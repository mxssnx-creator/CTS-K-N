# CTS-K-N X02 stability, accounting and performance report

Generated: 2026-08-26T22:07:22Z
Observation: 2026-08-26T20:38:31.448Z–2026-08-26T21:38:31.650Z (60.003 minutes)
Scope: sanitised X02 Prod-VST telemetry plus deterministic local paper/historic tests
Production baseline commit: `f6477985a2c2058b3f9c9991e9f3e125f85f3c9f`
Release-candidate code commit: `5f5f30d004e58afcbf863d6c96c043e81a2cd80b`

## Executive verdict

- The one-hour observer completed 241 samples at 15-second cadence. All 1,446 API requests succeeded and the app, scheduler, Direct worker, Redis and managed Chisel service were reachable in every sample.
- Continuity was nevertheless **not healthy**: the canonical `cron` pipeline retained admission for more than 44 minutes, its progress age reached more than 38 minutes, and successful cycles advanced only from 235 to 236. A later two-sample check confirmed that age increased while progress stayed frozen.
- Root cause: `server-continuity` used a timeout race that returned after 50 seconds without cancelling the losing `generate-indications` task. The detached task retained the canonical admission lock. The recovery supervisor then restarted the app after liveness became unavailable, while the environment wrapper translated the intended SIGTERM into a false service failure.
- The local repair introduces cooperative cancellation and bounded cleanup drain, forwards cancellation through Historic and realtime processing, and treats expected supervisor SIGTERM/SIGINT shutdown as clean.
- Direct Trade was enabled with 32 symbols, all four entry indication types and all seven strategy types, but produced **zero Direct orders, fills or closed positions** during the observation. Main Trade likewise reported zero live trades in the hour. No Direct/Main live PF can therefore be calculated; the correct value is `—`, not 1.00 or 0.
- Existing general X02 exchange history was negative in the most recent 4h and 12h windows but positive over 48h. Those rows were not created by the read-only observer and cannot be attributed to Direct/Main indication types without exact system/run ownership lineage.
- None of the current Direct internal aggregate indication, strategy, TP, SL or block-count groups achieved classic PF 1.0, and none met the requested 1.10 minimum. There is no evidence-based Mainnet candidate in this snapshot.
- The deterministic scale test proves four lanes are the stable optimum at 8–32 symbols. Eight lanes reduced throughput and caused 3,470.44 ms maximum parent event-loop delay at 32 symbols. The runtime default is already capped at four and adapts downward under pressure.

This report does not promise profitability. It intentionally rejects selection for real-money trading where exact live samples, settlement and ownership attribution are missing.

## Measurement and accounting rules

- `classic PF = gross settled profit / absolute gross settled loss`.
- `PF coordinate = 1 + 0.1 × (sum settled net PnL / sum PositionCost)`; 1.00 is neutral and 1.10 means net PnL equals +1× total PositionCost.
- A closed row without exact venue accounting is `accounting pending`. It is visible but excluded from realized PnL, W/L/BE, PF and holding-time/DDT averages.
- Open positions are excluded from realized PnL/PF and are reported separately.
- Stage and pseudo PF values are internal coordination metrics. They are not exchange-realized PF.
- A missing denominator or zero settled sample produces `—`; no PF is invented.

## One-hour continuity

| Metric | Result |
|---|---:|
| Samples | 241 |
| Sampling interval | 15 s |
| API requests / failures | 1,446 / 0 |
| App non-running samples / restarts | 0 / 0 |
| Scheduler non-running samples / restarts | 0 / 0 |
| Direct service non-running samples / systemd restarts | 0 / 0 |
| Chisel non-running samples / restarts | 0 / 0 |
| Redis non-running samples / historical restart counter | 0 / 7 |
| Canonical pipeline in-flight samples | 231 / 241 |
| Maximum pipeline age | 2,637,283 ms |
| Maximum progress age | 2,280,398 ms |
| Maximum budget-exceeded counter | 7 |
| Successful progression cycles | 235 → 236 |
| Failed progression cycles | 4 → 4 |
| Realtime cycles | 9 → 10 |
| Indication / strategy cycle counters | 0 → 0 / 0 → 0 |

