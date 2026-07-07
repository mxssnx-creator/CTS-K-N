/**
 * Shared "stop everything before wiping the DB" helper.
 *
 * Every Reset-DB / Flush endpoint must call `stopAllProgressionsBeforeReset()`
 * BEFORE issuing FLUSHALL or any wide DELETE. Without this, an in-flight
 * engine tick can repopulate progression rows, position records, or counter
 * keys mid-wipe and leave the database in a partially-reset state where
 * the operator sees stale numbers blended with fresh defaults.
 *
 * The helper is best-effort: each step is wrapped in try/catch so a
 * crashed coordinator (or a missing global instance during a cold boot)
 * never permanently blocks the operator from resetting state. Errors
 * are returned in the result so the caller can surface them.
 */

export interface StopProgressionsResult {
  coordinator_stopped: boolean
  interval_manager_stopped: boolean
  engine_timers_cleared: number
  global_state_marked_stopped: boolean
  errors: string[]
}

/**
 * Stops every engine, every progression interval, and every stale timer.
 * Marks the global trade-engine state as "stopped" in Redis so any cron
 * invocation that races the wipe will short-circuit.
 *
 * Safe to call multiple times. Safe to call even when nothing is running.
 */
export async function stopAllProgressionsBeforeReset(): Promise<StopProgressionsResult> {
  const result: StopProgressionsResult = {
    coordinator_stopped: false,
    interval_manager_stopped: false,
    engine_timers_cleared: 0,
    global_state_marked_stopped: false,
    errors: [],
  }

  // ── 1. Stop the global trade-engine coordinator ──────────────────────
  // This stops every per-connection EngineManager, including their
  // realtime processors, prehistoric processors, and reconciliation
  // tasks. Without this, a tick mid-flight will rewrite progression
  // counters under our feet between FLUSHALL and migration replay.
  try {
    const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
    const coordinator = getGlobalTradeEngineCoordinator()
    if (coordinator?.stopAll) {
      await coordinator.stopAll()
      result.coordinator_stopped = true
      console.log("[v0] [DBReset] coordinator.stopAll() OK")
    } else if (coordinator?.stopAllEngines) {
      await coordinator.stopAllEngines()
      result.coordinator_stopped = true
      console.log("[v0] [DBReset] coordinator.stopAllEngines() OK")
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`coordinator.stopAll: ${msg}`)
    console.warn("[v0] [DBReset] coordinator stop failed (non-fatal):", msg)
  }

  // ── 2. Stop the IntervalProgressionManager ────────────────────────────
  // This holds setInterval handles for prehistoric progressions, indication
  // refresh loops, and other periodic jobs that run independently of the
  // coordinator's per-engine timers.
  try {
    const { globalIntervalManager } = await import("@/lib/interval-progression-manager")
    if (globalIntervalManager?.stopAll) {
      globalIntervalManager.stopAll()
      result.interval_manager_stopped = true
      console.log("[v0] [DBReset] globalIntervalManager.stopAll() OK")
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`intervalManager.stopAll: ${msg}`)
    console.warn("[v0] [DBReset] interval manager stop failed (non-fatal):", msg)
  }

  // ── 3. Clear stale __engine_timers from previous code versions ───────
  // The trade-engine module installs setInterval handles into a global
  // Set so HMR / hot-reload doesn't leak timers. On a Reset DB we want
  // to forcibly clear that set, not just the ones the coordinator
  // currently knows about — older code versions may have leaked handles.
  try {
    const engineGlobal = globalThis as unknown as {
      __engine_timers?: Set<ReturnType<typeof setInterval>>
    }
    if (engineGlobal.__engine_timers && engineGlobal.__engine_timers.size > 0) {
      let cleared = 0
      for (const timer of engineGlobal.__engine_timers) {
        try {
          clearInterval(timer)
          cleared++
        } catch {
          /* swallow individual clearInterval failures */
        }
      }
      engineGlobal.__engine_timers.clear()
      result.engine_timers_cleared = cleared
      console.log(`[v0] [DBReset] Cleared ${cleared} stale engine timers`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`clearEngineTimers: ${msg}`)
    console.warn("[v0] [DBReset] clear engine timers failed (non-fatal):", msg)
  }

  // ── 4. Mark global engine state as stopped in Redis ──────────────────
  // Crons (`/api/cron/*`) read this hash before running their loops and
  // bail out if status === "stopped". Setting it pre-flush prevents a
  // racing cron from writing fresh keys into the DB right after we
  // FLUSHALL but before migrations replay.
  try {
    const { getRedisClient, initRedis } = await import("@/lib/redis-db")
    await initRedis()
    const client = getRedisClient()
    await client.hset("trade_engine:global", {
      status: "stopped",
      stopped_at: new Date().toISOString(),
      coordinator_ready: "false",
      stopped_reason: "db_reset",
    })
    result.global_state_marked_stopped = true
    console.log("[v0] [DBReset] Marked trade_engine:global as stopped")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`markGlobalStopped: ${msg}`)
    console.warn("[v0] [DBReset] mark global stopped failed (non-fatal):", msg)
  }

  return result
}
