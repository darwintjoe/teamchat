// Groups and the flat v0 tree (build item 3). CR-17: groups are direct children of the org root;
// nesting below that level is rejected. Reparenting does not exist. Renaming changes the display
// name only — the path is made of publicId segments and is immutable.
//
// DMs (build item 6) live in the same table as a discriminated-union variant with no path, no
// orgId and no publicId; the S1 probe verified that an absent `path` is structurally excluded
// from every path query, so a DM can never appear in a tree.

import { mutation, query, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { assertDmCapable, checkDmPolicy } from "./lib/dmPolicy";
import { DbCtx, requireActive, requireNotShadow, requireOrgMember, requireUserId } from "./lib/guards";
import { newPublicId } from "./lib/ids";
import { Doc, Id } from "./_generated/dataModel";

const groupRoleValidator = v.union(v.literal("owner"), v.literal("manager"), v.literal("member"));

/**
 * Manage rights for a tree group: its owner/manager, or an org owner/admin
 * ("Parents see children in the locked tree, so an org owner can drill into any group").
 */
async function requireGroupManage(
  ctx: MutationCtx,
  userId: Id<"users">,
  group: Doc<"groups">,
): Promise<void> {
  if (group.kind !== "group") throw new Error("This operation applies to tree groups");
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group._id}:${userId}`))
    .unique();
  if (membership !== null && (membership.role === "owner" || membership.role === "manager")) return;
  const orgMember = await ctx.db
    .query("orgMembers")
    .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group.orgId}:${userId}`))
    .unique();
  if (orgMember !== null && orgMember.orgRole !== "member") return;
  throw new Error("Requires group owner/manager or org owner/admin");
}

async function groupByPublicId(ctx: DbCtx, publicId: string): Promise<Doc<"groups">> {
  const group = await ctx.db
    .query("groups")
    .withIndex("by_public_id", (q) => q.eq("publicId", publicId))
    .unique();
  if (group === null) throw new Error("Group not found");
  return group;
}

/**
 * Create a flat group. `parentGroupPublicId`, when given, must be the org root — anything else
 * is rejected as nesting. `memberPublicIds` must all be members of the org.
 */
export const create = mutation({
  args: {
    orgPublicId: v.string(),
    name: v.string(),
    parentGroupPublicId: v.optional(v.string()),
    memberPublicIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    const { user } = await requireOrgMember(ctx, org._id, ["owner", "admin"]);

    const name = args.name.trim();
    if (name === "") throw new Error("Group name is required");
    if (org.rootGroupId === undefined) throw new Error("Organisation has no root group");
    const root = await ctx.db.get(org.rootGroupId);
    if (root === null || root.kind !== "group") throw new Error("Organisation root group is missing");

    if (args.parentGroupPublicId !== undefined) {
      const parent = await groupByPublicId(ctx, args.parentGroupPublicId);
      if (parent.kind !== "group" || parent._id !== root._id) {
        throw new Error(
          "Nested groups are not permitted: v0 groups are direct children of the org root (CR-17)",
        );
      }
    }

    const publicId = newPublicId("grp");
    const path = `/${org.publicId}/${publicId}`;
    const now = Date.now();
    const groupId = await ctx.db.insert("groups", {
      kind: "group",
      publicId,
      name,
      orgId: org._id,
      parentGroupId: root._id,
      path,
    });
    await ctx.db.insert("memberships", {
      groupId,
      userId: user._id,
      role: "owner",
      groupPath: path,
      joinedAt: now,
      uniqueKey: `${groupId}:${user._id}`,
    });
    await ctx.db.insert("groupActivity", { groupId, lastMessageAt: 0, flushPending: false });

    const added: string[] = [];
    const seen = new Set<string>([user.publicId]);
    for (const memberPublicId of args.memberPublicIds ?? []) {
      if (seen.has(memberPublicId)) continue;
      seen.add(memberPublicId);
      const member = await ctx.db
        .query("users")
        .withIndex("by_public_id", (q) => q.eq("publicId", memberPublicId))
        .unique();
      if (member === null) throw new Error(`User "${memberPublicId}" not found`);
      const orgMembership = await ctx.db
        .query("orgMembers")
        .withIndex("by_unique", (q) => q.eq("uniqueKey", `${org._id}:${member._id}`))
        .unique();
      if (orgMembership === null) {
        throw new Error(`"${member.name}" is not a member of this organisation`);
      }
      await ctx.db.insert("memberships", {
        groupId,
        userId: member._id,
        role: "member",
        groupPath: path,
        joinedAt: now,
        uniqueKey: `${groupId}:${member._id}`,
      });
      added.push(member.publicId);
    }

    return { groupPublicId: publicId, path, parentGroupPublicId: root.publicId, memberPublicIds: added };
  },
});

