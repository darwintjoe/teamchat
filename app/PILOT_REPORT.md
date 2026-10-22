# TeamChat Pilot Readiness Report

Date: 2026-10-22  
Scope: 1–3 organisation pilot, US East production deployment, per `TeamChat_PRD_v1.4.md`  
Out of scope: hierarchy, Drive adapter, voice notes, calls, CR-12, CR-13

This report separates **proven** results from **manual gates**. A green check below means the
named evidence exists and was produced against the production deployment. It does not mean an
unavailable device, mailbox, bucket, or lawyer was replaced by a mock.

---

## 1. Production deployment and CR-16

| Item | Value |
|---|---|
| Convex deployment | `benevolent-crocodile-386` |
| Reference | `teamchat-prod` |
| Region | `aws-us-east-1` |
| Cloud URL | `https://benevolent-crocodile-386.convex.cloud` |
| HTTP/site URL | `https://benevolent-crocodile-386.convex.site` |
| Dashboard | `https://dashboard.convex.dev/t/darwin-tjoe/teamchat-app/benevolent-crocodile-386` |

The production bundle reports `channel=production`, `echoOtp=false`. The deploy path is
`npm run deploy:prod`, which rewrites the repository's demo flags to production, deploys with the
deploy key scoped to this deployment, and restores the demo flags. A bare `convex deploy` points at
a different, empty default production deployment and is not the supported path.

### CR-16 refusal evidence

CR-16 requires the echoed-OTP demo stub to be impossible in production. Three independent
refusals were captured:

1. **Compile time** — `evidence/cr16-compile.txt`: the CR-16 proof file fails TypeScript with
   `TS2344: Type 'false' does not satisfy the constraint 'true'`.
2. **Deploy time** — `evidence/cr16-deploy-refusal.txt`: pushing the demo build with
   `TEAMCHAT_BUILD_CHANNEL=production` is rejected with `InvalidModules` and
   `[CR-16] The echoed-OTP demo stub is enabled, but this deployment is marked production`.
3. **Runtime** — `evidence/cr16-runtime.txt`: calling `auth.demo.buildInfo` on the production
   deployment throws the same `[CR-16]` refusal when the stub is enabled.

The normal production build passes `auth.demo.buildInfo` with `channel=production`,
`echoOtp=false`, so the refusal is not caused by a permanently broken function.

### Production guard

`npm run guard:prod` checks required environment names, channel, OTP provider, placeholders, cost
gate, and the running bundle without printing secret values. Current evidence is
`evidence/prod-guard.txt`.

**Current result: FAIL (1) — `SENDGRID_API_KEY` is the placeholder.** Everything else passes,
including `buildInfo: channel=production echoOtp=false`. Real OTP delivery is therefore an open
manual gate, not a completed check. The guard is correctly failing closed; it was not bypassed.
Exact command and output on 2026-10-22:

```text
PS C:\workspace\TeamChat\app> npm run guard:prod
> teamchat-app@0.0.0 guard:prod
> node scripts/guard-prod.mjs

FAIL  SENDGRID_API_KEY is the placeholder
buildInfo: channel=production echoOtp=false

production guard: FAIL (1)
```

### 1.1 Deployment class limits

The dashboard requires an interactive Convex login; this build host has none, so the dashboard
rendered `https://auth.convex.dev/` instead of the deployment. The same deployment record was read
from the Convex platform API and copied verbatim to `evidence/prod-deployment-class.txt`:

```json
{
  "name": "benevolent-crocodile-386",
  "deploymentType": "prod",
  "region": "aws-us-east-1",
  "reference": "teamchat-prod",
  "deploymentUrl": "https://benevolent-crocodile-386.convex.cloud",
  "class": "s16"
}
```

Published S16 limits, read from `docs.convex.dev/production/state/limits` on 2026-10-22:

| S16 capability | Limit |
|---|---:|
| Concurrent sessions | 1,000 |
| Concurrent queries | 16 |
| Concurrent mutations | 16 |
| Convex/HTTP actions | 64 |
| Node actions | 64 |

**The measured deployment exceeds every one of those numbers**: 8,073 authenticated WebSocket
sessions, 256 submitted concurrent queries, and 512 submitted concurrent actions. The S16 class
limits therefore do not act as hard admission ceilings on this deployment as measured. They cannot
explain 8,211 sessions, and they cannot be used to declare 8,211 a platform limit.

### 1.2 Connection ceiling — indeterminate, single host only

The 2026-10-22 rerun used six generator processes on the same Windows host, a 10,000-session
target, 45 s ramp timeout, and a 10 s socket/port sampler. `evidence/s5-prod-diag-fanout40.json`
and `evidence/s5-prod-diag-curve2000.json` hold the raw samples.

