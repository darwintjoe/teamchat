// Merge the per-scenario S5 v2 evidence files into one report.
//
//   node scripts/s5-v2-merge.mjs
//
// Each scenario runs in its own process with a fresh 10,000-session generator fleet (see
// s5-v2-scenario.mjs for why). This script does not touch the deployment; it only reads the
// per-scenario JSON files and writes evidence/s5-v2-result.json + evidence/s5-v2-summary.md.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDir } from "./lib/harness.mjs";

const evidenceDir = join(appDir, "evidence");
const read = (name) => JSON.parse(readFileSync(join(evidenceDir, name), "utf8"));

const curveFiles = [
  ["curve400", "s5-v2-curve400.json"],
  ["curve500", "s5-v2-curve500.json"],
  ["curve1000", "s5-v2-curve1000.json"],
  ["curve2000", "s5-v2-curve2000.json"],
  ["curve4000", "s5-v2-curve4000.json"],
  ["curve8000", "s5-v2-curve8000.json"],
];
const scenarioFiles = [
  ...curveFiles,
  ["fanout40", "s5-v2-fanout40.json"],
  ["sequential", "s5-v2-sequential.json"],
];

const scenarios = [];
for (const [name, file] of scenarioFiles) {
  const data = read(file);
  scenarios.push({
    scenario: name,
    file,
    ranAt: data.ranAt,
    orgPublicId: data.orgPublicId,
    ramp: data.sessionRamp,
    failures: data.failures?.byClass ?? {},
    failureTotal: data.failures?.total ?? 0,
  });
}

const curve = [];
for (const [, file] of curveFiles) {
  const data = read(file);
  if (data.curve) curve.push(data.curve);
}

const combined4k = read("s5-v2-curve4000.json").combined;
const combined8k = read("s5-v2-curve8000.json").combined;
const sequential = read("s5-v2-sequential.json").sequential;
const fanout40 = read("s5-v2-fanout40.json").fanout40;

const rampRuns = scenarios
  .filter((entry) => entry.ramp)
  .map((entry) => ({
    scenario: entry.scenario,
    requested: entry.ramp.requested,
    connected: entry.ramp.connected,
    shortfall: entry.ramp.shortfall,
    rampSeconds: entry.ramp.rampSeconds,
    failuresByClass: entry.failures,
  }));
const bestRamp = rampRuns.reduce(
  (best, run) => (best === null || run.connected > best.connected ? run : best),
  null,
);

// Linear fit over the curve points, used only to bracket the 2 s threshold.
const fitPoints = curve.filter((point) => point.p95 !== null);
let thresholdViewers = null;
if (fitPoints.length >= 2) {
  const meanX = fitPoints.reduce((sum, point) => sum + point.requestedViewers, 0) / fitPoints.length;
  const meanY = fitPoints.reduce((sum, point) => sum + point.p95, 0) / fitPoints.length;
  const slope =
    fitPoints.reduce((sum, point) => sum + (point.requestedViewers - meanX) * (point.p95 - meanY), 0) /
    fitPoints.reduce((sum, point) => sum + (point.requestedViewers - meanX) ** 2, 0);
  const intercept = meanY - slope * meanX;
  thresholdViewers = Math.floor((2000 - intercept) / slope);
}

const largestUnder2s = curve
  .filter((point) => point.p95 !== null && point.p95 < 2000 && point.coverage === 1)
  .reduce((best, point) => (best === null || point.requestedViewers > best.requestedViewers ? point : best), null);

