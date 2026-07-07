import { NextResponse } from "next/server"
import { getAllConnections, initRedis } from "@/lib/redis-db"
import { ensureDefaultExchangesExist } from "@/lib/default-exchanges-seeder"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * Canonical startup initialization.
 * Ensures only canonical base connections exist and env credentials are injected.
 */
export async function POST() {
  try {
    await initRedis()
    const ensureResult = await ensureDefaultExchangesExist()
    const connections = await getAllConnections()

    const baseIds = ["bingx-x01", "pionex-x01", "orangex-x01"]
    const baseConnections = connections.filter((c: any) => baseIds.includes(c.id))
    const withCredentials = baseConnections.filter((c: any) => (c.api_key || "").length > 10 && (c.api_secret || "").length > 10).length

    return NextResponse.json({
      success: true,
      message: "Startup initialization complete",
      ensureResult,
      summary: {
        totalConnections: connections.length,
        baseConnections: baseConnections.length,
        baseWithCredentials: withCredentials,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}
