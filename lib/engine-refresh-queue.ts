import { publishEngineEvent } from "./engine-event-bus"
import { getRedisClient, getSettings, setSettings } from "./redis-db"

export const ENGINE_REFRESH_REQUEST_PREFIX = "engine_coordinator:refresh_requested:"
const ENGINE_REFRESH_REQUEST_INDEX = "engine_coordinator:refresh_requested:index"

export const ENGINE_REFRESH_CLAIM_PREFIX = "engine_coordinator:refresh_claim:"
export const ENGINE_REFRESH_CLAIM_TTL_MS = 30_000

type QueuedEngineRefreshRequest = { key: string; request: EngineRefreshRequest }

type EngineRefreshConsumerAction = (request: EngineRefreshRequest, connection: any) => Promise<"processed" | "defer">

export interface ProcessQueuedEngineRefreshRequestsOptions {
  consumerName: string
  targetConnectionId?: string
  staleAfterMs?: number
  getConnection: (connectionId: string) => Promise<any>
  act: EngineRefreshConsumerAction
}

function refreshClaimKey(connectionId: string): string {
  return `${ENGINE_REFRESH_CLAIM_PREFIX}${connectionId}`
}

function buildRefreshClaimValue(request: EngineRefreshRequest, consumerName: string): string {
  return JSON.stringify({
    connectionId: request.connectionId,
    action: String(request.action),
    state_switch_version: String(request.state_switch_version ?? ""),
    requestTimestamp: request.timestamp,
    claimedAt: new Date().toISOString(),
    consumer: consumerName,
    claimId: `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
  })
}

async function acquireRefreshClaim(request: EngineRefreshRequest, consumerName: string): Promise<string | null> {
  const client = getRedisClient()
  const claimValue = buildRefreshClaimValue(request, consumerName)
  const result = await client
    .set(refreshClaimKey(request.connectionId), claimValue, { NX: true, PX: ENGINE_REFRESH_CLAIM_TTL_MS } as any)
    .catch(() => null)
  return result === "OK" || result === true ? claimValue : null
}

async function releaseRefreshClaim(connectionId: string, claimValue: string): Promise<void> {
  const client = getRedisClient() as any
  const key = refreshClaimKey(connectionId)
  try {
    const current = typeof client.get === "function" ? await client.get(key).catch(() => null) : null
    if (current === claimValue) await client.del(key).catch(() => 0)
  } catch {
    // The claim has a short TTL; if ownership cannot be verified, let it expire.
  }
}


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
}

export function nextStateSwitchVersion(connection: any): string {
  const current = Number(connection?.state_switch_version ?? 0)
  return String((Number.isFinite(current) ? current : 0) + 1)
}

export function currentStateSwitchVersion(connection: any): string {
  return String(connection?.state_switch_version ?? 0)
}

async function triggerImmediateEngineRefresh(request: EngineRefreshRequest): Promise<void> {
  // Event-state fast path: act on the changed connection only. Running a full
  // healing sweep from every toggle was fast but too memory-heavy because it
  // loaded all eligible connections and could fan out multiple engine starts.
  // This targeted drain keeps the timer as a safety net while explicit actions
  // (enable/disable/progression/state changes) converge immediately.
  if (process.env.NEXT_RUNTIME === "edge") return

  try {
    const { getGlobalTradeEngineCoordinator } = await import("./trade-engine")
    const coordinator = getGlobalTradeEngineCoordinator()
    await coordinator.drainQueuedRefreshRequestsNow?.(request.connectionId)
  } catch (error) {
    console.warn(
      `[v0] [EngineRefreshQueue] Immediate targeted refresh failed (${request.reason || request.action}):`,
      error instanceof Error ? error.message : String(error),
    )
  }
}

export async function queueEngineRefreshRequest(request: EngineRefreshRequest): Promise<void> {
  await setSettings(`${ENGINE_REFRESH_REQUEST_PREFIX}${request.connectionId}`, request)
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

  // Do not block API/settings/progression writes on local coordinator work.
  // In long-lived production workers this runs on the next turn; in serverless
  // the durable queued request remains for the coordinator watchdog/cron.
  void triggerImmediateEngineRefresh(request)
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
  })
  await (getRedisClient().sadd?.(`settings:${ENGINE_REFRESH_REQUEST_INDEX}`, request.connectionId) ?? Promise.resolve(0)).catch(() => 0)
}


export async function processQueuedEngineRefreshRequests(
  options: ProcessQueuedEngineRefreshRequestsOptions,
): Promise<number> {
  const staleAfterMs = options.staleAfterMs ?? 120_000
  const refreshRequests = await getQueuedEngineRefreshRequests()
  const targetedRequests = options.targetConnectionId
    ? refreshRequests.filter(({ request }) => request.connectionId === options.targetConnectionId)
    : refreshRequests

  let processed = 0

  for (const { request } of targetedRequests as QueuedEngineRefreshRequest[]) {
    const claimValue = await acquireRefreshClaim(request, options.consumerName)
    if (!claimValue) continue

    try {
      const requestTime = new Date(request.timestamp).getTime()
      if (!Number.isFinite(requestTime) || Date.now() - requestTime >= staleAfterMs) {
        console.log(`[v0] [${options.consumerName}] Dropping expired refresh request for ${request.connectionId}`)
        await clearEngineRefreshRequest(request.connectionId)
        processed++
        continue
      }

      const connection = await options.getConnection(request.connectionId)
      const currentVersion = String(connection?.state_switch_version ?? 0)
      const requestedVersion = String(request.state_switch_version ?? "")
      if (!connection || currentVersion !== requestedVersion) {
        console.log(
          `[v0] [${options.consumerName}] Ignoring stale refresh request for ${request.connectionId}: ` +
            `requested state_switch_version=${requestedVersion}, current=${currentVersion}`,
        )
        await clearEngineRefreshRequest(request.connectionId)
        processed++
        continue
      }

      console.log(
        `[v0] [${options.consumerName}] Processing queued refresh request for ${request.connectionId}: ${request.action} ` +
          `(state_switch_version=${requestedVersion}, reason=${request.reason})`,
      )

      const result = await options.act(request, connection)
      if (result === "processed") {
        await clearEngineRefreshRequest(request.connectionId)
        processed++
      }
    } catch (error) {
      console.warn(
        `[v0] [${options.consumerName}] Refresh request failed for ${request.connectionId}; ` +
          `leaving queued for retry until expiry (attempt=${Number(request.retryCount ?? 0) + 1}):`,
        error instanceof Error ? error.message : String(error),
      )
      await recordEngineRefreshRequestFailure(request, error)
    } finally {
      await releaseRefreshClaim(request.connectionId, claimValue)
    }
  }

  return processed
}
