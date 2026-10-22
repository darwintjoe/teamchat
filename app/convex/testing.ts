// Internal test hooks. These are not public functions: no client can call them, and nothing in
// the product imports them. They exist so `scripts/attachment-read-path.mjs` can prove that a
// read resolves from `messages.attachments[].storageRef` and not from the bookkeeping row.
//
// Run them with the Convex CLI (`npx convex run testing:...`), which has admin access.

import {
  internalAction,
  internalMutation,
  internalQuery,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { dynamicRateLimiter } from "./lib/rateLimiter";
import { v } from "convex/values";
import { Doc } from "./_generated/dataModel";
import { newPublicId } from "./lib/ids";
import { sha256Hex } from "./lib/crypto";
import { costStatus, projectOrgMonthlyCost } from "./lib/cost";

async function attachmentRow(
  ctx: QueryCtx | MutationCtx,
  attachmentId: string,
): Promise<Doc<"attachments"> | null> {
  return await ctx.db
    .query("attachments")
    .withIndex("by_attachment_id", (q) => q.eq("attachmentId", attachmentId))
    .unique();
}

async function messageRow(
  ctx: QueryCtx | MutationCtx,
  messagePublicId: string,
): Promise<Doc<"messages">> {
  const message = await ctx.db
    .query("messages")
    .withIndex("by_public_id", (q) => q.eq("publicId", messagePublicId))
    .unique();
  if (message === null) throw new Error("Message not found");
  return message;
}

export const readProbeState = internalQuery({
  args: { attachmentId: v.string(), messagePublicId: v.string() },
  handler: async (ctx, args) => {
    const row = await attachmentRow(ctx, args.attachmentId);
    if (row === null) throw new Error("Attachment row not found");
    const message = await messageRow(ctx, args.messagePublicId);
    const record = (message.attachments ?? []).find(
      (attachment) => attachment.attachmentId === args.attachmentId,
    );
    return {
      rowStatus: row.status,
      rowFileKey: row.fileKey ?? null,
      rowMessageId: row.messageId ?? null,
      messageAttachmentPresent: record !== undefined,
      messageFileKey:
        record !== undefined && record.storageRef.scope === "org"
          ? record.storageRef.fileKey
          : null,
    };
  },
});

export const setAttachmentRowFileKey = internalMutation({
  args: { attachmentId: v.string(), fileKey: v.string() },
  handler: async (ctx, args) => {
    const row = await attachmentRow(ctx, args.attachmentId);
    if (row === null) throw new Error("Attachment row not found");
    await ctx.db.patch(row._id, { fileKey: args.fileKey });
    return { attachmentId: args.attachmentId, fileKey: args.fileKey };
  },
});

export const setMessageAttachmentFileKey = internalMutation({
  args: { messagePublicId: v.string(), attachmentId: v.string(), fileKey: v.string() },
  handler: async (ctx, args) => {
    const message = await messageRow(ctx, args.messagePublicId);
    const attachments = (message.attachments ?? []).map((attachment) => {
      if (attachment.attachmentId !== args.attachmentId) return attachment;
      if (attachment.storageRef.scope !== "org") {
        throw new Error("Probe only supports org-scope attachments");
      }
      return {
        ...attachment,
        storageRef: { ...attachment.storageRef, fileKey: args.fileKey },
      };
    });
    await ctx.db.patch(message._id, { attachments });
    return { messagePublicId: args.messagePublicId, fileKey: args.fileKey };
  },
});

export const removeMessageAttachment = internalMutation({
  args: { messagePublicId: v.string(), attachmentId: v.string() },
  handler: async (ctx, args) => {
    const message = await messageRow(ctx, args.messagePublicId);
    const attachments = (message.attachments ?? []).filter(
      (attachment) => attachment.attachmentId !== args.attachmentId,
    );
    await ctx.db.patch(message._id, {
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    return { messagePublicId: args.messagePublicId, remaining: attachments.length };
  },
});

// ---------------------------------------------------------------------------------------------
// Action Inbox probes (scripts/verify-action-inbox.mjs). Admin-only, never imported by product.
// ---------------------------------------------------------------------------------------------

async function userRow(ctx: QueryCtx | MutationCtx, publicId: string): Promise<Doc<"users">> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_public_id", (q) => q.eq("publicId", publicId))
    .unique();
  if (user === null) throw new Error("User not found");
  return user;
}

async function groupRow(
  ctx: QueryCtx | MutationCtx,
  publicId: string,
): Promise<Extract<Doc<"groups">, { kind: "group" }>> {
  const group = await ctx.db
    .query("groups")
    .withIndex("by_public_id", (q) => q.eq("publicId", publicId))
    .unique();
  if (group === null || group.kind !== "group") throw new Error("Group not found");
  return group;
}

export const setUserAccountState = internalMutation({
  args: {
    userPublicId: v.string(),
    accountState: v.union(
      v.literal("shadow"),
      v.literal("provisioned"),
      v.literal("active"),
      v.literal("bot"),
    ),
  },
  handler: async (ctx, args) => {
    const user = await userRow(ctx, args.userPublicId);
    await ctx.db.patch(user._id, { accountState: args.accountState });
    return { userPublicId: user.publicId, accountState: args.accountState };
  },
});

export const setMembershipRole = internalMutation({
  args: {
    groupPublicId: v.string(),
    userPublicId: v.string(),
    role: v.union(v.literal("owner"), v.literal("manager"), v.literal("member")),
  },
  handler: async (ctx, args) => {
    const group = await groupRow(ctx, args.groupPublicId);
    const user = await userRow(ctx, args.userPublicId);
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group._id}:${user._id}`))
      .unique();
    if (membership === null) throw new Error("Membership not found");
    await ctx.db.patch(membership._id, { role: args.role });
    return { groupPublicId: group.publicId, userPublicId: user.publicId, role: args.role };
  },
});

export const removeMembership = internalMutation({
  args: { groupPublicId: v.string(), userPublicId: v.string() },
  handler: async (ctx, args) => {
    const group = await groupRow(ctx, args.groupPublicId);
    const user = await userRow(ctx, args.userPublicId);
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group._id}:${user._id}`))
      .unique();
    if (membership === null) throw new Error("Membership not found");
    await ctx.db.delete(membership._id);
    return { groupPublicId: group.publicId, userPublicId: user.publicId, removed: true };
  },
});

