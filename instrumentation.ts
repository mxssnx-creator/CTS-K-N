/**
 * Next.js instrumentation hook — the deterministic, once-per-process server
 * boot entry point. `register()` runs a single time when each server process
 * starts, BEFORE any request is handled.
 *
 * ── WHY THIS FILE IS CRITICAL (production stability) ─────────────────────────
 * This file had gone missing even though `next.config.mjs` and
 * `scripts/vercel-build-setup.sh` both reference it. Without it, production had
 * NO server-side boot path: the engine only initialized when a browser happened
 * to mount `EngineAutoInitializer` and POST `/api/system/initialize`. That route
 * seeds + auto-starts but does NOT run `completeStartup()`, so the orphaned-flag
 * cleanup (`cleanupOrphanedProgress`) and stranded-position reconcile
 * (`reconcileStrandedPositions`) NEVER ran on a production restart/deploy.
 * Result: zombie `engine_is_running` flags, stalled progress, stranded live
 * positions, and inconsistent counts carried over in the snapshot from the
 * previous process — exactly the "race conditions, stallings, restarts,
 * failures of progress and counts" reported in production. Dev was stable
 * because it is a single long-lived process with the browser always open and a
 * dev-only stale-state flush on every init.
 *
 * Restoring this hook gives production a deterministic, headless boot that does
 * not depend on a browser, and guarantees orphan cleanup + migrations run on
 * every process start. The documented boot path is:
 *   register() → completeStartup() [initRedis→runMigrations, validate,
 *   cleanupOrphanedProgress, reconcileStrandedPositions] →
 *   initializeTradeEngineAutoStart() → startServerContinuityRunner()
 */

import { isKiloDeploymentRuntime, isServerlessDeploymentRuntime } from "@/lib/deployment-runtime"

// Guard against double-execution across HMR / module re-evaluation. Failed
// startup attempts are not cached: a long-lived Node process retries after one
// minute, while serverless platforms naturally retry on a later invocation.
const bootGuard = globalThis as unknown as {
  __v0_instrumentation_booted?: boolean
  __v0_instrumentation_boot_promise?: Promise<void> | null
  __v0_instrumentation_retry_timer?: ReturnType<typeof setTimeout>
}

function canRetryInProcess(): boolean {
  return !(
    process.env.DISABLE_IN_PROCESS_CONTINUITY === "1" ||
    isServerlessDeploymentRuntime()
  )
}

function scheduleStartupRetry(): void {
  if (!canRetryInProcess() || bootGuard.__v0_instrumentation_retry_timer) return
  bootGuard.__v0_instrumentation_retry_timer = setTimeout(() => {
    bootGuard.__v0_instrumentation_retry_timer = undefined
    void register()
  }, 60_000)
  bootGuard.__v0_instrumentation_retry_timer.unref?.()
  console.warn("[v0] [Instrumentation] critical startup will retry in 60 seconds")
}

export async function register(): Promise<void> {
  // Only skip the Edge runtime. In `next start` / OpenNext production workers
  // `NEXT_RUNTIME` can be undefined during instrumentation registration, while
  // the runtime is still a normal Node-compatible server process. Requiring the
  // value to be exactly "nodejs" skipped deterministic boot in production and
  // reproduced the dev/prod divergence: migrations, orphan cleanup, and
  // stranded-position reconciliation did not run until a later request path.
  if (process.env.NEXT_RUNTIME === "edge") return

  if (bootGuard.__v0_instrumentation_booted) return
  if (bootGuard.__v0_instrumentation_boot_promise) {
    return bootGuard.__v0_instrumentation_boot_promise
  }

  let bootPromise!: Promise<void>
  bootPromise = runDeterministicBoot().finally(() => {
    if (bootGuard.__v0_instrumentation_boot_promise === bootPromise) {
      bootGuard.__v0_instrumentation_boot_promise = null
    }
  })
  bootGuard.__v0_instrumentation_boot_promise = bootPromise
  return bootPromise
}

