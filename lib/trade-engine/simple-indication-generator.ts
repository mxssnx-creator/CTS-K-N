/**
 * Simple Indication Generator
 * A standalone module that generates indications without relying on class instances.
 * This bypasses the cache initialization issues in IndicationProcessor.
 * @version 1.0.0
 */

import { initRedis, getRedisClient, getMarketData } from "@/lib/redis-db"

console.log("[v0] SimpleIndicationGenerator module loaded v1.0.0")

// Module-level cache - guaranteed to exist
const MARKET_DATA_CACHE = new Map<string, { data: any; timestamp: number }>()
const CACHE_TTL = 500

/**
 * Get market data with caching
 */
async function getCachedMarketData(symbol: string): Promise<any> {
  const now = Date.now()
  const cached = MARKET_DATA_CACHE.get(symbol)
  
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.data
  }
  
  try {
    await initRedis()
    const rawData = await getMarketData(symbol, "1m")
    if (!rawData) return null
    
    const latest = Array.isArray(rawData) ? rawData[0] : rawData
    if (latest) {
      MARKET_DATA_CACHE.set(symbol, { data: latest, timestamp: now })
    }
    return latest
  } catch (error) {
    console.error(`[v0] [SimpleIndicationGenerator] Failed to get market data for ${symbol}:`, error)
    return null
  }
}

/**
 * Generate simple indications for a symbol
 */
export async function generateIndications(symbol: string, connectionId: string): Promise<any[]> {
  try {
    const marketData = await getCachedMarketData(symbol)
    if (!marketData) {
      return []
    }
    
    const currentClose = Number(marketData.close || marketData.c || 0)
    const currentOpen = Number(marketData.open || marketData.o || 0)
    const currentHigh = Number(marketData.high || marketData.h || 0)
    const currentLow = Number(marketData.low || marketData.l || 0)
    
    if (!currentClose || !currentOpen) {
      return []
    }
    
    const range = currentHigh - currentLow
    const rangePercent = (range / currentClose) * 100
    const direction = currentClose >= currentOpen ? "long" : "short"
    const directionValue = direction === "long" ? 1 : -1
    
    const baseTimestamp = Date.now()
    const indications: any[] = []
    
    // Direction indication
    indications.push({
      id: `${symbol}-direction-${baseTimestamp}`,
      type: "direction",
      symbol,
      value: directionValue,
      profitFactor: 1.0 + rangePercent / 50,
      drawdownTime: 0,
      confidence: Math.min(0.5 + rangePercent / 10, 0.95),
      timestamp: baseTimestamp,
      step: 5,
      continuousPosition: false,
      metadata: { range, rangePercent, direction },
    })
    
    // Move indication
    indications.push({
      id: `${symbol}-move-${baseTimestamp}`,
      type: "move",
      symbol,
      value: rangePercent > 2 ? 1 : 0,
      profitFactor: 1.0 + rangePercent / 100,
      drawdownTime: 0,
      confidence: Math.min(0.4 + rangePercent / 20, 0.9),
      timestamp: baseTimestamp,
      step: 5,
      continuousPosition: false,
      metadata: { range, rangePercent },
    })
    
    // Active indication
    indications.push({
      id: `${symbol}-active-${baseTimestamp}`,
      type: "active",
      symbol,
      value: 1,
      profitFactor: 1.0 + rangePercent / 100,
      drawdownTime: 0,
      confidence: 0.7,
      timestamp: baseTimestamp,
      step: 5,
      continuousPosition: false,
      metadata: { marketActive: true },
    })
    
    // Optimal indication
    indications.push({
      id: `${symbol}-optimal-${baseTimestamp}`,
      type: "optimal",
      symbol,
      value: directionValue,
      profitFactor: 1.0 + rangePercent / 40,
      drawdownTime: 0,
      confidence: Math.min(0.5 + rangePercent / 15, 0.85),
      timestamp: baseTimestamp,
      step: 5,
      continuousPosition: false,
      metadata: { range, rangePercent, direction },
    })
    
    return indications
  } catch (error) {
    console.error(`[v0] [SimpleIndicationGenerator] Error generating indications for ${symbol}:`, error)
    return []
  }
}

/**
 * Generate and save indications for a symbol
 */
export async function generateAndSaveIndications(symbol: string, connectionId: string): Promise<any[]> {
  try {
    const indications = await generateIndications(symbol, connectionId)
    
    if (indications.length > 0) {
      await initRedis()
      const client = getRedisClient()
      if (client) {
        const key = `indications:${connectionId}`
        const existingRaw = await client.get(key)
        let existing: any[] = []
        if (existingRaw) {
          try {
            existing = JSON.parse(existingRaw)
          } catch { existing = [] }
        }
        
        // Merge new indications
        existing.push(...indications)
        
        // Keep last 500 indications
        const trimmed = existing.slice(-500)
        await client.set(key, JSON.stringify(trimmed))
      }
    }
    
    return indications
  } catch (error) {
    console.error(`[v0] [SimpleIndicationGenerator] Error saving indications for ${symbol}:`, error)
    return []
  }
}
