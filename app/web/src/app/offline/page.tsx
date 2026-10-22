"use client";

import { useEffect, useState } from "react";
import { listConversationCaches, type CachedConversation } from "@/lib/cache";
import { formatClock, formatDay, sameDay } from "@/lib/format";

/**
 * Offline read: renders only from localStorage — no Convex client, no network, no auth. The last
 * hundred messages of every conversation this browser has opened survive a reload or restart.
 */
export default function OfflinePage() {
  const [items, setItems] = useState<CachedConversation[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    const caches = listConversationCaches();
    setItems(caches);
    setSelectedKey(caches[0]?.key ?? null);
  }, []);

  const selected = items?.find((item) => item.key === selectedKey) ?? null;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div className="demo-banner" style={{ background: "#0f2b22", borderColor: "#1f6f56", color: "#9ff0d2" }}>
        <strong>Offline cache — read only.</strong> Loaded from this browser’s local storage. No
        network request was made.
      </div>

      <div className="offline-wrap">
        <aside className="offline-side">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 4px 10px" }}>
            <strong>Cached conversations</strong>
            <a href="/" className="btn btn-small">
              Back to app
            </a>
          </div>
          {items === null ? (
            <p className="hint">Reading cache…</p>
          ) : items.length === 0 ? (
            <p className="hint">
              Nothing cached yet. Open a conversation in the app while online — each one keeps its
              newest 100 messages here.
            </p>
          ) : (
            <div className="conv-list">
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`conv-row${item.key === selectedKey ? " active" : ""}`}
                  onClick={() => setSelectedKey(item.key)}
                >
                  <span className="conv-main">
                    <span className="conv-name">{item.label}</span>
                    <span className="conv-sub">
                      {item.messages.length} messages · updated {formatClock(item.updatedAt)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <main className="offline-main">
          {selected === null ? (
            <p className="hint">Select a cached conversation.</p>
          ) : (
            <>
              <h2 style={{ margin: "0 0 4px" }}>{selected.label}</h2>
              <p className="hint" style={{ marginTop: 0 }}>
                {selected.conversation.kind === "group"
                  ? `group ${selected.conversation.publicId}`
                  : `DM with ${selected.conversation.peerPublicId}`}{" "}
                · {selected.messages.length} of the newest 100 messages · cached{" "}
                {new Date(selected.updatedAt).toLocaleString()}
              </p>

              <div style={{ marginTop: 16 }}>
                {selected.messages.map((message, index) => {
                  const previous = index > 0 ? selected.messages[index - 1] : null;
                  const showDay =
                    previous === null || !sameDay(new Date(previous.createdAt), new Date(message.createdAt));
                  return (
                    <div key={message.publicId}>
                      {showDay ? (
                        <div className="section-title" style={{ paddingLeft: 0 }}>
                          {formatDay(message.createdAt)}
                        </div>
                      ) : null}
                      <div className="offline-msg">
                        <div className="meta">
                          <strong style={{ color: "#c3d1de" }}>{message.senderName}</strong>
                          <span>{formatClock(message.createdAt)}</span>
                          {message.editedAt !== null ? <span>edited</span> : null}
                        </div>
                        {message.deleted ? (
                          <em style={{ color: "var(--muted)" }}>Message deleted</em>
                        ) : (
                          <>
                            {message.text !== "" ? <div style={{ whiteSpace: "pre-wrap" }}>{message.text}</div> : null}
                            {message.attachments.map((attachment) => (
                              <div key={attachment.attachmentId} className="hint">
                                [attachment] {attachment.name} · {attachment.mime} · {attachment.size} bytes
                                (not cached offline)
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