async function runDeterministicBoot(): Promise<void> {

  console.log("[v0] [Instrumentation] register() — beginning deterministic server boot...")

  // Migrations and startup reconciliation are critical. Never start an engine
  // or advertise readiness when this phase failed against a partial schema.
  try {
    const { completeStartup } = await import("@/lib/startup-coordinator")
    await completeStartup()
    const { recordInstrumentationRegistered } = await import("@/lib/startup-diagnostics")
    await recordInstrumentationRegistered().catch(() => {})
  } catch (err) {
    await import("@/lib/startup-diagnostics")
      .then(({ recordStartupError }) => recordStartupError(err, "completeStartup"))
      .catch(() => {})
    bootGuard.__v0_instrumentation_booted = false
    console.error("[v0] [Instrumentation] critical startup failed; engines remain stopped:", err instanceof Error ? err.message : err)
    if (canRetryInProcess()) {
      scheduleStartupRetry()
      return
    }
    // OpenNext/Kilo request workers must remain reachable when an optional
    // managed binding is still being provisioned or temporarily unavailable.
    // The startup coordinator already leaves engines stopped and all real
    // orders fail closed until readiness is restored. Throwing here makes the
    // entire Worker return OpenNext's opaque "Server failed to respond" 500,
    // which prevents the UI and diagnostics from showing the actionable cause.
    if (isKiloDeploymentRuntime()) {
      console.error("[v0] [Instrumentation] Kilo request worker remains reachable; production engines stay stopped until startup is ready")
      return
    }
    // Serverless workers cannot retain the retry timer. Fail the cold start so
    // the platform retries with a fresh process instead of serving a worker
    // that advertises routes while migrations/startup invariants are incomplete.
    throw err
  }

  // Production Node processes should be self-contained: initialize the
  // auto-start/healing sweep and continuity runner by default so explicit UI
  // actions and persisted running intent work without a separate worker env flag.
  // Serverless/edge safety is handled inside the imported runners.
  if (process.env.DISABLE_TRADE_ENGINE_AUTOSTART !== "1") {
    try {
      const { recordStartupPhase } = await import("@/lib/startup-diagnostics")
      await recordStartupPhase("auto_start_running")
      const { initializeTradeEngineAutoStart } = await import("@/lib/trade-engine-auto-start")
      await initializeTradeEngineAutoStart()
    } catch (err) {
      const { recordStartupError } = await import("@/lib/startup-diagnostics")
      await recordStartupError(err, "initializeTradeEngineAutoStart").catch(() => {})
      console.error("[v0] [Instrumentation] auto-start init failed (continuing):", err instanceof Error ? err.message : err)
    }
  } else {
    console.warn("[v0] [Instrumentation] trade-engine auto-start disabled by DISABLE_TRADE_ENGINE_AUTOSTART=1")
    console.warn("[v0] [Instrumentation] background trade-engine auto-start skipped; explicit UI actions and continuity sweeps can start/reconcile engines")
  }

  if (process.env.DISABLE_IN_PROCESS_CONTINUITY !== "1") {
    try {
      const { startServerContinuityRunner } = await import("@/lib/server-continuity-runner")
      startServerContinuityRunner()
      const { recordStartupPhase } = await import("@/lib/startup-diagnostics")
      await recordStartupPhase("continuity_runner_started")
    } catch (err) {
      const { recordStartupError } = await import("@/lib/startup-diagnostics")
      await recordStartupError(err, "startServerContinuityRunner").catch(() => {})
      console.error("[v0] [Instrumentation] continuity runner failed (continuing):", err instanceof Error ? err.message : err)
    }
  } else {
    console.warn("[v0] [Instrumentation] in-process continuity disabled by DISABLE_IN_PROCESS_CONTINUITY=1")
    console.warn("[v0] [Instrumentation] background in-process continuity skipped; deployment cron or UI-triggered reconciliation remains available")
  }

  bootGuard.__v0_instrumentation_booted = true
  if (bootGuard.__v0_instrumentation_retry_timer) {
    clearTimeout(bootGuard.__v0_instrumentation_retry_timer)
    bootGuard.__v0_instrumentation_retry_timer = undefined
  }
  console.log("[v0] [Instrumentation] ✓ Server boot complete")
  try {
    const { recordStartupPhase } = await import("@/lib/startup-diagnostics")
    await recordStartupPhase("ready")
  } catch {}
}
