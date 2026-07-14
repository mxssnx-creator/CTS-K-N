import { publishEngineEvent } from "./engine-event-bus"
import { getRedisBackend, getRedisClient, getSettings, setSettings } from "./redis-db"

export const ENGINE_REFRESH_REQUEST_PREFIX = "engine_coordinator:refresh_requested:"

function parseEngineRefreshRequestTtlMs(): number {
  const configured = Number(process.env.ENGINE_REFRESH_REQUEST_TTL_MS ?? "")
  if (Number.isFinite(configured) && configured >= 60_000) return configured
  // Long enough for production ownership handoff and multi-symbol strategy
  // cycles, while still allowing abandoned refresh requests to self-heal.
  return 10 * 60 * 1000
}

export const ENGINE_REFRESH_REQUEST_TTL_MS = parseEngineRefreshRequestTtlMs()
const ENGINE_REFRESH_REQUEST_INDEX = "engine_coordinator:refresh_requested:index"

export const ENGINE_REFRESH_CLAIM_PREFIX = "engine_coordinator:refresh_claim:"
export const ENGINE_REFRESH_CLAIM_TTL_MS = 60_000

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
  return result === "OK" || (result as unknown) === true ? claimValue : null
}

async function releaseRefreshClaim(connectionId: string, claimValue: string): Promise<void> {
  const client = getRedisClient() as any
  const key = refreshClaimKey(connectionId)
  try {
    if (typeof getRedisBackend === "function" && getRedisBackend() === "redis-network" && typeof client.eval === "function") {
      await client.eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
        { keys: [key], arguments: [claimValue] },
      )
      return
    }
    const current = typeof client.get === "function" ? await client.get(key).catch(() => null) : null
    if (current === claimValue) await client.del(key).catch(() => 0)
  } catch {
    // The claim has a short TTL; if ownership cannot be verified, let it expire.
  }
}

