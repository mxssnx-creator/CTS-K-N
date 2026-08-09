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
| Direct-Trade matrix | PASS | 16 symbols × 60 h, 946,176 evaluated sets, 2,224 valid sets, ~44.2 s |
| Direct-Trade dev API soak | PASS | 16 symbols × 24 h, 946,176 sets, 95 config chunks, 2 pulses |
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
