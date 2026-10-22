// Appendix A cost model (O7). Pure functions only: no Convex imports, no database access.
//
// What this is: a projection calibrated to the PRD's Appendix A baseline. It is deliberately an
// estimate, not a bill. The ratios are the reliable part.
//
// Calibration (Appendix A, "Where the ceiling actually binds"):
//   lever 1 only, 400 active users, 15 sent/user/day, 15% of a group's members viewing at once,
//   40 outlet groups x 10 (70% of volume), 8 region groups x 40 (20%), one org-wide group x 400
//   (10%) => $18 per org per month.
//
//   weighted viewers per message = 0.7*10*0.15 + 0.2*40*0.15 + 0.1*400*0.15 = 8.25
//   messages per month          = 400 * 15 * 30 = 180,000
//   USD per viewer-message      = 18 / (180,000 * 8.25)
//
// The model keeps Appendix A's volume-share shape because it is what makes large groups expensive:
// most messages land in small groups, while the org-wide group carries a minority of traffic but a
// large share of re-runs. It is superlinear in group size by construction.

export const BUDGET_CEILING_USD = 1_000;
export const FIXED_MONTHLY_USD = 100; // seats, hosting, email; Appendix A assumption
export const ALERT_FRACTION = 0.7;
export const ALERT_THRESHOLD_USD = BUDGET_CEILING_USD * ALERT_FRACTION;
export const DAYS_PER_MONTH = 30;
export const DEFAULT_MESSAGES_PER_USER_DAY = 15;
export const DEFAULT_VIEWER_RATE = 0.15;

export const BASELINE_DAU = 400;
export const BASELINE_COST_USD = 18;
export const BASELINE_AVG_VIEWERS = 8.25;
export const USD_PER_VIEWER_MESSAGE =
  BASELINE_COST_USD / (BASELINE_DAU * DEFAULT_MESSAGES_PER_USER_DAY * DAYS_PER_MONTH * BASELINE_AVG_VIEWERS);

// Volume shares by tier, from Appendix A: outlet 70%, region 20%, org-wide 10%.
const TIER_VOLUME_SHARE = { small: 0.7, mid: 0.2, large: 0.1 } as const;
const SMALL_MAX = 15;
const MID_MAX = 80;

export type GroupSizeBuckets = {
  le10: number;
  le50: number;
  le200: number;
  le1000: number;
  gt1000: number;
};

export type CostProjection = {
  activeUsers: number;
  messagesPerUserPerDay: number;
  viewerRate: number;
  averageGroupSize: number;
  averageViewersPerMessage: number;
  messagesPerMonth: number;
  projectedMonthlyCostUsd: number;
};

export type CostStatus = {
  projectedTotalUsd: number;
  fixedMonthlyUsd: number;
  ceilingUsd: number;
  alertThresholdUsd: number;
  percentOfCeiling: number;
  level: "ok" | "warning" | "over";
  isEstimate: true;
};

export function emptyGroupSizeBuckets(): GroupSizeBuckets {
  return { le10: 0, le50: 0, le200: 0, le1000: 0, gt1000: 0 };
}

export function bucketGroupSizes(sizes: number[]): GroupSizeBuckets {
  const buckets = emptyGroupSizeBuckets();
  for (const raw of sizes) {
    const size = Math.max(0, Math.floor(raw));
    if (size <= 10) buckets.le10++;
    else if (size <= 50) buckets.le50++;
    else if (size <= 200) buckets.le200++;
    else if (size <= 1000) buckets.le1000++;
    else buckets.gt1000++;
  }
  return buckets;
}

/** Representative sizes for bucket-only inputs (daily rollups store counts, not per-group rows). */
export function sizesFromBuckets(buckets: GroupSizeBuckets): number[] {
  const sizes: number[] = [];
  const push = (count: number, size: number) => {
    for (let index = 0; index < count; index++) sizes.push(size);
  };
  push(buckets.le10, 7);
  push(buckets.le50, 30);
  push(buckets.le200, 125);
  push(buckets.le1000, 600);
  push(buckets.gt1000, 2_000);
  return sizes;
}

/** Appendix A's baseline mix, used when an org has not been measured yet. */
export function baselineGroupSizes(): number[] {
  return [
    ...Array.from({ length: 40 }, () => 10),
    ...Array.from({ length: 8 }, () => 40),
    400,
  ];
}

