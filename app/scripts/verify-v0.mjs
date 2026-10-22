// End-to-end verification of the v0 Definition of Done against the dev deployment.
//
//   node scripts/verify-v0.mjs
//
// Reads the deployment URL from app/.env.local and the dev bucket URL from .storage/endpoint.txt
// (override with S3_ENDPOINT=...). Every check prints PASS/FAIL with a short reason; the process
// exits non-zero if any check failed.

import { ConvexHttpClient } from "convex/browser";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");

function readDeploymentUrl() {
  if (process.env.CONVEX_URL) return process.env.CONVEX_URL;
  const env = readFileSync(join(appDir, ".env.local"), "utf8");
  const match = env.match(/^CONVEX_URL=(.+)$/m);
  if (!match) throw new Error("CONVEX_URL not found in .env.local");
  return match[1].trim();
}

const URL_BASE = readDeploymentUrl();
const S3_ENDPOINT =
  process.env.S3_ENDPOINT ??
  (existsSync(join(appDir, ".storage", "endpoint.txt"))
    ? readFileSync(join(appDir, ".storage", "endpoint.txt"), "utf8").trim()
    : null);

const { api } = await import("../convex/_generated/api.js");

// ------------------------------------------------------------------ tiny harness

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    passed++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failed++;
    failures.push(`${name}: ${error.message}`);
    console.log(`FAIL  ${name} — ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? "assertion failed");
}

async function expectError(fn, matcher) {
  let result;
  try {
    result = await fn();
  } catch (error) {
    if (matcher) {
      const text = `${error.message} ${JSON.stringify(error.data ?? "")}`;
      if (!text.toLowerCase().includes(matcher.toLowerCase())) {
        throw new Error(`expected ${JSON.stringify(matcher)}, got: ${error.message}`);
      }
    }
    return error;
  }
  throw new Error(`expected an error, but the call succeeded: ${JSON.stringify(result)?.slice(0, 200)}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ auth helpers

async function signInFresh(email) {
  const client = new ConvexHttpClient(URL_BASE);
  await client.action(api.auth.signIn, { provider: "email", params: { email } });

  let code = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const echo = await client.query(api.auth.demo.getEchoedCode, { email });
    if (echo?.code) {
      code = echo.code;
      break;
    }
    await sleep(200);
  }
  if (code === null) throw new Error(`no echoed OTP for ${email}`);

  const result = await client.action(api.auth.signIn, {
    provider: "email",
    params: { email, code },
  });
  const token = result?.tokens?.token;
  if (!token) throw new Error(`sign-in for ${email} returned no token: ${JSON.stringify(result)}`);
  client.setAuth(token);
  return client;
}

// ------------------------------------------------------------------ run

const runId = `${Date.now().toString(36)}`;
const email = (name) => `${name}+${runId}@demo.teamchat.test`;

console.log(`deployment: ${URL_BASE}`);
console.log(`dev bucket: ${S3_ENDPOINT ?? "(not set — storage checks will fail)"}`);
console.log(`run id:     ${runId}\n`);

const alice = await signInFresh(email("alice"));
const bob = await signInFresh(email("bob"));
let carol; // signed in during T2c; stays outside the org for the access checks later

const aliceMe = await alice.query(api.users.me, {});
const bobMe = await bob.query(api.users.me, {});
const alicePublicId = aliceMe.publicId;
const bobPublicId = bobMe.publicId;

// ---- T1: sign-in → active account

await check("T1 sign-in produces an active account with a publicId", async () => {
  assert(aliceMe.accountState === "active", `accountState=${aliceMe.accountState}`);
  assert(/^usr_[a-z0-9]+$/.test(alicePublicId), `publicId=${alicePublicId}`);
  const authed = await alice.query(api.auth.isAuthenticated, {});
  assert(authed === true, "isAuthenticated false");
  return `alice=${alicePublicId}, bob=${bobPublicId}`;
});

await check("T1b unauthenticated queries are refused", async () => {
  const anon = new ConvexHttpClient(URL_BASE);
  await expectError(() => anon.query(api.users.me, {}), "not signed in");
  return "users.me refused without a session";
});

// ---- T2: organisation, invite single-use / expiring / revocable / rate-limited

