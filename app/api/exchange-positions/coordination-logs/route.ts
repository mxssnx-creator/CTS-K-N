import { type NextRequest, NextResponse } from "next/server"
import { ExchangePositionManager } from "@/lib/exchange-position-manager"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connection_id")
    const exchangeId = searchParams.get("exchange_id")
    const limit = Number.parseInt(searchParams.get("limit") || "100")

    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connection_id is required" }, { status: 400 })
    }

    const manager = new ExchangePositionManager(connectionId)
    const logs = await manager.getCoordinationLogs(exchangeId || undefined, limit)

    return NextResponse.json({
      success: true,
      data: logs,
      count: logs.length,
    })
  } catch (error) {
    console.error("[v0] Get coordination logs error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
