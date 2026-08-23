import { fetchBingXPublic } from "@/lib/bingx-public-api"
import type { DirectTradeCandle } from "@/lib/direct-trade-coordination"

const BINGX_KLINE_PAGE_SIZE = 1_440
const BYBIT_KLINE_PAGE_SIZE = 1_000

function deterministicSyntheticMinuteHistory(symbol: string, historyHours: number): DirectTradeCandle[] {
  const minutes = Math.max(1, Math.floor(historyHours * 60))
  const end = Math.floor(Date.now() / 60_000) * 60_000
  const seed = [...symbol].reduce((total, character) => total + character.charCodeAt(0), 0)
  return Array.from({ length: minutes }, (_, index) => {
    const close = 100
      + Math.sin((index + seed) / (13 + seed % 7)) * (1.2 + (seed % 5) * 0.2)
      + Math.cos((index + seed * 3) / (37 + seed % 11)) * 0.75
      + index * (0.001 + (seed % 4) * 0.0003)
    return {
      time: end - (minutes - 1 - index) * 60_000,
      open: close - 0.03,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 100 + ((index * ((seed % 17) + 3)) % 29),
    }
  })
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normaliseCandle(value: any): DirectTradeCandle | null {
  const candle: DirectTradeCandle = {
    time: numberOr(value?.time ?? value?.timestamp ?? value?.t, 0),
    open: numberOr(value?.open ?? value?.o, 0),
    high: numberOr(value?.high ?? value?.h, 0),
    low: numberOr(value?.low ?? value?.l, 0),
    close: numberOr(value?.close ?? value?.c, 0),
    volume: numberOr(value?.volume ?? value?.v, 0),
  }
  if (candle.time > 0 && candle.time < 10_000_000_000) candle.time *= 1_000
  return candle.time > 0 && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0
    ? candle
    : null
}

/**
 * Read public one-minute BingX candles and page backwards until the requested
 * start time. Page size is a venue transport limit only; callers retain their
 * complete requested historic range.
 */
export async function fetchBingXMinuteHistory(symbol: string, historyHours: number): Promise<DirectTradeCandle[]> {
  // Test-only deterministic transport. It keeps the complete API calculation,
  // progress, persistence and pulse paths active without routing development
  // tests through a public exchange or creating an execution side effect.
  if (process.env.DIRECT_TRADE_SYNTHETIC_MARKET_DATA === "1") {
    return deterministicSyntheticMinuteHistory(symbol, historyHours)
  }
  const endTime = Date.now()
  const startTime = endTime - Math.max(1, historyHours) * 60 * 60 * 1_000
  const bingxSymbol = symbol.replace(/USDT$/, "-USDT")
  const byTime = new Map<number, DirectTradeCandle>()
  let cursorEnd = endTime
  let oldestSeen = Number.POSITIVE_INFINITY

  while (cursorEnd > startTime) {
    const url = `/openApi/swap/v3/quote/klines?symbol=${encodeURIComponent(bingxSymbol)}&interval=1m&startTime=${startTime}&endTime=${cursorEnd}&limit=${BINGX_KLINE_PAGE_SIZE}`
    let rows: any[] = []
    try {
      const response = await fetchBingXPublic(url, {}, { timeoutMs: 8_000 })
      if (!response.ok) break
      const payload = await response.json()
      rows = Array.isArray(payload?.data) ? payload.data : []
    } catch {
      break
    }
    if (rows.length === 0) break
    const page = rows.map(normaliseCandle).filter((value): value is DirectTradeCandle => value !== null)
    for (const candle of page) {
      if (candle.time >= startTime && candle.time <= endTime) byTime.set(candle.time, candle)
    }
    const oldest = Math.min(...page.map((candle) => candle.time))
    if (!Number.isFinite(oldest) || oldest >= oldestSeen || oldest <= startTime) break
    oldestSeen = oldest
    cursorEnd = oldest - 1
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time)
}

export async function fetchBybitMinuteHistory(symbol: string, historyHours: number): Promise<DirectTradeCandle[]> {
  if (process.env.DIRECT_TRADE_SYNTHETIC_MARKET_DATA === "1") {
    return deterministicSyntheticMinuteHistory(symbol, historyHours)
  }
  const endTime = Date.now()
  const startTime = endTime - Math.max(1, historyHours) * 60 * 60 * 1_000
  const byTime = new Map<number, DirectTradeCandle>()
  let cursorEnd = endTime
  let oldestSeen = Number.POSITIVE_INFINITY

  while (cursorEnd > startTime) {
    const url = new URL("https://api.bybit.com/v5/market/kline")
    url.searchParams.set("category", "linear")
    url.searchParams.set("symbol", symbol.replace(/-/g, ""))
    url.searchParams.set("interval", "1")
    url.searchParams.set("start", String(startTime))
    url.searchParams.set("end", String(cursorEnd))
    url.searchParams.set("limit", String(BYBIT_KLINE_PAGE_SIZE))
    let rows: unknown[][] = []
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      })
      if (!response.ok) break
      const payload = await response.json()
      if (Number(payload?.retCode) !== 0) break
      rows = Array.isArray(payload?.result?.list) ? payload.result.list : []
    } catch {
      break
    }
    if (rows.length === 0) break
    const page = rows.map((row) => normaliseCandle({
      time: row?.[0],
      open: row?.[1],
      high: row?.[2],
      low: row?.[3],
      close: row?.[4],
      volume: row?.[5],
    })).filter((value): value is DirectTradeCandle => value !== null)
    for (const candle of page) {
      if (candle.time >= startTime && candle.time <= endTime) byTime.set(candle.time, candle)
    }
    const oldest = Math.min(...page.map((candle) => candle.time))
    if (!Number.isFinite(oldest) || oldest >= oldestSeen || oldest <= startTime) break
    oldestSeen = oldest
    cursorEnd = oldest - 1
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time)
}

/**
 * Venue-bound Direct-Trade history. Refusing an unsupported exchange is
 * safer than silently evaluating Bybit orders against a BingX market graph.
 */
export async function fetchDirectTradeMinuteHistory(
  exchange: string,
  symbol: string,
  historyHours: number,
): Promise<DirectTradeCandle[]> {
  const normalized = String(exchange || "").trim().toLowerCase()
  if (normalized === "bingx") return fetchBingXMinuteHistory(symbol, historyHours)
  if (normalized === "bybit") return fetchBybitMinuteHistory(symbol, historyHours)
  throw new Error(`Direct-Trade market history is not supported for exchange ${normalized || "unknown"}`)
}
