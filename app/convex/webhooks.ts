// Part 5 §4 — outbound webhooks.
//
// Registration is an action only because the URL must be resolved and checked before the row is
// written. Delivery, DNS re-checks and HTTP live in `webhookDelivery.ts` ("use node").
//
// The event helper is a plain mutation helper: it inserts one `webhookDeliveries` row per
// subscribed webhook IN THE SAME MUTATION as the workflow change, then schedules the delivery
// action. The HTTP call can never delay or roll back the state change.

import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireOrgMember } from "./lib/guards";
import { newPublicId, newSecretToken } from "./lib/ids";
import { encryptSecret } from "./lib/crypto";

export const webhookEventValidator = v.union(
  v.literal("task.claimed"),
  v.literal("task.forwarded"),
  v.literal("task.done"),
  v.literal("task.reopened"),
  v.literal("task.closed"),
  v.literal("message.created"),
);

export type WebhookEvent =
  | "task.claimed"
  | "task.forwarded"
  | "task.done"
  | "task.reopened"
  | "task.closed"
  | "message.created";

export type WebhookData = {
  messagePublicId?: string;
  externalRef?: string;
  externalSource?: string;
  groupPublicId?: string;
  claimedBy?: { publicId: string; email?: string };
};

const ALL_EVENTS: WebhookEvent[] = [
  "task.claimed",
  "task.forwarded",
  "task.done",
  "task.reopened",
  "task.closed",
  "message.created",
];

function normaliseEvents(events: WebhookEvent[]): WebhookEvent[] {
  const out: WebhookEvent[] = [];
  for (const event of events) {
    if (!ALL_EVENTS.includes(event)) throw new Error(`Unknown webhook event "${event}"`);
    if (!out.includes(event)) out.push(event);
  }
  if (out.length === 0) throw new Error("Register at least one webhook event");
  return out;
}

/**
 * Insert delivery rows for every active webhook in the org that subscribes to this event.
 * Called from the same mutation that changes workflow state; returns immediately.
 */
export async function enqueueWebhookEvent(
  ctx: any,
  orgId: Id<"organizations">,
  event: WebhookEvent,
  data: WebhookData,
): Promise<void> {
  const hooks = await ctx.db
    .query("webhooks")
    .withIndex("by_org", (q: any) => q.eq("orgId", orgId))
    .collect();
  const subscribed = hooks.filter(
    (hook: Doc<"webhooks">) => hook.isActive && hook.events.includes(event),
  );
  if (subscribed.length === 0) return;

  const payload = {
    event,
    occurredAt: new Date().toISOString(),
    data: {
      messagePublicId: data.messagePublicId,
      externalRef: data.externalRef,
      externalSource: data.externalSource,
      groupPublicId: data.groupPublicId,
      claimedBy: data.claimedBy,
    },
  };
  const now = Date.now();
  for (const hook of subscribed) {
    const deliveryId = await ctx.db.insert("webhookDeliveries", {
      webhookId: hook._id,
      event,
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
    });
    // The action does the network I/O. Scheduling is the only extra step in this mutation.
    await ctx.scheduler.runAfter(0, internal.webhookDelivery.deliver, { deliveryId });
  }
}

// ---------------------------------------------------------------------------------------------
// Delivery support (default runtime; the network action is `webhookDelivery.ts`)
// ---------------------------------------------------------------------------------------------

export const deliveryContext = internalQuery({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (delivery === null) return null;
    const hook = await ctx.db.get(delivery.webhookId);
    if (hook === null) return null;
    const secret = await ctx.db
      .query("webhookSecrets")
      .withIndex("by_webhook", (q) => q.eq("webhookId", hook._id))
      .first();
    return {
      delivery: {
        id: delivery._id,
        status: delivery.status,
        attempts: delivery.attempts,
        event: delivery.event,
        payload: delivery.payload,
      },
      webhook: {
        url: hook.url,
        isActive: hook.isActive,
      },
      secret:
        secret === null
          ? null
          : { ciphertext: secret.ciphertext, keyVersion: secret.keyVersion },
    };
  },
});

