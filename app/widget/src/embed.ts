// Host-side embed script. Creates a Shadow DOM launcher + iframe panel, validates every
// postMessage origin, and tears the iframe down completely when the panel closes.
//
// Usage:
//   TeamChatWidget.mount({
//     hostAppPublicId: "hap_…",
//     convexUrl: "https://….convex.cloud",
//     widgetUrl: "https://widget.example.com/widget/index.html",
//     tokenUrl: "/api/teamchat-widget-token", // POST { hostAppPublicId } -> { token }
//   });

import {
  isAllowedOrigin,
  parseWidgetMessage,
  WIDGET_PROTOCOL_VERSION,
} from "./protocol";

export type MountOptions = {
  hostAppPublicId: string;
  convexUrl: string;
  widgetUrl: string;
  tokenUrl?: string;
  getToken?: () => Promise<string> | string;
  target?: string | HTMLElement;
  side?: "left" | "right";
  launcherLabel?: string;
};

type PublicConfig = {
  name: string;
  allowedOrigins: string[];
  primaryColor: string;
  logoUrl: string | null;
};

export type WidgetHandle = {
  open: () => void;
  close: () => void;
  toggle: () => void;
  setToken: (token: string) => void;
  destroy: () => void;
  isOpen: () => boolean;
};

const EMBED_CSS = `
:host { all: initial; }
.tc-launcher {
  position: fixed; bottom: 22px; right: 22px; z-index: 2147483000;
  display: inline-flex; align-items: center; gap: 9px;
  border: 0; border-radius: 999px; padding: 13px 18px;
  background: var(--tc-primary, #2563eb); color: #fff;
  font: 600 14px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 12px 32px rgba(15,23,42,.28); cursor: pointer;
}
.tc-launcher[data-side="left"] { right: auto; left: 22px; }
.tc-launcher:hover { filter: brightness(1.06); }
.tc-launcher svg { width: 18px; height: 18px; display: block; }
.tc-panel {
  position: fixed; bottom: 22px; right: 22px; z-index: 2147483000;
  width: min(390px, calc(100vw - 28px)); height: min(620px, calc(100vh - 44px));
  border-radius: 16px; overflow: hidden; background: #fff;
  border: 1px solid rgba(15,23,42,.12);
  box-shadow: 0 20px 60px rgba(15,23,42,.30);
  display: flex; flex-direction: column;
}
.tc-panel[data-side="left"] { right: auto; left: 22px; }
.tc-panel iframe { border: 0; width: 100%; height: 100%; flex: 1; background: #f8fafc; }
.tc-close {
  position: absolute; top: 8px; right: 8px; z-index: 2;
  width: 30px; height: 30px; border-radius: 999px; border: 0;
  background: rgba(15,23,42,.16); color: #fff; cursor: pointer;
  font: 700 15px/1 ui-sans-serif, system-ui, sans-serif;
}
.tc-panel[data-side="left"] .tc-close { right: auto; left: 8px; }
.tc-pop { animation: tc-pop .16s ease-out; }
.tc-hidden { display: none !important; }
@keyframes tc-pop { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: none; } }
`;

function resolveTarget(target: MountOptions["target"]): HTMLElement {
  if (target instanceof HTMLElement) return target;
  if (typeof target === "string") {
    const found = document.querySelector<HTMLElement>(target);
    if (found !== null) return found;
  }
  const created = document.createElement("div");
  created.setAttribute("data-teamchat-widget", "");
  document.body.append(created);
  return created;
}

function configUrl(convexUrl: string): string {
  return `${convexUrl.replace(/\/+$/, "")}/api/query`;
}

async function fetchConfig(
  convexUrl: string,
  hostAppPublicId: string,
): Promise<PublicConfig> {
  const response = await fetch(configUrl(convexUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "hostApps:publicConfig",
      args: { hostAppPublicId },
      format: "json",
    }),
  });
  if (!response.ok) throw new Error(`Widget config failed (${response.status})`);
  const body = (await response.json()) as {
    status?: string;
    value?: PublicConfig;
    errorMessage?: string;
  };
  if (body.status === "error") throw new Error(body.errorMessage ?? "Widget is not available");
  if (body.value === undefined) throw new Error("Widget config was empty");
  return body.value;
}

