import { POSITION_COST_PERCENT_DEFAULT } from "./position-cost"
import { normalizeTradeDirection } from "./trade-direction"
import {
  MAIN_TRADE_PF_RATIO_BASE,
  mainTradePfRatioToSignedResultR,
  MAIN_TRADE_PF_RATIO_MAX,
} from "./main-trade-profit-factor"

export const POSITION_COST_PCT_DEFAULT = POSITION_COST_PERCENT_DEFAULT

export type TradeDirection = "long" | "short" | string

export interface CostNormalizedAggregate {
  profitFactor: number
  grossPositiveR: number
  grossNegativeR: number
  avgSignedR: number
  avgPositiveR: number
  avgNegativeR: number
  netR: number
  winRate: number
  count: number
}

function finiteNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

export function calculatePriceMovePct(
  entryPrice: number,
  exitPrice: number,
  direction: TradeDirection,
): number {
  const entry = finiteNumber(entryPrice)
  const exit = finiteNumber(exitPrice)
  if (entry <= 0 || exit <= 0) return 0
  const normalizedDirection = normalizeTradeDirection(direction)
  if (!normalizedDirection) return Number.NaN

  const rawMovePct = ((exit - entry) / entry) * 100
  return normalizedDirection === "short" ? -rawMovePct : rawMovePct
}

export function calculateSignedResultR(
  entryPrice: number,
  exitPrice: number,
  direction: TradeDirection,
  positionCostPct = POSITION_COST_PCT_DEFAULT,
): number {
  const costPct = finiteNumber(positionCostPct, POSITION_COST_PCT_DEFAULT)
  if (costPct <= 0) return 0
  // A result is admitted to PF/DDT only after the position is closed.  The
  // position-cost percentage is a realised close cost, not merely a unit used
  // to scale the move: deduct it once before expressing the net result in R.
  return (calculatePriceMovePct(entryPrice, exitPrice, direction) - costPct) / costPct
}

function resultToSignedR(result: unknown): number | null {
  if (typeof result === "number") return Number.isFinite(result) ? result : null
  if (!result || typeof result !== "object") return null

  const record = result as Record<string, unknown>
  const direct = record.signedResultR ?? record.avgSignedR ?? record.costNormalizedReturn ?? record.netR
  if (direct !== undefined) {
    const numeric = Number(direct)
    return Number.isFinite(numeric) ? numeric : null
  }

  const direction = normalizeTradeDirection(record.direction, record.side)
  if (!direction) return null

  return calculateSignedResultR(
    finiteNumber(record.entryPrice ?? record.entry_price),
    finiteNumber(record.exitPrice ?? record.exit_price ?? record.currentPrice ?? record.current_price),
    direction,
    finiteNumber(record.positionCostPct ?? record.position_cost_pct ?? record.positionCost ?? record.position_cost, POSITION_COST_PCT_DEFAULT),
  )
}

/**
 * Resolve a pseudo-position result without guessing from the overloaded
 * legacy `profit_factor` field. A `0.6 R` result is a gain, whereas a
 * Main-stage coordinate of `1.06` represents the same gain. The explicit
 * signed fields always win; tagged coordinates are converted deliberately.
 */
export function resolvePseudoPositionSignedResultR(position: unknown): number {
  const record = asRecord(position)
  for (const value of [
    record.signedResultR,
    record.signed_result_r,
    record.costNormalizedReturn,
    record.netR,
  ]) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
  }

  const legacyValue = Number(record.profit_factor ?? record.profitFactor)
  if (!Number.isFinite(legacyValue)) return 0
  const kind = String(
    record.profit_factor_kind ?? record.profitFactorKind ?? record.profitFactorSource ?? "",
  ).trim().toLowerCase()
  if (["main_trade_pf_ratio", "main-stage-ratio", "position_cost_ratio"].includes(kind)) {
    // The operator coordinate begins at 1.00. Older ledgers occasionally
    // wrote an untagged signed Result-R such as 0.6 together with the newer
    // coordinate tag. Treat that impossible tagged 0.x value as the neutral
    // 1.00 coordinate instead of manufacturing a negative result from it.
    // A stored measurement is not an operator setting.  In particular, the
    // exact 1.00 coordinate is neutral and must remain neutral even though
    // the selectable stage-gate minimum is now 1.02.  Only impossible legacy
    // sub-1 coordinates are treated as neutral; valid measured coordinates
    // are kept continuous and capped at the calculation safety ceiling.
    const measuredCoordinate = legacyValue >= 1
      ? Math.min(MAIN_TRADE_PF_RATIO_MAX, legacyValue)
      : 1
    return mainTradePfRatioToSignedResultR(measuredCoordinate)
  }
  // Untagged compatibility pseudo rows historically stored signed Result-R.
  return legacyValue
}

/**
 * Convert a pseudo-position's semantic Result-R into its configured monetary
 * PositionCost basis. This avoids treating a ratio below one as a loss.
 */
export function resolvePseudoPositionNetPnl(position: unknown): number {
  const record = asRecord(position)
  const positionCost = finiteNumber(
    record.position_cost ?? record.positionCost ?? record.margin_used ?? record.marginUsd,
  )
  return resolvePseudoPositionSignedResultR(record) * positionCost
}

export function aggregateCostNormalizedResults(results: unknown[]): CostNormalizedAggregate {
  const signedResults = results
    .map(resultToSignedR)
    .filter((value): value is number => value !== null && Number.isFinite(value))
  const count = signedResults.length
  const positives = signedResults.filter((value) => value > 0)
  const negatives = signedResults.filter((value) => value < 0)
  const grossPositiveR = positives.reduce((sum, value) => sum + value, 0)
  const grossNegativeR = Math.abs(negatives.reduce((sum, value) => sum + value, 0))
  const netR = signedResults.reduce((sum, value) => sum + value, 0)

  return {
    profitFactor: grossNegativeR > 0 ? grossPositiveR / grossNegativeR : grossPositiveR > 0 ? 999 : 0,
    grossPositiveR,
    grossNegativeR,
    avgSignedR: count > 0 ? netR / count : 0,
    avgPositiveR: positives.length > 0 ? grossPositiveR / positives.length : 0,
    avgNegativeR: negatives.length > 0 ? negatives.reduce((sum, value) => sum + value, 0) / negatives.length : 0,
    netR,
    winRate: count > 0 ? positives.length / count : 0,
    count,
  }
}
