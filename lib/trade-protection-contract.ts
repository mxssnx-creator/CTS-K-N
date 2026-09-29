/**
 * Shared percentage protection contract.
 *
 * All strategy families eventually express their bracket distances as market
 * percentages.  Keeping the fallback and SL/TP relation here prevents a
 * legacy/imported row from reaching an execution boundary without a stop or
 * with an unbounded stop relative to its target.
 */

export const MAX_STOP_LOSS_TO_TAKE_PROFIT_RATIO = 1.5
/**
 * Live results on 2026-09-29 (52 settled X01 rows, 14 on X02): every row ran
 * TP 0.333 % against SL 0.5 % — the 0.5 % stop floor raised the stop and the
 * 1.5x cap set the target to 0.5/1.5, a reward/risk of 0.67 that no signal
 * quality can carry once the 0.26 % round trip is paid (net +0.07 on a win,
 * -0.76 on a loss; 33 % wins, PF 0.44). The Real stage had evaluated the same
 * Sets with adaptive targets of 2-10x PositionCost and their own stops.
 *
 * One rule keeps the executed bracket comparable to the evaluated one: when
 * the stop is raised by a floor, the requested target is raised by the same
 * factor, so the Set's reward/risk survives the floor. The 1.5x cap on the
 * stop is unchanged (Sets with a wide stop and a high win rate are legitimate:
 * the stable baseline runs TP 0.5 % / SL 2.0 % at 95 % wins).
 */
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
  // The floor raised the stop: raise the REQUESTED target by the same factor
  // so the requested reward/risk survives (this only ever raises the target).
  const floorFactor = requested > 0 && stopLossPct > requested ? stopLossPct / requested : 1
  const requestedTarget = requestedTakeProfit ?? fallbackTakeProfit ?? takeProfitPct
  const scaledTakeProfitPct = Math.max(
    takeProfitPct,
    Number((requestedTarget * floorFactor).toFixed(6)),
  )

  return {
    takeProfitPct: scaledTakeProfitPct,
    stopLossPct,
    stopLossToTakeProfitRatio: scaledTakeProfitPct > 0 ? stopLossPct / scaledTakeProfitPct : 0,
    stopLossMissing,
    stopLossCapped: stopLossPct !== requested,
    takeProfitDefaulted,
  }
}
