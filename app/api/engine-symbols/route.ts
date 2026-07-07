import { NextRequest, NextResponse } from "next/server"
import { getProgressManager } from "@/lib/engine-progress-manager"
import { MetricsAggregator } from "@/lib/metrics-aggregator"
import { IndicationEvaluator } from "@/lib/indication-evaluator"
import { StrategyEvaluator } from "@/lib/strategy-evaluator"
import { getEngineLogger } from "@/lib/engine-logger"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connectionId")
    const symbol = searchParams.get("symbol")

    if (!connectionId) {
      return NextResponse.json(
        { error: "connectionId is required" },
        { status: 400 }
      )
    }

    const progressManager = getProgressManager(connectionId)
    const state = progressManager.getState()

    if (symbol) {
      // Get specific symbol metrics
      const logger = getEngineLogger(connectionId)
      const indicationEvaluator = new IndicationEvaluator(connectionId)
      const strategyEvaluator = new StrategyEvaluator(connectionId)
      const metricsAggregator = new MetricsAggregator(connectionId, indicationEvaluator, strategyEvaluator, logger)
      
      const symbolMetrics = await metricsAggregator.getSymbolMetrics(symbol)
      return NextResponse.json({ symbol: symbolMetrics })
    }

    // Get all symbols
    const symbols = Object.keys(state.symbols)
    return NextResponse.json({
      symbols,
      count: symbols.length,
      symbolData: state.symbols,
    })
  } catch (error) {
    console.error("[EngineSymbols] Error:", error)
    return NextResponse.json(
      { error: "Failed to get engine symbols" },
      { status: 500 }
    )
  }
}
