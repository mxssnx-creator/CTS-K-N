import { type NextRequest, NextResponse } from "next/server"
import { VolumeCalculator } from "@/lib/volume-calculator"
import { normalizeMarketType } from "@/lib/market-types"

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { connectionId, symbol, currentPrice } = body

    if (
      typeof connectionId !== "string" ||
      typeof symbol !== "string" ||
      !Number.isFinite(Number(currentPrice)) ||
      Number(currentPrice) <= 0
    ) {
      return NextResponse.json({ error: "Missing required parameters" }, { status: 400 })
    }

    const tradeMode = body.tradeMode === "main" || body.tradeMode === "preset"
      ? body.tradeMode
      : undefined
    const marketType = normalizeMarketType(body.marketType ?? body.market_type, body.exchange)
    const finitePositive = (value: unknown): number | undefined => {
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    }
    const result = await VolumeCalculator.calculateVolumeForConnection(
      connectionId.trim(),
      symbol.trim().toUpperCase(),
      Number(currentPrice),
      {
        tradeMode,
        indicationType: typeof body.indicationType === "string"
          ? body.indicationType
          : undefined,
        sizeMultiplier: Number.isFinite(Number(body.sizeMultiplier))
          ? Number(body.sizeMultiplier)
          : undefined,
        marketType,
        lotSize: finitePositive(body.lotSize ?? body.lot_size),
        quoteToUsdRate: finitePositive(body.quoteToUsdRate ?? body.quote_to_usd_rate),
        positionCostPercentOverride: finitePositive(
          body.positionCostPercentOverride ?? body.position_cost_percent,
        ),
      },
    )

    return NextResponse.json(result)
  } catch (error) {
    console.error("[v0] Failed to calculate volume:", error)
    return NextResponse.json({ error: "Failed to calculate volume" }, { status: 500 })
  }
}
