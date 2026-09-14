import { NextResponse } from "next/server"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { getActiveConnectionsForEngine } from "@/lib/redis-db"
import { loadSettingsAsync } from "@/lib/settings-storage"
import { SystemLogger } from "@/lib/system-logger"
import { getRuntimeMaintenanceState, runtimeMaintenanceJson } from "@/lib/runtime-maintenance"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    const maintenance = getRuntimeMaintenanceState()
    if (maintenance.active) {
      return NextResponse.json(runtimeMaintenanceJson(maintenance), { status: 503 })
    }

    console.log("[v0] [DEBUG] Trade Engine Manual Startup Endpoint")

    const coordinator = getGlobalTradeEngineCoordinator()
    if (!coordinator) {
      return NextResponse.json(
        { success: false, error: "Trade engine coordinator not initialized" },
        { status: 503 },
      )
    }

    // Canonical enabled set (Redis `connections:main:enabled`) — the same set
    // the normal startup path uses. The legacy file catalog this endpoint used
    // to read could contain stale placeholder ids, which would have started
    // engines the canonical configuration never enabled.
    const enabledConnections = await getActiveConnectionsForEngine()
    if (!Array.isArray(enabledConnections)) {
      console.error("[v0] [DEBUG] Connections is not an array:", typeof enabledConnections)
      return NextResponse.json({
        success: false,
        error: "Invalid connections data",
        log: [`ERROR: Connections data is not an array (type: ${typeof enabledConnections})`],
      }, { status: 500 })
    }

    const settings = await loadSettingsAsync()
    const indicationInterval = settings.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 1
    const strategyInterval = settings.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 1
    const realtimeInterval = settings.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.3

    const results = []

    for (const connection of enabledConnections) {
      try {
        const engineConfig = {
          connectionId: connection.id,
          indicationInterval,
          strategyInterval,
          realtimeInterval,
        }

        await coordinator.startEngine(connection.id, engineConfig)

        results.push({
          connectionId: connection.id,
          connectionName: connection.name ?? connection.id,
          success: true,
          message: "Engine started successfully",
        })
      } catch (error) {
        results.push({
          connectionId: connection.id,
          connectionName: connection.name ?? connection.id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return NextResponse.json({
      success: true,
      message: "Manual trade engine startup completed",
      enabledConnections: enabledConnections.length,
      results,
    })
  } catch (error) {
    console.error("[v0] [DEBUG] Startup failed:", error)
    await SystemLogger.logError(error, "trade-engine", "Manual startup failed")

    return NextResponse.json(
      {
        success: false,
        error: "Manual startup failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
