// S5 v2 — one scenario per fresh generator fleet.
//
//   node scripts/s5-v2-scenario.mjs --scenario=curve500
//   node scripts/s5-v2-scenario.mjs --scenario=curve8000   # also runs the combined burst
//   node scripts/s5-v2-scenario.mjs --scenario=fanout40
//
// Why one scenario per process: the first two attempts reused one 8k fleet across the whole curve.
// Tearing down one viewer set before subscribing the next made the deployment cancel thousands of
// query sets while the next probe ran. That measured teardown and dropped sockets, not fan-out. A
// fresh ramp per point keeps exactly one subscription set alive, which is the condition being
// priced. The master script merges these per-scenario files into s5-v2-result.json.

import { fork } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { appDir, classifyError, deploymentUrl, summary } from "./lib/harness.mjs";
import { ensureUsers, s5Emails } from "./lib/s5-auth.mjs";
import { ensureProdSessions, loadPrivateKey, runInternal } from "./lib/prod-session.mjs";
import { startSampler } from "./lib/net-telemetry.mjs";

const absNow = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepUntil = async (epoch) => {
  const wait = epoch - absNow();
  if (wait > 0) await sleep(wait);
};

function arg(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (hit === undefined) return fallback;
  const raw = hit.slice(name.length + 3);
  return Number.isNaN(Number(raw)) ? raw : Number(raw);
}

const PROD = arg("prod", process.env.S5_PROD === "true");
const URL = PROD
  ? process.env.CONVEX_URL ?? "https://benevolent-crocodile-386.convex.cloud"
  : deploymentUrl();
const SCENARIO = String(arg("scenario", "curve500"));
const SESSIONS = arg("sessions", 10_000);
const WORKERS = Math.max(4, Math.min(6, arg("workers", 4)));
const QUERIES = arg("queries", 256);
const ACTIONS = arg("actions", 512);
const ACTION_USERS = arg("action-users", 8);
const RAMP_BUDGET_MS = arg("ramp-budget-ms", 8 * 60 * 1000);
const RAMP_BATCH = arg("ramp-batch", 100);
const RAMP_TIMEOUT_MS = arg("ramp-timeout-ms", 20_000);
const FANOUT_GROUPS = 40;
const VIEWERS_PER_GROUP = 200;
const BASELINE_VIEWERS = arg("viewers", 4000);
const TELEMETRY_INTERVAL_MS = arg("telemetry-interval-ms", 10_000);

const curveSize =
  SCENARIO.startsWith("curve") ? Number(SCENARIO.slice("curve".length)) : null;
