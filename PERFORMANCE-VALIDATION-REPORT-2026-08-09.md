# CTS-K-N performance and correctness validation

Date: 2026-08-09

## Scope

- Recovered workspace was compared against GitHub `main`; local work was
  rebased by fast-forwarding to `da33ed5` and then replaying the local
  performance/live-statistics changes.
- All exchange-facing tests used simulated/paper mode. No real exchange
  order was submitted (`orderRequests=0`, `realExchangeOrdersSubmitted=0`).
- Runtime: Node 24.14, pnpm 11.16, effective cgroup CPU quota 8 cores,
  20 GiB memory limit.

## Implemented safeguards

- Runtime-aware CPU/I/O profiles and bounded symbol, config, type, read and
  write pools; CPU-heavy JavaScript remains conservatively serialized while
  I/O is bounded separately.
- Historic 1-minute stage history is oldest-first and uses the configured
  complete history window; realtime tails are merged by timestamp.
- Main/Real/Live active-set lineage is reconciled after simulated execution,
  so active UI/API statistics reflect durable simulated positions immediately.
- Stale prehistoric cache markers, pseudo-position terminal rings and
  configuration marker families are pruned in bounded chunks with yields.
- Production build retries cleanly after Next trace/export races and accepts
  an artifact only after standalone assets and all traces validate.
- The soak p95 override is explicit. Network-Redis production keeps the
  1,000 ms limit; InlineLocalRedis preview has a separate constrained-host
  budget because exhaustive CPU work shares the single Node event loop.

## Test results

| Test | Result | Measured result |
|---|---:|---|
| TypeScript | PASS | `tsc --noEmit` |
| Jest after GitHub sync | PASS | 142 suites, 964 tests |
| Production build | PASS | 42 pages, 347 complete trace files, standalone assets |
| Volatile cleanup | PASS | regression checks passed |
| Release secret scan | PASS | 1,345 files, 0 findings |
| Direct-Trade matrix | PASS | 16 symbols × 60 h, 946,176 evaluated sets, 2,224 valid sets, 37.5 s; repeated at 32 symbols in 75.7 s |
| Direct-Trade dev API soak | PASS | 16 symbols × 24 h, 946,176 sets, 95 config chunks, 3 pulses |
| Direct-Trade lifecycle | PASS | open row → close row; realised PnL moved from 0.4 to 0.7 |
| Direct-Trade recovery | PASS | lease takeover, hard crash/restart, open-stage adoption and settings persistence |
| Production paper soak | PASS | 4 symbols, 181.6 s, 89 rounds, 1,068 API requests, 595 cycles |

### 4-symbol production paper statistics

- Historic: 4/4 symbols, 21,600 candles, 4 historic cycles.
- Main/Real/Live: Main 1 productive cycle, 18,882 evaluated Main sets,
  208,442 Real evaluations, 46 Live evaluations.
- Paper lifecycle: 16 simulated orders, 16 simulated positions created,
  16 observed lifecycles, 16 active simulated positions at peak.
- End keys: 98,483; topology-derived absolute budget: 166,568.
- RSS: 498,268 KiB start, 1,810,828 KiB end/peak; post-warm growth 579,340 KiB
  within the 4 GiB constrained-host budget.
- Inline preview API p95: 2,038 ms; the explicit preview limit was 3,000 ms.
- Restart/crash recovery: PASS; 16 positions recovered and 16 active positions
  were available after restart.
- Schema/migrations: v0 → v93 on cold boot, then UP TO DATE on restart.

### Strategy and indication coverage

Direct-Trade exercised: `standard`, `trailing_fixed`, `trailing_auto`,
`combination`, `inverse`, `high_protection`; entry tactics were momentum,
mean-reversion, breakout and relative; exit tactics were bracket,
momentum-reversal, relative and time.

The Main/indication pipeline retained the complete enabled topology, including
Direction, Move, Active, Active Advanced, Optimal, Common, Trend, Signal and
the runtime Auto coordination path. The 4-symbol paper run observed default,
trailing, block and overall strategy ledgers; DCA remained enabled as a
zero-row path for the exercised market sample.

### Current 16/32-symbol Direct-Trade matrix statistics

