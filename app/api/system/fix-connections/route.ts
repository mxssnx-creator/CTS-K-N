import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { BASE_CONNECTION_CREDENTIALS } from "@/lib/base-connection-credentials"

export const dynamic = "force-dynamic"

/**
 * POST /api/system/fix-connections
 * 
 * Fixes all 3 base connections (bingx, pionex, orangex) to be:
 * - is_active_inserted = 1 (in Active panel)
 * - is_enabled = 1 (enabled)
 * - is_enabled_dashboard = 0 (dashboard toggle off by default)
 * - connection_method = library (use native SDK)
 * 
 * Also injects credentials from predefined variables.
 */
export async function POST() {
  try {
    await initRedis()
    const client = getRedisClient()
    
    const baseConnections = ["bingx-x01", "pionex-x01", "orangex-x01"] as const
    
    const results: Record<string, any> = {}
    
    for (const conn of baseConnections) {
      // Check if connection exists
      const exists = await client.sismember("connections", conn)
      
      // Build update data
      const updateData: Record<string, string> = {
        is_inserted: "1",
        is_enabled: "1",
        is_active_inserted: "1",
        is_enabled_dashboard: "0",
        is_active: "0",
        is_predefined: "1",
        connection_method: "library",
        updated_at: new Date().toISOString(),
      }
      
      // Check for credentials in environment
      const credentials = BASE_CONNECTION_CREDENTIALS[conn]
      const hasCredentials = credentials.apiKey.length > 0 && credentials.apiSecret.length > 0
      
      if (hasCredentials) {
        updateData.api_key = credentials.apiKey
        updateData.api_secret = credentials.apiSecret
      }
      
      // Apply update and ensure set membership
      await client.hset(`connection:${conn}`, updateData)
      await client.sadd("connections", conn)
      results[conn] = {
        status: exists ? "updated" : "created",
        active_inserted: true,
        enabled: true,
        dashboard_enabled: false,
        has_credentials: hasCredentials,
      }
    }
    
    // Count successful updates
    const updatedCount = Object.values(results).filter((r: any) => r.status === "updated").length
    const withCredentials = Object.values(results).filter((r: any) => r.has_credentials).length
    
    return NextResponse.json({
      success: true,
      message: `Fixed ${updatedCount}/4 base connections, ${withCredentials} with credentials`,
      connections: results,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] [FixConnections] Error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    
    const baseIds = ["bingx-x01", "pionex-x01", "orangex-x01"]
    const status: Record<string, any> = {}
    
    for (const id of baseIds) {
      const conn = await client.hgetall(`connection:${id}`)
      if (conn && Object.keys(conn).length > 0) {
        status[id] = {
          exists: true,
          name: conn.name || id,
          exchange: conn.exchange,
          is_active_inserted: conn.is_active_inserted,
          is_enabled: conn.is_enabled,
          is_enabled_dashboard: conn.is_enabled_dashboard,
          has_credentials: !!(conn.api_key && conn.api_key.length > 10 && conn.api_secret && conn.api_secret.length > 10),
          connection_method: conn.connection_method || "rest",
        }
      } else {
        status[id] = { exists: false }
      }
    }
    
    return NextResponse.json({
      success: true,
      baseConnections: status,
      summary: {
        total: baseIds.length,
        existing: Object.values(status).filter((s: any) => s.exists).length,
        activeInserted: Object.values(status).filter((s: any) => s.is_active_inserted === "1").length,
        withCredentials: Object.values(status).filter((s: any) => s.has_credentials).length,
      },
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
