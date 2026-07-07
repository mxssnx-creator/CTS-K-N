import { type NextRequest, NextResponse } from "next/server"
import { getSetEvaluator } from "@/lib/preset-set-evaluator"

// POST /api/preset-sets/[id]/evaluate - Manually trigger Set evaluation
export const dynamic = "force-dynamic"
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const evaluator = getSetEvaluator()

    const metrics = await evaluator.evaluateSetById(id)

    if (!metrics) {
      return NextResponse.json({ error: "Set not found" }, { status: 404 })
    }

    // Convert Map to object for JSON serialization
    const symbolStatsObj: Record<string, any> = {}
    for (const [symbol, stats] of metrics.symbolStats.entries()) {
      symbolStatsObj[symbol] = stats
    }

    return NextResponse.json({
      setId: metrics.setId,
      symbolStats: symbolStatsObj,
      overallProfitFactor: metrics.overallProfitFactor,
      shouldDisableSet: metrics.shouldDisableSet,
    })
  } catch (error) {
    console.error("[v0] Failed to evaluate Set:", error)
    return NextResponse.json({ error: "Failed to evaluate Set" }, { status: 500 })
  }
}
