import { POSITION_COST_PERCENT_DEFAULT } from "./position-cost"

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

export function calculatePriceMovePct(
  entryPrice: number,
  exitPrice: number,
  direction: TradeDirection,
): number {
  const entry = finiteNumber(entryPrice)
  const exit = finiteNumber(exitPrice)
  if (entry <= 0 || exit <= 0) return 0

  const rawMovePct = ((exit - entry) / entry) * 100
  return String(direction).toLowerCase() === "short" ? -rawMovePct : rawMovePct
}

export function calculateSignedResultR(
  entryPrice: number,
  exitPrice: number,
  direction: TradeDirection,
  positionCostPct = POSITION_COST_PCT_DEFAULT,
): number {
  const costPct = finiteNumber(positionCostPct, POSITION_COST_PCT_DEFAULT)
  if (costPct <= 0) return 0
  return calculatePriceMovePct(entryPrice, exitPrice, direction) / costPct
}

function resultToSignedR(result: unknown): number {
  if (typeof result === "number") return finiteNumber(result)
  if (!result || typeof result !== "object") return 0

  const record = result as Record<string, unknown>
  const direct = record.signedResultR ?? record.avgSignedR ?? record.costNormalizedReturn ?? record.netR
  if (direct !== undefined) return finiteNumber(direct)

  return calculateSignedResultR(
    finiteNumber(record.entryPrice ?? record.entry_price),
    finiteNumber(record.exitPrice ?? record.exit_price ?? record.currentPrice ?? record.current_price),
    String(record.direction ?? record.side ?? "long"),
    finiteNumber(record.positionCostPct ?? record.position_cost_pct ?? record.positionCost ?? record.position_cost, POSITION_COST_PCT_DEFAULT),
  )
}

export function aggregateCostNormalizedResults(results: unknown[]): CostNormalizedAggregate {
  const signedResults = results.map(resultToSignedR).filter(Number.isFinite)
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
