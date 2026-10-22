// Org storage configuration and credentials.
//
// LINT 1 — no secret on a client-readable document: the access key/secret are written only to
// `byosCredentials`, encrypted with the versioned master key. No client-facing query reads that
// table; `myStorageState` returns only the derived provider name, never a credential or a
// credential reference.
//
// v0 note: `setS3Config` is an org-owner/admin mutation so the dev bucket can be configured
// without the (unbuilt) admin dashboard. It never returns the secret. Moving this behind the
// dashboard/API layer is planned work, not a v0 change.

import { internalQuery, mutation, query, QueryCtx } from "../_generated/server";
import { v } from "convex/values";
import { conversationAddressValidator, dmKeyFor, resolveConversation } from "../lib/address";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { requireActive, requireGroupAccess, requireOrgMember } from "../lib/guards";
import { orgStorageCapBytes } from "../lib/limits";
import { Doc, Id } from "../_generated/dataModel";

export const setS3Config = mutation({
  args: {
    orgPublicId: v.string(),
    endpoint: v.string(),
    bucket: v.string(),
    region: v.string(),
    keyPrefix: v.string(),
    pendingPrefix: v.string(),
    accessKeyId: v.string(),
    secretAccessKey: v.string(),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);

    let endpoint: URL;
    try {
      endpoint = new URL(args.endpoint);
    } catch {
      throw new Error("Endpoint must be a valid URL");
    }
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new Error("Endpoint must be http(s)");
    }
    if (args.bucket.trim() === "") throw new Error("Bucket is required");
    if (args.accessKeyId.trim() === "" || args.secretAccessKey.trim() === "") {
      throw new Error("Storage credentials are required");
    }

    const { ciphertext, keyVersion } = await encryptSecret(
      JSON.stringify({
        accessKeyId: args.accessKeyId,
        secretAccessKey: args.secretAccessKey,
        sessionToken: args.sessionToken,
      }),
    );
    const credentialRef = await ctx.db.insert("byosCredentials", {
      scopeType: "org",
      orgId: org._id,
      ciphertext,
      keyVersion,
      createdAt: Date.now(),
    });

    // One active config per org: disable any previous.
    const previous = await ctx.db
      .query("storageConfigs")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    for (const row of previous) {
      if (row.status === "active") await ctx.db.patch(row._id, { status: "disabled" });
    }

    const configId = await ctx.db.insert("storageConfigs", {
      orgId: org._id,
      provider: "s3",
      endpoint: args.endpoint.replace(/\/+$/, ""),
      bucket: args.bucket,
      region: args.region,
      keyPrefix: args.keyPrefix.replace(/\/+$/, ""),
      pendingPrefix: args.pendingPrefix.replace(/\/+$/, ""),
      credentialRef,
      status: "active",
    });
    return { configId, provider: "s3" as const };
  },
});

/**
 * Derived per-sender storage state (never stored — PRD §4): "none" means this sender has no
 * storage available and the client must operate text-only with a prompt to connect storage.
 */
export const myStorageState = query({
  args: { orgPublicId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id);
    const configs = await ctx.db
      .query("storageConfigs")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    const active = configs.find((c) => c.status === "active" && c.provider === "s3");
    // userStorageConfigs is defined but not built in v0 (CR-19); when Drive lands, this becomes
    // the per-sender resolution point.
    return {
      provider: active !== undefined ? ("s3" as const) : ("none" as const),
      storageCapBytes: org.storageCapBytes ?? null,
    };
  },
});

/**
 * Per-org byte cap. The org's own value wins; TEAMCHAT_ORG_STORAGE_CAP_BYTES is the deployment
 * default. Used by both the upload-ticket pre-check and the confirm-time accounting.
 */
export const storageCapForOrg = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (org === null) throw new Error("Organisation not found");
    return { capBytes: org.storageCapBytes ?? orgStorageCapBytes() };
  },
});

/** Owner/admin: set this org's storage cap without changing the deployment-wide default. */
export const setStorageCap = mutation({
  args: { orgPublicId: v.string(), capBytes: v.number() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);
    const cap = Math.floor(args.capBytes);
    if (!Number.isFinite(cap) || cap < 0) throw new Error("Storage cap must be a non-negative number");
    await ctx.db.patch(org._id, { storageCapBytes: cap });
    return { orgPublicId: org.publicId, capBytes: cap };
  },
});

/** Server-only: active S3 config plus the encrypted credential material for later decryption. */
export const getActiveConfigForOrg = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const configs = await ctx.db
      .query("storageConfigs")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const config = configs.find((c) => c.status === "active" && c.provider === "s3");
    return await loadConfig(ctx, config ?? null);
  },
});

/** Server-only: one config by id (used by confirm, read tickets, and the pending sweep). */
export const getConfigByIdWithCredential = internalQuery({
  args: { configId: v.id("storageConfigs") },
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    return await loadConfig(ctx, config);
  },
});

/**
 * Server-only: turn a `storageConfigs` row into everything the S3 adapter needs *except* the
 * decrypted credential (decryption happens in an action — V8 runtime only).
 */
