# S5 production full-curve run — failure record

Run: 2026-10-21T06:29:08Z–06:57:12Z  
Deployment: `https://benevolent-crocodile-386.convex.cloud` (`aws-us-east-1`)  
Throwaway org: `org_76w9l75m19ru` (purged after the run)  
Raw log: `evidence/s5-prod-full-curve-failure.log`

This run used 6 generator processes, a 10,000-session target, 256 concurrent queries, 512
concurrent actions, the 500/1,000/2,000/4,000/8,000 viewer curve, and the 40 groups × 200 phase.

## Session ramp

- Connected: **7,969 / 10,000** in 469.8 s; shortfall **2,031**.
- All 2,031 failures were `ramp:timeout`, with `hasEverConnected=false`. The workers held the
  7,969 connected sessions; there were no server disconnect events during the hold.
- The ramp budget stopped the remaining attempts after 7 minutes. The shortfall is consistent with
  a load-generator host/NAT connection ceiling, not a proven 10,000-session deployment limit. The
  same host reached 7,841/8,000 on a separate 8,000-session probe and held it for 45 s.

## Single-group fan-out curve

| Viewers requested | Ready | Received | p50 ms | p95 ms | p99 ms | Sockets up after subscribe |
|---:|---:|---:|---:|---:|---:|---:|
| 500 | 500 | 500 | 1,544.96 | 2,652.21 | 2,755.25 | 7,968 |
| 1,000 | 1,000 | 1,000 | 2,853.63 | 5,124.14 | 5,277.93 | 7,969 |
| 2,000 | 2,000 | 2,000 | 5,442.76 | 9,837.34 | 10,247.25 | 7,969 |
| 4,000 | 3,568 | 2,165 | 179,218.06 | 189,865.32 | 193,440.68 | 6,021 |
| 8,000 | 7,168 | 7,170 | 68,164.11 | 92,330.56 | 94,228.50 | 7,718 |

At 4,000 viewers the fleet dropped from 7,968 to 6,021 sockets during subscription setup; only 3,568 of 4,000
subscriptions became ready, and 2,165 receipts arrived after roughly three minutes. At 8,000
viewers 7,168 of 7,969 subscriptions were ready and the p95 was 92.3 s. The 8,000 row reports 7,170
receipts for 7,168 ready subscriptions; the extra receipts are treated as a queued/duplicate
delivery artifact, not as full coverage.

## Combined burst

The combined burst started 256 one-shot queries, 512 `messages.send` actions, and the 8,000-viewer
fan-out at one target epoch. The master timed out after 240 s waiting for worker 0's `query-done`.
No query or action result was written. The run threw before the 40 groups × 200 phase, so that
phase has no production result in this run.

## What this proves

- The deployment accepted and held **7,969 concurrent authenticated sessions** without a server
  disconnect, but the single-host generator could not reach 10,000.
- Single-group fan-out is **not interactive at 500 viewers** (p95 2.65 s) and degrades badly above
  2,000 viewers. At 4,000 viewers the deployment sheds sockets and stops delivering in a bounded
  time; at 8,000 viewers the p95 is 92 s.
- The combined 256-query + 512-action + 8,000-viewer burst did **not complete** on production.
  This is a failure, not a passing gate.
- The 40 groups × 200 distribution was not measured in this run. The earlier dev run measured it
  at 626 ms p95 with zero missing; that is dev evidence, not production evidence.

The run is recorded as a **production S5 failure**. Follow-up runs isolated the gates: a caps-only
run measured 256 queries and 512 actions with no fan-out, and a distributed run measured a clean
200-viewer baseline but a failed **40 groups × 200** phase (`2,385/8,000` subscribers, p95 62.8 s).