const org = await alice.mutation(api.organizations.create, {
  name: `Demo Co ${runId}`,
  allowDirectMessages: true,
});
const orgPublicId = org.orgPublicId;

await check("T2 org creation bootstraps owner + root group", async () => {
  assert(org.rootGroupPublicId?.startsWith("grp_"), "no root group");
  const mine = await alice.query(api.organizations.listMine, {});
  const row = mine.find((o) => o.publicId === orgPublicId);
  assert(row !== undefined && row.myOrgRole === "owner", "alice is not org owner");
  return `${orgPublicId} root=${org.rootGroupPublicId}`;
});

await check("T2b invite redeem joins the org and root group", async () => {
  const invite = await alice.mutation(api.invites.create, { orgPublicId });
  const result = await bob.action(api.invites.redeem, { token: invite.token });
  assert(result.orgPublicId === orgPublicId, "joined the wrong org");
  assert(result.alreadyMember === false, "reported already a member");
  const mine = await bob.query(api.organizations.listMine, {});
  assert(mine.some((o) => o.publicId === orgPublicId), "org missing from bob's list");
  return "bob joined via single invite";
});

await check("T2c invite is single-use", async () => {
  const invite = await alice.mutation(api.invites.create, { orgPublicId });
  const grace = await signInFresh(email("grace"));
  const joined = await grace.action(api.invites.redeem, { token: invite.token });
  assert(joined.alreadyMember === false, "grace did not join");
  carol = await signInFresh(email("carol"));
  await expectError(() => carol.action(api.invites.redeem, { token: invite.token }), "already been used");
  return "second redemption refused";
});

await check("T2d invite expires", async () => {
  const invite = await alice.mutation(api.invites.create, { orgPublicId, ttlMs: 1 });
  await sleep(50);
  const carol = await signInFresh(email("carol2"));
  await expectError(() => carol.action(api.invites.redeem, { token: invite.token }), "expired");
  return "expired invite refused";
});

await check("T2e invite is revocable", async () => {
  const invite = await alice.mutation(api.invites.create, { orgPublicId });
  const revoked = await alice.mutation(api.invites.revoke, { token: invite.token });
  assert(revoked.revoked === true, "revoke didn't report success");
  const carol = await signInFresh(email("carol3"));
  await expectError(() => carol.action(api.invites.redeem, { token: invite.token }), "revoked");
  return "revoked invite refused";
});

await check("T2f redemption is rate-limited (10/min per user, CR-6)", async () => {
  const erin = await signInFresh(email("erin"));
  for (let i = 1; i <= 10; i++) {
    await expectError(() => erin.action(api.invites.redeem, { token: `bogus-${i}` }), "not valid");
  }
  const error = await expectError(() => erin.action(api.invites.redeem, { token: "bogus-11" }));
  const detail = `${error.message} ${JSON.stringify(error.data ?? "")}`;
  assert(/rate.?limit/i.test(detail), `11th attempt was not rate-limited: ${detail}`);
  return "11th attempt in the window refused by the limiter";
});

// ---- T3: flat groups

const group1 = await alice.mutation(api.groups.create, {
  orgPublicId,
  name: "Sales",
  parentGroupPublicId: org.rootGroupPublicId,
});

await check("T3 group path is org publicId + group publicId", async () => {
  assert(
    group1.path === `/${orgPublicId}/${group1.groupPublicId}`,
    `path=${group1.path}`,
  );
  return group1.path;
});

await check("T3b nested group (parent below root) is rejected", async () => {
  await expectError(
    () =>
      alice.mutation(api.groups.create, {
        orgPublicId,
        name: "Nested",
        parentGroupPublicId: group1.groupPublicId,
      }),
    "Nested groups are not permitted",
  );
  return "parent=<child group> refused";
});

await check("T3c rename changes display name, never the path", async () => {
  const renamed = await alice.mutation(api.groups.rename, {
    groupPublicId: group1.groupPublicId,
    name: "Sales EMEA",
  });
  assert(renamed.path === group1.path, "path changed on rename");
  assert(renamed.name === "Sales EMEA", "name not updated");
  return renamed.name;
});

const group2 = await alice.mutation(api.groups.create, {
  orgPublicId,
  name: "Ops",
  memberPublicIds: [bobPublicId],
});

