# CTS-K-N validation — Main DCA, Direct Trade Special, and development runtime

Generated: 2026-08-15 (Europe/Vienna)

## Executive decision

| Area | Evidence | Decision |
| --- | --- | --- |
| Main / Direct DCA | 42 days, 18 symbols, 4,322 screened candidates, 204 full finalists, six weekly folds, 28d-train/14d-OOS | **Keep DCA disabled.** No global or adaptive profile met the profitability/stability gates. |
| Main DCA execution | 6 focused suites / 90 tests covering Main live dispatch, sequential steps, exposure cap, hot reload, settings, and Direct calculation | Technical path is green; this does not override the negative economic validation. |
| Direct Trade Special | 7 days, 8 volatility-selected symbols, 80,640 complete 1m rows, 24 base candidates / 48 Fixed+Trailing variants, four purged OOS folds | **No automatic activation.** Zero walk-forward-qualified configurations. |
| Development memory | Controlled 32-symbol pre-fix run, 5,120 MiB soft / 7,168 MiB emergency / 8,192 MiB hard | Raise only the dev soft boundary to 6,400 MiB. Emergency, hard, and absolute limits stay unchanged. |
| Real orders | All soaks/backtests are simulated or public-data-only | **0 real/authenticated order requests.** |

Historical validation is evidence, not a profit guarantee. A losing diagnostic candidate is never converted into an enabled production setting.

## 1. Main and Direct DCA — 42 days / 18 symbols

Exact UTC window: `2026-07-04T13:30:00.000Z` through `2026-08-15T13:30:00.000Z`.

- Symbols: BTC, SOL, BCH, XRP, ETH, BNB, DOGE, ADA, AVAX, LINK, DOT, ATOM, LTC, UNI, NEAR, OP, ARB, APT.
- Complete 5m and 15m coverage: 36/36 symbol/timeframe histories at at least 98% coverage.
- Costs: 0.10% round trip plus 0.02% adverse slippage per fill.
- Search: 4,322 short-last-step candidates; 204 diversified finalists re-run on all symbols and all six weekly folds.
- Validation: per-symbol selection was frozen after 28 training days; the last 14 days were untouched OOS data.
- Qualification: 0 strict, 0 robust global candidates; adaptive basket also unqualified.

### Best high-activity / lower-risk global diagnostic (not enabled)

| Parameter | Value |
| --- | ---: |
| Timeframe / entry | 15m / relative |
| Take profit | 0.60% |
| Original-entry stop | 1.25% |
| DCA distances | 0.20 / 0.40 / 0.65 / 0.95% |
| Added initial-volume ratios | 0.15 / 0.25 / 0.40 / 0.60× |
| Last-step SL buffer | 0.30% |
| Maximum total exposure | 2.40× |
| Maximum hold | 720 min |

| Metric | Result |
| --- | ---: |
| Closed positions | 1,263 |
| Long / Short | 611 / 652 |
| Wins / losses | 892 / 371 |
| Win rate | 70.6255% |
| Profit factor | 0.7963 |
| Equal-weight net PnL | -8.0524% |
| Equal-weight portfolio DD | 8.1811% |
| Worst per-symbol DD | 30.3004% |
| Worst closed trade | -2.3599% |
| Average / p95 hold | 177.8 / 645 min |
| Average / p95 drawdown time | 64.1 / 255 min |
| DCA positions | 959 (75.93%) |
| DCA step distribution 0/1/2/3/4 | 304 / 266 / 256 / 209 / 228 |
| TP / SL / timeout | 879 / 335 / 49 |
| Profitable / non-negative symbols | 4 / 4 of 18 |
| Positive weekly folds | 0 / 6 |

### Weekly stability

| Fold | Positions | Net PnL | PF | Worst symbol DD | Profitable symbols |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 253 | -46.9470% | 0.6934 | 12.7567% | 4/18 |
| 2 | 225 | -9.0972% | 0.9212 | 8.7251% | 9/18 |
| 3 | 185 | -33.7350% | 0.6920 | 11.5560% | 6/18 |
| 4 | 205 | -8.9285% | 0.9144 | 12.5105% | 6/18 |
| 5 | 191 | -33.2113% | 0.7178 | 9.3345% | 7/18 |
| 6 | 175 | -16.0304% | 0.8362 | 9.8532% | 8/18 |

### Per-symbol diagnostic

