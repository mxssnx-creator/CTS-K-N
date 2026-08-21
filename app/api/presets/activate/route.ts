import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getConnection, setSettings } from "@/lib/redis-db"
import { getWebSocketManager } from "@/lib/websocket-server"
import { SystemLogger } from "@/lib/system-logger"
import {
  PRESET_DEFAULT_INDICATION_RANGES,
  PRESET_DEFAULT_INDICATION_TYPES,
  PRESET_DEFAULT_MIN_PF_RATIO,
  PRESET_DEFAULT_STRATEGY_TYPES,
  PRESET_DEFAULT_TAKE_PROFIT_STEPS,
  presetNumberList,
  presetStringList,
} from "@/lib/preset-crud-defaults"
import { normalizeMainTradeStagePfRatio } from "@/lib/main-trade-profit-factor"

export const dynamic = "force-dynamic"
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { presetId, connectionId } = body
    const scopedConnectionId = String(connectionId || "").trim()

    if (!presetId) {
      return NextResponse.json({ error: "Preset ID is required" }, { status: 400 })
    }
    if (!scopedConnectionId) {
      return NextResponse.json({ error: "Select an active connection before activating a preset" }, { status: 400 })
    }

    const connection = await getConnection(scopedConnectionId)
    if (!connection) {
      return NextResponse.json({ error: "Selected connection was not found" }, { status: 404 })
    }

    console.log(`[v0] [API] [Presets] Activating preset: ${presetId}`)
    await SystemLogger.logAPI(`Activating preset: ${presetId}`, "info", "POST /api/presets/activate")

    const presetResult = await query("SELECT * FROM presets WHERE id = $1", [presetId])
    const preset = presetResult[0]

    if (!preset) {
      return NextResponse.json({ error: "Preset not found" }, { status: 404 })
    }

    await setSettings(`active_preset:${scopedConnectionId}`, {
      id: presetId,
      name: preset.name,
      activatedAt: new Date().toISOString(),
      connectionId: scopedConnectionId,
    })

    const activeConfig = {
      id: presetId,
      name: preset.name,
      description: preset.description,
      indication_types: presetStringList(preset.indication_types, PRESET_DEFAULT_INDICATION_TYPES),
      indication_ranges: presetNumberList(preset.indication_ranges, PRESET_DEFAULT_INDICATION_RANGES),
      takeprofit_steps: preset.takeprofit_steps ? JSON.parse(preset.takeprofit_steps) : [...PRESET_DEFAULT_TAKE_PROFIT_STEPS],
      stoploss_ratios: preset.stoploss_ratios ? JSON.parse(preset.stoploss_ratios) : [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5],
      trailing_enabled: preset.trailing_enabled === true,
      trail_starts: preset.trail_starts ? JSON.parse(preset.trail_starts) : [0.3, 0.6, 1.0],
      trail_stops: preset.trail_stops ? JSON.parse(preset.trail_stops) : [0.1, 0.2, 0.3],
      strategy_types: presetStringList(preset.strategy_types, PRESET_DEFAULT_STRATEGY_TYPES),
      min_profit_factor: normalizeMainTradeStagePfRatio(
        "base",
        preset.min_profit_factor ?? PRESET_DEFAULT_MIN_PF_RATIO,
      ),
      min_win_rate: preset.min_win_rate || 0.0,
      max_drawdown: preset.max_drawdown || 50.0,
    }

    const wsManager = getWebSocketManager()
    wsManager.broadcast({
      type: "preset_activated",
      data: {
        presetId,
        name: preset.name,
        connectionId: scopedConnectionId,
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
      connectionId: scopedConnectionId,
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