| Host fact | Value |
|---|---|
| OS dynamic port range | `49152–65535`, 16,384 ports (`netsh int ipv4 show dynamicport tcp`) |
| Administered/excluded TCP ranges | ~1,100 ports across 14 ranges (`netsh int ipv4 show excludedportrange protocol=tcp`) |
| Generator processes | 6 |
| Peak established sockets (host) | **8,135** |
| Peak established sockets per process | 1,319–1,404 |
| Peak sockets in `TIME_WAIT` | **1,875** |
| Peak ephemeral ports in use | **9,952 / 16,384 = 60.7%** |
| Explicit `EMFILE` / `EADDRINUSE` / `ECONNRESET` errors | **0 / 0 / 0** |
| Peak `SYN_SENT` | 588 |
| WebSocket attempts / successful opens | 16,397 / 8,097 |
| WebSocket close and error events | 8,314 errors / 8,331 closes; **1006 only**, no close frame; 17 clean 1005 |
| Explicit client reconnects | 7 |

`TIME_WAIT` cannot be attributed per process on Windows: `netstat` reports those rows with PID 0,
so the table reports a host total rather than inventing a per-process split.

The local ephemeral range was **not exhausted at the 8,073-session plateau**: 60.7% peak use,
5,000+ ports still free, zero local socket-resource errors. The upstream router/NAT table was not
observable, and no second machine or cloud VM was available. **This is a single-host result.** It
does not prove a deployment session ceiling, and it does not prove the host ceiling either.

### 1.3 Timeout classification — original and instrumented 40 × 200

The original run recorded 5,618 `subscription:timeout` entries but did not record per-connection
close codes; that harness gap is now fixed. The original entries can be classified by mechanism
but not attributed per connection:

| Class | Count | Basis |
|---|---:|---|
| Local connect failure | **0** | No `EMFILE`, `EADDRINUSE`, `ECONNRESET`, or connection-class error was recorded. All 5,618 were on sessions that had already completed ramp authentication. |
| Server close | **not attributable per connection** | The run ended with **0 sockets up** and the fleet had to be closed by something other than the harness. Close codes were not captured, so no per-connection count is claimed. |
| Auth rejection | **0** | No auth error appears; the same minted token served the 2,385 subscriptions that did become ready. |
| Client timeout | **5,618** | The harness's 30 s subscription deadline expired with no first result. This is the mechanism for all 5,618; the root cause is server close or client-side wait, and the stored evidence cannot split them. |

The instrumented rerun of the same shape did **not** reproduce the 5,618-timeout cliff: 7,222
subscriptions became ready, with 882 attributed subscription failures:

| Class | Instrumented rerun | Detail |
|---|---:|---|
| Local connect failure | **0** | No explicit socket error codes |
| Server close | **167** | All close code 1006, no close frame |
| Auth rejection | **0** | No auth refusal |
| Client timeout | **715** | 30 s deadline; 104 later received a first result |

A consolidated count for all three runs is in `evidence/s5-prod-diag-classification.md`.

The 40 × 200 result is therefore **not clean**, but the catastrophic 5,618-timeout shape is not
stable across runs. The report keeps the curve as the product limit and records the sessions
ceiling as `indeterminate`.

**Rule: benchmarks never run from a single host without port telemetry.** The sampler, the
per-process socket counts, the dynamic port range, and the close-code histogram are written into
every diagnostic evidence file for this reason.

---

## 2. Cross-tenant isolation

`scripts/verify-cross-tenant.mjs` ran against the production HTTP API with two real throwaway
tenants. Evidence: `evidence/verify-cross-tenant.txt`. Result: **10 passed, 0 failed**.

| Check | Result |
|---|---|
| A API key reading a B message gets 404, byte-identical to an unknown id | PASS — 404 `message_not_found`, no existence oracle |
| A API key resolving B `externalRef` for task, group, user | PASS — all 404 |
| A provisioning into a B group | PASS — 404, B membership unchanged |
| A API key posting into a B group | PASS — 404 `group_not_found` |
| A admin listing B webhooks/deliveries | PASS — B had rows; A saw none |
| A mutating B webhook state | PASS — B hook still active |
| Host A widget token resolving only host A support group | PASS |
| Host A widget session reading B support group through standalone queries | PASS — 4 reads refused by `accountState` |
| A token signed for host A presented as host B | PASS — selector switched, kid not found |
| B's own widget host still works while A is refused | PASS — fixture is real, not a dead tenant |

Seven client refusals arrived as Convex's production-redacted `Server Error` rather than the
stable domain message. They still failed closed and no data crossed the boundary; this is recorded
in the evidence rather than treated as a pass with a readable error. Both tenants were purged.

---

## 3. Cost instrumentation and controls

The model is in `convex/lib/cost.ts`; the live projections and onboarding gate are in
`convex/cost.ts`; daily rollups, alert state, and admin queries are in `convex/usage.ts`. Evidence:
`evidence/verify-cost-model.txt` — **7 passed, 0 failed**.

### 3.1 What was proven

- **Appendix A lever-1 baseline:** 400 active users, 15 messages/user/day, 15% viewers, volume mix
  40 groups × 10 / 8 × 40 / one × 400 projects **$18.00 per organisation per month**, with
  **8.25 average viewers per message** and 180,000 messages/month.
