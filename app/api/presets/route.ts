import { type NextRequest, NextResponse } from "next/server"
import { query, execute } from "@/lib/db"
import { nanoid } from "nanoid"
import { SystemLogger } from "@/lib/system-logger"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  try {
    console.log("[v0] GET /api/presets - Starting...")

    const searchParams = request.nextUrl.searchParams
    const activeOnly = searchParams.get("active") === "true"

    console.log("[v0] Fetching presets, activeOnly:", activeOnly)
    await SystemLogger.logAPI(`Fetching presets (activeOnly: ${activeOnly})`, "info", "GET /api/presets")

    const queryText = activeOnly
      ? "SELECT * FROM presets WHERE is_active = true ORDER BY is_predefined DESC, created_at DESC"
      : "SELECT * FROM presets ORDER BY is_predefined DESC, created_at DESC"

    const result = await query(queryText)
    const presets = result

    console.log("[v0] Successfully fetched", presets.length, "presets")

    const validatedPresets = presets.map((preset: any) => ({
      ...preset,
      indication_types: preset.indication_types ? JSON.parse(preset.indication_types) : ["direction", "move", "active"],
      indication_ranges: preset.indication_ranges
        ? JSON.parse(preset.indication_ranges)
        : [3, 5, 8, 12, 15, 20, 25, 30],
      takeprofit_steps: preset.takeprofit_steps ? JSON.parse(preset.takeprofit_steps) : [2, 3, 4, 6, 8, 12],
      stoploss_ratios: preset.stoploss_ratios
        ? JSON.parse(preset.stoploss_ratios)
        : [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5],
      trail_starts: preset.trail_starts ? JSON.parse(preset.trail_starts) : [0.3, 0.6, 1.0],
      trail_stops: preset.trail_stops ? JSON.parse(preset.trail_stops) : [0.1, 0.2, 0.3],
      strategy_types: preset.strategy_types ? JSON.parse(preset.strategy_types) : ["base", "main", "real"],
      last_positions_counts: preset.last_positions_counts
        ? JSON.parse(preset.last_positions_counts)
        : [3, 4, 5, 6, 8, 12, 25],
      main_positions_count: preset.main_positions_count
        ? JSON.parse(preset.main_positions_count)
        : [1, 2, 3, 4, 5],
      block_sizes: preset.block_sizes ? JSON.parse(preset.block_sizes) : [2, 4, 6, 8],
      block_adjustment_ratios: preset.block_adjustment_ratios
        ? JSON.parse(preset.block_adjustment_ratios)
        : [0.5, 1.0, 1.5, 2.0],
      dca_levels: preset.dca_levels ? JSON.parse(preset.dca_levels) : [3, 5, 7],
      volume_factors: preset.volume_factors ? JSON.parse(preset.volume_factors) : [0.1, 0.2, 0.5],
      trailing_enabled: preset.trailing_enabled === true,
      block_adjustment_enabled: preset.block_adjustment_enabled === true,
      dca_adjustment_enabled: preset.dca_adjustment_enabled === true,
      backtest_enabled: preset.backtest_enabled === true,
      is_active: preset.is_active === true,
      is_predefined: preset.is_predefined === true,
    }))

    return NextResponse.json(validatedPresets)
  } catch (error) {
    console.error("[v0] Failed to fetch presets:", error)
    await SystemLogger.logError(error, "api", "GET /api/presets")
    return NextResponse.json([], { status: 200 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    if (!body.name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 })
    }

    const presetId = nanoid()

    console.log("[v0] Creating preset:", body.name)
    await SystemLogger.logAPI(`Creating preset: ${body.name}`, "info", "POST /api/presets")

    await execute(
      `INSERT INTO presets (
        id, name, description, indication_types, indication_ranges,
        takeprofit_steps, stoploss_ratios, trailing_enabled,
        trail_starts, trail_stops, strategy_types,
        last_positions_counts, main_positions_count,
        block_adjustment_enabled, block_sizes, block_adjustment_ratios,
        dca_adjustment_enabled, dca_levels, volume_factors,
        min_profit_factor, min_win_rate, max_drawdown,
        backtest_period_days, backtest_enabled, is_active,
        is_predefined, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)`,
      [
        presetId,
        body.name,
        body.description || null,
        JSON.stringify(body.indication_types || ["direction", "move", "active"]),
        JSON.stringify(body.indication_ranges || [3, 5, 8, 12, 15, 20, 25, 30]),
        JSON.stringify(body.takeprofit_steps || [2, 3, 4, 6, 8, 12]),
        JSON.stringify(body.stoploss_ratios || [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5]),
        body.trailing_enabled !== undefined ? body.trailing_enabled : true,
        JSON.stringify(body.trail_starts || [0.3, 0.6, 1.0]),
        JSON.stringify(body.trail_stops || [0.1, 0.2, 0.3]),
        JSON.stringify(body.strategy_types || ["base", "main", "real"]),
        JSON.stringify(body.last_positions_counts || [3, 4, 5, 6, 8, 12, 25]),
        JSON.stringify(body.main_positions_count || [1, 2, 3, 4, 5]),
        body.block_adjustment_enabled !== undefined ? body.block_adjustment_enabled : true,
        JSON.stringify(body.block_sizes || [2, 4, 6, 8]),
        JSON.stringify(body.block_adjustment_ratios || [0.5, 1.0, 1.5, 2.0]),
        body.dca_adjustment_enabled !== undefined ? body.dca_adjustment_enabled : false,
        JSON.stringify(body.dca_levels || [3, 5, 7]),
        JSON.stringify(body.volume_factors || [0.1, 0.2, 0.5]),
        body.min_profit_factor || 0.4,
        body.min_win_rate || 0.0,
        body.max_drawdown || 50.0,
        body.backtest_period_days || 30,
        body.backtest_enabled !== undefined ? body.backtest_enabled : true,
        body.is_active !== undefined ? body.is_active : true,
        body.is_predefined ? true : false,
        body.created_by || null,
      ],
    )

    const result = await query("SELECT * FROM presets WHERE id = $1", [presetId])
    const preset = result[0]

    console.log("[v0] Preset created successfully:", presetId)
    await SystemLogger.logAPI(`Preset created: ${presetId}`, "info", "POST /api/presets")

    return NextResponse.json(preset, { status: 201 })
  } catch (error) {
    console.error("[v0] Failed to create preset:", error)
    await SystemLogger.logError(error, "api", "POST /api/presets")

    return NextResponse.json(
      {
        error: "Failed to create preset",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
