import { NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const INIT_LOCK_KEY = "system:initialize:lock"
const INIT_LOCK_TTL_SECONDS = 90

export async function POST(_req: NextRequest) {
  // Server-side bootstrap endpoint. This POST is intentionally idempotent
  // and safe to call from client mounts (EngineAutoInitializer). It will
  // run the same seeding and initialization logic used in production
  // without importing `fs` or other server-only modules into client
  // bundles.
  const token = `system_init_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  try {
    // Acquire a Redis lock before seeding so page refreshes, multiple tabs,
    // cron continuity, and startup instrumentation cannot run production
    // bootstrap concurrently and race on progression/connection state.
    const { initRedis, getRedisClient } = await import("@/lib/redis-db")
    await initRedis()
    const { recordStartupPhase } = await import("@/lib/startup-diagnostics")
    await recordStartupPhase("system_initialize_running")
    const client = getRedisClient()
    const acquired = await client.set(INIT_LOCK_KEY, token, { NX: true, EX: INIT_LOCK_TTL_SECONDS }).catch(() => null)
    if (acquired !== "OK") {
      return NextResponse.json({ success: true, skipped: true, queued: true, reason: "system initialization already running" })
    }

    try {
      // Run the same authoritative startup path used by instrumentation while
      // still holding the public initialization lock. This keeps production
      // bootstrap side effects (migrations, pre-startup seeding, validation,
      // cleanup scheduling, boot metadata) in one path instead of duplicating
      // them here with subtly different behavior. `completeStartup()` throws
      // only for fatal startup failures; controlled/non-fatal warnings are
      // logged internally and return normally.
      const { completeStartup } = await import("@/lib/startup-coordinator")
      await completeStartup()

      // `completeStartup()` already runs `runPreStartup()`, which handles
      // idempotent default settings, base connection/symbol, and placeholder
      // market-data seeding. Keep this route's extra production seeding limited
      // to progression-state creation, whose seeder is first-boot-only and
      // explicitly preserves existing live progression.
      const { seedProductionData } = await import("@/lib/production-seeder")
      await seedProductionData({ seedSettings: false, seedConnections: false, seedMarketData: false, seedProgression: true })

      // Start coordinator and server-side continuity directly. Avoid relative
      // self-fetch here: Node's fetch cannot resolve `/api/...` without a base
      // URL, and silently skipping this left production boot dependent on a
      // browser page mount.
      const { initializeTradeEngineAutoStart, runTradeEngineHealingSweep } = await import("@/lib/trade-engine-auto-start")
      await initializeTradeEngineAutoStart().catch(() => {})
      const healing = await runTradeEngineHealingSweep({ isStartup: true }).catch((error) => ({
        startedCount: 0,
        eligibleCount: 0,
        error: error instanceof Error ? error.message : String(error),
      }))
      const { startServerContinuityRunner } = await import("@/lib/server-continuity-runner")
      startServerContinuityRunner()
      await recordStartupPhase("system_initialize_complete", {
        healing_started_count: healing.startedCount,
        healing_eligible_count: healing.eligibleCount,
        healing_error: "error" in healing ? healing.error : null,
      })
      return NextResponse.json({ success: true, healing })
    } finally {
      const current = await client.get(INIT_LOCK_KEY).catch(() => null)
      if (current === token) {
        await client.del(INIT_LOCK_KEY).catch(() => {})
      }
    }
  } catch (err) {
    try {
      const { recordStartupError } = await import("@/lib/startup-diagnostics")
      await recordStartupError(err, "system_initialize")
    } catch {}
    console.error("/api/system/initialize error:", err)
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 })
  }
}
