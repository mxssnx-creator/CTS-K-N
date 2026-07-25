import {
  DEFAULT_COMMON_COORDINATION_SETTINGS,
  type CommonCoordinationSettings,
} from "@/lib/common-indicator-config"

export type CoordinatedDirection = "long" | "short" | "neutral"

export interface MultiRangeSituation {
  /** Canonical range value. `timeframeMinutes` is retained for compatibility. */
  range: number
  rangeUnit: "minutes" | "samples"
  timeframeMinutes: number
  direction: CoordinatedDirection
  directionChanged: boolean
  directionChangeIndex: number
  postChangeSamples: number
  changePct: number
  positionCostRatio: number
  averageMovePct: number
  activityRatio: number
  adverseDrawdownPct: number
  adverseDrawdownRatio: number
  allowedDrawdownRatio: number
  passedRangeSteps: number[]
  valid: boolean
}

export interface MultiRangeCoordination {
  rangeUnit: "minutes" | "samples"
  direction: CoordinatedDirection
  agreement: number
  activityAgreement: number
  score: number
  passed: boolean
  positionCostPct: number
  minimumSignals: number
  rangeSteps: number[]
  passedRangeSteps: number[]
  situations: MultiRangeSituation[]
}

export const DEFAULT_MAIN_COORDINATION_SETTINGS: CommonCoordinationSettings = {
  enabled: true,
  // Default-indication calculation ranges are candle/sample counts, not
  // Trend/Common minute timeframes. The shared shape keeps the generic
  // coordinator reusable; UI and metadata label these as ranges.
  timeframesMinutes: [2, 5, 10, 20, 30],
  rangeSteps: [2, 2.5, 3],
  drawdownRatios: [1, 1.5, 2],
  higherRangeDrawdownScale: 0.5,
  minAgreement: 0.6,
  minimumSignals: 3,
  shortDifferenceRatio: 0.1,
}

function finitePrices(prices: number[]): number[] {
  return prices.map(Number).filter((price) => Number.isFinite(price) && price > 0)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: number, decimals = 8): number {
  const scale = 10 ** decimals
  return Math.round((value + Number.EPSILON) * scale) / scale
}

function pct(from: number, to: number): number {
  return from > 0 ? ((to - from) / from) * 100 : 0
}

function averageAbsoluteMove(prices: number[]): number {
  if (prices.length < 2) return 0
  let total = 0
  for (let index = 1; index < prices.length; index++) {
    total += Math.abs(pct(prices[index - 1], prices[index]))
  }
  return total / (prices.length - 1)
}

function adverseDrawdown(prices: number[], direction: CoordinatedDirection): number {
  if (prices.length < 2 || direction === "neutral") return 0
  let adverse = 0
  if (direction === "long") {
    let peak = prices[0]
    for (const price of prices) {
      peak = Math.max(peak, price)
      adverse = Math.min(adverse, pct(peak, price))
    }
  } else {
    let trough = prices[0]
    for (const price of prices) {
      trough = Math.min(trough, price)
      adverse = Math.min(adverse, -Math.max(0, pct(trough, price)))
    }
  }
  return adverse
}

function normalizedConfig(
  raw: Partial<CommonCoordinationSettings> | undefined,
  defaults: CommonCoordinationSettings,
): CommonCoordinationSettings {
  const numbers = (
    value: unknown,
    fallback: readonly number[],
    min: number,
    max: number,
  ) => {
    const source = Array.isArray(value) ? value : fallback
    const normalized = [...new Set(source.map(Number).filter(Number.isFinite).map((item) => clamp(item, min, max)))]
    return normalized.length > 0 ? normalized : [...fallback]
  }
  return {
    enabled: raw?.enabled !== false,
    timeframesMinutes: numbers(raw?.timeframesMinutes, defaults.timeframesMinutes, 1, 60)
      .map(Math.round)
      .sort((left, right) => left - right),
    rangeSteps: numbers(raw?.rangeSteps, defaults.rangeSteps, 0.5, 10)
      .sort((left, right) => left - right),
    drawdownRatios: numbers(raw?.drawdownRatios, defaults.drawdownRatios, 0.1, 20)
      .sort((left, right) => left - right),
    higherRangeDrawdownScale: clamp(
      Number(raw?.higherRangeDrawdownScale ?? defaults.higherRangeDrawdownScale),
      0,
      5,
    ),
    minAgreement: clamp(Number(raw?.minAgreement ?? defaults.minAgreement), 0.5, 1),
    minimumSignals: Math.round(clamp(Number(raw?.minimumSignals ?? defaults.minimumSignals), 1, 100)),
    shortDifferenceRatio: clamp(
      Number(raw?.shortDifferenceRatio ?? defaults.shortDifferenceRatio),
      0,
      5,
    ),
  }
}

