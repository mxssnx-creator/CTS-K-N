# Special — BingX Prod-VST 7-day validation

Decision: **REJECTED_NO_WALK_FORWARD_QUALIFIED_CONFIGURATION**. No configuration was auto-applied.

Source: `https://open-api-vst.bingx.com`, read-only 1m swap klines, 2026-08-08T16:23:00.000Z to 2026-08-15T16:22:00.000Z. The 8 most volatile symbols over the preceding hour were selected from the 32 most liquid eligible VST USDT contracts; 48 independent Fixed/Trailing configurations used four purged chronological folds.

## Most volatile one-hour symbols (best first)

| Rank | Symbol | 1h realised vol % | 1h range % | Abs move % | Spread bps | Quote volume |
|---:|---|---:|---:|---:|---:|---:|
| 1 | TUT-USDT | 5.641372 | 7.175738 | 0.352017 | 35.407871 | 15097201 |
| 2 | AIINU-USDT | 3.778304 | 9.134451 | 6.568594 | 13.426915 | 16904593 |
| 3 | ANSEM-USDT | 3.888176 | 7.216072 | 2.378024 | 21.012818 | 22155409 |
| 4 | AKE-USDT | 3.932982 | 5.914711 | 2.904074 | 35.224855 | 15191763 |
| 5 | CAP-USDT | 2.896395 | 4.765484 | 0.826819 | 13.639464 | 53902484 |
| 6 | BTW-USDT | 2.520769 | 3.910998 | 3.011366 | 35.766772 | 25087453 |
| 7 | PRL-USDT | 1.90964 | 6.978022 | 0.192308 | 5.482456 | 30768676 |
| 8 | BOME-USDT | 2.026628 | 2.888044 | 1.616354 | 29.234637 | 12278468 |

No higher-ranked volatility candidate was skipped for incomplete 7-day history.

The 15-second historical endpoint is unavailable and no synthetic 15-second bars were created. Therefore even a profitable candidate remains blocked from automatic activation until genuine 15-second VST history/live replay covers that lane.

## Data coverage

| Symbol | Rows | Coverage | Missing intervals | Pages | Fetch ms |
|---|---:|---:|---:|---:|---:|
| TUT-USDT | 10080 | 100.00% | 0 | 11 | 7609 |
| AIINU-USDT | 10080 | 100.00% | 0 | 11 | 9252 |
| ANSEM-USDT | 10080 | 100.00% | 0 | 11 | 6357 |
| AKE-USDT | 10080 | 100.00% | 0 | 11 | 6855 |
| CAP-USDT | 10080 | 100.00% | 0 | 11 | 7836 |
| BTW-USDT | 10080 | 100.00% | 0 | 11 | 8142 |
| PRL-USDT | 10080 | 100.00% | 0 | 11 | 5824 |
| BOME-USDT | 10080 | 100.00% | 0 | 11 | 7874 |

## Best Fixed variant

Walk-forward qualified: **no**; full-period qualified: **no**.

PIs 194 (Long 117, Short 77); PF 0.928; stable PF 0.212; worst-fold PF 0; max DD 30.924%; net -12.768%.

### Last 24 hours, all symbols combined, two-hour intervals

| UTC interval | PIs | Long | Short | PF | DD max % | DDT max |
|---|---:|---:|---:|---:|---:|---:|
| 2026-08-14T18:00–20:00 | 1 | 1 | 0 | 100 | 0 | 0s |
| 2026-08-14T20:00–22:00 | 1 | 1 | 0 | 100 | 0 | 0s |
| 2026-08-14T22:00–00:00 | 1 | 0 | 1 | 0 | 0.828 | 4800s |
| 2026-08-15T00:00–02:00 | 8 | 6 | 2 | 0.9 | 5.495 | 5700s |
| 2026-08-15T02:00–04:00 | 8 | 3 | 5 | 1.877 | 3.458 | 4260s |
| 2026-08-15T04:00–06:00 | 4 | 3 | 1 | 0.767 | 5.423 | 4320s |
| 2026-08-15T06:00–08:00 | 0 | 0 | 0 | 0 | 0 | 0s |
| 2026-08-15T08:00–10:00 | 3 | 1 | 2 | 0.704 | 4.481 | 1560s |
| 2026-08-15T10:00–12:00 | 6 | 2 | 4 | 0.449 | 10.013 | 1800s |
| 2026-08-15T12:00–14:00 | 0 | 0 | 0 | 0 | 0 | 0s |
| 2026-08-15T14:00–16:00 | 1 | 1 | 0 | 100 | 0 | 0s |
| 2026-08-15T16:00–18:00 | 1 | 1 | 0 | 0 | 0.077 | 5880s |

## Best adaptive Trailing variant

Walk-forward qualified: **no**; full-period qualified: **no**.

PIs 214 (Long 128, Short 86); PF 0.952; stable PF 0.212; worst-fold PF 0; max DD 30.924%; net -8.487%.

### Last 24 hours, all symbols combined, two-hour intervals

| UTC interval | PIs | Long | Short | PF | DD max % | DDT max |
|---|---:|---:|---:|---:|---:|---:|
| 2026-08-14T18:00–20:00 | 1 | 1 | 0 | 100 | 0 | 0s |
| 2026-08-14T20:00–22:00 | 2 | 2 | 0 | 2.393 | 0.607 | 5940s |
| 2026-08-14T22:00–00:00 | 1 | 0 | 1 | 0 | 0.828 | 4800s |
| 2026-08-15T00:00–02:00 | 9 | 7 | 2 | 0.879 | 5.495 | 5700s |
| 2026-08-15T02:00–04:00 | 8 | 3 | 5 | 1.877 | 3.458 | 4260s |
| 2026-08-15T04:00–06:00 | 5 | 4 | 1 | 1.202 | 5.301 | 780s |
| 2026-08-15T06:00–08:00 | 0 | 0 | 0 | 0 | 0 | 0s |
| 2026-08-15T08:00–10:00 | 3 | 1 | 2 | 0.915 | 4.481 | 1560s |
| 2026-08-15T10:00–12:00 | 6 | 2 | 4 | 0.48 | 10.013 | 1800s |
| 2026-08-15T12:00–14:00 | 0 | 0 | 0 | 0 | 0 | 0s |
| 2026-08-15T14:00–16:00 | 1 | 1 | 0 | 100 | 0 | 0s |
| 2026-08-15T16:00–18:00 | 1 | 1 | 0 | 0 | 0.077 | 5880s |

## Lowest-drawdown walk-forward-qualified variant

No result was produced.

## High-activity / low-drawdown diagnostic

No result was produced.

## Performance and limitations

Optimization 1184358ms; peak RSS 153MB; peak heap 35MB.

- Counts are produced from separate Long and Short ledgers; equality is neither forced nor used as a success criterion.
- PF includes the configured round-trip cost assumption; DD is an additive percentage-equity drawdown in this validation model.
- OFI and historical spread are not claimed because synchronized VST history was unavailable from the tested public route.
- 7 days cannot prove future profitability; failed qualification or incomplete coverage blocks activation.

