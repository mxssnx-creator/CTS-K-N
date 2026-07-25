import { NextResponse, type NextRequest } from "next/server"
import { initRedis } from "@/lib/redis-db"
import { query } from "@/lib/db"

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
  profit_factor_last_75: number
  
  // Time metrics
  avg_holding_time_min: number
  
  // Last 25 positions
  last_25_positions: PositionPnL[]
  last_25_pnl: number
  last_25_win_rate: number
}

export async function GET(request: NextRequest) {
  const startTime = Date.now()
  try {
    await initRedis()
    
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connection_id") || "bingx-x01"
    
    // Fetch closed positions from database
    const positions = await query<any>(
      `SELECT id, symbol, direction, entry_price, exit_price, quantity, 
              opened_at, closed_at, realized_pnl, realized_pnl_percent
       FROM positions WHERE connection_id = ? AND status = 'closed'
       ORDER BY closed_at DESC`,
      [connectionId]
    )
    
    if (!positions || positions.length === 0) {
      return NextResponse.json({
        success: true,
        stats: {
          total_positions: 0,
          closed_positions: 0,
          open_positions: 0,
          total_pnl: 0,
          total_pnl_percent: 0,
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
          profit_factor_last_75: 0,
          avg_holding_time_min: 0,
          last_25_positions: [],
          last_25_pnl: 0,
          last_25_win_rate: 0,
        },
        duration: Date.now() - startTime,
      } satisfies { success: boolean; stats: PnLStats; duration: number })
    }
    
    // Calculate comprehensive stats
    let totalPnL = 0
    let totalWinPnL = 0
    let totalLossPnL = 0
    let wins = 0
    let losses = 0
    let breakEven = 0
    let totalHoldingTime = 0
    let largestWin = -Infinity
    let largestLoss = Infinity
    
    const last25Positions: PositionPnL[] = []
    let last25PnL = 0
    let last25Wins = 0
    let last25GrossProfit = 0
    let last25GrossLoss = 0
    
    let last12GrossProfit = 0
    let last12GrossLoss = 0
    
    let last75GrossProfit = 0
    let last75GrossLoss = 0
    let validPositionIndex = 0
    
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i]
      if (!pos) continue // Skip null positions
      
      const pnl = parseFloat(String(pos.realized_pnl ?? 0))
      const pnlPercent = parseFloat(String(pos.realized_pnl_percent ?? 0))
      
      // Validate parsed values
      if (!isFinite(pnl) || !isFinite(pnlPercent)) continue
      
      totalPnL += pnl
      
      // Calculate holding time with error handling
      let holdingTimeMin = 0
      try {
        const openedAt = new Date(pos.opened_at).getTime()
        const closedAt = new Date(pos.closed_at).getTime()
        if (isFinite(openedAt) && isFinite(closedAt)) {
          holdingTimeMin = Math.max(0, Math.round((closedAt - openedAt) / 60000))
        }
      } catch {
        holdingTimeMin = 0
      }
      totalHoldingTime += holdingTimeMin
      
      // Track wins/losses
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
      
      // Last N positions tracking for profit factor
      if (validPositionIndex < 12) {
        if (pnl > 0) last12GrossProfit += pnl
        else if (pnl < 0) last12GrossLoss += Math.abs(pnl)
      }
      if (validPositionIndex < 25) {
        if (pnl > 0) { last25Wins++; last25GrossProfit += pnl }
        else if (pnl < 0) last25GrossLoss += Math.abs(pnl)
        const entryPrice = parseFloat(String(pos.entry_price ?? 0)) || 0
        const exitPrice = parseFloat(String(pos.exit_price ?? 0)) || 0
        const quantity = parseFloat(String(pos.quantity ?? 0)) || 0
        
        if (isFinite(entryPrice) && isFinite(exitPrice) && isFinite(quantity)) {
          last25Positions.push({
            id: pos.id || `unknown-${i}`,
            symbol: pos.symbol || "UNKNOWN",
            direction: pos.direction || "unknown",
            entry_price: entryPrice,
            exit_price: exitPrice,
            quantity,
            opened_at: pos.opened_at || new Date().toISOString(),
            closed_at: pos.closed_at || new Date().toISOString(),
            pnl,
            pnl_percent: pnlPercent,
            holding_time_min: holdingTimeMin,
          })
          last25PnL += pnl
        }
      }
      if (validPositionIndex < 75) {
        if (pnl > 0) last75GrossProfit += pnl
        else if (pnl < 0) last75GrossLoss += Math.abs(pnl)
      }
      validPositionIndex++
    }
    
    // Calculate derived metrics
    const totalTrades = wins + losses + breakEven
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0
    const last25WinRate = last25Positions.length > 0 ? (last25Wins / last25Positions.length) * 100 : 0
    const avgWin = wins > 0 ? totalWinPnL / wins : 0
    const avgLoss = losses > 0 ? totalLossPnL / losses : 0
    const finiteProfitFactor = (grossProfit: number, grossLoss: number) =>
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0
    const profitFactor = finiteProfitFactor(totalWinPnL, totalLossPnL)
    const profitFactorLast12 = finiteProfitFactor(last12GrossProfit, last12GrossLoss)
    const profitFactorLast25 = finiteProfitFactor(last25GrossProfit, last25GrossLoss)
    const profitFactorLast75 = finiteProfitFactor(last75GrossProfit, last75GrossLoss)
    const expectancy = totalTrades > 0 ? totalPnL / totalTrades : 0
    const avgHoldingTime = totalTrades > 0 ? Math.round(totalHoldingTime / totalTrades) : 0
    
    // Fetch open positions count
    const openPos = await query<any>(
      `SELECT COUNT(*) as count FROM positions WHERE connection_id = ? AND status = 'open'`,
      [connectionId]
    )
    const openPositionsCount = Math.max(0, Number(openPos?.[0]?.count) || 0)
    
    const stats: PnLStats = {
      total_positions: totalTrades,
      closed_positions: wins + losses + breakEven,
      open_positions: openPositionsCount,
      total_pnl: parseFloat(totalPnL.toFixed(8)),
      total_pnl_percent: totalTrades > 0 && (totalWinPnL + totalLossPnL) > 0 ? parseFloat(((totalPnL / (totalWinPnL + totalLossPnL)) * 100).toFixed(2)) : 0,
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
      profit_factor_last_75: parseFloat(profitFactorLast75.toFixed(2)),
      avg_holding_time_min: avgHoldingTime,
      last_25_positions: last25Positions,
      last_25_pnl: parseFloat(last25PnL.toFixed(8)),
      last_25_win_rate: parseFloat(last25WinRate.toFixed(2)),
    }
    
    return NextResponse.json({
      success: true,
      stats,
      duration: Date.now() - startTime,
    } satisfies { success: boolean; stats: PnLStats; duration: number })
  } catch (error) {
    console.error("[PnL Stats] Error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
