import { NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient, getSettings } from "@/lib/redis-db"
import { getLiveExecutionSummary } from "@/lib/live-execution-summary"

/**
 * GET /api/settings/connections/[id]/statistics
 * Returns detailed statistics for a specific active connection including:
 * - Prehistoric data calculations (30-day historical analysis)
 * - Symbol statistics (volatility, volume, price ranges)
 * - Trading metrics (win rate, profit factor, etc.)
 * - Engine progress data
 */
export const dynamic = "force-dynamic"
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: connectionId } = await params
    await initRedis()
    const client = getRedisClient()

    // Get connection details
    const conn = await client.hgetall(`connection:${connectionId}`)
    if (!conn || Object.keys(conn).length === 0) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Get prehistoric data (30-day historical analysis)
    const prehistoricKey = `prehistoric:${connectionId}`
    const prehistoricData = await client.hgetall(prehistoricKey)
    const prehistoricStats = prehistoricData
      ? {
          symbols_analyzed: parseInt(prehistoricData.symbols_analyzed || "0"),
          total_indications: parseInt(prehistoricData.total_indications || "0"),
          avg_profit_factor: parseFloat(prehistoricData.avg_profit_factor || "0"),
          winning_signals: parseInt(prehistoricData.winning_signals || "0"),
          losing_signals: parseInt(prehistoricData.losing_signals || "0"),
          data_points_loaded: parseInt(prehistoricData.data_points_loaded || "0"),
          last_updated: prehistoricData.last_updated || new Date().toISOString(),
        }
      : {
          symbols_analyzed: 0,
          total_indications: 0,
          avg_profit_factor: 0,
          winning_signals: 0,
          losing_signals: 0,
          data_points_loaded: 0,
          last_updated: new Date().toISOString(),
        }

    // Get symbol statistics
    const symbolsKey = `symbols:${connectionId}`
    const symbolsSet = await client.smembers(symbolsKey)
    const symbols = [...new Set(symbolsSet.map(String).filter(Boolean))]
    const symbolStats: Array<Record<string, string | number>> = []
    const READ_BATCH_SIZE = 32
    for (let offset = 0; offset < symbols.length; offset += READ_BATCH_SIZE) {
      const batch = symbols.slice(offset, offset + READ_BATCH_SIZE)
      const values = await Promise.all(
        batch.map((symbol) =>
          client.hgetall(`symbol:${connectionId}:${symbol}`).catch(() => null),
        ),
      )
      for (let index = 0; index < batch.length; index++) {
        const symbolData = values[index]
        if (symbolData && Object.keys(symbolData).length > 0) {
          symbolStats.push({
            symbol: batch[index],
            volatility: parseFloat(symbolData.volatility || "0"),
            volume_24h: parseFloat(symbolData.volume_24h || "0"),
            price_change_percent: parseFloat(symbolData.price_change_percent || "0"),
            indications_count: parseInt(symbolData.indications_count || "0"),
            winning_indications: parseInt(symbolData.winning_indications || "0"),
            last_price: parseFloat(symbolData.last_price || "0"),
          })
        }
      }
    }

    const [scopedProgression, legacyProgression, execution] = await Promise.all([
      client.hgetall(`progression:${connectionId}:main`).catch(() => ({} as Record<string, string>)),
      client.hgetall(`progression:${connectionId}`).catch(() => ({} as Record<string, string>)),
      getLiveExecutionSummary(connectionId),
    ])
    const progression = Object.keys(scopedProgression).length > 0
      ? scopedProgression
      : Object.keys(legacyProgression).length > 0
        ? legacyProgression
        : await getSettings(`engine_progression:${connectionId}`) || {}
    const tradingMetrics = {
      total_trades: execution.totalTrades,
      total_positions: execution.totalPositions,
      open_positions: execution.openPositions,
      open_symbols: execution.openSymbols,
      open_orders: execution.openOrders,
      open_order_symbols: execution.openOrderSymbols,
      entry_orders: execution.entryOrders,
      control_orders: execution.controlOrders,
      excluded_untracked_positions: execution.excludedUntrackedPositions,
      excluded_untracked_orders: execution.excludedUntrackedOrders,
      exchange_scope: "cts_tracked_only",
      exchange_snapshot_complete: execution.exchange.complete,
      closed_positions: execution.closedPositions,
      settled_closed_positions: execution.settledClosedPositions,
      accounting_pending: execution.accountingPending,
      accounting_complete: execution.complete,
      winning_trades: execution.wins,
      losing_trades: execution.losses,
      break_even_trades: execution.breakEven,
      total_profit: execution.realizedPnl,
      unrealized_profit: execution.unrealizedPnl,
      effective_profit: execution.effectivePnl,
      total_loss: execution.losses > 0 && execution.avgLoss !== null
        ? Math.abs(execution.avgLoss * execution.losses)
        : 0,
      max_drawdown: null,
      win_rate: execution.winRate,
      data_available: execution.totalPositions > 0,
      source_counts: execution.sourceCounts,
    }

    return NextResponse.json({
      success: true,
      connection: {
        id: connectionId,
        exchange: conn.exchange,
        name: conn.name,
      },
      prehistoric: prehistoricStats,
      symbols: symbolStats,
      progression: progression,
      metrics: tradingMetrics,
      exchange: execution.exchange,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] [Statistics API] Error:", error instanceof Error ? error.message : String(error))
    return NextResponse.json(
      { error: "Failed to fetch statistics" },
      { status: 500 }
    )
  }
}
