// Cost instrumentation (Appendix A, "What to build").
//
//  * `usageRollups` is written by a DAILY scheduled aggregation, one row per org per UTC day.
//    There is no per-message counter and no hot per-group document.
//  * Projections use `lib/cost.ts`, calibrated to Appendix A’s $18/org lever-1 baseline.
//  * The 70% alert is driven by the projected total across active orgs, logged server-side and
//    surfaced in the admin UI. It is explicitly a MODEL alert, not a bill.

import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireActive, requireOrgMember } from "./lib/guards";
import {
  ALERT_THRESHOLD_USD,
  BUDGET_CEILING_USD,
  CostStatus,
  FIXED_MONTHLY_USD,
  bucketGroupSizes,
  costStatus,
  projectOrgFromBuckets,
  projectOrgMonthlyCost,
} from "./lib/cost";
import { liveOrgProjection } from "./cost";

const ALERT_KEY = "platform";
const PEAK_VIEWER_METHOD = "not_measured_no_presence_signal";

function dayRange(day: string): { start: number; end: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Invalid day "${day}" (expected YYYY-MM-DD)`);
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start)) throw new Error(`Invalid day "${day}"`);
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

export function utcDay(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export const listOrgIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const orgs = await ctx.db.query("organizations").collect();
    return orgs.map((org) => ({ orgId: org._id, orgPublicId: org.publicId }));
  },
});

/**
 * Aggregate one org for one UTC day. Scheduled only. Reads messages through `by_group` with a
 * `_creationTime` range, so no `by_org` index has to be added to `messages`.
 */
export const rollupOrg = internalMutation({
  args: { orgId: v.id("organizations"), day: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.orgId);
    if (org === null) throw new Error("Organisation not found");
    const { start, end } = dayRange(args.day);

    const groups = await ctx.db
      .query("groups")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();

    const sizes: number[] = [];
    const senders = new Set<Id<"users">>();
    let messagesSent = 0;

    for (const group of groups) {
      if (group.kind !== "group") continue;
      const memberships = await ctx.db
        .query("memberships")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .collect();
      sizes.push(memberships.length);

      const messages = await ctx.db
        .query("messages")
        .withIndex("by_group", (q) =>
          q.eq("groupId", group._id).gte("_creationTime", start).lt("_creationTime", end),
        )
        .collect();
      messagesSent += messages.length;
      for (const message of messages) senders.add(message.senderId);
    }

    const activeSenders = senders.size;
    const buckets = bucketGroupSizes(sizes);
    const measuredRate =
      activeSenders === 0 ? 0 : Number((messagesSent / activeSenders).toFixed(1));
    const messagesPerUserPerDay =
      measuredRate > 0 ? Math.min(60, Math.max(1, measuredRate)) : 0;
    const projection = projectOrgFromBuckets({
      activeUsers: activeSenders,
      buckets,
      messagesPerUserPerDay:
        messagesPerUserPerDay > 0 ? messagesPerUserPerDay : undefined,
    });
    const averageGroupSize =
      sizes.length === 0 ? 0 : sizes.reduce((sum, size) => sum + size, 0) / sizes.length;

    const row = {
      orgId: org._id,
      orgPublicId: org.publicId,
      day: args.day,
      messagesSent,
      activeSenders,
      groupCount: sizes.length,
      groupSizeBuckets: buckets,
      messagesPerUserPerDay,
      averageGroupSize: Number(averageGroupSize.toFixed(1)),
      projectedMonthlyCostUsd: projection.projectedMonthlyCostUsd,
      peakViewerMethod: PEAK_VIEWER_METHOD,
      createdAt: Date.now(),
    };

    const existing = await ctx.db
      .query("usageRollups")
      .withIndex("by_org_day", (q) => q.eq("orgId", org._id).eq("day", args.day))
      .unique();
    if (existing === null) {
      const id = await ctx.db.insert("usageRollups", row);
      return { ...row, id, updated: false };
    }
    await ctx.db.patch(existing._id, row);
    return { ...row, id: existing._id, updated: true };
  },
});

export const latestRollup = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("usageRollups")
      .withIndex("by_org_day", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .first();
  },
});

/**
 * Sum the latest projection for every org and persist the alert state. Logs once per day (or on a
 * level change) with `console.warn`; there is no email-provider dependency.
 */
export const evaluateAlert = internalMutation({
  args: { day: v.string() },
  handler: async (ctx, args) => {
    const orgs = await ctx.db.query("organizations").collect();
    const costs: number[] = [];
    let measuredOrgs = 0;
    for (const org of orgs) {
      const latest = await ctx.db
        .query("usageRollups")
        .withIndex("by_org_day", (q) => q.eq("orgId", org._id))
        .order("desc")
        .first();
      if (latest === null) {
        const live = await liveOrgProjection(ctx, org);
        costs.push(live.projection.projectedMonthlyCostUsd);
      } else {
        costs.push(latest.projectedMonthlyCostUsd);
        measuredOrgs++;
      }
    }
    const status = costStatus(costs);
    const previous = await ctx.db
      .query("costAlertState")
      .withIndex("by_key", (q) => q.eq("key", ALERT_KEY))
      .unique();
    const now = Date.now();
    const shouldLog =
      status.level !== "ok" &&
      (previous === null || previous.day !== args.day || previous.level !== status.level);

    const row = {
      key: ALERT_KEY,
      day: args.day,
      projectedTotalUsd: status.projectedTotalUsd,
      percentOfCeiling: status.percentOfCeiling,
      level: status.level,
      activeOrgCount: orgs.length,
      lastLoggedAt: shouldLog ? now : (previous?.lastLoggedAt ?? now),
    };
    if (previous === null) await ctx.db.insert("costAlertState", row);
    else await ctx.db.patch(previous._id, row);

    if (shouldLog) {
      console.warn(
        `[cost] MODEL ALERT (not a bill): projected total $${status.projectedTotalUsd.toFixed(2)}/month ` +
          `is ${status.percentOfCeiling.toFixed(1)}% of the $${status.ceilingUsd.toFixed(0)} ceiling across ` +
          `${orgs.length} orgs (${measuredOrgs} measured, ${orgs.length - measuredOrgs} live-projected).`,
      );
    }
    return { ...status, activeOrgCount: orgs.length, measuredOrgs, logged: shouldLog };
  },
});

/** Daily entry point. One mutation per org keeps each transaction small. */
export const runDailyRollup = internalAction({
  args: { day: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const day = args.day ?? utcDay(-1);
    const orgs = await ctx.runQuery(internal.usage.listOrgIds, {});
    let written = 0;
    for (const entry of orgs) {
      await ctx.runMutation(internal.usage.rollupOrg, { orgId: entry.orgId, day });
      written++;
    }
    const alert = await ctx.runMutation(internal.usage.evaluateAlert, { day });
    return { day, orgs: written, alert };
  },
});

/** Manual re-run for the pilot runbook. Admin CLI only (internal action). */
export const rollupAllNow = internalAction({
  args: { day: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    return await ctx.runAction(internal.usage.runDailyRollup, args);
  },
});

function statusFromState(state: Doc<"costAlertState"> | null): CostStatus {
  if (state === null) return costStatus([]);
  return {
    projectedTotalUsd: state.projectedTotalUsd,
    fixedMonthlyUsd: FIXED_MONTHLY_USD,
    ceilingUsd: BUDGET_CEILING_USD,
    alertThresholdUsd: ALERT_THRESHOLD_USD,
    percentOfCeiling: state.percentOfCeiling,
    level: state.level,
    isEstimate: true,
  };
}

/**
 * Platform-wide alert without cross-tenant detail. Any active user may see the alert level; only
 * the aggregate is returned, never another org’s rows or cost.
 */
export const platformStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireActive(ctx);
    const state = await ctx.db
      .query("costAlertState")
      .withIndex("by_key", (q) => q.eq("key", ALERT_KEY))
      .unique();
    return {
      ...statusFromState(state),
      day: state?.day ?? null,
      activeOrgCount: state?.activeOrgCount ?? 0,
      label: "Model alert — an estimate, not a bill.",
    };
  },
});

/** The admin tile for one org. Returns 14 days of measured rollups plus a current projection. */
export const orgDashboard = query({
  args: { orgPublicId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);

    const rollups = await ctx.db
      .query("usageRollups")
      .withIndex("by_org_day", (q) => q.eq("orgId", org._id))
      .order("desc")
      .take(14);
    const latest = rollups[0] ?? null;
    const fallback = await liveOrgProjection(ctx, org);
    const projection =
      latest === null
        ? fallback.projection
        : projectOrgFromBuckets({
            activeUsers: latest.activeSenders,
            buckets: latest.groupSizeBuckets,
            messagesPerUserPerDay:
              latest.messagesPerUserPerDay > 0 ? latest.messagesPerUserPerDay : undefined,
          });
    const state = await ctx.db
      .query("costAlertState")
      .withIndex("by_key", (q) => q.eq("key", ALERT_KEY))
      .unique();

    return {
      orgPublicId: org.publicId,
      orgName: org.name,
      isEstimate: true as const,
      projection,
      latest,
      days: rollups.map((row) => ({
        day: row.day,
        messagesSent: row.messagesSent,
        activeSenders: row.activeSenders,
        groupCount: row.groupCount,
        groupSizeBuckets: row.groupSizeBuckets,
        averageGroupSize: row.averageGroupSize,
        projectedMonthlyCostUsd: row.projectedMonthlyCostUsd,
        peakViewerMethod: row.peakViewerMethod,
      })),
      alert: {
        ...statusFromState(state),
        day: state?.day ?? null,
        label: "Model alert — an estimate, not a bill.",
      },
    };
  },
});
