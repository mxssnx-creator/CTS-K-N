# Block / CTS-G / DCA verification — 2026-09-05

## Historical result: no new production defaults

6,048 profiles were evaluated for XRP, BCH and SOL: 5/15/30-minute candles,
seven entry families (including CTS-G Trend, Break and combined Trend/Break),
four volume ladders, four distance ladders, three TP values, two SL offsets
and three exit modes. Complete public BingX candles cover 2026-08-16 00:00 UTC
through 2026-09-05 00:00 UTC, plus two warm-up days. The first 14 days train;
the remaining six days validate training-only selections. The additional
last-20-hour per-symbol selection overlaps those six days and is explicitly
NOT independent validation. Dynamic candidates need untouched forward data.

All numbers below are fixed initial, unleveraged-notional percentage points,
not account returns. Costs: 0.10% round-trip fees plus 0.02% slippage per fill;
funding is not included. Drawdown includes adverse open marks. Intrabar stops
take priority over TP and DCA; an adjusted TP becomes effective next bar.

| Rolling-selected symbol profile | 14d net | 14d maximum DD | Last 20h net | 20h trades | 6d net (selection overlap) | Viable profiles |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| XRP (unqualified fallback only) | -17.9062 | 20.9687 | +0.1948 | 3 | -4.0436 | 0 |
| BCH | +5.3793 | 3.4446 | +0.7443 | 2 | +3.4044 | 56 |
| SOL | +17.5504 | 9.0921 | +0.4001 | 2 | +2.3028 | 101 |

The training-only common winner is 30m Relative, volume additions
`[0.25, 0.4, 0.55, 0.8]`, trigger distances `[0.55, 1.1, 1.8, 2.8]%`,
maximum total ratio 3, TP 0.4%, SL 3.4%. Its unseen six-day PF is only 1.0481
and net +0.4814 across 35 trades, with negative XRP and SOL results. It fails
the qualification gate. No CTS-G-entry profile passed the common training
gate. The nearest average of the symbol winners also fails (14d net -10.8842;
six-day net -0.0151). Averaging good-looking short windows is not evidence of
a robust profitable default. Candidate settings are saved with `active=false`.

Full continuous 20-day replays are also recorded. Their totals need not equal
the sum of separately restarted train/validation windows because open trades
and DCA ladders can cross a split in the continuous replay.

See [complete metrics](dca-20d-20260905.json) and
[inactive candidate defaults](dca-candidate-defaults-20260905.json).

## Functional verification

- Block counts 1–6 have independent result/recovery/pause state. Additive
  target: `base + base * count * ratio * step`, with levels 1–2; confirmed
  Block adds are subtracted once and DCA retains a separate lane budget.
- A count advances after its own count-sized nonpositive window and remains
  increased until its own positive settled result. Recovery cannot bypass
  drawdown, exposure, margin-call, pause or control-order barriers.
- Actual leg entry/close prices and allocated fees determine the count result;
  duplicate closes are idempotent and partial/unsettled fills do not advance it.
- Schema 108 upgrades old settings while preserving smaller custom values,
  TTLs, live position snapshots and control/recovery identifiers.
- Native Redis test passed on an isolated local-only server: two clients,
  11 duplicated outcomes, independent Count 1 / Count 6, durable pause,
  repeated settings migration and preserved owned positions. Production Redis
  was not mutated by this test; the isolated instance was shut down afterward.
- CTS-G Trend/Break use complete UTC-aligned 1/5/15/30-minute bars, bounded
  compact history and gap-sensitive warm-up. No partial future bar is used.
- New CTS-G engine positions share cost-aware lock/peak exits between venue
  protection and system-close fallback; stops never loosen after recovery or
  DCA. Operator-controlled and legacy positions are not silently opted in.
- Direct Trade reconciles pending DCA controls even after signal expiry;
  new Trend/Break DCA exposure requires a current matching signal pulse.

Local functional gates at this checkpoint: 284 suites / 1,951 tests passed;
TypeScript, ESLint, secret scan and production build (349 complete traces)
passed. GitHub CI, deployment,
and authenticated X02 VST/UI acceptance must be recorded separately before
claiming complete end-to-end acceptance.

Reproduce the optimizer with public data from `scripts/fetch-dca-public-history.py`,
then run `scripts/optimize-dca-20d.ts` with `DCA_BACKTEST_INPUT`,
`DCA_BACKTEST_OUTPUT` and `DCA_DEFAULTS_OUTPUT`. The exact input hash is in the
metrics file. No mainnet orders are authorized by this report.
