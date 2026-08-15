# Historic DCA 42-day / 18-symbol validation — 2026-08-15

## Scope and decision

- Exact UTC range: `2026-07-04T13:30:00.000Z` through `2026-08-15T13:30:00.000Z`.
- 18 symbols, 42 days, 6 chronological weekly folds.
- 4322 complete short-range configurations screened; 204 diversified finalists re-run over every symbol and fold.
- Conservative costs: 0.1% round trip plus 0.02% adverse slippage per fill.
- Global-profile status: **unqualified**. Symbol-adaptive out-of-sample status: **unqualified**.
- Runtime recommendation: **keep_dca_disabled**. This is measured historical evidence, not a profit guarantee.

## 28-day training / 14-day out-of-sample decision

Profiles were selected independently per symbol using only the first 28 days. The final 14 days were not consulted until selection was frozen. 8 of 18 symbols passed the training-only gates.

| Metric | Out-of-sample result |
| --- | ---: |
| Active / disabled symbols | 8 / 10 |
| Closed positions | 202 |
| Long / Short | 102 / 100 |
| Win rate | 66.83% |
| Profit factor | 0.5135 |
| Equal-weight net PnL | -7.2735% |
| Equal-weight portfolio drawdown | 7.3560% |
| Worst per-symbol equity drawdown | 19.0382% |
| Profitable symbols | 1/8 |
| Positive OOS weeks | 0/2 |
| Worst closed position | -3.8484% |
| DCA positions | 146 (72.28%) |

### Symbol-level frozen-profile validation

| Symbol | Train gate | TF / entry | Last step + buffer | OOS pos. | OOS PnL | OOS PF | OOS DD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| BTCUSDT | strict | 15m / relative | 0.50% + 0.35% | 7 | 1.6049% | 1.5391 | 2.9769% |
| SOLUSDT | strict | 15m / relative | 1.20% + 0.45% | 19 | -7.8513% | 0.3029 | 8.5436% |
| BCHUSDT | disabled | — | — | — | — | — | — |
| XRPUSDT | robust | 15m / breakout | 0.95% + 0.45% | 45 | -9.5381% | 0.6344 | 14.9098% |
| ETHUSDT | strict | 15m / relative | 0.65% + 0.10% | 15 | -4.9319% | 0.5238 | 5.7239% |
| BNBUSDT | disabled | — | — | — | — | — | — |
| DOGEUSDT | robust | 15m / relative | 1.20% + 0.20% | 12 | -1.2447% | 0.7462 | 4.4131% |
| ADAUSDT | disabled | — | — | — | — | — | — |
| AVAXUSDT | robust | 15m / relative | 0.80% + 0.15% | 26 | -14.2774% | 0.2767 | 14.7395% |
| LINKUSDT | disabled | — | — | — | — | — | — |
| DOTUSDT | robust | 15m / relative | 1.20% + 0.35% | 27 | -16.7823% | 0.4345 | 19.0382% |
| ATOMUSDT | disabled | — | — | — | — | — | — |
| LTCUSDT | disabled | — | — | — | — | — | — |
| UNIUSDT | disabled | — | — | — | — | — | — |
| NEARUSDT | robust | 5m / relative | 0.95% + 0.20% | 51 | -5.1676% | 0.6462 | 7.3467% |
| OPUSDT | disabled | — | — | — | — | — | — |
| ARBUSDT | disabled | — | — | — | — | — | — |
| APTUSDT | disabled | — | — | — | — | — | — |

## Best global-profile diagnostic (not enabled)

| Setting | Value |
| --- | ---: |
| Timeframe / entry | 15m / relative |
| TP / original-entry SL | 0.60% / 1.25% |
| Last DCA step / SL buffer | 0.95% / 0.30% |
| DCA distances | 0.2 / 0.4 / 0.65 / 0.95% |
| Add ratios | 0.15 / 0.25 / 0.4 / 0.6× |
| Maximum hold | 720 minutes |

| Metric | Result |
| --- | ---: |
| Closed positions | 1263 |
| Long / Short | 611 / 652 |
| Win rate | 70.63% |
| Net PnL (sum of initial-notional %) | -144.9437% |
| Profit factor | 0.7963 |
| Aggregate drawdown (initial-notional units) | 147.2600% |
| Equal-weight portfolio drawdown | 8.1811% |
| Worst per-symbol equity drawdown | 30.3004% |
| Worst closed position | -2.3599% |
| Profitable / non-negative symbols | 4 / 4 |
| Positive weekly folds | 0 / 6 |
| DCA positions | 959 (75.93%) |
| SL / timeout positions | 335 / 49 |
| Average / p95 drawdown time | 64.1 / 255.0 min |

