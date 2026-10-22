// End-to-end proof for PRD Part 5: widget shell hardening, API keys, REST endpoints, rate limits,
// idempotency and outbound webhooks.
//
//   node scripts/verify-part5.mjs
//
// Requires a deployed dev backend and .env.local. Writes app/evidence/verify-part5.txt and exits
// non-zero if any check fails.

import { ConvexHttpClient } from "convex/browser";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "../convex/_generated/api.js";
import { deploymentUrl, signInFresh, sleep } from "./lib/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const convexBin = join(appDir, "node_modules", "convex", "bin", "main.js");
const URL_BASE = deploymentUrl();
const ENV = readFileSync(join(appDir, ".env.local"), "utf8");
const siteMatch = ENV.match(/^CONVEX_SITE_URL=(.+)$/m);
const SITE = (process.env.CONVEX_SITE_URL ?? siteMatch?.[1]?.trim() ?? URL_BASE.replace(".convex.cloud", ".convex.site")).replace(/\/+$/, "");

const lines = [];
function log(line = "") {
  lines.push(line);
  console.log(line);
}

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

function runInternal(name, args) {
  const raw = execFileSync(
    process.execPath,
    [convexBin, "run", `testing:${name}`, JSON.stringify(args), "--typecheck", "disable"],
    { cwd: appDir, encoding: "utf8" },
  ).replace(/\u001b\[[0-9;]*m/g, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`testing:${name} returned no JSON: ${raw.slice(0, 400)}`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

const apiResponses = [];
async function http(method, path, { token, body, headers } = {}) {
  const response = await fetch(`${SITE}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A shell response is HTML.
  }
  const result = { status: response.status, headers: response.headers, text, json };
  if (path.startsWith("/v1/")) apiResponses.push(result);
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function internalIdsIn(value, path = "$") {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = internalIdsIn(value[index], `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "_id" || key === "_creationTime") return `${path}.${key}`;
      const found = internalIdsIn(child, `${path}.${key}`);
      if (found !== null) return found;
    }
  }
  return null;
}

function errorShape(response) {
  return (
    response.json !== null &&
    typeof response.json === "object" &&
    typeof response.json.error?.code === "string" &&
    typeof response.json.error?.message === "string"
  );
}

async function expectError(fn, matcher) {
  let caught = null;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  if (caught === null) throw new Error("expected an error, but the call succeeded");
  if (matcher !== undefined) {
    const text = `${caught.message} ${JSON.stringify(caught.data ?? "")}`.toLowerCase();
    assert(text.includes(matcher.toLowerCase()), `expected ${JSON.stringify(matcher)}, got ${caught.message}`);
  }
  return caught;
}

const runId = Date.now().toString(36);
log(`deployment: ${URL_BASE}`);
log(`site:       ${SITE}`);
log(`run id:     ${runId}`);
log("");

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const admin = new ConvexHttpClient(URL_BASE);
const adminEmail = `part5-admin+${runId}@demo.teamchat.test`;
await signInFresh(admin, adminEmail);

const org = await admin.mutation(api.organizations.create, {
  name: `Part 5 Verify ${runId}`,
  allowDirectMessages: true,
});
const orgPublicId = org.orgPublicId;
const rootGroupPublicId = org.rootGroupPublicId;

const ALL_SCOPES = ["messages:write", "messages:read", "users:provision", "groups:manage", "tasks:read"];

async function createKey(label, scopes = ALL_SCOPES) {
  return await admin.mutation(api.apiKeys.create, { orgPublicId, label, scopes });
}

const keyAll = await createKey(`all-${runId}`);
const keyRead = await createKey(`read-${runId}`, ["messages:read"]);
const keyGroup = await createKey(`group-${runId}`, ["messages:write"]);
const keyRate = await createKey(`rate-${runId}`, ["tasks:read"]);
const keyRotate = await createKey(`rotate-${runId}`, ["tasks:read"]);
const keyExpire = await createKey(`expire-${runId}`, ["tasks:read"]);
const keyRevoke = await createKey(`revoke-${runId}`, ["tasks:read"]);
const keyLastUsed = await createKey(`last-${runId}`, ["tasks:read"]);

// ---------------------------------------------------------------------------------------------
// Part B — API keys
// ---------------------------------------------------------------------------------------------

await check("API key format is tc_live_ + 32 alphanumerics", async () => {
  assert(/^tc_live_[A-Za-z0-9]{32}$/.test(keyAll.key), `bad format: ${keyAll.key}`);
  return `${keyAll.keyPublicId} ${keyAll.key.slice(0, 12)}…`;
});

await check("API key stores SHA-256 only and never returns it", async () => {
  const probe = runInternal("apiKeyProbe", { keyPublicId: keyAll.keyPublicId });
  assert(probe.keyHash === sha256(keyAll.key), "stored hash is not SHA-256 of the plaintext");
  assert(probe.keyHash !== keyAll.key, "plaintext was stored");
  const list = await admin.query(api.apiKeys.listForOrg, { orgPublicId });
  const serialised = JSON.stringify(list);
  assert(!serialised.includes(keyAll.key), "list leaked plaintext");
  assert(!serialised.includes(probe.keyHash), "list leaked the hash");
  assert(!serialised.includes("keyHash"), "list exposed a hash field");
  return "hash-index lookup, metadata-only list";
});

await check("API key expires 90 days after creation", async () => {
  const probe = runInternal("apiKeyProbe", { keyPublicId: keyLastUsed.keyPublicId });
  const days = (probe.expiresAt - keyLastUsed.createdAt) / (24 * 60 * 60 * 1000);
  assert(Math.abs(days - 90) < 0.01, `expiry is ${days} days`);
  return `${days.toFixed(2)} days`;
});

await check("Bearer auth: missing/unknown key is 401, scope mismatch is 403", async () => {
  const missing = await http("GET", "/v1/tasks?externalRef=x");
  assert(missing.status === 401 && errorShape(missing), `missing: ${missing.status}`);
  const unknown = await http("GET", "/v1/tasks?externalRef=x", { token: "tc_live_00000000000000000000000000000000" });
  assert(unknown.status === 401 && errorShape(unknown), `unknown: ${unknown.status}`);
  const forbidden = await http("POST", "/v1/messages", {
    token: keyRead.key,
    headers: { "Idempotency-Key": `scope-${runId}` },
    body: JSON.stringify({ groupPublicId: rootGroupPublicId, text: "scope test" }),
  });
  assert(forbidden.status === 403 && forbidden.json.error.code === "forbidden", `scope: ${forbidden.status}`);
  return "401 missing/unknown · 403 scope";
});

await check("Revoked key is 401 and indistinguishable from unknown", async () => {
  await admin.mutation(api.apiKeys.revoke, { orgPublicId, keyPublicId: keyRevoke.keyPublicId });
  const revoked = await http("GET", "/v1/tasks?externalRef=x", { token: keyRevoke.key });
  const unknown = await http("GET", "/v1/tasks?externalRef=x", { token: "tc_live_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" });
  assert(revoked.status === 401, `revoked: ${revoked.status}`);
  assert(revoked.text === unknown.text, "revoked and unknown responses differ");
  return "same 401 body";
});

await check("Expired key is enforced on every request", async () => {
  runInternal("expireApiKey", { keyPublicId: keyExpire.keyPublicId });
  const expired = await http("GET", "/v1/tasks?externalRef=x", { token: keyExpire.key });
  assert(expired.status === 401, `expired: ${expired.status}`);
  return "stored expiresAt checked at auth";
});

await check("Rotation revokes the old key immediately and returns a new one", async () => {
  const rotated = await admin.mutation(api.apiKeys.rotate, {
    orgPublicId,
    keyPublicId: keyRotate.keyPublicId,
  });
  assert(rotated.key !== keyRotate.key, "rotation reused the old secret");
  const old = await http("GET", "/v1/tasks?externalRef=x", { token: keyRotate.key });
  const fresh = await http("GET", "/v1/tasks?externalRef=x", { token: rotated.key });
  assert(old.status === 401, `old key still works: ${old.status}`);
  assert(fresh.status === 404, `new key failed: ${fresh.status}`);
  return `${keyRotate.keyPublicId} → ${rotated.keyPublicId}`;
});

await check("lastUsedAt is written at most once per key per 60s", async () => {
  await http("GET", "/v1/tasks?externalRef=x", { token: keyLastUsed.key });
  const first = runInternal("apiKeyProbe", { keyPublicId: keyLastUsed.keyPublicId });
  await sleep(250);
  await http("GET", "/v1/tasks?externalRef=x", { token: keyLastUsed.key });
  const second = runInternal("apiKeyProbe", { keyPublicId: keyLastUsed.keyPublicId });
  assert(first.lastUsedAt !== null, "first use did not set lastUsedAt");
  assert(first.lastUsedAt === second.lastUsedAt, "second request inside 60s rewrote lastUsedAt");
  return `lastUsedAt pinned at ${first.lastUsedAt}`;
});

await check("Per-org API limit is configurable only above the 500 floor", async () => {
  await expectError(
    () => admin.mutation(api.apiKeys.setRateLimit, { orgPublicId, requestsPerMinute: 499 }),
    "below 500",
  );
  const saved = await admin.mutation(api.apiKeys.setRateLimit, {
    orgPublicId,
    requestsPerMinute: 750,
  });
  const probe = runInternal("orgRateProbe", { orgPublicId });
  assert(saved.requestsPerMinute === 750 && probe.apiRateLimitPerMinute === 750, "limit not stored");
  await admin.mutation(api.apiKeys.setRateLimit, { orgPublicId, requestsPerMinute: 500 });
  return "499 rejected, 750 stored";
});

// ---------------------------------------------------------------------------------------------
// Part C/D — REST endpoints, idempotency, rate limits
// ---------------------------------------------------------------------------------------------

await check("Idempotency-Key is required on every write", async () => {
  const response = await http("POST", "/v1/messages", {
    token: keyAll.key,
    body: JSON.stringify({ groupPublicId: rootGroupPublicId, text: "no key" }),
  });
  assert(response.status === 400 && response.json.error.code === "idempotency_key_required", `${response.status}`);
  return "400 idempotency_key_required";
});

const instructionRef = `PO-${runId}-INSTRUCTION`;
const instructionBody = JSON.stringify({
  groupPublicId: rootGroupPublicId,
  text: `Instruction ${runId}`,
  mode: "discussion",
  externalRef: instructionRef,
  externalSource: "verify",
});
const instructionKey = `idem-${runId}`;
let instructionResponse = null;

await check("POST /v1/messages creates an api-origin message and returns only public ids", async () => {
  instructionResponse = await http("POST", "/v1/messages", {
    token: keyAll.key,
    headers: { "Idempotency-Key": instructionKey },
    body: instructionBody,
  });
  assert(instructionResponse.status === 201, `status ${instructionResponse.status}`);
  assert(typeof instructionResponse.json.messagePublicId === "string", "no messagePublicId");
  assert(instructionResponse.json.status === "discussion", "wrong status");
  assert(internalIdsIn(instructionResponse.json) === null, "internal id in response");
  return instructionResponse.json.messagePublicId;
});

await check("Idempotent replay returns the original response byte-identically", async () => {
  const replay = await http("POST", "/v1/messages", {
    token: keyAll.key,
    headers: { "Idempotency-Key": instructionKey },
    body: instructionBody,
  });
  assert(replay.status === instructionResponse.status, `status ${replay.status}`);
  assert(replay.text === instructionResponse.text, "replay body differs");
  const row = runInternal("idempotencyProbe", {
    orgPublicId,
    scope: "POST /v1/messages",
    key: instructionKey,
  });
  assert(row.rows.length === 1, `stored ${row.rows.length} rows`);
  assert(row.rows[0].responseBody === instructionResponse.text, "stored body is not verbatim");
  return "same status and bytes";
});

await check("Reusing a key with a different body is 409", async () => {
  const conflict = await http("POST", "/v1/messages", {
    token: keyAll.key,
    headers: { "Idempotency-Key": instructionKey },
    body: JSON.stringify({ groupPublicId: rootGroupPublicId, text: "different", mode: "discussion" }),
  });
  assert(conflict.status === 409 && conflict.json.error.code === "idempotency_conflict", `${conflict.status}`);
  return "409 idempotency_conflict";
});

const actionRef = `PO-${runId}-ACTION`;
const actionBody = JSON.stringify({
  groupPublicId: rootGroupPublicId,
  text: `Action ${runId}`,
  mode: "action",
  externalRef: actionRef,
  externalSource: "verify",
});
const actionResponse = await http("POST", "/v1/messages", {
  token: keyAll.key,
  headers: { "Idempotency-Key": `action-${runId}` },
  body: actionBody,
});
const actionMessagePublicId = actionResponse.json?.messagePublicId;

await check("Action mode creates exactly one task in the same mutation", async () => {
  assert(actionResponse.status === 201 && actionResponse.json.status === "open", `status ${actionResponse.status}`);
  const probe = runInternal("actionProbeState", { messagePublicId: actionMessagePublicId });
  assert(probe.task?.publicId, "task missing");
  assert(probe.events.length === 0, `unexpected events: ${probe.events.length}`);
  return `${actionMessagePublicId} → one open task`;
});

await check("API writes run as the one-per-org bot service user", async () => {
  const first = runInternal("serviceUserProbe", { orgPublicId });
  assert(first !== null && first.accountState === "bot", "service user is not a bot");
  const second = await http("POST", "/v1/messages", {
    token: keyAll.key,
    headers: { "Idempotency-Key": `bot-${runId}` },
    body: JSON.stringify({ groupPublicId: rootGroupPublicId, text: "second", mode: "discussion" }),
  });
  assert(second.status === 201, `second send ${second.status}`);
  const again = runInternal("serviceUserProbe", { orgPublicId });
  assert(again.userPublicId === first.userPublicId, "a second service user was created");
  return `${first.userPublicId} accountState=bot`;
});

await check("GET /v1/messages/{publicId} returns content, no _id, scope-gated", async () => {
  const response = await http("GET", `/v1/messages/${actionMessagePublicId}`, { token: keyAll.key });
  assert(response.status === 200, `status ${response.status}`);
  assert(response.json.origin === "api", `origin ${response.json.origin}`);
  assert(response.json.text === `Action ${runId}`, "text mismatch");
  assert(response.json.externalRef === actionRef, "externalRef mismatch");
  assert(internalIdsIn(response.json) === null, "internal id in response");
  const wrongScope = await http("GET", `/v1/messages/${actionMessagePublicId}`, { token: keyAll.key });
  assert(wrongScope.status === 200, "read for own org failed");
  return response.json.messagePublicId;
});

await check("GET /v1/tasks resolves by org-scoped externalRef and reported claim state", async () => {
  const before = await http("GET", `/v1/tasks?externalRef=${encodeURIComponent(actionRef)}&externalSource=verify`, {
    token: keyAll.key,
  });
  assert(before.status === 200 && before.json.status === "open", `${before.status} ${before.text}`);
  assert(internalIdsIn(before.json) === null, "internal id in response");

  const rollup = await admin.query(api.actionInbox.rollup, {
    groupPublicId: rootGroupPublicId,
    status: "open",
  });
  const task = rollup.tasks.find((row) => row.messagePublicId === actionMessagePublicId);
  assert(task !== undefined, "task not found for claim");
  await admin.mutation(api.actionInbox.claim, { taskPublicId: task.publicId });

  const after = await http("GET", `/v1/tasks?externalRef=${encodeURIComponent(actionRef)}`, {
    token: keyAll.key,
  });
  assert(after.status === 200 && after.json.status === "claimed", `${after.status} ${after.text}`);
  assert(after.json.claimedBy?.publicId?.startsWith("usr_"), "claimedBy publicId missing");
  assert(typeof after.json.claimedAt === "string", "claimedAt missing");
  return `open → claimed by ${after.json.claimedBy.publicId}`;
});

await check("POST /v1/users/provision creates org members and is idempotent by externalRef", async () => {
  const email = `part5-staff+${runId}@demo.teamchat.test`;
  const externalRef = `ACC-EMP-${runId}`;
  const body = JSON.stringify({
    externalSource: "verify",
    users: [
      {
        email,
        name: "Part Five Staff",
        externalRef,
        groupPublicIds: [rootGroupPublicId],
      },
    ],
  });
  const first = await http("POST", "/v1/users/provision", {
    token: keyAll.key,
    headers: { "Idempotency-Key": `prov-${runId}` },
    body,
  });
  assert(first.status === 201, `${first.status} ${first.text}`);
  const created = first.json.created[0];
  assert(created.state === "provisioned" && created.activatable === true, "wrong state/activatable");
  assert(internalIdsIn(first.json) === null, "internal id in response");

  const second = await http("POST", "/v1/users/provision", {
    token: keyAll.key,
    headers: { "Idempotency-Key": `prov2-${runId}` },
    body,
  });
  assert(second.status === 201, `${second.status}`);
  assert(second.json.created[0].userPublicId === created.userPublicId, "externalRef created a second user");

  const lookup = await http("GET", `/v1/users?externalRef=${encodeURIComponent(externalRef)}&externalSource=verify`, {
    token: keyAll.key,
  });
  assert(lookup.status === 200, `${lookup.status} ${lookup.text}`);
  assert(lookup.json.userPublicId === created.userPublicId, "lookup returned another user");
  assert(lookup.json.activatable === true, "activatable lost");
  return `${created.userPublicId} provisioned + orgMembers row`;
});

await check("POST /v1/groups creates a direct child and rejects nesting", async () => {
  const externalRef = `ACC-BRANCH-${runId}`;
  const body = JSON.stringify({
    name: `Outlet ${runId}`,
    parentPublicId: rootGroupPublicId,
    memberEmails: [`part5-staff+${runId}@demo.teamchat.test`],
    externalRef,
    externalSource: "verify",
  });
  const created = await http("POST", "/v1/groups", {
    token: keyAll.key,
    headers: { "Idempotency-Key": `grp-${runId}` },
    body,
  });
  assert(created.status === 201, `${created.status} ${created.text}`);
  assert(created.json.path.startsWith(`/${orgPublicId}/`), `path ${created.json.path}`);
  assert(internalIdsIn(created.json) === null, "internal id in response");

  const lookup = await http("GET", `/v1/groups?externalRef=${encodeURIComponent(externalRef)}&externalSource=verify`, {
    token: keyAll.key,
  });
  assert(lookup.status === 200 && lookup.json.groupPublicId === created.json.groupPublicId, "lookup failed");

  const nested = await http("POST", "/v1/groups", {
    token: keyAll.key,
    headers: { "Idempotency-Key": `grp-nested-${runId}` },
    body: JSON.stringify({ name: "Nested", parentPublicId: created.json.groupPublicId }),
  });
  assert(nested.status === 400 && nested.json.error.code === "nested_group_not_supported", `${nested.status} ${nested.text}`);
  return `${created.json.groupPublicId} direct child; nested rejected`;
});

await check("Per-group send cap trips before the per-key cap", async () => {
  const group = await http("POST", "/v1/groups", {
    token: keyAll.key,
    headers: { "Idempotency-Key": `grp-cap-${runId}` },
    body: JSON.stringify({ name: `Cap group ${runId}` }),
  });
  assert(group.status === 201, `group ${group.status}`);
  const groupPublicId = group.json.groupPublicId;
  let limited = null;
  let sends = 0;
  for (let index = 0; index < 70; index++) {
    const response = await http("POST", "/v1/messages", {
      token: keyGroup.key,
      headers: { "Idempotency-Key": `cap-${runId}-${index}` },
      body: JSON.stringify({ groupPublicId, text: `cap ${index}`, mode: "discussion" }),
    });
    if (response.status === 201) {
      sends++;
      continue;
    }
    limited = response;
    break;
  }
  assert(limited !== null, "no limit tripped after 70 sends");
  assert(limited.status === 429, `status ${limited.status}`);
  assert(limited.json.error.code === "group_rate_limited", `code ${limited.json.error.code}`);
  assert(sends <= 61, `sent ${sends} before tripping`);
  return `tripped at ${sends} sends with group_rate_limited`;
});

await check("Per-key limit is 500/min and returns a stable 429", async () => {
  let limited = null;
  let allowed = 0;
  for (let batch = 0; batch < 24 && limited === null; batch++) {
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        http("GET", "/v1/tasks?externalRef=missing", { token: keyRate.key }),
      ),
    );
    for (const response of results) {
      if (response.status === 429) {
        limited = response;
        break;
      }
      allowed++;
    }
  }
  assert(
    limited !== null,
    `no 429 after ${allowed} requests; limiter=${JSON.stringify(
      runInternal("rateLimitProbe", {
        name: "apiKeyRequests",
        key: keyRate.keyPublicId,
        rate: 500,
        period: 60_000,
      }),
    )}`,
  );
  assert(limited.json.error.code === "rate_limited", `code ${limited.json.error.code}`);
  assert(allowed >= 490 && allowed <= 505, `allowed ${allowed}`);
  return `${allowed} allowed, then 429 rate_limited`;
});

