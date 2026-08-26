import { NextResponse } from "next/server"
import {
  getLivePositions,
  getClosedLivePositions,
} from "@/lib/trade-engine/stages/live-stage"
import { initRedis, getRedisClient, getConnection } from "@/lib/redis-db"
import { getAlternateLivePositionKeys } from "@/lib/live-position-alt-index"
import { countLiveOpenPositions, isLiveOpenStatus } from "@/lib/live-position-status"
import { evaluateRealTradeReadiness } from "@/lib/real-trade-gates"
import { calculateLivePositionStatistics } from "@/lib/live-position-statistics"
import {
  derivePositionRoi,
  resolveSettledRealizedPnl,
  resolveUnrealizedPnl,
  roundPositionPnl,
} from "@/lib/live-position-pnl"
import { serveSerializedResponseSWR } from "@/lib/serialized-response-swr"
import { getLivePositionSource, type LivePositionSource } from "@/lib/live-position-source"

export const dynamic = "force-dynamic"

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

function closedLimitOf(value: string | null): number {
  const parsed = Number.parseInt(String(value || "200"), 10)
  return Number.isFinite(parsed) ? Math.min(1000, Math.max(1, parsed)) : 200
}

function mergeLifecyclePositions(...ledgers: any[][]): any[] {
  const byId = new Map<string, any>()
  const withoutId: any[] = []
  for (const position of ledgers.flat()) {
    const id = String(position?.id ?? position?.positionId ?? "").trim()
    if (id) byId.set(id, position)
    else withoutId.push(position)
  }
  return [...byId.values(), ...withoutId]
}

function normalizePosition(pos: any) {
  const source: LivePositionSource = getLivePositionSource(pos)
  return {
    ...pos,
    dataSource: source,
    isRealExchangeData: source === "real",
    isSimulated: source === "simulated",
  }
}

/**
 * The persisted lifecycle record deliberately contains full diagnostic lineage
 * (fills, set membership, position stages and control-order attempts).  That
 * record is correct for recovery, but returning it verbatim on a dashboard
 * poll made a 300-position Paper book serialize the same large nested graphs
 * several times (`positions`, `realPositions`, `simulatedPositions`).  Keep
 * the API read model intentionally small; mutations still load the
 * authoritative record by stable id on the server.
 */
function compactExchangeData(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const source = raw as Record<string, unknown>
  const fields = [
    "source", "markPrice", "currentPrice", "unrealizedPnl", "unrealizedPnL",
    "marginUsd", "fees", "totalFees", "fundingFee", "fundingFees",
    "exchangeOrderId", "exchangePositionId", "orderId", "syncedAt",
  ]
  const compact = Object.fromEntries(
    fields
      .filter((field) => source[field] !== undefined)
      .map((field) => [field, source[field]]),
  )
  // Do not use the Redis client's expensive `keys()` API in this route.  The
  // static regression guard intentionally rejects that spelling here too.
  return Object.values(compact).length > 0 ? compact : undefined
}

