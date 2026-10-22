// Widget uploads (O2 / CR-8). Blocked by default for every shadow account, regardless of what the
// client calls. Opt-in lives on the host app; the per-org byte cap still applies and is enforced
// again at confirm. Every widget attachment is org-scoped: a shadow has no personal storage scope.

import { action } from "../_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import { MINUTE } from "@convex-dev/rate-limiter";
import { decryptSecret } from "../lib/crypto";
import { newPublicId } from "../lib/ids";
import {
  assertAllowedFile,
  isAllowedMime,
  MAX_FILE_BYTES,
  orgStorageCapBytes,
  sanitizeFileName,
} from "../lib/limits";
import { rateLimiter } from "../lib/rateLimiter";
import { OrgStorageTarget } from "../storage/adapter";
import { s3Adapter, UPLOAD_TICKET_SECONDS } from "../storage/s3";

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

function joinKey(...segments: Array<string | undefined>): string {
  return segments
    .filter((s): s is string => s !== undefined && s !== "")
    .map((s) => s.replace(/^\/+|\/+$/g, ""))
    .filter((s) => s !== "")
    .join("/");
}

async function shadowForAction(ctx: any) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Not signed in");
  const shadow = await ctx.runQuery(internal.widgets.exchange.identityForUser, { userId });
  return { userId, shadow };
}

async function denyUpload(ctx: any, shadow: any, detail: string, message: string): Promise<never> {
  await ctx.runMutation(internal.widgets.exchange.audit, {
    hostAppId: shadow.hostApp.id,
    userId: shadow.userId,
    kind: "upload_denied",
    detail,
  });
  throw new Error(message);
}

