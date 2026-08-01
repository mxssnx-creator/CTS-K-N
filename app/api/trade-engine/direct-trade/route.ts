import { type NextRequest, NextResponse } from "next/server"
import { getSettings, setSettings, getRedisClient, initRedis } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

const DIRECT_TRADE_STATE_KEY = "direct_trade:state"
const DIRECT_TRADE_CONFIGS_KEY = "direct_trade:configs"
const DIRECT_TRADE_STATS_KEY = "direct_trade:stats"
const DIRECT_TRADE_POSITIONS_KEY = "direct_trade:positions"

export interface DirectTradeState {
  enabled: boolean
  liveMode: boolean
  startedAt: string | null
  lastRecalcAt: string | null
  recalcIntervalMs: number
  symbolCount: number
  symbolOrder: "volatility_1h" | "volume" | "volatility"
  minVolFactor: number
  maxSlRatio: number
  slRatioStep: number
  timeframes: ("1m" | "5m" | "10m")[]
  blockRange: [number, number]
  maxPositionsPerSymbol: number
  maxPositionsPerDirection: number
  processingIntervalMs: number
  // Evaluation settings (Pos Count for PF/DDT checks)
  keepEnabledPosCount: number     // Per symbol/direction/config: last N pos to check keep-enabled
  minProfitFactor: number         // Min PF to keep config enabled
  maxDrawdownTimeMin: number      // Max avg DDT to keep config enabled
  prevPosWindow: number           // Rolling window for overall PF/DDT eval
  prevPosMinCount: number         // Min positions before eval activates
  evalPosCount: number            // Coordination eval count
  trailingEnabled: boolean        // Trailing stop on/off
}

export interface DirectTradeStats {
  totalOrders: number
  totalFilled: number
  totalPnl: number
  winCount: number
  lossCount: number
  profitFactor: number
  maxDrawdownTimeMin: number
  currentDrawdownTimeMin: number
  lastPositionAt: string | null
  pnlHistory: { time: string; pnl: number; cumPnl: number }[]
  // Rolling windows
  last12Pos: { pf: number; ddt: number; pnl: number }
  last25Pos: { pf: number; ddt: number; pnl: number }
  last50Pos: { pf: number; ddt: number; pnl: number }
  last4h: { pf: number; ddt: number; pnl: number }
  last12h: { pf: number; ddt: number; pnl: number }
  last48h: { pf: number; ddt: number; pnl: number }
}

const DEFAULT_STATE: DirectTradeState = {
  enabled: false,
  liveMode: false,
  startedAt: null,
  lastRecalcAt: null,
  recalcIntervalMs: 2 * 60 * 60 * 1000, // 2 hours
  symbolCount: 8,
  symbolOrder: "volatility_1h",
  minVolFactor: 1,
  maxSlRatio: 1,
  slRatioStep: 0.25,
  timeframes: ["1m", "5m", "10m"],
  blockRange: [1, 12],
  maxPositionsPerSymbol: 3,
  maxPositionsPerDirection: 2,
  processingIntervalMs: 500,
  // Evaluation defaults
  keepEnabledPosCount: 8,
  minProfitFactor: 1.1,
  maxDrawdownTimeMin: 10,
  prevPosWindow: 25,
  prevPosMinCount: 5,
  evalPosCount: 12,
  trailingEnabled: true,
}

const DEFAULT_STATS: DirectTradeStats = {
  totalOrders: 0,
  totalFilled: 0,
  totalPnl: 0,
  winCount: 0,
  lossCount: 0,
  profitFactor: 0,
  maxDrawdownTimeMin: 0,
  currentDrawdownTimeMin: 0,
  lastPositionAt: null,
  pnlHistory: [],
  last12Pos: { pf: 0, ddt: 0, pnl: 0 },
  last25Pos: { pf: 0, ddt: 0, pnl: 0 },
  last50Pos: { pf: 0, ddt: 0, pnl: 0 },
  last4h: { pf: 0, ddt: 0, pnl: 0 },
  last12h: { pf: 0, ddt: 0, pnl: 0 },
  last48h: { pf: 0, ddt: 0, pnl: 0 },
}

async function getClient() {
  await initRedis()
  return getRedisClient()
}

async function getState(): Promise<DirectTradeState> {
  try {
    const client = await getClient()
    const raw = await client.get(DIRECT_TRADE_STATE_KEY)
    if (raw) return { ...DEFAULT_STATE, ...JSON.parse(raw) }
  } catch {}
  return { ...DEFAULT_STATE }
}

async function setState(state: DirectTradeState): Promise<void> {
  const client = await getClient()
  await client.set(DIRECT_TRADE_STATE_KEY, JSON.stringify(state))
}

async function getStats(): Promise<DirectTradeStats> {
  try {
    const client = await getClient()
    const raw = await client.get(DIRECT_TRADE_STATS_KEY)
    if (raw) return { ...DEFAULT_STATS, ...JSON.parse(raw) }
  } catch {}
  return { ...DEFAULT_STATS }
}

