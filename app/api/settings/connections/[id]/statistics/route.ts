import { NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient, getSettings } from "@/lib/redis-db"
// Aliases so the rest of the file continues to compile without changes.
const redisGetSettings = getSettings
const redisSetSettings = async (_key: string, _val: unknown) => { /* no-op: use setSettings if write is needed */ }

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
    const symbolStats = []
    for (const symbol of symbolsSet.slice(0, 50)) {
      const symbolData = await client.hgetall(`symbol:${connectionId}:${symbol}`)
      if (symbolData && Object.keys(symbolData).length > 0) {
        symbolStats.push({
          symbol,
          volatility: parseFloat(symbolData.volatility || "0"),
          volume_24h: parseFloat(symbolData.volume_24h || "0"),
          price_change_percent: parseFloat(symbolData.price_change_percent || "0"),
          indications_count: parseInt(symbolData.indications_count || "0"),
          winning_indications: parseInt(symbolData.winning_indications || "0"),
          last_price: parseFloat(symbolData.last_price || "0"),
        })
      }
    }

    // Get progression data
    const progressionKey = `settings:engine_progression:${connectionId}`
    const progression = await redisGetSettings(progressionKey) || {}

    // Get trading metrics
    const metricsKey = `trading_metrics:${connectionId}`
    const metrics = await client.hgetall(metricsKey)
    const tradingMetrics = metrics
      ? {
          total_trades: parseInt(metrics.total_trades || "0"),
          winning_trades: parseInt(metrics.winning_trades || "0"),
          losing_trades: parseInt(metrics.losing_trades || "0"),
          total_profit: parseFloat(metrics.total_profit || "0"),
          total_loss: parseFloat(metrics.total_loss || "0"),
          max_drawdown: parseFloat(metrics.max_drawdown || "0"),
          win_rate: parseFloat(metrics.win_rate || "0"),
        }
      : {
          total_trades: 0,
          winning_trades: 0,
          losing_trades: 0,
          total_profit: 0,
          total_loss: 0,
          max_drawdown: 0,
          win_rate: 0,
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
