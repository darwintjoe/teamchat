// Action mode / Action Inbox (PRD v1.4 Part 1 §2 and §4).
//
// One message = one insert: `messages.send` inserts the message and, for mode "action", exactly one
// `actionInbox` row in the same mutation. Every workflow state change patches that row and inserts
// its typed `actionEvents` row in the same mutation. There is no un-claim: recovery is forward or
// reassign. Close and archive are terminal; hiding a closed task only sets `archivedAt`.
//
// All authority is re-checked here. Viewer flags on a rendered task card are a convenience for the
// thin UI, never the enforcement point.

import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireActive, requireGroupAccess, requireNotShadow, requireUserId } from "./lib/guards";
import { Doc, Id } from "./_generated/dataModel";
import { enqueueWebhookEvent, type WebhookEvent } from "./webhooks";

export const taskStatusValidator = v.union(
  v.literal("open"),
  v.literal("claimed"),
  v.literal("done"),
  v.literal("closed"),
  v.literal("archived"),
);

export const taskFlagValidator = v.union(
  v.literal("task"),
  v.literal("approval"),
  v.literal("support_ticket"),
  v.literal("inventory_alert"),
);

type TaskStatus = "open" | "claimed" | "done" | "closed" | "archived";
type Task = Doc<"actionInbox">;
type Group = Doc<"groups">;

const LIVE_STATUSES: TaskStatus[] = ["open", "claimed", "done", "closed"];
const MAX_ROWS_PER_STATUS = 200;

function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter((part) => part !== "");
  const out: string[] = [];
  for (let length = 1; length < parts.length; length++) {
    out.push(`/${parts.slice(0, length).join("/")}`);
  }
  return out;
}

async function taskByPublicId(ctx: QueryCtx, publicId: string): Promise<Task> {
  const task = await ctx.db
    .query("actionInbox")
    .withIndex("by_public_id", (q) => q.eq("publicId", publicId))
    .unique();
  if (task === null) throw new Error("Task not found");
  return task;
}

async function groupForTask(ctx: QueryCtx, task: Task): Promise<Group> {
  const group = await ctx.db.get(task.groupId);
  if (group === null) throw new Error("Task group not found");
  return group;
}

/**
 * Build the webhook snapshot for a task transition and insert one delivery row per subscribed
 * webhook. Runs inside the same mutation as the status patch and the audit event, so a webhook can
 * never observe a transition that rolled back — and the HTTP attempt itself runs later, in an
 * action, so it can never delay or fail the transition.
 */
async function emitTaskWebhook(
  ctx: any,
  task: Task,
  event: WebhookEvent,
  extra?: { claimedBy?: { publicId: string; email?: string } },
): Promise<void> {
  if (task.groupPath === undefined) return; // DM tasks have no org / webhook surface
  const group = await ctx.db.get(task.groupId);
  if (group === null || group.kind !== "group") return;
  const message = await ctx.db.get(task.messageId);
  await enqueueWebhookEvent(ctx, group.orgId, event, {
    messagePublicId: message?.publicId,
    externalRef: message?.externalRef,
    externalSource: message?.externalSource,
    groupPublicId: group.publicId,
    claimedBy: extra?.claimedBy,
  });
}

async function exactMembership(
  ctx: QueryCtx,
  userId: Id<"users">,
  groupId: Id<"groups">,
): Promise<Doc<"memberships"> | null> {
  return await ctx.db
    .query("memberships")
    .withIndex("by_unique", (q) => q.eq("uniqueKey", `${groupId}:${userId}`))
    .unique();
}

/**
 * Manager/owner at the task's group or any ancestor. DMs have no tree, so both participants are
 * treated as owner for task purposes. This is closing/archiving authority only — it never grants
 * claim rights outside an exact group membership.
 */
