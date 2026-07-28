/**
 * Main Position-Count coordination control.
 *
 * The operator slider is a coordination ratio, not the direct per-Set volume
 * multiplier.  The requested anchor is:
 *
 *   ratio 10.0 -> 0.02 × Base volume per valid Position-Count Set
 *
 * Every valid Set contributes independently, so 300 valid Sets at ratio 10
 * coordinate to 300 × 0.02 = 6.0 Base-volume units before the normal exchange
 * minimum-volume floor is applied.
 */

export const POS_COUNT_VOLUME_RATIO_MIN = 0.1
export const POS_COUNT_VOLUME_RATIO_MAX = 10
export const POS_COUNT_VOLUME_RATIO_STEP = 0.1
export const POS_COUNT_VOLUME_RATIO_DEFAULT = 3
export const POS_COUNT_VOLUME_MULTIPLIER_AT_MAX = 0.02

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals
  return Math.round((value + Number.EPSILON) * factor) / factor
}

export function normalizePosCountVolumeRatio(
  value: unknown,
  fallback = POS_COUNT_VOLUME_RATIO_DEFAULT,
): number {
  const parsed = Number(value)
  const parsedFallback = Number(fallback)
  const safeFallback = Number.isFinite(parsedFallback)
    ? Math.max(POS_COUNT_VOLUME_RATIO_MIN, Math.min(POS_COUNT_VOLUME_RATIO_MAX, parsedFallback))
    : POS_COUNT_VOLUME_RATIO_DEFAULT
  const clamped = Number.isFinite(parsed)
    ? Math.max(POS_COUNT_VOLUME_RATIO_MIN, Math.min(POS_COUNT_VOLUME_RATIO_MAX, parsed))
    : safeFallback
  const steps = Math.round(
    (clamped - POS_COUNT_VOLUME_RATIO_MIN) / POS_COUNT_VOLUME_RATIO_STEP,
  )
  return round(
    Math.min(
      POS_COUNT_VOLUME_RATIO_MAX,
      POS_COUNT_VOLUME_RATIO_MIN + steps * POS_COUNT_VOLUME_RATIO_STEP,
    ),
    1,
  )
}

/** Convert the operator ratio into the direct volume multiplier of one Set. */
export function posCountVolumeRatioToSetMultiplier(value: unknown): number {
  return round(
    normalizePosCountVolumeRatio(value) *
      (POS_COUNT_VOLUME_MULTIPLIER_AT_MAX / POS_COUNT_VOLUME_RATIO_MAX),
    8,
  )
}

export function calculatePosCountCoordinatedVolume(
  validSetCount: unknown,
  ratio: unknown,
): number {
  const count = Math.max(0, Math.floor(Number(validSetCount) || 0))
  return round(count * posCountVolumeRatioToSetMultiplier(ratio), 8)
}