- **Alert is spend-driven, not org-count-driven:** with a $100 fixed monthly cost and a $1,000
  ceiling, 33 baseline orgs project **69.4% (`ok`)**, 34 project **71.2% (`warning`)**, and 50
  project **over**. The 70% alert therefore does not key off a raw tenant count.
- **Onboarding gate:** a candidate of 1,000 users with a 5,000-member group is refused before
  creation because it would cross the $1,000 ceiling. A small candidate is admitted and returns its
  projection.
- **Measured rollup path:** a real daily rollup wrote one organisation/day row with the measured
  message count, active senders, group count, group-size buckets, and cost fields. This is a
  measured *rollup*, not a bill.
- **Estimate labeling:** the admin tile and platform status both label the projection as an
  estimate; the tile carries `Estimate — model, not a bill`.
- **No hot cost documents:** there is no per-message counter and no per-group cost document. The
  only writer of `usageRollups` is the daily cron at 00:20 UTC (manual run available for a pilot
  check).

### 3.2 What is modelled, not measured

- **Peak concurrent viewers** are not measured. The build has no presence signal, so the field is
  explicitly `not_measured_no_presence_signal`; the model uses the 15% viewer assumption.
- The $18 baseline and the $1,000/$700 thresholds are projections, not invoices. Seat fees are
  excluded. The admin tile is an estimate.
- The pilot has not yet produced a real monthly Convex invoice; the model's ratios are the
  defensible part.

### 3.3 Convex platform controls

These are account controls, not TeamChat controls, and are documented in `OPERATIONS.md` §3:

- Convex warns at approximately **70%** of the team's usage/spend allowance.
- It can disable projects at approximately **1.5×** the spending limit.
- Seat fees are **excluded** from the spend limit.
- A disable applies to **every project on the team**, not only TeamChat.

Keep this project on a team without unrelated production workloads if a platform-level disable
would be unacceptable. The TeamChat $700 alert is earlier and narrower; it is surfaced in the admin
UI and the deployment log and does not depend on email. The onboarding gate is a spend projection,
not an org-count cap.

---

## 4. Production-class S5

### 4.1 Test shape

Production S5 was split into three runs because the full runs failed before they could produce a
complete result. All runs used six generator processes against `benevolent-crocodile-386`; the full
runs used a 10,000-session target, 256 concurrent one-shot queries, 512 concurrent `messages.send`
actions, the 500/1,000/2,000/4,000/8,000 viewer curve, and 40 groups × 200 viewers. The caps run
measured 256 queries and 512 actions with no fan-out subscriptions. The distributed run measured a
200-viewer baseline and then 40 groups × 200 viewers. Action sends were distributed one per
throwaway group so the 512-action gate measures concurrent writes without turning the run into a
single hot `groupActivity` document test.

The 2026-10-22 diagnostic reruns used the instrumented worker: six generator processes, a 45 s
ramp timeout, the same 10,000-session target, per-process socket sampling every 10 s, and close-code
capture on every WebSocket. The deployment class is S16 (`class: "s16"`), not S256; see §1.1. No
second host or cloud VM was available, so the session ceiling remains a single-host result.

Production sign-in could not be used because the SendGrid key is still a placeholder. S5 uses
internal test seeding and minted RS256 sessions; this is a test-only path and does not prove real
OTP sign-in.

### 4.2 Session ramp — target missed, ceiling indeterminate

| Metric | Full-curve run | Caps-only run | Distributed run | Diagnostic rerun (40×200) |
|---|---:|---:|---:|---:|
| Sessions requested | 10,000 | 10,000 | 10,000 | 10,000 |
| Sessions connected | **7,969** | **7,726** | **8,185** | **8,073** |
| Shortfall | 2,031 (20.3%) | 2,274 (22.7%) | 1,815 (18.2%) | 1,927 (19.3%) |
| Generator processes | 6 | 6 | 6 | 6 |
| Ramp time | 469.8 s | 457.7 s | 445.8 s | 303.9 s |
| Failures | 2,031 `ramp:timeout` | 2,274 `ramp:timeout` | 1,648 `ramp:timeout` | 1,927 `server_close` |
| Server disconnect events while holding | 0 | 0 | 0 | 0 |

A second curve run connected 8,211 sessions before its combined burst timed out; it is not in the
table because it did not produce a complete result. Six independent production runs peak at
**7,726–8,211**, inside 6.3%. That consistency is the reason the ceiling was investigated rather
than reported as a platform limit.

The instrumented rerun resolved the *mechanism*, not the *owner*:

- 1,927 failures all closed with **1006** (abnormal closure, no close frame). There were no
  `EMFILE`, `EADDRINUSE`, `ECONNRESET`, or auth errors.
- Peaks: **8,135 established sockets**, **9,952 / 16,384 ephemeral ports (60.7%)**, 1,875
  `TIME_WAIT`. The local port range was not exhausted.
