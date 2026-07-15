import { type NextRequest, NextResponse } from "next/server"
import { listOptimizedPresets } from "@/lib/preset-store"

interface PresetTemplate {
  id: string
  name: string
  description: string
  strategyType: string
  symbol: string
  enabled: boolean
  config: {
    tp: number
    sl: number
    leverage: number
    volume: number
  }
  stats: {
    winRate: number
    avgProfit: number
    successCount: number
  }
}

function generateMockPresets(connectionId: string): PresetTemplate[] {
  return [
    {
      id: `p1-${connectionId}`,
      name: "Bitcoin Momentum",
      description: "Aggressive momentum strategy for BTC",
      strategyType: "Momentum",
      symbol: "BTCUSDT",
      enabled: true,
      config: { tp: 8, sl: 0.5, leverage: 5, volume: 0.1 },
      stats: { winRate: 72, avgProfit: 3.2, successCount: 45 },
    },
    {
      id: `p2-${connectionId}`,
      name: "Ethereum Trend Follower",
      description: "Conservative trend-following for ETH",
      strategyType: "Trend",
      symbol: "ETHUSDT",
      enabled: true,
      config: { tp: 6, sl: 0.75, leverage: 3, volume: 0.1 },
      stats: { winRate: 68, avgProfit: 2.1, successCount: 38 },
    },
    {
      id: `p3-${connectionId}`,
      name: "Solana Volatility",
      description: "High volatility trading on SOL",
      strategyType: "Volatility",
      symbol: "SOLUSDT",
      enabled: false,
      config: { tp: 10, sl: 1, leverage: 10, volume: 0.1 },
      stats: { winRate: 55, avgProfit: 4.5, successCount: 22 },
    },
    {
      id: `p4-${connectionId}`,
      name: "Mean Reversion Multi",
      description: "Mean reversion across multiple pairs",
      strategyType: "Mean Reversion",
      symbol: "MULTI",
      enabled: true,
      config: { tp: 4, sl: 1.5, leverage: 2, volume: 0.1 },
      stats: { winRate: 65, avgProfit: 1.8, successCount: 52 },
    },
    {
      id: `p5-${connectionId}`,
      name: "Scalping Strategy",
      description: "High-frequency scalping template",
      strategyType: "Momentum",
      symbol: "BTCUSDT",
      enabled: false,
      config: { tp: 2, sl: 0.25, leverage: 20, volume: 0.1 },
      stats: { winRate: 58, avgProfit: 0.8, successCount: 120 },
    },
    {
      id: `p2-${connectionId}`,
      name: "Ethereum Trend Follower",
      description: "Conservative trend-following for ETH",
      strategyType: "Trend",
      symbol: "ETHUSDT",
      enabled: true,
      config: { tp: 6, sl: 0.75, leverage: 3, volume: 0.75 },
      stats: { winRate: 68, avgProfit: 2.1, successCount: 38 },
    },
    {
      id: `p3-${connectionId}`,
      name: "Solana Volatility",
      description: "High volatility trading on SOL",
      strategyType: "Volatility",
      symbol: "SOLUSDT",
      enabled: false,
      config: { tp: 10, sl: 1, leverage: 10, volume: 0.25 },
      stats: { winRate: 55, avgProfit: 4.5, successCount: 22 },
    },
    {
      id: `p4-${connectionId}`,
      name: "Mean Reversion Multi",
      description: "Mean reversion across multiple pairs",
      strategyType: "Mean Reversion",
      symbol: "MULTI",
      enabled: true,
      config: { tp: 4, sl: 1.5, leverage: 2, volume: 1 },
      stats: { winRate: 65, avgProfit: 1.8, successCount: 52 },
    },
    {
      id: `p5-${connectionId}`,
      name: "Scalping Strategy",
      description: "High-frequency scalping template",
      strategyType: "Momentum",
      symbol: "BTCUSDT",
      enabled: false,
      config: { tp: 2, sl: 0.25, leverage: 20, volume: 0.1 },
      stats: { winRate: 58, avgProfit: 0.8, successCount: 120 },
    },
  ]
}

/**
 * Compatibility projection for older PresetCard consumers. The canonical
 * source is the generation-indexed optimizer store; no fabricated production
 * values or SQL shim rows are returned.
 */
async function getRealPresets(connectionId: string): Promise<PresetTemplate[]> {
  try {
    const { presets } = await listOptimizedPresets(connectionId, { limit: 2_000 })
    return presets.map((preset) => ({
      id: preset.id,
      name: `${preset.symbol} ${preset.indicator.type.toUpperCase()} #${preset.rank}`,
      description: `PF ${preset.metrics.profitFactor.toFixed(2)} · ${preset.metrics.totalPositions} positions · ${preset.trailing.enabled ? "independent trailing" : "TP/SL"}`,
      strategyType: preset.indicator.type,
      symbol: preset.symbol,
      enabled: preset.selected,
      config: {
        tp: preset.takeProfitPct,
        sl: preset.stopLossPct,
        leverage: 1,
        volume: preset.positionCostPct,
      },
      stats: {
        winRate: preset.metrics.winRate,
        avgProfit: Number((preset.metrics.averageR * preset.positionCostPct).toFixed(4)),
        successCount: preset.metrics.totalPositions,
      },
    }))
  } catch (error) {
    console.error(`[data/presets] Failed to load real presets for ${connectionId}:`, error)
    return []
  }
}

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const connectionId = request.nextUrl.searchParams.get("connectionId")
    if (!connectionId) {
      return NextResponse.json(
        { success: false, error: "connectionId query parameter required" },
        { status: 400 },
      )
    }

    const isDemo = connectionId === "demo-mode" || connectionId.startsWith("demo")

    let presets: PresetTemplate[] = []

    if (isDemo) {
      presets = generateMockPresets(connectionId)
    } else {
      // Real connections expose only persisted optimizer results.
      presets = await getRealPresets(connectionId)
    }

    return NextResponse.json({
      success: true,
      data: presets,
      isDemo,
      connectionId,
      count: presets.length,
    })
  } catch (error) {
    console.error("[v0] Get presets error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
