import { NextResponse, type NextRequest } from "next/server"
import { getAllConnections, initRedis } from "@/lib/redis-db"
import { getLiveExecutionSummary, type LiveExecutionSummary } from "@/lib/live-execution-summary"

export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

function weightedAverage(
  summaries: LiveExecutionSummary[],
  field: "avgWin" | "avgLoss",
  countField: "wins" | "losses",
): number | null {
  let sum = 0
  let count = 0
  for (const summary of summaries) {
    const value = summary[field]
    const fieldCount = summary[countField]
    if (value === null || fieldCount <= 0) continue
    sum += value * fieldCount
    count += fieldCount
  }
  return count > 0 ? sum / count : null
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now()
  try {
    await initRedis()
    const { searchParams } = new URL(request.url)
    const requestedConnectionId = String(
      searchParams.get("connection_id") || searchParams.get("connectionId") || "",
    ).trim()
    const statusFilter = String(searchParams.get("status") || "all").toLowerCase()
    const connectionIds = requestedConnectionId
      ? [requestedConnectionId]
      : (await getAllConnections()).map((connection: any) => String(connection.id || "")).filter(Boolean)
    const summaries = await Promise.all(connectionIds.map(getLiveExecutionSummary))

    const totalPositions = summaries.reduce((sum, row) => sum + row.totalPositions, 0)
    const openPositions = summaries.reduce((sum, row) => sum + row.openPositions, 0)
    const closedPositions = summaries.reduce((sum, row) => sum + row.closedPositions, 0)
    const settledClosedPositions = summaries.reduce((sum, row) => sum + row.settledClosedPositions, 0)
    const accountingPending = summaries.reduce((sum, row) => sum + row.accountingPending, 0)
    const wins = summaries.reduce((sum, row) => sum + row.wins, 0)
    const losses = summaries.reduce((sum, row) => sum + row.losses, 0)
    const breakEven = summaries.reduce((sum, row) => sum + row.breakEven, 0)
    const realizedPnl = summaries.reduce((sum, row) => sum + row.realizedPnl, 0)
    const unrealizedPnl = summaries.reduce((sum, row) => sum + row.unrealizedPnl, 0)
    const openSymbols = summaries.reduce((sum, row) => sum + row.openSymbols, 0)
    const openOrders = summaries.reduce((sum, row) => sum + row.openOrders, 0)
    const openOrderSymbols = summaries.reduce((sum, row) => sum + row.openOrderSymbols, 0)
    const entryOrders = summaries.reduce((sum, row) => sum + row.entryOrders, 0)
    const controlOrders = summaries.reduce((sum, row) => sum + row.controlOrders, 0)
    const excludedUntrackedPositions = summaries.reduce((sum, row) => sum + row.excludedUntrackedPositions, 0)
    const excludedUntrackedOrders = summaries.reduce((sum, row) => sum + row.excludedUntrackedOrders, 0)
    const exchangeSnapshotsComplete = summaries.filter((row) => row.exchange.complete).length
    const positionsSnapshotsAvailable = summaries.filter((row) => row.positionsDataAvailable).length
    const ordersSnapshotsAvailable = summaries.filter((row) => row.ordersDataAvailable).length
    const openOnly = statusFilter === "open"
    const closedOnly = statusFilter === "closed"
    const visibleOpenPositions = closedOnly ? 0 : openPositions
    const visibleClosedPositions = openOnly ? 0 : closedPositions
    const visibleSettledClosedPositions = openOnly ? 0 : settledClosedPositions
    const visibleAccountingPending = openOnly ? 0 : accountingPending
    const visibleWins = openOnly ? 0 : wins
    const visibleLosses = openOnly ? 0 : losses
    const visibleBreakEven = openOnly ? 0 : breakEven
    const visibleRealizedPnl = openOnly ? 0 : realizedPnl
    const visibleUnrealizedPnl = closedOnly ? 0 : unrealizedPnl
    const decided = visibleWins + visibleLosses
    const largestWins = summaries.flatMap((row) => row.largestWin === null ? [] : [row.largestWin])
    const largestLosses = summaries.flatMap((row) => row.largestLoss === null ? [] : [row.largestLoss])
    const visibleTotal = openOnly
      ? openPositions
      : closedOnly
        ? closedPositions
        : totalPositions
    const accountingComplete = summaries.length > 0 && summaries.every((summary) => summary.complete)

    return NextResponse.json({
      success: true,
      connectionId: requestedConnectionId || null,
      connectionCount: connectionIds.length,
      statusFilter,
      stats: {
        total_positions: visibleTotal,
        active_positions: visibleOpenPositions,
        open_positions: visibleOpenPositions,
        open_symbols: closedOnly ? 0 : openSymbols,
        open_orders: closedOnly ? 0 : openOrders,
        open_order_symbols: closedOnly ? 0 : openOrderSymbols,
        entry_orders: closedOnly ? 0 : entryOrders,
        control_orders: closedOnly ? 0 : controlOrders,
        excluded_untracked_positions: closedOnly ? 0 : excludedUntrackedPositions,
        excluded_untracked_orders: closedOnly ? 0 : excludedUntrackedOrders,
        exchange_scope: "cts_tracked_only",
        exchange_snapshot_complete: summaries.length > 0 && exchangeSnapshotsComplete === summaries.length,
        positions_data_available: summaries.length > 0 && positionsSnapshotsAvailable === summaries.length,
        orders_data_available: summaries.length > 0 && ordersSnapshotsAvailable === summaries.length,
        positions_snapshots_available: positionsSnapshotsAvailable,
        orders_snapshots_available: ordersSnapshotsAvailable,
        exchange_snapshots_complete: exchangeSnapshotsComplete,
        exchange_snapshots_total: summaries.length,
        closed_positions: visibleClosedPositions,
        settled_closed_positions: visibleSettledClosedPositions,
        accounting_pending: visibleAccountingPending,
        accounting_complete: accountingComplete,
        total_pnl: visibleRealizedPnl + visibleUnrealizedPnl,
        realized_pnl: visibleRealizedPnl,
        unrealized_pnl: visibleUnrealizedPnl,
        win_count: visibleWins,
        loss_count: visibleLosses,
        break_even: visibleBreakEven,
        win_rate: decided > 0 ? (visibleWins / decided) * 100 : null,
        avg_profit: openOnly ? null : weightedAverage(summaries, "avgWin", "wins"),
        avg_loss: openOnly ? null : weightedAverage(summaries, "avgLoss", "losses"),
        avg_win: openOnly ? null : weightedAverage(summaries, "avgWin", "wins"),
        largest_win: !openOnly && largestWins.length > 0 ? Math.max(...largestWins) : null,
        largest_loss: !openOnly && largestLosses.length > 0 ? Math.min(...largestLosses) : null,
        data_available: visibleTotal > 0,
      },
      exchange: summaries.map((summary) => summary.exchange),
      duration: Date.now() - startedAt,
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
      { status: 500 },
    )
  }
}