function toLivePositionView(pos: any): Record<string, unknown> {
  const pendingProtectionOrders = pos.pendingProtectionOrders && typeof pos.pendingProtectionOrders === "object"
    ? Object.fromEntries(Object.entries(pos.pendingProtectionOrders).map(([leg, raw]) => {
        const pending = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
        return [leg, {
          clientOrderId: pending.clientOrderId,
          triggerPrice: pending.triggerPrice,
          quantity: pending.quantity,
          absenceConfirmations: pending.absenceConfirmations,
        }]
      }))
    : undefined
  const pendingSystemAction = pos.pendingSystemAction && typeof pos.pendingSystemAction === "object"
    ? {
        phase: pos.pendingSystemAction.phase,
        reason: pos.pendingSystemAction.reason,
        startedAt: pos.pendingSystemAction.startedAt,
        updatedAt: pos.pendingSystemAction.updatedAt,
        requestedQuantity: pos.pendingSystemAction.requestedQuantity,
        appliedFilledQuantity: pos.pendingSystemAction.appliedFilledQuantity,
        absenceConfirmations: pos.pendingSystemAction.absenceConfirmations,
      }
    : undefined
  const pendingQuantityMutation = pos.pendingQuantityMutation && typeof pos.pendingQuantityMutation === "object"
    ? {
        phase: pos.pendingQuantityMutation.phase,
        reason: pos.pendingQuantityMutation.reason,
        quantityBefore: pos.pendingQuantityMutation.quantityBefore,
        startedAt: pos.pendingQuantityMutation.startedAt,
        updatedAt: pos.pendingQuantityMutation.updatedAt,
      }
    : undefined
  const view: Record<string, unknown> = {
    id: pos.id,
    connectionId: pos.connectionId,
    symbol: pos.symbol,
    direction: pos.direction,
    side: pos.side,
    status: pos.status,
    statusReason: pos.statusReason,
    executionMode: pos.executionMode,
    executionIntent: pos.executionIntent,
    executionBlockReason: pos.executionBlockReason,
    dataSource: pos.dataSource,
    isRealExchangeData: pos.isRealExchangeData,
    isSimulated: pos.isSimulated,
    entryPrice: pos.entryPrice,
    averageExecutionPrice: pos.averageExecutionPrice,
    markPrice: pos.markPrice,
    currentPrice: pos.currentPrice ?? pos.current_price,
    executedQuantity: pos.executedQuantity,
    totalExecutedQuantity: pos.totalExecutedQuantity,
    closedQuantity: pos.closedQuantity,
    remainingQuantity: pos.remainingQuantity,
    quantity: pos.quantity,
    leverage: pos.leverage,
    marginType: pos.marginType,
    volumeUsd: pos.volumeUsd,
    requestedVolume: pos.requestedVolume,
    intendedNotionalUsd: pos.intendedNotionalUsd,
    exchangeMinNotionalUsd: pos.exchangeMinNotionalUsd,
    systemVolumeFactor: pos.systemVolumeFactor,
    liveEngineFactor: pos.liveEngineFactor,
    signalVolumeFactor: pos.signalVolumeFactor,
    sizeMultiplier: pos.sizeMultiplier,
    volumeAdjusted: pos.volumeAdjusted,
    volumeAdjustmentReason: pos.volumeAdjustmentReason,
    positionCostPct: pos.positionCostPct,
    fees: pos.fees ?? pos.totalFees ?? pos.fee,
    fundingFee: pos.fundingFee ?? pos.fundingFees ?? pos.funding,
    unrealizedPnL: pos.unrealizedPnL,
    realizedPnL: pos.realizedPnL ?? pos.realized_pnl ?? pos.pnl,
    entryAccountingComplete: pos.entryAccountingComplete,
    realizedPnlComplete: pos.realizedPnlComplete,
    realizedPnlSource: pos.realizedPnlSource,
    pnlAccountingComplete: pos.pnlAccountingComplete,
    pnlAccountingSource: pos.pnlAccountingSource,
    accountingPending: String(pos.status || "").trim().toLowerCase() === "closed"
      ? resolveSettledRealizedPnl(pos) === undefined
      : false,
    exchangeQuantityAdjustmentCount: Array.isArray(pos.exchangeQuantityAdjustments)
      ? pos.exchangeQuantityAdjustments.length
      : 0,
    exchangeQuantityAdjustmentQuantity: Array.isArray(pos.exchangeQuantityAdjustments)
      ? pos.exchangeQuantityAdjustments.reduce(
        (sum: number, adjustment: any) => sum + Math.max(0, Number(adjustment?.quantity) || 0),
        0,
      )
      : 0,
    unrealizedRoi: pos.unrealizedRoi,
    liquidationPrice: pos.liquidationPrice,
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    stopLossPrice: pos.stopLossPrice,
    takeProfitPrice: pos.takeProfitPrice,
    trailingActive: pos.trailingActive,
    trailingStopPrice: pos.trailingStopPrice,
    trailingProfile: pos.trailingProfile && {
      mode: pos.trailingProfile.mode,
      startRatio: pos.trailingProfile.startRatio,
      stopRatio: pos.trailingProfile.stopRatio,
      stepRatio: pos.trailingProfile.stepRatio,
      minStopRatio: pos.trailingProfile.minStopRatio,
      positiveMoveRatio: pos.trailingProfile.positiveMoveRatio,
      updateStopRangeRatio: pos.trailingProfile.updateStopRangeRatio,
    },
    manualProtectionOverride: pos.manualProtectionOverride && {
      stopLossPrice: pos.manualProtectionOverride.stopLossPrice,
      takeProfitPrice: pos.manualProtectionOverride.takeProfitPrice,
      trailingEnabled: pos.manualProtectionOverride.trailingEnabled,
      trailingDistancePct: pos.manualProtectionOverride.trailingDistancePct,
      updatedAt: pos.manualProtectionOverride.updatedAt,
      source: pos.manualProtectionOverride.source,
    },
    setVariant: pos.setVariant,
    // Lane identity is part of the compact operational read model. Dropping
    // it made a correctly persisted Signal-Trailing position indistinguishable
    // from Signal-Standard in the UI, analytics, and production soak checks.
    executionLane: pos.executionLane ?? pos.execution_lane,
    setKey: pos.setKey,
    parentSetKey: pos.parentSetKey,
    indicationType: pos.indicationType,
    blockCount: pos.blockCount,
    dcaStep: pos.dcaStep,
    orderId: pos.orderId,
    stopLossOrderId: pos.stopLossOrderId,
    takeProfitOrderId: pos.takeProfitOrderId,
    stopLossArmedQuantity: pos.stopLossArmedQuantity,
    takeProfitArmedQuantity: pos.takeProfitArmedQuantity,
    protectionArmedQuantity: pos.protectionArmedQuantity,
    stopLossLastArmedAt: pos.stopLossLastArmedAt,
    takeProfitLastArmedAt: pos.takeProfitLastArmedAt,
    protectionMode: pos.protectionMode,
    systemProtectionLegs: pos.systemProtectionLegs,
    controlOrderCapacity: pos.controlOrderCapacity,
    submissionState: pos.submissionState,
    submissionAbsentConfirmations: pos.submissionAbsentConfirmations,
    pendingProtectionLegs: pendingProtectionOrders ? Object.keys(pendingProtectionOrders) : [],
    pendingProtectionOrders,
    pendingSystemAction,
    pendingQuantityMutation,
    closePrice: pos.closePrice ?? pos.exitPrice,
    createdAt: pos.createdAt,
    updatedAt: pos.updatedAt,
    closedAt: pos.closedAt,
    exchangeData: compactExchangeData(pos.exchangeData),
  }
  for (const [key, value] of Object.entries(view)) {
    if (value === undefined) delete view[key]
  }
  return view
}

