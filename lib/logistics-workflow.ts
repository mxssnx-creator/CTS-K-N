import { type getDashboardWorkflowSnapshot } from "@/lib/dashboard-workflow"

type DashboardWorkflowSnapshot = Awaited<ReturnType<typeof getDashboardWorkflowSnapshot>>

type LogisticsRateSample = { processed: number; at: number; rate: number }
const logisticsGlobal = globalThis as typeof globalThis & {
  __logisticsRateSamples?: Map<string, LogisticsRateSample>
}
const rateSamples = logisticsGlobal.__logisticsRateSamples ?? new Map<string, LogisticsRateSample>()
logisticsGlobal.__logisticsRateSamples = rateSamples

function calculateOrderRate(connectionId: string, processed: number): number {
  const now = Date.now()
  const previous = rateSamples.get(connectionId)
  let rate = 0
  if (previous && processed >= previous.processed && now > previous.at) {
    rate = (processed - previous.processed) / ((now - previous.at) / 1000)
  }
  const rounded = Math.round(Math.max(0, rate) * 100) / 100
  rateSamples.set(connectionId, { processed, at: now, rate: rounded })

  // This is observability state, not trade state. Keep it strictly bounded.
  if (rateSamples.size > 100) {
    const oldest = Array.from(rateSamples.entries()).sort((a, b) => a[1].at - b[1].at)
    for (const [key] of oldest.slice(0, rateSamples.size - 100)) rateSamples.delete(key)
  }
  return rounded
}

export function buildLogisticsQueuePayload(snapshot: DashboardWorkflowSnapshot) {
  const { focusConnection, connectionMetrics, overview, globalStatus } = snapshot

  const cycleSuccessRate = Math.round(connectionMetrics.progression?.cycleSuccessRate || 0)
  const completedOrders = connectionMetrics.liveOrders.filled
  const failedOrders = connectionMetrics.liveOrders.failed
  const totalProcessed = completedOrders + failedOrders
  const successRate = totalProcessed > 0 ? Math.round((completedOrders / totalProcessed) * 100) : cycleSuccessRate
  const processingRate = calculateOrderRate(
    focusConnection?.id || "global",
    totalProcessed,
  )

  const latencySamples = [
    connectionMetrics.engineDurations?.indicationAvgMs || 0,
    connectionMetrics.engineDurations?.strategyAvgMs || 0,
    connectionMetrics.engineDurations?.realtimeAvgMs || 0,
  ].filter((value) => value > 0)

  const avgLatency =
    latencySamples.length > 0
      ? Math.round(latencySamples.reduce((sum, value) => sum + value, 0) / latencySamples.length)
      : 0

  const queueBacklog = connectionMetrics.liveOrders.pending
  const queueCapacity = connectionMetrics.maxOpenPositions
  const processingPressure = queueCapacity > 0
    ? Math.min(100, Math.round((queueBacklog / queueCapacity) * 100))
    : 0
  const degradedRuntime =
    processingPressure >= 90 ||
    (totalProcessed > 0 && successRate < 50)
  const workflowHealth =
    overview.eligibleEngineConnections === 0
      ? "needs-input"
      : globalStatus === "running"
        ? degradedRuntime ? "degraded" : "healthy"
        : globalStatus === "paused"
          ? "degraded"
          : "blocked"

  return {
    success: true,
    queueSize: queueBacklog,
    queueCapacity,
    queueBacklog,
    workflowHealth,
    processingPressure,
    processingRate,
    successRate,
    avgLatency,
    maxLatency: avgLatency ? avgLatency + 120 : 0,
    throughput: processingRate > 0 ? processingRate * 60 : 0,
    completedOrders,
    failedOrders,
    // Do not fabricate venue order IDs. Detailed open orders come from the
    // exchange/live-position APIs; this endpoint provides aggregate queue data.
    activeOrders: [],
    workflow: snapshot.workflowPhases,
    focusConnection,
    progression: connectionMetrics.progression,
    quickstart: snapshot.quickstartState,
    recentGlobalLogs: snapshot.recentGlobalLogs.slice(0, 5),
  }
}
