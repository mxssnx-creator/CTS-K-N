/**
 * Trend indication calculations shared by the set-backed engine and the
 * Base-pseudo-position generator.
 *
 * Price arrays are always oldest-first and represent one-minute closes. This
 * keeps the configured windows (1/3/5/10/15/30 minutes) deterministic and
 * avoids mixing wall-clock sampling with candle-based calculations.
 */

export const DEFAULT_TREND_TIMEFRAMES_MINUTES = [1, 3, 5, 10, 15, 30] as const
export const DEFAULT_TREND_DRAWDOWN_FACTORS = [-1, -2, -3] as const
export const DEFAULT_TREND_LAST_SITUATION_RATIOS = [0.5, 1] as const
export const DEFAULT_TREND_ACTIVE_SITUATION_RATIOS = [0.5, 1] as const

export const DEFAULT_TREND_MIN_AGREEMENT = 0.6
export const DEFAULT_TREND_TP_MIN_MULTIPLIER = 2
export const DEFAULT_TREND_TP_MAX_FACTOR = 10
export const DEFAULT_TREND_TP_STEP = 1

export type TrendDirection = "long" | "short"

export interface TrendCalculationConfig {
  timeframeMinutes: number
  /** Negative PositionCost multiples. Example: -2 allows 2× PositionCost adverse movement. */
  drawdownFactor: number
  /** Required recent-window strength relative to average absolute one-minute change. */
  lastSituationRatio: number
  /** Required last one-minute move strength relative to the same average. */
  activeSituationRatio: number
  /** Position cost in percent, e.g. 0.02 means 0.02%. */
  positionCostPct: number
  minAgreement?: number
  minChangeRatio?: number
}
export interface TrendSignal {
  direction: TrendDirection
  signalScore: number
  confidence: number
  metadata: {
    timeframeMinutes: number
    direction: TrendDirection
    totalChangePct: number
    positionCostPct: number
    positionCostRatio: number
    averageOneMinuteChangePct: number
    continuationAgreement: number
    adverseDrawdownPct: number
    adverseDrawdownFactor: number
    configuredDrawdownFactor: number
    lastSituationPct: number
    lastSituationRatio: number
    configuredLastSituationRatio: number
    activeMarketChangePct: number
    activeSituationRatio: number
    configuredActiveSituationRatio: number
  }
}

export interface AdaptiveTrendTpRange {
  factors: number[]
  averageOneMinuteChangePct: number
  positionCostPct: number
  marketChangePositionCostRatio: number
  calculatedMinFactor: number
  appliedMinFactor: number
  maxFactor: number
  step: number
  minMultiplier: number
}

function finitePositivePrices(prices: number[]): number[] {
  return prices
    .map(Number)
    .filter((price) => Number.isFinite(price) && price > 0)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: number, decimals = 8): number {
  const scale = 10 ** decimals
  return Math.round((value + Number.EPSILON) * scale) / scale
}

function percentChange(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return 0
  return ((to - from) / from) * 100
}

/** Average absolute close-to-close movement in percent for one-minute closes. */
export function calculateAverageOneMinuteChangePct(pricesOldestFirst: number[]): number {
  const prices = finitePositivePrices(pricesOldestFirst)
  if (prices.length < 2) return 0

  let total = 0
  let count = 0
  for (let index = 1; index < prices.length; index++) {
    total += Math.abs(percentChange(prices[index - 1], prices[index]))
    count++
  }
  return count > 0 ? round(total / count) : 0
}

function calculateAdverseDrawdownPct(prices: number[], direction: TrendDirection): number {
  if (prices.length < 2) return 0

  let adverse = 0
  if (direction === "long") {
    let runningPeak = prices[0]
    for (const price of prices) {
      runningPeak = Math.max(runningPeak, price)
      adverse = Math.min(adverse, percentChange(runningPeak, price))
    }
  } else {
    let runningTrough = prices[0]
    for (const price of prices) {
      runningTrough = Math.min(runningTrough, price)
      const reboundPct = percentChange(runningTrough, price)
      adverse = Math.min(adverse, -Math.max(0, reboundPct))
    }
  }
  return round(adverse)
}