function enrichPnl(pos: any) {
  const closed = String(pos.status || "").trim().toLowerCase() === "closed"
  const pnl = closed ? resolveSettledRealizedPnl(pos) : resolveUnrealizedPnl(pos)
  if (pnl !== undefined) {
    if (closed) pos.realizedPnL = roundPositionPnl(pnl)
    else pos.unrealizedPnL = roundPositionPnl(pnl)
  }

  const roi = derivePositionRoi(pos, pnl, closed)
  if (roi !== undefined) {
    if (closed) pos.realizedRoi = roundPositionPnl(roi)
    else pos.unrealizedRoi = roundPositionPnl(roi)
  }

  return pos
}

function computeStats(positions: any[]) {
  const closed = positions.filter((p) => String(p.status || "").trim().toLowerCase() === "closed")
  const settledClosed = closed
    .map((position) => ({ position, pnl: resolveSettledRealizedPnl(position) }))
    .filter((entry): entry is { position: any; pnl: number } => entry.pnl !== undefined)
  const accountingPending = closed.length - settledClosed.length
  const open = positions.filter((p) => isLiveOpenStatus(p.status))
  const totalRealizedPnL = settledClosed.reduce((sum, entry) => sum + entry.pnl, 0)
  const totalUnrealizedPnL = open.reduce((sum, p) => sum + (resolveUnrealizedPnl(p) ?? 0), 0)
  const wins = settledClosed.filter((entry) => entry.pnl > 0).length
  const losses = settledClosed.filter((entry) => entry.pnl < 0).length
  const breakEven = settledClosed.filter((entry) => entry.pnl === 0).length
  const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 10000) / 100 : 0
  return {
    total: positions.length,
    open: open.length,
    closed: closed.length,
    settledClosed: settledClosed.length,
    accountingPending,
    accountingComplete: accountingPending === 0,
    totalRealizedPnL: Math.round(totalRealizedPnL * 100) / 100,
    totalUnrealizedPnL: Math.round(totalUnrealizedPnL * 100) / 100,
    effectivePnL: Math.round((totalRealizedPnL + totalUnrealizedPnL) * 100) / 100,
    wins,
    losses,
    breakEven,
    winRate,
  }
}

