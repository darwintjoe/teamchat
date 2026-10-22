// Part 5 §3 — REST endpoint internals.
//
// Every write does three things in ONE serializable mutation:
//   1. check/store the Idempotency-Key row;
//   2. perform the domain write (message + task, provisioning, group);
//   3. write the delivery rows for any subscribed webhook in the same mutation.
//
// The HTTP action only authenticates, rate-limits and serialises. No `_id` is returned here:
// only `publicId` strings cross this boundary.

import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { newPublicId } from "./lib/ids";
import { noteMessageForActivity } from "./groupActivity";
import { enqueueWebhookEvent } from "./webhooks";

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type IdempotentOutcome =
  | { kind: "new"; status: number; body: string }
  | { kind: "replay"; status: number; body: string }
  | { kind: "conflict" };

async function priorIdempotent(
  ctx: any,
  orgId: Id<"organizations">,
  scope: string,
  key: string,
  requestHash: string,
): Promise<IdempotentOutcome | null> {
  const prior = await ctx.db
    .query("idempotencyKeys")
    .withIndex("by_org_scope_key", (q: any) =>
      q.eq("orgId", orgId).eq("scope", scope).eq("key", key),
    )
    .first();
  if (prior === null) return null;
  if (prior.requestHash !== requestHash) return { kind: "conflict" };
  if (prior.expiresAt <= Date.now()) {
    await ctx.db.delete(prior._id);
    return null;
  }
  return { kind: "replay", status: prior.responseStatus, body: prior.responseBody };
}

async function storeIdempotent(
  ctx: any,
  args: {
    orgId: Id<"organizations">;
    scope: string;
    key: string;
    requestHash: string;
    status: number;
    body: string;
  },
): Promise<void> {
  await ctx.db.insert("idempotencyKeys", {
    orgId: args.orgId,
    scope: args.scope,
    key: args.key,
    requestHash: args.requestHash,
    responseStatus: args.status,
    responseBody: args.body,
    createdAt: Date.now(),
    expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
  });
}

async function serviceUserForOrg(
  ctx: any,
  org: Doc<"organizations">,
): Promise<Doc<"users">> {
  if (org.serviceUserId !== undefined) {
    const existing = await ctx.db.get(org.serviceUserId);
    if (existing !== null && existing.accountState === "bot") return existing;
  }
  const publicId = newPublicId("usr");
  const userId = await ctx.db.insert("users", {
    publicId,
    name: `${org.name} service`,
    accountState: "bot",
    phoneVerified: false,
  });
  await ctx.db.patch(org._id, { serviceUserId: userId });
  const user = await ctx.db.get(userId);
  if (user === null) throw new Error("Service user insert failed");
  return user;
}

async function taskForMessage(
  ctx: any,
  messageId: Id<"messages">,
): Promise<Doc<"actionInbox"> | null> {
  return await ctx.db
    .query("actionInbox")
    .withIndex("by_message", (q: any) => q.eq("messageId", messageId))
    .unique();
}

function messageData(message: Doc<"messages">): {
  messagePublicId?: string;
  externalRef?: string;
  externalSource?: string;
  groupPublicId?: string;
} {
  return {
    messagePublicId: message.publicId,
    externalRef: message.externalRef,
    externalSource: message.externalSource,
    groupPublicId: undefined,
  };
}

async function groupPublicIdFor(ctx: any, groupId: Id<"groups">): Promise<string | undefined> {
  const group = await ctx.db.get(groupId);
  return group !== null && group.kind === "group" ? group.publicId : undefined;
}

// ---------------------------------------------------------------------------------------------
// POST /v1/messages
// ---------------------------------------------------------------------------------------------

