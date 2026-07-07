import { type NextRequest, NextResponse } from "next/server"
import { sql } from "@/lib/db"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    const settings = await sql`
      SELECT key, value FROM system_settings
      WHERE key IN (
        'activeAdvancedActivityRatiosFrom',
        'activeAdvancedActivityRatiosTo',
        'activeAdvancedActivityRatiosStep',
        'activeAdvancedMinPositions',
        'activeAdvancedContinuationRatio',
        'activeAdvancedMinVolatility',
        'activeAdvancedMaxDrawdown'
      )
    `

    const settingsMap = new Map(settings.map((s: any) => [s.key, s.value]))

    return NextResponse.json({
      success: true,
      settings: {
        activity_ratios: {
          from: Number.parseFloat(settingsMap.get("activeAdvancedActivityRatiosFrom") || "0.5"),
          to: Number.parseFloat(settingsMap.get("activeAdvancedActivityRatiosTo") || "3.0"),
          step: Number.parseFloat(settingsMap.get("activeAdvancedActivityRatiosStep") || "0.5"),
        },
        time_windows: [1, 3, 5, 10, 15, 20, 30, 40],
        min_positions: Number.parseInt(settingsMap.get("activeAdvancedMinPositions") || "3"),
        continuation_ratio: Number.parseFloat(settingsMap.get("activeAdvancedContinuationRatio") || "0.6"),
        min_volatility: Number.parseFloat(settingsMap.get("activeAdvancedMinVolatility") || "0.1"),
        max_drawdown: Number.parseFloat(settingsMap.get("activeAdvancedMaxDrawdown") || "5.0"),
      },
    })
  } catch (error) {
    console.error("[v0] Error loading active advanced settings:", error)
    return NextResponse.json({ error: "Failed to load settings" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { settings } = await request.json()

    const updates = [
      { key: "activeAdvancedActivityRatiosFrom", value: settings.activity_ratios.from.toString() },
      { key: "activeAdvancedActivityRatiosTo", value: settings.activity_ratios.to.toString() },
      { key: "activeAdvancedActivityRatiosStep", value: settings.activity_ratios.step.toString() },
      { key: "activeAdvancedMinPositions", value: settings.min_positions.toString() },
      { key: "activeAdvancedContinuationRatio", value: settings.continuation_ratio.toString() },
      { key: "activeAdvancedMinVolatility", value: settings.min_volatility.toString() },
      { key: "activeAdvancedMaxDrawdown", value: settings.max_drawdown.toString() },
    ]

    for (const update of updates) {
      await sql`
        INSERT INTO system_settings (key, value)
        VALUES (${update.key}, ${update.value})
        ON CONFLICT (key)
        DO UPDATE SET value = ${update.value}, updated_at = CURRENT_TIMESTAMP
      `
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Error saving active advanced settings:", error)
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 })
  }
}
