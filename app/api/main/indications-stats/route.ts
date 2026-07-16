import { NextResponse } from "next/server"
import { initRedis, getAllConnections, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()

    // Get indications from Redis keys: indications:{connectionId}:{symbol}:{type}
    const indicationKeys = await client.keys("indications:*")
    
    const indicationStats = {
      direction: { count: 0, avgSignalStrength: 0, lastTrigger: null, profitFactor: 0, signals: [] as any[] },
      move: { count: 0, avgSignalStrength: 0, lastTrigger: null, profitFactor: 0, signals: [] as any[] },
      active: { count: 0, avgSignalStrength: 0, lastTrigger: null, profitFactor: 0, signals: [] as any[] },
      optimal: { count: 0, avgSignalStrength: 0, lastTrigger: null, profitFactor: 0, signals: [] as any[] },
      auto: { count: 0, avgSignalStrength: 0, lastTrigger: null, profitFactor: 0, signals: [] as any[] },
      trend: { count: 0, avgSignalStrength: 0, lastTrigger: null, profitFactor: 0, signals: [] as any[] },
    }

    // Fetch all indications
    for (const key of indicationKeys) {
      const indication = await client.get(key)
      if (!indication) continue

      const data = JSON.parse(indication)
      const type = data.type as "direction" | "move" | "active" | "optimal" | "auto" | "trend"

      if (indicationStats[type]) {
        indicationStats[type].signals.push(data)
        indicationStats[type].count++

        // Track latest trigger
        if (!indicationStats[type].lastTrigger || new Date(data.timestamp) > new Date(indicationStats[type].lastTrigger)) {
          indicationStats[type].lastTrigger = data.timestamp
        }
      }
    }

    // Calculate aggregates for each indication type
    Object.keys(indicationStats).forEach((type) => {
      const stats = indicationStats[type as "direction" | "move" | "active" | "optimal" | "auto" | "trend"]
      if (stats.signals.length > 0) {
        const avgSignalStrength = stats.signals.reduce((sum: number, s: any) => sum + (s.signal_strength || 0), 0) / stats.signals.length
        const avgProfitFactor = stats.signals.reduce((sum: number, s: any) => sum + (s.profit_factor || 1), 0) / stats.signals.length
        
        stats.avgSignalStrength = avgSignalStrength
        stats.profitFactor = avgProfitFactor
      }
      
      // Remove the signals array from response
      delete (stats as any).signals
    })

    return NextResponse.json({
      success: true,
      indications: indicationStats,
    })
  } catch (error) {
    console.error("[v0] Failed to fetch indications stats:", error)
    return NextResponse.json({
      success: false,
      error: "Failed to fetch indications stats",
      indications: {
        direction: { count: 0, avgSignalStrength: 0, lastTrigger: null, profitFactor: 0 },
        move: { count: 0, avgSignalStrength: 0, lastTrigger: null, profitFactor: 0 },
        active: { count: 0, avgSignalStrength: 0, lastTrigger: null, profitFactor: 0 },
        optimal: { count: 0, avgSignalStrength: 0, lastTrigger: null, profitFactor: 0 },
        auto: { count: 0, avgSignalStrength: 0, lastTrigger: null, profitFactor: 0 },
        trend: { count: 0, avgSignalStrength: 0, lastTrigger: null, profitFactor: 0 },
      },
    })
  }
}
