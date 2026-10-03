export const STOP_LOSS_RATIO_MIN = 0.25
export const STOP_LOSS_RATIO_MAX = 2.5
export const STOP_LOSS_RATIO_STEP = 0.25
export const DEFAULT_MAX_STOP_LOSS_RATIO = STOP_LOSS_RATIO_MAX

export function normalizeMaxStopLossRatio(value: unknown, fallback = DEFAULT_MAX_STOP_LOSS_RATIO): number {
  const raw = Number(value)
  const base = Number.isFinite(raw) ? raw : fallback
  const clamped = Math.max(STOP_LOSS_RATIO_MIN, Math.min(STOP_LOSS_RATIO_MAX, base))
  const snapped = Math.round(clamped / STOP_LOSS_RATIO_STEP) * STOP_LOSS_RATIO_STEP
  return Number(Math.max(STOP_LOSS_RATIO_MIN, Math.min(STOP_LOSS_RATIO_MAX, snapped)).toFixed(2))
}

/**
 * The operator's lowest SL ratio (2026-10-03: "SL ratio ab 1.2"). Kept exactly as given (not snapped to the 0.25 grid) and
 * bounded to the ratio range; missing or invalid means the full range from 0.25.
 */
export const DEFAULT_MIN_STOP_LOSS_RATIO = STOP_LOSS_RATIO_MIN
export function normalizeMinStopLossRatio(value: unknown, fallback = DEFAULT_MIN_STOP_LOSS_RATIO): number {
  if (value === undefined || value === null || value === "") return fallback
  const raw = Number(value)
  if (!Number.isFinite(raw)) return fallback
  return Number(Math.max(STOP_LOSS_RATIO_MIN, Math.min(STOP_LOSS_RATIO_MAX, raw)).toFixed(2))
}
/** SL ratios from the minimum (exactly) in 0.25 steps up to the maximum: min 1.2, max 2.5 gives 1.2 1.45 1.7 1.95 2.2 2.45. */
export function buildStopLossRatios(maxRatio: unknown = DEFAULT_MAX_STOP_LOSS_RATIO, minRatio: unknown = DEFAULT_MIN_STOP_LOSS_RATIO): number[] {
  const max = normalizeMaxStopLossRatio(maxRatio)
  const min = normalizeMinStopLossRatio(minRatio)
  if (min > max + 1e-9) return [min]
  const ratios: number[] = []
  for (let sl = min; sl <= max + 1e-9; sl += STOP_LOSS_RATIO_STEP) {
    ratios.push(Number(sl.toFixed(2)))
  }
  return ratios
}
