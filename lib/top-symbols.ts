// Shared exchange top-symbols resolver.
//
// Extracted from app/api/exchange/[exchange]/top-symbols/route.ts so server-side
// callers (e.g. the settings PATCH route's auto-resolve, quick-start) can resolve
// the top-N symbols DIRECTLY instead of doing a fragile HTTP self-fetch back into
// our own route (which fails on loopback/origin mismatch inside a route handler).
//
// Uses public exchange REST APIs — no auth required. Always returns at least one
// symbol (safe-major fallback) so callers never wipe a connection's symbol source.
//
// SortKey guide:
//   "volume"       — top by 24h USDT-quoted volume (liquidity-first).
//   "volatility"   — top by |24h priceChangePercent| from the ticker feed.
//   "volatility_1h" — top by true 1h ATR: (1h high - 1h low) / 1h open × 100.
//                     Fetches one 1h kline for a bounded ranked head and retains
//                     the complete volume-ranked tail. Concurrency remains capped
//                     so exchange-wide selections cannot flood venue APIs.

import { fetchBingXPublic } from "@/lib/bingx-public-api"
import { getDefaultSymbolsForMarket } from "@/lib/market-types"
import { isForexSymbol, normalizeForexSymbol } from "@/lib/forex-market"
import {
  ATR_ENRICHMENT_MAX_SYMBOLS,
  EXCHANGE_SYMBOL_COUNT_MAX,
  MARKET_DATA_REQUEST_CONCURRENCY,
  clampExchangeSymbolCount,
  isHighScaleSymbolCount,
} from "@/lib/symbol-capacity"

export type SortKey = "volume" | "volatility" | "volatility_1h"
export type Ticker = { symbol: string; priceChangePercent: number; volume: number; atr1h?: number }

// In-memory ranked-list cache plus in-flight coalescing. Settings dialogs,
// save routes and overview cards often request the same public ranking at the
// same time; one venue request serves all of them while every caller still
// receives its requested complete top-N slice.
const cache = new Map<string, { symbols: Ticker[]; timestamp: number; attemptedLimit: number }>()
const inFlight = new Map<string, {
  attemptedLimit: number
  promise: Promise<{ symbol: string; priceChangePercent: number; symbols: Ticker[] }>
}>()
// 1h ATR cache is per-symbol and shorter-lived (90s) since 1h klines refresh every ~60s.
const atrCache = new Map<string, { atr1h: number; timestamp: number }>()
const CACHE_TTL = 60_000
const ATR_CACHE_TTL = 90_000

const FALLBACK: Record<string, string> = {
  binance: "BTCUSDT",
  bybit: "BTCUSDT",
  bingx: "BTCUSDT",
  okx: "BTCUSDT",
  pionex: "BTCUSDT",
  orangex: "BTCUSDT",
  instaforex: "EURUSD",
  instafx: "EURUSD",
  forex: "EURUSD",
}

const SAFE_FOREX_SYMBOLS = getDefaultSymbolsForMarket("forex")

const SAFE_MAJORS = [
  "BTCUSDT",  "ETHUSDT",  "SOLUSDT",  "BNBUSDT",  "XRPUSDT",
  "DOGEUSDT", "ADAUSDT",  "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "ATOMUSDT", "LTCUSDT",  "UNIUSDT",  "NEARUSDT", "POLUSDT",
  "WIFUSDT",  "1000PEPEUSDT", "SUIUSDT", "OPUSDT", "ARBUSDT",
  "APTUSDT",  "FILUSDT",  "BCHUSDT",  "TRXUSDT", "ETCUSDT",
  "AAVEUSDT", "INJUSDT",  "SEIUSDT",  "TIAUSDT", "WLDUSDT",
  "JUPUSDT",  "ORDIUSDT",
]

export function normaliseSort(raw: string | null | undefined): SortKey {
  const v = (raw || "").toLowerCase()
  // Map the dialog's SymbolOrder values to SortKey:
  //   volatility_1h          → "volatility_1h"  (true 1h kline ATR)
  //   volatility_24h / volatil* → "volatility"  (24h priceChangePercent)
  //   volume_* / newest / manual / anything else → "volume"
  if (v === "volatility_1h") return "volatility_1h"
  if (v.startsWith("volatil")) return "volatility"
  return "volume"
}

