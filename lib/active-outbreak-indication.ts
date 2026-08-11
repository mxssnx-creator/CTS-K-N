/**
 * Deterministic Active/Outbreak indication model.
 *
 * Active is intentionally different from Move and Trend:
 * - Move measures a price displacement in one window.
 * - Active requires a fresh range break whose movement/activity is stronger
 *   than the immediately preceding, equally-sized market window.
 * - Trend remains the final, slower multi-timeframe confirmation family.
 *
 * The module is dependency-free so the historical replay, realtime engine and
 * unit/performance tests execute the exact same causal calculation.
 */

export const DEFAULT_ACTIVE_OUTBREAK_RANGES = [3, 5, 10] as const
export const DEFAULT_ACTIVE_STOP_LOSS_POSITION_COST_RATIOS = [2, 3, 5] as const
export const ACTIVE_MARKET_EXIT_SITUATIONS = [
  "momentum",
  "range_extension",
  "activity_fade",
] as const
export const DEFAULT_ACTIVE_TAKE_PROFIT_MULTIPLIERS = [1.25, 1.5, 1] as const

export type ActiveMarketExitSituation = typeof ACTIVE_MARKET_EXIT_SITUATIONS[number]

export interface ActiveOutbreakProtectionProfile {
  id: string
  stopLossPositionCostRatio: number
  stopLossPct: number
  takeProfitPositionCostRatio: number
  takeProfitPct: number
  takeProfitMultiplier: number
  marketExitSituation: ActiveMarketExitSituation
  orderExitType: "TAKE_PROFIT_MARKET"
  rewardRisk: number
}

export interface ActiveOutbreakMetrics {
  range: number
  direction: "long" | "short"
  signedPriceChangePct: number
  priceChangePct: number
  previousSignedPriceChangePct: number
  currentActivityPct: number
  previousActivityPct: number
  activityRatio: number
  breakoutPct: number
  currentRangePct: number
  previousRangePct: number
  directionalAgreement: number
  tailAgreement: number
  maximumAdverseMovePct: number
  volatilityPct: number
}

export interface ActiveOutbreakSignal {
  direction: "long" | "short"
  confidence: number
  signalScore: number
  rawSignalStrength: number
  metrics: ActiveOutbreakMetrics
  protectionProfiles: ActiveOutbreakProtectionProfile[]
}

export interface ActiveOutbreakInput {
  pricesOldestFirst: readonly number[]
  range: number
  thresholdPct: number
  previousActivityRatio: number
  noiseFilterPct: number
  drawdownRatio: number
  lastPartRatio: number
  factorMultiplier: number
  volatilityWeight: number
  positionCostPct: number
  stopLossPositionCostRatios?: readonly number[]
  takeProfitMultipliers?: readonly number[]
  marketExitSituations?: readonly ActiveMarketExitSituation[]
}

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function rounded(value: number, places = 6): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function percentChange(from: number, to: number): number {
  return from > 0 ? ((to - from) / from) * 100 : 0
}

function rangePercent(values: readonly number[]): number {
  if (values.length === 0) return 0
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  for (const value of values) {
    minimum = Math.min(minimum, value)
    maximum = Math.max(maximum, value)
  }
  const anchor = values[0]
  return anchor > 0 ? ((maximum - minimum) / anchor) * 100 : 0
}

function averageAbsoluteMovement(values: readonly number[]): number {
  if (values.length < 2) return 0
  let total = 0
  let count = 0
  for (let index = 1; index < values.length; index++) {
    const movement = Math.abs(percentChange(values[index - 1], values[index]))
    if (!Number.isFinite(movement)) continue
    total += movement
    count++
  }
  return count > 0 ? total / count : 0
}

function directionAgreement(values: readonly number[], direction: "long" | "short"): number {
  if (values.length < 2) return 0
  let aligned = 0
  for (let index = 1; index < values.length; index++) {
    const movement = values[index] - values[index - 1]
    if ((direction === "long" && movement > 0) || (direction === "short" && movement < 0)) aligned++
  }
  return aligned / Math.max(1, values.length - 1)
}

function maximumAdverseMove(values: readonly number[], direction: "long" | "short"): number {
  if (values.length < 2) return 0
  let favourableExtreme = values[0]
  let maximum = 0
  for (let index = 1; index < values.length; index++) {
    const value = values[index]
    if (direction === "long") {
      favourableExtreme = Math.max(favourableExtreme, value)
      maximum = Math.max(maximum, Math.max(0, -percentChange(favourableExtreme, value)))
    } else {
      favourableExtreme = Math.min(favourableExtreme, value)
      maximum = Math.max(maximum, Math.max(0, percentChange(favourableExtreme, value)))
    }
  }
  return maximum
}

function normalizePositiveList(value: readonly number[] | undefined, fallback: readonly number[]): number[] {
  const source = value?.length ? value : fallback
  return [...new Set(source.map(Number).filter((item) => Number.isFinite(item) && item > 0))]
    .sort((left, right) => left - right)
}