The changing Direct child PIDs were bounded worker lifecycles; `systemd NRestarts` remained zero. The actual hang evidence is frozen monotonic progression combined with increasing owner/progress age, not process runtime alone.

## API latency

| Endpoint class | p50 ms | p95 ms | p99 ms | max ms | failures |
|---|---:|---:|---:|---:|---:|
| X02 engine status | 128.847 | 694.956 | 840.285 | 1,014.755 | 0 |
| Direct status | 32.165 | 629.628 | 770.089 | 970.415 | 0 |
| PnL stats | 118.385 | 676.087 | 837.196 | 1,007.937 | 0 |
| Functional overview | 116.433 | 689.623 | 827.649 | 1,018.022 | 0 |
| Main stats v3 | 143.510 | 704.145 | 847.330 | 1,026.323 | 0 |
| System status | 34.645 | 630.756 | 774.892 | 971.187 | 0 |

The APIs remained available, but ~0.63–0.70 s p95 clustering across unrelated routes indicates shared event-loop/Redis pressure rather than one endpoint-specific failure.

## Resource and persistence envelope

| Component | Maximum observed |
|---|---:|
| App RSS | 30,704 KiB |
| Scheduler RSS | 48,272 KiB |
| Direct worker RSS | 48,176 KiB |
| Direct sampled CPU | 1% |
| Redis logical keys | 106,872 → 118,998 |
| Redis used memory | 3,530,054,216 B |
| Redis RSS | 3,366,363,136 B |
| Redis blocked clients | 0 |
| Redis rejected connections | 0 |
| Redis schema | 103 |

Redis grew by 12,126 keys during the hour. It did not block or reject clients, but the growth and multi-gigabyte footprint remain monitoring inputs for longer soak tests.

## Direct Trade live versus internal

Production Direct settings at the end of observation: 32 symbols; Momentum, Mean-Reversion, Breakout and Relative enabled; Standard, Trailing Fixed, Trailing Auto, Combination, Inverse, High Protection and DCA enabled; 960,512 evaluated sets; 1,590 valid; minimum historic and recent PF 1.10; PositionCost 0.15%; TP PositionCost ratios 5 and 10; TP step 5; SL step 0.25.

| Indication type | Enabled | Internal evaluated | Internal valid | Internal aggregate PF | Internal total PnL | Direct live closed | Direct live PF |
|---|:---:|---:|---:|---:|---:|---:|---:|
| Momentum | yes | 240,128 | 498 | 0.577029 | -202,870.5571 | 0 | — |
| Mean-Reversion | yes | 240,128 | 0 | 0.504588 | -1,675.7250 | 0 | — |
| Breakout | yes | 240,128 | 512 | 0.560365 | -154,777.3499 | 0 | — |
| Relative | yes | 240,128 | 580 | 0.572792 | -289,127.3612 | 0 | — |

Direct live totals: zero orders, zero fills, zero open, zero closed and zero accounting-pending rows. A live-to-internal PF ratio is therefore mathematically unavailable.

### Internal strategy groups

| Strategy | Evaluated | Valid | Aggregate PF | Total internal PnL |
|---|---:|---:|---:|---:|
| Standard | 43,008 | 47 | 0.542270 | -32,223.6159 |
| Trailing Fixed | 129,024 | 105 | 0.530866 | -89,384.0698 |
| Trailing Auto | 129,024 | 117 | 0.549560 | -87,520.2040 |
| Combination | 301,056 | 269 | 0.540608 | -209,127.8897 |
| Inverse | 286,720 | 1,012 | 0.619256 | -170,403.9041 |
| High Protection | 57,344 | 28 | 0.576742 | -43,370.6821 |
| DCA | 14,336 | 12 | 0.680396 | -16,420.6276 |

