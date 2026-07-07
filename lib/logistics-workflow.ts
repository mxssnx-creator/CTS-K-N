import { type getDashboardWorkflowSnapshot } from "@/lib/dashboard-workflow"

type DashboardWorkflowSnapshot = Awaited<ReturnType<typeof getDashboardWorkflowSnapshot>>

export function buildLogisticsQueuePayload(snapshot: DashboardWorkflowSnapshot) {
  const { focusConnection, connectionMetrics, overview, globalStatus } = snapshot

  const cycleSuccessRate = Math.round(connectionMetrics.progression?.cycleSuccessRate || 0)
  const completedOrders = connectionMetrics.trades
  const failedOrders = connectionMetrics.progression?.failedCycles || 0
  const totalProcessed = completedOrders + failedOrders
  const successRate = totalProcessed > 0 ? Math.round((completedOrders / totalProcessed) * 100) : cycleSuccessRate

  const processingRate = connectionMetrics.engineCycles?.total || connectionMetrics.progression?.cyclesCompleted || 0

  const latencySamples = [
    connectionMetrics.engineDurations?.indicationAvgMs || 0,
    connectionMetrics.engineDurations?.strategyAvgMs || 0,
    connectionMetrics.engineDurations?.realtimeAvgMs || 0,
  ].filter((value) => value > 0)

  const avgLatency =
    latencySamples.length > 0
      ? Math.round(latencySamples.reduce((sum, value) => sum + value, 0) / latencySamples.length)
      : 0

  const latestSymbolFromLogs = connectionMetrics.logs.find((log: any) => typeof log.details?.symbol === "string")?.details?.symbol
  const focusSymbol = latestSymbolFromLogs || "N/A"
  const queueBacklog = Math.max(0, overview.eligibleEngineConnections - processingRate)
  const workflowHealth =
    overview.eligibleEngineConnections === 0
      ? "needs-input"
      : globalStatus === "running"
        ? "operational"
        : globalStatus === "paused"
          ? "degraded"
          : "blocked"
  const processingPressure = overview.eligibleEngineConnections > 0
    ? Math.min(100, Math.round((queueBacklog / overview.eligibleEngineConnections) * 100))
    : 0

  return {
    success: true,
    queueSize: Math.max(0, overview.eligibleEngineConnections - overview.liveTradeConnections),
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
    activeOrders: focusConnection
      ? [
          {
            id: focusConnection.id,
            orderId: `#${focusConnection.id.slice(0, 8)}`,
            symbol: focusSymbol,
            status: globalStatus === "running" ? "processing" : "waiting",
            quantity: `${connectionMetrics.positions} tracked positions`,
            latency: avgLatency,
          },
        ]
      : [],
    workflow: snapshot.workflowPhases,
    focusConnection,
    progression: connectionMetrics.progression,
    quickstart: snapshot.quickstartState,
    recentGlobalLogs: snapshot.recentGlobalLogs.slice(0, 5),
  }
}
