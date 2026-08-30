import { NextRequest, NextResponse } from "next/server"
import { initRedis } from "@/lib/redis-db"
import { placeLiveOrder } from "@/lib/live-order-service"
import { authorizeAdminBearer } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

function positiveFinite(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export async function POST(req: NextRequest) {
  try {
    const authorization = authorizeAdminBearer(req.headers.get("authorization"))
    if (!authorization.ok) {
      return NextResponse.json(
        { success: false, error: authorization.error },
        { status: authorization.status },
      )
    }
    await initRedis()
    const body = await req.json()
    const { connectionId, symbol, side, quantity, leverage } = body

    if (!connectionId || !symbol || !side || !quantity || leverage === undefined) {
      return NextResponse.json(
        { error: "Missing required fields: connectionId, symbol, side, quantity, leverage" },
        { status: 400 },
      )
    }

    const result = await placeLiveOrder({
      connectionId,
      symbol,
      side,
      quantity: Number(quantity),
      leverage: Number(leverage),
      // The diagnostic entry route must exercise the same direction-aware
      // protection contract as every other real-entry route. In paper mode
      // this remains a no-op; on a real venue missing controls fail closed.
      requireProtection: true,
      stopLossPrice: positiveFinite(body.stopLossPrice),
      takeProfitPrice: positiveFinite(body.takeProfitPrice),
      protectionStopLossPercent: positiveFinite(body.protectionStopLossPercent ?? body.stopLossPercent),
      protectionTakeProfitPercent: positiveFinite(body.protectionTakeProfitPercent ?? body.takeProfitPercent),
      positionTicket: positiveFinite(body.positionTicket),
      safetyPayload: body,
      source: "testing-place-order",
    })

    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error, mode: result.mode }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      mode: result.mode,
      orderId: result.orderId,
      symbol: result.symbol,
      side: result.side,
      direction: result.direction,
      quantity: result.quantity,
      leverage: result.leverage,
      timestamp: Date.now(),
      details: result.details?.details || result.details,
    })
  } catch (error: any) {
    console.error("[PlaceOrder] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        mode: error?.mode,
      },
      { status: Number(error?.statusCode || 500) },
    )
  }
}
