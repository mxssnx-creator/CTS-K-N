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

export function buildStopLossRatios(maxRatio: unknown = DEFAULT_MAX_STOP_LOSS_RATIO): number[] {
  const max = normalizeMaxStopLossRatio(maxRatio)
  const ratios: number[] = []
  for (let sl = STOP_LOSS_RATIO_MIN; sl <= max + 1e-9; sl += STOP_LOSS_RATIO_STEP) {
    ratios.push(Number(sl.toFixed(2)))
  }
  return ratios
}