function normalizeOrderedPositiveList(
  value: readonly number[] | undefined,
  fallback: readonly number[],
): number[] {
  const source = value?.length ? value : fallback
  // TP multipliers are positional: index 0 belongs to the first selected
  // market-exit situation, index 1 to the second, and so on. De-duplicate
  // while preserving operator order; sorting here would silently attach the
  // right values to the wrong exit situations.
  return [...new Set(source.map(Number).filter((item) => Number.isFinite(item) && item > 0))]
}

export function normalizeActiveMarketExitSituations(
  value: readonly ActiveMarketExitSituation[] | undefined,
): ActiveMarketExitSituation[] {
  const source = value?.length ? value : ACTIVE_MARKET_EXIT_SITUATIONS
  return [...new Set(source.filter((item): item is ActiveMarketExitSituation =>
    ACTIVE_MARKET_EXIT_SITUATIONS.includes(item as ActiveMarketExitSituation),
  ))]
}

/**
 * Build every configured SL × TP-market-exit profile. Nothing is sampled or
 * capped: each profile receives a stable identity and remains an independent
 * Strategy/Base lane downstream.
 */
export function buildActiveOutbreakProtectionProfiles(input: {
  metrics: Pick<ActiveOutbreakMetrics,
    "priceChangePct" | "currentActivityPct" | "previousActivityPct" | "currentRangePct" | "volatilityPct"
  >
  positionCostPct: number
  volatilityWeight: number
  stopLossPositionCostRatios?: readonly number[]
  takeProfitMultipliers?: readonly number[]
  marketExitSituations?: readonly ActiveMarketExitSituation[]
}): ActiveOutbreakProtectionProfile[] {
  const positionCostPct = clamp(finite(input.positionCostPct, 0.1), 0.02, 1)
  const volatilityWeight = clamp(finite(input.volatilityWeight, 0.3), 0, 1)
  const stopRatios = normalizePositiveList(
    input.stopLossPositionCostRatios,
    DEFAULT_ACTIVE_STOP_LOSS_POSITION_COST_RATIOS,
  )
  const situations = normalizeActiveMarketExitSituations(input.marketExitSituations)
  const multipliers = normalizeOrderedPositiveList(
    input.takeProfitMultipliers,
    DEFAULT_ACTIVE_TAKE_PROFIT_MULTIPLIERS,
  )
  const volatilityRiskPct = Math.max(
    positionCostPct * 2,
    input.metrics.volatilityPct * (0.75 + volatilityWeight * 0.75),
  )

  const profiles: ActiveOutbreakProtectionProfile[] = []
  for (const stopLossPositionCostRatio of stopRatios) {
    const ratioScale = stopLossPositionCostRatio / Math.max(1, stopRatios[0])
    const stopLossPct = clamp(
      Math.max(positionCostPct * stopLossPositionCostRatio, volatilityRiskPct * ratioScale),
      0.2,
      5,
    )

    for (let situationIndex = 0; situationIndex < situations.length; situationIndex++) {
      const marketExitSituation = situations[situationIndex]
      const takeProfitMultiplier = multipliers[situationIndex % multipliers.length]
      const situationBasisPct = marketExitSituation === "momentum"
        ? input.metrics.priceChangePct
        : marketExitSituation === "range_extension"
          ? input.metrics.currentRangePct
          : Math.max(
              input.metrics.currentActivityPct,
              input.metrics.previousActivityPct,
              input.metrics.priceChangePct * 0.65,
            )
      const takeProfitPct = clamp(
        Math.max(
          positionCostPct * 3,
          situationBasisPct * takeProfitMultiplier,
          stopLossPct * 1.1,
        ),
        0.2,
        22,
      )
      const rewardRisk = takeProfitPct / stopLossPct
      profiles.push({
        id:
          `slpc${rounded(stopLossPositionCostRatio, 4)}` +
          `-exit-${marketExitSituation}` +
          `-tpm${rounded(takeProfitMultiplier, 4)}`,
        stopLossPositionCostRatio: rounded(stopLossPositionCostRatio, 4),
        stopLossPct: rounded(stopLossPct),
        takeProfitPositionCostRatio: rounded(takeProfitPct / positionCostPct, 4),
        takeProfitPct: rounded(takeProfitPct),
        takeProfitMultiplier: rounded(takeProfitMultiplier, 4),
        marketExitSituation,
        orderExitType: "TAKE_PROFIT_MARKET",
        rewardRisk: rounded(rewardRisk, 4),
      })
    }
  }
  return profiles
}