async function loadConfig(ctx: QueryCtx, config: Doc<"storageConfigs"> | null) {
  if (config === null) return null;
  if (config.credentialRef === undefined) return null;
  const credential = await ctx.db.get(config.credentialRef);
  if (credential === null || credential.scopeType !== "org") return null;
  return {
    configId: config._id,
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
    keyPrefix: config.keyPrefix ?? "",
    pendingPrefix: config.pendingPrefix ?? "pending",
    ciphertext: credential.ciphertext,
    keyVersion: credential.keyVersion,
  };
}

/**
 * Server-only guard used by the upload action.
 *
 * Tree group: an active user with access to the group; the org that owns the group bills and
 * stores the upload.
 *
 * DM: an active participant. DMs carry no org, so the upload resolves a shared org with active
 * storage — the same per-org cap and credential set as a group upload. A DM between users with no
 * shared org-backed storage stays text-only.
 */
export const resolveGroupForUpload = internalQuery({
  args: {
    userId: v.id("users"),
    groupPublicId: v.optional(v.string()),
    peerPublicId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (user === null || user.accountState !== "active") {
      throw new Error("An active account is required");
    }
    if ((args.groupPublicId === undefined) === (args.peerPublicId === undefined)) {
      throw new Error("Provide either groupPublicId or peerPublicId");
    }

    if (args.groupPublicId !== undefined) {
      const group = await ctx.db
        .query("groups")
        .withIndex("by_public_id", (q) => q.eq("publicId", args.groupPublicId!))
        .unique();
      if (group === null || group.kind !== "group") throw new Error("Group not found");
      await requireGroupAccess(ctx, args.userId, group._id);
      const org = await ctx.db.get(group.orgId);
      if (org === null) throw new Error("Organisation not found");
      return {
        groupId: group._id,
        groupPublicId: group.publicId,
        groupKind: "group" as const,
        orgId: org._id,
        orgPublicId: org.publicId,
      };
    }

    const peer = await ctx.db
      .query("users")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.peerPublicId!))
      .unique();
    if (peer === null) throw new Error("User not found");
    if (peer._id === args.userId) throw new Error("You cannot direct-message yourself");
    const group = await ctx.db
      .query("groups")
      .withIndex("by_dm_key", (q) => q.eq("dmKey", dmKeyFor(args.userId, peer._id)))
      .unique();
    if (group === null || group.kind !== "dm") {
      throw new Error("No direct message exists with this user yet");
    }
    if (!group.participantIds.includes(args.userId)) {
      throw new Error("You are not a participant in this direct message");
    }
    const org = await sharedOrgWithStorage(ctx, group.participantIds);
    if (org === null) {
      throw new Error(
        "This direct message has no shared organisation with storage configured; it stays text-only",
      );
    }
    return {
      groupId: group._id,
      groupPublicId: undefined,
      groupKind: "dm" as const,
      orgId: org._id,
      orgPublicId: org.publicId,
    };
  },
});

/**
 * The shared org that stores and bills a DM's attachments. Deterministic: the participants'
 * orgMembers rows are walked in index order and the first shared org with active S3 storage wins,
 * so both senders resolve the same bucket. Returns null when no shared org has storage.
 */
async function sharedOrgWithStorage(
  ctx: QueryCtx,
  participantIds: Id<"users">[],
): Promise<Doc<"organizations"> | null> {
  if (participantIds.length !== 2) return null;
  const [first, second] = participantIds;
  const firstOrgs = await ctx.db
    .query("orgMembers")
    .withIndex("by_user", (q) => q.eq("userId", first))
    .collect();
  const secondOrgs = await ctx.db
    .query("orgMembers")
    .withIndex("by_user", (q) => q.eq("userId", second))
    .collect();
  const secondOrgIds = new Set(secondOrgs.map((row) => row.orgId));
  for (const row of firstOrgs) {
    if (!secondOrgIds.has(row.orgId)) continue;
    const org = await ctx.db.get(row.orgId);
    if (org === null) continue;
    const configs = await ctx.db
      .query("storageConfigs")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    if (configs.some((config) => config.status === "active" && config.provider === "s3")) {
      return org;
    }
  }
  return null;
}

/**
 * Client-safe storage state for an open conversation. Groups report their org's provider; DMs
 * report the shared org that would bill an upload. Never returns anything but the derived name.
 */
export const conversationStorageState = query({
  args: { conversation: conversationAddressValidator },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const { group } = await resolveConversation(ctx, user._id, args.conversation);
    if (group.kind === "dm") {
      const org = await sharedOrgWithStorage(ctx, group.participantIds);
      return { provider: org === null ? ("none" as const) : ("s3" as const) };
    }
    const configs = await ctx.db
      .query("storageConfigs")
      .withIndex("by_org", (q) => q.eq("orgId", group.orgId))
      .collect();
    const active = configs.find((c) => c.status === "active" && c.provider === "s3");
    return { provider: active !== undefined ? ("s3" as const) : ("none" as const) };
  },
});

/** Used by tests/ops: decrypt a config's credential in an action-only code path. */
export async function decryptConfigCredentials(config: {
  ciphertext: string;
  keyVersion: number;
}): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken?: string }> {
  return JSON.parse(await decryptSecret(config.ciphertext, config.keyVersion));
}
