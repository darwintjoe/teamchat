// Messages (build item 4).
//
// send is one insert plus two bounded writes: the sender's own membership read pointer (Flow A3
// sender exception) and the debounced groupActivity write (Flow A2). No group-scoped document is
// written per message; nothing here writes a counter.
//
// The live page is bounded to 15 messages; older history is served by a separate, non-reactive
// paginated query (`listHistory` — clients call it imperatively, never as a subscription).

import { mutation, query, QueryCtx, MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { conversationAddressValidator, resolveConversation, resolveConversationForRead } from "./lib/address";
import { checkDmPolicy } from "./lib/dmPolicy";
import { requireActive, requireUserId, requireGroupAccess, requireNotShadow } from "./lib/guards";
import { newPublicId } from "./lib/ids";
import { noteMessageForActivity } from "./groupActivity";
import { renderTaskCards, taskFlagValidator, type TaskCard } from "./actionInbox";
import { enqueueWebhookEvent } from "./webhooks";
import { Doc, Id } from "./_generated/dataModel";

export const LIVE_PAGE_SIZE = 15;
const MAX_TEXT_LENGTH = 4_000;

export type ClientMessage = {
  publicId: string;
  text: string;
  deleted: boolean;
  editedAt: number | null;
  createdAt: number;
  senderPublicId: string;
  senderName: string;
  attachments: Array<{ attachmentId: string; name: string; mime: string; size: number }>;
  isReply: boolean;
  mode: "action" | "discussion";
  origin: "app" | "widget" | "api";
  task: TaskCard | null;
};

function maskText(message: Doc<"messages">): string {
  return message.deletedAt !== undefined ? "" : message.text;
}

async function renderMessages(
  ctx: QueryCtx,
  messages: Doc<"messages">[],
  viewerId: Id<"users">,
): Promise<ClientMessage[]> {
  const senderIds = new Set(messages.map((m) => m.senderId));
  const senders = new Map<string, Doc<"users">>();
  for (const senderId of senderIds) {
    const sender = await ctx.db.get(senderId);
    if (sender !== null) senders.set(senderId, sender);
  }
  const cards = await renderTaskCards(ctx, messages, viewerId);
  return messages.map((message) => {
    const sender = senders.get(message.senderId) ?? null;
    return {
      publicId: message.publicId,
      text: maskText(message),
      deleted: message.deletedAt !== undefined,
      editedAt: message.editedAt ?? null,
      createdAt: message._creationTime,
      senderPublicId: sender?.publicId ?? "usr_unknown",
      senderName: sender?.name ?? "Unknown",
      attachments: (message.attachments ?? []).map((a) => ({
        attachmentId: a.attachmentId,
        name: a.name,
        mime: a.mime,
        size: a.size,
      })),
      isReply: message.parentId !== undefined,
      mode: message.mode,
      origin: message.origin,
      task: cards.get(message.publicId) ?? null,
    };
  });
}

/**
 * Edit is blocked once a task leaves `open` (PRD Part 1 §2 integrity rule). A discussion message
 * has no task row and stays editable by its sender.
 */
async function assertNotClaimedAndEditable(
  ctx: MutationCtx,
  message: Doc<"messages">,
): Promise<void> {
  const task = await ctx.db
    .query("actionInbox")
    .withIndex("by_message", (q) => q.eq("messageId", message._id))
    .unique();
  if (task !== null && task.status !== "open") {
    throw new Error(
      `This message's task is ${task.status}; editing is disabled once a task is claimed`,
    );
  }
}

export const send = mutation({
  args: {
    conversation: conversationAddressValidator,
    text: v.string(),
    parentPublicId: v.optional(v.string()),
    attachmentIds: v.optional(v.array(v.string())),
    mode: v.optional(v.union(v.literal("action"), v.literal("discussion"))),
    flagType: v.optional(taskFlagValidator),
  },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const { group, membership } = await resolveConversation(ctx, user._id, args.conversation);

    // DM policy is re-checked at send time: an org may have switched DMs off since the DM was
    // created ("an org-level policy a franchisor can switch off").
    if (group.kind === "dm") {
      const peerId = group.participantIds.find((id) => id !== user._id);
      if (peerId !== undefined) await checkDmPolicy(ctx, user._id, peerId);
    }

    const text = args.text.trim();
    if (text.length > MAX_TEXT_LENGTH) {
      throw new Error(`Message text is limited to ${MAX_TEXT_LENGTH} characters`);
    }

    let parentId: Doc<"messages">["_id"] | undefined;
    const parentPublicId = args.parentPublicId;
    if (parentPublicId !== undefined) {
      const parent = await ctx.db
        .query("messages")
        .withIndex("by_public_id", (q) => q.eq("publicId", parentPublicId))
        .unique();
      if (parent === null) throw new Error("Parent message not found");
      if (parent.groupId !== group._id) throw new Error("Parent message is in a different conversation");
      parentId = parent._id;
    }

    // Attachments must be confirmed (SAL contract step 3) before they can be recorded.
    const attachmentRows: Array<{ row: Doc<"attachments">; record: NonNullable<Doc<"messages">["attachments"]>[number] }> = [];
    for (const attachmentId of args.attachmentIds ?? []) {
      const row = await ctx.db
        .query("attachments")
        .withIndex("by_attachment_id", (q) => q.eq("attachmentId", attachmentId))
        .unique();
      if (row === null) throw new Error(`Attachment "${attachmentId}" not found`);
      if (row.status !== "confirmed") throw new Error(`Attachment "${attachmentId}" is not confirmed`);
      if (row.uploaderId !== user._id) throw new Error("You can only attach files you uploaded");
      if (row.groupId !== group._id) throw new Error("Attachment was uploaded for a different group");
      if (row.messageId !== undefined) throw new Error("Attachment has already been sent on a message");
      if (row.fileKey === undefined) throw new Error("Attachment is missing its final storage key");
      attachmentRows.push({
        row,
        record: {
          attachmentId: row.attachmentId,
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

    // `origin` is fixed to "app" for this first-party mutation; the mode is client-chosen but
    // server-validated here, and `flagType` only means anything on an action message.
    const mode = args.mode ?? "discussion";
    if (mode === "discussion" && args.flagType !== undefined) {
      throw new Error("A flag type is only valid on an action message");
    }
    const flagType = args.flagType ?? "task";

    const publicId = newPublicId("msg");
    const messageId = await ctx.db.insert("messages", {
      publicId,
      groupId: group._id,
      orgId: group.kind === "group" ? group.orgId : undefined,
      senderId: user._id,
      text,
      origin: "app", // server-set, never client-supplied
      mode,
      parentId,
      attachments: attachmentRows.length > 0 ? attachmentRows.map((a) => a.record) : undefined,
    });

    // Action mode: exactly one `actionInbox` row in the same mutation as the message insert.
    // `by_message` is an index, not a uniqueness constraint, so creation lives only here and
    // there is no second code path that could insert a duplicate task.
    let taskPublicId: string | null = null;
    if (mode === "action") {
      taskPublicId = newPublicId("task");
      await ctx.db.insert("actionInbox", {
        publicId: taskPublicId,
        messageId,
        groupId: group._id,
        groupPath: group.kind === "group" ? group.path : undefined,
        senderId: user._id,
        // Materialized at creation. This mutation already required an active account and sets
        // `origin: "app"`, so an app action message always starts senderMayClose = true.
        senderMayClose: true,
        flagType,
        status: "open",
      });
    }

    for (const attachment of attachmentRows) {
      await ctx.db.patch(attachment.row._id, { messageId });
    }

    const message = await ctx.db.get(messageId);
    if (message === null) throw new Error("Message insert failed");

    // Flow A3 sender exception: the sender's own pointer advances in the same mutation, so their
    // own messages never count as unread. This is the sender's own membership row — not a shared
    // group document.
    await ctx.db.patch(membership._id, {
      lastReadAt: message._creationTime,
      lastReadMessageId: messageId,
    });

    await noteMessageForActivity(ctx, group._id, message._creationTime);

    // Delivery rows only: the HTTP attempt is an action, so a slow or dead endpoint can never
    // delay or roll back this send. DMs have no org and therefore no webhook surface.
    if (group.kind === "group") {
      await enqueueWebhookEvent(ctx, group.orgId, "message.created", {
        messagePublicId: publicId,
        groupPublicId: group.publicId,
      });
    }

    return { messagePublicId: publicId, mode, taskPublicId };
  },
});

/** The bounded live page: the last 15 messages, reactive. */
export const listLive = query({
  args: { conversation: conversationAddressValidator },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);
    const { group } = await resolveConversationForRead(ctx, userId, args.conversation);
    const newest = await ctx.db
      .query("messages")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .order("desc")
      .take(LIVE_PAGE_SIZE);
    return await renderMessages(ctx, newest.reverse(), userId);
  },
});

/** Older history: a separate, cursor-paginated query the client calls on demand (not live). */
export const listHistory = query({
  args: {
    conversation: conversationAddressValidator,
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);
    const { group } = await resolveConversationForRead(ctx, userId, args.conversation);
    const limit = Math.min(Math.max(args.limit ?? 25, 1), 50);
    const page = await ctx.db
      .query("messages")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, numItems: limit });
    return {
      messages: await renderMessages(ctx, [...page.page].reverse(), userId),
      nextCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/** Thread replies for one parent message. */
export const listReplies = query({
  args: { parentPublicId: v.string() },
  handler: async (ctx, args) => {
    await requireNotShadow(ctx);
    const userId = await requireUserId(ctx);
    const parent = await ctx.db
      .query("messages")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.parentPublicId))
      .unique();
    if (parent === null) throw new Error("Message not found");
    const group = await ctx.db.get(parent.groupId);
    if (group === null) throw new Error("Conversation not found");
    if (group.kind === "group") {
      await requireGroupAccess(ctx, userId, group._id);
    } else if (!group.participantIds.includes(userId)) {
      throw new Error("You are not a participant in this direct message");
    }
    const replies = await ctx.db
      .query("messages")
      .withIndex("by_parent", (q) => q.eq("parentId", parent._id))
      .order("asc")
      .take(50);
    const rendered = await renderMessages(ctx, [parent, ...replies], userId);
    return { parent: rendered[0], replies: rendered.slice(1) };
  },
});

export const edit = mutation({
  args: { messagePublicId: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const message = await ctx.db
      .query("messages")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.messagePublicId))
      .unique();
    if (message === null) throw new Error("Message not found");
    if (message.senderId !== user._id) throw new Error("Only the sender can edit a message");
    if (message.deletedAt !== undefined) throw new Error("A deleted message cannot be edited");
    const text = args.text.trim();
    if (text === "") throw new Error("Message text cannot be empty");
    if (text.length > MAX_TEXT_LENGTH) {
      throw new Error(`Message text is limited to ${MAX_TEXT_LENGTH} characters`);
    }
    await assertNotClaimedAndEditable(ctx, message);
    const editedAt = Date.now();
    await ctx.db.patch(message._id, { text, editedAt });
    return { publicId: message.publicId, editedAt };
  },
});

/** Soft delete only (Part 3). v0 rule: the sender deletes their own message. */
export const softDelete = mutation({
  args: { messagePublicId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const message = await ctx.db
      .query("messages")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.messagePublicId))
      .unique();
    if (message === null) throw new Error("Message not found");
    if (message.senderId !== user._id) throw new Error("Only the sender can delete a message");
    if (message.mode === "action") {
      throw new Error("Action messages cannot be deleted; close or archive the task instead");
    }
    if (message.deletedAt !== undefined) return { deleted: false, alreadyDeleted: true };
    await ctx.db.patch(message._id, { deletedAt: Date.now() });
    return { deleted: true, alreadyDeleted: false };
  },
});
