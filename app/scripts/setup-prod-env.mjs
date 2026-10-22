// One-time production deployment setup (teamchat-prod).
//
//   node scripts/setup-prod-env.mjs
//
// Generates the production JWT signing pair and master key locally (gitignored `.storage/`),
// writes them to the deployment, and sets the non-secret production configuration:
//
//   JWT_PRIVATE_KEY / JWKS          sessions
//   TEAMCHAT_MASTER_KEY             BYOS credential + webhook-secret envelope key
//   SITE_URL                        Convex Auth redirect/issuer origin
//   TEAMCHAT_BUILD_CHANNEL          production
//   TEAMCHAT_OTP_PROVIDER=sendgrid  real OTP sender (see providers.ts)
//   SENDGRID_API_KEY                from the environment, or a visible placeholder
//   TEAMCHAT_OTP_FROM               from the environment, or a placeholder
//   TEAMCHAT_ORG_STORAGE_CAP_BYTES  5 GiB default per-org cap
//
// Key custody: `.storage/prod-jwt-private.pem` and `.storage/prod-master-key.txt` are the only
// copies this script creates. Losing the master key makes every stored BYOS credential and
// webhook secret undecryptable. Back both up in the org's secret manager before the first org.
//
// The script never prints a secret. It prints a fingerprint so two operators can compare backups.

import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const convexBin = join(appDir, "node_modules", "convex", "bin", "main.js");
const deployment = process.env.PROD_DEPLOYMENT ?? "benevolent-crocodile-386";
const siteUrl = process.env.PROD_SITE_URL ?? "https://benevolent-crocodile-386.convex.site";
const storageDir = join(appDir, ".storage");
const keyFile = join(storageDir, "prod-jwt-private.pem");
const masterFile = join(storageDir, "prod-master-key.txt");
const envFile = join(storageDir, "prod.env");

mkdirSync(storageDir, { recursive: true });

function envSet(name, value) {
  execFileSync(
    process.execPath,
    [convexBin, "env", "set", name, "--deployment", deployment],
    { cwd: appDir, encoding: "utf8", input: value, stdio: ["pipe", "pipe", "pipe"] },
  );
}

function envGet(name) {
  try {
    const value = execFileSync(
      process.execPath,
      [convexBin, "env", "get", name, "--deployment", deployment],
      { cwd: appDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function fingerprint(value) {
  // Short, non-reversible identifier for operator comparison. Sha-256 over the value.
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

// --- JWT signing pair -------------------------------------------------------------------------
let privatePem;
if (existsSync(keyFile)) {
  privatePem = readFileSync(keyFile, "utf8");
  console.log(`= JWT private key reused from ${keyFile}`);
} else {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  writeFileSync(keyFile, privatePem, { encoding: "utf8", mode: 0o600 });
  const jwk = publicKey.export({ format: "jwk" });
  const jwks = JSON.stringify({ keys: [{ use: "sig", ...jwk }] });
  envSet("JWKS", jwks);
  console.log(`+ JWT_PRIVATE_KEY / JWKS generated and written to the deployment`);
}
envSet("JWT_PRIVATE_KEY", privatePem.trimEnd().replace(/\n/g, " "));

// --- envelope-encryption master key -----------------------------------------------------------
let masterKey;
if (existsSync(masterFile)) {
  masterKey = readFileSync(masterFile, "utf8").trim();
  console.log(`= TEAMCHAT_MASTER_KEY reused from ${masterFile}`);
} else {
  masterKey = randomBytes(32).toString("base64");
  writeFileSync(masterFile, `${masterKey}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`+ TEAMCHAT_MASTER_KEY generated and written to ${masterFile}`);
}
envSet("TEAMCHAT_MASTER_KEY", masterKey);

// --- non-secret production configuration ------------------------------------------------------
envSet("SITE_URL", siteUrl);
envSet("TEAMCHAT_BUILD_CHANNEL", "production");
envSet("TEAMCHAT_OTP_PROVIDER", "sendgrid");
envSet("TEAMCHAT_ORG_STORAGE_CAP_BYTES", String(5 * 1024 * 1024 * 1024));

const sendgridKey = (process.env.SENDGRID_API_KEY ?? "").trim();
const otpFrom = (process.env.TEAMCHAT_OTP_FROM ?? "").trim();
if (sendgridKey === "") {
  envSet("SENDGRID_API_KEY", "SG.REPLACE_ME_WITH_A_REAL_SENDGRID_KEY");
  console.log("! SENDGRID_API_KEY not in the environment: wrote a visible placeholder.");
  console.log("! Real OTP delivery is therefore UNVERIFIED until a key is supplied.");
} else {
  envSet("SENDGRID_API_KEY", sendgridKey);
  console.log("+ SENDGRID_API_KEY set from the environment");
}
if (otpFrom === "") {
  envSet("TEAMCHAT_OTP_FROM", "no-reply@teamchat.example");
  console.log("! TEAMCHAT_OTP_FROM not supplied: wrote no-reply@teamchat.example (unverified domain).");
} else {
  envSet("TEAMCHAT_OTP_FROM", otpFrom);
  console.log("+ TEAMCHAT_OTP_FROM set from the environment");
}

writeFileSync(envFile, `CONVEX_DEPLOYMENT=${deployment}\nCONVEX_SITE_URL=${siteUrl}\n`, "utf8");

console.log("");
console.log(`deployment:        ${deployment}`);
console.log(`site URL:          ${siteUrl}`);
console.log(`JWT fingerprint:   ${fingerprint(privatePem)}`);
console.log(`master fingerprint:${fingerprint(masterKey)}`);
console.log(`env file:          ${envFile}`);
console.log("");
console.log("Back up .storage/prod-jwt-private.pem and .storage/prod-master-key.txt off this machine.");
console.log("Verify with: node scripts/guard-prod.mjs");