export const recordAttempt = internalMutation({
  args: {
    deliveryId: v.id("webhookDeliveries"),
    ok: v.boolean(),
    error: v.optional(v.string()),
    retryDelayMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const delivery = await ctx.db.get(args.deliveryId);
    if (delivery === null) return null;
    const now = Date.now();
    const attempts = delivery.attempts + 1;
    if (args.ok) {
      await ctx.db.patch(delivery._id, {
        status: "delivered",
        attempts,
        lastError: undefined,
        nextAttemptAt: undefined,
      });
      return { status: "delivered" as const, attempts, nextAttemptAt: null, now };
    }
    if (args.retryDelayMs === undefined) {
      await ctx.db.patch(delivery._id, {
        status: "dead",
        attempts,
        lastError: (args.error ?? "delivery failed").slice(0, 300),
        nextAttemptAt: undefined,
      });
      return { status: "dead" as const, attempts, nextAttemptAt: null, now };
    }
    const nextAttemptAt = now + args.retryDelayMs;
    await ctx.db.patch(delivery._id, {
      status: "pending",
      attempts,
      lastError: (args.error ?? "delivery failed").slice(0, 300),
      nextAttemptAt,
    });
    return {
      status: "pending" as const,
      attempts,
      nextAttemptAt,
      retryDelayMs: args.retryDelayMs,
      now,
    };
  },
});

export const dueDeliveries = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const now = Date.now();
    const rows = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status_next", (q) => q.eq("status", "pending").lte("nextAttemptAt", now))
      .take(limit);
    return rows.map((row) => row._id);
  },
});

export const sweepDelivered = internalMutation({
  args: { limit: v.optional(v.number()), olderThanMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
    const cutoff = Date.now() - (args.olderThanMs ?? 30 * 24 * 60 * 60 * 1000);
    const rows = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_status_created", (q) => q.eq("status", "delivered").lt("createdAt", cutoff))
      .take(limit);
    for (const row of rows) await ctx.db.delete(row._id);
    return { deleted: rows.length };
  },
});

export const sweepIdempotencyKeys = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 500);
    const rows = await ctx.db
      .query("idempotencyKeys")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
      .take(limit);
    for (const row of rows) await ctx.db.delete(row._id);
    return { deleted: rows.length };
  },
});

// ---------------------------------------------------------------------------------------------
// Registration / admin
// ---------------------------------------------------------------------------------------------

export const requireAdminForOrg = internalQuery({
  args: { orgPublicId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);
    return { orgId: org._id, orgPublicId: org.publicId };
  },
});

export const insertWebhook = internalMutation({
  args: {
    orgId: v.id("organizations"),
    url: v.string(),
    events: v.array(webhookEventValidator),
    ciphertext: v.string(),
    keyVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const publicId = newPublicId("whk");
    const now = Date.now();
    const webhookId = await ctx.db.insert("webhooks", {
      publicId,
      orgId: args.orgId,
      url: args.url,
      events: normaliseEvents(args.events as WebhookEvent[]),
      isActive: true,
      createdAt: now,
    });
    await ctx.db.insert("webhookSecrets", {
      webhookId,
      ciphertext: args.ciphertext,
      keyVersion: args.keyVersion,
      createdAt: now,
    });
    return { webhookPublicId: publicId, url: args.url, events: args.events, isActive: true };
  },
});

/**
 * Register a webhook. The URL is verified by a Node action that resolves the hostname and rejects
 * private/loopback/link-local/metadata ranges. The plaintext signing secret is returned once.
 */