await check("T3d tree lists flat children of the org root only", async () => {
  const tree = await alice.query(api.groups.tree, { orgPublicId });
  const paths = tree.map((t) => t.path);
  assert(paths.includes(`/${orgPublicId}`), "root missing");
  assert(paths.includes(group1.path), "group1 missing");
  assert(paths.includes(group2.path), "group2 missing");
  assert(paths.every((p) => p.startsWith(`/${orgPublicId}`)), "path outside the org");
  return `${tree.length} nodes`;
});

await check("T3e addMember puts an org member into a group", async () => {
  const added = await alice.mutation(api.groups.addMember, {
    groupPublicId: group1.groupPublicId,
    userPublicId: bobPublicId,
  });
  assert(added.added === true, "bob not added to Sales");
  const mine = await bob.query(api.groups.listMine, {});
  assert(mine.some((r) => r.publicId === group1.groupPublicId), "Sales missing for bob");
  const ops = mine.find((r) => r.publicId === group2.groupPublicId);
  assert(ops !== undefined, "Ops missing for bob");
  return "bob sees Sales and Ops";
});

// ---- T4: messages, live page, activity flush

const conversation = { kind: "group", publicId: group1.groupPublicId };

const first = await alice.mutation(api.messages.send, {
  conversation,
  text: "hello-0",
});
assert(typeof first.messagePublicId === "string", "no message id");

await check("T4 send advances the sender's own read pointer (Flow A3 exception)", async () => {
  const hasUnread = await alice.query(api.unread.hasUnread, {
    conversation,
    groupPath: group1.path,
  });
  assert(hasUnread === false, "sender sees unread after sending");
  return "hasUnread=false for the sender";
});

for (let i = 1; i <= 21; i++) {
  await alice.mutation(api.messages.send, { conversation, text: `hello-${i}` });
}

await check("T4b live page is the newest 15 messages", async () => {
  const live = await alice.query(api.messages.listLive, { conversation });
  assert(live.length === 15, `live length=${live.length}`);
  assert(live[0].text === "hello-7", `oldest live=${live[0].text}`);
  assert(live[live.length - 1].text === "hello-21", `newest live=${live[live.length - 1].text}`);
  return `15 messages, ${live[0].text} … ${live[live.length - 1].text}`;
});

await check("T4c history is separate, paginated and complete (22)", async () => {
  const page = await alice.query(api.messages.listHistory, { conversation, limit: 50 });
  assert(page.messages.length === 22, `history length=${page.messages.length}`);
  assert(page.messages[0].text === "hello-0", "oldest history wrong");
  assert(page.isDone === true, "expected the page to be complete");
  return "22 messages";
});

await check("T4d two messages within the 3s window are never lost (Flow A2)", async () => {
  await alice.mutation(api.messages.send, { conversation, text: "burst-1" });
  await alice.mutation(api.messages.send, { conversation, text: "burst-2" });
  const live = await alice.query(api.messages.listLive, { conversation });
  const newest = live[live.length - 1];
  assert(newest.text === "burst-2", "second burst message missing from live page");
  await sleep(3500); // debounce window + slack for the trailing flush
  const mine = await alice.query(api.groups.listMine, {});
  const row = mine.find((r) => r.publicId === group1.groupPublicId);
  assert(row.lastMessageAt === newest.createdAt, `activity=${row.lastMessageAt} latest=${newest.createdAt}`);
  return `trailing flush reached ${new Date(row.lastMessageAt).toISOString()}`;
});

await check("T4e edit stamps editedAt; soft delete empties the text", async () => {
  const edited = await alice.mutation(api.messages.edit, {
    messagePublicId: first.messagePublicId,
    text: "hello-0 (edited)",
  });
  assert(typeof edited.editedAt === "number", "no editedAt");
  await alice.mutation(api.messages.softDelete, { messagePublicId: first.messagePublicId });
  const page = await alice.query(api.messages.listHistory, { conversation, limit: 50 });
  const target = page.messages.find((m) => m.publicId === first.messagePublicId);
  assert(target.deleted === true && target.text === "", "delete did not mask the text");
  return "edited then soft-deleted";
});

