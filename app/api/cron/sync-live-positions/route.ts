import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getAllConnections } from "@/lib/redis-db"
import { reconcileLivePositions, syncWithExchange } from "@/lib/trade-engine/stages/live-stage"
import { exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { getEngineTimings, refreshEngineTimings, ENGINE_TIMING_BOUNDS } from "@/lib/engine-timings"
import { authorizeCronRequest, cronAuthorizationResponse } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * CRASH-RECOVERY / ENGINE-DOWN safety net for live positions.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  Why this file self-loops instead of relying on Vercel cron alone
 * ──────────────────────────────────────────────────────────────────────
 *
 *  Vercel cron's minimum schedule granularity is ONE MINUTE (`* * * * *`).
 *  The operator wants 15-second cadence so an externally-closed position
 *  (SL/TP fired, manual close) is reflected in Redis within ~15 s rather
 *  than waiting up to 60 s for the next cron tick.
 *
 *  Solution: each cron invocation runs *multiple* sweeps inside its
 *  single 60-second `maxDuration` budget, sleeping `cronSyncIntervalSeconds`
 *  (default 15 s) between sweeps. With a 15 s cadence each cron run
 *  performs 4 sweeps (t=0, 15, 30, 45) and exits ~5 s before the next
 *  Vercel cron fires.
 *
 *  Effective sync cadence = `cronSyncIntervalSeconds` (live-tunable from
 *  /settings → System → Engine Timings → cron_sync_interval_seconds).
 *  Setting it to 60 = legacy one-sweep-per-cron behaviour.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  What each sweep does
 * ──────────────────────────────────────────────────────────────────────
 *  Per connection (skipping any whose engine emitted a heartbeat in the
 *  last 90 s — the engine itself reconciles every 5 s via the realtime
 *  processor, so doubling up would burn rate limit):
 *
 *    1. syncWithExchange — discovers exchange-side orphan positions
 *       (positions on the venue that aren't in our Redis index) and
 *       adopts them so the close path can reach them. Also runs the new
 *       externally-closed branch added in the v0_plans/comprehensive-
 *       system-audit fixes — positions in Redis but no longer on the
 *       exchange get finalised here too.
 *
 *    2. reconcileLivePositions — full per-position reconcile: detects
 *       externally-closed, promotes placed→open on fill, heals SL/TP,
 *       runs the max-hold orphan-close sweep.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  Overlap guard
 * ──────────────────────────────────────────────────────────────────────
 *  The atomic SET-NX lock (TTL = 65 s, slightly longer than maxDuration)
 *  prevents two cron invocations from running concurrent sweeps. The
 *  lock is EXTENDED on every sleep boundary so a slow exchange cannot
 *  cause the lock to expire mid-flight and let a second invocation
 *  start. On clean exit the lock is DELeted so the next minute's tick
 *  can acquire immediately.
 */

const LOCK_KEY = "cron:sync-live-positions:lock"
const LOCK_TTL_SECONDS = 65 // > maxDuration so an expired lock implies real crash

interface SweepSummary {
  connectionsChecked: number
  connectionsSkipped: number
  positionsReconciled: number
  positionsClosed: number
  positionsUpdated: number
  // Protection-leg / control-order activity counters. See the
  // reconcileLivePositions return-type docstring for exact semantics.
  protectionRearmed: number
  orphansSwept: number
  errors: number
}

function newSummary(): SweepSummary {
  return {
    connectionsChecked: 0,
    connectionsSkipped: 0,
    positionsReconciled: 0,
    positionsClosed: 0,
    positionsUpdated: 0,
    protectionRearmed: 0,
    orphansSwept: 0,
    errors: 0,
  }
}

function mergeSummary(into: SweepSummary, from: SweepSummary): void {
  into.connectionsChecked  += from.connectionsChecked
  into.connectionsSkipped  += from.connectionsSkipped
  into.positionsReconciled += from.positionsReconciled
  into.positionsClosed     += from.positionsClosed
  into.positionsUpdated    += from.positionsUpdated
  into.protectionRearmed   += from.protectionRearmed
  into.orphansSwept        += from.orphansSwept
  into.errors              += from.errors
}

/**
 * Run a single sweep across all live connections whose engine is idle.
 * Pure function over the connection list — no locking, no sleeping.
 */
export async function runLivePositionRecoverySweep(): Promise<SweepSummary> {
  const summary = newSummary()
  await initRedis()
  const client = getRedisClient()
  const connections = await getAllConnections()

  for (const conn of connections) {
    const connId: string = conn.id || (conn as any).connection_id || (conn as any).connectionId
    if (!connId) continue

    // Canonical per-connection hash is `connection_settings:{id}` (underscore)
    // — the same key written by the settings PATCH route and read by the
    // coordinator/volume-calculator. The old `connection:settings:{id}`
    // (colon) key never existed, so every `settings?.*` gate below was dead
    // and the cron relied solely on the `conn.is_live_trade` fallback.
    const settings = await client
      .hgetall(`connection_settings:${connId}`)
      .catch(() => ({} as Record<string, string>))

    const isLiveTrade =
      settings?.live_trade === "true" ||
      settings?.live_trade === "1" ||
      (conn as any).live_trade === true ||
      (conn as any).is_live_trade === "1" ||
      (conn as any).is_live_trade === true ||
      settings?.is_live_trade === "1"

    // Even when isLiveTrade is false, reconcile any connection that has
    // open positions tracked in Redis — quickstart-restored state etc.
    const hasOpenPositions = !isLiveTrade
      ? (await client.llen(`live:positions:${connId}`).catch(() => 0)) > 0
      : false

    if (!isLiveTrade && !hasOpenPositions) {
      summary.connectionsSkipped++
      continue
    }

    // Engine-running guard: the LivePositions loop in engine-manager.ts
    // writes `last_processor_heartbeat` (epoch ms) into
    // `settings:trade_engine_state:{id}` via client.hset.
    //
    // PREVIOUS BUG: code read bare `trade_engine_state:{id}` (missing the
    // `settings:` prefix) and checked the non-existent `updated_at` field.
    // Result: engineActiveRecently was always false, so the cron ran a
    // full sync even while the in-process engine was already syncing every
    // 200 ms — continuous double-syncing of every live position.
    const engineStateKey = `settings:trade_engine_state:${connId}`
    const engineState = await client
      .hgetall(engineStateKey)
      .catch(() => ({} as Record<string, string>))
    // last_processor_heartbeat is epoch-ms (numeric string).
    // Fall back to last_live_positions_run (ISO) if the numeric field is absent.
    const heartbeatRaw = engineState?.last_processor_heartbeat
    const lastHeartbeatMs = heartbeatRaw
      ? Number(heartbeatRaw)
      : engineState?.last_live_positions_run
        ? new Date(engineState.last_live_positions_run as string).getTime()
        : 0
    const engineActiveRecently =
      Number.isFinite(lastHeartbeatMs) && Date.now() - lastHeartbeatMs < 90_000
    if (engineActiveRecently) {
      summary.connectionsSkipped++
      continue
    }

    summary.connectionsChecked++

    try {
      const connector = await exchangeConnectorFactory.getOrCreateConnector(connId)
      if (!connector) {
        summary.connectionsSkipped++
        continue
      }

      // 1. Orphan adoption + externally-closed detection.
      try {
        await syncWithExchange(connId, connector)
      } catch (syncErr) {
        summary.errors++
        console.warn(
          `[SyncLivePositions] ${connId} sync (orphan adoption) error:`,
          syncErr instanceof Error ? syncErr.message : String(syncErr),
        )
      }

      // 2. Full per-position reconcile.
      const result = await reconcileLivePositions(connId, connector)
      summary.positionsReconciled += result.reconciled
      summary.positionsClosed     += result.closed
      summary.positionsUpdated    += result.updated
      summary.protectionRearmed   += result.protectionRearmed
      summary.orphansSwept        += result.orphansSwept
      summary.errors              += result.errors
    } catch (connErr) {
      summary.errors++
      console.warn(
        `[SyncLivePositions] ${connId} sync error:`,
        connErr instanceof Error ? connErr.message : String(connErr),
      )
    }
  }

  return summary
}

export async function GET(request: Request) {
  const auth = authorizeCronRequest(request)
  if (!auth.ok) return cronAuthorizationResponse(auth)

  const started = Date.now()
  await initRedis()
  const client = getRedisClient()

  // Refresh timings cache once at entry so this invocation sees the
  // latest cron_sync_interval_seconds without having to wait for the
  // 10s cache TTL.
  await refreshEngineTimings({ force: true }).catch(() => {})

  const timings = getEngineTimings()
  // Clamp again defensively — UI already clamps but a hand-edited HSET
  // could bypass that path.
  const cadenceBounds = ENGINE_TIMING_BOUNDS.cronSyncIntervalSeconds
  const intervalSec = Math.max(
    cadenceBounds.min,
    Math.min(cadenceBounds.max, timings.cronSyncIntervalSeconds || 15),
  )
  const intervalMs = intervalSec * 1000

  // Atomic acquire — overlap guard. TTL slightly > maxDuration so a
  // crashed invocation cannot permanently block subsequent runs.
  const acquired = await client.set(LOCK_KEY, String(started), {
    NX: true,
    EX: LOCK_TTL_SECONDS,
  })
  if (!acquired) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "another_invocation_in_progress",
      ms: Date.now() - started,
    })
  }

  const total = newSummary()
  let sweepCount = 0

  try {
    // Budget: stop new sweeps once we are within 5 s of maxDuration so
    // the in-flight sweep has time to finish and the lock to release
    // cleanly before Vercel kills the function.
    // maxDuration is 60 s, headroom 5 s → wall budget 55 s.
    const WALL_BUDGET_MS = 55_000
    const deadline = started + WALL_BUDGET_MS

    while (Date.now() < deadline) {
      const sweepStarted = Date.now()
      const result = await runLivePositionRecoverySweep().catch((err) => {
        console.warn("[SyncLivePositions] sweep failed:", err)
        const errSummary = newSummary()
        errSummary.errors = 1
        return errSummary
      })
      mergeSummary(total, result)
      sweepCount++

      const sweepElapsed = Date.now() - sweepStarted
      const sleepFor = Math.max(0, intervalMs - sweepElapsed)
      const nextSweepStartsAt = Date.now() + sleepFor

      // If the next sweep would start past the deadline, exit cleanly
      // rather than busy-sleeping into the kill window.
      if (nextSweepStartsAt + 2_000 > deadline) break

      // Extend the lock so it never expires mid-sleep.
      await client.set(LOCK_KEY, String(Date.now()), {
        XX: true,
        EX: LOCK_TTL_SECONDS,
      }).catch(() => {})

      // Sleep. Plain setTimeout — no abort signal needed because the
      // surrounding function is single-tenant (lock holder).
      await new Promise((resolve) => setTimeout(resolve, sleepFor))
    }

    await client.del(LOCK_KEY).catch(() => {})
    return NextResponse.json({
      ok: true,
      sweepCount,
      intervalSec,
      ms: Date.now() - started,
      ...total,
    })
  } catch (err) {
    console.error("[SyncLivePositions] Fatal:", err)
    await client.del(LOCK_KEY).catch(() => {})
    return NextResponse.json(
      {
        ok: false,
        sweepCount,
        intervalSec,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
        ...total,
      },
      { status: 500 },
    )
  }
}
