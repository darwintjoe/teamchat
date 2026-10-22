// Connections (v0 build item 7): email request → accept, plus list/remove. Invite links are the
// org invites built in `invites.ts`; a QR code is a client-side rendering of that same link or of
// a user's connection code (no server change, no global directory).
//
// Phone matching is in-org only: a match requires at least one shared organisation, and shadow or
// bot accounts are never matchable. There is no global phone lookup in Phase 1 (O1) — this query
// must stay direct (no router near phone discovery).

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { dmKeyFor } from "./lib/address";
import { DbCtx, requireActive, requireNotShadow, requireUserId } from "./lib/guards";
import { Doc, Id } from "./_generated/dataModel";

function normalizePhone(raw: string): string {
  return raw.trim();
}

function digitsOnly(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

async function pairRow(
  ctx: DbCtx,
  a: Id<"users">,
  b: Id<"users">,
): Promise<Doc<"connections"> | null> {
  return await ctx.db
    .query("connections")
    .withIndex("by_pair", (q) => q.eq("pairKey", dmKeyFor(a, b)))
    .unique();
}

/**
 * Ask another user to connect, by email. The request waits for the other side to accept.
 * `found: false` when no account has that email — the caller learns nothing else.
 */
export const requestByEmail = mutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const email = args.email.trim().toLowerCase();
    if (email === "") throw new Error("An email address is required");

    const target = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .unique();
    if (target === null) return { found: false as const };
    if (target._id === user._id) throw new Error("You cannot connect to yourself");
    if (target.accountState === "shadow" || target.accountState === "bot") {
      return { found: false as const };
    }

    const existing = await pairRow(ctx, user._id, target._id);
    if (existing !== null) {
      return {
        found: true as const,
        peerPublicId: target.publicId,
        peerName: target.name ?? null,
        status: existing.status,
        created: false as const,
      };
    }

    await ctx.db.insert("connections", {
      user1: user._id, // requester
      user2: target._id,
      pairKey: dmKeyFor(user._id, target._id),
      status: "pending",
    });
    return {
      found: true as const,
      peerPublicId: target.publicId,
      peerName: target.name ?? null,
      status: "pending" as const,
      created: true as const,
    };
  },
});

/** The recipient accepts a pending request. The requester cannot accept their own request. */
export const accept = mutation({
  args: { userPublicId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const peer = await ctx.db
      .query("users")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.userPublicId))
      .unique();
    if (peer === null) throw new Error("User not found");
    const row = await pairRow(ctx, user._id, peer._id);
    if (row === null) throw new Error("No connection request with this user");
    if (row.status === "accepted") return { status: "accepted" as const, alreadyAccepted: true };
    if (row.user1 === user._id) throw new Error("Wait for the other person to accept");
    if (row.user2 !== user._id) throw new Error("No connection request with this user");
    await ctx.db.patch(row._id, { status: "accepted" });
    return { status: "accepted" as const, alreadyAccepted: false };
  },
});

/** Reject or remove: either side, in either state. */
export const remove = mutation({
  args: { userPublicId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const peer = await ctx.db
      .query("users")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.userPublicId))
      .unique();
    if (peer === null) throw new Error("User not found");
    const row = await pairRow(ctx, user._id, peer._id);
    if (row === null) return { removed: false };
    if (row.user1 !== user._id && row.user2 !== user._id) {
      throw new Error("You are not part of this connection");
    }
    await ctx.db.delete(row._id);
    return { removed: true };
  },
});

/**
 * The caller's connections, both accepted and pending, with the direction so the UI can render
 * "incoming request" vs "sent". Emails are shown only for accepted connections.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireNotShadow(ctx);
    const user = await requireUserId(ctx);
    const asUser1 = await ctx.db
      .query("connections")
      .withIndex("by_user1", (q) => q.eq("user1", user))
      .collect();
    const asUser2 = await ctx.db
      .query("connections")
      .withIndex("by_user2", (q) => q.eq("user2", user))
      .collect();

    const rows: Array<{
      peerPublicId: string | null;
      peerName: string | null;
      peerEmail: string | null;
      status: "pending" | "accepted";
      direction: "outgoing" | "incoming";
    }> = [];
    for (const connection of [...asUser1, ...asUser2]) {
      const peerId = connection.user1 === user ? connection.user2 : connection.user1;
      const peer = await ctx.db.get(peerId);
      rows.push({
        peerPublicId: peer?.publicId ?? null,
        peerName: peer?.name ?? null,
        peerEmail: connection.status === "accepted" ? (peer?.email ?? null) : null,
        status: connection.status,
        direction: connection.user1 === user ? "outgoing" : "incoming",
      });
    }
    rows.sort((a, b) => (a.status === b.status ? 0 : a.status === "pending" ? -1 : 1));
    return rows;
  },
});

/**
 * In-org phone matching. Exact match on the stored value or on its digits-only form (auth
 * providers differ in how they normalise E.164); the match is only ever revealed when the caller
 * and the target share at least one organisation. No router, no global lookup (O1).
 */
export const matchByPhone = query({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const user = await requireUserId(ctx);
    const trimmed = normalizePhone(args.phone);
    const digits = digitsOnly(trimmed);
    if (digits.length < 6) return { matched: false as const };

    let target = await ctx.db
      .query("users")
      .withIndex("phone", (q) => q.eq("phone", trimmed))
      .unique();
    if (target === null && digits !== trimmed) {
      target = await ctx.db
        .query("users")
        .withIndex("phone", (q) => q.eq("phone", digits))
        .unique();
    }
    if (target === null) {
      target = await ctx.db
        .query("users")
        .withIndex("phone", (q) => q.eq("phone", `+${digits}`))
        .unique();
    }
    if (target === null || target._id === user) return { matched: false as const };
    if (target.accountState === "shadow" || target.accountState === "bot") {
      return { matched: false as const };
    }

    // Shared-org check: walk the caller's orgs and look for the target in each.
    const myOrgs = await ctx.db
      .query("orgMembers")
      .withIndex("by_user", (q) => q.eq("userId", user))
      .collect();
    for (const membership of myOrgs) {
      const counterpart = await ctx.db
        .query("orgMembers")
        .withIndex("by_unique", (q) => q.eq("uniqueKey", `${membership.orgId}:${target._id}`))
        .unique();
      if (counterpart !== null) {
        return {
          matched: true as const,
          userPublicId: target.publicId,
          name: target.name ?? null,
          sharedOrgId: membership.orgId,
        };
      }
    }
    return { matched: false as const };
  },
});