/** Group header for a member (or org admin). */
export const get = query({
  args: { groupPublicId: v.string() },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);
    const group = await groupByPublicId(ctx, args.groupPublicId);
    if (group.kind !== "group") throw new Error("Not a tree group");
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group._id}:${userId}`))
      .unique();
    if (membership === null) {
      const orgMember = await ctx.db
        .query("orgMembers")
        .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group.orgId}:${userId}`))
        .unique();
      if (orgMember === null || orgMember.orgRole === "member") {
        throw new Error("You do not have access to this group");
      }
    }
    return { publicId: group.publicId, name: group.name, path: group.path, myRole: membership?.role ?? null };
  },
});

/** Rename changes the display name only; the path is untouched (reparenting is disabled). */
export const rename = mutation({
  args: { groupPublicId: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);
    const group = await groupByPublicId(ctx, args.groupPublicId);
    if (group.kind !== "group") throw new Error("Not a tree group");
    await requireGroupManage(ctx, userId, group);
    const name = args.name.trim();
    if (name === "") throw new Error("Group name is required");
    await ctx.db.patch(group._id, { name });
    return { publicId: group.publicId, name, path: group.path };
  },
});

/** Add an org member to a tree group. */
export const addMember = mutation({
  args: {
    groupPublicId: v.string(),
    userPublicId: v.string(),
    role: v.optional(groupRoleValidator),
  },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);
    const group = await groupByPublicId(ctx, args.groupPublicId);
    if (group.kind !== "group") throw new Error("Not a tree group");
    await requireGroupManage(ctx, userId, group);
    const target = await ctx.db
      .query("users")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.userPublicId))
      .unique();
    if (target === null) throw new Error("User not found");
    const orgMembership = await ctx.db
      .query("orgMembers")
      .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group.orgId}:${target._id}`))
      .unique();
    if (orgMembership === null) throw new Error("That user is not a member of this organisation");
    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group._id}:${target._id}`))
      .unique();
    if (existing !== null) return { added: false, role: existing.role };
    await ctx.db.insert("memberships", {
      groupId: group._id,
      userId: target._id,
      role: args.role ?? "member",
      groupPath: group.path,
      joinedAt: Date.now(),
      uniqueKey: `${group._id}:${target._id}`,
    });
    return { added: true, role: args.role ?? "member" };
  },
});

/** Remove a member. A group owner cannot be removed by a manager (org owners can). */
export const removeMember = mutation({
  args: { groupPublicId: v.string(), userPublicId: v.string() },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);
    const group = await groupByPublicId(ctx, args.groupPublicId);
    if (group.kind !== "group") throw new Error("Not a tree group");
    await requireGroupManage(ctx, userId, group);
    const target = await ctx.db
      .query("users")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.userPublicId))
      .unique();
    if (target === null) throw new Error("User not found");
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group._id}:${target._id}`))
      .unique();
    if (membership === null) return { removed: false };
    if (membership.role === "owner") {
      const callerOrg = await ctx.db
        .query("orgMembers")
        .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group.orgId}:${userId}`))
        .unique();
      if (callerOrg === null || callerOrg.orgRole !== "owner") {
        throw new Error("Only an org owner can remove a group owner");
      }
    }
    await ctx.db.delete(membership._id);
    return { removed: true };
  },
});

