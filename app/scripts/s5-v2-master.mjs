// S5 v2 — distributed concurrent sessions / queries / actions / fan-out.
//
//   node scripts/s5-v2-master.mjs [--sessions=10000] [--workers=5] [--queries=256]
//                                 [--actions=512] [--skip-ramp]
//
// The master owns setup (auth cache, org, groups), the measurement clock, the 256-query and
// 512-action bursts, and every send mutation. The workers own WebSocket clients and subscriptions.
// T0 is taken immediately after the send mutation returns, T1 inside the subscription callback.
// All processes run on one host, so performance.timeOrigin + performance.now() is comparable.
//
// Evidence: evidence/s5-v2-result.json and evidence/s5-v2-summary.md.

import { fork } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ConvexClient } from "convex/browser";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import {
  appDir,
  classifyError,
  deploymentUrl,
  percentile,
  summary,
} from "./lib/harness.mjs";
import { ensureUsers, s5Emails } from "./lib/s5-auth.mjs";
import { ensureProdSessions, loadPrivateKey, runInternal } from "./lib/prod-session.mjs";

const absNow = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepUntil = async (epoch) => {
  const wait = epoch - absNow();
  if (wait > 0) await sleep(wait);
};

function arg(name, fallback) {
  if (typeof fallback === "boolean" && process.argv.includes(`--${name}`)) return true;
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (hit === undefined) return fallback;
  const raw = hit.slice(name.length + 3);
  return raw === "true" ? true : raw === "false" ? false : Number.isNaN(Number(raw)) ? raw : Number(raw);
}

const PROD = arg("prod", process.env.S5_PROD === "true");
const URL = PROD
  ? process.env.CONVEX_URL ?? "https://benevolent-crocodile-386.convex.cloud"
  : deploymentUrl();
const SESSIONS = arg("sessions", 10_000);
const WORKERS = Math.max(4, Math.min(6, arg("workers", 4)));
const QUERIES = arg("queries", 256);
const ACTIONS = arg("actions", 512);
const ACTION_USERS = arg("action-users", 8);
const ACTION_GROUP_COUNT = Math.max(ACTIONS, 1);
const actionGroupName = (index) => `action-${String(index).padStart(4, "0")}`;
const CURVE = String(arg("curve", "500,1000,2000,4000,8000"))
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const FANOUT_GROUPS = 40;
const VIEWERS_PER_GROUP = 200;
const RAMP_BUDGET_MS = arg("ramp-budget-ms", 8 * 60 * 1000);
const RAMP_BATCH = arg("ramp-batch", 100);
const RAMP_TIMEOUT_MS = arg("ramp-timeout-ms", 20_000);
const SKIP_RAMP = arg("skip-ramp", false);
const STABILITY_SECONDS = arg("stability-seconds", 0);
const CAPS_ONLY = arg("caps-only", false);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = join(appDir, "evidence");
mkdirSync(evidenceDir, { recursive: true });

const failures = [];
function recordFailure(stage, errorOrEntry, extra = {}) {
  const entry =
    errorOrEntry && typeof errorOrEntry === "object" && errorOrEntry.class
      ? { ...errorOrEntry, stage: errorOrEntry.stage ?? stage, ...extra }
      : { stage, class: classifyError(errorOrEntry), message: String(errorOrEntry?.message ?? errorOrEntry).slice(0, 300), ...extra };
  failures.push(entry);
  return entry;
}

