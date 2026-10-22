// Cost model, onboarding gate and alert-path proof.
//
//   node scripts/verify-cost-model.mjs
//
// Runs against teamchat-prod. It uses the internal pure-model probes for the arithmetic, then
// exercises the real `organizations.create` gate and the real `usage.rollupOrg` path with one
// throwaway tenant. The tenant is purged at the end.
//
// Proves:
//   * Appendix A's lever-1 baseline projects $18/org/month;
//   * the 70% alert threshold is crossed by the aggregate projection, not by org count;
//   * onboarding refuses a candidate that would cross the $1,000 ceiling and admits a small one;
//   * a measured daily rollup writes one row per org/day with the required fields and no
//     per-message counter or hot per-group document;
//   * the admin tile and platform status both label the number an estimate.
//
// Writes evidence/verify-cost-model.txt.

import { ConvexHttpClient } from "convex/browser";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "../convex/_generated/api.js";
import { loadPrivateKey, mintSessionToken, runInternal } from "./lib/prod-session.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const CLOUD = (process.env.PROD_CLOUD_URL ?? "https://benevolent-crocodile-386.convex.cloud").replace(/\/+$/, "");
const SITE = (process.env.PROD_SITE_URL ?? CLOUD.replace(".convex.cloud", ".convex.site")).replace(/\/+$/, "");

const lines = [];
const log = (line = "") => {
  lines.push(line);
  console.log(line);
};