/**
 * Evaluate one independent Trend configuration.
 *
 * A signal is valid only when all four coordinated layers agree:
 * overall window direction, step continuity, recent-window situation, and
 * the active (latest one-minute) market change. Drawdown is expressed as a
 * negative multiple of PositionCost so operators can configure several
 * independent adverse-move tolerances without unit ambiguity.
 */
export function calculateTrendSignal(
  pricesOldestFirst: number[],
  config: TrendCalculationConfig,
): TrendSignal | null {
  const timeframeMinutes = Math.max(1, Math.round(Number(config.timeframeMinutes) || 1))
  const prices = finitePositivePrices(pricesOldestFirst).slice(-(timeframeMinutes + 1))
  if (prices.length < timeframeMinutes + 1) return null

  const positionCostPct = Math.max(0.000001, Number(config.positionCostPct) || 0.1)
  const totalChangePct = percentChange(prices[0], prices[prices.length - 1])
  const direction: TrendDirection = totalChangePct >= 0 ? "long" : "short"
  const directionSign = direction === "long" ? 1 : -1
  const positionCostRatio = Math.abs(totalChangePct) / positionCostPct
  const minChangeRatio = Math.max(0, Number(config.minChangeRatio ?? 1))
  if (positionCostRatio < minChangeRatio) return null

  const oneMinuteChanges: number[] = []
  for (let index = 1; index < prices.length; index++) {
    oneMinuteChanges.push(percentChange(prices[index - 1], prices[index]))
  }
  const alignedMoves = oneMinuteChanges.filter((change) => change * directionSign > 0).length
  const continuationAgreement = alignedMoves / Math.max(1, oneMinuteChanges.length)
  const minAgreement = clamp(Number(config.minAgreement ?? DEFAULT_TREND_MIN_AGREEMENT), 0, 1)
  if (continuationAgreement < minAgreement) return null

  const averageOneMinuteChangePct = calculateAverageOneMinuteChangePct(prices)
  if (averageOneMinuteChangePct <= 0) return null

  const recentMoveCount = Math.max(1, Math.ceil(timeframeMinutes / 3))
  const recentStartIndex = Math.max(0, prices.length - 1 - recentMoveCount)
  const lastSituationPct = percentChange(prices[recentStartIndex], prices[prices.length - 1])
  const activeMarketChangePct = oneMinuteChanges[oneMinuteChanges.length - 1] || 0
  if (lastSituationPct * directionSign <= 0 || activeMarketChangePct * directionSign <= 0) return null

  // Normalize the recent cumulative move to a per-minute value before
  // comparing it to the average, so 30-minute configs are not automatically
  // favoured over 1-minute configs merely because their window is longer.
  const lastSituationRatio =
    Math.abs(lastSituationPct) / recentMoveCount / averageOneMinuteChangePct
  const activeSituationRatio = Math.abs(activeMarketChangePct) / averageOneMinuteChangePct
  const requiredLastRatio = Math.max(0, Number(config.lastSituationRatio) || 0)
  const requiredActiveRatio = Math.max(0, Number(config.activeSituationRatio) || 0)
  if (lastSituationRatio < requiredLastRatio || activeSituationRatio < requiredActiveRatio) return null

  const adverseDrawdownPct = calculateAdverseDrawdownPct(prices, direction)
  const adverseDrawdownFactor = adverseDrawdownPct / positionCostPct
  const configuredDrawdownFactor = Math.min(-0.000001, Number(config.drawdownFactor) || -1)
  if (adverseDrawdownFactor < configuredDrawdownFactor) return null

  const normalizedOverall = Math.min(positionCostRatio / Math.max(1, minChangeRatio), 8) / 8
  const normalizedLast = Math.min(lastSituationRatio / Math.max(requiredLastRatio, 0.25), 2) / 2
  const normalizedActive = Math.min(activeSituationRatio / Math.max(requiredActiveRatio, 0.25), 2) / 2
  const drawdownQuality = clamp(1 - Math.abs(adverseDrawdownFactor / configuredDrawdownFactor), 0, 1)
  const confidence = clamp(
    0.2 +
      continuationAgreement * 0.3 +
      normalizedOverall * 0.2 +
      normalizedLast * 0.1 +
      normalizedActive * 0.1 +
      drawdownQuality * 0.1,
    0,
    1,
  )
  const signalScore = 1 +
    positionCostRatio * 0.08 +
    continuationAgreement * 0.35 +
    Math.min(lastSituationRatio, 2) * 0.12 +
    Math.min(activeSituationRatio, 2) * 0.12 +
    drawdownQuality * 0.15

  return {
    direction,
    signalScore: round(signalScore),
    confidence: round(confidence),
    metadata: {
      timeframeMinutes,
      direction,
      totalChangePct: round(totalChangePct),
      positionCostPct: round(positionCostPct),
      positionCostRatio: round(positionCostRatio),
      averageOneMinuteChangePct: round(averageOneMinuteChangePct),
      continuationAgreement: round(continuationAgreement),
      adverseDrawdownPct: round(adverseDrawdownPct),
      adverseDrawdownFactor: round(adverseDrawdownFactor),
      configuredDrawdownFactor: round(configuredDrawdownFactor),
      lastSituationPct: round(lastSituationPct),
      lastSituationRatio: round(lastSituationRatio),
      configuredLastSituationRatio: round(requiredLastRatio),
      activeMarketChangePct: round(activeMarketChangePct),
      activeSituationRatio: round(activeSituationRatio),
      configuredActiveSituationRatio: round(requiredActiveRatio),
    },
  }
}

