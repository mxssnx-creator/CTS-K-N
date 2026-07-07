import { NextResponse } from "next/server"
import { initRedis, getAllConnections } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function isTruthy(value: unknown): boolean {
  return value === true || value === "1" || value === "true"
}

/**
 * GET /api/trade-engine/quick-start/ready
 * Returns whether the system is ready for quickstart
 * Checks for at least one connection that can be used
 */
export async function GET() {
  try {
    await initRedis()
    const allConnections = await getAllConnections()
    const BASE_EXCHANGES = ["bingx", "pionex", "orangex"]

    // Check for connections with credentials (highest priority)
    const connectionsWithCredentials = allConnections.filter((c: any) => {
      const exch = (c.exchange || "").toLowerCase()
      const key = c.api_key || c.apiKey || ""
      const secret = c.api_secret || c.apiSecret || ""
      const hasCredentials = key.length >= 10 && secret.length >= 10
      const isBase = BASE_EXCHANGES.includes(exch)
      return isBase && hasCredentials
    })

    // Check for main-assigned connections (even without credentials)
    const mainConnections = allConnections.filter((c: any) => {
      const exch = (c.exchange || "").toLowerCase()
      const isMainAssigned = isTruthy(c.is_assigned)
      const isBase = BASE_EXCHANGES.includes(exch)
      return isBase && isMainAssigned
    })

    const isReady = connectionsWithCredentials.length > 0 || mainConnections.length > 0
    
    return NextResponse.json({
      ready: isReady,
      hasCredentials: connectionsWithCredentials.length > 0,
      connectionsWithCredentials: connectionsWithCredentials.map((c: any) => ({
        id: c.id,
        name: c.name,
        exchange: c.exchange,
      })),
      // Keep both keys for compatibility while the UI transitions to Main naming.
      mainConnections: mainConnections.map((c: any) => ({
        id: c.id,
        name: c.name,
        exchange: c.exchange,
        hasCredentials: (c.api_key || c.apiKey || "").length >= 10 && (c.api_secret || c.apiSecret || "").length >= 10,
      })),
      baseConnections: mainConnections.map((c: any) => ({
        id: c.id,
        name: c.name,
        exchange: c.exchange,
        hasCredentials: (c.api_key || c.apiKey || "").length >= 10 && (c.api_secret || c.apiSecret || "").length >= 10,
      })),
      totalConnections: allConnections.length,
      message: isReady
        ? "System is ready for quickstart"
        : "No suitable connections found. Add BingX to Main Connections in Dashboard first.",
    })
  } catch (error) {
    console.error("[v0] [QuickStartReady] Error:", error)
    return NextResponse.json(
      {
        ready: false,
        error: "Failed to check quickstart readiness",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
