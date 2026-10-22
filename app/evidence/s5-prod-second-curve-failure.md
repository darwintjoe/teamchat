# S5 production second curve run — 2,000-viewer collapse

Run: 2026-10-21T15:36:16Z–15:59:47Z  
Deployment: `https://benevolent-crocodile-386.convex.cloud` (`aws-us-east-1`)  
Throwaway org: `org_46uwsl3m2819` (purged after the run)  
Raw log: `evidence/s5-prod-second-curve-failure.log`

This run repeated the 500/1,000/2,000 curve to isolate the fan-out behavior without the
4,000/8,000 points. It used 6 generator processes, 256 queries and 512 actions for the combined
burst.

## Session ramp

- Connected: **8,211 / 10,000** in 435.5 s; shortfall 1,789.
- All 1,789 failures were `ramp:timeout`.

## Curve

| Viewers requested | Ready | Received | Subscribe s | p50 ms | p95 ms | p99 ms |
|---:|---:|---:|---:|---:|---:|---:|
| 500 | 497 | 497 | 30.6 | 1,609.53 | 2,672.78 | 2,761.65 |
| 1,000 | 994 | 995 | 30.7 | 3,018.37 | 5,072.90 | 5,247.80 |
| 2,000 | 1,986 | 1,825 | 32.7 | 294,235.13 | 427,154.35 | 433,995.94 |

The 2,000-viewer message took about seven minutes: only 1,825 of 1,986 ready subscriptions
received it, p95 427 s. This is materially worse than the earlier full-curve run's 2,000 point
(2,000/2,000 received, p95 9.8 s). Subscription setup also took about 30 s at every point in this
run, versus about 1 s in the earlier run.

## Combined burst

The combined 256-query + 512-action + 2,000-viewer fan-out started after the curve. It timed out
after 240 s waiting for worker 1's `query-done`. No query or action result was produced. The run
threw before the 40 groups × 200 phase.

## Interpretation

The same 2,000-viewer shape passed cleanly in one production run and collapsed in another. The
difference is not a harness clock issue: all timestamps are on one host clock, and the 200-viewer
baseline in the later distributed run passed at 424 ms p95. **Production fan-out is unstable at
2,000 viewers and cannot be treated as a safe operating point.** The 40 groups × 200 phase was
measured separately and also failed (`evidence/s5-prod-fanout40-failure.md`).
