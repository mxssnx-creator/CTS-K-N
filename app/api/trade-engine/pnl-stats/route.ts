import { NextResponse, type NextRequest } from "next/server"
import { initRedis } from "@/lib/redis-db"
import {
  getClosedLivePositions,
  getLivePositions,
} from "@/lib/trade-engine/stages/live-stage"
import {
  derivePositionRoi,
  resolvePositionMargin,
  resolveRealizedPnl,
  resolveUnrealizedPnl,
} from "@/lib/live-position-pnl"
import { isLiveOpenStatus } from "@/lib/live-position-status"

export const dynamic = "force-dynamic"

interface PositionPnL {
  id: string
  symbol: string
  direction: string
  entry_price: number
  exit_price: number
  quantity: number
  opened_at: string
  closed_at: string
  pnl: number
  pnl_percent: number
  holding_time_min: number
}

interface PnLStats {
  // Overall metrics
  total_positions: number
  closed_positions: number
  open_positions: number
  total_pnl: number
  total_pnl_percent: number
  realized_pnl: number
  unrealized_pnl: number
  total_margin: number
  
  // Win/Loss metrics
  wins: number
  losses: number
  break_even: number
  win_rate: number
  
  // Trade metrics
  avg_win: number
  avg_loss: number
  largest_win: number
  largest_loss: number
  profit_factor: number
  expectancy: number
  
  // Last N profit factors
  profit_factor_last_12: number
  profit_factor_last_25: number
  profit_factor_last_50: number
  profit_factor_last_75: number
  
  // Time metrics
  avg_holding_time_min: number
  
  // Last 25 positions
  last_25_positions: PositionPnL[]
  last_25_pnl: number
  last_25_win_rate: number
  last_50_positions: PositionPnL[]
  last_50_pnl: number
  last_50_win_rate: number
  source: "live_position_ledger"
  history_limit: number
}

interface PnLStatsSuccessResponse {
  success: true
  connectionId: string
  stats: PnLStats
  duration: number
}

// Operator contract: live PnL/PF is based only on the latest 50 real exchange
// positions. Older rows remain in Redis for audit/history but cannot distort
// the operational dashboard.
const CLOSED_HISTORY_LIMIT = 50

