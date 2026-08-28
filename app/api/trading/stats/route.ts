import { NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { initRedis, getAllConnections } from "@/lib/redis-db"
import { getLivePositions, getClosedLivePositions } from "@/lib/trade-engine/stages/live-stage"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import { resolveSettledRealizedPnl, resolveUnrealizedPnl } from "@/lib/live-position-pnl"
import { isLiveOpenStatus } from "@/lib/live-position-status"
import { isExecutedRealExchangePosition, isRealExchangePosition } from "@/lib/live-position-source"
import { getLiveExecutionSummary } from "@/lib/live-execution-summary"

export const dynamic = "force-dynamic"

type TradeStats = {
  total: number
  openPositions: number
  closedPositions: number
  settledClosedPositions: number
  accountingPending: number
  accountingComplete: boolean
  wins: number
  losses: number
  breakEven: number
  winRate: number
  profitFactor: number | null
  profitFactorInfinite: boolean
  totalProfit: number
  realizedPnl: number
  unrealizedPnl: number
  unrealizedPnlUnknown: number
  unrealizedPnlComplete: boolean
  effectivePnl: number
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
  const parsed = Date.parse(String(value || ""))
  return Number.isFinite(parsed) ? parsed : 0
}

function lifecycleTimestamp(position: any): number {
  const status = String(position?.status || "").trim().toLowerCase()
  return timestampOf(status === "closed"
    ? position?.closedAt ?? position?.closed_at ?? position?.updatedAt ?? position?.updated_at
    : position?.createdAt ?? position?.created_at ?? position?.updatedAt ?? position?.updated_at)
}

function mergeLifecyclePositions(open: any[], closed: any[]): any[] {
  const byId = new Map<string, any>()
  const withoutId: any[] = []
  for (const position of [...open, ...closed]) {
    const id = String(position?.id ?? position?.positionId ?? "").trim()
    if (id) byId.set(id, position)
    else withoutId.push(position)
  }
  return [...byId.values(), ...withoutId]
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function buildStats(positions: any[]): TradeStats {
  const closed = positions.filter((p) => String(p?.status || "").trim().toLowerCase() === "closed")
  // Rejected/cancelled/error rows are terminal outcomes, not current market
  // exposure. Counting every non-closed record as open inflated live PnL.
  const open = positions.filter((p) =>
    isLiveOpenStatus(p.status) && isExecutedRealExchangePosition(p),
  )
  const settled = closed
    .map((position) => ({ position, pnl: resolveSettledRealizedPnl(position) }))
    .filter((entry): entry is { position: any; pnl: number } => entry.pnl !== undefined)
  const wins = settled.filter((entry) => entry.pnl > 0).length
  const losses = settled.filter((entry) => entry.pnl < 0).length
  const breakEven = settled.filter((entry) => entry.pnl === 0).length
  const grossProfit = settled.reduce((sum, entry) => sum + Math.max(0, entry.pnl), 0)
  const grossLoss = settled.reduce((sum, entry) => sum + Math.abs(Math.min(0, entry.pnl)), 0)
  const realizedPnl = settled.reduce((sum, entry) => sum + entry.pnl, 0)
  const openPnl = open.map((position) => resolveUnrealizedPnl(position))
  const unrealizedPnl = openPnl.reduce<number>(
    (sum, pnl) => sum + (pnl !== undefined && Number.isFinite(pnl) ? pnl : 0),
    0,
  )
  const unrealizedPnlUnknown = openPnl.filter((pnl) => pnl === undefined || !Number.isFinite(pnl)).length
  const accountingPending = closed.length - settled.length
  return {
    total: positions.length,
    openPositions: open.length,
    closedPositions: closed.length,
    settledClosedPositions: settled.length,
    accountingPending,
    accountingComplete: accountingPending === 0,
    wins,
    losses,
    breakEven,
    winRate: wins + losses > 0 ? round2((wins / (wins + losses)) * 100) : 0,
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : null,
    profitFactorInfinite: grossLoss === 0 && grossProfit > 0,
    totalProfit: round2(realizedPnl),
    realizedPnl: round2(realizedPnl),
    unrealizedPnl: round2(unrealizedPnl),
    unrealizedPnlUnknown,
    unrealizedPnlComplete: unrealizedPnlUnknown === 0,
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
    const [perConnectionPositions, executionSummaries] = await Promise.all([
      Promise.all(
      liveConnections.map(async (connection: any) => {
        const [open, closed] = await Promise.all([
          getLivePositions(connection.id).catch(() => []),
          getClosedLivePositions(connection.id, 250).catch(() => []),
        ])
        return mergeLifecyclePositions(open, closed)
      }),
      ),
      Promise.all(liveConnections.map((connection: any) => getLiveExecutionSummary(connection.id))),
    ])
    const positions: any[] = perConnectionPositions.flat()

    const realPositions = positions.filter(isRealExchangePosition)
    const closedPositions = realPositions
      .filter((position) => String(position?.status || "").trim().toLowerCase() === "closed")
      .sort((left, right) => lifecycleTimestamp(right) - lifecycleTimestamp(left))
    const openPositions = realPositions.filter((position) =>
      isLiveOpenStatus(position?.status) && isExecutedRealExchangePosition(position),
    )
    const now = Date.now()
    const last32hCutoff = now - 32 * 60 * 60 * 1000

    const authoritativeOpenPositions = executionSummaries.reduce((sum, row) => sum + row.openPositions, 0)
    const authoritativeUnrealizedPnl = executionSummaries.reduce((sum, row) => sum + row.unrealizedPnl, 0)
    const authoritativeOpenSymbols = executionSummaries.reduce((sum, row) => sum + row.openSymbols, 0)
    const authoritativeOpenOrders = executionSummaries.reduce((sum, row) => sum + row.openOrders, 0)
    const authoritativeEntryOrders = executionSummaries.reduce((sum, row) => sum + row.entryOrders, 0)
    const authoritativeControlOrders = executionSummaries.reduce((sum, row) => sum + row.controlOrders, 0)
    const excludedUntrackedPositions = executionSummaries.reduce(
      (sum, row) => sum + (Number(row.excludedUntrackedPositions) || 0),
      0,
    )
    const excludedUntrackedOrders = executionSummaries.reduce(
      (sum, row) => sum + (Number(row.excludedUntrackedOrders) || 0),
      0,
    )
    const snapshotComplete = executionSummaries.length > 0 && executionSummaries.every((row) => row.exchange.complete)
    const positionsDataAvailable = executionSummaries.length > 0 && executionSummaries.every(
      (row) => row.positionsDataAvailable,
    )
    const ordersDataAvailable = executionSummaries.length > 0 && executionSummaries.every(
      (row) => row.ordersDataAvailable,
    )
    const applyAuthoritativeOpen = (stats: TradeStats): TradeStats => ({
      ...stats,
      total: stats.closedPositions + authoritativeOpenPositions,
      openPositions: authoritativeOpenPositions,
      unrealizedPnl: round2(authoritativeUnrealizedPnl),
      unrealizedPnlUnknown: snapshotComplete ? 0 : stats.unrealizedPnlUnknown,
      unrealizedPnlComplete: snapshotComplete,
      effectivePnl: round2(stats.realizedPnl + authoritativeUnrealizedPnl),
    })

    return NextResponse.json({
      // Closed-trade windows are chronological terminal windows. Current open
      // exposure is included separately in each effective/unrealized total and
      // never consumes a closed-trade PF sample slot.
      last250: applyAuthoritativeOpen(buildStats([...closedPositions.slice(0, 250), ...openPositions])),
      last50: applyAuthoritativeOpen(buildStats([...closedPositions.slice(0, 50), ...openPositions])),
      last32h: applyAuthoritativeOpen(buildStats(realPositions.filter((position) => lifecycleTimestamp(position) >= last32hCutoff))),
      exchangeLive: {
        openPositions: authoritativeOpenPositions,
        openSymbols: authoritativeOpenSymbols,
        openOrders: authoritativeOpenOrders,
        entryOrders: authoritativeEntryOrders,
        controlOrders: authoritativeControlOrders,
        excludedUntrackedPositions,
        excludedUntrackedOrders,
        scope: "cts_tracked_only",
        snapshotComplete,
        positionsDataAvailable,
        ordersDataAvailable,
        connections: executionSummaries.map((row) => row.exchange),
      },
      source: "executed_exchange_positions_and_live_exchange_snapshot",
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
