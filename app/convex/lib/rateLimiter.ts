// Transactional rate limits (CR-6: "no external Redis, no hand-rolled counter table").
// Backed by the @convex-dev/rate-limiter component (see convex/convex.config.ts).

import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "../_generated/api";

/** The PRD's OTP abuse window: all three limits below are 10-minute fixed windows. */
export const OTP_WINDOW_MS = 10 * MINUTE;
export const OTP_EMAIL_MAX = 3;
export const OTP_IP_MAX = 20;
export const OTP_VERIFY_MAX = 10;

/**
 * A second handle on the same component with no named configs, for limits whose rate is chosen at
 * call time (the per-org API budget). Named `config` overrides are not part of the typed API in
 * 0.4.2, so the inline-config overload is used here.
 */
export const dynamicRateLimiter = new RateLimiter(components.rateLimiter);

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Invite-link redemption. Keyed by the redeeming user; single-use tokens make the per-token
  // surface small, the per-user loop is the abuse vector.
  redeemInvite: { kind: "fixed window", rate: 10, period: MINUTE },
  // Attachment upload-ticket requests, keyed by uploader.
  requestUpload: { kind: "fixed window", rate: 30, period: MINUTE },
  // Email OTP request limits (PRD Part 1 §3): 3 per email and 20 per client IP per 10 minutes.
  otpRequestByEmail: { kind: "fixed window", rate: OTP_EMAIL_MAX, period: OTP_WINDOW_MS },
  otpRequestByIp: { kind: "fixed window", rate: OTP_IP_MAX, period: OTP_WINDOW_MS },
  // Code verification attempts, keyed by the normalised email.
  otpVerifyByEmail: { kind: "fixed window", rate: OTP_VERIFY_MAX, period: OTP_WINDOW_MS },
  // Widget exchange is public. Per host app and per client IP, separate windows.
  widgetExchangeByHost: { kind: "fixed window", rate: 120, period: MINUTE },
  widgetExchangeByIp: { kind: "fixed window", rate: 30, period: MINUTE },
  // Part 5 §2: every authenticated REST request is limited per API key. The default matches the
  // 500/min floor; an org may raise it, so the call site passes an explicit `config`.
  apiKeyRequests: { kind: "fixed window", rate: 500, period: MINUTE },
  // Part 5 §2: independent per-group send cap. Checked BEFORE the per-key limit so a runaway
  // group loop is attributed to the group, not hidden behind the key's larger budget.
  apiGroupSends: { kind: "fixed window", rate: 60, period: MINUTE },
});

/** Per-group API send cap (PRD ambiguity: no value is specified; 60/min chosen, see report). */
export const API_GROUP_SEND_MAX_PER_MINUTE = 60;

export function widgetExchangeLimitMessage(scope: "host" | "network", retryAfter?: number): string {
  const seconds = Math.max(1, Math.ceil((retryAfter ?? MINUTE) / 1000));
  return scope === "host"
    ? `Too many widget token exchanges for this host app. Try again in ${seconds} second(s).`
    : `Too many widget token exchanges from this network. Try again in ${seconds} second(s).`;
}

/** Consistent, actionable denial text. `retryAfter` is milliseconds. */
export function otpLimitMessage(scope: "email" | "network" | "verification", retryAfter?: number): string {
  const seconds = Math.max(1, Math.ceil((retryAfter ?? OTP_WINDOW_MS) / 1000));
  if (scope === "email") {
    return `Too many sign-in codes requested for this email. Try again in ${seconds} second(s).`;
  }
  if (scope === "network") {
    return `Too many sign-in codes requested from this network. Try again in ${seconds} second(s).`;
  }
  return `Too many verification attempts for this email. Try again in ${seconds} second(s).`;
}
