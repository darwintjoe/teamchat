// Scheduled housekeeping.
//
//  * Pending attachment objects expire and are swept hourly (SAL contract: `pending/` expires).
//  * Echoed demo OTPs are dropped after they expire so the table stays small (CR-16 only; the
//    sweep is a no-op when DEMO_OTP_ECHO is off).

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.hourly(
  "sweep expired widget token ids",
  { minuteUTC: 41 },
  internal.widgets.exchange.sweepUsedTokenIds,
  { limit: 200 },
);

crons.hourly(
  "sweep expired pending attachments",
  { minuteUTC: 7 },
  internal.storage.attachments.sweepPending,
  { limit: 100 },
);

crons.hourly(
  "sweep expired demo auth codes",
  { minuteUTC: 23 },
  internal.auth.demo.sweepExpiredEchoes,
  { limit: 200 },
);

// Part 5 §4: retries are scheduled on the delivery row, so a cron only has to drain rows whose
// `nextAttemptAt` has arrived. A minute cadence is enough for 10s/60s/300s backoff.
crons.interval(
  "drain due webhook deliveries",
  { minutes: 1 },
  internal.webhookDelivery.drainDue,
  { limit: 50 },
);

crons.daily(
  "sweep delivered webhook rows",
  { hourUTC: 3, minuteUTC: 17 },
  internal.webhooks.sweepDelivered,
  { limit: 200 },
);

crons.hourly(
  "sweep expired idempotency keys",
  { minuteUTC: 49 },
  internal.webhooks.sweepIdempotencyKeys,
  { limit: 500 },
);

// Appendix A cost instrumentation: one org/day row, written after the UTC day closes. This is the
// only writer of `usageRollups`; there is no per-message counter anywhere in the send path.
crons.daily(
  "aggregate daily usage rollups",
  { hourUTC: 0, minuteUTC: 20 },
  internal.usage.runDailyRollup,
  {},
);

export default crons;