/** Task + full event trail for one action message, including raw ids for assertions. */
// ---------------------------------------------------------------------------------------------
// Part 5 probes (scripts/verify-part5.mjs). Admin-only, never imported by product.
// ---------------------------------------------------------------------------------------------

async function apiKeyRow(ctx: QueryCtx | MutationCtx, publicId: string): Promise<Doc<"apiKeys">> {
  const key = await ctx.db
    .query("apiKeys")
    .withIndex("by_public_id", (q) => q.eq("publicId", publicId))
    .unique();
  if (key === null) throw new Error("API key not found");
  return key;
}

async function webhookRow(ctx: QueryCtx | MutationCtx, publicId: string): Promise<Doc<"webhooks">> {
  const hook = await ctx.db
    .query("webhooks")
    .withIndex("by_public_id", (q) => q.eq("publicId", publicId))
    .unique();
  if (hook === null) throw new Error("Webhook not found");
  return hook;
}

export const expireApiKey = internalMutation({
  args: { keyPublicId: v.string() },
  handler: async (ctx, args) => {
    const key = await apiKeyRow(ctx, args.keyPublicId);
    await ctx.db.patch(key._id, { expiresAt: Date.now() - 1_000 });
    return { keyPublicId: key.publicId, expiresAt: key.expiresAt - 1_000 };
  },
});

/** Raw key metadata for assertions that must never run through a client-readable query. */
export const apiKeyProbe = internalQuery({
  args: { keyPublicId: v.string() },
  handler: async (ctx, args) => {
    const key = await apiKeyRow(ctx, args.keyPublicId);
    return {
      publicId: key.publicId,
      keyHash: key.keyHash,
      lastUsedAt: key.lastUsedAt ?? null,
      expiresAt: key.expiresAt,
      scopes: key.scopes,
    };
  },
});

export const setWebhookUrlForTest = internalMutation({
  args: { webhookPublicId: v.string(), url: v.string() },
  handler: async (ctx, args) => {
    const hook = await webhookRow(ctx, args.webhookPublicId);
    await ctx.db.patch(hook._id, { url: args.url });
    return { webhookPublicId: hook.publicId, url: args.url };
  },
});

