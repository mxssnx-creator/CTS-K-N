/**
 * Logical stage accounting for the strategy pipeline.
 *
 * Position-count projections deliberately fan one Base configuration out into
 * many physical axis rows. Those rows all remain independently calculated and
 * retain their exact volume ratios, but they are one related Main evaluation
 * for their Base lineage. Keeping logical and physical counts separate avoids
 * presenting Cartesian fan-out as unrelated strategy evaluations.
 */

export type StageAccountingSet = {
  setKey?: unknown
  parentSetKey?: unknown
  variant?: unknown
  axisWindows?: { direction?: unknown } | null
  posCountsVolumeRatio?: unknown
  combinedPosCounts?: unknown
  posCountsTargetFlat?: unknown
}

export type LogicalStageAccounting = {
  /** Base-lineage inputs evaluated by the stage. */
  baseInputs: number
  /** One logical related set per Base lineage with Pos-Count projections. */
  positionCountRelated: number
  /** Other distinct Main/Real projections, such as DCA. */
  otherRelated: number
  /** Public logical evaluation count: base + Pos-Count + other projections. */
  logicalEvaluated: number
  /** Physical rows materialized/evaluated by the runtime. */
  rawMaterialized: number
  /** Number of Base mirrors present in the physical runtime graph. */
  baseMirrors: number
}

function finiteCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim()
}

function parentKey(set: StageAccountingSet): string {
  const explicit = text(set.parentSetKey)
  if (explicit) return explicit
  const key = text(set.setKey)
  return key.split("#axis:")[0] || key
}

function isPositionCountProjection(set: StageAccountingSet): boolean {
  if (set.combinedPosCounts === true || set.posCountsTargetFlat === true) return true
  // The explicit ratio is the canonical Pos-Count marker.  Directional axis
  // metadata is retained as a compatibility fallback for a zero/flat legacy
  // projection.  Do not key this on `variant`: a trailing Base projection can
  // still be a Pos-Count child, while DCA/Block rows deliberately have no
  // Pos-Count ratio.
  const ratio = Number(set.posCountsVolumeRatio)
  if (Number.isFinite(ratio) && ratio > 0) return true
  return set.posCountsVolumeRatio !== undefined && Boolean(set.axisWindows?.direction)
}

function isBaseMirror(set: StageAccountingSet, parent: string): boolean {
  if (isPositionCountProjection(set)) return false
  const key = text(set.setKey)
  return key === parent || key === `${parent}#default`
}

/**
 * Count the Main stage from the Base input it actually evaluated. A Base
 * parent with 320 valid axis rows contributes exactly one Pos-Count related
 * evaluation; every raw row remains represented in `rawMaterialized`.
 */
export function accountMainStage(
  baseInputs: number,
  sets: readonly StageAccountingSet[],
): LogicalStageAccounting {
  const axisParents = new Set<string>()
  const additional = new Set<string>()
  const mirrors = new Set<string>()

  for (const set of sets) {
    const parent = parentKey(set)
    if (isPositionCountProjection(set)) {
      if (parent) axisParents.add(parent)
      continue
    }
    if (isBaseMirror(set, parent)) {
      if (parent) mirrors.add(parent)
      continue
    }
    const key = text(set.setKey) || `${parent}\u0000${text(set.variant) || "related"}`
    additional.add(key)
  }

  const base = finiteCount(baseInputs)
  return {
    baseInputs: base,
    positionCountRelated: axisParents.size,
    otherRelated: additional.size,
    logicalEvaluated: base + axisParents.size + additional.size,
    rawMaterialized: sets.length,
    baseMirrors: mirrors.size,
  }
}

/**
 * Count the logical Main inputs which actually reached Real evaluation.
 * Unlike Main, this stage has no independently supplied Base denominator, so
 * the Base-mirror lineages are derived from the physical input rows.
 */
export function accountRealStageInputs(
  sets: readonly StageAccountingSet[],
): LogicalStageAccounting {
  const axisParents = new Set<string>()
  const additional = new Set<string>()
  const mirrors = new Set<string>()

  for (const set of sets) {
    const parent = parentKey(set)
    if (isPositionCountProjection(set)) {
      if (parent) axisParents.add(parent)
      continue
    }
    if (isBaseMirror(set, parent)) {
      if (parent) mirrors.add(parent)
      continue
    }
    const key = text(set.setKey) || `${parent}\u0000${text(set.variant) || "related"}`
    additional.add(key)
  }

  return {
    baseInputs: mirrors.size,
    positionCountRelated: axisParents.size,
    otherRelated: additional.size,
    logicalEvaluated: mirrors.size + axisParents.size + additional.size,
    rawMaterialized: sets.length,
    baseMirrors: mirrors.size,
  }
}
