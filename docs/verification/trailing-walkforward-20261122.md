# CTS-K-N trailing verification, 2026-11-22

The exact trailing profile keeps its initial stop, trailing gap, basis, and ratchet step through Base and Live admission. Profiles that cannot be executed at their configured distances under the existing protection floors or SL/TP ratio are excluded. The first venue ratchet must tighten the existing protection. A subsequent exact trailing sync changes the absolute stop while preserving the admitted bracket percentages.

The historic replays use the same price-gap and ratchet calculation. An opening gap through a stop settles at the opening price. After the open, an ambiguous candle that crosses both the standing stop and target settles at the stop. A new ratchet takes effect on the following candle. The historic family reads a bounded candle range and honors its requested hold time.

## Market replay

24 BingX USDT perpetual contracts, 24,480 complete one-minute candles per symbol, and 587,520 candles total. The candle input SHA-256 is `1bfa98d3e92416c613f5c3f4128bc7545857b865c9593bb625b0ceb482487f03`.

| Period | UTC interval, end excluded |
| --- | --- |
| Prehistory | 2026-11-05 to 2026-11-08 |
| Configuration selection | 2026-11-08 to 2026-11-15 |
| Later validation | 2026-11-15 to 2026-11-22 |

The 5, 15 and 30 minute indication lookbacks had 0.5%, 1.0% and 1.5% targets with 30, 120 and 240 minute holds, respectively. The test evaluated 1,218 native profiles that cleared the configured 0.6% protection floors and 1.5× SL/TP limit, and 128 additional step variants. The other 1,932 native combinations were ineligible at those targets and floors. The entry model was the direction change indication with one position per symbol and side per candidate. Round-trip cost was 0.15%, with 0.26% as a separate stress case. Drawdown included open positions marked at one-minute closes. The later week never chose a configuration.

| Later result | Closed positions | Net PF | Stress PF | Max marked drawdown | Trailing exits |
| --- | ---: | ---: | ---: | ---: | ---: |
| Fixed | 2,838 | 0.7878 | 0.6564 | 4.88% | 344 |
| Dynamic | 2,827 | 0.7839 | 0.6535 | 4.96% | 201 |
| Matching fixed SL/TP control | 2,811 | 0.7813 | 0.6515 | 4.98% | 0 |

Both diagnostic selections used a 1.8% initial stop and 1.5% target. Fixed used a 2.2% entry-based trail and a 1.1% ratchet step. Dynamic used a 2.3% peak-based trail and a 1.15% step. None of the 1,346 candidates passed selection. A secondary check chose eight fixed and ten dynamic symbol/direction lanes from the selection week. On the same later week they scored PF 0.7992/0.8161, stress PF 0.6624/0.6779, with 440/550 settles. The exact grid remains disabled by default. The replay measures trailing exits, with no venue fills or native stage promotion.

The older 22-symbol portfolio from the committed September fixture reproduced R-normalized PF 1.1837, 14,539 modeled closes, and 10.84% drawdown. That portfolio used different admission, sizing and PF accounting. The corrected 12-symbol exact trailing replay on the original fixture gave fixed PF 0.8911 and dynamic PF 0.9056. The November replay completed in 48.4 seconds at 434 MiB peak RSS. The repeat using the repository's pinned packages reproduced every numerical result and completed in 47.7 seconds.

The 14 focused Jest suites passed all 285 checks across isolated runs, including exact bracket admission, first and stale ratchets, Axis, Block, DCA, Relate, and the 70-symbol simulated order burst. The five portable Last-N and volume checks also passed. TypeScript passed for the trailing price and replay modules. The full repository TypeScript check exceeded local memory.

## Reproduce

Use the frozen 17-day candle JSON from the evidence archive or generate a new source file with the public candle fetcher. The replay checks each timestamp, OHLC and volume entry and the supplied SHA-256 before it runs.

```sh
node --import tsx scripts/regression/trailing-walkforward.ts \
  bingx-trailing-20261105-17d.json \
  1bfa98d3e92416c613f5c3f4128bc7545857b865c9593bb625b0ceb482487f03 \
  /tmp/cts-trailing-november
```

## Demo acceptance

An initial X02 read received exchange code `109400`. The canonical authenticated preflight passed on retry. The virtual funds run completed one cycle on each of four symbols, with four entries, four accumulations, and four closes. All four cycles verified the stop and security order replacements, retained the target through the ratchet, rejected stale updates, and finished flat. The runner confirmed the test's own orders and positions were reconciled.

The full shared account baseline differed at the end, so the overall soak failed that gate. A separate read-only check audited every one of the 12 market order settlements and matched the fill prices and quantities. The recorded execution relationships also passed an independent audit. The run took 12 minutes 16 seconds including preflight and cleanup. Among 60 completed venue write responses, the median was 735 ms and the 95th percentile was 6,023 ms. These are demo lifecycle measurements. The soak does not measure the profitability of the historical strategy settings.
