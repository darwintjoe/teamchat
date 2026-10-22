// Proves the attachment read path resolves ONLY from `messages.attachments[].storageRef`.
//
//   node scripts/attachment-read-path.mjs
//
// The real SAL flow creates an attachment and records it on a message. The test then tampers with
// the `attachments` bookkeeping row through internal (non-public) test hooks:
//   1. row fileKey changed       -> read still signs the message's original key
//   2. message storageRef changed -> read signs the changed message key
//   3. attachment removed from the message -> read is refused even though the row is confirmed
//
// The dev S3 (s3rver) does not enforce POST policies; the ticket's policy is decoded and asserted
// separately. HEAD-at-confirm remains the size/type backstop.

import { ConvexHttpClient } from "convex/browser";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "../convex/_generated/api.js";
import {
  appDir,
  decodePolicy,
  deploymentUrl,
  postUpload,
  signInFresh,
  storageEndpoint,
} from "./lib/harness.mjs";

const url = deploymentUrl();
const endpoint = storageEndpoint();
if (endpoint === null) throw new Error("No dev storage endpoint; start scripts/dev-storage.mjs and the tunnel");

const runId = Date.now().toString(36);
const email = `attach.probe.${runId}@demo.teamchat.test`;
const client = new ConvexHttpClient(url);
await signInFresh(client, email);

const org = await client.mutation(api.organizations.create, {
  name: `Attachment probe ${runId}`,
  allowDirectMessages: false,
});
const group = await client.mutation(api.groups.create, {
  orgPublicId: org.orgPublicId,
  name: "Read path",
  parentGroupPublicId: org.rootGroupPublicId,
});
await client.mutation(api.storage.config.setS3Config, {
  orgPublicId: org.orgPublicId,
  endpoint,
  bucket: "teamchat",
  region: "us-east-1",
  keyPrefix: "teamchat",
  pendingPrefix: "pending",
  accessKeyId: "minioadmin",
  secretAccessKey: "minioadmin",
});

const bytes = new Uint8Array(2048);
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
const ticket = await client.action(api.storage.attachments.requestUpload, {
  groupPublicId: group.groupPublicId,
  name: "read-path.png",
  mime: "image/png",
  size: bytes.length,
});

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- ticket policy assertions -------------------------------------------------
check("ticket is a POST, not a PUT", ticket.method === "POST", ticket.method);
const policy = decodePolicy(ticket);
const conditions = JSON.stringify(policy.conditions);
check(
  "policy carries content-length-range bounded by the declared size",
  policy.conditions.some(
    (condition) =>
      Array.isArray(condition) &&
      condition[0] === "content-length-range" &&
      condition[1] === 1 &&
      condition[2] === bytes.length,
  ),
  conditions,
);
check(
  "policy pins the exact key and Content-Type",
  policy.conditions.some((c) => c && c.key === ticket.fields.key) &&
    policy.conditions.some((c) => c && c["Content-Type"] === "image/png"),
  conditions,
);

await postUpload(ticket, bytes, "read-path.png", "image/png");
const confirmed = await client.action(api.storage.attachments.confirmUpload, {
  attachmentId: ticket.attachmentId,
});
check("confirm accepts the posted object", confirmed.status === "confirmed", `${confirmed.size} bytes`);

const sent = await client.mutation(api.messages.send, {
  conversation: { kind: "group", publicId: group.groupPublicId },
  text: "",
  attachmentIds: [ticket.attachmentId],
});

const firstRead = await client.action(api.storage.attachments.requestRead, {
  attachmentId: ticket.attachmentId,
});
const firstPath = decodeURIComponent(new URL(firstRead.url).pathname);
check(
  "read signs the key recorded on the message",
  firstPath.includes(ticket.attachmentId) && firstPath.includes("read-path.png"),
  firstPath,
);

// --- internal test hooks (admin CLI, not public functions) ---------------------
function runHook(name, args) {
  // Invoke the Convex CLI's JS entry point directly. Going through npx.cmd on Windows lets cmd
  // strip the JSON argument's quotes before it reaches the CLI.
  const output = execFileSync(
    process.execPath,
    [join(appDir, "node_modules", "convex", "bin", "main.js"), "run", `testing:${name}`, JSON.stringify(args)],
    { cwd: appDir, encoding: "utf8" },
  );
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  return start >= 0 && end > start ? JSON.parse(output.slice(start, end + 1)) : null;
}

const state = runHook("readProbeState", {
  attachmentId: ticket.attachmentId,
  messagePublicId: sent.messagePublicId,
});
check(
  "the message and bookkeeping row initially agree",
  state.rowFileKey === state.messageFileKey && state.rowStatus === "confirmed",
  state.messageFileKey,
);

runHook("setAttachmentRowFileKey", {
  attachmentId: ticket.attachmentId,
  fileKey: `tampered/row-only/${ticket.attachmentId}`,
});
const afterRowTamper = await client.action(api.storage.attachments.requestRead, {
  attachmentId: ticket.attachmentId,
});
const afterRowPath = decodeURIComponent(new URL(afterRowTamper.url).pathname);
check(
  "changing the attachments row fileKey does not change the signed key",
  afterRowPath === firstPath,
  afterRowPath,
);

const messageKey = `tampered/from-message/${ticket.attachmentId}`;
runHook("setMessageAttachmentFileKey", {
  messagePublicId: sent.messagePublicId,
  attachmentId: ticket.attachmentId,
  fileKey: messageKey,
});
const afterMessageTamper = await client.action(api.storage.attachments.requestRead, {
  attachmentId: ticket.attachmentId,
});
const afterMessagePath = decodeURIComponent(new URL(afterMessageTamper.url).pathname);
check(
  "changing the message storageRef changes the signed key",
  afterMessagePath.includes(messageKey),
  afterMessagePath,
);

runHook("removeMessageAttachment", {
  messagePublicId: sent.messagePublicId,
  attachmentId: ticket.attachmentId,
});
const afterRemovalState = runHook("readProbeState", {
  attachmentId: ticket.attachmentId,
  messagePublicId: sent.messagePublicId,
});
let removalError = null;
try {
  await client.action(api.storage.attachments.requestRead, { attachmentId: ticket.attachmentId });
} catch (error) {
  removalError = error;
}
check(
  "a confirmed row that the message no longer lists is unreachable",
  removalError !== null &&
    /not available/i.test(`${removalError.message} ${JSON.stringify(removalError.data ?? "")}`) &&
    afterRemovalState.messageAttachmentPresent === false &&
    afterRemovalState.rowStatus === "confirmed",
  removalError?.message.split("\n").slice(-1)[0]?.slice(0, 160) ?? "no error",
);

const evidence = [
  `runAt: ${new Date().toISOString()}`,
  `deployment: ${url}`,
  `org: ${org.orgPublicId}`,
  `group: ${group.groupPublicId}`,
  `attachment: ${ticket.attachmentId}`,
  `message: ${sent.messagePublicId}`,
  `passed: ${passed}`,
  `failed: ${failures.length}`,
  ...failures.map((name) => `failed check: ${name}`),
].join("\n");
mkdirSync(join(appDir, "evidence"), { recursive: true });
writeFileSync(join(appDir, "evidence", "part1-attachment-read.txt"), `${evidence}\n`);
console.log(`\n${passed} passed, ${failures.length} failed`);
console.log("evidence: evidence/part1-attachment-read.txt");
process.exit(failures.length === 0 ? 0 : 1);
