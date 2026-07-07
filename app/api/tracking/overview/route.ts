import { NextResponse } from "next/server"
import { getAllConnections, getConnectionPositions, getConnectionTrades, initRedis } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { getProgressionLogs } from "@/lib/engine-progression-logs"
import {
  hasConnectionCredentials,
  isConnectionDashboardEnabled,
  isConnectionLiveTradeEnabled,
  isOpenPosition,
} from "@/lib/connection-state-utils"

export const dynamic = "force-dynamic"


export async function GET() {
  try {
    await initRedis()
    const connections = await getAllConnections()

    const items = await Promise.all(
      connections.map(async (connection: any) => {
        const [positions, trades, progression, logs] = await Promise.all([
          getConnectionPositions(connection.id),
          getConnectionTrades(connection.id),
          ProgressionStateManager.getProgressionState(connection.id),
          getProgressionLogs(connection.id),
        ])

        const activePositions = positions.filter(isOpenPosition)
        const closedPositions = positions.filter((position) => !isOpenPosition(position))
        const totalVolume = positions.reduce((sum, position) => sum + Number(position.size || position.volume || 0), 0)
        const profit = positions.reduce((sum, position) => sum + Number(position.profit_loss || position.pnl || 0), 0)
        const winRate = trades.length > 0
          ? (trades.filter((trade) => Number(trade.profit_loss || trade.pnl || 0) > 0).length / trades.length) * 100
          : 0

        return {
          connectionId: connection.id,
          connectionName: connection.name || connection.exchange || connection.id,
          exchange: connection.exchange || "unknown",
          activePositions: activePositions.length,
          closedPositions: closedPositions.length,
          totalVolume,
          profit,
          winRate,
          progression,
          logs: logs.slice(0, 10),
          hasCredentials: hasConnectionCredentials(connection, 10),
          dashboardEnabled: isConnectionDashboardEnabled(connection),
          liveTradeEnabled: isConnectionLiveTradeEnabled(connection),
          lastUpdate: progression.lastUpdate?.toISOString?.() || new Date().toISOString(),
        }
      }),
    )

    return NextResponse.json({
      success: true,
      items,
      summary: {
        totalConnections: items.length,
        activeConnections: items.filter((item) => item.dashboardEnabled).length,
        totalActivePositions: items.reduce((sum, item) => sum + item.activePositions, 0),
        totalClosedPositions: items.reduce((sum, item) => sum + item.closedPositions, 0),
        totalProfit: items.reduce((sum, item) => sum + item.profit, 0),
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load tracking overview",
        items: [],
      },
      { status: 500 },
    )
  }
}
