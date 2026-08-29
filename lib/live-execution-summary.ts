import {
  getClosedLivePositionReadModels,
  getOpenLivePositionReadModels,
  LIVE_POSITION_CLOSED_READ_LIMIT,
  LIVE_POSITION_OPEN_READ_LIMIT,
  type LivePositionReadModel,
} from "@/lib/live-position-read-model"
import { calculateLivePositionStatistics } from "@/lib/live-position-statistics"
import {
  getLivePositionSource,
  isExecutedRealExchangePosition,
  type LivePositionSource,
} from "@/lib/live-position-source"
import {
  resolveConfirmedPositionQuantity,
  resolveSettledRealizedPnl,
} from "@/lib/live-position-pnl"
import {
  getExchangeLiveStateSummary,
  type ExchangeLiveStateSummary,
} from "@/lib/exchange-live-state-summary"
import {
  getLivePositionLifetimeSummary,
  lifetimeLaneDerived,
  type LivePositionLifetimeSummary,
} from "@/lib/live-position-lifetime-summary"

export interface LiveExecutionSummary {
  connectionId: string
  totalPositions: number
  openPositions: number
  openSymbols: number
  openOrders: number
  openOrderSymbols: number
  entryOrders: number
  controlOrders: number
  positionsDataAvailable: boolean
  ordersDataAvailable: boolean
  positionsSnapshotError: string | null
  ordersSnapshotError: string | null
  excludedUntrackedPositions: number
  excludedUntrackedOrders: number
  closedPositions: number
  settledClosedPositions: number
  accountingPending: number
  totalTrades: number
  realizedPnl: number
  unrealizedPnl: number
  effectivePnl: number
  dailyRealizedPnl: number
  dailyPnlTimestampUnknown: number
  lastHourTrades: number
  lastHourRealizedPnl: number
  lifetimeVolumeUsd: number
  openVolumeUsd: number
  wins: number
  losses: number
  breakEven: number
  winRate: number | null
  avgWin: number | null
  avgLoss: number | null
  largestWin: number | null
  largestLoss: number | null
  sourceCounts: Record<LivePositionSource, number>
  statisticsScope: "lifetime" | "recent_window"
  lifetime: LivePositionLifetimeSummary & {
    derived: Record<LivePositionSource | "all", ReturnType<typeof lifetimeLaneDerived>>
  }
  coverage: {
    openRows: number
    closedRows: number
    openLimit: number
    closedLimit: number
    truncated: boolean
  }
  real: ReturnType<typeof calculateLivePositionStatistics>
  simulated: ReturnType<typeof calculateLivePositionStatistics>
  unknown: ReturnType<typeof calculateLivePositionStatistics>
  all: ReturnType<typeof calculateLivePositionStatistics>
  exchange: ExchangeLiveStateSummary
  complete: boolean
  generatedAt: number
}

type CachedSummary = {
  expiresAt: number
  value: LiveExecutionSummary
}

const SUMMARY_FRESH_MS = 3_000
const summaryCache = new Map<string, CachedSummary>()
const summaryInFlight = new Map<string, Promise<LiveExecutionSummary>>()

function positionIdentity(position: LivePositionReadModel, index: number): string {
  const explicit = String(position.id ?? position.positionId ?? position.position_id ?? "").trim()
  if (explicit) return explicit
  return [
    position.connectionId ?? position.connection_id ?? "unknown",
    position.symbol ?? "unknown",
    position.direction ?? position.side ?? "unknown",
    position.orderId ?? position.order_id ?? "unknown",
    position.openedAt ?? position.opened_at ?? position.createdAt ?? position.created_at ?? index,
  ].map(String).join("|")
}

function isExecutedLivePosition(position: LivePositionReadModel): boolean {
  const source = getLivePositionSource(position as Record<string, any>)
  if (source === "real") {
    return isExecutedRealExchangePosition(position as Record<string, any>)
  }
  // Simulated and unknown rows still require positive executed quantity; they
  // are exposed only in their own diagnostic lanes, never headline live PnL.
  return (resolveConfirmedPositionQuantity(position as Record<string, any>, true) ?? 0) > 0
}

function realizedValues(positions: LivePositionReadModel[]): number[] {
  return positions.flatMap((position) => {
    const status = String(position.status || "").trim().toLowerCase()
    if (status !== "closed") return []
    const value = resolveSettledRealizedPnl(position as Record<string, any>)
    return value === undefined ? [] : [value]
  })
}

function average(values: number[]): number | null {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null
}

function timestampOf(position: LivePositionReadModel): number {
  const raw = position.closedAt ?? position.closed_at ?? position.updatedAt ?? position.updated_at
  if (typeof raw === "number" || (typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw.trim()))) {
    const numeric = Number(raw)
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  }
  const parsed = Date.parse(String(raw || ""))
  return Number.isFinite(parsed) ? parsed : 0
}

