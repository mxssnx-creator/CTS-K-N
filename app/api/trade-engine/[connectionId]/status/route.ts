import { NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { ProgressionStateManager } from "@/lib/progression-state-manager"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

/**
 * GET /api/trade-engine/[connectionId]/status
 *
 * Returns per-connection engine status including health metrics, cycle counts,
 * and component health breakdown. Used by the monitoring Trade Engines tab.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await params

  if (!connectionId) {
    return NextResponse.json({ success: false, error: "connectionId is required" }, { status: 400 })
  }

  try {
    await initRedis()
    const client = getRedisClient()
    const coordinator = getGlobalTradeEngineCoordinator()

    // Read global operator intent
    const engineHash: Record<string, string> =
      ((await client.hgetall("trade_engine:global").catch(() => null)) as Record<string, string> | null) ?? {}
    const isGloballyRunning =
      (engineHash.operator_intent || engineHash.desired_status || engineHash.status || "stopped") === "running"
    const isGloballyPaused = (engineHash.operator_intent || engineHash.status || "") === "paused"

    // Read connection-scoped state
    const [rawEngineState, settingsEngineState, rawProgression, connHash] = await Promise.all([
      client.hgetall(`trade_engine_state:${connectionId}`).catch(() => ({} as Record<string, string>)),
      client.hgetall(`settings:trade_engine_state:${connectionId}`).catch(() => ({} as Record<string, string>)),
      client.hgetall(`progression:${connectionId}`).catch(() => ({} as Record<string, string>)),
      client.hgetall(`connection:${connectionId}`).catch(() => ({} as Record<string, string>)),
    ])

    const engineState: Record<string, string> = { ...(rawEngineState ?? {}), ...(settingsEngineState ?? {}) }
    const progression = rawProgression ?? {}
    const connData = connHash ?? {}

    // Check heartbeats
    const processorHeartbeat = Number(engineState.last_processor_heartbeat || 0)
    const hasFreshDistributedHeartbeat =
      Number.isFinite(processorHeartbeat) && processorHeartbeat > 0 && Date.now() - processorHeartbeat < 90_000
    const portableCycleRaw = String(progression.portable_cycle_completed_at || "")
    const portableCycleAt = portableCycleRaw ? Date.parse(portableCycleRaw) : 0
    const hasFreshScheduledCycle =
      Number.isFinite(portableCycleAt) && portableCycleAt > 0 && Date.now() - portableCycleAt < 90_000

    const hasLocalEngine = (coordinator?.getActiveEngineCount() || 0) > 0
    const connectionRunning =
      isGloballyRunning &&
      !isGloballyPaused &&
      (hasLocalEngine || hasFreshDistributedHeartbeat || hasFreshScheduledCycle)

    const status = connectionRunning ? "running" : isGloballyPaused ? "paused" : "stopped"

    // Cycle metrics from progression state
    const progressionState = await ProgressionStateManager.getProgressionState(connectionId).catch(() => ({
      cyclesCompleted: 0,
      successfulCycles: 0,
      failedCycles: 0,
    }))

    const cyclesCompleted = Number(progression.cycles_completed || progressionState.cyclesCompleted || 0)
    const indCycles = Number(engineState.indication_cycle_count || engineState.ind_cycles || 0)
    const stratCycles = Number(engineState.strategy_cycle_count || engineState.strat_cycles || 0)
    const realtimeCycles = Number(engineState.realtime_cycle_count || engineState.rt_cycles || cyclesCompleted)

    // Avg durations
    const indAvg = Number(engineState.indication_avg_duration_ms || 0)
    const stratAvg = Number(engineState.strategy_avg_duration_ms || 0)
    const rtAvg = Number(engineState.realtime_avg_duration_ms || 0)

    // Determine component health
    const overallHealthy = connectionRunning || hasFreshDistributedHeartbeat
    const componentStatus = overallHealthy ? "healthy" : "degraded"

    return NextResponse.json({
      success: true,
      connectionId,
      connectionName: connData.name || connectionId,
      exchange: connData.exchange || "unknown",
      status,
      isRunning: connectionRunning,
      hasFreshDistributedHeartbeat,
      hasFreshScheduledCycle,
      lastProcessorHeartbeat: processorHeartbeat || null,
      lastScheduledCycleAt: portableCycleAt || null,
      indication_cycle_count: indCycles,
      strategy_cycle_count: stratCycles,
      realtime_cycle_count: realtimeCycles,
      indication_avg_duration_ms: indAvg,
      strategy_avg_duration_ms: stratAvg,
      realtime_avg_duration_ms: rtAvg,
      metrics: {
        indicationCycleCount: indCycles,
        strategyCycleCount: stratCycles,
        realtimeCycleCount: realtimeCycles,
        indicationAvgDuration: indAvg,
        strategyAvgDuration: stratAvg,
        realtimeAvgDuration: rtAvg,
      },
      health: {
        overall: overallHealthy ? "healthy" : "degraded",
        components: {
          indications: {
            status: componentStatus,
            lastCycleDuration: indAvg,
            errorCount: 0,
            successRate: progressionState.successfulCycles > 0
              ? Math.round((progressionState.successfulCycles / Math.max(progressionState.cyclesCompleted, 1)) * 100)
              : 100,
          },
          strategies: {
            status: componentStatus,
            lastCycleDuration: stratAvg,
            errorCount: 0,
            successRate: 100,
          },
          realtime: {
            status: componentStatus,
            lastCycleDuration: rtAvg,
            errorCount: 0,
            successRate: 100,
          },
        },
      },
      progression: {
        cycles_completed: cyclesCompleted,
        successful_cycles: progressionState.successfulCycles || 0,
        failed_cycles: progressionState.failedCycles || 0,
      },
    })
  } catch (error) {
    console.error(`[v0] [ConnectionStatus] Error fetching status for ${connectionId}:`, error)
    return NextResponse.json(
      {
        success: false,
        connectionId,
        status: "error",
        isRunning: false,
        health: {
          overall: "unhealthy",
          components: {
            indications: { status: "unhealthy", lastCycleDuration: 0, errorCount: 1, successRate: 0 },
            strategies: { status: "unhealthy", lastCycleDuration: 0, errorCount: 1, successRate: 0 },
            realtime: { status: "unhealthy", lastCycleDuration: 0, errorCount: 1, successRate: 0 },
          },
        },
        metrics: {
          indicationCycleCount: 0,
          strategyCycleCount: 0,
          realtimeCycleCount: 0,
          indicationAvgDuration: 0,
          strategyAvgDuration: 0,
          realtimeAvgDuration: 0,
        },
        error: error instanceof Error ? error.message : "Failed to fetch connection status",
      },
      { status: 500 },
    )
  }
}
