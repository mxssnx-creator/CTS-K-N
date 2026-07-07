import { NextResponse } from "next/server"
import { sql } from "@/lib/db"

export const dynamic = "force-dynamic"
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    try {
      // Fetch symbol performance data
      const performance = await sql`
        SELECT 
          symbol,
          profit_factor_12 as "profitFactor12",
          profit_factor_25 as "profitFactor25",
          avg_profit_factor_50 as "avgProfitFactor50",
          max_drawdown_hours as "maxDrawdownHours",
          valid_config_count as "validConfigCount",
          pnl_4h as "pnl4h",
          pnl_12h as "pnl12h",
          pnl_24h as "pnl24h",
          pnl_48h as "pnl48h"
        FROM preset_symbol_performance
        WHERE preset_id = ${id}
        ORDER BY avg_profit_factor_50 DESC
      `

      // Fetch balance/equity history for the last 7 days for each symbol
      const historyData = await sql`
        SELECT 
          symbol,
          balance,
          equity,
          timestamp
        FROM preset_balance_history
        WHERE preset_id = ${id}
          AND timestamp >= NOW() - INTERVAL '7 days'
        ORDER BY symbol, timestamp ASC
      `

      // Group history by symbol
      const historyBySymbol: Record<string, any[]> = {}
      for (const row of (historyData as any[])) {
        if (!historyBySymbol[row.symbol]) {
          historyBySymbol[row.symbol] = []
        }
        historyBySymbol[row.symbol].push({
          timestamp: row.timestamp,
          balance: Number.parseFloat(row.balance),
          equity: Number.parseFloat(row.equity),
        })
      }

      // Combine performance data with history
      const result = performance.map((perf: any) => ({
        ...perf,
        profitFactor12: Number.parseFloat(perf.profitFactor12),
        profitFactor25: Number.parseFloat(perf.profitFactor25),
        avgProfitFactor50: Number.parseFloat(perf.avgProfitFactor50),
        maxDrawdownHours: Number.parseFloat(perf.maxDrawdownHours),
        pnl4h: Number.parseFloat(perf.pnl4h),
        pnl12h: Number.parseFloat(perf.pnl12h),
        pnl24h: Number.parseFloat(perf.pnl24h),
        pnl48h: Number.parseFloat(perf.pnl48h),
        chartData: historyBySymbol[perf.symbol] || [],
      }))

      return NextResponse.json(result)
    } catch (dbError) {
      console.error("[v0] Database query failed (tables may not exist):", dbError)
      // Return empty array instead of error to prevent UI crash
      return NextResponse.json([])
    }
  } catch (error) {
    console.error("[v0] Failed to fetch symbol performance:", error)
    // Return empty array instead of error
    return NextResponse.json([])
  }
}
