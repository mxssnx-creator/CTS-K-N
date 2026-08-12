export type MainOpenBreakdownKind =
  | "standard"
  | "trailing"
  | "positionCount"
  | "block"
  | "dca"

export interface MainStageRelationLike {
  setKey?: string
  parentSetKey?: string
  rowSourceSetKey?: string
  rowEvaluationKey?: string
  variant?: string
  trailingProfile?: unknown
  axisWindows?: { direction?: string; axisKey?: string }
  combinedPosCounts?: boolean
  posCountsTargetFlat?: boolean
  posCountsVolumeRatio?: number
}

function lineageCandidates(set: MainStageRelationLike): string[] {
  const values = [
    set.setKey,
    set.parentSetKey,
    set.rowSourceSetKey,
    set.rowEvaluationKey,
  ]
  const candidates = new Set<string>()
  for (const raw of values) {
    const value = String(raw || "").trim()
    if (!value) continue
    candidates.add(value)
    const base = value.split("#")[0]
    if (base) candidates.add(base)
  }
  return [...candidates]
}

/**
 * Main rows reuse the open Base position instead of owning another pseudo
 * position. A derived row is therefore open when any canonical lineage key
 * resolves to the active Base ledger, not only when its derived setKey does.
 */
export function mainSetHasOpenLineage(
  set: MainStageRelationLike,
  activeKeys: ReadonlySet<string>,
): boolean {
  return lineageCandidates(set).some((key) => activeKeys.has(key))
}

/**
 * Mutually-exclusive Main Overall classification. Priority is intentional:
 * position-count and adjustment rows can inherit a trailing Base profile, but
 * each materialised Main row must contribute to exactly one displayed bucket.
 */
export function classifyMainOpenSet(set: MainStageRelationLike): MainOpenBreakdownKind {
  const hasPositionCountIdentity =
    set.combinedPosCounts === true ||
    set.posCountsTargetFlat === true ||
    set.posCountsVolumeRatio !== undefined ||
    Boolean(set.axisWindows?.direction || set.axisWindows?.axisKey)
  if (hasPositionCountIdentity) return "positionCount"

  const variant = String(set.variant || "default").toLowerCase()
  if (variant === "block") return "block"
  if (variant === "dca") return "dca"
  if (variant === "trailing" || set.trailingProfile) return "trailing"
  return "standard"
}

export function countOpenMainBreakdown(
  sets: readonly MainStageRelationLike[],
  activeKeys: ReadonlySet<string>,
): Record<MainOpenBreakdownKind, number> {
  const result: Record<MainOpenBreakdownKind, number> = {
    standard: 0,
    trailing: 0,
    positionCount: 0,
    block: 0,
    dca: 0,
  }
  for (const set of sets) {
    if (!mainSetHasOpenLineage(set, activeKeys)) continue
    result[classifyMainOpenSet(set)]++
  }
  return result
}
