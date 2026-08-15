import { NextResponse } from "next/server"
import { getActiveConnectionsForEngine, getRedisClient, initRedis } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"
import { evaluateRealTradeReadiness } from "@/lib/real-trade-gates"
import { serveSerializedResponseSWR } from "@/lib/serialized-response-swr"
import { resolveDistributedEngineRuntime } from "@/lib/distributed-engine-runtime"

function isEnabledFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}


function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function parseSymbols(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0)
  }
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parseSymbols(parsed)
    } catch {
      return value.split(",").map((item) => item.trim()).filter(Boolean)
    }
  }
  return []
}

type StatusAllGlobal = typeof globalThis & {
  __status_all_connections_snapshot?: { at: number; value: any[] }
  __status_all_connections_inflight?: Promise<any[]> | null
  __status_all_engine_symbols?: Map<string, { at: number; value: string[] }>
}

const statusAllGlobal = globalThis as StatusAllGlobal
const ACTIVE_CONNECTION_FRESH_MS = 5_000
const ACTIVE_CONNECTION_STALE_FALLBACK_MS = 120_000
const ENGINE_SYMBOL_STALE_FALLBACK_MS = 120_000
const ENGINE_SYMBOL_SNAPSHOT_LIMIT = 128

function rememberCompleteEngineSymbols(connectionId: string, symbols: string[]): string[] {
  const normalized = [...symbols]
  const snapshots = statusAllGlobal.__status_all_engine_symbols || new Map()
  statusAllGlobal.__status_all_engine_symbols = snapshots
  snapshots.set(connectionId, { at: Date.now(), value: normalized })
  while (snapshots.size > ENGINE_SYMBOL_SNAPSHOT_LIMIT) {
    const oldest = snapshots.keys().next().value
    if (!oldest) break
    snapshots.delete(oldest)
  }
  return normalized
}

function recoverCompleteEngineSymbols(connectionId: string): string[] {
  const cached = statusAllGlobal.__status_all_engine_symbols?.get(connectionId)
  if (!cached || Date.now() - cached.at >= ENGINE_SYMBOL_STALE_FALLBACK_MS) return []
  return [...cached.value]
}

async function getActiveConnectionsSnapshot(): Promise<any[]> {
  const now = Date.now()
  const cached = statusAllGlobal.__status_all_connections_snapshot
  if (cached && now - cached.at < ACTIVE_CONNECTION_FRESH_MS) return cached.value

  if (!statusAllGlobal.__status_all_connections_inflight) {
    const pending = getActiveConnectionsForEngine()
      .then((connections) => {
        if (!Array.isArray(connections)) throw new Error("Invalid active connection snapshot")
        statusAllGlobal.__status_all_connections_snapshot = { at: Date.now(), value: connections }
        return connections
      })
      .finally(() => {
        if (statusAllGlobal.__status_all_connections_inflight === pending) {
          statusAllGlobal.__status_all_connections_inflight = null
        }
      })
    statusAllGlobal.__status_all_connections_inflight = pending
  }

  const resolved = await withTimeout<any[] | null>(
    statusAllGlobal.__status_all_connections_inflight,
    10_000,
    null,
  )
  if (Array.isArray(resolved)) return resolved

  const fallback = statusAllGlobal.__status_all_connections_snapshot
  if (fallback && Date.now() - fallback.at < ACTIVE_CONNECTION_STALE_FALLBACK_MS) {
    console.warn("[v0] Active connection read timed out; serving the last complete status snapshot")
    return fallback.value
  }
  throw new Error("Active connection read timed out without a complete fallback snapshot")
}

async function stripConsumedRuntimeFlags(
  client: ReturnType<typeof getRedisClient>,
  connectionId: string,
  status: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const pending = (await withTimeout(
    client.hgetall(`settings:settings_change:${connectionId}`).catch(() => ({} as Record<string, string>)),
    750,
    {} as Record<string, string>,
  )) as Record<string, string>
  if (pending && typeof pending.connectionId === "string" && pending.connectionId.length > 0) return status

  const cleaned = { ...status }
  delete cleaned.restart_required
  delete cleaned.restart_reason
  delete cleaned.restart_requested_at
  delete cleaned.reload_required
  delete cleaned.reload_fields
  delete cleaned.reload_requested_at

  await withTimeout(Promise.all([
    client
      .hdel(
        `settings:trade_engine_state:${connectionId}`,
        "restart_required",
        "restart_reason",
        "restart_requested_at",
        "reload_required",
        "reload_fields",
        "reload_requested_at",
      )
      .catch(() => 0),
    client
      .hdel(
        `trade_engine_state:${connectionId}`,
        "restart_required",
        "restart_reason",
        "restart_requested_at",
        "reload_required",
        "reload_fields",
        "reload_requested_at",
      )
      .catch(() => 0),
  ]), 750, [0, 0])

  return cleaned
}

