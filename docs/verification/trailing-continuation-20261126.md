# Trailing and DCA verification, 2026-11-26

The live engine now checks pseudo trailing updates against the position it rereads under its mutation lease. A delayed unarmed tick or invalid trigger cannot clear an armed stop. An exact trailing position accepts updates from its own Set lineage, and automated updates respect an operator override recorded on the position. The recording venue confirms the retained SL and TP percentages and both long and short stop replacements.

The x02 verifier records a second account snapshot before placing orders. If positions or orders change during preflight, it stops before the first write. The final audit uses exact terminal receipts from venue history before making paced individual requests for unresolved IDs. Pending or incomplete receipts fail the history gate. The verifier records owned settlements independently of the strict account and terminal-history gates.

## Market input

The replay used 783,360 complete one-minute public BingX perpetual candles across 32 symbols. Candle SHA-256 is `42c4b2fe91aac82948fe6b909e107d22ec2a4267743f781643bbac7b7b29d6d9`. The 24-symbol set from the preceding study retained its earlier candles. XLM, TRX, HBAR, XMR, ZEC, ICP, BNB and ALGO added complete data. The venue rejected requests for TON, MKR and PEPE, and those series were excluded.

| Period | UTC dates inclusive |
| --- | --- |
| Warm-up | November 9–11 |
| Selection | November 12–18 |
| Validation | November 19–25 |
| New dates since the prior study | November 22–25 |

The first three validation days overlap the earlier study. Choices were frozen on November 12–18 before replaying the later period. Diagnostics from November 22–25 use the same selection. The replay evaluates candle-model trailing exits and uses no native stage promotion or actual fills.

## Trailing and matched fixed brackets

Eight entry plans covered 5, 10, 15 and 30-minute Direction or Inverse lookbacks, targets from 0.5% to 1.8%, and 30 to 360-minute holds. Some plans required 0.30%, 0.45%, or 0.65% prior price movement. Of 8,400 nominal native profiles, 3,990 met the protection bounds. The test also evaluated 416 alternate steps. Each candidate used its own positions and both directions. The base and stress round-trip costs were 0.15% and 0.26%. The replay validates each candle and marks drawdown at one-minute closes.

| Seven-day validation | Positions closed | Net PF | Stress PF | Max marked drawdown | Trailing exits |
| --- | ---: | ---: | ---: | ---: | ---: |
| Expanded fixed | 2,125 | 0.8351 | 0.7257 | 3.17% | 378 |
| Expanded dynamic | 2,121 | 0.8331 | 0.7238 | 3.20% | 377 |
| Previous fixed on the same data | 3,794 | 0.7666 | 0.6390 | 6.34% | 511 |
| Previous dynamic on the same data | 3,773 | 0.7646 | 0.6377 | 6.37% | 309 |
| Matched fixed SL/TP | 2,053 | 0.8417 | 0.7324 | 2.98% | 0 |

The expanded fixed and dynamic selections both used an inverse 30-minute lookback after 0.65% qualifying movement, a 1.8% target, a 2.2% initial stop, a 2.5% trailing gap and a 1.25% ratchet step. On the four new days they scored PF 0.7744 and 0.7726 with 1,097 and 1,096 closes. The matched fixed bracket scored 0.7697 over 1,067 closes. The previous fixed and dynamic profiles scored 0.7507 and 0.7511 respectively over the same four days.

No configuration passed the selection gate. The two narrower diagnostics each picked 23 independent symbol-and-side lanes from the selection week. Over the validation week, fixed scored PF 1.0165 / stress 0.8823 across 776 closes, and dynamic scored PF 1.0198 / stress 0.8851 across 778 closes. On the four new days each group closed 403 positions. Fixed scored PF 0.8424 / stress 0.7283 and dynamic scored PF 0.8451 / stress 0.7305. The wider grid remains opt-in.

The previous 24-symbol experiment reproduced its numerical results exactly. Repeated passes of the new experiment produced identical selection and validation metrics. The pass that marked drawdown for every trailing configuration took 146.1 seconds with 767 MiB peak RSS. The pass that marked only the selected settings used 623 MiB RSS after releasing unused signal arrays.

## DCA

The DCA matrix ran BCH first, then XRP and SOL, over the same dates. It covered 5,184 unique configurations per symbol across 5, 15 and 30-minute candles, four entry rules, one through four adds, three volume ladders, three distance ladders, four TP levels and three final stop multipliers. Costs were 0.15% at base and 0.225% at stress, priced at the filled volume. The result uses a conservative adverse drawdown bound in percentage points of initial order notional.

| Symbol | Training gates passed | Diagnostic training stress PF | Later stress PF | Later stress adverse drawdown |
| --- | ---: | ---: | ---: | ---: |
| BCH | 0 | 2.292 | 0.678 | 18.12 pp |
| XRP | 0 | 1.840 | 0.831 | 19.19 pp |
| SOL | 0 | 1.767 | 0.747 | 19.92 pp |

Diagnostics rank training stress PF among configurations with at least 30 training trades. None met both the profitability and 5 pp drawdown requirements. The study did not change DCA defaults.

## x02 virtual funds

Eight symbols completed eight flat lifecycles in 16 minutes 46 seconds of monitored trading. The run covered four long and four short positions, four Block and four DCA accumulations, and two cycles each on Direct, Main, Preset and Signal paths. All eight exact stop replacements kept the bracket and target intact and rejected stale, invalid, unarmed and unowned updates. Each test symbol finished flat with owned orders cleared, and the account position and open-order baseline matched. Counter and execution-relation audits passed.

The initial per-ID terminal-history audit missed 25 canceled controls. A read-only re-audit with the corrected history logic verified all 64 terminal records using 18 exact lookups. It reconciled all 24 fills by price and quantity, with zero submitted-to-filled quantity differences. Across the eight cycles, gross P&amp;L calculated from the fills differed from the venue readback by at most $0.00009. Observed fees were 0.1000% of aggregate opening notional. Among 120 completed write responses, the median was 473 ms and the 95th percentile was 5,426 ms.

## Source and regression verification

Full TypeScript checking passed. The initial 3,820 Jest tests across 569 suites passed with isolated Redis 7.2.10 and network access limited to loopback. The parallel run completed 567 suites. Two workers were stopped by the host, and both affected suites passed in an isolated serial rerun. The new terminal-history regression passed its focused run. Ten portable Last-N, indication and volume tests also passed. The native Redis coordination verifier passed its batch-command and outcome-window checks with zero exchange orders.

The earlier exact trailing and owned Axis branches are part of this topic's history. The older Axis volume-cache branch at `dd6a3733` is represented by `9ee7b7ec` and its existing regression. PR #573 has a separate PF reading guide and remains open for its own review.

## Reproduction

Use the input and settings from the evidence archive with the locked dependencies. The HTML report provides sortable results for all 19,958 scored configurations.

```sh
node --import tsx scripts/regression/trailing-walkforward.ts \
  bingx-trailing-20261109-17d-32.json \
  42c4b2fe91aac82948fe6b909e107d22ec2a4267743f781643bbac7b7b29d6d9 \
  /tmp/cts-trailing-20261126 --expanded-entry-plans --fresh-from 2026-11-22 \
  --compare-selection previous/selection-configs.json
node --import tsx scripts/research-dca-matrix.ts dca-frozen
```
