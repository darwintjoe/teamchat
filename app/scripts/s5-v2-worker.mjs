// S5 v2 generator worker. One OS process = one generator. The master starts 4–6 of these and
// assigns each a slice of the 10,000 sessions.
//
// A worker owns authenticated Convex WebSocket clients, their live `messages.listLive`
// subscriptions, and the client-side receipt timestamps (T1). It never decides what to measure;
// the master sends commands and receives results over the Node IPC channel.

import { performance } from "node:perf_hooks";
import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { classifyError } from "./lib/harness.mjs";

const absNow = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let url = null;
let token = null;
let workerIndex = 0;
let holdConversation = null;
let rampBatch = 100;
let rampTimeoutMs = 25_000;
let stopRequested = false;

/** @type {Array<{client: ConvexClient, ready: boolean, subs: Map<string, any>}>} */
let sessions = [];
const armed = new Map();

// Host-side counters. These separate a deployment refusal from this process running out of
// sockets or ports; classifyError() alone cannot tell those apart.
const counters = {
  wsAttempts: 0,
  wsOpens: 0,
  wsReconnects: 0,
  wsCloseEvents: 0,
  wsErrors: 0,
  closeCodes: {},
  socketErrorCodes: {},
  rampClassification: {},
  subscriptionClassification: {},
};

function bump(object, key) {
  object[key] = (object[key] ?? 0) + 1;
}

function send(message) {
  if (process.connected) process.send(message);
}

function failure(stage, error, extra = {}) {
  return {
    stage,
    class: classifyError(error),
    message: String(error?.message ?? error).split("\n")[0].slice(0, 300),
    ...extra,
  };
}

/**
 * Per-session connection facts. The Convex client exposes retry counts but not the close code, so
 * each client gets its own WebSocket subclass that records `onclose`/`onerror` without changing
 * the client's behaviour.
 */
function newWsDiagnostics() {
  return {
    attempts: 0,
    opens: 0,
    closes: [],
    lastClose: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  };
}

function makeWebSocketClass(diagnostics) {
  const Base = globalThis.WebSocket;
  if (typeof Base !== "function") return undefined;
  return class InstrumentedWebSocket extends Base {
    constructor(url, protocols) {
      super(url, protocols);
      diagnostics.attempts += 1;
      counters.wsAttempts += 1;
      this.addEventListener("open", () => {
        diagnostics.opens += 1;
        counters.wsOpens += 1;
        if (diagnostics.opens > 1) counters.wsReconnects += 1;
      });
      this.addEventListener("close", (event) => {
        const close = {
          code: event.code,
          reason: String(event.reason ?? "").slice(0, 200),
          wasClean: event.wasClean,
          at: Date.now(),
        };
        diagnostics.closes.push(close);
        if (diagnostics.closes.length > 8) diagnostics.closes.shift();
        diagnostics.lastClose = close;
        counters.wsCloseEvents += 1;
        bump(counters.closeCodes, String(close.code));
      });
      this.addEventListener("error", (event) => {
        counters.wsErrors += 1;
        const code = event?.error?.code ?? event?.error?.cause?.code ?? null;
        diagnostics.lastErrorCode = code ? String(code) : diagnostics.lastErrorCode;
        diagnostics.lastErrorMessage = String(event?.error?.message ?? event?.message ?? "").slice(0, 200);
        if (code) bump(counters.socketErrorCodes, String(code));
      });
    }
  };
}

function connectionDiagnosis(state) {
  const clientState = state.client?.connectionState?.() ?? {};
  return {
    hasEverConnected: clientState.hasEverConnected ?? null,
    isWebSocketConnected: clientState.isWebSocketConnected ?? null,
    connectionCount: clientState.connectionCount ?? null,
    connectionRetries: clientState.connectionRetries ?? null,
    wsAttempts: state.wsDiagnostics.attempts,
    wsOpens: state.wsDiagnostics.opens,
    wsCloseCount: state.wsDiagnostics.closes.length,
    lastCloseCode: state.wsDiagnostics.lastClose?.code ?? null,
    lastCloseReason: state.wsDiagnostics.lastClose?.reason ?? null,
    lastCloseWasClean: state.wsDiagnostics.lastClose?.wasClean ?? null,
    lastSocketErrorCode: state.wsDiagnostics.lastErrorCode,
    lastSocketErrorMessage: state.wsDiagnostics.lastErrorMessage,
    serverDisconnects: state.disconnects.slice(0, 2),
  };
}

