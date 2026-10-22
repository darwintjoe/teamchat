// Cross-tenant isolation proof for the production deployment (PRD Parts 5 and 1).
//
//   node scripts/verify-cross-tenant.mjs
//
// Seeds two throwaway tenants through the internal test hooks, then tries every route by which
// tenant A could reach tenant B:
//
//   * A API key reading a B message                       -> 404, byte-identical to unknown
//   * A API key resolving a B task/group/user externalRef -> 404
//   * A API key provisioning into a B group               -> rejected, no row on either side
//   * A API key posting into a B group                    -> 404
//   * A admin listing B webhooks/deliveries               -> refused, A's own list is empty of B
//   * host-A widget token reading host-B support group    -> no B data; standalone reads refused
//   * host-A signed token presented for host B            -> refused
//
// Everything is removed afterwards with `testing:purgeTenant`. Requires the production JWT
// private key (JWT_PRIVATE_KEY or .storage/prod-jwt-private.pem) and a deployed production build.
//
// Writes app/evidence/verify-cross-tenant.txt.

import { ConvexHttpClient } from "convex/browser";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "../convex/_generated/api.js";
import { createSigningKey, signWidgetToken, tokenTimes } from "./lib/widgetAuth.mjs";
import { loadPrivateKey, mintSessionToken, runInternal } from "./lib/prod-session.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const CLOUD = (process.env.PROD_CLOUD_URL ?? "https://benevolent-crocodile-386.convex.cloud").replace(/\/+$/, "");
const SITE = (process.env.PROD_SITE_URL ?? CLOUD.replace(".convex.cloud", ".convex.site")).replace(/\/+$/, "");

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

function textOf(error) {
  return `${error?.message ?? error} ${JSON.stringify(error?.data ?? "")}`;
}

function isProductionRedacted(error) {
  // Convex replaces server error messages with "Server Error" for clients on a production
  // deployment. That redaction is itself required; the refusal is still observable as a throw.
  return /server error/i.test(textOf(error)) && /request id/i.test(textOf(error));
}

let redactions = 0;
async function expectError(fn, matcher) {
  let caught = null;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  if (caught === null) throw new Error("expected an error, but the call succeeded");
  if (matcher !== undefined && !textOf(caught).toLowerCase().includes(matcher.toLowerCase())) {
    if (!isProductionRedacted(caught)) {
      throw new Error(`expected ${JSON.stringify(matcher)}, got: ${caught.message}`);
    }
    redactions++;
  }
  return caught;
}

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
    // Not JSON.
  }
  return { status: response.status, headers: response.headers, text, json };
}

function errorCode(response) {
  return response.json?.error?.code ?? null;
}

async function sessionFor(publicId, privateKey) {
  const session = runInternal("createTestSession", { userPublicId: publicId });
  const token = await mintSessionToken({
    privateKey,
    userId: session.userId,
    sessionId: session.sessionId,
    siteUrl: SITE,
  });
  const client = new ConvexHttpClient(CLOUD);
  client.setAuth(token);
  return client;
}

const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const marker = `XT-MARK-${runId}`;
const emailA = `xt-a+${runId}@pilot.teamchat.test`;
const emailB = `xt-b+${runId}@pilot.teamchat.test`;
const bTaskRef = `XT-B-TASK-${runId}`;
const bGroupRef = `XT-B-GROUP-${runId}`;
const bUserRef = `XT-B-USER-${runId}`;
const bAttemptRef = `XT-A-ATTEMPT-${runId}`;

let tenantA = null;
let tenantB = null;

log(`cloud:   ${CLOUD}`);
log(`site:    ${SITE}`);
log(`run id:  ${runId}`);
log("");

