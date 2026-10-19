# Round 5 audit findings: status

Source: read-only audit of 2026-10-19 (10 agents, 84 candidates, 75 confirmed, 9 refuted). Full list in the session scratchpad (not committed). Every confirmed finding is listed here with its status.

Status: **fixed** (commit), **changed** (behaviour changed this round, measured where stated), **partly**, **open** (in scope, not yet fixed), **logged** (low impact, no behaviour change this round).

## trailing (20 confirmed)

| ID | Sev | Location | Finding | Status |
|---|---|---|---|---|
| TRAIL-01 | high | `lib/trade-engine/realtime-processor.ts:1004` | General multi-step trailing never arms: start threshold (30 percent+ gain) is above the take-profit that closes first | fixed 23b7004 (activation is a share of TP; operator decision) |
| TRAIL-02 | high | `lib/trade-engine/pseudo-position-manager.ts:633` | Signal-dynamic positions with trailingStartPct > 0 are stopped at the minimum trail distance before activation | fixed 86ae2c0 (dormant trailing seed removed) |
| TRAIL-04 | high | `lib/historic-test-family-replay.ts:90` | Historic trailing family arms from entry (no activation threshold), unlike every live rule | fixed 23b7004 (historic trailing follows live activation) |
| TRAIL-05 | high | `lib/historic-test-family-replay.ts:115` | Historic trailing exits charge PositionCost (0.10 percent) instead of the real round trip (0.26 percent), with no exit slippage | fixed 86ae2c0 (real round trip on historic trailing) |
| TRAIL-06 | high | `lib/historic-test-service.ts:180` | Historic trailing retrace is taken from trailingMinStep, a window-gate setting with default 8 | fixed 86ae2c0 (retrace no longer read from trailingMinStep) |
| TRAIL-07 | medium | `lib/historic-test-replay.ts:169` | Historic trailing family ignores take-profit and max hold; its TP variants are identical copies and trades are never time-capped | fixed 23b7004 (historic trailing checks take-profit first) |
| TRAIL-08 | medium | `lib/historic-test-family-replay.ts:85` | replayTrailing walks the entry candle itself, using prices that printed before the entry | fixed 23b7004 (walk starts after the entry bar) |
| TRAIL-09 | medium | `lib/trade-engine/realtime-processor.ts:1134` | Legacy single-step trailing seeds the stop from the current tick, which can sit beyond the configured stop | logged |
| TRAIL-10 | medium | `lib/trade-engine/realtime-processor.ts:1061` | Multi-step ratchet trails the last step anchor, not the best price (lags by up to one step) | logged |
| TRAIL-11 | medium | `lib/trade-engine/realtime-processor.ts:719` | Pseudo exits book the sampled tick rather than the trigger level, so TP, SL and trailing PnL depend on tick overshoot | logged |
| TRAIL-13 | medium | `lib/strategy-coordinator.ts:10942` | Signal trailing matrix discards its SL dimension, and pseudo dedupe ignores source and SL ratio (needs runtime confirmation) | logged |
| TRAIL-14 | medium | `lib/preset-pseudo-position-manager.ts:267` | Preset-engine trailing is enforced only while profit stays above the activation level, and its high-water mark is lost on restart | logged |
| TRAIL-17 | medium | `lib/historic-test-family-replay.ts:84` | Historic trailing trades overlap; no one-open-position rule is applied | open (in scope, next) |
| TRAIL-19 | medium | `scripts/short-range-research.ts:31` | Research harnesses use PositionCost (0.10 percent) as the base cost for trailing and fixed exits | logged |
| TRAIL-12 | low | `lib/trade-engine/realtime-processor.ts:726` | Trailing exits are labelled stop_loss in the main pseudo engine | logged |
| TRAIL-15 | low | `lib/preset-coordination-engine.ts:1131` | Preset simulator resolves same-bar ordering optimistically; the historic family resolves it pessimistically | logged |
| TRAIL-16 | low | `lib/historic-test-family-replay.ts:96` | replayTrailing fills gap-through exits at the trigger level rather than the candle open | logged |
| TRAIL-18 | low | `lib/short-range-exits.ts:369` | sparseExits silently ignores trailing fields that ExitConfig accepts | logged |
| TRAIL-20 | low | `lib/trade-engine/realtime-processor.ts:940` | Signal-lane operator trailing floor is not applied to the minimum stop distance; doc default is stale | logged |
| TRAIL-21 | low | `lib/signal-trailing.ts:53` | Activation is an absolute gain on entry in every live rule, not a fraction of the target; the Signal stop distance is dynamic, not stopRatio | fixed 23b7004 (activation share; stop distance unchanged) |

## stages (16 confirmed)

