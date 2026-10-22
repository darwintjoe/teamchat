"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@/lib/api";
import {
  conversationKey,
  saveLastConversation,
  writeConversationCache,
  type ClientMessage,
  type Conversation,
} from "@/lib/cache";
import { errorMessage } from "@/lib/errors";
import { formatClock, formatDay, sameDay } from "@/lib/format";
import { TaskCardPanel } from "@/components/TaskCard";

type Attachment = ClientMessage["attachments"][number];
type ComposeMode = "discussion" | "action";
type FlagType = "task" | "approval" | "support_ticket" | "inventory_alert";

const FLAG_TYPES: Array<{ value: FlagType; label: string }> = [
  { value: "task", label: "Task" },
  { value: "approval", label: "Approval" },
  { value: "support_ticket", label: "Support ticket" },
  { value: "inventory_alert", label: "Inventory alert" },
];

type Props = {
  conversation: Conversation;
  label: string;
  groupPath: string | null;
  orgPublicId: string | null;
  myPublicId: string;
};

function mergeMessages(older: ClientMessage[], live: ClientMessage[]): ClientMessage[] {
  const byId = new Map<string, ClientMessage>();
  for (const message of [...older, ...live]) byId.set(message.publicId, message);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/** One attachment: images load a short-lived read ticket and render; other files download. */
function AttachmentView({ attachment }: { attachment: Attachment }) {
  const requestRead = useAction(api.storage.attachments.requestRead);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isImage = attachment.mime.startsWith("image/");

  async function open() {
    setLoading(true);
    setError(null);
    try {
      const ticket = await requestRead({ attachmentId: attachment.attachmentId });
      if (isImage) {
        setUrl(ticket.url);
      } else {
        window.open(ticket.url, "_blank", "noopener,noreferrer");
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isImage) void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment.attachmentId]);

  return (
    <div className="attach">
      {url !== null ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={attachment.name} />
        </a>
      ) : (
        <button type="button" className="btn btn-small" onClick={() => void open()} disabled={loading}>
          {loading ? "Opening…" : isImage ? `Load image · ${attachment.name}` : `Download · ${attachment.name}`}
        </button>
      )}
      {error !== null ? <span className="error">{error}</span> : null}
    </div>
  );
}

/**
 * One open conversation: the reactive last-15 live page, imperative older history, sending text
 * and photos, read-pointer updates, and the local last-100 cache used by the offline view.
 */
