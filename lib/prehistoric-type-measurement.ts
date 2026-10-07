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
