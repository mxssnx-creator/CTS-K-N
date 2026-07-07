import { type NextRequest, NextResponse } from "next/server"
import { sql } from "@/lib/db"

// GET /api/preset-sets/[id] - Get single configuration set
export const dynamic = "force-dynamic"
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const [set] = await sql`
      SELECT * FROM preset_configuration_sets
      WHERE id = ${id}
    `

    if (!set) {
      return NextResponse.json({ error: "Set not found" }, { status: 404 })
    }

    return NextResponse.json(set)
  } catch (error) {
    console.error("[v0] Failed to fetch preset set:", error)
    return NextResponse.json({ error: "Failed to fetch preset set" }, { status: 500 })
  }
}

// PUT /api/preset-sets/[id] - Update configuration set
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()

    const [set] = await sql`
      UPDATE preset_configuration_sets
      SET
        name = ${body.name},
        description = ${body.description || null},
        symbol_mode = ${body.symbol_mode},
        symbols = ${body.symbols || []},
        exchange_order_by = ${body.exchange_order_by || null},
        exchange_limit = ${body.exchange_limit || 10},
        indication_type = ${body.indication_type},
        indication_params = ${JSON.stringify(body.indication_params)},
        takeprofit_min = ${body.takeprofit_min},
        takeprofit_max = ${body.takeprofit_max},
        takeprofit_step = ${body.takeprofit_step},
        stoploss_min = ${body.stoploss_min},
        stoploss_max = ${body.stoploss_max},
        stoploss_step = ${body.stoploss_step},
        trailing_enabled = ${body.trailing_enabled},
        trail_starts = ${body.trail_starts},
        trail_stops = ${body.trail_stops},
        range_days = ${body.range_days},
        trades_per_48h_min = ${body.trades_per_48h_min},
        profit_factor_min = ${body.profit_factor_min},
        drawdown_time_max = ${body.drawdown_time_max},
        evaluation_positions_count1 = ${body.evaluation_positions_count1},
        evaluation_positions_count2 = ${body.evaluation_positions_count2},
        database_positions_per_set = ${body.database_positions_per_set},
        database_threshold_percent = ${body.database_threshold_percent},
        is_active = ${body.is_active},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}
      RETURNING *
    `

    return NextResponse.json(set)
  } catch (error) {
    console.error("[v0] Failed to update preset set:", error)
    return NextResponse.json({ error: "Failed to update preset set" }, { status: 500 })
  }
}

// DELETE /api/preset-sets/[id] - Delete configuration set
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    await sql`
      DELETE FROM preset_configuration_sets
      WHERE id = ${id}
    `

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Failed to delete preset set:", error)
    return NextResponse.json({ error: "Failed to delete preset set" }, { status: 500 })
  }
}