/** Deliveries for one webhook, including retry state. Used to prove snapshot + backoff + dead. */
export const webhookProbe = internalQuery({
  args: { webhookPublicId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const hook = await webhookRow(ctx, args.webhookPublicId);
    const rows = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_webhook", (q) => q.eq("webhookId", hook._id))
      .order("desc")
      .take(Math.min(args.limit ?? 20, 100));
    const secret = await ctx.db
      .query("webhookSecrets")
      .withIndex("by_webhook", (q) => q.eq("webhookId", hook._id))
      .first();
    return {
      webhook: {
        publicId: hook.publicId,
        url: hook.url,
        isActive: hook.isActive,
        events: hook.events,
      },
      secret: secret === null ? null : { ciphertext: secret.ciphertext, keyVersion: secret.keyVersion },
      deliveries: rows.map((row) => ({
        id: row._id,
        event: row.event,
        payload: row.payload,
        status: row.status,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt ?? null,
        lastError: row.lastError ?? null,
        createdAt: row.createdAt,
      })),
    };
  },
});

/**
 * Insert a delivery row without scheduling it. Lets the script run each attempt itself instead of
 * racing the scheduler while it inspects retry state.
 */
export const insertTestDelivery = internalMutation({
  args: {
    webhookPublicId: v.string(),
    event: v.union(
      v.literal("task.claimed"),
      v.literal("task.forwarded"),
      v.literal("task.done"),
      v.literal("task.reopened"),
      v.literal("task.closed"),
      v.literal("message.created"),
    ),
    messagePublicId: v.optional(v.string()),
    groupPublicId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const hook = await webhookRow(ctx, args.webhookPublicId);
    const now = Date.now();
    const deliveryId = await ctx.db.insert("webhookDeliveries", {
      webhookId: hook._id,
      event: args.event,
      payload: {
        event: args.event,
        occurredAt: new Date(now).toISOString(),
        data: {
          messagePublicId: args.messagePublicId,
          groupPublicId: args.groupPublicId,
        },
      },
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    });
    return { deliveryId };
  },
});

/** Run one delivery attempt synchronously from a test script. */
export const runDelivery = internalAction({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    return await ctx.runAction(internal.webhookDelivery.deliver, {
      deliveryId: args.deliveryId,
    });
  },
});

export const idempotencyProbe = internalQuery({
  args: { orgPublicId: v.string(), scope: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    const rows = await ctx.db
      .query("idempotencyKeys")
      .withIndex("by_org_scope_key", (q) =>
        q.eq("orgId", org._id).eq("scope", args.scope).eq("key", args.key),
      )
      .collect();
    return {
      rows: rows.map((row) => ({
        scope: row.scope,
        requestHash: row.requestHash,
        responseStatus: row.responseStatus,
        responseBody: row.responseBody,
        expiresAt: row.expiresAt,
      })),
    };
  },
});

export const serviceUserProbe = internalQuery({
  args: { orgPublicId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    if (org.serviceUserId === undefined) return null;
    const user = await ctx.db.get(org.serviceUserId);
    if (user === null) return null;
    return { userPublicId: user.publicId, accountState: user.accountState, email: user.email ?? null };
  },
});

export const rateLimitProbe = internalQuery({
  args: { name: v.string(), key: v.string(), rate: v.number(), period: v.number() },
  handler: async (ctx, args) => {
    return await dynamicRateLimiter.getValue(ctx, args.name, {
      key: args.key,
      config: { kind: "fixed window", rate: args.rate, period: args.period },
    });
  },
});

export const orgRateProbe = internalQuery({
  args: { orgPublicId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    return { apiRateLimitPerMinute: org.apiRateLimitPerMinute ?? null };
  },
});

