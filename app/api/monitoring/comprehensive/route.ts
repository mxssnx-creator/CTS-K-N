import { NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import {
  getAllConnections,
  getAssignedAndEnabledConnections,
  getObservedRedisRequestsPerSecond,
  getRedisClient,
  initRedis,
} from "@/lib/redis-db"
import { computeResultBook, readResultLedger } from "@/lib/results/ledger"
import { getSystemResourceMetrics } from "@/lib/system-resource-metrics"
import { getStrategyMemoryCoordinationSnapshot } from "@/lib/strategy-memory-guard"
import { getDashboardWorkflowSnapshot } from "@/lib/dashboard-workflow"
import {
  getClosedLivePositionReadModels,
  getOpenLivePositionReadModels,
  LIVE_POSITION_CLOSED_READ_LIMIT,
  LIVE_POSITION_OPEN_READ_LIMIT,
} from "@/lib/live-position-read-model"
import { isExecutedRealExchangePosition } from "@/lib/live-position-source"
import { isLiveOpenStatus } from "@/lib/live-position-status"
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

// A dialog polls this every 3 s, possibly several at once. One build serves
// every caller for a few seconds instead of re-reading positions, 500 log
// rows and INFO per request.
const RESPONSE_CACHE_MS = 5_000
let cachedResponse: { at: number; body: Record<string, unknown> } | null = null
let responseInFlight: Promise<Record<string, unknown>> | null = null

export async function GET() {
  const startTime = Date.now()
  if (cachedResponse && startTime - cachedResponse.at < RESPONSE_CACHE_MS) {
    return NextResponse.json(cachedResponse.body)
  }
  try {
    if (!responseInFlight) {
      responseInFlight = buildComprehensiveMetrics(startTime)
        .then((body) => {
          cachedResponse = { at: Date.now(), body }
          return body
        })
        .finally(() => {
          responseInFlight = null
        })
    }
    return NextResponse.json(await responseInFlight)
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

async function buildComprehensiveMetrics(startTime: number): Promise<Record<string, unknown>> {
  await initRedis()
  const client = getRedisClient()
  const resourceMetrics = getSystemResourceMetrics()
  const memoryCoordination = getStrategyMemoryCoordinationSnapshot()
  const [
    connections,
    processedConnections,
    workflow,
    requestsPerSecond,
    totalKeys,
    redisInfo,
    logs,
  ] = await Promise.all([
    getAllConnections(),
    getAssignedAndEnabledConnections(),
    getDashboardWorkflowSnapshot(),
    getObservedRedisRequestsPerSecond().catch(() => 0),
    client.dbSize().catch(() => 0),
    client.info().catch(() => ""),
    SystemLogger.getLogs(undefined, 500),
  ])
  const connectionList = Array.isArray(connections) ? connections : []
  // Positions only of the connections the engine processes, and counted
  // from the open pseudo set's cardinality and the results ledger instead
  // of loading every stored connection's rows on each request.
  const positionCounts = await mapWithConcurrency(
    Array.isArray(processedConnections) ? processedConnections : [],
    8,
    async (connection: any) => {
      const connectionId = String(connection.id)
      const [pseudoOpen, ledger] = await Promise.all([
        client.scard(`pseudo_positions:${connectionId}`).catch(() => 0),
        readResultLedger(client, connectionId).catch(() => null),
      ])
      if (ledger && ledger.meta.complete) {
        const book = computeResultBook(ledger.entries)
        return { pseudoOpen: Number(pseudoOpen) || 0, liveOpen: book.open, liveClosed: book.closed }
      }
      // No complete ledger yet: the bounded read models, executed real rows only.
      const [liveOpen, liveClosed] = await Promise.all([
        getOpenLivePositionReadModels(connectionId, LIVE_POSITION_OPEN_READ_LIMIT),
        getClosedLivePositionReadModels(connectionId, LIVE_POSITION_CLOSED_READ_LIMIT),
      ])
      return {
        pseudoOpen: Number(pseudoOpen) || 0,
        liveOpen: liveOpen.filter((position: any) => (
          isExecutedRealExchangePosition(position) &&
          isLiveOpenStatus(position.status)
        )).length,
        liveClosed: liveClosed.filter((position: any) => (
          isExecutedRealExchangePosition(position) &&
          String(position.status || "").trim().toLowerCase() === "closed"
        )).length,
      }
    },
  )
  const pseudoOpen = positionCounts.reduce((sum, row) => sum + row.pseudoOpen, 0)
  const openRealPositions = positionCounts.reduce((sum, row) => sum + row.liveOpen, 0)
  const closedRealPositions = positionCounts.reduce((sum, row) => sum + row.liveClosed, 0)
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
  // Pseudo positions are created open and the set tracks open ones only;
  // the previous row filter for pending/opening could only ever find 0.
  const pseudoPending = 0

  return {
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
      memoryCoordination,
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
        total: pseudoOpen,
        open: pseudoOpen,
        pending: pseudoPending,
      },
      realPositions: {
        total: openRealPositions + closedRealPositions,
        open: openRealPositions,
        closed: closedRealPositions,
      },
      // Compatibility scalars used by the compact Seed/System dialog.
      livePositions: openRealPositions,
      pendingPositions: pseudoPending,
      closedPositions: closedRealPositions,
      health:
        openRealPositions > 0 || pseudoOpen > 0
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
