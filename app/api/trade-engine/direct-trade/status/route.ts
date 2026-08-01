import { type NextRequest, NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

const DIRECT_TRADE_STATE_KEY = "direct_trade:state"
const DIRECT_TRADE_STATS_KEY = "direct_trade:stats"
const DIRECT_TRADE_CONFIGS_KEY = "direct_trade:configs"
const DIRECT_TRADE_POSITIONS_KEY = "direct_trade:positions"
const DIRECT_TRADE_PROCESSOR_KEY = "direct_trade:processor"

async function getClient() {
  await initRedis()
  return getRedisClient()
}

export async function GET() {
  try {
    const client = await getClient()
    const [stateRaw, statsRaw, configsRaw, positionsRaw, processorRaw] = await Promise.all([
      client.get(DIRECT_TRADE_STATE_KEY),
      client.get(DIRECT_TRADE_STATS_KEY),
      client.get(DIRECT_TRADE_CONFIGS_KEY),
      client.get(DIRECT_TRADE_POSITIONS_KEY),
      client.get(DIRECT_TRADE_PROCESSOR_KEY),
    ])

    const state = stateRaw ? JSON.parse(stateRaw) : null
    const stats = statsRaw ? JSON.parse(statsRaw) : null
    const configs = configsRaw ? JSON.parse(configsRaw) : []
    const positions = positionsRaw ? JSON.parse(positionsRaw) : []
    const processor = processorRaw ? JSON.parse(processorRaw) : null

    // Calculate rolling stats from positions
    const now = Date.now()
    const closedPositions = positions.filter((p: any) => p.status === "closed")
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
      activeConfigs: configs.length,
      openPositions: openPositions.length,
      closedPositions: closedPositions.length,
      processor: processor ? {
        lastTick: processor.lastTick,
        tickCount: processor.tickCount,
        errorsLast5min: processor.errorsLast5min || 0,
        isHealthy: processor.lastTick && (now - new Date(processor.lastTick).getTime()) < 5000,
      } : null,
    })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to get direct-trade status", details: String(error) },
      { status: 500 },
    )
  }
}

function calculateRollingPF(positions: any[]): { pf: number; ddt: number; pnl: number } {
  if (!positions.length) return { pf: 0, ddt: 0, pnl: 0 }
  const wins = positions.filter((p) => (p.pnl || 0) > 0)
  const losses = positions.filter((p) => (p.pnl || 0) <= 0)
  const totalProfit = wins.reduce((s, p) => s + (p.pnl || 0), 0)
  const totalLoss = Math.abs(losses.reduce((s, p) => s + (p.pnl || 0), 0))
  const pf = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 10 : 0
  const avgDdt = positions.reduce((s, p) => s + (p.drawdownTimeMin || 0), 0) / positions.length
  const totalPnl = positions.reduce((s, p) => s + (p.pnl || 0), 0)
  return { pf: Number(pf.toFixed(3)), ddt: Number(avgDdt.toFixed(1)), pnl: Number(totalPnl.toFixed(4)) }
}

function calculateTimePF(positions: any[], since: number): { pf: number; ddt: number; pnl: number } {
  const filtered = positions.filter((p) => new Date(p.closedAt || p.exitTime || 0).getTime() >= since)
  return calculateRollingPF(filtered)
}
