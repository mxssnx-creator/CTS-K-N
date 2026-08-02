import { NextResponse } from "next/server"
import { getAllConnections, getRedisClient, verifyRedisHealth } from "@/lib/redis-db"
import { healthCheckService, HealthStatus } from "@/lib/health-check"

export const dynamic = "force-dynamic"

type HealthMetrics = {
  runningEngines: number
  totalTrades: number
  totalPositions: number
  totalConnections: number
  enabledConnections: number
}

const HEALTH_DIAGNOSTIC_BUDGET_MS = 1_000
const EMPTY_METRICS: HealthMetrics = {
  runningEngines: 0,
  totalTrades: 0,
  totalPositions: 0,
  totalConnections: 0,
  enabledConnections: 0,
}
let lastMetrics: HealthMetrics = { ...EMPTY_METRICS }

/**
 * A liveness endpoint must never inherit an unbounded dashboard/diagnostic
 * wait. The work continues in the background, but the caller gets a truthful
 * degraded response instead of timing out and incorrectly triggering a second
 * recovery/restart loop.
 */
function withinHealthBudget<T>(work: Promise<T>, fallback: T, timeoutMs = HEALTH_DIAGNOSTIC_BUDGET_MS): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs)
    timer.unref?.()
    void work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

function readCachedMetrics(raw: string | null): HealthMetrics | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    const values = [
      parsed?.runningEngines,
      parsed?.totalTrades,
      parsed?.totalPositions,
      parsed?.totalConnections,
      parsed?.enabledConnections,
    ].map(Number)
    if (values.some((value) => !Number.isFinite(value) || value < 0)) return null
    return {
      runningEngines: values[0],
      totalTrades: values[1],
      totalPositions: values[2],
      totalConnections: values[3],
      enabledConnections: values[4],
    }
  } catch {
    return null
  }
}

async function collectMetrics(): Promise<{ metrics: HealthMetrics; fresh: boolean }> {
  const client = getRedisClient()
  const cacheKey = "health:cached_metrics"
  const cached = readCachedMetrics(await withinHealthBudget(client.get(cacheKey), null, 250))
  if (cached) {
    lastMetrics = cached
    return { metrics: cached, fresh: true }
  }

  const connections = await withinHealthBudget(getAllConnections(), null)
  if (!connections) return { metrics: lastMetrics, fresh: false }

  const rows = await withinHealthBudget(
    Promise.all(connections.map(async (connection) => {
      const id = String(connection?.id || "")
      const [running, trades, positions] = await Promise.all([
        client.get(`engine_is_running:${id}`).catch(() => null),
        client.smembers(`trades:${id}`).catch(() => [] as string[]),
        client.smembers(`positions:${id}`).catch(() => [] as string[]),
      ])
      return {
        running: running === "1" || running === "true",
        trades: trades.length,
        positions: positions.length,
      }
    })),
    null,
  )
  if (!rows) return { metrics: lastMetrics, fresh: false }

  const metrics: HealthMetrics = {
    runningEngines: rows.filter((row) => row.running).length,
    totalTrades: rows.reduce((sum, row) => sum + row.trades, 0),
    totalPositions: rows.reduce((sum, row) => sum + row.positions, 0),
    totalConnections: connections.length,
    enabledConnections: connections.filter((connection) => connection?.is_enabled).length,
  }
  lastMetrics = metrics
  void client.setex(cacheKey, 5, JSON.stringify(metrics)).catch(() => undefined)
  return { metrics, fresh: true }
}

export async function GET() {
  const unavailableReport = {
    status: HealthStatus.DEGRADED,
    timestamp: new Date(),
    uptime: 0,
    checks: {},
    summary: "Health diagnostics exceeded the liveness budget",
  }
  const [report, redisHealth, collected] = await Promise.all([
    withinHealthBudget(healthCheckService.getHealthReport(), unavailableReport),
    withinHealthBudget(verifyRedisHealth(), { healthy: false, latency: HEALTH_DIAGNOSTIC_BUDGET_MS }),
    withinHealthBudget(collectMetrics(), { metrics: lastMetrics, fresh: false }),
  ])

  const diagnosticsComplete = collected.fresh && redisHealth.healthy
  const status = diagnosticsComplete && report.status !== HealthStatus.UNHEALTHY
    ? report.status
    : HealthStatus.DEGRADED

  return NextResponse.json({
    ...report,
    status,
    alive: true,
    timestamp: new Date().toISOString(),
    redis: {
      healthy: redisHealth.healthy,
      connected: redisHealth.healthy,
      latencyMs: redisHealth.latency,
    },
    diagnostics: {
      complete: diagnosticsComplete,
      budgetMs: HEALTH_DIAGNOSTIC_BUDGET_MS,
    },
    system: {
      totalConnections: collected.metrics.totalConnections,
      enabledConnections: collected.metrics.enabledConnections,
      runningEngines: collected.metrics.runningEngines,
      totalTrades: collected.metrics.totalTrades,
      totalOpenPositions: collected.metrics.totalPositions,
    },
  }, { status: 200 })
}
