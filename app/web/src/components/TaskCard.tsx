"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { TaskCard, TaskStatus } from "@/lib/cache";

export type InboxTaskRow = TaskCard & {
  messagePublicId: string | null;
  messageText: string;
  groupPublicId: string | null;
  groupPath: string | null;
  groupName: string;
  senderPublicId: string | null;
  senderName: string | null;
  createdAt: number;
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "Open",
  claimed: "Claimed",
  done: "Done — needs review",
  closed: "Closed — work done",
  archived: "Archived — withdrawn",
};

function shortTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Props = {
  task: TaskCard;
  messageText?: string;
  groupLabel?: string;
  senderName?: string | null;
  createdAt?: number;
  compact?: boolean;
};

/**
 * One task card. The server re-checks every rule; the buttons here only reflect the viewer flags
 * the backend rendered. The audit panel is loaded lazily (one indexed query) when opened.
 */
export function TaskCardPanel({ task, messageText, groupLabel, senderName, createdAt, compact }: Props) {
  const claim = useMutation(api.actionInbox.claim);
  const markDone = useMutation(api.actionInbox.markDone);
  const forward = useMutation(api.actionInbox.forward);
  const reassign = useMutation(api.actionInbox.reassign);
  const reopen = useMutation(api.actionInbox.reopen);
  const close = useMutation(api.actionInbox.close);
  const archive = useMutation(api.actionInbox.archive);
  const hideClosed = useMutation(api.actionInbox.hideClosed);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<"forward" | "reassign" | null>(null);
  const [target, setTarget] = useState("");
  const [showAudit, setShowAudit] = useState(false);

  const members = useQuery(
    api.actionInbox.assignableMembers,
    transfer === null ? "skip" : { taskPublicId: task.publicId },
  );
  const audit = useQuery(
    api.actionInbox.events,
    showAudit ? { taskPublicId: task.publicId } : "skip",
  );

  const viewer = task.viewer;
  const hasControls =
    viewer.canClaim ||
    viewer.canMarkDone ||
    viewer.canForward ||
    viewer.canReassign ||
    viewer.canClose ||
    viewer.canReopen ||
    viewer.canArchive ||
    viewer.canHide;

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setTransfer(null);
      setTarget("");
    } catch (caught) {
      setError(`${label}: ${errorMessage(caught)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onClaim() {
    if (!window.confirm("Claim this task? The first claimant locks it to themselves.")) return;
    await run("Claim failed", () => claim({ taskPublicId: task.publicId }));
  }

  async function onClose() {
    if (!window.confirm("Close this task as completed? Closing is terminal.")) return;
    await run("Close failed", () => close({ taskPublicId: task.publicId }));
  }

  async function onArchive() {
    if (
      !window.confirm(
        "Archive this task as withdrawn? Archived is terminal and removed from the default board.",
      )
    ) {
      return;
    }
    await run("Archive failed", () => archive({ taskPublicId: task.publicId }));
  }

  async function onTransfer() {
    if (transfer === null || target === "") return;
    const fn = transfer === "forward" ? forward : reassign;
    await run(transfer === "forward" ? "Forward failed" : "Reassign failed", () =>
      fn({ taskPublicId: task.publicId, toUserPublicId: target }),
    );
  }

  return (
    <div className={`task-card${compact ? " compact" : ""}${task.hidden ? " hidden" : ""}`}>
      <div className="task-head">
        <span className={`task-status status-${task.status}`}>{STATUS_LABEL[task.status]}</span>
        <span className="task-flag">{task.flagType.replaceAll("_", " ")}</span>
        <span className="task-id">{task.publicId}</span>
        {task.hidden ? <span className="task-flag">hidden</span> : null}
      </div>

      {messageText !== undefined && messageText !== "" ? (
        <p className="task-text">{messageText}</p>
      ) : null}

      <div className="task-meta">
        {groupLabel !== undefined ? <span>{groupLabel}</span> : null}
        {senderName !== undefined && senderName !== null ? <span>raised by {senderName}</span> : null}
        {createdAt !== undefined ? <span>{shortTime(createdAt)}</span> : null}
        {task.claimedByName !== null ? <span>claimed by {task.claimedByName}</span> : null}
        {task.forwardedToName !== null ? <span>forwarded to {task.forwardedToName}</span> : null}
        {task.closedByName !== null ? <span>closed by {task.closedByName}</span> : null}
        {task.senderMayClose ? <span>sender may close</span> : null}
      </div>

      {hasControls ? (
        <div className="task-actions">
          {viewer.canClaim ? (
            <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void onClaim()}>
              ⚡ Claim task
            </button>
          ) : null}
          {viewer.canMarkDone ? (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => void run("Mark done failed", () => markDone({ taskPublicId: task.publicId }))}
            >
              Mark done
            </button>
          ) : null}
          {viewer.canForward ? (
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => setTransfer("forward")}>
              Forward
            </button>
          ) : null}
          {viewer.canReassign ? (
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => setTransfer("reassign")}>
              Reassign
            </button>
          ) : null}
          {viewer.canReopen ? (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => void run("Reopen failed", () => reopen({ taskPublicId: task.publicId }))}
            >
              Reopen
            </button>
          ) : null}
          {viewer.canClose ? (
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => void onClose()}>
              Close
            </button>
          ) : null}
          {viewer.canArchive ? (
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => void onArchive()}>
              Archive
            </button>
          ) : null}
          {viewer.canHide ? (
            <button
              type="button"
              className="btn btn-small"
              disabled={busy}
              onClick={() => void run("Hide failed", () => hideClosed({ taskPublicId: task.publicId }))}
            >
              Hide closed
            </button>
          ) : null}
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setShowAudit((value) => !value)}>
            {showAudit ? "Hide audit" : "Audit"}
          </button>
        </div>
      ) : (
        <div className="task-actions">
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setShowAudit((value) => !value)}>
            {showAudit ? "Hide audit" : "Audit"}
          </button>
        </div>
      )}

      {transfer !== null ? (
        <form
          className="task-transfer"
          onSubmit={(event) => {
            event.preventDefault();
            void onTransfer();
          }}
        >
          <select value={target} onChange={(event) => setTarget(event.target.value)} required>
            <option value="">Choose an active group member…</option>
            {(members ?? [])
              .filter(
                (member) =>
                  member.userPublicId !== task.claimedByPublicId &&
                  member.userPublicId !== task.forwardedToPublicId,
              )
              .map((member) => (
                <option key={member.userPublicId} value={member.userPublicId}>
                  {member.name} ({member.role})
                </option>
              ))}
          </select>
          <button type="submit" className="btn btn-small btn-primary" disabled={busy || target === ""}>
            {transfer === "forward" ? "Forward to" : "Reassign to"}
          </button>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => {
              setTransfer(null);
              setTarget("");
            }}
          >
            Cancel
          </button>
          {members !== undefined && members.length === 0 ? (
            <span className="hint">No other active member can receive this task.</span>
          ) : null}
        </form>
      ) : null}

      {showAudit ? (
        <div className="task-audit">
          <div className="task-audit-title">Audit trail · append-only</div>
          {audit === undefined ? (
            <p className="hint">Loading…</p>
          ) : audit.events.length === 0 ? (
            <p className="hint">No events yet. The task has not changed state.</p>
          ) : (
            <ol>
              {audit.events.map((event, index) => (
                <li key={`${event.timestamp}:${event.action}:${index}`}>
                  <strong>{event.action}</strong>
                  {event.actorName !== null ? ` · ${event.actorName}` : ""}
                  {event.fromName !== null && event.toName !== null
                    ? ` · ${event.fromName} → ${event.toName}`
                    : ""}
                  {event.reason !== null ? ` · ${event.reason.replaceAll("_", " ")}` : ""}
                  {event.selfClosed === true ? " · self-closed" : ""}
                  <span className="task-audit-time">{shortTime(event.timestamp)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}

      {error !== null ? <p className="error">{error}</p> : null}
    </div>
  );
}
