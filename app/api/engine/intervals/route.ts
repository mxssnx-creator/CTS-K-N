import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getSettings } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    
    await initRedis()
    
    // Canonical sources (see audit plan item 5):
    //   • last_*_run        → trade_engine_state:{id}  (heartbeat)
    //   • *_cycle_count     → progression:{id}         (atomic hincrby)
    //
    // Reading cycle counts from `trade_engine_state` alone lagged the
    // authoritative counters and made this surface look stuck after a
    // watchdog re-arm. We now resolve cycle counters from the
    // `progression:` hash first and fall back to the engine-state
    // snapshot for legacy data.
    const [engState, progression] = await Promise.all([
      getSettings(`trade_engine_state:${id}`),
      getSettings(`progression:${id}`),
    ])

    // Extract interval/timing metrics from engine state
    const lastIndicationRun = (engState as any)?.last_indication_run || 0
    const lastStrategyRun = (engState as any)?.last_strategy_run || 0
    const now = Date.now()
    
    // Determine if intervals are "running" (ran within last 30 seconds)
    const indicationRunning = (now - lastIndicationRun) < 30000
    const strategyRunning = (now - lastStrategyRun) < 30000

    const indicationCycleCount =
      Number((progression as any)?.indication_cycle_count) ||
      Number((engState as any)?.indication_cycle_count) || 0
    const strategyCycleCount =
      Number((progression as any)?.strategy_cycle_count) ||
      Number((engState as any)?.strategy_cycle_count) || 0

    return NextResponse.json({
      connectionId: id,
      intervals: {
        indication: {
          running: indicationRunning,
          lastRun: lastIndicationRun,
          cycleCount: indicationCycleCount,
        },
        strategy: {
          running: strategyRunning,
          lastRun: lastStrategyRun,
          cycleCount: strategyCycleCount,
        },
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] [MonitoringIntervals] Error:", error)
    return NextResponse.json(
      { error: "Failed to fetch intervals status" },
      { status: 500 }
    )
  }
}