function tierOf(size: number): "small" | "mid" | "large" {
  if (size <= SMALL_MAX) return "small";
  if (size <= MID_MAX) return "mid";
  return "large";
}

export function averageViewersPerMessage(
  groupSizes: number[],
  viewerRate = DEFAULT_VIEWER_RATE,
): number {
  if (groupSizes.length === 0) return 0;
  const groups: Record<"small" | "mid" | "large", number[]> = {
    small: [],
    mid: [],
    large: [],
  };
  for (const size of groupSizes) {
    if (Number.isFinite(size) && size > 0) groups[tierOf(size)].push(size);
  }
  const present = (Object.keys(groups) as Array<keyof typeof groups>).filter(
    (tier) => groups[tier].length > 0,
  );
  if (present.length === 0) return 0;
  // Renormalise across the tiers that exist, so a small-only org is not charged for an org-wide
  // group it does not have.
  const totalWeight = present.reduce((sum, tier) => sum + TIER_VOLUME_SHARE[tier], 0);
  let viewers = 0;
  for (const tier of present) {
    const list = groups[tier];
    const averageSize = list.reduce((sum, size) => sum + size, 0) / list.length;
    viewers += (TIER_VOLUME_SHARE[tier] / totalWeight) * averageSize * viewerRate;
  }
  return viewers;
}

export function projectOrgMonthlyCost(input: {
  activeUsers: number;
  groupSizes: number[];
  messagesPerUserPerDay?: number;
  viewerRate?: number;
}): CostProjection {
  const activeUsers = Math.max(0, Number(input.activeUsers) || 0);
  const messagesPerUserPerDay = Math.min(
    60,
    Math.max(1, Number(input.messagesPerUserPerDay) || DEFAULT_MESSAGES_PER_USER_DAY),
  );
  const viewerRate = Math.min(1, Math.max(0, input.viewerRate ?? DEFAULT_VIEWER_RATE));
  const sizes = input.groupSizes.filter((size) => Number.isFinite(size) && size > 0);
  const averageGroupSize =
    sizes.length === 0 ? 0 : sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
  const avgViewers = averageViewersPerMessage(sizes, viewerRate);
  const messagesPerMonth = activeUsers * messagesPerUserPerDay * DAYS_PER_MONTH;
  const projected = messagesPerMonth * avgViewers * USD_PER_VIEWER_MESSAGE;
  return {
    activeUsers,
    messagesPerUserPerDay,
    viewerRate,
    averageGroupSize: Number(averageGroupSize.toFixed(1)),
    averageViewersPerMessage: Number(avgViewers.toFixed(2)),
    messagesPerMonth: Math.round(messagesPerMonth),
    projectedMonthlyCostUsd: Number(projected.toFixed(2)),
  };
}

export function projectOrgFromBuckets(input: {
  activeUsers: number;
  buckets: GroupSizeBuckets;
  messagesPerUserPerDay?: number;
}): CostProjection {
  return projectOrgMonthlyCost({
    activeUsers: input.activeUsers,
    groupSizes: sizesFromBuckets(input.buckets),
    messagesPerUserPerDay: input.messagesPerUserPerDay,
  });
}

export function projectTotalMonthlyCost(orgCostsUsd: number[]): number {
  const usage = orgCostsUsd.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  return Number((FIXED_MONTHLY_USD + usage).toFixed(2));
}

export function costStatus(orgCostsUsd: number[]): CostStatus {
  const projectedTotalUsd = projectTotalMonthlyCost(orgCostsUsd);
  const percentOfCeiling = (projectedTotalUsd / BUDGET_CEILING_USD) * 100;
  return {
    projectedTotalUsd,
    fixedMonthlyUsd: FIXED_MONTHLY_USD,
    ceilingUsd: BUDGET_CEILING_USD,
    alertThresholdUsd: ALERT_THRESHOLD_USD,
    percentOfCeiling: Number(percentOfCeiling.toFixed(1)),
    level:
      projectedTotalUsd >= BUDGET_CEILING_USD
        ? "over"
        : projectedTotalUsd >= ALERT_THRESHOLD_USD
          ? "warning"
          : "ok",
    isEstimate: true,
  };
}
