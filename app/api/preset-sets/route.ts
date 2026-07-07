import { type NextRequest, NextResponse } from "next/server"
import { sql } from "@/lib/db"
import { nanoid } from "nanoid"

// GET /api/preset-sets - Get all configuration sets
export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const sets = await sql`
      SELECT * FROM preset_configuration_sets
      ORDER BY created_at DESC
    `

    return NextResponse.json(sets)
  } catch (error) {
    console.error("[v0] Failed to fetch preset sets:", error)
    return NextResponse.json({ error: "Failed to fetch preset sets" }, { status: 500 })
  }
}

// POST /api/preset-sets - Create new configuration set
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    const id = nanoid()

    const [set] = await sql`
      INSERT INTO preset_configuration_sets (
        id, name, description,
        symbol_mode, symbols, exchange_order_by, exchange_limit,
        indication_type, indication_params,
        takeprofit_min, takeprofit_max, takeprofit_step,
        stoploss_min, stoploss_max, stoploss_step,
        trailing_enabled, trail_starts, trail_stops,
        range_days, trades_per_48h_min, profit_factor_min,
        drawdown_time_max, evaluation_positions_count1, evaluation_positions_count2,
        database_positions_per_set, database_threshold_percent,
        is_active
      ) VALUES (
        ${id}, ${body.name}, ${body.description || null},
        ${body.symbol_mode || "main"}, ${body.symbols || []}, 
        ${body.exchange_order_by || null}, ${body.exchange_limit || 10},
        ${body.indication_type}, ${JSON.stringify(body.indication_params)},
        ${body.takeprofit_min || 2.0}, ${body.takeprofit_max || 30.0}, ${body.takeprofit_step || 2.0},
        ${body.stoploss_min || 0.3}, ${body.stoploss_max || 3.0}, ${body.stoploss_step || 0.3},
        ${body.trailing_enabled !== false}, ${body.trail_starts || [0.5, 1.0, 1.5]}, 
        ${body.trail_stops || [0.2, 0.4, 0.6]},
        ${body.range_days || 7}, ${body.trades_per_48h_min || 5}, ${body.profit_factor_min || 0.5},
        ${body.drawdown_time_max || 12}, ${body.evaluation_positions_count1 || 25}, 
        ${body.evaluation_positions_count2 || 50},
        ${body.database_positions_per_set || 250}, ${body.database_threshold_percent || 20},
        ${body.is_active !== false}
      )
      RETURNING *
    `

    return NextResponse.json(set)
  } catch (error) {
    console.error("[v0] Failed to create preset set:", error)
    return NextResponse.json({ error: "Failed to create preset set" }, { status: 500 })
  }
}
