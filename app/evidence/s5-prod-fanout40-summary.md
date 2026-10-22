> **Read with s5-prod-fanout40-failure.md.** The 40 groups x 200 phase failed: only 2,385 of 8,000 viewers subscribed, 5,618 subscription timeouts, p95 62.8 s. The missing -24 figure is an artifact of receipts from groups whose final viewer assignment was empty; it is not coverage.

# S5 v2 distributed result

Run: 2026-10-22T00:41:49.190Z  
Deployment: https://benevolent-crocodile-386.convex.cloud  
Sessions: **8185/10000** across 6 processes in 445.8s  
Session shortfall: **1815**  

## Fan-out curve

| Viewers requested | Subscribed | Received | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |
|---:|---:|---:|---:|---:|---:|---:|
| 200 | 197 | 197 | 406.11 | 424.53 | 432.63 | 433.04 |

## Combined burst at 200 target viewers

- Queries: 1/1, p95 275.87 ms, errors 0
- Actions: 1/1, p95 315.19 ms, errors 0
- Fan-out: 197/197, p95 403.66 ms, missing 0

## 40 groups × 200

- Viewers: 2385, receipts 2409, p95 62750.95 ms, missing -24

## Session ramp

| Worker | Attempted | Connected | Seconds | Failures | RSS MB | Capped |
|---:|---:|---:|---:|---:|---:|---|
| 0 | 1667 | 1393 | 445.8 | 274 | 315 |  |
| 1 | 1650 | 1374 | 427.2 | 276 | 317 |  |
| 2 | 1650 | 1380 | 423.4 | 270 | 319 |  |
| 3 | 1600 | 1323 | 424.8 | 277 | 305 |  |
| 4 | 1600 | 1325 | 423.2 | 275 | 315 |  |
| 5 | 1666 | 1390 | 438.7 | 276 | 320 |  |

Failures by class: {"ramp:timeout":1648,"subscription:timeout":5618,"fanout40:receipt_timeout":15}


