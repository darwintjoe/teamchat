// Focused proof of the 20-requests-per-client-IP OTP window.
//
//   node scripts/otp-ip-limit.mjs
//
// Run this only on a fresh 10-minute window. It intentionally exhausts the IP budget with 20
// accepted first-time requests and proves the 21st is refused. The demo echo path is checked on
// the first request. Functional checks live in verify-part1.mjs.

import { ConvexHttpClient } from "convex/browser";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "../convex/_generated/api.js";
import { appDir, deploymentUrl, sleep } from "./lib/harness.mjs";

const url = deploymentUrl();
const runId = Date.now().toString(36);
const client = new ConvexHttpClient(url);
const email = (index) => `part1.ipcheck.${runId}.${index}@demo.teamchat.test`;
let accepted = 0;
let deniedAt = null;
let denial = null;

for (let index = 1; index <= 21; index += 1) {
  try {
    await client.action(api.auth.signIn, { provider: "email", params: { email: email(index) } });
    accepted += 1;
    if (index === 1) {
      let echo = null;
      for (let attempt = 0; attempt < 20 && echo === null; attempt += 1) {
        const row = await client.query(api.auth.demo.getEchoedCode, { email: email(1) });
        if (row?.code) echo = row.code;
        else await sleep(100);
      }
      if (echo === null) throw new Error("demo echo did not record the first request");
      console.log(`PASS  demo echo path recorded code for request 1 (${echo.length} chars)`);
    }
  } catch (error) {
    const text = `${error?.message ?? error} ${JSON.stringify(error?.data ?? "")}`;
    if (!/too many sign-in codes requested from this network/i.test(text)) throw error;
    deniedAt = index;
    denial = text;
    break;
  }
}

const passed = accepted === 20 && deniedAt === 21;
console.log(
  `${passed ? "PASS" : "FAIL"}  per-IP limit: accepted ${accepted}, first denial at request ${deniedAt ?? "none"}`,
);
if (!passed) console.log(`denial: ${denial}`);

mkdirSync(join(appDir, "evidence"), { recursive: true });
writeFileSync(
  join(appDir, "evidence", "otp-ip-limit.txt"),
  [
    `runAt: ${new Date().toISOString()}`,
    `deployment: ${url}`,
    `accepted: ${accepted}`,
    `firstDeniedAt: ${deniedAt ?? "none"}`,
    `denial: ${denial ?? "none"}`,
    `passed: ${passed ? 1 : 0}`,
    `failed: ${passed ? 0 : 1}`,
  ].join("\n") + "\n",
);
console.log("evidence: evidence/otp-ip-limit.txt");
process.exit(passed ? 0 : 1);
