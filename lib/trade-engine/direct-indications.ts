/**
 * The engine's DIRECT indication rules, evaluated for one point in time.
 *
 * IndicationProcessor.processIndication (realtime and replay) and the
 * prehistoric per-type measurement call this one function, so a type's
 * historic results are produced by exactly the rules that create its live
 * Base Sets. It is pure apart from its inputs: no Redis, no network, no clock.
 *
 * Signal (remote consensus, realtime only) is not part of it: the realtime
 * caller inserts the Signal rows between `beforeSignal` and `afterSignal`,
 * which keeps the established emission order (… Direction/Move/Optimal/Auto,
 * coordinated Direction/Move, Signal, Active, Trend).
 */
import { calculateMultiRangeCoordination } from "@/lib/multi-range-coordination"
import {
  buildAdaptiveTrendTpRange,
  calculateCombinedTrendSignal,
  calculateTrendSignal,
  DEFAULT_TREND_ACTIVE_SITUATION_RATIOS,
  DEFAULT_TREND_DRAWDOWN_FACTORS,
  DEFAULT_TREND_HIGHER_RANGE_DRAWDOWN_SCALE,
  DEFAULT_TREND_LAST_SITUATION_RATIOS,
  DEFAULT_TREND_MIN_AGREEMENT,
  DEFAULT_TREND_RANGE_STEPS,
  DEFAULT_TREND_TP_MAX_FACTOR,
  DEFAULT_TREND_TP_MIN_MULTIPLIER,
  DEFAULT_TREND_TP_STEP,
  normalizeTrendTimeframesMinutes,
} from "@/lib/trend-indication"
import {
  calculateActiveOutbreak,
  DEFAULT_ACTIVE_OUTBREAK_RANGES,
  DEFAULT_ACTIVE_STOP_LOSS_POSITION_COST_RATIOS,
  DEFAULT_ACTIVE_TAKE_PROFIT_MULTIPLIERS,
  normalizeActiveMarketExitSituations,
  type ActiveMarketExitSituation,
} from "@/lib/active-outbreak-indication"
import { evaluateIndependentDirections } from "@/lib/directional-evaluation"
import { ENGINE_STAGE_HISTORY_MINUTES } from "@/lib/engine-stage-history"

export function timestampMs(value: unknown): number | null {
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  const parsed = Date.parse(String(value ?? ""))
  return Number.isFinite(parsed) ? parsed : null
}

/** Collapse arbitrary-frequency candles to deterministic one-minute closes. */
export function oneMinuteClosesOldestFirst(candles: any[]): number[] {
  const rows = candles
    .map((candle: any, index: number) => ({
      price: Number(candle?.close ?? candle?.c ?? candle?.price),
      timestamp: timestampMs(candle?.timestamp ?? candle?.time ?? candle?.t),
      index,
    }))
    .filter((row) => Number.isFinite(row.price) && row.price > 0)
  if (rows.length === 0) return []

  const allTimestamped = rows.every((row) => row.timestamp !== null)
  // The stage contract requires a complete 90-minute one-minute window.
  // The old 61-row cap made the Main/Real gate mathematically impossible
  // even when the canonical 1-second history contained all 5,400 samples.
  if (!allTimestamped) return rows.map((row) => row.price).slice(-ENGINE_STAGE_HISTORY_MINUTES)

  rows.sort((left, right) => Number(left.timestamp) - Number(right.timestamp) || left.index - right.index)
  const byMinute = new Map<number, number>()
  for (const row of rows) byMinute.set(Math.floor(Number(row.timestamp) / 60_000), row.price)
  return Array.from(byMinute.values()).slice(-ENGINE_STAGE_HISTORY_MINUTES)
}

export function parseNumericSettingList(raw: unknown, fallback: readonly number[]): number[] {
  let values: unknown[] = []
  if (Array.isArray(raw)) values = raw
  else if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      values = Array.isArray(parsed) ? parsed : raw.split(",")
    } catch {
      values = raw.split(",")
    }
  }
  const parsed = values.map(Number).filter(Number.isFinite)
  return parsed.length > 0 ? Array.from(new Set(parsed)) : [...fallback]
}

