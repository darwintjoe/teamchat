// Part 5 §2 — organisation-scoped API keys.
//
// Format: `tc_live_` + 32 random alphanumeric characters. Only the SHA-256 hash is stored; the
// plaintext is returned exactly once from `create`/`rotate` and is never stored or queryable.
// Authentication is always an indexed lookup on `by_key_hash`.
//
// `lastUsedAt` is a bounded write: at most one update per key per 60 seconds, not one write per
// request. A hot key therefore costs at most six metadata writes an hour.

import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireOrgMember } from "./lib/guards";
import { newPublicId } from "./lib/ids";
import { sha256Hex } from "./lib/crypto";
import { Doc } from "./_generated/dataModel";

export const API_KEY_PREFIX = "tc_live_";
export const API_KEY_RANDOM_CHARS = 32;
export const API_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const API_KEY_LAST_USED_WRITE_MS = 60 * 1000;
export const API_RATE_FLOOR_PER_MINUTE = 500;
export const API_RATE_DEFAULT_PER_MINUTE = 500;

const KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export const apiScopeValidator = v.union(
  v.literal("messages:write"),
  v.literal("messages:read"),
  v.literal("users:provision"),
  v.literal("groups:manage"),
  v.literal("tasks:read"),
);

export type ApiScope =
  | "messages:write"
  | "messages:read"
  | "users:provision"
  | "groups:manage"
  | "tasks:read";

export type ApiAuthSuccess = {
  ok: true;
  keyId: Doc<"apiKeys">["_id"];
  keyPublicId: string;
  orgId: Doc<"apiKeys">["orgId"];
  orgPublicId: string;
  scopes: ApiScope[];
  rateLimitPerMinute: number;
};

export type ApiAuthFailure = {
  ok: false;
  status: 401 | 403;
  code: "unauthorized" | "forbidden";
  message: string;
};

export type ApiAuthResult = ApiAuthSuccess | ApiAuthFailure;

function newApiKeyPlaintext(): string {
  const bytes = new Uint8Array(API_KEY_RANDOM_CHARS);
  crypto.getRandomValues(bytes);
  let out = API_KEY_PREFIX;
  for (const byte of bytes) out += KEY_ALPHABET[byte % KEY_ALPHABET.length];
  return out;
}

function normaliseLabel(value: string): string {
  const label = value.trim();
  if (label === "" || label.length > 100) {
    throw new Error("A key label is required (max 100 characters)");
  }
  return label;
}

function normaliseScopes(scopes: ApiScope[]): ApiScope[] {
  const allowed: ApiScope[] = [
    "messages:write",
    "messages:read",
    "users:provision",
    "groups:manage",
    "tasks:read",
  ];
  const out: ApiScope[] = [];
  for (const scope of scopes) {
    if (!allowed.includes(scope)) throw new Error(`Unknown scope "${scope}"`);
    if (!out.includes(scope)) out.push(scope);
  }
  if (out.length === 0) throw new Error("At least one scope is required");
  return out;
}

/**
 * Create a key. The plaintext is returned in this response only and is never persisted.
 * `orgRole` owner/admin is enforced here, matching the other admin surfaces.
 */
export const create = mutation({
  args: {
    orgPublicId: v.string(),
    label: v.string(),
    scopes: v.array(apiScopeValidator),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);

    const plaintext = newApiKeyPlaintext();
    const keyHash = await sha256Hex(plaintext);
    const publicId = newPublicId("key");
    const scopes = normaliseScopes(args.scopes);
    const now = Date.now();
    await ctx.db.insert("apiKeys", {
      publicId,
      orgId: org._id,
      keyHash,
      label: normaliseLabel(args.label),
      scopes,
      createdAt: now,
      expiresAt: now + API_KEY_TTL_MS,
    });
    return {
      keyPublicId: publicId,
      key: plaintext,
      label: args.label.trim(),
      scopes,
      createdAt: now,
      expiresAt: now + API_KEY_TTL_MS,
    };
  },
});