async function managerAtOrAbove(
  ctx: QueryCtx,
  userId: Id<"users">,
  group: Group,
): Promise<boolean> {
  if (group.kind === "dm") return group.participantIds.includes(userId);
  const own = await exactMembership(ctx, userId, group._id);
  if (own !== null && (own.role === "owner" || own.role === "manager")) return true;
  for (const path of ancestorsOf(group.path)) {
    const ancestor = await ctx.db
      .query("memberships")
      .withIndex("by_user_path", (q) => q.eq("userId", userId).eq("groupPath", path))
      .unique();
    if (ancestor !== null && (ancestor.role === "owner" || ancestor.role === "manager")) {
      return true;
    }
  }
  return false;
}

async function isExactMember(
  ctx: QueryCtx,
  userId: Id<"users">,
  group: Group,
): Promise<boolean> {
  if (group.kind === "dm") return group.participantIds.includes(userId);
  return (await exactMembership(ctx, userId, group._id)) !== null;
}

async function eligibleCloserIds(
  ctx: QueryCtx,
  task: Task,
  group: Group,
): Promise<Set<Id<"users">>> {
  const ids = new Set<Id<"users">>();
  if (group.kind === "dm") {
    for (const id of group.participantIds) ids.add(id);
  } else {
    const own = await ctx.db
      .query("memberships")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .collect();
    for (const row of own) {
      if (row.role === "owner" || row.role === "manager") ids.add(row.userId);
    }
    for (const path of ancestorsOf(group.path)) {
      const rows = await ctx.db
        .query("memberships")
        .withIndex("by_path_role", (q) => q.eq("groupPath", path))
        .collect();
      for (const row of rows) {
        if (row.role === "owner" || row.role === "manager") ids.add(row.userId);
      }
    }
  }
  if (task.senderMayClose) ids.add(task.senderId);

  // Only an active account can exercise closing authority. `senderMayClose` itself stays
  // materialized on the task; this filter only answers "does another available closer exist?".
  const active = new Set<Id<"users">>();
  for (const id of ids) {
    const user = await ctx.db.get(id);
    if (user !== null && user.accountState === "active") active.add(id);
  }
  return active;
}

async function requireTaskRead(
  ctx: QueryCtx,
  userId: Id<"users">,
  task: Task,
): Promise<Group> {
  const group = await groupForTask(ctx, task);
  if (group.kind === "dm") {
    if (!group.participantIds.includes(userId)) {
      throw new Error("You are not a participant in this direct message");
    }
  } else {
    await requireGroupAccess(ctx, userId, group._id);
  }
  return group;
}

type ViewerContext = {
  ctx: QueryCtx;
  userId: Id<"users">;
  user: Doc<"users"> | null;
  active: boolean;
  exact: (group: Group) => Promise<Doc<"memberships"> | null>;
  manager: (group: Group) => Promise<boolean>;
  userById: (id: Id<"users">) => Promise<Doc<"users"> | null>;
  groupById: (id: Id<"groups">) => Promise<Group | null>;
};

async function viewerContext(ctx: QueryCtx, userId: Id<"users">): Promise<ViewerContext> {
  const user = await ctx.db.get(userId);
  const exactCache = new Map<string, Doc<"memberships"> | null>();
  const managerCache = new Map<string, boolean>();
  const userCache = new Map<string, Doc<"users"> | null>();
  const groupCache = new Map<string, Group | null>();

  async function exact(group: Group): Promise<Doc<"memberships"> | null> {
    const key = group._id as string;
    if (exactCache.has(key)) return exactCache.get(key) ?? null;
    const row = await exactMembership(ctx, userId, group._id);
    exactCache.set(key, row);
    return row;
  }

  async function manager(group: Group): Promise<boolean> {
    const key = group._id as string;
    if (managerCache.has(key)) return managerCache.get(key) === true;
    const value = await managerAtOrAbove(ctx, userId, group);
    managerCache.set(key, value);
    return value;
  }

  async function userById(id: Id<"users">): Promise<Doc<"users"> | null> {
    const key = id as string;
    if (userCache.has(key)) return userCache.get(key) ?? null;
    const row = await ctx.db.get(id);
    userCache.set(key, row);
    return row;
  }

  async function groupById(id: Id<"groups">): Promise<Group | null> {
    const key = id as string;
    if (groupCache.has(key)) return groupCache.get(key) ?? null;
    const row = await ctx.db.get(id);
    groupCache.set(key, row);
    return row;
  }

  return {
    ctx,
    userId,
    user,
    active: user?.accountState === "active",
    exact,
    manager,
    userById,
    groupById,
  };
}

