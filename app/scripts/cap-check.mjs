// Per-org byte cap check. Run against a deployment with a temporary small cap:
//
//   npx convex env set TEAMCHAT_ORG_STORAGE_CAP_BYTES 1000000
//   node scripts/cap-check.mjs
//   npx convex env unset TEAMCHAT_ORG_STORAGE_CAP_BYTES
//
// Asserts: an 800 kB confirm passes, then a second 800 kB ticket is refused because
// 800 kB + 800 kB > 1,000,000 bytes.

import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { api } from "../convex/_generated/api.js";

const appDir = new URL("..", import.meta.url);
const url = readFileSync(new URL(".env.local", appDir), "utf8").match(/^CONVEX_URL=(.+)$/m)[1].trim();
const endpoint = readFileSync(new URL(".storage/endpoint.txt", appDir), "utf8").trim();

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const email = `cap+${Date.now().toString(36)}@demo.teamchat.test`;
const client = new ConvexHttpClient(url);
await client.action(api.auth.signIn, { provider: "email", params: { email } });
let code = null;
for (let i = 0; i < 60 && code === null; i++) {
  const echo = await client.query(api.auth.demo.getEchoedCode, { email });
  if (echo?.code) code = echo.code;
  else await new Promise((r) => setTimeout(r, 200));
}
const signedIn = await client.action(api.auth.signIn, { provider: "email", params: { email, code } });
client.setAuth(signedIn.tokens.token);

const org = await client.mutation(api.organizations.create, {
  name: `Cap Co ${Date.now()}`,
  allowDirectMessages: false,
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

const size = 800_000;
const bytes = randomBytes(size);

const first = await client.action(api.storage.attachments.requestUpload, {
  groupPublicId: org.rootGroupPublicId,
  name: "cap-a.png",
  mime: "image/png",
  size,
});
const form = new FormData();
for (const [name, value] of Object.entries(first.fields)) form.append(name, value);
form.append("file", new Blob([bytes], { type: "image/png" }), "cap-a.png");
const put = await fetch(first.uploadUrl, { method: first.method, body: form });
check("cap: first 800 kB upload POST", put.ok, `status ${put.status}`);
if (!put.ok) process.exit(1);

const confirmed = await client.action(api.storage.attachments.confirmUpload, {
  attachmentId: first.attachmentId,
});
check("cap: first 800 kB confirm passes (under the 1,000,000-byte cap)", confirmed.status === "confirmed");

let secondError = null;
try {
  await client.action(api.storage.attachments.requestUpload, {
    groupPublicId: org.rootGroupPublicId,
    name: "cap-b.png",
    mime: "image/png",
    size,
  });
} catch (error) {
  secondError = error;
}
check(
  "cap: second 800 kB ticket is refused (800 kB + 800 kB > 1,000,000)",
  secondError !== null && /cap would be exceeded/i.test(secondError.message),
  secondError?.message.split("\n").slice(-2).join(" ").slice(0, 160),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