const LOCAL_SOCKET_CODES = /^(EMFILE|ENFILE|EADDRINUSE|EADDRNOTAVAIL|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOBUFS)$/;

/**
 * Exactly four buckets, as required by the S5 diagnostic:
 *   local_connect_failure — an explicit local socket/resource error, or a connect that never
 *                           opened while the harness deadline expired;
 *   server_close         — the peer sent a close frame (code recorded), or the socket opened and
 *                           later closed without a local socket error;
 *   auth_rejection       — the query/subscription error is an auth refusal;
 *   client_timeout       — the socket is still open (or the server closed cleanly) and the
 *                           harness deadline expired with no first result.
 */
function classifyConnectionFailure(diagnostics, error) {
  const text = `${error?.message ?? error} ${JSON.stringify(error?.data ?? "")}`;
  if (/401|403|unauthori[sz]ed|not signed in|auth(?:entication|orization)? (?:failed|error)|token (?:expired|invalid)/i.test(text)) {
    return "auth_rejection";
  }
  const socketCode = diagnostics.lastSocketErrorCode;
  if (socketCode && LOCAL_SOCKET_CODES.test(socketCode)) return "local_connect_failure";
  if (diagnostics.lastCloseCode !== null && diagnostics.lastCloseCode !== 1005) {
    // 1006 means the peer vanished without a close frame. It is still a transport close, not an
    // auth or query outcome, but it cannot be attributed to local or server side from the client.
    return "server_close";
  }
  const retries = diagnostics.connectionRetries ?? 0;
  if (diagnostics.wsAttempts > 0 && diagnostics.wsOpens === 0 && retries > 0) {
    // The client kept retrying with its own jittered backoff and never opened a socket.
    return "local_connect_failure";
  }
  if (retries > 0 && diagnostics.isWebSocketConnected === false) return "server_close";
  return "client_timeout";
}

function openSession() {
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const state = {
    client: null,
    ready: false,
    readyResolved: false,
    holdKey: "hold",
    subs: new Map(),
    disconnects: [],
    wsDiagnostics: newWsDiagnostics(),
  };

  const webSocketConstructor = makeWebSocketClass(state.wsDiagnostics);
  const client = new ConvexClient(url, {
    logger: false,
    ...(webSocketConstructor ? { webSocketConstructor } : {}),
    onServerDisconnectError: (message) => {
      state.disconnects.push(String(message).slice(0, 300));
    },
  });
  state.client = client;
  client.setAuth(async () => token);

  // Prove the socket and the token with a one-shot query. Ramping with a live hold subscription
  // meant clearing 8k subscriptions before the first curve point, and that cleanup delayed the
  // fan-out by minutes — it measured teardown, not delivery.
  client
    .query(api.users.me, {})
    .then(() => {
      if (!state.readyResolved) {
        state.readyResolved = true;
        state.ready = true;
        resolveReady(true);
      }
    })
    .catch((error) => {
      if (!state.readyResolved) {
        state.readyResolved = true;
        state.ready = false;
        state.firstError = failure("ramp", error);
        resolveReady(false);
      }
    });

  return { state, ready };
}

async function ramp(target) {
  const started = performance.now();
  let attempted = 0;
  const failures = [];
  let lastConnected = 0;
  let stagnantBatches = 0;

  while (attempted < target && !stopRequested) {
    const size = Math.min(rampBatch, target - attempted);
    const pending = Array.from({ length: size }, () => openSession());
    const settled = await Promise.all(
      pending.map(async ({ state, ready }) => {
        const ok = await Promise.race([
          ready,
          sleep(rampTimeoutMs).then(() => "timeout"),
        ]);
        if (ok === true) return { state, ok: true };
        const connection = state.client.connectionState?.();
        const error =
          ok === "timeout"
            ? new Error(
                `session did not receive its first result in ${rampTimeoutMs} ms ` +
                  `(hasEverConnected=${connection?.hasEverConnected ?? "?"})`,
              )
            : state.firstError ?? new Error("session subscription failed");
        const diagnostics = connectionDiagnosis(state);
        const failureClass = ok === "timeout"
          ? classifyConnectionFailure(diagnostics, error)
          : classifyError(error) === "auth"
            ? "auth_rejection"
            : classifyConnectionFailure(diagnostics, error);
        bump(counters.rampClassification, failureClass);
        const entry = {
          ...failure("ramp", error),
          class: failureClass,
          diagnostics,
        };
        await state.client.close().catch(() => {});
        return { state: null, ok: false, entry };
      }),
    );

    const good = settled.filter((entry) => entry.ok).map((entry) => entry.state);
    const bad = settled.filter((entry) => !entry.ok).map((entry) => entry.entry);
    sessions.push(...good);
    failures.push(...bad);
    attempted += size;

    if (sessions.length > lastConnected) {
      lastConnected = sessions.length;
      stagnantBatches = 0;
    } else {
      stagnantBatches += 1;
    }
    send({
      type: "ramp-progress",
      worker: workerIndex,
      attempted,
      connected: sessions.length,
      batchSize: size,
      batchFailures: bad.length,
      failures: bad,
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(1)),
      counters: { ...counters },
    });
    if (stagnantBatches >= 3 && sessions.length < target) {
      send({
        type: "ramp-cap",
        worker: workerIndex,
        connected: sessions.length,
        reason: "no new sessions connected in three consecutive batches",
      });
      break;
    }
  }

  // Keep the local index space compact so the master can address sessions by local position.
  sessions = sessions.filter((session) => session.ready && !session.client.closed);
  sessions.forEach((session, index) => {
    session.localIndex = index;
  });
  send({
    type: "ramp-done",
    worker: workerIndex,
    attempted,
    connected: sessions.length,
    failures,
    stopped: stopRequested,
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(1)),
    counters: { ...counters },
  });
}

