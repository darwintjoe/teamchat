// S5 — concurrent sessions / queries / actions burst against the dev deployment.
//
//   node scripts/s5-burst.mjs [--sessions=10000] [--queries=256] [--actions=512]
//
// What is measured (and what is not):
//   * sessions  : real authenticated WebSocket clients, each holding a live `messages.listLive`
//                 subscription on one group. This is the connection count the S256 class prices.
//   * queries   : N concurrent one-shot `messages.listLive` calls fired simultaneously, R rounds.
//   * actions   : N concurrent `messages.send` mutations fired simultaneously to a group with no
//                 live subscribers (so the measurement is action throughput, not fan-out).
//   * fan-out   : ONE message to the group every session is watching; latency from send return to
//                 each subscription callback, i.e. the re-run cost the PRD warns about.
//
// The dev deployment is not guaranteed to be S256-class. If the ramp hits a hard limit, the script
// stops, reports the achieved session count, and still runs the bursts at that scale. The result is
// written to app/evidence/s5-result.json.

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const URL = process.env.CONVEX_URL ?? "https://adventurous-squirrel-356.convex.cloud";
const ORG_PUBLIC_ID = process.env.S5_ORG ?? "org_rgxyfa3ehf1d";
const EMAIL = process.env.S5_EMAIL ?? "demo.owner@teamchat.test";

function arg(name, fallback) {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (hit === undefined) return fallback;
  return Number(hit.slice(name.length + 3));
}

const SESSIONS = arg("sessions", 10_000);
const QUERIES = arg("queries", 256);
const ACTIONS = arg("actions", 512);
const BATCH = arg("batch", 250);
const QUERY_ROUNDS = arg("query-rounds", 5);
const RAMP_BUDGET_MS = arg("ramp-budget-ms", 8 * 60 * 1000);
const MEMORY_LIMIT_MB = arg("memory-limit-mb", 4200);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

function summary(values) {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length === 0 ? null : Number(Math.max(...values).toFixed(2)),
  };
}

function rssMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

// ---------------------------------------------------------------------------- auth

const auth = new ConvexClient(URL);
await auth.action(api.auth.signIn, { provider: "email", params: { email: EMAIL } });
let code = null;
for (let i = 0; i < 60; i++) {
  const echo = await auth.query(api.auth.demo.getEchoedCode, { email: EMAIL });
  if (echo !== null) {
    code = echo.code;
    break;
  }
  await sleep(200);
}
if (code === null) throw new Error("S5: no echoed OTP code");
const signedIn = await auth.action(api.auth.signIn, {
  provider: "email",
  params: { email: EMAIL, code },
});
const token = signedIn.tokens.token;
auth.setAuth(async () => token);
await sleep(600);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const liveGroup = await auth.mutation(api.groups.create, {
  orgPublicId: ORG_PUBLIC_ID,
  name: `S5 live ${stamp}`,
});
const writeGroup = await auth.mutation(api.groups.create, {
  orgPublicId: ORG_PUBLIC_ID,
  name: `S5 write ${stamp}`,
});
const liveConversation = { kind: "group", publicId: liveGroup.groupPublicId };
const writeConversation = { kind: "group", publicId: writeGroup.groupPublicId };
console.log(`[s5] groups: live=${liveGroup.groupPublicId} write=${writeGroup.groupPublicId}`);

// ---------------------------------------------------------------------------- action user pool
//
// 512 concurrent sends from ONE user would serialise on that user's membership row (the sender
// exception patches it), which measures a hotspot rather than deployment capacity. Create a pool
// of real users instead, join them to the write group, and spread the burst across them.

const ACTION_USERS = Math.min(64, Math.max(1, Math.ceil(ACTIONS / 8)));

const inviteTokens = [];
for (let i = 0; i < ACTION_USERS; i++) {
  const invite = await auth.mutation(api.invites.create, { orgPublicId: ORG_PUBLIC_ID });
  inviteTokens.push(invite.token);
}
console.log(`[s5] created ${inviteTokens.length} single-use invites for the action pool`);