export const requestWidgetUpload = action({
  args: {
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
    const { userId, shadow } = await shadowForAction(ctx);
    if (!shadow.uploads.enabled) {
      await denyUpload(
        ctx,
        shadow,
        "allowWidgetUploads is false",
        "Widget uploads are disabled for this host app",
      );
    }

    const maxBytes = Math.min(shadow.uploads.maxFileBytes, MAX_FILE_BYTES);
    if (!Number.isFinite(args.size) || args.size <= 0 || args.size > maxBytes) {
      await denyUpload(
        ctx,
        shadow,
        `size ${args.size} outside 1..${maxBytes}`,
        `File size must be between 1 and ${maxBytes} bytes for this widget`,
      );
    }
    if (!shadow.uploads.mimes.includes(args.mime) || !isAllowedMime(args.mime)) {
      await denyUpload(
        ctx,
        shadow,
        `mime ${args.mime} not in the host app allowlist`,
        `Content type "${args.mime}" is not allowed for this widget`,
      );
    }
    // Global limits still apply (name/size/type) even inside the narrower host allowlist.
    assertAllowedFile({ name: args.name, mime: args.mime, size: args.size });

    const rate = await rateLimiter.limit(ctx, "widgetUpload", {
      key: `${shadow.hostApp.id}:${userId}`,
      config: {
        kind: "fixed window",
        rate: Math.max(1, shadow.uploads.maxPerMinute),
        period: MINUTE,
      },
    });
    if (!rate.ok) {
      await denyUpload(
        ctx,
        shadow,
        "widget upload rate limit",
        `Too many widget uploads. Try again in ${Math.max(1, Math.ceil((rate.retryAfter ?? MINUTE) / 1000))} second(s).`,
      );
    }

    const config = await ctx.runQuery(internal.storage.config.getActiveConfigForOrg, {
      orgId: shadow.org.id,
    });
    if (config === null) {
      throw new Error("This organisation has no storage configured yet; messages will be text-only");
    }
    const usage = await ctx.runQuery(internal.storage.attachments.usageForOrg, {
      orgId: shadow.org.id,
    });
    const cap = orgStorageCapBytes();
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
      shadow.org.publicId,
      attachmentId,
      safeName,
    );
    await ctx.runMutation(internal.storage.attachments.createPending, {
      attachmentId,
      orgId: shadow.org.id,
      groupId: shadow.supportGroup.id,
      uploaderId: userId,
      storageConfigId: config.configId,
      pendingKey,
      name: args.name,
      mime: args.mime,
      size: args.size,
      expiresAt: Date.now() + PENDING_TTL_MS,
      widgetHostAppId: shadow.hostApp.id,
    });

    const loaded = await ctx.runQuery(internal.storage.attachments.targetForConfig, {
      configId: config.configId,
    });
    const secret = JSON.parse(await decryptSecret(loaded.ciphertext, loaded.keyVersion)) as {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };
    const target: OrgStorageTarget = {
      endpoint: loaded.endpoint,
      bucket: loaded.bucket,
      region: loaded.region,
      keyPrefix: loaded.keyPrefix,
      pendingPrefix: loaded.pendingPrefix,
      credentials: secret,
    };
    const ticket = await s3Adapter.requestUpload({
      target,
      key: pendingKey,
      contentType: args.mime,
      expiresInSeconds: UPLOAD_TICKET_SECONDS,
      maxBytes,
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

export const confirmWidgetUpload = action({
  args: { attachmentId: v.string() },
  handler: async (ctx, args): Promise<{
    attachmentId: string;
    name: string;
    mime: string;
    size: number;
    status: "confirmed";
    scope: "org";
  }> => {
    const { userId, shadow } = await shadowForAction(ctx);
    if (!shadow.uploads.enabled) {
      await denyUpload(
        ctx,
        shadow,
        "allowWidgetUploads is false at confirm",
        "Widget uploads are disabled for this host app",
      );
    }

    const pending = await ctx.runQuery(internal.storage.attachments.getPendingForUploader, {
      attachmentId: args.attachmentId,
      userId,
    });
    if (pending.widgetHostAppId !== shadow.hostApp.id) {
      throw new Error("This upload was not issued to this host app");
    }
    if (pending.groupId !== shadow.supportGroup.id) {
      throw new Error("Widget uploads are confined to the host app's support group");
    }

    const loaded = await ctx.runQuery(internal.storage.attachments.targetForConfig, {
      configId: pending.storageConfigId,
    });
    const secret = JSON.parse(await decryptSecret(loaded.ciphertext, loaded.keyVersion)) as {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };
    const target: OrgStorageTarget = {
      endpoint: loaded.endpoint,
      bucket: loaded.bucket,
      region: loaded.region,
      keyPrefix: loaded.keyPrefix,
      pendingPrefix: loaded.pendingPrefix,
      credentials: secret,
    };

    const head = await s3Adapter.headObject({ target, key: pending.pendingKey });
    if (head === null) throw new Error("The uploaded file was not found in storage");
    if (head.size <= 0) throw new Error("The uploaded file is empty");
    const maxBytes = Math.min(shadow.uploads.maxFileBytes, MAX_FILE_BYTES);
    if (head.size > maxBytes) {
      throw new Error(`The uploaded file is too large for this widget: ${head.size} > ${maxBytes} bytes`);
    }
    const storedMime = head.contentType !== null ? head.contentType.split(";")[0].trim() : null;
    if (storedMime !== null && (!shadow.uploads.mimes.includes(storedMime) || !isAllowedMime(storedMime))) {
      throw new Error(`The uploaded file's content type "${storedMime}" is not allowed for this widget`);
    }

    const fileKey = joinKey(
      target.keyPrefix,
      shadow.org.publicId,
      args.attachmentId,
      sanitizeFileName(pending.name),
    );
    await s3Adapter.promoteObject({ target, fromKey: pending.pendingKey, toKey: fileKey });
    try {
      // markConfirmed enforces the per-org cap in the serializable mutation. Opt-in does not
      // bypass the cap.
      const marked = await ctx.runMutation(internal.storage.attachments.markConfirmed, {
        attachmentId: args.attachmentId,
        userId,
        fileKey,
        actualSize: head.size,
        actualMime: storedMime ?? pending.mime,
      });
      return {
        attachmentId: args.attachmentId,
        name: pending.name,
        mime: marked.mime,
        size: marked.size,
        status: "confirmed" as const,
        scope: "org" as const,
      };
    } catch (error) {
      await s3Adapter.deleteObject({ target, key: fileKey }).catch(() => {});
      throw error;
    }
  },
});
