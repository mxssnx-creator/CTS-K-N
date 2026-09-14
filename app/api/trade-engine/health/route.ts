import { NextResponse } from "next/server"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { getActiveConnectionsForEngine } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

// Health is reported for the canonical enabled connection set (Redis,
// `connections:main:enabled`), the same set the running engine coordinator
// operates on. The previous implementation read the legacy file catalog,
// which no longer matches the live Redis catalog: it listed stale placeholder
// ids and reported "idle / 0 running" while the real engine was running.
export async function GET() {
  try {
    console.log("[v0] Fetching trade engine health status")

    const coordinator = getGlobalTradeEngineCoordinator()

    if (!coordinator) {
      console.warn("[v0] Coordinator is null - engines may not be initialized yet")
      return NextResponse.json(
        {
          success: false,
          error: "Trade engine coordinator not initialized",
          overall: "offline",
          runningEngines: 0,
          totalEngines: 0,
          engines: [],
          timestamp: new Date().toISOString(),
        },
        { status: 503 },
      )
    }

    const enabledConnections = await getActiveConnectionsForEngine()
    if (!Array.isArray(enabledConnections)) {
      console.error("[v0] Connections is not an array:", typeof enabledConnections)
      return NextResponse.json(
        { success: false, error: "Invalid connections data", overall: "error", engines: [] },
        { status: 500 },
      )
    }

    const engineHealthStatus = await Promise.all(
      enabledConnections.map(async (conn) => {
        try {
          const engineStatus = await coordinator.getEngineStatus(conn.id)

          // Health components report "healthy" when their cycles are progressing.
          const components = engineStatus?.health?.components
          const isRunning =
            components?.realtime?.status === "healthy" ||
            components?.indications?.status === "healthy" ||
            components?.strategies?.status === "healthy"

          // Engine state already comes from Redis (`trade_engine_state:<id>`);
          // the removed SQL lookup targeted a table the compat layer never mapped.
          const lastUpdate =
            engineStatus?.updated_at ??
            engineStatus?.updatedAt ??
            engineStatus?.health?.lastCheck ??
            null

          return {
            connectionId: conn.id,
            connectionName: conn.name ?? conn.id,
            exchange: conn.exchange ?? null,
            status: isRunning ? "running" : "idle",
            isRunning,
            lastUpdate: lastUpdate instanceof Date ? lastUpdate.toISOString() : lastUpdate,
            errorMessage: engineStatus?.errorMessage || null,
          }
        } catch (err) {
          console.error(`[v0] Failed to get health for ${conn.id}:`, err)
          return {
            connectionId: conn.id,
            connectionName: conn.name ?? conn.id,
            exchange: conn.exchange ?? null,
            status: "error",
            isRunning: false,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }),
    )

    const runningCount = engineHealthStatus.filter((s) => s.isRunning).length
    const totalCount = engineHealthStatus.length

    return NextResponse.json({
      success: true,
      overall: runningCount > 0 ? "healthy" : "idle",
      runningEngines: runningCount,
      totalEngines: totalCount,
      engines: engineHealthStatus,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] Failed to get health status:", error)
    return NextResponse.json(
      { success: false, error: "Failed to get health status", details: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
