import { NextResponse } from "next/server"
import { getConnection, getRedisClient, initRedis } from "@/lib/redis-db"
import {
  buildDirectTradeOverview48h,
  resolveDirectTradeSettledExchangePnlUsdt,
} from "@/lib/direct-trade-overview-stats"
import { buildDirectTradeIndicationTypeStats } from "@/lib/direct-trade-indication-stats"
import {
  DIRECT_TRADE_CONNECTION_INDEX_KEY,
  directTradeKeyspace,
  normalizeDirectTradeConnectionId,
} from "@/lib/direct-trade-keyspace"
import { directTradeLiveExecutionReadiness } from "@/lib/direct-trade-live-readiness"
import { normalizeMarketType } from "@/lib/market-types"
import { DEFAULT_FOREX_POSITIONS_AVERAGE } from "@/lib/forex-market"

export const dynamic = "force-dynamic"

// A 1.5s worker heartbeat uses a bounded 2.5s HTTP request. Three or four
// delayed acknowledgements during history publication are degraded telemetry,
// not proof that the lease owner died. Keep the restart-grade heartbeat gate
// comfortably above that transport budget; progress remains a separate signal.
const PROCESSOR_HEARTBEAT_STALE_MS = 20_000
const PROCESSOR_PROGRESS_STALE_MS = 60_000

function parseStoredJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    return parsed === null || parsed === undefined ? fallback : parsed as T
  } catch {
    return fallback
  }
}

function directTradeStatus(value: unknown): string {
  return String(value || "").trim().toLowerCase()
}

function isExchangePosition(position: any): boolean {
  const mode = directTradeStatus(position?.mode || position?.executionMode)
  return mode === "live" || mode === "exchange" || mode === "real" || Boolean(position?.exchangeOrderId)
}

function processorRuntimeStatus(
  processor: any,
  heartbeatRaw: string | null,
  now = Date.now(),
): {
  processor: any
  heartbeatHealthy: boolean
  progressHealthy: boolean
  heartbeatAgeMs: number | null
  healthy: boolean
  progressAgeMs: number | null
} {
  const lastHeartbeatAt = heartbeatRaw || processor?.lastHeartbeatAt || processor?.lastTick || null
  // Pre-upgrade workers do not publish `lastProgressAt`; their full snapshot
  // tick is the only safe evidence that the lifecycle itself completed.
  const lastProgressAt = processor?.lastProgressAt || processor?.lastTick || null
  const heartbeatAt = Date.parse(String(lastHeartbeatAt || ""))
  const progressAt = Date.parse(String(lastProgressAt || ""))
  const heartbeatAgeMs = Number.isFinite(heartbeatAt) ? Math.max(0, now - heartbeatAt) : null
  const progressAgeMs = Number.isFinite(progressAt) ? Math.max(0, now - progressAt) : null
  const heartbeatHealthy = heartbeatAgeMs !== null && heartbeatAgeMs < PROCESSOR_HEARTBEAT_STALE_MS
  const progressHealthy = progressAgeMs !== null && progressAgeMs < PROCESSOR_PROGRESS_STALE_MS
  return {
    processor: processor || lastHeartbeatAt ? {
      ...(processor || {}),
      lastTick: lastHeartbeatAt,
      lastHeartbeatAt,
      lastProgressAt,
      heartbeatAgeMs,
      progressAgeMs,
    } : null,
    heartbeatHealthy,
    progressHealthy,
    // Recovery must act on a stale dedicated heartbeat, never on slow useful
    // work alone. `progressHealthy` remains visible as a degraded-work signal.
    healthy: heartbeatHealthy,
    heartbeatAgeMs,
    progressAgeMs,
  }
}