export const createMessage = internalMutation({
  args: {
    orgId: v.id("organizations"),
    idempotencyKey: v.string(),
    requestHash: v.string(),
    groupPublicId: v.string(),
    text: v.string(),
    mode: v.union(v.literal("action"), v.literal("discussion")),
    externalRef: v.optional(v.string()),
    externalSource: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<IdempotentOutcome> => {
    const scope = "POST /v1/messages";
    const prior = await priorIdempotent(
      ctx,
      args.orgId,
      scope,
      args.idempotencyKey,
      args.requestHash,
    );
    if (prior !== null) return prior;

    const org = await ctx.db.get(args.orgId);
    if (org === null) throw new Error("Organisation not found");
    const group = await ctx.db
      .query("groups")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.groupPublicId))
      .unique();
    if (group === null || group.kind !== "group" || group.orgId !== args.orgId) {
      throw new Error("Group not found in this organisation");
    }

    const text = args.text.trim();
    if (text === "") throw new Error("A message needs text");
    if (text.length > 4_000) throw new Error("Message text is limited to 4000 characters");
    const externalRef = args.externalRef?.trim();
    const externalSource = args.externalSource?.trim();
    if ((externalRef === undefined) !== (externalSource === undefined)) {
      throw new Error("externalRef and externalSource must be supplied together");
    }

    const serviceUser = await serviceUserForOrg(ctx, org);
    const messagePublicId = newPublicId("msg");
    const messageId = await ctx.db.insert("messages", {
      publicId: messagePublicId,
      groupId: group._id,
      orgId: args.orgId,
      senderId: serviceUser._id,
      text,
      origin: "api",
      mode: args.mode,
      externalRef,
      externalSource,
    });

    let status: string;
    if (args.mode === "action") {
      status = "open";
      await ctx.db.insert("actionInbox", {
        publicId: newPublicId("task"),
        messageId,
        groupId: group._id,
        groupPath: group.path,
        senderId: serviceUser._id,
        // API-originated tasks cannot be closed by the bot sender; a human closer is required.
        senderMayClose: false,
        flagType: "task",
        status: "open",
      });
    } else {
      status = "discussion";
    }

    await noteMessageForActivity(ctx, group._id, Date.now());

    const message = await ctx.db.get(messageId);
    if (message === null) throw new Error("Message insert failed");
    const data = messageData(message);
    data.groupPublicId = group.publicId;
    await enqueueWebhookEvent(ctx, args.orgId, "message.created", data);

    const body = JSON.stringify({ messagePublicId, status });
    await storeIdempotent(ctx, {
      orgId: args.orgId,
      scope,
      key: args.idempotencyKey,
      requestHash: args.requestHash,
      status: 201,
      body,
    });
    return { kind: "new", status: 201, body };
  },
});

// ---------------------------------------------------------------------------------------------
// POST /v1/users/provision
// ---------------------------------------------------------------------------------------------

const provisionUserValidator = v.object({
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  name: v.string(),
  externalRef: v.string(),
  externalSource: v.optional(v.string()),
  groupPublicIds: v.optional(v.array(v.string())),
});

