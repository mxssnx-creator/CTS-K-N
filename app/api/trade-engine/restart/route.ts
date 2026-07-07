import { type NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"

/**
 * POST /api/trade-engine/restart
 *
 * NOTE: Route handlers are isolated modules and cannot be injected with a live
 * engine instance at runtime, so a hard restart must be performed through the
 * global coordinator (see /api/trade-engine/stop + /api/trade-engine/start).
 * This endpoint therefore delegates to the global coordinator singleton when
 * available, and reports a clear error otherwise.
 */
export async function POST(request: NextRequest) {
  try {
    let force = false
    let clearCache = false
    try {
      const text = await request.text()
      if (text && text.trim()) {
        const body = JSON.parse(text)
        force = body.force ?? false
        clearCache = body.clearCache ?? false
      }
    } catch {
      // Empty body - use defaults
    }

    const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
    const coordinator = getGlobalTradeEngineCoordinator()
    if (!coordinator) {
      return NextResponse.json({ success: false, error: "Trade engine not initialized" }, { status: 503 })
    }

    console.log("[v0] Restarting trade engine via global coordinator...", { force, clearCache })

    await coordinator.stopAll()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await coordinator.startAll()

    console.log("[v0] Trade engine restarted successfully")

    return NextResponse.json({
      success: true,
      message: "Trade engine restarted successfully",
      timestamp: new Date().toISOString(),
    })
  } catch (error: any) {
    console.error("[v0] Error restarting trade engine:", error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}