type ViewerFlags = {
  canClaim: boolean;
  canMarkDone: boolean;
  canForward: boolean;
  canReassign: boolean;
  canClose: boolean;
  canReopen: boolean;
  canArchive: boolean;
  canHide: boolean;
};

async function viewerFlags(
  viewer: ViewerContext,
  task: Task,
  group: Group,
): Promise<ViewerFlags> {
  const member = await isExactMember(viewer.ctx, viewer.userId, group);
  const manager = await viewer.manager(group);
  const sender = task.senderMayClose && task.senderId === viewer.userId;
  const claimant = task.claimedBy === viewer.userId;
  const closeAuthority = manager || sender;
  const transitional =
    task.status === "open" || task.status === "claimed" || task.status === "done";
  return {
    canClaim: viewer.active && member && task.status === "open",
    canMarkDone: viewer.active && claimant && task.status === "claimed",
    canForward: viewer.active && claimant && task.status === "claimed",
    canReassign: viewer.active && !claimant && closeAuthority && task.status === "claimed",
    canClose: viewer.active && closeAuthority && transitional,
    canReopen: viewer.active && (manager || sender) && task.status === "done",
    canArchive: viewer.active && manager && transitional,
    canHide:
      viewer.active && closeAuthority && task.status === "closed" && task.archivedAt === undefined,
  };
}

async function userSummary(
  viewer: ViewerContext,
  id: Id<"users"> | undefined,
): Promise<{ publicId: string | null; name: string | null }> {
  if (id === undefined) return { publicId: null, name: null };
  const user = await viewer.userById(id);
  return { publicId: user?.publicId ?? null, name: user?.name ?? null };
}

export type TaskCard = {
  publicId: string;
  status: TaskStatus;
  flagType: Task["flagType"];
  claimedByPublicId: string | null;
  claimedByName: string | null;
  closedByPublicId: string | null;
  closedByName: string | null;
  forwardedToPublicId: string | null;
  forwardedToName: string | null;
  senderMayClose: boolean;
  archivedAt: number | null;
  hidden: boolean;
  viewer: ViewerFlags;
};

async function cardForTask(
  viewer: ViewerContext,
  task: Task,
  group: Group,
): Promise<TaskCard> {
  const claimedBy = await userSummary(viewer, task.claimedBy);
  const closedBy = await userSummary(viewer, task.closedBy);
  const forwardedTo = await userSummary(viewer, task.forwardedTo);
  return {
    publicId: task.publicId,
    status: task.status,
    flagType: task.flagType,
    claimedByPublicId: claimedBy.publicId,
    claimedByName: claimedBy.name,
    closedByPublicId: closedBy.publicId,
    closedByName: closedBy.name,
    forwardedToPublicId: forwardedTo.publicId,
    forwardedToName: forwardedTo.name,
    senderMayClose: task.senderMayClose,
    archivedAt: task.archivedAt ?? null,
    hidden: task.archivedAt !== undefined,
    viewer: await viewerFlags(viewer, task, group),
  };
}

/** Bounded batch renderer for `messages.listLive` / history: only action messages carry a card. */
export async function renderTaskCards(
  ctx: QueryCtx,
  messages: Doc<"messages">[],
  viewerId: Id<"users">,
): Promise<Map<string, TaskCard>> {
  const out = new Map<string, TaskCard>();
  const actionMessages = messages.filter((message) => message.mode === "action");
  if (actionMessages.length === 0) return out;
  const viewer = await viewerContext(ctx, viewerId);
  for (const message of actionMessages) {
    const task = await ctx.db
      .query("actionInbox")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .unique();
    if (task === null) continue;
    const group = await viewer.groupById(task.groupId);
    if (group === null) continue;
    out.set(message.publicId, await cardForTask(viewer, task, group));
  }
  return out;
}

