import { type NextRequest, NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { DIRECT_TRADE_OPEN_POSITION_STAGE_KEY } from "@/lib/direct-trade-position-stage"

export const dynamic = "force-dynamic"

const DIRECT_TRADE_STATE_KEY = "direct_trade:state"
const DIRECT_TRADE_STATS_KEY = "direct_trade:stats"
const DIRECT_TRADE_EXECUTION_CONFIGS_KEY = "direct_trade:execution-configs"
const DIRECT_TRADE_POSITIONS_KEY = "direct_trade:positions"
const DIRECT_TRADE_PROCESSOR_KEY = "direct_trade:processor"
const DIRECT_TRADE_CONFIG_STATUS_KEY = "direct_trade:config-status"
const DIRECT_TRADE_CALCULATION_KEY = "direct_trade:calculation"
const DIRECT_TRADE_CALCULATION_PROGRESS_KEY = "direct_trade:calculation-progress"
const DIRECT_TRADE_RECOVERY_REQUEST_KEY = "direct_trade:processor:recovery-request"

async function getClient() {
  await initRedis()
  return getRedisClient()
}

export async function GET() {
  try {
    const client = await getClient()
    const [stateRaw, statsRaw, positionsRaw, openPositionStageRaw, processorRaw, configStatusRaw, calculationRaw, progressRaw, recoveryRequestRaw] = await Promise.all([
      client.get(DIRECT_TRADE_STATE_KEY),
      client.get(DIRECT_TRADE_STATS_KEY),
      client.get(DIRECT_TRADE_POSITIONS_KEY),
      client.get(DIRECT_TRADE_OPEN_POSITION_STAGE_KEY),
      client.get(DIRECT_TRADE_PROCESSOR_KEY),
      client.get(DIRECT_TRADE_CONFIG_STATUS_KEY),
      client.get(DIRECT_TRADE_CALCULATION_KEY),
      client.get(DIRECT_TRADE_CALCULATION_PROGRESS_KEY),
      client.get(DIRECT_TRADE_RECOVERY_REQUEST_KEY),
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
      const executionConfigsRaw = await client.get(DIRECT_TRADE_EXECUTION_CONFIGS_KEY)
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

    const rollingStats = {
      last12Pos: calculateRollingPF(closedPositions.slice(-12)),
      last25Pos: calculateRollingPF(closedPositions.slice(-25)),
      last50Pos: calculateRollingPF(closedPositions.slice(-50)),
      last4h: calculateTimePF(closedPositions, now - 4 * 60 * 60 * 1000),
      last12h: calculateTimePF(closedPositions, now - 12 * 60 * 60 * 1000),
      last48h: calculateTimePF(closedPositions, now - 48 * 60 * 60 * 1000),
    }

    return NextResponse.json({
      success: true,
      state,
      stats: stats ? { ...stats, ...rollingStats } : rollingStats,
      activeConfigs: Math.max(0, Number(calculation?.evaluatedSets) || executionConfigs.length),
      validConfigs: Math.max(0, Number(calculation?.validSets) || executionConfigs.length),
      evaluatedConfigs: Math.max(0, Number(calculation?.evaluatedSets) || executionConfigs.length),
      openPositions: openPositions.length,
      openPositionStage,
      closedPositions: closedPositions.length,
      configStatus,
      calculation,
      calculationProgress,
      disabledConfigs: Object.values(configStatus as Record<string, any>)
        .filter((entry: any) => entry?.enabled === false).length,
      processor: processor ? {
        lastTick: processor.lastTick,
        tickCount: processor.tickCount,
        errorsLast5min: processor.errorsLast5min || 0,
        isHealthy: processor.lastTick && (now - new Date(processor.lastTick).getTime()) < 7000,
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

function calculateRollingPF(positions: any[]): { pf: number | null; pfInfinite: boolean; ddt: number; pnl: number } {
  if (!positions.length) return { pf: 0, pfInfinite: false, ddt: 0, pnl: 0 }
  const wins = positions.filter((p) => (p.pnl || 0) > 0)
  const losses = positions.filter((p) => (p.pnl || 0) <= 0)
  const totalProfit = wins.reduce((s, p) => s + (p.pnl || 0), 0)
  const totalLoss = Math.abs(losses.reduce((s, p) => s + (p.pnl || 0), 0))
  const pfInfinite = totalLoss === 0 && totalProfit > 0
  const pf = totalLoss > 0 ? totalProfit / totalLoss : 0
  const avgDdt = positions.reduce((s, p) => s + (p.drawdownTimeMin || 0), 0) / positions.length
  const totalPnl = positions.reduce((s, p) => s + (p.pnl || 0), 0)
  return { pf: pfInfinite ? null : Number(pf.toFixed(3)), pfInfinite, ddt: Number(avgDdt.toFixed(1)), pnl: Number(totalPnl.toFixed(4)) }
}

function calculateTimePF(positions: any[], since: number): { pf: number | null; pfInfinite: boolean; ddt: number; pnl: number } {
  const filtered = positions.filter((p) => new Date(p.closedAt || p.exitTime || 0).getTime() >= since)
  return calculateRollingPF(filtered)
}
