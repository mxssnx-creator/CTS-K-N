import { type NextRequest, NextResponse } from "next/server"
import { engineMonitor } from "@/lib/engine-performance-monitor"
import { getAllConnections, initRedis } from "@/lib/redis-db"

/**
 * GET /api/trade-engine/metrics/[id]
 * Returns detailed engine performance metrics for a connection
 */
export const dynamic = "force-dynamic"
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    await initRedis()

    // Get detailed metrics
    const detailedStats = await engineMonitor.getDetailedStats(id)
    
    // Get recent cycles for each processor
    const [indicationMetrics, strategyMetrics, realtimeMetrics] = await Promise.all([
      engineMonitor.getMetrics(id, "indications"),
      engineMonitor.getMetrics(id, "strategies"),
      engineMonitor.getMetrics(id, "realtime"),
    ])

    return NextResponse.json({
      success: true,
      connectionId: id,
      timestamp: new Date().toISOString(),
      summary: detailedStats,
      processors: {
        indications: indicationMetrics,
        strategies: strategyMetrics,
        realtime: realtimeMetrics,
      },
    })
  } catch (error) {
    console.error("[v0] [EngineMetricsAPI] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}

/**
 * GET /api/trade-engine/metrics
 * Returns metrics for all active engines
 */
export async function GET_ALL(request: NextRequest) {
  try {
    await initRedis()
    const connections = await getAllConnections()
    
    const activeConnections = connections.filter((c: any) => {
      return c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true
    })

    const allMetrics = await Promise.all(
      activeConnections.map(async (conn: any) => {
        try {
          const stats = await engineMonitor.getDetailedStats(conn.id)
          return {
            connectionId: conn.id,
            name: conn.name,
            exchange: conn.exchange,
            metrics: stats,
          }
        } catch (err) {
          return {
            connectionId: conn.id,
            name: conn.name,
            error: err instanceof Error ? err.message : "Failed to get metrics",
          }
        }
      })
    )

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      activeEngines: allMetrics.length,
      engines: allMetrics,
    })
  } catch (error) {
    console.error("[v0] [EngineMetricsAPI] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
