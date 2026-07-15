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

    console.log("[v0] Stopping preset coordination engine:", { connectionId, presetTypeId })

    await initRedis()
    const client = getRedisClient()

    // Update connection to mark preset trade as disabled
    const connection = await getConnection(connectionId)
    if (connection) {
      const stateSwitchVersion = await allocateStateSwitchVersion(connectionId, connection)
      const changedAt = new Date().toISOString()
      const connectionPatch = {
        is_preset_trade: "0",
        state_switch_version: stateSwitchVersion,
        state_switch_action: "preset_engine_stop",
        updated_at: changedAt,
      }
      const changedFieldsOverride = Object.keys(connectionPatch).filter((field) => {
        if (field === "updated_at") return false
        if (field === "state_switch_version") return true
        if (field === "is_preset_trade") return isTruthyFlag(connection[field]) !== isTruthyFlag(connectionPatch[field])
        return JSON.stringify(connection[field]) !== JSON.stringify(connectionPatch[field as keyof typeof connectionPatch])
      })
      const { stateTransitionApplied } = await applyMainConnectionSettingsChange(connectionId, connection, {
        connectionPatch,
        changedFieldsOverride,
        settingsVersion: stateSwitchVersion,
        stateSwitchVersion,
        logTag: "POST /preset-coordination-engine/stop",
      })
      if (!stateTransitionApplied) {
        return NextResponse.json({ error: "Preset stop was superseded by a newer state" }, { status: 409 })
      }

      await client.hset(`preset_engine:${connectionId}:${presetTypeId}`, {
        status: "stopped",
        stopped_at: changedAt,
        updated_at: changedAt,
      })
      emitCanonicalEvent({
        type: "connection.recoordinated",
        connectionId,
        stage: "connection",
        settingsVersion: stateSwitchVersion,
        data: { mode: "preset", enabled: false, presetTypeId },
      })
    } else {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
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
