// Widget conversation and send path (build items 3, 4, 5).
//
// The client never supplies an origin, a conversation id or a mode that is trusted. The shadow
// user is derived from the session; the support group comes from the host app; the message is
// always `origin: "widget"` and `mode: "action"`; `senderMayClose` is always false.
//
// Threading: first widget message opens a support_ticket; later messages attach to the open ticket
// as replies. A reply on a `done` ticket reopens it to the same claimant with reason
// `customer_reply`. A reply on a `closed`/`archived` ticket opens a new ticket.

import { action, mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import { newPublicId } from "../lib/ids";
import { noteMessageForActivity } from "../groupActivity";
import { enqueueWebhookEvent } from "../webhooks";
import { Doc, Id } from "../_generated/dataModel";
import {
  allTicketsFor,
  loadShadowContext,
  openTicketFor,
  type ShadowContext,
} from "./context";

const MAX_TEXT_LENGTH = 4_000;
const MAX_HISTORY_MESSAGES = 80;
const MAX_REPLIES_PER_TICKET = 50;

type WidgetAttachment = {
  attachmentId: string;
  name: string;
  mime: string;
  size: number;
};

type WidgetMessage = {
  publicId: string;
  text: string;
  createdAt: number;
  mine: boolean;
  senderPublicId: string;
  senderName: string;
  isReply: boolean;
  ticketPublicId: string | null;
  mode: "action";
  attachments: WidgetAttachment[];
};

async function requireShadow(ctx: any): Promise<ShadowContext> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Not signed in");
  return await loadShadowContext(ctx, userId);
}

async function messageById(ctx: any, id: Id<"messages">): Promise<Doc<"messages"> | null> {
  return await ctx.db.get(id);
}

export const me = query({
  args: {},
  handler: async (ctx) => {
    const shadow = await requireShadow(ctx);
    return {
      publicId: shadow.userPublicId,
      name: shadow.name,
      accountState: "shadow" as const,
      hostAppPublicId: shadow.hostApp.publicId,
      hostAppName: shadow.hostApp.name,
      supportGroupPublicId: shadow.supportGroup.publicId,
      uploadsEnabled: shadow.uploads.enabled,
      uploadLimits: shadow.uploads.enabled
        ? {
            maxFileBytes: shadow.uploads.maxFileBytes,
            mimes: shadow.uploads.mimes,
            maxPerMinute: shadow.uploads.maxPerMinute,
          }
        : null,
      branding: {
        primaryColor: shadow.hostApp.primaryColor,
        logoUrl: shadow.hostApp.logoUrl,
      },
    };
  },
});

/**
 * The widget's own conversation: only this shadow's ticket roots and the replies under them.
 * Other customers' tickets in the same support group are structurally unreachable here.
 */
