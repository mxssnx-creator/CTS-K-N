import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getMarketData, getAllConnections } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export const revalidate = 0

// Track last generation to avoid flooding
let lastGeneration = 0
const GENERATION_INTERVAL = 1000 // 1 second

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

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
    
    for (const connection of activeConnections) {
      for (const symbol of SYMBOLS) {
        try {
          const marketData = await getMarketData(symbol, "1m")
          if (!marketData) continue
          
          const close = parseFloat(marketData?.close || marketData?.c || "0")
          const open = parseFloat(marketData?.open || marketData?.o || "0")
          const high = parseFloat(marketData?.high || marketData?.h || "0")
          const low = parseFloat(marketData?.low || marketData?.l || "0")
          
          if (close === 0) continue
          
          const direction = close >= open ? "long" : "short"
          const range = high - low
          const rangePercent = (range / close) * 100
          
          const indications = [
            { type: "direction", symbol, value: direction === "long" ? 1 : -1, profitFactor: 1.2, confidence: 0.7, timestamp: now },
            { type: "move", symbol, value: rangePercent > 2 ? 1 : 0, profitFactor: 1.0 + rangePercent/100, confidence: 0.6, timestamp: now },
            { type: "active", symbol, value: rangePercent > 1 ? 1 : 0, profitFactor: 1.1, confidence: 0.65, timestamp: now },
            { type: "optimal", symbol, value: direction === "long" && rangePercent > 1.5 ? 1 : 0, profitFactor: 1.3, confidence: 0.75, timestamp: now },
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
      symbols: SYMBOLS.length,
      timestamp: now
    })
  } catch (error) {
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : "Unknown error" 
    }, { status: 500 })
  }
}
