import { EventEmitter } from "events"
import { initRedis, getSettings, setSettings, getConnection, getRedisBackend, getRedisClient } from "@/lib/redis-db"
import { publishEngineEvent } from "@/lib/engine-event-bus"

/**
 * Settings Coordinator
 * 
 * Manages the propagation of settings changes to running engines.
 * When a connection's settings are updated, this module:
 * 1. Writes a change event to Redis so engines know to reload
 * 2. Determines if the change requires an engine restart vs hot reload
 * 3. Emits an in-process event so local engines apply changes without timers
 */

// Fields that require a full engine restart when changed
const RESTART_REQUIRED_FIELDS = [
  "api_key", "api_secret", "exchange", "is_testnet",
  "api_type", "api_subtype", "progression_epoch",
  // Browser/dialog saves must not stop or restart a live engine. Symbol and
  // mode changes are handled by the hot-reload path, which invalidates symbol
  // caches, refreshes per-cycle settings, and lets progression recoordination
  // update Redis state without tearing down live trade.
]

// Settings that alter the strategy/progression graph must trigger a durable
// progression reload/recoordination signal. They should not tear down a live
// engine process unless a credential/runtime identity field also changed.
const PROGRESSION_RESTART_FIELDS = [
  "connection_settings", "strategies", "indications", "active_indications",
  "symbols", "active_symbols", "force_symbols", "symbol_count", "symbol_order",
  "is_live_trade", "is_preset_trade", "connection_method", "margin_type", "position_mode",
  "live_volume_factor", "preset_volume_factor", "volume_factor_live",
  "volume_factor_preset", "volume_step_ratio", "volume_factor",
  "leveragePercentage", "useMaximalLeverage", "maxLeverage", "useSystemCloseOnly", "use_system_close_only",
  "profitFactorMin", "baseProfitFactor", "mainProfitFactor", "realProfitFactor", "liveProfitFactor",
  "maxDrawdownTimeMainHours", "maxDrawdownTimeRealHours", "maxDrawdownTimeLiveHours",
  "stageMinPosCountBase", "stageMinPosCountMain", "stageMinPosCountReal",
  "coordination_settings", "variantTrailingEnabled", "variantBlockEnabled", "variantDcaEnabled",
  "strategyBaseTrailingEnabled", "strategyBaseTrailingVariants", "trailingMinStep",
  "axisPrevEnabled", "axisLastEnabled", "axisContEnabled", "axisPauseEnabled",
  "axisPrevMaxWindow", "axisLastMaxWindow", "axisContMaxWindow", "axisPauseMaxWindow",
  "blockVolumeRatio", "blockMaxStack", "blockPauseCountRatio", "blockActiveRealEnabled", "blockActiveLiveEnabled",
  "dcaMaxSteps", "dcaStepVolumeMultipliers", "dcaStepDistancesPct",
  "dcaTakeProfitMode", "dcaBreakevenProfitPct", "dcaCooldownSeconds",
  "minimal_step_count", "minimalStepCount", "minStep", "maxStopLossRatio", "max_stoploss_ratio",
  "prevPosWindow", "prevPosMinCount", "mainEvalPosCount", "realEvalPosCount",
  "control_orders", "control_orders_enabled", "controlOrdersEnabled",
  "system_settings",
]

// Fields that can be hot-reloaded without restart
const HOT_RELOAD_FIELDS = [
  "name", "volume_factor", "margin_type", "position_mode",
  "connection_settings", "strategies", "indications",
  "active_indications", "preset_type",
  "symbols", "active_symbols", "force_symbols", "symbol_count", "symbol_order",
  "is_enabled", "is_enabled_dashboard", "is_live_trade", "is_preset_trade", "connection_method",
  "live_volume_factor", "preset_volume_factor", "volume_factor_live",
  "volume_factor_preset", "volume_step_ratio", "leveragePercentage",
  "useMaximalLeverage", "maxLeverage", "useSystemCloseOnly", "use_system_close_only",
  "profitFactorMin", "baseProfitFactor", "mainProfitFactor", "realProfitFactor", "liveProfitFactor",
  "maxDrawdownTimeMainHours", "maxDrawdownTimeRealHours", "maxDrawdownTimeLiveHours",
  "stageMinPosCountBase", "stageMinPosCountMain", "stageMinPosCountReal",
  "coordination_settings", "variantTrailingEnabled", "variantBlockEnabled", "variantDcaEnabled",
  "strategyBaseTrailingEnabled", "strategyBaseTrailingVariants", "trailingMinStep",
  "axisPrevEnabled", "axisLastEnabled", "axisContEnabled", "axisPauseEnabled",
  "axisPrevMaxWindow", "axisLastMaxWindow", "axisContMaxWindow", "axisPauseMaxWindow",
  "blockVolumeRatio", "blockMaxStack", "blockPauseCountRatio", "blockActiveRealEnabled", "blockActiveLiveEnabled", "minimal_step_count", "minimalStepCount", "minStep", "maxStopLossRatio", "max_stoploss_ratio",
  "dcaMaxSteps", "dcaStepVolumeMultipliers", "dcaStepDistancesPct",
  "dcaTakeProfitMode", "dcaBreakevenProfitPct", "dcaCooldownSeconds",
  "prevPosWindow", "prevPosMinCount", "mainEvalPosCount", "realEvalPosCount",
  "control_orders", "control_orders_enabled", "controlOrdersEnabled",
  "system_settings",
]