/**
 * Build the adaptive TP-factor ladder used by Trend Base pseudo positions.
 *
 * Example: average 1-minute change / PositionCost = 3, min multiplier = 2
 * gives a calculated minimum factor of 6. With max=10 and step=1 the ladder
 * is [6, 7, 8, 9, 10].
 */
export function buildAdaptiveTrendTpRange(input: {
  pricesOldestFirst: number[]
  positionCostPct: number
  minMultiplier?: number
  maxFactor?: number
  step?: number
  averageWindowMinutes?: number
}): AdaptiveTrendTpRange {
  const positionCostPct = Math.max(0.000001, Number(input.positionCostPct) || 0.1)
  const minMultiplier = Math.max(0.1, Number(input.minMultiplier) || DEFAULT_TREND_TP_MIN_MULTIPLIER)
  const maxFactor = Math.max(0.1, Number(input.maxFactor) || DEFAULT_TREND_TP_MAX_FACTOR)
  const step = Math.max(0.01, Number(input.step) || DEFAULT_TREND_TP_STEP)
  const averageWindowMinutes = Math.max(1, Math.round(Number(input.averageWindowMinutes) || 30))
  const prices = finitePositivePrices(input.pricesOldestFirst).slice(-(averageWindowMinutes + 1))
  const averageOneMinuteChangePct = calculateAverageOneMinuteChangePct(prices)
  const marketChangePositionCostRatio = averageOneMinuteChangePct / positionCostPct
  const calculatedMinFactor = marketChangePositionCostRatio * minMultiplier
  const steppedMin = Math.ceil((calculatedMinFactor - Number.EPSILON) / step) * step
  const appliedMinFactor = round(Math.min(maxFactor, Math.max(step, steppedMin)))

  const factors: number[] = []
  if (appliedMinFactor >= maxFactor) {
    factors.push(round(maxFactor))
  } else {
    for (let value = appliedMinFactor; value <= maxFactor + Number.EPSILON; value += step) {
      factors.push(round(Math.min(value, maxFactor)))
    }
    if (factors[factors.length - 1] !== round(maxFactor)) factors.push(round(maxFactor))
  }

  return {
    factors: Array.from(new Set(factors)),
    averageOneMinuteChangePct: round(averageOneMinuteChangePct),
    positionCostPct: round(positionCostPct),
    marketChangePositionCostRatio: round(marketChangePositionCostRatio),
    calculatedMinFactor: round(calculatedMinFactor),
    appliedMinFactor,
    maxFactor: round(maxFactor),
    step: round(step),
    minMultiplier: round(minMultiplier),
  }
}
