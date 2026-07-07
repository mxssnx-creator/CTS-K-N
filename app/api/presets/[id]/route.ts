import { type NextRequest, NextResponse } from "next/server"
import { sql } from "@/lib/db"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const [preset] = await sql`
      SELECT * FROM presets WHERE id = ${id}
    `

    if (!preset) {
      return NextResponse.json({ error: "Preset not found" }, { status: 404 })
    }

    return NextResponse.json(preset)
  } catch (error) {
    console.error("[v0] Failed to fetch preset:", error)
    return NextResponse.json({ error: "Failed to fetch preset" }, { status: 500 })
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()

    const [preset] = await sql`
      UPDATE presets
      SET
        name = ${body.name},
        description = ${body.description || null},
        indication_types = ${JSON.stringify(body.indication_types)},
        indication_ranges = ${JSON.stringify(body.indication_ranges)},
        takeprofit_steps = ${JSON.stringify(body.takeprofit_steps)},
        stoploss_ratios = ${JSON.stringify(body.stoploss_ratios)},
        trailing_enabled = ${body.trailing_enabled},
        trail_starts = ${JSON.stringify(body.trail_starts)},
        trail_stops = ${JSON.stringify(body.trail_stops)},
        strategy_types = ${JSON.stringify(body.strategy_types)},
        last_positions_counts = ${JSON.stringify(body.last_positions_counts)},
        main_positions_count = ${JSON.stringify(body.main_positions_count)},
        block_adjustment_enabled = ${body.block_adjustment_enabled},
        block_sizes = ${JSON.stringify(body.block_sizes)},
        block_adjustment_ratios = ${JSON.stringify(body.block_adjustment_ratios)},
        dca_adjustment_enabled = ${body.dca_adjustment_enabled},
        dca_levels = ${JSON.stringify(body.dca_levels)},
        volume_factors = ${JSON.stringify(body.volume_factors)},
        min_profit_factor = ${body.min_profit_factor},
        min_win_rate = ${body.min_win_rate},
        max_drawdown = ${body.max_drawdown},
        backtest_period_days = ${body.backtest_period_days},
        backtest_enabled = ${body.backtest_enabled},
        is_active = ${body.is_active}
      WHERE id = ${id}
      RETURNING *
    `

    if (!preset) {
      return NextResponse.json({ error: "Preset not found" }, { status: 404 })
    }

    return NextResponse.json(preset)
  } catch (error) {
    console.error("[v0] Failed to update preset:", error)
    return NextResponse.json({ error: "Failed to update preset" }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const [preset] = await sql`
      DELETE FROM presets WHERE id = ${id} RETURNING *
    `

    if (!preset) {
      return NextResponse.json({ error: "Preset not found" }, { status: 404 })
    }

    return NextResponse.json({ message: "Preset deleted successfully" })
  } catch (error) {
    console.error("[v0] Failed to delete preset:", error)
    return NextResponse.json({ error: "Failed to delete preset" }, { status: 500 })
  }
}
