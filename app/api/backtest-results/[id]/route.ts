import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    await initRedis()
    const client = getRedisClient()

    const result = await (client as any).hgetall(`backtest_result:${id}`)

    if (!result || Object.keys(result).length === 0) {
      return NextResponse.json({ error: "Backtest result not found" }, { status: 404 })
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error("[v0] Failed to fetch backtest result:", error)
    return NextResponse.json({ error: "Failed to fetch backtest result" }, { status: 500 })
  }
}
