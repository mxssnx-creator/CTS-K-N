/**
 * Deterministic synthetic OHLCV for tests and benchmarks (port of CTS-A-O
 * src/core/market/bars.ts `syntheticCandles`): a regime-switching random walk
 * with intraday mean reversion, wicks, and volume growing with the move.
 * Same (symbol, seed, end) → same candles. Never used for trading decisions.
 */
import type { TechnicalCandle } from "./types"

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(text: string): number {
  let h = 2166136261
  for (let index = 0; index < text.length; index++) {
    h ^= text.charCodeAt(index)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function syntheticCandles(
  symbol: string,
  timeframeMinutes: number,
  count: number,
  endMs: number,
  seed = 7,
): TechnicalCandle[] {
  const random = mulberry32(hashString(symbol) ^ seed)
  const gauss = () => {
    let u = 0
    let v = 0
    while (u === 0) u = random()
    while (v === 0) v = random()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  const frameMs = timeframeMinutes * 60_000
  const start = Math.floor(endMs / frameMs) * frameMs - (count - 1) * frameMs
  let price = 20 + (hashString(symbol) % 5000) / 10
  const baseVolatility = 0.0018 * Math.sqrt(timeframeMinutes / 5) * (0.7 + random() * 0.8)
  let drift = 0
  let regimeLeft = 0
  let anchor = price
  const out: TechnicalCandle[] = []
  for (let index = 0; index < count; index++) {
    if (regimeLeft <= 0) {
      regimeLeft = 20 + Math.floor(random() * 120)
      drift = (random() - 0.5) * baseVolatility * 0.6
      anchor = price
    }
    regimeLeft--
    const volatility = baseVolatility * (0.6 + random() * 0.9)
    const pull = ((anchor - price) / price) * 0.04
    const ret = drift + pull + gauss() * volatility
    const open = price
    const close = Math.max(1e-6, open * (1 + ret))
    const wick = Math.abs(gauss()) * volatility * 0.6
    const high = Math.max(open, close) * (1 + wick * random())
    const low = Math.min(open, close) * (1 - wick * random())
    const volume = 1000 * (0.5 + random()) * (1 + Math.abs(ret) / baseVolatility)
    out.push({ timestamp: start + index * frameMs, open, high, low, close, volume })
    price = close
  }
  return out
}

/** Price mirror K / price (rises become falls, highs become lows): the long/short symmetry check. */
export function mirrorCandles(candles: readonly TechnicalCandle[]): TechnicalCandle[] {
  const k = candles[0].close * candles[0].close
  return candles.map((candle) => ({
    ...candle,
    open: k / candle.open,
    close: k / candle.close,
    high: k / candle.low,
    low: k / candle.high,
  }))
}
