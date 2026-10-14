/**
 * The functional overview's stage figures are a basket snapshot: the sum of
 * the last-observed per-symbol stage rows (strategy_detail:{id}:{stage}),
 * kept up to 24 h with their freshness reported in `stageSnapshots`. They are
 * not "this cycle" counts. A stage without any observed row has no snapshot
 * yet, which is shown as missing instead of 0.
 */
export type OverviewStage = "base" | "main" | "real" | "live"

type Json = Record<string, any> | null | undefined

const COUNT_FIELD: Record<OverviewStage, string> = {
  base: "baseStrategies",
  main: "mainStrategies",
  real: "realStrategies",
  live: "liveStrategies",
}

export function stageSnapshotCount(overview: Json, stage: OverviewStage): number | null {
  const snapshot = overview?.stageSnapshots?.[stage]
  const coveredSymbols = Number(snapshot?.coveredSymbols)
  if (!snapshot || !Number.isFinite(coveredSymbols) || coveredSymbols <= 0) return null
  const count = Number(overview?.counts?.[COUNT_FIELD[stage]])
  return Number.isFinite(count) ? Math.max(0, count) : null
}

/** Freshly observed vs retained symbol rows of a stage, e.g. "3/4 fresh". */
export function stageSnapshotFreshness(overview: Json, stage: OverviewStage): string | null {
  const snapshot = overview?.stageSnapshots?.[stage]
  const covered = Number(snapshot?.coveredSymbols)
  const fresh = Number(snapshot?.freshSymbols)
  if (!Number.isFinite(covered) || covered <= 0 || !Number.isFinite(fresh)) return null
  return `${fresh}/${covered} fresh`
}