- Each failed session made up to 4 WebSocket attempts (3 client retries) inside the 45 s ramp
  deadline; host-wide there were 16,397 attempts for 8,097 opens and 8,314 close/error events. The
  Convex client's own backoff is jittered exponential, **1 s base, 16 s cap, ±50% jitter**, not an
  immediate retry loop; the harness itself does not retry a failed session. Explicit reconnects are
  counted separately (7 in this run).
- The deployment class is **S16** (1,000 sessions), yet 8,073 authenticated sessions were admitted.
  The class limit is therefore not the observed session ceiling.

**Verdict: sessions are `indeterminate`.** Not the S16 class limit, and not local port exhaustion at
the measured peak. The unobserved candidates are the upstream router/NAT table and an undocumented
server-side admission limit. **This is a single-host result; no second host or cloud VM was
available.** Do not claim 10,000 sessions, and do not claim 8,211 as a platform limit.

### 4.3 Full fan-out curve — failure above 2,000 viewers

Evidence: `evidence/s5-prod-full-curve-failure.md` and
`evidence/s5-prod-full-curve-failure.log`.

| Viewers requested | Ready | Received | p50 ms | p95 ms | p99 ms |
|---:|---:|---:|---:|---:|---:|
| 500 | 500 | 500 | 1,544.96 | 2,652.21 | 2,755.25 |
| 1,000 | 1,000 | 1,000 | 2,853.63 | 5,124.14 | 5,277.93 |
| 2,000 | 2,000 | 2,000 | 5,442.76 | 9,837.34 | 10,247.25 |
| 4,000 | 3,568 | 2,165 | 179,218.06 | 189,865.32 | 193,440.68 |
| 8,000 | 7,168 | 7,170 | 68,164.11 | 92,330.56 | 94,228.50 |

At 4,000 viewers the fleet dropped from 7,968 to 6,021 sockets during subscription setup; only 3,568
of 4,000 subscriptions became ready and 2,165 receipts arrived after about three minutes. At 8,000
viewers the p95 was 92.3 s. The 8,000 row has 7,170 receipts for 7,168 ready subscriptions; the two
extra receipts are treated as a queued/duplicate artifact, not as full coverage.

A separate run repeated the 500/1,000/2,000 curve before its own fan-out
(`evidence/s5-prod-second-curve-failure.md`). That run's 2,000 point collapsed: only 1,825 of
1,986 ready subscriptions received the message, p95 427 s, after subscription setup itself took
32.7 s. Its 500 and 1,000 subscription setups also took ~30 s, versus ~1 s in the earlier run. The
full-curve run's 2,000 point was 9.8 s p95. The same shape therefore produced a clean 2,000 result
and a seven-minute 2,000 result on different runs.

The 2026-10-22 rerun re-tested 2,000 viewers from the same six-process host: **1,999/2,000 assigned
and ready, 1,999/1,999 receipts, p50 5,281 ms, p95 9,604 ms, p99 9,945 ms**
(`evidence/s5-prod-diag-curve2000.json`). Subscription setup itself took **30.6 s**, so the
9.6 s receipt p95 excludes 30 s of subscription delay. **The 427 s outlier did not reproduce.** The
2,000-viewer p95 stays near 9.6–9.8 s, which is a stable failure of the 2 s interactive target, not
a random seven-minute stall. Production fan-out is consistently non-interactive at 2,000 viewers;
it is not unstable in the sense of varying between seconds and minutes.

**The 2,000 ms interactive p95 threshold is crossed at 500 viewers on production** (p95 2.65 s).
The 200-viewer point is 0.42 s p95; the crossover is between 200 and 500 and was not bisected. The
dev curve's 400-viewer point (p95 1.85 s) is not production evidence. **Production single-group
fan-out has no meaningful interactive headroom at 500 viewers.**

The combined 256-query + 512-action + 8,000-viewer burst did **not complete**: the master timed out
after 240 s waiting for `query-done`. The run threw before the 40 groups × 200 phase. No query or
action result from that burst is claimed; those gates were measured separately in §4.4 and §4.5.

### 4.4 Caps run — 256 queries and 512 actions

Evidence: `evidence/s5-prod-caps-only.json` and `evidence/s5-prod-caps-only-run.log`.

The caps-only run held **7,726 sessions** and issued no fan-out subscriptions. It measured the
query and action gates in isolation.

| Gate | Concurrency | Completed | Errors | p50 ms | p95 ms | p99 ms | Max ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| One-shot queries | 256 | 256 | 0 | 402.88 | **420.45** | 14,450.16 | 35,562.56 |
| `messages.send` actions | 512 | 512 | 0 | 1,576.75 | **2,637.06** | 2,722.67 | 2,788.31 |

Both gates completed with zero errors. The query p95 is well inside a 2 s interactive target, but
its p99 is 14.45 s and its max is 35.56 s: a small tail stalled badly even with no fan-out. The
action p95 is 2.64 s, so the 512-action gate meets the concurrency/zero-error requirement but
**misses a 2 s interactive target**. It is not evidence that 512 same-group sends pass; the actions
were spread across 512 groups.

