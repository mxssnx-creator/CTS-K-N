/**
 * The prehistoric per-type measurement as the last completed run recorded it
 * (`type_measurement_closes` / `type_measurement_summary` in the prehistoric
 * hash, written by ConfigSetProcessor). These closes seeded the Base gate's
 * (symbol × type × direction) buckets. Dependency-free so routes and reports
 * can share it.
 */
export interface TypeMeasurementBucket {
  closed: number
  wins: number
  losses: number
  netPctSum: number
  /** Mean PositionCost-relative ratio — the coordinate the Base gate compares. */
  positionCostRatio: number | null
}

export interface TypeMeasurement {
  closes: number
  /** Keyed `type:direction`, e.g. `direction:long`. */
  byTypeDirection: Record<string, TypeMeasurementBucket>
}

export function parseTypeMeasurement(hash: Record<string, string> | null | undefined): TypeMeasurement | null {
  if (!hash || hash.type_measurement_closes === undefined) return null
  const closes = Math.max(0, Math.floor(Number(hash.type_measurement_closes) || 0))
  let raw: unknown = {}
  try {
    raw = JSON.parse(String(hash.type_measurement_summary || "{}"))
  } catch {
    raw = {}
  }
  const count = (value: unknown) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
  }
  const byTypeDirection: Record<string, TypeMeasurementBucket> = {}
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, any>)) {
      if (!/^[a-z][a-z_]*:(long|short)$/.test(key) || !value || typeof value !== "object") continue
      const ratio = Number(value.positionCostRatio)
      const net = Number(value.netPctSum)
      byTypeDirection[key] = {
        closed: count(value.closed),
        wins: count(value.wins),
        losses: count(value.losses),
        netPctSum: Number.isFinite(net) ? net : 0,
        positionCostRatio: value.positionCostRatio !== null && Number.isFinite(ratio) ? ratio : null,
      }
    }
  }
  return { closes, byTypeDirection }
}

/**
 * The closes the measurement booked after the prehistoric run (engine
 * heartbeat), from `prehistoric:type_measurement_rolling:<conn>`: counters
 * `n:`, `w:`, `l:` and sums `net:`, `ratio:` per `type:direction`.
 */
export const typeMeasurementRollingKey = (connectionId: string) =>
  `prehistoric:type_measurement_rolling:${connectionId}`

export interface RollingTypeMeasurement extends TypeMeasurement {
  lastAt: number | null
}

export function parseRollingTypeMeasurement(hash: Record<string, string> | null | undefined): RollingTypeMeasurement | null {
  if (!hash || Object.keys(hash).length === 0) return null
  const integer = (value: unknown) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
  }
  const byTypeDirection: Record<string, TypeMeasurementBucket> = {}
  for (const [field, value] of Object.entries(hash)) {
    const match = /^n:([a-z][a-z_]*:(?:long|short))$/.exec(field)
    if (!match) continue
    const bucket = match[1]
    const closed = integer(value)
    if (closed === 0) continue
    const net = Number(hash[`net:${bucket}`])
    const ratioSum = Number(hash[`ratio:${bucket}`])
    byTypeDirection[bucket] = {
      closed,
      wins: integer(hash[`w:${bucket}`]),
      losses: integer(hash[`l:${bucket}`]),
      netPctSum: Number.isFinite(net) ? net : 0,
      positionCostRatio: Number.isFinite(ratioSum) ? ratioSum / closed : null,
    }
  }
  const lastAt = Number(hash.last_at)
  return {
    closes: integer(hash.closes),
    byTypeDirection,
    lastAt: Number.isFinite(lastAt) && lastAt > 0 ? lastAt : null,
  }
}
