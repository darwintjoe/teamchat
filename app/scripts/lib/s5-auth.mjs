// Shared S5 auth-token cache.
//
// S5 needs one owner session plus a pool of action users. Creating that pool through the email OTP
// flow would consume the production rate limits (3 per email / 20 per IP per 10 minutes), so the
// access and refresh tokens are cached under the gitignored `.storage/` directory. Later runs
// refresh the session instead of requesting a new code.
//
// The cache contains live credentials: never copy it into evidence/ or commit it.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import { appDir, signInFresh, sleep } from "./harness.mjs";

export const AUTH_CACHE_PATH = join(appDir, ".storage", "s5-v2-auth-cache.json");

function readCache() {
  if (!existsSync(AUTH_CACHE_PATH)) return { users: {} };
  try {
    const parsed = JSON.parse(readFileSync(AUTH_CACHE_PATH, "utf8"));
    return parsed && typeof parsed === "object" && parsed.users ? parsed : { users: {} };
  } catch {
    return { users: {} };
  }
}

function writeCache(cache) {
  mkdirSync(dirname(AUTH_CACHE_PATH), { recursive: true });
  writeFileSync(AUTH_CACHE_PATH, JSON.stringify(cache, null, 2));
}

async function refreshOrSignIn(url, email, cached) {
  if (cached?.token) {
    const client = new ConvexHttpClient(url);
    try {
      client.setAuth(cached.token);
      const me = await client.query(api.users.me, {});
      return {
        email,
        token: cached.token,
        refreshToken: cached.refreshToken ?? null,
        publicId: me.publicId,
        refreshed: true,
      };
    } catch {
      // Fall through to the refresh token or OTP path.
    }
  }
  if (cached?.refreshToken) {
    const client = new ConvexHttpClient(url);
    try {
      const result = await client.action(api.auth.signIn, {
        refreshToken: cached.refreshToken,
      });
      if (result?.tokens?.token) {
        client.setAuth(result.tokens.token);
        const me = await client.query(api.users.me, {});
        return {
          email,
          token: result.tokens.token,
          refreshToken: result.tokens.refreshToken,
          publicId: me.publicId,
          refreshed: true,
        };
      }
    } catch (error) {
      console.warn(`[s5-auth] refresh failed for ${email}: ${String(error.message).split("\n")[0]}`);
    }
  }

  const client = new ConvexHttpClient(url);
  const tokens = await signInFresh(client, email);
  const me = await client.query(api.users.me, {});
  return {
    email,
    token: tokens.token,
    refreshToken: tokens.refreshToken,
    publicId: me.publicId,
    refreshed: false,
  };
}

/**
 * Return signed-in users for the given emails, refreshing cached sessions where possible.
 * `allowOtp` is false when the caller must not spend the rate-limit budget.
 */
export async function ensureUsers(url, emails, { allowOtp = true, onProgress } = {}) {
  const cache = readCache();
  const users = [];
  for (const email of emails) {
    const cached = cache.users[email];
    if (cached?.refreshToken || cached?.token) {
      const user = await refreshOrSignIn(url, email, cached);
      cache.users[email] = user;
      writeCache(cache);
      users.push(user);
      onProgress?.(user);
      continue;
    }
    if (!allowOtp) {
      throw new Error(`No cached session for ${email}; OTP fallback disabled`);
    }
    const user = await refreshOrSignIn(url, email, null);
    cache.users[email] = user;
    writeCache(cache);
    users.push(user);
    // Spacing avoids opening several OTP requests in the same millisecond without measuring
    // anything useful.
    await sleep(100);
    onProgress?.(user);
  }
  return users;
}

export function s5Emails(actionUsers) {
  return [
    "s5v2.owner@demo.teamchat.test",
    ...Array.from(
      { length: actionUsers },
      (_, index) => `s5v2.action.${String(index).padStart(2, "0")}@demo.teamchat.test`,
    ),
  ];
}
