import { NextResponse } from "next/server"
import { USER_CONNECTIONS } from "@/lib/user-connections-config"
import { successResponse, errorResponse } from "@/lib/api-response"
import { createConnection, getConnection, initRedis } from "@/lib/redis-db"

/**
 * Import user-configured connections into Redis
 * POST /api/settings/connections/import-user
 */
export const dynamic = "force-dynamic"
export async function POST() {
  try {
    await initRedis()
    let imported = 0
    let skipped = 0
    const errors: string[] = []

    for (const userConn of USER_CONNECTIONS) {
      try {
        const existing = await getConnection(userConn.id)

        if (existing) {
          console.log(`[v0] Skipping ${userConn.displayName} - already exists`)
          skipped++
          continue
        }

        await createConnection({
          id: userConn.id,
          name: userConn.name,
          exchange: userConn.exchange,
          api_type: userConn.apiType,
          connection_method: "rest",
          connection_library: "native",
          api_key: userConn.apiKey,
          api_secret: userConn.apiSecret,
          margin_type: userConn.marginType || "cross",
          position_mode: userConn.positionMode || "hedge",
          is_testnet: userConn.isTestnet ? "1" : "0",
          is_enabled: "1",
          is_live_trade: "0",
          is_preset_trade: "0",
          is_inserted: "1",
          is_active_inserted: "0",
          is_enabled_dashboard: "0",
          is_active: "0",
          is_predefined: "0",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })

        console.log(`[v0] ✓ Imported ${userConn.displayName}`)
        imported++
      } catch (error) {
        const errorMsg = `Failed to import ${userConn.displayName}: ${error instanceof Error ? error.message : String(error)}`
        console.error(`[v0] ${errorMsg}`)
        errors.push(errorMsg)
      }
    }

    return successResponse({
      imported,
      skipped,
      total: USER_CONNECTIONS.length,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (error) {
    console.error("[v0] Error importing user connections:", error)
    return errorResponse("Failed to import user connections", {
      status: 500,
      details: error instanceof Error ? error.message : "Unknown error",
    })
  }
}

/**
 * Get list of available user connections
 * GET /api/settings/connections/import-user
 */
export async function GET() {
  try {
    await initRedis()
    // Get list of user connections with their import status
    const connections = await Promise.all(
      USER_CONNECTIONS.map(async (userConn) => {
        const existing = await getConnection(userConn.id)

        return {
          id: userConn.id,
          name: userConn.name,
          exchange: userConn.exchange,
          displayName: userConn.displayName,
          apiType: userConn.apiType,
          connectionType: userConn.connectionType,
          maxLeverage: userConn.maxLeverage,
          documentation: userConn.documentation,
          installCommands: userConn.installCommands,
          imported: !!existing,
          enabled: existing?.is_enabled === "1" || existing?.is_enabled === true,
          dbId: existing?.id || null,
        }
      })
    )

    return successResponse(connections)
  } catch (error) {
    console.error("[v0] Error getting user connections:", error)
    return errorResponse("Failed to get user connections", {
      status: 500,
      details: error instanceof Error ? error.message : "Unknown error",
    })
  }
}
