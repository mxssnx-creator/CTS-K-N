import { NextResponse } from "next/server"
import { PresetConfigGenerator } from "@/lib/preset-config-generator"
import { PresetTester } from "@/lib/preset-tester"
import { sql } from "@/lib/db"
import type { Preset } from "@/lib/types"

export const dynamic = "force-dynamic"
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()
    const { connectionId, symbols, testPeriodHours = 12 } = body

    // Get preset configuration
    const presetResult = await sql`
      SELECT * FROM presets WHERE id = ${id}
    `
    const preset = presetResult[0] as unknown as Preset

    if (!preset) {
      return NextResponse.json({ error: "Preset not found" }, { status: 404 })
    }

    // Generate indicator configurations
    const indicatorConfigs = PresetConfigGenerator.generateIndicatorConfigs()

    // Generate all test configurations (limit to 500)
    const testSymbols = symbols && symbols.length > 0 ? symbols : ["BTCUSDT", "ETHUSDT", "XRPUSDT"]
    const configurations = await PresetConfigGenerator.generateAllConfigurations(testSymbols, indicatorConfigs, 500)

    // Initialize tester
    const tester = new PresetTester(connectionId)

    // Test configurations
    const results = await tester.testConfigurations(configurations, testPeriodHours)

    // Filter valid configurations
    const validConfigs = PresetConfigGenerator.filterValidConfigurations(
      configurations,
      results,
      Number(preset.min_profit_factor),
      12, // max drawdown hours
    )

    // Save results to database
    await tester.saveResults(id)

    // Save valid configurations as active
    for (const config of validConfigs.slice(0, 100)) {
      // Limit to top 100
      const result = results.get(config.id)
      if (!result) continue

      await sql`
        INSERT INTO preset_active_configs (
          preset_id, connection_id, config_id,
          indicator_type, indicator_params, symbol, timeframe,
          takeprofit_factor, stoploss_ratio, trailing_enabled,
          trail_start, trail_stop, profit_factor, win_rate, total_trades
        )
        VALUES (
          ${id}, ${connectionId}, ${config.id},
          ${config.indicator.type}, ${JSON.stringify(config.indicator.params)}, ${config.symbol}, ${config.timeframe},
          ${config.takeprofit_factor}, ${config.stoploss_ratio}, ${config.trailing_enabled},
          ${config.trail_start || null}, ${config.trail_stop || null},
          ${result.profitFactor}, ${result.winRate}, ${result.totalTrades}
        )
        ON CONFLICT (preset_id, connection_id, config_id) 
        DO UPDATE SET
          profit_factor = EXCLUDED.profit_factor,
          win_rate = EXCLUDED.win_rate,
          total_trades = EXCLUDED.total_trades
      `
    }

    return NextResponse.json({
      success: true,
      totalConfigurations: configurations.length,
      validConfigurations: validConfigs.length,
      testedSymbols: testSymbols,
      testPeriodHours,
    })
  } catch (error) {
    console.error("[v0] Failed to test preset configurations:", error)
    return NextResponse.json({ error: "Failed to test configurations" }, { status: 500 })
  }
}
