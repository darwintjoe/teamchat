// Test-only session factory for the production deployment.
//
// S5 and the cross-tenant checks must run against production without spending the real OTP budget
// or creating a real org. This helper seeds active users through internal test mutations, creates
// an auth session row, and mints the same RS256 JWT that @convex-dev/auth would issue.
//
// Requires the production JWT_PRIVATE_KEY. Read it from the environment or from the local
// gitignored `.storage/prod-jwt-private.pem`. Never write it to evidence/.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, importPKCS8 } from "jose";
import { appDir, sleep } from "./harness.mjs";

const convexBin = join(appDir, "node_modules", "convex", "bin", "main.js");

export function prodDeployment() {
  return process.env.PROD_DEPLOYMENT ?? "benevolent-crocodile-386";
}

export function runInternal(name, args) {
  const raw = execFileSync(
    process.execPath,
    [
      convexBin,
      "run",
      `testing:${name}`,
      JSON.stringify(args),
      "--deployment",
      prodDeployment(),
      "--typecheck",
      "disable",
    ],
    { cwd: appDir, encoding: "utf8" },
  ).replace(/\u001b\[[0-9;]*m/g, "");
  const objectStart = raw.indexOf("{");
  const arrayStart = raw.indexOf("[");
  const isArray = arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart);
  const start = isArray ? arrayStart : objectStart;
  const end = isArray ? raw.lastIndexOf("]") : raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`testing:${name} returned no JSON: ${raw.slice(0, 400)}`);
  }
  return JSON.parse(raw.slice(start, end + 1));
}

export function loadPrivateKey() {
  if (process.env.JWT_PRIVATE_KEY) return process.env.JWT_PRIVATE_KEY;
  const path = process.env.PROD_JWT_KEY_FILE ?? join(appDir, ".storage", "prod-jwt-private.pem");
  if (!existsSync(path)) {
    throw new Error(`No production JWT private key: set JWT_PRIVATE_KEY or create ${path}`);
  }
  return readFileSync(path, "utf8");
}

export async function mintSessionToken({
  privateKey,
  userId,
  sessionId,
  siteUrl,
  durationSeconds = 24 * 60 * 60,
}) {
  const key = await importPKCS8(privateKey, "RS256");
  return await new SignJWT({ sub: `${userId}|${sessionId}` })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer(siteUrl)
    .setAudience("convex")
    .setExpirationTime(new Date(Date.now() + durationSeconds * 1000))
    .sign(key);
}

/** Seed (or reuse) active users and return `{email, token, publicId}` rows. */
export async function ensureProdSessions({ emails, siteUrl, privateKey }) {
  const seeded = runInternal("seedTestUsers", { emails });
  const out = [];
  for (const row of seeded) {
    const session = runInternal("createTestSession", { userPublicId: row.userPublicId });
    const token = await mintSessionToken({
      privateKey,
      userId: session.userId,
      sessionId: session.sessionId,
      siteUrl,
    });
    out.push({ email: row.email, publicId: row.userPublicId, token });
    await sleep(20);
  }
  return out;
}
