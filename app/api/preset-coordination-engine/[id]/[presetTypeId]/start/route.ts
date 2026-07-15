import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient, getConnection } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"
import { applyMainConnectionSettingsChange } from "@/lib/connection-recoordinator"
import { allocateStateSwitchVersion } from "@/lib/engine-refresh-queue"
import { emitCanonicalEvent } from "@/lib/events/emitter"
import { isTruthyFlag } from "@/lib/boolean-utils"

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

    // 3. Update connection through the same generation-guarded mode path as
    // the main Preset UI switch.
    const stateSwitchVersion = await allocateStateSwitchVersion(connectionId, connection)
    const changedAt = new Date().toISOString()
    const connectionPatch = {
      is_preset_trade: "1",
      preset_type_id: presetTypeId,
      is_assigned: "1",
      is_active_inserted: "1",
      is_dashboard_inserted: "1",
      is_enabled_dashboard: "1",
      is_active: "1",
      state_switch_version: stateSwitchVersion,
      state_switch_action: "preset_engine_start",
      updated_at: changedAt,
    }
    const flagFields = new Set([
      "is_preset_trade",
      "is_assigned",
      "is_active_inserted",
      "is_dashboard_inserted",
      "is_enabled_dashboard",
      "is_active",
    ])
    const changedFieldsOverride = Object.keys(connectionPatch).filter((field) => {
      if (field === "updated_at") return false
      if (field === "state_switch_version") return true
      if (flagFields.has(field)) return isTruthyFlag(connection[field]) !== isTruthyFlag((connectionPatch as any)[field])
      return JSON.stringify(connection[field]) !== JSON.stringify((connectionPatch as any)[field])
    })
    const { stateTransitionApplied } = await applyMainConnectionSettingsChange(connectionId, connection, {
      connectionPatch,
      changedFieldsOverride,
      settingsVersion: stateSwitchVersion,
      stateSwitchVersion,
      logTag: "POST /preset-coordination-engine/start",
    })
    if (!stateTransitionApplied) {
      return NextResponse.json({ error: "Preset start was superseded by a newer state" }, { status: 409 })
    }

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
    emitCanonicalEvent({
      type: "connection.recoordinated",
      connectionId,
      stage: "connection",
      settingsVersion: stateSwitchVersion,
      data: { mode: "preset", enabled: true, presetTypeId },
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