All are below classic PF 1.0. DCA has the least-bad PF but only 12 valid sets and negative aggregate PnL, so it is not qualified.

### TP, SL and block-step groups

| Dimension | Step/ratio | Evaluated | Valid | Aggregate PF | Total internal PnL |
|---|---:|---:|---:|---:|---:|
| TP / PositionCost | 5 | 480,256 | 421 | 0.443417 | -370,433.1550 |
| TP / PositionCost | 10 | 480,256 | 1,169 | 0.671494 | -278,017.8382 |
| SL ratio | 0.25 | 258,048 | 335 | 0.510351 | -154,035.1979 |
| SL ratio | 0.50 | 258,048 | 492 | 0.561157 | -173,549.4799 |
| SL ratio | 0.75 | 315,392 | 404 | 0.580947 | -228,975.4758 |
| SL ratio | 1.00 | 57,344 | 166 | 0.624239 | -37,532.7149 |
| SL ratio | 1.25 | 57,344 | 181 | 0.635672 | -37,937.4971 |
| SL ratio | 1.30 | 7,168 | 9 | 0.747696 | -7,985.4236 |
| SL ratio | 1.50 | 7,168 | 3 | 0.572425 | -8,435.2040 |
| Block count | 3 (requested minimum) | 946,176 | 332 | 0.575807 | -703,812.5332 |

Block counts 1–12 are included in `step-results.csv`. Aggregate PF peaks at block count 7 (0.576039) with only 27 valid rows; counts 8–12 have zero valid rows. Increasing minimum block step to 3 does not make this population profitable.

## Independent 32-symbol × 48-hour paper matrix

The deterministic offline matrix evaluated 960,512 sets in 34.223 s with 160 MiB heap, found 22,467 valid sets (2.339%), made no network/Redis/credential/order access, and preserved identical results across concurrency variants.

| Strategy | Evaluated | Valid | Mean finite per-config PF | Mean DDT min | Total simulated PnL |
|---|---:|---:|---:|---:|---:|
| Standard | 43,008 | 732 | 0.825 | 0.166 | -27,665.507 |
| Trailing Fixed | 129,024 | 2,544 | 7.905 | 0.137 | -18,919.338 |
| Trailing Auto | 129,024 | 2,475 | 6.194 | 0.132 | -17,473.316 |
| Combination | 301,056 | 5,751 | 6.133 | 0.139 | -64,058.160 |
| Inverse | 286,720 | 9,818 | 0.846 | 1.022 | +108,549.117 |
| High Protection | 57,344 | 907 | 4.590 | 0.318 | -44,231.658 |
| DCA | 14,336 | 240 | 0.468 | 1.461 | -90,265.721 |

Total simulated PnL across strategy groups is -154,064.583. High arithmetic mean per-config PF values can coexist with negative aggregate PnL because the mean gives small denominators/configs equal weight. They must not be used as aggregate PF or as a Mainnet ranking. The offline matrix also used PositionCost 0.10%, while the observed production Direct state used 0.15%; it is a deterministic regression/load test, not a like-for-like live comparison.

## Async scale and overload result

| Symbols | Lanes | Wall ms | Sets/s | Max event-loop delay ms | Verdict |
|---:|---:|---:|---:|---:|---|
| 1 | 1 | 1,777 | 16,887 | 10.70 | stable |
| 2 | 2 | 1,963 | 30,580 | 9.41 | best |
| 4 | 4 | 1,830 | 65,618 | 5.25 | best |
| 8 | 4 | 4,122 | 58,259 | 34.09 | best |
| 15 | 4 | 7,643 | 58,910 | 21.76 | stable |
| 16 | 4 | 7,933 | 60,536 | 7.35 | best |
| 16 | 8 | 9,153 | 52,470 | 205.80 | overloaded |
| 32 | 4 | 16,604 | 57,847 | 23.93 | best |
| 32 | 8 | 17,216 | 55,791 | 3,470.44 | reject |

