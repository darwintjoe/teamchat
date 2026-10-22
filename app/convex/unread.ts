// Unread and read pointers (build item 5). No per-message counter exists anywhere.
//
// `hasUnread` is the O9 lever: the verdict compares exactly two documents —
// `groupActivity.lastMessageAt` against `memberships.lastReadAt` — and never scans messages.
// Tree conversations can be resolved in exactly two document reads when the client passes the
// group path it already has from the chat list (`by_user_path` lookup → `groupActivity` lookup).
// DMs need address resolution first (peer → dmKey → group) because Part 3's DM variant carries no
// path or publicId by design; the verdict itself is still the same two-document comparison.
//
// `unreadCount` is a separate ON-DEMAND query: newest ≤100 messages, displayed as "99+". It runs
// only when a number is actually rendered, never as part of the chat list.

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { conversationAddressValidator, resolveConversation } from "./lib/address";
import { requireNotShadow, requireUserId } from "./lib/guards";

export const hasUnread = query({
  args: {
    conversation: conversationAddressValidator,
    /** The conversation's `path` from `groups.listMine`; enables the two-read fast path. */
    groupPath: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);

    // Fast path: one membership read, one activity read.
    if (args.conversation.kind === "group" && args.groupPath !== undefined) {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user_path", (q) =>
          q.eq("userId", userId).eq("groupPath", args.groupPath),
        )
        .unique();
      if (membership !== null) {
        const activity = await ctx.db
          .query("groupActivity")
          .withIndex("by_group", (q) => q.eq("groupId", membership.groupId))
          .unique();
        if (activity === null || activity.lastMessageAt === 0) return false;
        return activity.lastMessageAt > (membership.lastReadAt ?? 0);
      }
    }

    // Fallback (DMs, or a stale client without the path): resolve, then the same two reads.
    const { group, membership } = await resolveConversation(ctx, userId, args.conversation);
    const activity = await ctx.db
      .query("groupActivity")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .unique();
    if (activity === null || activity.lastMessageAt === 0) return false;
    return activity.lastMessageAt > (membership.lastReadAt ?? 0);
  },
});

/**
 * On-demand bounded count of messages newer than the reader's pointer, `take(100)`.
 * Rendered as "99+". Own messages never count (the sender's pointer advanced on send) and
 * soft-deleted messages do not count.
 */
export const unreadCount = query({
  args: { conversation: conversationAddressValidator },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);
    const { group, membership } = await resolveConversation(ctx, userId, args.conversation);
    const lastReadAt = membership.lastReadAt ?? 0;
    const newest = await ctx.db
      .query("messages")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .order("desc")
      .take(100);
    let count = 0;
    for (const message of newest) {
      if (message._creationTime <= lastReadAt) break;
      if (message.deletedAt !== undefined) continue;
      if (message.senderId === userId) continue;
      count++;
    }
    return { count, capped: count >= 100, display: count >= 100 ? "99+" : String(count) };
  },
});

/**
 * Flow A3. The client sends the last message ID it has seen — never a timestamp.
 * Validates the message belongs to the conversation and is not older than the current pointer,
 * then stores both the message id and its server `_creationTime`.
 */
export const markRead = mutation({
  args: {
    conversation: conversationAddressValidator,
    lastMessagePublicId: v.string(),
  },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);
    const { group, membership } = await resolveConversation(ctx, userId, args.conversation);
    const message = await ctx.db
      .query("messages")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.lastMessagePublicId))
      .unique();
    if (message === null) throw new Error("Message not found");
    if (message.groupId !== group._id) {
      throw new Error("Message does not belong to this conversation");
    }
    if (membership.lastReadAt !== undefined && message._creationTime < membership.lastReadAt) {
      // Stale client: never move the pointer backwards. Silent no-op, not an error — a pending
      // markRead racing the sender-exception update is normal.
      return { updated: false as const, lastReadAt: membership.lastReadAt };
    }
    await ctx.db.patch(membership._id, {
      lastReadAt: message._creationTime,
      lastReadMessageId: message._id,
    });
    return { updated: true as const, lastReadAt: message._creationTime };
  },
});
