import { NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    await initRedis()
    const client = getRedisClient()
    const connectionId = params.id

    if (!connectionId) {
      return NextResponse.json({ error: "Missing id parameter" }, { status: 400 })
    }

    // Get strategy data from Redis
    const strategies = [
      await getStrategyData(client, connectionId, "base"),
      await getStrategyData(client, connectionId, "main"),
      await getStrategyData(client, connectionId, "real"),
    ].filter(Boolean)

    return NextResponse.json({ strategies })
  } catch (error) {
    console.error("[Strategies API] Error:", error)
    return NextResponse.json(
      {
        strategies: [
          { type: "base", enabled: true, rangeCount: 0, activePositions: 0, totalIndications: 0, successRate: 0 },
          { type: "main", enabled: false, rangeCount: 0, activePositions: 0, totalIndications: 0, successRate: 0 },
          { type: "real", enabled: false, rangeCount: 0, activePositions: 0, totalIndications: 0, successRate: 0 },
        ],
        error: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    )
  }
}

async function getStrategyData(client: any, connectionId: string, type: string) {
  try {
    const key = `strategies:${connectionId}:${type}`
    const data = await client.hgetall(key)

    if (!data || Object.keys(data).length === 0) {
      // Return default values
      return {
        type,
        enabled: type === "base", // Base is always enabled by default
        rangeCount: 0,
        activePositions: 0,
        totalIndications: 0,
        successRate: 0,
      }
    }

    return {
      type,
      enabled: data.enabled === "true" || data.enabled === "1",
      rangeCount: parseInt(data.rangeCount) || 0,
      activePositions: parseInt(data.activePositions) || 0,
      totalIndications: parseInt(data.totalIndications) || 0,
      successRate: parseFloat(data.successRate) || 0,
    }
  } catch (error) {
    console.warn(`[Strategies API] Failed to get ${type} data:`, error)
    return null
  }
}