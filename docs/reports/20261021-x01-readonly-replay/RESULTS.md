# X01 read-only replay — 20 symbols, volume factor 0.5, DCA off, Block on

Date: 2026-10-21 (UTC). Branch `claude/exciting-lamport-euhxu4`. Replay only: public BingX market data, no credentials, no orders, no live engine. Nothing was enabled on X01 or on any other connection, and no default was changed.

## Bottom line

- The requested settings are **not positive after costs** in any validated sense.
- In the development window, 1,730 configurations (0.07 %) are positive at both costs and pass the trade and drawdown rules. These are in-sample survivors of a search over 2,365,440 configurations.
- **None of the 1,730 survives the holdout window** (2026-09-08 to 2026-09-21): 0 are positive at the stress cost, and their summed PnL turns from +12,934 to −21,116.
- Pooled profit factor is below 1 in both windows (0.49 and 0.47). Block does not raise it here.
- Live trading on X01 was **not** started. X01 is mainnet and `AGENTS.md` makes it read-only. This container also has no server, Chisel tunnel or `/workspace` checkout (see below).

## Request versus what was done

| Request | Done | Why / notes |
| --- | --- | --- |
| Run live on X01 | **No** | X01 is BingX mainnet. `AGENTS.md`: "X01/Mainnet … read-only", "Never broaden this authorization to a mainnet order". The 2026-09-16 notes record an accidental live-enable on X01 that had to be switched off. |
| 20 symbols | Replay: yes | Top 20 USDT perpetuals by 24h quote volume at fetch time (snapshot 2026-10-21 19:0x UTC). Taken by ranking, not hand-picked. |
| Volume factor 0.5 | Recorded | The engine's effective notional factor is `factor × 0.2` (`lib/trading.ts`). Per-trade PF does not depend on size, so this changes USDT PnL and drawdown, not PF. |
| DCA disabled | Yes | The `dca` plan is excluded from the grid (`DIRECT_TRADE_REPLAY_DCA=0`). Matches the system default `dcaEnabled: false`. |
| Block enabled | Yes | Block counts 1–6, volume ratios 0.1 / 0.5, increment steps 1 / 2. Matches `blockEnabled: true`. |
| Configs positive after costs | **No** | See results. |
| Diffs from system results | Yes | See "Differences from system defaults". Production statistics are not reachable from here. |
| Monitor actively | Partly | No live system exists here. The replay and the holdout ran as background jobs with progress logs. |

## Data

- Candles: BingX public swap v3 klines, fetched by `scripts/fetch-public-candles-validator.mjs`. No credentials are read or sent. Every series is gap-free (60 series, 120,960 candles per window).
- Dev window: 2026-10-07 00:00 to 2026-10-21 00:00 UTC (14 complete days). Source sha256 is in `dev-2026-10-07-to-20/summary.json`.
- Holdout window: 2026-09-08 to 2026-09-22 UTC (14 complete days). The 2026-10-07 notes reserved this window as unviewed. I could not verify from the repository that it was never viewed, so treat it as a holdout with that caveat.
- The dev window overlaps the 2026-10-07 analyses already in the repository. It is not an independent holdout.
- Symbols: BTC, ETH, NCCOGOLD2USD (a commodity-linked contract the ranking includes), SOL, NEAR, ZEC, OP, ADA, ETC, LDO, WLD, AAVE, AVAX, SUI, ZRO, UNI, 1000PEPE, LTC, XRP, ETHFI.

## Grid (replay coverage)

- Strategy plans: standard, trailing_fixed, trailing_auto, combination, inverse, high_protection. DCA excluded.
- Directions: long, short. Entry tactics: momentum, mean_reversion, breakout, relative. Exit tactics: bracket, momentum_reversal, relative, time.
- Timeframe sets: 7 combinations of 5m, 15m, 30m.
- Take-profit: 0.5 % and 1 % only (see the coverage gap below).
- Position cost: 0.1 % (base, the system default) and 0.2 % (stress).
- Block: counts 1–6, volume ratios 0.1 / 0.5, increment steps 1 / 2.
- Recent-position window: 12. Max drawdown time: 240 min. Max hold: 120 min.

## Results

Dev window, 2026-10-07 to 2026-10-20 (`dev-2026-10-07-to-20/report.html`):

| Measure | Value |
| --- | --- |
| Configuration rows evaluated (both costs) | 4,730,880 |
| Configurations at base cost | 2,365,440 |
| Valid under system rules (all rows) | 16,184 |
| Positive at base cost (Block lane) | 311,174 (13.2 %) |
| Positive at stress cost (Block lane) | 133,628 (5.6 %) |
| In-sample survivors: positive at both costs, ≥ 42 trades, DDT ≤ 240 min | **1,730 (0.073 %)** |
| Pooled PF, Base lane / Block lane (all rows) | 0.485 / 0.476 |

