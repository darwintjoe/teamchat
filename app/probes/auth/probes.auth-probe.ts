// TEMPORARY auth-probe functions. Not product code.
import { internalMutation, internalQuery, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";

export const resolveShadowUser = internalQuery({
  args: { issuer: v.string(), externalUserId: v.string() },
  handler: async (ctx, args) => {
    const hostApp = await ctx.db
      .query("hostApps")
      .withIndex("by_issuer", (q) => q.eq("issuer", args.issuer))
      .first();
    if (hostApp === null || !hostApp.isActive) return null;

    const identity = await ctx.db
      .query("externalIdentities")
      .withIndex("by_host_external", (q) =>
        q.eq("hostAppId", hostApp._id).eq("externalUserId", args.externalUserId),
      )
      .first();
    if (identity === null) return null;

    const user = await ctx.db.get(identity.userId);
    if (user === null || user.accountState !== "shadow") return null;

    return { userId: user._id };
  },
});

export const seedAuthProbe = internalMutation({
  args: {},
  handler: async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      publicId: "probe-org",
      name: "Probe Org",
      allowDirectMessages: false,
    });
    const supportGroupId = await ctx.db.insert("groups", {
      kind: "group",
      publicId: "probe-support",
      name: "Probe Support",
      orgId,
      path: "/probe-org/probe-support",
    });
    const userId = await ctx.db.insert("users", {
      publicId: "probe-shadow",
      name: "Probe Shadow",
      email: "shadow@example.test",
      phoneVerified: false,
      accountState: "shadow",
    });
    const hostAppId = await ctx.db.insert("hostApps", {
      orgId,
      name: "Probe Host",
      issuer: "probe-host",
      audience: "probe-audience",
      allowedOrigins: ["https://host.example.test"],
      supportGroupId,
      isActive: true,
    });
    const externalIdentityId = await ctx.db.insert("externalIdentities", {
      hostAppId,
      externalUserId: "cust-1",
      userId,
      createdAt: Date.now(),
    });
    return { orgId, supportGroupId, userId, hostAppId, externalIdentityId };
  },
});

export const whoAmI = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const user = await ctx.db.get(userId);
    if (user === null) return null;
    return {
      userId,
      publicId: user.publicId,
      accountState: user.accountState,
    };
  },
});

export const authProbeState = query({
  args: {},
  handler: async (ctx) => {
    const sessions = await ctx.db.query("authSessions").collect();
    const refreshTokens = await ctx.db.query("authRefreshTokens").collect();
    const now = Date.now();
    return {
      sessionCount: sessions.length,
      refreshTokenCount: refreshTokens.length,
      sessions: sessions.map((s) => ({
        userId: s.userId,
        expiresInDays:
          Math.round(((s.expirationTime - now) / 86_400_000) * 100) / 100,
      })),
      refreshTokens: refreshTokens.map((t) => ({
        sessionId: t.sessionId,
        expiresInDays:
          Math.round(((t.expirationTime - now) / 86_400_000) * 100) / 100,
        firstUsedTime: t.firstUsedTime ?? null,
      })),
    };
  },
});