function firstFinite(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function timestampOf(value: unknown): number {
  const parsed = new Date(String(value || "")).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function closedAtOf(position: any): string {
  return String(position?.closedAt || position?.closed_at || position?.updatedAt || position?.updated_at || "")
}

function openedAtOf(position: any): string {
  return String(position?.createdAt || position?.openedAt || position?.opened_at || position?.created_at || "")
}

function isRealExchangePosition(position: any): boolean {
  if (String(position?.status || "").toLowerCase() === "simulated") return false
  if (String(position?.executionMode || "").toLowerCase() === "simulation") return false
  const exchange = position?.exchangeData || {}
  return Boolean(
    position?.orderId
    || position?.exchangeOrderId
    || exchange?.orderId
    || exchange?.exchangeOrderId
    || exchange?.exchangePositionId,
  )
}

function toPositionPnl(
  position: any,
  pnl: number,
  pnlPercent: number,
  holdingTimeMin: number,
): PositionPnL {
  return {
    id: String(position?.id || "unknown"),
    symbol: String(position?.symbol || "UNKNOWN"),
    direction: String(position?.direction || position?.side || "unknown"),
    entry_price: firstFinite(position?.averageExecutionPrice, position?.entryPrice, position?.entry_price),
    exit_price: firstFinite(position?.closePrice, position?.exitPrice, position?.exit_price),
    quantity: firstFinite(
      position?.totalExecutedQuantity,
      position?.executedQuantity,
      position?.quantity,
      position?.executed_quantity,
    ),
    opened_at: openedAtOf(position),
    closed_at: closedAtOf(position),
    pnl,
    pnl_percent: pnlPercent,
    holding_time_min: holdingTimeMin,
  }
}

function finiteProfitFactor(grossProfit: number, grossLoss: number): number {
  return grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0
}

function emptyStats(): PnLStats {
  return {
    total_positions: 0,
    closed_positions: 0,
    open_positions: 0,
    total_pnl: 0,
    total_pnl_percent: 0,
    realized_pnl: 0,
    unrealized_pnl: 0,
    total_margin: 0,
    wins: 0,
    losses: 0,
    break_even: 0,
    win_rate: 0,
    avg_win: 0,
    avg_loss: 0,
    largest_win: 0,
    largest_loss: 0,
    profit_factor: 0,
    expectancy: 0,
    profit_factor_last_12: 0,
    profit_factor_last_25: 0,
    profit_factor_last_50: 0,
    profit_factor_last_75: 0,
    avg_holding_time_min: 0,
    last_25_positions: [],
    last_25_pnl: 0,
    last_25_win_rate: 0,
    last_50_positions: [],
    last_50_pnl: 0,
    last_50_win_rate: 0,
    source: "live_position_ledger",
    history_limit: CLOSED_HISTORY_LIMIT,
  }
}

export async function GET(request: NextRequest) {
  const startTime = Date.now()
  try {
    await initRedis()

    const { searchParams } = new URL(request.url)
    const connectionId = String(
      searchParams.get("connection_id") || searchParams.get("connectionId") || "",
    ).trim()
    if (!connectionId) {
      return NextResponse.json(
        { success: false, error: "connection_id query parameter required" },
        { status: 400 },
      )
    }

    // The SQL compatibility shim cannot accurately execute a connection-wide
    // `WHERE connection_id = ?` query; it treats the parameter as a record id.
    // Read the canonical Redis lifecycle ledgers instead, which also includes
    // current open positions and therefore keeps realised and live PnL on the
    // same authoritative calculation path.
    const [openLedger, closedLedger] = await Promise.all([
      getLivePositions(connectionId),
      getClosedLivePositions(connectionId, CLOSED_HISTORY_LIMIT),
    ])

    const byId = new Map<string, any>()
    for (const position of closedLedger) {
      const id = String(position?.id || "")
      if (id) byId.set(id, position)
    }
    for (const position of openLedger) {
      const id = String(position?.id || "")
      if (id) byId.set(id, position)
    }

    const positions = [...byId.values()].filter(isRealExchangePosition)
    if (positions.length === 0) {
      const response: PnLStatsSuccessResponse = {
        success: true,
        connectionId,
        stats: emptyStats(),
        duration: Date.now() - startTime,
      }
      return NextResponse.json<PnLStatsSuccessResponse>(response)
    }

    const closedPositions = positions
      .filter((position) => String(position?.status || "").toLowerCase() === "closed")
      .sort((left, right) => timestampOf(closedAtOf(right)) - timestampOf(closedAtOf(left)))
    const openPositions = positions.filter((position) => isLiveOpenStatus(position?.status))

    let realizedPnl = 0
    let unrealizedPnl = 0
    let totalMargin = 0
    let totalWinPnL = 0
    let totalLossPnL = 0
    let wins = 0
    let losses = 0
    let breakEven = 0
    let totalHoldingTime = 0
    let largestWin = -Infinity
    let largestLoss = Infinity
    
    const closedRows: PositionPnL[] = []
    let last25PnL = 0
    let last25Wins = 0
    let last25GrossProfit = 0
    let last25GrossLoss = 0
    let last50PnL = 0
    let last50Wins = 0
    let last50GrossProfit = 0
    let last50GrossLoss = 0
    
    let last12GrossProfit = 0
    let last12GrossLoss = 0
    
    let last75GrossProfit = 0
    let last75GrossLoss = 0
    for (let i = 0; i < closedPositions.length; i++) {
      const pos = closedPositions[i]
      const pnl = resolveRealizedPnl(pos)
      if (pnl === undefined || !Number.isFinite(pnl)) continue
      const openedAt = timestampOf(openedAtOf(pos))
      const closedAt = timestampOf(closedAtOf(pos))
      const holdingTimeMin = openedAt > 0 && closedAt >= openedAt
        ? Math.round((closedAt - openedAt) / 60_000)
        : 0
      const pnlPercent = derivePositionRoi(pos, pnl, true) ?? firstFinite(
        pos?.realizedRoi,
        pos?.realized_pnl_percent,
        pos?.realizedPnLPercent,
      )
      const margin = resolvePositionMargin(pos, true)

      realizedPnl += pnl
      if (margin !== undefined) totalMargin += margin
      totalHoldingTime += holdingTimeMin

      if (pnl > 0) {
        wins++
        totalWinPnL += pnl
        largestWin = Math.max(largestWin, pnl)
      } else if (pnl < 0) {
        losses++
        totalLossPnL += Math.abs(pnl)
        largestLoss = Math.min(largestLoss, pnl)
      } else {
        breakEven++
      }

      if (i < 12) {
        if (pnl > 0) last12GrossProfit += pnl
        else if (pnl < 0) last12GrossLoss += Math.abs(pnl)
      }
      if (i < 25) {
        if (pnl > 0) { last25Wins++; last25GrossProfit += pnl }
        else if (pnl < 0) last25GrossLoss += Math.abs(pnl)
        last25PnL += pnl
      }
      if (i < 50) {
        if (pnl > 0) { last50Wins++; last50GrossProfit += pnl }
        else if (pnl < 0) last50GrossLoss += Math.abs(pnl)
        closedRows.push(toPositionPnl(pos, pnl, pnlPercent, holdingTimeMin))
        last50PnL += pnl
      }
      if (i < 75) {
        if (pnl > 0) last75GrossProfit += pnl
        else if (pnl < 0) last75GrossLoss += Math.abs(pnl)
      }
    }

    for (const pos of openPositions) {
      const pnl = resolveUnrealizedPnl(pos)
      if (pnl !== undefined && Number.isFinite(pnl)) unrealizedPnl += pnl
      const margin = resolvePositionMargin(pos)
      if (margin !== undefined) totalMargin += margin
    }

    const totalTrades = wins + losses + breakEven
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0
    const last25Count = Math.min(25, closedRows.length)
    const last25WinRate = last25Count > 0 ? (last25Wins / last25Count) * 100 : 0
    const last50WinRate = closedRows.length > 0 ? (last50Wins / closedRows.length) * 100 : 0
    const avgWin = wins > 0 ? totalWinPnL / wins : 0
    const avgLoss = losses > 0 ? totalLossPnL / losses : 0
    const profitFactor = finiteProfitFactor(totalWinPnL, totalLossPnL)
    const profitFactorLast12 = finiteProfitFactor(last12GrossProfit, last12GrossLoss)
    const profitFactorLast25 = finiteProfitFactor(last25GrossProfit, last25GrossLoss)
    const profitFactorLast50 = finiteProfitFactor(last50GrossProfit, last50GrossLoss)
    const profitFactorLast75 = finiteProfitFactor(last75GrossProfit, last75GrossLoss)
    const effectivePnl = realizedPnl + unrealizedPnl
    const expectancy = totalTrades > 0 ? realizedPnl / totalTrades : 0
    const avgHoldingTime = totalTrades > 0 ? Math.round(totalHoldingTime / totalTrades) : 0

    const stats: PnLStats = {
      total_positions: totalTrades + openPositions.length,
      closed_positions: totalTrades,
      open_positions: openPositions.length,
      total_pnl: parseFloat(effectivePnl.toFixed(8)),
      total_pnl_percent: totalMargin > 0 ? parseFloat(((effectivePnl / totalMargin) * 100).toFixed(2)) : 0,
      realized_pnl: parseFloat(realizedPnl.toFixed(8)),
      unrealized_pnl: parseFloat(unrealizedPnl.toFixed(8)),
      total_margin: parseFloat(totalMargin.toFixed(8)),
      wins,
      losses,
      break_even: breakEven,
      win_rate: parseFloat(winRate.toFixed(2)),
      avg_win: parseFloat(avgWin.toFixed(8)),
      avg_loss: parseFloat(avgLoss.toFixed(8)),
      largest_win: largestWin === -Infinity ? 0 : parseFloat(largestWin.toFixed(8)),
      largest_loss: largestLoss === Infinity ? 0 : parseFloat(largestLoss.toFixed(8)),
      profit_factor: parseFloat(profitFactor.toFixed(2)),
      expectancy: parseFloat(expectancy.toFixed(8)),
      profit_factor_last_12: parseFloat(profitFactorLast12.toFixed(2)),
      profit_factor_last_25: parseFloat(profitFactorLast25.toFixed(2)),
      profit_factor_last_50: parseFloat(profitFactorLast50.toFixed(2)),
      profit_factor_last_75: parseFloat(profitFactorLast75.toFixed(2)),
      avg_holding_time_min: avgHoldingTime,
      last_25_positions: closedRows.slice(0, 25),
      last_25_pnl: parseFloat(last25PnL.toFixed(8)),
      last_25_win_rate: parseFloat(last25WinRate.toFixed(2)),
      last_50_positions: closedRows,
      last_50_pnl: parseFloat(last50PnL.toFixed(8)),
      last_50_win_rate: parseFloat(last50WinRate.toFixed(2)),
      source: "live_position_ledger",
      history_limit: CLOSED_HISTORY_LIMIT,
    }
    
    const response: PnLStatsSuccessResponse = {
      success: true,
      connectionId,
      stats,
      duration: Date.now() - startTime,
    }
    return NextResponse.json<PnLStatsSuccessResponse>(response)
  } catch (error) {
    console.error("[PnL Stats] Error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