export interface DirectIndicationCandle {
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface DirectIndicationInput {
  symbol: string
  /** Causal 1-second candles, oldest first; the last one is the current bar. */
  candles: any[]
  /** The last 90 one-minute closes, oldest first (oneMinuteClosesOldestFirst). */
  pricesOldestFirst: number[]
  positionCostPct: number
  /** The processor's indication settings (getSettingsCachedModule shape). */
  indicationSettings: any
  /** Step-based indicator summaries per coordinated timeframe (Auto). */
  stepIndicators: any
  coordinatedTimeframes: number[]
  current: DirectIndicationCandle
  /** Timestamp the rows are anchored at (wall clock, or the replayed candle). */
  now: number
}

export interface DirectIndicationResult {
  beforeSignal: any[]
  afterSignal: any[]
}

export function computeDirectIndications(input: DirectIndicationInput): DirectIndicationResult {
  const {
    symbol,
    candles,
    pricesOldestFirst,
    positionCostPct,
    indicationSettings,
    stepIndicators,
    coordinatedTimeframes,
    now,
  } = input
  const currentClose = input.current.close
  const currentOpen = input.current.open
  const currentHigh = input.current.high
  const currentLow = input.current.low
  const currentVolume = input.current.volume

    const defaultMultiRangeCoordination = calculateMultiRangeCoordination({
      pricesOldestFirst,
      positionCostPct,
      config: indicationSettings.defaultCoordination,
      rangeUnit: "samples",
    })
    const directionPostChangeCoordination = calculateMultiRangeCoordination({
      pricesOldestFirst,
      positionCostPct,
      config: indicationSettings.defaultCoordination,
      requireDirectionChange: indicationSettings.directionPostChangeOnly !== false,
      rangeUnit: "samples",
    })
    const commonMultiRangeCoordination = calculateMultiRangeCoordination({
      pricesOldestFirst,
      positionCostPct,
      config: indicationSettings.commonCoordination,
      rangeUnit: "minutes",
    })


    // Determine direction from real price data:
    // Use close vs open to set bullish/bearish direction for this candle.
    // Do not synthesize an opposite hedge indication. The historical
    // primary+opposite fan-out made every cycle contribute one long and one
    // short candidate, which in turn produced identical side/order counts.
    const primaryDirectionEvaluation = evaluateIndependentDirections([
      currentOpen > 0 ? ((currentClose - currentOpen) / currentOpen) * 100 : 0,
    ])
    const primaryDir = primaryDirectionEvaluation.selectedDirection

    // Derive confidence from candle body vs wick ratio (stronger body = higher confidence)
    const range = currentHigh - currentLow
    const body = Math.abs(currentClose - currentOpen)
    const bodyRatio = range > 0 ? Math.min(0.99, body / range) : 0.5
    const primaryConf = 0.5 + bodyRatio * 0.4  // 0.5 – 0.9

    // Profit factor proportional to confidence
    const primaryPF = 1.0 + primaryConf * 0.5

    // ── Indication emission with differentiated semantics ────────────────
    //
    // Before this fix, every cycle pushed exactly one of every type per
    // direction (4 types × 2 dirs = 8 flat), so the dashboard showed
    // Dir=Move=Act=Opt in perfect lockstep and Auto was always 0.
    //
    // Each type now only fires when its own criterion is satisfied, so the
    // per-type counts naturally diverge and reflect real market structure:
    //
    //   direction — one independent observation in the actual market side
    //   move      — primary-direction candle expansion beyond a small live-noise floor
    //   active    — candle volume > recent-volume average (elevated activity)
    //   optimal   — strong confidence + strong body (conf ≥ 0.72 AND body-ratio ≥ 0.55)
    //   auto      — step-based indicator alignment across short/mid/long windows
    //   trend     — final type; coordinated multi-minute trend + negative
    //               drawdown + recent/active situation validation
    //
    // The scoring below is derived from the real candle data already in scope
    // (currentOpen/High/Low/Close/Volume, candles[], stepIndicators), so we
    // don't incur any extra fetches.

    let indications: any[] = []
    // Active is appended as one deterministic barrier immediately before
    // Trend. Producers add to this buffer so an earlier Move/Optimal/Signal
    // branch cannot accidentally change the public workflow order.
    const deferredActiveIndications: any[] = []

    // Range-percent of the current candle (used by move threshold)
    const rangePercent = currentClose > 0 ? (range / currentClose) * 100 : 0

    // Recent-volume baseline: mean volume of the last ~20 candles (or fewer
    // if the window is smaller). Falls back to currentVolume so the first
    // warm-up ticks don't spuriously fire "active".
    let recentVolAvg = 0
    {
      const window = candles.slice(-20)
      let sum = 0
      let n = 0
      for (const c of window) {
        const v = Number(c?.volume ?? c?.v ?? 0)
        if (Number.isFinite(v) && v > 0) { sum += v; n++ }
      }
      recentVolAvg = n > 0 ? sum / n : currentVolume
    }

    const activeOutbreakRepresentative = (() => {
      const ranges = parseNumericSettingList(
        indicationSettings.activeOutbreakRanges,
        DEFAULT_ACTIVE_OUTBREAK_RANGES,
      ).map((value) => Math.max(2, Math.round(value)))
      const thresholds = parseNumericSettingList(
        indicationSettings.activeThresholds,
        [0.5, 1, 1.5, 2, 2.5],
      )
      const previousActivityRatios = parseNumericSettingList(
        indicationSettings.activeTimeRatios,
        [0.5, 1],
      )
      const rawExitSituations = Array.isArray(indicationSettings.activeMarketExitSituations)
        ? indicationSettings.activeMarketExitSituations
        : String(indicationSettings.activeMarketExitSituations || "")
            .split(/[\s,|]+/)
            .filter(Boolean)
      const marketExitSituations = normalizeActiveMarketExitSituations(
        rawExitSituations as ActiveMarketExitSituation[],
      )
      let best: ReturnType<typeof calculateActiveOutbreak> = null
      for (const activeRange of ranges) {
        for (const thresholdPct of thresholds) {
          for (const previousActivityRatio of previousActivityRatios) {
            const candidate = calculateActiveOutbreak({
              pricesOldestFirst,
              range: activeRange,
              thresholdPct,
              previousActivityRatio,
              noiseFilterPct: Number(indicationSettings.activeNoiseFilter) || 0.05,
              drawdownRatio: 1,
              lastPartRatio: 0.5,
              factorMultiplier: 1,
              volatilityWeight: Number(indicationSettings.activeVolatilityWeight) || 0.3,
              positionCostPct,
              stopLossPositionCostRatios: parseNumericSettingList(
                indicationSettings.activeStopLossPositionCostRatios,
                DEFAULT_ACTIVE_STOP_LOSS_POSITION_COST_RATIOS,
              ),
              takeProfitMultipliers: parseNumericSettingList(
                indicationSettings.activeTakeProfitMultipliers,
                DEFAULT_ACTIVE_TAKE_PROFIT_MULTIPLIERS,
              ),
              marketExitSituations,
            })
            if (candidate && (!best || candidate.signalScore > best.signalScore)) best = candidate
          }
        }
      }
      return best
    })()

    // Auto uses the full enabled Common catalogue (including OBV and
    // Stochastic) on every configured range. A higher range only counts
    // when both its internal indicator vote and the PositionCost-relative
    // coordination point in the same market direction.
    const autoAlignment = (() => {
      try {
        const minimumSignals = Math.max(
          1,
          Number(indicationSettings.commonCoordination?.minimumSignals) || 3,
        )
        const minimumAgreement = Math.max(
          0.5,
          Number(indicationSettings.commonCoordination?.minAgreement) || 0.6,
        )
        const windows = coordinatedTimeframes.map((timeframeMinutes) => {
          const step = (stepIndicators as any)?.[String(timeframeMinutes)]
          const summary = step?.summary
          const direction = summary?.direction === "long" || summary?.direction === "short"
            ? summary.direction
            : null
          return {
            timeframeMinutes,
            direction,
            agreement: Number(summary?.agreement) || 0,
            strength: Number(summary?.strength) || 0,
            signals: Number(summary?.signals) || 0,
            indicators: step?.indicators || {},
          }
        }).filter((window) =>
          window.direction &&
          window.signals >= minimumSignals &&
          window.agreement >= minimumAgreement,
        )
        const coordinated = windows.filter((window) =>
          window.direction === commonMultiRangeCoordination.direction,
        )
        if (
          !commonMultiRangeCoordination.passed ||
          coordinated.length < Math.min(2, coordinatedTimeframes.length)
        ) {
          return null
        }
        const averageStrength = coordinated.reduce(
          (sum, window) => sum + window.strength * 0.5 + window.agreement * 0.5,
          0,
        ) / coordinated.length
        return {
          aligned: true,
          direction: commonMultiRangeCoordination.direction,
          strength: Math.min(0.98, 0.45 + averageStrength * 0.35 + commonMultiRangeCoordination.score * 0.2),
          windows: coordinated,
        }
      } catch {
        return null
      }
    })()

    const trendEvaluations = (() => {
      if (indicationSettings.trendEnabled === false) return []
      const prices = pricesOldestFirst
      const timeframes = normalizeTrendTimeframesMinutes(
        indicationSettings.trendTimeframesMinutes,
      )
      const drawdowns = parseNumericSettingList(
        indicationSettings.trendDrawdownValues,
        DEFAULT_TREND_DRAWDOWN_FACTORS,
      ).map((value) => value > 0 ? -value : value).filter((value) => value < 0)
      const lastRatios = parseNumericSettingList(
        indicationSettings.trendLastSituationRatios,
        DEFAULT_TREND_LAST_SITUATION_RATIOS,
      ).filter((value) => value > 0)
      const activeRatios = parseNumericSettingList(
        indicationSettings.trendActiveSituationRatios,
        DEFAULT_TREND_ACTIVE_SITUATION_RATIOS,
      ).filter((value) => value > 0)
      if (prices.length < 2 || timeframes.length === 0 || drawdowns.length === 0 || lastRatios.length === 0 || activeRatios.length === 0) {
        return []
      }

      const strongestByTimeframe: Array<NonNullable<ReturnType<typeof calculateTrendSignal>>> = []
      for (const timeframeMinutes of timeframes) {
        let best: ReturnType<typeof calculateTrendSignal> = null
        for (const drawdownFactor of drawdowns) {
          for (const lastSituationRatio of lastRatios) {
            for (const activeSituationRatio of activeRatios) {
              const signal = calculateTrendSignal(prices, {
                timeframeMinutes,
                drawdownFactor,
                lastSituationRatio,
                activeSituationRatio,
                positionCostPct,
                minAgreement: Number(indicationSettings.trendMinAgreement) || DEFAULT_TREND_MIN_AGREEMENT,
              })
              if (signal && (!best || signal.signalScore > best.signalScore)) best = signal
            }
          }
        }
        if (best) strongestByTimeframe.push(best)
      }
      if (strongestByTimeframe.length === 0) return []

      const adaptiveTpRange = buildAdaptiveTrendTpRange({
        pricesOldestFirst: prices,
        positionCostPct,
        minMultiplier: Number(indicationSettings.trendTpMinMultiplier) || DEFAULT_TREND_TP_MIN_MULTIPLIER,
        maxFactor: Number(indicationSettings.trendTpMaxFactor) || DEFAULT_TREND_TP_MAX_FACTOR,
        step: Number(indicationSettings.trendTpStep) || DEFAULT_TREND_TP_STEP,
        averageWindowMinutes: Math.max(...timeframes),
      })
      const evaluations: Array<{
        signal: NonNullable<ReturnType<typeof calculateTrendSignal>> | NonNullable<ReturnType<typeof calculateCombinedTrendSignal>>
        adaptiveTpRange: ReturnType<typeof buildAdaptiveTrendTpRange>
        combined: boolean
      }> = strongestByTimeframe.map((signal) => ({
        signal,
        adaptiveTpRange,
        combined: false,
      }))
      if (indicationSettings.trendCombinedEnabled !== false) {
        const combined = calculateCombinedTrendSignal(prices, {
          timeframesMinutes: timeframes,
          drawdownFactors: drawdowns,
          lastSituationRatios: lastRatios,
          activeSituationRatios: activeRatios,
          rangeSteps: parseNumericSettingList(
            indicationSettings.trendRangeSteps,
            DEFAULT_TREND_RANGE_STEPS,
          ),
          positionCostPct,
          minAgreement: Number(indicationSettings.trendMinAgreement) || DEFAULT_TREND_MIN_AGREEMENT,
          higherRangeDrawdownScale:
            Number(indicationSettings.trendHigherRangeDrawdownScale) ||
            DEFAULT_TREND_HIGHER_RANGE_DRAWDOWN_SCALE,
        })
        if (combined) evaluations.push({ signal: combined, adaptiveTpRange, combined: true })
      }
      return evaluations
    })()

    // Loop over the observed market direction only. Each condition remains independent
    // so in a calm market only `direction` fires; on a big bullish candle
    // with elevated volume, all legacy types can fire. Trend is appended
    // once after this loop so it is always the final indication type.
    const pairs: Array<["long" | "short", number, number, boolean]> = primaryDir
      ? [[primaryDir, primaryConf, primaryPF, true]]
      : []

    for (const [dir, conf, pf, isPrimary] of pairs) {
      // 1. Direction — independent and operator-controllable.
      if (indicationSettings.directionEnabled !== false) {
        indications.push({
          type: "direction",
          symbol,
          value: currentClose,
          profitFactor: pf,
          confidence: conf,
          timestamp: now,
          metadata: {
            direction: dir,
            primary: isPrimary,
            mode: "independent",
            higherRangeDirection: directionPostChangeCoordination.direction,
            higherRangeAligned: dir === directionPostChangeCoordination.direction,
            directionPostChangeCoordination,
            directionEvaluation: primaryDirectionEvaluation,
          },
        })
      }

      // 2. Move — independent from Direction. Emit only for the primary
      // candle direction and only when the candle expands beyond a tiny
      // live-noise floor. The previous `rangePercent >= 0` condition made
      // Move fire for every Direction signal (including hedge), so dashboard
      // counts for Direction and Move moved in lockstep.
      const moveThresholdPct = Math.max(0.01, Math.min(0.08, bodyRatio * 0.03))
      if (
        indicationSettings.moveEnabled !== false &&
        isPrimary &&
        (rangePercent >= moveThresholdPct || bodyRatio >= 0.18)
      ) {
        indications.push({
          type: "move",
          symbol,
          value: currentClose,
          profitFactor: pf * (1 + Math.min(0.25, rangePercent / 40)),
          confidence: conf * 0.95,
          timestamp: now,
          metadata: {
            direction: dir,
            rangePercent,
            primary: isPrimary,
            directionEvaluation: primaryDirectionEvaluation,
          },
        })
      }

      // 3. Optimal — gated on high confidence AND strong body. Only the
      //    primary direction is ever optimal (hedge is never the "best" play).
      if (
        indicationSettings.optimalEnabled !== false &&
        isPrimary &&
        conf >= 0.72 &&
        bodyRatio >= 0.55
      ) {
        indications.push({
          type: "optimal",
          symbol,
          value: currentClose,
          profitFactor: Math.min(2.5, pf * 1.15),
          confidence: Math.min(0.95, conf * 1.05),
          timestamp: now,
          metadata: {
            direction: dir,
            bodyRatio,
            primary: true,
            directionEvaluation: primaryDirectionEvaluation,
          },
        })
      }

      // 5. Auto — step-based indicator alignment, primary direction only.
      if (
        indicationSettings.autoEnabled !== false &&
        isPrimary &&
        autoAlignment?.aligned &&
        autoAlignment.direction === dir
      ) {
        indications.push({
          type: "auto",
          symbol,
          value: currentClose,
          profitFactor: Math.min(2.3, pf * (1 + autoAlignment.strength * 0.35)),
          confidence: autoAlignment.strength,
          timestamp: now,
          metadata: {
            direction: dir,
            alignment: "common_multi_range",
            primary: true,
            windows: autoAlignment.windows,
            commonMultiRangeCoordination,
            directionEvaluation: primaryDirectionEvaluation,
          },
        })
      }
    }

    // Independent Direction remains available above. This additional
    // Direction exists only when the higher relative ranges agree on the
    // same market move and satisfy activity, drawdown and 2/2.5/3 cost
    // steps; opposite ranges cannot contribute to its score.
    if (
      indicationSettings.directionEnabled !== false &&
      directionPostChangeCoordination.passed &&
      (directionPostChangeCoordination.direction === "long" || directionPostChangeCoordination.direction === "short")
    ) {
      const coordinatedDirection = directionPostChangeCoordination.direction
      const coordinatedMetadata = {
        direction: coordinatedDirection,
        primary: coordinatedDirection === primaryDir,
        mode: "multi_range",
        sameMarketMoveRequired: true,
        postDirectionChangeOnly: indicationSettings.directionPostChangeOnly !== false,
        multiRangeCoordination: directionPostChangeCoordination,
      }
      indications.push({
        type: "direction",
        symbol,
        value: currentClose,
        profitFactor: 1 + directionPostChangeCoordination.score,
        confidence: Math.min(0.99, directionPostChangeCoordination.agreement),
        timestamp: now,
        metadata: coordinatedMetadata,
      })
    }

    // Move and Active keep their own independent relative-range
    // coordination. They do not inherit Direction's reversal-only gate.
    if (
      defaultMultiRangeCoordination.passed &&
      (defaultMultiRangeCoordination.direction === "long" || defaultMultiRangeCoordination.direction === "short")
    ) {
      const coordinatedDirection = defaultMultiRangeCoordination.direction
      const coordinatedMetadata = {
        direction: coordinatedDirection,
        primary: coordinatedDirection === primaryDir,
        mode: "multi_range",
        sameMarketMoveRequired: true,
        rangeUnit: "samples",
        multiRangeCoordination: defaultMultiRangeCoordination,
      }
      const moveThresholdPct = Math.max(0.01, Math.min(0.08, bodyRatio * 0.03))
      if (
        indicationSettings.moveEnabled !== false &&
        coordinatedDirection === primaryDir &&
        (rangePercent >= moveThresholdPct || bodyRatio >= 0.18)
      ) {
        indications.push({
          type: "move",
          symbol,
          value: currentClose,
          profitFactor: 1 + defaultMultiRangeCoordination.score * 0.9,
          confidence: Math.min(0.98, defaultMultiRangeCoordination.agreement * 0.95),
          timestamp: now,
          metadata: { ...coordinatedMetadata, rangePercent },
        })
      }
      if (
        indicationSettings.activeEnabled !== false &&
        activeOutbreakRepresentative &&
        coordinatedDirection === activeOutbreakRepresentative.direction &&
        coordinatedDirection === primaryDir &&
        defaultMultiRangeCoordination.activityAgreement >= 0.5
      ) {
        deferredActiveIndications.push({
          type: "active",
          symbol,
          value: currentClose,
          profitFactor: 1 + defaultMultiRangeCoordination.score * 0.8,
          confidence: Math.min(0.97, defaultMultiRangeCoordination.activityAgreement),
          timestamp: now,
          metadata: {
            ...coordinatedMetadata,
            mode: "active_outbreak_multi_range",
            activeOutbreak: {
              ...activeOutbreakRepresentative.metrics,
              protectionProfiles: activeOutbreakRepresentative.protectionProfiles,
            },
          },
        })
      }
    }

    // Active — fast causal price outbreak relative to the immediately
    // preceding market-activity window. It is deliberately appended after
    // every other family and immediately before Trend.
    if (
      indicationSettings.activeEnabled !== false &&
      activeOutbreakRepresentative
    ) {
      deferredActiveIndications.push({
        type: "active",
        symbol,
        value: currentClose,
        profitFactor: activeOutbreakRepresentative.signalScore,
        confidence: activeOutbreakRepresentative.confidence,
        timestamp: now,
        metadata: {
          direction: activeOutbreakRepresentative.direction,
          primary: activeOutbreakRepresentative.direction === primaryDir,
          mode: "active_outbreak",
          volumeRatio: recentVolAvg > 0 ? currentVolume / recentVolAvg : 0,
          activeOutbreak: {
            ...activeOutbreakRepresentative.metrics,
            protectionProfiles: activeOutbreakRepresentative.protectionProfiles,
          },
        },
      })
    }
    const afterSignal: any[] = [...deferredActiveIndications]

    // Trend — deliberately appended last. Emit the strongest independent
    // configuration for every enabled Trend timeframe (1/5/15/30m by default),
    // while IndicationSetsProcessor retains every passing parameter tuple.
    for (const trendEvaluation of trendEvaluations) {
      afterSignal.push({
        type: "trend",
        symbol,
        value: currentClose,
        profitFactor: trendEvaluation.signal.signalScore,
        confidence: trendEvaluation.signal.confidence,
        timestamp: now,
        metadata: {
          ...trendEvaluation.signal.metadata,
          // The combined signal's metadata has no side of its own; without
          // it the coordinator cannot resolve a direction and drops the row.
          direction: trendEvaluation.signal.direction,
          adaptiveTpRange: trendEvaluation.adaptiveTpRange,
          combined: trendEvaluation.combined,
        },
      })
    }


  return { beforeSignal: indications, afterSignal }
}
