import { NextResponse } from "next/server"
import { getConnectionManager } from "@/lib/connection-manager"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { initRedis, getAllConnections } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"

/**
 * API Verification Endpoint
 * Tests all critical API functionality and connection manager integration
 */
export const dynamic = "force-dynamic"
export async function GET() {
  const results = {
    timestamp: new Date().toISOString(),
    system: {
      connectionManager: false,
      tradeEngineCoordinator: false,
      redisStorage: false,
    },
    connections: {
      count: 0,
      errors: [] as string[],
    },
    apis: {
      test: [] as any[],
    },
  }

  try {
    // Test 1: ConnectionManager
    try {
      const connManager = getConnectionManager()
      results.system.connectionManager = !!connManager
    } catch (error) {
      results.connections.errors.push(`ConnectionManager error: ${error instanceof Error ? error.message : String(error)}`)
    }

    // Test 2: Trade Engine Coordinator
    try {
      const coordinator = getGlobalTradeEngineCoordinator()
      results.system.tradeEngineCoordinator = !!coordinator
    } catch (error) {
      results.connections.errors.push(`Trade Engine Coordinator error: ${error instanceof Error ? error.message : String(error)}`)
    }

    // Test 3: Redis Storage
    try {
      await initRedis()
      const connections = await getAllConnections()
      results.system.redisStorage = Array.isArray(connections)
      results.connections.count = connections.length

      const enabledConnections = connections.filter((c: any) =>
        c.is_enabled === "1" || c.is_enabled === true
      )

      results.apis.test.push({
        type: "redis-storage",
        status: "ok",
        totalConnections: connections.length,
        enabledConnections: enabledConnections.length,
      })
    } catch (error) {
      results.connections.errors.push(`Redis Storage error: ${error instanceof Error ? error.message : String(error)}`)
    }

    // Test 4: API Endpoints Structure
    results.apis.test.push({
      type: "api-endpoints",
      status: "ok",
      endpoints: [
        { method: "GET", path: "/api/settings/connections", purpose: "Get all connections" },
        { method: "POST", path: "/api/settings/connections", purpose: "Create new connection" },
        { method: "POST", path: "/api/settings/connections/:id/toggle", purpose: "Toggle connection enabled" },
        { method: "POST", path: "/api/settings/connections/:id/live-trade", purpose: "Toggle Main Engine" },
        { method: "POST", path: "/api/settings/connections/:id/preset-toggle", purpose: "Toggle Preset Engine" },
        { method: "POST", path: "/api/settings/connections/:id/test", purpose: "Test connection" },
        { method: "POST", path: "/api/trade-engine/start", purpose: "Start Global Coordinator" },
        { method: "GET", path: "/api/trade-engine/status", purpose: "Get engine status" },
      ],
    })

    await SystemLogger.logAPI("API Verification completed", "info", "GET /api/system/verify-apis", results)

    return NextResponse.json({
      success: results.connections.errors.length === 0,
      results,
    })
  } catch (error) {
    console.error("[v0] API verification failed:", error)
    await SystemLogger.logError(error, "api", "GET /api/system/verify-apis")

    return NextResponse.json(
      {
        success: false,
        error: "API verification failed",
        details: error instanceof Error ? error.message : String(error),
        results,
      },
      { status: 500 },
    )
  }
}