| ID | Sev | Location | Finding | Status |
|---|---|---|---|---|
| F-01 | high | `lib/strategy-coordinator.ts:5584` | Base gate deadlocks when prevPosMinCount exceeds prevPosWindow | fixed 86ae2c0 (Base-gate minimum capped at window) |
| F-02 | medium | `lib/strategy-coordinator.ts:9945` | Live processing count is Real-row count without the entries filter and bypasses the funnel contract | logged |
| F-03 | medium | `lib/detailed-tracking.ts:766` | Main, Real and Live setsProgressing read a last-writer top-level field and fall back to the emitted pool | logged |
| F-05 | medium | `lib/trade-engine/config-set-processor.ts:1192` | Prehistoric Base gate reads buckets that already hold every close of the measured range (look-ahead for historic use) | open (in scope, next) |
| F-06 | medium | `lib/strategy-coordinator.ts:3195` | Base PF cost basis switches from simulated round trip to venue-net after 3 real closes | open (in scope, next) |
| F-07 | low | `lib/stage-funnel-contract.cjs:97` | Stats funnel check skips passed greater than evaluated when evaluated is 0 | logged |
| F-08 | low | `lib/strategy-coordinator.ts:5606` | Base-valid set includes Sets that Main then skips for low history | logged |
| F-09 | low | `lib/pos-history.ts:309` | Batch writer counts wins, PF and ring from pnl, while the single writer uses pnlPct | logged |
| F-10 | low | `lib/trade-engine/pseudo-position-manager.ts:1106` | Pseudo ring records the raw stored PositionCost while the charged cost uses the normalized one | logged |
| F-11 | low | `lib/strategy-coordinator.ts:6125` | Main-input invariant is a tautology and never checks real Main intake | logged |
| F-12 | low | `lib/strategy-coordinator.ts:3542` | Base DDT gate is inert (maxDrawdownTime 999999), contrary to the documented rule | logged |
| F-13 | low | `lib/trade-engine/type-measurement.ts:140` | Non-resumable stored state drops its open positions and overwrites the state | logged |
| F-14 | low | `lib/trade-engine/type-measurement.ts:326` | Backfill discards positions still open at each step boundary, biasing its sample | logged |
| F-15 | low | `lib/strategy-coordinator.ts:12090` | Strategy progression log reports Base passed as the emitted count | logged |
| F-16 | low | `lib/pos-history.ts:451` | Stale comment describes a fixed 0.1% pseudo close cost | logged |
| F-17 | low | `lib/strategy-coordinator.ts:5198` | Base emitted count is pre-dedupe in createBaseSets but post-dedupe in the Main gate | logged |

## costs (13 confirmed)

| ID | Sev | Location | Finding | Status |
|---|---|---|---|---|
| COST-01 | high | `lib/historic-test-family-replay.ts:115` | Historic Test trailing family charges PositionCost (0.10%) instead of the real round trip (0.26%) | fixed 86ae2c0 (same as TRAIL-05) |
| COST-02 | high | `app/api/auto-optimal/calculate/route.ts:475` | Auto-Optimal ranking and preset backtest deduct PositionCost, not the round trip | fixed 86ae2c0 (Auto-Optimal charges simulated close cost) |
| COST-03 | high | `app/statistics/page.tsx:116` | Statistics page PF coordinate divides net money by notional, not by PositionCost | fixed 86ae2c0 (statistics PF coordinate uses PositionCost money) |
| COST-04 | medium | `lib/trade-engine/stages/live-stage.ts:19276` | Simulated live closes: money PnL is gross, the Set ledger charges the round trip, the Signal ledger charges PositionCost | open (in scope, next) |
| COST-05 | medium | `lib/dca-backtest.ts:245` | DCA replay charges slippage twice per round trip; DCA optimization runs use a cheaper cost than the engine | open (in scope, next) |
| COST-06 | medium | `lib/bots/backtest.ts:220` | At least five different round-trip cost definitions are in use for the same concept | logged |
| COST-07 | medium | `lib/trading-round-trip-cost.cjs:29` | PositionCost is documented as never a cost, but it is charged as a floor whenever it exceeds the round trip | logged |
| COST-08 | medium | `lib/connection-backtest.ts:281` | Gated connection backtest scores admission on 0.26% costs while reporting trades net of BOT fees | open (in scope, next) |
| COST-09 | low | `lib/bots/runner.ts:102` | Live bot runner assumes a maker entry for every type; the backtest assumes a taker entry for three types | logged |
| COST-10 | low | `lib/bots/backtest.ts:444` | Bot summary reports the take-profit exit cost as the cost per trade; the header states a cost the code does not use | logged |
| COST-11 | low | `lib/trade-engine/pseudo-position-manager.ts:983` | Pseudo close overwrites position_cost with round-trip money; the field has three meanings across writers | logged |
| COST-12 | low | `lib/exchange-connectors/instaforex-connector.ts:888` | InstaForex settlement takes abs(fee) from the first of fee, commission or swap; swap credits become costs and a swap is ignored when commission is present | logged |
| COST-14 | low | `lib/indication-sets-processor.ts:1342` | slippageTolerance is a fraction in the connection schema but a percent in the order UI; the outcome model reads it as a fraction without normalisation | logged |

## sets (13 confirmed)

