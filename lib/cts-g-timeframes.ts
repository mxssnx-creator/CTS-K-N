export interface CtsGMinuteClose { timestamp: number; close: number }
export const CTS_G_HISTORY_MINUTES = 1_440

function timestampMs(raw: unknown): number {
  const numeric = Number(raw)
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric
  return typeof raw === "string" ? Date.parse(raw) : NaN
}

/** Compact real candles without making synthetic prices for missing minutes. */
export function compactCtsGMinuteCloses(candles: readonly any[]): CtsGMinuteClose[] {
  const byMinute = new Map<number, { timestamp: number; close: number }>()
  for (const candle of candles) {
    const timestamp = timestampMs(candle?.timestamp ?? candle?.time ?? candle?.t)
    const close = Number(candle?.close ?? candle?.c ?? candle?.price)
    if (!Number.isFinite(timestamp) || !Number.isFinite(close) || close <= 0) continue
    const minute = Math.floor(timestamp / 60_000) * 60_000
    if (timestamp >= (byMinute.get(minute)?.timestamp ?? -Infinity)) byMinute.set(minute, { timestamp, close })
  }
  return [...byMinute.entries()].sort(([a], [b]) => a - b).slice(-CTS_G_HISTORY_MINUTES - 1)
    .map(([timestamp, row]) => ({ timestamp, close: row.close }))
}

/** UTC-aligned, complete bars only. A gap resets the EMA/Break warm-up. */
export function ctsGTimeframeCloses(
  minutes: readonly CtsGMinuteClose[], timeframeMinutes: number, asOfMs: number,
): number[] {
  const width = Math.max(1, Math.floor(timeframeMinutes))
  if (!Number.isFinite(width) || !Number.isFinite(asOfMs)) return []
  const rows = compactCtsGMinuteCloses(minutes).filter(row => row.timestamp + 60_000 <= asOfMs)
  const bars: number[] = []
  let bucket = -1, count = 0, lastMinute = -1, close = 0
  for (const row of rows) {
    const nextBucket = Math.floor(row.timestamp / (width * 60_000))
    if (nextBucket !== bucket) {
      if (count === width) bars.push(close)
      else if (bucket >= 0) bars.length = 0
      if (bucket >= 0 && nextBucket !== bucket + 1) bars.length = 0
      bucket = nextBucket
      count = 0
    }
    if (count > 0 && row.timestamp !== lastMinute + 60_000) count = -width
    count++
    lastMinute = row.timestamp
    close = row.close
  }
  if (count === width) bars.push(close)
  else if ((bucket + 1) * width * 60_000 <= asOfMs) bars.length = 0
  // An incomplete current bar does not invalidate the preceding closed bars.
  return bars
}

/** Untimestamped legacy price input is explicitly a completed one-minute series. */
export function ctsGLegacyTimeframeCloses(prices: readonly number[], timeframeMinutes: number): number[] {
  const bars: number[] = []
  const width = Math.max(1, Math.floor(timeframeMinutes))
  for (let index = prices.length - 1; index >= width - 1; index -= width) bars.unshift(prices[index])
  return bars
}
