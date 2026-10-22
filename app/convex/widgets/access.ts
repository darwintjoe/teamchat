// Widget attachment reads. The storage resolver, not the UI, enforces that a shadow can only read
// files on its own ticket thread, and that widget uploads are org-scoped.

import { internalAction, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { decryptSecret } from "../lib/crypto";
import { READ_TICKET_SECONDS, s3Adapter } from "../storage/s3";
import { loadShadowContext, messageVisibleToShadow } from "./context";
import { OrgStorageTarget } from "../storage/adapter";

export const widgetAttachment = internalQuery({
  args: { attachmentId: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    const shadow = await loadShadowContext(ctx, args.userId);
    const row = await ctx.db
      .query("attachments")
      .withIndex("by_attachment_id", (q) => q.eq("attachmentId", args.attachmentId))
      .unique();
    if (row === null) throw new Error("Attachment not found");
    if (row.status !== "confirmed" || row.messageId === undefined) {
      throw new Error("This attachment is not available");
    }
    if (row.widgetHostAppId !== undefined && row.widgetHostAppId !== shadow.hostApp.id) {
      throw new Error("This attachment is not available");
    }
    const message = await ctx.db.get(row.messageId);
    if (message === null) throw new Error("This attachment is not available");
    if (!(await messageVisibleToShadow(ctx, message, shadow))) {
      throw new Error("This attachment is not available");
    }
    const record = (message.attachments ?? []).find(
      (attachment) => attachment.attachmentId === args.attachmentId,
    );
    if (record === undefined || record.storageRef.scope !== "org") {
      throw new Error("This attachment is not available");
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

export const signAttachmentUrl = internalAction({
  args: { storageConfigId: v.id("storageConfigs"), fileKey: v.string() },
  handler: async (ctx, args): Promise<{ url: string; expiresAt: number }> => {
    const config = await ctx.runQuery(internal.storage.attachments.targetForConfig, {
      configId: args.storageConfigId,
    });
    const secret = JSON.parse(await decryptSecret(config.ciphertext, config.keyVersion)) as {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };
    const target: OrgStorageTarget = {
      endpoint: config.endpoint,
      bucket: config.bucket,
      region: config.region,
      keyPrefix: config.keyPrefix,
      pendingPrefix: config.pendingPrefix,
      credentials: secret,
    };
    return await s3Adapter.requestRead({
      target,
      key: args.fileKey,
      expiresInSeconds: READ_TICKET_SECONDS,
    });
  },
});
