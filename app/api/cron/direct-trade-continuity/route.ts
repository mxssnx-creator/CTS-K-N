import { NextResponse } from "next/server"
import { getRedisClient, initRedis, withSharedPersistenceLease } from "@/lib/redis-db"
import { authorizeCronRequest, cronAuthorizationResponse } from "@/lib/cron-auth"
import {
  DIRECT_TRADE_CONNECTION_INDEX_KEY,
  directTradeKeyspace,
  normalizeDirectTradeConnectionId,
} from "@/lib/direct-trade-keyspace"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

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
      const indexedIds = await client.smembers(DIRECT_TRADE_CONNECTION_INDEX_KEY).catch(() => [])
      const legacyKeys = directTradeKeyspace()
      const [legacyStateRaw, legacyProcessorRaw, legacyHeartbeatRaw, legacyPositionsRaw] = await Promise.all([
        client.get(legacyKeys.state),
        client.get(legacyKeys.processor),
        client.get(legacyKeys.processorHeartbeat),
        client.get(legacyKeys.positions),
      ])
      const indexedScopes = [
        ...new Set(indexedIds
          .map(normalizeDirectTradeConnectionId)
          .filter((id): id is string => Boolean(id))),
      ]
      let legacyConnectionId: string | null = null
      try {
        legacyConnectionId = normalizeDirectTradeConnectionId(
          legacyStateRaw ? JSON.parse(legacyStateRaw)?.connectionId : null,
        )
      } catch {
        // A malformed legacy state remains isolated from modern scopes.
      }
      // Migration v100 deliberately retains legacy recovery evidence. Once
      // the same connection has a scoped worker, do not supervise that old
      // namespace as a second logical engine or restart the service forever
      // because of its intentionally stale heartbeat.
      const includeLegacy = Boolean(legacyStateRaw || legacyProcessorRaw)
        && (!legacyConnectionId || !indexedScopes.includes(legacyConnectionId))
      const scopes: Array<string | null> = [
        ...indexedScopes,
        ...(includeLegacy ? [null] : []),
      ]
      const scopeResults = await Promise.all(scopes.map(async (connectionId) => {
        const keys = directTradeKeyspace(connectionId)
        const [stateRaw, processorRaw, heartbeatRaw, positionsRaw] = connectionId === null
          ? [legacyStateRaw, legacyProcessorRaw, legacyHeartbeatRaw, legacyPositionsRaw]
          : await Promise.all([
              client.get(keys.state),
              client.get(keys.processor),
              client.get(keys.processorHeartbeat),
              client.get(keys.positions),
            ])
        const state = stateRaw ? JSON.parse(stateRaw) : {}
        const processor = processorRaw ? JSON.parse(processorRaw) : null
        const positions = positionsRaw ? JSON.parse(positionsRaw) : null
        const latestHeartbeat = heartbeatRaw || processor?.lastTick || null
        const lastTickMs = Date.parse(String(latestHeartbeat || ""))
        const exactNonTerminalPositions = Array.isArray(positions)
          ? positions.filter((position: any) => position?.status === "open" || position?.status === "opening").length
          : null
        const exactAccountingPending = Array.isArray(positions)
          ? positions.filter((position: any) => (
              position?.status === "closed"
              && position?.mode === "live"
              && position?.pnlAccountingComplete !== true
            )).length
          : null
        const reportedOpenPositions = Number(processor?.openPositionCount)
        const reportedOpeningPositions = Number(processor?.openingPositionCount)
        const hasManagedPositions = exactNonTerminalPositions != null
          ? exactNonTerminalPositions > 0 || Number(exactAccountingPending) > 0
          : Number.isFinite(reportedOpenPositions) || Number.isFinite(reportedOpeningPositions)
            ? Math.max(0, reportedOpenPositions || 0) + Math.max(0, reportedOpeningPositions || 0) > 0
            // Rolling-upgrade fallback only. New workers publish exact open
            // counters and a persisted positions list, so terminal history no
            // longer causes permanent, unnecessary service restarts.
            : Math.max(0, Number(processor?.positionCount) || 0) > 0
        const required = state?.enabled === true || hasManagedPositions
        const healthy = !required || (Number.isFinite(lastTickMs) && startedAt - lastTickMs < PROCESSOR_STALE_MS)
        const recoveryRequested = required && !healthy
        if (recoveryRequested) {
          // SET-NX keeps retry requests coalesced while a service manager is
          // already restarting a worker. It never changes a processor lease.
          await client.set(keys.recoveryRequest, JSON.stringify({
            connectionId,
            requestedAt: new Date(startedAt).toISOString(),
            reason: processor ? "stale-heartbeat" : "missing-heartbeat",
            source: source(request),
          }), { NX: true, EX: 120 }).catch(() => null)
        }
        return {
          connectionId,
          required,
          healthy,
          recoveryRequested,
          openPositions: exactNonTerminalPositions ?? Math.max(0, reportedOpenPositions || 0),
          accountingPending: exactAccountingPending ?? 0,
          lastTick: latestHeartbeat,
        }
      }))
      const required = scopeResults.some((entry) => entry.required)
      const healthy = scopeResults.every((entry) => entry.healthy)
      const recoveryRequested = scopeResults.some((entry) => entry.recoveryRequested)

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
        lastTick: scopeResults.map((entry) => entry.lastTick).filter(Boolean).sort().at(-1) || null,
        connections: scopeResults,
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