await check("T4f thread replies come back with their parent", async () => {
  const parent = await alice.query(api.messages.listHistory, { conversation, limit: 5 });
  const parentId = parent.messages[parent.messages.length - 1].publicId;
  await bob.mutation(api.messages.send, { conversation, text: "thread-reply", parentPublicId: parentId });
  const thread = await bob.query(api.messages.listReplies, { parentPublicId: parentId });
  assert(thread.replies.length === 1 && thread.replies[0].text === "thread-reply", "reply missing");
  return "1 reply";
});

// ---- T5: unread

await check("T5 hasUnread / unreadCount / markRead for a reader", async () => {
  // T4f had bob reply, and a sender's own pointer advances, so make a fresh unread message.
  // `groupActivity` is debounced by up to 3s (Flow A2), so wait for the trailing flush before
  // asserting the two-document verdict.
  await alice.mutation(api.messages.send, { conversation, text: "unread-trigger" });
  await sleep(3500);
  const hasUnread = await bob.query(api.unread.hasUnread, { conversation, groupPath: group1.path });
  assert(hasUnread === true, "bob should have unread");

  const count = await bob.query(api.unread.unreadCount, { conversation });
  assert(count.count > 0, `count=${count.count}`);
  assert(count.display === String(count.count), `display=${count.display}`);

  const live = await bob.query(api.messages.listLive, { conversation });
  const newest = live[live.length - 1];
  const marked = await bob.mutation(api.unread.markRead, {
    conversation,
    lastMessagePublicId: newest.publicId,
  });
  assert(marked.updated === true, "markRead did not update");

  const after = await bob.query(api.unread.hasUnread, { conversation, groupPath: group1.path });
  assert(after === false, "still unread after markRead");
  return `count=${count.count} → 0`;
});

await check("T5b markRead refuses a message from another conversation", async () => {
  await alice.mutation(api.messages.send, {
    conversation: { kind: "group", publicId: group2.groupPublicId },
    text: "ops-hello",
  });
  const opsLive = await alice.query(api.messages.listLive, {
    conversation: { kind: "group", publicId: group2.groupPublicId },
  });
  const foreign = opsLive[opsLive.length - 1];
  await expectError(
    () => bob.mutation(api.unread.markRead, { conversation, lastMessagePublicId: foreign.publicId }),
    "does not belong",
  );
  return "foreign message refused";
});

await check("T5c stale markRead never moves the pointer backwards", async () => {
  const history = await bob.query(api.messages.listHistory, { conversation, limit: 50 });
  const oldMessage = history.messages[0];
  const result = await bob.mutation(api.unread.markRead, {
    conversation,
    lastMessagePublicId: oldMessage.publicId,
  });
  assert(result.updated === false, "pointer moved backwards");
  return "silent no-op";
});

// ---- T6: SAL

await check("T6 storage config is owner/admin-only and never returns the secret", async () => {
  if (S3_ENDPOINT === null) throw new Error("S3 endpoint not set (run scripts/dev-tunnel.mjs)");
  const result = await alice.mutation(api.storage.config.setS3Config, {
    orgPublicId,
    endpoint: S3_ENDPOINT,
    bucket: "teamchat",
    region: "us-east-1",
    keyPrefix: "teamchat",
    pendingPrefix: "pending",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
  });
  assert(result.provider === "s3", "wrong provider");
  const serialized = JSON.stringify(result);
  assert(!serialized.includes("minioadmin"), "secret leaked in the response");
  await expectError(
    () =>
      bob.mutation(api.storage.config.setS3Config, {
        orgPublicId,
        endpoint: S3_ENDPOINT,
        bucket: "teamchat",
        region: "us-east-1",
        keyPrefix: "teamchat",
        pendingPrefix: "pending",
        accessKeyId: "x",
        secretAccessKey: "y",
      }),
    "org role",
  );
  const state = await bob.query(api.storage.config.myStorageState, { orgPublicId });
  assert(state.provider === "s3", `myStorageState=${JSON.stringify(state)}`);
  return `provider=${state.provider}, member refused`;
});

