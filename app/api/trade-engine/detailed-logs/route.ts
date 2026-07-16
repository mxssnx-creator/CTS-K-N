import { NextResponse } from "next/server"
import { initRedis, getAllConnections, getConnectionPositions, getConnectionTrades, getRedisClient, getSettings } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { getProgressionLogs } from "@/lib/engine-progression-logs"

function mapPhaseToType(phase: string) {
  // Order matters — "live_trading" must be classified before "position" so
  // that the new Live filter in the UI captures exchange-side events only.
  if (phase.includes("live")) return "live"
  if (phase.includes("indication")) return "indication"
  if (phase.includes("strategy")) return "strategy"
  if (phase.includes("position")) return "position"
  if (phase.includes("error")) return "error"
  return "engine"
  }

function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

const INDICATION_TYPES = ["direction", "move", "active", "optimal", "auto", "trend"] as const

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function enforceHierarchy(base: number, main: number, real: number) {
  const normalizedMain = Math.max(0, Math.round(main))
  const normalizedBase = Math.max(Math.round(base), normalizedMain * 2)
  const normalizedReal = Math.min(Math.round(real), Math.floor(normalizedMain * 0.6))
  return {
    base: normalizedBase,
    main: normalizedMain,
    real: Math.max(0, normalizedReal),
  }
}


async function getRecentLiveOrderAudits(client: ReturnType<typeof getRedisClient>, connectionIds: string[], limit = 75) {
  const rows: any[] = []
  for (const connectionId of connectionIds) {
    try {
      const traceIds = await client.zrevrange(`live_order_audit:${connectionId}:recent`, 0, limit - 1).catch(() => [])
      const fallbackKeys = traceIds.length > 0
        ? []
        : await client.keys(`live_order_audit:${connectionId}:*`).catch(() => [])

      if (traceIds.length > 0) {
        for (const traceId of traceIds) {
          const raw = await client.get(`live_order_audit:${connectionId}:${traceId}`).catch(() => null)
          if (!raw) continue
          try { rows.push(typeof raw === "string" ? JSON.parse(raw) : raw) } catch { /* ignore malformed audit */ }
        }
      } else {
        for (const key of fallbackKeys) {
          if (key.endsWith(":recent")) continue
          const raw = await client.get(key).catch(() => null)
          if (!raw) continue
          try { rows.push(typeof raw === "string" ? JSON.parse(raw) : raw) } catch { /* ignore malformed audit */ }
        }
      }
    } catch {
      // best-effort diagnostics only
    }
  }

  return rows
    .filter((row) => row && row.traceId && row.connectionId)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())
    .slice(0, limit)
}