async function taskRow(
  ctx: QueryCtx,
  viewer: ViewerContext,
  task: Task,
  group: Group,
) {
  const card = await cardForTask(viewer, task, group);
  const message = await ctx.db.get(task.messageId);
  const sender = await userSummary(viewer, task.senderId);
  return {
    ...card,
    messagePublicId: message?.publicId ?? null,
    messageText: (message?.text ?? "").slice(0, 180),
    groupPublicId: group.kind === "group" ? group.publicId : null,
    groupPath: group.kind === "group" ? group.path : null,
    groupName: group.kind === "group" ? group.name : "Direct message",
    senderPublicId: sender.publicId,
    senderName: sender.name,
    createdAt: task._creationTime,
  };
}

async function rowsForTasks(
  ctx: QueryCtx,
  viewer: ViewerContext,
  tasks: Task[],
): Promise<Array<Awaited<ReturnType<typeof taskRow>>>> {
  const rows = [];
  for (const task of tasks) {
    const group = await viewer.groupById(task.groupId);
    if (group === null) continue;
    rows.push(await taskRow(ctx, viewer, task, group));
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

// --------------------------------------------------------------------------------------------
// Mutations
// --------------------------------------------------------------------------------------------

export const claim = mutation({
  args: { taskPublicId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const task = await taskByPublicId(ctx, args.taskPublicId);
    const group = await groupForTask(ctx, task);

    // Exact membership only. An ancestor manager has oversight but not claim rights (CR-10).
    if (!(await isExactMember(ctx, user._id, group))) {
      throw new Error("Only a member of this task's group may claim it");
    }
    if (task.status !== "open") {
      throw new Error(`This task is ${task.status}; only an open task can be claimed`);
    }

    const now = Date.now();
    await ctx.db.patch(task._id, {
      status: "claimed",
      claimedBy: user._id,
      closedBy: undefined,
    });
    await ctx.db.insert("actionEvents", {
      actionInboxId: task._id,
      action: "claimed",
      actorId: user._id,
      timestamp: now,
    });
    await emitTaskWebhook(ctx, task, "task.claimed", {
      claimedBy: { publicId: user.publicId, email: user.email },
    });
    return { taskPublicId: task.publicId, status: "claimed" as const };
  },
});

export const markDone = mutation({
  args: { taskPublicId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const task = await taskByPublicId(ctx, args.taskPublicId);
    if (task.status !== "claimed") {
      throw new Error(`This task is ${task.status}; only a claimed task can be marked done`);
    }
    if (task.claimedBy !== user._id) {
      throw new Error("Only the current claimant can mark this task done");
    }
    const now = Date.now();
    await ctx.db.patch(task._id, { status: "done" });
    await ctx.db.insert("actionEvents", {
      actionInboxId: task._id,
      action: "done",
      actorId: user._id,
      timestamp: now,
    });
    await emitTaskWebhook(ctx, task, "task.done");
    return { taskPublicId: task.publicId, status: "done" as const };
  },
});

async function targetForTransfer(
  ctx: MutationCtx,
  task: Task,
  group: Group,
  toUserPublicId: string,
): Promise<Doc<"users">> {
  const target = await ctx.db
    .query("users")
    .withIndex("by_public_id", (q) => q.eq("publicId", toUserPublicId))
    .unique();
  if (target === null) throw new Error("Target user not found");
  if (target.accountState !== "active") {
    throw new Error(`Target account is "${target.accountState}"; an active account is required`);
  }
  if (!(await isExactMember(ctx, target._id, group))) {
    throw new Error("The target must be a member of this task's group");
  }
  if (target._id === task.claimedBy) {
    throw new Error("The target is already the current claimant");
  }
  return target;
}

export const forward = mutation({
  args: { taskPublicId: v.string(), toUserPublicId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const task = await taskByPublicId(ctx, args.taskPublicId);
    const group = await groupForTask(ctx, task);
    if (task.status !== "claimed") {
      throw new Error(`This task is ${task.status}; only a claimed task can be forwarded`);
    }
    if (task.claimedBy !== user._id) {
      throw new Error("Only the current claimant can forward this task");
    }
    const target = await targetForTransfer(ctx, task, group, args.toUserPublicId);
    if (target._id === user._id) throw new Error("You cannot forward a task to yourself");

    const now = Date.now();
    await ctx.db.patch(task._id, { claimedBy: target._id, forwardedTo: target._id });
    await ctx.db.insert("actionEvents", {
      actionInboxId: task._id,
      action: "forwarded",
      actorId: user._id,
      fromUserId: user._id,
      toUserId: target._id,
      timestamp: now,
    });
    await emitTaskWebhook(ctx, task, "task.forwarded");
    return { taskPublicId: task.publicId, status: "claimed" as const, toUserPublicId: target.publicId };
  },
});

export const reassign = mutation({
  args: { taskPublicId: v.string(), toUserPublicId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const task = await taskByPublicId(ctx, args.taskPublicId);
    const group = await groupForTask(ctx, task);
    if (task.status !== "claimed") {
      throw new Error(`This task is ${task.status}; a done task is reopened, not reassigned`);
    }
    const manager = await managerAtOrAbove(ctx, user._id, group);
    const sender = task.senderMayClose && task.senderId === user._id;
    if (!manager && !sender) {
      throw new Error("Only an eligible closer can reassign a claimed task");
    }
    if (task.claimedBy === user._id) {
      throw new Error("The current claimant must use forward; reassign is for a different closer");
    }
    const target = await targetForTransfer(ctx, task, group, args.toUserPublicId);

    const now = Date.now();
    const fromUserId = task.claimedBy;
    if (fromUserId === undefined) throw new Error("Claimed task has no claimant");
    await ctx.db.patch(task._id, { claimedBy: target._id, forwardedTo: target._id });
    await ctx.db.insert("actionEvents", {
      actionInboxId: task._id,
      action: "forwarded",
      actorId: user._id,
      fromUserId,
      toUserId: target._id,
      timestamp: now,
    });
    await emitTaskWebhook(ctx, task, "task.forwarded");
    return { taskPublicId: task.publicId, status: "claimed" as const, toUserPublicId: target.publicId };
  },
});

export const close = mutation({
  args: { taskPublicId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const task = await taskByPublicId(ctx, args.taskPublicId);
    const group = await groupForTask(ctx, task);

    if (task.status !== "open" && task.status !== "claimed" && task.status !== "done") {
      throw new Error(`This task is ${task.status}; closed and archived are terminal`);
    }
    const manager = await managerAtOrAbove(ctx, user._id, group);
    const sender = task.senderMayClose && task.senderId === user._id;
    if (!manager && !sender) {
      throw new Error(
        "Only a group manager/owner (at this group or an ancestor) or the sender may close this task",
      );
    }

    // Separation of duties: an assignee may close only when no other eligible closer exists.
    if (task.claimedBy === user._id) {
      const closers = await eligibleCloserIds(ctx, task, group);
      for (const id of closers) {
        if (id !== user._id) {
          throw new Error(
            "Another eligible closer exists; separation of duties requires them to close this task",
          );
        }
      }
    }

    const selfClosed = task.claimedBy === user._id;
    const now = Date.now();
    await ctx.db.patch(task._id, {
      status: "closed",
      closedBy: user._id,
    });
    await ctx.db.insert("actionEvents", {
      actionInboxId: task._id,
      action: "closed",
      actorId: user._id,
      selfClosed,
      timestamp: now,
    });
    await emitTaskWebhook(ctx, task, "task.closed");
    return { taskPublicId: task.publicId, status: "closed" as const, selfClosed };
  },
});

export const reopen = mutation({
  args: { taskPublicId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const task = await taskByPublicId(ctx, args.taskPublicId);
    const group = await groupForTask(ctx, task);
    if (task.status !== "done") {
      throw new Error(`This task is ${task.status}; only a done task can be reopened`);
    }
    const manager = await managerAtOrAbove(ctx, user._id, group);
    const sender = task.senderMayClose && task.senderId === user._id;
    if (!manager && !sender) {
      throw new Error("Only an eligible closer or the sender may reopen this task");
    }
    if (task.claimedBy === undefined) {
      throw new Error("Done task has no original claimant to return to");
    }

    const now = Date.now();
    await ctx.db.patch(task._id, {
      status: "claimed",
      closedBy: undefined,
    });
    await ctx.db.insert("actionEvents", {
      actionInboxId: task._id,
      action: "reopened",
      actorId: user._id,
      reason: "sender_review",
      timestamp: now,
    });
    await emitTaskWebhook(ctx, task, "task.reopened");
    return {
      taskPublicId: task.publicId,
      status: "claimed" as const,
      claimedByPublicId: (await ctx.db.get(task.claimedBy))?.publicId ?? null,
    };
  },
});

export const archive = mutation({
  args: { taskPublicId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const task = await taskByPublicId(ctx, args.taskPublicId);
    const group = await groupForTask(ctx, task);
    if (task.status !== "open" && task.status !== "claimed" && task.status !== "done") {
      throw new Error(`This task is ${task.status}; closed and archived are terminal`);
    }
    if (!(await managerAtOrAbove(ctx, user._id, group))) {
      throw new Error(
        "Only a group manager/owner (at this group or an ancestor), or a DM participant, may archive",
      );
    }

    const now = Date.now();
    await ctx.db.patch(task._id, { status: "archived" });
    await ctx.db.insert("actionEvents", {
      actionInboxId: task._id,
      action: "archived",
      actorId: user._id,
      timestamp: now,
    });
    return { taskPublicId: task.publicId, status: "archived" as const };
  },
});

/**
 * Retention, not a transition. Only a `closed` task can be hidden; `status` stays "closed".
 * No event is written because no workflow state changed.
 */
export const hideClosed = mutation({
  args: { taskPublicId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const task = await taskByPublicId(ctx, args.taskPublicId);
    const group = await groupForTask(ctx, task);
    if (task.status !== "closed") {
      throw new Error(`This task is ${task.status}; only a closed task can be hidden`);
    }
    const manager = await managerAtOrAbove(ctx, user._id, group);
    const sender = task.senderMayClose && task.senderId === user._id;
    if (!manager && !sender) {
      throw new Error("Only an eligible closer may hide a closed task");
    }
    if (task.archivedAt === undefined) {
      await ctx.db.patch(task._id, { archivedAt: Date.now() });
    }
    return { taskPublicId: task.publicId, status: "closed" as const, hidden: true };
  },
});

// --------------------------------------------------------------------------------------------
// Queries
// --------------------------------------------------------------------------------------------

/** Rollup: the group's own tasks plus every descendant, one indexed query per live status. */
export const rollup = query({
  args: {
    groupPublicId: v.string(),
    status: v.optional(taskStatusValidator),
    includeHidden: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);
    const group = await ctx.db
      .query("groups")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.groupPublicId))
      .unique();
    if (group === null || group.kind !== "group") throw new Error("Group not found");
    await requireGroupAccess(ctx, userId, group._id);
    if (args.status === "archived") {
      throw new Error("Archived tasks are audit-only and excluded from the rollup");
    }

    const statuses = args.status !== undefined ? [args.status] : LIVE_STATUSES;
    const prefix = `${group.path}/`;
    const upper = `${group.path}0`; // '/' is below '0', so every descendant sorts inside this range.
    const viewer = await viewerContext(ctx, userId);
    const counts: Record<string, number> = {};
    const tasks: Task[] = [];

    for (const status of statuses) {
      const rows = await ctx.db
        .query("actionInbox")
        .withIndex("by_status_path", (q) =>
          q.eq("status", status).gte("groupPath", group.path).lt("groupPath", upper),
        )
        .take(MAX_ROWS_PER_STATUS + 1);
      counts[status] = rows.length;
      for (const task of rows) {
        if (status === "closed" && task.archivedAt !== undefined && args.includeHidden !== true) {
          continue;
        }
        tasks.push(task);
      }
      void prefix;
    }

    return {
      groupPublicId: group.publicId,
      groupPath: group.path,
      counts,
      tasks: await rowsForTasks(ctx, viewer, tasks),
    };
  },
});

