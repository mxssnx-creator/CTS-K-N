import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getAllConnections } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

function toNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    
    const allConnections = await getAllConnections()
    // Match the same filter used by engine-manager and exchange-context
    const toBoolean = (v: unknown) => v === true || v === 1 || v === "1" || v === "true"
    const activeConnections = allConnections.filter((c: any) => {
      const exch = (c.exchange || "").toLowerCase()
      const isBase = ["bingx", "bybit", "pionex", "orangex"].includes(exch)
      return isBase || toBoolean(c.is_active_inserted) || toBoolean(c.is_dashboard_inserted) || toBoolean(c.is_enabled_dashboard)
    })
    
    const summary: any = {
      enginePerformance: {
        cyclesCompleted: 0,
        cycleSuccessRate: 100,
        cycleTimeMs: 0,
      },
      prehistoricData: {
        symbolsProcessed: 0,
        candlesProcessed: 0,
        phaseActive: false,
        cyclesCompleted: 0,
      },
      indicationsCounts: {},
      strategyCounts: {},
      activeConnections: activeConnections.length,
    }

    for (const conn of activeConnections) {
      // PRIMARY: read live progression hash (written every cycle — most current)
      let progHash: Record<string, string> = {}
      try {
        progHash = (await client.hgetall(`progression:${conn.id}`)) || {}
      } catch { /* non-critical */ }

      const indicationCycles = parseInt(progHash.indication_cycle_count || "0", 10)
      const strategyCycles   = parseInt(progHash.strategy_cycle_count   || "0", 10)
      const successRate      = parseFloat(progHash.cycle_success_rate   || "100")
      const indTotal         = parseInt(progHash.indications_count      || "0", 10)

      if (indicationCycles > 0) {
        summary.enginePerformance.cyclesCompleted += indicationCycles
        summary.enginePerformance.cycleSuccessRate = successRate
      } else {
        // FALLBACK: read from trade_engine_state:{connId} (canonical key, persisted every 50-100 cycles)
        try {
          const esHash = (await client.hgetall(`trade_engine_state:${conn.id}`)) || {}
          summary.enginePerformance.cyclesCompleted += toNum(esHash.indication_cycle_count)
          summary.enginePerformance.cycleTimeMs = Math.max(
            summary.enginePerformance.cycleTimeMs,
            toNum(esHash.last_cycle_duration)
          )
        } catch { /* non-critical */ }
      }

      // Prehistoric data — primary: prehistoric:{connId} hash written by trackPrehistoricStats
      try {
        const prehistoricHash = (await client.hgetall(`prehistoric:${conn.id}`)) || {}
        const symProcessed = toNum(prehistoricHash.symbols_processed) ||
          await client.scard(`prehistoric:${conn.id}:symbols`).catch(() => 0)
        const candlesLoaded = toNum(prehistoricHash.candles_loaded)
        summary.prehistoricData.symbolsProcessed += symProcessed
        summary.prehistoricData.candlesProcessed += candlesLoaded
        if (prehistoricHash.is_complete !== "1") {
          summary.prehistoricData.phaseActive = true
        }
      } catch { /* non-critical */ }

      // Per-type indication counts — prefer progression hash fields
      const indicationTypes = ["direction", "move", "active", "optimal", "auto"] as const
      for (const type of indicationTypes) {
        const fromHash = parseInt(progHash[`indications_${type}_count`] || "0", 10)
        const fromKey  = fromHash > 0 ? fromHash :
          toNum(await client.get(`indications:${conn.id}:${type}:count`).catch(() => 0))
        if (fromKey > 0) {
          summary.indicationsCounts[type] = (summary.indicationsCounts[type] || 0) + fromKey
        }
      }

      // Strategy counts — prefer progression hash fields (strategies_{stage}_total)
      const strategyTypes = ["base", "main", "real"] as const
      for (const type of strategyTypes) {
        const fromHash = parseInt(progHash[`strategies_${type}_total`] || "0", 10)
        const fromKey  = fromHash > 0 ? fromHash :
          toNum(await client.get(`strategies:${conn.id}:${type}:count`).catch(() => 0))
        if (fromKey > 0) {
          summary.strategyCounts[type] = (summary.strategyCounts[type] || 0) + fromKey
        }
      }
    }

    return NextResponse.json({
      success: true,
      summary,
      connections: activeConnections.map((c: any) => ({
        id: c.id,
        name: c.name,
        exchange: c.exchange,
        isActive: toBoolean(c.is_enabled_dashboard) || toBoolean(c.is_active_inserted),
        isLiveTrade: toBoolean(c.is_live_trade),
      }))
    })

  } catch (error) {
    console.error("[Connections Test Log] Error:", error)
    return NextResponse.json({
      success: false,
      summary: {
        enginePerformance: { cyclesCompleted: 0, cycleSuccessRate: 0, cycleTimeMs: 0 },
        prehistoricData: { symbolsProcessed: 0, candlesProcessed: 0, phaseActive: false, cyclesCompleted: 0 },
        indicationsCounts: {},
        strategyCounts: {},
      }
    })
  }
}
