import { type NextRequest, NextResponse } from "next/server"
import { query, queryOne, getDatabaseType } from "@/lib/db"
import { getDashboardWorkflowSnapshot } from "@/lib/dashboard-workflow"
import { buildLogisticsQueuePayload } from "@/lib/logistics-workflow"
import { getActiveIndications, getActiveStrategies, getAllPositions } from "@/lib/db-helpers"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    // Scope metrics to a specific exchange connection when the sidebar page
    // has one selected. When omitted, we report globally (previous behavior).
    const connectionId = request.nextUrl.searchParams.get("connectionId")
    const isScoped = !!connectionId && connectionId !== "demo-mode" && !connectionId.startsWith("demo")

    const workflowSnapshot = await getDashboardWorkflowSnapshot().catch(() => null)
    const logistics = workflowSnapshot ? buildLogisticsQueuePayload(workflowSnapshot) : null
    const dbType = getDatabaseType()
    const isSQLite = dbType === "sqlite"

    // Per-connection metrics derived from Redis — works regardless of SQL shim.
    const perConnection = isScoped
      ? await (async () => {
          const [indications, strategies, positions] = await Promise.all([
            getActiveIndications(connectionId!).catch(() => []),
            getActiveStrategies(connectionId!).catch(() => []),
            getAllPositions(connectionId!).catch(() => []),
          ])
          const activePositions = (positions as any[]).filter(
            (p: any) => p?.status === "open",
          )
          const activeSymbols = new Set(activePositions.map((p: any) => p.symbol).filter(Boolean)).size
          return {
            active_connections: 1,
            total_indications: indications.length,
            active_indications: indications.length,
            total_strategies: strategies.length,
            active_strategies: strategies.length,
            total_positions: positions.length,
            active_positions: activePositions.length,
            active_symbols: activeSymbols,
            total_volume_24h: activePositions.reduce(
              (sum: number, p: any) => sum + (Number(p.entry_price) || 0) * (Number(p.quantity) || 0),
              0,
            ),
            trades_per_hour: 0,
          }
        })()
      : null

    const result =
      perConnection ||
      (await queryOne(`
      SELECT 
        COUNT(DISTINCT ec.id) as active_connections,
        COUNT(DISTINCT i.id) as total_indications,
        COUNT(DISTINCT i.id) as active_indications,
        COUNT(DISTINCT ps.id) as total_strategies,
        ${isSQLite ? "SUM(CASE WHEN ps.is_active = 1 THEN 1 ELSE 0 END)" : "COUNT(*) FILTER (WHERE ps.is_active = true)"} as active_strategies,
        COUNT(DISTINCT pp.id) as total_positions,
        0 as base_positions,
        0 as main_positions,
        0 as real_positions,
        ${isSQLite ? "SUM(CASE WHEN pp.status = 'open' THEN 1 ELSE 0 END)" : "COUNT(*) FILTER (WHERE pp.status = 'open')"} as active_positions,
        COUNT(DISTINCT pp.symbol) as active_symbols,
        COALESCE(SUM(pp.volume * pp.entry_price), 0) as total_volume_24h,
        ${isSQLite ? "SUM(CASE WHEN datetime(pp.opened_at) > datetime('now', '-1 hour') THEN 1 ELSE 0 END)" : "COUNT(*) FILTER (WHERE pp.opened_at > NOW() - INTERVAL '1 hour')"} as trades_per_hour
      FROM exchange_connections ec
      LEFT JOIN indications i ON i.connection_id = ec.id
      LEFT JOIN pseudo_positions pp ON pp.connection_id = ec.id AND pp.status = 'open'
      LEFT JOIN preset_strategies ps ON ps.connection_id = ec.id
      WHERE ec.${isSQLite ? "is_enabled = 1" : "is_enabled = true"}
    `))

    // Note: pseudo_positions table doesn't have a 'type' column in the current schema
    // Using indication_type as a proxy for categorization
    const profitFactorByTypeResult = await query(`
      SELECT 
        'main' as type,
        AVG(CASE WHEN ${isSQLite ? "datetime(closed_at) > datetime('now', '-20 hours')" : "closed_at > NOW() - INTERVAL '20 hours'"} THEN profit_loss_percent END) as pf_last_20h,
        AVG(profit_loss_percent) as pf_last_25
      FROM (
        SELECT profit_loss_percent, closed_at
        FROM pseudo_positions
        WHERE status = 'closed' AND closed_at IS NOT NULL
        ORDER BY closed_at DESC
        LIMIT 100
      ) as subquery
    `)

    const profitFactorResult = await queryOne(`
      SELECT 
        AVG(CASE WHEN ${isSQLite ? "datetime(closed_at) > datetime('now', '-20 hours')" : "closed_at > NOW() - INTERVAL '20 hours'"} THEN profit_loss_percent END) as pf_last_20h,
        AVG(profit_loss_percent) as pf_last_50
      FROM (
        SELECT profit_loss_percent, closed_at
        FROM pseudo_positions
        WHERE status = 'closed' AND closed_at IS NOT NULL
        ORDER BY closed_at DESC
        LIMIT 50
      ) as subquery
    `)

    const profitMetrics25 = await queryOne(`
      SELECT AVG(profit_loss_percent) as pf_last_25
      FROM (
        SELECT profit_loss_percent
        FROM pseudo_positions
        WHERE status = 'closed' AND closed_at IS NOT NULL
        ORDER BY closed_at DESC
        LIMIT 25
      ) as subquery
    `)

    const liveMetrics = await queryOne(`
      SELECT COUNT(*) as live_count
      FROM positions
      WHERE status = 'open'
    `)

    const metrics = result || {}
    const profitMetrics = profitFactorResult || {}
    const profitMetrics25Result = profitMetrics25 || {}
    const liveMetricsResult = liveMetrics || {}

    const pfByType = {
      base: { pf20h: 0, pf25: 0 },
      main: { pf20h: 0, pf25: 0 },
      real: { pf20h: 0, pf25: 0 },
      active: { pf20h: 0, pf25: 0 },
    }

    profitFactorByTypeResult.forEach((row: any) => {
      if (row.type === "base") {
        pfByType.base.pf20h = Number.parseFloat(row.pf_last_20h) || 0
        pfByType.base.pf25 = Number.parseFloat(row.pf_last_25) || 0
      } else if (row.type === "main") {
        pfByType.main.pf20h = Number.parseFloat(row.pf_last_20h) || 0
        pfByType.main.pf25 = Number.parseFloat(row.pf_last_25) || 0
      } else if (row.type === "real") {
        pfByType.real.pf20h = Number.parseFloat(row.pf_last_20h) || 0
        pfByType.real.pf25 = Number.parseFloat(row.pf_last_25) || 0
      } else if (row.type === "active") {
        pfByType.active.pf20h = Number.parseFloat(row.pf_last_20h) || 0
        pfByType.active.pf25 = Number.parseFloat(row.pf_last_25) || 0
      }
    })

    const memoryUsage = process.memoryUsage()
    const cpuUsage = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100

    return NextResponse.json({
      success: true,
      scope: isScoped ? "connection" : "global",
      connectionId: isScoped ? connectionId : null,
      data: {
        systemMetrics: {
          cpu_usage: Math.round(cpuUsage),
          memory_usage: Math.round((memoryUsage.heapUsed / Math.max(memoryUsage.heapTotal, 1)) * 100),
          database_size: 45,
          database_connections: Number.parseInt((metrics as any)?.active_connections) || 0,
          api_requests_per_minute: 0,
          websocket_connections: Number.parseInt((metrics as any)?.active_connections) || 0,
          uptime_hours: 0,
        },
        tradingLogistics: {
          active_connections: Number.parseInt((metrics as any)?.active_connections) || 0,
          total_strategies: Number.parseInt((metrics as any)?.total_strategies) || 0,
          active_strategies: Number.parseInt((metrics as any)?.active_strategies) || 0,
          open_positions: Number.parseInt((metrics as any)?.active_positions) || 0,
          total_volume_24h: Number.parseFloat((metrics as any)?.total_volume_24h) || 0,
          trades_per_hour: Number.parseInt((metrics as any)?.trades_per_hour) || 0,
          avg_response_time: logistics?.avgLatency || 0,
          workflow_health: logistics?.workflowHealth || "unknown",
          queue_backlog: logistics?.queueBacklog || 0,
          processing_pressure: logistics?.processingPressure || 0,
          success_rate: logistics?.successRate || 0,
        },
        rawMetrics: {
          activeConnections: Number.parseInt((metrics as any)?.active_connections) || 0,
          totalPositions: Number.parseInt((metrics as any)?.total_positions) || 0,
          dailyPnL: 0,
          totalBalance: 0,
          indicationsActive: Number.parseInt((metrics as any)?.active_indications) || 0,
          indicationsTotal: Number.parseInt((metrics as any)?.total_indications) || 0,
          strategiesActive: Number.parseInt((metrics as any)?.active_strategies) || 0,
          strategiesTotal: Number.parseInt((metrics as any)?.total_strategies) || 0,
          systemLoad: Math.round(cpuUsage),
          databaseSize: 45,
          activeSymbols: Number.parseInt((metrics as any)?.active_symbols) || 0,
          realPositions: Number.parseInt((metrics as any)?.real_positions) || 0,
          pseudoPositionsBase: Number.parseInt((metrics as any)?.base_positions) || 0,
          pseudoPositionsMain: Number.parseInt((metrics as any)?.main_positions) || 0,
          pseudoPositionsReal: Number.parseInt((metrics as any)?.real_positions) || 0,
          pseudoPositionsActive: Number.parseInt((metrics as any)?.active_positions) || 0,
          profitFactorLast20h: Number.parseFloat(profitMetrics.pf_last_20h) || 0,
          profitFactorLast50: Number.parseFloat(profitMetrics.pf_last_50) || 0,
          profitFactorLast25: Number.parseFloat(profitMetrics25Result.pf_last_25) || 0,
          livePositions: Number.parseInt(liveMetricsResult.live_count) || 0,
          pseudoBasePF20h: pfByType.base.pf20h,
          pseudoBasePF25: pfByType.base.pf25,
          pseudoMainPF20h: pfByType.main.pf20h,
          pseudoMainPF25: pfByType.main.pf25,
          pseudoRealPF20h: pfByType.real.pf20h,
          pseudoRealPF25: pfByType.real.pf25,
          pseudoActivePF20h: pfByType.active.pf20h,
          pseudoActivePF25: pfByType.active.pf25,
        },
      },
    })
  } catch (error) {
    console.error("[v0] Error fetching structure metrics:", error)
    return NextResponse.json(
      {
        error: "Failed to fetch structure metrics",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