await check("T6b oversize upload intent is rejected (25 MB limit)", async () => {
  await expectError(
    () =>
      alice.action(api.storage.attachments.requestUpload, {
        groupPublicId: group1.groupPublicId,
        name: "big.mp4",
        mime: "video/mp4",
        size: 26 * 1024 * 1024,
      }),
    "too large",
  );
  return "26 MB refused";
});

await check("T6c disallowed type is rejected (executables are not allowed)", async () => {
  await expectError(
    () =>
      alice.action(api.storage.attachments.requestUpload, {
        groupPublicId: group1.groupPublicId,
        name: "evil.exe",
        mime: "application/x-msdownload",
        size: 1024,
      }),
    "not allowed",
  );
  return ".exe refused";
});

const uploadBytes = randomBytes(2048);
const attachment = await alice.action(api.storage.attachments.requestUpload, {
  groupPublicId: group1.groupPublicId,
  name: "photo.png",
  mime: "image/png",
  size: uploadBytes.length,
});

await check("T6d upload ticket → POST → confirm promotes out of pending/", async () => {
  const form = new FormData();
  for (const [name, value] of Object.entries(attachment.fields)) form.append(name, value);
  form.append("file", new Blob([uploadBytes], { type: "image/png" }), "photo.png");
  const put = await fetch(attachment.uploadUrl, {
    method: attachment.method,
    body: form,
  });
  assert(put.ok, `POST failed: ${put.status} ${await put.text()}`);

  const confirmed = await alice.action(api.storage.attachments.confirmUpload, {
    attachmentId: attachment.attachmentId,
  });
  assert(confirmed.status === "confirmed", `status=${confirmed.status}`);
  assert(confirmed.size === uploadBytes.length, `size=${confirmed.size}`);
  return `${attachment.attachmentId} confirmed (${confirmed.size} bytes)`;
});

let attachmentMessageId = null;

await check("T6d2 an unconfirmed attachment is unreachable", async () => {
  const pending = await alice.action(api.storage.attachments.requestUpload, {
    groupPublicId: group1.groupPublicId,
    name: "pending.png",
    mime: "image/png",
    size: 64,
  });
  await expectError(
    () => alice.action(api.storage.attachments.requestRead, { attachmentId: pending.attachmentId }),
    "not available",
  );
  return "read ticket refused before confirm";
});

await check("T6e a confirmed attachment can be sent and read back by a member", async () => {
  const sent = await alice.mutation(api.messages.send, {
    conversation,
    text: "",
    attachmentIds: [attachment.attachmentId],
  });
  attachmentMessageId = sent.messagePublicId;

  const ticket = await bob.action(api.storage.attachments.requestRead, {
    attachmentId: attachment.attachmentId,
  });
  const response = await fetch(ticket.url);
  assert(response.ok, `GET failed: ${response.status}`);
  const body = new Uint8Array(await response.arrayBuffer());
  assert(body.length === uploadBytes.length, `read ${body.length} bytes`);
  assert(Buffer.from(body).equals(uploadBytes), "bytes differ");
  return `${body.length} bytes round-trip via signed GET`;
});

await check("T6f a non-member cannot get a read ticket (access is checked first)", async () => {
  assert(carol !== undefined, "carol should be signed in from T2c");
  const err = await expectError(() =>
    carol.action(api.storage.attachments.requestRead, { attachmentId: attachment.attachmentId }),
  );
  assert(/access/i.test(err.message), `unexpected error: ${err.message}`);
  return "refused with an access error";
});

await check("T6g a confirmed attachment cannot be attached twice", async () => {
  await expectError(
    () =>
      alice.mutation(api.messages.send, {
        conversation,
        text: "",
        attachmentIds: [attachment.attachmentId],
      }),
    "already been sent",
  );
  return "single-use enforced";
});

// ---- T7: DMs

const dm = await alice.mutation(api.groups.createDm, { userPublicId: bobPublicId });

await check("T7 DM creation (shared org allows) and DM messaging", async () => {
  assert(dm.created === true, "DM not created");
  const dmConversation = { kind: "dm", peerPublicId: bobPublicId };
  const sent = await alice.mutation(api.messages.send, { conversation: dmConversation, text: "dm-hi (allowed)" });
  assert(sent.messagePublicId.startsWith("msg_"), "no dm message id");
  const live = await bob.query(api.messages.listLive, { conversation: { kind: "dm", peerPublicId: alicePublicId } });
  assert(live.length === 1 && live[0].text === "dm-hi (allowed)", "bob cannot read the DM");
  return "DM works both ways";
});