export type ChangeType = "restart" | "reload" | "cosmetic"

export interface SettingsChangeEvent {
  /** Stable identity used to prevent an older engine apply from clearing a newer pending save. */
  eventId?: string
  connectionId: string
  changedFields: string[]
  changeType: ChangeType
  timestamp: string
  previousValues?: Record<string, unknown>
  newValues?: Record<string, unknown>
  supersedesEventId?: string
}

const SETTINGS_CHANGED_EVENT = "settings-changed"
const settingsCoordinatorGlobal = globalThis as typeof globalThis & {
  __settings_change_bus?: EventEmitter
}
const settingsChangeBus = settingsCoordinatorGlobal.__settings_change_bus ?? new EventEmitter()
settingsChangeBus.setMaxListeners(500)
settingsCoordinatorGlobal.__settings_change_bus = settingsChangeBus

const settingsSignalGlobal = globalThis as typeof globalThis & {
  __settings_signal_queues?: Map<string, Promise<unknown>>
  __settings_event_process_salt?: string
}
const settingsEventProcessSalt =
  settingsSignalGlobal.__settings_event_process_salt ?? Math.random().toString(36).slice(2, 10)
settingsSignalGlobal.__settings_event_process_salt = settingsEventProcessSalt
const SETTINGS_SIGNAL_LOCK_TTL_MS = 10_000
const SETTINGS_SIGNAL_LOCK_WAIT_MS = 5_000

function nextSettingsEventId(connectionId: string): string {
  return `${connectionId}:${Date.now()}:${process.pid}:${settingsEventProcessSalt}:${Math.random().toString(36).slice(2, 8)}`
}

async function runSerializedSettingsSignal<T>(connectionId: string, work: () => Promise<T>): Promise<T> {
  const queues = settingsSignalGlobal.__settings_signal_queues ?? new Map<string, Promise<unknown>>()
  settingsSignalGlobal.__settings_signal_queues = queues
  const previous = queues.get(connectionId) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(async () => {
    const client = getRedisClient()
    const useSharedLock = typeof getRedisBackend === "function" && getRedisBackend() === "redis-network"
    if (!useSharedLock) return work()

    const lockKey = `settings_change_signal_lock:${connectionId}`
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`
    const deadline = Date.now() + SETTINGS_SIGNAL_LOCK_WAIT_MS
    let acquired = false
    do {
      const result = await client.set(lockKey, token, { NX: true, PX: SETTINGS_SIGNAL_LOCK_TTL_MS })
      acquired = result === "OK" || (result as unknown) === true
      if (!acquired) await new Promise((resolve) => setTimeout(resolve, 15 + Math.floor(Math.random() * 20)))
    } while (!acquired && Date.now() < deadline)
    if (!acquired) throw new Error(`Timed out waiting for settings signal lock for ${connectionId}`)

    try {
      return await work()
    } finally {
      try {
        if (typeof client.eval === "function") {
          await client.eval(
            `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
            { keys: [lockKey], arguments: [token] },
          )
        } else {
          const currentToken = await client.get(lockKey)
          if (currentToken === token) await client.del(lockKey)
        }
      } catch {
        // The short lease is the final cleanup guard if ownership verification fails.
      }
    }
  })
  queues.set(connectionId, current)
  try {
    return await current
  } finally {
    if (queues.get(connectionId) === current) queues.delete(connectionId)
  }
}