| Symbol | Positions | Win rate | Net PnL | PF | Max DD |
| --- | ---: | ---: | ---: | ---: | ---: |
| BTCUSDT | 28 | 78.57% | 5.0083% | 1.5794 | 3.0348% |
| SOLUSDT | 48 | 72.92% | 0.5995% | 1.0251 | 7.2042% |
| BCHUSDT | 68 | 72.06% | -5.6723% | 0.8414 | 14.2667% |
| XRPUSDT | 50 | 70.00% | -3.3229% | 0.8692 | 9.3587% |
| ETHUSDT | 59 | 67.80% | -8.8669% | 0.7291 | 12.6387% |
| BNBUSDT | 21 | 61.90% | 0.7204% | 1.0970 | 2.3599% |
| DOGEUSDT | 53 | 79.25% | 2.5777% | 1.1169 | 9.6508% |
| ADAUSDT | 103 | 72.82% | -7.3753% | 0.8706 | 24.6657% |
| AVAXUSDT | 70 | 71.43% | -10.1229% | 0.7546 | 12.6220% |
| LINKUSDT | 65 | 70.77% | -7.5249% | 0.8077 | 10.6264% |
| DOTUSDT | 82 | 74.39% | -0.0525% | 0.9987 | 11.4654% |
| ATOMUSDT | 63 | 65.08% | -17.6616% | 0.5924 | 18.9423% |
| LTCUSDT | 50 | 64.00% | -17.3523% | 0.5182 | 17.9044% |
| UNIUSDT | 104 | 65.38% | -26.9885% | 0.6043 | 30.3004% |
| NEARUSDT | 113 | 74.34% | -3.9642% | 0.9334 | 15.7981% |
| OPUSDT | 103 | 68.93% | -16.2392% | 0.7434 | 17.8861% |
| ARBUSDT | 99 | 69.70% | -15.1482% | 0.7363 | 21.8944% |
| APTUSDT | 84 | 70.24% | -13.5580% | 0.7309 | 21.3850% |

### Last-step buffer comparison

| Buffer | Validated finalists | Maximum positions | Best PF | Best raw net PnL | Best candidate's worst-symbol DD |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0.10% | 45 | 7,062 | 0.7138 | -164.6102% | 25.2278% |
| 0.15% | 38 | 6,956 | 0.7123 | -168.3738% | 22.8789% |
| 0.20% | 37 | 6,837 | 0.7225 | -162.5352% | 21.2797% |
| 0.30% | 32 | 6,631 | 0.7963 | -144.9437% | 30.3004% |
| 0.35% | 28 | 6,548 | 0.7338 | -159.9748% | 25.8676% |
| 0.45% | 24 | 6,364 | 0.7342 | -162.4542% | 24.5636% |

Shorter buffers increased activity but did not produce a profitable robust basket. The 0.30% diagnostic had the best PF, but it still lost money in every weekly fold.

### Frozen 28d-train / 14d-OOS adaptive basket

| Metric | Result |
| --- | ---: |
| Training-selected active symbols | 8/18 |
| OOS positions | 202 |
| Long / Short | 102 / 100 |
| Win rate | 66.8317% |
| PF | 0.5135 |
| Equal-weight OOS PnL | -7.2735% |
| Equal-weight OOS DD | 7.3560% |
| Worst symbol DD | 19.0382% |
| Profitable symbols | 1/8 |
| Positive OOS weeks | 0/2 |

Only BTC remained positive OOS (7 positions, +1.6049%, PF 1.5391, DD 2.9769%); seven trades are insufficient for activation.

## 2. Main DCA technical execution validation

Focused validation passed 6/6 suites and 90/90 tests:

- Main Real→Live dispatch retains independent Standard, Block, and DCA lineage.
- DCA steps 1–4 have stable idempotent Set identities and execute sequentially.
- The immutable initial fill anchors requested quantities and weighted average entry.
- The hard total-position ceiling remains 5×, including the initial 1× fill.
- Unready or failed DCA steps do not cancel existing protection.
- Settings saved during runtime apply to the next independent DCA step.
- Main/Direct settings, UI serialization, preset defaults, and hot reload use the same normalized profile.
- DCA remains disabled by source/preset defaults; no losing historical candidate was applied.

## 3. Direct Trade Special — 7 days / 8 symbols