// ---------------------------------------------------------------------------------------------
// Part E — webhooks
// ---------------------------------------------------------------------------------------------

await check("Webhook registration rejects http, loopback, private and metadata URLs", async () => {
  const cases = [
    ["http://example.com/hook", "https"],
    ["https://127.0.0.1/hook", "private"],
    ["https://localhost/hook", "private"],
    ["https://169.254.169.254/latest/meta-data", "private"],
    ["https://10.0.0.5/hook", "private"],
  ];
  for (const [url, matcher] of cases) {
    await expectError(
      () => admin.action(api.webhooks.register, { orgPublicId, url, events: ["task.claimed"] }),
      matcher,
    );
  }
  return "5 URL classes refused";
});

const hook = await admin.action(api.webhooks.register, {
  orgPublicId,
  url: `https://example.com/teamchat-verify-${runId}`,
  events: ["message.created", "task.claimed"],
});
const hookPublicId = hook.webhookPublicId;

await check("Webhook secret is returned once and stored encrypted, never listable", async () => {
  assert(hook.secret.startsWith("whsec_"), "secret prefix missing");
  assert(hook.secretShownOnce === true, "shown-once flag missing");
  const probe = runInternal("webhookProbe", { webhookPublicId: hookPublicId });
  assert(probe.secret !== null, "no secret row");
  assert(probe.secret.ciphertext !== hook.secret, "plaintext secret stored");
  assert(!probe.secret.ciphertext.includes(hook.secret), "ciphertext contains plaintext");
  const list = await admin.query(api.webhooks.listForOrg, { orgPublicId });
  const serialised = JSON.stringify(list);
  assert(!serialised.includes(hook.secret), "admin list leaked the secret");
  assert(!serialised.includes("ciphertext"), "admin list exposed ciphertext");
  return `${hookPublicId} ciphertext ${probe.secret.ciphertext.slice(0, 16)}…`;
});

