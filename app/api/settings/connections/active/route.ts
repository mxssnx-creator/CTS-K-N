import { NextResponse } from "next/server"
import { initRedis, getAllConnections } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    await initRedis()
    const allConnections = await getAllConnections()
    
    // Active connections = ONLY connections marked as enabled on dashboard
    const activeConnections = allConnections.filter((c: any) => {
      const isDashboardEnabled = c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true || c.is_enabled_dashboard === 1
      return isDashboardEnabled
    })
    
    return NextResponse.json({
      success: true,
      connections: activeConnections,
      total: allConnections.length,
      active: activeConnections.length,
      eligibleForEngine: activeConnections.length,
    })
  } catch (error) {
    console.error("[v0] [API/ActiveConnections] GET error:", error)
    return NextResponse.json(
      { success: false, error: "Failed to load active connections", connections: [], total: 0, active: 0 },
      { status: 500 }
    )
  }
}