function log(message) {
  console.log(`[s5v2 ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function purgeOrg(orgPublicId) {
  let last = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = runInternal("purgeTenant", { orgPublicId, deleteUsers: true, maxGroups: 50 });
    if (last.removed) return last;
  }
  throw new Error(`purge did not finish: ${JSON.stringify(last)}`);
}

// ---------------------------------------------------------------------------- auth + org

log(PROD ? "seeding production S5 users with minted RS256 sessions" : "refreshing cached S5 users (no OTP expected)");
let users;
if (PROD) {
  const privateKey = loadPrivateKey();
  const siteUrl = process.env.CONVEX_SITE_URL ?? URL.replace(".convex.cloud", ".convex.site");
  const seeded = await ensureProdSessions({ emails: s5Emails(ACTION_USERS), siteUrl, privateKey });
  users = seeded.map((user) => ({ ...user, refreshed: false }));
  log(`  ${users.length} production sessions minted`);
} else {
  users = await ensureUsers(URL, s5Emails(ACTION_USERS), {
    allowOtp: true,
    onProgress: (user) => log(`  ${user.email} ${user.refreshed ? "refreshed" : "signed in"}`),
  });
}
const owner = users[0];
const actionUsers = users.slice(1);

const admin = new ConvexHttpClient(URL);
admin.setAuth(owner.token);
const org = await admin.mutation(api.organizations.create, {
  name: `S5 v2 ${stamp}`,
  allowDirectMessages: false,
});
log(`org ${org.orgPublicId}`);

const groupNames = [
  "hold",
  "write",
  ...CURVE.map((size) => `curve-${size}`),
  ...Array.from({ length: FANOUT_GROUPS }, (_, index) => `fanout-${String(index).padStart(2, "0")}`),
  ...Array.from({ length: ACTION_GROUP_COUNT }, (_, index) => actionGroupName(index)),
];
const groups = {};
for (let offset = 0; offset < groupNames.length; offset += 8) {
  const batch = groupNames.slice(offset, offset + 8);
  const created = await Promise.all(
    batch.map((name) =>
      admin.mutation(api.groups.create, {
        orgPublicId: org.orgPublicId,
        name: `S5v2 ${name} ${stamp}`,
        parentGroupPublicId: org.rootGroupPublicId,
      }),
    ),
  );
  batch.forEach((name, index) => {
    groups[name] = created[index].groupPublicId;
  });
}
log(`created ${groupNames.length} groups`);

const holdConversation = { kind: "group", publicId: groups.hold };
const writeConversation = { kind: "group", publicId: groups.write };

for (const [userIndex, user] of actionUsers.entries()) {
  const invite = await admin.mutation(api.invites.create, { orgPublicId: org.orgPublicId });
  const client = new ConvexHttpClient(URL);
  client.setAuth(user.token);
  await client.action(api.invites.redeem, { token: invite.token });
  await admin.mutation(api.groups.addMember, {
    groupPublicId: groups.write,
    userPublicId: user.publicId,
  });
  for (let offset = 0; offset < ACTION_GROUP_COUNT; offset += 64) {
    const batch = [];
    for (let index = offset; index < Math.min(offset + 64, ACTION_GROUP_COUNT); index += 1) {
      if (index % actionUsers.length !== userIndex) continue;
      batch.push(
        admin.mutation(api.groups.addMember, {
          groupPublicId: groups[actionGroupName(index)],
          userPublicId: user.publicId,
        }),
      );
    }
    await Promise.all(batch);
  }
}
log(`${actionUsers.length} action users joined the org, write group and their action groups`);

const ownerWs = new ConvexClient(URL, { logger: false });
ownerWs.setAuth(async () => owner.token);
const actionClients = actionUsers.map((user) => {
  const client = new ConvexClient(URL, { logger: false });
  client.setAuth(async () => user.token);
  return client;
});

// ---------------------------------------------------------------------------- worker IPC

function startWorker(index) {
  const child = fork(join(appDir, "scripts", "s5-v2-worker.mjs"), [], {
    cwd: appDir,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const worker = {
    index,
    child,
    queued: [],
    waiters: [],
    attempted: 0,
    connected: 0,
    rampSeconds: null,
    rssMb: null,
    stopped: false,
    rampFailures: [],
    lastProgress: null,
    exited: false,
    exitReason: null,
  };
  child.on("message", (message) => {
    if (message.type === "ramp-progress") {
      worker.attempted = message.attempted;
      worker.connected = message.connected;
      worker.rssMb = message.rssMb;
      worker.lastProgress = message;
      return;
    }
    if (message.type === "ramp-cap") {
      worker.capped = message.reason;
      return;
    }
    if (message.type === "receipt") {
      const list = receipts.get(message.key);
      if (list) list.push(message.t1);
      return;
    }
    if (message.type === "sub-failure") {
      recordFailure("subscription", message.entry ?? new Error("subscription failed"));
      return;
    }
    if (message.type === "worker-error") {
      recordFailure("worker", message.error ?? new Error(message.message), { worker: index });
      return;
    }
    const waiterIndex = worker.waiters.findIndex((waiter) => waiter.type === message.type);
    if (waiterIndex >= 0) {
      const [waiter] = worker.waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      worker.queued.push(message);
    }
  });
  child.on("exit", (code, signal) => {
    worker.exited = true;
    worker.exitReason = `exit ${code} ${signal ?? ""}`.trim();
    for (const waiter of worker.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`worker ${index} ${worker.exitReason}`));
    }
  });
  return worker;
}

function waitMessage(worker, type, timeoutMs = 60_000) {
  const index = worker.queued.findIndex((message) => message.type === type);
  if (index >= 0) {
    const [message] = worker.queued.splice(index, 1);
    return Promise.resolve(message);
  }
  return new Promise((resolve, reject) => {
    const waiter = { type, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      const at = worker.waiters.indexOf(waiter);
      if (at >= 0) worker.waiters.splice(at, 1);
      reject(new Error(`worker ${worker.index}: timeout waiting for ${type}`));
    }, timeoutMs);
    worker.waiters.push(waiter);
  });
}

const receipts = new Map();
const workers = Array.from({ length: WORKERS }, (_, index) => startWorker(index));
await Promise.all(workers.map((worker) => waitMessage(worker, "worker-ready", 30_000)));
log(`${workers.length} generator processes ready`);

// ---------------------------------------------------------------------------- ramp

const perWorkerTarget = Array.from({ length: WORKERS }, (_, index) =>
  Math.floor(SESSIONS / WORKERS) + (index < SESSIONS % WORKERS ? 1 : 0),
);

const rampStarted = absNow();
let rampBudgetExceeded = false;
const budgetTimer = setTimeout(() => {
  rampBudgetExceeded = true;
  log("ramp budget exhausted; asking workers to stop");
  for (const worker of workers) worker.child.send({ type: "stop-ramp" });
}, RAMP_BUDGET_MS);

if (!SKIP_RAMP) {
  log(`ramping ${SESSIONS} sessions across ${WORKERS} workers`);
  const done = workers.map((worker) =>
    waitMessage(worker, "ramp-done", RAMP_BUDGET_MS + 120_000),
  );
  workers.forEach((worker) => {
    worker.child.send({
      type: "init",
      url: URL,
      token: owner.token,
      worker: worker.index,
      holdConversation,
      target: perWorkerTarget[worker.index],
      rampBatch: RAMP_BATCH,
      rampTimeoutMs: RAMP_TIMEOUT_MS,
    });
  });
  const results = await Promise.all(done);
  clearTimeout(budgetTimer);
  results.forEach((result, index) => {
    const worker = workers[index];
    worker.attempted = result.attempted;
    worker.connected = result.connected;
    worker.rampSeconds = result.elapsedSeconds;
    worker.rssMb = result.rssMb;
    worker.stopped = result.stopped;
    worker.rampFailures = result.failures ?? [];
    for (const entry of worker.rampFailures) recordFailure("ramp", entry, { worker: index });
    const byClass = {};
    for (const entry of worker.rampFailures) byClass[entry.class] = (byClass[entry.class] ?? 0) + 1;
    log(
      `worker ${index}: ${result.connected}/${result.attempted} connected in ${result.elapsedSeconds}s, ` +
        `${result.failures.length} classified failures ${JSON.stringify(byClass)}, rss ${result.rssMb} MB`,
    );
  });
} else {
  log("--skip-ramp set: workers are only useful for a previously populated run; aborting");
  process.exit(1);
}

const totalConnected = workers.reduce((sum, worker) => sum + worker.connected, 0);
const rampSeconds = Number(((absNow() - rampStarted) / 1000).toFixed(1));
log(`ramp complete: ${totalConnected}/${SESSIONS} sessions in ${rampSeconds}s`);
if (totalConnected === 0) throw new Error("no sessions connected");

if (CAPS_ONLY) {
  log(`caps-only: ${QUERIES} queries + ${ACTIONS} actions, no fan-out subscriptions`);
  const targetEpoch = absNow() + 3000;
  const queryCounts = Array.from({ length: WORKERS }, (_, index) =>
    Math.floor(QUERIES / WORKERS) + (index < QUERIES % WORKERS ? 1 : 0),
  );
  const queryDone = workers.map((worker) => waitMessage(worker, "query-done", 240_000));
  workers.forEach((worker, index) => {
    worker.child.send({
      type: "query-burst",
      targetEpoch,
      count: queryCounts[index],
      conversation: writeConversation,
    });
  });
  const actionPromise = (async () => {
    await sleepUntil(targetEpoch);
    const latencies = [];
    let errors = 0;
    await Promise.all(
      Array.from({ length: ACTIONS }, async (_, index) => {
        const client = actionClients[index % actionClients.length];
        const t0 = absNow();
        try {
          await client.mutation(api.messages.send, {
            conversation: { kind: "group", publicId: groups[actionGroupName(index)] },
            text: `s5v2 caps action ${index} ${stamp}`,
          });
          latencies.push(Number((absNow() - t0).toFixed(2)));
        } catch (error) {
          errors += 1;
          recordFailure("action", error, { actionIndex: index });
        }
      }),
    );
    return { concurrency: ACTIONS, users: actionClients.length, ...summary(latencies), errors };
  })();

  const [queryResults, actionStats] = await Promise.all([Promise.all(queryDone), actionPromise]);
  const queryLatencies = [];
  let queryErrors = 0;
  for (const result of queryResults) {
    for (const call of result.results ?? []) {
      if (!call.ok) {
        queryErrors += 1;
        recordFailure("query", call.error);
        continue;
      }
      queryLatencies.push(Number((call.t1 - call.t0).toFixed(2)));
    }
  }
  const caps = {
    ranAt: new Date().toISOString(),
    deployment: URL,
    production: PROD,
    sessions: { requested: SESSIONS, connected: totalConnected, shortfall: SESSIONS - totalConnected, rampSeconds },
    query: { concurrency: QUERIES, calls: queryLatencies.length, errors: queryErrors, ...summary(queryLatencies) },
    action: actionStats,
    failures: failures.map((entry) => `${entry.stage}:${entry.class}`),
  };
  const base = PROD ? "s5-prod" : "s5-v2";
  writeFileSync(join(evidenceDir, `${base}-caps-only.json`), JSON.stringify(caps, null, 2));
  log(
    `caps-only: queries ${caps.query.calls}/${QUERIES} p95 ${caps.query.p95} ms (${caps.query.errors} errors), ` +
      `actions ${caps.action.concurrency} p95 ${caps.action.p95} ms (${caps.action.errors} errors)`,
  );
  const closeDone = workers.map((worker) => waitMessage(worker, "close-done", 120_000).catch(() => null));
  workers.forEach((worker) => worker.child.send({ type: "close" }));
  await Promise.all(closeDone);
  await Promise.all(actionClients.map((client) => client.close().catch(() => {})));
  await ownerWs.close().catch(() => {});
  if (PROD) {
    try {
      const purged = purgeOrg(org.orgPublicId);
      log(`purged production caps tenant: ${JSON.stringify(purged)}`);
    } catch (error) {
      log(`production caps tenant purge failed: ${String(error.message ?? error)}`);
    }
  }
  process.exit(0);
}

if (STABILITY_SECONDS > 0) {
  log(`stability probe: holding for ${STABILITY_SECONDS}s`);
  const before = await health();
  log(`  at hold start: ${before.connectedSessions} connected, ${before.disconnectEvents} disconnect events`);
  await sleep(STABILITY_SECONDS * 1000);
  const after = await health();
  log(
    `  at hold end: ${after.connectedSessions} connected, ${after.disconnectEvents} disconnect events`,
  );
  if (after.disconnectSamples.length > 0) {
    log(`  disconnect samples: ${JSON.stringify(after.disconnectSamples.slice(0, 5))}`);
  }
  const evidenceBase = PROD ? "s5-prod" : "s5-v2";
  writeFileSync(
    join(evidenceDir, `${evidenceBase}-stability.json`),
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        deployment: URL,
        production: PROD,
        sessionsRequested: SESSIONS,
        sessionsConnectedAfterRamp: totalConnected,
        rampSeconds,
        holdSeconds: STABILITY_SECONDS,
        atHoldStart: before,
        atHoldEnd: after,
        perWorker: workers.map((worker) => ({
          worker: worker.index,
          attempted: worker.attempted,
          connected: worker.connected,
          failures: worker.rampFailures.length,
          failuresByClass: worker.rampFailures.reduce((out, entry) => {
            out[entry.class] = (out[entry.class] ?? 0) + 1;
            return out;
          }, {}),
          samples: worker.rampFailures.slice(0, 5),
        })),
      },
      null,
      2,
    ),
  );
  const closeDone = workers.map((worker) => waitMessage(worker, "close-done", 120_000).catch(() => null));
  workers.forEach((worker) => worker.child.send({ type: "close" }));
  await Promise.all(closeDone);
  await Promise.all(actionClients.map((client) => client.close().catch(() => {})));
  await ownerWs.close().catch(() => {});
  if (PROD) {
    try {
      const purged = purgeOrg(org.orgPublicId);
      log(`purged production stability tenant: ${JSON.stringify(purged)}`);
    } catch (error) {
      log(`production stability tenant purge failed: ${String(error.message ?? error)}`);
    }
  }
  log("stability probe complete");
  process.exit(0);
}

// ---------------------------------------------------------------------------- assignments

const offsets = [];
{
  let offset = 0;
  for (const worker of workers) {
    offsets.push(offset);
    offset += worker.connected;
  }
}

function locate(globalIndex) {
  for (let index = workers.length - 1; index >= 0; index -= 1) {
    if (globalIndex >= offsets[index]) return { worker: index, local: globalIndex - offsets[index] };
  }
  throw new Error(`global index ${globalIndex} out of range`);
}

function viewerIndices(requested) {
  const actual = Math.min(requested, totalConnected);
  const result = [];
  for (let k = 0; k < actual; k += 1) {
    result.push(Math.floor((k * totalConnected) / actual));
  }
  return result;
}

function curveKey(size) {
  return `curve-${size}`;
}

function assignmentFor(key, indices, groupPublicId) {
  const assignments = Array.from({ length: WORKERS }, () => []);
  for (const globalIndex of indices) {
    const { worker, local } = locate(globalIndex);
    assignments[worker].push({ session: local, key, publicId: groupPublicId });
  }
  return assignments;
}

async function clearAllSubscriptions() {
  const done = workers.map((worker) => waitMessage(worker, "clear-done", 120_000));
  workers.forEach((worker) => worker.child.send({ type: "clear-subscriptions" }));
  const results = await Promise.all(done);
  return results.reduce((sum, result) => sum + (result.removed ?? 0), 0);
}

async function clearAndCooldown(label) {
  const removed = await clearAllSubscriptions();
  if (removed === 0) return;
  // Unsubscribe is fire-and-forget at the protocol level: the local ack says nothing about the
  // server having finished cancelling those query sets. Starting the next phase immediately
  // measures that cleanup. The dev deployment needed roughly 30 ms per cancelled subscription.
  const cooldown = Math.min(240_000, removed * 30);
  log(`cleared ${removed} subscriptions before ${label}; cooling down ${Math.round(cooldown / 1000)}s`);
  await sleep(cooldown);
}

async function health() {
  const done = workers.map((worker) => waitMessage(worker, "health-done", 30_000));
  workers.forEach((worker) => worker.child.send({ type: "health" }));
  const results = await Promise.all(done);
  const readyByKey = {};
  let connectedSessions = 0;
  let disconnectEvents = 0;
  const disconnectSamples = [];
  for (const result of results) {
    connectedSessions += result.connectedSessions;
    disconnectEvents += result.disconnectEvents ?? 0;
    for (const sample of result.disconnectSamples ?? []) {
      if (disconnectSamples.length < 10) disconnectSamples.push(sample);
    }
    for (const [key, count] of Object.entries(result.readyByKey)) {
      readyByKey[key] = (readyByKey[key] ?? 0) + count;
    }
  }
  return { readyByKey, connectedSessions, disconnectEvents, disconnectSamples };
}

async function subscribePhase(key, indices) {
  const assignments = assignmentFor(key, indices, groups[key]);
  const started = absNow();
  const done = workers.map((worker) => waitMessage(worker, "subscribe-done", 240_000));
  workers.forEach((worker) => worker.child.send({ type: "subscribe", entries: assignments[worker.index] }));
  const results = await Promise.all(done);
  let assigned = 0;
  for (const result of results) {
    assigned += result.counts[key] ?? 0;
    for (const entry of result.failures ?? []) recordFailure("subscription", entry);
  }
  await sleep(500);
  const current = await health();
  const ready = current.readyByKey[key] ?? 0;
  if (ready < assigned) {
    recordFailure("subscription", {
      class: "connection",
      message: `${assigned - ready}/${assigned} ${key} subscriptions were no longer ready at the health check`,
    });
  }
  return {
    assigned,
    ready,
    connectedSessions: current.connectedSessions,
    seconds: Number(((absNow() - started) / 1000).toFixed(1)),
  };
}

// Ramp used one-shot queries only: no hold subscription exists to tear down before the curve.
log("starting the fan-out curve");

// ---------------------------------------------------------------------------- fan-out helper

async function arm(entries) {
  await Promise.all(
    workers.map((worker) => {
      const ack = waitMessage(worker, "arm-ack", 30_000);
      worker.child.send({ type: "arm", entries });
      return ack;
    }),
  );
}

async function sendMessage(conversation, text) {
  const t0 = absNow();
  await ownerWs.mutation(api.messages.send, { conversation, text });
  return t0;
}

async function waitReceipts(key, expected, timeoutMs) {
  const list = receipts.get(key) ?? [];
  const deadline = absNow() + timeoutMs;
  while (list.length < expected && absNow() < deadline) await sleep(50);
  return list;
}

async function fanoutCurve(size, expected, subscription) {
  const key = curveKey(size);
  receipts.set(key, []);
  const text = `s5v2 curve ${size} ${stamp} ${Math.random().toString(36).slice(2)}`;
  await arm([{ key, text }]);
  const t0 = await sendMessage({ kind: "group", publicId: groups[key] }, text);
  const list = await waitReceipts(key, expected, 180_000);
  const latencies = list.map((t1) => Number((t1 - t0).toFixed(2)));
  const missing = Math.max(0, expected - latencies.length);
  if (missing > 0) {
    recordFailure("fanout", {
      class: "receipt_timeout",
      message: `${missing}/${expected} subscribers did not receive the ${size}-viewer probe within 180 s`,
    });
  }
  return {
    requestedViewers: size,
    assignedViewers: subscription.assigned,
    subscribedViewers: expected,
    connectedSessions: subscription.connectedSessions,
    subscribeSeconds: subscription.seconds,
    received: latencies.length,
    missing,
    coverage: expected === 0 ? null : Number((latencies.length / expected).toFixed(4)),
    ...summary(latencies),
  };
}

const curve = [];
for (const size of CURVE) {
  const key = curveKey(size);
  if (size !== CURVE[0]) await clearAndCooldown(key);
  const indices = viewerIndices(size);
  log(`subscribing ${indices.length}/${size} viewers for ${key}`);
  const subscription = await subscribePhase(key, indices);
  log(`  ${subscription.ready}/${indices.length} ready in ${subscription.seconds}s (${subscription.connectedSessions} sockets up)`);
  const result = await fanoutCurve(size, subscription.ready, subscription);
  curve.push(result);
  log(
    `  ${result.received}/${result.subscribedViewers} received, p50 ${result.p50} ms, p95 ${result.p95} ms, p99 ${result.p99} ms`,
  );
}

// ---------------------------------------------------------------------------- combined burst at 8k

log(`combined burst: ${QUERIES} queries + ${ACTIONS} actions + one ${CURVE[CURVE.length - 1]}-viewer fan-out`);
const fanoutKey = curveKey(CURVE[CURVE.length - 1] ?? 8000);
const fanoutText = `s5v2 combined ${stamp} ${Math.random().toString(36).slice(2)}`;
receipts.set(fanoutKey, []);
const combinedHealth = await health();
const fanoutExpected = combinedHealth.readyByKey[fanoutKey] ?? 0;
const combinedSubscribed = curve[curve.length - 1]?.subscribedViewers ?? 0;
if (fanoutExpected < combinedSubscribed) {
  recordFailure("fanout", {
    class: "connection",
    message: `${combinedSubscribed - fanoutExpected} 8k-group subscriptions dropped before the combined burst`,
  });
}
await arm([{ key: fanoutKey, text: fanoutText }]);

const targetEpoch = absNow() + 3000;

const queryCounts = Array.from({ length: WORKERS }, (_, index) =>
  Math.floor(QUERIES / WORKERS) + (index < QUERIES % WORKERS ? 1 : 0),
);
const queryDone = workers.map((worker) => waitMessage(worker, "query-done", 240_000));
workers.forEach((worker, index) => {
  worker.child.send({
    type: "query-burst",
    targetEpoch,
    count: queryCounts[index],
    conversation: writeConversation,
  });
});

const fanoutSendPromise = sleepUntil(targetEpoch)
  .then(() => {
    const t0 = absNow();
    return ownerWs
      .mutation(api.messages.send, {
        conversation: { kind: "group", publicId: groups[fanoutKey] },
        text: fanoutText,
      })
      .then(() => t0);
  });

const actionStarted = absNow();
const actionPromise = (async () => {
  await sleepUntil(targetEpoch);
  const latencies = [];
  const localFailures = [];
  await Promise.all(
    Array.from({ length: ACTIONS }, async (_, index) => {
      const client = actionClients[index % actionClients.length];
      const t0 = absNow();
      try {
        await client.mutation(api.messages.send, {
          conversation: { kind: "group", publicId: groups[actionGroupName(index)] },
          text: `s5v2 action ${index} ${stamp}`,
        });
        latencies.push(Number((absNow() - t0).toFixed(2)));
      } catch (error) {
        localFailures.push(recordFailure("action", error, { actionIndex: index }));
      }
    }),
  );
  return {
    concurrency: ACTIONS,
    users: actionClients.length,
    startedAtEpoch: actionStarted,
    ...summary(latencies),
    errors: localFailures.length,
  };
})();

const t0Fanout = await fanoutSendPromise;
const fanoutStartDebtMs = Number((t0Fanout - targetEpoch).toFixed(2));
const [queryResults, actionStats] = await Promise.all([Promise.all(queryDone), actionPromise]);
const fanoutReceipts = await waitReceipts(fanoutKey, fanoutExpected, 240_000);
const fanoutLatencies = fanoutReceipts.map((t1) => Number((t1 - t0Fanout).toFixed(2)));
const fanoutMissing = Math.max(0, fanoutExpected - fanoutLatencies.length);
if (fanoutMissing > 0) {
  recordFailure("fanout", {
    class: "receipt_timeout",
    message: `${fanoutMissing}/${fanoutExpected} subscribers missed the combined 8k probe within 240 s`,
  });
}

const queryLatencies = [];
const queryDebts = [];
for (const result of queryResults) {
  for (const call of result.results ?? []) {
    if (!call.ok) {
      recordFailure("query", call.error);
      continue;
    }
    queryLatencies.push(Number((call.t1 - call.t0).toFixed(2)));
    queryDebts.push(Number((call.t0 - targetEpoch).toFixed(2)));
  }
}

const combined = {
  targetEpoch,
  query: {
    concurrency: QUERIES,
    calls: queryLatencies.length,
    errors: QUERIES - queryLatencies.length,
    startDebtMs: summary(queryDebts),
    ...summary(queryLatencies),
  },
  action: actionStats,
  fanout: {
    desiredViewers: CURVE[CURVE.length - 1] ?? 8000,
    subscribedViewers: fanoutExpected,
    received: fanoutLatencies.length,
    missing: fanoutMissing,
    coverage: fanoutExpected === 0 ? null : Number((fanoutLatencies.length / fanoutExpected).toFixed(4)),
    sendStartDebtMs: fanoutStartDebtMs,
    ...summary(fanoutLatencies),
  },
};
log(
  `combined: queries p95 ${combined.query.p95} ms (${combined.query.errors} errors), ` +
    `actions p95 ${combined.action.p95} ms (${combined.action.errors} errors), ` +
    `fan-out p95 ${combined.fanout.p95} ms (${combined.fanout.missing} missing)`,
);

// ---------------------------------------------------------------------------- 40 groups × 200

log("reshaping to 40 groups × 200 viewers");
await clearAndCooldown("the 40-group phase");

const fanoutAssignments = Array.from({ length: WORKERS }, () => []);
const fanoutSets = new Map();
for (let groupIndex = 0; groupIndex < FANOUT_GROUPS; groupIndex += 1) {
  const key = `fanout-${String(groupIndex).padStart(2, "0")}`;
  const indices = [];
  for (let k = 0; k < VIEWERS_PER_GROUP; k += 1) {
    const globalIndex = groupIndex * VIEWERS_PER_GROUP + k;
    if (globalIndex >= totalConnected) break;
    indices.push(globalIndex);
    const { worker, local } = locate(globalIndex);
    fanoutAssignments[worker].push({ session: local, key, publicId: groups[key] });
  }
  fanoutSets.set(key, indices);
}

const fanoutSubscribeStarted = absNow();
const fanoutSubDone = workers.map((worker) => waitMessage(worker, "subscribe-done", 240_000));
workers.forEach((worker) => worker.child.send({ type: "subscribe", entries: fanoutAssignments[worker.index] }));
const fanoutSubResults = await Promise.all(fanoutSubDone);
let fanoutAssigned = 0;
for (const result of fanoutSubResults) {
  for (const count of Object.values(result.counts)) fanoutAssigned += count;
  for (const entry of result.failures ?? []) recordFailure("subscription", entry);
}
await sleep(500);
const fanoutHealth = await health();
const fanoutCounts = {};
for (const key of fanoutSets.keys()) fanoutCounts[key] = fanoutHealth.readyByKey[key] ?? 0;
const fanoutReady = Object.values(fanoutCounts).reduce((sum, count) => sum + count, 0);
if (fanoutReady < fanoutAssigned) {
  recordFailure("subscription", {
    class: "connection",
    message: `${fanoutAssigned - fanoutReady}/${fanoutAssigned} 40-group subscriptions were no longer ready at the health check`,
  });
}
log(
  `40-group subscriptions ready in ${((absNow() - fanoutSubscribeStarted) / 1000).toFixed(1)}s; ` +
    `${fanoutReady}/${fanoutAssigned} viewers (${fanoutHealth.connectedSessions} sockets up)`,
);

const fanoutKeys = [...fanoutSets.keys()];
const fanoutTexts = new Map(
  fanoutKeys.map((key) => [key, `s5v2 40g ${key} ${stamp} ${Math.random().toString(36).slice(2)}`]),
);
for (const key of fanoutKeys) receipts.set(key, []);
await arm(fanoutKeys.map((key) => ({ key, text: fanoutTexts.get(key) })));

const fanoutTarget = absNow() + 3000;
await sleepUntil(fanoutTarget);
const groupSends = await Promise.all(
  fanoutKeys.map(async (key) => {
    const t0 = absNow();
    await ownerWs.mutation(api.messages.send, {
      conversation: { kind: "group", publicId: groups[key] },
      text: fanoutTexts.get(key),
    });
    return { key, t0 };
  }),
);
const sendByKey = new Map(groupSends.map((entry) => [entry.key, entry.t0]));
const expectedFanout = fanoutKeys.reduce((sum, key) => sum + (fanoutCounts[key] ?? 0), 0);
const deadline = absNow() + 240_000;
while (
  [...receipts].filter(([key]) => fanoutKeys.includes(key)).reduce((sum, [, list]) => sum + list.length, 0) < expectedFanout &&
  absNow() < deadline
) {
  await sleep(100);
}

const perGroup = [];
const aggregateLatencies = [];
for (const key of fanoutKeys) {
  const expected = fanoutCounts[key] ?? 0;
  const t0 = sendByKey.get(key);
  const latencies = (receipts.get(key) ?? []).map((t1) => Number((t1 - t0).toFixed(2)));
  aggregateLatencies.push(...latencies);
  const missing = Math.max(0, expected - latencies.length);
  if (missing > 0) {
    recordFailure("fanout40", {
      class: "receipt_timeout",
      message: `${key}: ${missing}/${expected} viewers missed the probe within 240 s`,
    });
  }
  perGroup.push({
    key,
    expected,
    received: latencies.length,
    missing,
    ...summary(latencies),
  });
}
const fanout40 = {
  groups: FANOUT_GROUPS,
  viewersRequested: FANOUT_GROUPS * VIEWERS_PER_GROUP,
  viewersSubscribed: expectedFanout,
  messagesSent: groupSends.length,
  startDebtMs: summary(groupSends.map((entry) => Number((entry.t0 - fanoutTarget).toFixed(2)))),
  ...summary(aggregateLatencies),
  perGroup,
};
log(
  `40×200: ${aggregateLatencies.length}/${expectedFanout} receipts, p50 ${fanout40.p50} ms, p95 ${fanout40.p95} ms, p99 ${fanout40.p99} ms`,
);

// ---------------------------------------------------------------------------- failures + evidence

const failuresByClass = {};
for (const entry of failures) {
  const key = `${entry.stage}:${entry.class}`;
  failuresByClass[key] = (failuresByClass[key] ?? 0) + 1;
}

const result = {
  ranAt: new Date().toISOString(),
  deployment: URL,
  production: PROD,
  region: "aws-us-east-1",
  orgPublicId: org.orgPublicId,
  parameters: {
    sessions: SESSIONS,
    workers: WORKERS,
    queries: QUERIES,
    actions: ACTIONS,
    actionUsers: ACTION_USERS,
    rampBatch: RAMP_BATCH,
    rampTimeoutMs: RAMP_TIMEOUT_MS,
    curve: CURVE,
    fanoutGroups: FANOUT_GROUPS,
    viewersPerGroup: VIEWERS_PER_GROUP,
  },
  sessionRamp: {
    requested: SESSIONS,
    attempted: workers.reduce((sum, worker) => sum + worker.attempted, 0),
    connected: totalConnected,
    shortfall: SESSIONS - totalConnected,
    rampSeconds,
    budgetExceeded: rampBudgetExceeded,
    perWorker: workers.map((worker) => {
      const byClass = {};
      for (const entry of worker.rampFailures) byClass[entry.class] = (byClass[entry.class] ?? 0) + 1;
      return {
        worker: worker.index,
        attempted: worker.attempted,
        connected: worker.connected,
        rampSeconds: worker.rampSeconds,
        rssMb: worker.rssMb,
        stopped: worker.stopped,
        capped: worker.capped ?? null,
        failures: worker.rampFailures.length,
        failuresByClass: byClass,
      };
    }),
  },
  curve,
  combined,
  fanout40,
  failures: {
    total: failures.length,
    byClass: failuresByClass,
    samples: failures.slice(0, 80),
  },
  notes: [
    "Sessions are separate OS generator processes; each session is an authenticated Convex WebSocket client with a live messages.listLive subscription.",
    "Curve viewers are exact subscription sets; curve groups are separate so one fan-out cannot trigger another size.",
    "T0 is the instant immediately before the send mutation is issued; T1 is the subscription callback in the worker process. Both processes share one clock. This measures user-perceived send-to-receive latency, including the caller's WebSocket queue, rather than excluding it by starting at the mutation's return.",
    `The combined burst starts ${QUERIES} one-shot queries, ${ACTIONS} messages.send mutations across the action-user pool, and the ${CURVE[CURVE.length - 1]}-viewer fan-out at one target epoch.`,
    "Each action sends to its own throwaway action group, so 512 concurrent action writes are measured without turning the benchmark into a single groupActivity document-conflict test.",
    "The 40-group phase sends one message per group (40 inserts) to 8,000 distinct viewers; no per-recipient writes.",
    "Failures are classified as ramp, subscription, query, action, fanout, fanout40, or worker, then grouped by class.",
  ],
};

const evidenceBase = PROD ? "s5-prod" : "s5-v2";

writeFileSync(join(evidenceDir, `${evidenceBase}-result.json`), JSON.stringify(result, null, 2));

const lines = [];
lines.push("# S5 v2 distributed result", "");
lines.push(`Run: ${result.ranAt}  `);
lines.push(`Deployment: ${URL}  `);
lines.push(`Sessions: **${totalConnected}/${SESSIONS}** across ${WORKERS} processes in ${rampSeconds}s  `);
lines.push(`Session shortfall: **${SESSIONS - totalConnected}**  `);
lines.push("");
lines.push("## Fan-out curve", "");
lines.push("| Viewers requested | Subscribed | Received | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |");
lines.push("|---:|---:|---:|---:|---:|---:|---:|");
for (const row of curve) {
  lines.push(
    `| ${row.requestedViewers} | ${row.subscribedViewers} | ${row.received} | ${row.p50 ?? "-"} | ${row.p95 ?? "-"} | ${row.p99 ?? "-"} | ${row.max ?? "-"} |`,
  );
}
lines.push("");
lines.push("## Combined burst at " + (CURVE[CURVE.length - 1] ?? 0) + " target viewers", "");
lines.push(`- Queries: ${combined.query.calls}/${QUERIES}, p95 ${combined.query.p95} ms, errors ${combined.query.errors}`);
lines.push(`- Actions: ${combined.action.n}/${ACTIONS}, p95 ${combined.action.p95} ms, errors ${combined.action.errors}`);
lines.push(`- Fan-out: ${combined.fanout.received}/${combined.fanout.subscribedViewers}, p95 ${combined.fanout.p95} ms, missing ${combined.fanout.missing}`);
lines.push("");
lines.push("## 40 groups × 200", "");
lines.push(`- Viewers: ${fanout40.viewersSubscribed}, receipts ${fanout40.n}, p95 ${fanout40.p95} ms, missing ${fanout40.viewersSubscribed - fanout40.n}`);
lines.push("");
lines.push("## Session ramp", "");
lines.push("| Worker | Attempted | Connected | Seconds | Failures | RSS MB | Capped |");
lines.push("|---:|---:|---:|---:|---:|---:|---|");
for (const row of result.sessionRamp.perWorker) {
  lines.push(
    `| ${row.worker} | ${row.attempted} | ${row.connected} | ${row.rampSeconds} | ${row.failures} | ${row.rssMb} | ${row.capped ?? ""} |`,
  );
}
lines.push("");
lines.push(`Failures by class: ${JSON.stringify(failuresByClass)}`);
lines.push("");
writeFileSync(join(evidenceDir, `${evidenceBase}-summary.md`), `${lines.join("\n")}\n`);

log(`evidence: evidence/${evidenceBase}-result.json, evidence/${evidenceBase}-summary.md`);
log("closing workers");
const closeDone = workers.map((worker) => waitMessage(worker, "close-done", 120_000).catch(() => null));
workers.forEach((worker) => worker.child.send({ type: "close" }));
await Promise.all(closeDone);
await Promise.all(actionClients.map((client) => client.close().catch(() => {})));
await ownerWs.close().catch(() => {});
if (PROD) {
  try {
    const purged = purgeOrg(org.orgPublicId);
    log(`purged production S5 tenant: ${JSON.stringify(purged)}`);
  } catch (error) {
    log(`production S5 tenant purge failed: ${String(error.message ?? error)}`);
  }
}
log("done");
process.exit(0);
