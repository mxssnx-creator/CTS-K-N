import { type NextRequest, NextResponse } from "next/server"
import { getDashboardWorkflowSnapshot } from "@/lib/dashboard-workflow"
import { getActiveIndications, getActiveStrategies, getAllPositions } from "@/lib/db-helpers"
import { buildLogisticsQueuePayload } from "@/lib/logistics-workflow"
import {
  getObservedRedisRequestsPerSecond,
  getRedisClient,
  initRedis,
} from "@/lib/redis-db"
import { getSystemResourceMetrics } from "@/lib/system-resource-metrics"

export const dynamic = "force-dynamic"

const TERMINAL_POSITION_STATUSES = new Set([
  "closed",
  "cancelled",
  "canceled",
  "rejected",
  "failed",
  "error",
])

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function timestampOf(row: Record<string, unknown>, ...fields: string[]): number {
  for (const field of fields) {
    const value = row[field]
    if (value == null || value === "") continue
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 10_000_000_000 ? numeric * 1000 : numeric
    }
    const parsed = new Date(String(value)).getTime()
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function isOpenPosition(row: Record<string, unknown>): boolean {
  const status = String(row.status || "").toLowerCase()
  return Boolean(status) && !TERMINAL_POSITION_STATUSES.has(status)
}

function positionPnl(row: Record<string, unknown>): number {
  for (const key of [
    "profit_loss_percent",
    "profitLossPercent",
    "realized_pnl",
    "realizedPnl",
    "profit_loss",
    "profitLoss",
    "pnl",
  ]) {
    const value = Number(row[key])
    if (Number.isFinite(value)) return value
  }
  return 0
}

function classicProfitFactor(rows: ReadonlyArray<Record<string, unknown>>): number {
  let grossProfit = 0
  let grossLoss = 0
  for (const row of rows) {
    const pnl = positionPnl(row)
    if (pnl > 0) grossProfit += pnl
    else if (pnl < 0) grossLoss += Math.abs(pnl)
  }
  if (grossLoss <= 0) return grossProfit > 0 ? 999 : 0
  return Math.round((grossProfit / grossLoss) * 10_000) / 10_000
}

function stageOf(row: Record<string, unknown>): "base" | "main" | "real" | "active" | null {
  const stage = String(
    row.stage ??
    row.position_stage ??
    row.positionStage ??
    row.set_stage ??
    row.setStage ??
    row.type ??
    "",
  ).toLowerCase()
  if (stage.includes("base")) return "base"
  if (stage.includes("main")) return "main"
  if (stage.includes("real")) return "real"
  if (stage.includes("active") || stage.includes("live")) return "active"
  return null
}

function positionVolume(row: Record<string, unknown>): number {
  const explicit = finite(row.volumeUsd ?? row.volume_usd ?? row.volume)
  if (explicit > 0) return explicit
  const entry = finite(row.entry_price ?? row.entryPrice)
  const quantity = finite(row.quantity ?? row.executedQuantity ?? row.executed_quantity)
  return Math.max(0, entry * quantity)
}

function isStrategyActive(row: Record<string, unknown>): boolean {
  const value = row.is_active ?? row.isActive ?? row.enabled
  if (value == null || value === "") return true
  return value === true || value === 1 || value === "1" || value === "true"
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
    const isScoped = Boolean(preferredConnectionId)

    await initRedis()
    const client = getRedisClient()
    const databaseStartedAt = Date.now()
    const [
      workflowSnapshot,
      indications,
      strategies,
      positions,
      redisRequestsPerSecond,
      databaseKeys,
      redisInfo,
    ] = await Promise.all([
      getDashboardWorkflowSnapshot({ preferredConnectionId }).catch(() => null),
      getActiveIndications(preferredConnectionId).catch(() => []),
      getActiveStrategies(preferredConnectionId).catch(() => []),
      getAllPositions(preferredConnectionId).catch(() => []),
      getObservedRedisRequestsPerSecond().catch(() => 0),
      client.dbSize().catch(() => 0),
      client.info().catch(() => ""),
    ])
    const databaseLatencyMs = Date.now() - databaseStartedAt
    const logistics = workflowSnapshot ? buildLogisticsQueuePayload(workflowSnapshot) : null
    const resourceMetrics = getSystemResourceMetrics()
    const now = Date.now()
    const hourAgo = now - 60 * 60 * 1000
    const dayAgo = now - 24 * 60 * 60 * 1000

    const allPositions = positions as Array<Record<string, unknown>>
    const openPositions = allPositions.filter(isOpenPosition)
    const closedPositions = allPositions
      .filter((row) => TERMINAL_POSITION_STATUSES.has(String(row.status || "").toLowerCase()))
      .sort(
        (left, right) =>
          timestampOf(right, "closed_at", "closedAt", "updated_at", "updatedAt", "timestamp") -
          timestampOf(left, "closed_at", "closedAt", "updated_at", "updatedAt", "timestamp"),
      )
    const positionsLastHour = allPositions.filter(
      (row) => timestampOf(row, "opened_at", "openedAt", "created_at", "createdAt", "timestamp") >= hourAgo,
    )
    const positionsLastDay = allPositions.filter(
      (row) => timestampOf(row, "opened_at", "openedAt", "created_at", "createdAt", "timestamp") >= dayAgo,
    )
    const activeSymbols = new Set(
      openPositions
        .map((row) => String(row.symbol || "").trim().toUpperCase())
        .filter(Boolean),
    )

    const stageCounts = { base: 0, main: 0, real: 0, active: 0 }
    const closedByStage = {
      base: [] as Array<Record<string, unknown>>,
      main: [] as Array<Record<string, unknown>>,
      real: [] as Array<Record<string, unknown>>,
      active: [] as Array<Record<string, unknown>>,
    }
    for (const row of allPositions) {
      const stage = stageOf(row)
      if (stage && isOpenPosition(row)) stageCounts[stage]++
      if (stage && TERMINAL_POSITION_STATUSES.has(String(row.status || "").toLowerCase())) {
        closedByStage[stage].push(row)
      }
    }

    const usedMemory = finite(redisInfo.match(/(?:^|\r?\n)used_memory:(\d+)/)?.[1])
    const connectedClients = finite(redisInfo.match(/(?:^|\r?\n)connected_clients:(\d+)/)?.[1])
    const databaseSizeMb = Math.round((usedMemory / 1024 / 1024) * 100) / 100
    const activeStrategies = (strategies as Array<Record<string, unknown>>).filter(isStrategyActive)
    const activeConnectionCount = workflowSnapshot
      ? isScoped
        ? Number(Boolean(workflowSnapshot.focusConnection?.isDashboardEnabled))
        : workflowSnapshot.overview.eligibleEngineConnections
      : 0
    const profitFactorLast20Hours = classicProfitFactor(
      closedPositions.filter(
        (row) => timestampOf(row, "closed_at", "closedAt", "updated_at", "updatedAt", "timestamp") >= now - 20 * 60 * 60 * 1000,
      ),
    )

    const pfByType = Object.fromEntries(
      (["base", "main", "real", "active"] as const).map((stage) => [
        stage,
        {
          pf20h: classicProfitFactor(
            closedByStage[stage].filter(
              (row) => timestampOf(row, "closed_at", "closedAt", "updated_at", "updatedAt", "timestamp") >= now - 20 * 60 * 60 * 1000,
            ),
          ),
          pf25: classicProfitFactor(closedByStage[stage].slice(0, 25)),
        },
      ]),
    ) as Record<"base" | "main" | "real" | "active", { pf20h: number; pf25: number }>

    return NextResponse.json({
      success: true,
      scope: isScoped ? "connection" : "global",
      connectionId: preferredConnectionId || null,
      data: {
        systemMetrics: {
          cpu_usage: resourceMetrics.cpuPercent,
          memory_usage: resourceMetrics.memoryPercent,
          memory_used_bytes: resourceMetrics.memoryUsedBytes,
          memory_total_bytes: resourceMetrics.memoryTotalBytes,
          database_size: databaseSizeMb,
          database_keys: databaseKeys,
          database_connections: connectedClients || 1,
          database_latency_ms: databaseLatencyMs,
          database_connected: true,
          redis_operations_per_minute: Math.round(redisRequestsPerSecond * 60),
          api_requests_per_minute: Math.round(redisRequestsPerSecond * 60),
          websocket_connections: 0,
          websocket_instrumented: false,
          uptime_hours: Math.round((process.uptime() / 3600) * 100) / 100,
        },
        tradingLogistics: {
          active_connections: activeConnectionCount,
          total_strategies: strategies.length,
          active_strategies: activeStrategies.length,
          open_positions: openPositions.length,
          total_volume_24h: positionsLastDay.reduce((sum, row) => sum + positionVolume(row), 0),
          trades_per_hour: positionsLastHour.length,
          avg_response_time: logistics?.avgLatency || 0,
          workflow_health: logistics?.workflowHealth || "unknown",
          queue_backlog: logistics?.queueBacklog || 0,
          processing_pressure: logistics?.processingPressure || 0,
          success_rate: logistics?.successRate || 0,
        },
        rawMetrics: {
          activeConnections: activeConnectionCount,
          totalPositions: allPositions.length,
          dailyPnL: positionsLastDay.reduce((sum, row) => sum + positionPnl(row), 0),
          totalBalance: 0,
          indicationsActive: indications.length,
          indicationsTotal: indications.length,
          strategiesActive: activeStrategies.length,
          strategiesTotal: strategies.length,
          systemLoad: resourceMetrics.cpuPercent,
          databaseSize: databaseSizeMb,
          databaseKeys,
          activeSymbols: activeSymbols.size,
          realPositions: stageCounts.real,
          pseudoPositionsBase: stageCounts.base,
          pseudoPositionsMain: stageCounts.main,
          pseudoPositionsReal: stageCounts.real,
          pseudoPositionsActive: stageCounts.active,
          profitFactorLast20h: profitFactorLast20Hours,
          profitFactorLast50: classicProfitFactor(closedPositions.slice(0, 50)),
          profitFactorLast25: classicProfitFactor(closedPositions.slice(0, 25)),
          livePositions: openPositions.length,
          pseudoBasePF20h: pfByType.base.pf20h,
          pseudoBasePF25: pfByType.base.pf25,
          pseudoMainPF20h: pfByType.main.pf20h,
          pseudoMainPF25: pfByType.main.pf25,
          pseudoRealPF20h: pfByType.real.pf20h,
          pseudoRealPF25: pfByType.real.pf25,
          pseudoActivePF20h: pfByType.active.pf20h,
          pseudoActivePF25: pfByType.active.pf25,
        },
      },
    })
  } catch (error) {
    console.error("[v0] Error fetching structure metrics:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch structure metrics",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
