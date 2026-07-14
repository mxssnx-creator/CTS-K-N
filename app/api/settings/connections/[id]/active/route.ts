import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { initRedis, getConnection, updateConnection, getRedisClient } from "@/lib/redis-db"
import { notifySettingsChanged } from "@/lib/settings-coordinator"

const isEnabledFlag = (value: unknown) =>
  value === true || value === 1 || value === "1" || value === "true"

// POST - Add connection to active connections (set is_enabled_dashboard flag)
export const dynamic = "force-dynamic"
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id

    await initRedis()
    const connection = await getConnection(connectionId)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Idempotency guard: if connection is already in the Active panel, return
    // the current state without resetting is_enabled_dashboard to "0". This
    // prevents re-adding a live connection from silently disabling it.
    const alreadyInserted =
      isEnabledFlag(connection.is_active_inserted) ||
      isEnabledFlag((connection as any).is_dashboard_inserted)
    if (alreadyInserted) {
      const normalizedConnection = {
        ...connection,
        is_active_inserted: "1",
        is_dashboard_inserted: "1",
        is_assigned: "1",
        // Preserve the operator's current enabled/running state. Re-adding an
        // already visible card must never disable it or create a duplicate row.
        is_enabled_dashboard: connection.is_enabled_dashboard ?? connection.is_active ?? "0",
        is_active: connection.is_active ?? connection.is_enabled_dashboard ?? "0",
        updated_at: new Date().toISOString(),
      }
      await updateConnection(connectionId, normalizedConnection).catch(() => null)
      return NextResponse.json({
        success: true,
        connection: normalizedConnection,
        message: "Connection already in active panel (normalized aliases only)",
        alreadyActive: true,
      })
    }

    // Add connection to Active panel (assigned but NOT yet enabled — user must toggle Enable)
    const updatedConnection = {
      ...connection,
      is_active_inserted: "1",     // Mark as assigned to Active panel
      is_dashboard_inserted: "1",  // Mark as inserted on dashboard
      is_assigned: "1",            // Assigned to Main Connections
      is_enabled_dashboard: "0",   // Disabled by default — user enables via toggle
      is_active: "0",              // Not processing yet
      updated_at: new Date().toISOString(),
    }

    await updateConnection(connectionId, updatedConnection)

    const logMsg = `[v0] [ActiveConnection] ✓ ADDED (disabled): ${connection.name} (${connectionId}) | Exchange: ${connection.exchange} | Base: ${["bybit", "bingx", "pionex", "orangex", "binance", "okx"].includes((connection.exchange || "").toLowerCase())}`
    console.log(logMsg)
    await SystemLogger.logConnection("Dashboard: Added active connection (disabled)", connectionId, "info")

    // Notify engine of dashboard activation and recoordinate
    try {
      await notifySettingsChanged(connectionId, ["is_enabled_dashboard", "is_assigned"])
      const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
      const coordinator = getGlobalTradeEngineCoordinator()
      await coordinator.applyPendingChangesNow(connectionId)
      
      // Start engine if it should be running
      const { isConnectionMainProcessing, hasConnectionCredentials, isTruthyFlag } = await import(
        "@/lib/connection-state-utils"
      )
      const shouldRun =
        isConnectionMainProcessing(updatedConnection) &&
        (hasConnectionCredentials(updatedConnection, 5, true) ||
          isTruthyFlag((updatedConnection as any).is_predefined) ||
          isTruthyFlag((updatedConnection as any).is_testnet) ||
          isTruthyFlag((updatedConnection as any).demo_mode))
      if (shouldRun) {
        const startKey = `engine_restart_cooldown:${connectionId}`
        const client = getRedisClient()
        const lastStartRaw = await client.get(startKey).catch(() => null)
        const lastStartMs = Number(lastStartRaw)
        if (!Number.isFinite(lastStartMs) || Date.now() - lastStartMs > 2_000) {
          await client.set(startKey, String(Date.now()), { EX: 5 }).catch(() => null)
          setImmediate(() => {
            coordinator.startMissingEngines([updatedConnection]).catch((startErr: unknown) => {
              console.warn(
                `[v0] [ActiveConnection POST] background start failed for ${connectionId}:`,
                startErr instanceof Error ? startErr.message : String(startErr),
              )
            })
          })
        }
      }
    } catch (applyErr) {
      console.warn(
        `[v0] [ActiveConnection POST] coordinator recoordination failed for ${connectionId}:`,
        applyErr instanceof Error ? applyErr.message : String(applyErr),
      )
    }

    return NextResponse.json({
      success: true,
      connection: updatedConnection,
      message: "Connection added to active dashboard (disabled until enabled by operator)",
    })
  } catch (error) {
    console.error(`[v0] [ActiveConnection] ✗ FAILED to enable: ${error instanceof Error ? error.message : String(error)}`)
    await SystemLogger.logError(error, "api", "POST /api/settings/connections/[id]/active")
    return NextResponse.json(
      { error: "Failed to enable connection", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

// DELETE - Remove connection from active connections
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id

    await initRedis()
    const connection = await getConnection(connectionId)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Update connection to remove from active panel - unassign from Main Connections
    // NOTE: is_inserted is preserved so the connection remains in Settings
    const updatedConnection = {
      ...connection,
      is_active_inserted: "0",      // Remove assignment from main panel
      is_dashboard_inserted: "0",   // Remove dashboard insertion
      is_enabled_dashboard: "0",    // Disable dashboard toggle
      is_active: "0",               // Not active for processing
      is_assigned: "0",             // Unassign from main connections
      updated_at: new Date().toISOString(),
    }

    await updateConnection(connectionId, updatedConnection)

    const logMsg = `[v0] [ActiveConnection] ✗ REMOVED: ${connection.name} (${connectionId}) | Exchange: ${connection.exchange}`
    console.log(logMsg)
    await SystemLogger.logConnection("Dashboard: Removed active connection", connectionId, "info")

    // Notify engine of removal from dashboard
    try {
      await notifySettingsChanged(connectionId, ["is_enabled_dashboard", "is_assigned"])
      const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
      const coordinator = getGlobalTradeEngineCoordinator()
      await coordinator.applyPendingChangesNow(connectionId)
    } catch (applyErr) {
      console.warn(
        `[v0] [ActiveConnection DELETE] coordinator recoordination failed for ${connectionId}:`,
        applyErr instanceof Error ? applyErr.message : String(applyErr),
      )
    }

    return NextResponse.json({
      success: true,
      connection: updatedConnection,
      message: "Connection removed from active panel",
    })
  } catch (error) {
    console.error(`[v0] [ActiveConnection] ✗ FAILED to disable: ${error instanceof Error ? error.message : String(error)}`)
    await SystemLogger.logError(error, "api", "DELETE /api/settings/connections/[id]/active")
    return NextResponse.json(
      { error: "Failed to disable connection", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
