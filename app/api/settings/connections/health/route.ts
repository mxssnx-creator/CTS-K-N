/**
 * Connection Health & Metrics API
 * Returns comprehensive health status and performance metrics for connections
 */

import { type NextRequest, NextResponse } from "next/server"
import { ConnectionCoordinator } from "@/lib/connection-coordinator"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const coordinator = ConnectionCoordinator.getInstance()
    await coordinator.reloadConnections()
    const { searchParams } = new URL(request.url)

    const connectionId = searchParams.get("id")
    const exchange = searchParams.get("exchange")
    const apiType = searchParams.get("apiType")

    if (connectionId) {
      // Get single connection health and metrics
      const health = coordinator.getConnectionHealth(connectionId)
      const metrics = coordinator.getConnectionMetrics(connectionId)

      if (!health) {
        return NextResponse.json(
          {
            error: "Connection not found",
            connectionId,
          },
          { status: 404 }
        )
      }

      return NextResponse.json({
        connectionId,
        health,
        metrics,
      })
    }

    if (exchange) {
      // Get all connections for an exchange with health
      const connections = coordinator.getConnectionsByExchange(exchange)
      const healthData = connections.map((conn) => ({
        connection: conn,
        health: coordinator.getConnectionHealth(conn.id),
        metrics: coordinator.getConnectionMetrics(conn.id),
      }))

      return NextResponse.json({
        exchange,
        count: connections.length,
        connections: healthData,
      })
    }

    if (apiType) {
      // Get all connections for an API type with health
      const connections = coordinator.getConnectionsByApiType(apiType as any)
      const healthData = connections.map((conn) => ({
        connection: conn,
        health: coordinator.getConnectionHealth(conn.id),
        metrics: coordinator.getConnectionMetrics(conn.id),
      }))

      return NextResponse.json({
        apiType,
        count: connections.length,
        connections: healthData,
      })
    }

    // Get all connections health overview
    const allConnections = coordinator.getAllConnections()
    const allHealth = coordinator.getAllConnectionsHealth()
    const allMetrics = coordinator.getAllConnectionsMetrics()

    const overview = allConnections.map((conn) => ({
      id: conn.id,
      name: conn.name,
      exchange: conn.exchange,
      apiType: conn.api_type,
      enabled: conn.is_enabled,
      active: conn.is_active,
      health: coordinator.getConnectionHealth(conn.id),
      metrics: coordinator.getConnectionMetrics(conn.id),
    }))

    const summary = {
      totalConnections: allConnections.length,
      activeConnections: allConnections.filter((c) => c.is_enabled && c.is_active).length,
      healthyConnections: allHealth.filter((h) => h.status === "active").length,
      errorConnections: allHealth.filter((h) => h.status === "error").length,
      averageUptime: allHealth.length > 0 ? (allHealth.reduce((sum, h) => sum + h.uptime, 0) / allHealth.length).toFixed(2) : "N/A",
      totalRequests: allMetrics.reduce((sum, m) => sum + m.totalRequests, 0),
      successRate:
        allMetrics.reduce((sum, m) => sum + m.successfulRequests, 0) /
          Math.max(allMetrics.reduce((sum, m) => sum + m.totalRequests, 0), 1) *
          100,
    }

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      summary,
      connections: overview,
    })
  } catch (error) {
    console.error("[v0] Health/metrics API error:", error)

    return NextResponse.json(
      {
        error: "Failed to retrieve health information",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
