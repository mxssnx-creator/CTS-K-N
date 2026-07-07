import { type NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getActiveIndications, getActiveStrategies, getAllPositions } from "@/lib/db-helpers"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    // When the Structure page has a connection selected, derive module health
    // from that connection's live Redis state (indications / strategies /
    // positions). Otherwise fall back to global SQL-shim counts.
    const connectionId = request.nextUrl.searchParams.get("connectionId")
    const isScoped = !!connectionId && connectionId !== "demo-mode" && !connectionId.startsWith("demo")

    let activeConnections: number
    let recentIndications: number
    let activePositions: number
    let activeStrategiesCount = 0

    if (isScoped) {
      const [inds, strats, positions] = await Promise.all([
        getActiveIndications(connectionId!).catch(() => []),
        getActiveStrategies(connectionId!).catch(() => []),
        getAllPositions(connectionId!).catch(() => []),
      ])
      activeConnections = 1
      recentIndications = inds.length
      activeStrategiesCount = strats.length
      activePositions = (positions as any[]).filter(
        (p: any) => p?.status === "open",
      ).length
    } else {
      const connectionCheck = await query(`SELECT COUNT(*) as count FROM exchange_connections WHERE is_enabled = 1`)
      const indicationCheck = await query(`
        SELECT COUNT(*) as count FROM indications 
        WHERE datetime(created_at) > datetime('now', '-5 minutes')
      `)
      const positionCheck = await query(`SELECT COUNT(*) as count FROM pseudo_positions WHERE status = 'open'`)
      activeConnections = Number.parseInt(connectionCheck[0]?.count || "0") || 0
      recentIndications = Number.parseInt(indicationCheck[0]?.count || "0") || 0
      activePositions = Number.parseInt(positionCheck[0]?.count || "0") || 0
    }

    const modules = [
      {
        name: "Live Trading Engine",
        status: activeConnections > 0 ? "active" : "inactive",
        health: activeConnections > 0 ? 98 : 0,
        last_update: "2 min ago",
      },
      {
        name: "Indication Generator",
        status: recentIndications > 0 ? "active" : "inactive",
        health: recentIndications > 0 ? 95 : 0,
        last_update: "1 min ago",
      },
      {
        name: "Strategy Optimizer",
        // When scoped, reflect whether this connection actually has strategies.
        status: isScoped ? (activeStrategiesCount > 0 ? "active" : "inactive") : "active",
        health: isScoped ? (activeStrategiesCount > 0 ? 92 : 0) : 92,
        last_update: "3 min ago",
      },
      {
        name: "Position Manager",
        status: activePositions > 0 ? "active" : "inactive",
        health: activePositions > 0 ? 97 : 0,
        last_update: "1 min ago",
      },
      {
        name: "Analytics Engine",
        status: "active",
        health: 89,
        last_update: "5 min ago",
      },
      {
        name: "Database Sync",
        status: "active",
        health: 94,
        last_update: "2 min ago",
      },
      {
        name: "API Gateway",
        status: "active",
        health: 96,
        last_update: "1 min ago",
      },
      {
        name: "WebSocket Server",
        status: "active",
        health: 93,
        last_update: "2 min ago",
      },
    ]

    return NextResponse.json({
      success: true,
      scope: isScoped ? "connection" : "global",
      connectionId: isScoped ? connectionId : null,
      data: modules,
    })
  } catch (error) {
    console.error("[v0] Error fetching module status:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch module status",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
