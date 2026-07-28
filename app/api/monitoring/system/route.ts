import { NextResponse, type NextRequest } from "next/server"
import {
  getAllConnections,
  getRedisClient,
  initRedis,
} from "@/lib/redis-db"
import { getDashboardWorkflowSnapshot } from "@/lib/dashboard-workflow"
import { getSystemResourceMetrics } from "@/lib/system-resource-metrics"
import { getOpenLivePositionReadModels } from "@/lib/live-position-read-model"
import { PseudoPositionManager } from "@/lib/trade-engine/pseudo-position-manager"
import { mapWithConcurrency } from "@/lib/bounded-concurrency"
import { SystemLogger } from "@/lib/system-logger"
import {
  isConnectionDashboardEnabled,
  isConnectionLiveTradeEnabled,
} from "@/lib/connection-state-utils"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const requestedConnectionId = request.nextUrl.searchParams.get("connectionId")?.trim()
    await initRedis()
    const client = getRedisClient()
    const allConnections = await getAllConnections()
    const selectedConnections = requestedConnectionId
      ? allConnections.filter((connection: any) => String(connection.id) === requestedConnectionId)
      : allConnections
    if (requestedConnectionId && selectedConnections.length === 0) {
      return NextResponse.json({ success: false, error: "Connection not found" }, { status: 404 })
    }

    const redisStartedAt = Date.now()
    const [redisReply, redisInfo, databaseKeys, snapshot, positionCounts, recentLogs] =
      await Promise.all([
        client.ping(),
        client.info().catch(() => ""),
        client.dbSize().catch(() => 0),
        getDashboardWorkflowSnapshot(
          requestedConnectionId ? { preferredConnectionId: requestedConnectionId } : undefined,
        ),
        mapWithConcurrency(selectedConnections, 8, async (connection: any) => {
          const connectionId = String(connection.id)
          const [pseudo, live] = await Promise.all([
            new PseudoPositionManager(connectionId).getActivePositions().catch(() => []),
            getOpenLivePositionReadModels(connectionId, 0),
          ])
          return { pseudo: pseudo.length, live: live.length }
        }),
        SystemLogger.getLogs(undefined, 100),
      ])
    const redisLatencyMs = Date.now() - redisStartedAt
    const resources = getSystemResourceMetrics()
    const usedMemory = Number(redisInfo.match(/(?:^|\r?\n)used_memory:(\d+)/)?.[1] || 0)
    const activeConnections = selectedConnections.filter((connection: any) =>
      isConnectionDashboardEnabled(connection),
    ).length
    const liveTradeConnections = selectedConnections.filter((connection: any) =>
      isConnectionLiveTradeEnabled(connection),
    ).length
    const pseudoPositions = positionCounts.reduce((sum, row) => sum + row.pseudo, 0)
    const realPositions = positionCounts.reduce((sum, row) => sum + row.live, 0)
    const recentErrors = recentLogs.filter((entry) => entry.level === "error")
    const progressionLastUpdate = snapshot.connectionMetrics.progression?.lastUpdate
    const globalStatus = snapshot.globalStatus

    return NextResponse.json({
      success: true,
      measuredAt: new Date().toISOString(),
      states: {
        connections: {
          total: selectedConnections.length,
          active: activeConnections,
          liveTrade: liveTradeConnections,
          status: activeConnections > 0 ? "connected" : "disconnected",
        },
        trading: {
          pseudoPositions,
          realPositions,
          status: realPositions > 0 || pseudoPositions > 0 ? "active" : "idle",
        },
        strategy: {
          status:
            globalStatus === "running"
              ? "running"
              : globalStatus === "paused"
                ? "paused"
                : "stopped",
          lastUpdate: progressionLastUpdate || snapshot.timestamp,
          cycles: snapshot.connectionMetrics.engineCycles.strategy,
          averageDurationMs: snapshot.connectionMetrics.engineDurations.strategyAvgMs,
        },
        database: {
          status: redisReply === "PONG" ? "connected" : "error",
          sizeBytes: usedMemory,
          keys: databaseKeys,
          latencyMs: redisLatencyMs,
        },
        resources: {
          cpuPercent: resources.cpuPercent,
          memoryPercent: resources.memoryPercent,
          rssBytes: resources.rssBytes,
          heapUsedBytes: resources.heapUsedBytes,
        },
        errors: {
          count: recentErrors.length,
          status: recentErrors.length > 5 ? "warning" : "healthy",
        },
      },
    })
  } catch (error) {
    console.error("Error fetching system states:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to read measured system state",
      },
      { status: 500 },
    )
  }
}
