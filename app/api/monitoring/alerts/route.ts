import { NextResponse, type NextRequest } from "next/server"
import { getAllConnections, getSettings, setSettings } from "@/lib/redis-db"
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

const ACKNOWLEDGEMENT_KEY = "monitoring_alert_acknowledgements"
const ACKNOWLEDGEMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000

function normalizeAcknowledgements(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const cutoff = Date.now() - ACKNOWLEDGEMENT_TTL_MS
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([id, timestamp]) => {
        if (!id || typeof timestamp !== "string") return false
        const parsed = Date.parse(timestamp)
        return Number.isFinite(parsed) && parsed >= cutoff
      })
      .map(([id, timestamp]) => [id, String(timestamp)]),
  )
}

/**
 * GET /api/monitoring/alerts
 * Fetch active alerts based on system monitoring
 */
export async function GET() {
  try {
    const alerts: Alert[] = []
    const acknowledgements = normalizeAcknowledgements(await getSettings(ACKNOWLEDGEMENT_KEY))

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

    const annotatedAlerts = alerts.map((alert) => ({
      ...alert,
      acknowledged: Boolean(acknowledgements[alert.id]),
      acknowledgedAt: acknowledgements[alert.id] || null,
    }))

    return NextResponse.json({
      success: true,
      alerts: annotatedAlerts,
      count: annotatedAlerts.length,
      unacknowledgedCount: annotatedAlerts.filter((alert) => !alert.acknowledged).length,
      criticalCount: annotatedAlerts.filter(a => a.level === "critical").length,
      warningCount: annotatedAlerts.filter(a => a.level === "warning").length,
      infoCount: annotatedAlerts.filter(a => a.level === "info").length,
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

    const acknowledgements = normalizeAcknowledgements(await getSettings(ACKNOWLEDGEMENT_KEY))
    const acknowledgedAt = new Date().toISOString()
    acknowledgements[String(alertId)] = acknowledgedAt
    await setSettings(ACKNOWLEDGEMENT_KEY, acknowledgements)
    await SystemLogger.logAPI(`Alert acknowledged: ${alertId}`, "info", "POST /api/monitoring/alerts")

    return NextResponse.json({
      success: true,
      message: `Alert ${alertId} acknowledged`,
      acknowledgedAt,
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
