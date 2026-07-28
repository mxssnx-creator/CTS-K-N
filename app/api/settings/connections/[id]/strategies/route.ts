import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getConnection } from "@/lib/redis-db"
import { applyMainConnectionSettingsChange } from "@/lib/connection-recoordinator"
import {
  MAIN_TRADE_STAGE_PF_DEFAULTS,
  normalizeMainTradeStagePfRatio,
  type MainTradeStage,
} from "@/lib/main-trade-profit-factor"

/**
 * Per-connection strategy settings (Base / Main / Real / Live channels).
 *
 * This route uses the Redis SQL compatibility layer.
 * `connection_strategy_settings` table that does not exist in this
 * Redis-only deployment — every call threw. It now reads/writes the same
 * canonical store the rest of the system uses:
 *   - the connection object's `connection_settings.strategies.main` JSON
 *     (source of truth the dialog hydrates from), AND
 *   - the flat `connection_settings:{id}` Redis HASH the strategy
 *     coordinator reads each refresh window (PF / DDT / stage pos-counts).
 *
 * Channel param semantics (matching the dialog + coordinator):
 *   min_profit_factor → baseProfitFactor / mainProfitFactor /
 *                       realProfitFactor / liveProfitFactor
 *   max_drawdown_time (MINUTES) → maxDrawdownTime{Main,Real,Live}Hours (÷60)
 *   max_positions → retained compatibility field, always normalized to
 *                   0 (= Unlimited).
 */

type StratRow = {
  strategy_type: MainTradeStage
  is_enabled: boolean
  enabled?: boolean
  min_profit_factor: number
  max_drawdown_time: number
  max_positions: number
}

const DEFAULTS: Record<StratRow["strategy_type"], Omit<StratRow, "strategy_type">> = {
  base: {
    is_enabled: true,
    min_profit_factor: MAIN_TRADE_STAGE_PF_DEFAULTS.base,
    max_drawdown_time: 0,
    max_positions: 0,
  },
  main: {
    is_enabled: true,
    min_profit_factor: MAIN_TRADE_STAGE_PF_DEFAULTS.main,
    max_drawdown_time: 240,
    max_positions: 0,
  },
  real: {
    is_enabled: true,
    min_profit_factor: MAIN_TRADE_STAGE_PF_DEFAULTS.real,
    max_drawdown_time: 240,
    max_positions: 0,
  },
  live: {
    is_enabled: true,
    min_profit_factor: MAIN_TRADE_STAGE_PF_DEFAULTS.live,
    max_drawdown_time: 240,
    max_positions: 0,
  },
}

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    await initRedis()
    const conn = await getConnection(id)
    if (!conn) return NextResponse.json({ error: "Connection not found" }, { status: 404 })

    const cs =
      typeof conn.connection_settings === "string"
        ? JSON.parse(conn.connection_settings || "{}")
        : conn.connection_settings || {}
    const channel = (cs?.strategies?.main || {}) as Record<string, Partial<StratRow>>

    const strategies: StratRow[] = (Object.keys(DEFAULTS) as StratRow["strategy_type"][]).map((type) => {
      const saved = channel[type] || {}
      const d = DEFAULTS[type]
      return {
        strategy_type: type,
        // Compatibility field only. The four rows form one mandatory
        // processing pipeline and cannot be switched independently.
        is_enabled: true,
        min_profit_factor: normalizeMainTradeStagePfRatio(
          type,
          saved.min_profit_factor,
        ),
        max_drawdown_time: Number(saved.max_drawdown_time ?? d.max_drawdown_time),
        max_positions: 0,
      }
    })

    return NextResponse.json({ strategies })
  } catch (error) {
    console.error("[v0] Failed to fetch connection strategies:", error)
    return NextResponse.json({ error: "Failed to fetch strategies" }, { status: 500 })
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { strategies } = (await request.json()) as { strategies: StratRow[] }
    if (!Array.isArray(strategies)) {
      return NextResponse.json({ error: "strategies must be an array" }, { status: 400 })
    }

    await initRedis()
    const conn = await getConnection(id)
    if (!conn) return NextResponse.json({ error: "Connection not found" }, { status: 404 })

    const cs =
      typeof conn.connection_settings === "string"
        ? JSON.parse(conn.connection_settings || "{}")
        : conn.connection_settings || {}

    const channel: Record<string, Partial<StratRow>> = { ...(cs?.strategies?.main || {}) }
    for (const type of Object.keys(DEFAULTS) as StratRow["strategy_type"][]) {
      channel[type] = {
        ...(channel[type] || {}),
        is_enabled: true,
        enabled: true,
      }
    }
    const flat: Record<string, string> = {}

    for (const strat of strategies) {
      const type = strat.strategy_type
      if (!["base", "main", "real", "live"].includes(type)) continue
      const d = DEFAULTS[type]
      const pf = normalizeMainTradeStagePfRatio(type, strat.min_profit_factor)
      const ddtMin = Number(strat.max_drawdown_time ?? d.max_drawdown_time)

      channel[type] = {
        is_enabled: true,
        enabled: true,
        min_profit_factor: pf,
        max_drawdown_time: ddtMin,
        max_positions: 0,
      }

      // Flatten into the coordinator-readable hash fields (same mapping as
      // the PATCH /settings route). DDT minutes → hours, clamp [1,72].
      const pfStr = String(pf)
      if (type === "base") flat.baseProfitFactor = pfStr
      if (type === "main") flat.mainProfitFactor = pfStr
      if (type === "real") flat.realProfitFactor = pfStr
      if (type === "live") flat.liveProfitFactor = pfStr
      if (Number.isFinite(ddtMin) && ddtMin > 0 && type !== "base") {
        const hrs = String(Math.max(1, Math.min(72, ddtMin / 60)))
        if (type === "main") flat.maxDrawdownTimeMainHours = hrs
        if (type === "real") flat.maxDrawdownTimeRealHours = hrs
        if (type === "live") flat.maxDrawdownTimeLiveHours = hrs
      }
      if (type === "real") {
        flat.strategyRealSetsSafetyCeiling = "0"
        flat.maxRealSets = "0"
      }
      if (type === "live") flat.strategyLiveSetsCeiling = "0"
    }

    await applyMainConnectionSettingsChange(id, conn, {
      connectionPatch: {
        connection_settings: {
          strategies: { main: channel },
        },
        updated_at: new Date().toISOString(),
      },
      settingsPatch: flat,
      changedFieldsOverride: ["strategies", ...Object.keys(flat)],
      logTag: "PUT /settings/connections/[id]/strategies",
    })

    const normalizedStrategies = (Object.keys(DEFAULTS) as StratRow["strategy_type"][]).map((type) => ({
      strategy_type: type,
      is_enabled: true,
      min_profit_factor: normalizeMainTradeStagePfRatio(
        type,
        channel[type]?.min_profit_factor,
      ),
      max_drawdown_time: Number(
        channel[type]?.max_drawdown_time ?? DEFAULTS[type].max_drawdown_time,
      ),
      max_positions: Number(
        channel[type]?.max_positions ?? DEFAULTS[type].max_positions,
      ),
    }))
    return NextResponse.json({ success: true, strategies: normalizedStrategies })
  } catch (error) {
    console.error("[v0] Failed to update connection strategies:", error)
    return NextResponse.json({ error: "Failed to update strategies" }, { status: 500 })
  }
}