// ─── 1h ATR helper ──────────────────────────────────────────────────────────
// Fetches the single most-recent 1h kline for `symbol` on the given exchange
// and computes (high - low) / open × 100 as a percentage ATR proxy.
// Returns 0 on any failure so the symbol still appears in results.
async function fetch1hAtr(exchange: string, symbol: string): Promise<number> {
  const cacheKey = `${exchange}:${symbol}`
  const cached = atrCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < ATR_CACHE_TTL) return cached.atr1h

  try {
    let atr1h = 0

    if (exchange === "bingx") {
      // BingX swap klines: symbol uses hyphen format (BTC-USDT)
      const bingxSym = symbol.replace(/USDT$/, "-USDT")
      const url = `/openApi/swap/v2/quote/klines?symbol=${encodeURIComponent(bingxSym)}&interval=1h&limit=2`
      const res = await fetchBingXPublic(url, {}, { timeoutMs: 4000 })
      if (res.ok) {
        const data = await res.json()
        // BingX klines: [{ open, high, low, close, volume, time }, ...]
        // Use index 0 (newest completed candle if limit=2 returns current+prev).
        const candles: any[] = Array.isArray(data?.data) ? data.data : []
        // Prefer the second-to-last (fully closed) candle if two are returned.
        const c = candles.length >= 2 ? candles[candles.length - 2] : candles[0]
        if (c) {
          const open  = Number(c.open  || c.o || 0)
          const high  = Number(c.high  || c.h || 0)
          const low   = Number(c.low   || c.l || 0)
          if (open > 0 && high >= low) atr1h = ((high - low) / open) * 100
        }
      }
    } else if (exchange === "binance") {
      const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=2`
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) {
        const data: any[][] = await res.json()
        const c = data.length >= 2 ? data[data.length - 2] : data[0]
        if (c) {
          const open = Number(c[1] || 0)
          const high = Number(c[2] || 0)
          const low  = Number(c[3] || 0)
          if (open > 0 && high >= low) atr1h = ((high - low) / open) * 100
        }
      }
    } else if (exchange === "bybit") {
      const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=2`
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) {
        const data = await res.json()
        const list: any[][] = data?.result?.list || []
        // Bybit returns newest-first; use index 1 for the closed candle.
        const c = list.length >= 2 ? list[1] : list[0]
        if (c) {
          const open = Number(c[1] || 0)
          const high = Number(c[2] || 0)
          const low  = Number(c[3] || 0)
          if (open > 0 && high >= low) atr1h = ((high - low) / open) * 100
        }
      }
    }

    atrCache.set(cacheKey, { atr1h, timestamp: Date.now() })
    return atr1h
  } catch {
    return 0
  }
}

// Runs fetch1hAtr for a batch of symbols with capped concurrency.
async function enrich1hAtr(
  exchange: string,
  tickers: Ticker[],
  concurrency = 8,
): Promise<Ticker[]> {
  const results: Ticker[] = [...tickers]
  let i = 0
  const worker = async () => {
    while (i < results.length) {
      const idx = i++
      results[idx] = {
        ...results[idx],
        atr1h: await fetch1hAtr(exchange, results[idx].symbol),
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tickers.length) }, worker))
  return results
}