export const register = action({
  args: {
    orgPublicId: v.string(),
    url: v.string(),
    events: v.array(webhookEventValidator),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    webhookPublicId: string;
    url: string;
    events: WebhookEvent[];
    isActive: boolean;
    secret: string;
    secretShownOnce: true;
    resolvedAddresses: string[];
  }> => {
    const { orgId } = await ctx.runQuery(internal.webhooks.requireAdminForOrg, {
      orgPublicId: args.orgPublicId,
    });
    const checked = await ctx.runAction(internal.webhookDelivery.validateUrl, {
      url: args.url,
    });
    const secret = `whsec_${newSecretToken()}`;
    const encrypted = await encryptSecret(secret);
    const inserted = await ctx.runMutation(internal.webhooks.insertWebhook, {
      orgId,
      url: checked.url,
      events: args.events,
      ciphertext: encrypted.ciphertext,
      keyVersion: encrypted.keyVersion,
    });
    return {
      webhookPublicId: inserted.webhookPublicId,
      url: inserted.url,
      events: inserted.events as WebhookEvent[],
      isActive: inserted.isActive,
      secret,
      secretShownOnce: true,
      resolvedAddresses: checked.addresses,
    };
  },
});

export const rotateSecret = action({
  args: { orgPublicId: v.string(), webhookPublicId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ webhookPublicId: string; rotated: true; secret: string; secretShownOnce: true }> => {
    const { orgId } = await ctx.runQuery(internal.webhooks.requireAdminForOrg, {
      orgPublicId: args.orgPublicId,
    });
    const secret = `whsec_${newSecretToken()}`;
    const encrypted = await encryptSecret(secret);
    const result = await ctx.runMutation(internal.webhooks.replaceSecret, {
      orgId,
      webhookPublicId: args.webhookPublicId,
      ciphertext: encrypted.ciphertext,
      keyVersion: encrypted.keyVersion,
    });
    return {
      webhookPublicId: result.webhookPublicId,
      rotated: true,
      secret,
      secretShownOnce: true,
    };
  },
});

export const replaceSecret = internalMutation({
  args: {
    orgId: v.id("organizations"),
    webhookPublicId: v.string(),
    ciphertext: v.string(),
    keyVersion: v.number(),
  },
  handler: async (ctx, args) => {
    const hook = await ctx.db
      .query("webhooks")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.webhookPublicId))
      .unique();
    if (hook === null || hook.orgId !== args.orgId) throw new Error("Webhook not found");
    const rows = await ctx.db
      .query("webhookSecrets")
      .withIndex("by_webhook", (q) => q.eq("webhookId", hook._id))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    await ctx.db.insert("webhookSecrets", {
      webhookId: hook._id,
      ciphertext: args.ciphertext,
      keyVersion: args.keyVersion,
      createdAt: Date.now(),
    });
    return { webhookPublicId: hook.publicId, rotated: true };
  },
});

export const setActive = mutation({
  args: { orgPublicId: v.string(), webhookPublicId: v.string(), isActive: v.boolean() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);
    const hook = await ctx.db
      .query("webhooks")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.webhookPublicId))
      .unique();
    if (hook === null || hook.orgId !== org._id) throw new Error("Webhook not found");
    await ctx.db.patch(hook._id, { isActive: args.isActive });
    return { webhookPublicId: hook.publicId, isActive: args.isActive };
  },
});

/** List registrations and the most recent deliveries. Never returns a secret or `_id`. */
export const listForOrg = query({
  args: { orgPublicId: v.string(), deliveryLimit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);
    const limit = Math.min(Math.max(args.deliveryLimit ?? 20, 1), 100);
    const hooks = await ctx.db
      .query("webhooks")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    const out = [];
    for (const hook of hooks) {
      const deliveries = await ctx.db
        .query("webhookDeliveries")
        .withIndex("by_webhook", (q) => q.eq("webhookId", hook._id))
        .order("desc")
        .take(limit);
      out.push({
        publicId: hook.publicId,
        url: hook.url,
        events: hook.events,
        isActive: hook.isActive,
        createdAt: hook.createdAt,
        recentDeliveries: deliveries.map((delivery) => ({
          event: delivery.event,
          status: delivery.status,
          attempts: delivery.attempts,
          nextAttemptAt: delivery.nextAttemptAt ?? null,
          lastError: delivery.lastError ?? null,
          createdAt: delivery.createdAt,
        })),
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  },
});