## Weekly walk-forward folds

| Week | Positions | Net PnL | PF | Max symbol DD | Profitable symbols |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 253 | -46.9470% | 0.6934 | 12.7567% | 4/18 |
| 2 | 225 | -9.0972% | 0.9212 | 8.7251% | 9/18 |
| 3 | 185 | -33.7350% | 0.6920 | 11.5560% | 6/18 |
| 4 | 205 | -8.9285% | 0.9144 | 12.5105% | 6/18 |
| 5 | 191 | -33.2113% | 0.7178 | 9.3345% | 7/18 |
| 6 | 175 | -16.0304% | 0.8362 | 9.8532% | 8/18 |

## Per-symbol result

| Symbol | Positions | Win rate | Net PnL | PF | Max DD | Avg DDT |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| BTCUSDT | 28 | 78.57% | 5.0083% | 1.5794 | 3.0348% | 108.8 min |
| SOLUSDT | 48 | 72.92% | 0.5995% | 1.0251 | 7.2042% | 87.2 min |
| BCHUSDT | 68 | 72.06% | -5.6723% | 0.8414 | 14.2667% | 79.0 min |
| XRPUSDT | 50 | 70.00% | -3.3229% | 0.8692 | 9.3587% | 105.6 min |
| ETHUSDT | 59 | 67.80% | -8.8669% | 0.7291 | 12.6387% | 82.4 min |
| BNBUSDT | 21 | 61.90% | 0.7204% | 1.0970 | 2.3599% | 160.0 min |
| DOGEUSDT | 53 | 79.25% | 2.5777% | 1.1169 | 9.6508% | 60.3 min |
| ADAUSDT | 103 | 72.82% | -7.3753% | 0.8706 | 24.6657% | 41.2 min |
| AVAXUSDT | 70 | 71.43% | -10.1229% | 0.7546 | 12.6220% | 73.7 min |
| LINKUSDT | 65 | 70.77% | -7.5249% | 0.8077 | 10.6264% | 73.4 min |
| DOTUSDT | 82 | 74.39% | -0.0525% | 0.9987 | 11.4654% | 57.8 min |
| ATOMUSDT | 63 | 65.08% | -17.6616% | 0.5924 | 18.9423% | 79.0 min |
| LTCUSDT | 50 | 64.00% | -17.3523% | 0.5182 | 17.9044% | 104.1 min |
| UNIUSDT | 104 | 65.38% | -26.9885% | 0.6043 | 30.3004% | 32.0 min |
| NEARUSDT | 113 | 74.34% | -3.9642% | 0.9334 | 15.7981% | 49.2 min |
| OPUSDT | 103 | 68.93% | -16.2392% | 0.7434 | 17.8861% | 46.6 min |
| ARBUSDT | 99 | 69.70% | -15.1482% | 0.7363 | 21.8944% | 35.0 min |
| APTUSDT | 84 | 70.24% | -13.5580% | 0.7309 | 21.3850% | 64.1 min |

## Last-step stop-buffer comparison

| Buffer | Finalists | Max positions | Best PF | Best net PnL | Best max-symbol DD |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0.10% | 45 | 7062 | 0.7138 | -164.6102% | 25.2278% |
| 0.15% | 38 | 6956 | 0.7123 | -168.3738% | 22.8789% |
| 0.20% | 37 | 6837 | 0.7225 | -162.5352% | 21.2797% |
| 0.30% | 32 | 6631 | 0.7963 | -144.9437% | 30.3004% |
| 0.35% | 28 | 6548 | 0.7338 | -159.9748% | 25.8676% |
| 0.45% | 24 | 6364 | 0.7342 | -162.4542% | 24.5636% |

## Interpretation

The optimizer favors high position coverage and explicitly penalizes per-symbol and portfolio drawdown, long drawdown duration, large single losses, and wider final-step stop buffers. A losing fallback is reported for transparency but is never converted into an enabled recommendation. The complete JSON artifact contains the diversified finalist table, frozen-profile out-of-sample results, buffer comparison, coverage checks, direction/exit/DCA-step distributions, and both legacy comparators.

Production DCA remains subject to runtime PF/DDT gates, the 5× exposure ceiling, venue fills, funding, latency, and live slippage. The backtest never enables real order placement.

