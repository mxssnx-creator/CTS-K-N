/** Canonical exchange position-cost settings, expressed as UI percent values. */
export const POSITION_COST_PERCENT_MIN = 0.02
export const POSITION_COST_PERCENT_MAX = 1
export const POSITION_COST_PERCENT_DEFAULT = 0.1
// Fresh TP set grids start at five PositionCost multiples throughout every
// engine. Existing explicitly saved lower grids remain readable as legacy
// configurations; this is a default, not a destructive migration rule.
export const DEFAULT_TAKE_PROFIT_POSITION_COST_RATIO = 5
// Fresh set generators use this sparse, capacity-safe Cartesian axis. It is
// intentionally separate from legacy read compatibility: previously saved
// lower or denser TP factors remain valid when explicitly selected.
export const DEFAULT_TAKE_PROFIT_POSITION_COST_STEPS = [5, 10, 15, 20] as const

export function normalizePositionCostPercent(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return POSITION_COST_PERCENT_DEFAULT
  return Math.max(POSITION_COST_PERCENT_MIN, Math.min(POSITION_COST_PERCENT_MAX, parsed))
}

/**
 * Converts a configuration-set TP coordinate into a market-price percent.
 *
 * Configuration `takeprofit_factor` values are PositionCost multiples, not
 * literal market percents: factor 5 at a 0.10% PositionCost means a 0.50%
 * gross price move.  Live/signal protections remain explicit `*Pct` values
 * and deliberately do not pass through this converter.
 */
export function takeProfitPositionCostRatioToPercent(
  positionCostPercent: unknown,
  positionCostRatio: unknown,
): number {
  const ratio = Number(positionCostRatio)
  if (!Number.isFinite(ratio) || ratio <= 0) return 0
  return normalizePositionCostPercent(positionCostPercent) * ratio
}

/**
 * Converts the configured `TP-ratio × SL-to-TP-ratio` coordinate into a
 * market-price percent.  It is the paired counterpart of the TP converter
 * above and prevents one engine from treating the same set axis as a raw
 * percentage while another treats it as a PositionCost multiple.
 */
export function stopLossPositionCostRatioToPercent(
  positionCostPercent: unknown,
  takeProfitPositionCostRatio: unknown,
  stopLossToTakeProfitRatio: unknown,
): number {
  const takeProfitRatio = Number(takeProfitPositionCostRatio)
  const stopLossRatio = Number(stopLossToTakeProfitRatio)
  if (
    !Number.isFinite(takeProfitRatio) || takeProfitRatio <= 0 ||
    !Number.isFinite(stopLossRatio) || stopLossRatio <= 0
  ) return 0
  return takeProfitPositionCostRatioToPercent(
    positionCostPercent,
    takeProfitRatio * stopLossRatio,
  )
}
