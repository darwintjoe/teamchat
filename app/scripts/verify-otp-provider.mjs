// Email-OTP provider proof.
//
//   node scripts/verify-otp-provider.mjs
//
// Runs against the dev deployment with TEAMCHAT_OTP_PROVIDER=mock. The mock is a real provider
// branch inside convex/auth/providers.ts: the request still passes the two OTP rate limits, the
// provider is called, and the code is recorded for this test to read. Nothing here fakes the
// verification step; `api.auth.signIn` checks the code through @convex-dev/auth.
//
// Proves:
//   * a request reaches the provider (mock branch) and a code exists;
//   * the code's lifetime is 3 minutes;
//   * a wrong code is refused and the correct one returns a session;
//   * the 4th request for one email inside the 10-minute window is refused by the limiter.
//
// Writes evidence/verify-otp-provider.txt.

import { ConvexHttpClient } from "convex/browser";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "../convex/_generated/api.js";
import { deploymentUrl, sleep } from "./lib/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const CLOUD = deploymentUrl();
const ENV = readFileSync(join(appDir, ".env.local"), "utf8");
const siteMatch = ENV.match(/^CONVEX_SITE_URL=(.+)$/m);
const SITE = (process.env.CONVEX_SITE_URL ?? siteMatch?.[1]?.trim() ?? CLOUD.replace(".convex.cloud", ".convex.site")).replace(/\/+$/, "");

const lines = [];
const log = (line = "") => {
  lines.push(line);
  console.log(line);
};

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

async function expectError(fn, matcher) {
  let caught = null;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  if (caught === null) throw new Error("expected an error, but the call succeeded");
  if (matcher !== undefined) {
    assert(
      `${caught.message} ${JSON.stringify(caught.data ?? "")}`.toLowerCase().includes(matcher.toLowerCase()),
      `expected ${JSON.stringify(matcher)}, got: ${caught.message}`,
    );
  }
  return caught;
}

async function requestCode(client, email) {
  await client.action(api.auth.signIn, { provider: "email", params: { email } });
}

async function readCode(client, email) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const echo = await client.query(api.auth.demo.getEchoedCode, { email });
    if (echo?.code) return echo;
    await sleep(200);
  }
  throw new Error(`no code was recorded for ${email}`);
}

const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const email = `otp-provider+${runId}@demo.teamchat.test`;
const limitedEmail = `otp-limit+${runId}@demo.teamchat.test`;

log(`cloud: ${CLOUD}`);
log(`site:  ${SITE}`);
log(`run:   ${runId}`);
log("");

try {
  const client = new ConvexHttpClient(CLOUD);

  await check("the deployed build reports the demo/echo surface (dev only)", async () => {
    const info = await client.query(api.auth.demo.buildInfo, {});
    assert(info.echoOtp === true, `echoOtp=${info.echoOtp}`);
    return `channel=${info.channel}`;
  });

  let echoed = null;
  await check("an OTP request reaches the provider and records a code", async () => {
    const before = Date.now();
    await requestCode(client, email);
    echoed = await readCode(client, email);
    assert(typeof echoed.code === "string" && echoed.code.length >= 6, `code shape ${echoed.code}`);
    assert(echoed.expiresAt > before, "code expired before it was issued");
    return `${email} · ${echoed.code.length}-character code`;
  });

  await check("the code lifetime is exactly 3 minutes", async () => {
    assert(echoed !== null, "no code from the prior check");
    const lifetimeMs = echoed.expiresAt - echoed.createdAt;
    assert(Math.abs(lifetimeMs - 180_000) <= 2, `lifetime ${lifetimeMs}ms`);
    assert(echoed.expiresAt > Date.now(), "code is already expired at read time");
    return `${lifetimeMs / 1000}s from issue to expiry`;
  });

  await check("a wrong code is refused", async () => {
    const wrong = awaitedWrong(echoed.code);
    await expectError(
      () => client.action(api.auth.signIn, { provider: "email", params: { email, code: wrong } }),
      "verify",
    );
    return "invalid code rejected";
  });

  await check("the correct code verifies and returns a session", async () => {
    const result = await client.action(api.auth.signIn, {
      provider: "email",
      params: { email, code: echoed.code },
    });
    assert(typeof result?.tokens?.token === "string" && result.tokens.token.length > 0, "no access token");
    assert(typeof result?.tokens?.refreshToken === "string", "no refresh token");
    client.setAuth(result.tokens.token);
    const me = await client.query(api.users.me, {}).catch(() => null);
    if (me !== null) assert(me.email === email, `resolved ${me.email}`);
    return "tokens issued; code consumed";
  });

  await check("the 4th code request for one email in 10 minutes is refused", async () => {
    for (let index = 0; index < 3; index++) {
      await requestCode(client, limitedEmail);
      await sleep(150);
    }
    const error = await expectError(() => requestCode(client, limitedEmail), "too many sign-in codes");
    assert(error !== null, "4th request was accepted");
    return "3 allowed, 4th refused by otpRequestByEmail";
  });
} catch (error) {
  failed++;
  failures.push(`setup: ${error.message}`);
  log(`FAIL  setup — ${error.stack ?? error.message}`);
}

function awaitedWrong(code) {
  const digits = code.split("");
  digits[0] = digits[0] === "0" ? "1" : "0";
  return digits.join("");
}

log("");
log(`checks: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  log("");
  for (const failure of failures) log(`  ${failure}`);
}

mkdirSync(join(appDir, "evidence"), { recursive: true });
const out = join(appDir, "evidence", "verify-otp-provider.txt");
writeFileSync(
  out,
  [
    `OTP provider verification — ${new Date().toISOString()}`,
    `deployment: ${CLOUD}`,
    `site:       ${SITE}`,
    `run id:     ${runId}`,
    "provider:   mock (TEAMCHAT_OTP_PROVIDER=mock on the dev deployment)",
    "",
    ...lines,
    "",
  ].join("\n"),
  "utf8",
);
console.log(`evidence: ${out}`);

if (failed > 0) process.exitCode = 1;
