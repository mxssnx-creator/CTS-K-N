import { NextResponse } from "next/server"
import DatabaseManager from "@/lib/database"
import { SystemLogger } from "@/lib/system-logger"

/**
 * Comprehensive Monitoring Endpoint
 * Consolidates all system monitoring data into a single response
 */
export const dynamic = "force-dynamic"
export async function GET() {
  const startTime = Date.now()

  try {
    const db = DatabaseManager.getInstance()

    // 1. Get all connections
    const connections = await db.getConnections()
    const connectionList = Array.isArray(connections) ? connections : []
    const activeConnections = connectionList.filter((c: any) => c.is_enabled)
    const liveTradeConnections = connectionList.filter((c: any) => c.is_live_trade)

    // 2. Get position data
    let pseudoPositions: any[] = []
    let realPositions: any[] = []

    try {
      pseudoPositions = await db.getPseudoPositions(undefined, 100)
      realPositions = await db.getRealPositions()
    } catch (dbError) {
      console.warn("[v0] [Monitoring] Could not fetch positions:", dbError)
    }

    // 3. Get error/log data
    let recentErrors: any[] = []
    try {
      recentErrors = await db.getErrors(10, false)
    } catch (logError) {
      console.warn("[v0] [Monitoring] Could not fetch errors:", logError)
    }

    // 4. Calculate health scores
    const connectionHealth = activeConnections.length > 0 ? "healthy" : "warning"
    const errorHealth =
      recentErrors.length > 10 ? "critical" : recentErrors.length > 5 ? "warning" : "healthy"

    // 5. Calculate overall system health
    const overallHealth = calculateOverallHealth({
      connectionHealth,
      errorHealth,
    })

    // 6. Build comprehensive response
    const response = {
      timestamp: new Date().toISOString(),
      responseTime: Date.now() - startTime,
      system: {
        status: overallHealth,
        uptime: process.uptime(),
        version: "3.2.0",
        environment: process.env.NODE_ENV || "production",
      },
      connections: {
        total: connectionList.length,
        active: activeConnections.length,
        liveTrade: liveTradeConnections.length,
        byExchange: aggregateByExchange(connectionList),
        health: connectionHealth,
        details: connectionList.map((c: any) => ({
          id: c.id,
          name: c.name,
          exchange: c.exchange,
          isEnabled: c.is_enabled,
          isLiveTrading: c.is_live_trade,
          lastTestStatus: c.last_test_status,
          lastTestAt: c.last_test_at,
        })),
      },
      trading: {
        pseudoPositions: {
          total: pseudoPositions.length,
          open: pseudoPositions.filter((p: any) => p.status === "open").length,
          pending: pseudoPositions.filter((p: any) => p.status === "pending").length,
        },
        realPositions: {
          total: realPositions.length,
          open: realPositions.filter((p: any) => p.status === "open").length,
        },
        health: realPositions.length > 0 ? "active" : "idle",
      },
      errors: {
        count: recentErrors.length,
        health: errorHealth,
        recent: recentErrors.slice(0, 5).map((e: any) => ({
          level: e.level,
          message: e.message,
          timestamp: e.timestamp,
          component: e.component,
        })),
      },
    }

    return NextResponse.json(response)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] [Monitoring] Failed to fetch comprehensive metrics:", errorMessage)

    await SystemLogger.logError(error, "system", "GET /api/monitoring/comprehensive")

    return NextResponse.json(
      {
        timestamp: new Date().toISOString(),
        responseTime: Date.now() - startTime,
        system: {
          status: "error",
          error: errorMessage,
        },
      },
      { status: 500 },
    )
  }
}

function calculateOverallHealth(metrics: {
  connectionHealth: string
  errorHealth: string
}): "healthy" | "degraded" | "critical" | "error" {
  const healthScores: Record<string, number> = {
    healthy: 3,
    warning: 2,
    idle: 2,
    degraded: 1,
    critical: 0,
    error: 0,
  }

  const scores = [
    healthScores[metrics.connectionHealth] || 0,
    healthScores[metrics.errorHealth] || 0,
  ]

  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length

  if (avgScore >= 2.5) return "healthy"
  if (avgScore >= 1.5) return "degraded"
  if (avgScore >= 0.5) return "critical"
  return "error"
}

function aggregateByExchange(connections: any[]): Record<string, number> {
  return connections.reduce(
    (acc: Record<string, number>, conn: any) => {
      acc[conn.exchange] = (acc[conn.exchange] || 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )
}
