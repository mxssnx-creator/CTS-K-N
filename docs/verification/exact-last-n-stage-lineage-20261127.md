# CTS-K-N independent Last-N stage verification

## Progression

Strategy Settings can activate a distinct Long, Short and Last configuration grid for each stage. CTS-K-N calls the final execution stage Live. The grid supports positive and negative Short and Last conditions, every configured Base Long count, and an optional independent no-Long branch downstream. Existing scalar configurations continue using their stored identity. The coordinator evaluates all configured combinations for each eligible predecessor. Only qualified children join the next stage or qualify for fresh dispatch.

Every new key encodes its preceding lane path, current stage, window sizes, signs and Auto PF ratio. Auto PF reads up to 24 older closes outside its decision window. An initially sparse lane can use measured evidence from its exact predecessor. A sufficiently populated own window or unavailable mature exchange evidence governs that lane. The close ledger records a terminal result once per attributable exact ancestor along its path. Held exposure continues through the existing ownership and protection flow. Venue caps and strategy-family controls still apply at dispatch.

Batches retain up to 250 candidate decisions. The coordinator reads only candidate closed counts and populated outcome rings, shares window calculations across sign alternatives, and retains bounded Real inputs when it can reuse an unchanged cycle. The native Redis progression fixture exercises all four stages with more than 250 eligible final lanes. It checks independent parent keys, exactly-once close attribution, fail-closed evidence and held-only rows.

Local verification passed 3,847 tests across 572 suites using disposable Redis 7.2.10 with external networking blocked. TypeScript, lint on the modified runtime files and the source-syntax check passed. The parallel Jest run reported a worker teardown warning after completing the assertions.

CTS-A [#86](https://github.com/mxssnx-creator/CTS-A/pull/86) and CTS-A-O [#304](https://github.com/mxssnx-creator/CTS-A-O/pull/304) provide reference patterns for expanding every qualified parent through the next stage and consuming previously settled observations. CTS-K-N [#588](https://github.com/mxssnx-creator/CTS-K-N/pull/588) evaluated Long alternatives beside a shared row. This work implements distinct successor rows using CTS-K-N's native settlement attribution and thresholds. The protected Signal batch work in [#589](https://github.com/mxssnx-creator/CTS-K-N/pull/589) and Relate recovery work in [#585](https://github.com/mxssnx-creator/CTS-K-N/pull/585) retain their topic branches. The performance and owned trailing changes from [#584](https://github.com/mxssnx-creator/CTS-K-N/pull/584) are represented by the starting main revision and [#587](https://github.com/mxssnx-creator/CTS-K-N/pull/587).

## Market replay

Each period used 3 warm-up days, 7 development days and 7 later validation days. The 32-symbol BingX perpetual archive contains 783,360 complete one-minute candles from November 9 through 25 UTC. BTCUSDT and ETHUSDT were tested in four separate 17-day periods starting January 2024, June 2024, March 2025 and June 2026. The three frozen confirmation periods started October 2024, June 2025 and May 2026. The replay verifies individual SHA-256 hashes and contiguous OHLCV data. The accompanying HTML includes dates, market hashes and the full scored matrix.

The expanded study tested 104 protection and signal plans on four window grids, or 416 combinations per period. Entry bars use completed 5, 15 or 30-minute aggregates. Brackets use the requested TP and SL and settle stop-first when both are touched inside the bar. The explicit DCA plan allows one 0.4% add of 0.5 times the starting volume. Ordinary plans use a fixed bracket. Round-trip cost is 0.15% base and 0.26% stress, applied to filled exposure. Reported PF is gross winning P&L divided by gross losing P&L after costs. Drawdown uses closed equity and a $10,000 starting account with $100 initial notional per position. The replay counts entries per physical simulated opportunity and tracks DCA adds and lane validations separately. The candle model omits exchange latency, partial fills, order-book slippage and funding.

| BingX later week, November 19–25 UTC | Entries | PF | Stress entries | Stress PF | Closed-equity drawdown |
| --- | ---: | ---: | ---: | ---: | ---: |
| 30m momentum, all-positive, TP 1.8%, SL 1.8% | 65 | 1.059 | 37 | 1.046 | 0.084% |
| 30m momentum, same protection, both signs | 180 | 0.986 | 106 | 0.946 | 0.281% |
| 5m momentum, both signs, TP 1.8%, SL 0.9% | 383 | 0.656 | 189 | 0.522 | 0.803% |

The BingX positive 30m candidate earned 1.427 PF at 165 development entries and 1.127 stress PF at 101 entries. It was the only cell to clear that development gate. The later results missed the PF 1.10 requirement. Two BTC/ETH signed profiles cleared the pooled development gates with at least 30 entries at each cost, positive net P&L and drawdown at most 5%. Their frozen later confirmation results were 0.341 base and 0.366 stress PF for momentum, and 0.426 base and 0.100 stress PF for breakout. Trading defaults require repeatable after-cost results, so the new grid remains operator-selectable.

The 32-symbol study ran in 79.1 seconds at 330 MiB peak process RSS. The four two-symbol periods took 12.0 seconds at 282 MiB. These measurements describe the replay runner. The earlier fixed/dynamic trailing study on the same candle archive recorded 0.835/0.833 PF in the later week. See [the prior audit](strategy-stage-performance-20261126.md) for its entry rules, drawdown basis and native Redis latency benchmarks.

## Remaining acceptance

A new Base configuration needs a measured tape for that exact configuration. The native fixture seeds that tape explicitly. The market replay generates causal shadow outcomes from completed candles. The runtime's existing prehistoric measurement aggregates by indication type and cannot seed every exact Base bracket or variant. Independent realized profitability of Axis, Block, Relate and trailing remains open. The existing lifecycle suites exercise allocation, protection and accounting.

X02 VST preflight is blocked in this workspace by the unavailable managed activation path. Current authenticated order, ownership, fill and reconciliation evidence remains open. The prior eight-cycle x02 result belongs to the revision documented in [the earlier continuation](trailing-continuation-20261126.md).

## Reproduction

Use the locked dependencies. Prepare one JSON array of periods with `name`, `begin`, `warmupEnd`, `selectionEnd`, `end` as UTC millisecond boundaries and `markets` containing `symbol`, `path` and `sha256`. The input CSV starts with millisecond time, open, high, low, close and volume. The BingX source archive is `bingx-trailing-20261109-17d-32.json` with SHA-256 `42c4b2fe91aac82948fe6b909e107d22ec2a4267743f781643bbac7b7b29d6d9`. The BTC/ETH archive is [worldtradingchampion-source/btcdata](https://github.com/worldtradingchampion-source/btcdata/tree/40d6a1052fa6c90be2156f23c6ef91f888f28945).

```sh
node --require ./scripts/test-network-isolation.cjs --import tsx \
  scripts/regression/last-n-stage-market-replay.ts STUDY.json RESULTS.json --sweep
node --require ./scripts/test-network-isolation.cjs --import tsx \
  scripts/regression/last-n-stage-market-replay.ts CONFIRMATION.json RESULTS.json --sweep FROZEN.json
```

The optional frozen input is an array of `{ "plan": "...", "windows": "..." }` rows. The native stage test is `__tests__/unit/independent-stage-last-n.test.ts` and runs with an isolated Redis instance.