### 4.5 Distributed fan-out — 40 groups × 200 viewers fails

Evidence: `evidence/s5-prod-fanout40-failure.md`,
`evidence/s5-prod-fanout40-failure.log`, and `evidence/s5-prod-fanout40-result.json`. The
instrumented rerun is in `evidence/s5-prod-diag-fanout40.json` and `.log`.

The original run held **8,185 sessions**. A single 200-viewer group and a combined 1-query +
1-action + 200-viewer burst passed:

| 200-viewer baseline | Result |
|---|---:|
| Ready / received | 197 / 197 |
| p50 / p95 / p99 | 406.11 / 424.53 / 432.63 ms |
| Combined query p95 | 275.87 ms |
| Combined action p95 | 315.19 ms |
| Combined fan-out p95 | 403.66 ms |
| Combined errors / missing | 0 / 0 |

The 40 groups × 200 viewers phase then failed:

| Metric | Result |
|---|---:|
| Groups | 40 |
| Viewers requested | 8,000 |
| Viewers subscribed | **2,385 (29.8%)** |
| Subscription timeouts | **5,618** |
| Receipt timeouts | 15 |
| p50 | **38,673.67 ms** |
| p95 | **62,750.95 ms** |
| p99 | **62,935.93 ms** |

Subscription setup took 242.3 s and ended with **0 sockets reported up**. The 2,409 receipts that
arrived are not coverage: only 2,385 subscriptions were ready, and the receipt count includes
groups whose final viewer assignment was empty. **The 40 × 200 distributed gate is a production
failure.** The earlier dev result (p95 626 ms, zero missing) did not transfer.

#### Instrumented rerun, 2026-10-22

The same 40 groups × 200 shape was rerun from the same six-process host with close-code capture and
socket telemetry:

| Metric | Original run | Instrumented rerun |
|---|---:|---:|
| Sessions connected after ramp | 8,185 | 8,073 |
| Viewers requested | 8,000 | 8,000 |
| Subscriptions accepted | not recorded | 7,118 |
| Ready at health check | 2,385 (29.8%) | **7,222 (90.3%)** |
| Subscription failures | 5,618 `subscription:timeout` | **882** — 167 `server_close` (1006), 715 `client_timeout` |
| Receipts | 2,409 | **7,256 for 7,222 expected** |
| Viewers missing the probe | not comparable | **671 across 30 of 40 groups** (worst group 51/200) |
| p50 / p95 / p99 from send | 38,673.67 / 62,750.95 / 62,935.93 ms | 1,920.40 / 2,994.30 / 3,328.07 ms |
| Send-start delay after target epoch | not recorded | **p50 199,234.62 ms, p95 199,930.30 ms** |
| Result | **fail** | **fail** |

The rerun recovered most of the subscription loss — 7,222 of 8,000 ready instead of 2,385 — but it
still fails on four independent counts:

1. **Coverage:** 671 viewers in 30 of 40 groups never received the probe. Ten groups missed
   nothing; the worst group missed 51 of 200.
2. **Latency:** p95 from send was 2.99 s, over the 2 s interactive target.
3. **End-to-end delay:** the 40 sends themselves started a median **199.2 s** after the target
   epoch. The 1.92/2.99 s percentiles are measured from each group's own send, so they exclude
   that debt; from probe start, the median viewer waited about **201 s**.
4. **Delivery accounting:** 7,256 receipts for 7,222 ready subscriptions is not coverage. The 34
   net extra receipts come from client-timeout subscriptions that completed late (104 of the 715
   later received a first result); they do not offset the 671 missing viewers.

**The 40 × 200 distributed gate fails in both runs.** The instrumented rerun shows the shape is not
a single 5,618-timeout cliff: it degrades into partial coverage plus a ~200 s start debt. Neither
outcome supports 8,000 concurrent viewers spread over 40 groups, and the earlier dev result
(p95 626 ms, zero missing) did not transfer.

### 4.6 Same-group write contention

The 512-action gate is deliberately distributed one action per group. A previous production smoke
with 20 concurrent sends to **one** group hit a `messages.send` failure and `groupActivity` OCC
retries. The production S5 therefore does **not** claim that 512 same-group sends pass. Same-group
concurrent writes remain a known contention limitation; the gate measured here is 512 concurrent
action writes across separate groups.

### 4.7 S5 verdict

**S5 is a production failure, not a pass.**

- The 10,000-session gate was not reached: the original curve run peaked at 8,211, and the
  instrumented reruns at **8,073** and **8,030**. Failures were 1006 server closes with no close
  frame, local ephemeral-port use peaked at **60.7%**, and there were no local socket-resource
  errors. The session ceiling is **`indeterminate`**: it is neither the S16 class limit nor proven
  local port exhaustion, and no second host or cloud VM was available, so this remains a
  single-host result.
- 256 concurrent queries pass with zero errors (p95 420 ms, p99 14.45 s).
- 512 concurrent action writes complete with zero errors (p95 2.64 s), but the 2 s interactive
  target is missed and same-group contention is untested.
