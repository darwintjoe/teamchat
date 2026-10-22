// One-time dev-deployment setup: JWT signing keys (same shape the `@convex-dev/auth` CLI
// generates) and the master key used to envelope-encrypt BYOS credentials.
//
// Runs non-interactively against the deployment selected by .env.local (the dev deployment).
//   node scripts/setup-dev-env.mjs           # set only what is missing
//   node scripts/setup-dev-env.mjs --force   # overwrite existing values (rotates keys)
//
// NOTE: rotating JWT_PRIVATE_KEY signs existing sessions out — fine on dev.

import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const convexBin = join(here, "..", "node_modules", "convex", "bin", "main.js");
const force = process.argv.includes("--force");

function convexEnv(args) {
  return execFileSync(process.execPath, [convexBin, "env", ...args], {
    cwd: join(here, ".."),
    encoding: "utf8",
  }).trim();
}

function envGet(name) {
  try {
    const value = convexEnv(["get", name]);
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function envSet(name, value) {
  // Value via stdin: the PEM starts with "-----" which the CLI would parse as an option if passed
  // as an argv value, and stdin also keeps it out of the shell history.
  execFileSync(process.execPath, [convexBin, "env", "set", name], {
    cwd: join(here, ".."),
    encoding: "utf8",
    input: value,
  });
}

function readEnvLocal(name) {
  const text = readFileSync(join(here, "..", ".env.local"), "utf8");
  const match = text.match(new RegExp(`^${name}=(.+)$`, "m"));
  return match ? match[1].trim() : null;
}

// --- JWT keys: generate as one pair so JWKS always matches JWT_PRIVATE_KEY ---
const hasJwt = envGet("JWT_PRIVATE_KEY") !== null;
const hasJwks = envGet("JWKS") !== null;
if (force || !hasJwt || !hasJwks) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  // Same normalisation the @convex-dev/auth CLI uses: one line, newlines → spaces.
  const jwtPrivateKey = pem.trimEnd().replace(/\n/g, " ");
  const jwk = publicKey.export({ format: "jwk" });
  const jwks = JSON.stringify({ keys: [{ use: "sig", ...jwk }] });
  envSet("JWT_PRIVATE_KEY", jwtPrivateKey);
  envSet("JWKS", jwks);
  console.log(`+ JWT_PRIVATE_KEY / JWKS ${force ? "rotated" : "set"}`);
} else {
  console.log("= JWT_PRIVATE_KEY / JWKS already set (kept)");
}

const siteMatch = readEnvLocal("CONVEX_SITE_URL");

// --- master key for byosCredentials envelope encryption ---
if (force || envGet("TEAMCHAT_MASTER_KEY") === null) {
  envSet("TEAMCHAT_MASTER_KEY", randomBytes(32).toString("base64"));
  console.log("+ TEAMCHAT_MASTER_KEY set");
} else {
  console.log("= TEAMCHAT_MASTER_KEY already set (kept)");
}

// --- SITE_URL: Convex Auth needs the deployment's .convex.site origin for redirect building ---
if (siteMatch !== null && (force || envGet("SITE_URL") === null)) {
  envSet("SITE_URL", siteMatch);
  console.log("+ SITE_URL set");
} else if (siteMatch === null) {
  console.log("! CONVEX_SITE_URL missing from .env.local; SITE_URL not set");
} else {
  console.log("= SITE_URL already set (kept)");
}

console.log("done");
