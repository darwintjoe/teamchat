// Guard helpers (v0 brief build item 1). Every client-facing function goes through one of
// these; none of them trusts a client-supplied id — the user comes from the auth session.

import { getAuthUserId } from "@convex-dev/auth/server";
import { QueryCtx, MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

export type DbCtx = QueryCtx | MutationCtx;
export type OrgRole = "owner" | "admin" | "member";
export type GroupRole = "owner" | "manager" | "member";

/**
 * Identity only — JWT-backed, no database read. Use when the caller's user document is not
 * needed (e.g. `hasUnread`, which must read exactly two documents).
 */
export async function requireUserId(ctx: DbCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Not signed in");
  return userId;
}

/** Signed in, and the user document exists. */
export async function requireUser(ctx: DbCtx): Promise<Doc<"users">> {
  const userId = await requireUserId(ctx);
  const user = await ctx.db.get(userId);
  if (user === null) throw new Error("User record not found");
  return user;
}

/**
 * Signed in and email-OTP verified. Provisioned and shadow accounts are rejected here: they
 * cannot sign in to the standalone app in Phase 1 (CR-9) and must not act as app users.
 */
export async function requireActive(ctx: DbCtx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (user.accountState !== "active") {
    throw new Error(`Account is "${user.accountState}"; an active account is required`);
  }
  return user;
}

/**
 * Signed in as a full app user. Shadow (widget) accounts are confined to the widget-only
 * functions in `convex/widgets/`; they cannot browse the standalone surfaces.
 */
export async function requireNotShadow(ctx: DbCtx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (user.accountState === "shadow") {
    throw new Error("Widget accounts can only use the embedded widget");
  }
  return user;
}

/** Active, and a row exists in `orgMembers`. Optionally narrow to specific org roles. */
export async function requireOrgMember(
  ctx: DbCtx,
  orgId: Id<"organizations">,
  roles?: OrgRole[],
): Promise<{ user: Doc<"users">; orgMember: Doc<"orgMembers"> }> {
  const user = await requireActive(ctx);
  const orgMember = await ctx.db
    .query("orgMembers")
    .withIndex("by_unique", (q) => q.eq("uniqueKey", `${orgId}:${user._id}`))
    .unique();
  if (orgMember === null) throw new Error("Not a member of this organisation");
  if (roles !== undefined && !roles.includes(orgMember.orgRole)) {
    throw new Error(`Requires org role: ${roles.join(", ")}`);
  }
  return { user, orgMember };
}

/** A `memberships` row for this group with one of `roles` (membership role, not org role). */
export async function requireGroupRole(
  ctx: DbCtx,
  userId: Id<"users">,
  groupId: Id<"groups">,
  roles?: GroupRole[],
): Promise<Doc<"memberships">> {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_unique", (q) => q.eq("uniqueKey", `${groupId}:${userId}`))
    .unique();
  if (membership === null) throw new Error("You are not a member of this group");
  if (roles !== undefined && !roles.includes(membership.role)) {
    throw new Error(`Requires group role: ${roles.join(", ")}`);
  }
  return membership;
}

/**
 * Read access to a group: a membership row, or org owner/admin on a tree group
 * ("Parents see children in the locked tree, so an org owner can drill into any group").
 * DMs never confer org-admin access — a DM has no org.
 */
export async function requireGroupAccess(
  ctx: DbCtx,
  userId: Id<"users">,
  groupId: Id<"groups">,
): Promise<{ group: Doc<"groups">; membership: Doc<"memberships"> | null; via: "membership" | "org_admin" }> {
  const group = await ctx.db.get(groupId);
  if (group === null) throw new Error("Group not found");
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_unique", (q) => q.eq("uniqueKey", `${groupId}:${userId}`))
    .unique();
  if (membership !== null) return { group, membership, via: "membership" };
  if (group.kind === "group") {
    const orgMember = await ctx.db
      .query("orgMembers")
      .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group.orgId}:${userId}`))
      .unique();
    if (orgMember !== null && orgMember.orgRole !== "member") {
      return { group, membership: null, via: "org_admin" };
    }
  }
  throw new Error("You do not have access to this group");
}