const result = {
  ranAt: new Date().toISOString(),
  deployment: read("s5-v2-curve4000.json").deployment,
  region: read("s5-v2-curve4000.json").region,
  methodology: {
    generatorProcesses: 4,
    sessionsPerScenario: 10_000,
    freshFleetPerScenario: true,
    t0: "send mutation return in the master process",
    t1: "messages.listLive subscription callback in the generator process",
    clock: "performance.timeOrigin + performance.now(); sub-ms skew clamped to 0",
    combinedBurst: "256 one-shot queries + 512 messages.send across 8 action users + one fan-out, one target epoch",
  },
  sessionRamp: {
    target: 10_000,
    bestConnected: bestRamp?.connected ?? null,
    runs: rampRuns,
    note:
      "Every scenario ramped a fresh fleet to the 10,000 target. The deployment refused collection " +
      "of new sockets around 8.0-8.3k in every run; all ramp failures were 20 s first-result " +
      "timeouts with hasEverConnected=false.",
  },
  curve: {
    points: curve,
    linearFitMsPerViewer: fitPoints.length >= 2 ? Number(((fitPoints[fitPoints.length - 1].p95 - fitPoints[0].p95) / (fitPoints[fitPoints.length - 1].requestedViewers - fitPoints[0].requestedViewers)).toFixed(4)) : null,
    thresholdUnder2sP95Viewers: thresholdViewers,
    largestMeasuredUnder2s: largestUnder2s
      ? { viewers: largestUnder2s.requestedViewers, p50: largestUnder2s.p50, p95: largestUnder2s.p95, p99: largestUnder2s.p99 }
      : null,
  },
  combined: {
    at4000: combined4k,
    at8000: combined8k,
  },
  sequential,
  fanout40,
  notes: [
    "8,000 viewers in one group is unstable: two attempts shed sockets during subscription setup (4,692 assigned / 6,242 ready in the first attempt; 3,942 assigned / 5,338 ready in the second), while the third held 8,000/8,000. The two collapsed attempts used 30-second no-first-result subscription timeouts; they are classified as timeout in this report even though the older logs say unknown.",
    "8,000 viewers spread over 40 groups of 200 delivered in 626 ms p95, so total viewer count is not the binding constraint - concentration in one group is.",
    "Sequential baseline: queries and actions one at a time at the same 8k fleet, then one 4,000-viewer fan-out.",
    "The 512-action burst uses eight cached users, so each user issues 64 concurrent sends; the latency includes per-sender membership-row contention.",
  ],
  failures: {
    byClass: {},
    perScenario: scenarios.map((entry) => ({
      scenario: entry.scenario,
      total: entry.failureTotal,
      byClass: entry.failures,
    })),
  },
};

for (const entry of scenarios) {
  for (const [key, count] of Object.entries(entry.failures)) {
    result.failures.byClass[key] = (result.failures.byClass[key] ?? 0) + count;
  }
}

writeFileSync(join(evidenceDir, "s5-v2-result.json"), JSON.stringify(result, null, 2));

