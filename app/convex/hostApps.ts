// Host app registration and key management (build item 1).
//
// A host app is owned by one organisation and points at one support group. Keys are PUBLIC only:
// the registration path validates a JWK, refuses private material, and stores the string verbatim.
// There is no shared secret anywhere in the widget trust model.
//
// Rotation is "add the new kid now, leave the old kid valid until notAfter": `addKey` adds a key
// immediately, and `setKeyWindow` moves an old key's `notAfter` (never backwards in normal use).

import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { newPublicId } from "./lib/ids";
import { requireActive, requireOrgMember } from "./lib/guards";
import { isAllowedMime, MAX_FILE_BYTES } from "./lib/limits";
import { Doc, Id } from "./_generated/dataModel";

const algValidator = v.union(v.literal("ES256"), v.literal("RS256"));

function normaliseOrigins(origins: string[]): string[] {
  const out: string[] = [];
  for (const raw of origins) {
    const value = raw.trim();
    if (value === "") continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`"${value}" is not a valid origin URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Allowed origins must be http(s)");
    }
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new Error(`"${value}" must be an origin only (scheme://host[:port])`);
    }
    const origin = url.origin;
    if (!out.includes(origin)) out.push(origin);
  }
  if (out.length === 0) throw new Error("At least one allowed iframe origin is required");
  return out;
}

function validatePublicJwk(publicKey: string, alg: "ES256" | "RS256"): void {
  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(publicKey) as Record<string, unknown>;
  } catch {
    throw new Error("publicKey must be a JSON-encoded JWK");
  }
  if (jwk === null || typeof jwk !== "object" || Array.isArray(jwk)) {
    throw new Error("publicKey must be a JSON-encoded JWK");
  }
  if (typeof jwk.d === "string" || typeof jwk.p === "string" || typeof jwk.q === "string") {
    throw new Error("Private key material is refused: register the PUBLIC key only");
  }
  if (alg === "ES256") {
    if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
      throw new Error("An ES256 key must be an EC JWK on P-256");
    }
    if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
      throw new Error("An ES256 public JWK requires x and y");
    }
  } else {
    if (jwk.kty !== "RSA") throw new Error("An RS256 key must be an RSA JWK");
    if (typeof jwk.n !== "string" || typeof jwk.e !== "string") {
      throw new Error("An RS256 public JWK requires n and e");
    }
  }
}

async function hostAppByPublicId(ctx: any, publicId: string): Promise<Doc<"hostApps">> {
  const hostApp = await ctx.db
    .query("hostApps")
    .withIndex("by_public_id", (q: any) => q.eq("publicId", publicId))
    .unique();
  if (hostApp === null) throw new Error("Host app not found");
  return hostApp;
}

async function requireHostAdmin(
  ctx: any,
  hostAppPublicId: string,
): Promise<{ hostApp: Doc<"hostApps">; user: Doc<"users"> }> {
  const hostApp = await hostAppByPublicId(ctx, hostAppPublicId);
  const { user } = await requireOrgMember(ctx, hostApp.orgId, ["owner", "admin"]);
  return { hostApp, user };
}

