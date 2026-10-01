/**
 * Cron routes answer fast; their work runs once, in the background.
 *
 * The one-minute scheduler calls seven routes in parallel and a tick lasts as long
 * as the slowest answer. Measured on 2026-09-29: close-accounting 28-37 s in every
 * tick, historic-test 58 s, signal-source-optimization 47 s, server-continuity and
 * sync-live-positions 11 s at times. Operator target: ticks under one second.
 *
 * runCronTimeBoxed starts the route's work and waits for it for a short budget:
 *   - it finishes inside the budget: the route answers exactly as before;
 *   - it does not: the route answers at once with { success, pending: true } and the
 *     work continues. The next tick does NOT start a second run while one is in
 *     flight (single flight per route), so slow work cannot pile up;
 *   - the outcome of a background run is recorded and shows in the next answer: a
 *     failed run makes the following response `success:false`, which the scheduler
 *     already counts as a failed tick. A failure is reported one tick late, not lost.
 *   - `?wait=1` (the installer's --once check) waits for the whole run, as before, so
 *     deploy verification still sees finished work and fresh continuity.
 */
import { NextResponse } from "next/server"

export const CRON_TIME_BUDGET_DEFAULT_MS = 600
/** How long a maintenance route waits when the caller asks it to wait (?wait=1). */
export const MAINTENANCE_MAX_WAIT_MS = 15_000
/** A run that has been in flight this long is presumed hung; a new one may start. */
export const CRON_RUN_STALE_MS = 5 * 60_000

export interface CronLastRun {
  at: number
  durationMs: number
  ok: boolean
  status: number
  error?: string
}

interface InFlight { startedAt: number; promise: Promise<Response> }

const inflight = new Map<string, InFlight>()
const lastRuns = new Map<string, CronLastRun>()

export function cronTimeBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.CTS_CRON_TIME_BUDGET_MS)
  if (!Number.isFinite(raw) || raw <= 0) return CRON_TIME_BUDGET_DEFAULT_MS
  return Math.min(5_000, Math.max(100, Math.floor(raw)))
}

/** Diagnostics: what each route's last completed run did, and what is running now. */
export function cronRunStatus(): Record<string, { lastRun: CronLastRun | null; runningForMs: number | null }> {
  const names = new Set([...inflight.keys(), ...lastRuns.keys()])
  const out: Record<string, { lastRun: CronLastRun | null; runningForMs: number | null }> = {}
  for (const name of names) out[name] = { lastRun: lastRuns.get(name) ?? null, runningForMs: inflight.has(name) ? Date.now() - inflight.get(name)!.startedAt : null }
  return out
}

/** Test hook. */
export function resetCronRunState(): void {
  inflight.clear()
  lastRuns.clear()
}

async function record(name: string, startedAt: number, response: Response): Promise<void> {
  let body: any = null
  try { body = await response.clone().json() } catch { /* not JSON */ }
  const failed = body && typeof body === "object" && (body.success === false || body.degraded === true || body.ok === false)
  lastRuns.set(name, { at: Date.now(), durationMs: Date.now() - startedAt, ok: response.ok && !failed, status: response.status })
}

function pendingResponse(name: string, run: InFlight, alreadyRunning: boolean): Response {
  const last = lastRuns.get(name) ?? null
  return NextResponse.json({
    // A failed previous run is reported here, one tick late; a run in progress is not a failure.
    success: last ? last.ok : true,
    pending: true,
    alreadyRunning,
    name,
    runningForMs: Date.now() - run.startedAt,
    lastRun: last,
  }, { status: 202 })
}

export async function runCronTimeBoxed(
  name: string,
  request: Request,
  work: () => Promise<Response>,
  options: { budgetMs?: number; maxWaitMs?: number } = {},
): Promise<Response> {
  const waitForCompletion = new URL(request.url).searchParams.get("wait") === "1"
  let run = inflight.get(name)
  if (run && Date.now() - run.startedAt > CRON_RUN_STALE_MS) {
    inflight.delete(name)
    run = undefined
  }
  if (!run) {
    const startedAt = Date.now()
    const promise = (async () => {
      try {
        const response = await work()
        await record(name, startedAt, response)
        return response
      } catch (error) {
        lastRuns.set(name, { at: Date.now(), durationMs: Date.now() - startedAt, ok: false, status: 500, error: error instanceof Error ? error.message : String(error) })
        throw error
      } finally {
        if (inflight.get(name)?.startedAt === startedAt) inflight.delete(name)
      }
    })()
    promise.catch(() => undefined) // a background failure is recorded above, never unhandled
    run = { startedAt, promise }
    inflight.set(name, run)
  } else if (!waitForCompletion) {
    return pendingResponse(name, run, true)
  }

  if (waitForCompletion) {
    // Continuity routes wait for the whole run: the installer's check needs finished work and fresh continuity.
    // MAINTENANCE routes (accounting, replay, optimisation) bound the wait with maxWaitMs and then answer
    // "pending": deploy #530 failed all four --once attempts because close-accounting, with the results ledger
    // and two connections, needed more than the 58 s a tick may take, although nothing it does is needed to
    // verify a deployment.
    if (options.maxWaitMs !== undefined) {
      let waitTimer: ReturnType<typeof setTimeout> | undefined
      const limit = new Promise<"timeout">((resolve) => { waitTimer = setTimeout(() => resolve("timeout"), options.maxWaitMs); waitTimer.unref?.() })
      try {
        const outcome = await Promise.race([run.promise, limit])
        if (outcome === "timeout") return pendingResponse(name, run, false)
        return outcome.bodyUsed ? NextResponse.json({ success: true, name, note: "completed by an earlier request" }) : outcome
      } finally {
        if (waitTimer) clearTimeout(waitTimer)
      }
    }
    const response = await run.promise
    return response.bodyUsed ? NextResponse.json({ success: true, name, note: "completed by an earlier request" }) : response
  }

  const budgetMs = options.budgetMs ?? cronTimeBudgetMs()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), budgetMs); timer.unref?.() })
  try {
    const outcome = await Promise.race([run.promise, timeout])
    return outcome === "timeout" ? pendingResponse(name, run, false) : outcome
  } finally {
    if (timer) clearTimeout(timer)
  }
}
