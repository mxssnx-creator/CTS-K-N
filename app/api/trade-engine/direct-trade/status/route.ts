import { NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { buildDirectTradeOverview48h } from "@/lib/direct-trade-overview-stats"
import {
  DIRECT_TRADE_CONNECTION_INDEX_KEY,
  directTradeKeyspace,
  normalizeDirectTradeConnectionId,
} from "@/lib/direct-trade-keyspace"

export const dynamic = "force-dynamic"

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
        const [stateRaw, positionsRaw, processorRaw] = await Promise.all([
          client.get(scoped.state),
          client.get(scoped.positions),
          client.get(scoped.processor),
        ])
        const state = stateRaw ? JSON.parse(stateRaw) : null
        const positions = positionsRaw ? JSON.parse(positionsRaw) : []
        const processor = processorRaw ? JSON.parse(processorRaw) : null
        const openPositions = Array.isArray(positions)
          ? positions.filter((position: any) => position?.status === "open" || position?.status === "opening").length
          : 0
        const required = state?.enabled === true || openPositions > 0
        const healthy = !required || Boolean(
          processor?.lastTick && now - Date.parse(String(processor.lastTick)) < 7_000,
        )
        return { connectionId, required, healthy, openPositions, state, processor }
      }))
      const scopedConnections = connections.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      const required = scopedConnections.some((entry) => entry.required)
      const healthy = scopedConnections.every((entry) => entry.healthy)
      return NextResponse.json({
        success: true,
        aggregate: true,
        state: { enabled: scopedConnections.some((entry) => entry.state?.enabled === true) },
        openPositions: scopedConnections.reduce((sum, entry) => sum + entry.openPositions, 0),
        processorRequired: required,
        processorHealthy: healthy,
        processor: { isHealthy: healthy },
        connections: scopedConnections,
      })
    }
    const connectionId = normalizeDirectTradeConnectionId(params.get("connectionId"))
    const keys = directTradeKeyspace(connectionId)
    const [stateRaw, statsRaw, positionsRaw, openPositionStageRaw, processorRaw, configStatusRaw, calculationRaw, progressRaw, recoveryRequestRaw] = await Promise.all([
      client.get(keys.state),
      client.get(keys.stats),
      client.get(keys.positions),
      client.get(keys.openPositionStage),
      client.get(keys.processor),
      client.get(keys.configStatus),
      client.get(keys.calculation),
      client.get(keys.calculationProgress),
      client.get(keys.recoveryRequest),
    ])

    const state = stateRaw ? JSON.parse(stateRaw) : null
    const stats = statsRaw ? JSON.parse(statsRaw) : null
    // Modern calculations persist aggregate counts. Do not deserialize the
    // potentially large eligible-config snapshot on each dashboard poll.
    // The fallback retains accurate status for pre-index installations.
    const calculation = calculationRaw ? JSON.parse(calculationRaw) : null
    const calculationProgress = progressRaw ? JSON.parse(progressRaw) : null
    const hasIndexedCounts = Number.isFinite(Number(calculation?.evaluatedSets))
    const executionConfigs: any[] = []
    const positions = positionsRaw ? JSON.parse(positionsRaw) : []
    const openPositionStage = openPositionStageRaw ? JSON.parse(openPositionStageRaw) : null
    const processor = processorRaw ? JSON.parse(processorRaw) : null
    const configStatus = configStatusRaw ? JSON.parse(configStatusRaw) : {}
    if (!hasIndexedCounts) {
      const executionConfigsRaw = await client.get(keys.executionConfigs)
      if (executionConfigsRaw) executionConfigs.push(...JSON.parse(executionConfigsRaw))
    }

    // Calculate rolling stats from positions
    const now = Date.now()
    const closedPositions = positions
      .filter((p: any) => p.status === "closed")
      .sort((left: any, right: any) =>
        new Date(left.closedAt || left.exitTime || 0).getTime() -
        new Date(right.closedAt || right.exitTime || 0).getTime(),
      )
    const openPositions = positions.filter((p: any) => p.status === "open")
    const openingPositions = positions.filter((p: any) => p.status === "opening")
    const processorRequired = state?.enabled === true || openPositions.length > 0 || openingPositions.length > 0
    const processorHeartbeatHealthy = Boolean(
      processor?.lastTick && (now - new Date(processor.lastTick).getTime()) < 7000,
    )
    const processorHealthy = !processorRequired || processorHeartbeatHealthy

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
    const responseStats = stats
      ? {
          ...stats,
          ...rollingStats,
          ...(closedPositions.length > 0 ? {
            profitFactorPercent: stats.profitFactor,
            profitFactor: allRolling.pf,
            profitFactorInfinite: allRolling.pfInfinite,
            totalPnlUsdt: allRolling.pnlUsdt,
            statsPnlBasis: allRolling.basis,
          } : {}),
        }
      : { ...rollingStats, ...allRolling }

    return NextResponse.json({
      success: true,
      state,
      stats: responseStats,
      activeConfigs: Math.max(0, Number(calculation?.evaluatedSets) || executionConfigs.length),
      validConfigs: Math.max(0, Number(calculation?.validSets) || executionConfigs.length),
      evaluatedConfigs: Math.max(0, Number(calculation?.evaluatedSets) || executionConfigs.length),
      openPositions: openPositions.length,
      openingPositions: openingPositions.length,
      openPositionStage,
      closedPositions: closedPositions.length,
      processorRequired,
      processorHealthy,
      overview48h,
      configStatus,
      calculation,
      calculationProgress,
      disabledConfigs: Object.values(configStatus as Record<string, any>)
        .filter((entry: any) => entry?.enabled === false).length,
      processor: processor ? {
        lastTick: processor.lastTick,
        tickCount: processor.tickCount,
        errorsLast5min: processor.errorsLast5min || 0,
        historyPolicy: processor.historyPolicy || null,
        isHealthy: processorHeartbeatHealthy,
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
  const isExchange = (position: any) => {
    const mode = String(position?.mode ?? position?.executionMode ?? "").toLowerCase()
    return mode === "live" || mode === "exchange" || mode === "real" || Boolean(position?.exchangeOrderId)
  }
  const accounted = positions.filter((position) => !isExchange(position) || (
    position?.pnlAccountingComplete !== false && Number.isFinite(Number(position?.realizedPnlUsdt))
  ))
  const accountingPending = positions.length - accounted.length
  if (!accounted.length) return { pf: null, pfInfinite: false, ddt: 0, pnl: 0, pnlUsdt: 0, basis: "percent", accountingPending }
  const percentValue = (position: any) => Number(position.pnl) || 0
  const hasCompleteNotional = accounted.every((position) => {
    if (Number.isFinite(Number(position.realizedPnlUsdt))) return true
    if (isExchange(position)) return false
    return Number(position.entryPrice) > 0 && Number(position.quantity) > 0 && Number.isFinite(Number(position.pnl))
  })
  const value = (position: any) => {
    if (!hasCompleteNotional) return percentValue(position)
    if (Number.isFinite(Number(position.realizedPnlUsdt))) return Number(position.realizedPnlUsdt)
    return Math.abs(Number(position.entryPrice) * Number(position.quantity)) * percentValue(position) / 100
  }
  const wins = accounted.filter((p) => value(p) > 0)
  const losses = accounted.filter((p) => value(p) <= 0)
  const totalProfit = wins.reduce((s, p) => s + value(p), 0)
  const totalLoss = Math.abs(losses.reduce((s, p) => s + value(p), 0))
  const pfInfinite = totalLoss === 0 && totalProfit > 0
  const pf = totalLoss > 0 ? totalProfit / totalLoss : 0
  const avgDdt = accounted.reduce((s, p) => s + (p.drawdownTimeMin || 0), 0) / accounted.length
  const totalPnl = accounted.reduce((s, p) => s + percentValue(p), 0)
  const totalPnlUsdt = hasCompleteNotional ? accounted.reduce((s, p) => s + value(p), 0) : 0
  return {
    pf: pfInfinite ? null : Number(pf.toFixed(3)),
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
