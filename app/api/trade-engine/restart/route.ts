import { type NextRequest, NextResponse } from "next/server"
import { getRuntimeMaintenanceState, runtimeMaintenanceJson } from "@/lib/runtime-maintenance"
import { getAssignedAndEnabledConnections, getRedisClient, initRedis } from "@/lib/redis-db"
import { parseRuntimeTimestamp } from "@/lib/distributed-engine-runtime"
import { publishRunningTradeEngineIntent } from "@/lib/trade-engine-intent"

export const dynamic = "force-dynamic"

const ACTIVE_PHASES = new Set(["active", "historic", "historical", "live_trading", "ready", "realtime", "running"])
const HEARTBEAT_FRESH_MS = 90_000

function sanitizedConnectionId(value: unknown): string {
  return String(value ?? "unknown").replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 96) || "unknown"
}

async function waitForRestartConvergence(
  coordinator: any,
  timeoutMs = Number(process.env.TRADE_ENGINE_RESTART_TIMEOUT_MS || 15_000),
  pollMs = Number(process.env.TRADE_ENGINE_RESTART_POLL_MS || 250),
) {
  const client = getRedisClient()
  const eligible = await getAssignedAndEnabledConnections()
  const deadline = Date.now() + Math.max(0, timeoutMs)
  let failures: string[] = []

  do {
    const now = Date.now()
    const globalState = (await client.hgetall("trade_engine:global")) as Record<string, string>
    const globalRunning =
      globalState.operator_intent === "running" &&
      globalState.desired_status === "running" &&
      coordinator.isRunning() === true
    failures = []

    for (const connection of eligible) {
      const id = String(connection.id)
      const states = await Promise.all([
        client.hgetall(`trade_engine_state:${id}`),
        client.hgetall(`settings:trade_engine_state:${id}`),
        client.hgetall(`trade_engine_state:${id}:main`),
        client.hgetall(`settings:trade_engine_state:${id}:main`),
      ]) as Array<Record<string, string>>
      const merged = Object.assign({}, ...states)
      const heartbeatAt = Math.max(
        parseRuntimeTimestamp(merged.last_processor_heartbeat),
        parseRuntimeTimestamp(merged.last_heartbeat_at),
        parseRuntimeTimestamp(merged.last_heartbeat_iso),
      )
      const heartbeatCurrent = heartbeatAt > 0 && heartbeatAt <= now + 5_000 && now - heartbeatAt < HEARTBEAT_FRESH_MS
      const phase = String(merged.status || merged.actual_status || "").trim().toLowerCase()
      if (!heartbeatCurrent || !ACTIVE_PHASES.has(phase)) failures.push(sanitizedConnectionId(id))
    }

    if (globalRunning && failures.length === 0) return { converged: true, failedConnectionIds: [] as string[] }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, pollMs)))
  } while (true)

  return { converged: false, failedConnectionIds: failures }
}

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
  let coordinator: any = null
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
    coordinator = getGlobalTradeEngineCoordinator()
    if (!coordinator) {
      return NextResponse.json({ success: false, error: "Trade engine not initialized" }, { status: 503 })
    }

    console.log("[v0] Restarting trade engine via global coordinator...", { force, clearCache })

    await coordinator.stopAll()
    const stopDelayMs = Number(process.env.TRADE_ENGINE_RESTART_STOP_DELAY_MS || 1_000)
    if (stopDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, stopDelayMs))

    // Restore canonical running intent before re-arming engines. A prior
    // pause()/stop writes `operator_intent="paused"` / `operator_stopped="1"`
    // to `trade_engine:global`; startAll() -> startEngine() is gated on
    // isGlobalCoordinatorEnabled(), which refuses to start while intent is
    // anything other than "running". Without this write, a Restart issued
    // after a Pause silently no-ops — engines stay stopped while the API
    // returns success. This mirrors the resume route's intent-first pattern.
    await initRedis()
    await publishRunningTradeEngineIntent(getRedisClient(), { event: "restarted", previousStatus: "stopped" })

    await coordinator.startAll()

    const convergence = await waitForRestartConvergence(coordinator)
    if (!convergence.converged) {
      await coordinator.stopAll()
      return NextResponse.json({
        success: false,
        error: "Trade engine restart did not converge before timeout",
        code: "restart_convergence_timeout",
        failedConnectionIds: convergence.failedConnectionIds,
        coordinatorState: "stopped",
      }, { status: 504 })
    }

    console.log("[v0] Trade engine restarted successfully")

    return NextResponse.json({
      success: true,
      message: "Trade engine restarted successfully",
      timestamp: new Date().toISOString(),
      coordinatorState: "running",
    })
  } catch (error: any) {
    console.error("[v0] Error restarting trade engine:", error)
    if (coordinator) {
      try {
        await coordinator.stopAll()
      } catch (stopError) {
        console.error("[v0] Failed to restore stopped coordinator state after restart failure:", stopError)
      }
    }
    return NextResponse.json({ success: false, error: error.message, coordinatorState: "stopped" }, { status: 500 })
  }
}
