// Widget host-token verification (Flow D2). Runs in the default Convex runtime, where Web Crypto
// (`crypto.subtle`) is available.
//
// Trust order is fixed and matches the PRD:
//   1. `kid` is resolved against the host app's stored PUBLIC key
//   2. signature
//   3. `iss`
//   4. `aud`
//   5. expiry window
//   6. `jti` replay (the caller consumes it in a mutation)
//   7. iframe origin against `allowedOrigins`
//
// No error echoes a key, a token, or an expected issuer/audience value.

export const WIDGET_TOKEN_MAX_LIFETIME_SECONDS = 5 * 60;
export const WIDGET_TOKEN_CLOCK_SKEW_SECONDS = 30;

export type WidgetTokenErrorCode =
  | "malformed"
  | "unknown_key"
  | "alg_mismatch"
  | "key_not_yet_valid"
  | "key_expired"
  | "bad_signature"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "missing_claim"
  | "expired"
  | "not_yet_valid"
  | "expiry_window"
  | "origin_not_allowed"
  | "replayed"
  // A verified host assertion named an identity that is already bound to a non-shadow account.
  // Distinct from "replayed": the jti was fresh, so the exchange was not a replay.
  | "identity_not_shadow";

export class WidgetTokenError extends Error {
  code: WidgetTokenErrorCode;
  constructor(code: WidgetTokenErrorCode, message: string) {
    super(`Widget token rejected [${code}]: ${message}`);
    this.name = "WidgetTokenError";
    this.code = code;
  }
}

export type WidgetClaims = {
  issuer: string;
  audience: string[];
  subject: string;
  jti: string;
  expiresAt: number;
  issuedAt: number;
  email: string | null;
  name: string | null;
  phone: string | null;
};

export type JwtHeader = { alg: string; kid: string; typ: string | null };

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const withPad = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(withPad);
  } catch {
    throw new WidgetTokenError("malformed", "the token is not valid base64url");
  }
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function decodeJson(value: string): Record<string, unknown> {
  try {
    const decoded = new TextDecoder().decode(base64UrlToBytes(value));
    const parsed = JSON.parse(decoded) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new WidgetTokenError("malformed", "a token segment is not JSON");
  }
}

export function readJwtHeader(token: string): JwtHeader {
  const parts = token.split(".");
  if (parts.length !== 3) throw new WidgetTokenError("malformed", "a JWT has three segments");
  const header = decodeJson(parts[0]);
  const alg = typeof header.alg === "string" ? header.alg : null;
  const kid = typeof header.kid === "string" ? header.kid : null;
  if (alg === null || kid === null || kid.trim() === "") {
    throw new WidgetTokenError("malformed", "the JWT header must carry alg and kid");
  }
  return { alg, kid, typ: typeof header.typ === "string" ? header.typ : null };
}

export function publicJwkHasPrivateMaterial(publicKey: string): boolean {
  try {
    const jwk = JSON.parse(publicKey) as Record<string, unknown>;
    return typeof jwk.d === "string" || typeof jwk.p === "string" || typeof jwk.q === "string";
  } catch {
    return false;
  }
}

function importPublicKey(publicKey: string, alg: "ES256" | "RS256"): Promise<CryptoKey> {
  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(publicKey) as Record<string, unknown>;
  } catch {
    throw new WidgetTokenError("unknown_key", "the stored public key is not a JWK");
  }
  if (typeof jwk.d === "string" || typeof jwk.p === "string" || typeof jwk.q === "string") {
    // Defence in depth: registration refuses private material, and verification refuses it again.
    throw new WidgetTokenError("unknown_key", "the stored key is not a public key");
  }
  const algorithm =
    alg === "ES256"
      ? ({ name: "ECDSA", namedCurve: "P-256" } as const)
      : ({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const);
  return crypto.subtle.importKey("jwk", jwk as JsonWebKey, algorithm, false, ["verify"]);
}

export type StoredKey = {
  kid: string;
  alg: "ES256" | "RS256";
  publicKey: string;
  notBefore: number;
  notAfter?: number;
};

function checkKeyWindow(key: StoredKey, nowMs: number): void {
  if (nowMs < key.notBefore) {
    throw new WidgetTokenError("key_not_yet_valid", "this key is not valid yet");
  }
  if (key.notAfter !== undefined && nowMs > key.notAfter) {
    throw new WidgetTokenError("key_expired", "this key is past its notAfter");
  }
}

function audienceValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  return [];
}

