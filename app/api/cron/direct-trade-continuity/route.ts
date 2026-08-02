import { NextResponse } from "next/server"
import { getRedisClient, initRedis, withSharedPersistenceLease } from "@/lib/redis-db"
import { authorizeCronRequest, cronAuthorizationResponse } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

const STATE_KEY = "direct_trade:state"
const PROCESSOR_KEY = "direct_trade:processor"
const RECOVERY_REQUEST_KEY = "direct_trade:processor:recovery-request"
const LOCK_KEY = "cron:direct-trade-continuity:lock"
const MINUTE_DEDUP_PREFIX = "cron:direct-trade-continuity:minute"
const DIAGNOSTIC_KEY = "system:coordination:direct-trade-continuity"
const PROCESSOR_STALE_MS = 7_000

function source(request: Request): string {
  if (request.headers.get("x-cron-source")) return String(request.headers.get("x-cron-source"))
  if ((request.headers.get("user-agent") || "").includes("cts-portable-minute-scheduler")) {
    return "portable-minute-scheduler"
  }
  return "external-authorized"
}

/**
 * Minute-level Direct-Trade liveness gate.
 *
 * The route deliberately does not acquire a processor lease and cannot create
 * or close orders. It only records a deduplicated recovery request when the
 * leased worker is stale. The host supervisor consumes that signal by
 * restarting the worker under systemd/PM2; the restarted worker restores the
 * durable position stage and waits for the former six-second lease to expire.
 */
export async function GET(request: Request) {
  const auth = authorizeCronRequest(request)
  if (!auth.ok) return cronAuthorizationResponse(auth)

  return withSharedPersistenceLease("cron:direct-trade-continuity", async () => {
    const startedAt = Date.now()
    const minuteBucket = Math.floor(startedAt / 60_000)
    await initRedis()
    const client = getRedisClient()
    const minuteKey = `${MINUTE_DEDUP_PREFIX}:${minuteBucket}`
    const accepted = await client.set(minuteKey, source(request), { NX: true, EX: 180 }).catch(() => null)
    if (accepted !== "OK") {
      return NextResponse.json({ success: true, skipped: true, reason: "direct-trade continuity minute already completed" })
    }

    const token = `direct_continuity_${startedAt}_${Math.random().toString(36).slice(2, 10)}`
    const locked = await client.set(LOCK_KEY, token, { NX: true, EX: 55 }).catch(() => null)
    if (locked !== "OK") {
      return NextResponse.json({ success: true, skipped: true, reason: "direct-trade continuity tick already running" })
    }

    try {
      const [stateRaw, processorRaw] = await Promise.all([
        client.get(STATE_KEY),
        client.get(PROCESSOR_KEY),
      ])
      const state = stateRaw ? JSON.parse(stateRaw) : {}
      const processor = processorRaw ? JSON.parse(processorRaw) : null
      const lastTickMs = Date.parse(String(processor?.lastTick || ""))
      const hasOpenPositions = Math.max(0, Number(processor?.positionCount) || 0) > 0
      const required = state?.enabled === true || hasOpenPositions
      const healthy = !required || (Number.isFinite(lastTickMs) && startedAt - lastTickMs < PROCESSOR_STALE_MS)
      const recoveryRequested = required && !healthy

      if (recoveryRequested) {
        // SET-NX keeps retry requests coalesced while a service manager is
        // already restarting a worker. It never changes the processor lease.
        await client.set(RECOVERY_REQUEST_KEY, JSON.stringify({
          requestedAt: new Date(startedAt).toISOString(),
          reason: processor ? "stale-heartbeat" : "missing-heartbeat",
          source: source(request),
        }), { NX: true, EX: 120 }).catch(() => null)
      }

      const finishedAt = Date.now()
      await client.hset(DIAGNOSTIC_KEY, {
        interval_seconds: "60",
        last_tick_at: new Date(finishedAt).toISOString(),
        last_tick_ms: String(finishedAt),
        last_tick_duration_ms: String(finishedAt - startedAt),
        last_tick_source: source(request),
        processor_required: required ? "1" : "0",
        processor_healthy: healthy ? "1" : "0",
        recovery_requested: recoveryRequested ? "1" : "0",
        updated_at: new Date(finishedAt).toISOString(),
      }).catch(() => 0)

      return NextResponse.json({
        success: true,
        required,
        healthy,
        recoveryRequested,
        lastTick: processor?.lastTick || null,
        durationMs: finishedAt - startedAt,
      })
    } catch (error) {
      return NextResponse.json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }, { status: 500 })
    } finally {
      const owner = await client.get(LOCK_KEY).catch(() => null)
      if (owner === token) await client.del(LOCK_KEY).catch(() => {})
    }
  }, { ttlMs: 70_000, waitMs: 2_000 })
}

export async function POST(request: Request) {
  return GET(request)
}