export const actionProbeState = internalQuery({
  args: { messagePublicId: v.string() },
  handler: async (ctx, args) => {
    const message = await messageRow(ctx, args.messagePublicId);
    const task = await ctx.db
      .query("actionInbox")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .unique();
    if (task === null) throw new Error("Task not found");
    const events = await ctx.db
      .query("actionEvents")
      .withIndex("by_inbox_time", (q) => q.eq("actionInboxId", task._id))
      .order("asc")
      .collect();
    const eventRows = [];
    for (const event of events) {
      const actor = event.actorId !== undefined ? await ctx.db.get(event.actorId) : null;
      const from =
        event.action === "forwarded" ? await ctx.db.get(event.fromUserId) : null;
      const to = event.action === "forwarded" ? await ctx.db.get(event.toUserId) : null;
      eventRows.push({
        action: event.action,
        actorPublicId: actor?.publicId ?? null,
        fromPublicId: from?.publicId ?? null,
        toPublicId: to?.publicId ?? null,
        selfClosed: event.action === "closed" ? event.selfClosed : null,
        reason: event.action === "reopened" ? event.reason : null,
        timestamp: event.timestamp,
      });
    }
    const sender = await ctx.db.get(task.senderId);
    const claimant = task.claimedBy !== undefined ? await ctx.db.get(task.claimedBy) : null;
    const closer = task.closedBy !== undefined ? await ctx.db.get(task.closedBy) : null;
    const forwarded =
      task.forwardedTo !== undefined ? await ctx.db.get(task.forwardedTo) : null;
    return {
      task: {
        publicId: task.publicId,
        messageId: message.publicId,
        messageMode: message.mode,
        groupPath: task.groupPath ?? null,
        senderPublicId: sender?.publicId ?? null,
        senderMayClose: task.senderMayClose,
        flagType: task.flagType,
        status: task.status,
        claimedByPublicId: claimant?.publicId ?? null,
        closedByPublicId: closer?.publicId ?? null,
        forwardedToPublicId: forwarded?.publicId ?? null,
        archivedAt: task.archivedAt ?? null,
      },
      events: eventRows,
      eventCount: events.length,
    };
  },
});

/** Count tasks/events for a message, used to prove one message creates exactly one task. */
export const actionMessageCounts = internalQuery({
  args: { messagePublicId: v.string() },
  handler: async (ctx, args) => {
    const message = await messageRow(ctx, args.messagePublicId);
    const tasks = await ctx.db
      .query("actionInbox")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .collect();
    let events = 0;
    for (const task of tasks) {
      events += (
        await ctx.db
          .query("actionEvents")
          .withIndex("by_inbox_time", (q) => q.eq("actionInboxId", task._id))
          .collect()
      ).length;
    }
    return { messagePublicId: args.messagePublicId, taskCount: tasks.length, eventCount: events };
  },
});

// ---------------------------------------------------------------------------------------------
// Production / cross-tenant test fixtures. Internal only: the CLI has admin access; no client can
// call these. They exist so launch checks can run against the production deployment without
// spending the real OTP budget or creating a real org.
// ---------------------------------------------------------------------------------------------

const KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function newTestApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = "tc_live_";
  for (const byte of bytes) out += KEY_ALPHABET[byte % KEY_ALPHABET.length];
  return out;
}

/**
 * Create an active owner, an org, its root group, a support group and an API key in one mutation.
 * Deliberately bypasses `organizations.create`'s cost gate: this is throwaway test data, and the
 * gate itself is tested separately.
 */
export const seedTenant = internalMutation({
  args: {
    name: v.string(),
    email: v.string(),
    keyLabel: v.optional(v.string()),
    scopes: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const email = args.email.trim().toLowerCase();
    const userPublicId = newPublicId("usr");
    const userId = await ctx.db.insert("users", {
      publicId: userPublicId,
      name: `${args.name} owner`,
      email,
      phoneVerified: false,
      accountState: "active",
      emailVerificationTime: now,
    });
    const orgPublicId = newPublicId("org");
    const orgId = await ctx.db.insert("organizations", {
      publicId: orgPublicId,
      name: args.name,
      allowDirectMessages: false,
    });
    const rootPublicId = newPublicId("grp");
    const rootId = await ctx.db.insert("groups", {
      kind: "group",
      publicId: rootPublicId,
      name: `${args.name} (org root)`,
      orgId,
      path: `/${orgPublicId}`,
    });
    await ctx.db.patch(orgId, { rootGroupId: rootId });
    const supportPublicId = newPublicId("grp");
    const supportId = await ctx.db.insert("groups", {
      kind: "group",
      publicId: supportPublicId,
      name: `${args.name} support`,
      orgId,
      parentGroupId: rootId,
      path: `/${orgPublicId}/${supportPublicId}`,
    });
    await ctx.db.insert("groupActivity", { groupId: rootId, lastMessageAt: 0, flushPending: false });
    await ctx.db.insert("groupActivity", { groupId: supportId, lastMessageAt: 0, flushPending: false });
    await ctx.db.insert("orgMembers", {
      orgId,
      userId,
      orgRole: "owner",
      joinedAt: now,
      uniqueKey: `${orgId}:${userId}`,
    });
    await ctx.db.insert("memberships", {
      groupId: rootId,
      userId,
      role: "owner",
      groupPath: `/${orgPublicId}`,
      joinedAt: now,
      uniqueKey: `${rootId}:${userId}`,
    });
    await ctx.db.insert("memberships", {
      groupId: supportId,
      userId,
      role: "owner",
      groupPath: `/${orgPublicId}/${supportPublicId}`,
      joinedAt: now,
      uniqueKey: `${supportId}:${userId}`,
    });

    const key = newTestApiKey();
    const keyPublicId = newPublicId("key");
    await ctx.db.insert("apiKeys", {
      publicId: keyPublicId,
      orgId,
      keyHash: await sha256Hex(key),
      label: args.keyLabel ?? "test key",
      scopes: (args.scopes ?? [
        "messages:write",
        "messages:read",
        "users:provision",
        "groups:manage",
        "tasks:read",
      ]) as any,
      createdAt: now,
      expiresAt: now + 90 * 24 * 60 * 60 * 1000,
    });

    return {
      orgPublicId,
      rootGroupPublicId: rootPublicId,
      supportGroupPublicId: supportPublicId,
      ownerPublicId: userPublicId,
      key,
      keyPublicId,
    };
  },
});

