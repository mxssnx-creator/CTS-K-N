import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { getConnection, initRedis } from "@/lib/redis-db"
import { applyMainConnectionSettingsChange } from "@/lib/connection-recoordinator"
import { allocateStateSwitchVersion, queueEngineRefreshRequest } from "@/lib/engine-refresh-queue"
import { emitCanonicalEvent } from "@/lib/events/emitter"
import { maskConnectionSecrets } from "@/lib/connection-secrets"

const isEnabledFlag = (value: unknown) =>
  value === true || value === 1 || value === "1" || value === "true"

const ACTIVE_FIELDS = [
  "is_active_inserted",
  "is_dashboard_inserted",
  "is_assigned",
  "is_inserted",
  "is_enabled_dashboard",
  "is_active",
  "is_live_trade",
  "live_trade_requested",
  "is_preset_trade",
  "state_switch_version",
]

const ACTIVE_FLAG_FIELDS = new Set(ACTIVE_FIELDS.filter((field) => field !== "state_switch_version"))

function changedActivePatchFields(before: Record<string, any>, patch: Record<string, any>): string[] {
  return Object.keys(patch).filter((field) => {
    if (field === "updated_at") return false
    if (field === "state_switch_version") return true
    if (ACTIVE_FLAG_FIELDS.has(field)) return isEnabledFlag(before[field]) !== isEnabledFlag(patch[field])
    return JSON.stringify(before[field]) !== JSON.stringify(patch[field])
  })
}

export const dynamic = "force-dynamic"

// Add a connection to the Main panel. A newly added connection is deliberately
// disabled until the operator uses the Enable switch.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: connectionId } = await params
  try {
    await initRedis()
    const connection = await getConnection(connectionId)
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 })

    const alreadyInserted =
      isEnabledFlag(connection.is_active_inserted) ||
      isEnabledFlag(connection.is_dashboard_inserted)
    const stateSwitchVersion = await allocateStateSwitchVersion(connectionId, connection)
    const updatedAt = new Date().toISOString()
    const patch = alreadyInserted
      ? {
          is_active_inserted: "1",
          is_dashboard_inserted: "1",
          is_assigned: "1",
          is_inserted: "1",
          // Preserve the operator-owned running state when normalizing aliases.
          is_enabled_dashboard: connection.is_enabled_dashboard ?? connection.is_active ?? "0",
          is_active: connection.is_active ?? connection.is_enabled_dashboard ?? "0",
          state_switch_version: stateSwitchVersion,
          updated_at: updatedAt,
        }
      : {
          is_active_inserted: "1",
          is_dashboard_inserted: "1",
          is_assigned: "1",
          is_inserted: "1",
          is_enabled_dashboard: "0",
          is_active: "0",
          // A newly assigned, disabled card must never inherit stale order
          // intent from a previous/legacy state. Live and Preset are explicit
          // switches the operator can re-enable after Main processing starts.
          is_live_trade: "0",
          live_trade_requested: "0",
          is_preset_trade: "0",
          state_switch_version: stateSwitchVersion,
          updated_at: updatedAt,
        }

    const { connection: updatedConnection, stateTransitionApplied } = await applyMainConnectionSettingsChange(
      connectionId,
      connection,
      {
        connectionPatch: patch,
        // Only advertise fields that actually changed. Passing the complete
        // ACTIVE_FIELDS list on every idempotent assignment falsely reported a
        // Live/Preset mode change and destructively restarted prehistoric
        // progression even though those switches were untouched.
        changedFieldsOverride: changedActivePatchFields(connection, patch),
        settingsVersion: stateSwitchVersion,
        stateSwitchVersion,
        logTag: "POST /settings/connections/[id]/active",
      },
    )
    if (!stateTransitionApplied) {
      return NextResponse.json({ error: "Assignment was superseded by a newer state" }, { status: 409 })
    }

    await SystemLogger.logConnection(
      alreadyInserted ? "Dashboard: Normalized existing active connection" : "Dashboard: Added active connection (disabled)",
      connectionId,
      "info",
    )
    emitCanonicalEvent({
      type: "connection.recoordinated",
      connectionId,
      stage: "connection",
      settingsVersion: stateSwitchVersion,
      data: { action: "assigned", alreadyActive: alreadyInserted, is_enabled_dashboard: isEnabledFlag(updatedConnection.is_enabled_dashboard) },
    })

    return NextResponse.json({
      success: true,
      connection: maskConnectionSecrets(updatedConnection),
      alreadyActive: alreadyInserted,
      message: alreadyInserted
        ? "Connection already in active panel (aliases normalized)"
        : "Connection added to active dashboard (disabled until enabled by operator)",
    })
  } catch (error) {
    await SystemLogger.logError(error, "api", "POST /api/settings/connections/[id]/active")
    return NextResponse.json(
      { error: "Failed to add active connection", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}

// Remove a connection from the Main panel while retaining the Settings record.
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: connectionId } = await params
  try {
    await initRedis()
    const connection = await getConnection(connectionId)
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 })

    const stateSwitchVersion = await allocateStateSwitchVersion(connectionId, connection)
    const updatedAt = new Date().toISOString()
    const { connection: updatedConnection, stateTransitionApplied } = await applyMainConnectionSettingsChange(
      connectionId,
      connection,
      {
        connectionPatch: {
          is_active_inserted: "0",
          is_dashboard_inserted: "0",
          is_enabled_dashboard: "0",
          is_active: "0",
          is_assigned: "0",
          is_inserted: "0",
          is_live_trade: "0",
          live_trade_requested: "0",
          is_preset_trade: "0",
          state_switch_version: stateSwitchVersion,
          updated_at: updatedAt,
        },
        changedFieldsOverride: changedActivePatchFields(connection, {
          is_active_inserted: "0",
          is_dashboard_inserted: "0",
          is_enabled_dashboard: "0",
          is_active: "0",
          is_assigned: "0",
          is_inserted: "0",
          is_live_trade: "0",
          live_trade_requested: "0",
          is_preset_trade: "0",
          state_switch_version: stateSwitchVersion,
          updated_at: updatedAt,
        }),
        settingsVersion: stateSwitchVersion,
        stateSwitchVersion,
        logTag: "DELETE /settings/connections/[id]/active",
      },
    )
    if (!stateTransitionApplied) {
      return NextResponse.json({ error: "Removal was superseded by a newer state" }, { status: 409 })
    }

    await queueEngineRefreshRequest({
      connectionId,
      action: "stop",
      state_switch_version: stateSwitchVersion,
      reason: "active_connection_removed",
      timestamp: updatedAt,
    })
    await SystemLogger.logConnection("Dashboard: Removed active connection", connectionId, "info")
    emitCanonicalEvent({
      type: "connection.recoordinated",
      connectionId,
      stage: "connection",
      settingsVersion: stateSwitchVersion,
      data: { action: "removed", is_enabled_dashboard: false },
    })

    return NextResponse.json({
      success: true,
      connection: maskConnectionSecrets(updatedConnection),
      message: "Connection removed from active panel",
    })
  } catch (error) {
    await SystemLogger.logError(error, "api", "DELETE /api/settings/connections/[id]/active")
    return NextResponse.json(
      { error: "Failed to remove active connection", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}
