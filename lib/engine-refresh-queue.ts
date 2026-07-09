import { publishEngineEvent } from "./engine-event-bus"
import { getRedisClient, getSettings, setSettings } from "./redis-db"

export const ENGINE_REFRESH_REQUEST_PREFIX = "engine_coordinator:refresh_requested:"
const ENGINE_REFRESH_REQUEST_INDEX = "engine_coordinator:refresh_requested:index"

export type EngineRefreshAction = "start" | "stop" | "refresh" | "restart"

export interface EngineRefreshRequest {
  connectionId: string
  action: EngineRefreshAction | string
  state_switch_version: string | number
  reason: string
  timestamp: string
  retryCount?: number
  lastError?: string
  lastErrorAt?: string
  refresh_queued_at?: string
  refresh_last_attempt_at?: string
  refresh_last_error?: string
  refresh_processed_at?: string
}

export interface EngineRefreshQueueStatus {
  refreshQueued: true
  refresh_queued_at: string
  refresh_last_attempt_at?: string
  refresh_last_error?: string
  refresh_processed_at?: string
  retryCount: number
  immediateDrainAttempted: boolean
  immediateDrainApplied: boolean
}

export function nextStateSwitchVersion(connection: any): string {
  const current = Number(connection?.state_switch_version ?? 0)
  return String((Number.isFinite(current) ? current : 0) + 1)
}

export function currentStateSwitchVersion(connection: any): string {
  return String(connection?.state_switch_version ?? 0)
}

async function triggerImmediateEngineRefresh(request: EngineRefreshRequest): Promise<{ attempted: boolean; applied: boolean; error?: unknown }> {
  // Event-state fast path: act on the changed connection only. Running a full
  // healing sweep from every toggle was fast but too memory-heavy because it
  // loaded all eligible connections and could fan out multiple engine starts.
  // This targeted drain keeps the timer as a safety net while explicit actions
  // (enable/disable/progression/state changes) converge immediately.
  if (process.env.NEXT_RUNTIME === "edge") return { attempted: false, applied: false }

  try {
    const { getGlobalTradeEngineCoordinator } = await import("./trade-engine")
    const coordinator = getGlobalTradeEngineCoordinator()
    if (typeof coordinator.drainQueuedRefreshRequestsNow !== "function") return { attempted: false, applied: false }
    await coordinator.drainQueuedRefreshRequestsNow(request.connectionId)
    return { attempted: true, applied: true }
  } catch (error) {
    console.warn(
      `[v0] [EngineRefreshQueue] Immediate targeted refresh failed (${request.reason || request.action}):`,
      error instanceof Error ? error.message : String(error),
    )
    return { attempted: true, applied: false, error }
  }
}

export async function queueEngineRefreshRequest(request: EngineRefreshRequest): Promise<EngineRefreshQueueStatus> {
  const queuedAt = request.refresh_queued_at || request.timestamp || new Date().toISOString()
  const queuedRequest: EngineRefreshRequest = {
    ...request,
    refresh_queued_at: queuedAt,
    refresh_last_error: request.refresh_last_error || request.lastError,
    refresh_last_attempt_at: request.refresh_last_attempt_at || request.lastErrorAt,
  }
  await setSettings(`${ENGINE_REFRESH_REQUEST_PREFIX}${request.connectionId}`, queuedRequest)
  await (getRedisClient().sadd?.(`settings:${ENGINE_REFRESH_REQUEST_INDEX}`, request.connectionId) ?? Promise.resolve(0)).catch(() => 0)
  await publishEngineEvent("engine.refresh.requested", {
    connectionId: request.connectionId,
    action: String(request.action),
    stateSwitchVersion: String(request.state_switch_version),
    reason: request.reason,
    timestamp: request.timestamp,
  }).catch((error) => {
    console.warn(
      `[v0] [EngineRefreshQueue] refresh event publish failed (${request.reason || request.action}):`,
      error instanceof Error ? error.message : String(error),
    )
  })

  // The durable write above remains the correctness layer. Await the lightweight
  // immediate drain only so callers can surface whether this API process applied
  // the request locally or merely queued it for the eventual engine owner.
  const drain = await triggerImmediateEngineRefresh(queuedRequest)
  if (drain.error) {
    await recordEngineRefreshRequestFailure(queuedRequest, drain.error)
  }
  return {
    refreshQueued: true,
    refresh_queued_at: queuedAt,
    refresh_last_attempt_at: drain.attempted ? new Date().toISOString() : queuedRequest.refresh_last_attempt_at,
    refresh_last_error: drain.error ? (drain.error instanceof Error ? drain.error.message : String(drain.error)) : queuedRequest.refresh_last_error,
    refresh_processed_at: drain.applied ? new Date().toISOString() : queuedRequest.refresh_processed_at,
    retryCount: Number(queuedRequest.retryCount ?? 0) + (drain.error ? 1 : 0),
    immediateDrainAttempted: drain.attempted,
    immediateDrainApplied: drain.applied,
  }
}

export async function getQueuedEngineRefreshRequests(): Promise<Array<{ key: string; request: EngineRefreshRequest }>> {
  const client = getRedisClient()
  let connectionIds = await (client.smembers?.(`settings:${ENGINE_REFRESH_REQUEST_INDEX}`) ?? Promise.resolve([] as string[])).catch(() => [] as string[])
  if (!connectionIds || connectionIds.length === 0) {
    // Backward-compatible fallback for queues written before the index existed.
    const keys = await client.keys(`settings:${ENGINE_REFRESH_REQUEST_PREFIX}*`).catch(() => [] as string[])
    connectionIds = keys
      .filter((redisKey: string) => !redisKey.endsWith(ENGINE_REFRESH_REQUEST_INDEX))
      .map((redisKey: string) => redisKey.replace(/^settings:/, "").slice(ENGINE_REFRESH_REQUEST_PREFIX.length))
      .filter(Boolean)
  }

  const requests = await Promise.all(
    Array.from(new Set(connectionIds)).map(async (connectionId) => {
      const key = `${ENGINE_REFRESH_REQUEST_PREFIX}${connectionId}`
      const request = await getSettings(key).catch(() => null)
      return request?.connectionId && request?.timestamp ? { key, request: request as EngineRefreshRequest } : null
    }),
  )
  return requests.filter((item): item is { key: string; request: EngineRefreshRequest } => !!item)
}

export async function clearEngineRefreshRequest(connectionId: string): Promise<void> {
  const client = getRedisClient()
  await Promise.all([
    client.del(`settings:${ENGINE_REFRESH_REQUEST_PREFIX}${connectionId}`).catch(() => 0),
    (client.srem?.(`settings:${ENGINE_REFRESH_REQUEST_INDEX}`, connectionId) ?? Promise.resolve(0)).catch(() => 0),
  ])
}

export async function recordEngineRefreshRequestFailure(
  request: EngineRefreshRequest,
  error: unknown,
): Promise<void> {
  const retryCount = Number(request.retryCount ?? 0)
  const lastError = error instanceof Error ? error.message : String(error)
  await setSettings(`${ENGINE_REFRESH_REQUEST_PREFIX}${request.connectionId}`, {
    ...request,
    retryCount: Number.isFinite(retryCount) ? retryCount + 1 : 1,
    lastError,
    lastErrorAt: new Date().toISOString(),
    refresh_last_error: lastError,
    refresh_last_attempt_at: new Date().toISOString(),
  })
  await (getRedisClient().sadd?.(`settings:${ENGINE_REFRESH_REQUEST_INDEX}`, request.connectionId) ?? Promise.resolve(0)).catch(() => 0)
}