async function fetchInstaForexTopSymbols(
  limit: number,
  sort: SortKey,
): Promise<{ symbol: string; priceChangePercent: number; symbols: Ticker[] }> {
  const safeLimit = clampExchangeSymbolCount(limit, 1)
  const requestTimeoutMs = isHighScaleSymbolCount(safeLimit) ? 15_000 : 5_000
  let listedSymbols: string[] = []
  try {
    const response = await fetch("https://quotes.instaforex.com/api/quotesList", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
    if (response.ok) {
      const payload: any = await response.json()
      const rows = Array.isArray(payload?.quotesList)
        ? payload.quotesList
        : Array.isArray(payload?.quotes)
          ? payload.quotes
          : []
      listedSymbols = rows
        .filter((row: any) => {
          const group = String(row?.group?.name ?? row?.group ?? "").trim().toLowerCase()
          return !group || group === "forex" || group === "fx"
        })
        .map((row: any) => normalizeForexSymbol(row?.symbol ?? row?.name))
        .filter((symbol: string) => isForexSymbol(symbol))
    }
  } catch {
    // The deterministic major list below keeps a temporary quote-list outage
    // from wiping a saved Forex symbol basket.
  }

  const candidates = Array.from(new Set([...listedSymbols, ...SAFE_FOREX_SYMBOLS]))
    .filter(isForexSymbol)
    .slice(0, safeLimit)
  let quotes = new Map<string, any>()
  if (candidates.length > 0) {
    const chunks = Array.from(
      { length: Math.ceil(candidates.length / 50) },
      (_, index) => candidates.slice(index * 50, index * 50 + 50),
    )
    const rowsByChunk: any[][] = new Array(chunks.length)
    let cursor = 0
    const worker = async () => {
      while (cursor < chunks.length) {
        const index = cursor++
        try {
          const url = new URL("https://quotes.instaforex.com/api/quotesTick")
          url.searchParams.set("q", chunks[index].join(",").toLowerCase())
          const response = await fetch(url, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(requestTimeoutMs),
          })
          if (!response.ok) continue
          const payload: any = await response.json()
          rowsByChunk[index] = Array.isArray(payload)
            ? payload
            : Array.isArray(payload?.quotes)
              ? payload.quotes
              : []
        } catch {
          rowsByChunk[index] = []
        }
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(MARKET_DATA_REQUEST_CONCURRENCY, chunks.length) },
      worker,
    ))
    quotes = new Map(rowsByChunk.flat().map((row: any) => [normalizeForexSymbol(row?.symbol), row]))
  }

  let tickers = candidates.map((symbol, index) => {
    const quote = quotes.get(symbol) || {}
    const priceChangePercent = Math.abs(Number(quote.change24h ?? quote.change) || 0)
    return {
      symbol,
      priceChangePercent,
      // InstaForex's public quote schema does not publish 24h volume. Keep
      // this zero rather than treating a price field as volume; list order is
      // the documented fallback for the volume sort.
      volume: 0,
      __order: index,
    }
  })
  if (sort === "volatility" || sort === "volatility_1h") {
    tickers.sort((left, right) => right.priceChangePercent - left.priceChangePercent || left.__order - right.__order)
  } else {
    tickers.sort((left, right) => left.__order - right.__order)
  }
  const selected = tickers.slice(0, safeLimit).map(({ __order: _order, ...ticker }) => ticker)
  const fallback = SAFE_FOREX_SYMBOLS.slice(0, safeLimit).map((symbol, index) => ({
    symbol,
    priceChangePercent: 0,
    volume: 0,
    __order: index,
  }))
  const output = selected.length > 0 ? selected : fallback.map(({ __order: _order, ...ticker }) => ticker)
  return {
    symbol: output[0]?.symbol || "EURUSD",
    priceChangePercent: output[0]?.priceChangePercent || 0,
    symbols: output,
  }
}

