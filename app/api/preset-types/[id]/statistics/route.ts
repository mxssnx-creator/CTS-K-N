import { type NextRequest, NextResponse } from "next/server"
import { sql } from "@/lib/db"

// GET /api/preset-types/[id]/statistics - Get statistics for a preset type
export const dynamic = "force-dynamic"
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    // Get preset type info
    const [presetType] = await sql`
      SELECT * FROM preset_types WHERE id = ${id}
    `

    if (!presetType) {
      return NextResponse.json({ error: "Preset type not found" }, { status: 404 })
    }

    // Get configuration sets count
    const setsCountResult = await sql`
      SELECT COUNT(*) as total_sets, COUNT(*) FILTER (WHERE is_active = true) as active_sets
      FROM preset_type_sets
      WHERE preset_type_id = ${id}
    `
    const setsCount = (setsCountResult[0] || {}) as any

    // Get total trades
    const tradesStatsResult = await sql`
      SELECT 
        COUNT(*) as total_trades,
        COUNT(*) FILTER (WHERE status = 'closed') as closed_trades,
        COUNT(*) FILTER (WHERE status = 'open') as open_trades,
        COUNT(*) FILTER (WHERE profit_loss > 0) as winning_trades,
        COUNT(*) FILTER (WHERE profit_loss < 0) as losing_trades,
        SUM(profit_loss) FILTER (WHERE status = 'closed') as total_pnl,
        AVG(profit_loss) FILTER (WHERE profit_loss > 0 AND status = 'closed') as avg_win,
        AVG(profit_loss) FILTER (WHERE profit_loss < 0 AND status = 'closed') as avg_loss
      FROM preset_real_trades
      WHERE preset_type_id = ${id}
    `
    const tradesStats = (tradesStatsResult[0] || {}) as any

    // Calculate profit factor
    const totalWins = tradesStats.winning_trades || 0
    const totalLosses = tradesStats.losing_trades || 0
    const avgWin = Number.parseFloat(tradesStats.avg_win) || 0
    const avgLoss = Math.abs(Number.parseFloat(tradesStats.avg_loss)) || 0
    const profitFactor = avgLoss > 0 ? (totalWins * avgWin) / (totalLosses * avgLoss) : 0
    const winRate = tradesStats.closed_trades > 0 ? (totalWins / tradesStats.closed_trades) * 100 : 0

    // Get performance by configuration set
    const setPerformance = await sql`
      SELECT 
        cs.id as set_id,
        cs.name as set_name,
        COUNT(prt.id) as trades_count,
        COUNT(*) FILTER (WHERE prt.profit_loss > 0) as wins,
        COUNT(*) FILTER (WHERE prt.profit_loss < 0) as losses,
        SUM(prt.profit_loss) as total_pnl,
        AVG(prt.profit_loss) FILTER (WHERE prt.profit_loss > 0) as avg_win,
        AVG(prt.profit_loss) FILTER (WHERE prt.profit_loss < 0) as avg_loss
      FROM preset_type_sets pts
      JOIN configuration_sets cs ON pts.configuration_set_id = cs.id
      LEFT JOIN preset_real_trades prt ON prt.configuration_set_id = cs.id AND prt.preset_type_id = ${id}
      WHERE pts.preset_type_id = ${id} AND pts.is_active = true
      GROUP BY cs.id, cs.name
      ORDER BY total_pnl DESC NULLS LAST
    `

    // Calculate profit factor for each set
    const setPerformanceWithPF = setPerformance.map((set: any) => {
      const wins = set.wins || 0
      const losses = set.losses || 0
      const avgWinVal = Number.parseFloat(set.avg_win) || 0
      const avgLossVal = Math.abs(Number.parseFloat(set.avg_loss)) || 0
      const setPF = avgLossVal > 0 ? (wins * avgWinVal) / (losses * avgLossVal) : 0
      const setWinRate = set.trades_count > 0 ? (wins / set.trades_count) * 100 : 0

      return {
        ...set,
        profit_factor: setPF,
        win_rate: setWinRate,
      }
    })

    // Get recent trades
    const recentTrades = await sql`
      SELECT 
        prt.*,
        cs.name as set_name,
        ec.name as connection_name
      FROM preset_real_trades prt
      LEFT JOIN configuration_sets cs ON prt.configuration_set_id = cs.id
      LEFT JOIN exchange_connections ec ON prt.connection_id = ec.id
      WHERE prt.preset_type_id = ${id}
      ORDER BY prt.created_at DESC
      LIMIT 20
    `

    // Get performance over time (last 7 days)
    const performanceOverTime = await sql`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as trades,
        COUNT(*) FILTER (WHERE profit_loss > 0) as wins,
        SUM(profit_loss) as pnl
      FROM preset_real_trades
      WHERE preset_type_id = ${id} 
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `

    return NextResponse.json({
      preset_type: presetType,
      summary: {
        total_sets: setsCount.total_sets || 0,
        active_sets: setsCount.active_sets || 0,
        total_trades: tradesStats.total_trades || 0,
        open_trades: tradesStats.open_trades || 0,
        closed_trades: tradesStats.closed_trades || 0,
        winning_trades: totalWins,
        losing_trades: totalLosses,
        win_rate: winRate,
        profit_factor: profitFactor,
        total_pnl: Number.parseFloat(tradesStats.total_pnl) || 0,
        avg_win: avgWin,
        avg_loss: avgLoss,
      },
      set_performance: setPerformanceWithPF,
      recent_trades: recentTrades,
      performance_over_time: performanceOverTime,
    })
  } catch (error) {
    console.error("[v0] Failed to fetch preset type statistics:", error)
    return NextResponse.json({ error: "Failed to fetch statistics" }, { status: 500 })
  }
}
