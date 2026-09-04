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

export interface MainOpenAccounting {
  included: Record<MainOpenBreakdownKind, number>
  blockCalculated: number
  overall: number
}

/**
 * Convert exhaustive Main calculations into the public open-row accounting.
 *
 * Main Valid is a parent-lineage count. Main Overall is that lineage baseline
 * plus independently included descendants. A Block row is additive in normal
 * mode, but replaces its parent for physical execution in Block-Only mode and
 * therefore must not inflate Overall. Some cycles can materialise only a Block
 * child for a valid lineage, so the standard bucket is topped up to preserve
 * the invariant Valid <= Overall while keeping the five displayed buckets
 * mutually exclusive and exactly summing to Overall.
 */
export function resolveMainOpenAccounting(
  calculated: Readonly<Record<MainOpenBreakdownKind, number>>,
  validOpen: number,
  blockOnlyEnabled: boolean,
): MainOpenAccounting {
  const nonNegative = (value: unknown): number => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
  }
  const included: Record<MainOpenBreakdownKind, number> = {
    standard: nonNegative(calculated.standard),
    trailing: nonNegative(calculated.trailing),
    positionCount: nonNegative(calculated.positionCount),
    block: blockOnlyEnabled ? 0 : nonNegative(calculated.block),
    dca: nonNegative(calculated.dca),
  }
  const requiredBaseline = nonNegative(validOpen)
  const currentOverall = Object.values(included).reduce((sum, count) => sum + count, 0)
  if (currentOverall < requiredBaseline) {
    included.standard += requiredBaseline - currentOverall
  }
  return {
    included,
    blockCalculated: nonNegative(calculated.block),
    overall: Object.values(included).reduce((sum, count) => sum + count, 0),
  }
}