await check("message.created delivery row is inserted with a content-free snapshot", async () => {
  const before = Date.now();
  const sent = await http("POST", "/v1/messages", {
    token: keyAll.key,
    headers: { "Idempotency-Key": `hook-${runId}` },
    body: JSON.stringify({
      groupPublicId: rootGroupPublicId,
      text: `Webhook text must never leave ${runId}`,
      mode: "discussion",
    }),
  });
  assert(sent.status === 201, `${sent.status} ${sent.text}`);
  const probe = runInternal("webhookProbe", { webhookPublicId: hookPublicId });
  const delivery = probe.deliveries.find((row) => row.event === "message.created");
  assert(delivery !== undefined, "no message.created delivery row");
  // The Convex deployment clock can differ from this host; allow a generous skew window.
  assert(delivery.createdAt >= before - 180_000, "row predates the mutation");
  assert(delivery.payload.data.messagePublicId === sent.json.messagePublicId, "payload message mismatch");
  const serialised = JSON.stringify(delivery.payload);
  assert(!serialised.includes(`Webhook text must never leave ${runId}`), "payload contains message text");
  assert(internalIdsIn(delivery.payload) === null, "payload contains an internal id");
  assert(!Object.prototype.hasOwnProperty.call(delivery.payload.data, "text"), "payload has text field");
  return `snapshot ${delivery.payload.event} attempts=${delivery.attempts}`;
});

