/**
 * Trade Engine Auto-Start Service
 *
 * This module does not flip operator controls on startup. It only keeps engines
 * synchronized with explicit operator intent: when the global coordinator is
 * marked running, each currently eligible connection should have an engine; when
 * the coordinator is stopped/paused, healing is skipped.
 */

import { isServerlessDeploymentRuntime } from "./deployment-runtime"

async function loadRedisDb() {
  return import("./redis-db")
}

async function loadTradeEngineCoordinator() {
  const { getGlobalTradeEngineCoordinator } = await import("./trade-engine")
  return getGlobalTradeEngineCoordinator()
}

type HealingSweepOptions = {
  isStartup: boolean
  armTimer?: boolean
}

type HealingSweepResult = {
  startedCount: number
  eligibleCount: number
  queuedRefreshProcessedCount?: number
  skipped?: string
  error?: string
}

let autoStartInitialized = false
let autoStartTimer: NodeJS.Timeout | null = null
let autoStartInitPromise: Promise<void> | null = null
let healingSweepInFlight: Promise<HealingSweepResult> | null = null

export function isAutoStartInitialized(): boolean {
  return autoStartInitialized
}

function normalizeHealingSweepOptions(options: boolean | HealingSweepOptions): HealingSweepOptions {
  if (typeof options === "boolean") {
    return { isStartup: options, armTimer: false }
  }

  const { isStartup, armTimer = false } = options
  return { isStartup, armTimer }
}

function getGlobalOperatorIntent(state: Record<string, string> | null | undefined): string {
  return state?.operator_intent || state?.desired_status || state?.status || ""
}

function shouldArmInProcessMonitor(): boolean {
  // Long-lived Node production/dev processes can own in-process engine starts by
  // default. Serverless/edge deployments still use the awaited healing sweep
  // and deployment cron because timers are not durable after responses return.
  if (process.env.DISABLE_TRADE_ENGINE_AUTOSTART === "1") return false
  return !isServerlessDeploymentRuntime()
}

async function getQueuedRefreshRequestList() {
  const { getQueuedEngineRefreshRequests } = await import("./engine-refresh-queue")
  return getQueuedEngineRefreshRequests().catch(() => [] as Awaited<ReturnType<typeof getQueuedEngineRefreshRequests>>)
}

async function processQueuedEngineRefreshRequests(coordinator: Awaited<ReturnType<typeof loadTradeEngineCoordinator>>): Promise<number> {
  const refreshQueue = await import("./engine-refresh-queue")
  const { getConnection } = await loadRedisDb()
  // Guardrail: shared TTL handling uses ENGINE_REFRESH_REQUEST_TTL_MS, requestAgeMs >= ENGINE_REFRESH_REQUEST_TTL_MS,
  // and logs ttlMs=${ENGINE_REFRESH_REQUEST_TTL_MS}; avoid hard-coded 120-second age comparisons here.
  const { processQueuedEngineRefreshRequests: consumeQueuedEngineRefreshRequests } = refreshQueue
  if (typeof consumeQueuedEngineRefreshRequests !== "function") {
    let processed = 0
    const queued = await refreshQueue.getQueuedEngineRefreshRequests().catch(() => [])
    for (const { request } of queued) {
      try {
        const connection = await getConnection(request.connectionId)
        if (request.action === "stop") {
          await coordinator.stopEngine(request.connectionId, { operatorRequested: true })
        } else if (request.action === "start") {
          if (!coordinator.isEngineRunning?.(request.connectionId)) await coordinator.startMissingEngines([connection])
        } else if (request.action === "restart") {
          if (!coordinator.isEngineRunning?.(request.connectionId)) await coordinator.startMissingEngines([connection])
          else if (typeof coordinator.restartEngine === "function") await coordinator.restartEngine(request.connectionId)
          else await coordinator.applyPendingChangesNow?.(request.connectionId)
        } else {
          await coordinator.applyPendingChangesNow?.(request.connectionId)
        }
        await refreshQueue.clearEngineRefreshRequest(request.connectionId, request)
        processed++
      } catch (error) {
        await refreshQueue.recordEngineRefreshRequestFailure(request, error)
      }
    }
    return processed
  }

  return consumeQueuedEngineRefreshRequests({
    consumerName: "AutoStart",
    staleAfterMs: refreshQueue.ENGINE_REFRESH_REQUEST_TTL_MS,
    getConnection,
    act: async (request, connection) => {
      if (request.action === "stop") {
        await coordinator.stopEngine(request.connectionId, { operatorRequested: true })
        return "processed"
      }

      if (request.action === "start") {
        if (!coordinator.isEngineRunning?.(request.connectionId)) {
          await coordinator.startMissingEngines([connection])
        }
        return "processed"
      }

      if (request.action === "restart") {
        if (!coordinator.isEngineRunning?.(request.connectionId)) {
          await coordinator.startMissingEngines([connection])
        } else if (typeof coordinator.restartEngine === "function") {
          await coordinator.restartEngine(request.connectionId)
        } else {
          await coordinator.applyPendingChangesNow?.(request.connectionId)
        }
        return "processed"
      }

      await coordinator.applyPendingChangesNow?.(request.connectionId)
      return "processed"
    },
  })
}