/** Pure-model probe used by scripts/verify-cost-model.mjs. No writes, no tenant data. */
export const costModelProbe = internalQuery({
  args: {
    activeUsers: v.number(),
    groupSizes: v.array(v.number()),
    messagesPerUserPerDay: v.optional(v.number()),
  },
  handler: async (_ctx, args) => {
    const projection = projectOrgMonthlyCost({
      activeUsers: args.activeUsers,
      groupSizes: args.groupSizes,
      messagesPerUserPerDay: args.messagesPerUserPerDay,
    });
    return {
      projection,
      singleOrgStatus: costStatus([projection.projectedMonthlyCostUsd]),
    };
  },
});

/** Membership count for a group, used to prove a rejected cross-tenant write left no row. */
export const groupMemberCount = internalQuery({
  args: { groupPublicId: v.string() },
  handler: async (ctx, args) => {
    const group = await groupRow(ctx, args.groupPublicId);
    const rows = await ctx.db
      .query("memberships")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .collect();
    return { groupPublicId: group.publicId, members: rows.length };
  },
});

/** Aggregate cost-status probe for scripts/verify-cost-model.mjs. Pure, no writes. */
export const costAggregateProbe = internalQuery({
  args: { orgCostsUsd: v.array(v.number()) },
  handler: async (_ctx, args) => {
    return costStatus(args.orgCostsUsd);
  },
});

/** Run the real daily rollup for one org, by public id, without touching other orgs. */
export const rollupTenantForTest = internalAction({
  args: { orgPublicId: v.string(), day: v.string() },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const orgs = await ctx.runQuery(internal.usage.listOrgIds, {});
    const hit = orgs.find((entry) => entry.orgPublicId === args.orgPublicId);
    if (hit === undefined) throw new Error("Organisation not found");
    return await ctx.runMutation(internal.usage.rollupOrg, { orgId: hit.orgId, day: args.day });
  },
});

/** Run the real platform alert evaluation for a day, without the full per-org rollup loop. */
export const evaluateCostAlertForTest = internalAction({
  args: { day: v.string() },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    return await ctx.runMutation(internal.usage.evaluateAlert, { day: args.day });
  },
});

/** Create active users only, for load-test sessions that create their own org. */
export const seedTestUsers = internalMutation({
  args: { emails: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out = [];
    for (const raw of args.emails) {
      const email = raw.trim().toLowerCase();
      const existing = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .first();
      if (existing !== null) {
        if (existing.accountState !== "active") {
          await ctx.db.patch(existing._id, { accountState: "active" });
        }
        out.push({ email, userPublicId: existing.publicId, created: false });
        continue;
      }
      const publicId = newPublicId("usr");
      await ctx.db.insert("users", {
        publicId,
        name: email.split("@")[0],
        email,
        phoneVerified: false,
        accountState: "active",
        emailVerificationTime: Date.now(),
      });
      out.push({ email, userPublicId: publicId, created: true });
    }
    return out;
  },
});

