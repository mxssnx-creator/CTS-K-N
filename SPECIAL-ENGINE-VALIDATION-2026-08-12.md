# Special Engine — implementation and validation report

Date: 2026-08-12
Exchange environment: BingX Prod-VST demo (`https://open-api-vst.bingx.com`)
Result: **implemented and technically validated; automatic strategy activation rejected**

## Decision

The Special indication/strategy and the general direction pipeline are implemented. The engine now evaluates Long and Short independently but emits exactly one effective direction per indication. Strategy, Set, position, order, fill, PF, volume, progression, and audit records retain that direction; missing or contradictory direction data fails closed.

No tested Special configuration is enabled automatically. The final five-day, four-symbol, cost-adjusted, purged walk-forward run did not achieve a stable positive Profit Factor or the configured drawdown limit. Publishing the code is justified; claiming a profitable configuration is not.

## Implemented contract

- Independent Long and Short evidence lanes; one selected direction per indication and no mirrored opposite row.
- Direction-qualified Set keys and independent Strategy/Real/Live storage, counts, PF, volume, and history.
- Special market-change speed per second, acceleration, activity, volatility, order-flow/depth/spread inputs, persistence, breakout, continuation, reversal, exhaustion, fade, and liquidity-stress scenarios.
- Exact 15s, 1m, 15m, and 30m lanes plus combined coordination. A 15-second series is never fabricated from 1-minute bars.
- Fixed TP/SL and adaptive Trailing are independent exit variants with separate Set keys, ledgers, position plans, and validation results.
- Hard, non-bypassable Special limits: minimum range step 3; at most 5 logical positions per direction; at most 3× Base volume; SL distance at most 3× TP distance; holding duration at most 90 minutes.
- Cost-aware signal floor and TP planning. The default signal movement floor is at least round-trip cost × the configured safety ratio.
- Per-indication Strategy policy in Settings for Direction, Move, Active, Active Advanced, Special, Optimal, Common, Signal, Trend, and Auto. Trailing and Block are enabled by default and independently gate their own processing.
- Causal backtest and four-fold purged chronological walk-forward selection. Failed folds, direction imbalance, per-symbol weakness, excessive drawdown, missing 15-second coverage, or insufficient samples block activation.
- Progression topology now distinguishes theoretical evaluation configurations from actual direction-bound orders and fills.

## Research basis and implementation interpretation

The implementation uses research as design evidence, not as a profitability guarantee:

