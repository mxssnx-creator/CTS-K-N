import { NextResponse } from "next/server"
import { initRedis, getRedisClient, getAllConnections, withSharedPersistenceLease } from "@/lib/redis-db"
import { reconcileLivePositions, syncWithExchange } from "@/lib/trade-engine/stages/live-stage"
import { exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { authorizeCronRequest, cronAuthorizationResponse } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * CRASH-RECOVERY / ENGINE-DOWN safety net for live positions.
 *
 * Each request performs exactly one bounded recovery sweep. The portable
 * scheduler invokes it once per minute on any server platform; long-lived
 * Node/PM2/Docker deployments additionally run the in-process 15-second
 * recovery timer. Keeping sleeps out of the request avoids hosted-function
 * duration limits and makes Vercel an optional target rather than a runtime
 * dependency.
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
 *  The atomic token-owned SET-NX lock prevents two scheduler/continuity
 *  owners from running concurrent sweeps. Clean release verifies ownership.
 */

const LOCK_KEY = "cron:sync-live-positions:lock"
const LOCK_TTL_SECONDS = 65
const MINUTE_DEDUP_PREFIX = "cron:sync-live-positions:minute"
const DIAGNOSTIC_KEY = "system:coordination:live-recovery"

function requestSource(request: Request): string {
  if (request.headers.get("x-cron-source")) return String(request.headers.get("x-cron-source"))
  if (request.headers.get("x-cloudflare-cron") === "1") return "cloudflare-scheduled"
  if ((request.headers.get("user-agent") || "").includes("cts-portable-minute-scheduler")) {
    return "portable-minute-scheduler"
  }
  return "external-authorized"
}

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

  return withSharedPersistenceLease("cron:sync-live-positions", async () => {
  const started = Date.now()
  await initRedis()
  const client = getRedisClient()
  const token = `sync_${started}_${Math.random().toString(36).slice(2, 10)}`

  const minuteBucket = Math.floor(started / 60_000)
  const minuteAccepted = await client.set(
    `${MINUTE_DEDUP_PREFIX}:${minuteBucket}`,
    requestSource(request),
    { NX: true, EX: 180 },
  ).catch(() => null)
  if (minuteAccepted !== "OK") {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "live-recovery minute already completed",
      ms: Date.now() - started,
    })
  }

  const acquired = await client.set(LOCK_KEY, token, {
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

  try {
    const total = await runLivePositionRecoverySweep()
    const finishedAt = Date.now()
    await client.hset(DIAGNOSTIC_KEY, {
      interval_seconds: "60",
      last_tick_at: new Date(finishedAt).toISOString(),
      last_tick_ms: String(finishedAt),
      last_tick_duration_ms: String(finishedAt - started),
      last_tick_source: requestSource(request),
      last_tick_result: total.errors > 0 ? "degraded" : "ok",
      last_connections_checked: String(total.connectionsChecked),
      last_positions_reconciled: String(total.positionsReconciled),
      last_errors: String(total.errors),
      updated_at: new Date(finishedAt).toISOString(),
    }).catch(() => 0)
    return NextResponse.json({
      ok: true,
      sweepCount: 1,
      scheduleIntervalSec: 60,
      ms: finishedAt - started,
      ...total,
    })
  } catch (err) {
    console.error("[SyncLivePositions] Fatal:", err)
    const failedAt = Date.now()
    await client.hset(DIAGNOSTIC_KEY, {
      interval_seconds: "60",
      last_tick_at: new Date(failedAt).toISOString(),
      last_tick_ms: String(failedAt),
      last_tick_duration_ms: String(failedAt - started),
      last_tick_source: requestSource(request),
      last_tick_result: "error",
      last_error: err instanceof Error ? err.message : String(err),
      updated_at: new Date(failedAt).toISOString(),
    }).catch(() => 0)
    return NextResponse.json(
      {
        ok: false,
        sweepCount: 1,
        scheduleIntervalSec: 60,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      },
      { status: 500 },
    )
  } finally {
    const current = await client.get(LOCK_KEY).catch(() => null)
    if (current === token) await client.del(LOCK_KEY).catch(() => {})
  }
  }, { ttlMs: 75_000, waitMs: 2_000 })
}
