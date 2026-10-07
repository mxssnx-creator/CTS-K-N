/**
 * When a live-trading connection judges a strategy Set on its settled real
 * exchange results instead of its simulated history (lib/live-set-outcomes.ts).
 * Dependency-free so the Settings UI and the API can share it.
 */

/** Operator decision 2026-10-06: from a Set's third settled real close on. */
export const DEFAULT_LIVE_OUTCOME_MIN_CLOSES = 3
export const LIVE_OUTCOME_MIN_CLOSES_MIN = 1
export const LIVE_OUTCOME_MIN_CLOSES_MAX = 25

export function normalizeLiveOutcomeMinCloses(
  value: unknown,
  fallback = DEFAULT_LIVE_OUTCOME_MIN_CLOSES,
): number {
  if (value === undefined || value === null || value === "") return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(LIVE_OUTCOME_MIN_CLOSES_MIN, Math.min(LIVE_OUTCOME_MIN_CLOSES_MAX, Math.round(n)))
}
