/**
 * Public, read-only 1-minute OHLCV history downloader for the historic signal
 * evaluation (scripts/historic-signal-eval.ts).
 *
 * Only unauthenticated GET market-data endpoints are used. No credentials are
 * read and no order endpoint is ever touched. Results are cached as JSON per
 * venue/symbol/window so reruns are offline.
 */
import fs from "node:fs"
import path from "node:path"
import type { SignalCandle } from "@/lib/signal-source-registry"

const MINUTE = 60_000

export interface VenueHistorySpec {
  /** Registry source id whose live adapter reads this venue/market. */
  sourceId: string
  /** Page size in minutes. */
  pageMinutes: number
  /** Minimum delay between requests (ms) to respect public rate limits. */
  delayMs: number
  url: (base: string, startMs: number, endMs: number) => string
  parse: (payload: any) => SignalCandle[]
}

const n = (value: unknown) => Number(value)
const candle = (t: unknown, o: unknown, h: unknown, l: unknown, c: unknown, v: unknown): SignalCandle => {
  let ts = n(t)
  if (ts < 100_000_000_000) ts *= 1000
  return { timestamp: ts, open: n(o), high: n(h), low: n(l), close: n(c), volume: n(v) || 0 }
}

export const VENUE_HISTORY_SPECS: readonly VenueHistorySpec[] = [
  {
    sourceId: "bingx-swap",
    pageMinutes: 720,
    delayMs: 150,
    url: (b, s, e) =>
      `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${b}-USDT&interval=1m&startTime=${s}&endTime=${e + MINUTE}&limit=1440`,
    parse: (p) => (p?.data || []).map((r: any) => candle(r.time, r.open, r.high, r.low, r.close, r.volume)),
  },
  {
    sourceId: "binance-spot-data",
    pageMinutes: 1000,
    delayMs: 100,
    url: (b, s, e) =>
      `https://data-api.binance.vision/api/v3/klines?symbol=${b}USDT&interval=1m&startTime=${s}&endTime=${e}&limit=1000`,
    parse: (p) => (Array.isArray(p) ? p : []).map((r: any) => candle(r[0], r[1], r[2], r[3], r[4], r[5])),
  },
  {
    sourceId: "okx-swap",
    pageMinutes: 100,
    delayMs: 120,
    // history-candles returns bars strictly older than `after`.
    url: (b, _s, e) =>
      `https://www.okx.com/api/v5/market/history-candles?instId=${b}-USDT-SWAP&bar=1m&after=${e + MINUTE}&limit=100`,
    parse: (p) => (p?.data || []).map((r: any) => candle(r[0], r[1], r[2], r[3], r[4], r[5])),
  },
  {
    sourceId: "bitget-usdt",
    pageMinutes: 200,
    delayMs: 110,
    url: (b, s, e) =>
      `https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${b}USDT&productType=USDT-FUTURES&granularity=1m&startTime=${s}&endTime=${e + MINUTE}&limit=200`,
    parse: (p) => (p?.data || []).map((r: any) => candle(r[0], r[1], r[2], r[3], r[4], r[5])),
  },
  {
    sourceId: "kucoin-spot",
    pageMinutes: 1440,
    delayMs: 250,
    // KuCoin spot rows are [time, open, close, high, low, volume, turnover].
    url: (b, s, e) =>
      `https://api.kucoin.com/api/v1/market/candles?type=1min&symbol=${b}-USDT&startAt=${s / 1000}&endAt=${e / 1000}`,
    parse: (p) => (p?.data || []).map((r: any) => candle(r[0], r[1], r[3], r[4], r[2], r[5])),
  },
  {
    sourceId: "mexc-contract",
    pageMinutes: 1000,
    delayMs: 200,
    url: (b, s, e) =>
      `https://contract.mexc.com/api/v1/contract/kline/${b}_USDT?interval=Min1&start=${s / 1000}&end=${e / 1000}`,
    parse: (p) => {
      const d = p?.data || {}
      const t: number[] = d.time || []
      return t.map((time, i) => candle(time, d.open[i], d.high[i], d.low[i], d.close[i], d.vol[i]))
    },
  },
  {
    sourceId: "htx-linear",
    pageMinutes: 1000,
    delayMs: 200,
    url: (b, s, e) =>
      `https://api.hbdm.com/linear-swap-ex/market/history/kline?contract_code=${b}-USDT&period=1min&from=${s / 1000}&to=${e / 1000}`,
    parse: (p) => (p?.data || []).map((r: any) => candle(r.id, r.open, r.high, r.low, r.close, r.vol)),
  },
]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function getJson(url: string, attempts = 4): Promise<any> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20_000)
      const response = await fetch(url, { method: "GET", signal: controller.signal })
      clearTimeout(timer)
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      lastError = error
      await sleep(1000 * (attempt + 1))
    }
  }
  throw lastError
}