function publicProcessorStatus(processor: any): Record<string, unknown> | null {
  if (!processor || typeof processor !== "object") return null
  return {
    lastTick: typeof processor.lastTick === "string" ? processor.lastTick : null,
    lastHeartbeatAt: typeof processor.lastHeartbeatAt === "string" ? processor.lastHeartbeatAt : null,
    lastProgressAt: typeof processor.lastProgressAt === "string" ? processor.lastProgressAt : null,
    heartbeatAgeMs: Number.isFinite(Number(processor.heartbeatAgeMs)) ? Math.max(0, Number(processor.heartbeatAgeMs)) : null,
    progressAgeMs: Number.isFinite(Number(processor.progressAgeMs)) ? Math.max(0, Number(processor.progressAgeMs)) : null,
    lifecycleCycleCount: Math.max(0, Math.floor(Number(processor.lifecycleCycleCount) || 0)),
    tickCount: Math.max(0, Math.floor(Number(processor.tickCount) || 0)),
    errorsLast5min: Math.max(0, Math.floor(Number(processor.errorsLast5min) || 0)),
    recalculationInFlight: processor.recalculationInFlight === true,
    nextRecalcAttemptAt: typeof processor.nextRecalcAttemptAt === "string" ? processor.nextRecalcAttemptAt : null,
    historyPolicy: processor.historyPolicy && typeof processor.historyPolicy === "object"
      ? processor.historyPolicy
      : null,
  }
}

async function getClient() {
  await initRedis()
  return getRedisClient()
}

