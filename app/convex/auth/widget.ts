// Custom-credentials provider for the embedded widget (O5 / S3-verified path).
//
// `authorize` runs in ACTION context: every database step is a `ctx.runQuery` / `ctx.runMutation`.
// Validation order is the Flow D2 order, and every refusal is a distinct, non-leaky code.

import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import type { AnyDataModel } from "convex/server";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { GenericActionCtxWithAuthConfig } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import { rateLimiter, widgetExchangeLimitMessage } from "../lib/rateLimiter";
import {
  assertAllowedOrigin,
  readJwtHeader,
  verifyWidgetToken,
  WidgetTokenError,
} from "../widgets/token";

type RequestMetadata = { ip?: string | null };

async function clientIp(
  ctx: GenericActionCtxWithAuthConfig<AnyDataModel>,
): Promise<string | null> {
  const meta = (ctx as unknown as {
    meta?: { getRequestMetadata?: () => Promise<RequestMetadata> | RequestMetadata | null };
  }).meta;
  const metadata = await meta?.getRequestMetadata?.();
  const ip = metadata?.ip;
  return typeof ip === "string" && ip.length > 0 ? ip : null;
}

export const widgetProvider = ConvexCredentials<AnyDataModel>({
  id: "widget",
  authorize: async (
    credentials,
    rawCtx,
  ): Promise<{ userId: Id<"users"> }> => {
    const token = typeof credentials.token === "string" ? credentials.token : null;
    const hostAppPublicId =
      typeof credentials.hostAppPublicId === "string" ? credentials.hostAppPublicId : null;
    const origin = typeof credentials.origin === "string" ? credentials.origin : null;
    if (token === null || hostAppPublicId === null || origin === null) {
      throw new WidgetTokenError("malformed", "token, hostAppPublicId and origin are required");
    }

    const ctx = rawCtx as unknown as ActionCtx;
    const actionCtx = rawCtx as unknown as GenericActionCtxWithAuthConfig<AnyDataModel>;

    // Selector only. A forged selector cannot pass the signature or issuer checks.
    const hostApp = await ctx.runQuery(internal.widgets.exchange.hostAppByPublicId, {
      hostAppPublicId,
    });
    if (hostApp === null || !hostApp.isActive) {
      throw new WidgetTokenError("unknown_key", "no active host app matches this exchange");
    }

    // Public endpoint: per-IP first, then per host app.
    const ip = await clientIp(actionCtx);
    if (ip !== null) {
      const byIp = await rateLimiter.limit(ctx, "widgetExchangeByIp", { key: ip });
      if (!byIp.ok) throw new Error(widgetExchangeLimitMessage("network", byIp.retryAfter));
    }
    const byHost = await rateLimiter.limit(ctx, "widgetExchangeByHost", {
      key: hostApp.publicId,
    });
    if (!byHost.ok) throw new Error(widgetExchangeLimitMessage("host", byHost.retryAfter));

    // 1. kid against this host app's stored public key.
    const header = readJwtHeader(token);
    const key = await ctx.runQuery(internal.widgets.exchange.keyForKid, {
      hostAppId: hostApp.id,
      kid: header.kid,
    });
    if (key === null) {
      throw new WidgetTokenError("unknown_key", "no public key matches this kid");
    }

    // 2-5. signature, issuer, audience, expiry window.
    const claims = await verifyWidgetToken({
      token,
      header,
      key,
      issuer: hostApp.issuer,
      audience: hostApp.audience,
    });

    // 6. jti replay. Consume before exchanging a session.
    const consumed = await ctx.runMutation(internal.widgets.exchange.consumeJti, {
      hostAppId: hostApp.id,
      jti: claims.jti,
      expiresAt: claims.expiresAt * 1000,
    });
    if (!consumed.accepted) {
      throw new WidgetTokenError("replayed", "this jti has already been used");
    }

    // 7. iframe origin allowlist.
    try {
      assertAllowedOrigin(origin, hostApp.allowedOrigins);
    } catch (error) {
      await ctx.runMutation(internal.widgets.exchange.audit, {
        hostAppId: hostApp.id,
        kind: "origin_rejected",
        detail: "exchange origin not in allowedOrigins",
      });
      throw error;
    }

    // Identity resolution: hostAppId + externalUserId, NEVER email.
    const shadow = await ctx.runMutation(internal.widgets.exchange.resolveShadow, {
      hostAppId: hostApp.id,
      externalUserId: claims.subject,
      email: claims.email,
      name: claims.name,
      phone: claims.phone,
    });
    if (shadow.accountState !== "shadow") {
      throw new WidgetTokenError(
        "identity_not_shadow",
        "host identity resolved to a non-shadow account",
      );
    }
    return { userId: shadow.userId };
  },
});
