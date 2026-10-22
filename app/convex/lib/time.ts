// Shared time constants. The session rule is S4-verified (30 days, see `convex/auth.ts`).

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** OTP code lifetime (PRD Part 1 §3: passwordless email OTP, 3-min expiry). */
export const OTP_MAX_AGE_SECONDS = 3 * 60;

/** Flow A2: `groupActivity.lastMessageAt` writes are debounced to a 3-second window. */
export const GROUP_ACTIVITY_DEBOUNCE_MS = 3_000;

/** Unconfirmed uploads live under `pending/` for this long (v0 brief: expiring prefix). */
export const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** Invite links expire after this long unless revoked or used first. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
