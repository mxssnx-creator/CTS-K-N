import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { initRedis, getConnection } from "@/lib/redis-db"
import { isTruthyFlag } from "@/lib/boolean-utils"
import { maskConnectionSecrets } from "@/lib/connection-secrets"
import { applyMainConnectionSettingsChange } from "@/lib/connection-recoordinator"
import { allocateStateSwitchVersion } from "@/lib/engine-refresh-queue"
import { emitCanonicalEvent } from "@/lib/events/emitter"

/**
 * POST /api/settings/connections/add-to-active
 * Add a base connection to the Active Connections list
 * 
 * Action:
 * 1. Load the base connection (predefined)
 * 2. Create an "active copy" state in Redis
 * 3. Set is_enabled_dashboard=0 (off by default) but keep inserted in Main panel
 * 4. Preserve base is_enabled state from Settings
 * 5. Reset trade flags (is_live_trade, is_preset_trade to false)
 */
export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    const { connectionId } = await request.json()

    if (!connectionId) {
      return NextResponse.json({ error: "connectionId required" }, { status: 400 })
    }

    console.log(`[v0] [Add to Active] Adding ${connectionId} to Active Connections`)
    await initRedis()

    const baseConnection = await getConnection(connectionId)
    if (!baseConnection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const alreadyInserted =
      isTruthyFlag(baseConnection.is_active_inserted) ||
      isTruthyFlag(baseConnection.is_dashboard_inserted) ||
      isTruthyFlag(baseConnection.is_assigned)

    const stateSwitchVersion = await allocateStateSwitchVersion(connectionId, baseConnection)
    const updatedAt = new Date().toISOString()
    // Assignment is a runtime state transition, not an ordinary settings
    // write. Commit every alias under one generation so a concurrent Enable /
    // Remove action cannot be overwritten by this route's older snapshot.
    const connectionPatch = alreadyInserted
      ? {
          is_active_inserted: "1",
          is_dashboard_inserted: "1",
          is_assigned: "1",
          is_inserted: "1",
          is_enabled_dashboard: baseConnection.is_enabled_dashboard ?? baseConnection.is_active ?? "0",
          is_active: baseConnection.is_active ?? baseConnection.is_enabled_dashboard ?? "0",
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
          is_live_trade: "0",
          live_trade_requested: "0",
          is_preset_trade: "0",
          state_switch_version: stateSwitchVersion,
          updated_at: updatedAt,
        }

    const { connection: activeConnection, stateTransitionApplied } = await applyMainConnectionSettingsChange(
      connectionId,
      baseConnection,
      {
        connectionPatch,
        changedFieldsOverride: Object.keys(connectionPatch),
        settingsVersion: stateSwitchVersion,
        stateSwitchVersion,
        logTag: "POST /settings/connections/add-to-active",
      },
    )
    if (!stateTransitionApplied) {
      return NextResponse.json(
        { success: false, error: "Assignment was superseded by a newer connection state" },
        { status: 409 },
      )
    }

    await SystemLogger.logConnection(
      alreadyInserted ? "Normalized existing Active panel assignment" : "Inserted into Active panel. Toggle to enable.",
      connectionId,
      "info",
      {
        is_active_inserted: true,
        is_enabled_dashboard: isTruthyFlag(activeConnection.is_enabled_dashboard),
        is_enabled: activeConnection.is_enabled,
      },
    )
    emitCanonicalEvent({
      type: "connection.recoordinated",
      connectionId,
      stage: "connection",
      settingsVersion: stateSwitchVersion,
      data: {
        action: "assigned",
        alreadyActive: alreadyInserted,
        is_enabled_dashboard: isTruthyFlag(activeConnection.is_enabled_dashboard),
      },
    })

    return NextResponse.json({
      success: true,
      alreadyActive: alreadyInserted,
      message: alreadyInserted
        ? "Connection already assigned; state aliases were normalized."
        : "Connection inserted into Active panel. Toggle Enable to start processing.",
      connection: maskConnectionSecrets(activeConnection),
    })
  } catch (error) {
    console.error(`[v0] [Add to Active] Exception:`, error)
    await SystemLogger.logError(error, "api", `POST /api/settings/connections/add-to-active`)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to add connection",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
