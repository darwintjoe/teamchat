// Embedded widget app. Runs inside the host's iframe, renders into a Shadow DOM, and only
// accepts postMessage traffic from the exact host origin that the server allowlisted.
//
// Trust boundaries:
//   * The host JWT is exchanged server-side; this file never validates it.
//   * The host origin is checked against `hostApps.publicConfig.allowedOrigins` before any
//     message is parsed, and again on every message.
//   * The widget never sees an `_id`; every identifier returned by the backend is a publicId.

import { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import {
  isAllowedOrigin,
  parseHostMessage,
  WIDGET_PROTOCOL_VERSION,
  type WidgetToHost,
} from "./protocol";
import { SubscriptionGate } from "./lifecycle";

type Conversation = FunctionReturnType<typeof api.widgets.messages.conversation>;
type WidgetMessage = Conversation["messages"][number];
type UploadTicket = FunctionReturnType<typeof api.widgets.uploads.requestWidgetUpload>;
type ConfirmedUpload = FunctionReturnType<typeof api.widgets.uploads.confirmWidgetUpload>;

type PublicConfig = {
  name: string;
  allowedOrigins: string[];
  primaryColor: string;
  logoUrl: string | null;
  uploadsEnabled: boolean;
};

const params = new URLSearchParams(window.location.search);
const hostAppPublicId = params.get("hostApp") ?? "";
const convexUrl = params.get("convexUrl") ?? "";
const hostOrigin = normaliseOrigin(params.get("hostOrigin") ?? referrerOrigin());

const root = document.getElementById("widget-root");
if (root === null) throw new Error("widget root missing");

const shadow = root.attachShadow({ mode: "closed" });
const style = document.createElement("link");
style.rel = "stylesheet";
style.href = "./widget.css";
shadow.append(style);

const shell = element("div", "tc-shell");
const header = element("div", "tc-header");
const title = element("div", "tc-title");
const titleName = document.createElement("strong");
const titleSub = document.createElement("span");
title.append(titleName, titleSub);
const status = element("span", "tc-status", "connecting");
header.append(status);
const scroll = element("div", "tc-scroll");
const errorBox = element("p", "tc-error tc-hidden");
const composer = element("div", "tc-composer");
const pendingRow = element("div", "tc-pending tc-hidden");
const inputRow = element("div", "tc-input-row");
const input = document.createElement("textarea");
input.className = "tc-input";
input.rows = 1;
input.placeholder = "Write a message…";
input.maxLength = 4000;
const sendButton = element("button", "tc-btn", "Send");
sendButton.type = "button";
const uploadButton = element("button", "tc-btn tc-btn-ghost", "Attach");
uploadButton.type = "button";
uploadButton.classList.add("tc-hidden");
const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.classList.add("tc-hidden");
inputRow.append(input, uploadButton, sendButton);
composer.append(pendingRow, inputRow, fileInput);
shell.append(header, scroll, errorBox, composer);
shadow.append(shell);

let config: PublicConfig | null = null;
let client: ConvexClient | null = null;
let sessionToken: string | null = null;
let authenticated = false;
let authenticating = false;
let queuedToken: string | null = null;
let pendingUpload: ConfirmedUpload | null = null;
let convo: Conversation | null = null;
let lastRenderedCount = 0;
let closed = false;
let gate: SubscriptionGate | null = null;

function normaliseOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function referrerOrigin(): string {
  try {
    return document.referrer === "" ? "" : new URL(document.referrer).origin;
  } catch {
    return "";
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function post(message: WidgetToHost): void {
  if (hostOrigin === "") return;
  window.parent.postMessage(message, hostOrigin);
}

function showError(message: string | null, code = "widget_error"): void {
  if (message === null || message === "") {
    errorBox.classList.add("tc-hidden");
    errorBox.textContent = "";
    return;
  }
  errorBox.textContent = message;
  errorBox.classList.remove("tc-hidden");
  post({ type: "teamchat:error", code, message });
}

function setStatus(text: string): void {
  status.textContent = text;
}

function applyBranding(): void {
  titleName.textContent = config?.name ?? "Support";
  titleSub.textContent = "Customer support";
  const primary = config?.primaryColor ?? "#2563eb";
  shell.style.setProperty("--tc-primary", primary);
  const logo = config?.logoUrl;
  if (logo !== null && logo !== undefined && logo !== "") {
    const img = document.createElement("img");
    img.className = "tc-logo";
    img.src = logo;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    header.prepend(img);
  } else {
    header.prepend(element("div", "tc-logo-fallback", (config?.name ?? "T").slice(0, 1).toUpperCase()));
  }
}

function ticketLabel(statusValue: string | null): string {
  switch (statusValue) {
    case "open":
      return "waiting for an agent";
    case "claimed":
      return "agent connected";
    case "done":
      return "resolved — reply to reopen";
    case "closed":
      return "closed";
    default:
      return "ready";
  }
}

function render(): void {
  if (convo === null) return;
  titleName.textContent = convo.branding.logoUrl === null ? (config?.name ?? "Support") : titleName.textContent;
  setStatus(ticketLabel(convo.activeTicketStatus));
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  scroll.replaceChildren();

  if (convo.messages.length === 0) {
    const empty = element("div", "tc-empty");
    empty.append(
      element("strong", "", "How can we help?"),
      document.createTextNode(
        "Send a message and it becomes an Action task for the support team. Replies appear here.",
      ),
    );
    scroll.append(empty);
  } else {
    for (const message of convo.messages) scroll.append(renderMessage(message));
  }

  const enabled = convo.uploads.enabled;
  uploadButton.classList.toggle("tc-hidden", !enabled);
  if (!enabled) pendingUpload = null;
  renderPending();
  if (nearBottom || convo.messages.length !== lastRenderedCount) {
    scroll.scrollTop = scroll.scrollHeight;
  }
  lastRenderedCount = convo.messages.length;
}

function renderMessage(message: WidgetMessage): HTMLElement {
  const row = element("div", `tc-row${message.mine ? " mine" : ""}`);
  const bubble = element("div", "tc-bubble");
  if (message.text !== "") bubble.append(document.createTextNode(message.text));
  for (const attachment of message.attachments) {
    const button = element("button", "tc-attachment");
    button.type = "button";
    button.textContent = `⇩ ${attachment.name} · ${formatBytes(attachment.size)}`;
    button.addEventListener("click", () => void openAttachment(attachment.attachmentId));
    bubble.append(button);
  }
  const meta = element(
    "span",
    "tc-meta",
    `${message.mine ? "You" : message.senderName} · ${formatTime(message.createdAt)}`,
  );
  bubble.append(meta);
  row.append(bubble);
  return row;
}

function renderPending(): void {
  pendingRow.replaceChildren();
  if (pendingUpload === null) {
    pendingRow.classList.add("tc-hidden");
    return;
  }
  pendingRow.classList.remove("tc-hidden");
  pendingRow.append(
    document.createTextNode(`Ready to send: ${pendingUpload.name} · ${formatBytes(pendingUpload.size)}`),
  );
  const remove = element("button", "", "Remove");
  remove.type = "button";
  remove.addEventListener("click", () => {
    pendingUpload = null;
    renderPending();
  });
  pendingRow.append(remove);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function applyToken(hostToken: string): Promise<void> {
  if (client === null || config === null) return;
  if (authenticating) {
    queuedToken = hostToken;
    return;
  }
  if (authenticated && hostToken === currentHostToken) return;
  authenticating = true;
  currentHostToken = hostToken;
  try {
    showError(null);
    setStatus("signing in");
    const result = await client.action(api.auth.signIn, {
      provider: "widget",
      params: { token: hostToken, hostAppPublicId, origin: hostOrigin },
    });
    const issuedToken = result?.tokens?.token;
    if (typeof issuedToken !== "string" || issuedToken === "") {
      throw new Error("The host token exchange returned no session");
    }
    sessionToken = issuedToken;
    client.setAuth(async () => sessionToken);
    // One authenticated read proves the session is usable before opening the live subscription.
    const me = await client.query(api.widgets.messages.me, {});
    if (me.accountState !== "shadow") throw new Error("Unexpected account state");
    authenticated = true;
    gate?.setOpen(true);
  } catch (error) {
    authenticated = false;
    gate?.setOpen(false);
    setStatus("sign-in failed");
    showError(messageOf(error), "exchange_failed");
  } finally {
    authenticating = false;
    const next = queuedToken;
    queuedToken = null;
    if (next !== null && next !== hostToken) void applyToken(next);
  }
}

let currentHostToken: string | null = null;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function onMessage(event: MessageEvent): void {
  if (event.source !== window.parent) return;
  if (hostOrigin === "" || event.origin !== hostOrigin) return;
  if (config === null || !isAllowedOrigin(event.origin, config.allowedOrigins)) {
    post({ type: "teamchat:error", code: "origin_not_allowed", message: "Host origin is not allowlisted" });
    return;
  }
  const message = parseHostMessage(event.data);
  if (message === null) return;
  switch (message.type) {
    case "teamchat:token":
      void applyToken(message.token);
      return;
    case "teamchat:visibility":
      gate?.setVisible(message.visible);
      return;
    case "teamchat:close":
      teardown();
      return;
    case "teamchat:open":
      gate?.setOpen(true);
      return;
  }
}

function teardown(): void {
  if (closed) return;
  closed = true;
  gate?.close();
  client?.close().catch(() => undefined);
  window.removeEventListener("message", onMessage);
  window.removeEventListener("pagehide", teardown);
  window.removeEventListener("beforeunload", teardown);
}

async function send(): Promise<void> {
  if (client === null || !authenticated) return;
  const text = input.value.trim();
  if (text === "" && pendingUpload === null) return;
  sendButton.disabled = true;
  try {
    showError(null);
    await client.mutation(api.widgets.messages.sendMessage, {
      text,
      mode: "action",
      attachmentIds: pendingUpload === null ? undefined : [pendingUpload.attachmentId],
    });
    input.value = "";
    pendingUpload = null;
    renderPending();
    scroll.scrollTop = scroll.scrollHeight;
  } catch (error) {
    showError(messageOf(error), "send_failed");
  } finally {
    sendButton.disabled = false;
    input.focus();
  }
}

async function uploadFile(file: File): Promise<void> {
  if (client === null || !authenticated || convo === null) return;
  if (!convo.uploads.enabled) return;
  uploadButton.disabled = true;
  try {
    showError(null);
    if (file.size <= 0 || file.size > convo.uploads.maxFileBytes) {
      throw new Error(`File must be 1..${convo.uploads.maxFileBytes} bytes`);
    }
    if (!convo.uploads.mimes.includes(file.type)) {
      throw new Error(`"${file.type}" is not an allowed file type`);
    }
    setStatus("uploading");
    const ticket: UploadTicket = await client.action(api.widgets.uploads.requestWidgetUpload, {
      name: file.name,
      mime: file.type,
      size: file.size,
    });
    const form = new FormData();
    for (const [name, value] of Object.entries(ticket.fields)) form.append(name, value);
    form.append("file", file, file.name);
    const response = await fetch(ticket.uploadUrl, { method: ticket.method, body: form });
    if (!response.ok) throw new Error(`Upload failed (${response.status})`);
    pendingUpload = await client.action(api.widgets.uploads.confirmWidgetUpload, {
      attachmentId: ticket.attachmentId,
    });
    renderPending();
    setStatus(ticketLabel(convo.activeTicketStatus));
  } catch (error) {
    showError(messageOf(error), "upload_failed");
  } finally {
    uploadButton.disabled = false;
    fileInput.value = "";
  }
}

async function openAttachment(attachmentId: string): Promise<void> {
  if (client === null || !authenticated) return;
  try {
    const ticket = await client.action(api.widgets.messages.attachmentUrl, { attachmentId });
    window.open(ticket.url, "_blank", "noopener,noreferrer");
  } catch (error) {
    showError(messageOf(error), "attachment_failed");
  }
}

async function boot(): Promise<void> {
  shadow.querySelectorAll(".tc-loading").forEach((node) => node.remove());
  if (hostOrigin === "" || hostAppPublicId === "" || convexUrl === "") {
    setStatus("configuration error");
    showError("The widget is missing its hostApp, convexUrl or hostOrigin parameter.", "config");
    return;
  }
  if (window.parent === window) {
    setStatus("embed only");
    showError("This page is an embedded widget and cannot be opened standalone.", "not_embedded");
    return;
  }

  setStatus("loading");
  try {
    const httpConfig = await publicConfig(convexUrl, hostAppPublicId);
    if (!isAllowedOrigin(hostOrigin, httpConfig.allowedOrigins)) {
      setStatus("origin refused");
      showError("This origin is not allowlisted for the widget.", "origin_not_allowed");
      return;
    }
    config = httpConfig;
    applyBranding();

    client = new ConvexClient(convexUrl);
    gate = new SubscriptionGate(
      () => {
        if (client === null) return () => undefined;
        return client.onUpdate(
          api.widgets.messages.conversation,
          {},
          (value) => {
            convo = value;
            render();
          },
          (error) => showError(messageOf(error), "subscription_failed"),
        );
      },
      (active) => {
        setStatus(active ? (convo?.activeTicketStatus ?? "connecting") : "paused");
        if (!active && convo !== null) setStatus(ticketLabel(convo.activeTicketStatus));
      },
    );

    window.addEventListener("message", onMessage);
    window.addEventListener("pagehide", teardown);
    window.addEventListener("beforeunload", teardown);
    document.addEventListener("visibilitychange", () => {
      gate?.setVisible(!document.hidden && !closed);
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void send();
      }
    });
    sendButton.addEventListener("click", () => void send());
    uploadButton.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file !== undefined) void uploadFile(file);
    });

    setStatus("connecting");
    post({ type: "teamchat:ready", version: WIDGET_PROTOCOL_VERSION });
  } catch (error) {
    setStatus("unavailable");
    showError(messageOf(error), "config");
  }
}

/**
 * Fetch the unauthenticated bootstrap document without pulling in the realtime client yet.
 * A plain POST keeps the bundle small and avoids opening a WebSocket before a token arrives.
 */
async function publicConfig(url: string, hostApp: string): Promise<PublicConfig> {
  const response = await fetch(`${url.replace(/\/+$/, "")}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "hostApps:publicConfig",
      args: { hostAppPublicId: hostApp },
      format: "json",
    }),
  });
  if (!response.ok) throw new Error(`Widget config request failed (${response.status})`);
  const body = (await response.json()) as {
    status?: string;
    value?: PublicConfig;
    errorMessage?: string;
  };
  if (body.status === "error") throw new Error(body.errorMessage ?? "Widget is not available");
  if (body.value === undefined) throw new Error("Widget config response was empty");
  return body.value;
}

void boot();
