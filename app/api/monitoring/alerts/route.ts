import { NextResponse, type NextRequest } from "next/server"
import { getAllConnections, getSettings } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface Alert {
  id: string
  level: "critical" | "warning" | "info"
  category: string
  message: string
  timestamp: Date
  acknowledged: boolean
}

/**
 * GET /api/monitoring/alerts
 * Fetch active alerts based on system monitoring
 */
export async function GET() {
  try {
    const alerts: Alert[] = []

    // Check for failed orders from Redis
    const orders = (await getSettings("orders")) || []
    const failedOrders = orders.filter((o: any) => o.status === "failed" && 
      new Date(o.created_at).getTime() > Date.now() - 3600000) // Last hour

    if (failedOrders.length > 5) {
      alerts.push({
        id: "orders-failed",
        level: "warning",
        category: "Order Execution",
        message: `${failedOrders.length} orders failed in the last hour`,
        timestamp: new Date(),
        acknowledged: false
      })
    }

    // Check for inactive connections
    const connections = await getAllConnections()
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
    
    const inactiveConnections = connections.filter((conn: any) => {
      const isActive = (conn.is_enabled === true || conn.is_enabled === "1" || conn.is_enabled === "true") &&
                      (conn.is_live_trade === true || conn.is_live_trade === "1" || conn.is_preset_trade === true || conn.is_preset_trade === "1")
      const lastUpdate = new Date(conn.updated_at || 0).getTime()
      return isActive && lastUpdate < fiveMinutesAgo
    })

    for (const conn of inactiveConnections) {
      alerts.push({
        id: `conn-inactive-${conn.id}`,
        level: "warning",
        category: "Connection",
        message: `Connection "${conn.name}" has not been active in the last 5 minutes`,
        timestamp: new Date(),
        acknowledged: false
      })
    }

    // Check for recent errors in logs
    const logs = (await getSettings("system_logs")) || []
    const recentErrorLogs = logs.filter((log: any) => 
      log.level === "error" && 
      new Date(log.timestamp || 0).getTime() > Date.now() - 10 * 60 * 1000 // Last 10 minutes
    )

    if (recentErrorLogs.length > 10) {
      alerts.push({
        id: "high-error-rate",
        level: "critical",
        category: "System Health",
        message: `High error rate detected: ${recentErrorLogs.length} errors in last 10 minutes`,
        timestamp: new Date(),
        acknowledged: false
      })
    }

    // Check for empty active connections on dashboard (info level)
    const dashboardConnections = connections.filter((c: any) => 
      c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true
    )
    
    if (dashboardConnections.length === 0 && connections.length > 0) {
      alerts.push({
        id: "no-dashboard-connections",
        level: "info",
        category: "Configuration",
        message: "No connections added to dashboard active list yet",
        timestamp: new Date(),
        acknowledged: false
      })
    }

    return NextResponse.json({
      success: true,
      alerts,
      count: alerts.length,
      criticalCount: alerts.filter(a => a.level === "critical").length,
      warningCount: alerts.filter(a => a.level === "warning").length,
      infoCount: alerts.filter(a => a.level === "info").length,
    })

  } catch (error) {
    console.error("[v0] Failed to fetch alerts:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch monitoring alerts",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    )
  }
}

/**
 * POST /api/monitoring/alerts
 * Acknowledge an alert
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { alertId } = body

    if (!alertId) {
      return NextResponse.json(
        { success: false, error: "Missing alertId" },
        { status: 400 }
      )
    }

    await SystemLogger.logAPI(`Alert acknowledged: ${alertId}`, "info", "POST /api/monitoring/alerts")

    return NextResponse.json({
      success: true,
      message: `Alert ${alertId} acknowledged`
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: "Failed to acknowledge alert"
      },
      { status: 500 }
    )
  }
}
