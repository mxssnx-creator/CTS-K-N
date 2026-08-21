import { NextResponse } from "next/server"
import { initRedis, getAllConnections } from "@/lib/redis-db"
import { getLivePositions, getClosedLivePositions } from "@/lib/trade-engine/stages/live-stage"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import { resolveRealizedPnl, resolveUnrealizedPnl } from "@/lib/live-position-pnl"
import { isLiveOpenStatus } from "@/lib/live-position-status"

export const dynamic = "force-dynamic"

type SymbolStats = {
  symbol: string
  livePositions: number
  openPositions: number
  closedPositions: number
  realizedPnl: number
  unrealizedPnl: number
  effectivePnl: number
  wins: number
  losses: number
  winRate: number
  profitFactor250: number
  profitFactor50: number
  source: "exchange_live_positions"
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

function pnlOf(pos: any): number {
  const isClosed = String(pos?.status || "").toLowerCase() === "closed"
  return (isClosed ? resolveRealizedPnl(pos || {}) : resolveUnrealizedPnl(pos || {})) ?? 0
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function finalizeStats(stats: SymbolStats): SymbolStats {
  const totalDecided = stats.wins + stats.losses
  stats.winRate = totalDecided > 0 ? round2((stats.wins / totalDecided) * 100) : 0
  stats.effectivePnl = round2(stats.realizedPnl + stats.unrealizedPnl)
  return stats
}

function grossProfitFactor(values: readonly number[]): number {
  const grossProfit = values.reduce((sum, value) => sum + Math.max(0, value), 0)
  const grossLoss = values.reduce((sum, value) => sum + Math.abs(Math.min(0, value)), 0)
  return grossLoss > 0 ? round2(grossProfit / grossLoss) : grossProfit > 0 ? 999 : 0
}

export async function GET(request: Request) {
  try {
    console.log("[v0] Fetching aggregated exchange-positions statistics")

    await initRedis()
    const connections = await getAllConnections()
    const params = new URL(request.url).searchParams
    const requestedConnectionId = String(
      params.get("connection_id") ?? params.get("connectionId") ?? "",
    ).trim()
    // Symbol statistics feed connection-specific UI panels. Aggregating all
    // enabled ledgers when a selection is missing leaks one connection's
    // performance into another and makes switching appear stale.
    if (!requestedConnectionId) {
      return NextResponse.json(
        { error: "connection_id query parameter required", symbols: [] },
        { status: 400 },
      )
    }
    const activeConnections = connections.filter((c: any) =>
      String(c.id) === requestedConnectionId &&
      isTruthyFlag(c.is_enabled_dashboard) &&
      isTruthyFlag(c.is_enabled) &&
      isTruthyFlag(c.is_live_trade),
    )

    const bySymbol = new Map<string, SymbolStats>()
    const closedPnlBySymbol = new Map<string, Array<{ pnl: number; closedAt: number }>>()
    // Connection ledgers are independent. Fetch in parallel so the selected
    // connection remains fast even while other active connections are busy.
    const ledgers = await Promise.all(
      activeConnections.map(async (connection: any) => ({
        connectionId: connection.id,
        open: await getLivePositions(connection.id).catch(() => []),
        closed: await getClosedLivePositions(connection.id, 250).catch(() => []),
      })),
    )
    for (const ledger of ledgers) {
      for (const pos of [...ledger.open, ...ledger.closed].filter(isRealExchangePosition)) {
        const symbol = String((pos as any).symbol || "UNKNOWN")
        const current = bySymbol.get(symbol) || {
          symbol,
          livePositions: 0,
          openPositions: 0,
          closedPositions: 0,
          realizedPnl: 0,
          unrealizedPnl: 0,
          effectivePnl: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          profitFactor250: 0,
          profitFactor50: 0,
          source: "exchange_live_positions" as const,
        }
        const isClosed = String((pos as any).status || "").toLowerCase() === "closed"
        const isOpen = isLiveOpenStatus((pos as any).status)
        if (!isClosed && !isOpen) continue
        current.livePositions += 1
        const pnl = pnlOf(pos)
        if (isClosed) {
          current.closedPositions += 1
          current.realizedPnl = round2(current.realizedPnl + pnl)
          if (pnl > 0) current.wins += 1
          if (pnl < 0) current.losses += 1
          const windows = closedPnlBySymbol.get(symbol) || []
          const closedAtRaw = (pos as any).closedAt || (pos as any).closed_at || (pos as any).updatedAt || 0
          const closedAtNumeric = Number(closedAtRaw)
          windows.push({
            pnl,
            closedAt: Number.isFinite(closedAtNumeric)
              ? closedAtNumeric
              : Date.parse(String(closedAtRaw)) || 0,
          })
          closedPnlBySymbol.set(symbol, windows)
        } else {
          current.openPositions += 1
          current.unrealizedPnl = round2(current.unrealizedPnl + pnl)
        }
        bySymbol.set(symbol, current)
      }
    }

    const symbols = Array.from(bySymbol.values())
      .map((stats) => {
        const rows = (closedPnlBySymbol.get(stats.symbol) || [])
          .sort((left, right) => right.closedAt - left.closedAt)
        stats.profitFactor250 = grossProfitFactor(rows.slice(0, 250).map((row) => row.pnl))
        stats.profitFactor50 = grossProfitFactor(rows.slice(0, 50).map((row) => row.pnl))
        return finalizeStats(stats)
      })
      .sort((a, b) => Math.abs(b.effectivePnl) - Math.abs(a.effectivePnl))
      .slice(0, 22)

    return NextResponse.json({
      symbols,
      source: "exchange_live_positions",
      simulatedExcluded: true,
      connectionId: requestedConnectionId,
    })
  } catch (error) {
    console.error("[v0] Failed to fetch exchange-positions statistics:", error)
    return NextResponse.json({
      symbols: [],
      source: "exchange_live_positions",
      simulatedExcluded: true,
    })
  }
}
