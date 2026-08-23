import { NextResponse } from "next/server"
import { getAllConnections, getRedisClient, verifyRedisHealth } from "@/lib/redis-db"
import { healthCheckService, HealthStatus } from "@/lib/health-check"
import { resolveDistributedEngineRuntime } from "@/lib/distributed-engine-runtime"
import { isConnectionMainProcessing } from "@/lib/connection-state-utils"

export const dynamic = "force-dynamic"

type HealthMetrics = {
  runningEngines: number
  totalTrades: number
  totalPositions: number
  totalConnections: number
  enabledConnections: number
  expectedRunningEngines: number
  runtimeDeficit: number
}

const HEALTH_DIAGNOSTIC_BUDGET_MS = 1_000
const EMPTY_METRICS: HealthMetrics = {
  runningEngines: 0,
  totalTrades: 0,
  totalPositions: 0,
  totalConnections: 0,
  enabledConnections: 0,
  expectedRunningEngines: 0,
  runtimeDeficit: 0,
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
      parsed?.expectedRunningEngines ?? 0,
      parsed?.runtimeDeficit ?? 0,
    ].map(Number)
    if (values.some((value) => !Number.isFinite(value) || value < 0)) return null
    return {
      runningEngines: values[0],
      totalTrades: values[1],
      totalPositions: values[2],
      totalConnections: values[3],
      enabledConnections: values[4],
      expectedRunningEngines: values[5],
      runtimeDeficit: values[6],
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

  const globalState = await withinHealthBudget(
    client.hgetall("trade_engine:global").catch(() => ({} as Record<string, string>)),
    {} as Record<string, string>,
    250,
  )
  const globalIntent = String(
    globalState.operator_intent || globalState.desired_status || globalState.status || "",
  ).trim().toLowerCase()
  const operatorWantsRunning = globalIntent === "running"

  const rows = await withinHealthBudget(
    Promise.all(connections.map(async (connection) => {
      const id = String(connection?.id || "")
      const [runningHint, runtimeState, settingsState, trades, positions] = await Promise.all([
        client.get(`engine_is_running:${id}`).catch(() => null),
        client.hgetall(`trade_engine_state:${id}`).catch(() => ({} as Record<string, string>)),
        client.hgetall(`settings:trade_engine_state:${id}`).catch(() => ({} as Record<string, string>)),
        client.scard(`trades:${id}`).catch(() => 0),
        client.scard(`positions:${id}`).catch(() => 0),
      ])
      const enabled = isConnectionMainProcessing(connection)
      const runtime = resolveDistributedEngineRuntime({
        runningHint,
        states: [runtimeState, settingsState],
        globalState,
        connectionEnabled: enabled,
      })
      return {
        running: runtime.running,
        expected: operatorWantsRunning && enabled,
        trades: Math.max(0, Number(trades) || 0),
        positions: Math.max(0, Number(positions) || 0),
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
    enabledConnections: connections.filter((connection) => isConnectionMainProcessing(connection)).length,
    expectedRunningEngines: rows.filter((row) => row.expected).length,
    runtimeDeficit: rows.filter((row) => row.expected && !row.running).length,
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
  const runtimeHealthy = collected.metrics.runtimeDeficit === 0
  const status = diagnosticsComplete && runtimeHealthy && report.status !== HealthStatus.UNHEALTHY
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
      runtimeHealthy,
      runtimeDeficit: collected.metrics.runtimeDeficit,
    },
    system: {
      totalConnections: collected.metrics.totalConnections,
      enabledConnections: collected.metrics.enabledConnections,
      expectedRunningEngines: collected.metrics.expectedRunningEngines,
      runningEngines: collected.metrics.runningEngines,
      runtimeDeficit: collected.metrics.runtimeDeficit,
      totalTrades: collected.metrics.totalTrades,
      totalOpenPositions: collected.metrics.totalPositions,
    },
  }, { status: 200 })
}