async function fetchTopSymbolsUncached(
  exchange: string,
  limit = 1,
  sort: SortKey = "volume",
): Promise<{ symbol: string; priceChangePercent: number; symbols: Ticker[] }> {
  const safeLimit = clampExchangeSymbolCount(limit, 1)
  const highScale = isHighScaleSymbolCount(safeLimit)
  const tickerTimeoutMs = highScale ? 15_000 : 5_000
  if (exchange === "instaforex" || exchange === "instafx" || exchange === "forex") {
    return fetchInstaForexTopSymbols(safeLimit, sort)
  }
  // For volatility_1h we first fetch a volume-ranked pool. ATR enrichment is
  // capped independently from the requested output size, so a 500-symbol UI
  // selection does not trigger 500 simultaneous/serial venue requests.
  // MIN_VOLUME_USDT filters out newly listed micro-caps and wash-traded coins
  // that appear at the top of any ATR ranking but have no real liquidity.
  // Threshold: $5M 24h USDT quoteVolume — excludes anything below that floor.
  if (sort === "volatility_1h") {
    const MIN_VOLUME_USDT = 5_000_000
    const poolSize = Math.min(
      EXCHANGE_SYMBOL_COUNT_MAX,
      Math.max(safeLimit, ATR_ENRICHMENT_MAX_SYMBOLS),
    )
    const pool = await fetchTopSymbols(exchange, poolSize, "volume")
    // Drop micro-caps before fetching klines — saves round-trips and
    // prevents wash-traded coins from polluting the ATR ranking.
    const liquid = pool.symbols.filter((t) => t.volume >= MIN_VOLUME_USDT)
    const candidates = highScale
      ? pool.symbols
      : liquid.length >= safeLimit
        ? liquid
        : pool.symbols
    const atrCandidates = candidates.slice(0, ATR_ENRICHMENT_MAX_SYMBOLS)
    const enriched = await enrich1hAtr(
      exchange,
      atrCandidates,
      MARKET_DATA_REQUEST_CONCURRENCY,
    )
    enriched.sort((a, b) => (b.atr1h ?? 0) - (a.atr1h ?? 0) || b.volume - a.volume)
    const enrichedSymbols = new Set(enriched.map((ticker) => ticker.symbol))
    const topN = [
      ...enriched,
      ...candidates.filter((ticker) => !enrichedSymbols.has(ticker.symbol)),
    ].slice(0, safeLimit)
    const top  = topN[0] ?? pool.symbols[0]
    return {
      symbol:             top.symbol,
      priceChangePercent: top.atr1h ?? top.priceChangePercent,
      symbols:            topN,
    }
  }
  let tickers: Ticker[] = []

  try {
    if (exchange === "binance") {
      const res = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(tickerTimeoutMs),
      })
      if (!res.ok) throw new Error(`Binance ticker HTTP ${res.status}`)
      const data: any[] = await res.json()
      tickers = data
        .filter(
          (t) =>
            t.symbol.endsWith("USDT") &&
            !t.symbol.includes("DOWN") &&
            !t.symbol.includes("UP") &&
            !["USDCUSDT", "BUSDUSDT", "TUSDUSDT", "FDUSDUSDT"].includes(t.symbol) &&
            (highScale || Number.parseFloat(t.quoteVolume) > 5_000_000) &&
            Number.parseFloat(t.lastPrice ?? t.last ?? t.price ?? "1") > 0,
          )
          .map((t: any) => ({
            symbol:             t.symbol,
            priceChangePercent: Math.abs(Number.parseFloat(t.priceChangePercent)),
            volume: Number.parseFloat(t.quoteVolume) || 0,
        }))
    } else if (exchange === "bybit") {
      try {
        const res = await fetch("https://api.bybit.com/v5/market/tickers?category=linear", {
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; TradingBot/1.0)" },
          signal: AbortSignal.timeout(tickerTimeoutMs),
        })
        if (res.ok) {
          const data = await res.json()
          tickers = (data?.result?.list || [])
            .filter((t: any) =>
              t.symbol.endsWith("USDT") &&
              Number.parseFloat(t.lastPrice || 0) > 0 &&
              (highScale || Number.parseFloat(t.turnover24h) > 1_000_000),
            )
            .map((t: any) => ({
              symbol: t.symbol,
              priceChangePercent: Math.abs(Number.parseFloat(t.price24hPcnt || "0") * 100),
              volume: Number.parseFloat(t.turnover24h) || 0,
            }))
        } else throw new Error(`Bybit ticker HTTP ${res.status}`)
      } catch (bybitErr) {
        console.warn("[TopSymbols] Bybit API error, using default:", bybitErr instanceof Error ? bybitErr.message : bybitErr)
      }
    } else if (exchange === "bingx") {
      const res = await fetchBingXPublic(
        "/openApi/swap/v2/quote/ticker",
        {},
        { timeoutMs: tickerTimeoutMs },
      )
      if (!res.ok) throw new Error(`BingX ticker HTTP ${res.status}`)
      const data = await res.json()
      tickers = (data?.data || [])
        .filter((t: any) =>
          t.symbol?.endsWith("-USDT") &&
          Number.parseFloat(t.lastPrice ?? t.price ?? t.close ?? "0") > 0 &&
          (highScale || Number.parseFloat(t.volume) > 100_000),
        )
        .map((t: any) => ({
          symbol: (t.symbol as string).replace("-", ""),
          priceChangePercent: Math.abs(Number.parseFloat(t.priceChangePercent || "0")),
          volume: Number.parseFloat(t.quoteVolume || t.volume || "0") || 0,
        }))
    } else if (exchange === "okx") {
      const res = await fetch("https://www.okx.com/api/v5/market/tickers?instType=SWAP", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(tickerTimeoutMs),
      })
      if (!res.ok) throw new Error(`OKX ticker HTTP ${res.status}`)
      const data = await res.json()
      tickers = (data?.data || [])
        .filter((t: any) =>
          t.instId?.endsWith("USDT-SWAP") &&
          Number.parseFloat(t.last || 0) > 0 &&
          (highScale || Number.parseFloat(t.volCcy24h) > 1_000_000),
        )
        .map((t: any) => ({
          symbol: (t.instId as string).replace("-SWAP", "").replace("-", ""),
          priceChangePercent: Math.abs(Number.parseFloat(t.sodUtc8 || "0")),
          volume: Number.parseFloat(t.volCcy24h || "0") || 0,
        }))
    }
  } catch {
    // Silently handle — will use fallback below.
  }

  if (tickers.length === 0) {
    // Public ticker API unreachable / empty after filtering (common in sandboxed
    // dev). Honour the requested count instead of collapsing to a single symbol.
    const preferred = FALLBACK[exchange] || "BTCUSDT"
    const ordered = [preferred, ...SAFE_MAJORS.filter((s) => s !== preferred)]
    const fallbackSymbols = ordered.slice(0, safeLimit).map((symbol, i) => ({
      symbol,
      priceChangePercent: i === 0 ? 0 : 0.5,
      volume: Math.max(0, (ordered.length - i) * 1000),
    }))
    return { symbol: preferred, priceChangePercent: 0, symbols: fallbackSymbols }
  }

  // Note: "volatility_1h" returns early above; only "volume" and "volatility" reach here.
  tickers.sort((a, b) =>
    sort === "volatility"
      ? b.priceChangePercent - a.priceChangePercent
      : b.volume - a.volume,
  )

  const seen = new Set<string>()
  const unique = tickers.filter((t) => {
    if (seen.has(t.symbol)) return false
    seen.add(t.symbol)
    return true
  })

  const topN = unique.slice(0, safeLimit)
  const top = topN[0]

  return { symbol: top.symbol, priceChangePercent: top.priceChangePercent, symbols: topN }
}

