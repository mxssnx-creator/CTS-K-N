import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { BASE_CONNECTION_CREDENTIALS } from "@/lib/base-connection-credentials"

export const dynamic = "force-dynamic"

/**
 * POST /api/system/inject-credentials
 * 
 * Injects predefined real API credentials into canonical base connections.
 */
export async function POST() {
  try {
    await initRedis()
    const client = getRedisClient()
    
    const results: Record<string, string> = {}

    const injectForConnection = async (connectionId: keyof typeof BASE_CONNECTION_CREDENTIALS) => {
      const { apiKey, apiSecret } = BASE_CONNECTION_CREDENTIALS[connectionId]
      const existing = await client.hgetall(`connection:${connectionId}`)
      const dashboardEnabled = existing?.is_enabled_dashboard === "1" || existing?.is_enabled_dashboard === "true"
      await client.hset(`connection:${connectionId}`, {
        api_key: apiKey,
        api_secret: apiSecret,
        // Preserve the operator-selected exchange environment. Forcing BingX
        // to testnet here made production credential injection silently route
        // later live orders away from the intended mainnet account.
        is_testnet: (existing?.is_testnet as string) || "0",
        is_active_inserted: (existing?.is_active_inserted as string) || "0",
        is_enabled: (existing?.is_enabled as string) || "1",
        is_enabled_dashboard: (existing?.is_enabled_dashboard as string) || "0",
        is_active: dashboardEnabled ? "1" : "0",
        connection_method: "library",
        updated_at: new Date().toISOString(),
      })
      await client.sadd("connections", connectionId)
      results[connectionId] = "Credentials injected successfully"
    }

    await injectForConnection("bingx-x01")
    await injectForConnection("pionex-x01")
    await injectForConnection("orangex-x01")
    
    // Count successful injections
    const successCount = Object.values(results).filter(r => r.includes("injected")).length
    
    return NextResponse.json({
      success: true,
      message: `Predefined credentials injection complete: ${successCount}/4 exchanges configured`,
      results,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] [Credentials] Error injecting credentials:", error)
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
    
    const predefinedStatus = {
      "bingx-x01": BASE_CONNECTION_CREDENTIALS["bingx-x01"].apiKey.length > 0 && BASE_CONNECTION_CREDENTIALS["bingx-x01"].apiSecret.length > 0,
      "pionex-x01": BASE_CONNECTION_CREDENTIALS["pionex-x01"].apiKey.length > 0 && BASE_CONNECTION_CREDENTIALS["pionex-x01"].apiSecret.length > 0,
      "orangex-x01": BASE_CONNECTION_CREDENTIALS["orangex-x01"].apiKey.length > 0 && BASE_CONNECTION_CREDENTIALS["orangex-x01"].apiSecret.length > 0,
    }
    
    // Check which connections have credentials in database
    const dbStatus: Record<string, boolean> = {}
    for (const connId of ["bingx-x01", "pionex-x01", "orangex-x01"]) {
      const conn = await client.hgetall(`connection:${connId}`)
      const hasKey = !!(conn?.api_key && conn.api_key.length > 10)
      const hasSecret = !!(conn?.api_secret && conn.api_secret.length > 10)
      dbStatus[connId] = hasKey && hasSecret
    }
    
    return NextResponse.json({
      success: true,
      predefined: predefinedStatus,
      database: dbStatus,
      availablePredefined: Object.entries(predefinedStatus).filter(([_, v]) => v).map(([k]) => k),
      configuredInDb: Object.entries(dbStatus).filter(([_, v]) => v).map(([k]) => k),
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
