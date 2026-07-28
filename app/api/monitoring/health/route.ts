import { NextResponse } from "next/server"
import { getAllConnections, getRedisClient, initRedis } from "@/lib/redis-db"
import { getDashboardWorkflowSnapshot } from "@/lib/dashboard-workflow"
import { getSystemResourceMetrics } from "@/lib/system-resource-metrics"

export const dynamic = "force-dynamic"

type ComponentStatus = "healthy" | "degraded" | "unhealthy" | "inactive" | "starting"

function measuredComponent(
  running: boolean,
  cycles: number,
  durationMs: number,
  lastUpdateAt: number,
): {
  status: ComponentStatus
  cycles: number
  durationMs: number
  lastUpdate: string | null
} {
  const ageMs = lastUpdateAt > 0 ? Date.now() - lastUpdateAt : Number.POSITIVE_INFINITY
  let status: ComponentStatus
  if (!running) status = "inactive"
  else if (cycles <= 0 || !Number.isFinite(ageMs)) status = "starting"
  else if (ageMs > 120_000) status = "unhealthy"
  else if (ageMs > 60_000) status = "degraded"
  else status = "healthy"

  return {
    status,
    cycles: Math.max(0, Math.floor(cycles || 0)),
    durationMs: Math.max(0, Math.round(durationMs || 0)),
    lastUpdate: lastUpdateAt > 0 ? new Date(lastUpdateAt).toISOString() : null,
  }
}

export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    const redisStartedAt = Date.now()
    const redisReply = await client.ping()
    const redisLatencyMs = Date.now() - redisStartedAt
    const [connections, snapshot] = await Promise.all([
      getAllConnections(),
      getDashboardWorkflowSnapshot(),
    ])
    const resources = getSystemResourceMetrics()
    const running = snapshot.globalStatus === "running"
    const progression = snapshot.connectionMetrics.progression
    const lastUpdateAt = progression?.lastUpdate
      ? new Date(progression.lastUpdate).getTime()
      : 0
    const cycles = snapshot.connectionMetrics.engineCycles
    const durations = snapshot.connectionMetrics.engineDurations

    const components = {
      "indication-processor": measuredComponent(
        running,
        cycles.indication,
        durations.indicationAvgMs,
        lastUpdateAt,
      ),
      "strategy-processor": measuredComponent(
        running,
        cycles.strategy,
        durations.strategyAvgMs,
        lastUpdateAt,
      ),
      "realtime-processor": measuredComponent(
        running,
        cycles.realtime,
        durations.realtimeAvgMs,
        lastUpdateAt,
      ),
      persistence: {
        status: redisReply === "PONG" ? "healthy" : "unhealthy",
        latencyMs: redisLatencyMs,
        lastUpdate: new Date().toISOString(),
      },
    }

    const processingStatuses = Object.entries(components)
      .filter(([name]) => name !== "persistence")
      .map(([, component]) => component.status)
    const unhealthy = processingStatuses.includes("unhealthy")
    const degraded =
      processingStatuses.includes("degraded") ||
      (running && processingStatuses.includes("starting"))
    const overallHealth =
      redisReply !== "PONG" || unhealthy
        ? "unhealthy"
        : degraded
          ? "degraded"
          : running
            ? "healthy"
            : "idle"

    const alerts: Array<{
      id: string
      severity: "warning" | "error"
      title: string
      message: string
      timestamp: string
    }> = []
    if (overallHealth === "degraded" || overallHealth === "unhealthy") {
      alerts.push({
        id: `runtime-${overallHealth}`,
        severity: overallHealth === "unhealthy" ? "error" : "warning",
        title: `Runtime ${overallHealth}`,
        message: `Measured processor state is ${overallHealth}; inspect component age and cycle telemetry.`,
        timestamp: new Date().toISOString(),
      })
    }

    return NextResponse.json({
      success: true,
      overallHealth,
      globalStatus: snapshot.globalStatus,
      activeConnections: snapshot.overview.eligibleEngineConnections,
      totalConnections: connections.length,
      cpuUsage: resources.cpuPercent,
      memoryUsage: resources.memoryPercent,
      memoryUsedBytes: resources.memoryUsedBytes,
      memoryTotalBytes: resources.memoryTotalBytes,
      uptimeDays: Math.round((process.uptime() / 86_400) * 1000) / 1000,
      components,
      indicationCycleDuration: durations.indicationAvgMs,
      strategyCycleDuration: durations.strategyAvgMs,
      realtimeCycleDuration: durations.realtimeAvgMs,
      alerts,
      measuredAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] [Monitoring] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch monitoring data",
        details: error instanceof Error ? error.message : "Unknown error",
        overallHealth: "unknown",
        activeConnections: 0,
        totalConnections: 0,
        cpuUsage: 0,
        memoryUsage: 0,
        uptimeDays: 0,
        components: {},
      },
      { status: 500 },
    )
  }
}
