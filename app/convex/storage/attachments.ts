// SAL flows: upload ticket → confirm (promote) → read ticket, plus the pending sweep.
//
// Contract (PRD Part 3 / v0 brief):
//   1. `requestUpload`  — rate-limited, validated intent; a signed POST policy under `pending/`
//                         with an exact key, Content-Type and `content-length-range`; expires.
//   2. `confirmUpload`  — HEAD the object, re-check limits, then an S3-side CopyObject out of
//                         `pending/`; only then is the attachment confirmed.
//   3. `requestRead`    — group access is checked FIRST; only then is a short-lived GET signed.
//
// No media bytes pass through Convex. Storage authority for a read lives on the message:
// `messages.attachments[].storageRef` is the only source of the file key and config used to sign
// a GET. The `attachments` table is pending/confirmed bookkeeping only — losing its fileKey does
// not change what a reader resolves, and a confirmed row whose message no longer lists the id is
// unreachable. Nothing unconfirmed is reachable: read tickets require a confirmed row that a
// message recorded.

import { action, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import { decryptSecret } from "../lib/crypto";
import { newPublicId } from "../lib/ids";
import { assertAllowedFile, isAllowedMime, MAX_FILE_BYTES, orgStorageCapBytes, sanitizeFileName } from "../lib/limits";
import { rateLimiter } from "../lib/rateLimiter";
import { requireGroupAccess } from "../lib/guards";
import { loadShadowContext, messageVisibleToShadow } from "../widgets/context";
import { OrgStorageTarget } from "./adapter";
import { READ_TICKET_SECONDS, s3Adapter, UPLOAD_TICKET_SECONDS } from "./s3";
import { Id } from "../_generated/dataModel";

const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // unconfirmed objects expire after 24h

/** S3 key segments are joined with slashes; empty segments are skipped. */
function joinKey(...segments: Array<string | undefined>): string {
  return segments
    .filter((s): s is string => s !== undefined && s !== "")
    .map((s) => s.replace(/^\/+|\/+$/g, ""))
    .filter((s) => s !== "")
    .join("/");
}

function requireActionUserId(userId: Id<"users"> | null): Id<"users"> {
  if (userId === null) throw new Error("Not signed in");
  return userId;
}

/**
 * Step 1 — the upload ticket. Validates intent (size, type), enforces the per-org cap, writes the
 * pending row, then signs a POST policy bound to the exact key, declared Content-Type and
 * declared size. A ticket names either a tree group or a DM peer; a DM resolves a shared org
 * whose storage bills the upload.
 */
export const requestUpload = action({
  args: {
    groupPublicId: v.optional(v.string()),
    peerPublicId: v.optional(v.string()),
    name: v.string(),
    mime: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args): Promise<{
    attachmentId: string;
    uploadUrl: string;
    method: "POST";
    fields: Record<string, string>;
    expiresAt: number;
  }> => {
    const userId = requireActionUserId(await getAuthUserId(ctx));
    if ((args.groupPublicId === undefined) === (args.peerPublicId === undefined)) {
      throw new Error("Provide either groupPublicId or peerPublicId");
    }

    // Cheap validation before anything else (the 25 MB / allowlist rules).
    assertAllowedFile({ name: args.name, mime: args.mime, size: args.size });
    await rateLimiter.limit(ctx, "requestUpload", { key: userId, throws: true });

    const resolved = await ctx.runQuery(internal.storage.config.resolveGroupForUpload, {
      userId,
      groupPublicId: args.groupPublicId,
      peerPublicId: args.peerPublicId,
    });

    const config = await ctx.runQuery(internal.storage.config.getActiveConfigForOrg, {
      orgId: resolved.orgId,
    });
    if (config === null) {
      // v0: the org admin configures storage with `storage.setS3Config`; the client shows a
      // "storage is not connected" prompt and stays text-only (derived `byosProvider: none`).
      throw new Error("This organisation has no storage configured yet; messages will be text-only");
    }

    const usage = await ctx.runQuery(internal.storage.attachments.usageForOrg, {
      orgId: resolved.orgId,
    });
    const capInfo = await ctx.runQuery(internal.storage.config.storageCapForOrg, {
      orgId: resolved.orgId,
    });
    const cap = capInfo.capBytes;
    if (usage.confirmedBytes + args.size > cap) {
      throw new Error(
        `The organisation's storage cap would be exceeded (${usage.confirmedBytes} + ${args.size} > ${cap} bytes)`,
      );
    }

    const attachmentId = newPublicId("att");
    const safeName = sanitizeFileName(args.name);
    const pendingKey = joinKey(
      config.keyPrefix,
      config.pendingPrefix,
      resolved.orgPublicId,
      attachmentId,
      safeName,
    );

    await ctx.runMutation(internal.storage.attachments.createPending, {
      attachmentId,
      orgId: resolved.orgId,
      groupId: resolved.groupId,
      uploaderId: userId,
      storageConfigId: config.configId,
      pendingKey,
      name: args.name,
      mime: args.mime,
      size: args.size,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    const target = await toTarget(
      await ctx.runQuery(internal.storage.attachments.targetForConfig, {
        configId: config.configId,
      }),
    );
    const ticket = await s3Adapter.requestUpload({
      target,
      key: pendingKey,
      contentType: args.mime,
      expiresInSeconds: UPLOAD_TICKET_SECONDS,
      maxBytes: Math.min(args.size, MAX_FILE_BYTES),
    });

    return {
      attachmentId,
      uploadUrl: ticket.url,
      method: "POST" as const,
      fields: ticket.fields,
      expiresAt: ticket.expiresAt,
    };
  },
});

/**
 * Step 2 — confirm. HEADs the pending object, re-checks the real size and type, then promotes it
 * out of `pending/` with an S3-side copy. The attachment only becomes usable here.
 */
export const confirmUpload = action({
  args: { attachmentId: v.string() },
  handler: async (ctx, args): Promise<{
    attachmentId: string;
    name: string;
    mime: string;
    size: number;
    status: "confirmed";
  }> => {
    const userId = requireActionUserId(await getAuthUserId(ctx));

    const pending = await ctx.runQuery(internal.storage.attachments.getPendingForUploader, {
      attachmentId: args.attachmentId,
      userId,
    });

    const target = await toTarget(
      await ctx.runQuery(internal.storage.attachments.targetForConfig, {
        configId: pending.storageConfigId,
      }),
    );

    const head = await s3Adapter.headObject({ target, key: pending.pendingKey });
    if (head === null) {
      throw new Error(
        "The uploaded file was not found in storage — the upload did not finish or has expired",
      );
    }
    if (head.size <= 0) throw new Error("The uploaded file is empty");
    if (head.size > MAX_FILE_BYTES) {
      throw new Error(
        `The uploaded file is too large: ${head.size} bytes; the limit is ${MAX_FILE_BYTES} bytes (25 MB)`,
      );
    }
    const storedMime = head.contentType !== null ? head.contentType.split(";")[0].trim() : null;
    if (storedMime !== null && !isAllowedMime(storedMime)) {
      throw new Error(`The uploaded file's content type "${storedMime}" is not allowed`);
    }

    const fileKey = joinKey(
      target.keyPrefix,
      pending.orgPublicId,
      args.attachmentId,
      sanitizeFileName(pending.name),
    );

    await s3Adapter.promoteObject({ target, fromKey: pending.pendingKey, toKey: fileKey });

    let marked;
    try {
      marked = await ctx.runMutation(internal.storage.attachments.markConfirmed, {
        attachmentId: args.attachmentId,
        userId,
        fileKey,
        actualSize: head.size,
        actualMime: storedMime ?? pending.mime,
      });
    } catch (error) {
      // The cap check lives in the (serializable) mutation; if it refuses, the promoted object
      // must not linger outside the expiring prefix.
      await s3Adapter.deleteObject({ target, key: fileKey }).catch(() => {});
      throw error;
    }

    return {
      attachmentId: args.attachmentId,
      name: pending.name,
      mime: marked.mime,
      size: marked.size,
      status: "confirmed" as const,
    };
  },
});

/**
 * Step 3 — read ticket. Group access is checked FIRST (a confirmed row that a message recorded,
 * then the message's group, then membership/admin rights). Only then is a GET signed.
 */
export const requestRead = action({
  args: { attachmentId: v.string() },
  handler: async (ctx, args): Promise<{
    url: string;
    expiresAt: number;
    name: string;
    mime: string;
    size: number;
  }> => {
    const userId = requireActionUserId(await getAuthUserId(ctx));

    const access = await ctx.runQuery(internal.storage.attachments.resolveReadAccess, {
      attachmentId: args.attachmentId,
      userId,
    });

    const target = await toTarget(
      await ctx.runQuery(internal.storage.attachments.targetForConfig, {
        configId: access.storageConfigId,
      }),
    );
    const ticket = await s3Adapter.requestRead({
      target,
      key: access.fileKey,
      expiresInSeconds: READ_TICKET_SECONDS,
    });
    return {
      url: ticket.url,
      expiresAt: ticket.expiresAt,
      name: access.name,
      mime: access.mime,
      size: access.size,
    };
  },
});

/**
 * Hourly sweep: delete objects whose pending row expired, then mark the rows expired. Rows are
 * swept in bounded batches; a partial sweep simply runs again next hour.
 */
export const sweepPending = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ scanned: number; deleted: number; failed: number }> => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const expired = await ctx.runQuery(internal.storage.attachments.expiredPending, {
      expiresAtBefore: Date.now(),
      limit,
    });
    let deleted = 0;
    let failed = 0;
    for (const row of expired) {
      try {
        const target = await toTarget(
          await ctx.runQuery(internal.storage.attachments.targetForConfig, {
            configId: row.storageConfigId,
          }),
        );
        await s3Adapter.deleteObject({ target, key: row.pendingKey });
        await ctx.runMutation(internal.storage.attachments.markExpired, { id: row.id });
        deleted++;
      } catch {
        // A config that was disabled/rotated mid-flight leaves the object unreachable anyway
        // (its key is under the org prefix and no row will ever confirm it); mark expired so the
        // row does not accumulate.
        await ctx.runMutation(internal.storage.attachments.markExpired, { id: row.id }).catch(() => {});
        failed++;
      }
    }
    return { scanned: expired.length, deleted, failed };
  },
});