The runtime default cap of four is retained. Explicit eight-lane overrides should not be used on this workload.

## Main Trade and stage overview

- Main status: running, 2 of 3 Main engines; one Live Trade engine running.
- Main last-hour live trades: 0; Main total positions/trades in the endpoint: 0/0.
- Completed Main counters: 28 cycles, 14 indication cycles, 14 strategy cycles, 261 indications and 54,923 strategy evaluations; last cycle duration 2,267 ms.
- Functional overview: 30 active symbols and 242,106 evaluated strategies.
- Internal stage-average PFs: Base 1.8734, Main 1.8849, Real 1.9776, Live 1.9345. These are canonical stage/set coordination aggregates, not realized venue PF.
- Every stage snapshot had zero fresh symbols under the five-minute freshness policy at the observation end, consistent with the stalled canonical owner. The repaired overview semantics label rows as Sets and keep freshness explicit.

## Existing exchange-history context

These are pre-existing general X02 exchange-history aggregates, not trades created by this read-only run and not safely attributable to a Direct/Main indication type.

| Window | Trades | W/L/flat | Net PnL | Classic PF | Volume |
|---|---:|---:|---:|---:|---:|
| 4h | 109 | 0 / 1 / 108 | -0.06 | 0.0000 | 691.36 |
| 12h | 151 | 0 / 4 / 147 | -0.17 | 0.0000 | 912.93 |
| 48h | 406 | 15 / 28 / 363 | +4.92 | 1.7546 | 4,579.90 |

Three-day drawdown history: 763 samples, 2 episodes, maximum duration 66.20 h, average episode duration 35.28 h, current duration 66.20 h, maximum depth 13.4514 and current depth 6.3114. This does not meet the requested approximately 20–60 minute drawdown-time objective.

## Repairs covered by the release candidate

1. Cooperative cron cancellation: timeout aborts Historic/realtime work, drains bounded cleanup, and prevents detached tasks from retaining canonical admission.
2. Clean supervisor lifecycle: expected forwarded SIGTERM/SIGINT no longer creates a false failed service state.
3. Exact live accounting: unresolved closed rows remain pending and cannot contaminate realized PnL, PF, W/L/BE, holding time or DDT.
4. Lifecycle read model: Open→Closed transitions are deduplicated; ISO/numeric timestamps sort consistently; invalid limits are sanitised.
5. Protection observability: SL/TP armed quantities and recoverable pending phases are visible without exposing private mutation tokens.
6. Ownership safety: Direct control state and processor lease are atomic; orphan cleanup and protection management remain system/connection-owned.
7. UI: PnL refreshes every 3 seconds and explicitly shows settled versus accounting-pending rows; absent PF is `—`.
8. Direct Performance Stats: indication type enablement and separate internal/live result columns are preserved.
9. Stage overview: rows represent Sets, with Overall coordinating all sets and Stage Real using its valid set population.

## Verification status at report generation

- Unit: 227/227 suites, 1,481/1,481 tests.
- Integration: 4/4 suites, 61/61 tests.
- TypeScript: 0 errors.
- ESLint: 0 errors.
- Targeted lifecycle/PnL: 23/23 tests.
- Scheduler and recovery contracts: green; no real services touched.
- Kilo preflight: 37/37, schema v103.
- Linux installer preflight: green and mutation-free.
- Secret scan: 1,517 files, zero findings.
- Final production build on the release-candidate commit: 42/42 static pages and 347/347 complete traces, attempt 1, no source change or retry.

## Mainnet qualification decision

**No configuration is qualified for Mainnet from this dataset.** The observation contains no owned Direct/Main live closes, current internal aggregate PF is below 1.0 in every listed group, recent general exchange history is negative over 4h/12h, and drawdown duration is far above target. A future Mainnet candidate requires exact owned X02 fills, complete settlement, sufficient sample count, positive net-after-fees/funding/slippage, PF coordinate at or above 1.10, acceptable classic PF, and sustained low DDT under repeated out-of-sample windows.
