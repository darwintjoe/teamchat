// End-to-end proof for the embedded widget surface (PRD Part 1 §1, §2, §4; Flow D2/D3; CR-8,
// CR-9, CR-11, CR-16, O2).
//
//   node scripts/verify-widget.mjs
//
// Requires: deployed dev functions, .env.local, .storage/endpoint.txt and a live storage tunnel.
// Writes app/evidence/verify-widget.txt and exits non-zero if any check fails.

import { ConvexHttpClient } from "convex/browser";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { api } from "../convex/_generated/api.js";
import {
  createSigningKey,
  signWidgetToken,
  tokenTimes,
} from "./lib/widgetAuth.mjs";
import { deploymentUrl, postUpload, storageEndpoint } from "./lib/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const URL_BASE = deploymentUrl();
const S3_ENDPOINT = storageEndpoint();

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

async function expectError(fn, matcher) {
  let result;
  try {
    result = await fn();
  } catch (error) {
    if (matcher !== undefined) {
      assert(
        textOf(error).toLowerCase().includes(matcher.toLowerCase()),
        `expected ${JSON.stringify(matcher)}, got: ${error.message}`,
      );
    }
    return error;
  }
  throw new Error(`expected an error, got: ${JSON.stringify(result)?.slice(0, 240)}`);
}