export async function fetchTopSymbols(
  exchange: string,
  limit = 1,
  sort: SortKey = "volume",
): Promise<{ symbol: string; priceChangePercent: number; symbols: Ticker[] }> {
  const normalizedExchange = String(exchange || "").trim().toLowerCase()
  const requested = clampExchangeSymbolCount(limit, 1)
  const cacheKey = `${normalizedExchange}:${sort}`
  const cached = cache.get(cacheKey)
  if (
    cached &&
    Date.now() - cached.timestamp < CACHE_TTL &&
    (cached.symbols.length >= requested || cached.attemptedLimit >= requested)
  ) {
    const symbols = cached.symbols.slice(0, requested)
    return {
      symbol: symbols[0].symbol,
      priceChangePercent: symbols[0].atr1h ?? symbols[0].priceChangePercent,
      symbols,
    }
  }

  const existing = inFlight.get(cacheKey)
  if (existing) {
    const shared = await existing.promise
    if (shared.symbols.length >= requested || existing.attemptedLimit >= requested) {
      const symbols = shared.symbols.slice(0, requested)
      return {
        symbol: symbols[0].symbol,
        priceChangePercent: symbols[0].atr1h ?? symbols[0].priceChangePercent,
        symbols,
      }
    }
  }

  const request = fetchTopSymbolsUncached(normalizedExchange, requested, sort)
    .then((result) => {
      const previous = cache.get(cacheKey)
      const previousFresh = Boolean(previous && Date.now() - previous.timestamp < CACHE_TTL)
      const symbols = previousFresh && previous!.symbols.length > result.symbols.length
        ? previous!.symbols
        : result.symbols
      cache.set(cacheKey, {
        symbols,
        timestamp: Date.now(),
        attemptedLimit: Math.max(requested, previousFresh ? previous!.attemptedLimit : 0),
      })
      return {
        symbol: symbols[0].symbol,
        priceChangePercent: symbols[0].atr1h ?? symbols[0].priceChangePercent,
        symbols,
      }
    })
    .finally(() => {
      if (inFlight.get(cacheKey)?.promise === request) inFlight.delete(cacheKey)
    })
  inFlight.set(cacheKey, { attemptedLimit: requested, promise: request })
  const result = await request
  const symbols = result.symbols.slice(0, requested)
  return {
    symbol: symbols[0].symbol,
    priceChangePercent: symbols[0].atr1h ?? symbols[0].priceChangePercent,
    symbols,
  }
}
