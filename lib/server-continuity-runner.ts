/**
 * Server-side continuity runner.
 *
 * Keeps instance progress moving from the Node runtime itself instead of relying
 * on a browser tab being open. Browser polling may disappear on page refresh,
 * navigation, laptop sleep, or when the user closes the dashboard; this runner
 * is process-scoped and idempotent so the trade-engine/cron path remains active
 * for long-lived production (`next start`, Docker, PM2, VPS) and dev servers.
 *
 * Serverless note: functions cannot guarantee durable in-process timers after
 * the request returns. Use the repository's portable minute scheduler (or a
 * platform cron trigger) there. Set DISABLE_IN_PROCESS_CONTINUITY=1 to opt out
 * in long-lived Node deployments.
 */

import { createInternalCronRequest } from "@/lib/cron-auth"
import { getEngineTimings } from "@/lib/engine-timings"

type ContinuityGlobal = typeof globalThis & {
  __cts_continuity_runner?: {
    started: boolean
    indicationInFlight: boolean
    autoStartInFlight: boolean
    liveRecoveryInFlight: boolean
    minuteTimer?: ReturnType<typeof setInterval>
    liveRecoveryTimer?: ReturnType<typeof setTimeout>
  }
}

const g = globalThis as ContinuityGlobal
export const CONTINUITY_MINUTE_INTERVAL_MS = 60_000

export function getLiveRecoveryIntervalMs(): number {
  const seconds = Number(getEngineTimings().cronSyncIntervalSeconds)
  return Math.max(5, Math.min(60, Number.isFinite(seconds) ? seconds : 15)) * 1_000
}

function scheduleNextLiveRecovery(): void {
  const state = g.__cts_continuity_runner
  if (!state?.started || shouldSkipInProcessTimers()) return
  state.liveRecoveryTimer = setTimeout(async () => {
    try {
      await enqueueContinuityLiveRecoveryJob()
    } finally {
      scheduleNextLiveRecovery()
    }
  }, getLiveRecoveryIntervalMs())
  state.liveRecoveryTimer.unref?.()
}

function shouldSkipInProcessTimers(): boolean {
  // Long-lived Node production/dev processes should keep continuity alive by
  // default. Serverless/edge deployments still use deployment cron because
  // in-process timers are not durable after responses return.
  if (process.env.DISABLE_IN_PROCESS_CONTINUITY === "1") return true
  // VERCEL=1 or VERCEL_ENV=production/preview indicates serverless environment
  const isVercel = process.env.VERCEL === "1" || !!process.env.VERCEL_ENV || process.env.NEXT_RUNTIME === "edge"
  return isVercel
}

export async function enqueueContinuityIndicationJob(): Promise<void> {
  const state = g.__cts_continuity_runner
  if (!state || state.indicationInFlight) return
  state.indicationInFlight = true
  try {
    const { publishEngineEvent } = await import("@/lib/engine-event-bus")
    await publishEngineEvent("engine.intent.changed", { intent: "continuity.generate-indications", reason: "in-process-runner", timestamp: new Date().toISOString() })
    const mod = await import("@/app/api/cron/generate-indications/route")
    await mod.GET(createInternalCronRequest("/api/cron/generate-indications"))
  } catch (err) {
    console.warn(
      "[v0] [Continuity] indication tick failed:",
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    state.indicationInFlight = false
  }
}

export async function enqueueContinuityAutoStartJob(): Promise<void> {
  const state = g.__cts_continuity_runner
  if (!state || state.autoStartInFlight) return
  if (process.env.DISABLE_TRADE_ENGINE_AUTOSTART === "1") return
  state.autoStartInFlight = true
  try {
    const { publishEngineEvent } = await import("@/lib/engine-event-bus")
    await publishEngineEvent("engine.intent.changed", { intent: "continuity.autostart", reason: "in-process-runner", timestamp: new Date().toISOString() })
    const { runTradeEngineHealingSweep } = await import("@/lib/trade-engine-auto-start")
    await runTradeEngineHealingSweep({ isStartup: false })
  } catch (err) {
    console.warn(
      "[v0] [Continuity] auto-start monitor tick failed:",
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    state.autoStartInFlight = false
  }
}

export async function enqueueContinuityLiveRecoveryJob(): Promise<void> {
  const state = g.__cts_continuity_runner
  if (!state || state.liveRecoveryInFlight) return
  state.liveRecoveryInFlight = true
  try {
    const { runLivePositionRecoverySweep } = await import("@/app/api/cron/sync-live-positions/route")
    await runLivePositionRecoverySweep()
  } catch (err) {
    console.warn(
      "[v0] [Continuity] live-position recovery tick failed:",
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    state.liveRecoveryInFlight = false
  }
}

/** One portable minute tick for indication generation and intent healing. */
export async function enqueueContinuityMinuteJob(): Promise<void> {
  await Promise.all([
    enqueueContinuityAutoStartJob(),
    enqueueContinuityIndicationJob(),
  ])
}

export function isServerContinuityRunnerStarted(): boolean {
  return !!g.__cts_continuity_runner?.started
}

export function startServerContinuityRunner(): void {
  if (!g.__cts_continuity_runner) {
    g.__cts_continuity_runner = {
      started: false,
      indicationInFlight: false,
      autoStartInFlight: false,
      liveRecoveryInFlight: false,
    }
  }

  const state = g.__cts_continuity_runner
  if (state.started) return
  state.started = true

  if (shouldSkipInProcessTimers()) {
    console.log("[v0] [Continuity] In-process timers skipped; relying on production cron/scheduler")
    return
  }

  // Auto-start and exit-only live-position recovery are safe and useful on the
  // first process tick. Defer the expensive indication/strategy fallback until
  // the first full minute boundary: initializeTradeEngineAutoStart() may have
  // dispatched manager startup asynchronously, leaving a short window before
  // engine_is_running/heartbeats are visible. Running generate-indications in
  // that window creates a second full pipeline beside the manager bootstrap.
  // External/serverless cron calls are unaffected and still execute on demand.
  void enqueueContinuityAutoStartJob()
  void enqueueContinuityLiveRecoveryJob()
  state.minuteTimer = setInterval(() => {
    void enqueueContinuityMinuteJob()
  }, CONTINUITY_MINUTE_INTERVAL_MS)
  state.minuteTimer.unref?.()
  scheduleNextLiveRecovery()

  console.log(
    `[v0] [Continuity] Server runner active (minute coordination + ${getLiveRecoveryIntervalMs() / 1_000}s live recovery)`,
  )
}

export function stopServerContinuityRunner(): void {
  const state = g.__cts_continuity_runner
  if (!state) return
  state.started = false
  state.indicationInFlight = false
  state.autoStartInFlight = false
  state.liveRecoveryInFlight = false
  if (state.minuteTimer) clearInterval(state.minuteTimer)
  if (state.liveRecoveryTimer) clearTimeout(state.liveRecoveryTimer)
  state.minuteTimer = undefined
  state.liveRecoveryTimer = undefined
}