export const conversation = query({
  args: {},
  handler: async (ctx) => {
    const shadow = await requireShadow(ctx);
    const tickets = await allTicketsFor(ctx, shadow);
    const ticketByRoot = new Map<string, Doc<"actionInbox">>();
    const rows: Array<{ message: Doc<"messages">; ticket: Doc<"actionInbox"> }> = [];

    for (const ticket of tickets) {
      const root = await messageById(ctx, ticket.messageId);
      if (root === null) continue;
      ticketByRoot.set(root._id as string, ticket);
      rows.push({ message: root, ticket });
      const replies = await ctx.db
        .query("messages")
        .withIndex("by_parent", (q) => q.eq("parentId", root._id))
        .order("asc")
        .take(MAX_REPLIES_PER_TICKET);
      for (const reply of replies) rows.push({ message: reply, ticket });
    }

    rows.sort((a, b) => a.message._creationTime - b.message._creationTime);
    const bounded = rows.slice(-MAX_HISTORY_MESSAGES);

    const senderIds = new Set(bounded.map((row) => row.message.senderId));
    const senders = new Map<string, Doc<"users">>();
    for (const senderId of senderIds) {
      const sender = await ctx.db.get(senderId);
      if (sender !== null) senders.set(senderId as string, sender);
    }

    const active = [...tickets]
      .reverse()
      .find((ticket) => ticket.status !== "closed" && ticket.status !== "archived");

    return {
      activeTicketPublicId: active?.publicId ?? null,
      activeTicketStatus: active?.status ?? null,
      ticketCount: tickets.length,
      messages: bounded.map(({ message, ticket }) => {
        const sender = senders.get(message.senderId as string) ?? null;
        return {
          publicId: message.publicId,
          text: message.deletedAt !== undefined ? "" : message.text,
          createdAt: message._creationTime,
          mine: message.senderId === shadow.userId,
          senderPublicId: sender?.publicId ?? "usr_unknown",
          senderName: sender?.name ?? "Unknown",
          isReply: message.parentId !== undefined,
          ticketPublicId: ticket.publicId,
          mode: "action" as const,
          attachments: (message.attachments ?? []).map((attachment) => ({
            attachmentId: attachment.attachmentId,
            name: attachment.name,
            mime: attachment.mime,
            size: attachment.size,
          })),
        } satisfies WidgetMessage;
      }),
      uploads: {
        enabled: shadow.uploads.enabled,
        maxFileBytes: shadow.uploads.maxFileBytes,
        mimes: shadow.uploads.mimes,
        maxPerMinute: shadow.uploads.maxPerMinute,
      },
      branding: {
        primaryColor: shadow.hostApp.primaryColor,
        logoUrl: shadow.hostApp.logoUrl,
      },
    };
  },
});

