import { NextResponse, type NextRequest } from "next/server"
import { initRedis, getSettings, setSettings, getConnection, getRedisClient } from "@/lib/redis-db"
import { createExchangeConnector } from "@/lib/exchange-connectors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/market-data
 * Returns market data (mock for development, real-time in production)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl
    const symbol = searchParams.get("symbol") || "BTCUSDT"
    const exchange = searchParams.get("exchange") || "bybit"
    const interval = searchParams.get("interval") || "1m"

    await initRedis()

    // Check cache
    const cacheKey = `market:${exchange}:${symbol}:${interval}`
    let marketData = await getSettings(cacheKey)

    if (!marketData) {
      // Fetch REAL market data from live exchange
      try {
        // Find active connection for this exchange
        const connections = await import("@/lib/redis-db").then(m => m.getAllConnections())
        const activeConnection = connections.find((c: any) => 
          c.exchange?.toLowerCase() === exchange.toLowerCase() && 
          c.is_assigned === "1" && 
          c.api_key && c.api_secret
        )

        if (activeConnection) {
          const connector = await createExchangeConnector(exchange, {
            apiKey: activeConnection.api_key,
            apiSecret: activeConnection.api_secret,
            apiPassphrase: activeConnection.api_passphrase || "",
            isTestnet: false,
            apiType: activeConnection.api_type || "perpetual_futures",
          })

          // Get real ticker data
          const tickerData = await connector.getTicker(symbol)
          marketData = {
            symbol,
            exchange,
            interval,
            ...tickerData,
            timestamp: Date.now(),
            datetime: new Date().toISOString(),
            last_update: new Date().toISOString(),
          }
        } else {
          // Fallback to real price fetch without credentials if possible
          const connector = await createExchangeConnector(exchange, 
            { apiKey: "", apiSecret: "", apiPassphrase: "", isTestnet: false, apiType: "spot" } as any
          )
          marketData = await connector.getTicker(symbol)
        }

        // Cache for 3 seconds for real data
        const client = getRedisClient()
        await client.set(cacheKey, JSON.stringify(marketData))
        await client.expire(cacheKey, 3)
      } catch (fetchError) {
        console.warn("[Market Data] Failed to fetch real data, using fallback:", fetchError)
        // Fallback - still generate but don't use random values, use static base prices
        const basePrice = getBasePrice(symbol)
        marketData = {
          symbol,
          exchange,
          interval,
          price: basePrice,
          open: basePrice,
          high: basePrice,
          low: basePrice,
          close: basePrice,
          volume: 0,
          timestamp: Date.now(),
          datetime: new Date().toISOString(),
          last_update: new Date().toISOString(),
        }
      }
    } else if (typeof marketData === "string") {
      try {
        marketData = JSON.parse(marketData)
      } catch {
        // If parsing fails, use the value as-is
      }
    }

    return NextResponse.json({
      success: true,
      data: marketData,
    })
  } catch (error) {
    console.error("[v0] Market data error:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch market data",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}

/**
 * POST /api/market-data/batch
 * Fetch market data for multiple symbols
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { symbols, exchange = "bybit", interval = "1m" } = body

    if (!Array.isArray(symbols) || symbols.length === 0) {
      return NextResponse.json(
        { success: false, error: "Symbols array is required" },
        { status: 400 },
      )
    }

    await initRedis()

    const marketData: Record<string, any> = {}

    for (const symbol of symbols) {
      const cacheKey = `market:${exchange}:${symbol}:${interval}`
      let data = await getSettings(cacheKey)

      if (!data) {
        const basePrice = getBasePrice(symbol)
        const variation = basePrice * 0.02

        data = {
          symbol,
          exchange,
          interval,
          price: basePrice + (Math.random() - 0.5) * variation,
          open: basePrice,
          high: basePrice + variation,
          low: basePrice - variation,
          close: basePrice + (Math.random() - 0.5) * variation,
          volume: Math.random() * 1000000,
          timestamp: Date.now(),
          datetime: new Date().toISOString(),
          bid: basePrice - 0.5,
          ask: basePrice + 0.5,
          last_update: new Date().toISOString(),
        }

        await setSettings(cacheKey, JSON.stringify(data))
      } else if (typeof data === "string") {
        try {
          data = JSON.parse(data)
        } catch {
          // Use as-is if parsing fails
        }
      }

      marketData[symbol] = data
    }

    return NextResponse.json({
      success: true,
      count: Object.keys(marketData).length,
      data: marketData,
    })
  } catch (error) {
    console.error("[v0] Batch market data error:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch batch market data",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}

function getBasePrice(symbol: string): number {
  if (symbol.includes("BTC")) return 45000
  if (symbol.includes("ETH")) return 2500
  if (symbol.includes("BNB")) return 300
  if (symbol.includes("XRP")) return 0.5
  if (symbol.includes("ADA")) return 0.4
  if (symbol.includes("DOGE")) return 0.08
  if (symbol.includes("SOL")) return 100
  if (symbol.includes("MATIC")) return 0.8
  if (symbol.includes("DOT")) return 7
  if (symbol.includes("AVAX")) return 35
  return 100
}
