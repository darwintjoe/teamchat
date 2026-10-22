import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * S1 — union-variant indexing.
 * Seeds one document per variant, then exercises every variant-only index.
 * Run with: npx convex run probes:runS1
 */
export const runS1 = internalMutation({
  args: {},
  handler: async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      publicId: "probe-org",
      name: "Probe Org",
      allowDirectMessages: true,
    });

    const userA = await ctx.db.insert("users", {
      publicId: "probe-user-a",
      email: "probe-a@example.test",
      name: "Probe A",
      phoneVerified: false,
      accountState: "active",
    });
    const userB = await ctx.db.insert("users", {
      publicId: "probe-user-b",
      email: "probe-b@example.test",
      name: "Probe B",
      phoneVerified: false,
      accountState: "active",
    });

    // --- byosCredentials: two variants, one indexed variant-only field each. ---
    const orgCredentialId = await ctx.db.insert("byosCredentials", {
      scopeType: "org",
      orgId,
      ciphertext: "probe-org-ciphertext",
      keyVersion: 1,
      createdAt: 1,
    });
    const userCredentialId = await ctx.db.insert("byosCredentials", {
      scopeType: "user",
      userId: userA,
      ciphertext: "probe-user-ciphertext",
      keyVersion: 1,
      createdAt: 2,
    });

    const credsByOrg = await ctx.db
      .query("byosCredentials")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    const credsByUser = await ctx.db
      .query("byosCredentials")
      .withIndex("by_user", (q) => q.eq("userId", userA))
      .collect();

    // --- groups: group variant carries path/orgId/externalRef; dm variant carries dmKey. ---
    const alphaId = await ctx.db.insert("groups", {
      kind: "group",
      publicId: "probe-alpha",
      name: "Probe Alpha",
      orgId,
      path: "/probe-org/probe-alpha",
      externalRef: "REF-ALPHA",
      externalSource: "probe_erp",
    });
    await ctx.db.insert("groups", {
      kind: "group",
      publicId: "probe-beta",
      name: "Probe Beta",
      orgId,
      parentGroupId: alphaId,
      path: "/probe-org/probe-beta",
      externalRef: "REF-BETA",
      externalSource: "probe_erp",
    });
    const dmId = await ctx.db.insert("groups", {
      kind: "dm",
      dmKey: `${userA}:${userB}`,
      participantIds: [userA, userB],
    });

    const pathPrefix = "/probe-org/";
    const subtree = await ctx.db
      .query("groups")
      .withIndex("by_path", (q) =>
        q.gte("path", pathPrefix).lt("path", pathPrefix + "\uffff"),
      )
      .collect();
    const exactPath = await ctx.db
      .query("groups")
      .withIndex("by_path", (q) => q.eq("path", "/probe-org/probe-alpha"))
      .collect();
    const dmByKey = await ctx.db
      .query("groups")
      .withIndex("by_dm_key", (q) => q.eq("dmKey", `${userA}:${userB}`))
      .collect();
    const groupsByOrg = await ctx.db
      .query("groups")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    const groupByExternal = await ctx.db
      .query("groups")
      .withIndex("by_org_external", (q) =>
        q
          .eq("orgId", orgId)
          .eq("externalSource", "probe_erp")
          .eq("externalRef", "REF-ALPHA"),
      )
      .collect();
    const groupByPublicId = await ctx.db
      .query("groups")
      .withIndex("by_public_id", (q) => q.eq("publicId", "probe-alpha"))
      .collect();
    const childrenByParent = await ctx.db
      .query("groups")
      .withIndex("by_parent", (q) => q.eq("parentGroupId", alphaId))
      .collect();

    // --- actionEvents: both indexed fields exist in every variant. ---
    const messageId = await ctx.db.insert("messages", {
      publicId: "probe-message",
      groupId: alphaId,
      orgId,
      senderId: userA,
      text: "probe",
      origin: "app",
      mode: "action",
    });
    const actionInboxId = await ctx.db.insert("actionInbox", {
      publicId: "probe-task",
      messageId,
      groupId: alphaId,
      groupPath: "/probe-org/probe-alpha",
      senderId: userA,
      senderMayClose: true,
      flagType: "task",
      status: "open",
    });
    const eventRows = [
      { actionInboxId, action: "claimed" as const, actorId: userB, timestamp: 1 },
      { actionInboxId, action: "forwarded" as const, actorId: userB, fromUserId: userB, toUserId: userA, timestamp: 2 },
      { actionInboxId, action: "done" as const, actorId: userA, timestamp: 3 },
      { actionInboxId, action: "reopened" as const, actorId: userB, reason: "sender_review" as const, timestamp: 4 },
      { actionInboxId, action: "closed" as const, actorId: userB, selfClosed: false, timestamp: 5 },
      { actionInboxId, action: "archived" as const, actorId: userB, timestamp: 6 },
    ];
    for (const row of eventRows) await ctx.db.insert("actionEvents", row);

    const events = await ctx.db
      .query("actionEvents")
      .withIndex("by_inbox_time", (q) => q.eq("actionInboxId", actionInboxId))
      .collect();

    return {
      byos: {
        orgCredentialId,
        userCredentialId,
        byOrg: credsByOrg.map((d) => ({ id: d._id, scopeType: d.scopeType })),
        byUser: credsByUser.map((d) => ({ id: d._id, scopeType: d.scopeType })),
      },
      groups: {
        alphaId,
        dmId,
        subtree: subtree.map((g) => ({ id: g._id, kind: g.kind })),
        exactPath: exactPath.map((g) => g._id),
        dmByKey: dmByKey.map((g) => g._id),
        byOrg: groupsByOrg.map((g) => ({ id: g._id, kind: g.kind })),
        byOrgExternal: groupByExternal.map((g) => g._id),
        byPublicId: groupByPublicId.map((g) => g._id),
        childrenByParent: childrenByParent.map((g) => g._id),
      },
      actionEvents: {
        count: events.length,
        order: events.map((e) => e.action),
      },
      ids: { orgId, userA, userB, messageId, actionInboxId },
    };
  },
});