export async function GET(request: Request) {
  try {
    const client = await getClient()
    const params = new URL(request.url).searchParams
    if (params.get("aggregate") === "1") {
      const connectionIds = await client.smembers(DIRECT_TRADE_CONNECTION_INDEX_KEY).catch(() => [])
      const now = Date.now()
      const connections = await Promise.all(connectionIds.map(async (rawId) => {
        const connectionId = normalizeDirectTradeConnectionId(rawId)
        if (!connectionId) return null
        const scoped = directTradeKeyspace(connectionId)
        const [stateRaw, positionsRaw, processorRaw, processorHeartbeatRaw] = await Promise.all([
          client.get(scoped.state),
          client.get(scoped.positions),
          client.get(scoped.processor),
          client.get(scoped.processorHeartbeat),
        ])
        const state = parseStoredJson<any>(stateRaw, null)
        const storedPositions = parseStoredJson<unknown>(positionsRaw, [])
        const positions = Array.isArray(storedPositions) ? storedPositions : []
        const processor = parseStoredJson<any>(processorRaw, null)
        const runtime = processorRuntimeStatus(processor, processorHeartbeatRaw, now)
        const latestProcessor = runtime.processor
        const openPositions = Array.isArray(positions)
          ? positions.filter((position: any) => {
              const status = directTradeStatus(position?.status)
              return status === "open" || status === "opening"
            }).length
          : 0
        const accountingPending = Array.isArray(positions)
          ? positions.filter((position: any) => (
              directTradeStatus(position?.status) === "closed"
              && isExchangePosition(position)
              && resolveDirectTradeSettledExchangePnlUsdt(position) === null
            )).length
          : 0
        const required = state?.enabled === true || openPositions > 0 || accountingPending > 0
        const healthy = !required || runtime.healthy
        return {
          connectionId,
          required,
          healthy,
          heartbeatHealthy: !required || runtime.heartbeatHealthy,
          progressHealthy: !required || runtime.progressHealthy,
          degraded: required && runtime.heartbeatHealthy && !runtime.progressHealthy,
          openPositions,
          accountingPending,
          state,
          processor: publicProcessorStatus(latestProcessor),
        }
      }))
      const scopedConnections = connections.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      const required = scopedConnections.some((entry) => entry.required)
      const healthy = scopedConnections.every((entry) => entry.healthy)
      const heartbeatHealthy = scopedConnections.every((entry) => entry.heartbeatHealthy)
      const progressHealthy = scopedConnections.every((entry) => entry.progressHealthy)
      return NextResponse.json({
        success: true,
        aggregate: true,
        state: { enabled: scopedConnections.some((entry) => entry.state?.enabled === true) },
        openPositions: scopedConnections.reduce((sum, entry) => sum + entry.openPositions, 0),
        accountingPending: scopedConnections.reduce((sum, entry) => sum + entry.accountingPending, 0),
        processorRequired: required,
        processorHealthy: healthy,
        processorProgressHealthy: progressHealthy,
        processor: {
          isHealthy: healthy,
          heartbeatHealthy,
          progressHealthy,
          degraded: required && heartbeatHealthy && !progressHealthy,
        },
        connections: scopedConnections,
      })
    }
    const connectionId = normalizeDirectTradeConnectionId(params.get("connectionId"))
    if (!connectionId) {
      return NextResponse.json(
        { success: false, error: "A valid connectionId is required" },
        { status: 400 },
      )
    }
    const keys = directTradeKeyspace(connectionId)
    const [stateRaw, statsRaw, positionsRaw, openPositionStageRaw, processorRaw, processorHeartbeatRaw, configStatusRaw, calculationRaw, progressRaw, recoveryRequestRaw, connection] = await Promise.all([
      client.get(keys.state),
      client.get(keys.stats),
      client.get(keys.positions),
      client.get(keys.openPositionStage),
      client.get(keys.processor),
      client.get(keys.processorHeartbeat),
      client.get(keys.configStatus),
      client.get(keys.calculation),
      client.get(keys.calculationProgress),
      client.get(keys.recoveryRequest),
      getConnection(connectionId).catch(() => null),
    ])

    const state = parseStoredJson<any>(stateRaw, null)
    const stats = parseStoredJson<any>(statsRaw, null)
    // Modern calculations persist aggregate counts. Do not deserialize the
    // potentially large eligible-config snapshot on each dashboard poll.
    // The fallback retains accurate status for pre-index installations.
    const calculation = parseStoredJson<any>(calculationRaw, null)
    const calculationProgress = parseStoredJson<any>(progressRaw, null)
    const hasIndexedCounts = Number.isFinite(Number(calculation?.evaluatedSets))
    const executionConfigs: any[] = []
    const storedPositions = parseStoredJson<unknown>(positionsRaw, [])
    const positions: any[] = Array.isArray(storedPositions) ? storedPositions : []
    const openPositionStage = parseStoredJson<any>(openPositionStageRaw, null)
    const processor = parseStoredJson<any>(processorRaw, null)
    const processorRuntime = processorRuntimeStatus(processor, processorHeartbeatRaw)
    const latestProcessor = processorRuntime.processor
    const configStatus = parseStoredJson<Record<string, any>>(configStatusRaw, {})
    const marketType = normalizeMarketType(
      state?.marketType ?? connection?.market_type ?? connection?.asset_class,
      connection?.exchange,
    )
    const settlementAsset = String(
      state?.settlementAsset ?? connection?.settlement_asset ?? connection?.last_test_settlement_asset ??
      (marketType === "forex" ? "account_currency" : "USDT"),
    ).trim() || (marketType === "forex" ? "account_currency" : "USDT")
    const positionsAverage = Number(
      state?.positionsAverage ?? connection?.positions_average ?? connection?.average_count ??
      (marketType === "forex" ? DEFAULT_FOREX_POSITIONS_AVERAGE : 2),
    )
    const positionCostPct = Number(state?.positionCostPercent ?? connection?.position_cost_percent ?? 0.1)
    if (!hasIndexedCounts) {
      const executionConfigsRaw = await client.get(keys.executionConfigs)
      const storedExecutionConfigs = parseStoredJson<unknown>(executionConfigsRaw, [])
      if (Array.isArray(storedExecutionConfigs)) executionConfigs.push(...storedExecutionConfigs)
    }

    // Calculate rolling stats from positions
    const now = Date.now()
    const allClosedPositions = positions
      .filter((p: any) => directTradeStatus(p.status) === "closed")
      .sort((left: any, right: any) =>
        new Date(left.closedAt || left.exitTime || 0).getTime() -
        new Date(right.closedAt || right.exitTime || 0).getTime(),
      )
    const selectedMode = state?.liveMode === true ? "live" : "simulated"
    const closedPositions = allClosedPositions.filter((position: any) => (
      (isExchangePosition(position) ? "live" : "simulated") === selectedMode
    ))
    const accountingPending = allClosedPositions.filter((position: any) => (
      isExchangePosition(position)
      && resolveDirectTradeSettledExchangePnlUsdt(position) === null
    )).length
    const openPositions = positions.filter((p: any) => directTradeStatus(p.status) === "open")
    const openingPositions = positions.filter((p: any) => directTradeStatus(p.status) === "opening")
    const processorRequired = state?.enabled === true
      || openPositions.length > 0
      || openingPositions.length > 0
      || accountingPending > 0
    const processorHeartbeatHealthy = processorRuntime.heartbeatHealthy
    const processorProgressHealthy = processorRuntime.progressHealthy
    const processorHealthy = !processorRequired || processorRuntime.heartbeatHealthy

    const rollingStats = {
      last12Pos: calculateRollingPF(closedPositions.slice(-12)),
      last25Pos: calculateRollingPF(closedPositions.slice(-25)),
      last50Pos: calculateRollingPF(closedPositions.slice(-50)),
      last4h: calculateTimePF(closedPositions, now - 4 * 60 * 60 * 1000),
      last12h: calculateTimePF(closedPositions, now - 12 * 60 * 60 * 1000),
      last48h: calculateTimePF(closedPositions, now - 48 * 60 * 60 * 1000),
    }
    const allRolling = calculateRollingPF(closedPositions)
    const overview48h = buildDirectTradeOverview48h(positions, now)
    const indicationTypeStats = buildDirectTradeIndicationTypeStats({
      positions,
      calculation,
      selectedMode,
      enabledIndicationTypes: Array.isArray(state?.enabledIndicationTypes)
        ? state.enabledIndicationTypes
        : [],
    })
    const liveExecutionReadiness = directTradeLiveExecutionReadiness(connection as any, connectionId)
    const responseStats = {
      ...(stats || {}),
      ...rollingStats,
      profitFactorPercent: selectedMode === "simulated" ? allRolling.pf : stats?.profitFactorPercent,
      profitFactor: allRolling.pf,
      profitFactorInfinite: allRolling.pfInfinite,
      totalPnl: allRolling.pnl,
      totalPnlUsdt: allRolling.pnlUsdt,
      statsPnlBasis: allRolling.basis,
      settledClosedCount: closedPositions.length - allRolling.accountingPending,
      accountingPending: allRolling.accountingPending,
      openPositionCount: openPositions.length,
      openingPositionCount: openingPositions.length,
    }

    return NextResponse.json({
      success: true,
      marketType,
      settlementAsset,
      volumeUnit: marketType === "forex" ? "lots" : "base_units",
      positionsAverage: Number.isFinite(positionsAverage) && positionsAverage > 0 ? positionsAverage : marketType === "forex" ? DEFAULT_FOREX_POSITIONS_AVERAGE : 2,
      positionCostPct: Number.isFinite(positionCostPct) && positionCostPct > 0 ? positionCostPct : 0.1,
      state: state ? {
        ...state,
        liveExecutionReady: liveExecutionReadiness.ready,
        liveExecutionBlockReason: liveExecutionReadiness.blockReason,
      } : state,
      liveExecutionReadiness,
      stats: responseStats,
      activeConfigs: Math.max(0, Number(calculation?.evaluatedSets) || executionConfigs.length),
      validConfigs: Math.max(0, Number(calculation?.validSets) || executionConfigs.length),
      evaluatedConfigs: Math.max(0, Number(calculation?.evaluatedSets) || executionConfigs.length),
      openPositions: openPositions.length,
      openingPositions: openingPositions.length,
      openPositionStage,
      closedPositions: closedPositions.length,
      accountingPending,
      processorRequired,
      processorHealthy,
      overview48h,
      indicationTypeStats,
      configStatus,
      calculation,
      calculationProgress,
      disabledConfigs: Object.values(configStatus as Record<string, any>)
        .filter((entry: any) => entry?.enabled === false).length,
      processor: latestProcessor ? {
        lastTick: latestProcessor.lastTick,
        lastHeartbeatAt: latestProcessor.lastHeartbeatAt,
        lastProgressAt: latestProcessor.lastProgressAt,
        progressAgeMs: latestProcessor.progressAgeMs,
        heartbeatAgeMs: latestProcessor.heartbeatAgeMs,
        lifecycleCycleCount: latestProcessor.lifecycleCycleCount || 0,
        tickCount: latestProcessor.tickCount,
        errorsLast5min: latestProcessor.errorsLast5min || 0,
        historyPolicy: latestProcessor.historyPolicy || null,
        heartbeatHealthy: processorHeartbeatHealthy,
        progressHealthy: processorProgressHealthy,
        isHealthy: processorRuntime.heartbeatHealthy,
        degraded: processorRequired && processorRuntime.heartbeatHealthy && !processorProgressHealthy,
      } : null,
      recovery: recoveryRequestRaw ? (() => {
        try {
          const request = JSON.parse(recoveryRequestRaw)
          return {
            requested: true,
            requestedAt: request?.requestedAt || null,
            reason: request?.reason || "unknown",
          }
        } catch {
          return { requested: true, requestedAt: null, reason: "invalid-recovery-request" }
        }
      })() : { requested: false, requestedAt: null, reason: null },
    })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to get direct-trade status", details: String(error) },
      { status: 500 },
    )
  }
}

