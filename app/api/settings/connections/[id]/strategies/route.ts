import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getConnection } from "@/lib/redis-db"
import { applyMainConnectionSettingsChange } from "@/lib/connection-recoordinator"

/**
 * Per-connection strategy settings (Base / Main / Real channels).
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
 *   min_profit_factor → baseProfitFactor / mainProfitFactor / realProfitFactor
 *   max_drawdown_time (MINUTES) → maxDrawdownTime{Main,Real}Hours (÷60)
 *   max_positions → stageMinPosCount{Base,Main,Real}
 */

type StratRow = {
  strategy_type: "base" | "main" | "real"
  is_enabled: boolean
  min_profit_factor: number
  max_drawdown_time: number
  max_positions: number
}

const DEFAULTS: Record<StratRow["strategy_type"], Omit<StratRow, "strategy_type">> = {
  base: { is_enabled: true, min_profit_factor: 1.1, max_drawdown_time: 180, max_positions: 250 },
  main: { is_enabled: true, min_profit_factor: 1.15, max_drawdown_time: 180, max_positions: 250 },
  real: { is_enabled: true, min_profit_factor: 1.2, max_drawdown_time: 180, max_positions: 100 },
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
        is_enabled: typeof saved.is_enabled === "boolean" ? saved.is_enabled : d.is_enabled,
        min_profit_factor: Number(saved.min_profit_factor ?? d.min_profit_factor),
        max_drawdown_time: Number(saved.max_drawdown_time ?? d.max_drawdown_time),
        max_positions: Number(saved.max_positions ?? d.max_positions),
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
    const flat: Record<string, string> = {}

    for (const strat of strategies) {
      const type = strat.strategy_type
      if (type !== "base" && type !== "main" && type !== "real") continue
      const d = DEFAULTS[type]
      const pf = Number(strat.min_profit_factor ?? d.min_profit_factor)
      const ddtMin = Number(strat.max_drawdown_time ?? d.max_drawdown_time)
      const maxPos = Number(strat.max_positions ?? d.max_positions)

      channel[type] = {
        is_enabled: !!strat.is_enabled,
        min_profit_factor: pf,
        max_drawdown_time: ddtMin,
        max_positions: maxPos,
      }

      // Flatten into the coordinator-readable hash fields (same mapping as
      // the PATCH /settings route). DDT minutes → hours, clamp [1,72].
      if (Number.isFinite(pf) && pf > 0) {
        const pfStr = String(Math.max(0, Math.min(5, pf)))
        if (type === "base") flat.baseProfitFactor = pfStr
        if (type === "main") flat.mainProfitFactor = pfStr
        if (type === "real") flat.realProfitFactor = pfStr
      }
      if (Number.isFinite(ddtMin) && ddtMin > 0 && type !== "base") {
        const hrs = String(Math.max(1, Math.min(72, ddtMin / 60)))
        if (type === "main") flat.maxDrawdownTimeMainHours = hrs
        if (type === "real") flat.maxDrawdownTimeRealHours = hrs
      }
      if (Number.isFinite(maxPos) && maxPos > 0) {
        const posStr = String(Math.floor(maxPos))
        if (type === "base") flat.stageMinPosCountBase = posStr
        if (type === "main") flat.stageMinPosCountMain = posStr
        if (type === "real") flat.stageMinPosCountReal = posStr
      }
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

    return NextResponse.json({ success: true, strategies })
  } catch (error) {
    console.error("[v0] Failed to update connection strategies:", error)
    return NextResponse.json({ error: "Failed to update strategies" }, { status: 500 })
  }
}
