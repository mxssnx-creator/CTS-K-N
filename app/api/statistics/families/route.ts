import { NextRequest, NextResponse } from "next/server"
import { getAllConnections, initRedis, isConnectionAssignedToMain } from "@/lib/redis-db"
import { POSITION_COST_PERCENT_DEFAULT } from "@/lib/position-cost"
import { buildLiveFamilyStatistics } from "@/lib/live-family-statistics"
import { mapWithConcurrency } from "@/lib/bounded-concurrency"
import type { TradeHistoryRow } from "@/lib/trade-history"
import { GET as getTradeHistory } from "@/app/api/trading/trade-history/route"

export const dynamic = "force-dynamic"

/**
 * Per-family ProfitFactor and drawdown time over REALISED trades.
 *
 * The Historic Test reports a ProfitFactor per strategy family from replayed
 * history; this is its live counterpart, on the same PositionCost-relative
 * coordinate, so an expectation and an outcome are directly comparable rather
 * than being two different definitions of "profit factor".
 *
 * Rows come from the existing trade-history handler so there is exactly one
 * assembly path for realised trades — a second one would drift from it and
 * quietly report different numbers on the same data. The handler is invoked
 * in-process (no HTTP round trip back into this server) and keeps its own
 * serialized read-model cache.
 */
const CONNECTION_READ_CONCURRENCY = 4

async function loadRows(origin: string, connectionId: string, limit: number): Promise<TradeHistoryRow[]> {
  const url = `${origin}/api/trading/trade-history?connection_id=${encodeURIComponent(connectionId)}&limit=${limit}`
  const response = await getTradeHistory(new NextRequest(url)).catch(() => null)
  if (!response?.ok) return []
  const payload = await response.json().catch(() => null)
  const rows = Array.isArray(payload?.rows) ? payload.rows : []
  return rows as TradeHistoryRow[]
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const requested = String(url.searchParams.get("connection_id") || "").trim()
  const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit")) || 500))
  const positionCostPercent = Number(url.searchParams.get("position_cost_percent")) > 0
    ? Number(url.searchParams.get("position_cost_percent"))
    : POSITION_COST_PERCENT_DEFAULT

  await initRedis()
  // Only connection-relevant lanes, matching every other aggregate surface: a
  // connection the operator removed from Main is not managed, so reporting its
  // realised trades as current performance would be misleading.
  const connectionIds = requested
    ? [requested]
    : (await getAllConnections().catch(() => [] as any[]))
        .filter((connection: any) => isConnectionAssignedToMain(connection))
        .map((connection: any) => String(connection.id || ""))
        .filter(Boolean)

  // Bounded parallel reads; results keep the connection order.
  const rowsByConnection = await mapWithConcurrency(
    connectionIds,
    CONNECTION_READ_CONCURRENCY,
    (connectionId) => loadRows(url.origin, connectionId, limit),
  )
  const allRows: TradeHistoryRow[] = rowsByConnection.flat()
  const perConnection = connectionIds.map((connectionId, index) => ({
    connectionId,
    rows: rowsByConnection[index].length,
    report: buildLiveFamilyStatistics(rowsByConnection[index], positionCostPercent),
  }))

  const combined = buildLiveFamilyStatistics(allRows, positionCostPercent)
  return NextResponse.json({
    success: true,
    positionCostPercent,
    connectionIds,
    // "no realised trades" and "realised trades that lost" must stay
    // distinguishable, so every family is reported even at zero trades.
    families: combined.families,
    overall: combined.overall,
    foreign: combined.foreign,
    perConnection,
  })
}