await check("task.claimed payload carries claimedBy identity, no content", async () => {
  // This claim must happen after the webhook was registered, so the event has a subscriber.
  const claimRef = `PO-${runId}-CLAIM`;
  const claimMessage = await http("POST", "/v1/messages", {
    token: keyAll.key,
    headers: { "Idempotency-Key": `claim-${runId}` },
    body: JSON.stringify({
      groupPublicId: rootGroupPublicId,
      text: `Claim me ${runId}`,
      mode: "action",
      externalRef: claimRef,
      externalSource: "verify",
    }),
  });
  assert(claimMessage.status === 201, `claim message ${claimMessage.status}`);
  const rollup = await admin.query(api.actionInbox.rollup, {
    groupPublicId: rootGroupPublicId,
    status: "open",
  });
  const task = rollup.tasks.find((item) => item.messagePublicId === claimMessage.json.messagePublicId);
  assert(task !== undefined, "claim task not found");
  await admin.mutation(api.actionInbox.claim, { taskPublicId: task.publicId });

  const probe = runInternal("webhookProbe", { webhookPublicId: hookPublicId });
  const delivery = probe.deliveries.find((row) => row.event === "task.claimed");
  assert(delivery !== undefined, "no task.claimed delivery");
  assert(delivery.payload.data.messagePublicId === claimMessage.json.messagePublicId, "wrong message");
  assert(delivery.payload.data.claimedBy?.publicId?.startsWith("usr_"), "claimedBy missing");
  assert(delivery.payload.data.externalRef === claimRef, "externalRef missing");
  assert(internalIdsIn(delivery.payload) === null, "payload contains an internal id");
  return delivery.payload.data.claimedBy.publicId;
});

