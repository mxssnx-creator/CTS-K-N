import { NextResponse } from "next/server"
import { getSettings, initRedis, getRedisClient, getAllConnections } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"

export const dynamic = "force-dynamic"

/**
 * Comprehensive Engine System Verification
 * Returns detailed status of: prehistoric data, indications, strategies, realtime, live trading.
 * All data is sourced from Redis — no SQL DB required.
 */
export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    const coordinator = getGlobalTradeEngineCoordinator()
    const connections = await getAllConnections()
    // Include all connections; filter to enabled ones for display (exclude ones with is_active===false)
    const enabledConnections = connections.filter((c) => c.is_active !== false)

    const systemStatus = {
      timestamp: new Date().toISOString(),
      coordinatorRunning: coordinator.isRunning(),
      activeConnectionCount: enabledConnections.filter((c) => c.is_active === true).length,
      components: [] as any[],
      verification: {
        allPhasesPassing: true,
        issues: [] as string[],
        warnings: [] as string[],
      },
    }

    for (const conn of enabledConnections) {
      const isActive = conn.is_active === true

      const engineStatus = await coordinator.getEngineStatus(conn.id)
      const engineState = (await getSettings(`trade_engine_state:${conn.id}`)) || {}
      const progressionHash = client ? await client.hgetall(`progression:${conn.id}`) : {}
      const progState = progressionHash || {}

      // Prehistoric progress from the engine_progression hash (written by engine-manager)
      const engineProgState = (await getSettings(`engine_progression:${conn.id}`)) || {}

      // Live trades count from Redis sorted set / list
      const liveTradesCount = client
        ? await client.llen(`live:positions:${conn.id}:closed`).catch(() => 0)
        : 0

      // Pseudo positions from Redis
      const pseudoCount = client
        ? await client.llen(`pseudo:positions:${conn.id}`).catch(() => 0)
        : 0

      // Indication cycle count from engine_progression or progression hash
      const indicationCycleCount =
        Number(engineProgState?.indication_live_cycle_count) ||
        Number(progState?.indication_live_cycle_count) ||
        Number(engineProgState?.indication_cycle_count) ||
        Number(progState?.indication_cycle_count) ||
        0

      // Strategy cycle count
      const strategyCycleCount =
        Number(engineProgState?.strategy_cycle_count) ||
        Number(progState?.strategy_cycle_count) ||
        0

      // Realtime cycle count
      const realtimeCycleCount =
        Number(engineProgState?.realtime_cycle_count) ||
        Number(progState?.realtime_cycle_count) ||
        0

      // Prehistoric completion
      const prehistoricComplete =
        engineProgState?.prehistoric_complete === "true" ||
        engineProgState?.prehistoric_complete === "1" ||
        engineProgState?.is_prehistoric_complete === "true" ||
        engineProgState?.is_prehistoric_complete === "1" ||
        progState?.prehistoric_complete === "true" ||
        progState?.prehistoric_complete === "1"

      const status = {
        connectionId: conn.id,
        connectionName: conn.name,
        exchange: conn.exchange,
        engineRunning: engineStatus !== null,
        isActive,
        isTestnet: conn.is_testnet === true,
        phases: {
          prehistoric: {
            completed: prehistoricComplete,
            progressionCycles: Number(progState?.prehistoric_cycle_count) || 0,
            startDate: engineProgState?.start_date,
            endDate: engineProgState?.end_date,
          },
          indications: {
            processing: engineStatus !== null,
            cycleCount: indicationCycleCount,
            avgDurationMs: Number(engineProgState?.indication_avg_duration_ms) || 0,
            successRate: progState?.cycle_success_rate || "0%",
            recentRecords: indicationCycleCount,
            lastRun: engineProgState?.last_indication_run,
          },
          strategies: {
            processing: engineStatus !== null,
            cycleCount: strategyCycleCount,
            avgDurationMs: Number(engineProgState?.strategy_avg_duration_ms) || 0,
            totalEvaluated:
              Number(engineProgState?.strategies_main_evaluated) ||
              Number(progState?.strategies_main_evaluated) ||
              0,
            recentRecords: strategyCycleCount,
            lastRun: engineProgState?.last_strategy_run,
          },
          realtime: {
            processing: engineStatus !== null,
            cycleCount: realtimeCycleCount,
            avgDurationMs: Number(engineProgState?.realtime_avg_duration_ms) || 0,
            lastRun: engineProgState?.last_realtime_run,
          },
          liveTrading: {
            active: engineStatus !== null && liveTradesCount > 0,
            tradesTotal: liveTradesCount,
            pseudoPositions: pseudoCount,
            status: engineProgState?.phase || progState?.phase || "idle",
          },
        },
        metrics: {
          successRate: progState?.cycle_success_rate || "0%",
          totalCycles: Number(progState?.cycles_completed) || 0,
          successfulCycles: Number(progState?.successful_cycles) || 0,
          failedCycles: Number(progState?.failed_cycles) || 0,
        },
      }

      // Only report issues for active connections that are supposed to be running
      if (isActive) {
        if (!engineStatus) {
          systemStatus.verification.issues.push(`${conn.name}: Engine not running`)
          systemStatus.verification.allPhasesPassing = false
        }
        if (!prehistoricComplete) {
          systemStatus.verification.warnings.push(`${conn.name}: Prehistoric data not yet complete`)
        }
        if (indicationCycleCount === 0) {
          systemStatus.verification.issues.push(`${conn.name}: No indication cycles detected`)
          systemStatus.verification.allPhasesPassing = false
        }
      }

      systemStatus.components.push(status)
    }

    // Sort: active connections first so the UI panel picks the right one
    systemStatus.components.sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0))

    if (!coordinator.isRunning()) {
      systemStatus.verification.warnings.push("Global coordinator not running")
    }

    if (enabledConnections.filter((c) => c.is_active).length === 0) {
      systemStatus.verification.warnings.push("No active connections configured")
    }

    return NextResponse.json(systemStatus)
  } catch (error) {
    console.error("[SystemVerify] Verification failed:", error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Verification failed",
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  }
}