try {
  const privateKey = loadPrivateKey();

  // -------------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------------

  tenantA = runInternal("seedTenant", { name: `Cross tenant A ${runId}`, email: emailA });
  tenantB = runInternal("seedTenant", { name: `Cross tenant B ${runId}`, email: emailB });

  const ownerA = await sessionFor(tenantA.ownerPublicId, privateKey);
  const ownerB = await sessionFor(tenantB.ownerPublicId, privateKey);

  // B proves it has real content, a real external ref and a real webhook delivery.
  const bHook = await ownerB.action(api.webhooks.register, {
    orgPublicId: tenantB.orgPublicId,
    url: `https://example.com/xt-${runId}`,
    events: ["message.created"],
  });
  const bMessage = await http("POST", "/v1/messages", {
    token: tenantB.key,
    headers: { "Idempotency-Key": `xt-b-msg-${runId}` },
    body: JSON.stringify({
      groupPublicId: tenantB.supportGroupPublicId,
      text: marker,
      mode: "action",
      externalRef: bTaskRef,
      externalSource: "xt",
    }),
  });
  assert(bMessage.status === 201, `B fixture message: ${bMessage.status} ${bMessage.text}`);
  const bMessagePublicId = bMessage.json.messagePublicId;

  const bGroup = await http("POST", "/v1/groups", {
    token: tenantB.key,
    headers: { "Idempotency-Key": `xt-b-group-${runId}` },
    body: JSON.stringify({
      name: `B group ${runId}`,
      parentPublicId: tenantB.rootGroupPublicId,
      externalRef: bGroupRef,
      externalSource: "xt",
    }),
  });
  assert(bGroup.status === 201, `B fixture group: ${bGroup.status} ${bGroup.text}`);

  const bStaff = await http("POST", "/v1/users/provision", {
    token: tenantB.key,
    headers: { "Idempotency-Key": `xt-b-user-${runId}` },
    body: JSON.stringify({
      externalSource: "xt",
      users: [
        {
          email: `xt-b-staff+${runId}@pilot.teamchat.test`,
          name: "B staff",
          externalRef: bUserRef,
        },
      ],
    }),
  });
  assert(bStaff.status === 201, `B fixture user: ${bStaff.status} ${bStaff.text}`);

  const bHooks = await ownerB.query(api.webhooks.listForOrg, {
    orgPublicId: tenantB.orgPublicId,
    deliveryLimit: 10,
  });
  assert(bHooks.some((hook) => hook.publicId === bHook.webhookPublicId), "B hook missing from B list");
  const bDeliveries = bHooks.find((hook) => hook.publicId === bHook.webhookPublicId)?.recentDeliveries ?? [];
  assert(bDeliveries.length > 0, "B fixture produced no delivery row");

  // Widget fixtures: one host app per tenant, each pointing at that tenant's own support group.
  const originA = `https://xt-a-${runId}.example`;
  const originB = `https://xt-b-${runId}.example`;
  const issuerA = `https://issuer-a-${runId}.example`;
  const issuerB = `https://issuer-b-${runId}.example`;
  const audienceA = `xt-a-${runId}`;
  const audienceB = `xt-b-${runId}`;

  const hostA = await ownerA.mutation(api.hostApps.register, {
    orgPublicId: tenantA.orgPublicId,
    name: `Host A ${runId}`,
    issuer: issuerA,
    audience: audienceA,
    allowedOrigins: [originA],
    supportGroupPublicId: tenantA.supportGroupPublicId,
  });
  const hostB = await ownerB.mutation(api.hostApps.register, {
    orgPublicId: tenantB.orgPublicId,
    name: `Host B ${runId}`,
    issuer: issuerB,
    audience: audienceB,
    allowedOrigins: [originB],
    supportGroupPublicId: tenantB.supportGroupPublicId,
  });
  const signingA = await createSigningKey(`xt-a-${runId}`);
  const signingB = await createSigningKey(`xt-b-${runId}`);
  await ownerA.mutation(api.hostApps.addKey, {
    hostAppPublicId: hostA.hostAppPublicId,
    kid: signingA.kid,
    alg: "ES256",
    publicKey: JSON.stringify(signingA.publicJwk),
  });
  await ownerB.mutation(api.hostApps.addKey, {
    hostAppPublicId: hostB.hostAppPublicId,
    kid: signingB.kid,
    alg: "ES256",
    publicKey: JSON.stringify(signingB.publicJwk),
  });

  let widgetMint = 0;
  async function widgetToken(signing, issuer, audience, sub) {
    widgetMint++;
    return await signWidgetToken(signing.privateKey, signing.kid, {
      iss: issuer,
      aud: audience,
      sub,
      jti: `xt_${runId}_${widgetMint}`,
      ...tokenTimes(),
      email: `${sub}@pilot.teamchat.test`,
      name: sub,
    });
  }

  async function exchange({ token, hostAppPublicId, origin }) {
    const client = new ConvexHttpClient(CLOUD);
    const result = await client.action(api.auth.signIn, {
      provider: "widget",
      params: { token, hostAppPublicId, origin },
    });
    const session = result?.tokens?.token;
    if (typeof session !== "string" || session === "") throw new Error("widget exchange returned no session");
    client.setAuth(session);
    return client;
  }

  const shadowA = await exchange({
    token: await widgetToken(signingA, issuerA, audienceA, `customer-a-${runId}`),
    hostAppPublicId: hostA.hostAppPublicId,
    origin: originA,
  });

  // -------------------------------------------------------------------------------------------
  // 1. Message by public id
  // -------------------------------------------------------------------------------------------

  await check("A API key reading a B message gets 404, byte-identical to an unknown id", async () => {
    const cross = await http("GET", `/v1/messages/${bMessagePublicId}`, { token: tenantA.key });
    const unknown = await http("GET", `/v1/messages/msg_does_not_exist_${runId}`, {
      token: tenantA.key,
    });
    assert(cross.status === 404, `cross status ${cross.status}`);
    assert(errorCode(cross) === "message_not_found", `code ${errorCode(cross)}`);
    assert(cross.text === unknown.text, "B message response differs from an unknown id");
    return "404 message_not_found, no existence oracle";
  });

  // -------------------------------------------------------------------------------------------
  // 2. External refs
  // -------------------------------------------------------------------------------------------

  await check("A API key resolving B externalRefs gets 404 for task, group and user", async () => {
    const task = await http("GET", `/v1/tasks?externalRef=${encodeURIComponent(bTaskRef)}&externalSource=xt`, {
      token: tenantA.key,
    });
    const group = await http("GET", `/v1/groups?externalRef=${encodeURIComponent(bGroupRef)}&externalSource=xt`, {
      token: tenantA.key,
    });
    const user = await http("GET", `/v1/users?externalRef=${encodeURIComponent(bUserRef)}&externalSource=xt`, {
      token: tenantA.key,
    });
    assert(task.status === 404 && errorCode(task) === "task_not_found", `task ${task.status} ${task.text}`);
    assert(group.status === 404 && errorCode(group) === "group_not_found", `group ${group.status} ${group.text}`);
    assert(user.status === 404 && errorCode(user) === "user_not_found", `user ${user.status} ${user.text}`);
    const serialised = `${task.text}${group.text}${user.text}`;
    assert(!serialised.includes(bMessagePublicId), "task 404 leaked the B message id");
    return "task/group/user all 404";
  });

  // -------------------------------------------------------------------------------------------
  // 3. Provisioning into a foreign group
  // -------------------------------------------------------------------------------------------

  await check("A provisioning into a B group is rejected and leaves no user on either side", async () => {
    const before = runInternal("groupMemberCount", { groupPublicId: tenantB.supportGroupPublicId });
    const attempt = await http("POST", "/v1/users/provision", {
      token: tenantA.key,
      headers: { "Idempotency-Key": `xt-attempt-${runId}` },
      body: JSON.stringify({
        externalSource: "xt",
        users: [
          {
            email: `xt-attempt+${runId}@pilot.teamchat.test`,
            name: "Cross tenant attempt",
            externalRef: bAttemptRef,
            groupPublicIds: [tenantB.supportGroupPublicId],
          },
        ],
      }),
    });
    assert(attempt.status >= 400 && attempt.status < 500, `status ${attempt.status}`);
    assert(errorCode(attempt) === "not_found", `code ${errorCode(attempt)}`);

    const asA = await http("GET", `/v1/users?externalRef=${encodeURIComponent(bAttemptRef)}&externalSource=xt`, {
      token: tenantA.key,
    });
    const asB = await http("GET", `/v1/users?externalRef=${encodeURIComponent(bAttemptRef)}&externalSource=xt`, {
      token: tenantB.key,
    });
    assert(asA.status === 404, `A still has the attempted user: ${asA.status}`);
    assert(asB.status === 404, `B received the attempted user: ${asB.status}`);
    const after = runInternal("groupMemberCount", { groupPublicId: tenantB.supportGroupPublicId });
    assert(after.members === before.members, `B support membership changed ${before.members} -> ${after.members}`);
    return `${attempt.status} ${errorCode(attempt)}; B membership ${after.members} unchanged`;
  });

  // -------------------------------------------------------------------------------------------
  // 4. Writing into a foreign group
  // -------------------------------------------------------------------------------------------

  await check("A API key posting into a B group gets 404 group_not_found", async () => {
    const response = await http("POST", "/v1/messages", {
      token: tenantA.key,
      headers: { "Idempotency-Key": `xt-post-b-${runId}` },
      body: JSON.stringify({
        groupPublicId: tenantB.supportGroupPublicId,
        text: `cross-tenant write ${runId}`,
      }),
    });
    assert(response.status === 404 && errorCode(response) === "group_not_found", `${response.status} ${response.text}`);
    const probe = await http("GET", `/v1/messages/${bMessagePublicId}`, { token: tenantB.key });
    assert(probe.status === 200, "B message became unreadable after the refused write");
    return "404 group_not_found";
  });

  // -------------------------------------------------------------------------------------------
  // 5. Webhooks and deliveries
  // -------------------------------------------------------------------------------------------

  await check("A admin cannot list B webhooks/deliveries, and A's own list contains none of B", async () => {
    const refused = await expectError(
      () => ownerA.query(api.webhooks.listForOrg, { orgPublicId: tenantB.orgPublicId, deliveryLimit: 10 }),
      "not a member",
    );
    assert(refused !== null, "A listed B webhooks");
    const own = await ownerA.query(api.webhooks.listForOrg, {
      orgPublicId: tenantA.orgPublicId,
      deliveryLimit: 10,
    });
    const serialised = JSON.stringify(own);
    assert(!serialised.includes(bHook.webhookPublicId), "B hook id appeared in A's list");
    assert(!serialised.includes(`xt-${runId}`), "B hook URL appeared in A's list");
    assert(!serialised.includes(bMessagePublicId), "B delivery appeared in A's list");
    return `B had ${bHooks.length} hook(s) and ${bDeliveries.length} delivery row(s); A saw neither`;
  });

  await check("A cannot mutate B webhook state", async () => {
    await expectError(
      () =>
        ownerA.mutation(api.webhooks.setActive, {
          orgPublicId: tenantB.orgPublicId,
          webhookPublicId: bHook.webhookPublicId,
          isActive: false,
        }),
      "not a member",
    );
    const after = await ownerB.query(api.webhooks.listForOrg, {
      orgPublicId: tenantB.orgPublicId,
      deliveryLimit: 1,
    });
    const hook = after.find((row) => row.publicId === bHook.webhookPublicId);
    assert(hook?.isActive === true, "B webhook was deactivated by A");
    return "still active";
  });

  // -------------------------------------------------------------------------------------------
  // 6. Widget: host A vs host B support group
  // -------------------------------------------------------------------------------------------

  await check("Host A widget token resolves only host A's support group", async () => {
    const me = await shadowA.query(api.widgets.messages.me, {});
    assert(me.hostAppPublicId === hostA.hostAppPublicId, `host ${me.hostAppPublicId}`);
    assert(me.supportGroupPublicId === tenantA.supportGroupPublicId, `support ${me.supportGroupPublicId}`);
    assert(me.supportGroupPublicId !== tenantB.supportGroupPublicId, "widget resolved B's support group");
    const conversation = await shadowA.query(api.widgets.messages.conversation, {});
    const serialised = JSON.stringify(conversation);
    assert(!serialised.includes(marker), "host A's conversation contains B's message text");
    assert(!serialised.includes(bMessagePublicId), "host A's conversation contains B's message id");
    return `${me.publicId} -> ${tenantA.supportGroupPublicId}`;
  });

  await check("Host A widget session cannot read B's support group through standalone queries", async () => {
    const attempts = [
      () =>
        shadowA.query(api.messages.listLive, {
          conversation: { kind: "group", publicId: tenantB.supportGroupPublicId },
        }),
      () => shadowA.query(api.messages.listReplies, { parentPublicId: bMessagePublicId }),
      () => shadowA.query(api.actionInbox.rollup, { groupPublicId: tenantB.supportGroupPublicId }),
      () => shadowA.query(api.groups.listMine, {}),
    ];
    for (const attempt of attempts) await expectError(attempt, "embedded widget");
    return "4 standalone reads refused by accountState";
  });

  await check("A token signed for host A is refused when presented as host B", async () => {
    const token = await widgetToken(signingA, issuerA, audienceA, `customer-b-${runId}`);
    const error = await expectError(
      () =>
        exchange({
          token,
          hostAppPublicId: hostB.hostAppPublicId,
          origin: originB,
        }),
      "unknown_key",
    );
    assert(error !== null, "host A token exchanged against host B");
    const bConversation = await ownerB.query(api.widgets.messages.conversation, {}).catch(() => null);
    assert(bConversation === null, "unexpected: owner session returned a widget conversation");
    return "selector switched, kid not found on host B";
  });

  await check("B's own widget host still works while A is refused (fixture is real)", async () => {
    const shadowB = await exchange({
      token: await widgetToken(signingB, issuerB, audienceB, `customer-b-${runId}`),
      hostAppPublicId: hostB.hostAppPublicId,
      origin: originB,
    });
    const me = await shadowB.query(api.widgets.messages.me, {});
    assert(me.hostAppPublicId === hostB.hostAppPublicId, `host ${me.hostAppPublicId}`);
    assert(me.supportGroupPublicId === tenantB.supportGroupPublicId, `support ${me.supportGroupPublicId}`);
    return `${me.publicId} -> ${tenantB.supportGroupPublicId}`;
  });
} catch (error) {
  failed++;
  failures.push(`setup: ${error.message}`);
  log(`FAIL  setup — ${error.stack ?? error.message}`);
} finally {
  for (const tenant of [tenantA, tenantB]) {
    if (tenant === null) continue;
    try {
      const purged = runInternal("purgeTenant", {
        orgPublicId: tenant.orgPublicId,
        deleteUsers: true,
      });
      log(`cleanup ${tenant.orgPublicId}: removed=${purged.removed} rows=${purged.deleted}`);
    } catch (error) {
      failed++;
      failures.push(`cleanup ${tenant.orgPublicId}: ${error.message}`);
      log(`FAIL  cleanup ${tenant.orgPublicId} — ${error.message}`);
    }
  }
}

log("");
if (redactions > 0) {
  log(`note: ${redactions} client refusal(s) were reported as Convex's production "Server Error";`);
  log("      the call still failed closed, and no data crossed the boundary.");
}
log(`checks: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  log("");
  for (const failure of failures) log(`  ${failure}`);
}

mkdirSync(join(appDir, "evidence"), { recursive: true });
const out = join(appDir, "evidence", "verify-cross-tenant.txt");
writeFileSync(
  out,
  [
    `Cross-tenant verification — ${new Date().toISOString()}`,
    `deployment: ${CLOUD}`,
    `site:       ${SITE}`,
    `run id:     ${runId}`,
    "",
    ...lines,
    "",
  ].join("\n"),
  "utf8",
);
console.log(`evidence: ${out}`);

if (failed > 0) process.exitCode = 1;
