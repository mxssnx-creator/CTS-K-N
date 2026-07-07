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

    console.log("[v0] Starting preset coordination engine:", { connectionId, presetTypeId })

    await initRedis()
    const client = getRedisClient()

    // 1. Check if Global Trade Engine Coordinator is running
    const globalState = await client.hgetall("trade_engine:global")
    if (globalState?.status !== "running") {
      return NextResponse.json({
        error: "Global Trade Engine must be running first",
        hint: "Start the Global Trade Engine Coordinator before enabling preset engines.",
      }, { status: 400 })
    }

    // 2. Verify connection exists and is enabled
    const connection = await getConnection(connectionId)
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const isEnabled = connection.is_enabled === "1" || connection.is_enabled === true
    if (!isEnabled) {
      return NextResponse.json({ error: "Connection must be enabled first" }, { status: 400 })
    }

    // 3. Update connection with preset trade flags
    await updateConnection(connectionId, {
      ...connection,
      is_preset_trade: "1",
      preset_type_id: presetTypeId,
      updated_at: new Date().toISOString(),
    })

    // 4. Store preset engine state in Redis
    await client.hset(`preset_engine:${connectionId}:${presetTypeId}`, {
      status: "running",
      started_at: new Date().toISOString(),
      stopped_at: "",
      updated_at: new Date().toISOString(),
      connection_id: connectionId,
      preset_id: presetTypeId,
    })

    await SystemLogger.logTradeEngine(`Preset engine started`, "info", {
      connectionId,
      presetTypeId,
      status: "running",
    })

    return NextResponse.json({
      success: true,
      message: "Preset coordination engine started",
      connectionId,
      presetTypeId,
      status: "running",
    })
  } catch (error) {
    console.error("[v0] Failed to start preset coordination engine:", error)
    await SystemLogger.logError(error, "trade-engine", "Failed to start preset coordination engine")

    return NextResponse.json(
      {
        error: "Failed to start preset coordination engine",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
