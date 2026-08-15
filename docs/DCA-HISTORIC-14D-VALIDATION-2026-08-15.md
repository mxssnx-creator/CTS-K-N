# Historic DCA 14-day validation — 2026-08-15

## Scope and safety model

- Exact UTC range: `2026-07-31T22:36:30.663Z` through
  `2026-08-14T22:36:30.663Z`.
- Symbols: BTCUSDT, SOLUSDT, BCHUSDT and XRPUSDT; Long and Short.
- Complete venue history per symbol: 4,032 × 5m, 1,344 × 15m and
  672 × 30m candles.
- 2,016 configurations across four entry models, three timeframes, seven
  volume ladders, four distance ladders, three TP values and two stop buffers.
- Costs: 0.10% round-trip plus 0.02% adverse slippage per fill.
- Conservative same-candle order: existing SL, existing TP, then at most one
  DCA add. A newly averaged TP cannot close on the same candle as its add.
- Qualification: at least 42 positions, at least four per symbol and eight per
  direction, positive Long and Short PnL separately, full/fold PF gates, every
  full-range symbol non-negative, maximum equity drawdown 6%, maximum single
  loss 6%, and zero losses of 100% or more of initial-position notional.

## Existing default versus risk-selected candidate

| Metric | Existing default | Risk-selected candidate |
| --- | ---: | ---: |
| Timeframe / entry | 15m / Relative | 15m / Relative |
| TP / tested SL | 0.60% / 1.95% | 0.60% / 3.15% |
| DCA distances | 0.30 / 0.60 / 1.00 / 1.60% | 0.55 / 1.10 / 1.80 / 2.80% |
| Add ratios | 1 / 1 / 1 / 1× | 1 / 1 / 1 / 1× |
| Closed positions | 52 | 50 |
| Long / Short | 17 / 35 | 17 / 33 |
| Win rate | 78.85% | 78.00% |
| Aggregate PF | 1.6911 | 1.6903 |
| Simulated net PnL | +19.1235% | +13.1489% |
| Maximum equity drawdown | 7.7619% | 5.6004% |
| Worst closed position | -6.9042% | -5.6004% |
| Total-loss events | 0 | 0 |
| DCA positions | 39 | 32 |

The risk-selected candidate reduced maximum drawdown by 2.1615 percentage
points and improved the worst closed position by 1.3039 points, while giving up
5.9746 points of simulated net PnL. Long PF was 2.6796 and Short PF 1.3889;
all four symbols remained positive over the complete 14-day range.

## Walk-forward result and decision

Two independent seven-day folds were aggregate-positive (PF 1.1278 and
2.6126) and stayed below the 6% drawdown ceiling. A stricter four-fold run over
four independent 3.5-day windows produced **zero** fully qualified candidates
from the same 2,016-config matrix. This is a material stability gap, not a test
failure to hide.

The global production DCA default is therefore not silently replaced from this
short in-sample result. The candidate is retained as measured evidence for a
longer out-of-sample/demo soak. Runtime PF/DDT gates and the 5× hard exposure
ceiling remain authoritative. No profit or no-loss guarantee follows from this
backtest.

The reproducible command is `npm run test:dca:historic:14d`. Full aggregate
machine-readable evidence is generated as
`validation-results/dca-historic-14d-2026-08-15.json`; raw position rows are
intentionally not included in source archives.