export const dynamic = "force-dynamic"
async function buildStatusAllResponse() {
  try {
    console.log("[v0] Fetching all trade engine statuses")
    await initRedis()
    const client = getRedisClient()
    const globalState = await withTimeout(
      client.hgetall("trade_engine:global").catch(() => ({} as Record<string, string>)),
      1000,
      {} as Record<string, string>,
    )
    // A historic->realtime handoff can temporarily saturate the development
    // event loop. Never turn that read delay into a successful `0/0 engines`
    // response: reuse one complete, bounded snapshot while the deduplicated
    // Redis refresh finishes in the background.
    const connections = await getActiveConnectionsSnapshot()
    
    // Ensure connections is an array
    if (!Array.isArray(connections)) {
      console.error("[v0] Connections is not an array:", typeof connections)
      return NextResponse.json({
        success: false,
        error: "Invalid connections data",
        engines: [],
        summary: { total: 0, running: 0, stopped: 0 },
        timestamp: new Date().toISOString(),
      }, { status: 500 })
    }

    const activeConnections = connections.filter((c) => {
      const assigned =
        isEnabledFlag(c.is_assigned) ||
        isEnabledFlag(c.is_active_inserted) ||
        isEnabledFlag(c.is_dashboard_inserted)
      return assigned && isEnabledFlag(c.is_enabled_dashboard)
    })

    const engineStatuses = await Promise.all(
      activeConnections.map(async (conn) => {
        try {
          const [runtimeState, settingsState, runningHint, progression] = await Promise.all([
            withTimeout(
              client.hgetall(`trade_engine_state:${conn.id}`).catch(() => ({} as Record<string, string>)),
              750,
              {} as Record<string, string>,
            ),
            withTimeout(
              client.hgetall(`settings:trade_engine_state:${conn.id}`).catch(() => ({} as Record<string, string>)),
              750,
              {} as Record<string, string>,
            ),
            withTimeout(client.get(`engine_is_running:${conn.id}`).catch(() => null), 750, null),
            withTimeout(
              client.hgetall(`progression:${conn.id}`).catch(() => ({} as Record<string, string>)),
              750,
              {} as Record<string, string>,
            ),
          ])
          const liveOrderReadiness = evaluateRealTradeReadiness(conn, "main")
          const orderMetrics = {
            attempted: Number(progression.live_orders_attempted_count || 0),
            placed: Number(progression.live_orders_placed_count || 0),
            filled: Number(progression.live_orders_filled_count || 0),
            failed: Number(progression.live_orders_failed_count || 0),
            simulated: Number(progression.live_orders_simulated_count || 0),
            openPositionsCreated: Number(progression.live_positions_created_count || 0),
            openPositionsClosed: Number(progression.live_positions_closed_count || 0),
            volumeUsd: Number(progression.live_volume_usd_total || 0),
          }
          // Read-only Next route contexts must not import the complete engine
          // graph. Process-independent Redis state remains authoritative across
          // route bundles and worker processes.
          const redisStatus = {
            ...settingsState,
            ...runtimeState,
          }
          const runtime = resolveDistributedEngineRuntime({
            runningHint,
            states: [runtimeState, settingsState],
            globalState,
            connectionEnabled: true,
            heartbeatFreshMs: 120_000,
          })
          const isRunning = runtime.running
          const configuredSymbols = parseSymbols(conn.force_symbols || conn.active_symbols || conn.symbols)
          const runtimeSymbols = parseSymbols(
            runtimeState.force_symbols || runtimeState.active_symbols || runtimeState.symbols,
          )
          const settingsSymbols = parseSymbols(
            settingsState.force_symbols || settingsState.active_symbols || settingsState.symbols,
          )
          const resolvedSymbols =
            configuredSymbols.length > 0 ? configuredSymbols :
              runtimeSymbols.length > 0 ? runtimeSymbols :
                settingsSymbols
          // Redis can briefly exceed the per-read timeout while the final
          // Historic symbol publishes its multi-million-row result. Returning
          // `{running:true,symbols:[]}` for that one poll breaks UI ownership
          // and makes an otherwise complete Historic→Realtime hand-off look as
          // if the engine dropped its basket. Retain only a previously complete
          // bounded snapshot; it expires quickly and never invents symbols.
          const effectiveSymbols = resolvedSymbols.length > 0
            ? rememberCompleteEngineSymbols(conn.id, resolvedSymbols)
            : isRunning
              ? recoverCompleteEngineSymbols(conn.id)
              : []
          if (resolvedSymbols.length === 0 && effectiveSymbols.length > 0) {
            console.warn(`[v0] Engine symbol read timed out for ${conn.id}; serving the last complete status snapshot`)
          }
          const rawEngineStatus = {
            ...redisStatus,
            status: runtime.status || (isRunning ? "running" : "stopped"),
            runtime_reason: runtime.reason,
            heartbeat_fresh: runtime.heartbeatFresh,
            heartbeat_age_ms: runtime.heartbeatAgeMs,
            ...(effectiveSymbols.length > 0
              ? {
                  symbols: effectiveSymbols,
                  active_symbols: effectiveSymbols,
                  symbol_count: effectiveSymbols.length,
                }
              : {}),
          }
          const engineStatus = await stripConsumedRuntimeFlags(client, conn.id, rawEngineStatus)

          return {
            connectionId: conn.id,
            connectionName: conn.name,
            exchange: conn.exchange,
            assigned: isEnabledFlag(conn.is_active_inserted) || isEnabledFlag(conn.is_assigned) || isEnabledFlag(conn.is_dashboard_inserted),
            processingEnabled: isEnabledFlag(conn.is_enabled_dashboard),
            isEnabled: isEnabledFlag(conn.is_enabled_dashboard),
            isActive: isEnabledFlag(conn.is_active_inserted) || isEnabledFlag(conn.is_assigned) || isEnabledFlag(conn.is_dashboard_inserted),
            isLiveTrading: isEnabledFlag(conn.is_live_trade),
            liveOrderReadiness: {
              intent: liveOrderReadiness.intent,
              requested: liveOrderReadiness.requested,
              enabled: liveOrderReadiness.enabled,
              credentialsValid: liveOrderReadiness.credentialsValid,
              durableCoordinationReady: liveOrderReadiness.durableCoordinationReady,
              canPlaceRealOrders: liveOrderReadiness.canPlaceRealOrders,
              executionMode: liveOrderReadiness.executionMode,
              blockCode: liveOrderReadiness.blockCode,
              blockReason: liveOrderReadiness.blockReason,
            },
            orderMetrics,
            isEngineRunning: isRunning,
            engineStatus,
          }
        } catch (error) {
          console.error(`[v0] Failed to get status for ${conn.id}:`, error)
          return {
            connectionId: conn.id,
            connectionName: conn.name,
            exchange: conn.exchange,
            assigned: isEnabledFlag(conn.is_active_inserted) || isEnabledFlag(conn.is_assigned) || isEnabledFlag(conn.is_dashboard_inserted),
            processingEnabled: isEnabledFlag(conn.is_enabled_dashboard),
            isEnabled: isEnabledFlag(conn.is_enabled_dashboard),
            isActive: isEnabledFlag(conn.is_active_inserted) || isEnabledFlag(conn.is_assigned) || isEnabledFlag(conn.is_dashboard_inserted),
            isLiveTrading: isEnabledFlag(conn.is_live_trade),
            isEngineRunning: false,
            error: error instanceof Error ? error.message : "Unknown error",
          }
        }
      })
    )

    const runningCount = engineStatuses.filter((s) => s.isEngineRunning).length
    const totalCount = engineStatuses.length

    console.log(`[v0] Engine status: ${runningCount}/${totalCount} running`)

    return NextResponse.json({
      success: true,
      engines: engineStatuses,
      summary: {
        total: totalCount,
        running: runningCount,
        stopped: totalCount - runningCount,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] Failed to fetch engine statuses:", error)
    await SystemLogger.logError(error, "trade-engine", "GET /api/trade-engine/status-all")

    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch engine statuses",
        details: error instanceof Error ? error.message : String(error),
        engines: [],
        summary: { total: 0, running: 0, stopped: 0 },
      },
      { status: 500 }
    )
  }
}

export async function GET() {
  if (process.env.NODE_ENV === "test") return buildStatusAllResponse()
  return serveSerializedResponseSWR({
    namespace: "trade-engine-status-all",
    key: "global",
    freshMs: 3_000,
    maxStaleMs: 20_000,
    producer: buildStatusAllResponse,
  })
}
