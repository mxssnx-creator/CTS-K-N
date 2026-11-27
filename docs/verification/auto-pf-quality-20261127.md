# CTS-K-N Auto PF and stage quality verification

## Runtime changes

Both signed Last-N paths now require complete net return, PositionCost and drawdown-time values. A missing measurement cannot supply a zero or substitute paper for mature venue evidence. Auto PF calibrates from two groups of 12 closes older than the decision window. A group with gains and zero losses is a complete sample. The weaker group sets the increase, with the existing 0.20 cap. Exact sibling lanes reuse the calibration for the same window length and Auto PF ratio. The existing ratio 4 remains the default.

The final-stage loss gate checks the dispatch intent with the exact Set, side and symbol. A Preset loss cannot remove a Main lane that shares its Set key. Normal, Axis, Block and Trailing historic runs now use the single-entry price path. DCA alone uses the accumulation path.

Signal ranking uses one complete evidence tape per provider in venue, paper, replay order. Only individually attributable settled venue outcomes can reject an established provider or quarantine it on drawdown. Recent provider ranking gives priority to qualified venue evidence before modeled evidence. Hour vetoes use the recorded UTC entry hour. Older records without proven provenance and blended legacy snapshots remain stored for diagnostics. The source optimizer groups outcomes once and reads at most 32 indexed lane lists concurrently.

## 48-hour stage replay

| Phase | Window A, UTC | Window B, UTC |
| --- | --- | --- |
| Prehistory | 13–14 November 2026 | 22–23 November 2026 |
| Trading | 15–16 November 2026 | 24–25 November 2026 |

The two four-day windows use 32 identical BingX perpetual markets. They are nonoverlapping and have appeared in earlier studies. Each window compares eight policies against 104 fixed protection and entry profiles. Entries use completed 5, 15 and 30-minute bars. A simulated fill counts once per selected opportunity within one profile. Different profiles can replay the same candle and trade. Round-trip cost is 0.15% base and 0.26% stress, starting notional is $100, and closed-equity drawdown uses $10,000 starting equity. The runner completed in 38.76 seconds at 335 MiB peak RSS.

| Policy | A entries | A PF | A stress entries | A stress PF | B entries | B PF | B stress entries | B stress PF |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Prior calibration and corrected Auto PF 4 | 5,137 | 0.535 | 2,876 | 0.403 | 2,045 | 0.492 | 814 | 0.379 |
| Auto PF 7 and 10 | 5,137 | 0.535 | 2,876 | 0.403 | 2,044 | 0.492 | 814 | 0.379 |
| Conventional Exec PF floor 1.20 | 4,428 | 0.519 | 2,182 | 0.385 | 1,604 | 0.490 | 545 | 0.413 |
| Conventional Exec PF floor 1.35 | 3,263 | 0.523 | 1,482 | 0.378 | 1,137 | 0.486 | 317 | 0.452 |

These entries sum independently tested cells. Profit factor divides their total gross wins by gross losses. With the same 10/4/1 signed alternatives and PositionCost-relative floors at every stage, the modeled Base, Main, Real and Live physical counts were equal at the default. Separately, the native Redis integration test covers distinct lane identities, qualified ancestry and independent settlement. The 1.20 and 1.35 fixed-floor trials changed only the Live/Exec decision.

The 5-minute mean-reversion profile with TP 1.8% and SL 2.7% produced PF 2.761 over 89 entries and stress PF 2.465 over 55 in November 15–16. Its repeat yielded PF 0.279 over 25 and stress PF 0.000 over six. No stage replay profile produced PF of at least 1.10 in both windows and both cost cases with at least 12 entries per window and 30 per cost across the two windows. See the [prior 14-day comparison](exact-last-n-stage-lineage-20261127.md) for the earlier positive profiles and their later deterioration.

## Catalogue and qualification

The eight-market catalogue uses each compiled Common rule with its default valid parameter tuples, both directions, completed 1, 5, 15 and 30-minute decisions and six fixed protection ranges. It separately exercises the native Direct generator, its Auto summaries, the Historic Test families and the public BingX Signal adapters. Normal, DCA, Axis, both trailing gap bases and Block counts 1–6 use four representative entry models. Special uses its closing-price backtest at one-minute resolution, with fixed and trailing exits. Relate has automated sizing, ledger and settlement checks. It has no independent market PF result in this study.

A repeated loss requires at least 30 closes and net loss in each trading window at both costs. A repeated positive result requires those sample sizes and PF at least 1.10 in all four cells. Of 122,448 Common rule, direction, timeframe and protection cells, 80,371 met the repeat-loss definition and 79 met the repeat-positive definition. The Common and Direct study used 16 bounded market-period jobs with 393 MiB maximum job RSS. These are per-configuration research grades. Independently attributable live outcomes govern automatic entry deactivation. All eight available BingX Signal models lost money in both windows and cost cases. The public audit uses one underlying provider feed and supplied no independently attributable venue evidence for a named removal.

The 79 positive Common cells also went through the signed stage evaluator on the 24 markets excluded from their catalogue selection. None delivered at least 12 Exec closes and PF 1.10 in both periods at both costs. For example, the 5-minute RSI Turn short with period 5, level 20, persistence 2, TP 2.0% and SL 1.2% reached PF 2.113 over 42 entries in the first period and PF 0.137 over 11 entries in the second. No model-backed default was promoted.

The candle simulations cannot quantify partial fills, intrabar path, funding, order latency or portfolio margin. The managed x02 activation path is absent. No authenticated venue test or deployment occurred.

## Reproduction

Use pinned dependencies and the [same candle archive](exact-last-n-stage-lineage-20261127.md#reproduction). Prepare a study JSON with the same UTC fields and market digests, setting `selectionEnd` equal to `warmupEnd` for this two-day comparison.

```sh
node --require ./scripts/test-network-isolation.cjs --import tsx \
  scripts/regression/last-n-stage-market-replay.ts STUDY.json RESULTS.json --sweep --auto-pf-study
node --require ./scripts/test-network-isolation.cjs --import tsx \
  scripts/regression/auto-pf-catalog-replay.ts STUDY.json CATALOGUE.json BTC-USDT,ETH-USDT,SOL-USDT,XRP-USDT,BCH-USDT,ADA-USDT,DOGE-USDT,DOT-USDT
node --require ./scripts/test-network-isolation.cjs --import tsx \
  scripts/regression/auto-pf-catalog-replay.ts STUDY.json SPECIAL.json BTC-USDT,ETH-USDT,SOL-USDT,XRP-USDT,BCH-USDT,ADA-USDT,DOGE-USDT,DOT-USDT --special-only
```

The catalogue can also be split into one market and optional zero-based period index per process. Combine matching catalogue cells by summing counts, gross gains, gross losses and positive/active symbol-hours, and taking maximum per-symbol drawdown.

The starting source is main `822c0959860b08f176945af83f322f2d69e0112e` after [#590](https://github.com/mxssnx-creator/CTS-K-N/pull/590). The separate strict-stage-window branch `f08611d1` informed the stronger final PF runs. The fixed-band DCA research at `f592e0a2`, the protected batch work [#589](https://github.com/mxssnx-creator/CTS-K-N/pull/589) and Relate [#585](https://github.com/mxssnx-creator/CTS-K-N/pull/585) retain their existing topic refs.
