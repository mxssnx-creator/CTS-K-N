import { type NextRequest, NextResponse } from "next/server"
import { emitEngineStageAck } from "@/lib/engine-stage-ack"

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
    const testConnectionId = connectionId || "testing-connection"

    // Simulate different test scenarios
    switch (test) {
      case "init":
        emitEngineStageAck(testConnectionId, "startup", "ack", "Testing connection initialized", { exchange, apiType, useTestnet })
        return NextResponse.json({
          success: true,
          message: "Connection initialized successfully",
          details: { exchange, apiType, testnet: useTestnet },
        })

      case "balance":
        emitEngineStageAck(testConnectionId, "live_sync", "ack", "Testing balance retrieved")
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
        emitEngineStageAck(testConnectionId, "market_data", "ack", "Testing connection market data fetched")
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
        emitEngineStageAck(testConnectionId, "market_data", "ack", "Testing order book retrieved")
        return NextResponse.json({
          success: true,
          message: "Order book retrieved successfully",
          details: {
            bids: [[44999, 1.5], [44998, 2.1]],
            asks: [[45001, 1.2], [45002, 1.8]],
          },
        })

      case "rate_limits":
        emitEngineStageAck(testConnectionId, "recoordination_complete", "ack", "Testing rate limits verified")
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