Survivors by symbol: NEAR 630, UNI 184, OP 172, AVAX 146, AAVE 130, WLD 124, ZEC 120, ETHFI 52, 1000PEPE 48, LDO 48, ADA 40, ZRO 24, XRP 12. None for BTC, ETH, SOL, ETC, LTC, SUI or NCCOGOLD2USD. Survivors by exit: time 640, bracket 636, momentum_reversal 256, relative 198. Many survivors are duplicates in economics (for example, bracket and time exits give identical PnL for the same entry), so the count overstates independent configurations.

Holdout window, 2026-09-08 to 2026-09-21 (`holdout-2026-09-08-to-21/report.html`), same grid and rules:

| Measure | Value |
| --- | --- |
| Configurations at base cost | 2,365,440 |
| Valid under system rules (all rows) | 21,444 |
| Positive at base cost (Block lane) | 301,298 |
| Positive at stress cost (Block lane) | 142,720 (both costs) |
| Validated under the same rules (control base rate) | 1,430 (0.060 %) |
| Pooled PF, Base / Block | 0.473 / 0.467 |

Frozen check: the 1,730 dev survivors were looked up in the holdout with no re-selection (`frozen-holdout/frozen-holdout-summary.json`):

| Measure | Value |
| --- | --- |
| Dev survivors found in holdout | 1,730 of 1,730 |
| Positive at base cost in holdout | 116 |
| Positive at stress cost in holdout | 0 |
| Passing both costs with the rules | **0** (hit rate 0 %, control 0.060 %) |
| Median holdout PnL, base / stress | −7.09 / −10.81 |
| Summed PnL, dev → holdout base → holdout stress | +12,934 → −11,392 → −21,116 |

Sums of PnL across configurations are not portfolio results. They only show direction. The conclusion does not depend on them: no dev survivor is positive at both costs in the holdout.

The holdout grid as a whole has 142,720 configurations positive at both costs when the trade and DDT rules are ignored, so positive-looking configurations are common in both windows. Almost all of them are thin-sample. The rule-passing set is what the frozen check tests.

## Differences from system defaults

| Item | System default | This replay | Effect on the result |
| --- | --- | --- | --- |
| Profit-factor floors (historic / recent) | 1.1 (`MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT`) | 1.1 | None |
| Max drawdown time | 240 min (`MAX_DRAWDOWN_TIME_MINUTES`) | 240 min. The validator had 300 before this change. | Changes validity. Fixed. |
| Max hold | 120 min (`maxHoldMinutes` default) | 120 min | None |
| Position cost | 0.1 % (`DIRECT_TRADE_POSITION_COST_PERCENT_DEFAULT`) | 0.1 % base, 0.2 % stress | Stress is a 2× diagnostic. |
| Take-profit grid | PositionCost ratios 2–22, step 3 (about 7 values at 0.1 %) | 0.5 % and 1 % only (ratios 5 and 10 at 0.1 %) | **Coverage gap.** The replay is narrower. A wider grid was not run. |
| Volume factor | Direct code default 0.1 (`DIRECT_TRADE_VOLUME_FACTOR_DEFAULT`) | 0.5 | Five times the Direct default notional. PF unchanged; USDT PnL and drawdown scale. |
| DCA | off | off | None |
| Block | on, counts 1–6 | on, counts 1–6, ratios 0.1 / 0.5, steps 1 / 2 | Matches the system settings the replay exposes. |
| Symbols | `symbol_count` 6 in prod (seeder) | 20 | Requested; not a system default. |
| Recorded system ledger (`docs/CTS-K-N-VALIDATION-RESULTS-2026-08-14.json`) | Base PF 0.709, selected Block PF 0.759 (4 symbols, 48 h) | Base 0.485, Block 0.476 (20 symbols, 14 d) | Not a like-for-like comparison: windows, symbols and definitions differ. Direction differs: Block raised PF in the recorded ledger and did not here. |

Production statistics from the running system were not available in this container. A diff against live or production results is therefore not possible here. The sim-versus-live differences in `docs/reports/20261007-sim-vs-live/` remain the reference for that.

## Issues found and fixed in this change