export function calculateActiveOutbreak(input: ActiveOutbreakInput): ActiveOutbreakSignal | null {
  const range = Math.max(2, Math.floor(finite(input.range, 10)))
  const prices = input.pricesOldestFirst
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
  // Two complete, non-overlapping windows share only their boundary price.
  const required = range * 2 + 1
  if (prices.length < required) return null
  const sample = prices.slice(-required)
  const previous = sample.slice(0, range + 1)
  const current = sample.slice(range)
  const newest = current[current.length - 1]
  const currentSignedMovePct = percentChange(current[0], newest)
  const priceChangePct = Math.abs(currentSignedMovePct)
  const thresholdPct = Math.max(0.01, finite(input.thresholdPct, 0.5))
  if (priceChangePct + Number.EPSILON < thresholdPct) return null

  const direction: "long" | "short" = currentSignedMovePct >= 0 ? "long" : "short"
  const previousSignedPriceChangePct = percentChange(previous[0], previous[previous.length - 1])
  const previousActivityPct = averageAbsoluteMovement(previous)
  const currentActivityPct = averageAbsoluteMovement(current)
  const activityRatio = currentActivityPct / Math.max(previousActivityPct, 0.000001)
  const minimumActivityRatio = Math.max(0, finite(input.previousActivityRatio, 1))
  if (activityRatio + Number.EPSILON < minimumActivityRatio) return null

  const reference = sample.slice(0, -1)
  const referenceHigh = Math.max(...reference)
  const referenceLow = Math.min(...reference)
  const breakoutPct = direction === "long"
    ? Math.max(0, percentChange(referenceHigh, newest))
    : Math.max(0, -percentChange(referenceLow, newest))
  const noiseFilterPct = Math.max(0, finite(input.noiseFilterPct, 0.05))
  if (breakoutPct + Number.EPSILON < noiseFilterPct) return null

  const directionalAgreement = directionAgreement(current, direction)
  const lastPartRatio = clamp(finite(input.lastPartRatio, 0.5), 0.05, 1)
  const tailSize = Math.max(2, Math.ceil(current.length * lastPartRatio))
  const tailAgreement = directionAgreement(current.slice(-tailSize), direction)
  if (tailAgreement < 0.5) return null

  const maximumAdverseMovePct = maximumAdverseMove(current, direction)
  const drawdownRatio = Math.max(0.1, finite(input.drawdownRatio, 1))
  if (maximumAdverseMovePct > Math.max(noiseFilterPct, priceChangePct * drawdownRatio)) return null

  const currentRangePct = rangePercent(current)
  const previousRangePct = rangePercent(previous)
  const volatilityPct = currentActivityPct
  const volatilityWeight = clamp(finite(input.volatilityWeight, 0.3), 0, 1)
  const factorMultiplier = Math.max(0.1, finite(input.factorMultiplier, 1))
  const normalizedMove = priceChangePct / thresholdPct
  const normalizedBreakout = breakoutPct / Math.max(noiseFilterPct, 0.01)
  const activityAcceleration = Math.max(0, activityRatio - minimumActivityRatio)
  const drawdownPenalty = maximumAdverseMovePct / Math.max(priceChangePct, 0.01)
  const signalScore = Math.max(
    0,
    1 + factorMultiplier * (
      normalizedMove * 0.34 +
      normalizedBreakout * 0.2 +
      activityAcceleration * (0.18 + volatilityWeight * 0.22) +
      directionalAgreement * 0.14 +
      tailAgreement * 0.14
    ) - drawdownPenalty * 0.25,
  )
  const confidence = clamp(
    0.2 +
      Math.min(1, normalizedMove / 2) * 0.25 +
      Math.min(1, normalizedBreakout / 2) * 0.2 +
      Math.min(1, activityRatio / Math.max(1, minimumActivityRatio * 2)) * 0.2 +
      directionalAgreement * 0.1 +
      tailAgreement * 0.05,
    0,
    0.99,
  )
  const metrics: ActiveOutbreakMetrics = {
    range,
    direction,
    signedPriceChangePct: rounded(currentSignedMovePct),
    priceChangePct: rounded(priceChangePct),
    previousSignedPriceChangePct: rounded(previousSignedPriceChangePct),
    currentActivityPct: rounded(currentActivityPct),
    previousActivityPct: rounded(previousActivityPct),
    activityRatio: rounded(activityRatio),
    breakoutPct: rounded(breakoutPct),
    currentRangePct: rounded(currentRangePct),
    previousRangePct: rounded(previousRangePct),
    directionalAgreement: rounded(directionalAgreement),
    tailAgreement: rounded(tailAgreement),
    maximumAdverseMovePct: rounded(maximumAdverseMovePct),
    volatilityPct: rounded(volatilityPct),
  }
  return {
    direction,
    confidence: rounded(confidence),
    signalScore: rounded(signalScore),
    rawSignalStrength: rounded(signalScore),
    metrics,
    protectionProfiles: buildActiveOutbreakProtectionProfiles({
      metrics,
      positionCostPct: input.positionCostPct,
      volatilityWeight,
      stopLossPositionCostRatios: input.stopLossPositionCostRatios,
      takeProfitMultipliers: input.takeProfitMultipliers,
      marketExitSituations: input.marketExitSituations,
    }),
  }
}
