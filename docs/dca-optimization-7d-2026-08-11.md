# DCA 7-day optimization — 2026-08-11

## Scope

- Exact UTC range: `2026-08-04T04:32:39.738Z` through `2026-08-11T04:32:39.738Z`
- Forced symbols: `BTCUSDT`, `SOLUSDT`, `BCHUSDT`, `XRPUSDT`
- Complete venue candles: 2,016 × 5m, 672 × 15m and 336 × 30m for every symbol
- Candidate matrix: 1,152 complete configurations
- Entry models: momentum, mean reversion, breakout and relative
- DCA distance ladders: minimal through medium adverse ranges
- Volume ladders: every candidate was normalized to a total position cap of 5× (500%), including the initial fill
- Cost model: 0.10% round-trip cost plus 0.02% adverse slippage per fill
- Conservative OHLC ordering: original-entry stop, then already-active TP, then at most one new DCA leg; a new average-entry TP cannot win on the same candle

The reproducible implementation is `scripts/optimize-dca-7d.ts`; the pure simulator and its tests are in `lib/dca-backtest.ts` and `__tests__/unit/dca-backtest.test.ts`.

## Selected default

| Setting | Selected value |
| --- | ---: |
| Primary entry | Relative |
| Primary timeframe | 15m |
| Enabled default timeframes | 5m, 15m, 30m |
| Take profit | 0.60% (6 × default 0.10% PositionCost) |
| DCA step distances | 0.30%, 0.60%, 1.00%, 1.60% |
| DCA step additions | 1×, 1×, 1×, 1× initial quantity |
| Maximum total position | 5× initial quantity |
| TP reference | Weighted average entry |
| Step cooldown | 30 seconds |
| Tested protective stop | 1.95% from original entry |

## Selected result

| Metric | Result |
| --- | ---: |
| Closed positions | 27 |
| Wins | 24 |
| Win rate | 88.89% |
| Aggregate net PnL | +26.4779% of initial-position notional |
| Aggregate PF | 17.6422 |
| Worst per-symbol net PnL | +2.8813% |
| Maximum per-symbol equity drawdown | 1.2007% |
| Average drawdown time | 136.67 minutes |

Per-symbol results were positive: BTC +2.8813%, SOL +5.2589%, BCH +9.5679%, XRP +8.7699%. The maximum realized volume ratio in the simulation was 5× and never exceeded the hard system cap.

This is a short-horizon robustness selection, not a profit guarantee. Runtime PF/DDT gates remain authoritative and can deactivate an exact configuration when fresh realized results deteriorate.