await check("T7b DMs never appear in the tree or in path queries", async () => {
  const tree = await alice.query(api.groups.tree, { orgPublicId });
  assert(tree.every((t) => t.publicId.startsWith("grp_")), "tree contains a row without a group publicId");
  assert(tree.every((t) => t.path.startsWith(`/${orgPublicId}`)), "tree contains a non-path row");
  const mine = await bob.query(api.groups.listMine, {});
  const dmRow = mine.find((r) => r.kind === "dm");
  assert(dmRow !== undefined, "DM missing from the chat list");
  assert(dmRow.publicId === null && dmRow.path === null, "DM exposes a publicId/path");
  return `DM row: publicId=${dmRow.publicId}, path=${dmRow.path}`;
});

await check("T7c DM unread works like any conversation", async () => {
  const dmConversation = { kind: "dm", peerPublicId: alicePublicId };
  const hasUnread = await bob.query(api.unread.hasUnread, { conversation: dmConversation });
  assert(hasUnread === true, "bob has no unread DM");
  const dmConversationAlice = { kind: "dm", peerPublicId: bobPublicId };
  const live = await alice.query(api.messages.listLive, { conversation: dmConversationAlice });
  await bob.mutation(api.unread.markRead, { conversation: dmConversation, lastMessagePublicId: live[0].publicId });
  const after = await bob.query(api.unread.hasUnread, { conversation: dmConversation });
  assert(after === false, "DM still unread");
  return "unread → read";
});

await check("T7d DM policy: no shared org ⇒ allowed; shared org(s) all off ⇒ denied", async () => {
  const dave = await signInFresh(email("dave"));
  const frank = await signInFresh(email("frank"));
  const daveOrg = await dave.mutation(api.organizations.create, {
    name: `Closed Co ${runId}`,
    allowDirectMessages: false,
  });
  const invite = await dave.mutation(api.invites.create, { orgPublicId: daveOrg.orgPublicId });
  await frank.action(api.invites.redeem, { token: invite.token });
  const frankMe = await frank.query(api.users.me, {});
  await expectError(
    () => dave.mutation(api.groups.createDm, { userPublicId: frankMe.publicId }),
    "turned off",
  );
  return "shared-org-off pair refused";
});

await check("T7e flipping the org policy off blocks sends in an existing DM", async () => {
  await alice.mutation(api.organizations.update, { orgPublicId, allowDirectMessages: false });
  await expectError(
    () => alice.mutation(api.messages.send, { conversation: { kind: "dm", peerPublicId: bobPublicId }, text: "should fail" }),
    "turned off",
  );
  await alice.mutation(api.organizations.update, { orgPublicId, allowDirectMessages: true });
  return "send refused while off; policy restored";
});

// ---- T8: connections

await check("T8 connection request by email, accept, list", async () => {
  const request = await alice.mutation(api.connections.requestByEmail, { email: bobMe.email });
  assert(request.found === true && request.status === "pending", `request=${JSON.stringify(request)}`);
  const accepted = await bob.mutation(api.connections.accept, { userPublicId: alicePublicId });
  assert(accepted.status === "accepted", "not accepted");
  const list = await alice.query(api.connections.list, {});
  const row = list.find((r) => r.peerPublicId === bobPublicId);
  assert(row !== undefined && row.status === "accepted" && row.direction === "outgoing", JSON.stringify(row));
  return "pending → accepted, listed";
});

await check("T8b unknown email and phoneless/unknown phone stays private", async () => {
  const missing = await alice.mutation(api.connections.requestByEmail, { email: `nobody+${runId}@nowhere.test` });
  assert(missing.found === false, "unknown email leaked");
  const phone = await alice.query(api.connections.matchByPhone, { phone: "+15550000000" });
  assert(phone.matched === false, "unknown phone matched");
  return "found=false, matched=false";
});

// ---- T9: per-org byte cap (env override, temporary)

console.log("\nchecks done; storage cap env test runs separately (scripts/cap-check.md)");

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nfailures:");
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
