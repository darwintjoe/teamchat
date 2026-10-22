// CR-16 demo surfaces. Everything here is inert unless DEMO_OTP_ECHO is on, and the build
// refuses to run with it on in a production deployment (see buildFlags.ts).

import { internalMutation, query } from "../_generated/server";
import { v } from "convex/values";
import { assertAuthBuildSafe, buildInfo as flags } from "./buildFlags";
import { DEMO_OTP_ECHO } from "./buildFlags";

/** Called by the email provider from its action context with the code that "would" be emailed. */
export const recordEchoedCode = internalMutation({
  args: {
    identifier: v.string(),
    token: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    if (!DEMO_OTP_ECHO) return; // the stub is compiled out
    const previous = await ctx.db
      .query("demoAuthCodes")
      .withIndex("by_identifier", (q) => q.eq("identifier", args.identifier))
      .collect();
    for (const row of previous) await ctx.db.delete(row._id);
    await ctx.db.insert("demoAuthCodes", {
      identifier: args.identifier,
      token: args.token,
      createdAt: Date.now(),
      expiresAt: args.expiresAt,
    });
  },
});

/** The client polls this to show the "hint" under the OTP box (CR-16). Demo builds only. */
export const getEchoedCode = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    assertAuthBuildSafe();
    if (!DEMO_OTP_ECHO) return null;
    const row = await ctx.db
      .query("demoAuthCodes")
      .withIndex("by_identifier", (q) => q.eq("identifier", args.email.trim().toLowerCase()))
      .order("desc")
      .first();
    if (row === null || row.expiresAt < Date.now()) return null;
    return { code: row.token, createdAt: row.createdAt, expiresAt: row.expiresAt };
  },
});

/** Drives the visible "demo build — not authentication" banner in both clients. */
export const buildInfo = query({
  args: {},
  handler: async () => {
    assertAuthBuildSafe();
    return flags();
  },
});

/** Housekeeping for the echo table: drop codes that can no longer be used. */
export const sweepExpiredEchoes = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!DEMO_OTP_ECHO) return { deleted: 0 }; // demo-only table, nothing to do elsewhere
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    const rows = await ctx.db
      .query("demoAuthCodes")
      .withIndex("by_identifier", (q) => q)
      .take(limit);
    let deleted = 0;
    const now = Date.now();
    for (const row of rows) {
      if (row.expiresAt < now) {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }
    return { deleted };
  },
});
