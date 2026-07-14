import { type NextRequest, NextResponse } from "next/server"
import { getConnection, getRedisClient, initRedis } from "@/lib/redis-db"
import { parseBooleanInput } from "@/lib/boolean-utils"
import { applyMainConnectionSettingsChange } from "@/lib/connection-recoordinator"
import { allocateStateSwitchVersion, queueEngineRefreshRequest } from "@/lib/engine-refresh-queue"
import { emitCanonicalEvent } from "@/lib/events/emitter"

// Legacy alias for dashboard state. The primary UI uses toggle-dashboard, but
// this route follows the same durable generation/refresh contract so older
// clients cannot bypass engine coordination.
export const dynamic = "force-dynamic"
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    if (body?.is_dashboard_active === undefined || body?.is_dashboard_active === null) {
      return NextResponse.json({ error: "Missing required is_dashboard_active flag" }, { status: 400 })
    }
    const enabled = parseBooleanInput(body.is_dashboard_active)

    await initRedis()
    const connection = await getConnection(id)
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 })

    const stateSwitchVersion = await allocateStateSwitchVersion(id, connection)
    const timestamp = new Date().toISOString()
    const patch = enabled
      ? {
          is_assigned: "1",
          is_active_inserted: "1",
          is_dashboard_inserted: "1",
          is_enabled_dashboard: "1",
          is_active: "1",
          state_switch_version: stateSwitchVersion,
          updated_at: timestamp,
        }
      : {
          is_assigned: "1",
          is_enabled_dashboard: "0",
          is_active: "0",
          state_switch_version: stateSwitchVersion,
          updated_at: timestamp,
        }

    const { stateTransitionApplied } = await applyMainConnectionSettingsChange(id, connection, {
      connectionPatch: patch,
      changedFieldsOverride: Object.keys(patch),
      settingsVersion: stateSwitchVersion,
      stateSwitchVersion,
      logTag: "POST /settings/connections/[id]/dashboard",
    })
    if (!stateTransitionApplied) {
      return NextResponse.json({ error: "Dashboard switch was superseded by a newer state" }, { status: 409 })
    }
    if (enabled) {
      await getRedisClient().hset("trade_engine:global", {
        status: "running",
        desired_status: "running",
        operator_intent: "running",
        coordinator_ready: "true",
        operator_stopped: "0",
        operator_stopped_at: "",
        stopped_at: "",
        updated_at: timestamp,
      })
    }
    await queueEngineRefreshRequest({
      connectionId: id,
      action: enabled ? "start" : "stop",
      state_switch_version: stateSwitchVersion,
      reason: "legacy_dashboard_toggle",
      timestamp,
    })
    emitCanonicalEvent({
      type: "connection.recoordinated",
      connectionId: id,
      stage: "connection",
      settingsVersion: stateSwitchVersion,
      data: { action: enabled ? "enabled" : "disabled", is_enabled_dashboard: enabled },
    })

    return NextResponse.json({ success: true, is_dashboard_active: enabled })
  } catch (error) {
    console.error("[v0] [DashboardRoute] Failed to toggle dashboard active:", error)
    return NextResponse.json({ error: "Failed to toggle dashboard active" }, { status: 500 })
  }
}