- A single 200-viewer group passes (p95 425 ms).
- A single 500-viewer group already misses a 2 s p95 (2.65 s); 1,000 is 5.12 s; 2,000 is 9.84 s in
  the original curve and 9.60 s in the instrumented rerun, with subscription setup itself taking
  30.6 s. The earlier 427 s outlier did not reproduce.
- 4,000 and 8,000 viewers in one group collapse: socket loss, missing receipts, 68–193 s p95.
- **40 groups × 200 viewers collapses in both runs**: the original had only 2,385 of 8,000
  subscriptions ready with 5,618 timeouts and p95 62.8 s; the instrumented rerun reached 7,222 of
  8,000, still missed **671 viewers in 30 of 40 groups**, had p95 2.99 s from send, and started its
  sends a median **199 s** late.
- The combined 256-query + 512-action + 8,000-viewer burst timed out after 240 s.

The production deployment is usable for small groups and low total fan-out, but it is **not**
ready for a pilot with large or numerous simultaneously active groups. Pilot limits must be set
from measured behavior: 200 concurrent viewers in one group is the only fan-out point that passed
cleanly, and 40 groups × 200 did not. Cap total concurrent live viewers across the org at that
level. Do not claim 500+ interactive fan-out or 10,000 sessions.

**Provisional onboarding limit: 300 members per organisation or group, revisited before org #4.**
At a 60% concurrent-viewer burst, 300 members project **180 concurrent viewers**, below the tested
clean 200-viewer point (p95 424.53 ms), so the measured fan-out supports it with margin. This is a
condition, not a tested 300-member result: no run exercised a 300-member org. Revisit before
onboarding organisation #4, or before any org or group exceeds 300 members, whichever comes first.
The pre-onboarding check and the group-size flag are in `PILOT_RUNBOOK.md` §1.4 and §5.2.

---

## 5. Operability

### 5.1 Pilot runbook

`app/PILOT_RUNBOOK.md` contains the required eight steps in order:

1. Verify the production build, environment, and key custody.
2. Create the pilot organisation and owner; set the per-organisation storage cap.
3. Apply the least-privilege bucket policy and configure storage.
4. Prove the cap and the upload/read round-trip.
5. Provision and activate staff.
6. Register the webhook and prove signature, retry, and dead-letter.
7. Run one sample Action task end to end.
8. Confirm the usage rollup and cost tile, then know the rollback.

The bucket policy JSON is scoped to `keyPrefix` and deliberately omits `s3:ListBucket`; secrets are
written only to `byosCredentials`, never to a client-readable document. The runbook also records
the per-org storage cap, the staff activation path, the 4-attempt webhook retry/dead-letter
behaviour, the Action task API/view/audit path, the rollup/cost tile check, and the rollback
procedure.

### 5.2 Key custody, backup, and region move

`app/OPERATIONS.md` records:

- **Key custody:** `TEAMCHAT_MASTER_KEY` decrypts `byosCredentials` and `webhookSecrets`. Losing it
  makes stored S3 credentials and webhook secrets unrecoverable; rotation is not implemented in
  this build. `JWT_PRIVATE_KEY`/`JWKS` are the auth signing pair; the deploy key and SendGrid key
  have their own loss effects.
- **Backups:** primary copies are in the gitignored `app/.storage/`. **Backup A** must be a
  password-manager/sealed-secret item; **Backup B** must be an offline encrypted copy held by a
  second named custodian. Neither has been created. The restore drill in `OPERATIONS.md` §2.4 is
  **UNRUN**: this host has no separate scratch deployment, and production currently has no stored
  `byosCredentials` or `webhookSecrets` rows to decrypt, so a restore would not prove decryption.
  This is an open gate before the first real organisation.
- **Export cadence:** daily Convex export at 02:00 UTC (30 daily / 12 weekly / 6 monthly), weekly
  with Convex file storage, and a pre-deploy export before schema/migration changes. Local
  `backups/convex/` is staging only; completed exports must be copied to the encrypted archive with
  object key, size, SHA-256, and timestamp recorded.
- **Region move:** create the target deployment in the new region, set production env, deploy the
  same commit, export the old deployment and import into the new one, keep the same master key, and
  freeze writes during the final export/import. BYOS bucket data does not move; the new deployment
  reaches the same buckets with the same credentials.

### 5.3 Retention and index decisions

- **Retention:** keep all messages for the MVP. No deletion cron, no automatic expiry, no per-org
  override. Revisit at month 12, or earlier for a contract, erasure request, or material storage
  cost. The decision and its reasoning are in `OPERATIONS.md` §4.
- **`messages.by_org_external`:** retained. `/v1/tasks?externalRef=` resolves through it; Appendix
  A's prune recommendation is contradicted by Part 5 §3b. The index's write cost is in the model.
  See `OPERATIONS.md` §5.

### 5.4 Production auth and OTP

