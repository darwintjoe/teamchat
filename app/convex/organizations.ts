// Organisations (v0 build item 2). `serviceUserId` stays optional and unset in v0.

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { newPublicId } from "./lib/ids";
import { requireActive, requireOrgMember } from "./lib/guards";
import { baselineGroupSizes } from "./lib/cost";
import { assertAdmissionAffordable } from "./cost";

/**
 * Create an organisation and its root group. The creator becomes org owner and root-group owner.
 * The root group's path is a single segment: "/<orgPublicId>" (Flow C: the org segment is the
 * root group's segment; child groups append their own).
 *
 * Onboarding cost gate (Appendix A): the caller supplies the expected active users and group sizes.
 * Admission is refused when fixed costs + admitted orgs + this candidate cross the $1,000 ceiling.
 * The org count is deliberately not the gate. Set TEAMCHAT_COST_GATE_DISABLED=true only on demo
 * deployments where the gate would be measuring test data.
 */
export const create = mutation({
  args: {
    name: v.string(),
    allowDirectMessages: v.boolean(),
    projectedActiveUsers: v.optional(v.number()),
    projectedGroupSizes: v.optional(v.array(v.number())),
  },
  handler: async (ctx, args) => {
    const user = await requireActive(ctx);
    const name = args.name.trim();
    if (name === "") throw new Error("Organisation name is required");

    const gateDisabled =
      (process.env.TEAMCHAT_COST_GATE_DISABLED ?? "").trim().toLowerCase() === "true";
    let admission: { candidateCostUsd: number; projectedTotalUsd: number } | null = null;
    if (!gateDisabled) {
      admission = await assertAdmissionAffordable(ctx, {
        name,
        activeUsers:
          args.projectedActiveUsers !== undefined && Number.isFinite(args.projectedActiveUsers)
            ? Math.max(1, Math.floor(args.projectedActiveUsers))
            : 400,
        groupSizes:
          args.projectedGroupSizes !== undefined && args.projectedGroupSizes.length > 0
            ? args.projectedGroupSizes
            : baselineGroupSizes(),
      });
    }

    const publicId = newPublicId("org");
    const orgId = await ctx.db.insert("organizations", {
      publicId,
      name,
      allowDirectMessages: args.allowDirectMessages,
      // serviceUserId left unset: no ERP bot exists in v0.
    });

    const rootGroupPublicId = newPublicId("grp");
    const rootGroupId = await ctx.db.insert("groups", {
      kind: "group",
      publicId: rootGroupPublicId,
      name: `${name} (org root)`,
      orgId,
      path: `/${publicId}`,
    });
    await ctx.db.patch(orgId, { rootGroupId });

    const now = Date.now();
    await ctx.db.insert("orgMembers", {
      orgId,
      userId: user._id,
      orgRole: "owner",
      joinedAt: now,
      uniqueKey: `${orgId}:${user._id}`,
    });
    await ctx.db.insert("memberships", {
      groupId: rootGroupId,
      userId: user._id,
      role: "owner",
      groupPath: `/${publicId}`,
      joinedAt: now,
      uniqueKey: `${rootGroupId}:${user._id}`,
    });
    await ctx.db.insert("groupActivity", {
      groupId: rootGroupId,
      lastMessageAt: 0,
      flushPending: false,
    });

    return { orgPublicId: publicId, rootGroupPublicId, name, admission };
  },
});

/** The orgs the caller belongs to (for the client's org switcher / first screen). */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireActive(ctx);
    const rows = await ctx.db
      .query("orgMembers")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const orgs: Array<{
      publicId: string;
      name: string;
      myOrgRole: "owner" | "admin" | "member";
      allowDirectMessages: boolean;
      rootGroupPublicId: string | null;
    }> = [];
    for (const row of rows) {
      const org = await ctx.db.get(row.orgId);
      if (org === null) continue;
      const root =
        org.rootGroupId !== undefined ? await ctx.db.get(org.rootGroupId) : null;
      orgs.push({
        publicId: org.publicId,
        name: org.name,
        myOrgRole: row.orgRole,
        allowDirectMessages: org.allowDirectMessages,
        rootGroupPublicId: root !== null && root.kind === "group" ? root.publicId : null,
      });
    }
    return orgs;
  },
});

/** Org profile, visible to its members. */
export const get = query({
  args: { orgPublicId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    const { orgMember } = await requireOrgMember(ctx, org._id);
    const rootGroup =
      org.rootGroupId !== undefined ? await ctx.db.get(org.rootGroupId) : null;
    return {
      publicId: org.publicId,
      name: org.name,
      allowDirectMessages: org.allowDirectMessages,
      rootGroupPublicId: rootGroup !== null && rootGroup.kind === "group" ? rootGroup.publicId : null,
      myOrgRole: orgMember.orgRole,
    };
  },
});

/** Owner/admin: rename or flip the org DM policy. */
export const update = mutation({
  args: {
    orgPublicId: v.string(),
    name: v.optional(v.string()),
    allowDirectMessages: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);
    const patch: { name?: string; allowDirectMessages?: boolean } = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (name === "") throw new Error("Organisation name is required");
      patch.name = name;
    }
    if (args.allowDirectMessages !== undefined) patch.allowDirectMessages = args.allowDirectMessages;
    if (Object.keys(patch).length > 0) await ctx.db.patch(org._id, patch);
    return { updated: true };
  },
});