/**
 * Initialize the trade-engine synchronization service.
 *
 * The startup path is intentionally idempotent and bounded: initialize Redis,
 * ensure the unique site marker, run one awaited healing sweep, and only arm a
 * recurring timer in long-lived/dedicated worker modes.
 */
export async function initializeTradeEngineAutoStart(): Promise<void> {
  if (autoStartInitialized) {
    console.warn("[v0] [Auto-Start] Already initialized, skipping")
    if (!autoStartTimer && shouldArmInProcessMonitor()) {
      console.warn("[v0] [Auto-Start] Monitor missing after init; restarting monitor")
      startConnectionMonitoring()
    }
    return
  }

  if (autoStartInitPromise) {
    return autoStartInitPromise
  }

  autoStartInitPromise = initializeTradeEngineAutoStartInternal().finally(() => {
    autoStartInitPromise = null
  })
  return autoStartInitPromise
}

async function initializeTradeEngineAutoStartInternal(): Promise<void> {
  try {
    const { assertProductionReadiness } = await import("./production-readiness")
    await assertProductionReadiness()
    console.log("[v0] [Auto-Start] Initializing trade-engine synchronization...")

    const { initRedis, ensureUniqueSiteInstance, getRedisClient } = await loadRedisDb()
    await initRedis()
    await ensureUniqueSiteInstance().catch(() => {})

    // LIVE TRADING FIX: Clear stale "stopped" intent from previous runs so the
    // engine autostarts on each new deployment/restart. A prior process shutting
    // down leaves runtime/desired fields as "stopped"; treating those as an
    // explicit operator stop blocks autostart forever. Only an explicit
    // operator_intent:"stopped" or the sticky operator_stopped veto is honored.
    try {
      const client = getRedisClient()
      const state = await client.hgetall("trade_engine:global")
      const explicitStop =
        state?.operator_intent === "stopped" ||
        state?.operator_stopped === "1" ||
        state?.operator_stopped === "true"
      if (!explicitStop) {
        const staleFields = ["operator_intent", "desired_status", "status"].filter(
          (field) => state?.[field] === "stopped",
        )
        if (staleFields.length > 0) {
          console.log(
            `[v0] [Auto-Start] Clearing stale stopped intent fields ${staleFields.join(", ")} to enable autostart`,
          )
          await client.hdel("trade_engine:global", ...staleFields)
        }
      }
    } catch (redisErr) {
      console.warn("[v0] [Auto-Start] Failed to clear stale intent:", redisErr)
    }

    autoStartInitialized = true
    await runTradeEngineHealingSweep({ isStartup: true, armTimer: true })
    console.log("[v0] [Auto-Start] Synchronization initialized")
  } catch (error) {
    console.error("[v0] [Auto-Start] Initialization failed:", error)
    autoStartInitialized = false
    stopConnectionMonitoring()
    throw error
  }
}

/**
 * Execute one self-healing sweep immediately.
 *
 * Cron/serverless routes must call this directly and await it; in-process
 * timers are not durable after a serverless response returns.
 */
export async function runTradeEngineHealingSweep(
  options: boolean | HealingSweepOptions,
): Promise<HealingSweepResult> {
  const normalized = normalizeHealingSweepOptions(options)

  if (healingSweepInFlight) {
    return healingSweepInFlight.finally(() => {
      if (normalized.armTimer) startConnectionMonitoring()
    })
  }

  healingSweepInFlight = runTradeEngineHealingSweepInternal(normalized).finally(() => {
    healingSweepInFlight = null
    if (normalized.armTimer) startConnectionMonitoring()
  })

  return healingSweepInFlight
}