- Production requires `TEAMCHAT_OTP_PROVIDER=sendgrid`, a non-empty `SENDGRID_API_KEY`, and
  `TEAMCHAT_OTP_FROM`; it refuses to serve auth without them. The runtime check rejects an empty key;
  the deploy guard additionally rejects the known placeholder. A placeholder therefore starts the
  deployment but every real send fails at SendGrid, which is why real delivery is an open gate. The
  echoed-OTP stub is compile-time and runtime-refused in production (CR-16).
- SendGrid is implemented behind the existing wrapper. SES is documented as a swappable alternative
  but is **not implemented** in this build.
- The OTP limits still apply: 3 requests per email and 20 per IP per 10 minutes, plus 10
  verification attempts per email per 10 minutes.
- `scripts/verify-otp-provider.mjs` ran against dev with the mock provider: **6/6 passed**,
  including a provider call, 180-second code lifetime, wrong-code refusal, successful verification,
  and refusal of a fourth request in 10 minutes. Evidence: `evidence/verify-otp-provider.txt`.
  This proves the application path; it does not prove inbox placement.

---

## 6. Manual gates

These are **not done** and must not be marked done because a mock, a typecheck, or a local test
passed.

| Gate | Status | Why it is open |
|---|---|---|
| Real SendGrid key and a real OTP sign-in | **OPEN** | Production still has the placeholder `SG.REPLACE_ME_...`; the guard fails on it. Replace it in the Convex env and run one real sign-in. |
| Gmail/Outlook deliverability for the production from-domain | **OPEN** | Inbox placement, SPF/DKIM/DMARC alignment, bounce handling, and provider reputation need real mailboxes. The mock-provider test cannot prove this. |
| Real S3-compatible bucket credentials, policy review, and upload/read round-trip | **OPEN** | BYOS configuration is DB-driven; no real bucket credentials were supplied. The organisation's bucket administrator must review the least-privilege policy in `PILOT_RUNBOOK.md` §3. Then run the cap/upload/read/cap-refusal checks in §4. |
| Native iOS and Android device pass | **OPEN** | The mobile client typechecks/builds, but no real device or emulator pass was available. |
| Counsel review of cross-border transfer | **OPEN** | Region and bucket location imply a transfer decision that a lawyer must review; this is not an engineering check. |
| Key backup A/B and restore test | **OPEN — drill UNRUN** | Primary copies exist in `app/.storage/`; the two independent backups have not been created. The restore drill in `OPERATIONS.md` §2.4 is recorded as **UNRUN** because no scratch deployment exists and production has no stored credentials to decrypt. Do this before the first real organisation. |

The production S5 runs are not a substitute for any of these gates. In particular, production S5
used seeded users with minted RS256 sessions because the SendGrid placeholder makes real email OTP
impossible; it does not prove real sign-in.

---

## 7. Decisions the prompt did not cover

These were judgement calls made while implementing the pilot; they are recorded here so they can be
reversed deliberately.

1. **Deployment name vs reference.** The CLI deploy uses the key scoped to
   `benevolent-crocodile-386`. `teamchat-prod` is only a reference for `convex env`; a bare
   `convex deploy` targets a different empty production deployment. The runbook documents the safe
   path.
2. **SendGrid first, SES documented only.** SendGrid is implemented behind the provider wrapper;
   SES is an alternative design note, not code. The production guard accepts SendGrid only.
3. **Cost calibration.** The model uses the Appendix A lever-1 baseline, a $100 fixed monthly cost,
   a 30-day month, a 15% viewer rate, and the 70/20/10 volume mix. These are assumptions, not
   measured invoice data. Peak viewers are explicitly unmeasured.
4. **Per-organisation storage cap.** The default is 5 GiB
   (`TEAMCHAT_ORG_STORAGE_CAP_BYTES`), overridable per organisation through
   `organizations.storageCapBytes`. The runbook sets it in the dashboard.
5. **Retention.** Keep all messages for the MVP; no deletion cron. Revisit at month 12.
6. **External-reference index.** Keep `messages.by_org_external`; do not prune it.
7. **Tenancy.** One Convex project/deployment serves all pilot organisations; there is no
   per-tenant Convex project split.
8. **Action burst shape.** The 512-action S5 burst distributes one action per throwaway group, so
   it measures 512 concurrent writes without conflating them with a single hot `groupActivity`
   document. Same-group concurrent sends remain a known contention limit; this run does not claim
   512 same-group sends pass.
9. **Production errors.** Convex redacts non-HTTP production errors to `Server Error`; cross-tenant
   and cost checks treat a redacted throw as fail-closed and record the count (7 in the cross-tenant
   run).
10. **S5 session seeding.** Production S5 uses internal test seeding and minted RS256 tokens because
    real OTP is unavailable. This is a test-only path, not a production sign-in path.
11. **S5 split into three runs.** The full runs failed at the combined burst, so the caps and
    distributed gates were measured separately rather than fabricating one passing run. The failed
    full-curve results are preserved in `evidence/s5-prod-full-curve-failure.*` and
    `evidence/s5-prod-second-curve-failure.*`; the caps and distributed results are separate
    evidence files.