export const sendMessage = mutation({
  args: {
    text: v.string(),
    attachmentIds: v.optional(v.array(v.string())),
    // Deliberately accepted so the server can prove it overrides a client that asks for
    // discussion mode. It is never trusted.
    mode: v.optional(v.union(v.literal("action"), v.literal("discussion"))),
  },
  handler: async (ctx, args) => {
    const shadow = await requireShadow(ctx);
    const text = args.text.trim();
    if (text.length > MAX_TEXT_LENGTH) {
      throw new Error(`Message text is limited to ${MAX_TEXT_LENGTH} characters`);
    }

    if (args.mode !== undefined && args.mode !== "action") {
      // Log the attempt, then force Action. Never reject into a discussion send path.
      await ctx.db.insert("widgetAuditLog", {
        hostAppId: shadow.hostApp.id,
        userId: shadow.userId,
        kind: "mode_override",
        detail: `client requested mode=${args.mode}`,
        createdAt: Date.now(),
      });
    }

    const attachmentRows: Array<{
      row: Doc<"attachments">;
      record: NonNullable<Doc<"messages">["attachments"]>[number];
    }> = [];
    for (const attachmentId of args.attachmentIds ?? []) {
      const row = await ctx.db
        .query("attachments")
        .withIndex("by_attachment_id", (q) => q.eq("attachmentId", attachmentId))
        .unique();
      if (row === null) throw new Error(`Attachment "${attachmentId}" not found`);
      if (row.status !== "confirmed") throw new Error("Attachment is not confirmed");
      if (row.uploaderId !== shadow.userId) throw new Error("You can only attach files you uploaded");
      if (row.groupId !== shadow.supportGroup.id) {
        throw new Error("Widget attachments must belong to this host app's support group");
      }
      if (row.widgetHostAppId !== shadow.hostApp.id) {
        throw new Error("Widget attachments must be uploaded through this host app");
      }
      if (row.messageId !== undefined) throw new Error("Attachment has already been sent");
      if (row.fileKey === undefined) throw new Error("Attachment is missing its storage key");
      attachmentRows.push({
        row,
        record: {
          attachmentId: row.attachmentId,
          // Always org-scoped. A shadow has no personal storage scope and cannot own a copy.
          storageRef: { scope: "org", configId: row.storageConfigId, fileKey: row.fileKey },
          name: row.name,
          mime: row.mime,
          size: row.size,
        },
      });
    }

    if (text === "" && attachmentRows.length === 0) {
      throw new Error("A message needs text or a confirmed attachment");
    }

    const ticket = await openTicketFor(ctx, shadow);
    const publicId = newPublicId("msg");
    const messageId = await ctx.db.insert("messages", {
      publicId,
      groupId: shadow.supportGroup.id,
      orgId: shadow.org.id,
      senderId: shadow.userId,
      text,
      origin: "widget", // server-set
      mode: "action", // forced; the client's `mode` is ignored above
      parentId: ticket?.messageId,
      attachments: attachmentRows.length > 0 ? attachmentRows.map((a) => a.record) : undefined,
    });

    for (const attachment of attachmentRows) {
      await ctx.db.patch(attachment.row._id, { messageId });
    }

    const message = await ctx.db.get(messageId);
    if (message === null) throw new Error("Message insert failed");

    if (ticket !== null) {
      let reopened = false;
      if (ticket.status === "done") {
        if (ticket.claimedBy === undefined) {
          throw new Error("Done ticket has no claimant to return to");
        }
        await ctx.db.patch(ticket._id, { status: "claimed", closedBy: undefined });
        await ctx.db.insert("actionEvents", {
          actionInboxId: ticket._id,
          action: "reopened",
          actorId: shadow.userId,
          reason: "customer_reply",
          timestamp: Date.now(),
        });
        reopened = true;
      }

      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_unique", (q) =>
          q.eq("uniqueKey", `${shadow.supportGroup.id}:${shadow.userId}`),
        )
        .unique();
      if (membership !== null) {
        await ctx.db.patch(membership._id, {
          lastReadAt: message._creationTime,
          lastReadMessageId: messageId,
        });
      }
      await noteMessageForActivity(ctx, shadow.supportGroup.id, message._creationTime);

      if (reopened) {
        // The event identifies the ticket by its root message, not the customer's new reply.
        const root = await ctx.db.get(ticket.messageId);
        await enqueueWebhookEvent(ctx, shadow.org.id, "task.reopened", {
          messagePublicId: root?.publicId,
          groupPublicId: shadow.supportGroup.publicId,
        });
      }
      await enqueueWebhookEvent(ctx, shadow.org.id, "message.created", {
        messagePublicId: publicId,
        groupPublicId: shadow.supportGroup.publicId,
      });

      return {
        messagePublicId: publicId,
        ticketPublicId: ticket.publicId,
        ticketCreated: false,
        reopened,
        mode: "action" as const,
      };
    }

    const ticketPublicId = newPublicId("task");
    await ctx.db.insert("actionInbox", {
      publicId: ticketPublicId,
      messageId,
      groupId: shadow.supportGroup.id,
      groupPath: shadow.supportGroup.path,
      senderId: shadow.userId,
      senderMayClose: false, // widget senders are customers; closing is always the agent side
      flagType: "support_ticket",
      status: "open",
    });

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_unique", (q) =>
        q.eq("uniqueKey", `${shadow.supportGroup.id}:${shadow.userId}`),
      )
      .unique();
    if (membership !== null) {
      await ctx.db.patch(membership._id, {
        lastReadAt: message._creationTime,
        lastReadMessageId: messageId,
      });
    }
    await noteMessageForActivity(ctx, shadow.supportGroup.id, message._creationTime);

    await enqueueWebhookEvent(ctx, shadow.org.id, "message.created", {
      messagePublicId: publicId,
      groupPublicId: shadow.supportGroup.publicId,
    });

    return {
      messagePublicId: publicId,
      ticketPublicId,
      ticketCreated: true,
      reopened: false,
      mode: "action" as const,
    };
  },
});

/**
 * Signed read URL for an attachment in this shadow's own thread. The generic read action also
 * refuses cross-ticket reads; this is the widget-facing path.
 */
export const attachmentUrl = action({
  args: { attachmentId: v.string() },
  handler: async (ctx, args): Promise<{ url: string; expiresAt: number; name: string; mime: string; size: number }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not signed in");
    const access = await ctx.runQuery(internal.widgets.access.widgetAttachment, {
      attachmentId: args.attachmentId,
      userId,
    });
    const ticket = await ctx.runAction(internal.widgets.access.signAttachmentUrl, {
      storageConfigId: access.storageConfigId,
      fileKey: access.fileKey,
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

export type WidgetMessageShape = WidgetMessage;
export type { ShadowContext };