| ID | Sev | Location | Finding | Status |
|---|---|---|---|---|
| SET-01 | high | `lib/trade-engine/indication-processor-fixed.ts:369` | Realtime Base receives one representative per type x direction x subtype lane, not every configured tuple | changed: default evaluates every configured tuple (STRATEGY_TUPLE_COVERAGE); A/B measurement in the round 5 report |
| SET-02 | medium | `lib/trade-engine/shared-ind-strat-pipeline.ts:211` | Counters count the full list while Base receives representatives, so counts do not reconcile | partly: configured and passed-to-Base counts recorded per pass (IndicationProcessor.lastBaseCoverage), not yet persisted to the stats route |
| SET-03 | medium | `lib/indication-sets-processor.ts:3115` | Common evaluated tuples are not reconciled to emitted Sets; excluded categories are not counted | partly: same record as SET-02 |
| SET-04 | medium | `lib/trade-engine/indication-processor-fixed.ts:1386` | Silent cycle-level and fallback population switches change the Base input without a count | partly: population switches still silent; the recorded Base input shows the change |
| SET-05 | medium | `lib/common-indicator-config.ts:446` | Fine user-editable steps silently drop the upper boundary tuple (Common ranges) | open (in scope, next) |
| SET-06 | medium | `lib/indication-sets-processor.ts:1588` | parseRangeSettings has no tolerance and drops the top activity-ratio value | open (in scope, next) |
| SET-07 | medium | `lib/indication-configuration-counts.ts:371` | Signal configuration count ignores the indication variant policy used by Base (conditional) | open (in scope, next) |
| SET-08 | low | `lib/strategy-coordinator.ts:4557` | Base-stage tuple skips have no counter | logged |
| SET-09 | low | `lib/strategy-coordinator.ts:4482` | Trailing profile parsing skips tokens silently, does not dedupe, and can collide on tag | logged |
| SET-10 | low | `lib/trade-engine/strategy-processor.ts:251` | Realtime validity gate drops indications silently with no per-type count | logged |
| SET-11 | low | `lib/common-indicators/catalog.ts:257` | requiresWallClock is declared but never enforced; UTC rules depend on candle timestamps | logged |
| SET-12 | low | `lib/indication-sets-processor.ts:627` | Per-direction evaluation counts double count tuples; possibleSets doubles evaluations | logged |
| SET-13 | low | `lib/common-indicator-config.ts:506` | Timeframe list is silently clamped to 60 minutes and de-duplicated | logged |

## indications (13 confirmed)

| ID | Sev | Location | Finding | Status |
|---|---|---|---|---|
| F1-rsi-band-direction | high | `lib/common-indicators/legacy-rules.ts:179` | Legacy RSI direction flips at the oversold/overbought thresholds | fixed d113346 (reversion rule; operator decision) |
| F2-cci-stochastic-category-mismatch | medium | `lib/common-indicators/legacy-rules.ts:369` | Legacy CCI and Stochastic vote momentum inside the 'reversion' oscillator category | open (in scope, next) |
| F3-pdhl-latch | medium | `lib/common-indicators/ao/research2.ts:647` | Previous-day break-and-retest latch never re-arms after an unconfirmed break | open (in scope, next) |
| F4-ichimoku-displacement | medium | `lib/common-indicators/ao/series-cache.ts:106` | Ichimoku cloud displacement is tied to the kijun period instead of 26 | open (in scope, next) |
| F5-historic-signal-mirror-gate | medium | `lib/historic-test-config-signals.ts:147` | Historic-test signal mirror: score gate cannot reject, score differs from production, and the doc claims parity | open (in scope, next) |
| F6-drawdown-not-a-gate | medium | `lib/indication-sets-processor.ts:4447` | drawdownRatio cannot remove Direction or Move candidates; it only shifts signalScore | open (in scope, next) |
| F7-zdistance-not-centered | low | `lib/common-indicators/ao/research.ts:343` | Distance z-score divides by stdev without subtracting the mean | logged |
| F8-historic-signal-index | low | `lib/historic-test-config-signals.ts:151` | Historic signal index is one bar late; entry is one further bar later | logged |
| F9-htf-gap-drops-bucket | low | `lib/common-indicators/ao/series-cache.ts:180` | Higher-timeframe bucket is never published when its last minute is missing | logged |
| F10-volatility-on-levels | low | `lib/indication-sets-processor.ts:4791` | Move 'volatility' is the coefficient of variation of price levels, not of returns | open (in scope, next) |
| F11-dead-indication-engine | low | `lib/indications.ts:79` | lib/indications.ts is unused and treats price_change_ratio in inconsistent units | logged |
| F12-ema-seed-split | low | `lib/common-indicators/kn-math.ts:151` | Two EMA definitions share the name; the legacy one leaves a large seed residual at warm-up | logged |
| F13-catalog-sources-metadata | info | `lib/common-indicators/catalog.ts:330` | cciReversion catalog sources lists 'cci' but its mapping uses 'cci-revert' | logged |
