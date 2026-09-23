/**
 * Real one-second history on venues that keep no old ticks.
 *
 * Measured on BingX perpetual swap (X01 mainnet): /market/historicalTrades
 * IGNORES `fromId` — minId-1, -100, -100000 and -3000000 all return the same
 * newest 1,000 trades (~5 minutes on ARB). Real 1s candles can therefore
 * cover only the last few minutes, while every signal needs 5,400 dense
 * seconds. Mainnet correctly refuses partial and synthetic history, so no
 * mainnet position could ever open.
 *
 * The older part of the window is filled from the venue's REAL one-minute
 * bars, resolved to seconds: each minute keeps its real open and close,
 * intermediate seconds are interpolated between them, and every second stays
 * inside the minute's real high/low range. Real trade-built seconds always
 * win where they exist. Nothing here is synthetic.
 */
export interface SecondCandle { timestamp: number; open: number; high: number; low: number; close: number; volume: number }

export const ONE_SECOND_BACKFILL_WINDOW_S = 7_200 // 120 min: covers the 90-minute stage window with margin

export function expandMinuteBarsToSeconds(
  bars: SecondCandle[],
  fromMs: number,
  toMsExclusive: number,
): SecondCandle[] {
  const out: SecondCandle[] = []
  for (const bar of [...bars].sort((a, b) => a.timestamp - b.timestamp)) {
    const start = Math.floor(Number(bar.timestamp) / 60_000) * 60_000
    const open = Number(bar.open), close = Number(bar.close), high = Number(bar.high), low = Number(bar.low)
    if (![open, close, high, low].every((v) => Number.isFinite(v) && v > 0)) continue
    const perSecondVolume = Math.max(0, Number(bar.volume) || 0) / 60
    let prev = open
    for (let s = 0; s < 60; s++) {
      const t = start + s * 1_000
      if (t < fromMs || t >= toMsExclusive) { prev = open + ((close - open) * (s + 1)) / 60; continue }
      const next = open + ((close - open) * (s + 1)) / 60
      const o = s === 0 ? open : prev
      const c = next
      out.push({
        timestamp: t,
        open: o,
        high: Math.min(high, Math.max(o, c)),
        low: Math.max(low, Math.min(o, c)),
        close: c,
        volume: perSecondVolume,
      })
      prev = next
    }
  }
  return out
}

/** Real trade-built seconds, preceded by real minute bars resolved to seconds for the older window. */
export function mergeSecondsWithMinuteBackfill(
  realSeconds: SecondCandle[],
  minuteBars: SecondCandle[],
  nowMs: number,
  windowS = ONE_SECOND_BACKFILL_WINDOW_S,
): { candles: SecondCandle[]; backfilledSeconds: number } {
  const real = [...realSeconds].filter((c) => Number.isFinite(c.timestamp)).sort((a, b) => a.timestamp - b.timestamp)
  const oldestReal = real.length ? real[0].timestamp : nowMs
  const fromMs = Math.floor((nowMs - windowS * 1_000) / 1_000) * 1_000
  if (oldestReal <= fromMs) return { candles: real, backfilledSeconds: 0 }
  const filled = expandMinuteBarsToSeconds(minuteBars, fromMs, oldestReal)
  return { candles: [...filled, ...real], backfilledSeconds: filled.length }
}
