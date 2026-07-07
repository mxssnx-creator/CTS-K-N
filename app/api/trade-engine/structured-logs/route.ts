import { NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"

/**
 * GET /api/trade-engine/structured-logs
 * Retrieve detailed structured engine processing logs
 */
export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    await initRedis()
    const client = getRedisClient()
    const coordinator = getGlobalTradeEngineCoordinator()

    // Get query parameters
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connectionId")
    const limit = Number.parseInt(searchParams.get("limit") || "100")
    const engine = searchParams.get("engine") // Filter by engine type

    if (!connectionId) {
      return NextResponse.json({ error: "connectionId required" }, { status: 400 })
    }

    // Retrieve logs from Redis
    const logKey = `engine:logs:${connectionId}`
    const rawLogs = await client.lrange(logKey, 0, limit - 1)
    const logs = rawLogs.map((log) => JSON.parse(log))

    // Filter by engine if specified
    const filtered = engine ? logs.filter((log: any) => log.engine === engine) : logs

    // Calculate statistics
    const stats = {
      totalLogs: filtered.length,
      byEngine: {} as Record<string, number>,
      byStatus: {} as Record<string, number>,
      latestLog: filtered[0] || null,
      errorCount: 0,
    }

    for (const log of filtered) {
      stats.byEngine[log.engine] = (stats.byEngine[log.engine] || 0) + 1
      stats.byStatus[log.status] = (stats.byStatus[log.status] || 0) + 1
      if (log.status === "error") stats.errorCount++
    }

    return NextResponse.json({
      success: true,
      connectionId,
      stats,
      logs: filtered.slice(0, limit),
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("Error retrieving structured logs:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to retrieve logs",
      },
      { status: 500 }
    )
  }
}

/**
 * POST /api/trade-engine/structured-logs
 * Clear or filter logs
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    await initRedis()
    const client = getRedisClient()

    const { action, connectionId } = body

    if (action === "clear") {
      const logKey = `engine:logs:${connectionId}`
      await client.del(logKey)

      return NextResponse.json({
        success: true,
        message: `Logs cleared for connection ${connectionId}`,
      })
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  } catch (error) {
    console.error("[v0] Error processing logs request:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to process request",
      },
      { status: 500 }
    )
  }
}
