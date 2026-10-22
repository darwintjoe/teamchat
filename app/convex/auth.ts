// Auth wrapper (O5) — thin and swappable, version-pinned to @convex-dev/auth 0.0.96.
//
// Swap points, in order of likelihood:
//   1. OTP delivery: convex/auth/providers.ts `sendVerificationRequest` (demo echo → SendGrid/SES).
//   2. Whole library: only this file and convex/auth.config.ts import @convex-dev/auth.
//   3. Session lifetimes: the `session` block below.
//
// Session rule (S4, PASS): 30-day inactivity, set explicitly so the rule never depends on a
// library default. `inactiveDurationMs` is the inactivity timeout; `totalDurationMs` is the
// hard session cap.

import { convexAuth } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { action, ActionCtx } from "./_generated/server";
import { THIRTY_DAYS_MS } from "./lib/time";
import { otpLimitMessage, rateLimiter } from "./lib/rateLimiter";
import { createOrUpdateUser } from "./auth/callbacks";
import { assertOtpProviderConfigured } from "./auth/buildFlags";
import { emailOtpProvider } from "./auth/providers";
import { widgetProvider } from "./auth/widget";

// Refuse to serve any auth function on a deployment marked production while the CR-16 stub is on,
// or while no real OTP provider is configured.
assertOtpProviderConfigured();

const library = convexAuth({
  providers: [emailOtpProvider, widgetProvider],
  session: {
    totalDurationMs: THIRTY_DAYS_MS,
    inactiveDurationMs: THIRTY_DAYS_MS,
  },
  callbacks: {
    createOrUpdateUser,
  },
});

export const { auth, signOut, store, isAuthenticated } = library;

type SignInArgs = {
  provider?: string;
  params?: any;
  verifier?: string;
  refreshToken?: string;
  calledBy?: string;
};

type SignInResult = {
  redirect?: string;
  verifier?: string;
  tokens?: { token: string; refreshToken: string } | null;
  started?: boolean;
};

/**
 * Verification-attempt limit (10 per email per 10 minutes). Requests for a new code are limited
 * in the provider's `sendVerificationRequest`; this wrapper covers the other half of the flow —
 * code submission — because the library's action has no hook before it verifies a code.
 *
 * The library action is invoked through its registered handler rather than a second public
 * action, so there is no unthrottled `signIn` alias that a client could call instead.
 */
export const signIn = action({
  args: {
    provider: v.optional(v.string()),
    params: v.optional(v.any()),
    verifier: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    calledBy: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<SignInResult> => {
    const email = typeof args.params?.email === "string" ? args.params.email : null;
    const hasCode = typeof args.params?.code === "string" && args.params.code.length > 0;
    if (email !== null && hasCode) {
      const key = email.trim().toLowerCase();
      const status = await rateLimiter.limit(ctx, "otpVerifyByEmail", { key });
      if (!status.ok) throw new Error(otpLimitMessage("verification", status.retryAfter));
    }

    const handler = (
      library.signIn as unknown as {
        _handler: (ctx: ActionCtx, args: SignInArgs) => Promise<SignInResult>;
      }
    )._handler;
    return await handler(ctx, args);
  },
});
