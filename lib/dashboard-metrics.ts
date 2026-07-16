/**
 * Small, shared normalisers for values rendered by dashboard status cards.
 *
 * Redis counters are updated by several workers and a read can briefly observe
 * one side of a ratio before the other.  UI surfaces must never render NaN,
 * Infinity, negative counters, or percentages outside 0..100 while that
 * distributed state converges.
 */
export function finiteMetric(value: unknown, fallback = 0): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

export function nonNegativeMetric(value: unknown): number {
  return Math.max(0, finiteMetric(value))
}

export function boundedPercentage(value: unknown): number {
  return Math.max(0, Math.min(100, finiteMetric(value)))
}

export function boundedPassedCount(passed: unknown, evaluated: unknown): number {
  const evaluatedCount = nonNegativeMetric(evaluated)
  return Math.min(nonNegativeMetric(passed), evaluatedCount)
}

export function boundedRatioPercentage(numerator: unknown, denominator: unknown): number {
  const denominatorCount = nonNegativeMetric(denominator)
  if (denominatorCount <= 0) return 0
  const ratio = (nonNegativeMetric(numerator) / denominatorCount) * 100
  return Math.round(boundedPercentage(ratio) * 10) / 10
}
