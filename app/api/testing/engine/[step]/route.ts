import { type NextRequest, NextResponse } from "next/server"

interface RouteParams {
  params: {
    step: string
  }
}

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json()
    const { step } = await params
    const { connectionId, useTestnet, minVolume, symbol } = body

    console.log(`[v0] Running engine test step: ${step}`)

    // Simulate different engine test steps
    switch (step) {
      case "init":
        await new Promise((resolve) => setTimeout(resolve, 600))
        return NextResponse.json({
          success: true,
          message: "Engine initialized",
          data: { engineId: "eng_" + Date.now(), status: "ready" },
        })

      case "market_data":
        await new Promise((resolve) => setTimeout(resolve, 800))
        return NextResponse.json({
          success: true,
          message: "Market data loaded",
          data: {
            symbol,
            price: 45123.45,
            volume24h: 1234567890,
            change24h: 2.34,
          },
        })

      case "indicators":
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return NextResponse.json({
          success: true,
          message: "Indicators calculated",
          data: {
            rsi: 65.4,
            macd: { value: 123.4, signal: 115.2, histogram: 8.2 },
            ema20: 44950.2,
          },
        })

      case "strategy":
        await new Promise((resolve) => setTimeout(resolve, 700))
        return NextResponse.json({
          success: true,
          message: "Strategy signal generated",
          data: {
            signal: "BUY",
            confidence: 0.78,
            reason: "RSI oversold + MACD bullish crossover",
          },
        })

      case "order":
        await new Promise((resolve) => setTimeout(resolve, 1200))
        return NextResponse.json({
          success: true,
          message: "Test order placed",
          data: {
            orderId: "ord_" + Date.now(),
            symbol,
            side: "BUY",
            type: "LIMIT",
            price: 45100,
            quantity: minVolume / 45100,
            status: "FILLED",
          },
        })

      case "position":
        await new Promise((resolve) => setTimeout(resolve, 800))
        return NextResponse.json({
          success: true,
          message: "Position monitored",
          data: {
            positionId: "pos_" + Date.now(),
            symbol,
            entryPrice: 45100,
            currentPrice: 45250,
            pnl: 150,
            pnlPercent: 0.33,
          },
        })

      case "update_tp_sl":
        await new Promise((resolve) => setTimeout(resolve, 900))
        return NextResponse.json({
          success: true,
          message: "TP/SL updated",
          data: {
            takeProfit: 45600,
            stopLoss: 44800,
            updatedAt: new Date().toISOString(),
          },
        })

      case "close":
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return NextResponse.json({
          success: true,
          message: "Position closed",
          data: {
            closePrice: 45350,
            realizedPnl: 250,
            realizedPnlPercent: 0.55,
            closedAt: new Date().toISOString(),
          },
        })

      case "rate_limits":
        await new Promise((resolve) => setTimeout(resolve, 500))
        return NextResponse.json({
          success: true,
          message: "Rate limits verified",
          data: {
            requestsUsed: 78,
            requestsLimit: 120,
            orderRateUsed: 12,
            orderRateLimit: 50,
          },
        })

      case "batch":
        await new Promise((resolve) => setTimeout(resolve, 1500))
        return NextResponse.json({
          success: true,
          message: "Batch processing completed",
          data: {
            processed: 10,
            successful: 10,
            failed: 0,
            totalTime: "1.2s",
          },
        })

      default:
        return NextResponse.json({ success: false, message: "Unknown step" }, { status: 400 })
    }
  } catch (error) {
    console.error("[v0] Engine test error:", error)
    return NextResponse.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Test step failed",
      },
      { status: 500 }
    )
  }
}