function calculateRollingPF(positions: any[]): {
  pf: number | null
  pfInfinite: boolean
  ddt: number
  pnl: number
  pnlUsdt: number
  basis: "usdt" | "percent"
  accountingPending: number
} {
  const finite = (value: unknown): number | null => {
    if (value === undefined || value === null || typeof value === "boolean") return null
    if (typeof value === "string" && value.trim() === "") return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const accounted = positions.filter((position) => (
    !isExchangePosition(position)
    || resolveDirectTradeSettledExchangePnlUsdt(position) !== null
  ))
  const accountingPending = positions.length - accounted.length
  const exchangeBasis = positions.some(isExchangePosition)
  if (!accounted.length) {
    return {
      pf: null,
      pfInfinite: false,
      ddt: 0,
      pnl: 0,
      pnlUsdt: 0,
      basis: exchangeBasis ? "usdt" : "percent",
      accountingPending,
    }
  }
  const percentValue = (position: any) => finite(position.pnl) ?? finite(position.pnlPercent) ?? 0
  const hasCompleteNotional = accounted.every((position) => {
    if (isExchangePosition(position)) {
      return resolveDirectTradeSettledExchangePnlUsdt(position) !== null
    }
    if (finite(position.realizedPnlUsdt) !== null) return true
    return (finite(position.entryPrice) ?? 0) > 0
      && (finite(position.quantity) ?? 0) > 0
      && finite(position.pnl) !== null
  })
  const value = (position: any) => {
    if (!hasCompleteNotional) return percentValue(position)
    if (isExchangePosition(position)) {
      return resolveDirectTradeSettledExchangePnlUsdt(position) ?? 0
    }
    const explicit = finite(position.realizedPnlUsdt)
    if (explicit !== null) return explicit
    return Math.abs((finite(position.entryPrice) ?? 0) * (finite(position.quantity) ?? 0)) * percentValue(position) / 100
  }
  const values = accounted.map(value)
  const totalProfit = values.reduce((sum, current) => sum + Math.max(0, current), 0)
  const totalLoss = values.reduce((sum, current) => sum + Math.abs(Math.min(0, current)), 0)
  const pfInfinite = totalLoss === 0 && totalProfit > 0
  const pf = totalLoss > 0 ? totalProfit / totalLoss : null
  const avgDdt = accounted.reduce((s, p) => s + (p.drawdownTimeMin || 0), 0) / accounted.length
  const totalPnl = accounted.reduce((s, p) => s + percentValue(p), 0)
  const totalPnlUsdt = hasCompleteNotional ? values.reduce((sum, current) => sum + current, 0) : 0
  return {
    pf: pf === null || pfInfinite ? null : Number(pf.toFixed(3)),
    pfInfinite,
    ddt: Number(avgDdt.toFixed(1)),
    pnl: Number(totalPnl.toFixed(4)),
    pnlUsdt: Number(totalPnlUsdt.toFixed(8)),
    basis: hasCompleteNotional ? "usdt" : "percent",
    accountingPending,
  }
}

function calculateTimePF(positions: any[], since: number): ReturnType<typeof calculateRollingPF> {
  const filtered = positions.filter((p) => new Date(p.closedAt || p.exitTime || 0).getTime() >= since)
  return calculateRollingPF(filtered)
}
