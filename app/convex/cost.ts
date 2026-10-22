// Server-side cost projections shared by the onboarding gate, the daily rollup and the admin tile.
// Pure arithmetic lives in `lib/cost.ts`; this file only gathers the live inputs.

import type { MutationCtx, QueryCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import {
  CostProjection,
  CostStatus,
  DEFAULT_MESSAGES_PER_USER_DAY,
  costStatus,
  projectOrgMonthlyCost,
} from "./lib/cost";

type DbCtx = QueryCtx | MutationCtx;

export type OrgProjection = {
  orgPublicId: string;
  orgName: string;
  activeUsers: number;
  groupCount: number;
  groupSizes: number[];
  messagesPerUserPerDay: number;
  projection: CostProjection;
};

async function groupSizesForOrg(
  ctx: DbCtx,
  org: Doc<"organizations">,
): Promise<{ sizes: number[]; groupCount: number }> {
  const groups = await ctx.db
    .query("groups")
    .withIndex("by_org", (q) => q.eq("orgId", org._id))
    .collect();
  const sizes: number[] = [];
  for (const group of groups) {
    if (group.kind !== "group") continue;
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_group", (q) => q.eq("groupId", group._id))
      .collect();
    sizes.push(memberships.length);
  }
  return { sizes, groupCount: sizes.length };
}

/** Live projection for one org. Used where no daily rollup exists yet (onboarding, first day). */
export async function liveOrgProjection(
  ctx: DbCtx,
  org: Doc<"organizations">,
): Promise<OrgProjection> {
  const { sizes, groupCount } = await groupSizesForOrg(ctx, org);
  const members = await ctx.db
    .query("orgMembers")
    .withIndex("by_org", (q) => q.eq("orgId", org._id))
    .collect();
  const latest = await ctx.db
    .query("usageRollups")
    .withIndex("by_org_day", (q) => q.eq("orgId", org._id))
    .order("desc")
    .first();
  const messagesPerUserPerDay =
    latest !== null && latest.messagesPerUserPerDay > 0
      ? latest.messagesPerUserPerDay
      : DEFAULT_MESSAGES_PER_USER_DAY;
  const projection = projectOrgMonthlyCost({
    activeUsers: members.length,
    groupSizes: sizes,
    messagesPerUserPerDay,
  });
  return {
    orgPublicId: org.publicId,
    orgName: org.name,
    activeUsers: members.length,
    groupCount,
    groupSizes: sizes,
    messagesPerUserPerDay,
    projection,
  };
}

export async function livePlatformCosts(
  ctx: DbCtx,
  options: { excludeOrgPublicId?: string } = {},
): Promise<{ projections: OrgProjection[]; status: CostStatus }> {
  const orgs = await ctx.db.query("organizations").collect();
  const projections: OrgProjection[] = [];
  for (const org of orgs) {
    if (options.excludeOrgPublicId !== undefined && org.publicId === options.excludeOrgPublicId) {
      continue;
    }
    projections.push(await liveOrgProjection(ctx, org));
  }
  return {
    projections,
    status: costStatus(projections.map((entry) => entry.projection.projectedMonthlyCostUsd)),
  };
}

/**
 * Onboarding gate. Projects the candidate from its expected active users and group sizes, then
 * refuses admission if fixed costs plus every admitted org plus the candidate cross the ceiling.
 */
export async function assertAdmissionAffordable(
  ctx: DbCtx,
  candidate: { name: string; activeUsers: number; groupSizes: number[] },
): Promise<{
  candidateCostUsd: number;
  projectedTotalUsd: number;
  ceilingUsd: number;
}> {
  const existing = await livePlatformCosts(ctx);
  const candidateProjection = projectOrgMonthlyCost({
    activeUsers: candidate.activeUsers,
    groupSizes: candidate.groupSizes,
  });
  const projectedTotalUsd = Number(
    (
      existing.status.projectedTotalUsd + candidateProjection.projectedMonthlyCostUsd
    ).toFixed(2),
  );
  if (projectedTotalUsd > existing.status.ceilingUsd) {
    throw new Error(
      `[cost gate] Admitting "${candidate.name}" would project $${projectedTotalUsd.toFixed(2)}/month, ` +
        `above the $${existing.status.ceilingUsd.toFixed(0)} ceiling. Reduce active users or group sizes, ` +
        `or route the org to Enterprise. This is a model estimate, not a bill.`,
    );
  }
  return {
    candidateCostUsd: candidateProjection.projectedMonthlyCostUsd,
    projectedTotalUsd,
    ceilingUsd: existing.status.ceilingUsd,
  };
}