await admin.mutation(api.webhooks.setActive, {
  orgPublicId,
  webhookPublicId: hookPublicId,
  isActive: false,
});

let retryFirstAttempt = null;
const testDelivery = runInternal("insertTestDelivery", {
  webhookPublicId: hookPublicId,
  event: "task.done",
  messagePublicId: actionMessagePublicId,
  groupPublicId: rootGroupPublicId,
});

await check("Delivery re-resolves DNS and rejects a private address on every attempt", async () => {
  runInternal("setWebhookUrlForTest", { webhookPublicId: hookPublicId, url: "https://127.0.0.1/hook" });
  await admin.mutation(api.webhooks.setActive, {
    orgPublicId,
    webhookPublicId: hookPublicId,
    isActive: true,
  });
  const result = runInternal("runDelivery", { deliveryId: testDelivery.deliveryId });
  retryFirstAttempt = result;
  assert(String(result.error) === "url_check", `result ${JSON.stringify(result)}`);
  const probe = runInternal("webhookProbe", { webhookPublicId: hookPublicId });
  const row = probe.deliveries.find((item) => item.id === testDelivery.deliveryId);
  assert(row.status === "pending" && row.attempts === 1, `${row.status}/${row.attempts}`);
  assert(/private|loopback|link-local|metadata/i.test(row.lastError ?? ""), `error: ${row.lastError}`);
  return "attempt 1 failed before any socket";
});

