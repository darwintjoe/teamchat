"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/lib/api";
import { TaskCardPanel, type InboxTaskRow } from "@/components/TaskCard";

type Filter = "all" | "open" | "claimed" | "done" | "closed";

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All live" },
  { value: "open", label: "Open" },
  { value: "claimed", label: "Claimed" },
  { value: "done", label: "Done" },
  { value: "closed", label: "Closed" },
];

const LIVE: Array<Exclude<Filter, "all">> = ["open", "claimed", "done", "closed"];

type Props = {
  orgPublicId: string | null;
  rootGroupPublicId: string | null;
};

function List({
  title,
  subtitle,
  tasks,
  empty,
}: {
  title: string;
  subtitle: string;
  tasks: InboxTaskRow[];
  empty: string;
}) {
  return (
    <section className="inbox-list">
      <div className="inbox-list-head">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <span className="unread-count">{tasks.length}</span>
      </div>
      <div className="inbox-list-body">
        {tasks.map((task) => (
          <TaskCardPanel
            key={task.publicId}
            task={task}
            messageText={task.messageText}
            groupLabel={`${task.groupName}${task.groupPath !== null ? ` · ${task.groupPath}` : ""}`}
            senderName={task.senderName}
            createdAt={task.createdAt}
          />
        ))}
        {tasks.length === 0 ? <p className="hint">{empty}</p> : null}
      </div>
    </section>
  );
}

/**
 * The Action Inbox: one group rollup (own group + descendants), one queue of tasks assigned to me,
 * one queue of tasks I raised, and the manager review queue (the rollup filtered to `done`).
 */
export function ActionInbox({ orgPublicId, rootGroupPublicId }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [groupPublicId, setGroupPublicId] = useState<string | null>(null);

  const tree = useQuery(api.groups.tree, orgPublicId !== null ? { orgPublicId } : "skip");
  const rollupArgs =
    groupPublicId === null
      ? ("skip" as const)
      : filter === "all"
        ? { groupPublicId }
        : { groupPublicId, status: filter };
  const rollup = useQuery(api.actionInbox.rollup, rollupArgs);
  const myTasks = useQuery(api.actionInbox.myTasks, {
    status: filter === "all" ? "claimed" : filter,
  });
  const raised = useQuery(api.actionInbox.raisedByMe, {
    status: filter === "all" ? "open" : filter,
  });

  useEffect(() => {
    if (orgPublicId === null) {
      setGroupPublicId(null);
      return;
    }
    const rows = tree ?? [];
    const stillValid = rows.some((row) => row.publicId === groupPublicId);
    if (!stillValid) {
      const preferred =
        rootGroupPublicId !== null && rows.some((row) => row.publicId === rootGroupPublicId)
          ? rootGroupPublicId
          : (rows.find((row) => row.isRoot)?.publicId ?? rows[0]?.publicId ?? null);
      setGroupPublicId(preferred);
    }
  }, [orgPublicId, rootGroupPublicId, tree, groupPublicId]);

  const counts = rollup?.counts ?? {};
  const rollupTasks = (rollup?.tasks ?? []) as InboxTaskRow[];
  const mine = (myTasks?.tasks ?? []) as InboxTaskRow[];
  const raisedRows = (raised?.tasks ?? []) as InboxTaskRow[];
  const selectedGroup = (tree ?? []).find((row) => row.publicId === groupPublicId) ?? null;

  return (
    <section className="inbox">
      <div className="inbox-head">
        <div className="chat-title">
          <h2>Action Inbox</h2>
          <p>
            {orgPublicId === null
              ? "No organisation selected — my tasks and tasks I raised still work"
              : `${selectedGroup?.name ?? "Group"} · own group + descendants · DMs excluded from the rollup`}
          </p>
        </div>
        <div className="inbox-filter">
          <select
            value={groupPublicId ?? ""}
            onChange={(event) => setGroupPublicId(event.target.value === "" ? null : event.target.value)}
            aria-label="Rollup group"
            disabled={orgPublicId === null}
          >
            {(tree ?? []).map((row) => (
              <option key={row.publicId} value={row.publicId}>
                {row.isRoot ? `${row.name} (root)` : `${row.name} · ${row.path}`}
              </option>
            ))}
          </select>
          {FILTERS.map((row) => (
            <button
              key={row.value}
              type="button"
              className={`btn btn-small${filter === row.value ? " btn-primary" : ""}`}
              onClick={() => setFilter(row.value)}
            >
              {row.label}
            </button>
          ))}
          <button type="button" className="btn btn-small" onClick={() => setFilter("done")}>
            Review queue
          </button>
        </div>
      </div>

      {filter === "all" ? (
        <div className="inbox-counts">
          {LIVE.map((status) => (
            <button
              key={status}
              type="button"
              className="inbox-count"
              onClick={() => setFilter(status)}
              title={`Show ${status}`}
            >
              <strong>{counts[status] ?? 0}</strong>
              <span>{status}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="inbox-grid">
        <List
          title="Rollup"
          subtitle="Selected group and every descendant"
          tasks={rollupTasks}
          empty={
            orgPublicId === null
              ? "Pick an organisation to see its rollup."
              : rollup === undefined
                ? "Loading rollup…"
                : "No tasks in this filter."
          }
        />
        <List
          title="My tasks"
          subtitle={filter === "all" ? "Assigned to me · claimed (all-live default)" : `Assigned to me · ${filter}`}
          tasks={mine}
          empty={myTasks === undefined ? "Loading…" : "Nothing assigned to me in this filter."}
        />
        <List
          title="Tasks I raised"
          subtitle={filter === "all" ? "Raised by me · open (all-live default)" : `Raised by me · ${filter}`}
          tasks={raisedRows}
          empty={raised === undefined ? "Loading…" : "I have not raised anything in this filter."}
        />
      </div>

      {rollup === undefined && orgPublicId !== null ? (
        <p className="hint" style={{ padding: "0 20px 14px" }}>
          Loading the rollup…
        </p>
      ) : null}
    </section>
  );
}
