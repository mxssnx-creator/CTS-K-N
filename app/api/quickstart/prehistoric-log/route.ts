import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

/**
 * Prehistoric Logging - Captures historical data about indications and strategies
 * before trade engine or active connections were enabled
 */
export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()

    // Get all indication-related keys to count historical cycles
    const allKeys = await client.keys("*").catch(() => [])
    
    const indicationKeys = allKeys.filter((k: string) => k.includes("indication"))
    const strategyKeys = allKeys.filter((k: string) => k.includes("strategy"))
    const positionKeys = allKeys.filter((k: string) => k.includes("position"))
    const entryKeys = allKeys.filter((k: string) => k.includes("entry"))

    // Analyze symbols processed
    const symbolsSet = new Set<string>()
    for (const key of indicationKeys) {
      // Parse symbol from key (e.g., "indication:BTCUSDT:...")
      const parts = key.split(":")
      if (parts[1]) {
        symbolsSet.add(parts[1])
      }
    }
    const symbolsArray = Array.from(symbolsSet).sort()

    // Get indication engine state
    const indicationState = await client.hgetall("engine:indications:state").catch(() => null) as Record<string, string> | null
    const cycleCount = indicationState?.cycleCount ? parseInt(indicationState.cycleCount) : 0
    const cycleDuration = indicationState?.cycleDuration_ms ? parseInt(indicationState.cycleDuration_ms) : 0

    // Get strategy engine state
    const strategyState = await client.hgetall("engine:strategies:state").catch(() => null) as Record<string, string> | null
    const strategyCycleCount = strategyState?.cycleCount ? parseInt(strategyState.cycleCount) : 0
    const strategyCycleDuration = strategyState?.cycleDuration_ms ? parseInt(strategyState.cycleDuration_ms) : 0

    return NextResponse.json({
      success: true,
      prehistoric: {
        processState: "running",
        indicationEngine: {
          cyclesExecuted: cycleCount,
          avgCycleDuration: cycleDuration,
          symbolsProcessedPerCycle: symbolsArray.length,
          indicationsCalculated: indicationKeys.length,
        },
        strategyEngine: {
          cyclesExecuted: strategyCycleCount,
          avgCycleDuration: strategyCycleDuration,
          symbolsEvaluatedPerCycle: symbolsArray.length,
          strategiesEvaluated: strategyKeys.length,
        },
        symbols: {
          count: symbolsArray.length,
          list: symbolsArray,
        },
        data: {
          positionsCreated: positionKeys.length,
          entriesCreated: entryKeys.length,
          totalIndicationRecords: indicationKeys.length,
          totalStrategyRecords: strategyKeys.length,
        },
      },
    })
  } catch (error) {
    console.error("[PrehistoricLog] Error:", error)
    return NextResponse.json(
      {
        error: "Failed to fetch prehistoric log",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
