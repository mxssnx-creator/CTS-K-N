import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { initRedis, getConnection, updateConnection } from "@/lib/redis-db"
import { isTruthyFlag } from "@/lib/boolean-utils"

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

    // Check if already inserted in active list
    if (isTruthyFlag(baseConnection.is_active_inserted)) {
      return NextResponse.json({
        success: false,
        error: "Connection already in Active panel",
      })
    }

    // Add to active list: inserted into Active panel, but NOT enabled by default
    const activeConnection = {
      ...baseConnection,
      is_active_inserted: "1",    // Visible in Active panel (inserted)
      is_enabled_dashboard: "0",  // Toggle is OFF (NOT enabled by default)
      is_enabled: baseConnection.is_enabled || "1", // Preserve Settings base state
      is_active: "0",             // Not active until user enables
      is_inserted: "1",           // Inserted (for connection tracking)
      is_live_trade: "0",
      is_preset_trade: "0",
      updated_at: new Date().toISOString(),
    }

    await updateConnection(connectionId, activeConnection)

    await SystemLogger.logConnection(
      `Inserted into Active panel. Toggle to enable.`,
      connectionId,
      "info",
      { is_active_inserted: true, is_enabled_dashboard: false, is_enabled: activeConnection.is_enabled },
    )

    return NextResponse.json({
      success: true,
      message: "Connection inserted into Active panel. Toggle Enable to start processing.",
      connection: activeConnection,
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
