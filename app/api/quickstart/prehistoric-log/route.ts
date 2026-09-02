import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { iterateRedisKeys } from "@/lib/redis-scan"

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

    // Stream the keyspace page by page. This diagnostic endpoint used to keep
    // every Redis key and four derived arrays in memory just to calculate
    // counters, which amplified the host pressure during polling.
    let indicationCount = 0
    let strategyCount = 0
    let positionCount = 0
    let entryCount = 0
    const symbolsSet = new Set<string>()
    for await (const key of iterateRedisKeys(client, "*", { count: 500 })) {
      if (key.includes("indication")) {
        indicationCount++
      // Parse symbol from key (e.g., "indication:BTCUSDT:...")
        const parts = key.split(":")
        if (parts[1]) symbolsSet.add(parts[1])
      }
      if (key.includes("strategy")) strategyCount++
      if (key.includes("position")) positionCount++
      if (key.includes("entry")) entryCount++
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
          indicationsCalculated: indicationCount,
        },
        strategyEngine: {
          cyclesExecuted: strategyCycleCount,
          avgCycleDuration: strategyCycleDuration,
          symbolsEvaluatedPerCycle: symbolsArray.length,
          strategiesEvaluated: strategyCount,
        },
        symbols: {
          count: symbolsArray.length,
          list: symbolsArray,
        },
        data: {
          positionsCreated: positionCount,
          entriesCreated: entryCount,
          totalIndicationRecords: indicationCount,
          totalStrategyRecords: strategyCount,
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
