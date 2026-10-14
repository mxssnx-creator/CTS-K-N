/**
 * Relative Strength Index, Wilder's definition — the one implementation every
 * RSI in the system uses.
 *
 * Seed: the simple mean of the first `period` gains and losses; afterwards
 * Wilder's smoothing (RMA): avg = (avg × (period − 1) + current) / period.
 * RSI = 100 − 100 / (1 + avgGain / avgLoss), with the edge cases defined
 * instead of falling out of a division: no losses and some gains → 100, no
 * gains and some losses → 0, a flat series → 50.
 *
 * Several copies used a plain mean of the last N changes (not Wilder), one
 * summed 13 changes without a period, one returned 99 on a flat market and
 * one returned 0 (a false "oversold") — so the same market produced
 * different RSI values depending on which part of the system looked.
 */
export function wilderRsiSeries(closes: readonly number[], periodInput = 14): number[] {
  const period = Math.max(2, Math.round(periodInput))
  const out = new Array<number>(closes.length).fill(Number.NaN)
  if (closes.length <= period) return out
  let averageGain = 0
  let averageLoss = 0
  for (let index = 1; index <= period; index++) {
    const change = Number(closes[index]) - Number(closes[index - 1])
    if (change > 0) averageGain += change
    else averageLoss -= change
  }
  averageGain /= period
  averageLoss /= period
  const value = () => averageLoss === 0
    ? (averageGain > 0 ? 100 : 50)
    : averageGain === 0 ? 0 : 100 - 100 / (1 + averageGain / averageLoss)
  out[period] = value()
  for (let index = period + 1; index < closes.length; index++) {
    const change = Number(closes[index]) - Number(closes[index - 1])
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period
    out[index] = value()
  }
  return out
}

/** The RSI at the last close, or `fallback` (neutral 50) when the series is too short to seed. */
export function latestWilderRsi(closes: readonly number[], period = 14, fallback = 50): number {
  const series = wilderRsiSeries(closes, period)
  const last = series[series.length - 1]
  return Number.isFinite(last) ? last : fallback
}
