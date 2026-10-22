// Invite links (v0 build item 2). The raw token exists only in the link handed to the user; the
// row stores its SHA-256 hash, matching the apiKeys pattern. Single use, expiring, revocable,
// rate-limited on redeem.
//
// Why `redeem` is an action: rate-limiter consumption is transactional. In a mutation, a failed
// redemption would roll the token consumption back, and a token-guessing loop would never be
// limited. The limit therefore runs in the action (its own transaction); the database work runs in
// `redeemInternal` afterwards. A failed attempt still costs a token.

import { action, internalMutation, mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { sha256Hex } from "./lib/crypto";
import { newSecretToken } from "./lib/ids";
import { rateLimiter } from "./lib/rateLimiter";
import { INVITE_TTL_MS } from "./lib/time";
import { requireUserId, requireOrgMember } from "./lib/guards";
import { Doc } from "./_generated/dataModel";

async function findInviteByToken(
  ctx: QueryCtx | MutationCtx,
  token: string,
): Promise<Doc<"orgInvites"> | null> {
  const tokenHash = await sha256Hex(token);
  return await ctx.db
    .query("orgInvites")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
}

export function inviteState(invite: Doc<"orgInvites">, now: number): "valid" | "used" | "revoked" | "expired" {
  if (invite.revokedAt !== undefined) return "revoked";
  if (invite.usedAt !== undefined) return "used";
  if (invite.expiresAt <= now) return "expired";
  return "valid";
}

/** Owner/admin creates an invite. The returned token is shown once; only its hash is stored. */
export const create = mutation({
  args: {
    orgPublicId: v.string(),
    ttlMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    const { user } = await requireOrgMember(ctx, org._id, ["owner", "admin"]);

    const ttl = args.ttlMs ?? INVITE_TTL_MS;
    if (ttl <= 0 || ttl > 30 * 24 * 60 * 60 * 1000) {
      throw new Error("Invite lifetime must be between 1 and 30 days");
    }
    const token = newSecretToken();
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    const expiresAt = now + ttl;
    await ctx.db.insert("orgInvites", {
      orgId: org._id,
      tokenHash,
      createdBy: user._id,
      createdAt: now,
      expiresAt,
    });
    return { token, expiresAt };
  },
});

/** Redeem: rate-limited per user, single use, expiring. Joins the org and its root group. */
export const redeem = action({
  args: { token: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ orgPublicId: string; orgName: string; alreadyMember: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not signed in");
    await rateLimiter.limit(ctx, "redeemInvite", { key: userId, throws: true });
    return await ctx.runMutation(internal.invites.redeemInternal, {
      token: args.token,
      userId,
    });
  },
});

export const redeemInternal = internalMutation({
  args: { token: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (user === null) throw new Error("User record not found");
    if (user.accountState !== "active") {
      throw new Error(`Account is "${user.accountState}"; an active account is required`);
    }

    const invite = await findInviteByToken(ctx, args.token);
    if (invite === null) throw new Error("This invite link is not valid");
    const state = inviteState(invite, Date.now());
    if (state !== "valid") {
      const messages: Record<string, string> = {
        used: "This invite link has already been used",
        revoked: "This invite link has been revoked",
        expired: "This invite link has expired",
      };
      throw new Error(messages[state]);
    }

    const org = await ctx.db.get(invite.orgId);
    if (org === null) throw new Error("This invite link's organisation no longer exists");

    const existingMember = await ctx.db
      .query("orgMembers")
      .withIndex("by_unique", (q) => q.eq("uniqueKey", `${org._id}:${user._id}`))
      .unique();
    if (existingMember !== null) {
      return { orgPublicId: org.publicId, orgName: org.name, alreadyMember: true };
    }

    const now = Date.now();
    await ctx.db.insert("orgMembers", {
      orgId: org._id,
      userId: user._id,
      orgRole: "member",
      joinedAt: now,
      uniqueKey: `${org._id}:${user._id}`,
    });

    if (org.rootGroupId !== undefined) {
      const rootGroup = await ctx.db.get(org.rootGroupId);
      if (rootGroup !== null && rootGroup.kind === "group") {
        await ctx.db.insert("memberships", {
          groupId: rootGroup._id,
          userId: user._id,
          role: "member",
          groupPath: rootGroup.path,
          joinedAt: now,
          uniqueKey: `${rootGroup._id}:${user._id}`,
        });
      }
    }

    await ctx.db.patch(invite._id, { usedAt: now, usedBy: user._id });
    return { orgPublicId: org.publicId, orgName: org.name, alreadyMember: false };
  },
});

/** Revoke an unused invite. Anyone with org owner/admin can revoke any invite of the org. */
export const revoke = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const invite = await findInviteByToken(ctx, args.token);
    if (invite === null) throw new Error("This invite link is not valid");
    await requireOrgMember(ctx, invite.orgId, ["owner", "admin"]);
    const state = inviteState(invite, Date.now());
    if (state === "used") throw new Error("This invite link has already been used");
    if (state === "revoked") return { revoked: true, alreadyRevoked: true };
    await ctx.db.patch(invite._id, { revokedAt: Date.now() });
    return { revoked: true, alreadyRevoked: false };
  },
});

/** Owner/admin view of an org's invites — metadata only, never the token or its hash. */
export const list = query({
  args: { orgPublicId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);
    const invites = await ctx.db
      .query("orgInvites")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    const now = Date.now();
    return invites.map((invite) => ({
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      state: inviteState(invite, now),
    }));
  },
});

/** Pre-flight check so the join screen can render "valid / used / revoked / expired". */
export const inspect = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireUserId(ctx);
    const invite = await findInviteByToken(ctx, args.token);
    if (invite === null) return { state: "invalid" as const };
    const state = inviteState(invite, Date.now());
    if (state !== "valid") return { state };
    const org = await ctx.db.get(invite.orgId);
    if (org === null) return { state: "invalid" as const };
    return { state: "valid" as const, orgPublicId: org.publicId, orgName: org.name };
  },
});