/** Seeds the S2 group, membership, and a groupActivity witness row. */
export const seedS2 = internalMutation({
  args: {},
  handler: async (ctx) => {
    const orgId = await ctx.db.insert("organizations", {
      publicId: "s2-org",
      name: "S2 Org",
      allowDirectMessages: false,
    });
    const senderId = await ctx.db.insert("users", {
      publicId: "s2-sender",
      email: "s2@example.test",
      name: "S2 Sender",
      phoneVerified: false,
      accountState: "active",
    });
    const groupId = await ctx.db.insert("groups", {
      kind: "group",
      publicId: "s2-group",
      name: "S2 Group",
      orgId,
      path: "/s2-org/s2-group",
    });
    const membershipId = await ctx.db.insert("memberships", {
      groupId,
      userId: senderId,
      role: "owner",
      groupPath: "/s2-org/s2-group",
      joinedAt: 1,
      uniqueKey: `${groupId}:${senderId}`,
    });
    const groupActivityId = await ctx.db.insert("groupActivity", {
      groupId,
      lastMessageAt: 0,
      flushPending: false,
    });
    return { orgId, senderId, groupId, membershipId, groupActivityId };
  },
});

/** S6 — trivial round-trip mutation used to measure region latency. */
export const ping = mutation({
  args: { nonce: v.string() },
  handler: async (_ctx, args) => {
    return { nonce: args.nonce, serverTime: Date.now() };
  },
});

/**
 * S2 — one insert, no shared group-scoped write.
 * This is deliberately the whole mutation: the only db write is the message insert.
 */
export const probeSendMessage = mutation({
  args: {
    groupId: v.id("groups"),
    senderId: v.id("users"),
    runId: v.string(),
    seq: v.number(),
  },
  handler: async (ctx, args) => {
    const messageId = await ctx.db.insert("messages", {
      publicId: `s2-${args.runId}-${args.seq}`,
      groupId: args.groupId,
      senderId: args.senderId,
      text: `probe ${args.seq}`,
      origin: "app",
      mode: "discussion",
    });
    return { seq: args.seq, messageId };
  },
});

/** S2 — snapshot of every shared group-scoped document the send path could touch. */
export const s2Snapshot = query({
  args: { groupId: v.id("groups"), senderId: v.id("users") },
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupId);
    const activity = await ctx.db
      .query("groupActivity")
      .withIndex("by_group", (q) => q.eq("groupId", args.groupId))
      .collect();
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_group", (q) => q.eq("groupId", args.groupId))
      .collect();
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_group", (q) => q.eq("groupId", args.groupId))
      .collect();
    return {
      group,
      groupActivity: activity,
      membership,
      messageCount: messages.length,
      messagePublicIds: messages.map((m) => m.publicId),
    };
  },
});
