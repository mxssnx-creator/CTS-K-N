import { type NextRequest, NextResponse } from "next/server"
import { VolumeCalculator } from "@/lib/volume-calculator"

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { entryPrice, currentPrice, volume, leverage, side, stopLossPrice, takeProfitPrice } = body

    if (!entryPrice || !currentPrice || !volume || !leverage || !side) {
      return NextResponse.json({ error: "Missing required parameters" }, { status: 400 })
    }

    const metrics = VolumeCalculator.calculateRiskMetrics({
      entryPrice,
      currentPrice,
      volume,
      leverage,
      side,
      stopLossPrice,
      takeProfitPrice,
    })

    return NextResponse.json(metrics)
  } catch (error) {
    console.error("[v0] Failed to calculate risk metrics:", error)
    return NextResponse.json({ error: "Failed to calculate risk metrics" }, { status: 500 })
  }
}