Exact UTC window: `2026-08-08T16:23:00.000Z` through `2026-08-15T16:22:00.000Z`.

- Read-only BingX Prod-VST public 1m klines.
- 8 volatility-ranked symbols from the 32 most liquid eligible VST contracts.
- 10,080/10,080 rows per symbol, 80,640 total rows, zero missing intervals.
- 24 base settings × Fixed/Trailing = 48 independent configurations.
- Four chronological folds with purge gaps; no look-ahead.
- Risk envelopes: max volume 1.5×/2×/2.5×/3×; 3/4/5/5 positions per direction; SL:TP caps 1.25/1.75/2.25/3; DD qualification caps 6/8/10/12%.
- Cost model: 0.10% position cost plus 0.12% round-trip execution assumption.
- Orders/authenticated requests: 0/0.

### Decision and best candidates

| Candidate | Trades L/S | PF | Stable PF | Net PnL | Max DD | Worst-fold PF | WF qualified |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Best Trailing (rank 1) | 214 (128/86) | 0.9525 | 0.2123 | -8.4869% | 30.9240% | 0 | No |
| Best Fixed (rank 2) | 194 (117/77) | 0.9282 | 0.2123 | -12.7679% | 30.9240% | 0 | No |
| Lowest full-period DD (rank 11) | 385 (240/145) | 0.8866 | 0.4748 | -31.5448% | 30.2015% | 0 | No |
| Highest activity | 4,249 (2,091/2,158) | 0.7921 | 0.4055 | -728.2815% | 367.3293% | 0 | No |

Even the lowest-DD candidate exceeded the strictest 6% gate by five times and lost money. Increasing activity magnified drawdown and losses. No Special candidate is safe to apply.

### Best Trailing settings (diagnostic only)

| Parameter | Value |
| --- | ---: |
| Calculation step range | 9–30, step 3 |
| Minimum agreement / score | 0.74 / 1.60 |
| Minimum market move / activity | 0.30% / 1.05× |
| Combined timeframes / higher-TF alignment | Yes / Yes |
| Target / maximum hold | 600 / 3,600 seconds |
| Positions per direction | 3 |
| Maximum volume | 1.5× |
| SL:TP cap | 1.25× |
| Take-profit minimum cost ratio | 5× |
| Exit | Adaptive trailing |

### Best Trailing per-symbol result

| Symbol | Trades | Wins / losses | PF | Net PnL | Max DD |
| --- | ---: | ---: | ---: | ---: | ---: |
| TUT-USDT | 49 | 30 / 19 | 1.4650 | 16.3654% | 12.8160% |
| AIINU-USDT | 19 | 11 / 8 | 2.5222 | 19.1316% | 5.1389% |
| ANSEM-USDT | 10 | 6 / 4 | 2.0210 | 4.1350% | 2.6364% |
| AKE-USDT | 22 | 10 / 12 | 0.7949 | -3.3101% | 8.5802% |
| CAP-USDT | 17 | 2 / 15 | 0.2123 | -24.3599% | 30.9240% |
| BTW-USDT | 37 | 12 / 25 | 0.5207 | -19.8669% | 29.7692% |
| PRL-USDT | 18 | 10 / 8 | 1.1656 | 2.1719% | 5.1091% |
| BOME-USDT | 42 | 19 / 23 | 0.8906 | -2.7539% | 7.7522% |

### Best Trailing walk-forward folds

| Fold | Trades L/S | PF | Stable PF | Net PnL | Max DD | Qualified |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 62 (55/7) | 1.5731 | 0 | 26.6670% | 13.2920% | No |
| 2 | 27 (10/17) | 0.3247 | 0 | -13.4827% | 4.7883% | No |
| 3 | 51 (23/28) | 0.9921 | 0 | -0.2655% | 11.4327% | No |
| 4 | 55 (30/25) | 0.7463 | 0 | -15.6182% | 12.8160% | No |

The stable PF is zero in every fold because at least one required symbol/direction cell had no profitable evidence. The candidate is therefore catastrophically vetoed despite a positive first fold.

### Source limitations

- BingX VST rejects historical 15-second klines. No synthetic 15s bars were fabricated.
- Historical synchronized order-flow imbalance and spread were unavailable for the full window and are not claimed.
- Missing 15s coverage independently blocks automatic activation, even if a future 1m-derived result becomes profitable.

## 4. Development runtime diagnosis and correction

