// Conversation addressing. Clients never see `_id`; a conversation is either
//   { kind: "group", publicId }  — a tree group addressed by its publicId
//   { kind: "dm", peerPublicId } — a DM addressed by the other participant's publicId
// DMs intentionally have no publicId of their own: Part 3's union gives them none, and the
// peer's publicId is already a stable, non-internal handle.

import { v } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { DbCtx, requireGroupAccess } from "./guards";

export const conversationAddressValidator = v.union(
  v.object({ kind: v.literal("group"), publicId: v.string() }),
  v.object({ kind: v.literal("dm"), peerPublicId: v.string() }),
);

export type ConversationAddress =
  | { kind: "group"; publicId: string }
  | { kind: "dm"; peerPublicId: string };

export function dmKeyFor(a: Id<"users">, b: Id<"users">): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export async function resolveConversation(
  ctx: DbCtx,
  userId: Id<"users">,
  address: ConversationAddress,
): Promise<{
  group: Doc<"groups">;
  membership: Doc<"memberships">;
  peer?: Doc<"users">;
}> {
  if (address.kind === "group") {
    const group = await ctx.db
      .query("groups")
      .withIndex("by_public_id", (q) => q.eq("publicId", address.publicId))
      .unique();
    if (group === null || group.kind !== "group") throw new Error("Group not found");
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group._id}:${userId}`))
      .unique();
    if (membership === null) throw new Error("You are not a member of this group");
    return { group, membership };
  }

  const peer = await ctx.db
    .query("users")
    .withIndex("by_public_id", (q) => q.eq("publicId", address.peerPublicId))
    .unique();
  if (peer === null) throw new Error("User not found");
  if (peer._id === userId) throw new Error("You cannot direct-message yourself");
  const group = await ctx.db
    .query("groups")
    .withIndex("by_dm_key", (q) => q.eq("dmKey", dmKeyFor(userId, peer._id)))
    .unique();
  if (group === null || group.kind !== "dm") throw new Error("No direct message exists with this user yet");
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group._id}:${userId}`))
    .unique();
  if (membership === null) throw new Error("You are not a participant in this direct message");
  return { group, membership, peer };
}

/**
 * Read access. Tree groups allow an org owner/admin to drill in without a membership row
 * ("Parents see children in the locked tree"); DMs require participation. `membership` is null
 * only for the org-admin case.
 */
export async function resolveConversationForRead(
  ctx: DbCtx,
  userId: Id<"users">,
  address: ConversationAddress,
): Promise<{ group: Doc<"groups">; membership: Doc<"memberships"> | null }> {
  if (address.kind === "dm") {
    const { group, membership } = await resolveConversation(ctx, userId, address);
    return { group, membership };
  }
  const group = await ctx.db
    .query("groups")
    .withIndex("by_public_id", (q) => q.eq("publicId", address.publicId))
    .unique();
  if (group === null || group.kind !== "group") throw new Error("Group not found");
  const { membership } = await requireGroupAccess(ctx, userId, group._id);
  return { group, membership };
}
