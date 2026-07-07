import { NextResponse } from "next/server"
import { getSettings } from "@/lib/redis-db"

/**
 * Comprehensive engine progression status
 * Shows phase, cycles, and all relevant metrics
 */
export const dynamic = "force-dynamic"
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const connectionId = searchParams.get("connection_id")

    if (!connectionId) {
      return NextResponse.json({ error: "connection_id required" }, { status: 400 })
    }

    // Fetch all relevant state from Redis
    const engState = await getSettings(`trade_engine_state:${connectionId}`)
    const progression = await getSettings(`engine_progression:${connectionId}`)
    const progState = await getSettings(`progression_state:${connectionId}`)
    const conn = await getSettings(`connection:${connectionId}`)

    console.log(`[v0] [ProgressionDebug] ${connectionId}:`)
    console.log(`  - engState:`, engState)
    console.log(`  - progression:`, progression)
    console.log(`  - progState:`, progState)
    console.log(`  - conn.is_live_trade:`, (conn as any)?.is_live_trade)

    return NextResponse.json({
      success: true,
      connectionId,
      engine_state: {
        status: (engState as any)?.status,
        indication_cycle_count: (engState as any)?.indication_cycle_count,
        strategy_cycle_count: (engState as any)?.strategy_cycle_count,
        started_at: (engState as any)?.started_at,
        last_indication_run: (engState as any)?.last_indication_run,
        last_strategy_run: (engState as any)?.last_strategy_run,
      },
      progression: {
        phase: (progression as any)?.phase,
        progress: (progression as any)?.progress,
        detail: (progression as any)?.detail,
      },
      progression_state: {
        cycles_completed: (progState as any)?.cyclesCompleted,
        symbols_count: (progState as any)?.symbolsCount,
      },
      connection: {
        is_live_trade: (conn as any)?.is_live_trade,
        is_active: (conn as any)?.is_active,
        is_active_inserted: (conn as any)?.is_active_inserted,
      },
      debug: {
        eng_state_raw: engState,
        progression_raw: progression,
        prog_state_raw: progState,
      },
    })
  } catch (error) {
    console.error("[v0] [ProgressionDebug] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
