// Flow A2 — chat-list ordering, debounced with a trailing flush.
//
// `lastMessageAt` is written at a bounded rate (at most one write per 3-second window per group),
// never on every message. The `flushPending` marker coalesces a burst into ONE scheduled flush;
// the flush recomputes the value from the group's actual latest message, so a debounced value is
// never wrong — only late (PRD Flow A2).

import { internalMutation, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { GROUP_ACTIVITY_DEBOUNCE_MS } from "./lib/time";
import { Id } from "./_generated/dataModel";

/** Called by `messages.send` in the same transaction as the message insert. */
export async function noteMessageForActivity(
  ctx: MutationCtx,
  groupId: Id<"groups">,
  messageAt: number,
): Promise<void> {
  const row = await ctx.db
    .query("groupActivity")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .unique();
  if (row === null) {
    await ctx.db.insert("groupActivity", {
      groupId,
      lastMessageAt: messageAt,
      flushPending: false,
    });
    return;
  }
  if (messageAt - row.lastMessageAt >= GROUP_ACTIVITY_DEBOUNCE_MS) {
    await ctx.db.patch(row._id, { lastMessageAt: messageAt, flushPending: false });
    return;
  }
  if (!row.flushPending) {
    await ctx.db.patch(row._id, { flushPending: true });
    await ctx.scheduler.runAfter(GROUP_ACTIVITY_DEBOUNCE_MS, internal.groupActivity.flush, {
      groupId,
    });
  }
  // If a flush is already pending: no write, no schedule. The pending flush recomputes from the
  // group's latest message, so this message cannot be lost.
}

export const flush = internalMutation({
  args: { groupId: v.id("groups") },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("groupActivity")
      .withIndex("by_group", (q) => q.eq("groupId", args.groupId))
      .unique();
    if (row === null || !row.flushPending) return { flushed: false as const };
    const latest = await ctx.db
      .query("messages")
      .withIndex("by_group", (q) => q.eq("groupId", args.groupId))
      .order("desc")
      .first();
    const lastMessageAt = latest !== null ? latest._creationTime : row.lastMessageAt;
    await ctx.db.patch(row._id, { lastMessageAt, flushPending: false });
    return { flushed: true as const, lastMessageAt };
  },
});