/**
 * Verify a token against one stored key. `kid` and key-window checks happen before the signature;
 * the caller has already selected the key by `kid`.
 */
export async function verifyWidgetToken(args: {
  token: string;
  header: JwtHeader;
  key: StoredKey;
  issuer: string;
  audience: string;
  nowMs?: number;
}): Promise<WidgetClaims> {
  const nowMs = args.nowMs ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);

  // 1. kid already selected the key; check alg and the key's own validity window.
  if (args.header.alg !== args.key.alg) {
    throw new WidgetTokenError("alg_mismatch", "the token alg does not match the stored key");
  }
  checkKeyWindow(args.key, nowMs);

  const parts = args.token.split(".");
  if (parts.length !== 3) throw new WidgetTokenError("malformed", "a JWT has three segments");

  // 2. signature over the exact header.payload.
  let cryptoKey: CryptoKey;
  try {
    cryptoKey = await importPublicKey(args.key.publicKey, args.key.alg);
  } catch (error) {
    if (error instanceof WidgetTokenError) throw error;
    throw new WidgetTokenError("unknown_key", "the stored public key could not be imported");
  }
  const signature = base64UrlToBytes(parts[2]);
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const algorithm =
    args.key.alg === "ES256"
      ? ({ name: "ECDSA", hash: "SHA-256" } as const)
      : ({ name: "RSASSA-PKCS1-v1_5" } as const);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(algorithm, cryptoKey, signature, signingInput);
  } catch {
    valid = false;
  }
  if (!valid) throw new WidgetTokenError("bad_signature", "the signature is not valid");

  const payload = decodeJson(parts[1]);

  // 3. issuer.
  if (typeof payload.iss !== "string" || payload.iss !== args.issuer) {
    throw new WidgetTokenError("issuer_mismatch", "the issuer does not match this host app");
  }

  // 4. audience.
  if (!audienceValues(payload.aud).includes(args.audience)) {
    throw new WidgetTokenError("audience_mismatch", "the audience does not match this host app");
  }

  // 5. expiry window. Require iat/exp/jti; short-lived tokens only.
  if (typeof payload.sub !== "string" || payload.sub.trim() === "") {
    throw new WidgetTokenError("missing_claim", "the subject claim is required");
  }
  if (typeof payload.jti !== "string" || payload.jti.trim() === "") {
    throw new WidgetTokenError("missing_claim", "the jti claim is required");
  }
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new WidgetTokenError("missing_claim", "iat and exp must be numeric claims");
  }
  if (payload.iat > nowSeconds + WIDGET_TOKEN_CLOCK_SKEW_SECONDS) {
    throw new WidgetTokenError("not_yet_valid", "the token was issued in the future");
  }
  if (typeof payload.nbf === "number" && payload.nbf > nowSeconds + WIDGET_TOKEN_CLOCK_SKEW_SECONDS) {
    throw new WidgetTokenError("not_yet_valid", "the token is not valid yet");
  }
  if (payload.exp <= nowSeconds) {
    throw new WidgetTokenError("expired", "the token has expired");
  }
  if (payload.exp - payload.iat > WIDGET_TOKEN_MAX_LIFETIME_SECONDS) {
    throw new WidgetTokenError(
      "expiry_window",
      `tokens must live at most ${WIDGET_TOKEN_MAX_LIFETIME_SECONDS} seconds`,
    );
  }

  return {
    issuer: payload.iss,
    audience: audienceValues(payload.aud),
    subject: payload.sub,
    jti: payload.jti,
    expiresAt: payload.exp,
    issuedAt: payload.iat,
    email: typeof payload.email === "string" ? payload.email.trim().toLowerCase() : null,
    name: typeof payload.name === "string" ? payload.name.trim() : null,
    phone: typeof payload.phone === "string" ? payload.phone : null,
  };
}

/** Step 7: exact origin match, after URL normalisation. */
export function assertAllowedOrigin(origin: string, allowedOrigins: string[]): void {
  if (typeof origin !== "string" || origin.trim() === "") {
    throw new WidgetTokenError("origin_not_allowed", "the iframe origin is required");
  }
  let normalised: string;
  try {
    normalised = new URL(origin).origin;
  } catch {
    throw new WidgetTokenError("origin_not_allowed", "the iframe origin is not a valid URL");
  }
  const allowed = allowedOrigins.map((value) => {
    try {
      return new URL(value).origin;
    } catch {
      return value;
    }
  });
  if (!allowed.includes(normalised)) {
    throw new WidgetTokenError("origin_not_allowed", "the iframe origin is not allowlisted");
  }
}