12. **Fixture cleanup.** Production test tenants, groups, and users are purged after each run. The
    purge now deletes group rows and walks large tenants in chunks because a 557-group tenant
    exceeded Convex's 4,096-read mutation limit. At report time the production database is empty.

---

## 8. Bottom line

**Production is deployed and instrumented, but the pilot is not cleared to start until the manual
gates close and the live fan-out limit is enforced.**

- **Production:** `benevolent-crocodile-386`, `aws-us-east-1`,
  `https://benevolent-crocodile-386.convex.cloud`. The bundle reports
  `channel=production echoOtp=false`. CR-16 is proven three ways: compile refusal
  (`evidence/cr16-compile.txt`), deploy refusal (`evidence/cr16-deploy-refusal.txt`), and runtime
  refusal (`evidence/cr16-runtime.txt`). `npm run guard:prod` currently fails only on the
  placeholder SendGrid key; everything else, including the production build info, passes.
- **Cross-tenant isolation:** 10/10 checks pass against production
  (`evidence/verify-cross-tenant.txt`). Cross-tenant reads and writes return 404/empty, not 403;
  seven refusals were Convex-redacted but still failed closed.
- **Cost:** the Appendix A lever-1 baseline projects **$18.00/org/month**; 33 baseline orgs are
  `ok`, 34 are `warning`, and the onboarding gate refuses a candidate that crosses the $1,000
  ceiling (`evidence/verify-cost-model.txt`). The daily rollup and admin tile are labelled
  estimates, not bills. Peak concurrent viewers remain `not_measured_no_presence_signal`.
- **S5:** the 10,000-session target was not reached; instrumented reruns peaked at **8,073** and
  **8,030** sessions, so the ceiling is **`indeterminate`** — not the S16 class limit and not proven
  local port exhaustion. 256 queries passed with zero errors (p95 420 ms, p99 14.45 s); 512 actions
  passed with zero errors (p95 2.64 s). A single 200-viewer group passed (p95 425 ms), but 500
  already missed a 2 s p95 (2.65 s), 2,000 was stably non-interactive (9.6–9.8 s; the 427 s outlier
  did not reproduce), and 4,000/8,000 collapsed. **40 groups × 200 failed in both runs**: the
  original reached 2,385/8,000 with 5,618 timeouts, and the instrumented rerun reached 7,222/8,000
  but still missed 671 viewers and started sends a median 199 s late. The combined 8,000-viewer
  burst timed out. S5 is a failure, not a pass, and it is a single-host measurement.
- **Pilot limit:** the only clean fan-out point is **200 concurrent viewers in one group**. Cap
  total concurrent live viewers across the org at that level for the pilot, or accept
  non-interactive behavior. Do not claim 500+ interactive fan-out or 10,000 sessions.
- **Provisional onboarding condition:** **300 members per organisation or group**, which at a 60%
  burst projects 180 concurrent viewers and fits under the tested 200-viewer point. This is an
  untested extrapolation, not a measured 300-member result. Revisit before organisation #4, or
  before any org/group exceeds 300 members. The runbook pre-onboarding check and group-size flag
  enforce it as a manual gate; there is no product enforcement code.
- **Operability:** `app/PILOT_RUNBOOK.md` has the eight ordered steps, including the
  least-privilege bucket policy scoped to `keyPrefix`, the 5 GiB default cap, staff activation,
  webhook signature/retry/dead-letter, one Action task end to end, the rollup/cost tile, and
  rollback, plus the §1.4 pre-onboarding check and §5.2 group-size flag. `app/OPERATIONS.md` covers
  key custody, backup/export/region move, Convex platform controls, retention, and the
  `by_org_external` decision. **Key backups A/B are still not created and the restore drill is
  UNRUN**; losing `TEAMCHAT_MASTER_KEY` makes stored bucket credentials and webhook secrets
  unrecoverable.
- **Manual gates still open:** real SendGrid key and real OTP sign-in; Gmail/Outlook deliverability;
  real S3-compatible bucket credentials, org-admin policy review, and upload/read round-trip;
  native iOS/Android device pass; counsel review of cross-border transfer; key backup A/B and
  restore test. A mock, a typecheck, or a seeded S5 session does not close any of these.
- **Cleanup:** all production test tenants, orphaned groups, and loose test users were purged. At
  report time the production database has **0 organisations, 0 groups, 0 users, 0 messages, 0
  memberships, 0 action rows, 0 rollups, and 0 auth sessions**
  (`evidence/prod-db-clean.txt`).

**Recommendation:** do not onboard a real organisation until the SendGrid key is replaced, bucket
credentials and policy review are complete, key backups are verified, and total concurrent live
viewers across the org are capped at 200. Keep every pilot org and group at or below the provisional
**300 members**, and re-run the pre-onboarding check before organisation #4 or any group above 300.
The engineering path is ready for a small, low-fan-out pilot; the evidence does not support a broad
or large-group pilot.
