// Standalone 512-action burst, with an option to send Action-mode messages.
//
//   node scripts/action-burst.mjs --label=baseline
//   node scripts/action-burst.mjs --label=action --mode=action
//
// Measures 512 concurrent `messages.send` calls from eight real users (64 sends each) to one write
// group with no live subscribers. Sends go over the same ConvexClient WebSocket transport that S5
// v2 and the real clients use, isolated from session ramp and fan-out so a before/after comparison
// measures the send mutation itself.
//
// Tokens are cached in `.storage/action-burst-auth.json` so the two runs do not consume the OTP
// per-IP window twice.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import {
  appDir,
  deploymentUrl,
  loadAuthCache,
  saveAuthCache,
  sleep,
  summary,
} from "./lib/harness.mjs";

const url = deploymentUrl();
const cachePath = join(appDir, ".storage", "action-burst-auth.json");
const cache = loadAuthCache(cachePath) ?? {};

const label = process.argv.find((value) => value.startsWith("--label="))?.split("=")[1] ?? "run";
const mode = process.argv.find((value) => value.startsWith("--mode="))?.split("=")[1] ?? "discussion";
const ACTIONS = Number(
  process.argv.find((value) => value.startsWith("--actions="))?.split("=")[1] ?? 512,
);
const USERS = 8;

function tokenUsable(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp !== "number" || payload.exp * 1000 > Date.now() + 60_000;
  } catch {
    return false;
  }
}

function openClient(token) {
  const client = new ConvexClient(url, { logger: false });
  if (token) client.setAuth(async () => token);
  return client;
}

/** ConvexClient.setAuth is fire-and-forget, so poll until the socket has authenticated. */
async function waitForMe(client, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await client.query(api.users.me, {});
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw lastError ?? new Error("timed out waiting for WebSocket auth");
}

async function freshClientWithToken(email, key) {
  const cached = cache[key];
  if (cached?.token && tokenUsable(cached.token)) {
    const client = openClient(cached.token);
    try {
      const me = await waitForMe(client);
      return { client, me, token: cached.token };
    } catch {
      await client.close();
    }
  }
  if (cached?.refreshToken) {
    const client = openClient(null);
    try {
      const refreshed = await client.action(api.auth.signIn, {
        refreshToken: cached.refreshToken,
      });
      const token = refreshed?.tokens?.token;
      if (token) {
        client.setAuth(async () => token);
        const me = await waitForMe(client);
        cache[key] = { token, refreshToken: refreshed.tokens.refreshToken };
        saveAuthCache(cachePath, cache);
        return { client, me, token };
      }
    } catch {
      // fall through to OTP
    }
    await client.close();
  }
  const client = openClient(null);
  await client.action(api.auth.signIn, { provider: "email", params: { email } });
  let code = null;
  for (let i = 0; i < 60; i++) {
    const echo = await client.query(api.auth.demo.getEchoedCode, { email });
    if (echo?.code) {
      code = echo.code;
      break;
    }
    await sleep(200);
  }
  if (code === null) throw new Error(`no echoed OTP for ${email}`);
  const signed = await client.action(api.auth.signIn, {
    provider: "email",
    params: { email, code },
  });
  const token = signed?.tokens?.token;
  if (!token) throw new Error(`no token for ${email}`);
  client.setAuth(async () => token);
  const me = await waitForMe(client);
  cache[key] = { token, refreshToken: signed.tokens.refreshToken };
  saveAuthCache(cachePath, cache);
  return { client, me, token };
}

const runId = Date.now().toString(36);
const owner = await freshClientWithToken(`action.burst.owner@demo.teamchat.test`, "owner");
const org = await owner.client.mutation(api.organizations.create, {
  name: `Action burst ${label} ${runId}`,
  allowDirectMessages: true,
});
const group = await owner.client.mutation(api.groups.create, {
  orgPublicId: org.orgPublicId,
  name: `Action burst write ${label} ${runId}`,
});

const users = [];
for (let index = 0; index < USERS; index++) {
  const email = `action.burst.user${index}@demo.teamchat.test`;
  const result = await freshClientWithToken(email, `user${index}`);
  const invite = await owner.client.mutation(api.invites.create, { orgPublicId: org.orgPublicId });
  try {
    await result.client.action(api.invites.redeem, { token: invite.token });
  } catch (error) {
    const text = `${error.message} ${JSON.stringify(error.data ?? "")}`;
    if (!/already/i.test(text)) throw error;
  }
  await owner.client.mutation(api.groups.addMember, {
    groupPublicId: group.groupPublicId,
    userPublicId: result.me.publicId,
  });
  users.push(result.client);
}

const conversation = { kind: "group", publicId: group.groupPublicId };
const latencies = [];
const errors = [];

const startedWall = performance.now();
await Promise.all(
  Array.from({ length: ACTIONS }, async (_, index) => {
    const user = users[index % users.length];
    const t0 = performance.now();
    try {
      const args = { conversation, text: `action burst ${label} ${index} ${runId}` };
      if (mode === "action") args.mode = "action";
      await user.mutation(api.messages.send, args);
      latencies.push(performance.now() - t0);
    } catch (error) {
      errors.push(`${error.message} ${JSON.stringify(error.data ?? "")}`.slice(0, 300));
    }
  }),
);
const wall = performance.now() - startedWall;

const result = {
  ranAt: new Date().toISOString(),
  label,
  mode,
  deployment: url,
  actions: ACTIONS,
  users: USERS,
  calls: latencies.length + errors.length,
  errors: errors.length,
  firstError: errors[0] ?? null,
  wallMs: Number(wall.toFixed(2)),
  ...summary(latencies),
};

mkdirSync(join(appDir, "evidence"), { recursive: true });
writeFileSync(join(appDir, "evidence", `action-burst-${label}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

await Promise.all([owner.client, ...users].map((client) => client.close()));
