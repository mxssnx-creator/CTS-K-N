import { NextResponse } from "next/server"
import { ensureDefaultExchangesExist } from "@/lib/default-exchanges-seeder"
import { getAllConnections, initRedis } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function POST() {
  try {
    console.log("[v0] [InitPredefined] Ensuring canonical base connections in Redis")
    await initRedis()
    const ensured = await ensureDefaultExchangesExist()
    const allConnections = await getAllConnections()
    const baseConnections = allConnections.filter((c: any) => ["bingx-x01", "pionex-x01", "orangex-x01"].includes(c.id))

    return NextResponse.json({
      success: true,
      message: "Canonical base connections ensured in Redis storage",
      count: baseConnections.length,
      ensured,
      connections: baseConnections.map((c: any) => ({
        id: c.id,
        name: c.name,
        exchange: c.exchange,
        is_enabled: c.is_enabled,
        is_enabled_dashboard: c.is_enabled_dashboard,
      })),
    })
  } catch (error) {
    console.error("[v0] [InitPredefined] Failed to initialize predefined connections:", error)
    return NextResponse.json(
      {
        error: "Failed to initialize predefined connections",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