/** Create an auth session row for a seeded user; the test script mints the matching JWT. */
export const createTestSession = internalMutation({
  args: { userPublicId: v.string() },
  handler: async (ctx, args) => {
    const user = await userRow(ctx, args.userPublicId);
    const sessionId = await ctx.db.insert("authSessions", {
      userId: user._id,
      expirationTime: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    return { userPublicId: user.publicId, userId: user._id, sessionId };
  },
});

/**
 * Remove a throwaway org and its rows. Keeps production free of S5/cross-tenant fixtures.
 * `deleteUsers` also removes users that have no membership left anywhere (owner and widget
 * shadows); a user shared with another org is kept.
 */
export const purgeTenant = internalMutation({
  args: {
    orgPublicId: v.string(),
    deleteUsers: v.optional(v.boolean()),
    // Large S5 tenants can exceed Convex's 4,096-reads-per-mutation limit if every group is
    // traversed in one call. The caller loops with a small chunk until `removed` is true.
    maxGroups: v.optional(v.number()),
  },  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) return { removed: false, deleted: 0 };
    let deleted = 0;
    const del = async (id: any) => {
      await ctx.db.delete(id);
      deleted++;
    };
    const candidateUserIds = new Set<string>();

    const allGroups = await ctx.db
      .query("groups")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    const limit = Math.max(1, Math.floor(args.maxGroups ?? 50));
    const groups = allGroups.slice(0, limit);
    const groupIds = new Set(groups.map((group) => group._id as string));
    for (const group of groups) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .collect();
      for (const message of messages) await del(message._id);
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .collect();
      for (const membership of memberships) await del(membership._id);
      const attachments = await ctx.db
        .query("attachments")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .collect();
      for (const attachment of attachments) await del(attachment._id);
      const activity = await ctx.db
        .query("groupActivity")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .collect();
      for (const row of activity) await del(row._id);
      await del(group._id);
    }

    const tasks = (await ctx.db.query("actionInbox").collect()).filter((task) =>
      groupIds.has(task.groupId as string),
    );
    for (const task of tasks) {
      const events = await ctx.db
        .query("actionEvents")
        .withIndex("by_inbox_time", (q) => q.eq("actionInboxId", task._id))
        .collect();
      for (const event of events) await del(event._id);
      await del(task._id);
    }

    if (groups.length < allGroups.length) {
      return {
        removed: false,
        deleted,
        groupsRemaining: allGroups.length - groups.length,
      };
    }

    const hooks = await ctx.db
      .query("webhooks")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    for (const hook of hooks) {
      const deliveries = await ctx.db
        .query("webhookDeliveries")
        .withIndex("by_webhook", (q) => q.eq("webhookId", hook._id))
        .collect();
      for (const delivery of deliveries) await del(delivery._id);
      const secrets = await ctx.db
        .query("webhookSecrets")
        .withIndex("by_webhook", (q) => q.eq("webhookId", hook._id))
        .collect();
      for (const secret of secrets) await del(secret._id);
      await del(hook._id);
    }

    for (const table of ["apiKeys", "storageConfigs", "byosCredentials", "storageUsage", "orgInvites"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_org", (q) => q.eq("orgId", org._id))
        .collect();
      for (const row of rows) await del(row._id);
    }

    const orgMembers = await ctx.db
      .query("orgMembers")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    for (const member of orgMembers) {
      candidateUserIds.add(member.userId as string);
      await del(member._id);
    }

    // Widget fixtures: host apps, their public keys, replay ids, audit rows and shadow identities.
    const hostApps = await ctx.db
      .query("hostApps")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    for (const hostApp of hostApps) {
      const keys = await ctx.db
        .query("hostAppKeys")
        .withIndex("by_hostapp", (q) => q.eq("hostAppId", hostApp._id))
        .collect();
      for (const key of keys) await del(key._id);
      const used = await ctx.db
        .query("usedTokenIds")
        .withIndex("by_hostapp_jti", (q) => q.eq("hostAppId", hostApp._id))
        .collect();
      for (const token of used) await del(token._id);
      const audit = await ctx.db
        .query("widgetAuditLog")
        .withIndex("by_hostapp_created", (q) => q.eq("hostAppId", hostApp._id))
        .collect();
      for (const row of audit) await del(row._id);
      const identities = (await ctx.db.query("externalIdentities").collect()).filter(
        (identity) => (identity.hostAppId as string) === (hostApp._id as string),
      );
      for (const identity of identities) {
        candidateUserIds.add(identity.userId as string);
        await del(identity._id);
      }
      await del(hostApp._id);
    }

    if (args.deleteUsers === true) {
      for (const userId of candidateUserIds) {
        const memberships = await ctx.db
          .query("memberships")
          .withIndex("by_user_path", (q) => q.eq("userId", userId as any))
          .take(1);
        const remainingOrg = await ctx.db
          .query("orgMembers")
          .withIndex("by_user", (q) => q.eq("userId", userId as any))
          .take(1);
        const identities = await ctx.db
          .query("externalIdentities")
          .withIndex("by_user", (q) => q.eq("userId", userId as any))
          .take(1);
        if (memberships.length > 0 || remainingOrg.length > 0 || identities.length > 0) continue;
        const sessions = await ctx.db
          .query("authSessions")
          .withIndex("userId", (q) => q.eq("userId", userId as any))
          .collect();
        for (const session of sessions) {
          const refresh = await ctx.db
            .query("authRefreshTokens")
            .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
            .collect();
          for (const token of refresh) await del(token._id);
          await del(session._id);
        }
        const accounts = await ctx.db
          .query("authAccounts")
          .withIndex("userIdAndProvider", (q) => q.eq("userId", userId as any))
          .collect();
        for (const account of accounts) await del(account._id);
        await del(userId);
      }
    }
    const rollups = await ctx.db
      .query("usageRollups")
      .withIndex("by_org_day", (q) => q.eq("orgId", org._id))
      .collect();
    for (const row of rollups) await del(row._id);

    const idempotency = (await ctx.db.query("idempotencyKeys").collect()).filter(
      (row) => (row.orgId as string) === (org._id as string),
    );
    for (const row of idempotency) await del(row._id);

    await del(org._id);
    return { removed: true, deleted };
  },
});

