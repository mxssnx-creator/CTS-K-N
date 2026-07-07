import { NextResponse, type NextRequest } from "next/server"
import { initRedis } from "@/lib/redis-db"
import { RedisTrades } from "@/lib/redis-operations"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: connectionId } = await params

    await initRedis()
    const trades = await RedisTrades.getTradesByConnection(connectionId)

    return NextResponse.json({
      connectionId,
      trades,
      total: trades.length,
    })
  } catch (error) {
    console.error("[v0] Failed to get trades:", error)
    return NextResponse.json(
      { error: "Failed to get trades", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