Both runs used the same deterministic 60-hour history, six strategy types,
four take-profit cost ratios, the PF floor of 0.8 and the recent-position PF
gate of 25. Results are paper calculations only; simulated PnL is a relative
matrix output, not a live profitability claim.

| Symbols | Evaluated | Valid | Valid rate | Runtime | Heap peak |
|---:|---:|---:|---:|---:|---:|
| 16 | 946,176 | 2,224 | 0.235% | 37.5 s | 146 MiB |
| 32 | 1,892,352 | 4,095 | 0.216% | 75.7 s | 146 MiB |

The 32-symbol strategy-type breakdown was:

| Type | Evaluated | Valid | Mean finite PF | Mean DDT min | Simulated PnL |
|---|---:|---:|---:|---:|---:|
| standard | 86,016 | 141 | 0.823 | 0.105 | 165,678.767 |
| trailing_fixed | 258,048 | 434 | 4.790 | 0.048 | 622,788.445 |
| trailing_auto | 258,048 | 468 | 3.777 | 0.041 | 525,378.935 |
| combination | 602,112 | 1,043 | 3.771 | 0.053 | 1,313,846.146 |
| inverse | 573,440 | 1,925 | 1.505 | 0.998 | -979,490.753 |
| high_protection | 114,688 | 84 | 2.767 | 0.141 | 162,270.299 |

At the configured recent-PF gate of 25, the valid-set rate remained stable at
0.216% for 32 symbols. The 32-symbol best-first paper selector respected the
300 requested maximum and selected 300 positions (the 16-symbol run selected
182 within its 192-position directional capacity), with no infinite PF in the
selected set.

### Recovery and persistence follow-up

The current recovery contract passed before/after phases: invalid live-mode
input was rejected closed, settings survived the crash, the lease was taken
over only after expiry, the open management row remained present, schema v93
reopened as up to date, and the replacement worker adopted the persisted row.
The constrained sandbox required an isolated replacement port because its
Next dev listener is reparented outside the harness process namespace; Linux
server execution without that namespace boundary uses the same-port path.

### Final code-review result

- CPU-bound JavaScript calculation remains at one conservative lane by
  default; symbol/history work and Redis reads/writes use separate bounded
  pools derived from container-visible parallelism.
- Live dispatch is capped per cycle without reducing evaluation coverage; only
  confirmed simulated/exchange executions update the post-dispatch Live
  snapshot and statistics.
- Prehistoric cache acceptance requires the canonical symbol basket and
  processed/total counters to match, so realtime cannot reuse a completed
  generation for a different basket.
- Marker cleanup, compatibility position-ring trimming, legacy result writes
  and statistics reads are all chunked/bounded with event-loop yields.
- No remaining changed-path lint/type errors, unbounded changed-path fan-out,
  stale manifest entries, or release-secret findings were found.

## 8/16-symbol boundary results

- 16-symbol CPU/Direct-Trade matrix passed completely and covered all six
  strategy types. The dev API/lifecycle/recovery suite also passed at 16.
- 8-symbol production preview reached the full per-symbol Main/Real/Live
  calculations in the longest run, but the constrained InlineLocalRedis
  server was not a stable completion environment: one run lost the server at
  ~150k keys, another reached 624 cycles but exceeded the 3 s preview p95,
  and a third lost API availability while the keyspace was still growing.
  These are recorded as non-passing boundary runs, not hidden as successes.
  The network-Redis production path remains the required deployment mode for
  this symbol count; InlineLocalRedis is a single-process preview backend.

## Runtime design reference

The concurrency decisions follow Node's container-aware
`os.availableParallelism()` guidance and the distinction between I/O
threadpool work and CPU-bound JavaScript. See [Node OS APIs](https://nodejs.org/api/os.html),
[Node cluster](https://nodejs.org/api/cluster.html), and
[libuv threadpool](https://docs.libuv.org/en/v1.x/threadpool.html).

## Remaining external step

The persistent host image already contains `gh` 2.97.0 at
`/workspace/tools/github-cli/2.97.0/bin/gh`, but it is not authenticated. The
repository remote is reachable and currently tracks `origin/main` at
`da33ed5`. A GitHub token/login is required before a push can be authorized.