### Correction to the earlier chat diagnosis

The earlier statement that the current dev soft limit was 4 GiB was stale. The controlled pre-fix run actually used:

| Boundary | Pre-fix | New default |
| --- | ---: | ---: |
| RSS soft | 5,120 MiB | **6,400 MiB** |
| RSS emergency | 7,168 MiB | 7,168 MiB |
| RSS hard | 8,192 MiB | 8,192 MiB |
| Absolute process memory | 10,240 MiB | 10,240 MiB |
| V8 heap limit | 12,288 MiB | 12,288 MiB |

The process plateaued around 5.1–6.0 GiB RSS. Because runtime pressure labels RSS at 95% of the soft boundary as critical, a 6,144 MiB soft limit would still mark a 6.0 GiB transient as critical. The selected 6,400 MiB boundary places the observed peak just below that pressure threshold without weakening emergency/hard crash protection.

### Controlled pre-fix 32-symbol result

| Metric | Observed |
| --- | ---: |
| Historic completion | 32/32 symbols |
| Main cycles | 18 |
| Realtime cycles | 1,509+ |
| Signal indications | 622 |
| Signal paper positions / trailing | 34 / 17 |
| RSS range / observed peak | about 5.0–6.0 GiB / 6.02 GiB |
| Strategy memory throttles | 18 |
| Strategy elevated GCs | 2 |
| Strategy GC wait | 4,353 ms |
| Event-loop utilization | about 96% |
| Event-loop delay p95 / max | about 181.5 / 8,074 ms |
| Steady API p95 | 4,456 ms (gate: ≤3,000 ms) |
| Slow route p95 range | 4,544–4,817 ms |
| Real orders | 0 |

The run was functionally productive but correctly failed the API latency gate. The acceptance limit was not increased.

### Applied correction

- Dev RSS soft boundary: 5,120 → 6,400 MiB.
- Emergency/hard/absolute limits unchanged.
- Full 32-symbol dev acceptance default: 20 minutes plus up to 10 minutes productive completion grace.
- Independent dashboard fallback timers now use each request's actual completion time. The initial mount fan-out remains; later timers no longer re-converge artificially on one verifier timestamp.
- Elevated and maintenance GC cooldown remains 10 minutes; urgent pressure collection remains immediate.
- Persistent helper: `/workspace/CTS-K-N-runtime/run-dev-soak-32.sh`, default empty Redis DB 12, fail-closed if the DB is not empty.

### Post-fix acceptance status

The post-fix 20-minute execution was requested but the Work-mode execution service rejected the long-running command because the session had reached its Codex usage limit. The service reported that long execution would be available again on 2026-08-20. The command was not bypassed or retried through an indirect path.

Therefore the post-fix full soak is **pending platform capacity**, not passed. Static checks and the complete Jest contract below validate the code changes, but they do not substitute for the missing runtime before/after measurement.

## 5. Validation gates completed after the changes

| Gate | Result |
| --- | --- |
| Main DCA focused suites | 6/6 suites, 90/90 tests passed |
| Changed-path regression suites | 3/3 suites, 200/200 tests passed |
| Complete canonical Jest contract | 181/181 suites, 1,216/1,216 tests passed |
| TypeScript | Passed (`tsc --noEmit`) |
| ESLint | Passed, zero errors |
| Deployment source syntax | Passed |
| Recreation manifests | Passed; 1,416 project files, 295 routes / 379 methods, 47 UI pages, 398 environment variables, 98 Redis migrations, 212 tests/verifiers |
| Credential scan | 1,424 files scanned, zero findings |
| Real/authenticated order requests | 0 |

Git tree, GitHub, checksum, and Drive identities are recorded in the final handoff after the commit is created.

## Artifact checksums

| Artifact | SHA-256 |
| --- | --- |
| Full DCA JSON runtime evidence | `785cd2e6cb6cc57fd94c285552c11ab932038f7eb7f7e3dbb7e8abc0d38d5dfe` |
| Tracked DCA Markdown report | `15c4021c30211a0e952310ec9e33fe18e3f5ac320db807bbb32e858942ec4b12` |

Related tracked detail reports:

- `docs/DCA-HISTORIC-42D-18S-VALIDATION-2026-08-15.md`
- `docs/SPECIAL-VST-7D-8S-VALIDATION-2026-08-15.md`
