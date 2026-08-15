export interface MaterializableStrategyRow {
  setKey?: unknown
  parentSetKey?: unknown
  rowSourceSetKey?: unknown
  rowEvaluationKey?: unknown
  accumulatedSetKeys?: unknown
  _hasLivePositions?: unknown
  rowStage?: unknown
  variant?: unknown
  indicationType?: unknown
  direction?: unknown
  combinedPosCounts?: unknown
  signalRisk?: { sourceId?: unknown } | null
}

export interface StrategyRealMaterializationResult<T> {
  rows: T[]
  ceiling: number
  qualifiedBeforeLimit: number
  activeRowsPreserved: number
  familiesPreserved: number
  truncatedRows: number
}

function normalizedKey(value: unknown): string {
  return String(value || "").trim()
}

/**
 * True only when this exact executable row (or one of its explicit combined
 * members) owns active exposure. A shared Base parent does not make every
 * derived sibling active; treating it that way would preserve an entire
 * 50k-row axis graph for one open position and defeat the memory guard.
 */
export function strategyRowHasActiveExposure(
  row: MaterializableStrategyRow,
  activeSetKeys: ReadonlySet<string>,
): boolean {
  if (row._hasLivePositions === true) return true

  const exactKeys = [
    row.setKey,
    row.rowSourceSetKey,
    row.rowEvaluationKey,
    ...(Array.isArray(row.accumulatedSetKeys) ? row.accumulatedSetKeys : []),
  ]
  if (exactKeys.some((value) => {
    const key = normalizedKey(value)
    return key.length > 0 && activeSetKeys.has(key)
  })) return true

  // Legacy direct Base rows can own a parent-only position. Derived rows must
  // match an exact source/evaluation identity so an active Base does not make
  // all of its Position-Count/Block/DCA children appear active.
  const setKey = normalizedKey(row.setKey)
  const hasDerivedIdentity =
    setKey.includes("#") ||
    normalizedKey(row.rowSourceSetKey).length > 0 ||
    normalizedKey(row.rowEvaluationKey).length > 0
  const parentSetKey = normalizedKey(row.parentSetKey)
  return !hasDerivedIdentity && parentSetKey.length > 0 && activeSetKeys.has(parentSetKey)
}

function materializationFamily(row: MaterializableStrategyRow): string {
  const rowStage = normalizedKey(row.rowStage)
  const stage = rowStage ? `row:${rowStage}` : "source:real"
  const variant = row.combinedPosCounts === true
    ? "position_count"
    : normalizedKey(row.variant) || "default"
  const indication = normalizedKey(row.indicationType) || "unknown"
  const direction = normalizedKey(row.direction) || "unknown"
  const sourceId = normalizedKey(row.signalRisk?.sourceId)
  return [stage, variant, indication, direction, sourceId].join("|")
}

/**
 * Bound only the Real rows retained for downstream materialisation. The
 * caller performs the complete Main -> Real evaluation first and keeps its
 * logical/raw counters separately. A non-positive ceiling is unlimited.
 *
 * Rows arrive quality-sorted. We retain every exact active row, then fill the
 * remaining budget with the best inactive rows while preserving input order.
 * If active exposure alone exceeds the ceiling, all active rows survive and
 * the result may intentionally exceed the configured budget.
 */
export function limitRealRowsForMaterialization<T extends MaterializableStrategyRow>(
  rows: T[],
  rawCeiling: number,
  activeSetKeys: ReadonlySet<string>,
): StrategyRealMaterializationResult<T> {
  const ceiling = Number.isFinite(rawCeiling)
    ? Math.max(0, Math.floor(rawCeiling))
    : 0
  if (ceiling <= 0 || rows.length <= ceiling) {
    return {
      rows,
      ceiling,
      qualifiedBeforeLimit: rows.length,
      activeRowsPreserved: rows.filter((row) => strategyRowHasActiveExposure(row, activeSetKeys)).length,
      familiesPreserved: 0,
      truncatedRows: 0,
    }
  }

  const activeRows = new Set<T>()
  for (const row of rows) {
    if (strategyRowHasActiveExposure(row, activeSetKeys)) activeRows.add(row)
  }

  const inactiveBudget = Math.max(0, ceiling - activeRows.size)
  const selectedInactive = new Set<T>()
  const representedFamilies = new Set<string>()

  // Reserve the best (first, because input is quality-sorted) row from every
  // processing family before filling by global PF rank. This prevents a wide
  // Position-Count family from crowding Row-Real, Signal, Block, DCA, or one
  // direction entirely out of a bounded diagnostic run.
  for (const row of rows) {
    if (activeRows.has(row) || selectedInactive.size >= inactiveBudget) continue
    const family = materializationFamily(row)
    if (representedFamilies.has(family)) continue
    representedFamilies.add(family)
    selectedInactive.add(row)
  }

  for (const row of rows) {
    if (activeRows.has(row)) continue
    if (selectedInactive.size >= inactiveBudget) break
    selectedInactive.add(row)
  }

  const selected = rows.filter((row) => activeRows.has(row) || selectedInactive.has(row))
  return {
    rows: selected,
    ceiling,
    qualifiedBeforeLimit: rows.length,
    activeRowsPreserved: activeRows.size,
    familiesPreserved: representedFamilies.size,
    truncatedRows: rows.length - selected.length,
  }
}