/** Metadata only: never the hash and never the secret. */
export const listForOrg = query({
  args: { orgPublicId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);
    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    return keys
      .map((key) => ({
        publicId: key.publicId,
        label: key.label,
        scopes: key.scopes,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt ?? null,
        expiresAt: key.expiresAt,
        rotatedAt: key.rotatedAt ?? null,
        revokedAt: key.revokedAt ?? null,
        state:
          key.revokedAt !== undefined
            ? ("revoked" as const)
            : key.expiresAt <= Date.now()
              ? ("expired" as const)
              : ("active" as const),
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const revoke = mutation({
  args: { orgPublicId: v.string(), keyPublicId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.keyPublicId))
      .unique();
    if (key === null || key.orgId !== org._id) throw new Error("API key not found");
    if (key.revokedAt === undefined) await ctx.db.patch(key._id, { revokedAt: Date.now() });
    return { keyPublicId: key.publicId, revoked: true };
  },
});

/**
 * Rotate: the old key is marked rotated and revoked in the same mutation that creates the new
 * one, so there is no window in which two keys are both usable. New expiry is 90 days.
 */
export const rotate = mutation({
  args: { orgPublicId: v.string(), keyPublicId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);
    const old = await ctx.db
      .query("apiKeys")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.keyPublicId))
      .unique();
    if (old === null || old.orgId !== org._id) throw new Error("API key not found");
    if (old.revokedAt !== undefined) throw new Error("A revoked key cannot be rotated");

    const plaintext = newApiKeyPlaintext();
    const keyHash = await sha256Hex(plaintext);
    const publicId = newPublicId("key");
    const now = Date.now();
    await ctx.db.patch(old._id, { rotatedAt: now, revokedAt: now });
    await ctx.db.insert("apiKeys", {
      publicId,
      orgId: org._id,
      keyHash,
      label: old.label,
      scopes: old.scopes,
      createdAt: now,
      expiresAt: now + API_KEY_TTL_MS,
    });
    return {
      keyPublicId: publicId,
      key: plaintext,
      replacedKeyPublicId: old.publicId,
      label: old.label,
      scopes: old.scopes,
      createdAt: now,
      expiresAt: now + API_KEY_TTL_MS,
    };
  },
});

/** Per-org request limit above the 500/min floor (Part 5 §2). */
export const setRateLimit = mutation({
  args: { orgPublicId: v.string(), requestsPerMinute: v.number() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);
    const rate = Math.floor(args.requestsPerMinute);
    if (!Number.isFinite(rate) || rate < API_RATE_FLOOR_PER_MINUTE) {
      throw new Error(`The API rate limit cannot be below ${API_RATE_FLOOR_PER_MINUTE} requests/minute`);
    }
    await ctx.db.patch(org._id, { apiRateLimitPerMinute: rate });
    return { orgPublicId: org.publicId, requestsPerMinute: rate };
  },
});

/**
 * Bearer authentication. Every branch is a stable 401/403; unknown, expired and revoked keys are
 * deliberately indistinguishable to the caller.
 *
 * Runs as an internal mutation so the `lastUsedAt` bounded write is transactional with the read.
 */
export const authenticate = internalMutation({
  args: {
    token: v.string(),
    requiredScope: v.optional(apiScopeValidator),
  },
  handler: async (ctx, args): Promise<ApiAuthResult> => {
    const keyHash = await sha256Hex(args.token);
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash))
      .first();
    if (key === null) {
      return { ok: false, status: 401, code: "unauthorized", message: "Invalid API key" };
    }
    const now = Date.now();
    if (key.revokedAt !== undefined || key.expiresAt <= now) {
      return { ok: false, status: 401, code: "unauthorized", message: "Invalid API key" };
    }
    if (args.requiredScope !== undefined && !key.scopes.includes(args.requiredScope)) {
      return {
        ok: false,
        status: 403,
        code: "forbidden",
        message: `This key does not have the "${args.requiredScope}" scope`,
      };
    }
    const org = await ctx.db.get(key.orgId);
    if (org === null) {
      return { ok: false, status: 401, code: "unauthorized", message: "Invalid API key" };
    }

    // Bounded write: refresh at most once per minute per key.
    if (key.lastUsedAt === undefined || now - key.lastUsedAt >= API_KEY_LAST_USED_WRITE_MS) {
      await ctx.db.patch(key._id, { lastUsedAt: now });
    }

    const configured = org.apiRateLimitPerMinute ?? API_RATE_DEFAULT_PER_MINUTE;
    return {
      ok: true,
      keyId: key._id,
      keyPublicId: key.publicId,
      orgId: key.orgId,
      orgPublicId: org.publicId,
      scopes: key.scopes as ApiScope[],
      rateLimitPerMinute: Math.max(API_RATE_FLOOR_PER_MINUTE, configured),
    };
  },
});
