import { type NextRequest, NextResponse } from "next/server"
import { ExchangePositionManager } from "@/lib/exchange-position-manager"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connection_id")
    const symbol = searchParams.get("symbol")
    const indicationType = searchParams.get("indication_type")
    const hours = Number.parseInt(searchParams.get("hours") || "24")

    if (!connectionId || !symbol) {
      return NextResponse.json({ success: false, error: "connection_id and symbol are required" }, { status: 400 })
    }

    const manager = new ExchangePositionManager(connectionId)
    const statistics = await manager.getStatistics(symbol, indicationType || undefined, hours)

    return NextResponse.json({
      success: true,
      data: statistics,
    })
  } catch (error) {
    console.error("[v0] Get exchange statistics error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