if (curveSize === null && SCENARIO !== "fanout40" && SCENARIO !== "sequential") {
  throw new Error(`unknown --scenario=${SCENARIO}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = join(appDir, "evidence");
mkdirSync(evidenceDir, { recursive: true });

const failures = [];
function recordFailure(stage, errorOrEntry, extra = {}) {
  const entry =
    errorOrEntry && typeof errorOrEntry === "object" && errorOrEntry.class
      ? { ...errorOrEntry, stage: errorOrEntry.stage ?? stage, ...extra }
      : {
          stage,
          class: classifyError(errorOrEntry),
          message: String(errorOrEntry?.message ?? errorOrEntry).slice(0, 300),
          ...extra,
        };
  failures.push(entry);
  return entry;
}
const log = (message) =>
  console.log(`[s5v2 ${SCENARIO} ${new Date().toISOString().slice(11, 19)}] ${message}`);

function purgeOrg(orgPublicId) {
  let last = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = runInternal("purgeTenant", { orgPublicId, deleteUsers: true, maxGroups: 50 });
    if (last.removed) return last;
  }
  throw new Error(`purge did not finish: ${JSON.stringify(last)}`);
}

// ---------------------------------------------------------------------------- auth + org + groups

log("refreshing cached S5 users");
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
  name: `S5 v2 ${SCENARIO} ${stamp}`,
  allowDirectMessages: false,
});
const groups = {};
const groupNames =
  SCENARIO === "fanout40"
    ? Array.from({ length: FANOUT_GROUPS }, (_, index) => `fanout-${String(index).padStart(2, "0")}`)
    : [SCENARIO, "write"];
for (const name of groupNames) {
  const created = await admin.mutation(api.groups.create, {
    orgPublicId: org.orgPublicId,
    name: `S5v2 ${name} ${stamp}`,
    parentGroupPublicId: org.rootGroupPublicId,
  });
  groups[name] = created.groupPublicId;
}
log(`org ${org.orgPublicId}, ${groupNames.length} groups`);

const writeConversation = { kind: "group", publicId: groups.write };
for (const user of actionUsers) {
  const invite = await admin.mutation(api.invites.create, { orgPublicId: org.orgPublicId });
  const client = new ConvexHttpClient(URL);
  client.setAuth(user.token);
  await client.action(api.invites.redeem, { token: invite.token });
  if (groups.write) {
    await admin.mutation(api.groups.addMember, {
      groupPublicId: groups.write,
      userPublicId: user.publicId,
    });
  }
}
const ownerWs = new ConvexClient(URL, { logger: false });
ownerWs.setAuth(async () => owner.token);
const actionClients = actionUsers.map((user) => {
  const client = new ConvexClient(URL, { logger: false });
  client.setAuth(async () => user.token);
  return client;
});

// ---------------------------------------------------------------------------- workers

const receipts = new Map();

function startWorker(index) {
  const child = fork(join(appDir, "scripts", "s5-v2-worker.mjs"), [], {
    cwd: appDir,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const worker = {
    index,
    pid: null,
    child,
    queued: [],
    waiters: [],
    attempted: 0,
    connected: 0,
    rampSeconds: null,
    rssMb: null,
    stopped: false,
    capped: null,
    rampFailures: [],
    counters: null,
  };
  child.on("message", (message) => {
    if (message.type === "ramp-progress") {
      worker.attempted = message.attempted;
      worker.connected = message.connected;
      worker.rssMb = message.rssMb;
      if (message.counters) worker.counters = message.counters;
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
    for (const waiter of worker.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`worker ${index} exit ${code} ${signal ?? ""}`));
    }
  });
  return worker;
}

function waitMessage(worker, type, timeoutMs = 60_000) {
  const index = worker.queued.findIndex((message) => message.type === type);
  if (index >= 0) return Promise.resolve(worker.queued.splice(index, 1)[0]);
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

const workerList = Array.from({ length: WORKERS }, (_, index) => startWorker(index));
const readyMessages = await Promise.all(
  workerList.map((worker) => waitMessage(worker, "worker-ready", 30_000)),
);
workerList.forEach((worker, index) => {
  worker.pid = readyMessages[index].pid ?? null;
});
const socketTelemetry = startSampler({
  pids: workerList.map((worker) => worker.pid).filter(Boolean),
  intervalMs: TELEMETRY_INTERVAL_MS,
});
log(`${workerList.length} generators ready, pids ${workerList.map((worker) => worker.pid).join(",")}`);

const perWorkerTarget = Array.from(
  { length: WORKERS },
  (_, index) => Math.floor(SESSIONS / WORKERS) + (index < SESSIONS % WORKERS ? 1 : 0),
);
const rampStarted = absNow();
const rampDone = workerList.map((worker) =>
  waitMessage(worker, "ramp-done", RAMP_BUDGET_MS + 120_000),
);
workerList.forEach((worker) => {
  worker.child.send({
    type: "init",
    url: URL,
    token: owner.token,
    worker: worker.index,
    holdConversation: null,
    target: perWorkerTarget[worker.index],
    rampBatch: RAMP_BATCH,
    rampTimeoutMs: RAMP_TIMEOUT_MS,
  });
});
const rampResults = await Promise.all(rampDone);
rampResults.forEach((result, index) => {
  const worker = workerList[index];
  worker.attempted = result.attempted;
  worker.connected = result.connected;
  worker.rampSeconds = result.elapsedSeconds;
  worker.rssMb = result.rssMb;
  worker.stopped = result.stopped;
  worker.rampFailures = result.failures ?? [];
  for (const entry of worker.rampFailures) recordFailure("ramp", entry, { worker: index });
  log(
    `worker ${index}: ${result.connected}/${result.attempted} connected in ${result.elapsedSeconds}s, ` +
      `${result.failures.length} failures, rss ${result.rssMb} MB`,
  );
});
const totalConnected = workerList.reduce((sum, worker) => sum + worker.connected, 0);
const rampSeconds = Number(((absNow() - rampStarted) / 1000).toFixed(1));
const rampFailuresByClass = {};
for (const entry of failures.filter((failure) => failure.stage === "ramp")) {
  rampFailuresByClass[entry.class] = (rampFailuresByClass[entry.class] ?? 0) + 1;
}
log(`ramp ${totalConnected}/${SESSIONS} in ${rampSeconds}s; ramp failures ${JSON.stringify(rampFailuresByClass)}`);
if (failures.some((failure) => failure.stage === "ramp")) {
  log(`first ramp failure: ${JSON.stringify(failures.find((failure) => failure.stage === "ramp"))}`);
}
if (totalConnected === 0) throw new Error("no sessions connected");

const offsets = [];
{
  let offset = 0;
  for (const worker of workerList) {
    offsets.push(offset);
    offset += worker.connected;
  }
}
function locate(globalIndex) {
  for (let index = workerList.length - 1; index >= 0; index -= 1) {
    if (globalIndex >= offsets[index]) return { worker: index, local: globalIndex - offsets[index] };
  }
  throw new Error(`global index ${globalIndex} out of range`);
}
function viewerIndices(requested) {
  const actual = Math.min(requested, totalConnected);
  return Array.from({ length: actual }, (_, k) => Math.floor((k * totalConnected) / actual));
}
function assignmentFor(key, indices) {
  const assignments = Array.from({ length: WORKERS }, () => []);
  for (const globalIndex of indices) {
    const { worker, local } = locate(globalIndex);
    assignments[worker].push({ session: local, key, publicId: groups[key] });
  }
  return assignments;
}
async function subscribePhase(key, indices) {
  const assignments = assignmentFor(key, indices);
  const started = absNow();
  const done = workerList.map((worker) => waitMessage(worker, "subscribe-done", 240_000));
  workerList.forEach((worker) =>
    worker.child.send({ type: "subscribe", entries: assignments[worker.index] }),
  );
  const results = await Promise.all(done);
  let assigned = 0;
  for (const result of results) {
    assigned += result.counts[key] ?? 0;
    for (const entry of result.failures ?? []) recordFailure("subscription", entry);
  }
  await sleep(500);
  const healthDone = workerList.map((worker) => waitMessage(worker, "health-done", 30_000));
  workerList.forEach((worker) => worker.child.send({ type: "health" }));
  const health = await Promise.all(healthDone);
  const readyByKey = {};
  let connectedSessions = 0;
  for (const result of health) {
    connectedSessions += result.connectedSessions;
    for (const [name, count] of Object.entries(result.readyByKey)) {
      readyByKey[name] = (readyByKey[name] ?? 0) + count;
    }
  }
  const failuresForPhase = results.flatMap((result) => result.failures ?? []);
  if (failuresForPhase.length > 0) {
    const byClass = {};
    for (const entry of failuresForPhase) byClass[entry.class] = (byClass[entry.class] ?? 0) + 1;
    log(`subscription failures: ${JSON.stringify(byClass)}`);
    log(`first subscription failure: ${JSON.stringify(failuresForPhase[0])}`);
  }
  const ready = readyByKey[key] ?? 0;
  if (ready < assigned) {
    recordFailure("subscription", {
      class: "connection",
      message: `${assigned - ready}/${assigned} ${key} subscriptions were not ready at the health check`,
    });
  }
  log(
    `health: ready ${ready}, assigned ${assigned}, sockets ${connectedSessions}/${totalConnected}`,
  );
  return {
    assigned,
    ready,
    connectedSessions,
    seconds: Number(((absNow() - started) / 1000).toFixed(1)),
  };
}
async function arm(entries) {
  await Promise.all(
    workerList.map((worker) => {
      const ack = waitMessage(worker, "arm-ack", 30_000);
      worker.child.send({ type: "arm", entries });
      return ack;
    }),
  );
}
async function waitReceipts(key, expected, timeoutMs) {
  const list = receipts.get(key) ?? [];
  const deadline = absNow() + timeoutMs;
  while (list.length < expected && absNow() < deadline) await sleep(50);
  return list;
}
async function fanoutOne(key, conversation, text, expected, timeoutMs = 240_000) {
  receipts.set(key, []);
  await arm([{ key, text }]);
  await ownerWs.mutation(api.messages.send, { conversation, text });
  const t0 = absNow();
  const list = await waitReceipts(key, expected, timeoutMs);
  const latencies = list.map((t1) => Math.max(0, Number((t1 - t0).toFixed(2))));
  const missing = Math.max(0, expected - latencies.length);
  if (missing > 0) {
    recordFailure("fanout", {
      class: "receipt_timeout",
      message: `${missing}/${expected} subscribers missed ${key} within ${timeoutMs / 1000}s`,
    });
  }
  return {
    expected,
    received: latencies.length,
    missing,
    coverage: expected === 0 ? null : Number((latencies.length / expected).toFixed(4)),
    ...summary(latencies),
  };
}

let curve = null;
let combined = null;
let sequential = null;
let fanout40 = null;

if (curveSize !== null) {
  const key = SCENARIO;
  const indices = viewerIndices(curveSize);
  log(`subscribing ${indices.length}/${curveSize} viewers`);
  const subscription = await subscribePhase(key, indices);
  log(
    `${subscription.ready}/${indices.length} ready in ${subscription.seconds}s ` +
      `(${subscription.connectedSessions} sockets up)`,
  );
  const text = `s5v2 ${key} ${stamp} ${Math.random().toString(36).slice(2)}`;
  const result = await fanoutOne(key, { kind: "group", publicId: groups[key] }, text, subscription.ready);
  curve = {
    requestedViewers: curveSize,
    assignedViewers: subscription.assigned,
    subscribedViewers: subscription.ready,
    connectedSessions: subscription.connectedSessions,
    subscribeSeconds: subscription.seconds,
    ...result,
  };
  log(`fan-out ${result.received}/${result.expected}, p50 ${result.p50}, p95 ${result.p95}, p99 ${result.p99}`);

  if (curveSize === 8000 || arg("combined", false) === true || arg("combined", false) === "true") {
    log(`combined burst: 256 queries + 512 actions + one ${curveSize}-viewer fan-out`);
    receipts.set(key, []);
    const combinedText = `s5v2 combined ${stamp} ${Math.random().toString(36).slice(2)}`;
    const before = await (async () => {
      const done = workerList.map((worker) => waitMessage(worker, "health-done", 30_000));
      workerList.forEach((worker) => worker.child.send({ type: "health" }));
      const health = await Promise.all(done);
      const readyByKey = {};
      let connectedSessions = 0;
      for (const result of health) {
        connectedSessions += result.connectedSessions;
        for (const [name, count] of Object.entries(result.readyByKey)) {
          readyByKey[name] = (readyByKey[name] ?? 0) + count;
        }
      }
      return { fanoutExpected: readyByKey[key] ?? 0, connectedSessions };
    })();
    await arm([{ key, text: combinedText }]);
    const targetEpoch = absNow() + 3000;
    const queryCounts = Array.from(
      { length: WORKERS },
      (_, index) => Math.floor(QUERIES / WORKERS) + (index < QUERIES % WORKERS ? 1 : 0),
    );
    const queryDone = workerList.map((worker) => waitMessage(worker, "query-done", 240_000));
    workerList.forEach((worker, index) => {
      worker.child.send({
        type: "query-burst",
        targetEpoch,
        count: queryCounts[index],
        conversation: writeConversation,
      });
    });
    const fanoutSendPromise = sleepUntil(targetEpoch)
      .then(() =>
        ownerWs.mutation(api.messages.send, {
          conversation: { kind: "group", publicId: groups[key] },
          text: combinedText,
        }),
      )
      .then(() => absNow());
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
              conversation: writeConversation,
              text: `s5v2 action ${index} ${stamp}`,
            });
            latencies.push(Number((absNow() - t0).toFixed(2)));
          } catch (error) {
            errors += 1;
            recordFailure("action", error, { actionIndex: index });
          }
        }),
      );
      return { concurrency: ACTIONS, users: actionClients.length, errors, ...summary(latencies) };
    })();

    const t0Fanout = await fanoutSendPromise;
    const [queryResults, actionResult] = await Promise.all([Promise.all(queryDone), actionPromise]);
    const fanoutReceipts = await waitReceipts(key, before.fanoutExpected, 240_000);
    const fanoutLatencies = fanoutReceipts.map((t1) =>
      Math.max(0, Number((t1 - t0Fanout).toFixed(2))),
    );
    const queryLatencies = [];
    for (const result of queryResults) {
      for (const call of result.results ?? []) {
        if (!call.ok) recordFailure("query", call.error);
        else queryLatencies.push(Number((call.t1 - call.t0).toFixed(2)));
      }
    }
    const fanoutMissing = Math.max(0, before.fanoutExpected - fanoutLatencies.length);
    if (fanoutMissing > 0) {
      recordFailure("fanout", {
        class: "receipt_timeout",
        message: `${fanoutMissing}/${before.fanoutExpected} subscribers missed the combined ${curveSize}-viewer probe`,
      });
    }
    combined = {
      targetEpoch,
      query: {
        concurrency: QUERIES,
        calls: queryLatencies.length,
        errors: QUERIES - queryLatencies.length,
        ...summary(queryLatencies),
      },
      action: actionResult,
      fanout: {
        desiredViewers: curveSize,
        subscribedViewers: before.fanoutExpected,
        connectedSessions: before.connectedSessions,
        received: fanoutLatencies.length,
        missing: fanoutMissing,
        coverage:
          before.fanoutExpected === 0
            ? null
            : Number((fanoutLatencies.length / before.fanoutExpected).toFixed(4)),
        sendReturnDebtMs: Number((t0Fanout - targetEpoch).toFixed(2)),
        ...summary(fanoutLatencies),
      },
    };
    log(
      `combined: query p95 ${combined.query.p95}, action p95 ${combined.action.p95}, ` +
        `fan-out p95 ${combined.fanout.p95}, missing ${combined.fanout.missing}`,
    );
  }
}

if (SCENARIO === "sequential") {
  const started = absNow();
  log(`sequential baseline: ${QUERIES} queries one at a time, then ${ACTIONS} actions one at a time, then fan-out`);

  const queryIndices = viewerIndices(QUERIES);
  const queryLatencies = [];
  let queryErrors = 0;
  const queryStarted = absNow();
  for (const globalIndex of queryIndices) {
    const { worker, local } = locate(globalIndex);
    const done = waitMessage(workerList[worker], "query-one-done", 120_000);
    workerList[worker].child.send({
      type: "query-one",
      session: local,
      conversation: writeConversation,
    });
    const { result } = await done;
    if (!result.ok) {
      queryErrors += 1;
      recordFailure("query", result.error);
    } else {
      queryLatencies.push(Number((result.t1 - result.t0).toFixed(2)));
    }
  }
  const queryWallMs = Number((absNow() - queryStarted).toFixed(1));

  const actionLatencies = [];
  let actionErrors = 0;
  const actionStarted = absNow();
  for (let index = 0; index < ACTIONS; index += 1) {
    const client = actionClients[index % actionClients.length];
    const t0 = absNow();
    try {
      await client.mutation(api.messages.send, {
        conversation: writeConversation,
        text: `s5v2 sequential action ${index} ${stamp}`,
      });
      actionLatencies.push(Number((absNow() - t0).toFixed(2)));
    } catch (error) {
      actionErrors += 1;
      recordFailure("action", error, { actionIndex: index });
    }
  }
  const actionWallMs = Number((absNow() - actionStarted).toFixed(1));

  const indices = viewerIndices(BASELINE_VIEWERS);
  log(`subscribing ${indices.length}/${BASELINE_VIEWERS} viewers for sequential fan-out`);
  const subscription = await subscribePhase(SCENARIO, indices);
  const text = `s5v2 sequential ${stamp} ${Math.random().toString(36).slice(2)}`;
  const fanout = await fanoutOne(
    SCENARIO,
    { kind: "group", publicId: groups[SCENARIO] },
    text,
    subscription.ready,
  );

  sequential = {
    query: {
      concurrency: 1,
      calls: queryLatencies.length + queryErrors,
      errors: queryErrors,
      wallMs: queryWallMs,
      ...summary(queryLatencies),
    },
    action: {
      concurrency: 1,
      calls: actionLatencies.length + actionErrors,
      errors: actionErrors,
      wallMs: actionWallMs,
      ...summary(actionLatencies),
    },
    fanout: {
      desiredViewers: BASELINE_VIEWERS,
      subscribedViewers: subscription.ready,
      connectedSessions: subscription.connectedSessions,
      subscribeSeconds: subscription.seconds,
      ...fanout,
    },
    totalWallMs: Number((absNow() - started).toFixed(1)),
  };
  log(
    `sequential: query p95 ${sequential.query.p95} (${sequential.query.wallMs} ms wall), ` +
      `action p95 ${sequential.action.p95} (${sequential.action.wallMs} ms wall), ` +
      `fan-out p95 ${sequential.fanout.p95}`,
  );
}

if (SCENARIO === "fanout40") {
  const assignments = Array.from({ length: WORKERS }, () => []);
  const sets = new Map();
  for (let groupIndex = 0; groupIndex < FANOUT_GROUPS; groupIndex += 1) {
    const key = `fanout-${String(groupIndex).padStart(2, "0")}`;
    const indices = [];
    for (let k = 0; k < VIEWERS_PER_GROUP; k += 1) {
      const globalIndex = groupIndex * VIEWERS_PER_GROUP + k;
      if (globalIndex >= totalConnected) break;
      indices.push(globalIndex);
      const { worker, local } = locate(globalIndex);
      assignments[worker].push({ session: local, key, publicId: groups[key] });
    }
    sets.set(key, indices);
  }
  const started = absNow();
  const done = workerList.map((worker) => waitMessage(worker, "subscribe-done", 240_000));
  workerList.forEach((worker) =>
    worker.child.send({ type: "subscribe", entries: assignments[worker.index] }),
  );
  const results = await Promise.all(done);
  let assigned = 0;
  for (const result of results) {
    for (const count of Object.values(result.counts)) assigned += count;
    for (const entry of result.failures ?? []) recordFailure("subscription", entry);
  }
  await sleep(500);
  const healthDone = workerList.map((worker) => waitMessage(worker, "health-done", 30_000));
  workerList.forEach((worker) => worker.child.send({ type: "health" }));
  const health = await Promise.all(healthDone);
  const counts = {};
  let connectedSessions = 0;
  for (const result of health) {
    connectedSessions += result.connectedSessions;
    for (const [name, count] of Object.entries(result.readyByKey)) counts[name] = (counts[name] ?? 0) + count;
  }
  const ready = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (ready < assigned) {
    recordFailure("subscription", {
      class: "connection",
      message: `${assigned - ready}/${assigned} 40-group subscriptions were not ready at the health check`,
    });
  }
  log(`40 groups: ${ready}/${assigned} ready in ${((absNow() - started) / 1000).toFixed(1)}s, ${connectedSessions} sockets up`);

  const keys = [...sets.keys()];
  const texts = new Map(
    keys.map((key) => [key, `s5v2 40g ${key} ${stamp} ${Math.random().toString(36).slice(2)}`]),
  );
  for (const key of keys) receipts.set(key, []);
  await arm(keys.map((key) => ({ key, text: texts.get(key) })));
  const targetEpoch = absNow() + 3000;
  await sleepUntil(targetEpoch);
  const sends = await Promise.all(
    keys.map(async (key) => {
      await ownerWs.mutation(api.messages.send, {
        conversation: { kind: "group", publicId: groups[key] },
        text: texts.get(key),
      });
      return { key, t0: absNow() };
    }),
  );
  const sendByKey = new Map(sends.map((entry) => [entry.key, entry.t0]));
  const expected = keys.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  const deadline = absNow() + 240_000;
  while (
    keys.reduce((sum, key) => sum + (receipts.get(key) ?? []).length, 0) < expected &&
    absNow() < deadline
  ) {
    await sleep(100);
  }
  const perGroup = [];
  const aggregate = [];
  for (const key of keys) {
    const groupExpected = counts[key] ?? 0;
    const t0 = sendByKey.get(key);
    const latencies = (receipts.get(key) ?? []).map((t1) => Math.max(0, Number((t1 - t0).toFixed(2))));
    aggregate.push(...latencies);
    const missing = Math.max(0, groupExpected - latencies.length);
    if (missing > 0) {
      recordFailure("fanout40", {
        class: "receipt_timeout",
        message: `${key}: ${missing}/${groupExpected} viewers missed the probe`,
      });
    }
    perGroup.push({ key, expected: groupExpected, received: latencies.length, missing, ...summary(latencies) });
  }
  fanout40 = {
    groups: FANOUT_GROUPS,
    viewersRequested: FANOUT_GROUPS * VIEWERS_PER_GROUP,
    viewersSubscribed: expected,
    connectedSessions,
    messagesSent: sends.length,
    startDebtMs: summary(sends.map((entry) => Number((entry.t0 - targetEpoch).toFixed(2)))),
    ...summary(aggregate),
    perGroup,
  };
  log(`40×200: ${aggregate.length}/${expected}, p50 ${fanout40.p50}, p95 ${fanout40.p95}, p99 ${fanout40.p99}`);
}

// ---------------------------------------------------------------------------- evidence + cleanup

const failuresByClass = {};
for (const entry of failures) {
  const key = `${entry.stage}:${entry.class}`;
  failuresByClass[key] = (failuresByClass[key] ?? 0) + 1;
}

const failureSamples = [];
{
  const counts = new Map();
  for (const entry of failures) {
    const key = `${entry.stage}:${entry.class}`;
    const count = counts.get(key) ?? 0;
    if (count < 3) failureSamples.push(entry);
    counts.set(key, count + 1);
  }
}

const result = {
  ranAt: new Date().toISOString(),
  scenario: SCENARIO,
  deployment: URL,
  production: PROD,
  region: "aws-us-east-1",
  orgPublicId: org.orgPublicId,
  parameters: { sessions: SESSIONS, workers: WORKERS, queries: QUERIES, actions: ACTIONS, actionUsers: ACTION_USERS },
  sessionRamp: {
    requested: SESSIONS,
    attempted: workerList.reduce((sum, worker) => sum + worker.attempted, 0),
    connected: totalConnected,
    shortfall: SESSIONS - totalConnected,
    rampSeconds,
    perWorker: workerList.map((worker) => {
      const byClass = {};
      for (const entry of worker.rampFailures) byClass[entry.class] = (byClass[entry.class] ?? 0) + 1;
      return {
        worker: worker.index,
        pid: worker.pid,
        attempted: worker.attempted,
        connected: worker.connected,
        rampSeconds: worker.rampSeconds,
        rssMb: worker.rssMb,
        stopped: worker.stopped,
        capped: worker.capped,
        failures: worker.rampFailures.length,
        failuresByClass: byClass,
        counters: worker.counters,
      };
    }),
  },
  sockets: (() => {
    const telemetry = socketTelemetry.stop();
    const peak = telemetry.samples.reduce(
      (out, sample) => ({
        established: Math.max(out.established, sample.host?.established ?? 0),
        timeWait: Math.max(out.timeWait, sample.host?.timeWait ?? 0),
        ephemeralPortsInUse: Math.max(out.ephemeralPortsInUse, sample.ephemeralPortsInUse ?? 0),
        perPidEstablished: Object.fromEntries(
          Object.entries(sample.perPid ?? {}).map(([pid, row]) => [
            pid,
            Math.max(out.perPidEstablished[pid] ?? 0, row.established ?? 0),
          ]),
        ),
      }),
      { established: 0, timeWait: 0, ephemeralPortsInUse: 0, perPidEstablished: {} },
    );
    return {
      os: process.platform,
      dynamicPortRange: telemetry.portRange,
      addresses: telemetry.addresses,
      samples: telemetry.samples,
      peak,
    };
  })(),
  curve,
  combined,
  sequential,
  fanout40,
  failures: { total: failures.length, byClass: failuresByClass, samples: failureSamples },
};

const evidenceName = PROD ? `s5-prod-diag-${SCENARIO}.json` : `s5-v2-${SCENARIO}.json`;
writeFileSync(join(evidenceDir, evidenceName), JSON.stringify(result, null, 2));
log(`rerun evidence: evidence/${evidenceName}`);

const closeDone = workerList.map((worker) => waitMessage(worker, "close-done", 120_000).catch(() => null));
workerList.forEach((worker) => worker.child.send({ type: "close" }));
await Promise.all(closeDone);
await Promise.all(actionClients.map((client) => client.close().catch(() => {})));
await ownerWs.close().catch(() => {});
if (PROD) {
  try {
    const purged = purgeOrg(org.orgPublicId);
    log(`purged production diagnostic tenant: ${JSON.stringify(purged)}`);
  } catch (error) {
    log(`production diagnostic tenant purge failed: ${String(error.message ?? error)}`);
  }
}
log("done");
process.exit(0);
