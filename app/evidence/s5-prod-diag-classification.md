# S5 timeout classification — 2026-10-22

Source data:

- `evidence/s5-prod-fanout40-result.json` — original 40 × 200 run (5,618 timeouts)
- `evidence/s5-prod-diag-fanout40.json` — instrumented 40 × 200 rerun
- `evidence/s5-prod-diag-curve2000.json` — instrumented 2,000-viewer rerun
- `evidence/s5-prod-diag-fanout40.log`, `evidence/s5-prod-diag-curve2000.log`

Buckets: local connect failure, server close, auth rejection, client timeout.

## Original 40 × 200 run

| Bucket | Count | Evidence |
|---|---:|---|
| Local connect failure | **0** | No `EMFILE`, `EADDRINUSE`, `ECONNRESET`, or connection-class error was recorded. |
| Server close | **not attributable per connection** | Run ended with 0 sockets up; close codes were not captured by that harness version. |
| Auth rejection | **0** | No auth error; the same minted token served the 2,385 subscriptions that became ready. |
| Client timeout | **5,618** | Harness 30 s subscription deadline expired with no first result. |

The 5,618 are classified by mechanism as **client_timeout**. The stored evidence cannot split the
root cause between a server close and a client-side wait, so no server-close count is claimed for
that run. Server close is strongly indicated by the fleet reaching 0 sockets, but it is not
attributable per connection.

## Instrumented 40 × 200 rerun

| Stage | Local connect | Server close (1006) | Auth rejection | Client timeout | Total |
|---|---:|---:|---:|---:|---:|
| Ramp | 0 | **1,927** | 0 | 0 | 1,927 |
| Subscription | 0 | **167** | 0 | **715** | 882 |
| Receipt | 0 | 0 | 0 | 30 | 30 |
| **All** | **0** | **2,094** | **0** | **745** | **2,839** |

- All 2,094 server closes were code **1006** with no close frame.
- 104 of the 715 subscription client timeouts later received a first result; 611 did not.
- The 1,927 ramp failures are connection-stage failures, not part of the original 5,618
  subscription timeouts.
- Explicit socket error codes: `EMFILE` 0, `EADDRINUSE` 0, `ECONNRESET` 0.
- WebSocket counters: 16,397 attempts, 8,097 opens, 8,314 errors, 8,331 close events
  (1006: 8,314; clean 1005: 17), 7 explicit reconnects.

## Instrumented 2,000-viewer rerun

| Stage | Local connect | Server close (1006) | Auth rejection | Client timeout | Total |
|---|---:|---:|---:|---:|---:|
| Ramp | 0 | **1,970** | 0 | 0 | 1,970 |
| Subscription | 0 | **1** | 0 | 0 | 1 |
| Receipt | 0 | 0 | 0 | 0 | 0 |
| **All** | **0** | **1,971** | **0** | **0** | **1,971** |

1,999 of 2,000 viewers were assigned and ready, and 1,999/1,999 receipts arrived.

## Host telemetry (40 × 200 rerun)

| Fact | Value |
|---|---:|
| OS dynamic port range | 49152–65535 (16,384) |
| Peak established sockets | 8,135 |
| Peak sockets in `TIME_WAIT` | 1,875 |
| Peak ephemeral ports in use | 9,952 / 16,384 (60.7%) |
| Peak `SYN_SENT` | 588 |
| Generator processes | 6 |

The local port range was not exhausted. No second host or cloud VM was available, so the session
ceiling remains **indeterminate**: not the S16 class limit, and not proven local exhaustion.