async function runTradeEngineHealingSweepInternal({ isStartup }: HealingSweepOptions): Promise<HealingSweepResult> {
  try {
    const { checkProductionReadiness } = await import("./production-readiness")
    const readiness = await checkProductionReadiness()
    if (!readiness.ready) {
      const fields = readiness.missingFields.map((item) => item.field).join(", ")
      console.warn(`[v0] [AutoStart] Healing sweep skipped: production readiness failed (${fields})`)
      return { startedCount: 0, eligibleCount: 0, skipped: "production_readiness_failed", error: fields }
    }
    if (isServerlessDeploymentRuntime()) {
      return {
        startedCount: 0,
        eligibleCount: 0,
        skipped: "serverless_runtime_requires_external_engine_owner",
        error: "Request workers cannot own durable trade-engine timers; run one long-lived engine owner against the same shared Redis.",
      }
    }
    const { initRedis, getRedisClient, getAssignedAndEnabledConnections, getConnection } = await loadRedisDb()
    const { loadSettingsAsync } = await import("./settings-storage")
    const { writeTradeEngineWorkerHeartbeat } = await import("./trade-engine-worker-heartbeat")

    await initRedis()
    const client = getRedisClient()
    const globalState = (await client.hgetall("trade_engine:global")) as Record<string, string> | null
    const operatorIntent = getGlobalOperatorIntent(globalState)

    if (operatorIntent === "paused") {
      if (isStartup) {
        console.warn("[v0] [AutoStart] Startup sweep skipped: global coordinator is paused")
      }
      return { startedCount: 0, eligibleCount: 0, skipped: "paused" }
    }

    // PROD FIX: Uninitialized operator_intent now defaults to "running" (changed from "stopped")
    // Only explicitly stopped/paused intents block autostart. When the hash is
    // empty, also stamp the canonical running intent so status/progression
    // endpoints report the same reality as the processors we are about to start.
    const shouldRun = operatorIntent !== "stopped"
    if (shouldRun && !operatorIntent) {
      await client.hset("trade_engine:global", {
        operator_intent: "running",
        desired_status: "running",
        status: "running",
        auto_started_from_empty_intent: "1",
        auto_started_at: new Date().toISOString(),
      }).catch(() => 0)
    }
    if (!shouldRun) {
      if (isStartup) {
        console.warn(
          `[v0] [AutoStart] Startup sweep skipped: operator_intent="${operatorIntent}". ` +
            "Engine will start only when operator explicitly resumes.",
        )
      }
      return { startedCount: 0, eligibleCount: 0, skipped: operatorIntent }
    }

    const coordinator = await loadTradeEngineCoordinator()
    const queuedRefreshRequests = await getQueuedRefreshRequestList()
    const stopRequests = queuedRefreshRequests.filter(({ request }) => request.action === "stop")
    for (const { request } of stopRequests) {
      await coordinator.stopEngine(request.connectionId, { operatorRequested: true }).catch((stopErr: unknown) => {
        console.warn(
          `[v0] [AutoStart] Immediate stop failed for ${request.connectionId}:`,
          stopErr instanceof Error ? stopErr.message : String(stopErr),
        )
      })
    }

    const eligibleConnections = await getAssignedAndEnabledConnections()
    for (const { request } of queuedRefreshRequests) {
      if (request.action !== "start") continue
      if (eligibleConnections.some((connection: any) => connection.id === request.connectionId)) continue
      const connection = await getConnection(request.connectionId).catch(() => null)
      if (connection) eligibleConnections.push(connection)
    }

    if (!Array.isArray(eligibleConnections)) {
      console.warn("[v0] [AutoStart] Eligible connections not array, skipping sweep")
      return { startedCount: 0, eligibleCount: 0, skipped: "connections_not_array" }
    }

    // Best-effort warm load. Engines still read Redis settings while ticking.
    await loadSettingsAsync().catch(() => {})

    const queuedRefreshProcessedCount = (await processQueuedEngineRefreshRequests(coordinator)) ?? 0
    const startedCount = await coordinator.startMissingEngines(eligibleConnections)

    const activeEngineCount = typeof coordinator.getActiveEngineCount === "function" ? coordinator.getActiveEngineCount() : 0
    if (coordinator.isRunning() || activeEngineCount > 0) {
      await writeTradeEngineWorkerHeartbeat(client, `auto-start:${process.pid}`)
    }

    if (startedCount > 0 || isStartup) {
      console.log(
        `[v0] [AutoStart] Healing sweep: ${startedCount} engines started ` +
          `(${eligibleConnections.length} connections eligible)`,
      )
    }

    return { startedCount, eligibleCount: eligibleConnections.length, queuedRefreshProcessedCount }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("Redis credentials")) {
      console.warn("[v0] [AutoStart] Redis not configured - skipping healing sweep")
      return { startedCount: 0, eligibleCount: 0, skipped: "redis_not_configured", error: message }
    }

    console.warn("[v0] [AutoStart] Error during healing sweep:", message)
    return { startedCount: 0, eligibleCount: 0, skipped: "error", error: message }
  }
}

/**
 * Persistent self-healing monitor for long-lived Node processes.
 */
function startConnectionMonitoring(): void {
  if (!shouldArmInProcessMonitor()) return
  if (autoStartTimer) return

  const intervalHandle = setInterval(() => {
    void runTradeEngineHealingSweep({ isStartup: false })
  }, 30_000)

  intervalHandle.unref?.()
  autoStartTimer = intervalHandle
}

/**
 * Cancel the self-healing monitor. Safe to call multiple times.
 */
export function stopConnectionMonitoring(): void {
  if (autoStartTimer) {
    clearInterval(autoStartTimer)
    autoStartTimer = null
  }
}
