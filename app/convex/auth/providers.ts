// The email OTP provider (O5). This module is the swap point for production delivery.
//
//   TEAMCHAT_OTP_PROVIDER=sendgrid  -> SendGrid v3 Mail Send (production)
//   TEAMCHAT_OTP_PROVIDER=mock      -> records the code for tests (never allowed in production)
//   unset + demo build              -> echoed-OTP stub (CR-16)
//
// SES is a documented alternative, not compiled in: see OPERATIONS.md and PILOT_RUNBOOK.md. Keeping one real adapter behind this wrapper satisfies the "swappable,
// version-pinned" requirement without shipping an untested second transport.

import { Email } from "@convex-dev/auth/providers/Email";
import type { AnyDataModel } from "convex/server";
import type { EmailUserConfig, GenericActionCtxWithAuthConfig } from "@convex-dev/auth/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { OTP_MAX_AGE_SECONDS } from "../lib/time";
import { otpLimitMessage, rateLimiter } from "../lib/rateLimiter";
import {
  DEMO_OTP_ECHO,
  assertAuthBuildSafe,
  assertOtpProviderConfigured,
  otpProviderName,
} from "./buildFlags";

type RequestMetadata = { ip?: string | null };

const SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";

/** The library's action ctx carries request metadata at runtime; its 0.0.96 type omits it. */
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

function emailBody(token: string): { text: string; html: string } {
  const text =
    `Your TeamChat sign-in code is ${token}.\n\n` +
    `It expires in ${Math.floor(OTP_MAX_AGE_SECONDS / 60)} minutes. ` +
    `If you did not ask for this code, ignore this email.\n`;
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif">
  <p>Your TeamChat sign-in code is:</p>
  <p style="font-size:28px;font-weight:700;letter-spacing:6px">${token}</p>
  <p>It expires in ${Math.floor(OTP_MAX_AGE_SECONDS / 60)} minutes. If you did not ask for this
  code, ignore this email.</p>
</body></html>`;
  return { text, html };
}

async function sendWithSendGrid(identifier: string, token: string): Promise<void> {
  const apiKey = (process.env.SENDGRID_API_KEY ?? "").trim();
  const from = (process.env.TEAMCHAT_OTP_FROM ?? "").trim();
  if (apiKey === "" || from === "") {
    throw new Error("[OTP] SendGrid is selected but SENDGRID_API_KEY or TEAMCHAT_OTP_FROM is missing");
  }
  const body = emailBody(token);
  const response = await fetch(SENDGRID_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: identifier }] }],
      from: { email: from, name: process.env.TEAMCHAT_OTP_FROM_NAME ?? "TeamChat" },
      subject: `TeamChat sign-in code: ${token}`,
      content: [
        { type: "text/plain", value: body.text },
        { type: "text/html", value: body.html },
      ],
      // Do not let SendGrid rewrite or track a sign-in code.
      tracking_settings: {
        click_tracking: { enable: false },
        open_tracking: { enable: false },
      },
    }),
  });
  if (!response.ok) {
    // Never echo the provider response body: it can contain request identifiers but not the code;
    // still, keep the deployment log free of provider detail.
    throw new Error(`[OTP] SendGrid rejected the message (HTTP ${response.status})`);
  }
}

/**
 * The library calls `sendVerificationRequest(params, ctx)` at runtime
 * (dist/server/implementation/signIn.js) — the Step 0 S3 probe verified the action context — but
 * its 0.0.96 type declaration lists only `params`. The cast below restores the real signature.
 */
async function sendVerificationRequest(
  { identifier, token }: { identifier: string; token: string },
  ctx: GenericActionCtxWithAuthConfig<AnyDataModel>,
): Promise<void> {
  // NOTE: this runs in an ACTION context (S3 caveat from Step 0). Never touch ctx.db here;
  // all database work goes through ctx.runMutation / ctx.runQuery.
  assertOtpProviderConfigured();

  const normalised = identifier.trim().toLowerCase();
  const actionCtx = ctx as unknown as ActionCtx;

  // Per-email limit first: it is the tighter, user-visible one. A denied request is not sent.
  const perEmail = await rateLimiter.limit(actionCtx, "otpRequestByEmail", { key: normalised });
  if (!perEmail.ok) throw new Error(otpLimitMessage("email", perEmail.retryAfter));

  // Per-client-IP limit. Convex supplies the caller's IP in action request metadata; if a local
  // invocation has no metadata there is no IP to key on, so only the email limit applies.
  const ip = await clientIp(ctx);
  if (ip !== null) {
    const perIp = await rateLimiter.limit(actionCtx, "otpRequestByIp", { key: ip });
    if (!perIp.ok) throw new Error(otpLimitMessage("network", perIp.retryAfter));
  }

  const provider = otpProviderName();

  if (provider === "sendgrid") {
    await sendWithSendGrid(normalised, token);
    return;
  }

  if (provider === "mock") {
    // Test-only path. assertOtpProviderConfigured has already refused this in production; keep a
    // second explicit check so the mock can never be enabled by env alone on a prod deployment.
    if ((process.env.TEAMCHAT_BUILD_CHANNEL ?? "").trim().toLowerCase() === "production") {
      throw new Error("[OTP] The mock provider is not allowed on a production deployment");
    }
    await ctx.runMutation(internal.auth.demo.recordEchoedCode, {
      identifier: normalised,
      token,
      expiresAt: Date.now() + OTP_MAX_AGE_SECONDS * 1000,
    });
    return;
  }

  if (DEMO_OTP_ECHO) {
    await ctx.runMutation(internal.auth.demo.recordEchoedCode, {
      identifier: normalised,
      token,
      expiresAt: Date.now() + OTP_MAX_AGE_SECONDS * 1000,
    });
    return;
  }

  // A production build cannot reach here: assertOtpProviderConfigured() has already refused.
  // A non-production build with DEMO_OTP_ECHO=false and no provider also fails closed.
  throw new Error(
    "No email provider is wired. Set TEAMCHAT_OTP_PROVIDER=sendgrid with SENDGRID_API_KEY and " +
      "TEAMCHAT_OTP_FROM, or run a demo build with the echo stub (CR-16).",
  );
}

export const emailOtpProvider = Email({
  id: "email",
  // PRD Part 1 §3: passwordless email OTP, 3-minute expiry.
  maxAge: OTP_MAX_AGE_SECONDS,
  from: (process.env.TEAMCHAT_OTP_FROM ?? "").trim() || "TeamChat Demo <no-reply@teamchat.invalid>",
  sendVerificationRequest:
    sendVerificationRequest as unknown as NonNullable<EmailUserConfig["sendVerificationRequest"]>,
});