/**
 * Delete groups whose organisation no longer exists. Earlier purge versions deleted the tenant's
 * messages and org row but left the group rows behind; this walks the groups table in pages and
 * removes those orphans. It is test-fixture cleanup, not a product retention path.
 */
export const purgeOrphanGroups = internalMutation({
  args: { maxGroups: v.optional(v.number()), cursor: v.optional(v.string()) },  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(200, Math.floor(args.maxGroups ?? 100)));
    const page = await ctx.db.query("groups").paginate({
      cursor: args.cursor ?? null,
      numItems: limit,
    });
    let deletedGroups = 0;
    for (const group of page.page) {
      if (group.kind !== "group") continue;
      const org = await ctx.db.get(group.orgId);
      if (org !== null) continue;
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .collect();
      for (const message of messages) await ctx.db.delete(message._id);
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .collect();
      for (const membership of memberships) await ctx.db.delete(membership._id);
      const attachments = await ctx.db
        .query("attachments")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .collect();
      for (const attachment of attachments) await ctx.db.delete(attachment._id);
      const activity = await ctx.db
        .query("groupActivity")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .collect();
      for (const row of activity) await ctx.db.delete(row._id);
      await ctx.db.delete(group._id);
      deletedGroups++;
    }
    return {
      deletedGroups,
      scanned: page.page.length,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Remove loose test users left by fixture cleanup. Production pilots have no such users. */
export const purgeLooseTestUsers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    let deleted = 0;
    for (const user of users) {
      const email = (user.email ?? "").toLowerCase();
      const isTest =
        email.endsWith("@demo.teamchat.test") ||
        email.endsWith("@pilot.teamchat.test") ||
        (user.name ?? "").startsWith("Cross tenant B ");
      if (!isTest) continue;
      const sessions = await ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", user._id))
        .collect();
      for (const session of sessions) {
        const refresh = await ctx.db
          .query("authRefreshTokens")
          .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
          .collect();
        for (const token of refresh) await ctx.db.delete(token._id);
        await ctx.db.delete(session._id);
      }
      const accounts = await ctx.db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (q) => q.eq("userId", user._id))
        .collect();
      for (const account of accounts) await ctx.db.delete(account._id);
      const identities = await ctx.db
        .query("externalIdentities")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect();
      for (const identity of identities) await ctx.db.delete(identity._id);
      await ctx.db.delete(user._id);
      deleted++;
    }
    return { deleted, scanned: users.length };
  },
});
