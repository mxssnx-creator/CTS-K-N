import { NextResponse } from "next/server"
import { query, execute } from "@/lib/db"
import { getSettings, setSettings } from "@/lib/redis-db"
import { getWebSocketManager } from "@/lib/websocket-server"
import { SystemLogger } from "@/lib/system-logger"

export const dynamic = "force-dynamic"
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { presetId, connectionId } = body

    if (!presetId) {
      return NextResponse.json({ error: "Preset ID is required" }, { status: 400 })
    }

    console.log(`[v0] [API] [Presets] Activating preset: ${presetId}`)
    await SystemLogger.logAPI(`Activating preset: ${presetId}`, "info", "POST /api/presets/activate")

    const presetResult = await query("SELECT * FROM presets WHERE id = $1", [presetId])
    const preset = presetResult[0]

    if (!preset) {
      return NextResponse.json({ error: "Preset not found" }, { status: 404 })
    }

    await execute(
      "UPDATE presets SET is_active = false WHERE is_active = true"
    )
    await execute(
      "UPDATE presets SET is_active = true WHERE id = $1",
      [presetId]
    )

    await setSettings("active_preset", {
      id: presetId,
      name: preset.name,
      activatedAt: new Date().toISOString(),
      connectionId: connectionId || null,
    })

    const activeConfig = {
      id: presetId,
      name: preset.name,
      description: preset.description,
      indication_types: preset.indication_types ? JSON.parse(preset.indication_types) : ["direction", "move", "active"],
      indication_ranges: preset.indication_ranges ? JSON.parse(preset.indication_ranges) : [3, 5, 8, 12, 15, 20, 25, 30],
      takeprofit_steps: preset.takeprofit_steps ? JSON.parse(preset.takeprofit_steps) : [2, 3, 4, 6, 8, 12],
      stoploss_ratios: preset.stoploss_ratios ? JSON.parse(preset.stoploss_ratios) : [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5],
      trailing_enabled: preset.trailing_enabled === true,
      trail_starts: preset.trail_starts ? JSON.parse(preset.trail_starts) : [0.3, 0.6, 1.0],
      trail_stops: preset.trail_stops ? JSON.parse(preset.trail_stops) : [0.1, 0.2, 0.3],
      strategy_types: preset.strategy_types ? JSON.parse(preset.strategy_types) : ["base", "main", "real"],
      min_profit_factor: preset.min_profit_factor || 0.4,
      min_win_rate: preset.min_win_rate || 0.0,
      max_drawdown: preset.max_drawdown || 50.0,
    }

    const wsManager = getWebSocketManager()
    wsManager.broadcast({
      type: "preset_activated",
      data: {
        presetId,
        name: preset.name,
        connectionId: connectionId || null,
        activatedAt: new Date().toISOString(),
        config: activeConfig,
      },
      timestamp: new Date().toISOString(),
    })

    console.log(`[v0] [API] [Presets] Preset ${presetId} (${preset.name}) activated successfully`)
    await SystemLogger.logAPI(`Preset activated: ${preset.name} (${presetId})`, "info", "POST /api/presets/activate")

    return NextResponse.json({
      success: true,
      message: `Preset ${preset.name} activated successfully`,
      name: preset.name,
      presetId,
      config: activeConfig,
    })
  } catch (error) {
    console.error("[v0] [API] [Presets] Error activating preset:", error)
    await SystemLogger.logError(error, "api", "POST /api/presets/activate")
    return NextResponse.json(
      { error: "Failed to activate preset", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