export const register = mutation({
  args: {
    orgPublicId: v.string(),
    name: v.string(),
    issuer: v.string(),
    audience: v.string(),
    allowedOrigins: v.array(v.string()),
    supportGroupPublicId: v.string(),
    primaryColor: v.optional(v.string()),
    logoUrl: v.optional(v.string()),
    uploads: v.optional(
      v.object({
        allowWidgetUploads: v.boolean(),
        maxFileBytes: v.number(),
        allowedMimes: v.array(v.string()),
        maxPerMinute: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);

    const name = args.name.trim();
    if (name === "") throw new Error("Host app name is required");
    const issuer = args.issuer.trim();
    const audience = args.audience.trim();
    if (issuer === "" || audience === "") throw new Error("Issuer and audience are required");

    const supportGroup = await ctx.db
      .query("groups")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.supportGroupPublicId))
      .unique();
    if (supportGroup === null || supportGroup.kind !== "group") {
      throw new Error("Support group not found");
    }
    if (supportGroup.orgId !== org._id) {
      throw new Error("The support group must belong to this organisation");
    }

    const allowedOrigins = normaliseOrigins(args.allowedOrigins);
    const primaryColor = args.primaryColor?.trim();
    if (primaryColor !== undefined && primaryColor !== "" && !/^#[0-9a-fA-F]{6}$/.test(primaryColor)) {
      throw new Error("primaryColor must be a #rrggbb hex colour");
    }
    const logoUrl = args.logoUrl?.trim();
    if (logoUrl !== undefined && logoUrl !== "" && !/^https?:\/\//.test(logoUrl)) {
      throw new Error("logoUrl must be http(s)");
    }

    if (args.uploads !== undefined) {
      validateUploadSettings(args.uploads);
    }

    const publicId = newPublicId("hap");
    const hostAppId = await ctx.db.insert("hostApps", {
      publicId,
      orgId: org._id,
      name,
      issuer,
      audience,
      allowedOrigins,
      supportGroupId: supportGroup._id,
      isActive: true,
      primaryColor: primaryColor === "" ? undefined : primaryColor,
      logoUrl: logoUrl === "" ? undefined : logoUrl,
      allowWidgetUploads: args.uploads?.allowWidgetUploads ?? false,
      widgetUploadMaxBytes: args.uploads?.maxFileBytes,
      widgetUploadMimes: args.uploads?.allowedMimes,
      widgetUploadRatePerMinute: args.uploads?.maxPerMinute,
    });
    return {
      hostAppPublicId: publicId,
      orgPublicId: org.publicId,
      supportGroupPublicId: supportGroup.publicId,
      hostAppId,
    };
  },
});

function validateUploadSettings(input: {
  allowWidgetUploads: boolean;
  maxFileBytes: number;
  allowedMimes: string[];
  maxPerMinute: number;
}): void {
  if (input.allowWidgetUploads) {
    if (!Number.isFinite(input.maxFileBytes) || input.maxFileBytes <= 0) {
      throw new Error("Widget upload maxFileBytes must be positive");
    }
    if (input.maxFileBytes > MAX_FILE_BYTES) {
      throw new Error(`Widget upload maxFileBytes cannot exceed ${MAX_FILE_BYTES} bytes`);
    }
    if (input.allowedMimes.length === 0) throw new Error("Widget uploads need at least one MIME type");
    for (const mime of input.allowedMimes) {
      if (!isAllowedMime(mime)) throw new Error(`"${mime}" is outside the global MIME allowlist`);
    }
    if (!Number.isFinite(input.maxPerMinute) || input.maxPerMinute < 1 || input.maxPerMinute > 60) {
      throw new Error("Widget upload maxPerMinute must be between 1 and 60");
    }
  }
}

export const addKey = mutation({
  args: {
    hostAppPublicId: v.string(),
    kid: v.string(),
    alg: algValidator,
    publicKey: v.string(),
    notBefore: v.optional(v.number()),
    notAfter: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { hostApp, user } = await requireHostAdmin(ctx, args.hostAppPublicId);
    const kid = args.kid.trim();
    if (kid === "") throw new Error("kid is required");
    validatePublicJwk(args.publicKey, args.alg);

    const notBefore = args.notBefore ?? Date.now();
    if (args.notAfter !== undefined && args.notAfter <= notBefore) {
      throw new Error("notAfter must be after notBefore");
    }
    const existing = await ctx.db
      .query("hostAppKeys")
      .withIndex("by_hostapp_kid", (q) => q.eq("hostAppId", hostApp._id).eq("kid", kid))
      .unique();
    if (existing !== null) throw new Error(`Key id "${kid}" already exists for this host app`);

    const keyId = await ctx.db.insert("hostAppKeys", {
      hostAppId: hostApp._id,
      kid,
      alg: args.alg,
      publicKey: args.publicKey,
      notBefore,
      notAfter: args.notAfter,
    });
    return { hostAppPublicId: hostApp.publicId, kid, alg: args.alg, keyId, addedBy: user.publicId };
  },
});