/** "My tasks": the queue of tasks assigned to the caller, one indexed query per status. */
export const myTasks = query({
  args: { status: v.optional(taskStatusValidator) },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);
    const status = args.status ?? "claimed";
    const tasks = await ctx.db
      .query("actionInbox")
      .withIndex("by_claimant", (q) => q.eq("claimedBy", userId).eq("status", status))
      .take(MAX_ROWS_PER_STATUS);
    const viewer = await viewerContext(ctx, userId);
    return { status, tasks: await rowsForTasks(ctx, viewer, tasks) };
  },
});

/** "Tasks I raised": tasks sent by the caller, one indexed query per status. */
export const raisedByMe = query({
  args: { status: v.optional(taskStatusValidator) },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);
    const status = args.status ?? "open";
    const tasks = await ctx.db
      .query("actionInbox")
      .withIndex("by_sender", (q) => q.eq("senderId", userId).eq("status", status))
      .take(MAX_ROWS_PER_STATUS);
    const viewer = await viewerContext(ctx, userId);
    return { status, tasks: await rowsForTasks(ctx, viewer, tasks) };
  },
});

/** Append-only audit trail for one task, chronological. */
export const events = query({
  args: { taskPublicId: v.string() },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);
    const task = await taskByPublicId(ctx, args.taskPublicId);
    await requireTaskRead(ctx, userId, task);
    const rows = await ctx.db
      .query("actionEvents")
      .withIndex("by_inbox_time", (q) => q.eq("actionInboxId", task._id))
      .order("asc")
      .collect();
    const viewer = await viewerContext(ctx, userId);
    const out = [];
    for (const row of rows) {
      const actor = await userSummary(viewer, row.actorId);
      if (row.action === "forwarded") {
        const from = await userSummary(viewer, row.fromUserId);
        const to = await userSummary(viewer, row.toUserId);
        out.push({
          action: row.action,
          actorPublicId: actor.publicId,
          actorName: actor.name,
          fromPublicId: from.publicId,
          fromName: from.name,
          toPublicId: to.publicId,
          toName: to.name,
          reason: null,
          selfClosed: null,
          timestamp: row.timestamp,
        });
      } else if (row.action === "reopened") {
        out.push({
          action: row.action,
          actorPublicId: actor.publicId,
          actorName: actor.name,
          fromPublicId: null,
          fromName: null,
          toPublicId: null,
          toName: null,
          reason: row.reason,
          selfClosed: null,
          timestamp: row.timestamp,
        });
      } else if (row.action === "closed") {
        out.push({
          action: row.action,
          actorPublicId: actor.publicId,
          actorName: actor.name,
          fromPublicId: null,
          fromName: null,
          toPublicId: null,
          toName: null,
          reason: null,
          selfClosed: row.selfClosed,
          timestamp: row.timestamp,
        });
      } else {
        out.push({
          action: row.action,
          actorPublicId: actor.publicId,
          actorName: actor.name,
          fromPublicId: null,
          fromName: null,
          toPublicId: null,
          toName: null,
          reason: null,
          selfClosed: null,
          timestamp: row.timestamp,
        });
      }
    }
    return { taskPublicId: task.publicId, events: out };
  },
});

/** Active members who can receive this task via forward/reassign. */
export const assignableMembers = query({
  args: { taskPublicId: v.string() },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);
    const task = await taskByPublicId(ctx, args.taskPublicId);
    const group = await groupForTask(ctx, task);
    const member = await isExactMember(ctx, userId, group);
    const manager = await managerAtOrAbove(ctx, userId, group);
    if (!member && !manager) {
      throw new Error("You do not have access to this task's group");
    }

    const rows =
      group.kind === "dm"
        ? await Promise.all(group.participantIds.map(async (id) => [id, "owner"] as const))
        : (
            await ctx.db
              .query("memberships")
              .withIndex("by_group", (q) => q.eq("groupId", group._id))
              .collect()
          ).map((row) => [row.userId, row.role] as const);

    const out = [];
    for (const [id, role] of rows) {
      const user = await ctx.db.get(id);
      if (user === null || user.accountState !== "active") continue;
      out.push({ userPublicId: user.publicId, name: user.name ?? "Unknown", role });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },
});
