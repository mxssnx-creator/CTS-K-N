import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient, getConnection, updateConnection } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"

export const dynamic = "force-dynamic"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; presetTypeId: string }> },
) {
  try {
    const { id: connectionId, presetTypeId } = await params

    console.log("[v0] Stopping preset coordination engine:", { connectionId, presetTypeId })

    await initRedis()
    const client = getRedisClient()

    // Update preset engine state in Redis
    await client.hset(`preset_engine:${connectionId}:${presetTypeId}`, {
      status: "stopped",
      stopped_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    // Update connection to mark preset trade as disabled
    const connection = await getConnection(connectionId)
    if (connection) {
      await updateConnection(connectionId, {
        ...connection,
        is_preset_trade: "0",
        updated_at: new Date().toISOString(),
      })
    }

    await SystemLogger.logTradeEngine(`Preset engine stopped`, "info", {
      connectionId,
      presetTypeId,
      status: "stopped",
    })

    return NextResponse.json({
      success: true,
      message: "Preset coordination engine stopped",
      connectionId,
      presetTypeId,
      status: "stopped",
    })
  } catch (error) {
    console.error("[v0] Failed to stop preset coordination engine:", error)
    await SystemLogger.logError(error, "trade-engine", "Failed to stop preset coordination engine")

    return NextResponse.json(
      {
        error: "Failed to stop preset coordination engine",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
