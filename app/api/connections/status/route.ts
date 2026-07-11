import { NextResponse } from "next/server"
import { getAllConnections, getRedisClient, getSettings, initRedis } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"
import { getTradeEngineStatus } from "@/lib/trade-engine"
import { getFreshestProcessorHeartbeat } from "@/lib/engine-heartbeat"
import { buildProgressionScope } from "@/lib/progression-scope"

// GET real-time status for all active connections
export const dynamic = "force-dynamic"
export const maxDuration = 30
export async function GET() {
  try {
    console.log("[v0] Fetching real connection statuses from Redis")

    await initRedis()
    const connections = await getAllConnections()
    const client = getRedisClient()
    const globalState = (await client.hgetall("trade_engine:global").catch(() => ({} as Record<string, string>))) || {}
    const globalIntent = globalState.operator_intent || globalState.desired_status || globalState.status || ""
    const globalRunning = globalIntent === "running" || (!globalIntent && globalState.operator_stopped !== "1" && globalState.operator_stopped !== "true")
    const globalPaused = globalIntent === "paused"
    
    // Ensure connections is an array
    if (!Array.isArray(connections)) {
      console.error("[v0] Connections is not an array:", typeof connections)
      return NextResponse.json({ error: "Invalid connections data", statuses: [] }, { status: 500 })
    }

    const activeConnections = connections.filter((c: any) => c.is_enabled !== false)

    // Get real statuses from trade engines
    const statuses = await Promise.all(
      activeConnections.map(async (connection: any) => {
        try {
          const engineStatus = await getTradeEngineStatus(connection.id)

          const assigned = connection.is_active_inserted === true || connection.is_active_inserted === "1" || connection.is_assigned === true || connection.is_assigned === "1" || connection.is_dashboard_inserted === true || connection.is_dashboard_inserted === "1"
          const processingEnabled = connection.is_enabled_dashboard === true || connection.is_enabled_dashboard === "1"

          const processorHeartbeat = await getFreshestProcessorHeartbeat(connection.id).catch(() => 0)
          const heartbeatFresh = processorHeartbeat > 0 && Date.now() - processorHeartbeat < 90_000
          const runtimeActive = !!engineStatus || heartbeatFresh || (globalRunning && assigned && processingEnabled)
          const scope = buildProgressionScope(connection.id, "main")
          const [scopedProgression, legacyProgression] = await Promise.all([
            getSettings(scope.engineProgressionKey).catch(() => ({} as Record<string, string>)),
            getSettings(`engine_progression:${connection.id}`).catch(() => ({} as Record<string, string>)),
          ])
          const progression = Object.keys(scopedProgression || {}).length > 0 ? scopedProgression : legacyProgression
          const progressionProgress = Number((progression as any)?.progress || 0) || 0

          return {
            id: connection.id,
            name: connection.name,
            exchange: connection.exchange,
            assigned,
            processingEnabled,
            status: !processingEnabled ? "disabled" : globalPaused ? "paused" : runtimeActive ? "connected" : "connecting",
            progress: engineStatus?.loadingProgress || progressionProgress,
            balance: engineStatus?.balance || 0,
            activePositions: engineStatus?.activePositions || 0,
            activeSymbols: engineStatus?.activeSymbols || 0,
            indicationsActive: engineStatus?.indicationsActive || 0,
            lastUpdate: engineStatus?.lastUpdate || (processorHeartbeat ? new Date(processorHeartbeat).toISOString() : new Date().toISOString()),
            heartbeatFresh,
            lastProcessorHeartbeat: processorHeartbeat || null,
            isLoading: engineStatus?.isLoading || (processingEnabled && !runtimeActive),
            loadingStage: engineStatus?.loadingStage || "idle",
            error: engineStatus?.error || null,
          }
        } catch (error) {
          console.error(`[v0] Failed to get status for ${connection.id}:`, error)
          return {
            id: connection.id,
            name: connection.name,
            exchange: connection.exchange,
            assigned: connection.is_active_inserted === true || connection.is_active_inserted === "1" || connection.is_assigned === true || connection.is_assigned === "1" || connection.is_dashboard_inserted === true || connection.is_dashboard_inserted === "1",
            processingEnabled: connection.is_enabled_dashboard === true || connection.is_enabled_dashboard === "1",
            status: "error",
            progress: 0,
            error: error instanceof Error ? error.message : "Unknown error",
          }
        }
      }),
    )

    return NextResponse.json(statuses)
  } catch (error) {
    console.error("[v0] Failed to fetch connection statuses:", error)
    await SystemLogger.logError(error, "api", "GET /api/connections/status")
    return NextResponse.json({ error: "Failed to fetch connection statuses", statuses: [] }, { status: 500 })
  }
}
