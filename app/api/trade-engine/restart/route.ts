import { type NextRequest, NextResponse } from "next/server"
import { getRuntimeMaintenanceState, runtimeMaintenanceJson } from "@/lib/runtime-maintenance"

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
    const maintenance = getRuntimeMaintenanceState()
    if (maintenance.active) {
      return NextResponse.json(runtimeMaintenanceJson(maintenance), { status: 503 })
    }

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

    // Restore canonical running intent before re-arming engines. A prior
    // pause()/stop writes `operator_intent="paused"` / `operator_stopped="1"`
    // to `trade_engine:global`; startAll() -> startEngine() is gated on
    // isGlobalCoordinatorEnabled(), which refuses to start while intent is
    // anything other than "running". Without this write, a Restart issued
    // after a Pause silently no-ops — engines stay stopped while the API
    // returns success. This mirrors the resume route's intent-first pattern.
    try {
      const { initRedis, getRedisClient } = await import("@/lib/redis-db")
      await initRedis()
      const client = getRedisClient()
      const nowIso = new Date().toISOString()
      await client.hset("trade_engine:global", {
        status: "running",
        operator_intent: "running",
        desired_status: "running",
        actual_status: "running",
        operator_stopped: "0",
        stopped_at: "",
        operator_stopped_at: "",
        previous_status: "stopped",
        updated_at: nowIso,
      })
      await client.hdel("trade_engine:global", "paused_at", "paused_by", "pause_reason")
    } catch (intentErr) {
      console.warn("[v0] Could not restore global running intent before restart:", intentErr)
    }

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
