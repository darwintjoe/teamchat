# S5 v2 distributed result

Run: 2026-10-21T05:09:25.701Z  
Deployment: https://benevolent-crocodile-386.convex.cloud  
Sessions: **120/120** across 4 processes in 3.3s  

## Fan-out curve

| Viewers requested | Subscribed | Received | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) |
|---:|---:|---:|---:|---:|---:|---:|
| 50 | 50 | 50 | 331.78 | 350.93 | 352.07 | 352.07 |

## Combined burst at 8k

- Queries: 20/20, p95 407.92 ms, errors 0
- Actions: 20/20, p95 533.57 ms, errors 0
- Fan-out: 50/50, p95 487.43 ms, missing 0

## 40 groups × 200

- Viewers: 120, receipts 120, p95 352.37 ms, missing 0

## Session ramp

| Worker | Attempted | Connected | Seconds | Failures | RSS MB | Capped |
|---:|---:|---:|---:|---:|---:|---|
| 0 | 30 | 30 | 3.2 | 0 | 65 |  |
| 1 | 30 | 30 | 3.3 | 0 | 65 |  |
| 2 | 30 | 30 | 2.5 | 0 | 64 |  |
| 3 | 30 | 30 | 3.3 | 0 | 65 |  |

Failures by class: {}

