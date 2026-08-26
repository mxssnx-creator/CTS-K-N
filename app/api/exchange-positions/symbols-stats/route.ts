import { NextResponse } from "next/server"
import { initRedis, getAllConnections } from "@/lib/redis-db"
import { getLivePositions, getClosedLivePositions } from "@/lib/trade-engine/stages/live-stage"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import { resolveSettledRealizedPnl, resolveUnrealizedPnl } from "@/lib/live-position-pnl"
import { isLiveOpenStatus } from "@/lib/live-position-status"
import { isRealExchangePosition } from "@/lib/live-position-source"

export const dynamic = "force-dynamic"

type SymbolStats = {
  symbol: string
  livePositions: number
  openPositions: number
  closedPositions: number
  settledClosedPositions: number
  accountingPending: number
  realizedPnl: number
  unrealizedPnl: number
  effectivePnl: number
  wins: number
  losses: number
  breakEven: number
  winRate: number
  profitFactor250: number | null
  profitFactor50: number | null
  profitFactor250Infinite: boolean
  profitFactor50Infinite: boolean
  accountingComplete: boolean
  unrealizedPnlUnknown: number
  unrealizedPnlComplete: boolean
  source: "exchange_live_positions"
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

function mergedLedgerPositions(open: any[], closed: any[]): any[] {
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

function finalizeStats(stats: SymbolStats): SymbolStats {
  const totalDecided = stats.wins + stats.losses
  stats.winRate = totalDecided > 0 ? round2((stats.wins / totalDecided) * 100) : 0
  stats.effectivePnl = round2(stats.realizedPnl + stats.unrealizedPnl)
  stats.accountingComplete = stats.accountingPending === 0
  stats.unrealizedPnlComplete = stats.unrealizedPnlUnknown === 0
  return stats
}

function grossProfitFactor(values: readonly number[]): { value: number | null; infinite: boolean } {
  const grossProfit = values.reduce((sum, value) => sum + Math.max(0, value), 0)
  const grossLoss = values.reduce((sum, value) => sum + Math.abs(Math.min(0, value)), 0)
  return {
    value: grossLoss > 0 ? round2(grossProfit / grossLoss) : null,
    infinite: grossLoss === 0 && grossProfit > 0,
  }
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
      for (const pos of mergedLedgerPositions(ledger.open, ledger.closed).filter(isRealExchangePosition)) {
        const symbol = String((pos as any).symbol || "UNKNOWN").trim().toUpperCase() || "UNKNOWN"
        const current = bySymbol.get(symbol) || {
          symbol,
          livePositions: 0,
          openPositions: 0,
          closedPositions: 0,
          settledClosedPositions: 0,
          accountingPending: 0,
          realizedPnl: 0,
          unrealizedPnl: 0,
          effectivePnl: 0,
          wins: 0,
          losses: 0,
          breakEven: 0,
          winRate: 0,
          profitFactor250: null,
          profitFactor50: null,
          profitFactor250Infinite: false,
          profitFactor50Infinite: false,
          accountingComplete: true,
          unrealizedPnlUnknown: 0,
          unrealizedPnlComplete: true,
          source: "exchange_live_positions" as const,
        }
        const isClosed = String((pos as any).status || "").trim().toLowerCase() === "closed"
        const isOpen = isLiveOpenStatus((pos as any).status)
        if (!isClosed && !isOpen) continue
        current.livePositions += 1
        if (isClosed) {
          current.closedPositions += 1
          const pnl = resolveSettledRealizedPnl(pos || {})
          if (pnl === undefined) {
            current.accountingPending += 1
            bySymbol.set(symbol, current)
            continue
          }
          current.settledClosedPositions += 1
          current.realizedPnl = round2(current.realizedPnl + pnl)
          if (pnl > 0) current.wins += 1
          if (pnl < 0) current.losses += 1
          if (pnl === 0) current.breakEven += 1
          const windows = closedPnlBySymbol.get(symbol) || []
          const closedAtRaw = (pos as any).closedAt || (pos as any).closed_at || (pos as any).updatedAt || 0
          windows.push({
            pnl,
            closedAt: timestampOf(closedAtRaw),
          })
          closedPnlBySymbol.set(symbol, windows)
        } else {
          current.openPositions += 1
          const pnl = resolveUnrealizedPnl(pos || {})
          if (pnl === undefined || !Number.isFinite(pnl)) current.unrealizedPnlUnknown += 1
          else current.unrealizedPnl = round2(current.unrealizedPnl + pnl)
        }
        bySymbol.set(symbol, current)
      }
    }

    const symbols = Array.from(bySymbol.values())
      .map((stats) => {
        const rows = (closedPnlBySymbol.get(stats.symbol) || [])
          .sort((left, right) => right.closedAt - left.closedAt)
        const pf250 = grossProfitFactor(rows.slice(0, 250).map((row) => row.pnl))
        const pf50 = grossProfitFactor(rows.slice(0, 50).map((row) => row.pnl))
        stats.profitFactor250 = pf250.value
        stats.profitFactor50 = pf50.value
        stats.profitFactor250Infinite = pf250.infinite
        stats.profitFactor50Infinite = pf50.infinite
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
