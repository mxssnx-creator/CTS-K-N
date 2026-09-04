/**
 * Freshness budget for one complete Base → Main → Row-Real → Row-Live pass.
 *
 * A fixed five-minute TTL is shorter than an exhaustive high-load pass over a
 * large basket. Earlier symbols then expired while later symbols were still
 * being evaluated, so an otherwise healthy 128-symbol run could never publish
 * a complete card snapshot. The budget scales with the selected basket while
 * staying bounded; stopped engines still zero current-open values separately.
 */
export const STAGE_ROW_SNAPSHOT_MIN_FRESH_MS = 5 * 60_000
export const STAGE_ROW_SNAPSHOT_PER_SYMBOL_MS = 15_000
export const STAGE_ROW_SNAPSHOT_MAX_FRESH_MS = 45 * 60_000

export function resolveStageRowSnapshotFreshMs(expectedSymbols: unknown): number {
  const parsed = Number(expectedSymbols)
  const symbols = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1
  return Math.min(
    STAGE_ROW_SNAPSHOT_MAX_FRESH_MS,
    Math.max(
      STAGE_ROW_SNAPSHOT_MIN_FRESH_MS,
      2 * 60_000 + symbols * STAGE_ROW_SNAPSHOT_PER_SYMBOL_MS,
    ),
  )
}
