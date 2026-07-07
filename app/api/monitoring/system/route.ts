import { NextResponse } from "next/server"
import DatabaseManager from "@/lib/database"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    const db = DatabaseManager.getInstance()

    // Get system states
    const connections = await db.getConnections()
    const pseudoPositions = await db.getPseudoPositions(undefined, 10)
    const realPositions = await db.getRealPositions()

    // Calculate states
    const activeConnections = connections.filter((c: any) => c.is_enabled).length
    const liveTradeConnections = connections.filter((c: any) => c.is_live_trade).length
    const activePseudoPositions = pseudoPositions.length
    const openRealPositions = realPositions.length

    // Get recent logs for health check
    const recentErrors = await db.getErrors(10, false)

    const systemStates = {
      connections: {
        total: connections.length,
        active: activeConnections,
        liveTrade: liveTradeConnections,
        status: activeConnections > 0 ? "connected" : "disconnected",
      },
      trading: {
        pseudoPositions: activePseudoPositions,
        realPositions: openRealPositions,
        status: openRealPositions > 0 ? "active" : "idle",
      },
      strategy: {
        status: "running",
        lastUpdate: new Date().toISOString(),
      },
      database: {
        status: "connected",
        size: "N/A",
      },
      errors: {
        count: recentErrors.length,
        status: recentErrors.length > 5 ? "warning" : "healthy",
      },
    }

    return NextResponse.json({ states: systemStates })
  } catch (error) {
    console.error("Error fetching system states:", error)
    return NextResponse.json({
      states: {
        connections: { total: 0, active: 0, liveTrade: 0, status: "disconnected" },
        trading: { pseudoPositions: 0, realPositions: 0, status: "idle" },
        strategy: { status: "stopped", lastUpdate: new Date().toISOString() },
        database: { status: "unknown", size: "N/A" },
        errors: { count: 0, status: "unknown" },
      },
    })
  }
}
