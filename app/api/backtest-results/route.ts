import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const presetId = searchParams.get("presetId")
    const connectionId = searchParams.get("connectionId")
    const status = searchParams.get("status")

    await initRedis()
    const client = getRedisClient()

    // Get all backtest result keys from Redis
    const keys = await (client as any).keys("backtest_result:*")
    const results = []

    for (const key of keys) {
      const data = await (client as any).hgetall(key)
      if (data && Object.keys(data).length > 0) {
        // Apply filters
        if (presetId && data.preset_id !== presetId) continue
        if (connectionId && data.connection_id !== connectionId) continue
        if (status && data.status !== status) continue
        results.push(data)
      }
    }

    // Sort by created_at descending and limit to 100
    results.sort((a, b) => {
      const dateA = new Date(a.created_at || 0)
      const dateB = new Date(b.created_at || 0)
      return dateB.getTime() - dateA.getTime()
    })

    return NextResponse.json(results.slice(0, 100))
  } catch (error) {
    console.error("[v0] Failed to fetch backtest results:", error)
    return NextResponse.json({ error: "Failed to fetch backtest results" }, { status: 500 })
  }
}