function normalizeLegacyCounter(value: unknown): number {
  if (Array.isArray(value)) {
    const joined = value.map((part) => String(Number(part))).join("")
    const parsed = Number(joined)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const direct = Number(record.value ?? record.counter)
    if (Number.isSafeInteger(direct) && direct >= 0) return direct
    const numericKeys = Object.keys(record).filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b))
    if (numericKeys.length > 0) {
      const parsed = Number(numericKeys.map((key) => String(Number(record[key]))).join(""))
      if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed
    }
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function compactSettingsEventValues(values: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  if (!values) return undefined
  const compact: Record<string, unknown> = {}
  for (const field of [
    "settings_version",
    "updated_at",
    "state_switch_version",
    "settings_event_id",
    "symbol_selection_epoch",
  ]) {
    if (values[field] !== undefined) compact[field] = values[field]
  }
  return Object.keys(compact).length > 0 ? compact : undefined
}

export function onSettingsChanged(
  connectionId: string,
  handler: (event: SettingsChangeEvent) => void | Promise<void>,
): () => void {
  const listener = (event: SettingsChangeEvent) => {
    if (event.connectionId !== connectionId) return
    try {
      void Promise.resolve(handler(event)).catch((error) => {
        console.warn(
          `[v0] [SettingsCoordinator] In-process settings event handler failed for ${connectionId}:`,
          error instanceof Error ? error.message : String(error),
        )
      })
    } catch (error) {
      console.warn(
        `[v0] [SettingsCoordinator] In-process settings event handler failed for ${connectionId}:`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  settingsChangeBus.on(SETTINGS_CHANGED_EVENT, listener)
  return () => settingsChangeBus.off(SETTINGS_CHANGED_EVENT, listener)
}

async function clearEngineRestartFlags(connectionId: string): Promise<void> {
  try {
    const client = getRedisClient()
    if (!client) return
    await Promise.all([
      client.hdel(
        `settings:trade_engine_state:${connectionId}`,
        "restart_required",
        "restart_reason",
        "restart_requested_at",
      ).catch(() => 0),
      client.hdel(
        `trade_engine_state:${connectionId}`,
        "restart_required",
        "restart_reason",
        "restart_requested_at",
      ).catch(() => 0),
    ])
  } catch {
    /* non-critical: stale restart flags should never block a settings save */
  }
}

/**
 * Determine the type of change based on which fields were modified
 */
export function classifyChange(changedFields: string[]): ChangeType {
  const normalized = changedFields.flatMap((field) => {
    const f = String(field || "")
    return f.startsWith("connection_settings.") ? [f, f.slice("connection_settings.".length)] : [f]
  })
  if (normalized.some(f => RESTART_REQUIRED_FIELDS.includes(f))) {
    return "restart"
  }
  if (normalized.some(f => HOT_RELOAD_FIELDS.includes(f) || PROGRESSION_RESTART_FIELDS.includes(f))) {
    return "reload"
  }
  return "cosmetic"
}

/**
 * Notify the system that a connection's settings have changed.
 * Writes a change event to Redis that running engines can detect.
 */
export async function notifySettingsChanged(
  connectionId: string,
  changedFields: string[],
  previousValues?: Record<string, unknown>,
  newValues?: Record<string, unknown>
): Promise<SettingsChangeEvent> {
  await initRedis()

  // Merge rather than overwrite an unconsumed event. Two API workers can save
  // different settings close together; retaining the union guarantees the
  // owner invalidates every affected cache even when only the newest envelope
  // is observed. The connection snapshot is re-read under the signal lock so
  // a delayed notifier never republishes stale form values as authoritative.
  const event = await runSerializedSettingsSignal(connectionId, async () => {
    const pending = await getSettings(`settings_change:${connectionId}`).catch(() => null) as SettingsChangeEvent | null
    const mergedFields = Array.from(new Set([
      ...(Array.isArray(pending?.changedFields) ? pending.changedFields : []),
      ...changedFields,
    ]))
    const authoritativeConnection = await getConnection(connectionId).catch(() => null)
    const mergedEvent: SettingsChangeEvent = {
      eventId: nextSettingsEventId(connectionId),
      connectionId,
      changedFields: mergedFields,
      changeType: classifyChange(mergedFields),
      timestamp: new Date().toISOString(),
      // The engine only needs generation metadata for completion stamps. Do
      // not retain entire connection snapshots (especially credentials and
      // nested strategy trees) in every pending event.
      previousValues: compactSettingsEventValues(pending?.previousValues ?? previousValues),
      newValues: compactSettingsEventValues(authoritativeConnection || newValues || pending?.newValues),
      supersedesEventId: pending?.eventId,
    }
    await setSettings(`settings_change:${connectionId}`, mergedEvent)
    return mergedEvent
  })
  const { changeType } = event

  // Write both durable signals before the API handler returns success:
  // 1. `settings_change:{id}` is the reload/restart envelope consumed by
  //    engine-owning processes (possibly in a different worker). Keep this
  //    envelope on the settings namespace so existing consumers retain the
  //    durable structured event contract.
  // 2. `settings:dirty:{id}` is the low-latency dirty flag consumed by
  //    processor-level caches as a raw Redis string key. It is intentionally
  //    mandatory: a settings PATCH response must not report success until both
  //    signals are persisted.
  const client = getRedisClient()
  await client.set(`settings:dirty:${connectionId}`, "1", { EX: 300 })
  console.log(
    `[v0] [SettingsCoordinator] Dirty flag set for ${connectionId}: key=settings:dirty:${connectionId}, fields=[${changedFields.join(",")}]`,
  )
  
  // Increment atomically across API/engine workers. The old implementation did
  // get+set through a hash and also encoded scalar "10" as fields 0/1, causing
  // the counter to become NaN precisely at the tenth settings save.
  const counterKey = `settings:settings_change_counter:${connectionId}:value`
  const existingCounter = await client.get(counterKey).catch(() => null)
  if (existingCounter === null) {
    const legacyCounter = normalizeLegacyCounter(
      await getSettings(`settings_change_counter:${connectionId}`).catch(() => null),
    )
    await client.set(counterKey, String(legacyCounter), { NX: true })
  }
  await client.incr(counterKey)

  console.log(`[v0] [SettingsCoordinator] Change event for ${connectionId}: type=${changeType}, fields=[${changedFields.join(",")}]`)

  // If restart required, update engine state to signal restart needed
  if (changeType === "restart") {
    const engineState = await getSettings(`trade_engine_state:${connectionId}`)
    if (engineState && (engineState.status === "running" || engineState.status === "ready")) {
      const restartPatch = {
        restart_required: "1",
        restart_reason: `Settings changed: ${event.changedFields.join(", ")}`,
        restart_requested_at: new Date().toISOString(),
      }
      await Promise.all([
        client.hset(`settings:trade_engine_state:${connectionId}`, restartPatch),
        client.hset(`trade_engine_state:${connectionId}`, restartPatch),
      ])
      console.log(`[v0] [SettingsCoordinator] Engine restart flagged for ${connectionId}`)
    }
  }

  // If hot-reload, update engine state to signal reload needed without
  // clearing progression counters or stopping the global coordinator.
  if (changeType === "reload") {
    const engineState = await getSettings(`trade_engine_state:${connectionId}`)
    if (engineState && (engineState.status === "running" || engineState.status === "ready")) {
      await clearEngineRestartFlags(connectionId)
      const reloadPatch = {
        reload_required: "1",
        reload_fields: JSON.stringify(event.changedFields),
        reload_requested_at: new Date().toISOString(),
      }
      await Promise.all([
        client.hset(`settings:trade_engine_state:${connectionId}`, reloadPatch),
        client.hset(`trade_engine_state:${connectionId}`, reloadPatch),
      ])
      // Keep progression/stat counters intact on hot reload. Operators expect
      // settings-dialog saves to update the next cycle in-place; resetting the
      // canonical progression hash here made dashboard stats disappear and looked
      // like the global coordinator had stopped. Stamp only an audit timestamp.
      try {
        const client = getRedisClient()
        if (client) {
          await client.hset(`progression:${connectionId}`, {
            settings_changed_at: new Date().toISOString(),
          })
        }
      } catch { /* non-critical */ }
      console.log(`[v0] [SettingsCoordinator] Engine hot-reload flagged for ${connectionId}`)
    }
  }

  // Event-state fast path: wake the owning in-process coordinator immediately
  // for reload/progression/coordination changes instead of waiting for the
  // durable queue drain or a continuity sweep. This only targets the affected connection;
  // the durable settings_change envelope above remains the cross-worker source
  // of truth.
  try {
    const connection = await getConnection(connectionId).catch(() => null)
    const { queueEngineRefreshRequest } = await import("@/lib/engine-refresh-queue")
    await queueEngineRefreshRequest({
      connectionId,
      action: changeType === "restart" ? "restart" : "refresh",
      state_switch_version: String((connection as any)?.state_switch_version ?? 0),
      reason: `settings_${changeType}:${changedFields.slice(0, 6).join(",")}`,
      timestamp: new Date().toISOString(),
    })
  } catch (eventErr) {
    console.warn(
      `[v0] [SettingsCoordinator] Immediate event-state refresh failed for ${connectionId}:`,
      eventErr instanceof Error ? eventErr.message : String(eventErr),
    )
  }

  // Publish only after the complete durable envelope, dirty flag, counters,
  // engine flags, and targeted refresh request exist. An in-process listener
  // can react synchronously, so publishing earlier exposed half-committed
  // settings state to the owning engine.
  await publishEngineEvent("settings.changed", {
    connectionId,
    changedFields: event.changedFields,
    changeType,
    timestamp: event.timestamp,
    eventId: event.eventId,
  }).catch((error) => {
    // Redis envelope + dirty flag + refresh queue above are the durable
    // correctness path. A transient pub/sub failure must not turn an already
    // committed settings save into a misleading HTTP 500.
    console.warn(
      `[v0] [SettingsCoordinator] Event publish failed for ${connectionId}:`,
      error instanceof Error ? error.message : String(error),
    )
  })

  // Emit only after all durable state writes above have completed. The
  // in-process engine subscriber may immediately consume and clear the pending
  // settings_change envelope; emitting earlier can race with reload_required /
  // restart_required state writes and leave stale flags behind.
  settingsChangeBus.emit(SETTINGS_CHANGED_EVENT, event)

  return event
}

/**
 * Check if a connection has pending settings changes that the engine hasn't processed yet.
 */
export async function getPendingChanges(connectionId: string): Promise<SettingsChangeEvent | null> {
  await initRedis()
  const event = await getSettings(`settings_change:${connectionId}`)
  return event as SettingsChangeEvent | null
}

/**
 * Clear pending changes after the engine has processed them.
 */
export async function clearPendingChanges(
  connectionId: string,
  expectedEvent?: Pick<SettingsChangeEvent, "eventId" | "timestamp">,
): Promise<boolean> {
  await initRedis()
  return runSerializedSettingsSignal(connectionId, async () => {
    const current = await getSettings(`settings_change:${connectionId}`).catch(() => null) as SettingsChangeEvent | null
    if (!current) return true
    if (expectedEvent) {
      const matches = expectedEvent.eventId
        ? current.eventId === expectedEvent.eventId
        : current.timestamp === expectedEvent.timestamp
      if (!matches) return false
    }

    const client = getRedisClient()
    const stateFields = [
      "restart_required",
      "restart_reason",
      "restart_requested_at",
      "reload_required",
      "reload_fields",
      "reload_requested_at",
    ]
    await Promise.all([
      client.del(`settings:settings_change:${connectionId}`),
      client.hdel(`settings:trade_engine_state:${connectionId}`, ...stateFields),
      client.hdel(`trade_engine_state:${connectionId}`, ...stateFields),
    ])
    return true
  })
}

/**
 * Get the change counter for a connection (engines can poll this).
 */
export async function getChangeCounter(connectionId: string): Promise<number> {
  await initRedis()
  const client = getRedisClient()
  const counter = await client.get(`settings:settings_change_counter:${connectionId}:value`).catch(() => null)
  if (counter !== null) return normalizeLegacyCounter(counter)
  return normalizeLegacyCounter(await getSettings(`settings_change_counter:${connectionId}`))
}

/**
 * Compute which fields changed between two connection objects.
 * Handles nested fields like force_symbols within connection_settings.
 */
export function detectChangedFields(
  previous: Record<string, unknown>,
  updated: Record<string, unknown>
): string[] {
  const changed: string[] = []
  const allKeys = new Set([...Object.keys(previous), ...Object.keys(updated)])
  
  for (const key of allKeys) {
    if (key === "updated_at" || key === "created_at") continue
    const prevVal = JSON.stringify(previous[key])
    const newVal = JSON.stringify(updated[key])
    if (prevVal !== newVal) {
      changed.push(key)
    }
  }
  
  // ── Symbol count changes need special handling ──────────────────────
  // force_symbols is nested within connection_settings, so a change to it
  // won't appear in the top-level allKeys. Compare symbol counts explicitly:
  // if they differ, it's a progression-level change (not just strategy reload).
  const prevSymbols = previous.force_symbols as string[] | undefined || []
  const updatedSymbols = updated.force_symbols as string[] | undefined || []
  if ((prevSymbols || []).length !== (updatedSymbols || []).length) {
    changed.push("symbol_count")  // Mark as a distinct "symbol count changed" signal
  }
  
  return changed
}
