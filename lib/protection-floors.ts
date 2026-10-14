/**
 * System-wide protection floors (operator instruction 2026-09-27, both 0.5 %;
 * raised by operator instruction 2026-10-06):
 *   - minimum stop-loss distance        0.6 %
 *   - minimum trailing-stop distance    0.6 %
 *
 * Floors only ever RAISE a distance. A configured/derived value that is
 * already wider is left unchanged, and a pre-existing higher lane floor
 * (for example the Signal dynamic trailing floor of 0.8 %) stays in force.
 * Percent units: 0.5 = 0.5 %.
 */
export const DEFAULT_MIN_STOP_LOSS_PCT = 0.6
export const DEFAULT_MIN_TRAILING_STOP_DISTANCE_PCT = 0.6
/** The defaults before 2026-10-06; a stored value equal to these is migrated to the new defaults. */
export const PREVIOUS_DEFAULT_PROTECTION_FLOOR_PCT = 0.5
export const PROTECTION_FLOOR_MIN_PCT = 0.05
export const PROTECTION_FLOOR_MAX_PCT = 10

export const PROTECTION_FLOOR_KEYS = ["minStopLossPct", "minTrailingStopDistancePct"] as const
export type ProtectionFloorKey = (typeof PROTECTION_FLOOR_KEYS)[number]

export type ProtectionFloors = {
  minStopLossPct: number
  minTrailingStopDistancePct: number
}

export const DEFAULT_PROTECTION_FLOORS: Readonly<ProtectionFloors> = Object.freeze({
  minStopLossPct: DEFAULT_MIN_STOP_LOSS_PCT,
  minTrailingStopDistancePct: DEFAULT_MIN_TRAILING_STOP_DISTANCE_PCT,
})

export function normalizeProtectionFloorPct(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(PROTECTION_FLOOR_MIN_PCT, Math.min(PROTECTION_FLOOR_MAX_PCT, n))
}

/** Returns one human-readable error per invalid floor key present in `input`. */
export function validateProtectionFloorInput(input: Record<string, unknown> | null | undefined): string[] {
  const errors: string[] = []
  if (!input || typeof input !== "object") return errors
  for (const key of PROTECTION_FLOOR_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    const raw = input[key]
    const n = typeof raw === "string" && raw.trim() === "" ? Number.NaN : Number(raw)
    if (!Number.isFinite(n) || n < PROTECTION_FLOOR_MIN_PCT || n > PROTECTION_FLOOR_MAX_PCT) {
      errors.push(`${key} must be a number between ${PROTECTION_FLOOR_MIN_PCT} and ${PROTECTION_FLOOR_MAX_PCT} (percent)`)
    }
  }
  return errors
}

export function resolveProtectionFloors(settings: Record<string, any> | null | undefined): ProtectionFloors {
  const raw = settings && typeof settings === "object" ? settings : {}
  return {
    minStopLossPct: normalizeProtectionFloorPct(
      raw.minStopLossPct ?? raw.min_stop_loss_pct,
      DEFAULT_MIN_STOP_LOSS_PCT,
    ),
    minTrailingStopDistancePct: normalizeProtectionFloorPct(
      raw.minTrailingStopDistancePct ?? raw.min_trailing_stop_distance_pct,
      DEFAULT_MIN_TRAILING_STOP_DISTANCE_PCT,
    ),
  }
}

const globalFloors = globalThis as typeof globalThis & { __ctsProtectionFloors?: ProtectionFloors }

/** Process-wide floors for the Main/Preset/Direct execution boundary. */
export function getActiveProtectionFloors(): ProtectionFloors {
  return globalFloors.__ctsProtectionFloors ?? { ...DEFAULT_PROTECTION_FLOORS }
}

export function setActiveProtectionFloors(settings: Record<string, any> | null | undefined): ProtectionFloors {
  const floors = resolveProtectionFloors(settings)
  globalFloors.__ctsProtectionFloors = floors
  return floors
}

/** Raise a stop-loss percent to the floor; never lowers a wider stop. */
export function applyStopLossFloorPct(stopLossPct: number, floorPct = getActiveProtectionFloors().minStopLossPct): number {
  const n = Number(stopLossPct)
  return Number.isFinite(n) ? Math.max(floorPct, n) : floorPct
}

/** Raise a trailing distance percent to the floor; never lowers a wider distance. */
export function applyTrailingDistanceFloorPct(
  distancePct: number,
  floorPct = getActiveProtectionFloors().minTrailingStopDistancePct,
): number {
  const n = Number(distancePct)
  return Number.isFinite(n) ? Math.max(floorPct, n) : floorPct
}

/** Ratio variant (1 = 100 %) used by trailing profiles. */
export function applyTrailingDistanceFloorRatio(
  distanceRatio: number,
  floorPct = getActiveProtectionFloors().minTrailingStopDistancePct,
): number {
  return applyTrailingDistanceFloorPct(Number(distanceRatio) * 100, floorPct) / 100
}