await check("Retries follow 10s / 60s / 300s and dead-letter after 3 retries", async () => {
  const delays = [];
  let probe = runInternal("webhookProbe", { webhookPublicId: hookPublicId });
  let row = probe.deliveries.find((item) => item.id === testDelivery.deliveryId);
  const snapshot = JSON.stringify(row.payload);
  assert(retryFirstAttempt !== null, "first attempt result missing");
  delays.push(retryFirstAttempt.nextAttemptAt - retryFirstAttempt.serverNow);

  for (let attempt = 2; attempt <= 4; attempt++) {
    const result = runInternal("runDelivery", { deliveryId: testDelivery.deliveryId });
    probe = runInternal("webhookProbe", { webhookPublicId: hookPublicId });
    row = probe.deliveries.find((item) => item.id === testDelivery.deliveryId);
    assert(row.attempts === attempt, `attempts ${row.attempts} !== ${attempt}`);
    if (attempt < 4) delays.push(result.nextAttemptAt - result.serverNow);
  }
  assert(row.status === "dead", `final status ${row.status}`);
  assert(row.nextAttemptAt === null, "dead row still scheduled");
  assert(JSON.stringify(row.payload) === snapshot, "retry did not use the original snapshot");
  assert(Math.abs(delays[0] - 10_000) < 2_000, `first delay ${delays[0]}`);
  assert(Math.abs(delays[1] - 60_000) < 2_000, `second delay ${delays[1]}`);
  assert(Math.abs(delays[2] - 300_000) < 2_000, `third delay ${delays[2]}`);
  return `${delays.map((delay) => `${Math.round(delay / 1000)}s`).join(" / ")} → dead`;
});

