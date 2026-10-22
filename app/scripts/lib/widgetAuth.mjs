// Shared ES256 test/demo helpers. No product code imports this file.
//
// The private key never leaves the demo host process (or the test process). Only the public JWK
// is registered with TeamChat, which is the trust model the PRD requires.

import { randomBytes } from "node:crypto";

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

export async function createSigningKey(kid = `kid_${randomBytes(6).toString("hex")}`) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    alg: "ES256",
    privateKey: pair.privateKey,
    privateJwk,
    publicJwk: {
      kty: publicJwk.kty,
      crv: publicJwk.crv,
      x: publicJwk.x,
      y: publicJwk.y,
      ext: true,
      key_ops: ["verify"],
    },
  };
}

export async function signingKeyFromJwk(privateJwk) {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return privateKey;
}

/** Sign a compact JWS. `iat` defaults to two minutes ago to tolerate local clock drift. */
export async function signWidgetToken(privateKey, kid, claims, { alg = "ES256" } = {}) {
  const header = { alg, typ: "JWT", kid };
  const encodedHeader = b64url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedClaims = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64url(signature)}`;
}

/** Current epoch seconds minus a drift allowance, matching the demo host's token minting. */
export function tokenTimes({ lifetimeSeconds = 180, driftSeconds = 120 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iat: now - driftSeconds, exp: now - driftSeconds + lifetimeSeconds };
}