function subscribeOne(state, key, publicId) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (ok, error) => {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      if (ok) {
        resolve(null);
        return true;
      }
      const diagnostics = connectionDiagnosis(state);
      const failureClass = classifyConnectionFailure(diagnostics, error);
      bump(counters.subscriptionClassification, failureClass);
      resolve(failure("subscription", error, { key, class: failureClass, diagnostics }));
      return true;
    };
    const subscription = state.client.onUpdate(
      api.messages.listLive,
      { conversation: { kind: "group", publicId } },
      (messages) => {
        const sub = state.subs.get(key);
        if (sub && !sub.ready) {
          sub.ready = true;
          finish(true);
        }
        const arm = armed.get(key);
        if (arm && messages.some((message) => message.text === arm.text)) {
          // Every subscribed session must report once; a group-wide flag would count only the
          // first callback in this worker.
          if (!arm.seen.has(state.localIndex)) {
            arm.seen.add(state.localIndex);
            send({
              type: "receipt",
              worker: workerIndex,
              key,
              t1: absNow(),
            });
          }
        }
      },
      (error) => {
        const sub = state.subs.get(key);
        if (sub) sub.ready = false;
        const settledNow = finish(false, error);
        if (!settledNow) {
          // A failure after subscribe-done: report it live, it is not in the phase result.
          const lateDiagnostics = connectionDiagnosis(state);
          send({
            type: "sub-failure",
            worker: workerIndex,
            key,
            late: true,
            entry: failure("subscription", error, {
              key,
              class: classifyConnectionFailure(lateDiagnostics, error),
              diagnostics: lateDiagnostics,
            }),
          });
        }
      },
    );
    state.subs.set(key, { subscription, ready: false, groupPublicId: publicId });
    timer = setTimeout(
      () => finish(false, new Error("subscription produced no first result in 30 s")),
      30_000,
    );
    if (typeof timer.unref === "function") timer.unref();
  });
}

async function subscribe(entries) {
  const failures = [];
  const counts = {};
  // entries: [{session, key, publicId}] — subscribe in bounded batches so one worker does not
  // open thousands of simultaneous queries.
  for (let offset = 0; offset < entries.length; offset += 400) {
    const batch = entries.slice(offset, offset + 400);
    const results = await Promise.all(
      batch.map(async (entry) => {
        const state = sessions[entry.session];
        if (!state) {
          return failure("subscription", new Error(`no session at local index ${entry.session}`), {
            key: entry.key,
          });
        }
        const result = await subscribeOne(state, entry.key, entry.publicId);
        if (result === null) counts[entry.key] = (counts[entry.key] ?? 0) + 1;
        return result;
      }),
    );
    for (const result of results) if (result !== null) failures.push(result);
  }
  send({
    type: "subscribe-done",
    worker: workerIndex,
    counts,
    failures,
    sessionCount: sessions.length,
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    counters: { ...counters },
  });
}

async function clearSubscriptions() {
  let removed = 0;
  for (const state of sessions) {
    for (const [key, sub] of state.subs) {
      try {
        sub.subscription();
      } catch {
        // The client may already have closed; nothing left to unsubscribe.
      }
      state.subs.delete(key);
      removed += 1;
    }
  }
  send({ type: "clear-done", worker: workerIndex, removed });
}

