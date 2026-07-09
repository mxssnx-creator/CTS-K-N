/**
 * Server-side continuity runner.
 *
 * Keeps instance progress moving from the Node runtime itself instead of relying
 * on a browser tab being open. Browser polling may disappear on page refresh,
 * navigation, laptop sleep, or when the user closes the dashboard; this runner
 * is process-scoped and idempotent so the trade-engine/cron path remains active
 * for long-lived production (`next start`, Docker, PM2, VPS) and dev servers.
 *
 * Vercel/serverless note: serverless functions cannot guarantee durable
 * in-process timers after the request returns. On Vercel the repo's
 * `vercel.json` crons are the durable production fallback. Set
 * DISABLE_IN_PROCESS_CONTINUITY=1 to opt out in long-lived Node deployments.
 */

type ContinuityGlobal = typeof globalThis & {
  __cts_continuity_runner?: {
    started: boolean
    indicationInFlight: boolean
    autoStartInFlight: boolean
  }
}

const g = globalThis as ContinuityGlobal

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
    await mod.GET()
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
  state.autoStartInFlight = true
  try {
    const { publishEngineEvent } = await import("@/lib/engine-event-bus")
    await publishEngineEvent("engine.intent.changed", { intent: "continuity.autostart", reason: "in-process-runner", timestamp: new Date().toISOString() })
    const { initializeTradeEngineAutoStart } = await import("@/lib/trade-engine-auto-start")
    await initializeTradeEngineAutoStart()
  } catch (err) {
    console.warn(
      "[v0] [Continuity] auto-start monitor tick failed:",
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    state.autoStartInFlight = false
  }
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
    }
  }

  const state = g.__cts_continuity_runner
  if (state.started) return
  state.started = true

  if (shouldSkipInProcessTimers()) {
    console.log("[v0] [Continuity] In-process timers skipped; relying on production cron/scheduler")
    return
  }

  // Enqueue one idempotent event job on startup. External cron remains the durable
  // scheduler; the in-process runner no longer owns continuous local intervals.
  void enqueueContinuityAutoStartJob()
  void enqueueContinuityIndicationJob()

  console.log("[v0] [Continuity] Server runner enqueued startup continuity jobs; external cron remains scheduler")
}

export function stopServerContinuityRunner(): void {
  const state = g.__cts_continuity_runner
  if (!state) return
  state.started = false
  state.indicationInFlight = false
  state.autoStartInFlight = false
}