export function ConversationView({ conversation, label, groupPath, myPublicId }: Props) {
  const convex = useConvex();
  const live = useQuery(api.messages.listLive, { conversation });
  const markRead = useMutation(api.unread.markRead);
  const send = useMutation(api.messages.send);
  const requestUpload = useAction(api.storage.attachments.requestUpload);
  const confirmUpload = useAction(api.storage.attachments.confirmUpload);
  const storage = useQuery(api.storage.config.conversationStorageState, { conversation });
  const unread = useQuery(api.unread.unreadCount, { conversation });

  const [older, setOlder] = useState<ClientMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [historyDone, setHistoryDone] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<ComposeMode>("discussion");
  const [flagType, setFlagType] = useState<FlagType>("task");
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const markedRef = useRef<string | null>(null);

  const merged = useMemo(() => mergeMessages(older, live ?? []), [older, live]);
  const cacheSignature = merged
    .map(
      (m) =>
        `${m.publicId}:${m.createdAt}:${m.editedAt ?? 0}:${m.deleted ? 1 : 0}:${m.text.length}:${
          m.task?.status ?? ""
        }:${m.task?.claimedByPublicId ?? ""}:${m.task?.archivedAt ?? 0}`,
    )
    .join("|");
  const cacheKey = conversationKey(conversation);

  const last = merged.length > 0 ? merged[merged.length - 1] : null;
  const lastPublicId = last?.publicId ?? null;

  // Flow A3: the client sends the last message id it has actually seen, never a timestamp.
  useEffect(() => {
    if (lastPublicId === null) return;
    if (markedRef.current === lastPublicId) return;
    markedRef.current = lastPublicId;
    void markRead({ conversation, lastMessagePublicId: lastPublicId }).catch(() => {
      markedRef.current = null; // retry on the next live update
    });
  }, [lastPublicId, conversation, markRead]);

  // Local cache: newest 100 messages survive a reload/restart for the offline view.
  useEffect(() => {
    if (merged.length === 0) return;
    writeConversationCache(conversation, label, merged);
    saveLastConversation(conversation, label);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheSignature, cacheKey, label]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [cacheSignature]);

  async function loadOlder() {
    setLoadingHistory(true);
    setError(null);
    try {
      const page = await convex.query(api.messages.listHistory, {
        conversation,
        cursor: cursor ?? undefined,
        limit: 25,
      });
      setOlder((previous) => mergeMessages(page.messages, previous));
      setCursor(page.nextCursor);
      setHistoryDone(page.isDone);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoadingHistory(false);
    }
  }

  async function sendText(event: React.FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (value === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await send({
        conversation,
        text: value,
        mode,
        ...(mode === "action" ? { flagType } : {}),
      });
      setText("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function sendPhoto(file: File) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setUploadStatus("Requesting upload ticket…");
      const ticket = await requestUpload({
        ...(conversation.kind === "group"
          ? { groupPublicId: conversation.publicId }
          : { peerPublicId: conversation.peerPublicId }),
        name: file.name,
        mime: file.type !== "" ? file.type : "application/octet-stream",
        size: file.size,
      });

      setUploadStatus("Uploading directly to storage…");
      const form = new FormData();
      for (const [name, value] of Object.entries(ticket.fields)) form.append(name, value);
      form.append("file", file, file.name);
      const response = await fetch(ticket.uploadUrl, {
        method: ticket.method,
        body: form,
      });
      if (!response.ok) {
        throw new Error(`Storage upload failed with HTTP ${response.status}`);
      }

      setUploadStatus("Confirming upload…");
      const confirmed = await confirmUpload({ attachmentId: ticket.attachmentId });

      setUploadStatus("Sending message…");
      await send({
        conversation,
        text: text.trim(),
        attachmentIds: [confirmed.attachmentId],
        mode,
        ...(mode === "action" ? { flagType } : {}),
      });
      setText("");
      setUploadStatus(null);
    } catch (caught) {
      setUploadStatus(null);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
      if (fileInput.current !== null) fileInput.current.value = "";
    }
  }

  return (
    <section className="chat">
      <div className="chat-head">
        <div className="chat-title">
          <h2>{label}</h2>
          <p>{groupPath ?? "Direct message"}</p>
        </div>
        {unread !== undefined && unread.count > 0 ? (
          <span className="chip">{unread.display} unread</span>
        ) : null}
        <span className="chip plain">
          {storage === undefined
            ? "storage…"
            : storage.provider === "s3"
              ? "storage: S3"
              : "storage: none · text only"}
        </span>
      </div>

      <div className="messages">
        {!historyDone && (older.length > 0 || (live?.length ?? 0) >= 15) ? (
          <div className="history-row">
            <button type="button" className="btn btn-small" onClick={() => void loadOlder()} disabled={loadingHistory}>
              {loadingHistory ? "Loading…" : "Load older messages"}
            </button>
          </div>
        ) : null}

        {merged.map((message, index) => {
          const previous = index > 0 ? merged[index - 1] : null;
          const showDay =
            previous === null || !sameDay(new Date(previous.createdAt), new Date(message.createdAt));
          const own = message.senderPublicId === myPublicId;
          return (
            <div key={message.publicId} style={{ display: "contents" }}>
              {showDay ? <div className="day-divider">{formatDay(message.createdAt)}</div> : null}
              <div className={`msg${own ? " own" : ""}`}>
                <div className="msg-meta">
                  <strong>{own ? "You" : message.senderName}</strong>
                  <span>{formatClock(message.createdAt)}</span>
                  {message.editedAt !== null ? <span>edited</span> : null}
                  {message.isReply ? <span>reply</span> : null}
                </div>
                <div className="bubble">
                  {message.deleted ? (
                    <em>Message deleted</em>
                  ) : (
                    <>
                      {message.text !== "" ? <p>{message.text}</p> : null}
                      {message.attachments.map((attachment) => (
                        <AttachmentView key={attachment.attachmentId} attachment={attachment} />
                      ))}
                    </>
                  )}
                </div>
                {message.task !== null && message.task !== undefined ? (
                  <TaskCardPanel task={message.task} compact />
                ) : null}
              </div>
            </div>
          );
        })}

        {merged.length === 0 ? (
          <p className="hint" style={{ textAlign: "center", marginTop: 24 }}>
            No messages yet. Say hello — or send a photo.
          </p>
        ) : null}

        <div ref={bottomRef} />
      </div>

      <form className="composer" onSubmit={sendText}>
        <div className="composer-mode">
          <button
            type="button"
            className={`mode-pill${mode === "discussion" ? " active" : ""}`}
            onClick={() => setMode("discussion")}
            aria-pressed={mode === "discussion"}
          >
            💬 Discussion
          </button>
          <button
            type="button"
            className={`mode-pill${mode === "action" ? " active" : ""}`}
            onClick={() => setMode("action")}
            aria-pressed={mode === "action"}
          >
            ⚡ Action
          </button>
          {mode === "action" ? (
            <select
              value={flagType}
              onChange={(event) => setFlagType(event.target.value as FlagType)}
              aria-label="Action flag type"
            >
              {FLAG_TYPES.map((row) => (
                <option key={row.value} value={row.value}>
                  {row.label}
                </option>
              ))}
            </select>
          ) : null}
          <span className="composer-mode-hint">
            {mode === "action"
              ? "Creates one task in the Action Inbox. First claim locks it."
              : "Normal chat. No claiming."}
          </span>
        </div>
        <div className="composer-row">
          <input
            ref={fileInput}
            type="file"
            accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.md,.zip"
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void sendPhoto(file);
            }}
          />
          <button
            type="button"
            className="btn"
            title={storage?.provider === "none" ? "No shared storage is connected" : "Send a photo or file"}
            disabled={busy || storage === undefined || storage.provider === "none"}
            onClick={() => fileInput.current?.click()}
          >
            Attach
          </button>
          <textarea
            rows={2}
            placeholder="Message"
            value={text}
            maxLength={4000}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendText(event);
              }
            }}
          />
          <button className="btn btn-primary" type="submit" disabled={busy || text.trim() === ""}>
            Send
          </button>
        </div>
        <div className="composer-meta">
          {uploadStatus !== null ? <span>{uploadStatus}</span> : null}
          {storage?.provider === "none" ? (
            <span>
              Text-only: no shared storage is connected
              {conversation.kind === "group" ? " (an org admin can add S3)" : ""}.
            </span>
          ) : null}
          {storage?.provider === "s3" ? (
            <span>Files upload straight to the org bucket; Convex never relays media bytes.</span>
          ) : null}
        </div>
        {error !== null ? <p className="error">{error}</p> : null}
      </form>
    </section>
  );
}
