import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getMarketData, getAllConnections } from "@/lib/redis-db"
import { marketDataKey } from "@/lib/market-data-keys"
import { getDefaultSymbolsForMarket, normalizeMarketSymbol, normalizeMarketType } from "@/lib/market-types"
import { isForexSymbol, normalizeForexSymbol } from "@/lib/forex-market"

export const dynamic = "force-dynamic"
export const revalidate = 0

// Track last generation to avoid flooding
let lastGeneration = 0
const GENERATION_INTERVAL = 1000 // 1 second

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

function symbolsForConnection(connection: any): { symbols: string[]; marketType: "crypto" | "forex" } {
  const marketType = normalizeMarketType(
    connection?.market_type || connection?.asset_class,
    connection?.exchange,
  )
  const raw = connection?.active_symbols ?? connection?.activeSymbols
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\s,|;]+/)
      : []
  const symbols = Array.from(new Set(values.map((value: unknown) => {
    const normalized = marketType === "forex"
      ? normalizeForexSymbol(value)
      : normalizeMarketSymbol(value, "crypto")
    return marketType === "forex"
      ? isForexSymbol(normalized) ? normalized : ""
      : /^[A-Z0-9]{2,30}$/.test(normalized) ? normalized : ""
  }).filter(Boolean)))
  return {
    symbols: symbols.length > 0
      ? symbols
      : marketType === "forex"
        ? getDefaultSymbolsForMarket("forex")
        : SYMBOLS,
    marketType,
  }
}

function latestCandle(marketData: any): any | null {
  if (!marketData) return null
  if (Array.isArray(marketData?.candles) && marketData.candles.length > 0) {
    return marketData.candles[marketData.candles.length - 1]
  }
  return marketData
}

export async function GET() {
  const now = Date.now()
  
  // Throttle generation
  if (now - lastGeneration < GENERATION_INTERVAL) {
    return NextResponse.json({ skipped: true, reason: "too_soon" })
  }
  lastGeneration = now
  
  try {
    await initRedis()
    const client = getRedisClient()
    
    // Get active connections
    const connections = await getAllConnections()
    const activeConnections = connections.filter((c: any) => c.isActive || c.is_active)
    
    let totalGenerated = 0
    let totalSymbols = 0
    
    for (const connection of activeConnections) {
      const { symbols, marketType } = symbolsForConnection(connection)
      totalSymbols += symbols.length
      for (const symbol of symbols) {
        try {
          const marketData = await getMarketData(symbol, "1s", connection.id)
          const candle = latestCandle(marketData)
          if (!candle) continue
          
          const close = parseFloat(candle?.close || candle?.c || "0")
          const open = parseFloat(candle?.open || candle?.o || "0")
          const high = parseFloat(candle?.high || candle?.h || "0")
          const low = parseFloat(candle?.low || candle?.l || "0")
          
          if (!(close > 0) || !(open > 0) || !(high >= low) || !(low > 0)) continue
          
          const direction = close >= open ? "long" : "short"
          const range = high - low
          const rangePercent = (range / close) * 100
          const activityThreshold = marketType === "forex" ? 0.02 : 1
          
          const indications = [
            { type: "direction", symbol, value: direction === "long" ? 1 : -1, profitFactor: 1.2, confidence: 0.7, timestamp: now, connection_id: connection.id, market_type: marketType },
            { type: "move", symbol, value: rangePercent > activityThreshold ? 1 : 0, profitFactor: 1.0 + rangePercent / 100, confidence: 0.6, timestamp: now, connection_id: connection.id, market_type: marketType },
            { type: "active", symbol, value: rangePercent > activityThreshold / 2 ? 1 : 0, profitFactor: 1.1, confidence: 0.65, timestamp: now, connection_id: connection.id, market_type: marketType },
            { type: "optimal", symbol, value: rangePercent > activityThreshold && direction === "long" ? 1 : 0, profitFactor: 1.3, confidence: 0.75, timestamp: now, connection_id: connection.id, market_type: marketType },
          ]
          
          // Save to Redis
          const key = `indications:${connection.id}`
          const existing = await client.get(key)
          const existingArr = existing ? JSON.parse(existing) : []
          existingArr.push(...indications)
          const trimmed = existingArr.slice(-1000)
          await client.set(key, JSON.stringify(trimmed))
          
          totalGenerated += indications.length
        } catch (symbolError) {
          // Continue with other symbols
        }
      }
    }
    
    return NextResponse.json({ 
      success: true, 
      generated: totalGenerated,
      connections: activeConnections.length,
      symbols: totalSymbols,
      timestamp: now
    })
  } catch (error) {
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : "Unknown error" 
    }, { status: 500 })
  }
}
