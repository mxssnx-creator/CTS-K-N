import { NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { initRedis, getAllConnections } from "@/lib/redis-db"
import { getLivePositions, getClosedLivePositions } from "@/lib/trade-engine/stages/live-stage"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import { closedPnl, openPnl } from "@/lib/live-position-pnl"
import { isLiveOpenStatus } from "@/lib/live-position-status"

export const dynamic = "force-dynamic"

type TradeStats = {
  total: number
  wins: number
  losses: number
  winRate: number
  profitFactor: number
  totalProfit: number
  realizedPnl: number
  unrealizedPnl: number
  effectivePnl: number
}

function isRealExchangePosition(pos: any): boolean {
  const ex = pos?.exchangeData || {}
  return Boolean(
    pos?.orderId ||
      pos?.exchangeOrderId ||
      ex.exchangeOrderId ||
      ex.exchangePositionId ||
      ex.orderId ||
      ex.source === "exchange" ||
      ex.syncedFrom === "exchange",
  )
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function buildStats(positions: any[]): TradeStats {
  const closed = positions.filter((p) => p.status === "closed")
  // Rejected/cancelled/error rows are terminal outcomes, not current market
  // exposure. Counting every non-closed record as open inflated live PnL.
  const open = positions.filter((p) => isLiveOpenStatus(p.status))
  const wins = closed.filter((p) => closedPnl(p) > 0).length
  const losses = closed.filter((p) => closedPnl(p) < 0).length
  const grossProfit = closed.reduce((sum, p) => sum + Math.max(0, closedPnl(p)), 0)
  const grossLoss = closed.reduce((sum, p) => sum + Math.abs(Math.min(0, closedPnl(p))), 0)
  const realizedPnl = closed.reduce((sum, p) => sum + closedPnl(p), 0)
  const unrealizedPnl = open.reduce((sum, p) => sum + openPnl(p), 0)
  return {
    total: positions.length,
    wins,
    losses,
    winRate: wins + losses > 0 ? round2((wins / (wins + losses)) * 100) : 0,
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : (grossProfit > 0 ? round2(grossProfit) : 0),
    totalProfit: round2(realizedPnl),
    realizedPnl: round2(realizedPnl),
    unrealizedPnl: round2(unrealizedPnl),
    effectivePnl: round2(realizedPnl + unrealizedPnl),
  }
}

export async function GET(request: Request) {
  try {
    console.log("[v0] Fetching real exchange trading statistics")

    await initRedis()
    const connections = await getAllConnections()
    const params = new URL(request.url).searchParams
    const requestedConnectionId = String(
      params?.get("connection_id") ?? params?.get("connectionId") ?? "",
    ).trim()
    const liveConnections = connections.filter((c: any) =>
      (!requestedConnectionId || String(c.id) === requestedConnectionId) &&
      isTruthyFlag(c.is_enabled) && isTruthyFlag(c.is_enabled_dashboard) && isTruthyFlag(c.is_live_trade),
    )

    // These reads are independent per connection. Fetching them serially made
    // stats latency grow linearly with the number of enabled live connections,
    // which was a primary p95 problem zone.
    const perConnectionPositions = await Promise.all(
      liveConnections.map(async (connection: any) => {
        const [open, closed] = await Promise.all([
          getLivePositions(connection.id).catch(() => []),
          getClosedLivePositions(connection.id, 250).catch(() => []),
        ])
        return [...open, ...closed]
      }),
    )
    const positions: any[] = perConnectionPositions.flat()

    const realPositions = positions
      .filter(isRealExchangePosition)
      .sort((a, b) => Number(b.closedAt || b.updatedAt || b.createdAt || 0) - Number(a.closedAt || a.updatedAt || a.createdAt || 0))

    return NextResponse.json({
      last250: buildStats(realPositions.slice(0, 250)),
      last50: buildStats(realPositions.slice(0, 50)),
      last32h: buildStats(realPositions.filter((p) => Number(p.createdAt || 0) >= Date.now() - 32 * 60 * 60 * 1000)),
      source: "exchange_live_positions",
      simulatedExcluded: true,
      connectionCount: liveConnections.length,
      connectionId: requestedConnectionId || null,
    })
  } catch (error) {
    console.error("[v0] Failed to fetch stats:", error)
    await SystemLogger.logError(error, "api", "GET /api/trading/stats")
    return NextResponse.json({ error: "Failed to fetch stats" }, { status: 500 })
  }
}
