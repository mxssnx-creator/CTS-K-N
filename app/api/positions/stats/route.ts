import { NextResponse, type NextRequest } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { getSession } from "@/lib/auth"
import { logProgressionEvent } from "@/lib/engine-progression-logs"

export const dynamic = "force-dynamic"

/**
 * GET /api/positions/stats - Get comprehensive position statistics
 * Query params: connection_id, status
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now()
  try {
    let user = null
    try {
      user = await getSession()
    } catch {
      // Auth may not be configured yet - continue with empty stats
    }

    await initRedis()
    const client = getRedisClient()
    
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connection_id")
    const statusFilter = searchParams.get("status") || "all"

    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connection_id required" }, { status: 400 })
    }

    // Fetch all positions for this connection
    const positionIds = await client.smembers(`positions:${connectionId}`)
    
    if (!positionIds || positionIds.length === 0) {
      return NextResponse.json({
        success: true,
        stats: {
          total_positions: 0,
          open_positions: 0,
          closed_positions: 0,
          total_pnl: 0,
          total_pnl_percent: 0,
          win_count: 0,
          loss_count: 0,
          win_rate: 0,
          avg_win: 0,
          avg_loss: 0,
          largest_win: 0,
          largest_loss: 0,
          avg_holding_time_hours: 0,
        },
        duration: Date.now() - startTime,
      })
    }

    // Batch fetch and calculate stats
    let totalPositions = 0
    let openPositions = 0
    let closedPositions = 0
    let totalPnL = 0
    let winCount = 0
    let lossCount = 0
    let winSum = 0
    let lossSum = 0
    let largestWin = -Infinity
    let largestLoss = Infinity
    let totalHoldingTime = 0

    for (const posId of positionIds) {
      const pos = await client.hgetall(`position:${connectionId}:${posId}`)
      if (!pos || Object.keys(pos).length === 0) continue

      // Apply status filter
      if (statusFilter !== "all" && pos.status !== statusFilter) continue

      totalPositions++
      
      if (pos.status === "open") {
        openPositions++
      } else if (pos.status === "closed") {
        closedPositions++
        
        // Calculate PnL stats for closed positions
        const finalPnL = parseFloat(pos.final_pnl || "0")
        totalPnL += finalPnL
        
        if (finalPnL > 0) {
          winCount++
          winSum += finalPnL
          largestWin = Math.max(largestWin, finalPnL)
        } else if (finalPnL < 0) {
          lossCount++
          lossSum += Math.abs(finalPnL)
          largestLoss = Math.min(largestLoss, finalPnL)
        }
        
        // Calculate holding time
        if (pos.opened_at && pos.closed_at) {
          const openTime = new Date(pos.opened_at).getTime()
          const closeTime = new Date(pos.closed_at).getTime()
          totalHoldingTime += closeTime - openTime
        }
      }
    }

    const winRate = totalPositions > 0 ? (winCount / totalPositions) * 100 : 0
    const avgWin = winCount > 0 ? winSum / winCount : 0
    const avgLoss = lossCount > 0 ? lossSum / lossCount : 0
    const avgHoldingTimeHours = closedPositions > 0 ? totalHoldingTime / closedPositions / (1000 * 60 * 60) : 0

    const stats = {
      total_positions: totalPositions,
      open_positions: openPositions,
      closed_positions: closedPositions,
      total_pnl: parseFloat(totalPnL.toFixed(2)),
      total_pnl_percent: winCount + lossCount > 0 ? parseFloat(((winCount - lossCount) / (winCount + lossCount) * 100).toFixed(2)) : 0,
      win_count: winCount,
      loss_count: lossCount,
      win_rate: parseFloat(winRate.toFixed(2)),
      avg_win: parseFloat(avgWin.toFixed(2)),
      avg_loss: parseFloat(Math.abs(avgLoss).toFixed(2)),
      largest_win: isFinite(largestWin) ? parseFloat(largestWin.toFixed(2)) : 0,
      largest_loss: isFinite(largestLoss) ? parseFloat(largestLoss.toFixed(2)) : 0,
      avg_holding_time_hours: parseFloat(avgHoldingTimeHours.toFixed(2)),
    }

    await logProgressionEvent(
      connectionId,
      "positions_stats",
      "info",
      `Generated stats for ${totalPositions} positions`,
      { stats, statusFilter }
    )

    return NextResponse.json({
      success: true,
      stats,
      duration: Date.now() - startTime,
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error("[v0] [PositionsStatsAPI] error:", errorMsg)

    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch position stats",
        details: process.env.NODE_ENV === "development" ? errorMsg : undefined,
      },
      { status: 500 }
    )
  }
}
