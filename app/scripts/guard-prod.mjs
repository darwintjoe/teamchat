// Post-deploy production guard.
//
//   node scripts/guard-prod.mjs
//
// Checks the deployment's environment and the running bundle without printing secret values:
//   * every required variable is present;
//   * the build channel is production and the OTP provider is SendGrid;
//   * `auth.demo.buildInfo` reports channel=production and echoOtp=false, which can only be true
//     when the echoed-OTP stub was compiled out AND the runtime CR-16 guard accepted the build.
//
// Exits non-zero on any failure; writes evidence/prod-guard.txt.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const convexBin = join(appDir, "node_modules", "convex", "bin", "main.js");
const deployment = process.env.PROD_DEPLOYMENT ?? "benevolent-crocodile-386";
const cloud = (process.env.PROD_CLOUD_URL ?? "https://benevolent-crocodile-386.convex.cloud").replace(/\/+$/, "");

const lines = [];
const log = (line) => {
  lines.push(line);
  console.log(line);
};

let failed = 0;
function assert(condition, message) {
  if (condition) return;
  failed++;
  log(`FAIL  ${message}`);
}

function envNames() {
  const raw = execFileSync(
    process.execPath,
    [convexBin, "env", "list", "--names-only", "--deployment", deployment],
    { cwd: appDir, encoding: "utf8" },
  );
  return new Set(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("Environment variables")),
  );
}

function envGet(name) {
  try {
    return execFileSync(
      process.execPath,
      [convexBin, "env", "get", name, "--deployment", deployment],
      { cwd: appDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    return "";
  }
}

const names = envNames();
const required = [
  "JWT_PRIVATE_KEY",
  "JWKS",
  "TEAMCHAT_MASTER_KEY",
  "SITE_URL",
  "TEAMCHAT_BUILD_CHANNEL",
  "TEAMCHAT_OTP_PROVIDER",
  "SENDGRID_API_KEY",
  "TEAMCHAT_OTP_FROM",
];
for (const name of required) assert(names.has(name), `${name} is not set on ${deployment}`);
assert(envGet("TEAMCHAT_BUILD_CHANNEL").toLowerCase() === "production", "build channel is not production");
assert(envGet("TEAMCHAT_OTP_PROVIDER").toLowerCase() === "sendgrid", "OTP provider is not sendgrid");
assert(envGet("SITE_URL").startsWith("https://"), "SITE_URL is not an https origin");
assert(!envGet("SENDGRID_API_KEY").includes("REPLACE_ME"), "SENDGRID_API_KEY is the placeholder");
assert(!envGet("TEAMCHAT_COST_GATE_DISABLED").toLowerCase().includes("true"), "cost gate is disabled in production");

const client = new ConvexHttpClient(cloud);
try {
  const info = await client.query(api.auth.demo.buildInfo, {});
  log(`buildInfo: channel=${info.channel} echoOtp=${info.echoOtp}`);
  assert(info.channel === "production", "deployed bundle reports a non-production channel");
  assert(info.echoOtp === false, "deployed bundle still has the echoed-OTP stub enabled");
} catch (error) {
  failed++;
  log(`FAIL  auth.demo.buildInfo — ${error.message}`);
}

log("");
log(failed === 0 ? "production guard: PASS" : `production guard: FAIL (${failed})`);
mkdirSync(join(appDir, "evidence"), { recursive: true });
const out = join(appDir, "evidence", "prod-guard.txt");
writeFileSync(
  out,
  [`runAt: ${new Date().toISOString()}`, `deployment: ${deployment}`, `cloud: ${cloud}`, ...lines, ""].join("\n"),
  "utf8",
);
console.log(`evidence: ${out}`);
if (failed > 0) process.exitCode = 1;
