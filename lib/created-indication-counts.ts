export const CREATED_INDICATION_TYPES = ["direction", "move", "active", "active_advanced", "special", "optimal", "auto", "common", "signal", "trend"] as const

/** Created-record counts only. Evaluated candidates are a different unit. */
export async function readCreatedIndicationCounts(redis: any, connectionId: string, progression: Record<string, any>): Promise<Record<string, number>> {
  const types = new Set<string>(CREATED_INDICATION_TYPES)
  for (const field of Object.keys(progression)) {
    if (field.startsWith("indications_") && field.endsWith("_count") && field !== "indications_count") {
      types.add(field.slice("indications_".length, -"_count".length))
    }
  }
  const counts: Record<string, number> = {}
  await Promise.all([...types].map(async (type) => {
    const standalone = typeof redis.get === "function"
      ? await Promise.resolve(redis.get(`indications:${connectionId}:${type}:count`)).catch(() => null)
      : null
    const field = `indications_${type}_count`
    if (standalone == null && !(field in progression)) return
    const value = Number(standalone ?? progression[field])
    counts[type] = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  }))
  return counts
}

/** Refresh all projections of this population while the full graph is cached. */
export function overlayCreatedIndicationCounts(body: Record<string, any>, counts: Record<string, number>): void {
  body.indicationsByType = counts
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  for (const [type, publicKey] of [...new Set([...CREATED_INDICATION_TYPES, ...Object.keys(counts)])]
    .map(type => [type, type === "active_advanced" ? "activeAdvanced" : type])) {
    const count = counts[type] ?? 0
    if (body.breakdown?.indications) body.breakdown.indications[publicKey] = count
    if (body.activeProgressing?.indications?.[publicKey]) body.activeProgressing.indications[publicKey].trackings = count
    if (body.mainIndications?.types?.[publicKey]) body.mainIndications.types[publicKey].trackings = count
  }
  if (body.breakdown?.indications) body.breakdown.indications.total = total
  if (body.activeProgressing?.indications?.total) body.activeProgressing.indications.total.trackings = total
  if (body.mainIndications?.totals) {
    body.mainIndications.totals.trackings = Object.values(body.mainIndications.types || {})
      .reduce((sum: number, row: any) => sum + Number(row.trackings || 0), 0)
  }
}
