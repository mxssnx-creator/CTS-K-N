import { type NextRequest, NextResponse } from "next/server"
import { getDashboardWorkflowSnapshot } from "@/lib/dashboard-workflow"
import { getRedisClient, initRedis } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

type ModuleStatus = "active" | "inactive" | "error"

function clampPercent(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 0
}

function processingHealth(input: {
  active: boolean
  cycles: number
  successRate: number
  lastUpdateAt: number
}): number {
  if (!input.active) return 0
  if (input.cycles <= 0) return 25
  const freshnessMs = input.lastUpdateAt > 0 ? Date.now() - input.lastUpdateAt : Number.POSITIVE_INFINITY
  const freshnessFactor = freshnessMs <= 30_000 ? 1 : freshnessMs <= 120_000 ? 0.75 : 0.35
  return clampPercent(input.successRate * freshnessFactor)
}

export async function GET(request: NextRequest) {
  try {
    const requestedConnectionId = request.nextUrl.searchParams.get("connectionId")?.trim()
    const preferredConnectionId =
      requestedConnectionId &&
      requestedConnectionId !== "demo-mode" &&
      !requestedConnectionId.startsWith("demo")
        ? requestedConnectionId
        : undefined

    const snapshot = await getDashboardWorkflowSnapshot({ preferredConnectionId })
    const progression = snapshot.connectionMetrics.progression
    const cycles = snapshot.connectionMetrics.engineCycles
    const eligible = preferredConnectionId
      ? Boolean(
          snapshot.focusConnection?.id === preferredConnectionId &&
          snapshot.focusConnection.isDashboardEnabled &&
          snapshot.focusConnection.isActivePanel,
        )
      : snapshot.overview.eligibleEngineConnections > 0
    const engineRunning = snapshot.globalStatus === "running"
    const processorsActive = engineRunning && eligible
    const lastUpdateAt = progression?.lastUpdate
      ? new Date(progression.lastUpdate).getTime()
      : 0
    const lastUpdate =
      lastUpdateAt > 0 && Number.isFinite(lastUpdateAt)
        ? new Date(lastUpdateAt).toISOString()
        : snapshot.timestamp
    const cycleSuccessRate = clampPercent(progression?.cycleSuccessRate)

    let persistenceStatus: ModuleStatus = "active"
    let persistenceHealth = 100
    let persistenceDetail = "Redis ping succeeded"
    let persistenceUpdatedAt = new Date().toISOString()
    try {
      await initRedis()
      const pingStartedAt = Date.now()
      await getRedisClient().ping()
      const pingMs = Date.now() - pingStartedAt
      persistenceHealth = pingMs <= 25 ? 100 : pingMs <= 100 ? 90 : pingMs <= 250 ? 75 : 50
      persistenceDetail = `Redis ping ${pingMs} ms`
      persistenceUpdatedAt = new Date().toISOString()
    } catch (error) {
      persistenceStatus = "error"
      persistenceHealth = 0
      persistenceDetail = error instanceof Error ? error.message : "Redis ping failed"
    }

    const modules = [
      {
        name: "Global Coordinator",
        status: (engineRunning ? "active" : "inactive") as ModuleStatus,
        health: engineRunning ? 100 : snapshot.globalStatus === "paused" ? 50 : 0,
        last_update: snapshot.timestamp,
        detail: `State: ${snapshot.globalStatus}`,
      },
      {
        name: "Indication Processor",
        status: (processorsActive ? "active" : "inactive") as ModuleStatus,
        health: processingHealth({
          active: processorsActive,
          cycles: cycles.indication,
          successRate: cycleSuccessRate,
          lastUpdateAt,
        }),
        last_update: lastUpdate,
        detail: `${cycles.indication} measured cycles`,
      },
      {
        name: "Strategy Processor",
        status: (processorsActive ? "active" : "inactive") as ModuleStatus,
        health: processingHealth({
          active: processorsActive,
          cycles: cycles.strategy,
          successRate: cycleSuccessRate,
          lastUpdateAt,
        }),
        last_update: lastUpdate,
        detail: `${cycles.strategy} measured cycles`,
      },
      {
        name: "Realtime / Live Processor",
        status: (processorsActive ? "active" : "inactive") as ModuleStatus,
        health: processingHealth({
          active: processorsActive,
          cycles: cycles.realtime,
          successRate: cycleSuccessRate,
          lastUpdateAt,
        }),
        last_update: lastUpdate,
        detail:
          `${cycles.realtime} cycles · ${snapshot.connectionMetrics.liveOrders.filled} filled · ` +
          `${snapshot.connectionMetrics.liveOrders.failed} failed`,
      },
      {
        name: "Redis Persistence",
        status: persistenceStatus,
        health: persistenceHealth,
        last_update: persistenceUpdatedAt,
        detail: persistenceDetail,
      },
    ]

    return NextResponse.json({
      success: true,
      scope: preferredConnectionId ? "connection" : "global",
      connectionId: preferredConnectionId || null,
      measuredAt: snapshot.timestamp,
      data: modules,
    })
  } catch (error) {
    console.error("[v0] Error fetching module status:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch module status",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