export interface VenueHistory {
  sourceId: string
  symbol: string
  startMs: number
  endMs: number
  candles: SignalCandle[]
  expectedMinutes: number
  missingMinutes: number
  gaps: Array<{ fromMs: number; toMs: number; minutes: number }>
  error?: string
}

export function summarizeGaps(
  candles: readonly SignalCandle[],
  startMs: number,
  endMs: number,
): Pick<VenueHistory, "expectedMinutes" | "missingMinutes" | "gaps"> {
  const present = new Set(candles.map((c) => c.timestamp))
  const gaps: VenueHistory["gaps"] = []
  let missing = 0
  let runStart = -1
  for (let t = startMs; t < endMs; t += MINUTE) {
    if (!present.has(t)) {
      missing++
      if (runStart < 0) runStart = t
    } else if (runStart >= 0) {
      gaps.push({ fromMs: runStart, toMs: t, minutes: (t - runStart) / MINUTE })
      runStart = -1
    }
  }
  if (runStart >= 0) gaps.push({ fromMs: runStart, toMs: endMs, minutes: (endMs - runStart) / MINUTE })
  return { expectedMinutes: Math.round((endMs - startMs) / MINUTE), missingMinutes: missing, gaps }
}

/** Download [startMs, endMs) for one venue and base symbol, with a JSON cache. */
export async function loadVenueHistory(input: {
  spec: VenueHistorySpec
  base: string
  startMs: number
  endMs: number
  cacheDir: string
  log?: (line: string) => void
}): Promise<VenueHistory> {
  const { spec, base, startMs, endMs } = input
  const file = path.join(input.cacheDir, `${spec.sourceId}_${base}_${startMs}_${endMs}.json`)
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"))
  const byTs = new Map<number, SignalCandle>()
  let error: string | undefined
  try {
    for (let pageEnd = endMs - MINUTE; pageEnd >= startMs; pageEnd -= spec.pageMinutes * MINUTE) {
      const pageStart = Math.max(startMs, pageEnd - (spec.pageMinutes - 1) * MINUTE)
      const payload = await getJson(spec.url(base, pageStart, pageEnd))
      for (const c of spec.parse(payload)) {
        if (
          c.timestamp >= startMs && c.timestamp < endMs && c.timestamp % MINUTE === 0 &&
          [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0)
        ) {
          byTs.set(c.timestamp, c)
        }
      }
      await sleep(spec.delayMs)
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  const candles = [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp)
  const history: VenueHistory = {
    sourceId: spec.sourceId,
    symbol: `${base}USDT`,
    startMs,
    endMs,
    candles,
    ...summarizeGaps(candles, startMs, endMs),
    ...(error ? { error } : {}),
  }
  input.log?.(
    `${spec.sourceId} ${base}: ${candles.length}/${history.expectedMinutes} bars, missing ${history.missingMinutes}${error ? `, error ${error}` : ""}`,
  )
  // Only cache complete-enough downloads so transient failures are retried.
  if (!error) {
    fs.mkdirSync(input.cacheDir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(history))
  }
  return history
}
