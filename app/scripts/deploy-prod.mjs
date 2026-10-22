// Deploy a production build to teamchat-prod.
//
//   node scripts/deploy-prod.mjs
//
// `convex/auth/buildFlags.ts` is a demo file in the repository on purpose: the demo deployment
// must keep the echoed OTP. This script rewrites it to the production flags, deploys with
// `TEAMCHAT_BUILD_CHANNEL=production` already set on the deployment, then restores the file even
// if the deploy fails. The production bundle therefore has DEMO_OTP_ECHO=false compiled in.
//
// Refuses to run unless all required production environment variables are present, so a deploy
// cannot silently produce a build that the runtime guard will reject.

import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const convexBin = join(appDir, "node_modules", "convex", "bin", "main.js");
const envFile = process.env.PROD_ENV_FILE ?? join(appDir, ".storage", "prod.env");
const deployment = process.env.PROD_DEPLOYMENT ?? "benevolent-crocodile-386";
const flagsPath = join(appDir, "convex", "auth", "buildFlags.ts");

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

const required = [
  "JWT_PRIVATE_KEY",
  "JWKS",
  "TEAMCHAT_MASTER_KEY",
  "SITE_URL",
  "TEAMCHAT_OTP_PROVIDER",
  "SENDGRID_API_KEY",
  "TEAMCHAT_OTP_FROM",
];
const missing = required.filter((name) => envGet(name) === "");
if (missing.length > 0) {
  console.error(`refusing to deploy: missing production env: ${missing.join(", ")}`);
  console.error("run: node scripts/setup-prod-env.mjs");
  process.exit(1);
}
if (envGet("TEAMCHAT_BUILD_CHANNEL").toLowerCase() !== "production") {
  console.error("refusing to deploy: TEAMCHAT_BUILD_CHANNEL is not production");
  process.exit(1);
}
if (envGet("TEAMCHAT_OTP_PROVIDER").toLowerCase() !== "sendgrid") {
  console.error("refusing to deploy: TEAMCHAT_OTP_PROVIDER must be sendgrid");
  process.exit(1);
}
if (envGet("SENDGRID_API_KEY").includes("REPLACE_ME")) {
  console.warn("WARNING: SENDGRID_API_KEY is still the placeholder. OTP delivery will fail.");
  console.warn("WARNING: this deploy is testable but not pilot-ready; record it as a manual gate.");
}

const original = readFileSync(flagsPath, "utf8");
const production = original
  .replace('export const BUILD_CHANNEL = "demo" as const;', 'export const BUILD_CHANNEL = "production" as const;')
  .replace("export const DEMO_OTP_ECHO = true as const;", "export const DEMO_OTP_ECHO = false as const;");
if (production === original) {
  console.error("refusing to deploy: could not rewrite convex/auth/buildFlags.ts to production flags");
  process.exit(1);
}

let status = 1;
try {
  writeFileSync(flagsPath, production, "utf8");
  console.log(`deploying production build to ${deployment} (echoed OTP compiled out)`);
  const result = spawnSync(
    process.execPath,
    [
      convexBin,
      "deploy",
      "--env-file",
      envFile,
      "--typecheck",
      "enable",
      "--message",
      `production build ${new Date().toISOString()}`,
    ],
    { cwd: appDir, stdio: "inherit" },
  );
  status = result.status ?? 1;
} finally {
  writeFileSync(flagsPath, original, "utf8");
  console.log("restored demo build flags in the working tree");
}

process.exit(status);
