// Widget token exchange (Flow D2). This file holds the server steps the custom-credentials
// `authorize` function calls through `ctx.runQuery` / `ctx.runMutation`; it never touches the
// database directly from the action.
//
// The shadow identity rule is absolute: a user is resolved by `hostAppId + externalUserId`
// through `externalIdentities`. Email is stored as an attribute and is never a lookup key.

import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { newPublicId } from "../lib/ids";
import { Doc, Id } from "../_generated/dataModel";
import { supportGroupForHostApp } from "../hostApps";
import { loadShadowContext } from "./context";
import type { ShadowContext } from "./context";

export type { ShadowContext };

/** Public projections for the action step. Internal ids stay inside the backend. */
export const hostAppByPublicId = internalQuery({
  args: { hostAppPublicId: v.string() },
  handler: async (ctx, args) => {
    const hostApp = await ctx.db
      .query("hostApps")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.hostAppPublicId))
      .unique();
    if (hostApp === null) return null;
    return {
      id: hostApp._id,
      publicId: hostApp.publicId,
      orgId: hostApp.orgId,
      issuer: hostApp.issuer,
      audience: hostApp.audience,
      allowedOrigins: hostApp.allowedOrigins,
      supportGroupId: hostApp.supportGroupId,
      isActive: hostApp.isActive,
    };
  },
});

export const keyForKid = internalQuery({
  args: { hostAppId: v.id("hostApps"), kid: v.string() },
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("hostAppKeys")
      .withIndex("by_hostapp_kid", (q) => q.eq("hostAppId", args.hostAppId).eq("kid", args.kid))
      .unique();
    if (key === null) return null;
    return {
      kid: key.kid,
      alg: key.alg,
      publicKey: key.publicKey,
      notBefore: key.notBefore,
      notAfter: key.notAfter,
    };
  },
});

/**
 * Step 6: one-shot jti. Check-then-insert inside one serializable mutation. The index read and
 * insert conflict under Convex's OCC, so a concurrent replay retries and then sees the winner.
 */
export const consumeJti = internalMutation({
  args: {
    hostAppId: v.id("hostApps"),
    jti: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("usedTokenIds")
      .withIndex("by_hostapp_jti", (q) => q.eq("hostAppId", args.hostAppId).eq("jti", args.jti))
      .first();
    if (existing !== null) return { accepted: false as const };
    await ctx.db.insert("usedTokenIds", {
      hostAppId: args.hostAppId,
      jti: args.jti,
      usedAt: Date.now(),
      expiresAt: args.expiresAt,
    });
    return { accepted: true as const };
  },
});

/**
 * Step 8: resolve or create the shadow user. Existing identities are re-checked for confinement:
 * a shadow must have exactly its host app's support-group membership and nothing else.
 */
export const resolveShadow = internalMutation({
  args: {
    hostAppId: v.id("hostApps"),
    externalUserId: v.string(),
    email: v.optional(v.union(v.string(), v.null())),
    name: v.optional(v.union(v.string(), v.null())),
    phone: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const hostApp = await ctx.db.get(args.hostAppId);
    if (hostApp === null || !hostApp.isActive) throw new Error("Host app is not active");
    const { group } = await supportGroupForHostApp(ctx, hostApp);

    const existingIdentity = await ctx.db
      .query("externalIdentities")
      .withIndex("by_host_external", (q) =>
        q.eq("hostAppId", hostApp._id).eq("externalUserId", args.externalUserId),
      )
      .unique();

    if (existingIdentity !== null) {
      const user = await ctx.db.get(existingIdentity.userId);
      if (user === null) throw new Error("Shadow user record is missing");
      // NEVER fall back to email, and never sign in a non-shadow account from a host assertion.
      if (user.accountState !== "shadow") {
        throw new Error("This host identity is not a shadow account");
      }

      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_user_path", (q) => q.eq("userId", user._id))
        .collect();
      for (const membership of memberships) {
        if (membership.groupId !== group._id) {
          throw new Error("Shadow identity escaped its support group");
        }
      }
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group._id}:${user._id}`))
        .unique();
      if (membership === null) {
        await ctx.db.insert("memberships", {
          groupId: group._id,
          userId: user._id,
          role: "member",
          groupPath: group.path,
          joinedAt: Date.now(),
          uniqueKey: `${group._id}:${user._id}`,
        });
      }

      // Email/name are attributes only. Refreshing them cannot change identity.
      const patch: Partial<Doc<"users">> = {};
      if (args.email !== undefined && args.email !== null && args.email !== user.email) {
        patch.email = args.email;
      }
      if (args.name !== undefined && args.name !== null && args.name !== "" && args.name !== user.name) {
        patch.name = args.name;
      }
      if (args.phone !== undefined && args.phone !== null && args.phone !== user.phone) {
        patch.phone = args.phone;
      }
      if (Object.keys(patch).length > 0) await ctx.db.patch(user._id, patch);

      return {
        userId: user._id,
        userPublicId: user.publicId,
        accountState: user.accountState,
        supportGroupPublicId: group.publicId,
        created: false,
      };
    }

    if (args.email === undefined && args.phone === undefined) {
      // Part 3 requires at least one of email|phone. A host token that carries neither cannot
      // create a user; this is an exchange refusal, not an email-based identity match.
      throw new Error("The host token carries no email or phone attribute");
    }

    const publicId = newPublicId("usr");
    const userId = await ctx.db.insert("users", {
      publicId,
      name: args.name !== undefined && args.name !== null && args.name !== "" ? args.name : "Widget customer",
      email: args.email ?? undefined,
      phone: args.phone ?? undefined,
      phoneVerified: false,
      accountState: "shadow",
    });
    await ctx.db.insert("externalIdentities", {
      hostAppId: hostApp._id,
      externalUserId: args.externalUserId,
      userId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("memberships", {
      groupId: group._id,
      userId,
      role: "member",
      groupPath: group.path,
      joinedAt: Date.now(),
      uniqueKey: `${group._id}:${userId}`,
    });
    return {
      userId,
      userPublicId: publicId,
      accountState: "shadow" as const,
      supportGroupPublicId: group.publicId,
      created: true,
    };
  },
});

/** Identity context for every widget-only function. Shadow accounts only. */
export const identityForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => await loadShadowContext(ctx, args.userId),
});

/** Look up the host app + support group for a host identity (used by widget sends). */
export const identityByExternalId = internalQuery({
  args: { hostAppId: v.id("hostApps"), externalUserId: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.db
      .query("externalIdentities")
      .withIndex("by_host_external", (q) =>
        q.eq("hostAppId", args.hostAppId).eq("externalUserId", args.externalUserId),
      )
      .unique();
    if (identity === null) return null;
    return { userId: identity.userId };
  },
});

export const audit = internalMutation({
  args: {
    hostAppId: v.id("hostApps"),
    userId: v.optional(v.id("users")),
    kind: v.union(
      v.literal("mode_override"),
      v.literal("upload_denied"),
      v.literal("origin_rejected"),
    ),
    detail: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("widgetAuditLog", {
      ...args,
      createdAt: Date.now(),
    });
    return { logged: true };
  },
});

/** Hourly sweep: replay rows live only as long as the token they came from. */
export const sweepUsedTokenIds = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 500);
    const now = Date.now();
    const expired = await ctx.db
      .query("usedTokenIds")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now))
      .take(limit);
    for (const row of expired) await ctx.db.delete(row._id);
    return { scanned: expired.length, deleted: expired.length };
  },
});

export type HostAppDocId = Id<"hostApps">;
