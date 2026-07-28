import { NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import {
  getAllConnections,
  getObservedRedisRequestsPerSecond,
  getRedisClient,
  initRedis,
} from "@/lib/redis-db"
import { getSystemResourceMetrics } from "@/lib/system-resource-metrics"
import { getDashboardWorkflowSnapshot } from "@/lib/dashboard-workflow"
import {
  getClosedLivePositionReadModels,
  getOpenLivePositionReadModels,
} from "@/lib/live-position-read-model"
import { PseudoPositionManager } from "@/lib/trade-engine/pseudo-position-manager"
import { mapWithConcurrency } from "@/lib/bounded-concurrency"
import {
  isConnectionDashboardEnabled,
  isConnectionLiveTradeEnabled,
} from "@/lib/connection-state-utils"

/**
 * Comprehensive monitoring endpoint backed by the same current ledgers used
 * by Structure, Logistics and the connection cards.
 */
export const dynamic = "force-dynamic"

export async function GET() {
  const startTime = Date.now()
  try {
    await initRedis()
    const client = getRedisClient()
    const resourceMetrics = getSystemResourceMetrics()
    const [
      connections,
      workflow,
      requestsPerSecond,
      totalKeys,
      redisInfo,
      logs,
    ] = await Promise.all([
      getAllConnections(),
      getDashboardWorkflowSnapshot(),
      getObservedRedisRequestsPerSecond().catch(() => 0),
      client.dbSize().catch(() => 0),
      client.info().catch(() => ""),
      SystemLogger.getLogs(undefined, 500),
    ])
    const connectionList = Array.isArray(connections) ? connections : []
    const positionRows = await mapWithConcurrency(
      connectionList,
      8,
      async (connection: any) => {
        const connectionId = String(connection.id)
        const [pseudo, liveOpen, liveClosed] = await Promise.all([
          new PseudoPositionManager(connectionId).getActivePositions().catch(() => []),
          getOpenLivePositionReadModels(connectionId, 0),
          getClosedLivePositionReadModels(connectionId, 0),
        ])
        return { pseudo, liveOpen, liveClosed }
      },
    )
    const pseudoPositions = positionRows.flatMap((row) => row.pseudo)
    const openRealPositions = positionRows.flatMap((row) => row.liveOpen)
    const closedRealPositions = positionRows.flatMap((row) => row.liveClosed)
    const activeConnections = connectionList.filter((connection: any) =>
      isConnectionDashboardEnabled(connection),
    )
    const liveTradeConnections = connectionList.filter((connection: any) =>
      isConnectionLiveTradeEnabled(connection),
    )
    const usedMemory = Number(redisInfo.match(/(?:^|\r?\n)used_memory:(\d+)/)?.[1] || 0)
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const errors = logs.filter((entry) => entry.level === "error")
    const warnings = logs.filter((entry) => entry.level === "warn")
    const recentErrors = errors.filter(
      (entry) => new Date(entry.timestamp).getTime() >= oneHourAgo,
    )
    const connectionHealth = activeConnections.length > 0 ? "healthy" : "warning"
    const errorHealth =
      recentErrors.length > 10 ? "critical" : recentErrors.length > 5 ? "warning" : "healthy"
    const overallHealth = calculateOverallHealth({ connectionHealth, errorHealth })
    const pseudoPending = pseudoPositions.filter((position: any) =>
      ["pending", "opening"].includes(String(position.status || "").toLowerCase()),
    ).length

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      responseTime: Date.now() - startTime,
      system: {
        status: overallHealth,
        engineStatus: workflow.globalStatus,
        uptime: process.uptime(),
        version: process.env.npm_package_version || "unknown",
        environment: process.env.NODE_ENV || "production",
        cpuUsage: resourceMetrics.cpuPercent,
        memoryUsed: resourceMetrics.memoryUsedBytes,
        memoryTotal: resourceMetrics.memoryTotalBytes,
        heapUsed: resourceMetrics.heapUsedBytes,
        rss: resourceMetrics.rssBytes,
        processCount: 1,
      },
      database: {
        connected: true,
        requestsPerSecond,
        totalKeys,
        sizeMb: Math.round((usedMemory / 1024 / 1024) * 100) / 100,
        activeConnections: activeConnections.length,
      },
      connections: {
        total: connectionList.length,
        active: activeConnections.length,
        liveTrade: liveTradeConnections.length,
        byExchange: aggregateByExchange(connectionList),
        health: connectionHealth,
        details: connectionList.map((connection: any) => ({
          id: connection.id,
          name: connection.name,
          exchange: connection.exchange,
          isEnabled: isConnectionDashboardEnabled(connection),
          isLiveTrading: isConnectionLiveTradeEnabled(connection),
          lastTestStatus: connection.last_test_status,
          lastTestAt: connection.last_test_at,
        })),
      },
      trading: {
        pseudoPositions: {
          total: pseudoPositions.length,
          open: pseudoPositions.filter((position: any) =>
            ["open", "active", "simulated"].includes(
              String(position.status || "").toLowerCase(),
            ),
          ).length,
          pending: pseudoPending,
        },
        realPositions: {
          total: openRealPositions.length + closedRealPositions.length,
          open: openRealPositions.length,
          closed: closedRealPositions.length,
        },
        // Compatibility scalars used by the compact Seed/System dialog.
        livePositions: openRealPositions.length,
        pendingPositions: pseudoPending,
        closedPositions: closedRealPositions.length,
        health:
          openRealPositions.length > 0 || pseudoPositions.length > 0
            ? "active"
            : "idle",
      },
      processing: {
        cycles: workflow.connectionMetrics.engineCycles,
        averageDurationsMs: workflow.connectionMetrics.engineDurations,
        progression: workflow.connectionMetrics.progression,
      },
      errors: {
        count: errors.length,
        total: errors.length,
        lastHour: recentErrors.length,
        critical: recentErrors.length,
        warning: warnings.length,
        warnings: warnings.length,
        health: errorHealth,
        recent: [...errors, ...warnings]
          .sort(
            (left, right) =>
              new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
          )
          .slice(0, 5)
          .map((entry) => ({
            level: entry.level,
            message: entry.message,
            timestamp: entry.timestamp,
            component: entry.category,
          })),
      },
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] [Monitoring] Failed to fetch comprehensive metrics:", errorMessage)
    await SystemLogger.logError(
      "system",
      error,
      { source: "GET /api/monitoring/comprehensive" },
    )
    return NextResponse.json(
      {
        timestamp: new Date().toISOString(),
        responseTime: Date.now() - startTime,
        system: { status: "error", error: errorMessage },
      },
      { status: 500 },
    )
  }
}

function calculateOverallHealth(metrics: {
  connectionHealth: string
  errorHealth: string
}): "healthy" | "degraded" | "critical" | "error" {
  const healthScores: Record<string, number> = {
    healthy: 3,
    warning: 2,
    idle: 2,
    degraded: 1,
    critical: 0,
    error: 0,
  }
  const scores = [
    healthScores[metrics.connectionHealth] || 0,
    healthScores[metrics.errorHealth] || 0,
  ]
  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length
  if (average >= 2.5) return "healthy"
  if (average >= 1.5) return "degraded"
  if (average >= 0.5) return "critical"
  return "error"
}

function aggregateByExchange(connections: any[]): Record<string, number> {
  return connections.reduce((output: Record<string, number>, connection: any) => {
    const exchange = String(connection.exchange || "unknown")
    output[exchange] = (output[exchange] || 0) + 1
    return output
  }, {})
}
