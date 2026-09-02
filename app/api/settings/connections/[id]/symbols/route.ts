import { NextResponse } from "next/server"
import { getConnection, initRedis } from "@/lib/redis-db"
import { fetchTopSymbols, normaliseSort } from "@/lib/top-symbols"
import {
  CANONICAL_FORCED_SYMBOLS,
  withCanonicalForcedSymbols,
} from "@/lib/forced-symbols"
import { clampExchangeSymbolCount } from "@/lib/symbol-capacity"

const FALLBACK_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "ATOMUSDT", "LTCUSDT", "UNIUSDT", "NEARUSDT", "MATICUSDT",
  "OPUSDT", "ARBUSDT", "APTUSDT", "SUIUSDT", "INJUSDT",
  "TIAUSDT", "SEIUSDT", "WLDUSDT", "PYTHUSDT", "JUPUSDT",
]

export const dynamic = "force-dynamic"

/**
 * GET /api/settings/connections/[id]/symbols?order=volatility_1h&count=20
 *
 * Returns a ranked list of tradeable symbols for the connection's exchange.
 *
 * Query params:
 *   order  — SymbolOrder value from the dialog ("volatility_1h", "volatility_24h",
 *             "volume_24h", "manual", etc.). Maps to SortKey via normaliseSort().
 *             Default: "volume" (volume-first / most liquid).
 *   count  — How many symbols to return. Uses the shared exchange-wide cap.
 *             Default: 50.
 *
 * For "volatility_1h": ranks the bounded ATR-enrichment head, then retains
 * the complete requested volume-ranked tail. Adds `atr1h` where enriched.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await initRedis()
    const { id } = await params

    const { searchParams } = new URL(request.url)
    const rawOrder = searchParams.get("order") || "volume"
    const rawCount = searchParams.get("count") || "50"
    const sort  = normaliseSort(rawOrder)
    const count = clampExchangeSymbolCount(
      Number.parseInt(rawCount, 10),
      50,
      CANONICAL_FORCED_SYMBOLS.length,
    )

    // Resolve connection from Redis to learn the exchange name.
    const connection = await getConnection(id).catch(() => null)

    if (!connection) {
      return NextResponse.json(
        { error: "Connection not found", symbols: [] },
        { status: 404 },
      )
    }

    const exchange = String(connection.exchange || "bingx").toLowerCase()

    // Try live exchange API with the requested sort order.
    try {
      const { symbols: tickers } = await fetchTopSymbols(exchange, count, sort)
      if (tickers && tickers.length > 0) {
        const symbols = withCanonicalForcedSymbols(tickers.map((ticker) => ticker.symbol), count)
        const tickerBySymbol = new Map(tickers.map((ticker) => [String(ticker.symbol).toUpperCase(), ticker]))
        const completeTickers = symbols.map((symbol) => tickerBySymbol.get(symbol) || {
          symbol,
          priceChangePercent: 0,
          volume: 0,
          mandatory: true,
        })
        return NextResponse.json({
          symbols,
          // Full ticker objects (includes atr1h for volatility_1h sort)
          tickers: completeTickers,
          source:   sort === "volatility_1h" ? "live_1h_atr" : "live",
          sort,
          exchange,
          count:    symbols.length,
        })
      }
    } catch (fetchErr) {
      console.warn(`[v0] [symbols] fetchTopSymbols(${sort}) failed for ${exchange}:`, fetchErr)
    }

    // Hardcoded safe-majors fallback — always available offline
    const fallbackSymbols = withCanonicalForcedSymbols(FALLBACK_SYMBOLS, count)
    return NextResponse.json({
      symbols: fallbackSymbols,
      tickers: fallbackSymbols.map((s, i) => ({ symbol: s, priceChangePercent: 0.5, volume: 1000 - i * 10 })),
      source:   "fallback",
      sort,
      exchange,
      warning: "Live symbol ranking failed; returned offline fallback symbols for manual review.",
      count: fallbackSymbols.length,
    })
  } catch (error) {
    console.error("[v0] [symbols] Unexpected error:", error)
    return NextResponse.json(
      { error: "Failed to fetch symbols", symbols: [] },
      { status: 500 },
    )
  }
}