export function mount(options: MountOptions): WidgetHandle {
  const hostOrigin = window.location.origin;
  const iframeOrigin = new URL(options.widgetUrl).origin;
  const side = options.side ?? "right";

  const target = resolveTarget(options.target);
  const shadow = target.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = EMBED_CSS;
  shadow.append(style);

  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "tc-launcher";
  launcher.dataset.side = side;
  launcher.setAttribute("aria-label", options.launcherLabel ?? "Open support chat");
  launcher.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 8.9 8.9 0 0 1-4-.9L3 21l1.9-5a8.1 8.1 0 0 1-.9-3.7A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5Z"/></svg>';
  const label = document.createElement("span");
  label.textContent = options.launcherLabel ?? "Support";
  launcher.append(label);
  shadow.append(launcher);

  let panel: HTMLDivElement | null = null;
  let iframe: HTMLIFrameElement | null = null;
  let config: PublicConfig | null = null;
  let open = false;
  let destroyed = false;
  let lastToken: string | null = null;

  function onMessage(event: MessageEvent): void {
    if (iframe === null || event.source !== iframe.contentWindow) return;
    // The iframe is the only sender accepted here; the host origin is enforced inside the iframe
    // and by the exchange's `allowedOrigins` check.
    if (event.origin !== iframeOrigin) return;
    const message = parseWidgetMessage(event.data);
    if (message === null) return;
    switch (message.type) {
      case "teamchat:ready":
        if (message.version !== WIDGET_PROTOCOL_VERSION) return;
        void deliverToken();
        return;
      case "teamchat:token-request":
        void deliverToken();
        return;
      case "teamchat:error":
        console.warn(`[TeamChat widget] ${message.code}: ${message.message}`);
        return;
      case "teamchat:state":
        return;
    }
  }

  async function obtainToken(): Promise<string> {
    if (options.getToken !== undefined) return await options.getToken();
    if (options.tokenUrl !== undefined) {
      const response = await fetch(options.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostAppPublicId: options.hostAppPublicId }),
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`Widget token request failed (${response.status})`);
      const body = (await response.json()) as { token?: unknown };
      if (typeof body.token !== "string" || body.token === "") {
        throw new Error("Widget token response was empty");
      }
      return body.token;
    }
    throw new Error("Widget mount needs tokenUrl or getToken");
  }

  async function deliverToken(): Promise<void> {
    if (iframe === null) return;
    try {
      // Ask the host for a fresh assertion on every handshake. Host assertions are one-shot by
      // jti, so reusing the previous token would be refused as a replay.
      const token = options.getToken !== undefined || options.tokenUrl !== undefined
        ? await obtainToken()
        : lastToken;
      if (token === null) return;
      lastToken = token;
      if (iframe === null) return;
      iframe.contentWindow?.postMessage(
        { type: "teamchat:token", token, hostAppPublicId: options.hostAppPublicId },
        iframeOrigin,
      );
    } catch (error) {
      console.warn("[TeamChat widget] token delivery failed", error);
    }
  }

  function createIframe(): void {
    iframe = document.createElement("iframe");
    iframe.title = "TeamChat support";
    iframe.setAttribute("allow", "clipboard-write");
    const url = new URL(options.widgetUrl);
    url.searchParams.set("hostApp", options.hostAppPublicId);
    url.searchParams.set("convexUrl", options.convexUrl);
    url.searchParams.set("hostOrigin", hostOrigin);
    iframe.src = url.toString();
    panel?.append(iframe);
  }

  function setOpen(next: boolean): void {
    if (destroyed || next === open) return;
    open = next;
    if (open) {
      if (config === null) return;
      panel = document.createElement("div");
      panel.className = "tc-panel tc-pop";
      panel.dataset.side = side;
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tc-close";
      close.setAttribute("aria-label", "Close support chat");
      close.textContent = "×";
      close.addEventListener("click", () => setOpen(false));
      panel.append(close);
      shadow.append(panel);
      createIframe();
      launcher.classList.add("tc-hidden");
    } else {
      panel?.remove();
      panel = null;
      iframe = null;
      launcher.classList.remove("tc-hidden");
    }
  }

  function visibility(): void {
    if (iframe === null) return;
    iframe.contentWindow?.postMessage(
      { type: "teamchat:visibility", visible: open && !document.hidden },
      iframeOrigin,
    );
  }

  function onDocumentVisibility(): void {
    visibility();
  }

  window.addEventListener("message", onMessage);
  document.addEventListener("visibilitychange", onDocumentVisibility);
  launcher.addEventListener("click", () => setOpen(!open));

  void fetchConfig(options.convexUrl, options.hostAppPublicId)
    .then((value) => {
      config = value;
      if (!isAllowedOrigin(hostOrigin, value.allowedOrigins)) {
        console.warn(
          `[TeamChat widget] ${hostOrigin} is not in the host app's allowedOrigins; the exchange will be refused.`,
        );
      }
      launcher.style.setProperty("--tc-primary", value.primaryColor);
      if (value.logoUrl !== null && value.logoUrl !== "") {
        const logo = document.createElement("img");
        logo.src = value.logoUrl;
        logo.alt = "";
        logo.style.cssText = "width:18px;height:18px;border-radius:5px;object-fit:contain";
        logo.referrerPolicy = "no-referrer";
        launcher.querySelector("svg")?.replaceWith(logo);
      }
      if (options.launcherLabel === undefined) label.textContent = value.name;
    })
    .catch((error: unknown) => {
      console.warn("[TeamChat widget] config failed", error);
    });

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    setToken: (token: string) => {
      lastToken = token;
      if (iframe !== null) {
        iframe.contentWindow?.postMessage(
          { type: "teamchat:token", token, hostAppPublicId: options.hostAppPublicId },
          iframeOrigin,
        );
      }
    },
    destroy: () => {
      destroyed = true;
      setOpen(false);
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onDocumentVisibility);
      launcher.remove();
    },
    isOpen: () => open,
  };
}

export default { mount };
