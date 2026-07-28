function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function deepMerge(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    if (isPlainObject(value) && isPlainObject(output[key])) {
      output[key] = deepMerge(output[key] as Record<string, unknown>, value)
    } else {
      // Arrays represent ordered operator selections and are replaced as one
      // atomic value; concatenating them resurrects stale symbols/profiles.
      output[key] = Array.isArray(value) ? [...value] : value
    }
  }
  return output
}

/** Deep-merge partial connection saves while keeping legacy aliases identical. */
export function mergeConnectionSettings<T extends Record<string, any>>(
  current: T | null | undefined,
  incoming: Record<string, any> | null | undefined,
): T & Record<string, any> {
  const merged = deepMerge(current || {}, incoming || {}) as T & Record<string, any>
  const mutable = merged as Record<string, any>
  const coordination = isPlainObject(mutable.coordination_settings)
    ? mutable.coordination_settings
    : isPlainObject(mutable.coordinationSettings)
      ? mutable.coordinationSettings
      : undefined
  if (coordination) {
    mutable.coordination_settings = coordination
    mutable.coordinationSettings = coordination
  }
  // Normalize the pos-count coordination ratio at the canonical merge point so
  // an out-of-range value can never reach the persisted connection settings,
  // the recoordinator re-merge, or the nested coordination object. The ratio
  // it stays on the exact [0.1, 10] step-0.1 grid wherever it is stored.
  const clampPcvr = (value: unknown): number | undefined => {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return undefined
    return normalizePosCountVolumeRatio(n, POS_COUNT_VOLUME_RATIO_DEFAULT)
  }
  const clampedTop = clampPcvr(mutable.posCountsVolumeRatio)
  if (clampedTop !== undefined) mutable.posCountsVolumeRatio = clampedTop
  if (coordination && Number(mutable.coordination_settings?.posCountsVolumeRatio) > 0) {
    const clampedNested = clampPcvr(mutable.coordination_settings.posCountsVolumeRatio)
    if (clampedNested !== undefined) mutable.coordination_settings.posCountsVolumeRatio = clampedNested
  }
  return merged
}
import {
  normalizePosCountVolumeRatio,
  POS_COUNT_VOLUME_RATIO_DEFAULT,
} from "@/lib/pos-count-volume-ratio"