async function getConfigs(): Promise<any[]> {
  try {
    const client = await getClient()
    const raw = await client.get(DIRECT_TRADE_CONFIGS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return []
}

// GET: Return current state + stats + active configs
export async function GET() {
  try {
    const [state, stats, configs] = await Promise.all([
      getState(),
      getStats(),
      getConfigs(),
    ])
    return NextResponse.json({
      success: true,
      state,
      stats,
      activeConfigs: configs.length,
      configs: configs.slice(0, 50),
    })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to get direct-trade state", details: String(error) },
      { status: 500 },
    )
  }
}

// POST: Update state (enable/disable, live/simulated, config changes)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const currentState = await getState()

    // Handle actions
    if (body.action === "start") {
      const newState: DirectTradeState = {
        ...currentState,
        enabled: true,
        startedAt: currentState.startedAt || new Date().toISOString(),
        ...(body.liveMode !== undefined ? { liveMode: body.liveMode } : {}),
        ...(body.symbolCount ? { symbolCount: Math.min(20, Math.max(1, body.symbolCount)) } : {}),
        ...(body.symbolOrder ? { symbolOrder: body.symbolOrder } : {}),
        ...(body.minVolFactor ? { minVolFactor: Math.max(0.1, body.minVolFactor) } : {}),
        ...(body.maxSlRatio ? { maxSlRatio: Math.min(2, Math.max(0.5, body.maxSlRatio)) } : {}),
        ...(body.slRatioStep ? { slRatioStep: body.slRatioStep } : {}),
        ...(body.timeframes ? { timeframes: body.timeframes } : {}),
        ...(body.blockRange ? { blockRange: body.blockRange } : {}),
        ...(body.maxPositionsPerSymbol ? { maxPositionsPerSymbol: body.maxPositionsPerSymbol } : {}),
        ...(body.maxPositionsPerDirection ? { maxPositionsPerDirection: body.maxPositionsPerDirection } : {}),
      }
      await setState(newState)
      return NextResponse.json({ success: true, state: newState, message: "Direct-Trade started" })
    }

    if (body.action === "stop") {
      const newState: DirectTradeState = { ...currentState, enabled: false }
      await setState(newState)
      return NextResponse.json({ success: true, state: newState, message: "Direct-Trade stopped" })
    }

    if (body.action === "toggle-live") {
      const newState: DirectTradeState = {
        ...currentState,
        liveMode: body.liveMode !== undefined ? body.liveMode : !currentState.liveMode,
      }
      await setState(newState)
      return NextResponse.json({ success: true, state: newState, message: `Live mode ${newState.liveMode ? "enabled" : "disabled"}` })
    }

    if (body.action === "update-config") {
      const newState: DirectTradeState = {
        ...currentState,
        ...(body.symbolCount !== undefined ? { symbolCount: Math.min(20, Math.max(1, body.symbolCount)) } : {}),
        ...(body.symbolOrder !== undefined ? { symbolOrder: body.symbolOrder } : {}),
        ...(body.minVolFactor !== undefined ? { minVolFactor: Math.max(0.1, body.minVolFactor) } : {}),
        ...(body.maxSlRatio !== undefined ? { maxSlRatio: Math.min(2, Math.max(0.5, body.maxSlRatio)) } : {}),
        ...(body.slRatioStep !== undefined ? { slRatioStep: body.slRatioStep } : {}),
        ...(body.timeframes !== undefined ? { timeframes: body.timeframes } : {}),
        ...(body.blockRange !== undefined ? { blockRange: body.blockRange } : {}),
        ...(body.maxPositionsPerSymbol !== undefined ? { maxPositionsPerSymbol: body.maxPositionsPerSymbol } : {}),
        ...(body.maxPositionsPerDirection !== undefined ? { maxPositionsPerDirection: body.maxPositionsPerDirection } : {}),
        // Evaluation settings (instant effect on processor via loadState sync)
        ...(body.keepEnabledPosCount !== undefined ? { keepEnabledPosCount: Math.min(30, Math.max(3, body.keepEnabledPosCount)) } : {}),
        ...(body.minProfitFactor !== undefined ? { minProfitFactor: Math.max(0.5, Math.min(3.5, body.minProfitFactor)) } : {}),
        ...(body.maxDrawdownTimeMin !== undefined ? { maxDrawdownTimeMin: Math.max(1, Math.min(30, body.maxDrawdownTimeMin)) } : {}),
        ...(body.prevPosWindow !== undefined ? { prevPosWindow: Math.min(100, Math.max(5, body.prevPosWindow)) } : {}),
        ...(body.prevPosMinCount !== undefined ? { prevPosMinCount: Math.min(25, Math.max(1, body.prevPosMinCount)) } : {}),
        ...(body.evalPosCount !== undefined ? { evalPosCount: Math.min(50, Math.max(3, body.evalPosCount)) } : {}),
        ...(body.trailingEnabled !== undefined ? { trailingEnabled: body.trailingEnabled } : {}),
      }
      await setState(newState)
      return NextResponse.json({ success: true, state: newState, message: "Config updated" })
    }

    if (body.action === "reset-stats") {
      const client = await getClient()
      await client.set(DIRECT_TRADE_STATS_KEY, JSON.stringify(DEFAULT_STATS))
      return NextResponse.json({ success: true, message: "Stats reset" })
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to update direct-trade state", details: String(error) },
      { status: 500 },
    )
  }
}