/** Move an old key's notAfter. Never used to make a key valid again. */
export const setKeyWindow = mutation({
  args: {
    hostAppPublicId: v.string(),
    kid: v.string(),
    notAfter: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { hostApp } = await requireHostAdmin(ctx, args.hostAppPublicId);
    const key = await ctx.db
      .query("hostAppKeys")
      .withIndex("by_hostapp_kid", (q) => q.eq("hostAppId", hostApp._id).eq("kid", args.kid))
      .unique();
    if (key === null) throw new Error("Key not found");
    await ctx.db.patch(key._id, { notAfter: args.notAfter });
    return { hostAppPublicId: hostApp.publicId, kid: args.kid, notAfter: args.notAfter ?? null };
  },
});

export const configureUploads = mutation({
  args: {
    hostAppPublicId: v.string(),
    allowWidgetUploads: v.boolean(),
    maxFileBytes: v.number(),
    allowedMimes: v.array(v.string()),
    maxPerMinute: v.number(),
  },
  handler: async (ctx, args) => {
    const { hostApp } = await requireHostAdmin(ctx, args.hostAppPublicId);
    validateUploadSettings(args);
    await ctx.db.patch(hostApp._id, {
      allowWidgetUploads: args.allowWidgetUploads,
      widgetUploadMaxBytes: args.maxFileBytes,
      widgetUploadMimes: args.allowedMimes,
      widgetUploadRatePerMinute: args.maxPerMinute,
    });
    return {
      hostAppPublicId: hostApp.publicId,
      allowWidgetUploads: args.allowWidgetUploads,
      maxFileBytes: args.maxFileBytes,
      allowedMimes: args.allowedMimes,
      maxPerMinute: args.maxPerMinute,
    };
  },
});

export const setBranding = mutation({
  args: {
    hostAppPublicId: v.string(),
    primaryColor: v.optional(v.string()),
    logoUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { hostApp } = await requireHostAdmin(ctx, args.hostAppPublicId);
    const primaryColor = args.primaryColor?.trim();
    if (primaryColor !== undefined && primaryColor !== "" && !/^#[0-9a-fA-F]{6}$/.test(primaryColor)) {
      throw new Error("primaryColor must be a #rrggbb hex colour");
    }
    const logoUrl = args.logoUrl?.trim();
    if (logoUrl !== undefined && logoUrl !== "" && !/^https?:\/\//.test(logoUrl)) {
      throw new Error("logoUrl must be http(s)");
    }
    await ctx.db.patch(hostApp._id, {
      primaryColor: primaryColor === "" ? undefined : primaryColor,
      logoUrl: logoUrl === "" ? undefined : logoUrl,
    });
    return { hostAppPublicId: hostApp.publicId, primaryColor: primaryColor ?? null, logoUrl: logoUrl ?? null };
  },
});

export const setActive = mutation({
  args: { hostAppPublicId: v.string(), isActive: v.boolean() },
  handler: async (ctx, args) => {
    const { hostApp } = await requireHostAdmin(ctx, args.hostAppPublicId);
    await ctx.db.patch(hostApp._id, { isActive: args.isActive });
    return { hostAppPublicId: hostApp.publicId, isActive: args.isActive };
  },
});

/** Owner/admin view: host apps, public keys (never private), upload opt-in and branding. */
export const listForOrg = query({
  args: { orgPublicId: v.string() },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);
    const apps = await ctx.db
      .query("hostApps")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    const out = [];
    for (const app of apps) {
      const supportGroup = await ctx.db.get(app.supportGroupId);
      const keys = await ctx.db
        .query("hostAppKeys")
        .withIndex("by_hostapp", (q) => q.eq("hostAppId", app._id))
        .collect();
      out.push({
        publicId: app.publicId,
        name: app.name,
        issuer: app.issuer,
        audience: app.audience,
        allowedOrigins: app.allowedOrigins,
        supportGroupPublicId:
          supportGroup !== null && supportGroup.kind === "group" ? supportGroup.publicId : null,
        isActive: app.isActive,
        primaryColor: app.primaryColor ?? null,
        logoUrl: app.logoUrl ?? null,
        allowWidgetUploads: app.allowWidgetUploads === true,
        widgetUploadMaxBytes: app.widgetUploadMaxBytes ?? null,
        widgetUploadMimes: app.widgetUploadMimes ?? [],
        widgetUploadRatePerMinute: app.widgetUploadRatePerMinute ?? null,
        keys: keys.map((key) => ({
          kid: key.kid,
          alg: key.alg,
          publicKey: key.publicKey,
          notBefore: key.notBefore,
          notAfter: key.notAfter ?? null,
        })),
      });
    }
    return out;
  },
});

