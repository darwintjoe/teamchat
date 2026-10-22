// Shared helpers for the v0/v0-correction and S5 harnesses. No product code imports this.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "../../convex/_generated/api.js";

export const appDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function deploymentUrl() {
  if (process.env.CONVEX_URL) return process.env.CONVEX_URL;
  const env = readFileSync(join(appDir, ".env.local"), "utf8");
  const match = env.match(/^CONVEX_URL=(.+)$/m);
  if (!match) throw new Error("CONVEX_URL not found in .env.local");
  return match[1].trim();
}

export function storageEndpoint() {
  if (process.env.S3_ENDPOINT) return process.env.S3_ENDPOINT;
  const file = join(appDir, ".storage", "endpoint.txt");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

export function summary(values) {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length === 0 ? null : Number(Math.max(...values).toFixed(2)),
  };
}

/**
 * Coarse failure classes used by every S5 table. Keep the categories stable so runs compare.
 */
export function classifyError(error) {
  const text = `${error?.message ?? error} ${JSON.stringify(error?.data ?? "")}`;
  if (/rate.?limit|too many/i.test(text)) return "rate_limited";
  if (/401|403|unauthori[sz]ed|not signed in|auth(?:entication|orization)? (?:failed|error)|token (?:expired|invalid)|session (?:expired|invalid)/i.test(text)) return "auth";
  if (/timeout|timed out|deadline|no first result/i.test(text)) return "timeout";
  if (/websocket|connection|socket|closed|network|ECONN|reset/i.test(text)) return "connection";
  if (/\b429\b|too many requests/i.test(text)) return "rate_limited";
  if (/\b5\d\d\b|server error|internal/i.test(text)) return "server_error";
  return "unknown";
}

export async function signInFresh(client, email, { timeoutMs = 20_000 } = {}) {
  await client.action(api.auth.signIn, { provider: "email", params: { email } });
  let code = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
  if (!result?.tokens?.token) throw new Error(`sign-in for ${email} returned no token`);
  client.setAuth(result.tokens.token);
  return result.tokens;
}

/**
 * A pre-signed POST is multipart/form-data: every field first (in order), the file part last.
 * Never set Content-Type manually; the runtime must add the multipart boundary.
 */
export async function postUpload(ticket, bytes, filename, mime) {
  const form = new FormData();
  for (const [name, value] of Object.entries(ticket.fields)) form.append(name, value);
  form.append("file", new Blob([bytes], { type: mime }), filename);
  const response = await fetch(ticket.uploadUrl, { method: ticket.method, body: form });
  if (!response.ok) {
    throw new Error(`storage POST failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

/** Decode the base64 policy in a ticket; used to assert the signed conditions. */
export function decodePolicy(ticket) {
  return JSON.parse(Buffer.from(ticket.fields.policy, "base64").toString("utf8"));
}

export function loadAuthCache(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function saveAuthCache(path, value) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}