const lines = [];
lines.push("# S5 v2 distributed result");
lines.push("");
lines.push(`Merged: ${result.ranAt}  `);
lines.push(`Deployment: ${result.deployment} (${result.region})  `);
lines.push(`Generator: 4 OS processes, fresh 10,000-session fleet per scenario  `);
lines.push("");
lines.push("## Fan-out curve (one message, one group)");
lines.push("");
lines.push("| Requested viewers | Subscribed | Received | p50 ms | p95 ms | p99 ms | Max ms |");
lines.push("|---:|---:|---:|---:|---:|---:|---:|");
for (const point of curve) {
  lines.push(
    `| ${point.requestedViewers} | ${point.subscribedViewers} | ${point.received} | ${point.p50} | ${point.p95} | ${point.p99} | ${point.max} |`,
  );
}
lines.push("");
lines.push(`Linear fit: ${result.curve.linearFitMsPerViewer} ms per viewer; 2,000 ms p95 threshold at ~${result.curve.thresholdUnder2sP95Viewers} viewers.`);
if (result.curve.largestMeasuredUnder2s) {
  lines.push(`Largest measured point under 2,000 ms p95: **${result.curve.largestMeasuredUnder2s.viewers} viewers** (p95 ${result.curve.largestMeasuredUnder2s.p95} ms).`);
}
lines.push("");
lines.push("## Session ramp (fresh fleet per scenario)");
lines.push("");
lines.push("| Scenario | Requested | Connected | Shortfall | Seconds | Failures |");
lines.push("|---|---:|---:|---:|---:|---|");
for (const run of rampRuns) {
  lines.push(
    `| ${run.scenario} | ${run.requested} | ${run.connected} | ${run.shortfall} | ${run.rampSeconds} | ${JSON.stringify(run.failuresByClass)} |`,
  );
}
lines.push("");
lines.push(`Best connected: **${bestRamp?.connected ?? "-"}/10,000**.`);
lines.push("");
lines.push("## Combined burst (256 queries + 512 actions + fan-out at one instant)");
lines.push("");
for (const [label, combined] of [
  ["4,000 viewers", combined4k],
  ["8,000 viewers", combined8k],
]) {
  lines.push(`### ${label}`);
  lines.push("");
  lines.push(`- Queries: ${combined.query.calls}/256, errors ${combined.query.errors}, p50 ${combined.query.p50} ms, p95 ${combined.query.p95} ms, p99 ${combined.query.p99} ms`);
  lines.push(`- Actions: ${combined.action.n}/512, errors ${combined.action.errors}, p50 ${combined.action.p50} ms, p95 ${combined.action.p95} ms, p99 ${combined.action.p99} ms`);
  lines.push(`- Fan-out: ${combined.fanout.received}/${combined.fanout.subscribedViewers}, missing ${combined.fanout.missing}, p50 ${combined.fanout.p50} ms, p95 ${combined.fanout.p95} ms, p99 ${combined.fanout.p99} ms`);
  lines.push(`- Send-return debt: ${combined.fanout.sendReturnDebtMs} ms`);
  lines.push("");
}
lines.push("## Sequential baseline");
lines.push("");
lines.push(`- Queries: ${sequential.query.calls}/256 one at a time, errors ${sequential.query.errors}, p50 ${sequential.query.p50} ms, p95 ${sequential.query.p95} ms, wall ${sequential.query.wallMs} ms`);
lines.push(`- Actions: ${sequential.action.calls}/512 one at a time, errors ${sequential.action.errors}, p50 ${sequential.action.p50} ms, p95 ${sequential.action.p95} ms, wall ${sequential.action.wallMs} ms`);
lines.push(`- Fan-out: ${sequential.fanout.received}/${sequential.fanout.subscribedViewers}, p95 ${sequential.fanout.p95} ms`);
lines.push("");
lines.push("## 40 groups x 200 viewers");
lines.push("");
lines.push(`- Viewers: ${fanout40.viewersSubscribed}/${fanout40.viewersRequested}`);
lines.push(`- Messages: ${fanout40.messagesSent} (one per group)`);
lines.push(`- Receipts: ${fanout40.n}, missing ${fanout40.viewersSubscribed - fanout40.n}`);
lines.push(`- p50 ${fanout40.p50} ms, p95 ${fanout40.p95} ms, p99 ${fanout40.p99} ms, max ${fanout40.max} ms`);
lines.push("");
lines.push("## Failures by class");
lines.push("");
lines.push("```json");
lines.push(JSON.stringify(result.failures, null, 2));
lines.push("```");
lines.push("");

writeFileSync(join(evidenceDir, "s5-v2-summary.md"), `${lines.join("\n")}\n`);

console.log(`merged ${scenarios.length} scenarios`);
console.log(`curve points: ${curve.map((point) => `${point.requestedViewers}=${point.p95}ms`).join(", ")}`);
console.log(`best ramp: ${bestRamp?.connected ?? "-"}/10000`);
console.log(`2s p95 threshold: ~${thresholdViewers} viewers; largest measured under 2s: ${largestUnder2s?.requestedViewers ?? "-"}`);
console.log("wrote evidence/s5-v2-result.json and evidence/s5-v2-summary.md");
