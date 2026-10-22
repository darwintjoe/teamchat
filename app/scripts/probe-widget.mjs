// Quick widget smoke probe (development only). Not part of the product surface.
//   node scripts/probe-widget.mjs

import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const env = readFileSync(join(appDir, ".env.local"), "utf8");
const url = process.env.CONVEX_URL ?? env.match(/^CONVEX_URL=(.+)$/m)[1].trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function b64u(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function keypair() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = `kid_${Math.random().toString(36).slice(2, 10)}`;
  return { privateKey: pair.privateKey, publicJwk: JSON.stringify({ ...publicJwk, kid }), kid };
}

async function signToken(privateKey, kid, claims) {
  const header = { alg: "ES256", typ: "JWT", kid };
  const input = `${b64u(new TextEncoder().encode(JSON.stringify(header)))}.${b64u(
    new TextEncoder().encode(JSON.stringify(claims)),
  )}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64u(signature)}`;
}

async function signInFresh(email) {
  const client = new ConvexHttpClient(url);
  await client.action(api.auth.signIn, { provider: "email", params: { email } });
  let code = null;
  for (let i = 0; i < 50; i++) {
    const echo = await client.query(api.auth.demo.getEchoedCode, { email });
    if (echo?.code) {
      code = echo.code;
      break;
    }
    await sleep(200);
  }
  if (!code) throw new Error("no OTP");
  const result = await client.action(api.auth.signIn, {
    provider: "email",
    params: { email, code },
  });
  client.setAuth(result.tokens.token);
  return client;
}

const runId = Date.now().toString(36);
const origin = "http://localhost:4310";
const alice = await signInFresh(`widget-alice+${runId}@demo.teamchat.test`);
const org = await alice.mutation(api.organizations.create, {
  name: `Widget Co ${runId}`,
  allowDirectMessages: true,
});

const keys = await keypair();
const host = await alice.mutation(api.hostApps.register, {
  orgPublicId: org.orgPublicId,
  name: "Probe Host",
  issuer: `https://host-${runId}.example`,
  audience: "teamchat-widget",
  allowedOrigins: [origin],
  supportGroupPublicId: org.rootGroupPublicId,
});
await alice.mutation(api.hostApps.addKey, {
  hostAppPublicId: host.hostAppPublicId,
  kid: keys.kid,
  alg: "ES256",
  publicKey: keys.publicJwk,
});

const now = Math.floor(Date.now() / 1000);
// Local dev machines can drift from Convex's clock; issue with headroom, still inside the 5-minute cap.
const token = await signToken(keys.privateKey, keys.kid, {
  iss: `https://host-${runId}.example`,
  aud: "teamchat-widget",
  sub: `customer-${runId}`,
  jti: `jti-${runId}`,
  iat: now - 120,
  exp: now + 60,
  email: `customer+${runId}@demo.teamchat.test`,
  name: "Widget Customer",
});

const anon = new ConvexHttpClient(url);
const exchanged = await anon.action(api.auth.signIn, {
  provider: "widget",
  params: { token, hostAppPublicId: host.hostAppPublicId, origin },
});
console.log("exchange ok", Boolean(exchanged?.tokens?.token));
anon.setAuth(exchanged.tokens.token);

console.log("me", await anon.query(api.widgets.messages.me, {}));
const sent = await anon.mutation(api.widgets.messages.sendMessage, {
  text: "Hello, I need help",
  mode: "discussion",
});
console.log("sent", sent);
const convo = await anon.query(api.widgets.messages.conversation, {});
console.log("conversation", JSON.stringify(convo, null, 2).slice(0, 800));

try {
  await anon.query(api.groups.listMine, {});
  console.log("FAIL shadow could list conversations");
} catch (error) {
  console.log("shadow blocked from groups.listMine:", error.message.slice(0, 100));
}

const claimed = await alice.mutation(api.actionInbox.claim, { taskPublicId: sent.ticketPublicId });
console.log("claimed", claimed);
const done = await alice.mutation(api.actionInbox.markDone, { taskPublicId: sent.ticketPublicId });
console.log("done", done);
const reply = await anon.mutation(api.widgets.messages.sendMessage, { text: "Any update?" });
console.log("reply", reply);
const closed = await alice.mutation(api.actionInbox.close, { taskPublicId: sent.ticketPublicId });
console.log("closed", closed);
const next = await anon.mutation(api.widgets.messages.sendMessage, { text: "New issue" });
console.log("new ticket", next);