/**
 * Coordinates ordered windows without replacing any independent indication.
 * Common callers interpret them as minute windows; Default Direction/Move/
 * Active callers interpret them as sample ranges. Every window is normalized
 * to PositionCost, and longer windows receive a configurable wider adverse
 * drawdown allowance.
 */
export function calculateMultiRangeCoordination(input: {
  pricesOldestFirst: number[]
  positionCostPct: number
  config?: Partial<CommonCoordinationSettings>
  /** Evaluate only the newest same-direction regime after the last reversal. */
  requireDirectionChange?: boolean
  /** Common indicators use minutes; default Direction/Move/Active use samples. */
  rangeUnit?: "minutes" | "samples"
}): MultiRangeCoordination {
  const rangeUnit = input.rangeUnit === "samples" ? "samples" : "minutes"
  const config = normalizedConfig(
    input.config,
    rangeUnit === "samples"
      ? DEFAULT_MAIN_COORDINATION_SETTINGS
      : DEFAULT_COMMON_COORDINATION_SETTINGS,
  )
  const prices = finitePrices(input.pricesOldestFirst)
  const positionCostPct = Math.max(0.000001, Number(input.positionCostPct) || 0.1)
  const maximumTimeframe = Math.max(...config.timeframesMinutes, 1)
  const baseDrawdown = Math.max(...config.drawdownRatios)
  const situations: MultiRangeSituation[] = []
  const allMovements = prices.slice(1).map((price, index) => pct(prices[index], price))
  let latestMovementIndex = allMovements.length - 1
  while (
    latestMovementIndex >= 0 &&
    Math.abs(allMovements[latestMovementIndex]) <= Number.EPSILON
  ) {
    latestMovementIndex--
  }
  const latestSign = latestMovementIndex >= 0
    ? Math.sign(allMovements[latestMovementIndex])
    : 0
  let latestDirectionChangeIndex = 0
  let latestDirectionChanged = false
  if (latestSign !== 0) {
    for (let index = latestMovementIndex - 1; index >= 0; index--) {
      const sign = Math.sign(allMovements[index])
      if (sign !== 0 && sign !== latestSign) {
        // movement[index + 1] is the first movement in the new regime, so
        // prices[index + 1] is its correct anchor price.
        latestDirectionChangeIndex = index + 1
        latestDirectionChanged = true
        break
      }
    }
  }
  const latestRegimePrices = latestDirectionChanged
    ? prices.slice(latestDirectionChangeIndex)
    : prices

  for (const timeframeMinutes of config.timeframesMinutes) {
    const calculationPrices = input.requireDirectionChange
      ? latestRegimePrices
      : prices
    const window = calculationPrices.slice(-(timeframeMinutes + 1))
    if (window.length < timeframeMinutes + 1) continue
    const movements = window.slice(1).map((price, index) => pct(window[index], price))
    let windowLatestMovementIndex = movements.length - 1
    while (
      windowLatestMovementIndex >= 0 &&
      Math.abs(movements[windowLatestMovementIndex]) <= Number.EPSILON
    ) {
      windowLatestMovementIndex--
    }
    const windowLatestSign = windowLatestMovementIndex >= 0
      ? Math.sign(movements[windowLatestMovementIndex])
      : 0
    let directionChangeIndex = 0
    let directionChanged = false
    if (input.requireDirectionChange) {
      directionChangeIndex = latestDirectionChangeIndex
      directionChanged = latestDirectionChanged
    } else if (windowLatestSign !== 0) {
      for (let index = windowLatestMovementIndex - 1; index >= 0; index--) {
        const sign = Math.sign(movements[index])
        if (sign !== 0 && sign !== windowLatestSign) {
          directionChangeIndex = index + 1
          directionChanged = true
          break
        }
      }
    }
    // In Direction post-change mode, every relative range is calculated from
    // one shared current regime. A range becomes eligible only after that many
    // same-regime samples have accumulated; no range may cross the reversal.
    const postChangeWindow = window
    const changePct = pct(postChangeWindow[0], postChangeWindow[postChangeWindow.length - 1])
    const effectiveSign = input.requireDirectionChange ? latestSign : windowLatestSign
    const direction: CoordinatedDirection = effectiveSign === 0
      ? "neutral"
      : effectiveSign > 0
        ? "long"
        : "short"
    const positionCostRatio = Math.abs(changePct) / positionCostPct
    const averageMovePct = averageAbsoluteMove(postChangeWindow)
    const latestMovePct = Math.abs(pct(
      postChangeWindow[postChangeWindow.length - 2],
      postChangeWindow[postChangeWindow.length - 1],
    ))
    const activityRatio = averageMovePct > 0 ? latestMovePct / averageMovePct : 0
    const adverseDrawdownPct = adverseDrawdown(postChangeWindow, direction)
    const adverseDrawdownRatio = Math.abs(adverseDrawdownPct) / positionCostPct
    const rangeRelation = timeframeMinutes / maximumTimeframe
    const allowedDrawdownRatio = baseDrawdown * (1 + rangeRelation * config.higherRangeDrawdownScale)
    const passedRangeSteps = config.rangeSteps.filter((step) =>
      positionCostRatio + Number.EPSILON >= step &&
      adverseDrawdownRatio <= allowedDrawdownRatio + Number.EPSILON,
    )
    const valid =
      direction !== "neutral" &&
      (!input.requireDirectionChange || directionChanged) &&
      positionCostRatio >= config.shortDifferenceRatio &&
      adverseDrawdownRatio <= allowedDrawdownRatio + Number.EPSILON
    situations.push({
      range: timeframeMinutes,
      rangeUnit,
      timeframeMinutes,
      direction,
      directionChanged,
      directionChangeIndex,
      postChangeSamples: postChangeWindow.length,
      changePct: round(changePct),
      positionCostRatio: round(positionCostRatio),
      averageMovePct: round(averageMovePct),
      activityRatio: round(activityRatio),
      adverseDrawdownPct: round(adverseDrawdownPct),
      adverseDrawdownRatio: round(adverseDrawdownRatio),
      allowedDrawdownRatio: round(allowedDrawdownRatio),
      passedRangeSteps,
      valid,
    })
  }

  const valid = situations.filter((situation) => situation.valid)
  const longWeight = valid
    .filter((situation) => situation.direction === "long")
    .reduce((sum, situation) => sum + Math.sqrt(situation.timeframeMinutes), 0)
  const shortWeight = valid
    .filter((situation) => situation.direction === "short")
    .reduce((sum, situation) => sum + Math.sqrt(situation.timeframeMinutes), 0)
  const totalWeight = longWeight + shortWeight
  const direction: CoordinatedDirection = totalWeight === 0
    ? "neutral"
    : longWeight === shortWeight
      ? "neutral"
      : longWeight > shortWeight
        ? "long"
        : "short"
  const dominantWeight = Math.max(longWeight, shortWeight)
  const agreement = totalWeight > 0 ? dominantWeight / totalWeight : 0
  const dominant = valid.filter((situation) => situation.direction === direction)
  const activityAgreement = dominant.length > 0
    ? dominant.filter((situation) => situation.activityRatio >= 0.5).length / dominant.length
    : 0
  const passedRangeSteps = config.rangeSteps.filter((step) =>
    dominant.filter((situation) => situation.passedRangeSteps.includes(step)).length >=
      Math.max(1, Math.ceil(dominant.length * config.minAgreement)),
  )
  const averageCostRatio = dominant.length > 0
    ? dominant.reduce((sum, situation) => sum + situation.positionCostRatio, 0) / dominant.length
    : 0
  const score = clamp(
    agreement * 0.45 +
      activityAgreement * 0.2 +
      Math.min(1, averageCostRatio / Math.max(config.rangeSteps[0] || 1, 0.5)) * 0.25 +
      Math.min(1, passedRangeSteps.length / Math.max(1, config.rangeSteps.length)) * 0.1,
    0,
    1,
  )
  const passed =
    config.enabled &&
    direction !== "neutral" &&
    dominant.length >= Math.min(config.minimumSignals, config.timeframesMinutes.length) &&
    agreement >= config.minAgreement &&
    passedRangeSteps.length > 0

  return {
    rangeUnit,
    direction,
    agreement: round(agreement),
    activityAgreement: round(activityAgreement),
    score: round(score),
    passed,
    positionCostPct: round(positionCostPct),
    minimumSignals: config.minimumSignals,
    rangeSteps: config.rangeSteps,
    passedRangeSteps,
    situations,
  }
}