/**
 * Returns all live positions for a connection, split into open and closed
 * buckets (via dedicated Redis index lists), plus aggregate stats.
 *
 * Query params:
 *   connection_id / connectionId - required connection to query
 *   closedLimit                 - max number of closed positions to include (default 200)
 *   status                      - optional filter (e.g. "open", "closed", "error")
 *   source                      - all|real|simulated|unknown (default all)
 */
async function buildLivePositionsResponse(request: Request) {
  const { searchParams } = new URL(request.url)
  const connectionId = String(
    searchParams.get("connection_id") || searchParams.get("connectionId") || "",
  ).trim()
  if (!connectionId) {
    return NextResponse.json(
      { error: "connection_id query parameter required" },
      { status: 400 },
    )
  }
  const closedLimit = closedLimitOf(searchParams.get("closedLimit"))
  const statusFilter = searchParams.get("status") || undefined
  const sourceFilter = (searchParams.get("source") || "all").toLowerCase()

  try {
    await initRedis()

    const [open, closed, connection] = await Promise.all([
      getLivePositions(connectionId),
      getClosedLivePositions(connectionId, closedLimit),
      getConnection(connectionId).catch(() => null),
    ])

    // Fallback: also read positions stored under alternate key patterns.
    // New writers should maintain live:position:live:{connectionId}:index so this path
    // remains bounded; legacy unindexed data falls back to bounded SCAN only.
    const client = getRedisClient()
    const { keys: altKeys, partialLegacyScan } = await getAlternateLivePositionKeys(client, connectionId)
    const altPositions: any[] = []
    const seenIds = new Set<string>([...open.map((p) => p.id!).filter(Boolean), ...closed.map((p) => p.id!).filter(Boolean)])
    for (const key of altKeys) {
      try {
        const raw = await client.get(key)
        if (raw) {
          const p = JSON.parse(raw)
          if (!seenIds.has(p.id)) {
            altPositions.push(p)
            seenIds.add(p.id)
          }
        }
      } catch { /* skip malformed */ }
    }

    // Closed/archive rows override a stale open-index copy with the same id.
    // This makes the dashboard monotonic during the short archive transition.
    const all = mergeLifecyclePositions(open, closed, altPositions)
      .map((pos) => enrichPnl(normalizePosition(pos)))
      .sort((a, b) => timestampOf(b.createdAt ?? b.openedAt ?? b.updatedAt)
        - timestampOf(a.createdAt ?? a.openedAt ?? a.updatedAt))

    const realPositions = all.filter((p) => p.dataSource === "real")
    const simulatedPositions = all.filter((p) => p.dataSource === "simulated")
    const unknownPositions = all.filter((p) => p.dataSource === "unknown")

    const sourceFiltered =
      sourceFilter === "real" ? realPositions :
        sourceFilter === "simulated" ? simulatedPositions :
          sourceFilter === "unknown" ? unknownPositions :
            all

    const filtered = statusFilter
      ? sourceFiltered.filter((p) => String(p.status || "").trim().toLowerCase() === statusFilter.trim().toLowerCase())
      : sourceFiltered

    // We already hold the canonical open/closed read model for this response.
    // Re-reading every position through calculateLivePositionStats doubled
    // hydration and amplified heap churn under the 280 ms Paper lifecycle.
    const allStats = computeStats(all)
    const completeStatistics = calculateLivePositionStatistics(all)
    const realExchangeStatistics = calculateLivePositionStatistics(realPositions)
    const simulatedStatistics = calculateLivePositionStatistics(simulatedPositions)
    const legacyStats = {
      // `filled` is a transient lifecycle status. Count every position with a
      // confirmed lifetime execution, including rows already open or closed.
      totalFilled: completeStatistics.filled,
      totalOpen: allStats.open,
      totalClosed: allStats.closed,
      totalPnL: allStats.effectivePnL,
      averageROI: 0,
      winRate: allStats.winRate,
    }

    const positionViews = all.map(toLivePositionView)
    const viewsById = new Map(positionViews.map((position) => [String(position.id), position]))
    const viewFor = (position: any) => viewsById.get(String(position.id)) || toLivePositionView(position)

    const liveReadiness = evaluateRealTradeReadiness((connection || {}) as Record<string, any>)
    const liveTradeEnabled = liveReadiness.canPlaceRealOrders
    const liveTradeRequested = liveReadiness.requested
    const liveTradeBlockedReason = liveReadiness.blockReason

    return NextResponse.json({
      connectionId,
      sourceFilter,
      positions: filtered.map(viewFor),
      realPositions: realPositions.map(viewFor),
      simulatedPositions: simulatedPositions.map(viewFor),
      counts: {
        total: all.length,
        real: realPositions.length,
        simulated: simulatedPositions.length,
        unknown: unknownPositions.length,
        open: countLiveOpenPositions(all),
        executed: completeStatistics.filled,
        pending: all.filter((p) => String(p.status || "").trim().toLowerCase() === "pending").length,
        placed: all.filter((p) => ["placed", "pending_fill", "placed_unconfirmed"].includes(String(p.status || "").trim().toLowerCase())).length,
        pending_fill: all.filter((p) => String(p.status || "").trim().toLowerCase() === "pending_fill").length,
        filled: all.filter((p) => String(p.status || "").trim().toLowerCase() === "filled").length,
        closing: all.filter((p) => String(p.status || "").trim().toLowerCase() === "closing").length,
        closing_partial: all.filter((p) => String(p.status || "").trim().toLowerCase() === "closing_partial").length,
        closed: allStats.closed,
        settledClosed: allStats.settledClosed,
        accountingPending: allStats.accountingPending,
        rejected: all.filter((p) => String(p.status || "").trim().toLowerCase() === "rejected").length,
        error: all.filter((p) => String(p.status || "").trim().toLowerCase() === "error").length,
      },
      stats: {
        ...legacyStats,
        all: allStats,
        real: computeStats(realPositions),
        simulated: computeStats(simulatedPositions),
        complete: completeStatistics,
        realComplete: realExchangeStatistics,
        simulatedComplete: simulatedStatistics,
      },
      partialLegacyScan,
      dataIntegrity: {
        liveTradeEnabled,
        liveTradeRequested,
        liveTradeBlockedReason,
        liveTradeBlockCode: liveReadiness.blockCode,
        liveExecutionMode: liveReadiness.executionMode,
        credentialsValid: liveReadiness.credentialsValid,
        durableCoordinationReady: liveReadiness.durableCoordinationReady,
        positionOrderRelationIntegrity: realExchangeStatistics.relationIntegrity,
        realExchangeDataComplete: realPositions.length > 0 || !liveTradeEnabled,
        message: liveTradeEnabled
          ? "Real exchange positions are separated from simulated/paper positions and use exchange-synced order/position identifiers when available."
          : liveTradeRequested
            ? `Live exchange trading is blocked: ${liveTradeBlockedReason}`
          : "Live exchange order placement is not enabled; returned exchange-real history may be empty and simulated positions are separated from real data.",
      },
    })
  } catch (err) {
    console.warn("[v0] [LivePositions API] Error:", err instanceof Error ? err.message : String(err))
    return NextResponse.json({
      connectionId,
      positions: [],
      realPositions: [],
      simulatedPositions: [],
      counts: { total: 0, real: 0, simulated: 0 },
      stats: null,
    })
  }
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "test") return buildLivePositionsResponse(request)
  const url = new URL(request.url)
  const connectionId = String(
    url.searchParams.get("connection_id") || url.searchParams.get("connectionId") || "",
  ).trim()
  if (!connectionId) {
    return NextResponse.json(
      { error: "connection_id query parameter required" },
      { status: 400 },
    )
  }
  const closedLimit = closedLimitOf(url.searchParams.get("closedLimit"))
  const status = url.searchParams.get("status") || "all"
  const source = (url.searchParams.get("source") || "all").toLowerCase()
  return serveSerializedResponseSWR({
    namespace: "live-positions",
    key: `${connectionId}|${closedLimit}|${status}|${source}`,
    freshMs: 2_000,
    maxStaleMs: 15_000,
    serveExpiredImmediately: true,
    producer: () => buildLivePositionsResponse(request),
  })
}
