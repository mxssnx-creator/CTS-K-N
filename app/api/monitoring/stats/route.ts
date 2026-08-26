import { NextResponse, type NextRequest } from "next/server"
import { initRedis, getAllConnections, getRedisClient } from "@/lib/redis-db"
import { RedisMonitoring, RedisPositions, RedisTrades } from "@/lib/redis-operations"
import {
  resolveSettledRealizedPnl,
  resolveUnrealizedPnl,
} from "@/lib/live-position-pnl"
import { isLiveOpenStatus } from "@/lib/live-position-status"
import { getLivePositionSource } from "@/lib/live-position-source"

export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

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

function finiteOrNull(value: unknown): number | null {
  if (value === undefined || value === null || typeof value === "boolean") return null
  if (typeof value === "string" && value.trim() === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function nonNegativeInteger(value: unknown): number {
  const parsed = finiteOrNull(value)
  return parsed === null ? 0 : Math.max(0, Math.trunc(parsed))
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const exchangeFilter = searchParams.get("exchange")

    await initRedis()

    // Use all connections for position/trade queries; filter for active-inserted engines
    const allConns = await getAllConnections()
    let connections = allConns

    if (exchangeFilter) {
      connections = connections.filter((c: any) => c.exchange === exchangeFilter)
    }

    // Active processing connections must be assigned and dashboard-enabled.
    const isOn = (value: unknown) => value === true || value === 1 || value === "1" || value === "true"
    const activeConnections = connections.filter((c: any) => {
      const assigned = isOn(c.is_assigned) || isOn(c.is_active_inserted) || isOn(c.is_dashboard_inserted)
      return assigned && isOn(c.is_enabled_dashboard)
    })

    let totalPositions = 0
    let openPositions = 0
    let totalTrades = 0
    let dailyPnL = 0
    let realizedPnL = 0
    let unrealizedPnL = 0
    let accountingPending = 0
    let dailyPnlTimestampUnknown = 0
    const positionSourceCounts = { real: 0, simulated: 0, unknown: 0 }
    const now = Date.now()
    const utcDayStart = new Date(now)
    utcDayStart.setUTCHours(0, 0, 0, 0)
    const utcDayStartMs = utcDayStart.getTime()
    const utcDayEndMs = utcDayStartMs + 24 * 60 * 60 * 1000

    const ledgers = await Promise.all(connections.map(async (conn: any) => {
      const [positions, trades] = await Promise.all([
        RedisPositions.getPositionsByConnection(conn.id).catch(() => []),
        RedisTrades.getTradesByConnection(conn.id).catch(() => []),
      ])
      return { positions, trades }
    }))
    for (const { positions, trades } of ledgers) {

      totalPositions += positions.length
      totalTrades += trades.length

      const open = positions.filter((p: any) => isLiveOpenStatus(p.status))
      openPositions += open.length

      positions.forEach((pos: any) => {
        positionSourceCounts[getLivePositionSource(pos)] += 1
        if (String(pos.status || "").trim().toLowerCase() === "closed") {
          const pnl = resolveSettledRealizedPnl(pos)
          if (pnl === undefined) accountingPending++
          else {
            realizedPnL += pnl
            const closedAt = timestampOf(pos.closedAt ?? pos.closed_at ?? pos.updatedAt ?? pos.updated_at)
            if (closedAt >= utcDayStartMs && closedAt < utcDayEndMs) dailyPnL += pnl
            else if (closedAt === 0) dailyPnlTimestampUnknown++
          }
        } else if (isLiveOpenStatus(pos.status)) {
          unrealizedPnL += resolveUnrealizedPnl(pos) ?? 0
        }
      })
    }

    const stats = await RedisMonitoring.getStatistics()

    // Get real engine progression data from Redis
    let totalCycles = 0
    let totalIndications = 0
    let totalStrategies = 0
    
    try {
      const client = getRedisClient()
      // Canonical counters live on one known hash per selected connection.
      // Direct reads avoid a Redis-blocking KEYS scan and prevent scoped
      // exchange filters from accidentally including unrelated connections.
      const progressionRows: Array<Record<string, string>> = await Promise.all(connections.map((connection: any) =>
        client.hgetall(`progression:${connection.id}`).catch(() => ({} as Record<string, string>)),
      ))
      for (const hash of progressionRows) {
        totalCycles += nonNegativeInteger(hash.indication_cycle_count)
        totalIndications += nonNegativeInteger(hash.indications_count)
        totalStrategies += nonNegativeInteger(hash.strategies_count)
      }
    } catch (e) {
      // non-critical
    }

    return NextResponse.json({
      activeConnections: activeConnections.length,
      totalConnections: connections.length,
      totalPositions,
      openPositions,
      totalTrades,
      dailyPnL: Number(dailyPnL.toFixed(2)),
      dailyPnlWindow: "UTC calendar day",
      dailyPnlTimestampUnknown,
      realizedPnL: Number(realizedPnL.toFixed(2)),
      unrealizedPnL: Number(unrealizedPnL.toFixed(2)),
      effectivePnL: Number((realizedPnL + unrealizedPnL).toFixed(2)),
      // Compatibility alias: this is lifecycle PnL, not an exchange wallet
      // balance. New consumers should use effectivePnL.
      totalBalance: Number((realizedPnL + unrealizedPnL).toFixed(2)),
      accountingPending,
      positionSourceCounts,
      statistics: {
        ...stats,
        totalCycles,
        totalIndications,
        totalStrategies,
        avgCycleDuration: (stats as any)?.avgCycleDuration || 0,
        winRate250: finiteOrNull((stats as any)?.winRate250),
        profitFactor250: finiteOrNull((stats as any)?.profitFactor250),
        winRate50: finiteOrNull((stats as any)?.winRate50),
        profitFactor50: finiteOrNull((stats as any)?.profitFactor50),
        uptime: (stats as any)?.uptime || (totalCycles > 0 ? `${totalCycles} cycles` : "Starting..."),
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] Error fetching monitoring stats:", error)
    return NextResponse.json(
      {
        activeConnections: 0,
        totalConnections: 0,
        totalPositions: 0,
        openPositions: 0,
        totalTrades: 0,
        dailyPnL: 0,
        realizedPnL: 0,
        unrealizedPnL: 0,
        effectivePnL: 0,
        totalBalance: 0,
        accountingPending: 0,
        error: "Failed to fetch stats",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
