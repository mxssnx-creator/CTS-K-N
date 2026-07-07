import { NextResponse } from "next/server"
import { sql } from "@/lib/db"

export const dynamic = "force-dynamic"
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connectionId")
    const symbol = searchParams.get("symbol")
    const indicatorType = searchParams.get("indicatorType")

    try {
      let query = sql`
        SELECT 
          pac.*,
          ptr.max_drawdown,
          ptr.drawdown_hours,
          ptr.sharpe_ratio
        FROM preset_active_configs pac
        LEFT JOIN preset_test_results ptr ON pac.test_result_id = ptr.id
        WHERE pac.preset_id = ${id}
          AND pac.is_active = true
      `

      if (connectionId) {
        query = sql`${query} AND pac.connection_id = ${connectionId}`
      }

      if (symbol) {
        query = sql`${query} AND pac.symbol = ${symbol}`
      }

      if (indicatorType) {
        query = sql`${query} AND pac.indicator_type = ${indicatorType}`
      }

      query = sql`${query} ORDER BY pac.profit_factor DESC LIMIT 100`

      const configs = await query

      return NextResponse.json(configs)
    } catch (dbError) {
      console.error("[v0] Database query failed (tables may not exist):", dbError)
      // Return empty array instead of error to prevent UI crash
      return NextResponse.json([])
    }
  } catch (error) {
    console.error("[v0] Failed to fetch active configurations:", error)
    // Return empty array instead of error
    return NextResponse.json([])
  }
}
