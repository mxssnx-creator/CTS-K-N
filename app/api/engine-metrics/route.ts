import { NextRequest, NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { readResultLedger } from "@/lib/results/ledger"
import { buildEnginePerformance } from "./engine-performance"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * GET /api/engine-metrics?connectionId=...
 *
 * Realized profit factor, win rate and drawdown of a connection, computed from
 * its results ledger (executed, settled own positions). The former response
 * came from a MetricsAggregator over evaluators created fresh for every
 * request, which the running engine never feeds, so every figure was 0.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const connectionId = String(searchParams.get("connectionId") || searchParams.get("connection_id") || "").trim()

    if (!connectionId) {
      return NextResponse.json(
        { error: "connectionId is required" },
        { status: 400 }
      )
    }

    await initRedis()
    const ledger = await readResultLedger(getRedisClient(), connectionId).catch(() => null)

    return NextResponse.json(
      {
        success: true,
        connectionId,
        performance: buildEnginePerformance(ledger),
        timestamp: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    )
  } catch (error) {
    console.error("[EngineMetrics] Error:", error)
    return NextResponse.json(
      { error: "Failed to get engine metrics" },
      { status: 500 }
    )
  }
}
