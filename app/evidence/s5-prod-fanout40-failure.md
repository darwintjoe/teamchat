# S5 production 40 groups × 200 viewers — failure record

Run: 2026-10-22T00:27:39Z–00:43:52Z  
Deployment: `https://benevolent-crocodile-386.convex.cloud` (`aws-us-east-1`)  
Throwaway org: `org_qhc8fu1rlvu0` (purged after the run)  
Raw log: `evidence/s5-prod-fanout40-failure.log`  
Structured result: `evidence/s5-prod-fanout40-result.json`

This run isolated the distributed fan-out gate. It used 6 generator processes, 1 query, 1 action,
and a 200-viewer baseline before reshaping to **40 groups × 200 viewers = 8,000 subscriptions**.

## Session ramp

- Connected: **8,185 / 10,000** in 445.8 s; shortfall 1,815.
- 1,648 `ramp:timeout` attempts, all `hasEverConnected=false`.
- The 8,185 connected sessions were stable before subscription setup.

## 200-viewer baseline — passes

| Viewers requested | Ready | Received | p50 ms | p95 ms | p99 ms |
|---:|---:|---:|---:|---:|---:|
| 200 | 197 | 197 | 406.11 | 424.53 | 432.63 |

The combined 1-query + 1-action + 200-viewer burst also passed: query p95 275.87 ms, action p95
315.19 ms, fan-out p95 403.66 ms, zero errors, zero missing.

## 40 groups × 200 viewers — fails

| Metric | Result |
|---|---:|
| Groups | 40 |
| Viewers requested | 8,000 |
| Viewers subscribed | **2,385 (29.8%)** |
| Subscription timeouts | **5,618** |
| Messages sent | 40 |
| Receipts | 2,409 |
| Receipt timeouts | 15 |
| p50 | **38,673.67 ms** |
| p95 | **62,750.95 ms** |
| p99 | **62,935.93 ms** |

Subscription setup took 242.3 s and ended with **0 sockets reported up**. Only 2,385 of the 8,000
viewers became ready; the rest timed out. The receipts that did arrive were spread over roughly
21–63 s, far outside any interactive target. Some groups received receipts despite having 0
assigned viewers in the final assignment, so the 2,409 receipt count is not evidence of 2,409
covered viewers; coverage is the 2,385 ready subscriptions.

## What this proves

- The distribution shape does **not** rescue production fan-out. Forty concurrent group
  subscriptions at 200 viewers each collapses the same way a single 4,000/8,000-viewer group does.
- The 200-viewer baseline passes, so the failure is not a broken harness or a dead deployment.
- The 40 × 200 gate is a **production failure**, not a pass. The earlier dev result (p95 626 ms,
  zero missing) does not transfer to production.
- The production product must cap concurrent live fan-out well below this shape, or change the
  subscription/fan-out architecture, before a pilot with many active groups.
