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
//                     Fetches the last single 1h kline for each candidate symbol.
//                     For BingX this hits /openApi/swap/v2/quote/klines once per
//                     symbol (up to `limit`×top-candidates). A parallel batch with
//                     concurrency=8 keeps total latency < 2s for 20 symbols.

import { fetchBingXPublic } from "@/lib/bingx-public-api"

export type SortKey = "volume" | "volatility" | "volatility_1h"
export type Ticker = { symbol: string; priceChangePercent: number; volume: number; atr1h?: number }

// In-memory cache — volatile symbols don't change rapidly, 60s TTL is fine.
// Keyed by `${exchange}:${sort}` so volume-, volatility-, and 1h-sorted requests
// don't clobber each other.
const cache = new Map<string, { symbol: string; priceChangePercent: number; timestamp: number }>()
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
}

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

export async function fetchTopSymbols(
  exchange: string,
  limit = 1,
  sort: SortKey = "volume",
): Promise<{ symbol: string; priceChangePercent: number; symbols: Ticker[] }> {
  // For volatility_1h we first fetch a larger pool (top-100 by volume) to
  // narrow candidates before making one kline request per symbol.
  // MIN_VOLUME_USDT filters out newly listed micro-caps and wash-traded coins
  // that appear at the top of any ATR ranking but have no real liquidity.
  // Threshold: $5M 24h USDT quoteVolume — excludes anything below that floor.
  if (sort === "volatility_1h") {
    const MIN_VOLUME_USDT = 5_000_000
    // Fetch a wide pool (up to 100 by volume) so we have enough after filtering.
    const pool = await fetchTopSymbols(exchange, 100, "volume")
    // Drop micro-caps before fetching klines — saves round-trips and
    // prevents wash-traded coins from polluting the ATR ranking.
    const liquid = pool.symbols.filter((t) => t.volume >= MIN_VOLUME_USDT)
    const candidates = liquid.length >= limit ? liquid : pool.symbols // fallback if filter over-prunes
    const enriched = await enrich1hAtr(exchange, candidates, 8)
    enriched.sort((a, b) => (b.atr1h ?? 0) - (a.atr1h ?? 0))
    const topN = enriched.slice(0, limit)
    const top  = topN[0] ?? pool.symbols[0]
    return {
      symbol:             top.symbol,
      priceChangePercent: top.atr1h ?? top.priceChangePercent,
      symbols:            topN,
    }
  }
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit) || 1))
  const cacheKey = `${exchange}:${sort}`
  if (safeLimit === 1) {
    const cached = cache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return {
        symbol: cached.symbol,
        priceChangePercent: cached.priceChangePercent,
        symbols: [{ symbol: cached.symbol, priceChangePercent: cached.priceChangePercent, volume: 0 }],
      }
    }
  }

  let tickers: Ticker[] = []

  try {
    if (exchange === "binance") {
      const res = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
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
            Number.parseFloat(t.quoteVolume) > 5_000_000,
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
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) {
          const binanceRes = await fetch("https://api.binance.com/api/v3/ticker/24hr", {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(5000),
          })
          if (binanceRes.ok) {
            const binanceData: any[] = await binanceRes.json()
            tickers = binanceData
              .filter(
                (t) =>
                  t.symbol.endsWith("USDT") &&
                  !t.symbol.includes("DOWN") &&
                  !t.symbol.includes("UP") &&
                  !["USDCUSDT", "BUSDUSDT", "TUSDUSDT", "FDUSDUSDT"].includes(t.symbol) &&
                  Number.parseFloat(t.quoteVolume) > 5_000_000,
              )
              .map((t) => ({
                symbol: t.symbol,
                priceChangePercent: Math.abs(Number.parseFloat(t.priceChangePercent)),
                volume: Number.parseFloat(t.quoteVolume) || 0,
              }))
          }
        } else {
          const data = await res.json()
          tickers = (data?.result?.list || [])
            .filter((t: any) => t.symbol.endsWith("USDT") && Number.parseFloat(t.turnover24h) > 1_000_000)
            .map((t: any) => ({
              symbol: t.symbol,
              priceChangePercent: Math.abs(Number.parseFloat(t.price24hPcnt || "0") * 100),
              volume: Number.parseFloat(t.turnover24h) || 0,
            }))
        }
      } catch (bybitErr) {
        console.warn("[TopSymbols] Bybit API error, using default:", bybitErr instanceof Error ? bybitErr.message : bybitErr)
      }
    } else if (exchange === "bingx") {
      const res = await fetchBingXPublic("/openApi/swap/v2/quote/ticker", {}, { timeoutMs: 5000 })
      if (!res.ok) throw new Error(`BingX ticker HTTP ${res.status}`)
      const data = await res.json()
      tickers = (data?.data || [])
        .filter((t: any) => t.symbol?.endsWith("-USDT") && Number.parseFloat(t.volume) > 100_000)
        .map((t: any) => ({
          symbol: (t.symbol as string).replace("-", ""),
          priceChangePercent: Math.abs(Number.parseFloat(t.priceChangePercent || "0")),
          volume: Number.parseFloat(t.quoteVolume || t.volume || "0") || 0,
        }))
    } else if (exchange === "okx") {
      const res = await fetch("https://www.okx.com/api/v5/market/tickers?instType=SWAP", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`OKX ticker HTTP ${res.status}`)
      const data = await res.json()
      tickers = (data?.data || [])
        .filter((t: any) => t.instId?.endsWith("USDT-SWAP") && Number.parseFloat(t.volCcy24h) > 1_000_000)
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

  // Replace obviously bogus symbols (sandbox junk) with safe majors.
  const looksBogus = (s: string) =>
    s.length > 10 || !/USDT$/.test(s) || /AEON|B2US|HANA|INUS|TAG|HOOLI|MAGASOL|SPORTFUN|TIMI/.test(s)
  if (tickers.some((t) => looksBogus(t.symbol))) {
    const clean = tickers.filter((t) => !looksBogus(t.symbol))
    const needed = Math.max(0, safeLimit - clean.length)
    const extras = SAFE_MAJORS.filter((s) => !clean.some((c) => c.symbol === s))
      .slice(0, needed)
      .map((s) => ({ symbol: s, priceChangePercent: 0.5, volume: 1000 }))
    tickers = [...clean, ...extras].slice(0, Math.max(safeLimit, clean.length))
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
  cache.set(cacheKey, { symbol: top.symbol, priceChangePercent: top.priceChangePercent, timestamp: Date.now() })

  return { symbol: top.symbol, priceChangePercent: top.priceChangePercent, symbols: topN }
}