function health() {
  const readyByKey = {};
  let connectedSessions = 0;
  let disconnectEvents = 0;
  let reconnects = 0;
  let sessionsWithRetries = 0;
  let maxConnectionRetries = 0;
  const disconnectSamples = [];
  for (const state of sessions) {
    const clientState = state.client.connectionState?.() ?? {};
    if (clientState.isWebSocketConnected) connectedSessions += 1;
    reconnects += Math.max(0, (clientState.connectionCount ?? 1) - 1);
    if ((clientState.connectionRetries ?? 0) > 0) sessionsWithRetries += 1;
    maxConnectionRetries = Math.max(maxConnectionRetries, clientState.connectionRetries ?? 0);
    for (const [key, sub] of state.subs) {
      if (sub.ready) readyByKey[key] = (readyByKey[key] ?? 0) + 1;
    }
    disconnectEvents += state.disconnects.length;
    for (const message of state.disconnects) {
      if (disconnectSamples.length < 5) disconnectSamples.push(message);
    }
  }
  send({
    type: "health-done",
    worker: workerIndex,
    readyByKey,
    connectedSessions,
    disconnectEvents,
    disconnectSamples,
    sessionCount: sessions.length,
    reconnects,
    sessionsWithRetries,
    maxConnectionRetries,
    counters: { ...counters },
  });
}

async function queryBurst({ targetEpoch, count, conversation }) {
  const targets = sessions.slice(0, count);
  const wait = Math.max(0, targetEpoch - absNow());
  if (wait > 0) await sleep(wait);
  const results = await Promise.all(
    targets.map(async (state) => {
      const t0 = absNow();
      try {
        await state.client.query(api.messages.listLive, { conversation });
        return { ok: true, t0, t1: absNow() };
      } catch (error) {
        return { ok: false, t0, t1: absNow(), error: failure("query", error) };
      }
    }),
  );
  send({ type: "query-done", worker: workerIndex, results });
}

async function queryOne({ session, conversation }) {
  const state = sessions[session];
  if (!state) {
    send({
      type: "query-one-done",
      worker: workerIndex,
      result: { ok: false, t0: absNow(), t1: absNow(), error: failure("query", new Error("missing session")) },
    });
    return;
  }
  const t0 = absNow();
  try {
    await state.client.query(api.messages.listLive, { conversation });
    send({ type: "query-one-done", worker: workerIndex, result: { ok: true, t0, t1: absNow() } });
  } catch (error) {
    send({
      type: "query-one-done",
      worker: workerIndex,
      result: { ok: false, t0, t1: absNow(), error: failure("query", error) },
    });
  }
}

async function closeAll() {
  for (let offset = 0; offset < sessions.length; offset += 200) {
    await Promise.all(sessions.slice(offset, offset + 200).map((state) => state.client.close().catch(() => {})));
  }
  sessions = [];
  send({ type: "close-done", worker: workerIndex });
}

process.on("message", async (message) => {
  try {
    switch (message.type) {
      case "init":
        url = message.url;
        token = message.token;
        workerIndex = message.worker;
        holdConversation = message.holdConversation;
        rampBatch = message.rampBatch ?? rampBatch;
        rampTimeoutMs = message.rampTimeoutMs ?? rampTimeoutMs;
        send({ type: "init-ack", worker: workerIndex });
        await ramp(message.target);
        break;
      case "stop-ramp":
        stopRequested = true;
        break;
      case "subscribe":
        await subscribe(message.entries);
        break;
      case "clear-subscriptions":
        await clearSubscriptions();
        break;
      case "health":
        health();
        break;
      case "arm":
        for (const entry of message.entries) armed.set(entry.key, { text: entry.text, seen: new Set() });
        send({ type: "arm-ack", worker: workerIndex, keys: message.entries.map((entry) => entry.key) });
        break;
      case "query-burst":
        await queryBurst(message);
        break;
      case "query-one":
        await queryOne(message);
        break;
      case "close":
        await closeAll();
        break;
      case "ping":
        send({ type: "pong", worker: workerIndex });
        break;
      default:
        send({ type: "worker-error", worker: workerIndex, message: `unknown command ${message.type}` });
    }
  } catch (error) {
    send({ type: "worker-error", worker: workerIndex, error: failure("worker", error) });
  }
});

send({ type: "worker-ready", worker: workerIndex, pid: process.pid });
