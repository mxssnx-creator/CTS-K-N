import { NextResponse, type NextRequest } from "next/server"
import { initRedis } from "@/lib/redis-db"
import {
  getClosedLivePositions,
  getLivePositions,
} from "@/lib/trade-engine/stages/live-stage"
import {
  derivePositionRoi,
  resolvePositionMargin,
  resolveSettledRealizedPnl,
  resolveUnrealizedPnl,
} from "@/lib/live-position-pnl"
import { isLiveOpenStatus } from "@/lib/live-position-status"
import { isRealExchangePosition } from "@/lib/live-position-source"

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
  pnl: number | null
  pnl_percent: number | null
  holding_time_min: number
  accounting_status: "settled" | "pending"
  accounting_source: string | null
}

interface PnLStats {
  // Overall metrics
  total_positions: number
  closed_positions: number
  settled_closed_positions: number
  accounting_pending: number
  accounting_complete: boolean
  accounting_coverage_percent: number
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
  profit_factor: number | null
  profit_factor_infinite: boolean
  expectancy: number
  
  // Last N profit factors
  profit_factor_last_12: number | null
  profit_factor_last_12_infinite: boolean
  profit_factor_last_25: number | null
  profit_factor_last_25_infinite: boolean
  profit_factor_last_50: number | null
  profit_factor_last_50_infinite: boolean
  profit_factor_last_75: number | null
  profit_factor_last_75_infinite: boolean
  
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
  analytics_history_limit: number
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
const CLOSED_ANALYTICS_LIMIT = 75

function firstFinite(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || typeof value === "boolean") continue
    if (typeof value === "string" && value.trim() === "") continue
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function timestampOf(value: unknown): number {
  if (
    typeof value === "number" ||
    (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))
  ) {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 10_000_000_000 ? numeric * 1000 : numeric
    }
  }
  const parsed = new Date(String(value || "")).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function closedAtOf(position: any): string {
  return String(position?.closedAt || position?.closed_at || position?.updatedAt || position?.updated_at || "")
}

function openedAtOf(position: any): string {
  return String(position?.createdAt || position?.openedAt || position?.opened_at || position?.created_at || "")
}

function toPositionPnl(
  position: any,
  pnl: number | null,
  pnlPercent: number | null,
  holdingTimeMin: number,
): PositionPnL {
  const pending = pnl === null
  return {
    id: String(position?.id || "unknown"),
    symbol: String(position?.symbol || "UNKNOWN"),
    direction: String(position?.direction || position?.side || "unknown"),
    entry_price: firstFinite(position?.averageExecutionPrice, position?.entryPrice, position?.entry_price) ?? 0,
    exit_price: firstFinite(position?.closePrice, position?.exitPrice, position?.exit_price) ?? 0,
    quantity: firstFinite(
      position?.totalExecutedQuantity,
      position?.executedQuantity,
      position?.quantity,
      position?.executed_quantity,
    ) ?? 0,
    opened_at: openedAtOf(position),
    closed_at: closedAtOf(position),
    pnl,
    pnl_percent: pnlPercent,
    holding_time_min: holdingTimeMin,
    accounting_status: pending ? "pending" : "settled",
    accounting_source: String(
      position?.realizedPnlSource ?? position?.pnlAccountingSource ?? "",
    ).trim() || null,
  }
}

function profitFactorMetrics(grossProfit: number, grossLoss: number): {
  value: number | null
  infinite: boolean
} {
  return {
    value: grossLoss > 0 ? grossProfit / grossLoss : null,
    infinite: grossLoss === 0 && grossProfit > 0,
  }
}

function roundedProfitFactor(value: number | null): number | null {
  return value === null ? null : parseFloat(value.toFixed(2))
}

