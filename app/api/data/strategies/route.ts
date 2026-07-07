import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { StrategyEngine } from "@/lib/strategies"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/data/strategies?connectionId=<id>
 *
 * Serves strategy pipeline data from the canonical progression + strategy_detail
 * Redis hashes. The old `getActiveStrategies` helper read from `strategies:{id}`
 * SET keys that the current engine never writes — it always returned [] for real
 * connections, causing a "Failed to load strategies" toast on every page load.
 *
 * Now reads directly from the authoritative keys the engine writes:
 *   progression:{id}                — cumulative stage counters
 *   strategy_detail:{id}:base|main|real  — per-symbol breakdown
 */
export async function GET(request: NextRequest) {
  try {
    const connectionId = request.nextUrl.searchParams.get("connectionId")
    if (!connectionId) {
      return NextResponse.json(
        { success: false, error: "connectionId query parameter required" },
        { status: 400 },
      )
    }

    // Demo mode: return synthetic strategy objects shaped the same way the
    // strategies page expects (StrategyResult from lib/strategies.ts).
    const isDemo = connectionId === "demo-mode" || connectionId.startsWith("demo")
    if (isDemo) {
      const strategyEngine = new StrategyEngine()
      const mockPseudoPositions = Array.from({ length: 150 }, (_, i) => ({
        id: `pseudo-${connectionId}-${i}`,
        connection_id: connectionId,
        symbol: ["BTCUSDT", "ETHUSDT", "SOLUSDT"][i % 3],
        indication_type: "direction" as const,
        takeprofit_factor: 8 + Math.random() * 10,
        stoploss_ratio: 0.5 + Math.random() * 1.5,
        trailing_enabled: Math.random() > 0.5,
        trail_start: 0.3 + Math.random() * 0.7,
        trail_stop: 0.1 + Math.random() * 0.2,
        entry_price: 45000 + Math.random() * 5000,
        current_price: 45000 + Math.random() * 5000,
        profit_factor: Math.random() * 2,
        position_cost: 0.001,
        status: "open" as const,
        created_at: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }))
      const strategies = strategyEngine.generateAllStrategies(mockPseudoPositions, 1.0, false, 50)
      return NextResponse.json({ success: true, data: strategies, isDemo: true, connectionId, count: strategies.length })
    }

    // Real connections: read from canonical engine hashes.
    await initRedis()
    const client = getRedisClient()
    if (!client) {
      return NextResponse.json({ success: false, error: "Redis not available" }, { status: 503 })
    }

    const [progHash, detailBase, detailMain, detailReal] = await Promise.all([
      client.hgetall(`progression:${connectionId}`).catch(() => null),
      client.hgetall(`strategy_detail:${connectionId}:base`).catch(() => null),
      client.hgetall(`strategy_detail:${connectionId}:main`).catch(() => null),
      client.hgetall(`strategy_detail:${connectionId}:real`).catch(() => null),
    ])

    const prog = (progHash ?? {}) as Record<string, string>
    const n = (v: string | undefined) => Number(v ?? 0) || 0

    // Build a strategy summary array — one entry per symbol extracted from
    // strategy_detail:* hashes. Fields are `s:{symbol}:{metric}`.
    const symbols = new Set<string>()
    for (const hash of [detailBase, detailMain, detailReal]) {
      if (!hash) continue
      for (const key of Object.keys(hash)) {
        // field format: s:{symbol}:created  →  extract symbol
        const m = key.match(/^s:([^:]+):/)
        if (m) symbols.add(m[1])
      }
    }

    type DetailHash = Record<string, string> | null
    const getField = (hash: DetailHash, sym: string, field: string) =>
      Number(hash?.[`s:${sym}:${field}`] ?? 0) || 0

    const strategies = Array.from(symbols).map((sym) => {
      const avgPF =
        getField(detailReal, sym, "apf") ||
        getField(detailMain, sym, "apf") ||
        getField(detailBase, sym, "apf")

      const baseCreated = getField(detailBase, sym, "created")
      const mainCreated = getField(detailMain, sym, "created")
      const realCreated = getField(detailReal, sym, "created")
      const mainAvgDDT = getField(detailMain, sym, "addt")

      // Shape each record as a StrategyResult so strategy-row-compact renders without crashes
      return {
        id: `${connectionId}-${sym}`,
        name: sym,
        connectionId,
        mainType: "direction" as const,
        adjustments: [] as string[],
        isActive: true,
        validation_state: "valid" as const,
        last_positions: [],
        should_open_position: avgPF >= 1.0,
        // Profit factor: prefer Real, then Main, then Base
        avg_profit_factor: avgPF,
        volume_factor: 1,
        config: {
          takeprofit_factor: 8,
          stoploss_ratio: 1,
          last_positions_count: 20,
          min_profit_factor: 1.0,
          trailing_stop: { enabled: false, start_percent: 0.3, stop_percent: 0.1 },
        },
        stats: {
          last_8_avg: avgPF,
          last_20_avg: avgPF,
          last_50_avg: avgPF,
          positions_per_day: mainCreated > 0 ? mainCreated / Math.max(1, 1) : 0,
          drawdown_hours: mainAvgDDT / 60,
          total_trades: realCreated,
          win_rate: avgPF > 1 ? Math.min(100, (avgPF - 1) * 50 + 50) : 30,
        },
        // Extended engine fields for the progression breakdown
        base: {
          created: baseCreated,
          passed: getField(detailBase, sym, "passed"),
          evaluated: getField(detailBase, sym, "evaluated"),
          avgPF: getField(detailBase, sym, "apf"),
          avgDDT: getField(detailBase, sym, "addt"),
        },
        main: {
          created: mainCreated,
          passed: getField(detailMain, sym, "passed"),
          evaluated: getField(detailMain, sym, "evaluated"),
          avgPF: getField(detailMain, sym, "apf"),
          avgDDT: mainAvgDDT,
        },
        real: {
          created: realCreated,
          passed: getField(detailReal, sym, "passed"),
          evaluated: getField(detailReal, sym, "evaluated"),
          avgPF: getField(detailReal, sym, "apf"),
          avgDDT: getField(detailReal, sym, "addt"),
        },
        totals: {
          base: n(prog.strategies_base_total),
          main: n(prog.strategies_main_total),
          real: n(prog.strategies_real_total),
          baseEvaluated: n(prog.strategies_base_evaluated),
          mainEvaluated: n(prog.strategies_main_evaluated),
          realEvaluated: n(prog.strategies_real_evaluated),
        },
      }
    })

    return NextResponse.json({
      success: true,
      data: strategies,
      isDemo: false,
      connectionId,
      count: strategies.length,
    })
  } catch (error) {
    console.error("[v0] GET /api/data/strategies error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