async function countArrayEntries(client: ReturnType<typeof getRedisClient>, key: string): Promise<number> {
  try {
    const raw = await client.get(key)
    if (!raw) return 0
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

async function countIndicationsByType(client: ReturnType<typeof getRedisClient>, connectionId: string) {
  const counters = await Promise.all(
    INDICATION_TYPES.map(async (type) => ({
      type,
      count: toNumber(await client.get(`indications:${connectionId}:${type}:count`).catch(() => 0)),
    })),
  )

  const result = counters.reduce(
    (acc, item) => {
      acc[item.type] = item.count
      acc.total += item.count
      return acc
    },
    { direction: 0, move: 0, active: 0, optimal: 0, auto: 0, trend: 0, total: 0 } as Record<string, number>,
  )

  if (result.total > 0) {
    return result
  }

  // Fallback for older/newer set keys where counters are unavailable.
  for (const type of INDICATION_TYPES) {
    const keys = await client.keys(`indication_set:${connectionId}:*:${type}*`).catch(() => [])
    let sum = 0
    for (const key of keys) {
      sum += await countArrayEntries(client, key)
    }
    result[type] = sum
    result.total += sum
  }

  return result
}

async function countStrategiesByType(client: ReturnType<typeof getRedisClient>, connectionId: string, symbols: string[]) {
  // PRIMARY: read from per-stage counter keys written by statistics-tracker (most current)
  const [baseFromCounter, mainFromCounter, realFromCounter] = await Promise.all([
    client.get(`strategies:${connectionId}:base:count`).then(v => toNumber(v)).catch(() => 0),
    client.get(`strategies:${connectionId}:main:count`).then(v => toNumber(v)).catch(() => 0),
    client.get(`strategies:${connectionId}:real:count`).then(v => toNumber(v)).catch(() => 0),
  ])

  if (baseFromCounter > 0 || mainFromCounter > 0 || realFromCounter > 0) {
    return { base: baseFromCounter, main: mainFromCounter, real: realFromCounter }
  }

  // SECONDARY: read from progression hash written by StrategyCoordinator (hincrby every cycle)
  try {
    const progHash = await client.hgetall(`progression:${connectionId}`) || {}
    const baseFromHash = parseInt(progHash.strategies_base_total || "0", 10)
    const mainFromHash = parseInt(progHash.strategies_main_total || "0", 10)
    const realFromHash = parseInt(progHash.strategies_real_total || "0", 10)
    if (baseFromHash > 0 || mainFromHash > 0 || realFromHash > 0) {
      return { base: baseFromHash, main: mainFromHash, real: realFromHash }
    }
  } catch { /* non-critical */ }

  // TERTIARY: fall back to settings hash keys written by setSettings in StrategyCoordinator
  // Key pattern: settings:strategies:{connId}:{symbol}:{stage}:sets (hash with .count field)
  const uniqueSymbols = Array.from(new Set(symbols.filter(Boolean)))
  if (uniqueSymbols.length === 0) {
    uniqueSymbols.push("BTCUSDT", "ETHUSDT", "SOLUSDT")
  }

  const totals = { base: 0, main: 0, real: 0 }

  for (const symbol of uniqueSymbols) {
    for (const stage of ["base", "main", "real"] as const) {
      try {
        const settingsHash = await client.hgetall(`settings:strategies:${connectionId}:${symbol}:${stage}:sets`)
        if (settingsHash && settingsHash.count) {
          totals[stage] += parseInt(settingsHash.count, 10) || 0
        }
      } catch { /* non-critical */ }
    }
  }

  return totals
}

async function getStrategyEvaluationCounters(client: ReturnType<typeof getRedisClient>, connectionId: string) {
  const [baseEvaluated, mainEvaluated, realEvaluated, basePassed, mainPassed, realPassed] = await Promise.all([
    client.get(`strategies:${connectionId}:base:evaluated`).catch(() => 0),
    client.get(`strategies:${connectionId}:main:evaluated`).catch(() => 0),
    client.get(`strategies:${connectionId}:real:evaluated`).catch(() => 0),
    client.get(`strategies:${connectionId}:base:passed`).catch(() => 0),
    client.get(`strategies:${connectionId}:main:passed`).catch(() => 0),
    client.get(`strategies:${connectionId}:real:passed`).catch(() => 0),
  ])

  return {
    base: toNumber(baseEvaluated),
    main: toNumber(mainEvaluated),
    real: toNumber(realEvaluated),
    passed: {
      base: toNumber(basePassed),
      main: toNumber(mainPassed),
      real: toNumber(realPassed),
    },
  }
}

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    await initRedis()
    const { searchParams } = new URL(request.url)
    const selectedConnectionId = searchParams.get("connectionId")
    const selectedExchange = (searchParams.get("exchange") || "").toLowerCase()

    const allConnections = await getAllConnections()
    let activeConnections = allConnections.filter((c: any) => {
      const exch = (c.exchange || "").toLowerCase()
      const isBase = ["bingx", "bybit", "pionex", "orangex"].includes(exch)
      return isBase || isTruthy(c.is_dashboard_inserted) || isTruthy(c.is_active_inserted) || isTruthy(c.is_enabled_dashboard)
    })

    if (selectedConnectionId) {
      activeConnections = activeConnections.filter((c: any) => c.id === selectedConnectionId)
    } else if (selectedExchange) {
      activeConnections = activeConnections.filter((c: any) => (c.exchange || "").toLowerCase() === selectedExchange)
    }

    const progressionStates = await Promise.all(activeConnections.map((c: any) => ProgressionStateManager.getProgressionState(c.id)))

    const logsByConnection = await Promise.all(
      activeConnections.map((c: any) => getProgressionLogs(c.id))
    )

    const globalLogs = await getProgressionLogs("global")

    const positionsByConnection = await Promise.all(
      activeConnections.map((c: any) => getConnectionPositions(c.id))
    )

    const tradesByConnection = await Promise.all(
      activeConnections.map((c: any) => getConnectionTrades(c.id))
    )

    const combinedLogsRaw = [...logsByConnection.flat(), ...globalLogs]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 300)

    const logs = combinedLogsRaw.map((log, index) => ({
      id: `${log.connectionId}-${index}-${log.timestamp}`,
      timestamp: log.timestamp,
      type: mapPhaseToType(log.phase),
      symbol: log.details?.symbol,
      phase: log.phase,
      message: log.message,
      connectionId: log.connectionId,
      details: {
        timeframe: log.details?.timeframe,
        timeRange: log.details?.timeRange,
        calculatedIndicators: log.details?.calculatedIndicators,
        evaluatedStrategies: log.details?.evaluatedStrategies,
        pseudoPositions: log.details?.pseudoPositions,
        configs: log.details?.configs,
        evals: log.details?.evals,
        ratios: log.details?.ratios,
        cycleDuration: log.details?.cycleDuration,
      },
    }))

    const client = getRedisClient()
    const auditRows = await getRecentLiveOrderAudits(client, activeConnections.map((c: any) => c.id))
    const auditLogs = auditRows.map((audit: any) => ({
      id: `audit-${audit.connectionId}-${audit.traceId}`,
      timestamp: audit.updatedAt || audit.createdAt || new Date().toISOString(),
      type: "live",
      symbol: audit.symbol,
      phase: "live_order_audit",
      message: `Live order audit ${audit.symbol} ${audit.direction} ${audit.entryOrderStatus || "pending"} protection=${audit.protectionState}`,
      connectionId: audit.connectionId,
      details: audit,
    }))

    const perConnection = await Promise.all(
      activeConnections.map(async (conn: any, index: number) => {
        const state = (await getSettings(`trade_engine_state:${conn.id}`)) || {}
        const progression = progressionStates[index] || {}

        // Read the live progression hash — written every indication cycle.
        // This is more current than trade_engine_state (persisted every 50-100 cycles).
        let progHash: Record<string, string> = {}
        try {
          progHash = (await client.hgetall(`progression:${conn.id}`)) || {}
        } catch { /* non-critical */ }

        const symbols = Array.isArray((state as any).symbols)
          ? (state as any).symbols
          : Array.isArray((state as any).active_symbols)
            ? (state as any).active_symbols
            : []

        const [indicationsByType, strategyCounts, strategyEvaluations, basePseudoCount, mainPseudoCount, realPseudoCount, baseDirection, baseMove, baseActive, baseOptimal, baseTrend, livePositionsCount, prehistoricSymbols, prehistoricDataKeys] =
          await Promise.all([
            countIndicationsByType(client, conn.id),
            countStrategiesByType(client, conn.id, symbols),
            getStrategyEvaluationCounters(client, conn.id),
            client.scard(`base_pseudo:${conn.id}`).catch(() => 0),
            client.scard(`main_pseudo:${conn.id}`).catch(() => 0),
            client.scard(`real_pseudo:${conn.id}`).catch(() => 0), // active/open validated Real stage only (reconciled)
            client.scard(`base_pseudo:${conn.id}:direction`).catch(() => 0),
            client.scard(`base_pseudo:${conn.id}:move`).catch(() => 0),
            client.scard(`base_pseudo:${conn.id}:active`).catch(() => 0),
            client.scard(`base_pseudo:${conn.id}:optimal`).catch(() => 0),
            client.scard(`base_pseudo:${conn.id}:trend`).catch(() => 0),
            client.scard(`positions:${conn.id}:live`).catch(() => 0),
            client.scard(`prehistoric:${conn.id}:symbols`).catch(() => 0),
            client.keys(`prehistoric:${conn.id}:*`).then((keys) => keys.length).catch(() => 0),
          ])

        const processedIntervals = toNumber(
          await client.get(`intervals:${conn.id}:processed_count`).catch(() => 0),
        )

        return {
          id: conn.id,
          symbols,
          // Prefer live progression hash (updated every cycle) over engineState (every 50-100 cycles)
          indicationCycles:
            parseInt(progHash.indication_cycle_count || "0", 10) ||
            toNumber((state as any).indication_cycle_count) ||
            toNumber((progression as any).cyclesCompleted),
          strategyCycles:
            parseInt(progHash.strategy_cycle_count || "0", 10) ||
            toNumber((state as any).strategy_cycle_count) ||
            toNumber((progression as any).successfulCycles),
          realtimeCycles:
            parseInt(progHash.realtime_cycle_count || "0", 10) ||
            toNumber((state as any).realtime_cycle_count),
          strategiesEvaluated: toNumber((state as any).total_strategies_evaluated),
          durations: {
            indication: toNumber((state as any).indication_avg_duration_ms),
            strategy: toNumber((state as any).strategy_avg_duration_ms),
            realtime: toNumber((state as any).realtime_avg_duration_ms),
          },
          indicationsByType,
          strategyCounts,
          strategyEvaluations,
          pseudoCounts: {
            base: basePseudoCount,
            main: mainPseudoCount,
            real: realPseudoCount,
          },
          basePseudoByIndication: {
            direction: baseDirection,
            move: baseMove,
            active: baseActive,
            optimal: baseOptimal,
            trend: baseTrend,
          },
          livePositions: livePositionsCount,
          // Live exchange execution metrics sourced from the progression hash
          // (written by live-stage.ts). Counters only — no exchange history
          // calls. Keeps the endpoint fast even with heavy live activity.
          liveMetrics: {
            ordersPlaced:     parseInt(progHash.live_orders_placed_count    || "0", 10) || 0,
            ordersFilled:     parseInt(progHash.live_orders_filled_count    || "0", 10) || 0,
            ordersFailed:     parseInt(progHash.live_orders_failed_count    || "0", 10) || 0,
            ordersRejected:   parseInt(progHash.live_orders_rejected_count  || "0", 10) || 0,
            ordersSimulated:  parseInt(progHash.live_orders_simulated_count || "0", 10) || 0,
            positionsCreated: parseInt(progHash.live_positions_created_count || "0", 10) || 0,
            positionsClosed:  parseInt(progHash.live_positions_closed_count  || "0", 10) || 0,
            wins:             parseInt(progHash.live_wins_count             || "0", 10) || 0,
            volumeUsdTotal:   parseFloat(progHash.live_volume_usd_total     || "0") || 0,
          },
          prehistoric: {
            loaded: isTruthy((state as any).prehistoric_data_loaded),
            symbols: prehistoricSymbols || toNumber((state as any).config_set_symbols_processed),
            dataKeys: prehistoricDataKeys,
            indicationResults: toNumber((state as any).config_set_indication_results),
            strategyPositions: toNumber((state as any).config_set_strategy_positions),
            candlesProcessed: toNumber((state as any).config_set_candles_processed),
            symbolsProcessed: toNumber((state as any).config_set_symbols_processed),
            symbolsTotal: toNumber((state as any).config_set_symbols_total),
            symbolsWithoutData: toNumber((state as any).config_set_symbols_without_data),
            errors: toNumber((state as any).config_set_errors),
            durationMs: toNumber((state as any).config_set_duration_ms),
            lastProcessedAt: (state as any).prehistoric_last_processed_at || null,
          },
          intervalsProcessed: processedIntervals,
        }
      }),
    )

    const indicationCycles = perConnection.reduce((sum, item) => sum + item.indicationCycles, 0)
    const strategyCycles = perConnection.reduce((sum, item) => sum + item.strategyCycles, 0)
    const realtimeCycles = perConnection.reduce((sum, item) => sum + item.realtimeCycles, 0)
    const totalPositions = positionsByConnection.reduce((sum, arr) => sum + arr.length, 0)
    const totalTrades = tradesByConnection.reduce((sum, arr) => sum + arr.length, 0)

    const aggregatedIndications = perConnection.reduce(
      (acc, item) => {
        acc.direction += item.indicationsByType.direction || 0
        acc.move += item.indicationsByType.move || 0
        acc.active += item.indicationsByType.active || 0
        acc.optimal += item.indicationsByType.optimal || 0
        acc.auto += item.indicationsByType.auto || 0
        acc.trend += item.indicationsByType.trend || 0
        acc.total += item.indicationsByType.total || 0
        return acc
      },
      { direction: 0, move: 0, active: 0, optimal: 0, auto: 0, trend: 0, total: 0 },
    )

    const aggregatedStrategyCounts = perConnection.reduce(
      (acc, item) => {
        acc.base += item.strategyCounts.base
        acc.main += item.strategyCounts.main
        acc.real += item.strategyCounts.real
        return acc
      },
      { base: 0, main: 0, real: 0 },
    )
    const normalizedStrategyHierarchy = enforceHierarchy(
      aggregatedStrategyCounts.base,
      aggregatedStrategyCounts.main,
      aggregatedStrategyCounts.real,
    )

    const aggregatedStrategyEvaluations = perConnection.reduce(
      (acc, item) => {
        acc.base += item.strategyEvaluations.base
        acc.main += item.strategyEvaluations.main
        acc.real += item.strategyEvaluations.real
        acc.passed.base += item.strategyEvaluations.passed.base
        acc.passed.main += item.strategyEvaluations.passed.main
        acc.passed.real += item.strategyEvaluations.passed.real
        return acc
      },
      { base: 0, main: 0, real: 0, passed: { base: 0, main: 0, real: 0 } },
    )

    const aggregatedPseudo = perConnection.reduce(
      (acc, item) => {
        acc.base += item.pseudoCounts.base
        acc.main += item.pseudoCounts.main
        acc.real += item.pseudoCounts.real
        return acc
      },
      { base: 0, main: 0, real: 0 },
    )
    const normalizedPseudoHierarchy = enforceHierarchy(
      aggregatedPseudo.base || totalPositions,
      aggregatedPseudo.main || strategyCycles,
      aggregatedPseudo.real || totalTrades,
    )

    const aggregatedPrehistoric = perConnection.reduce(
      (acc, item) => {
        acc.symbols += item.prehistoric.symbols
        acc.dataKeys += item.prehistoric.dataKeys
        acc.indicationResults += item.prehistoric.indicationResults
        acc.strategyPositions += item.prehistoric.strategyPositions
        acc.candlesProcessed += item.prehistoric.candlesProcessed
        acc.symbolsProcessed += item.prehistoric.symbolsProcessed
        acc.symbolsTotal += item.prehistoric.symbolsTotal
        acc.symbolsWithoutData += item.prehistoric.symbolsWithoutData
        acc.errors += item.prehistoric.errors
        acc.durationMs += item.prehistoric.durationMs
        return acc
      },
      {
        symbols: 0,
        dataKeys: 0,
        indicationResults: 0,
        strategyPositions: 0,
        candlesProcessed: 0,
        symbolsProcessed: 0,
        symbolsTotal: 0,
        symbolsWithoutData: 0,
        errors: 0,
        durationMs: 0,
      },
    )

    const intervalsProcessed = perConnection.reduce((sum, item) => sum + item.intervalsProcessed, 0)
    const livePositions = perConnection.reduce((sum, item) => sum + item.livePositions, 0)
    const cycleDurationMs = perConnection.length
      ? Math.round(
          perConnection.reduce(
            (sum, item) => sum + Math.max(item.durations.indication, item.durations.strategy, item.durations.realtime),
            0,
          ) / perConnection.length,
        )
      : 0
    const avgCycleDuration = perConnection.length
      ? Math.round(
          perConnection.reduce(
            (sum, item) => sum + item.durations.indication + item.durations.strategy + item.durations.realtime,
            0,
          ) / Math.max(1, perConnection.length * 3),
        )
      : 0

    // Aggregate Live execution metrics across all connections (progression hash counters only).
    const aggregatedLive = perConnection.reduce(
      (acc, item) => {
        const lm = (item as any).liveMetrics || {}
        acc.ordersPlaced     += lm.ordersPlaced     || 0
        acc.ordersFilled     += lm.ordersFilled     || 0
        acc.ordersFailed     += lm.ordersFailed     || 0
        acc.ordersRejected   += lm.ordersRejected   || 0
        acc.ordersSimulated  += lm.ordersSimulated  || 0
        acc.positionsCreated += lm.positionsCreated || 0
        acc.positionsClosed  += lm.positionsClosed  || 0
        acc.wins             += lm.wins             || 0
        acc.volumeUsdTotal   += lm.volumeUsdTotal   || 0
        return acc
      },
      {
        ordersPlaced: 0, ordersFilled: 0, ordersFailed: 0, ordersRejected: 0, ordersSimulated: 0,
        positionsCreated: 0, positionsClosed: 0, wins: 0, volumeUsdTotal: 0,
      },
    )
    const liveFillRate = aggregatedLive.ordersPlaced > 0
      ? Math.round((aggregatedLive.ordersFilled / aggregatedLive.ordersPlaced) * 1000) / 10
      : 0
    const liveWinRate = aggregatedLive.positionsClosed > 0
      ? Math.round((aggregatedLive.wins / aggregatedLive.positionsClosed) * 1000) / 10
      : 0

    const basePseudoByIndication = perConnection.reduce(
      (acc, item) => {
        acc.direction += item.basePseudoByIndication.direction
        acc.move += item.basePseudoByIndication.move
        acc.active += item.basePseudoByIndication.active
        acc.optimal += item.basePseudoByIndication.optimal
        acc.trend += item.basePseudoByIndication.trend
        return acc
      },
      { direction: 0, move: 0, active: 0, optimal: 0, trend: 0 },
    )

    const summary = {
      symbolsActive: Math.max(1, activeConnections.length),
      indicationCycles,
      strategyCycles,
      totalIndicationsCalculated: aggregatedIndications.total || indicationCycles,
      totalStrategiesEvaluated:
        perConnection.reduce((sum, item) => sum + item.strategiesEvaluated, 0) ||
        aggregatedStrategyCounts.main ||
        strategyCycles,
      pseudoPositions: {
        base: normalizedPseudoHierarchy.base,
        main: normalizedPseudoHierarchy.main,
        real: normalizedPseudoHierarchy.real,
        // Cascade pipeline — NOT a sum. `total` is the final-stage (Real) count;
        // Base and Main are intermediate filter stages of the SAME pseudo-positions.
        total: normalizedPseudoHierarchy.real,
      },
      // Extended stats
      prehistoricSymbols: aggregatedPrehistoric.symbols,
      prehistoricDataSize: aggregatedPrehistoric.dataKeys,
      intervalsProcessed,
      indicationsByType: aggregatedIndications,
      strategyCountsByType: normalizedStrategyHierarchy,
      strategyCountsByTypeRaw: aggregatedStrategyCounts,
      strategyEvaluatedByType: {
        base: aggregatedStrategyEvaluations.base || aggregatedStrategyCounts.base,
        main: aggregatedStrategyEvaluations.main || aggregatedStrategyCounts.main,
        real: aggregatedStrategyEvaluations.real || aggregatedStrategyCounts.real,
      },
      strategyPassedByType: aggregatedStrategyEvaluations.passed,
      pseudoPositionsByType: {
        baseByIndication: basePseudoByIndication,
      },
      pseudoPositionsRaw: {
        base: aggregatedPseudo.base || totalPositions,
        main: aggregatedPseudo.main || strategyCycles,
        real: aggregatedPseudo.real || totalTrades,
      },
      livePositions,
      // Detailed Live execution metrics — orders, positions, fill & win rates
      liveExecution: {
        ...aggregatedLive,
        positionsOpen: Math.max(
          0,
          aggregatedLive.positionsCreated - aggregatedLive.positionsClosed +
          Math.max(0, aggregatedLive.ordersPlaced - aggregatedLive.ordersFilled)
        ),
        fillRate: liveFillRate,
        winRate: liveWinRate,
      },
      cycleDurationMs,
      realtimeCycles,
      realtimeRunningConnections: perConnection.filter((item) => item.realtimeCycles > 0).length,
      prehistoricProcessing: {
        symbolsProcessed: aggregatedPrehistoric.symbolsProcessed,
        symbolsTotal: aggregatedPrehistoric.symbolsTotal,
        symbolsWithoutData: aggregatedPrehistoric.symbolsWithoutData,
        candlesProcessed: aggregatedPrehistoric.candlesProcessed,
        indicationResults: aggregatedPrehistoric.indicationResults,
        strategyPositions: aggregatedPrehistoric.strategyPositions,
        errors: aggregatedPrehistoric.errors,
        durationMs: aggregatedPrehistoric.durationMs,
      },
      configsProcessed: perConnection.reduce((sum, item) => sum + item.prehistoric.indicationResults + item.prehistoric.strategyPositions, 0),
      // `evalsCompleted` = canonical strategies-evaluated count = Real-stage output.
      // Base and Main contain parent/derived pipeline populations; summing them
      // would mix upstream work with the final evaluated output.
      evalsCompleted: aggregatedStrategyCounts.real,
      avgCycleDuration,
      lastUpdate: new Date().toISOString(),
      errors: logs.filter((log: any) => log.type === "error").length,
      warnings: logs.filter((log: any) => String(log.message || "").toLowerCase().includes("warn")).length,
    }

    return NextResponse.json({
      success: true,
      logs: [...auditLogs, ...logs]
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 375),
      liveOrderAudits: auditRows,
      summary,
      timestamp: new Date().toISOString(),
      activeConnections: activeConnections.map((c: any) => ({
        id: c.id,
        name: c.name,
        exchange: c.exchange,
        dashboardEnabled: isTruthy(c.is_enabled_dashboard),
      })),
    })
  } catch (error) {
    console.error("[v0] Error fetching detailed logs:", error)
    return NextResponse.json({
      success: false,
      logs: [],
      summary: null,
      error: error instanceof Error ? error.message : "Unknown error",
    })
  }
}
