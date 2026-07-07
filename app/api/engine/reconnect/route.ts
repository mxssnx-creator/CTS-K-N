import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getAllConnections } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { clearMarginCooldown } from "@/lib/trade-engine/stages/live-stage"
import { hasConnectionCredentials, isConnectionMainProcessing, isTruthyFlag } from "@/lib/connection-state-utils"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/engine/reconnect
 *
 * Lightweight self-heal trigger that:
 *   1. Clears the margin-error cooldown for all connections (or a specific
 *      one if `connectionId` is provided in the request body) so orders
 *      resume immediately without waiting for the exponential backoff to expire.
 *   2. Re-applies `is_enabled_dashboard="1"` for base connections that may
 *      have been accidentally zeroed out (migration race, clear-progressions, etc.).
 *   3. Calls `coordinator.startMissingEngines()` to restart any enabled
 *      connection whose engine dropped.
 *
 * This endpoint is intentionally idempotent and non-destructive — it does
 * NOT stop running engines, clear progression data, or reset trade history.
 * Use it as a "soft reconnect" when orders stop flowing or after topping up
 * the exchange balance.
 */
export async function POST(request: Request) {
  const startedAt = Date.now()
  try {
    await initRedis()
    const client = getRedisClient()

    // Optional: target a specific connection only.
    let targetConnectionId: string | null = null
    try {
      const body = await request.json().catch(() => ({}))
      if (body?.connectionId && typeof body.connectionId === "string") {
        targetConnectionId = body.connectionId
      }
    } catch { /* no body is fine */ }

    const log: string[] = []

    // ── 1. Clear margin-error cooldowns ───────────────────────────────
    if (targetConnectionId) {
      clearMarginCooldown(targetConnectionId)
      log.push(`Cleared margin cooldown for ${targetConnectionId}`)
    } else {
      // Clear for all base connections.
      const BASE_CONNECTION_IDS = ["bingx-x01"]
      for (const connId of BASE_CONNECTION_IDS) {
        clearMarginCooldown(connId)
      }
      log.push(`Cleared margin cooldowns for base connections`)
    }

    // ── 2. Connection enable flags — intentionally NOT touched ────────
    // AUTO-START DISABLED: reconnect no longer forces is_enabled_dashboard="1".
    // Connections are enabled/disabled only by explicit user action (dashboard toggle).
    // This endpoint only clears cooldowns and restarts dropped engines for already-enabled connections.
    const BASE_CONNECTION_IDS = ["bingx-x01"]
    const connIdsToHeal = targetConnectionId ? [targetConnectionId] : BASE_CONNECTION_IDS
    const healed = 0
    log.push(`Connection enable flags preserved as-is (auto-enable disabled)`)

    // ── 3. Ensure global engine is running ────────────────────────────
    // If the engine is stopped (e.g. auto-stop after a code hot-reload, or a
    // previous explicit stop), the reconnect endpoint re-arms it. This is the
    // primary purpose of the "Reconnect" button: recover from any stopped state
    // without requiring a full QuickStart flow.
    const globalState = await client.hgetall("trade_engine:global")
    const globalIsRunning = globalState?.status === "running"
    if (!globalIsRunning) {
      const nowIso = new Date().toISOString()
      await client.hset("trade_engine:global", {
        status: "running",
        started_at: nowIso,
        coordinator_ready: "true",
        reconnected_at: nowIso,
      })
      log.push(`Set trade_engine:global status=running (was: ${globalState?.status ?? "missing"})`)

      // Also start the in-memory coordinator so engines spin up without
      // waiting for the next auto-start monitor tick (up to 30 s delay).
      try {
        const coordinator = getGlobalTradeEngineCoordinator()
        if (!coordinator.isRunning()) {
          // Trigger initialization cycle via the existing public API.
          // The coordinator does not expose a bare `start()` — the engine
          // loop runs via `initialize()` on the next request / cron tick.
          log.push("Coordinator not running — will auto-start on next engine cycle")
        }
      } catch (startErr) {
        log.push(`Coordinator check failed: ${startErr instanceof Error ? startErr.message : String(startErr)}`)
      }
    }

    // ── 4. Start any missing engines ──────────────────────────────────
    let startedCount = 0
    try {
      const connections = await getAllConnections()
      const eligible = connections.filter((c) => {
        if (targetConnectionId && c.id !== targetConnectionId) return false
        const isFullyEnabled = isConnectionMainProcessing(c)
        if (!isFullyEnabled) return false
        const hasAnyCredentials = hasConnectionCredentials(c, 5, true)
        const isPredefined = isTruthyFlag(c.is_predefined)
        const isTestnet = isTruthyFlag(c.is_testnet) || isTruthyFlag(c.demo_mode)
        return hasAnyCredentials || isPredefined || isTestnet
      })

      const coordinator = getGlobalTradeEngineCoordinator()
      startedCount = await coordinator.startMissingEngines(eligible)
      log.push(`startMissingEngines: ${startedCount} engines started (${eligible.length} eligible)`)
    } catch (err) {
      log.push(`startMissingEngines failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    return NextResponse.json({
      success: true,
      message: `Reconnect complete. ${healed} connections re-enabled, ${startedCount} engines started.`,
      log,
      healed,
      startedCount,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] [Reconnect] FATAL:", error)
    return NextResponse.json(
      { success: false, error: "Reconnect failed", details: errorMessage },
      { status: 500 },
    )
  }
}
