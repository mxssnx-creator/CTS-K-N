import { type NextRequest, NextResponse } from "next/server"
import { sql } from "@/lib/db"
import {
  PRESET_DEFAULT_INDICATION_RANGES,
  PRESET_DEFAULT_INDICATION_TYPES,
  PRESET_DEFAULT_MIN_PF_RATIO,
  PRESET_DEFAULT_STRATEGY_TYPES,
  presetNumberList,
  presetStringList,
} from "@/lib/preset-crud-defaults"
import { normalizeMainTradeStagePfRatio } from "@/lib/main-trade-profit-factor"

export const dynamic = "force-dynamic"

function normalizePresetVolumeFactors(value: unknown): number[] {
  let raw = value
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw) } catch { raw = [] }
  }
  const factors = Array.isArray(raw)
    ? raw
        .map(Number)
        .filter(Number.isFinite)
        .map((factor) => Math.max(1, Math.min(10, factor)))
    : []
  return [...new Set(factors.length > 0 ? factors : [1, 1.5, 2])]
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const [preset] = await sql`
      SELECT * FROM presets WHERE id = ${id}
    `

    if (!preset) {
      return NextResponse.json({ error: "Preset not found" }, { status: 404 })
    }

    return NextResponse.json({
      ...preset,
      indication_types: presetStringList(preset.indication_types, PRESET_DEFAULT_INDICATION_TYPES),
      indication_ranges: presetNumberList(preset.indication_ranges, PRESET_DEFAULT_INDICATION_RANGES),
      strategy_types: presetStringList(preset.strategy_types, PRESET_DEFAULT_STRATEGY_TYPES),
      min_profit_factor: normalizeMainTradeStagePfRatio(
        "base",
        preset.min_profit_factor ?? PRESET_DEFAULT_MIN_PF_RATIO,
      ),
      volume_factors: normalizePresetVolumeFactors(preset.volume_factors),
    })
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
        indication_types = ${JSON.stringify(presetStringList(body.indication_types, PRESET_DEFAULT_INDICATION_TYPES))},
        indication_ranges = ${JSON.stringify(presetNumberList(body.indication_ranges, PRESET_DEFAULT_INDICATION_RANGES))},
        takeprofit_steps = ${JSON.stringify(body.takeprofit_steps)},
        stoploss_ratios = ${JSON.stringify(body.stoploss_ratios)},
        trailing_enabled = ${body.trailing_enabled},
        trail_starts = ${JSON.stringify(body.trail_starts)},
        trail_stops = ${JSON.stringify(body.trail_stops)},
        strategy_types = ${JSON.stringify(presetStringList(body.strategy_types, PRESET_DEFAULT_STRATEGY_TYPES))},
        last_positions_counts = ${JSON.stringify(body.last_positions_counts)},
        main_positions_count = ${JSON.stringify(body.main_positions_count)},
        block_adjustment_enabled = ${body.block_adjustment_enabled},
        block_sizes = ${JSON.stringify(body.block_sizes)},
        block_adjustment_ratios = ${JSON.stringify(body.block_adjustment_ratios)},
        dca_adjustment_enabled = ${body.dca_adjustment_enabled},
        dca_levels = ${JSON.stringify(body.dca_levels)},
        volume_factors = ${JSON.stringify(normalizePresetVolumeFactors(body.volume_factors))},
        min_profit_factor = ${normalizeMainTradeStagePfRatio(
          "base",
          body.min_profit_factor ?? PRESET_DEFAULT_MIN_PF_RATIO,
        )},
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
