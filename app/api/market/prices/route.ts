import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    // Fetch real prices from exchanges or aggregator
    // For now, using a public API as demonstration
    const symbols = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"]
    const prices: Record<string, { price: number; change_24h: number }> = {}

    for (const symbol of symbols) {
      try {
        const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, {
          cache: "no-store",
        })

        if (response.ok) {
          const data = await response.json()
          prices[symbol] = {
            price: Number.parseFloat(data.lastPrice),
            change_24h: Number.parseFloat(data.priceChangePercent),
          }
        }
      } catch (error) {
        console.error(`[v0] Failed to fetch ${symbol}:`, error)
        // Provide fallback data if fetch fails
        prices[symbol] = {
          price: 0,
          change_24h: 0,
        }
      }
    }

    return NextResponse.json(prices)
  } catch (error) {
    console.error("[v0] Market prices API error:", error)
    return NextResponse.json({ error: "Failed to fetch market prices" }, { status: 500 })
  }
}