export const provisionUsers = internalMutation({
  args: {
    orgId: v.id("organizations"),
    idempotencyKey: v.string(),
    requestHash: v.string(),
    externalSource: v.optional(v.string()),
    users: v.array(provisionUserValidator),
  },
  handler: async (ctx, args): Promise<IdempotentOutcome> => {
    const scope = "POST /v1/users/provision";
    const prior = await priorIdempotent(
      ctx,
      args.orgId,
      scope,
      args.idempotencyKey,
      args.requestHash,
    );
    if (prior !== null) return prior;
    const org = await ctx.db.get(args.orgId);
    if (org === null) throw new Error("Organisation not found");
    if (args.users.length === 0) throw new Error("At least one user is required");
    if (args.users.length > 100) throw new Error("Provision at most 100 users per request");

    const created: Array<{
      userPublicId: string;
      state: string;
      activatable: boolean;
    }> = [];

    for (const input of args.users) {
      const email = input.email?.trim().toLowerCase();
      const phone = input.phone?.trim();
      const name = input.name.trim();
      const externalRef = input.externalRef.trim();
      const source = (input.externalSource ?? args.externalSource ?? "api").trim();
      if (email === undefined && (phone === undefined || phone === "")) {
        throw new Error(`User "${externalRef}" needs at least one of email or phone`);
      }
      if (name === "") throw new Error(`User "${externalRef}" needs a name`);
      if (externalRef === "") throw new Error("Every provisioned user needs an externalRef");
      if (source === "") throw new Error("externalSource cannot be empty");

      // Idempotent by org-scoped externalRef, not by email.
      const existingMember = await ctx.db
        .query("orgMembers")
        .withIndex("by_org_external", (q) =>
          q.eq("orgId", args.orgId).eq("externalSource", source).eq("externalRef", externalRef),
        )
        .unique();

      let userId: Id<"users">;
      if (existingMember !== null) {
        userId = existingMember.userId;
      } else {
        let existingUser: Doc<"users"> | null = null;
        if (email !== undefined) {
          existingUser = await ctx.db
            .query("users")
            .withIndex("email", (q) => q.eq("email", email))
            .first();
        }
        if (existingUser !== null) {
          if (existingUser.accountState === "bot" || existingUser.accountState === "shadow") {
            throw new Error(`User "${externalRef}" collides with a non-provisionable account`);
          }
          userId = existingUser._id;
          if (existingUser.accountState !== "active") {
            await ctx.db.patch(userId, { accountState: "provisioned", name });
          }
        } else {
          userId = await ctx.db.insert("users", {
            publicId: newPublicId("usr"),
            name,
            email,
            phone: phone === "" ? undefined : phone,
            phoneVerified: false,
            accountState: "provisioned",
          });
        }
        await ctx.db.insert("orgMembers", {
          orgId: args.orgId,
          userId,
          orgRole: "member",
          joinedAt: Date.now(),
          externalRef,
          externalSource: source,
          uniqueKey: `${args.orgId}:${userId}`,
        });
      }

      const user = await ctx.db.get(userId);
      if (user === null) throw new Error(`User "${externalRef}" could not be provisioned`);

      for (const groupPublicId of input.groupPublicIds ?? []) {
        const group = await ctx.db
          .query("groups")
          .withIndex("by_public_id", (q) => q.eq("publicId", groupPublicId))
          .unique();
        if (group === null || group.kind !== "group" || group.orgId !== args.orgId) {
          throw new Error(`Group "${groupPublicId}" not found in this organisation`);
        }
        const membership = await ctx.db
          .query("memberships")
          .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group._id}:${userId}`))
          .unique();
        if (membership === null) {
          await ctx.db.insert("memberships", {
            groupId: group._id,
            userId,
            role: "member",
            groupPath: group.path,
            joinedAt: Date.now(),
            uniqueKey: `${group._id}:${userId}`,
          });
        }
      }

      created.push({
        userPublicId: user.publicId,
        state: user.accountState,
        activatable: user.email !== undefined,
      });
    }

    const body = JSON.stringify({ created });
    await storeIdempotent(ctx, {
      orgId: args.orgId,
      scope,
      key: args.idempotencyKey,
      requestHash: args.requestHash,
      status: 201,
      body,
    });
    return { kind: "new", status: 201, body };
  },
});

// ---------------------------------------------------------------------------------------------
// POST /v1/groups
// ---------------------------------------------------------------------------------------------

export const createGroup = internalMutation({
  args: {
    orgId: v.id("organizations"),
    idempotencyKey: v.string(),
    requestHash: v.string(),
    name: v.string(),
    parentPublicId: v.optional(v.string()),
    memberEmails: v.optional(v.array(v.string())),
    externalRef: v.optional(v.string()),
    externalSource: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<IdempotentOutcome> => {
    const scope = "POST /v1/groups";
    const prior = await priorIdempotent(
      ctx,
      args.orgId,
      scope,
      args.idempotencyKey,
      args.requestHash,
    );
    if (prior !== null) return prior;

    const org = await ctx.db.get(args.orgId);
    if (org === null) throw new Error("Organisation not found");
    if (org.rootGroupId === undefined) throw new Error("Organisation has no root group");
    const root = await ctx.db.get(org.rootGroupId);
    if (root === null || root.kind !== "group") throw new Error("Organisation root group is missing");

    const name = args.name.trim();
    if (name === "") throw new Error("A group name is required");
    if (args.parentPublicId !== undefined) {
      const parent = await ctx.db
        .query("groups")
        .withIndex("by_public_id", (q) => q.eq("publicId", args.parentPublicId as string))
        .unique();
      if (parent === null || parent.kind !== "group" || parent.orgId !== args.orgId) {
        throw new Error("Parent group not found in this organisation");
      }
      if (parent._id !== root._id) {
        throw new Error(
          "Nested groups are not permitted: v0 groups are direct children of the org root (CR-17)",
        );
      }
    }

    const externalRef = args.externalRef?.trim();
    const externalSource = args.externalSource?.trim();
    if ((externalRef === undefined) !== (externalSource === undefined)) {
      throw new Error("externalRef and externalSource must be supplied together");
    }
    if (externalRef !== undefined) {
      const clash = await ctx.db
        .query("groups")
        .withIndex("by_org_external", (q) =>
          q.eq("orgId", args.orgId).eq("externalSource", externalSource).eq("externalRef", externalRef),
        )
        .first();
      if (clash !== null) throw new Error("A group with this externalRef already exists");
    }

    const publicId = newPublicId("grp");
    const path = `/${org.publicId}/${publicId}`;
    const groupId = await ctx.db.insert("groups", {
      kind: "group",
      publicId,
      name,
      orgId: args.orgId,
      parentGroupId: root._id,
      path,
      externalRef,
      externalSource,
    });
    await ctx.db.insert("groupActivity", { groupId, lastMessageAt: 0, flushPending: false });

    const seen = new Set<string>();
    for (const raw of args.memberEmails ?? []) {
      const email = raw.trim().toLowerCase();
      if (email === "" || seen.has(email)) continue;
      seen.add(email);
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .first();
      if (user === null) throw new Error(`No user with email "${email}" exists in this organisation`);
      const orgMember = await ctx.db
        .query("orgMembers")
        .withIndex("by_unique", (q) => q.eq("uniqueKey", `${args.orgId}:${user._id}`))
        .unique();
      if (orgMember === null) throw new Error(`"${email}" is not a member of this organisation`);
      await ctx.db.insert("memberships", {
        groupId,
        userId: user._id,
        role: "member",
        groupPath: path,
        joinedAt: Date.now(),
        uniqueKey: `${groupId}:${user._id}`,
      });
    }

    const body = JSON.stringify({ groupPublicId: publicId, path });
    await storeIdempotent(ctx, {
      orgId: args.orgId,
      scope,
      key: args.idempotencyKey,
      requestHash: args.requestHash,
      status: 201,
      body,
    });
    return { kind: "new", status: 201, body };
  },
});

// ---------------------------------------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------------------------------------

function iso(value: number | undefined): string | null {
  return value === undefined ? null : new Date(value).toISOString();
}

export const lookupTask = internalQuery({
  args: {
    orgId: v.id("organizations"),
    externalRef: v.string(),
    externalSource: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const ref = args.externalRef.trim();
    if (ref === "") return null;
    const source = args.externalSource?.trim();
    const query = ctx.db.query("messages");
    const message =
      source !== undefined && source !== ""
        ? await query
            .withIndex("by_org_external", (q) =>
              q.eq("orgId", args.orgId).eq("externalSource", source).eq("externalRef", ref),
            )
            .order("desc")
            .first()
        : await query
            .withIndex("by_org_ref", (q) => q.eq("orgId", args.orgId).eq("externalRef", ref))
            .order("desc")
            .first();
    if (message === null) return null;
    const task = await taskForMessage(ctx, message._id);
    if (task === null) return null;

    const claimant = task.claimedBy !== undefined ? await ctx.db.get(task.claimedBy) : null;
    const forwarded = task.forwardedTo !== undefined ? await ctx.db.get(task.forwardedTo) : null;
    const events = await ctx.db
      .query("actionEvents")
      .withIndex("by_inbox_time", (q) => q.eq("actionInboxId", task._id))
      .order("desc")
      .collect();
    const claimedEvent = events.find((event) => event.action === "claimed");
    const group = await ctx.db.get(task.groupId);

    return {
      messagePublicId: message.publicId,
      status: task.status,
      claimedBy:
        claimant === null
          ? null
          : { publicId: claimant.publicId, name: claimant.name ?? "Unknown" },
      claimedAt:
        claimedEvent !== undefined && claimedEvent.action === "claimed"
          ? iso(claimedEvent.timestamp)
          : null,
      forwardedTo:
        forwarded === null ? null : { publicId: forwarded.publicId, name: forwarded.name ?? "Unknown" },
      groupPublicId: group !== null && group.kind === "group" ? group.publicId : null,
    };
  },
});

export const getMessage = internalQuery({
  args: { orgId: v.id("organizations"), messagePublicId: v.string() },
  handler: async (ctx, args) => {
    const message = await ctx.db
      .query("messages")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.messagePublicId))
      .unique();
    if (message === null || message.orgId !== args.orgId) return null;
    const group = await ctx.db.get(message.groupId);
    if (group === null || group.kind !== "group") return null;
    return {
      messagePublicId: message.publicId,
      groupPublicId: group.publicId,
      text: message.deletedAt !== undefined ? "" : message.text,
      mode: message.mode,
      origin: message.origin,
      externalRef: message.externalRef ?? null,
      externalSource: message.externalSource ?? null,
      createdAt: iso(message._creationTime),
      attachments: (message.attachments ?? []).map((attachment) => ({
        attachmentId: attachment.attachmentId,
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size,
      })),
    };
  },
});

export const lookupGroup = internalQuery({
  args: {
    orgId: v.id("organizations"),
    externalRef: v.string(),
    externalSource: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const ref = args.externalRef.trim();
    if (ref === "") return null;
    const source = args.externalSource?.trim();
    const query = ctx.db.query("groups");
    const group =
      source !== undefined && source !== ""
        ? await query
            .withIndex("by_org_external", (q) =>
              q.eq("orgId", args.orgId).eq("externalSource", source).eq("externalRef", ref),
            )
            .first()
        : await query
            .withIndex("by_org_ref", (q) => q.eq("orgId", args.orgId).eq("externalRef", ref))
            .first();
    if (group === null || group.kind !== "group" || group.orgId !== args.orgId) return null;
    return { groupPublicId: group.publicId, name: group.name, path: group.path };
  },
});

export const lookupUser = internalQuery({
  args: {
    orgId: v.id("organizations"),
    externalRef: v.string(),
    externalSource: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const ref = args.externalRef.trim();
    if (ref === "") return null;
    const source = args.externalSource?.trim();
    const query = ctx.db.query("orgMembers");
    const member =
      source !== undefined && source !== ""
        ? await query
            .withIndex("by_org_external", (q) =>
              q.eq("orgId", args.orgId).eq("externalSource", source).eq("externalRef", ref),
            )
            .first()
        : await query
            .withIndex("by_org_ref", (q) => q.eq("orgId", args.orgId).eq("externalRef", ref))
            .first();
    if (member === null) return null;
    const user = await ctx.db.get(member.userId);
    if (user === null) return null;
    return {
      userPublicId: user.publicId,
      name: user.name ?? "Unknown",
      email: user.email ?? null,
      phone: user.phone ?? null,
      state: user.accountState,
      activatable: user.email !== undefined,
      externalRef: member.externalRef ?? null,
      externalSource: member.externalSource ?? null,
    };
  },
});

/** Resolve the group's org for an API message write (used before the write mutation). */
export const groupOrg = internalQuery({
  args: { groupPublicId: v.string() },
  handler: async (ctx, args) => {
    const group = await ctx.db
      .query("groups")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.groupPublicId))
      .unique();
    if (group === null || group.kind !== "group") return null;
    return { orgId: group.orgId, groupPublicId: group.publicId };
  },
});