/**
 * Unauthenticated widget bootstrap. The iframe needs the origin allowlist before it accepts a
 * postMessage token, plus the white-label values. No org id, support group id or key is exposed.
 */
export const publicConfig = query({
  args: { hostAppPublicId: v.string() },
  handler: async (ctx, args) => {
    const hostApp = await ctx.db
      .query("hostApps")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.hostAppPublicId))
      .unique();
    if (hostApp === null || !hostApp.isActive) throw new Error("Widget is not available");
    return {
      hostAppPublicId: hostApp.publicId,
      name: hostApp.name,
      allowedOrigins: hostApp.allowedOrigins,
      primaryColor: hostApp.primaryColor ?? "#2563eb",
      logoUrl: hostApp.logoUrl ?? null,
      uploadsEnabled: hostApp.allowWidgetUploads === true,
    };
  },
});

/**
 * Server-side input for `GET /widget/shell`. Unknown and inactive hosts are the same `null`, so the
 * HTTP route cannot be used to probe which host ids exist or to read a dormant allowlist.
 */
export const shellConfig = internalQuery({
  args: { hostAppPublicId: v.string() },
  handler: async (ctx, args) => {
    const hostApp = await ctx.db
      .query("hostApps")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.hostAppPublicId))
      .unique();
    if (hostApp === null || !hostApp.isActive) return null;
    return { allowedOrigins: hostApp.allowedOrigins };
  },
});

/** Owner/admin audit view: widget overrides and refusals, never tokens or keys. */
export const auditForOrg = query({
  args: { orgPublicId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.orgPublicId))
      .unique();
    if (org === null) throw new Error("Organisation not found");
    await requireOrgMember(ctx, org._id, ["owner", "admin"]);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const apps = await ctx.db
      .query("hostApps")
      .withIndex("by_org", (q) => q.eq("orgId", org._id))
      .collect();
    const rows = [];
    for (const app of apps) {
      const entries = await ctx.db
        .query("widgetAuditLog")
        .withIndex("by_hostapp_created", (q) => q.eq("hostAppId", app._id))
        .order("desc")
        .take(limit);
      for (const entry of entries) {
        rows.push({
          hostAppPublicId: app.publicId,
          kind: entry.kind,
          detail: entry.detail,
          createdAt: entry.createdAt,
        });
      }
    }
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return rows.slice(0, limit);
  },
});

/** Internal/test helper: org admin view of one host app's support group. */
export async function supportGroupForHostApp(
  ctx: any,
  hostApp: Doc<"hostApps">,
): Promise<{ group: Extract<Doc<"groups">, { kind: "group" }>; org: Doc<"organizations"> }> {
  const group = await ctx.db.get(hostApp.supportGroupId);
  if (group === null || group.kind !== "group") throw new Error("Host app support group not found");
  if (group.orgId !== hostApp.orgId) throw new Error("Host app support group is outside its organisation");
  const org = await ctx.db.get(hostApp.orgId);
  if (org === null) throw new Error("Host app organisation not found");
  return { group, org };
}

export type WidgetUploadSettings = {
  enabled: boolean;
  maxFileBytes: number;
  mimes: string[];
  maxPerMinute: number;
};

export function widgetUploadSettings(hostApp: Doc<"hostApps">): WidgetUploadSettings {
  return {
    enabled: hostApp.allowWidgetUploads === true,
    maxFileBytes: Math.min(hostApp.widgetUploadMaxBytes ?? 0, MAX_FILE_BYTES),
    mimes: hostApp.widgetUploadMimes ?? [],
    maxPerMinute: hostApp.widgetUploadRatePerMinute ?? 0,
  };
}

export type HostAppId = Id<"hostApps">;