- BingX API behavior and route contracts follow the [official BingX API documentation](https://bingx-api.github.io/docs/).
- The cost model starts from the published perpetual-futures maker/taker schedule; the validator uses a conservative 0.12% round-trip assumption (0.10% two-sided taker fees plus a 0.02% slippage buffer). See the [BingX perpetual futures fee schedule](https://bingx.com/en/support/articles/360046487573-perpetual-futures-fee-schedule).
- Directional order-flow imbalance is grounded in the documented short-horizon price-impact relationship in [Cont, Kukanov and Stoikov](https://arxiv.org/abs/1011.6402) and the multilevel extension in [The Price Impact of Order Book Events](https://arxiv.org/html/2112.13213v4).
- Volatility scaling and risk throttling are informed by [Volatility Managed Portfolios](https://www.nber.org/papers/w22208).
- Intraday continuation is treated as conditional evidence, based on [Intraday time-series momentum](https://www.sciencedirect.com/science/article/abs/pii/S138641812100001X), rather than as a mandatory direction.
- Fixed and trailing exits remain separate because trailing behavior can materially alter the outcome distribution; see [When Do Trailing Stops Work?](https://arxiv.org/abs/1701.03960).
- Purged chronological folds and a no-auto-activation gate address leakage and selection bias. Related validation discussions: [purged cross-validation](https://arxiv.org/html/2512.12924v1) and [walk-forward validation](https://arxiv.org/html/2603.09219v1).

The exact weights, thresholds, vetoes, and coordinator are engineering inferences derived from these concepts and tested VST behavior; they are not copied claims of an optimal universal strategy.

## Final five-day VST validation

Common causal market window: `2026-08-06T23:54:00Z` through `2026-08-11T23:53:00Z`.

The validator ranked the 32 most liquid eligible VST USDT contracts by one-hour realized volatility, with bounded range/displacement tie contributions, then required at least 95% five-day 1-minute coverage. TOAD-USDT was skipped automatically because it provided only 36.36% coverage.

| Rank | Symbol | 1h realized vol | 1h range | Absolute move | Spread | Quote volume |
|---:|---|---:|---:|---:|---:|---:|
| 1 | CYS-USDT | 10.984% | 19.227% | 8.899% | 36.952 bps | 18,245,588 |
| 2 | JIMOTHY-USDT | 8.543% | 15.364% | 4.729% | 12.018 bps | 17,719,126 |
| 3 | AIINU-USDT | 6.457% | 10.351% | 1.556% | 12.243 bps | 38,234,674 |
| 4 | TUT-USDT | 4.051% | 4.899% | 2.896% | 38.130 bps | 24,119,756 |

### Best results, ranked before rejection

| Exit | Pos | Long/Short | PF | Stable PF | Worst-fold PF | Max DD | Net PnL |
|---|---:|---:|---:|---:|---:|---:|---:|
| Fixed | 273 | 171/102 | 0.8669 | 0.5358 | 0.1207 | 35.7976% | -44.0389% |
| Adaptive Trailing | 282 | 177/105 | 0.8573 | 0.5352 | 0.1982 | 39.0806% | -47.9704% |

The non-equal 171/102 and 177/105 counts demonstrate independent direction processing. They are not a success metric: the Short lane was materially weak (Fixed PF 0.5358; Trailing PF 0.5352), so the coordinator correctly rejected both variants.

## Last 24 hours in common two-hour intervals

Both exit variants use the same aligned UTC window ending `2026-08-12T00:00:00Z`. `Pi` is the combined position/trade count over all four symbols. `DDT(max)` is the longest underwater duration inside the bucket. PF `100` is the validator's finite display sentinel for positive gross profit with zero gross loss in a sparse bucket; it must not be interpreted as robust evidence.

### Fixed

| UTC interval | Pi | Long/Short | PF | DDT(max) | DD(max) |
|---|---:|---:|---:|---:|---:|
| 00:00–02:00 | 3 | 0/3 | 0.000 | 7,140s | 3.187% |
| 02:00–04:00 | 0 | 0/0 | 0.000 | 0s | 0.000% |
| 04:00–06:00 | 5 | 5/0 | 0.087 | 2,100s | 6.075% |
| 06:00–08:00 | 0 | 0/0 | 0.000 | 0s | 0.000% |
| 08:00–10:00 | 4 | 4/0 | 1.126 | 3,420s | 1.918% |
| 10:00–12:00 | 2 | 1/1 | 100.000 | 0s | 0.000% |
| 12:00–14:00 | 5 | 3/2 | 2.558 | 900s | 2.913% |
| 14:00–16:00 | 6 | 1/5 | 0.162 | 6,780s | 11.101% |
| 16:00–18:00 | 10 | 5/5 | 1.227 | 4,440s | 9.705% |
| 18:00–20:00 | 1 | 1/0 | 0.000 | 600s | 1.655% |
| 20:00–22:00 | 2 | 0/2 | 0.746 | 3,720s | 0.374% |
| 22:00–00:00 | 7 | 1/6 | 0.000 | 3,480s | 10.740% |

### Adaptive Trailing

| UTC interval | Pi | Long/Short | PF | DDT(max) | DD(max) |
|---|---:|---:|---:|---:|---:|
| 00:00–02:00 | 3 | 0/3 | 0.000 | 7,140s | 3.187% |
| 02:00–04:00 | 0 | 0/0 | 0.000 | 0s | 0.000% |
| 04:00–06:00 | 5 | 5/0 | 0.087 | 2,100s | 6.075% |
| 06:00–08:00 | 0 | 0/0 | 0.000 | 0s | 0.000% |
| 08:00–10:00 | 4 | 4/0 | 1.126 | 3,420s | 1.918% |
| 10:00–12:00 | 2 | 1/1 | 100.000 | 0s | 0.000% |
| 12:00–14:00 | 5 | 3/2 | 2.669 | 900s | 2.913% |
| 14:00–16:00 | 6 | 1/5 | 0.162 | 6,780s | 11.101% |
| 16:00–18:00 | 10 | 5/5 | 1.227 | 4,440s | 9.705% |
| 18:00–20:00 | 1 | 1/0 | 0.000 | 600s | 1.655% |
| 20:00–22:00 | 3 | 0/3 | 1.482 | 4,500s | 0.618% |
| 22:00–00:00 | 7 | 1/6 | 0.000 | 3,480s | 11.819% |

## Authenticated VST demo-order validation

The final pass used virtual VST funds and the exact Prod-VST host. Initial and final state contained zero positions and zero open orders.

| Symbol | Path | Progression | Direction | Entry + add | Close | Flat |
|---|---|---|---|---:|---:|---|
| BTCUSDT | Direct | DCA | Short | 0.0001 + 0.0001 | 0.0002 | yes |
| ETHUSDT | Main | Block | Long | 0.003 + 0.003 | 0.006 | yes |
| SOLUSDT | Preset | DCA | Long | 0.07 + 0.07 | 0.14 | yes |
| BCHUSDT | Signal | Block | Short | 0.03 + 0.03 | 0.06 | yes |

- 20 unique venue submissions: 8 exposure, 8 protection, and 4 close orders.
- Direction count: 2 Long and 2 Short. Every entry/add/fill counter matched its symbol and direction exactly.
- Counter delta: 8 placed, 8 filled, 0 failed, 4 positions created, 4 accumulated; 47.50219 USD tracked exposure volume.
- Execution-relation audit: pass; no partial fills, duplicate order IDs, missing TP/SL legs, or quantity mismatches.
- Order-history audit: all 20 expected venue IDs found; none missing.
- Cleanup and baseline restoration: pass; zero residual positions/orders.
- Demo balance difference was -0.1338 VST from fees/slippage during the forced smoke lifecycles; this was a validation cost, not strategy PnL.

During the preceding six-cycle run, the audit itself exposed an old implicit-Long expectation. Actual BingX counters were already direction-correct. The audit contract now requires a direction and fails closed; replaying those six cycle deltas produced zero mismatches before the final full pass.

## Performance and verification

- Five-day optimizer: 151.096s total, 94.208s optimization, 121.223 MB peak RSS, 22.260 MB peak heap, 20.188 MB heap after GC.
- Public five-symbol quote stress: 1,000 candle rows and three ticker rounds, zero retries/timeouts, 1.9 MB heap delta.
- TypeScript, ESLint, production Next build, development paper-engine smoke, 163 unit suites / 1,073 tests, 4 integration suites / 52 tests, and E2E passed at the final checkpoint.
- Secret scan inspected 1,388 files with zero findings. Credentials are not present in this report or release archive.

## Limitations

- BingX Prod-VST rejected a historical `15s` kline request. The implementation supports real 15-second inputs, but this five-day report uses native 1-minute history and causal 15m/30m aggregation; automatic activation remains blocked when requested 15-second validation coverage is unavailable.
- Historical synchronized order-book OFI and spread snapshots were unavailable on the tested five-day public route. Those inputs remain active for live observations but are not claimed in this backtest.
- Five days and four volatile demo symbols are a stress sample, not proof of future performance, minimum possible drawdown, or globally optimal parameters.
- PF and additive percentage drawdown in this validator are comparative research metrics. Production capital, leverage, liquidation, latency, funding, and market impact require longer demo-forward validation before any real-funds decision.

## Release recommendation

Merge the direction, safety, Settings, Special engine, validator, and audit corrections. Keep Special automatic execution disabled. Continue demo-forward collection until both directions and every selected symbol pass the configured minimum stable PF, drawdown, fold-loss, sample-count, and genuine timeframe-coverage gates.