function emptyStats(): PnLStats {
  return {
    total_positions: 0,
    closed_positions: 0,
    settled_closed_positions: 0,
    accounting_pending: 0,
    accounting_complete: true,
    accounting_coverage_percent: 100,
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
    profit_factor: null,
    profit_factor_infinite: false,
    expectancy: 0,
    profit_factor_last_12: null,
    profit_factor_last_12_infinite: false,
    profit_factor_last_25: null,
    profit_factor_last_25_infinite: false,
    profit_factor_last_50: null,
    profit_factor_last_50_infinite: false,
    profit_factor_last_75: null,
    profit_factor_last_75_infinite: false,
    avg_holding_time_min: 0,
    last_25_positions: [],
    last_25_pnl: 0,
    last_25_win_rate: 0,
    last_50_positions: [],
    last_50_pnl: 0,
    last_50_win_rate: 0,
    source: "live_position_ledger",
    history_limit: CLOSED_HISTORY_LIMIT,
    analytics_history_limit: CLOSED_ANALYTICS_LIMIT,
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
      getClosedLivePositions(connectionId, CLOSED_ANALYTICS_LIMIT),
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

    const closedHistory = positions
      .filter((position) => String(position?.status || "").toLowerCase() === "closed")
      .sort((left, right) => timestampOf(closedAtOf(right)) - timestampOf(closedAtOf(left)))
    const closedPositions = closedHistory.slice(0, CLOSED_HISTORY_LIMIT)
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
    
    const displayRows: PositionPnL[] = []
    let accountingPending = 0
    let last25PnL = 0
    let last25Wins = 0
    let last25Decisive = 0
    let last25GrossProfit = 0
    let last25GrossLoss = 0
    let last50PnL = 0
    let last50Wins = 0
    let last50Decisive = 0
    let last50GrossProfit = 0
    let last50GrossLoss = 0
    
    let last12GrossProfit = 0
    let last12GrossLoss = 0
    
    let last75GrossProfit = 0
    let last75GrossLoss = 0
    for (const [closedIndex, pos] of closedPositions.entries()) {
      const openedAt = timestampOf(openedAtOf(pos))
      const closedAt = timestampOf(closedAtOf(pos))
      const holdingTimeMin = openedAt > 0 && closedAt >= openedAt
        ? Math.round((closedAt - openedAt) / 60_000)
        : 0
      const pnl = resolveSettledRealizedPnl(pos)
      if (pnl === undefined) {
        accountingPending++
        if (displayRows.length < CLOSED_HISTORY_LIMIT) {
          displayRows.push(toPositionPnl(pos, null, null, holdingTimeMin))
        }
        continue
      }
      const pnlPercent = derivePositionRoi(pos, pnl, true) ?? firstFinite(
        pos?.realizedRoi,
        pos?.realized_pnl_percent,
        pos?.realizedPnLPercent,
      ) ?? null
      const margin = resolvePositionMargin(pos, true)
      const settledRow = toPositionPnl(pos, pnl, pnlPercent, holdingTimeMin)
      if (displayRows.length < CLOSED_HISTORY_LIMIT) displayRows.push(settledRow)

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

      if (closedIndex < 12) {
        if (pnl > 0) last12GrossProfit += pnl
        else if (pnl < 0) last12GrossLoss += Math.abs(pnl)
      }
      if (closedIndex < 25) {
        if (pnl > 0) { last25Wins++; last25Decisive++; last25GrossProfit += pnl }
        else if (pnl < 0) { last25Decisive++; last25GrossLoss += Math.abs(pnl) }
        last25PnL += pnl
      }
      if (closedIndex < 50) {
        if (pnl > 0) { last50Wins++; last50Decisive++; last50GrossProfit += pnl }
        else if (pnl < 0) { last50Decisive++; last50GrossLoss += Math.abs(pnl) }
        last50PnL += pnl
      }
    }

    // The operational overview intentionally stays capped at 50 terminal
    // positions. The compatibility PF75 field has its own 75-row source so it
    // is not a mislabeled copy of PF50. Pending venue settlements remain in
    // the time window but are excluded from gross-profit/loss accounting.
    for (const pos of closedHistory.slice(0, CLOSED_ANALYTICS_LIMIT)) {
      const pnl = resolveSettledRealizedPnl(pos)
      if (pnl === undefined) continue
      if (pnl > 0) last75GrossProfit += pnl
      else if (pnl < 0) last75GrossLoss += Math.abs(pnl)
    }

    for (const pos of openPositions) {
      const pnl = resolveUnrealizedPnl(pos)
      if (pnl !== undefined && Number.isFinite(pnl)) unrealizedPnl += pnl
      const margin = resolvePositionMargin(pos)
      if (margin !== undefined) totalMargin += margin
    }

    const totalTrades = wins + losses + breakEven
    const decisiveTrades = wins + losses
    const winRate = decisiveTrades > 0 ? (wins / decisiveTrades) * 100 : 0
    const last25WinRate = last25Decisive > 0 ? (last25Wins / last25Decisive) * 100 : 0
    const last50WinRate = last50Decisive > 0 ? (last50Wins / last50Decisive) * 100 : 0
    const avgWin = wins > 0 ? totalWinPnL / wins : 0
    const avgLoss = losses > 0 ? totalLossPnL / losses : 0
    const profitFactor = profitFactorMetrics(totalWinPnL, totalLossPnL)
    const profitFactorLast12 = profitFactorMetrics(last12GrossProfit, last12GrossLoss)
    const profitFactorLast25 = profitFactorMetrics(last25GrossProfit, last25GrossLoss)
    const profitFactorLast50 = profitFactorMetrics(last50GrossProfit, last50GrossLoss)
    const profitFactorLast75 = profitFactorMetrics(last75GrossProfit, last75GrossLoss)
    const effectivePnl = realizedPnl + unrealizedPnl
    const expectancy = totalTrades > 0 ? realizedPnl / totalTrades : 0
    const avgHoldingTime = totalTrades > 0 ? Math.round(totalHoldingTime / totalTrades) : 0
    const accountingCoveragePercent = closedPositions.length > 0
      ? (totalTrades / closedPositions.length) * 100
      : 100

    const stats: PnLStats = {
      total_positions: closedPositions.length + openPositions.length,
      closed_positions: closedPositions.length,
      settled_closed_positions: totalTrades,
      accounting_pending: accountingPending,
      accounting_complete: accountingPending === 0,
      accounting_coverage_percent: parseFloat(accountingCoveragePercent.toFixed(2)),
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
      profit_factor: roundedProfitFactor(profitFactor.value),
      profit_factor_infinite: profitFactor.infinite,
      expectancy: parseFloat(expectancy.toFixed(8)),
      profit_factor_last_12: roundedProfitFactor(profitFactorLast12.value),
      profit_factor_last_12_infinite: profitFactorLast12.infinite,
      profit_factor_last_25: roundedProfitFactor(profitFactorLast25.value),
      profit_factor_last_25_infinite: profitFactorLast25.infinite,
      profit_factor_last_50: roundedProfitFactor(profitFactorLast50.value),
      profit_factor_last_50_infinite: profitFactorLast50.infinite,
      profit_factor_last_75: roundedProfitFactor(profitFactorLast75.value),
      profit_factor_last_75_infinite: profitFactorLast75.infinite,
      avg_holding_time_min: avgHoldingTime,
      last_25_positions: displayRows.slice(0, 25),
      last_25_pnl: parseFloat(last25PnL.toFixed(8)),
      last_25_win_rate: parseFloat(last25WinRate.toFixed(2)),
      last_50_positions: displayRows,
      last_50_pnl: parseFloat(last50PnL.toFixed(8)),
      last_50_win_rate: parseFloat(last50WinRate.toFixed(2)),
      source: "live_position_ledger",
      history_limit: CLOSED_HISTORY_LIMIT,
      analytics_history_limit: CLOSED_ANALYTICS_LIMIT,
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
