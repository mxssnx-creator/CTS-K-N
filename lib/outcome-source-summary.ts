/**
 * Where a stage's Set results came from, as the coordinator last published it
 * in `strategy_detail:<conn>:<stage>` (StrategyCoordinator.noteOutcomeSources):
 * Sets judged only on settled exchange results, and Sets that already have real
 * closes but fewer than the switch-over count. Dependency-free so routes and
 * client components can share it.
 */
export interface OutcomeSourceSummary {
  /** Distinct Sets judged on their exchange-only result ring in the last window. */
  exchangeJudged: number
  /** Sets with at least one but fewer than `minCloses` settled real closes. */
  exchangePending: number
  /** Settled real closes from which a Set is judged on exchange results. */
  minCloses: number
  updatedAt: number
  /** False once the figure is older than the freshness budget (engine stopped, paper mode). */
  fresh: boolean
}

/** Published every 30 s while the connection trades live; 5 minutes tolerate a slow cycle. */
export const OUTCOME_SOURCE_FRESH_MS = 5 * 60_000

export function summarizeOutcomeSource(
  hash: Record<string, string> | null | undefined,
  now: number = Date.now(),
  maxAgeMs: number = OUTCOME_SOURCE_FRESH_MS,
): OutcomeSourceSummary | null {
  if (!hash) return null
  const updatedAt = Number(hash.outcome_source_ts)
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null
  const count = (value: unknown) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
  }
  return {
    exchangeJudged: count(hash.exchange_judged_sets),
    exchangePending: count(hash.exchange_pending_sets),
    minCloses: count(hash.exchange_min_closes),
    updatedAt,
    fresh: now - updatedAt <= maxAgeMs,
  }
}