async function createUser(index, inviteToken) {
  const email = `s5.user${String(index).padStart(3, "0")}@teamchat.test`;
  const client = new ConvexClient(URL);
  await client.action(api.auth.signIn, { provider: "email", params: { email } });
  let userCode = null;
  for (let i = 0; i < 40; i++) {
    const echo = await client.query(api.auth.demo.getEchoedCode, { email });
    if (echo !== null) {
      userCode = echo.code;
      break;
    }
    await sleep(150);
  }
  if (userCode === null) throw new Error(`S5: no code for ${email}`);
  const result = await client.action(api.auth.signIn, {
    provider: "email",
    params: { email, code: userCode },
  });
  client.setAuth(async () => result.tokens.token);
  await sleep(300);
  await client.action(api.invites.redeem, { token: inviteToken });
  const me = await client.query(api.users.me, {});
  await auth.mutation(api.groups.addMember, {
    groupPublicId: writeGroup.groupPublicId,
    userPublicId: me.publicId,
  });
  return { client, token: result.tokens.token, publicId: me.publicId };
}

const actionUsers = [];
for (let offset = 0; offset < ACTION_USERS; offset += 8) {
  const chunk = await Promise.all(
    Array.from({ length: Math.min(8, ACTION_USERS - offset) }, (_, i) =>
      createUser(offset + i, inviteTokens[offset + i]),
    ),
  );
  actionUsers.push(...chunk);
  console.log(`[s5] action users ${actionUsers.length}/${ACTION_USERS}`);
}

// ---------------------------------------------------------------------------- sessions

const sessions = [];
let rampFailures = 0;
let stoppedReason = null;
const rampStarted = performance.now();

function openSession() {
  const client = new ConvexClient(URL);
  client.setAuth(async () => token);

  let resolveFirst;
  const firstValue = new Promise((resolve) => {
    resolveFirst = resolve;
  });

  const state = {
    client,
    ready: false,
    errors: 0,
    fanoutSeenText: null,
    last: null,
    unsubscribe: null,
  };

  state.unsubscribe = client.onUpdate(
    api.messages.listLive,
    { conversation: liveConversation },
    (messages) => {
      state.last = messages;
      if (!state.ready) {
        state.ready = true;
        resolveFirst(true);
      }
      if (
        state.fanoutSeenText !== null &&
        messages.some((m) => m.text === state.fanoutSeenText)
      ) {
        state.fanoutSeenText = null;
        if (fanout !== null) {
          fanout.latencies.push(performance.now() - fanout.startedAt);
          fanout.received += 1;
        }
      }
    },
    () => {
      state.errors += 1;
    },
  );

  return { state, firstValue };
}

let fanout = null;

for (let offset = 0; offset < SESSIONS; offset += BATCH) {
  const elapsed = performance.now() - rampStarted;
  if (elapsed > RAMP_BUDGET_MS) {
    stoppedReason = `ramp budget ${Math.round(RAMP_BUDGET_MS / 1000)}s exhausted`;
    break;
  }
  if (rssMb() > MEMORY_LIMIT_MB) {
    stoppedReason = `process RSS ${rssMb()} MB above ${MEMORY_LIMIT_MB} MB`;
    break;
  }

  const size = Math.min(BATCH, SESSIONS - offset);
  const batch = Array.from({ length: size }, () => openSession());
  const settled = await Promise.all(
    batch.map(({ firstValue }) =>
      Promise.race([firstValue, sleep(25_000).then(() => false)]),
    ),
  );
  const ready = settled.filter(Boolean).length;
  rampFailures += size - ready;
  for (const entry of batch) sessions.push(entry.state);
  console.log(
    `[s5] sessions ${sessions.length}/${SESSIONS} (batch +${ready}/${size}, failures ${rampFailures}, rss ${rssMb()} MB, ${Math.round((performance.now() - rampStarted) / 1000)}s)`,
  );
  if (ready < size * 0.8) {
    stoppedReason = `batch had ${size - ready}/${size} failures`;
    break;
  }
}

const activeSessions = sessions.filter((s) => s.ready);
const sessionStats = {
  requested: SESSIONS,
  connected: activeSessions.length,
  failures: rampFailures,
  stoppedReason,
  rampSeconds: Number(((performance.now() - rampStarted) / 1000).toFixed(1)),
  rssMb: rssMb(),
};
console.log(`[s5] ramp done: ${JSON.stringify(sessionStats)}`);

// ---------------------------------------------------------------------------- query burst
//
// One round only: Convex caches one-shot query results per client, so a second identical round
// would measure the local cache, not the deployment. 256 simultaneous first-time queries is the
// S256 metric ("256 concurrent queries"), not sustained QPS.

