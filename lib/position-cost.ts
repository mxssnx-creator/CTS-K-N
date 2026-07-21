/** Canonical exchange position-cost settings, expressed as UI percent values. */
export const POSITION_COST_PERCENT_MIN = 0.02
export const POSITION_COST_PERCENT_MAX = 1
export const POSITION_COST_PERCENT_DEFAULT = 0.1

export function normalizePositionCostPercent(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return POSITION_COST_PERCENT_DEFAULT
  return Math.max(POSITION_COST_PERCENT_MIN, Math.min(POSITION_COST_PERCENT_MAX, parsed))
}
