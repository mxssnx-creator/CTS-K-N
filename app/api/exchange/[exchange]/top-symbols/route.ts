import { NextResponse } from "next/server"
import { fetchTopSymbols, normaliseSort } from "@/lib/top-symbols"

export const dynamic = "force-dynamic"

/**
 * GET /api/exchange/[exchange]/top-symbols?limit=N&sort=volume|volatility|volatility_1h
 * Returns the top N symbols on the exchange, ordered by the requested key.
 * - limit defaults to 1 and is clamped to [1,50]
 * - sort defaults to "volume" (liquidity-first); "volatility" orders by 24h |%Δ|;
 *   "volatility_1h" fetches 1h klines and orders by true (high−low)/open ATR%
 * - `symbol` keeps the top-1 for backward-compatibility with existing callers
 * - `symbols` is a sorted list of objects: [{ symbol, priceChangePercent, volume }, ...]
 * - `symbolList` is the plain string[] for convenience
 * Uses public exchange REST APIs (via lib/top-symbols) — no auth required.
 */
export async function GET(request: Request, { params }: { params: Promise<{ exchange: string }> }) {
  try {
    const { exchange } = await params
    const normalised = (exchange || "").toLowerCase()

    const { searchParams } = new URL(request.url)
    const limit = Number.parseInt(searchParams.get("limit") || "1", 10) || 1
    const sort = normaliseSort(searchParams.get("sort"))

    const { symbol, priceChangePercent, symbols } = await fetchTopSymbols(normalised, limit, sort)

    return NextResponse.json({
      success: true,
      exchange: normalised,
      sort,
      symbol,
      priceChangePercent,
      symbols, // [{ symbol, priceChangePercent, volume }]
      symbolList: symbols.map((s) => s.symbol), // plain string[] for convenience
      count: symbols.length,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error(`[v0] [TopSymbols] Fatal error:`, error)
    return NextResponse.json(
      { error: "Failed to retrieve top symbols", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}