const queryLatencies = [];
const queryErrors = [];
const queryClients = activeSessions.slice(0, Math.max(QUERIES, 1));

{
  const started = performance.now();
  await Promise.all(
    queryClients.map(async (session) => {
      const t0 = performance.now();
      try {
        await session.client.query(api.messages.listLive, { conversation: writeConversation });
        queryLatencies.push(performance.now() - t0);
      } catch (error) {
        queryErrors.push(String(error));
      }
    }),
  );
  console.log(
    `[s5] query burst: ${queryClients.length} concurrent, ${Math.round(performance.now() - started)} ms wall`,
  );
}

const queryStats = {
  concurrency: queryClients.length,
  calls: queryLatencies.length + queryErrors.length,
  errors: queryErrors.length,
  firstError: queryErrors[0] ?? null,
  ...summary(queryLatencies),
};

// ---------------------------------------------------------------------------- action burst

const actionLatencies = [];
const actionErrors = [];

{
  const started = performance.now();
  await Promise.all(
    Array.from({ length: ACTIONS }, async (_, index) => {
      const user = actionUsers[index % actionUsers.length];
      const t0 = performance.now();
      try {
        await user.client.mutation(api.messages.send, {
          conversation: writeConversation,
          text: `s5 action ${index} ${Date.now()}`,
        });
        actionLatencies.push(performance.now() - t0);
      } catch (error) {
        actionErrors.push(String(error));
      }
    }),
  );
  console.log(
    `[s5] action burst: ${ACTIONS} concurrent sends across ${actionUsers.length} users, ${Math.round(performance.now() - started)} ms wall`,
  );
}

const actionStats = {
  concurrency: ACTIONS,
  users: actionUsers.length,
  calls: actionLatencies.length + actionErrors.length,
  errors: actionErrors.length,
  firstError: actionErrors[0] ?? null,
  ...summary(actionLatencies),
};

// ---------------------------------------------------------------------------- fan-out (one message, every live session)

const fanoutSessions = activeSessions.filter((s) => s.ready);
const probeText = `s5 fanout probe ${stamp}`;
fanout = {
  startedAt: performance.now(),
  latencies: [],
  received: 0,
  timedOut: false,
  probeText,
};

if (fanoutSessions.length > 0) {
  for (const session of fanoutSessions) session.fanoutSeenText = probeText;
  fanout.startedAt = performance.now();
  await auth.mutation(api.messages.send, {
    conversation: liveConversation,
    text: probeText,
  });

  const deadline = performance.now() + 120_000;
  while (fanout.received < fanoutSessions.length && performance.now() < deadline) {
    await sleep(100);
  }
  fanout.timedOut = fanout.received < fanoutSessions.length;
  const fanoutStats = {
    subscribers: fanoutSessions.length,
    received: fanout.received,
    timedOut: fanout.timedOut,
    coverage: fanoutSessions.length === 0 ? null : Number((fanout.received / fanoutSessions.length).toFixed(3)),
    ...summary(fanout.latencies),
  };
  console.log(`[s5] fan-out: ${JSON.stringify(fanoutStats)}`);

  // -------------------------------------------------------------------------- report

  const result = {
    ranAt: new Date().toISOString(),
    deployment: URL,
    region: "aws-us-east-1",
    classTarget: { sessions: 10_000, queries: 256, actions: 512 },
    sessions: sessionStats,
    queries: queryStats,
    actions: actionStats,
    fanout: fanoutStats,
    notes: [
      "Sessions are authenticated WebSocket clients each holding one live subscription on the same group.",
      "Query burst uses one-shot queries (not cached subscriptions); actions are messages.send to a group with no live subscribers.",
      "Fan-out is one message to the group all sessions watch; latency is send-response to subscription callback.",
      "The dev deployment's class limits are not exposed to the CLI; a hard stop in the ramp is a deployment limit, not a client bug.",
    ],
  };
  fs.mkdirSync(path.join(process.cwd(), "evidence"), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), "evidence", "s5-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(`[s5] wrote evidence/s5-result.json`);
} else {
  console.log("[s5] no live sessions; skipping fan-out");
}

// ---------------------------------------------------------------------------- cleanup

for (let offset = 0; offset < sessions.length; offset += 200) {
  await Promise.all(sessions.slice(offset, offset + 200).map((session) => session.client.close()));
}
for (const user of actionUsers) await user.client.close();
await auth.close();
console.log("[s5] closed sessions");
