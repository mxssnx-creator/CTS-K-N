import { NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { isConnectionMainProcessing } from "@/lib/connection-state-utils"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await initRedis()
    const client = getRedisClient()
    const { id: connectionId } = await params

    if (!connectionId) {
      return NextResponse.json({ error: "Missing id parameter" }, { status: 400 })
    }

    const [bareConnection, settingsConnection] = await Promise.all([
      client.hgetall(`connection:${connectionId}`).catch(() => ({})),
      client.hgetall(`settings:connection:${connectionId}`).catch(() => ({})),
    ])
    const pipelineEnabled = isConnectionMainProcessing({
      ...(bareConnection || {}),
      ...(settingsConnection || {}),
    })

    // Base → Main → Real → Live is one coordinated processing pipeline.
    // Stages cannot be enabled or disabled independently; only their measured
    // populations differ.
    const strategies = [
      await getStrategyData(client, connectionId, "base", pipelineEnabled),
      await getStrategyData(client, connectionId, "main", pipelineEnabled),
      await getStrategyData(client, connectionId, "real", pipelineEnabled),
      await getStrategyData(client, connectionId, "live", pipelineEnabled),
    ].filter(Boolean)

    return NextResponse.json({ strategies })
  } catch (error) {
    console.error("[Strategies API] Error:", error)
    return NextResponse.json(
      {
        strategies: [
          { type: "base", enabled: false, rangeCount: 0, activePositions: 0, totalIndications: 0, successRate: 0 },
          { type: "main", enabled: false, rangeCount: 0, activePositions: 0, totalIndications: 0, successRate: 0 },
          { type: "real", enabled: false, rangeCount: 0, activePositions: 0, totalIndications: 0, successRate: 0 },
          { type: "live", enabled: false, rangeCount: 0, activePositions: 0, totalIndications: 0, successRate: 0 },
        ],
        error: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    )
  }
}

async function getStrategyData(
  client: any,
  connectionId: string,
  type: string,
  pipelineEnabled: boolean,
) {
  try {
    const key = `strategies:${connectionId}:${type}`
    const data = await client.hgetall(key)

    if (!data || Object.keys(data).length === 0) {
      // Return default values
      return {
        type,
        enabled: pipelineEnabled,
        rangeCount: 0,
        activePositions: 0,
        totalIndications: 0,
        successRate: 0,
      }
    }

    return {
      type,
      enabled: pipelineEnabled,
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