async function buildSummary(connectionId: string): Promise<LiveExecutionSummary> {
  const [openRows, closedRows, exchange, lifetime] = await Promise.all([
    getOpenLivePositionReadModels(connectionId, LIVE_POSITION_OPEN_READ_LIMIT),
    getClosedLivePositionReadModels(connectionId, LIVE_POSITION_CLOSED_READ_LIMIT),
    getExchangeLiveStateSummary(connectionId),
    getLivePositionLifetimeSummary(connectionId),
  ])

  // The open compatibility index may still contain a terminal row while a
  // close is being archived. Let the terminal archive win and count every
  // lifecycle exactly once across all overview surfaces.
  const byIdentity = new Map<string, LivePositionReadModel>()
  openRows.forEach((position, index) => {
    byIdentity.set(positionIdentity(position, index), position)
  })
  closedRows.forEach((position, index) => {
    byIdentity.set(positionIdentity(position, openRows.length + index), position)
  })
  const positions = [...byIdentity.values()].filter(isExecutedLivePosition)
  const lanes: Record<LivePositionSource, LivePositionReadModel[]> = {
    real: [],
    simulated: [],
    unknown: [],
  }
  for (const position of positions) lanes[getLivePositionSource(position as Record<string, any>)].push(position)

  const all = calculateLivePositionStatistics(positions as Array<Record<string, any>>)
  const real = calculateLivePositionStatistics(lanes.real as Array<Record<string, any>>)
  const simulated = calculateLivePositionStatistics(lanes.simulated as Array<Record<string, any>>)
  const unknown = calculateLivePositionStatistics(lanes.unknown as Array<Record<string, any>>)
  // Headline execution statistics are exchange-only. Paper and unknown rows
  // remain visible through sourceCounts and the lane payloads, but must never
  // alter live PnL, W/L, PF or overview trade counts.
  const realized = realizedValues(lanes.real)
  const wins = realized.filter((value) => value > 0)
  const losses = realized.filter((value) => value < 0)
  const breakEven = realized.filter((value) => value === 0)
  const settledClosedPositions = realized.length
  const accountingPending = Math.max(real.accountingPending, real.closed - settledClosedPositions)
  const lifetimeReal = lifetime.lanes.real
  const useLifetime = lifetime.coverage.complete
  const headlineClosedPositions = useLifetime ? lifetimeReal.closedTrades : real.closed
  const headlineSettledClosedPositions = useLifetime
    ? lifetimeReal.settledClosedTrades
    : settledClosedPositions
  const headlineAccountingPending = useLifetime
    ? lifetimeReal.accountingPending
    : accountingPending
  const headlineRealizedPnl = useLifetime
    ? lifetimeReal.realizedPnl
    : real.realizedPnl
  const headlineWins = useLifetime ? lifetimeReal.wins : wins.length
  const headlineLosses = useLifetime ? lifetimeReal.losses : losses.length
  const headlineBreakEven = useLifetime ? lifetimeReal.breakEven : breakEven.length
  const headlineDecisive = headlineWins + headlineLosses
  const utcDayStart = new Date()
  utcDayStart.setUTCHours(0, 0, 0, 0)
  const utcDayStartMs = utcDayStart.getTime()
  const utcDayEndMs = utcDayStartMs + 24 * 60 * 60 * 1000
  let dailyRealizedPnl = 0
  let dailyPnlTimestampUnknown = 0
  let lastHourTrades = 0
  let lastHourRealizedPnl = 0
  const lastHourStartMs = Date.now() - 60 * 60 * 1000
  for (const position of lanes.real) {
    if (String(position.status || "").trim().toLowerCase() !== "closed") continue
    const closedAt = timestampOf(position)
    if (closedAt >= lastHourStartMs) lastHourTrades++
  }
  for (const position of lanes.real) {
    if (String(position.status || "").trim().toLowerCase() !== "closed") continue
    const pnl = resolveSettledRealizedPnl(position as Record<string, any>)
    if (pnl === undefined) continue
    const closedAt = timestampOf(position)
    if (closedAt >= utcDayStartMs && closedAt < utcDayEndMs) dailyRealizedPnl += pnl
    else if (closedAt === 0) dailyPnlTimestampUnknown++
    if (closedAt >= lastHourStartMs) lastHourRealizedPnl += pnl
  }

  const authoritativeOpenPositions = exchange.positionsStatus.available
    ? exchange.openPositions
    : real.open
  const authoritativeUnrealizedPnl = exchange.positionsStatus.available
    ? exchange.unrealizedPnl
    : real.unrealizedPnl
  const authoritativeOpenVolumeUsd = exchange.positionsStatus.available
    ? exchange.positionNotionalUsd
    : real.openVolumeUsd

  return {
    connectionId,
    totalPositions: headlineClosedPositions + authoritativeOpenPositions,
    openPositions: authoritativeOpenPositions,
    openSymbols: exchange.positionsStatus.available ? exchange.openPositionSymbols : new Set(
      lanes.real
        .filter((position) => String(position.status || "").trim().toLowerCase() !== "closed")
        .map((position) => String(position.symbol || "").trim().toUpperCase())
        .filter(Boolean),
    ).size,
    openOrders: exchange.ordersStatus.available ? exchange.openOrders : 0,
    openOrderSymbols: exchange.ordersStatus.available ? exchange.openOrderSymbols : 0,
    entryOrders: exchange.ordersStatus.available ? exchange.entryOrders : 0,
    controlOrders: exchange.ordersStatus.available ? exchange.controlOrders : 0,
    positionsDataAvailable: exchange.positionsStatus.available,
    ordersDataAvailable: exchange.ordersStatus.available,
    positionsSnapshotError: exchange.positionsStatus.error,
    ordersSnapshotError: exchange.ordersStatus.error,
    excludedUntrackedPositions: exchange.positionsStatus.available
      ? exchange.tracking?.venuePositionsExcluded ?? 0
      : 0,
    excludedUntrackedOrders: exchange.ordersStatus.available
      ? exchange.tracking?.venueOrdersExcluded ?? 0
      : 0,
    closedPositions: headlineClosedPositions,
    settledClosedPositions: headlineSettledClosedPositions,
    accountingPending: headlineAccountingPending,
    // A closed lifecycle is one executed position result. Pending settlement
    // remains a trade, but never contributes fabricated zero PnL.
    totalTrades: headlineClosedPositions,
    realizedPnl: headlineRealizedPnl,
    unrealizedPnl: authoritativeUnrealizedPnl,
    effectivePnl: headlineRealizedPnl + authoritativeUnrealizedPnl,
    dailyRealizedPnl,
    dailyPnlTimestampUnknown,
    lastHourTrades,
    lastHourRealizedPnl,
    lifetimeVolumeUsd: useLifetime ? lifetimeReal.lifetimeVolumeUsd : real.lifetimeVolumeUsd,
    openVolumeUsd: authoritativeOpenVolumeUsd,
    wins: headlineWins,
    losses: headlineLosses,
    breakEven: headlineBreakEven,
    winRate: headlineDecisive > 0
      ? (headlineWins / headlineDecisive) * 100
      : null,
    avgWin: useLifetime
      ? lifetimeReal.wins > 0 ? lifetimeReal.grossProfit / lifetimeReal.wins : null
      : average(wins),
    avgLoss: useLifetime
      ? lifetimeReal.losses > 0 ? -(lifetimeReal.grossLoss / lifetimeReal.losses) : null
      : average(losses),
    largestWin: useLifetime ? null : wins.length > 0 ? Math.max(...wins) : null,
    largestLoss: useLifetime ? null : losses.length > 0 ? Math.min(...losses) : null,
    sourceCounts: {
      real: useLifetime ? lifetime.lanes.real.executedRows + real.open : real.positions,
      simulated: useLifetime ? lifetime.lanes.simulated.executedRows + simulated.open : simulated.positions,
      unknown: useLifetime ? lifetime.lanes.unknown.executedRows + unknown.open : unknown.positions,
    },
    statisticsScope: useLifetime ? "lifetime" : "recent_window",
    lifetime: {
      ...lifetime,
      derived: {
        all: lifetimeLaneDerived(lifetime.lanes.all),
        real: lifetimeLaneDerived(lifetime.lanes.real),
        simulated: lifetimeLaneDerived(lifetime.lanes.simulated),
        unknown: lifetimeLaneDerived(lifetime.lanes.unknown),
      },
    },
    coverage: {
      openRows: openRows.length,
      closedRows: closedRows.length,
      openLimit: LIVE_POSITION_OPEN_READ_LIMIT,
      closedLimit: LIVE_POSITION_CLOSED_READ_LIMIT,
      truncated:
        openRows.length >= LIVE_POSITION_OPEN_READ_LIMIT ||
        closedRows.length >= LIVE_POSITION_CLOSED_READ_LIMIT,
    },
    real,
    simulated,
    unknown,
    all,
    exchange,
    complete:
      exchange.complete &&
      headlineAccountingPending === 0 &&
      openRows.length < LIVE_POSITION_OPEN_READ_LIMIT &&
      lifetime.coverage.complete,
    generatedAt: Date.now(),
  }
}

export async function getLiveExecutionSummary(connectionId: string): Promise<LiveExecutionSummary> {
  const normalized = String(connectionId || "").trim()
  if (!normalized) throw new Error("connectionId is required")
  const cached = summaryCache.get(normalized)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const existing = summaryInFlight.get(normalized)
  if (existing) return existing

  const work = buildSummary(normalized).then((value) => {
    summaryCache.set(normalized, { expiresAt: Date.now() + SUMMARY_FRESH_MS, value })
    return value
  }).finally(() => {
    if (summaryInFlight.get(normalized) === work) summaryInFlight.delete(normalized)
  })
  summaryInFlight.set(normalized, work)
  return work
}

export function clearLiveExecutionSummaryCache(connectionId?: string): void {
  if (connectionId) summaryCache.delete(connectionId)
  else summaryCache.clear()
}
