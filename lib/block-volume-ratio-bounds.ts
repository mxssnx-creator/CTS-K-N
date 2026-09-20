/**
 * Canonical bounds for the Block volume ratio and the shared-adjust ratio.
 *
 * Operator setting: the per-Block increase ratio runs 0.1 to 2.0 in steps of
 * 0.1 with a default of 0.2. It was previously clamped to 0.25-3.0 with a
 * default of 1.0, so the low end an operator could configure was unreachable
 * and the default was five times the intended one.
 *
 * The SHARED adjust ratio is a separate knob: when shared adjustment is on,
 * the Block volume is computed once against whatever is currently valid
 * rather than per Set, and that aggregate uses its own, larger default.
 */
export const BLOCK_VOLUME_RATIO_MIN = 0.1
export const BLOCK_VOLUME_RATIO_MAX = 2.0
export const BLOCK_VOLUME_RATIO_STEP = 0.1
export const BLOCK_VOLUME_RATIO_DEFAULT = 0.2

export const BLOCK_SHARED_VOLUME_RATIO_DEFAULT = 1.5

/** Clamp a raw ratio into the configurable range; a non-positive value falls back to the default. */
export function clampBlockVolumeRatio(raw: unknown, fallback = BLOCK_VOLUME_RATIO_DEFAULT): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.max(BLOCK_VOLUME_RATIO_MIN, Math.min(BLOCK_VOLUME_RATIO_MAX, value))
}

/**
 * Shared Block stacking across independent relations ("lanes").
 *
 * With shared adjustment on, the Block increase is not computed per Set but
 * once against whatever is currently valid — and it STACKS ADDITIVELY across
 * the relations the operator enables. Each enabled relation contributes its
 * own count of valid Blocks, and those counts add rather than override or
 * multiply.
 *
 * Why additive: the relations describe genuinely independent exposure. Two
 * valid Blocks on the same symbol in opposite directions are two separate
 * recovery situations, and a multiplicative combination would compound them
 * into a size neither one justifies, while a max() would silently discard one.
 *
 * The relations are suboptions because which ones are independent is an
 * operator judgement about the book, not a property of the code: an operator
 * running one direction per symbol wants `symbol` alone, while one running
 * hedged lanes wants `symbol` and `direction` counted separately.
 */
export type BlockSharedRelation = "symbol" | "direction" | "indication" | "lane"

export const BLOCK_SHARED_RELATIONS: readonly BlockSharedRelation[] = [
  "symbol",
  "direction",
  "indication",
  "lane",
] as const

/**
 * Default relations: symbol and direction.
 *
 * These two are independent in every configuration — a long and a short on the
 * same symbol never share a recovery. `indication` and `lane` are off by
 * default because they subdivide further, and subdividing a relation that is
 * not actually independent inflates the stack without adding information.
 */
export const BLOCK_SHARED_RELATIONS_DEFAULT: readonly BlockSharedRelation[] = [
  "symbol",
  "direction",
] as const

/** Normalize an operator's relation selection, preserving order and dropping unknowns. */
export function normalizeBlockSharedRelations(raw: unknown): BlockSharedRelation[] {
  const values = Array.isArray(raw)
    ? raw
    : String(raw ?? "").split(",")
  const seen = new Set<BlockSharedRelation>()
  for (const value of values) {
    const key = String(value ?? "").trim().toLowerCase() as BlockSharedRelation
    if (BLOCK_SHARED_RELATIONS.includes(key)) seen.add(key)
  }
  // An empty or unrecognised selection falls back to the default rather than
  // disabling stacking silently — "no relations" would mean "never stack",
  // which is a different setting (shared adjustment off).
  return seen.size > 0 ? [...seen] : [...BLOCK_SHARED_RELATIONS_DEFAULT]
}

/** One relation's contribution: how many valid Blocks it currently carries. */
export interface BlockSharedLaneCount {
  relation: BlockSharedRelation
  /** Distinct keys within this relation that hold at least one valid Block. */
  validCount: number
}

/**
 * Additive stack across the enabled relations.
 *
 * Returns the combined count and the multiplier it produces. A relation the
 * operator did not enable contributes nothing, and a relation with no valid
 * Blocks contributes nothing — so the multiplier degrades to the base 1.0
 * rather than to zero when nothing is stacking.
 */
export function stackBlockSharedLanes(
  lanes: readonly BlockSharedLaneCount[],
  enabled: readonly BlockSharedRelation[],
  sharedRatio: number = BLOCK_SHARED_VOLUME_RATIO_DEFAULT,
): { totalValid: number; multiplier: number; contributions: BlockSharedLaneCount[] } {
  const active = new Set(enabled)
  const contributions = lanes.filter((lane) =>
    active.has(lane.relation) && Number(lane.validCount) > 0)
  const totalValid = contributions.reduce((sum, lane) => sum + Math.max(0, Math.floor(Number(lane.validCount) || 0)), 0)
  const ratio = Number(sharedRatio) > 0 ? Number(sharedRatio) : BLOCK_SHARED_VOLUME_RATIO_DEFAULT
  return {
    totalValid,
    // Base 1.0 plus the additive stack: no valid Blocks means no increase,
    // never a zero-size order.
    multiplier: 1 + totalValid * ratio,
    contributions,
  }
}
