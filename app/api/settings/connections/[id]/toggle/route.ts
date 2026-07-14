import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { initRedis, getConnection, updateConnection } from "@/lib/redis-db"
import { parseBooleanInput, toRedisFlag } from "@/lib/boolean-utils"
import { emitCanonicalEvent } from "@/lib/events/emitter"

// POST toggle connection enabled status
// NOTE: Trade engines DO NOT start here
// Main/Preset engines are controlled independently via their toggle endpoints:
// - /api/settings/connections/[id]/live-trade (controls Main Engine)
// - /api/settings/connections/[id]/preset-type (controls Preset Engine)
export const dynamic = "force-dynamic"
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id
    const body = await request.json()
    const isEnabled = parseBooleanInput(body?.is_enabled)

    console.log("[v0] [Toggle] Toggling connection enabled:", connectionId, "enabled:", isEnabled)

    await initRedis()
    const connection = await getConnection(connectionId)

    if (!connection) {
      console.error("[v0] [Toggle] Connection not found:", connectionId)
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Update connection in Redis with updated_at timestamp
    const connectionPatch = {
      is_enabled: toRedisFlag(isEnabled),
      updated_at: new Date().toISOString(),
    }

    const updatedConnection = (await updateConnection(connectionId, connectionPatch)) || {
      ...connection,
      ...connectionPatch,
    }
    console.log("[v0] [Toggle] Connection is_enabled updated:", connectionId, "=", isEnabled)

    // Log the change but do NOT start/stop engines here
    // Engine control is separate via live-trade and preset-type endpoints
    await SystemLogger.logConnection(
      `Connection toggled: is_enabled=${isEnabled}. Engines controlled separately via live-trade/preset-type endpoints.`,
      connectionId,
      "info",
      { is_enabled: isEnabled },
    )

    emitCanonicalEvent({
      type: "dashboard.sectionUpdated",
      connectionId,
      stage: "dashboard",
      settingsVersion: updatedConnection.updated_at,
      data: { section: "connections", is_enabled: isEnabled },
    })

    return NextResponse.json({
      success: true,
      // Never echo exchange credentials from a state-only toggle response.
      connection: {
        id: connectionId,
        name: updatedConnection.name,
        exchange: updatedConnection.exchange,
        is_enabled: updatedConnection.is_enabled,
        updated_at: updatedConnection.updated_at,
      },
      message: `Connection ${isEnabled ? "enabled" : "disabled"}. Trade engines are controlled separately.`,
    })
  } catch (error) {
    console.error("[v0] [Toggle] Exception:", error)
    const errorMsg = error instanceof Error ? error.message : String(error)

    try {
      await SystemLogger.logError(error, "api", "POST /api/settings/connections/[id]/toggle")
    } catch (logError) {
      console.warn("[v0] [Toggle] Failed to log error:", logError)
    }

    return NextResponse.json(
      {
        error: "Failed to toggle connection",
        details: errorMsg,
      },
      { status: 500 },
    )
  }
}