/**
 * The user's conversations: tree-group memberships and DMs, ordered like a chat list.
 * Ordering data comes from `groupActivity` (debounced), never from a messages scan.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user_path", (q) => q.eq("userId", userId))
      .collect();

    const rows: Array<{
      kind: "group" | "dm";
      publicId: string | null;
      peerPublicId: string | null;
      peerName: string | null;
      name: string;
      path: string | null;
      orgPublicId: string | null;
      role: "owner" | "manager" | "member";
      lastMessageAt: number;
      lastReadAt: number | null;
    }> = [];

    for (const membership of memberships) {
      const group = await ctx.db.get(membership.groupId);
      if (group === null) continue;
      const activity = await ctx.db
        .query("groupActivity")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .unique();
      const lastMessageAt = activity?.lastMessageAt ?? 0;

      if (group.kind === "group") {
        rows.push({
          kind: "group",
          publicId: group.publicId,
          peerPublicId: null,
          peerName: null,
          name: group.name,
          path: group.path,
          orgPublicId: group.path.split("/")[1] ?? null,
          role: membership.role,
          lastMessageAt,
          lastReadAt: membership.lastReadAt ?? null,
        });
      } else {
        const peerId = group.participantIds.find((id) => id !== userId);
        const peer = peerId !== undefined ? await ctx.db.get(peerId) : null;
        rows.push({
          kind: "dm",
          publicId: null,
          peerPublicId: peer?.publicId ?? null,
          peerName: peer?.name ?? "Unknown user",
          name: peer?.name ?? "Direct message",
          path: null,
          orgPublicId: null,
          role: membership.role,
          lastMessageAt,
          lastReadAt: membership.lastReadAt ?? null,
        });
      }
    }

    rows.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return rows;
  },
});

/**
 * The org tree. Org owner/admin see every tree group of the org; ordinary members see the groups
 * they belong to. DMs can never appear: the `by_org` index only matches the group variant (S1).
 */
export const tree = query({
  args: { orgPublicId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    const { user, orgMember } = await requireOrgMember(ctx, org._id);

    if (orgMember.orgRole !== "member") {
      const groups = await ctx.db
        .query("groups")
        .withIndex("by_org", (q) => q.eq("orgId", org._id))
        .collect();
      return groups
        .map((g) => ({
          publicId: g.kind === "group" ? g.publicId : "",
          name: g.kind === "group" ? g.name : "",
          path: g.kind === "group" ? g.path : "",
          isRoot: g._id === org.rootGroupId,
        }))
        .sort((a, b) => (a.isRoot ? -1 : b.isRoot ? 1 : a.path.localeCompare(b.path)));
    }

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user_path", (q) => q.eq("userId", user._id))
      .collect();
    const rows: Array<{ publicId: string; name: string; path: string; isRoot: boolean }> = [];
    for (const membership of memberships) {
      if (membership.groupPath === undefined) continue;
      if (!membership.groupPath.startsWith(`/${org.publicId}`)) continue;
      const group = await ctx.db.get(membership.groupId);
      if (group === null || group.kind !== "group" || group.orgId !== org._id) continue;
      rows.push({
        publicId: group.publicId,
        name: group.name,
        path: group.path,
        isRoot: group._id === org.rootGroupId,
      });
    }
    return rows.sort((a, b) => (a.isRoot ? -1 : b.isRoot ? 1 : a.path.localeCompare(b.path)));
  },
});

/**
 * Create (or return) a DM with another user. Policy — decision 3: any shared org that allows DMs
 * is enough; no shared org means personal connection, allowed; shared orgs with DM disabled by
 * all means deny. Shadow and bot accounts are excluded (locked rule).
 */
export const createDm = mutation({
  args: { userPublicId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const peerPublicId = args.userPublicId.trim();
    if (peerPublicId === user.publicId) throw new Error("You cannot direct-message yourself");
    const peer = await ctx.db
      .query("users")
      .withIndex("by_public_id", (q) => q.eq("publicId", peerPublicId))
      .unique();
    if (peer === null) throw new Error("User not found");
    assertDmCapable(user, "sender");
    assertDmCapable(peer, "recipient");

    const dmKey = [user._id, peer._id].sort().join(":");
    const existing = await ctx.db
      .query("groups")
      .withIndex("by_dm_key", (q) => q.eq("dmKey", dmKey))
      .unique();
    if (existing !== null && existing.kind === "dm") {
      return { peerPublicId: peer.publicId, peerName: peer.name, created: false };
    }

    const verdict = await checkDmPolicy(ctx, user._id, peer._id);
    const now = Date.now();
    const groupId = await ctx.db.insert("groups", {
      kind: "dm",
      dmKey,
      participantIds: [user._id, peer._id].sort() as Id<"users">[],
    });
    for (const participantId of [user._id, peer._id]) {
      await ctx.db.insert("memberships", {
        groupId,
        userId: participantId,
        // Both DM participants are owners of the DM (PRD Part 1 §2: for task purposes both are
        // treated as owner; v0 encodes that in the membership so later task code needs no change).
        role: "owner",
        joinedAt: now,
        uniqueKey: `${groupId}:${participantId}`,
      });
    }
    await ctx.db.insert("groupActivity", { groupId, lastMessageAt: 0, flushPending: false });
    return { peerPublicId: peer.publicId, peerName: peer.name, created: true, policy: verdict.policy };
  },
});