async function signInFresh(email) {
  const client = new ConvexHttpClient(URL_BASE);
  await client.action(api.auth.signIn, { provider: "email", params: { email } });
  let code = null;
  for (let attempt = 0; attempt < 60 && code === null; attempt++) {
    const echo = await client.query(api.auth.demo.getEchoedCode, { email });
    if (echo?.code) code = echo.code;
    else await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (code === null) throw new Error(`no echoed OTP for ${email}`);
  const result = await client.action(api.auth.signIn, {
    provider: "email",
    params: { email, code },
  });
  if (!result?.tokens?.token) throw new Error(`sign-in for ${email} returned no token`);
  client.setAuth(result.tokens.token);
  return client;
}

function containsInternalId(value, path = "$") {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = containsInternalId(value[i], `${path}[${i}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "_id" || key === "_creationTime") return `${path}.${key}`;
      const found = containsInternalId(child, `${path}.${key}`);
      if (found !== null) return found;
    }
  }
  return null;
}

const runId = `${Date.now().toString(36)}`;
const ORIGIN = "http://localhost:4310";
const ISSUER = `https://host-${runId}.example`;
const AUDIENCE = `teamchat-widget-${runId}`;

log(`deployment: ${URL_BASE}`);
log(`storage:    ${S3_ENDPOINT ?? "(not set)"}`);
log(`run id:     ${runId}`);
log("");

// ---------------------------------------------------------------- fixtures

const alice = await signInFresh(`widget-admin+${runId}@demo.teamchat.test`);
const bob = await signInFresh(`widget-outsider+${runId}@demo.teamchat.test`);

const org = await alice.mutation(api.organizations.create, {
  name: `Widget Verify ${runId}`,
  allowDirectMessages: true,
});
const orgPublicId = org.orgPublicId;
const supportGroupPublicId = org.rootGroupPublicId;

const host = await alice.mutation(api.hostApps.register, {
  orgPublicId,
  name: `Widget Verify Host ${runId}`,
  issuer: ISSUER,
  audience: AUDIENCE,
  allowedOrigins: [ORIGIN],
  supportGroupPublicId,
  primaryColor: "#0f766e",
});
const hostAppPublicId = host.hostAppPublicId;

const key = await createSigningKey(`kid_${runId}`);
const key2 = await createSigningKey(`kid2_${runId}`);
await alice.mutation(api.hostApps.addKey, {
  hostAppPublicId,
  kid: key.kid,
  alg: "ES256",
  publicKey: JSON.stringify(key.publicJwk),
});

if (S3_ENDPOINT !== null) {
  await alice.mutation(api.storage.config.setS3Config, {
    orgPublicId,
    endpoint: S3_ENDPOINT,
    bucket: "teamchat",
    region: "us-east-1",
    keyPrefix: "widget-verify",
    pendingPrefix: "pending",
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
  });
}

let mintCounter = 0;
function claims(overrides = {}) {
  const times = tokenTimes();
  mintCounter++;
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: `customer-${runId}-a`,
    jti: `jti_${runId}_${mintCounter}`,
    iat: times.iat,
    exp: times.exp,
    email: `customer-a+${runId}@demo.teamchat.test`,
    name: "Customer A",
    ...overrides,
  };
}

function mint(overrides = {}, signingKey = key, headerOptions = {}) {
  return signWidgetToken(signingKey.privateKey, signingKey.kid, claims(overrides), headerOptions);
}

function anonymous() {
  return new ConvexHttpClient(URL_BASE);
}

async function exchange(token, { origin = ORIGIN, hostApp = hostAppPublicId } = {}) {
  const resolved = await token;
  const client = anonymous();
  const result = await client.action(api.auth.signIn, {
    provider: "widget",
    params: { token: resolved, hostAppPublicId: hostApp, origin },
  });
  const session = result?.tokens?.token;
  if (typeof session !== "string" || session === "") throw new Error("exchange returned no session");
  client.setAuth(session);
  return client;
}

// ---------------------------------------------------------------- registration / keys

await check("R1 host app registration is org-admin only", async () => {
  await expectError(
    () =>
      bob.mutation(api.hostApps.register, {
        orgPublicId,
        name: "Unauthorised",
        issuer: ISSUER,
        audience: AUDIENCE,
        allowedOrigins: [ORIGIN],
        supportGroupPublicId,
      }),
    "not a member",
  );
  await expectError(() => bob.query(api.hostApps.listForOrg, { orgPublicId }), "not a member");
  return "outsider refused at register and listForOrg";
});

await check("R2 private key material is refused at registration", async () => {
  await expectError(
    () =>
      alice.mutation(api.hostApps.addKey, {
        hostAppPublicId,
        kid: `private_${runId}`,
        alg: "ES256",
        publicKey: JSON.stringify({ ...key.privateJwk }),
      }),
    "private key material",
  );
  return "d is never stored";
});

await check("R3 origins must be bare origins and support group must be in the org", async () => {
  await expectError(
    () =>
      alice.mutation(api.hostApps.register, {
        orgPublicId,
        name: "Bad origin",
        issuer: ISSUER,
        audience: AUDIENCE,
        allowedOrigins: [`${ORIGIN}/path`],
        supportGroupPublicId,
      }),
    "origin only",
  );
  const otherOrg = await alice.mutation(api.organizations.create, {
    name: `Other ${runId}`,
    allowDirectMessages: false,
  });
  await expectError(
    () =>
      alice.mutation(api.hostApps.register, {
        orgPublicId,
        name: "Cross-org group",
        issuer: ISSUER,
        audience: AUDIENCE,
        allowedOrigins: [ORIGIN],
        supportGroupPublicId: otherOrg.rootGroupPublicId,
      }),
    "must belong to this organisation",
  );
  return "path origins and cross-org support groups refused";
});

await check("R4 stored keys are public only", async () => {
  const apps = await alice.query(api.hostApps.listForOrg, { orgPublicId });
  const app = apps.find((value) => value.publicId === hostAppPublicId);
  assert(app !== undefined, "host app missing");
  assert(app.keys.length === 1, `expected one key, got ${app.keys.length}`);
  const jwk = JSON.parse(app.keys[0].publicKey);
  assert(typeof jwk.d !== "string" && typeof jwk.p !== "string", "private material returned");
  return `${app.keys[0].kid} · ${app.keys[0].alg}`;
});

// ---------------------------------------------------------------- exchange trust order

const valid = await exchange(mint());

await check("E1 kid is resolved before anything else", async () => {
  await expectError(() => exchange(mint({}, { ...key, kid: `missing_${runId}` })), "unknown_key");
  return "unknown kid refused";
});

await check("E2 signature is checked against the stored public key", async () => {
  await expectError(
    () => exchange(signWidgetToken(key2.privateKey, key.kid, claims())),
    "bad_signature",
  );
  return "forged signature refused";
});

await check("E3 issuer must match the host app", async () => {
  await expectError(() => exchange(mint({ iss: `${ISSUER}.evil` })), "issuer_mismatch");
  return "iss mismatch refused";
});

await check("E4 audience must match the host app", async () => {
  await expectError(() => exchange(mint({ aud: `${AUDIENCE}-other` })), "audience_mismatch");
  return "aud mismatch refused";
});

await check("E5 expiry and token lifetime are bounded", async () => {
  const now = Math.floor(Date.now() / 1000);
  await expectError(() => exchange(mint({ iat: now - 420, exp: now - 240 })), "expired");
  await expectError(() => exchange(mint({ iat: now + 300, exp: now + 420 })), "not_yet_valid");
  await expectError(() => exchange(mint({ iat: now - 120, exp: now + 300 })), "expiry_window");
  return "expired, future-issued and >300s tokens refused";
});

await check("E6 required claims are enforced", async () => {
  const base = claims();
  delete base.jti;
  const noJti = await signWidgetToken(key.privateKey, key.kid, base);
  await expectError(() => exchange(noJti), "missing_claim");
  const base2 = claims();
  delete base2.sub;
  const noSub = await signWidgetToken(key.privateKey, key.kid, base2);
  await expectError(() => exchange(noSub), "missing_claim");
  return "jti and sub required";
});

await check("E7 alg is tied to the stored key", async () => {
  await expectError(() => exchange(mint({}, key, { alg: "RS256" })), "alg_mismatch");
  return "header alg cannot downgrade/upgrade the key";
});

await check("E8 jti replay is refused", async () => {
  const token = mint({ sub: `replay-${runId}` });
  await exchange(token);
  const error = await expectError(() => exchange(token), "replayed");
  assert(error !== null, "replay succeeded");
  return "same jti accepted once";
});

await check("E9 iframe origin allowlist is enforced and audited", async () => {
  await expectError(() => exchange(mint(), { origin: "https://evil.example" }), "origin_not_allowed");
  const audit = await alice.query(api.hostApps.auditForOrg, { orgPublicId });
  const rejected = audit.find((row) => row.kind === "origin_rejected");
  assert(rejected !== undefined, "no origin_rejected audit row");
  return "origin refused and logged";
});

await check("E10 inactive host app refuses every exchange", async () => {
  await alice.mutation(api.hostApps.setActive, { hostAppPublicId, isActive: false });
  await expectError(() => exchange(mint()), "unknown_key");
  await alice.mutation(api.hostApps.setActive, { hostAppPublicId, isActive: true });
  return "isActive=false is a hard stop";
});

await check("E11 key validity windows are enforced", async () => {
  const future = await createSigningKey(`future_${runId}`);
  await alice.mutation(api.hostApps.addKey, {
    hostAppPublicId,
    kid: future.kid,
    alg: "ES256",
    publicKey: JSON.stringify(future.publicJwk),
    notBefore: Date.now() + 60_000,
  });
  await expectError(
    () => exchange(signWidgetToken(future.privateKey, future.kid, claims())),
    "key_not_yet_valid",
  );
  const past = await createSigningKey(`past_${runId}`);
  await alice.mutation(api.hostApps.addKey, {
    hostAppPublicId,
    kid: past.kid,
    alg: "ES256",
    publicKey: JSON.stringify(past.publicJwk),
    notBefore: Date.now() - 300_000,
    notAfter: Date.now() - 120_000,
  });
  await expectError(
    () => exchange(signWidgetToken(past.privateKey, past.kid, claims())),
    "key_expired",
  );
  return "notBefore and notAfter enforced";
});

await check("E12 key rotation keeps both kids valid", async () => {
  await alice.mutation(api.hostApps.addKey, {
    hostAppPublicId,
    kid: key2.kid,
    alg: "ES256",
    publicKey: JSON.stringify(key2.publicJwk),
  });
  const rotated = await exchange(
    signWidgetToken(key2.privateKey, key2.kid, claims({ sub: `rotated-${runId}` })),
  );
  const me = await rotated.query(api.widgets.messages.me, {});
  assert(me.accountState === "shadow", "rotated key did not resolve a shadow");
  return `${key2.kid} accepted while ${key.kid} remains valid`;
});

// ---------------------------------------------------------------- shadow identity / confinement

await check("S1 exchange creates a shadow with a public identity only", async () => {
  const me = await valid.query(api.widgets.messages.me, {});
  assert(me.accountState === "shadow", `accountState=${me.accountState}`);
  assert(/^usr_/.test(me.publicId), `publicId=${me.publicId}`);
  assert(me.hostAppPublicId === hostAppPublicId, "wrong host app");
  const conversation = await valid.query(api.widgets.messages.conversation, {});
  const leak = containsInternalId(me) ?? containsInternalId(conversation);
  assert(leak === null, `internal id leaked at ${leak}`);
  return `${me.publicId} · no _id in me/conversation`;
});

await check("S2 same externalUserId resolves the same shadow even if email changes", async () => {
  const before = await valid.query(api.widgets.messages.me, {});
  const other = await exchange(
    mint({ sub: `customer-${runId}-a`, email: `changed+${runId}@demo.teamchat.test` }),
  );
  const after = await other.query(api.widgets.messages.me, {});
  assert(before.publicId === after.publicId, `${before.publicId} != ${after.publicId}`);
  return "identity key is hostAppId + externalUserId";
});

await check("S3 same email with a different external id is a different shadow", async () => {
  const first = await valid.query(api.widgets.messages.me, {});
  const second = await exchange(
    mint({ sub: `customer-${runId}-b`, email: `customer-a+${runId}@demo.teamchat.test` }),
  );
  const me = await second.query(api.widgets.messages.me, {});
  assert(first.publicId !== me.publicId, "email was used as an identity key");
  return `${first.publicId} != ${me.publicId}`;
});

await check("S4 a shadow cannot sign in to the standalone app", async () => {
  const shadowEmail = `customer-a+${runId}@demo.teamchat.test`;
  const probe = anonymous();
  await expectError(
    () =>
      probe.action(api.auth.signIn, {
        provider: "email",
        params: { email: shadowEmail },
      }),
    "shadow",
  );
  return "OTP sign-in refused before a code is issued";
});

await check("S5 shadow is confined to widget-only reads and writes", async () => {
  const attempts = [
    ["groups.listMine", () => valid.query(api.groups.listMine, {})],
    [
      "messages.listLive",
      () => valid.query(api.messages.listLive, { conversation: { kind: "group", publicId: supportGroupPublicId } }),
    ],
    ["actionInbox.rollup", () => valid.query(api.actionInbox.rollup, { groupPublicId: supportGroupPublicId })],
    ["actionInbox.myTasks", () => valid.query(api.actionInbox.myTasks, {})],
    ["unread.hasUnread", () => valid.query(api.unread.hasUnread, { conversation: { kind: "group", publicId: supportGroupPublicId } })],
    ["connections.list", () => valid.query(api.connections.list, {})],
    [
      "messages.send",
      () => valid.mutation(api.messages.send, { conversation: { kind: "group", publicId: supportGroupPublicId }, text: "nope" }),
    ],
    [
      "groups.createDm",
      () => valid.mutation(api.groups.createDm, { userPublicId: "usr_nobody" }),
    ],
  ];
  const blocked = [];
  for (const [name, call] of attempts) {
    await expectError(call);
    blocked.push(name);
  }
  return blocked.join(", ");
});

// ---------------------------------------------------------------- action mode + threading

let firstTicket = null;
let firstRootMessage = null;
let claimedTask = null;

await check("A1 widget sends are forced to Action mode and audited", async () => {
  const sent = await valid.mutation(api.widgets.messages.sendMessage, {
    text: "My order arrived damaged",
    mode: "discussion",
  });
  assert(sent.mode === "action", `mode=${sent.mode}`);
  assert(sent.ticketCreated === true, "first message did not create a ticket");
  firstTicket = sent.ticketPublicId;
  firstRootMessage = sent.messagePublicId;
  const conversation = await valid.query(api.widgets.messages.conversation, {});
  const message = conversation.messages.find((row) => row.publicId === sent.messagePublicId);
  assert(message !== undefined && message.mode === "action", "stored mode is not action");
  const audit = await alice.query(api.hostApps.auditForOrg, { orgPublicId });
  assert(audit.some((row) => row.kind === "mode_override"), "no mode_override audit row");
  return `task ${firstTicket} · mode action · override logged`;
});

await check("A2 the ticket is an Action task with senderMayClose=false", async () => {
  const rollup = await alice.query(api.actionInbox.rollup, {
    groupPublicId: supportGroupPublicId,
    status: "open",
  });
  const task = rollup.tasks.find((row) => row.publicId === firstTicket);
  assert(task !== undefined, "ticket missing from the agent rollup");
  assert(task.senderMayClose === false, "senderMayClose must be false");
  assert(task.flagType === "support_ticket", `flagType=${task.flagType}`);
  claimedTask = task.publicId;
  return `${task.publicId} · support_ticket · senderMayClose=false`;
});

await check("A3 later widget messages thread under the same ticket", async () => {
  const sent = await valid.mutation(api.widgets.messages.sendMessage, { text: "Order #NW-1042" });
  assert(sent.ticketPublicId === firstTicket, "reply created a different ticket");
  assert(sent.ticketCreated === false, "reply reported a new ticket");
  const conversation = await valid.query(api.widgets.messages.conversation, {});
  assert(conversation.ticketCount === 1, `ticketCount=${conversation.ticketCount}`);
  const reply = conversation.messages.find((row) => row.publicId === sent.messagePublicId);
  assert(reply !== undefined && reply.isReply === true, "reply is not a thread reply");
  return "one ticket, replies are by_parent";
});

await check("A4 widget has no edit or delete surface", async () => {
  const source = readFileSync(join(appDir, "convex", "widgets", "messages.ts"), "utf8");
  assert(!/export const\s+(edit|softDelete)\b/.test(source), "widget module exports edit/softDelete");
  await expectError(
    () => valid.mutation(api.messages.edit, { messagePublicId: firstRootMessage, text: "changed" }),
  );
  return "no widget edit/delete; generic edit refuses shadow";
});

await check("A5 a shadow cannot claim its own ticket", async () => {
  await expectError(() => valid.mutation(api.actionInbox.claim, { taskPublicId: claimedTask }));
  return "claim requires an active agent";
});

await check("A6 done ticket reply reopens the same claimant with customer_reply", async () => {
  await alice.mutation(api.actionInbox.claim, { taskPublicId: claimedTask });
  await alice.mutation(api.actionInbox.markDone, { taskPublicId: claimedTask });
  const reply = await valid.mutation(api.widgets.messages.sendMessage, { text: "It is still broken" });
  assert(reply.reopened === true, "reply did not reopen");
  assert(reply.ticketPublicId === claimedTask, "reopened a different ticket");
  const events = await alice.query(api.actionInbox.events, { taskPublicId: claimedTask });
  const reopened = [...events.events].reverse().find((event) => event.action === "reopened");
  assert(reopened !== undefined, "no reopened event");
  assert(reopened.reason === "customer_reply", `reason=${reopened.reason}`);
  const rollup = await alice.query(api.actionInbox.rollup, {
    groupPublicId: supportGroupPublicId,
    status: "claimed",
  });
  const task = rollup.tasks.find((row) => row.publicId === claimedTask);
  assert(task?.claimedByPublicId !== null && task?.claimedByPublicId !== undefined, "claimant lost");
  return `same ticket, reason=customer_reply`;
});

await check("A7 closed ticket reply opens a new ticket", async () => {
  await alice.mutation(api.actionInbox.close, { taskPublicId: claimedTask });
  const sent = await valid.mutation(api.widgets.messages.sendMessage, {
    text: "A different problem",
  });
  assert(sent.ticketCreated === true, "closed ticket accepted a reply");
  assert(sent.ticketPublicId !== claimedTask, "reused the closed ticket");
  const conversation = await valid.query(api.widgets.messages.conversation, {});
  assert(conversation.ticketCount === 2, `ticketCount=${conversation.ticketCount}`);
  return `new ticket ${sent.ticketPublicId}`;
});

// ---------------------------------------------------------------- uploads

await check("U1 widget uploads are blocked by default", async () => {
  const error = await expectError(
    () =>
      valid.action(api.widgets.uploads.requestWidgetUpload, {
        name: "receipt.png",
        mime: "image/png",
        size: 128,
      }),
    "disabled",
  );
  assert(error !== null);
  const audit = await alice.query(api.hostApps.auditForOrg, { orgPublicId });
  assert(audit.some((row) => row.kind === "upload_denied"), "no upload_denied audit row");
  return "opt-in is off; denial logged";
});

await check("U2 per-host size and MIME limits are enforced", async () => {
  await alice.mutation(api.hostApps.configureUploads, {
    hostAppPublicId,
    allowWidgetUploads: true,
    maxFileBytes: 1024 * 1024,
    allowedMimes: ["image/png", "application/pdf"],
    maxPerMinute: 2,
  });
  await expectError(
    () =>
      valid.action(api.widgets.uploads.requestWidgetUpload, {
        name: "notes.csv",
        mime: "text/csv",
        size: 100,
      }),
    "not allowed",
  );
  await expectError(
    () =>
      valid.action(api.widgets.uploads.requestWidgetUpload, {
        name: "huge.png",
        mime: "image/png",
        size: 2 * 1024 * 1024,
      }),
    "file size",
  );
  return "MIME and size outside the host policy refused";
});

await check("U3 opted-in upload is org-scoped end to end", async () => {
  if (S3_ENDPOINT === null) throw new Error("storage endpoint not configured");
  const ticket = await valid.action(api.widgets.uploads.requestWidgetUpload, {
    name: "receipt.png",
    mime: "image/png",
    size: 512,
  });
  assert(/^att_/.test(ticket.attachmentId), "attachmentId is not public");
  assert(ticket.method === "POST", "unexpected upload method");
  const bytes = new Uint8Array(512).fill(7);
  await postUpload(ticket, bytes, "receipt.png", "image/png");
  const confirmed = await valid.action(api.widgets.uploads.confirmWidgetUpload, {
    attachmentId: ticket.attachmentId,
  });
  assert(confirmed.status === "confirmed", "upload not confirmed");
  assert(confirmed.scope === "org", `scope=${confirmed.scope}`);
  const sent = await valid.mutation(api.widgets.messages.sendMessage, {
    text: "Receipt attached",
    attachmentIds: [ticket.attachmentId],
  });
  const conversation = await valid.query(api.widgets.messages.conversation, {});
  const message = conversation.messages.find((row) => row.publicId === sent.messagePublicId);
  assert(message !== undefined && message.attachments.length === 1, "attachment missing from thread");
  const link = await valid.action(api.widgets.messages.attachmentUrl, {
    attachmentId: ticket.attachmentId,
  });
  const response = await fetch(link.url);
  assert(response.ok, `signed read failed: ${response.status}`);
  const downloaded = new Uint8Array(await response.arrayBuffer());
  assert(downloaded.length === bytes.length, `read ${downloaded.length} bytes, wrote ${bytes.length}`);
  return `${ticket.attachmentId} · org scope · signed read ${downloaded.length}B`;
});

await check("U4 per-shadow upload rate limit is enforced", async () => {
  const rateUser = await exchange(mint({ sub: `rate-${runId}`, email: `rate+${runId}@demo.teamchat.test` }));
  await rateUser.action(api.widgets.uploads.requestWidgetUpload, {
    name: "one.png",
    mime: "image/png",
    size: 64,
  });
  await rateUser.action(api.widgets.uploads.requestWidgetUpload, {
    name: "two.png",
    mime: "image/png",
    size: 64,
  });
  await expectError(
    () =>
      rateUser.action(api.widgets.uploads.requestWidgetUpload, {
        name: "three.png",
        mime: "image/png",
        size: 64,
      }),
    "too many",
  );
  return "third request in the fixed window refused";
});

// ---------------------------------------------------------------- public config / admin

await check("P1 public config is unauthenticated, branded and free of internal ids", async () => {
  const anon = anonymous();
  const config = await anon.query(api.hostApps.publicConfig, { hostAppPublicId });
  assert(config.primaryColor === "#0f766e", "branding not exposed");
  assert(config.allowedOrigins.includes(ORIGIN), "origin allowlist not exposed");
  assert(config.uploadsEnabled === true, "upload flag not exposed");
  const serialised = JSON.stringify(config);
  assert(!serialised.includes("orgId"), "orgId leaked");
  assert(!serialised.includes("supportGroup"), "support group leaked");
  return "name, origins, branding, uploads flag only";
});

await check("P2 host app admin never returns private key material", async () => {
  const apps = await alice.query(api.hostApps.listForOrg, { orgPublicId });
  const serialised = JSON.stringify(apps);
  assert(!serialised.includes('"d"'), "private exponent leaked");
  assert(!serialised.includes('"p"'), "RSA private factor leaked");
  return `${apps.length} host app(s), public JWKs only`;
});

// ---------------------------------------------------------------- exchange rate limit (last)

await check("E13 exchange per-IP rate limit stops a burst", async () => {
  const anon = anonymous();
  let tripped = false;
  let last = "";
  for (let i = 0; i < 40 && !tripped; i++) {
    try {
      const token = await mint({}, { ...key, kid: `burst_missing_${runId}` });
      await anon.action(api.auth.signIn, {
        provider: "widget",
        params: { token, hostAppPublicId, origin: ORIGIN },
      });
    } catch (error) {
      last = textOf(error);
      if (/too many|rate.?limit/i.test(last)) tripped = true;
    }
  }
  assert(tripped, `burst was not rate-limited; last error: ${last}`);
  return "per-IP exchange limiter engaged";
});

// ---------------------------------------------------------------- report

log("");
log(`${passed} passed, ${failed} failed`);
if (failed > 0) log(`failures:\n${failures.map((value) => `  - ${value}`).join("\n")}`);
mkdirSync(join(appDir, "evidence"), { recursive: true });
writeFileSync(join(appDir, "evidence", "verify-widget.txt"), `${lines.join("\n")}\n`, "utf8");
console.log(`\nevidence: app/evidence/verify-widget.txt`);
if (failed > 0) process.exitCode = 1;
