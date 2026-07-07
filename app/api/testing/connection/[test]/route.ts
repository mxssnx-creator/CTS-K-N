import { type NextRequest, NextResponse } from "next/server"

interface RouteParams {
  params: Promise<{
    test: string
  }>
}

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const body = await request.json()
    const { test } = await params
    const { exchange, apiType, useTestnet, apiKey, apiSecret, connectionId } = body

    console.log(`[v0] Running connection test: ${test}`)

    // Simulate different test scenarios
    switch (test) {
      case "init":
        await new Promise((resolve) => setTimeout(resolve, 500))
        return NextResponse.json({
          success: true,
          message: "Connection initialized successfully",
          details: { exchange, apiType, testnet: useTestnet },
        })

      case "balance":
        await new Promise((resolve) => setTimeout(resolve, 800))
        return NextResponse.json({
          success: true,
          message: "Balance retrieved successfully",
          details: {
            totalBalance: "10000.00 USDT",
            availableBalance: "9500.00 USDT",
            positions: [],
          },
        })

      case "market_data":
        await new Promise((resolve) => setTimeout(resolve, 600))
        return NextResponse.json({
          success: true,
          message: "Market data fetched successfully",
          details: {
            symbol: "BTCUSDT",
            price: 45000.5,
            timestamp: new Date().toISOString(),
          },
        })

      case "orderbook":
        await new Promise((resolve) => setTimeout(resolve, 700))
        return NextResponse.json({
          success: true,
          message: "Order book retrieved successfully",
          details: {
            bids: [[44999, 1.5], [44998, 2.1]],
            asks: [[45001, 1.2], [45002, 1.8]],
          },
        })

      case "rate_limits":
        await new Promise((resolve) => setTimeout(resolve, 400))
        return NextResponse.json({
          success: true,
          message: "Rate limits verified",
          details: {
            used: 45,
            limit: 120,
            resetAt: new Date(Date.now() + 60000).toISOString(),
          },
        })

      default:
        return NextResponse.json({ success: false, message: "Unknown test type" }, { status: 400 })
    }
  } catch (error) {
    console.error("[v0] Connection test error:", error)
    return NextResponse.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Test failed",
      },
      { status: 500 }
    )
  }
}