await check("A failing webhook never rolls back or delays the task transition", async () => {
  const task = await admin.query(api.actionInbox.myTasks, { status: "claimed" });
  const row = task.tasks.find((item) => item.messagePublicId === actionMessagePublicId);
  assert(row !== undefined, "claimed task missing");
  const done = await admin.mutation(api.actionInbox.markDone, { taskPublicId: row.publicId });
  assert(done.status === "done", `transition failed: ${done.status}`);
  const probe = runInternal("webhookProbe", { webhookPublicId: hookPublicId, limit: 50 });
  const delivery = probe.deliveries.find((item) => item.event === "task.done");
  assert(delivery !== undefined, "task.done delivery row missing");
  return `status=done, delivery=${delivery.status}`;
});

await check("Payload is HMAC-signed over the raw body and redirects are never followed", async () => {
  const source = readFileSync(join(appDir, "convex", "webhookDelivery.ts"), "utf8");
  assert(
    source.includes('createHmac("sha256", secret).update(body).digest("hex")'),
    "HMAC is not computed over the serialized body",
  );
  assert(source.includes('"X-TeamChat-Signature"'), "signature header missing");
  assert(source.includes("status < 200 || status >= 300"), "3xx is not treated as failure");
  assert(!/followRedirects|redirect:\s*["']follow["']/.test(source), "delivery follows redirects");
  assert(source.includes("httpsRequest"), "delivery is not HTTPS-only");
  return "sha256 HMAC, 3xx fails, https.request";
});

await check("No limiter counter documents exist in the schema", async () => {
  const schema = readFileSync(join(appDir, "convex", "schema.ts"), "utf8");
  assert(!/defineTable\(\{[^}]*\bcount\b/s.test(schema), "schema has a counter-like table");
  assert(!/idempotencyKeys[\s\S]{0,500}counter/i.test(schema), "idempotency table looks like a counter");
  const source = readFileSync(join(appDir, "convex", "http.ts"), "utf8");
  assert(!/insert\(["'](?:rate|limit|counter)/i.test(source), "HTTP layer inserts a counter doc");
  return "component-backed limits only";
});

// ---------------------------------------------------------------------------------------------
// Part A — widget shell hardening
// ---------------------------------------------------------------------------------------------

const shellHost = await admin.mutation(api.hostApps.register, {
  orgPublicId,
  name: `Shell host ${runId}`,
  issuer: `https://shell-${runId}.example`,
  audience: `shell-${runId}`,
  allowedOrigins: [`https://host-${runId}.example`],
  supportGroupPublicId: rootGroupPublicId,
});
const shellHostPublicId = shellHost.hostAppPublicId;

await check("GET /widget/shell sets frame-ancestors from the stored allowlist and no X-Frame-Options", async () => {
  const response = await http("GET", `/widget/shell?host=${shellHostPublicId}`);
  assert(response.status === 200, `status ${response.status}`);
  assert(
    response.headers.get("content-security-policy") === `frame-ancestors https://host-${runId}.example`,
    `CSP: ${response.headers.get("content-security-policy")}`,
  );
  assert(response.headers.get("x-frame-options") === null, "X-Frame-Options present");
  assert(response.text.includes("widget.js"), "shell does not load the widget bundle");
  return `frame-ancestors https://host-${runId}.example`;
});

await check("Unknown and inactive hosts are the same 404 with no allowlist leak", async () => {
  const unknown = await http("GET", `/widget/shell?host=hap_does_not_exist_${runId}`);
  assert(unknown.status === 404, `unknown ${unknown.status}`);
  await admin.mutation(api.hostApps.setActive, {
    hostAppPublicId: shellHostPublicId,
    isActive: false,
  });
  const inactive = await http("GET", `/widget/shell?host=${shellHostPublicId}`);
  assert(inactive.status === 404, `inactive ${inactive.status}`);
  assert(unknown.text === inactive.text, "unknown and inactive bodies differ");
  assert(!inactive.text.includes(`host-${runId}.example`), "404 leaked the allowlist");
  return "identical 404 body, no origins";
});

await check("Demo host points at the shell route; direct index.html is not used", async () => {
  const demo = readFileSync(join(appDir, "widget", "demo", "index.html"), "utf8");
  const server = readFileSync(join(appDir, "scripts", "widget-demo-server.mjs"), "utf8");
  assert(demo.includes("widgetUrl: config.widgetUrl"), "demo still composes a widget URL itself");
  assert(server.includes('url.pathname === "/widget/shell"'), "demo server has no shell route");
  assert(server.includes("Content-Security-Policy"), "demo shell sets no CSP");
  assert(server.includes("/widget/shell?host="), "bootstrap does not point at the shell route");
  return "demo page → /widget/shell?host=…";
});

await check("Origin in the exchange is advisory; CSP is the enforcement point", async () => {
  const exchange = readFileSync(join(appDir, "convex", "auth", "widget.ts"), "utf8");
  const token = readFileSync(join(appDir, "convex", "widgets", "token.ts"), "utf8");
  assert(exchange.includes("assertAllowedOrigin"), "exchange does not check origin metadata");
  assert(token.includes("origin_not_allowed"), "origin check code missing");
  assert(token.includes("identity_not_shadow"), "distinct non-shadow error code missing");
  return "identity_not_shadow distinct from replayed; CSP header enforced";
});

// ---------------------------------------------------------------------------------------------
// Cross-cutting assertions
// ---------------------------------------------------------------------------------------------

await check("No API response contains an internal Convex id", async () => {
  for (const response of apiResponses) {
    if (response.json === null) continue;
    const found = internalIdsIn(response.json);
    assert(found === null, `internal id at ${found}`);
  }
  return `${apiResponses.length} responses scanned`;
});

await check("Every API error is the stable {error:{code,message}} shape", async () => {
  const errors = apiResponses.filter((response) => response.status >= 400);
  assert(errors.length > 0, "no errors exercised");
  for (const response of errors) {
    assert(errorShape(response), `bad error body: ${response.text.slice(0, 160)}`);
    assert(!/stack|at .*\.ts:\d+|_id/i.test(response.text), "error leaked internals");
  }
  return `${errors.length} error responses`;
});

await check("Webhook admin list exposes last-used deliveries and no secret", async () => {
  const list = await admin.query(api.webhooks.listForOrg, { orgPublicId, deliveryLimit: 10 });
  const row = list.find((item) => item.publicId === hookPublicId);
  assert(row !== undefined, "webhook missing from list");
  assert(row.recentDeliveries.length > 0, "no recent deliveries");
  assert(!JSON.stringify(row).includes("whsec_"), "list leaked a secret");
  return `${row.recentDeliveries.length} recent deliveries`;
});

log("");
log(`checks: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  log("");
  for (const failure of failures) log(`  ${failure}`);
}

const evidenceDir = join(appDir, "evidence");
mkdirSync(evidenceDir, { recursive: true });
const out = join(evidenceDir, "verify-part5.txt");
writeFileSync(
  out,
  [
    `Part 5 verification — ${new Date().toISOString()}`,
    `deployment: ${URL_BASE}`,
    `site:       ${SITE}`,
    `run id:     ${runId}`,
    "",
    ...lines,
    "",
  ].join("\n"),
  "utf8",
);
console.log(`evidence:   ${out}`);

process.exit(failed === 0 ? 0 : 1);