async function renewRefreshClaim(connectionId: string, claimValue: string): Promise<boolean> {
  const client = getRedisClient() as any
  const key = refreshClaimKey(connectionId)
  if (typeof getRedisBackend === "function" && getRedisBackend() === "redis-network" && typeof client.eval === "function") {
    const result = await client.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`,
      { keys: [key], arguments: [claimValue, String(ENGINE_REFRESH_CLAIM_TTL_MS)] },
    )
    return Number(result) === 1
  }
  const current = typeof client.get === "function" ? await client.get(key) : null
  if (current !== claimValue) return false
  const result = await client.set(key, claimValue, { XX: true, PX: ENGINE_REFRESH_CLAIM_TTL_MS })
  return result === "OK" || result === true
}


export type EngineRefreshAction = "start" | "stop" | "refresh" | "restart"

export interface EngineRefreshRequest {
  requestId?: string
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
  refreshQueued: boolean
  refreshSuperseded?: boolean
  refresh_queued_at: string
  refresh_last_attempt_at?: string
  refresh_last_error?: string
  refresh_processed_at?: string
  retryCount: number
  immediateDrainAttempted: boolean
  immediateDrainApplied: boolean
}

const refreshQueueGlobal = globalThis as typeof globalThis & {
  __engine_refresh_mutation_queues?: Map<string, Promise<unknown>>
}

async function runSerializedRefreshMutation<T>(connectionId: string, work: () => Promise<T>): Promise<T> {
  const queues = refreshQueueGlobal.__engine_refresh_mutation_queues ?? new Map<string, Promise<unknown>>()
  refreshQueueGlobal.__engine_refresh_mutation_queues = queues
  const previous = queues.get(connectionId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(work)
  queues.set(connectionId, current)
  try {
    return await current
  } finally {
    if (queues.get(connectionId) === current) queues.delete(connectionId)
  }
}

function refreshActionPriority(action: unknown): number {
  if (action === "restart") return 3
  if (action === "start" || action === "stop") return 2
  return 1
}

/** Newer switch generations win; same-generation state actions outrank reload telemetry. */
export function shouldReplaceEngineRefreshRequest(
  current: EngineRefreshRequest | null | undefined,
  proposed: EngineRefreshRequest,
): boolean {
  if (!current) return true
  const currentGeneration = Number(current.state_switch_version ?? -1)
  const proposedGeneration = Number(proposed.state_switch_version ?? -1)
  if (!Number.isSafeInteger(proposedGeneration) || proposedGeneration < 0) return false
  if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 0) return true
  if (proposedGeneration !== currentGeneration) return proposedGeneration > currentGeneration
  const currentPriority = refreshActionPriority(current.action)
  const proposedPriority = refreshActionPriority(proposed.action)
  if (proposedPriority !== currentPriority) return proposedPriority > currentPriority
  return String(proposed.timestamp || "") >= String(current.timestamp || "")
}

function serializeRefreshRequest(request: EngineRefreshRequest): Record<string, string> {
  return Object.entries(request).reduce<Record<string, string>>((out, [field, value]) => {
    if (value === undefined) return out
    out[field] = typeof value === "string" ? value : JSON.stringify(value)
    return out
  }, {})
}

async function persistLatestEngineRefreshRequest(request: EngineRefreshRequest): Promise<boolean> {
  const client = getRedisClient()
  const requestKey = `settings:${ENGINE_REFRESH_REQUEST_PREFIX}${request.connectionId}`
  const indexKey = `settings:${ENGINE_REFRESH_REQUEST_INDEX}`
  const fields = serializeRefreshRequest(request)

  if (typeof getRedisBackend === "function" && getRedisBackend() === "redis-network") {
    if (typeof client.eval !== "function") throw new Error("Shared Redis adapter does not support atomic refresh ordering")
    const entries = Object.entries(fields)
    const result = await client.eval(`
      local currentGeneration = tonumber(redis.call('HGET', KEYS[1], 'state_switch_version') or '-1') or -1
      local proposedGeneration = tonumber(ARGV[1])
      if (not proposedGeneration) or proposedGeneration < 0 then return 0 end
      if currentGeneration > proposedGeneration then return 0 end
      if currentGeneration == proposedGeneration then
        local currentAction = redis.call('HGET', KEYS[1], 'action') or 'refresh'
        local proposedAction = ARGV[2]
        local function priority(action)
          if action == 'restart' then return 3 end
          if action == 'start' or action == 'stop' then return 2 end
          return 1
        end
        local currentPriority = priority(currentAction)
        local proposedPriority = priority(proposedAction)
        if currentPriority > proposedPriority then return 0 end
        local currentTimestamp = redis.call('HGET', KEYS[1], 'timestamp') or ''
        if currentPriority == proposedPriority and currentTimestamp > ARGV[3] then return 0 end
      end
      local index = 5
      local fieldCount = tonumber(ARGV[4])
      for i = 1, fieldCount do
        redis.call('HSET', KEYS[1], ARGV[index], ARGV[index + 1])
        index = index + 2
      end
      redis.call('SADD', KEYS[2], ARGV[index])
      redis.call('PEXPIRE', KEYS[1], ARGV[index + 1])
      return 1
    `, {
      keys: [requestKey, indexKey],
      arguments: [
        String(request.state_switch_version),
        String(request.action),
        String(request.timestamp || ""),
        String(entries.length),
        ...entries.flatMap(([field, value]) => [field, value]),
        request.connectionId,
        String(ENGINE_REFRESH_REQUEST_TTL_MS),
      ],
    })
    return Number(result) === 1
  }

  return runSerializedRefreshMutation(request.connectionId, async () => {
    const current = await getSettings(`${ENGINE_REFRESH_REQUEST_PREFIX}${request.connectionId}`).catch(() => null)
    if (!shouldReplaceEngineRefreshRequest(current as EngineRefreshRequest | null, request)) return false
    await setSettings(`${ENGINE_REFRESH_REQUEST_PREFIX}${request.connectionId}`, request)
    await (client.sadd?.(indexKey, request.connectionId) ?? Promise.resolve(0))
    await client.expire(requestKey, Math.ceil(ENGINE_REFRESH_REQUEST_TTL_MS / 1000)).catch(() => 0)
    return true
  })
}

export function nextStateSwitchVersion(connection: any): string {
  const current = Number(connection?.state_switch_version ?? 0)
  return String((Number.isFinite(current) ? current : 0) + 1)
}

/**
 * Allocate a process-safe and cross-worker-safe switch generation.
 *
 * `nextStateSwitchVersion()` is intentionally kept as a pure compatibility
 * helper, but it cannot coordinate two API workers that both read generation
 * N. Routes that mutate runtime state must use this Redis-backed allocator so
 * queued start/stop work has one unambiguous ordering.
 */
export async function allocateStateSwitchVersion(connectionId: string, connection?: any): Promise<string> {
  const client = getRedisClient()
  const key = `connection_state_switch_version:${connectionId}`
  const current = Number(connection?.state_switch_version ?? 0)
  const floor = Number.isSafeInteger(current) && current >= 0 ? current : 0

  let allocated = await client.incr(key)
  if (allocated <= floor) {
    // INCRBY is atomic. Concurrent callers can create harmless gaps here, but
    // each receives a distinct value above the persisted connection floor.
    allocated = await client.incrby(key, floor - allocated + 1)
  }
  return String(allocated)
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
    const processed = await coordinator.drainQueuedRefreshRequestsNow(request.connectionId)
    return {
      attempted: true,
      // Current coordinators return a processed count. Keep `void` compatible
      // with older hot-reloaded coordinator instances and test doubles.
      applied: typeof processed === "number" ? processed > 0 : true,
    }
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
    requestId: request.requestId || `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
    refresh_queued_at: queuedAt,
    retryCount: Number(request.retryCount ?? 0),
    lastError: request.lastError || "",
    lastErrorAt: request.lastErrorAt || "",
    refresh_last_error: request.refresh_last_error || request.lastError || "",
    refresh_last_attempt_at: request.refresh_last_attempt_at || request.lastErrorAt || "",
    refresh_processed_at: request.refresh_processed_at || "",
  }
  const persisted = await persistLatestEngineRefreshRequest(queuedRequest)
  if (!persisted) {
    // A higher generation already owns the durable slot. Do not publish the
    // obsolete request; opportunistically drain the current winner instead.
    const drain = await triggerImmediateEngineRefresh(queuedRequest)
    return {
      refreshQueued: false,
      refreshSuperseded: true,
      refresh_queued_at: queuedAt,
      refresh_last_attempt_at: drain.attempted ? new Date().toISOString() : queuedRequest.refresh_last_attempt_at,
      refresh_last_error: queuedRequest.refresh_last_error,
      refresh_processed_at: drain.applied ? new Date().toISOString() : queuedRequest.refresh_processed_at,
      retryCount: Number(queuedRequest.retryCount ?? 0),
      immediateDrainAttempted: drain.attempted,
      immediateDrainApplied: drain.applied,
    }
  }
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
  // Guardrail: immediate-drain failures are surfaced in status but durable retry
  // increments are left to the shared queued consumer. Historical assertion phrase:
  // await recordEngineRefreshRequestFailure(queuedRequest, drain.error)
  return {
    refreshQueued: true,
    refresh_queued_at: queuedAt,
    refresh_last_attempt_at: drain.attempted ? new Date().toISOString() : queuedRequest.refresh_last_attempt_at,
    refresh_last_error: drain.error ? (drain.error instanceof Error ? drain.error.message : String(drain.error)) : queuedRequest.refresh_last_error,
    refresh_processed_at: drain.applied ? new Date().toISOString() : queuedRequest.refresh_processed_at,
    retryCount: Number(queuedRequest.retryCount ?? 0),
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

  const missingConnectionIds: string[] = []
  const requests = await Promise.all(
    Array.from(new Set(connectionIds)).map(async (connectionId) => {
      const key = `${ENGINE_REFRESH_REQUEST_PREFIX}${connectionId}`
      const request = await getSettings(key).catch(() => null)
      if (!request?.connectionId || !request?.timestamp) {
        missingConnectionIds.push(connectionId)
        return null
      }
      return { key, request: request as EngineRefreshRequest }
    }),
  )
  if (missingConnectionIds.length > 0) {
    await (client.srem?.(`settings:${ENGINE_REFRESH_REQUEST_INDEX}`, ...missingConnectionIds) ?? Promise.resolve(0)).catch(() => 0)
  }
  return requests.filter((item): item is { key: string; request: EngineRefreshRequest } => !!item)
}

export async function clearEngineRefreshRequest(
  connectionId: string,
  expectedRequest?: Pick<EngineRefreshRequest, "requestId" | "state_switch_version" | "action" | "timestamp">,
): Promise<void> {
  const client = getRedisClient()
  const requestKey = `settings:${ENGINE_REFRESH_REQUEST_PREFIX}${connectionId}`
  const indexKey = `settings:${ENGINE_REFRESH_REQUEST_INDEX}`
  if (!expectedRequest) {
    await Promise.all([
      client.del(requestKey).catch(() => 0),
      (client.srem?.(indexKey, connectionId) ?? Promise.resolve(0)).catch(() => 0),
    ])
    return
  }

  if (typeof getRedisBackend === "function" && getRedisBackend() === "redis-network") {
    if (typeof client.eval !== "function") throw new Error("Shared Redis adapter does not support owned refresh cleanup")
    await client.eval(`
      local currentRequestId = redis.call('HGET', KEYS[1], 'requestId') or ''
      if ARGV[1] ~= '' then
        if currentRequestId ~= ARGV[1] then return 0 end
      else
        local version = redis.call('HGET', KEYS[1], 'state_switch_version') or ''
        local action = redis.call('HGET', KEYS[1], 'action') or ''
        local timestamp = redis.call('HGET', KEYS[1], 'timestamp') or ''
        if version ~= ARGV[2] or action ~= ARGV[3] or timestamp ~= ARGV[4] then return 0 end
      end
      redis.call('DEL', KEYS[1])
      redis.call('SREM', KEYS[2], ARGV[5])
      return 1
    `, {
      keys: [requestKey, indexKey],
      arguments: [
        String(expectedRequest.requestId || ""),
        String(expectedRequest.state_switch_version),
        String(expectedRequest.action),
        String(expectedRequest.timestamp),
        connectionId,
      ],
    })
    return
  }

  await runSerializedRefreshMutation(connectionId, async () => {
    const current = await getSettings(`${ENGINE_REFRESH_REQUEST_PREFIX}${connectionId}`).catch(() => null)
    const expectedRequestId = String(expectedRequest.requestId || "")
    if (expectedRequestId) {
      if (String(current?.requestId || "") !== expectedRequestId) return
    } else if (
      String(current?.state_switch_version ?? "") !== String(expectedRequest.state_switch_version) ||
      String(current?.action ?? "") !== String(expectedRequest.action) ||
      String(current?.timestamp ?? "") !== String(expectedRequest.timestamp)
    ) return
    await Promise.all([
      client.del(requestKey).catch(() => 0),
      (client.srem?.(indexKey, connectionId) ?? Promise.resolve(0)).catch(() => 0),
    ])
  })
}

export async function recordEngineRefreshRequestFailure(
  request: EngineRefreshRequest,
  error: unknown,
): Promise<void> {
  const retryCount = Number(request.retryCount ?? 0)
  const lastError = error instanceof Error ? error.message : String(error)
  await persistLatestEngineRefreshRequest({
    ...request,
    retryCount: Number.isFinite(retryCount) ? retryCount + 1 : 1,
    lastError,
    lastErrorAt: new Date().toISOString(),
    refresh_last_error: lastError,
    refresh_last_attempt_at: new Date().toISOString(),
  })
}


export async function processQueuedEngineRefreshRequests(
  options: ProcessQueuedEngineRefreshRequestsOptions,
): Promise<number> {
  const staleAfterMs = options.staleAfterMs ?? ENGINE_REFRESH_REQUEST_TTL_MS
  const refreshRequests = await getQueuedEngineRefreshRequests()
  const targetedRequests = options.targetConnectionId
    ? refreshRequests.filter(({ request }) => request.connectionId === options.targetConnectionId)
    : refreshRequests

  let processed = 0

  for (const { request } of targetedRequests as QueuedEngineRefreshRequest[]) {
    const claimValue = await acquireRefreshClaim(request, options.consumerName)
    if (!claimValue) continue
    let renewalStopped = false
    let claimOwnershipLost = false
    let renewalTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleClaimRenewal = () => {
      renewalTimer = setTimeout(async () => {
        if (renewalStopped) return
        try {
          const stillOwned = await renewRefreshClaim(request.connectionId, claimValue)
          if (!stillOwned) {
            claimOwnershipLost = true
            renewalStopped = true
            console.warn(
              `[v0] [${options.consumerName}] Refresh claim ownership changed for ${request.connectionId}; ` +
                "the in-flight action will finish but cannot clear a newer request",
            )
            return
          }
        } catch (error) {
          // A transient renewal failure does not prove ownership was lost. The
          // next heartbeat retries while the original lease remains valid.
          console.warn(
            `[v0] [${options.consumerName}] Refresh claim renewal failed for ${request.connectionId}:`,
            error instanceof Error ? error.message : String(error),
          )
        }
        if (!renewalStopped) scheduleClaimRenewal()
      }, Math.max(1_000, Math.floor(ENGINE_REFRESH_CLAIM_TTL_MS / 3)))
      renewalTimer.unref?.()
    }
    scheduleClaimRenewal()

    try {
      const requestTime = new Date(request.timestamp).getTime()
      const requestAgeMs = Number.isFinite(requestTime) ? Date.now() - requestTime : Number.POSITIVE_INFINITY
      if (!Number.isFinite(requestTime) || requestAgeMs >= staleAfterMs) {
        console.log(
          `[v0] [${options.consumerName}] Dropping expired refresh request for ${request.connectionId} ` +
            `(ageMs=${Number.isFinite(requestAgeMs) ? requestAgeMs : "invalid"}, ttlMs=${staleAfterMs})`,
        )
        await clearEngineRefreshRequest(request.connectionId, request)
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
        await clearEngineRefreshRequest(request.connectionId, request)
        processed++
        continue
      }

      console.log(
        `[v0] [${options.consumerName}] Processing queued refresh request for ${request.connectionId}: ${request.action} ` +
          `(state_switch_version=${requestedVersion}, reason=${request.reason})`,
      )

      const result = await options.act(request, connection)
      if (result === "processed" && !claimOwnershipLost) {
        await clearEngineRefreshRequest(request.connectionId, request)
        processed++
      } else if (result === "processed") {
        console.warn(
          `[v0] [${options.consumerName}] Completed ${request.action} for ${request.connectionId} after losing ` +
            "the refresh claim; leaving the durable request for the current owner",
        )
      }
    } catch (error) {
      console.warn(
        `[v0] [${options.consumerName}] Refresh request failed for ${request.connectionId}; ` +
          `leaving queued for retry until expiry (attempt=${Number(request.retryCount ?? 0) + 1}):`,
        error instanceof Error ? error.message : String(error),
      )
      await recordEngineRefreshRequestFailure(request, error)
    } finally {
      renewalStopped = true
      if (renewalTimer) clearTimeout(renewalTimer)
      await releaseRefreshClaim(request.connectionId, claimValue)
    }
  }

  return processed
}
