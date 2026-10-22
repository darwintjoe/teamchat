// Shared server context for widget-only functions. Shadow identity is derived from the
// `externalIdentities` row, never from email, and always resolves exactly one host app.

import type { QueryCtx, MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { supportGroupForHostApp, widgetUploadSettings } from "../hostApps";

export type DbCtx = QueryCtx | MutationCtx;

export type ShadowContext = {
  userId: Id<"users">;
  userPublicId: string;
  name: string;
  email: string | null;
  hostApp: {
    id: Id<"hostApps">;
    publicId: string;
    name: string;
    orgId: Id<"organizations">;
    supportGroupId: Id<"groups">;
    primaryColor: string;
    logoUrl: string | null;
  };
  supportGroup: { id: Id<"groups">; publicId: string; path: string };
  org: { id: Id<"organizations">; publicId: string };
  uploads: ReturnType<typeof widgetUploadSettings>;
};

export async function loadShadowContext(
  ctx: DbCtx,
  userId: Id<"users">,
): Promise<ShadowContext> {
  const user = await ctx.db.get(userId);
  if (user === null) throw new Error("User not found");
  if (user.accountState !== "shadow") {
    throw new Error("This operation is only available to a widget (shadow) account");
  }
  const identities = await ctx.db
    .query("externalIdentities")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .collect();
  if (identities.length !== 1) {
    throw new Error("Shadow account is not bound to exactly one host app");
  }
  const hostApp = await ctx.db.get(identities[0].hostAppId);
  if (hostApp === null || !hostApp.isActive) throw new Error("Host app is not active");
  const { group, org } = await supportGroupForHostApp(ctx, hostApp);
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_unique", (q) => q.eq("uniqueKey", `${group._id}:${user._id}`))
    .unique();
  if (membership === null) throw new Error("Shadow account is not in its support group");

  // Confinement is re-checked on every widget call, not assumed from creation.
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user_path", (q) => q.eq("userId", user._id))
    .collect();
  for (const row of memberships) {
    if (row.groupId !== group._id) throw new Error("Shadow identity escaped its support group");
  }

  return {
    userId: user._id,
    userPublicId: user.publicId,
    name: user.name ?? "Widget customer",
    email: user.email ?? null,
    hostApp: {
      id: hostApp._id,
      publicId: hostApp.publicId,
      name: hostApp.name,
      orgId: hostApp.orgId,
      supportGroupId: hostApp.supportGroupId,
      primaryColor: hostApp.primaryColor ?? "#2563eb",
      logoUrl: hostApp.logoUrl ?? null,
    },
    supportGroup: { id: group._id, publicId: group.publicId, path: group.path },
    org: { id: org._id, publicId: org.publicId },
    uploads: widgetUploadSettings(hostApp),
  };
}

export type WidgetTaskStatus = "open" | "claimed" | "done" | "closed" | "archived";

/**
 * "Same conversation": a task by this shadow user in this host app's support group whose status
 * is not closed and not archived. Lookup is by `by_sender` + status only.
 */
export async function openTicketFor(
  ctx: DbCtx,
  shadow: ShadowContext,
): Promise<Doc<"actionInbox"> | null> {
  const statuses: WidgetTaskStatus[] = ["open", "claimed", "done"];
  let newest: Doc<"actionInbox"> | null = null;
  for (const status of statuses) {
    const rows = await ctx.db
      .query("actionInbox")
      .withIndex("by_sender", (q) => q.eq("senderId", shadow.userId).eq("status", status))
      .take(10);
    for (const row of rows) {
      if (row.groupId !== shadow.supportGroup.id) continue;
      if (newest === null || row._creationTime > newest._creationTime) newest = row;
    }
  }
  return newest;
}

/** All tasks this shadow raised in its support group, newest last. Used for conversation history. */
export async function allTicketsFor(
  ctx: DbCtx,
  shadow: ShadowContext,
): Promise<Array<Doc<"actionInbox">>> {
  const statuses: WidgetTaskStatus[] = ["open", "claimed", "done", "closed", "archived"];
  const out: Array<Doc<"actionInbox">> = [];
  for (const status of statuses) {
    const rows = await ctx.db
      .query("actionInbox")
      .withIndex("by_sender", (q) => q.eq("senderId", shadow.userId).eq("status", status))
      .take(50);
    for (const row of rows) {
      if (row.groupId === shadow.supportGroup.id) out.push(row);
    }
  }
  return out.sort((a, b) => a._creationTime - b._creationTime);
}

/** True when a message belongs to this shadow's own ticket thread (root or a reply under it). */
export async function messageVisibleToShadow(
  ctx: DbCtx,
  message: Doc<"messages">,
  shadow: ShadowContext,
): Promise<boolean> {
  if (message.groupId !== shadow.supportGroup.id) return false;
  if (message.senderId === shadow.userId) return true;
  if (message.parentId === undefined) return false;
  const parent = await ctx.db.get(message.parentId);
  return parent !== null && parent.senderId === shadow.userId;
}