// ---------------------------------------------------------------- internal steps

/** Confirmed bytes for the org cap (0 when nothing was ever confirmed). */
export const usageForOrg = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const usage = await ctx.db
      .query("storageUsage")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    return { confirmedBytes: usage?.confirmedBytes ?? 0 };
  },
});

/**
 * Config + encrypted credential material for a storage config. The action decrypts locally:
 * decrypted secrets must never appear in a query result (query results are cached), even an
 * internal one. This query returns the same ciphertext that `storageConfigs` already references.
 */
export const targetForConfig = internalQuery({
  args: { configId: v.id("storageConfigs") },
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (config === null) throw new Error("Storage config not found");
    if (config.status !== "active" || config.provider !== "s3") {
      throw new Error("The organisation's storage is not active");
    }
    if (config.credentialRef === undefined) throw new Error("Storage credential is missing");
    const credential = await ctx.db.get(config.credentialRef);
    if (credential === null || credential.scopeType !== "org" || credential.orgId !== config.orgId) {
      throw new Error("Storage credential is missing");
    }
    if (
      config.endpoint === undefined ||
      config.bucket === undefined ||
      config.region === undefined
    ) {
      throw new Error("Storage config is incomplete");
    }
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
  },
});

type LoadedConfig = {
  endpoint: string;
  bucket: string;
  region: string;
  keyPrefix: string;
  pendingPrefix: string;
  ciphertext: string;
  keyVersion: number;
};