let passed = 0;
let failed = 0;
const failures = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    passed++;
    log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failed++;
    failures.push(`${name}: ${error.message}`);
    log(`FAIL  ${name} — ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? "assertion failed");
}

function isRedacted(error) {
  return /server error/i.test(`${error?.message ?? error}`) && /request id/i.test(`${error?.message ?? error}`);
}

async function expectError(fn, matcher) {
  let caught = null;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  if (caught === null) throw new Error("expected an error, but the call succeeded");
  const text = `${caught.message} ${JSON.stringify(caught.data ?? "")}`.toLowerCase();
  if (matcher !== undefined && !text.includes(matcher.toLowerCase()) && !isRedacted(caught)) {
    throw new Error(`expected ${JSON.stringify(matcher)}, got: ${caught.message}`);
  }
  return caught;
}

function baselineGroupSizes() {
  return [...Array.from({ length: 40 }, () => 10), ...Array.from({ length: 8 }, () => 40), 400];
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const email = `cost-model+${runId}@pilot.teamchat.test`;
let createdOrg = null;

log(`cloud: ${CLOUD}`);
log(`run:   ${runId}`);
log("");

try {
  const privateKey = loadPrivateKey();
  const seeded = runInternal("seedTestUsers", { emails: [email] });
  const user = seeded[0];
  const session = runInternal("createTestSession", { userPublicId: user.userPublicId });
  const token = await mintSessionToken({
    privateKey,
    userId: session.userId,
    sessionId: session.sessionId,
    siteUrl: SITE,
  });
  const client = new ConvexHttpClient(CLOUD);
  client.setAuth(token);

  await check("Appendix A lever-1 baseline projects $18/org/month", async () => {
    const probe = runInternal("costModelProbe", {
      activeUsers: 400,
      groupSizes: baselineGroupSizes(),
    });
    const cost = probe.projection.projectedMonthlyCostUsd;
    assert(Math.abs(cost - 18) < 0.01, `projected $${cost}`);
    assert(probe.projection.averageViewersPerMessage === 8.25, `viewers ${probe.projection.averageViewersPerMessage}`);
    return `$${cost.toFixed(2)}/org · ${probe.projection.messagesPerMonth} messages/month`;
  });

  await check("the 70% alert is driven by projected spend, not org count", async () => {
    const at33 = runInternal("costAggregateProbe", { orgCostsUsd: Array.from({ length: 33 }, () => 18) });
    const at34 = runInternal("costAggregateProbe", { orgCostsUsd: Array.from({ length: 34 }, () => 18) });
    const at50 = runInternal("costAggregateProbe", { orgCostsUsd: Array.from({ length: 50 }, () => 18) });
    assert(at33.level === "ok" && at33.percentOfCeiling < 70, `33 orgs: ${at33.level} ${at33.percentOfCeiling}%`);
    assert(at34.level === "warning" && at34.percentOfCeiling >= 70, `34 orgs: ${at34.level} ${at34.percentOfCeiling}%`);
    assert(at50.level === "over", `50 orgs: ${at50.level}`);
    assert(at34.projectedTotalUsd === 712, `34-org total ${at34.projectedTotalUsd}`);
    return `33 = ${at33.percentOfCeiling}% ok · 34 = ${at34.percentOfCeiling}% warning · 50 = over`;
  });

  await check("onboarding refuses a candidate that would cross the $1,000 ceiling", async () => {
    await expectError(
      () =>
        client.mutation(api.organizations.create, {
          name: `Too large ${runId}`,
          allowDirectMessages: false,
          projectedActiveUsers: 1000,
          projectedGroupSizes: [5000],
        }),
      "cost gate",
    );
    const mine = await client.query(api.organizations.listMine, {});
    assert(!mine.some((row) => row.name === `Too large ${runId}`), "refused org was created");
    return "1000 users / 5000-member group refused";
  });

  await check("onboarding admits a small candidate and returns its projection", async () => {
    createdOrg = await client.mutation(api.organizations.create, {
      name: `Cost model ${runId}`,
      allowDirectMessages: false,
      projectedActiveUsers: 2,
      projectedGroupSizes: [2],
    });
    assert(createdOrg.admission !== null, "gate was skipped");
    assert(createdOrg.admission.projectedTotalUsd <= 1000, "admitted above the ceiling");
    return `$${createdOrg.admission.candidateCostUsd}/month candidate · total $${createdOrg.admission.projectedTotalUsd}`;
  });

  await check("a measured daily rollup writes one org/day row with cost fields", async () => {
    assert(createdOrg !== null, "no org to measure");
    const sent = await client.mutation(api.messages.send, {
      conversation: { kind: "group", publicId: createdOrg.rootGroupPublicId },
      text: `cost rollup message ${runId}`,
    });
    assert(typeof sent.messagePublicId === "string", "message send failed");
    const day = utcDay();
    const row = runInternal("rollupTenantForTest", { orgPublicId: createdOrg.orgPublicId, day });
    assert(row.day === day, `day ${row.day}`);
    assert(row.messagesSent >= 1, `messagesSent ${row.messagesSent}`);
    assert(row.activeSenders >= 1, `activeSenders ${row.activeSenders}`);
    assert(row.groupCount >= 1, `groupCount ${row.groupCount}`);
    assert(typeof row.groupSizeBuckets === "object", "no size distribution");
    assert(row.peakViewerMethod === "not_measured_no_presence_signal", `method ${row.peakViewerMethod}`);
    assert(Number.isFinite(row.projectedMonthlyCostUsd), `projected ${row.projectedMonthlyCostUsd}`);
    assert(row.projectedMonthlyCostUsd >= 0, `projected ${row.projectedMonthlyCostUsd}`);
    return `${day} · ${row.messagesSent} message(s) · ${row.activeSenders} sender(s) · $${row.projectedMonthlyCostUsd}/month (tiny test org)`;
  });

  await check("the platform alert and admin tile label the projection an estimate", async () => {
    const day = utcDay();
    const evaluated = runInternal("evaluateCostAlertForTest", { day });
    assert(evaluated.level === "ok", `level ${evaluated.level}`);
    const status = await client.query(api.usage.platformStatus, {});
    assert(status.label === "Model alert — an estimate, not a bill.", `label ${status.label}`);
    assert(status.isEstimate === true, "platform status is not flagged as an estimate");
    const tile = await client.query(api.usage.orgDashboard, {
      orgPublicId: createdOrg.orgPublicId,
    });
    assert(tile.isEstimate === true, "admin tile is not flagged as an estimate");
    assert(tile.latest !== null, "no measured row in the admin tile");
    assert(tile.days.length >= 1, "admin tile has no day rows");
    assert(tile.alert.label.includes("not a bill"), `alert label ${tile.alert.label}`);
    return `platform $${status.projectedTotalUsd} (${status.percentOfCeiling}%) · tile ${tile.days.length} day(s)`;
  });

  await check("there is no per-message counter and no hot per-group cost document", async () => {
    const schema = readFileSync(join(appDir, "convex", "schema.ts"), "utf8");
    const usage = readFileSync(join(appDir, "convex", "usage.ts"), "utf8");
    const crons = readFileSync(join(appDir, "convex", "crons.ts"), "utf8");
    assert(!/defineTable\(\{[^}]*\bmessageCount\b/s.test(schema), "schema has a message counter");
    assert(!/usageRollups[\s\S]{0,400}_creationTime/.test(schema), "rollup looks per-message");
    assert(usage.includes('peakViewerMethod: PEAK_VIEWER_METHOD'), "rollup omits the peak-viewer method");
    assert(usage.includes("console.warn") && usage.includes("MODEL ALERT (not a bill)"), "alert does not log");
    assert(crons.includes("runDailyRollup"), "no scheduled rollup");
    return "daily rollup + index by_org_day; no counter table";
  });
} catch (error) {
  failed++;
  failures.push(`setup: ${error.message}`);
  log(`FAIL  setup — ${error.stack ?? error.message}`);
} finally {
  if (createdOrg !== null) {
    try {
      const purged = runInternal("purgeTenant", {
        orgPublicId: createdOrg.orgPublicId,
        deleteUsers: true,
      });
      log(`cleanup ${createdOrg.orgPublicId}: removed=${purged.removed} rows=${purged.deleted}`);
    } catch (error) {
      failed++;
      failures.push(`cleanup: ${error.message}`);
      log(`FAIL  cleanup — ${error.message}`);
    }
  }
}

log("");
log(`checks: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  log("");
  for (const failure of failures) log(`  ${failure}`);
}

mkdirSync(join(appDir, "evidence"), { recursive: true });
const out = join(appDir, "evidence", "verify-cost-model.txt");
writeFileSync(
  out,
  [
    `Cost model verification — ${new Date().toISOString()}`,
    `deployment: ${CLOUD}`,
    `run id:     ${runId}`,
    "",
    ...lines,
    "",
  ].join("\n"),
  "utf8",
);
console.log(`evidence: ${out}`);

if (failed > 0) process.exitCode = 1;