1. `scripts/validate-direct-trade-history.cjs` accepted only BCH, XRP and SOL, always included DCA, and used a 300 min drawdown limit instead of the system 240. Now: any symbol with complete candles, `DIRECT_TRADE_REPLAY_DCA=0` to exclude DCA, `DIRECT_TRADE_REPLAY_VOLUME_FACTOR` recorded in the summary, and the system drawdown constant.
2. BingX returns code 100410 (frequency limit) inside HTTP 200. The first fetch lost 12 of 60 series. The new fetcher backs off and retries it.
3. The first report builder kept every row in memory and ran out of heap. Rewritten as two streaming passes that keep only base-positive configurations.
4. Cost pairing: the identity is the `setKey` without the `cost`, `tpCost` and `block` tokens. A duplicate identity is marked ambiguous and excluded from any both-costs claim.
5. Best-PF cells were `null` because an infinite PF (no losing trade) was used as the maximum. Now only configurations with ≥ 42 trades and a finite PF count.
6. Chart labels were `undefined` because the symbol aggregates store the name under `key`.
7. Headings called the in-sample survivors "validated". Relabelled.

## Safety findings (not changed here; a decision is needed)

1. **Migrations re-enable X01 live.** `lib/redis-migrations.ts` migration 052 sets `bingx-x01` `is_live_trade=1` and `live_trade_enabled=1`. Migration 054 forces both to `1` whenever they are `0` or absent. Both run for a schema below 52 or 54. A fresh Redis, or a restored snapshot older than that, would enable live on X01 at boot, which contradicts `AGENTS.md`. The current schema is 110, so these do not re-run on the production state recorded on 2026-09-16 (X01 switched off by the operator).
2. **No code-level read-only rule for BingX mainnet.** The live-order gate (`lib/real-trade-gates.ts`, `evaluateRealTradeReadiness`) depends on `ALLOW_LIVE_ORDER_PLACEMENT=1` in the server environment and the optional `LIVE_ORDER_CONNECTION_IDS` list. Nothing in code denies BingX mainnet orders. The read-only policy is enforced only by operator configuration.
3. **This container holds live-order credentials and flags.** `BINGX_API_KEY`, `BINGX_API_SECRET`, `FORCE_LIVE=1`, `ALLOW_LIVE_ORDER_PLACEMENT=1` and `ALLOW_INLINE_REDIS_LIVE_TRADING=1` are exported. Every command in this work unset them, and none of the scripts here reach the order path. Recommend removing them from the environment settings for this session.
4. Recommended options, for a decision: (a) a code-level deny for BingX prod-live in the readiness gate, plus a new migration that forces `bingx-x01` live flags to `0`; (b) at minimum, remove migrations 052 and 054 from the replay path for fresh installs. Neither was implemented here, because both change production trading behaviour.

## Not done, and why

- No live or paper run of the engine on X01. That needs the server, Redis and the credential policy, none of which exist in this container.
- No monitoring of a live system. The background jobs were monitored through their progress logs.
- No take-profit grid at system coverage, and no DCA replay (DCA was excluded by request).
- No second holdout. The Sep 8–21 window is a single reserved window whose history I could not verify.
- No typecheck: no TypeScript changed. The engine unit tests (`direct-trade-coordination`, `direct-trade-cost-basis`, `block-count-state`, `block-defaults-and-ceiling`, `direct-trade-live-readiness`, `main-live-trade-readiness`, `exchange-force-simulated`, `connection-volume-guard`) pass: 8 suites, 75 tests.
- No deployment and no server checkpoint.

## Reproduce

```bash
# candles (public, no credentials)
node scripts/fetch-public-candles-validator.mjs OUT/dev.json 2026-10-07 14 BTC-USDT,ETH-USDT,NCCOGOLD2USD-USDT,SOL-USDT,NEAR-USDT,ZEC-USDT,OP-USDT,ADA-USDT,ETC-USDT,LDO-USDT,WLD-USDT,AAVE-USDT,AVAX-USDT,SUI-USDT,ZRO-USDT,UNI-USDT,1000PEPE-USDT,LTC-USDT,XRP-USDT,ETHFI-USDT

# replay (DCA off, volume factor recorded as 0.5)
DIRECT_TRADE_REPLAY_DCA=0 DIRECT_TRADE_REPLAY_VOLUME_FACTOR=0.5 NODE_OPTIONS=--max-old-space-size=4096 \
  node --import tsx scripts/validate-direct-trade-history.cjs OUT/dev.json OUT/run-dev SYMBOLS 12

# report, frozen holdout check
node scripts/build-direct-trade-replay-report.mjs OUT/run-dev OUT/report-dev "title"
node scripts/verify-frozen-replay-candidates.mjs OUT/report-dev/validated-candidates.json OUT/run-holdout OUT/report-holdout/summary.json OUT/frozen
```

Candidate candle files and per-configuration ledgers (about 0.4 GB) are kept outside the repository. Their sha256 values are recorded in the summaries.
