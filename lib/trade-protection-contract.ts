/**
 * Shared percentage protection contract.
 *
 * All strategy families eventually express their bracket distances as market
 * percentages.  Keeping the fallback and SL/TP relation here prevents a
 * legacy/imported row from reaching an execution boundary without a stop or
 * with an unbounded stop relative to its target.
 */

export const MAX_STOP_LOSS_TO_TAKE_PROFIT_RATIO = 1.5
export const MIN_PROTECTION_PERCENT = 0.01
export const DEFAULT_PROTECTION_TAKE_PROFIT_PERCENT = 0.1

export interface NormalizedProtectionPercentages {
  takeProfitPct: number
  stopLossPct: number
  stopLossToTakeProfitRatio: number
  stopLossMissing: boolean
  stopLossCapped: boolean
  takeProfitDefaulted: boolean
}

function finitePositive(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * Normalize one TP/SL pair without changing a valid TP.
 *
 * A missing SL defaults to one TP distance, which is positive and safely
 * inside the 1.5 maximum.  The minimums are applied before the cap is
 * calculated so the returned pair always satisfies both `SL > 0` and
 * `SL / TP <= maxRatio`.
 */
export function normalizeProtectionPercentages(input: {
  takeProfitPct?: unknown
  stopLossPct?: unknown
  fallbackTakeProfitPct?: unknown
  fallbackStopLossPct?: unknown
  minimumTakeProfitPct?: unknown
  minimumStopLossPct?: unknown
  maxStopLossToTakeProfitRatio?: unknown
}): NormalizedProtectionPercentages {
  const maxRatioCandidate = Number(input.maxStopLossToTakeProfitRatio)
  const maxRatio = Number.isFinite(maxRatioCandidate) && maxRatioCandidate > 0
    ? maxRatioCandidate
    : MAX_STOP_LOSS_TO_TAKE_PROFIT_RATIO
  const minimumStopCandidate = Number(input.minimumStopLossPct)
  const minimumStopLossPct = Number.isFinite(minimumStopCandidate) && minimumStopCandidate > 0
    ? minimumStopCandidate
    : MIN_PROTECTION_PERCENT
  const minimumTakeCandidate = Number(input.minimumTakeProfitPct)
  const minimumTakeProfitPct = Number.isFinite(minimumTakeCandidate) && minimumTakeCandidate > 0
    ? minimumTakeCandidate
    : DEFAULT_PROTECTION_TAKE_PROFIT_PERCENT
  const requestedTakeProfit = finitePositive(input.takeProfitPct)
  const fallbackTakeProfit = finitePositive(input.fallbackTakeProfitPct)
  const takeProfitDefaulted = requestedTakeProfit === null && fallbackTakeProfit === null
  const takeProfitPct = Math.max(
    minimumTakeProfitPct,
    minimumStopLossPct / maxRatio,
    requestedTakeProfit ?? fallbackTakeProfit ?? DEFAULT_PROTECTION_TAKE_PROFIT_PERCENT,
  )
  const requestedStopLoss = finitePositive(input.stopLossPct)
  const fallbackStopLoss = finitePositive(input.fallbackStopLossPct)
  const stopLossMissing = requestedStopLoss === null && fallbackStopLoss === null
  const requested = requestedStopLoss ?? fallbackStopLoss ?? takeProfitPct
  const maximumStopLossPct = takeProfitPct * maxRatio
  const stopLossPct = Math.max(
    minimumStopLossPct,
    Math.min(maximumStopLossPct, requested),
  )

  return {
    takeProfitPct,
    stopLossPct,
    stopLossToTakeProfitRatio: takeProfitPct > 0 ? stopLossPct / takeProfitPct : 0,
    stopLossMissing,
    stopLossCapped: stopLossPct !== requested,
    takeProfitDefaulted,
  }
}
