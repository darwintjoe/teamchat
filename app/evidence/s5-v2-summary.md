# S5 v2 distributed result

Merged: 2026-10-20T05:49:36.441Z  
Deployment: https://adventurous-squirrel-356.convex.cloud (aws-us-east-1)  
Generator: 4 OS processes, fresh 10,000-session fleet per scenario  

## Fan-out curve (one message, one group)

| Requested viewers | Subscribed | Received | p50 ms | p95 ms | p99 ms | Max ms |
|---:|---:|---:|---:|---:|---:|---:|
| 400 | 400 | 400 | 974.49 | 1852.14 | 2003.33 | 2018.99 |
| 500 | 500 | 500 | 1218.24 | 2409.4 | 2483.41 | 2500.86 |
| 1000 | 1000 | 1000 | 2569.62 | 4681.19 | 4920.35 | 5019.45 |
| 2000 | 2000 | 2000 | 5063.09 | 9501.41 | 9900.19 | 9995.31 |
| 4000 | 4000 | 4000 | 9879.2 | 19125.77 | 19817.35 | 20174.82 |
| 8000 | 8000 | 8000 | 20127.54 | 38219.6 | 39783.35 | 40442.25 |

Linear fit: 4.7852 ms per viewer; 2,000 ms p95 threshold at ~427 viewers.
Largest measured point under 2,000 ms p95: **400 viewers** (p95 1852.14 ms).

## Session ramp (fresh fleet per scenario)

| Scenario | Requested | Connected | Shortfall | Seconds | Failures |
|---|---:|---:|---:|---:|---|
| curve400 | 10000 | 8167 | 1833 | 266.4 | {"ramp:timeout":1833} |
| curve500 | 10000 | 8013 | 1987 | 263.2 | {"ramp:timeout":1987} |
| curve1000 | 10000 | 8268 | 1732 | 290.9 | {"ramp:timeout":1732} |
| curve2000 | 10000 | 8024 | 1976 | 280.7 | {"ramp:timeout":1976} |
| curve4000 | 10000 | 7986 | 2014 | 186.6 | {"ramp:timeout":2014} |
| curve8000 | 10000 | 8040 | 1960 | 196.6 | {"ramp:timeout":1960} |
| fanout40 | 10000 | 8044 | 1956 | 252.4 | {"ramp:timeout":1956} |
| sequential | 10000 | 8057 | 1943 | 188.1 | {"ramp:timeout":1943} |

Best connected: **8268/10,000**.

## Combined burst (256 queries + 512 actions + fan-out at one instant)

### 4,000 viewers

- Queries: 256/256, errors 0, p50 328.9 ms, p95 345.61 ms, p99 349.34 ms
- Actions: 512/512, errors 0, p50 1612.95 ms, p95 2646.39 ms, p99 2759.8 ms
- Fan-out: 4000/4000, missing 0, p50 9958.77 ms, p95 19181.27 ms, p99 19903.61 ms
- Send-return debt: 369.27 ms

### 8,000 viewers

- Queries: 256/256, errors 0, p50 298.82 ms, p95 314.1 ms, p99 777.17 ms
- Actions: 512/512, errors 0, p50 1624.36 ms, p95 2757.93 ms, p99 2878.53 ms
- Fan-out: 8000/8000, missing 0, p50 19230.15 ms, p95 37954.29 ms, p99 39684.45 ms
- Send-return debt: 378.77 ms

## Sequential baseline

- Queries: 256/256 one at a time, errors 0, p50 274.97 ms, p95 342.02 ms, wall 74639.8 ms
- Actions: 512/512 one at a time, errors 0, p50 308.62 ms, p95 388.5 ms, wall 165518.8 ms
- Fan-out: 4000/4000, p95 19191.64 ms

## 40 groups x 200 viewers

- Viewers: 8000/8000
- Messages: 40 (one per group)
- Receipts: 8000, missing 0
- p50 327.48 ms, p95 626.29 ms, p99 674.05 ms, max 835.02 ms

## Failures by class

```json
{
  "byClass": {
    "ramp:timeout": 15401
  },
  "perScenario": [
    {
      "scenario": "curve400",
      "total": 1833,
      "byClass": {
        "ramp:timeout": 1833
      }
    },
    {
      "scenario": "curve500",
      "total": 1987,
      "byClass": {
        "ramp:timeout": 1987
      }
    },
    {
      "scenario": "curve1000",
      "total": 1732,
      "byClass": {
        "ramp:timeout": 1732
      }
    },
    {
      "scenario": "curve2000",
      "total": 1976,
      "byClass": {
        "ramp:timeout": 1976
      }
    },
    {
      "scenario": "curve4000",
      "total": 2014,
      "byClass": {
        "ramp:timeout": 2014
      }
    },
    {
      "scenario": "curve8000",
      "total": 1960,
      "byClass": {
        "ramp:timeout": 1960
      }
    },
    {
      "scenario": "fanout40",
      "total": 1956,
      "byClass": {
        "ramp:timeout": 1956
      }
    },
    {
      "scenario": "sequential",
      "total": 1943,
      "byClass": {
        "ramp:timeout": 1943
      }
    }
  ]
}
```

