import { NextResponse } from "next/server"
import { getAllConnections, initRedis } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { getProgressionLogs } from "@/lib/engine-progression-logs"
import {
  hasConnectionCredentials,
  isConnectionDashboardEnabled,
  isConnectionLiveTradeEnabled,
} from "@/lib/connection-state-utils"
import { getLiveExecutionSummary } from "@/lib/live-execution-summary"

export const dynamic = "force-dynamic"


export async function GET() {
  try {
    await initRedis()
    const connections = await getAllConnections()

    const items = await Promise.all(
      connections.map(async (connection: any) => {
        const [execution, progression, logs] = await Promise.all([
          getLiveExecutionSummary(connection.id),
          ProgressionStateManager.getProgressionState(connection.id),
          getProgressionLogs(connection.id),
        ])

        return {
          connectionId: connection.id,
          connectionName: connection.name || connection.exchange || connection.id,
          exchange: connection.exchange || "unknown",
          activePositions: execution.openPositions,
          activeSymbols: execution.openSymbols,
          openOrders: execution.openOrders,
          openOrderSymbols: execution.openOrderSymbols,
          entryOrders: execution.entryOrders,
          controlOrders: execution.controlOrders,
          positionsDataAvailable: execution.positionsDataAvailable,
          ordersDataAvailable: execution.ordersDataAvailable,
          positionsSnapshotError: execution.positionsSnapshotError,
          ordersSnapshotError: execution.ordersSnapshotError,
          excludedUntrackedPositions: execution.excludedUntrackedPositions,
          excludedUntrackedOrders: execution.excludedUntrackedOrders,
          exchangeSnapshot: execution.exchange,
          closedPositions: execution.closedPositions,
          totalVolume: execution.lifetimeVolumeUsd,
          profit: execution.effectivePnl,
          realizedProfit: execution.realizedPnl,
          unrealizedProfit: execution.unrealizedPnl,
          winRate: execution.winRate,
          wins: execution.wins,
          losses: execution.losses,
          breakEven: execution.breakEven,
          accountingPending: execution.accountingPending,
          accountingComplete: execution.complete,
          sourceCounts: execution.sourceCounts,
          statisticsAvailable: execution.totalPositions > 0,
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
        totalActiveSymbols: items.reduce((sum, item) => sum + item.activeSymbols, 0),
        totalOpenOrders: items.reduce((sum, item) => sum + item.openOrders, 0),
        totalEntryOrders: items.reduce((sum, item) => sum + item.entryOrders, 0),
        totalControlOrders: items.reduce((sum, item) => sum + item.controlOrders, 0),
        positionsDataAvailable: items.length > 0 && items.every((item) => item.positionsDataAvailable),
        ordersDataAvailable: items.length > 0 && items.every((item) => item.ordersDataAvailable),
        totalExcludedUntrackedPositions: items.reduce((sum, item) => sum + item.excludedUntrackedPositions, 0),
        totalExcludedUntrackedOrders: items.reduce((sum, item) => sum + item.excludedUntrackedOrders, 0),
        totalClosedPositions: items.reduce((sum, item) => sum + item.closedPositions, 0),
        totalProfit: items.reduce((sum, item) => sum + item.profit, 0),
        exchangeScope: "cts_tracked_only",
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