/** Action-side: decrypt one config's credential into an adapter target. Server-only. */
async function toTarget(config: LoadedConfig): Promise<OrgStorageTarget> {
  const secret = JSON.parse(await decryptSecret(config.ciphertext, config.keyVersion)) as {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  return {
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
    keyPrefix: config.keyPrefix,
    pendingPrefix: config.pendingPrefix,
    credentials: secret,
  };
}

export const createPending = internalMutation({
  args: {
    attachmentId: v.string(),
    orgId: v.id("organizations"),
    groupId: v.id("groups"),
    uploaderId: v.id("users"),
    storageConfigId: v.id("storageConfigs"),
    pendingKey: v.string(),
    name: v.string(),
    mime: v.string(),
    size: v.number(),
    expiresAt: v.number(),
    widgetHostAppId: v.optional(v.id("hostApps")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("attachments")
      .withIndex("by_attachment_id", (q) => q.eq("attachmentId", args.attachmentId))
      .unique();
    if (existing !== null) throw new Error("Attachment id collision");
    await ctx.db.insert("attachments", {
      ...args,
      status: "pending",
      createdAt: Date.now(),
    });
    return { attachmentId: args.attachmentId };
  },
});

/** The pending row, for its uploader only, only while pending and unexpired. */
export const getPendingForUploader = internalQuery({
  args: { attachmentId: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("attachments")
      .withIndex("by_attachment_id", (q) => q.eq("attachmentId", args.attachmentId))
      .unique();
    if (row === null) throw new Error("Attachment not found");
    if (row.uploaderId !== args.userId) throw new Error("You can only confirm files you uploaded");
    if (row.status !== "pending") throw new Error(`Attachment is already ${row.status}`);
    if (row.expiresAt < Date.now()) throw new Error("The upload window has expired; request a new ticket");
    const org = await ctx.db.get(row.orgId);
    if (org === null) throw new Error("Organisation not found");
    return {
      id: row._id,
      orgId: row.orgId,
      orgPublicId: org.publicId,
      groupId: row.groupId,
      storageConfigId: row.storageConfigId,
      pendingKey: row.pendingKey,
      name: row.name,
      mime: row.mime,
      size: row.size,
      expiresAt: row.expiresAt,
      widgetHostAppId: row.widgetHostAppId ?? null,
    };
  },
});

/**
 * Confirmation + accounting, in one serializable mutation. This is where the per-org cap is
 * enforced exactly (the pre-check in `requestUpload` reads committed state only).
 */
export const markConfirmed = internalMutation({
  args: {
    attachmentId: v.string(),
    userId: v.id("users"),
    fileKey: v.string(),
    actualSize: v.number(),
    actualMime: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("attachments")
      .withIndex("by_attachment_id", (q) => q.eq("attachmentId", args.attachmentId))
      .unique();
    if (row === null) throw new Error("Attachment not found");
    if (row.uploaderId !== args.userId) throw new Error("You can only confirm files you uploaded");
    if (row.status !== "pending") throw new Error(`Attachment is already ${row.status}`);

    const usage = await ctx.db
      .query("storageUsage")
      .withIndex("by_org", (q) => q.eq("orgId", row.orgId))
      .unique();
    const org = await ctx.db.get(row.orgId);
    const confirmedBytes = usage?.confirmedBytes ?? 0;
    const cap = org?.storageCapBytes ?? orgStorageCapBytes();
    if (confirmedBytes + args.actualSize > cap) {
      throw new Error(
        `The organisation's storage cap would be exceeded (${confirmedBytes} + ${args.actualSize} > ${cap} bytes)`,
      );
    }

    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "confirmed",
      fileKey: args.fileKey,
      size: args.actualSize,
      mime: args.actualMime,
      confirmedAt: now,
    });
    if (usage === null) {
      await ctx.db.insert("storageUsage", {
        orgId: row.orgId,
        confirmedBytes: args.actualSize,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(usage._id, {
        confirmedBytes: confirmedBytes + args.actualSize,
        updatedAt: now,
      });
    }
    return { attachmentId: args.attachmentId, size: args.actualSize, mime: args.actualMime };
  },
});

/**
 * Read access for one attachment. Order matters: (1) the row must be confirmed and recorded on a
 * message; (2) the message must itself list the attachment — its `storageRef` is the storage
 * authority; (3) the caller must have access to that message's conversation — membership, or org
 * owner/admin on a tree group ("parents see children"), or DM participation. Only then may a URL
 * be signed.
 *
 * The `attachments` row is consulted for status/message wiring only. Its `fileKey` and
 * `storageConfigId` are never used to sign: a confirmed row that no message lists is
 * unreachable, and changing the row cannot redirect a signature.
 */
export const resolveReadAccess = internalQuery({
  args: { attachmentId: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("attachments")
      .withIndex("by_attachment_id", (q) => q.eq("attachmentId", args.attachmentId))
      .unique();
    if (row === null) throw new Error("Attachment not found");
    if (row.status !== "confirmed" || row.messageId === undefined) {
      throw new Error("This attachment is not available"); // unconfirmed rows are unreachable
    }
    const message = await ctx.db.get(row.messageId);
    if (message === null) throw new Error("This attachment is not available");
    const record = (message.attachments ?? []).find((a) => a.attachmentId === args.attachmentId);
    if (record === undefined) throw new Error("This attachment is not available");
    if (record.storageRef.scope !== "org") {
      throw new Error("This attachment is not available");
    }
    const group = await ctx.db.get(message.groupId);
    if (group === null) throw new Error("This attachment is not available");

    // Shadow accounts are confined to their own ticket thread. This is the storage resolver's
    // rule, not a UI rule: a guessed attachment id cannot cross tickets or leave the support group.
    const caller = await ctx.db.get(args.userId);
    if (caller !== null && caller.accountState === "shadow") {
      const shadow = await loadShadowContext(ctx, caller._id);
      if (!(await messageVisibleToShadow(ctx, message, shadow))) {
        throw new Error("This attachment is not available");
      }
      if (row.widgetHostAppId !== undefined && row.widgetHostAppId !== shadow.hostApp.id) {
        throw new Error("This attachment is not available");
      }
    }

    if (group.kind === "group") {
      await requireGroupAccess(ctx, args.userId, group._id);
    } else if (!group.participantIds.includes(args.userId)) {
      throw new Error("You do not have access to this attachment");
    }
    return {
      storageConfigId: record.storageRef.configId,
      fileKey: record.storageRef.fileKey,
      name: record.name,
      mime: record.mime,
      size: record.size,
    };
  },
});

/** Bounded batch of expired pending rows for the sweep. */
export const expiredPending = internalQuery({
  args: { expiresAtBefore: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("attachments")
      .withIndex("by_status_expires", (q) =>
        q.eq("status", "pending").lt("expiresAt", args.expiresAtBefore),
      )
      .take(args.limit);
    return rows.map((row) => ({
      id: row._id,
      storageConfigId: row.storageConfigId,
      pendingKey: row.pendingKey,
      expiresAt: row.expiresAt,
    }));
  },
});

export const markExpired = internalMutation({
  args: { id: v.id("attachments") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (row === null) return { expired: false };
    if (row.status !== "pending") return { expired: false };
    await ctx.db.patch(row._id, { status: "expired" });
    return { expired: true };
  },
});
