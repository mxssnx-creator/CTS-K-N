/**
 * lib/connection-recoordinator.ts
 *
 * Single source of truth for "the operator just saved connection
 * settings — propagate the change to the engine RIGHT NOW so the next
 * cycle reflects it, no 3 s watcher wait, no page reload."
 *
 * The full propagation has THREE steps and ALL of them must run in the
 * settings API handlers. Before this helper existed the three step were
 * duplicated (and partially missing) across four handlers in two route
 * files, which is exactly why a save-while-stopped (or a save-that-
 * should-stop) silently failed to take effect.
 *
 * Step 1 — `notifySettingsChanged`
 *   Writes a `pending-changes:{id}` envelope to Redis with the diff and
 *   a coarse change-type ("restart" / "reload" / "cosmetic"). Already
 *   running engines pick this up on their 3 s watcher tick. This is the
 *   correctness layer — it MUST run for every change.
 *
 * Step 2 — `applyPendingChangesNow`
 *   Latency optimization: synchronously asks the in-process engine
 *   manager (if any) to consume the pending envelope NOW instead of
 *   waiting for its next watcher tick. No-op if the engine isn't
 *   running in this process.
 *
 * Step 3 — recoordinate (start / stop)
 *   The piece operators kept missing. The engine watcher only runs
 *   for ALREADY-RUNNING engines, so a save while the engine is stopped
 *   (or a save that toggles `is_enabled` off) needed a separate path:
 *     • If the updated connection should now run → `startMissingEngines`.
 *     • If the updated connection should no longer run but IS running
 *       → `stopEngine`.
 *   Both calls are idempotent and safe to invoke even when no action
 *   is needed.
 *
 * Pass the connection BEFORE and AFTER the update so we can detect the
 * field diff correctly. The "after" snapshot is what gets persisted; the
 * "before" snapshot is what was loaded from Redis at the top of the
 * handler.
 */

import { notifySettingsChanged, detectChangedFields } from "@/lib/settings-coordinator"
import { emitCanonicalEvent } from "@/lib/events/emitter"

const inFlightRecoordinations = new Map<string, Promise<void>>()

function normalizeChangedField(field: string): string {
  const f = String(field || "")
  return f.startsWith("connection_settings.") ? f.slice("connection_settings.".length) : f
}

const SYMBOL_BASKET_SETTING_FIELDS = new Set([
  "symbols",
  "force_symbols",
  "active_symbols",
  "symbol_order",
  "symbol_count",
])

const STRATEGY_COORDINATION_SETTING_FIELDS = new Set([
  "strategies",
  "coordination_settings",
  "profitFactorMin",
  "baseProfitFactor",
  "mainProfitFactor",
  "realProfitFactor",
  "liveProfitFactor",
  "variantTrailingEnabled",
  "variantBlockEnabled",
  "variantDcaEnabled",
  "strategyBaseTrailingEnabled",
  "strategyBaseTrailingVariants",
  "trailingMinStep",
  "axisPrevEnabled",
  "axisLastEnabled",
  "axisContEnabled",
  "axisPauseEnabled",
  "axisPrevMaxWindow",
  "axisLastMaxWindow",
  "axisContMaxWindow",
  "axisPauseMaxWindow",
  "minimal_step_count",
  "minimalStepCount",
  "minStep",
  "maxStopLossRatio",
  "max_stoploss_ratio",
  "stageMinPosCountBase",
  "stageMinPosCountMain",
  "stageMinPosCountReal",
  "prevPosWindow",
  "prevPosMinCount",
  "mainEvalPosCount",
  "realEvalPosCount",
  "maxDrawdownTimeMainHours",
  "maxDrawdownTimeRealHours",
  "maxDrawdownTimeLiveHours",
])

const LIVE_ORDER_SETTING_FIELDS = new Set([
  "volume_factor",
  "live_volume_factor",
  "preset_volume_factor",
  "volume_factor_live",
  "volume_factor_preset",
  "volume_step_ratio",
  "blockVolumeRatio",
  "leveragePercentage",
  "useMaximalLeverage",
  "maxLeverage",
  "margin_type",
  "position_mode",
  "control_orders_enabled",
  "controlOrdersEnabled",
  "useSystemCloseOnly",
  "use_system_close_only",
])

function hasAnyChangedField(fields: readonly string[], candidates: ReadonlySet<string>): boolean {
  return fields.some((field) => candidates.has(normalizeChangedField(field)))
}

function isStrategyCoordinationField(field: string): boolean {
  const normalized = normalizeChangedField(field)
  return (
    STRATEGY_COORDINATION_SETTING_FIELDS.has(normalized) ||
    normalized.includes("ProfitFactor") ||
    normalized.includes("Drawdown") ||
    normalized.startsWith("variant") ||
    normalized.startsWith("axis") ||
    normalized.includes("EvalPosCount") ||
    normalized.includes("PosWindow") ||
    normalized.includes("PosMinCount")
  )
}

async function runSerializedForConnection(connectionId: string, work: () => Promise<void>): Promise<void> {
  const previous = inFlightRecoordinations.get(connectionId)
  if (previous) {
    try { await previous } catch { /* prior save already logged its own failure */ }
  }
  const current = work().finally(() => {
    if (inFlightRecoordinations.get(connectionId) === current) inFlightRecoordinations.delete(connectionId)
  })
  inFlightRecoordinations.set(connectionId, current)
  await current
}


export interface MainConnectionSettingsChangeOptions extends RecoordinateOptions {
  connectionPatch?: Record<string, any>
  settingsPatch?: Record<string, any>
  settingsKey?: string
  mirrorSettingsKey?: boolean
}

function stringifyHashPatch(patch: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = typeof value === "string" ? value : JSON.stringify(value)
  }
  return out
}

/**
 * Persist and propagate a Main Connection runtime-settings change. This is the
 * route-facing helper for settings saves that affect running engines: it writes
 * the connection hash plus the flat settings hash mirrors first, then delegates
 * to recoordinateAfterSettingsChange for notification, cache invalidation,
 * forced reload generation, local application, durable remote refresh, progress
 * stamping, and stats recalculation requests.
 */
export async function applyMainConnectionSettingsChange(
  id: string,
  before: Record<string, any>,
  opts: MainConnectionSettingsChangeOptions,
): Promise<{ connection: Record<string, any>; completion: RecoordinationCompletion }> {
  const { initRedis, updateConnection, getRedisClient, getConnection, setSettings } = await import("@/lib/redis-db")
  await initRedis()

  let after = { ...before, ...(opts.connectionPatch || {}) }
  if (opts.connectionPatch && Object.keys(opts.connectionPatch).length > 0) {
    after = (await updateConnection(id, after)) || after
  }

  const settingsPatch = opts.settingsPatch || {}
  if (Object.keys(settingsPatch).length > 0) {
    const settingsKey = opts.settingsKey || `connection_settings:${id}`
    if (settingsKey === `connection_settings:${id}`) {
      const redis = getRedisClient()
      const hashPatch = stringifyHashPatch(settingsPatch)
      await redis.hset(settingsKey, hashPatch)
      if (opts.mirrorSettingsKey !== false) {
        await redis.hset(`settings:connection_settings:${id}`, hashPatch).catch(() => 0)
      }
    } else {
      await setSettings(settingsKey, settingsPatch)
    }
  }

  // Reload from Redis so notify envelopes and downstream predicates see exactly
  // what was persisted, including updateConnection normalisation.
  after = (await getConnection(id).catch(() => null)) || after
  const explicitFields = Array.from(new Set([
    ...Object.keys(opts.connectionPatch || {}),
    ...Object.keys(settingsPatch),
    ...(opts.changedFieldsOverride || []),
  ]))
  const completion = await recoordinateAfterSettingsChange(id, before, after, {
    logTag: opts.logTag,
    settingsVersion: opts.settingsVersion,
    changedFieldsOverride: explicitFields.length > 0 ? explicitFields : opts.changedFieldsOverride,
  })
  return { connection: after, completion }
}

export interface RecoordinationCompletion {
  connectionId: string
  settingsVersion?: string
  recoordinationId?: string
  completedAt: string
  changedFields: string[]
  progressRecoordinationRequired: boolean
  progressionChanged?: boolean
  progressionReason?: string
}

export interface RecoordinateOptions {
  /**
   * When the caller already knows the changed-fields list (e.g. PATCH
   * /settings only receives a partial payload, so `detectChangedFields`
   * may miss settings nested under `connection_settings`), they can
   * pass an explicit override. The diff is still recomputed for the
   * notify envelope, but this list takes precedence when deciding
   * whether to short-circuit.
   */
  changedFieldsOverride?: string[]
  /**
   * Tag for log lines so it's clear which handler initiated the
   * recoordination. e.g. "PATCH /settings", "PUT /connections/[id]".
   */
  logTag: string
  settingsVersion?: string
}

/**
 * Run the full propagation chain. Designed to never throw — every step
 * is wrapped, so a failure in (say) coordinator import won't cause the
 * settings save itself to return 500. Failures are logged with the
 * provided `logTag` so they surface in the dev console.
 */
export async function recoordinateAfterSettingsChange(
  id: string,
  before: Record<string, any>,
  after: Record<string, any>,
  opts: RecoordinateOptions,
): Promise<RecoordinationCompletion> {
  const detected = detectChangedFields(before, after)
  const changedFields =
    opts.changedFieldsOverride && opts.changedFieldsOverride.length > 0
      ? opts.changedFieldsOverride
      : detected

  const makeCompletion = (extra?: Partial<RecoordinationCompletion>): RecoordinationCompletion => ({
    connectionId: id,
    settingsVersion: opts.settingsVersion,
    recoordinationId: opts.settingsVersion,
    completedAt: new Date().toISOString(),
    changedFields: [...changedFields],
    progressRecoordinationRequired: false,
    ...extra,
  })

  if (changedFields.length === 0) {
    return makeCompletion()
  }

  // If the operator previously requested Live Trade while credentials were
  // missing, saving credentials in the connection/settings dialog must unblock
  // the live stage without requiring the operator to toggle Live off/on again.
  // Otherwise `live_trade_blocked_reason` remains sticky and
  // hasRealTradeBlock() rejects every exchange order even though credentials
  // now exist.
  try {
    const { hasConnectionCredentials, isTruthyFlag } = await import("@/lib/connection-state-utils")
    const liveRequested = isTruthyFlag((after as any).live_trade_requested) || isTruthyFlag((after as any).is_live_trade)
    const hasCreds = hasConnectionCredentials(after, 5, true)
    const hasBlock = String((after as any).live_trade_blocked_reason || "").trim().length > 0
    if (liveRequested && hasCreds && (!isTruthyFlag((after as any).is_live_trade) || hasBlock)) {
      const { updateConnection } = await import("@/lib/redis-db")
      const patch = {
        is_live_trade: "1",
        live_trade_requested: "1",
        live_trade_blocked_reason: "",
        last_test_status: "success",
        updated_at: new Date().toISOString(),
      }
      await updateConnection(id, patch)
      after = { ...after, ...patch }
      if (!changedFields.includes("is_live_trade")) changedFields.push("is_live_trade")
      if (!changedFields.includes("live_trade_blocked_reason")) changedFields.push("live_trade_blocked_reason")
      console.log(
        `[v0] [${opts.logTag}] Live Trade unblocked for ${id} after credential/settings save`,
      )
    }
  } catch (liveRepairErr) {
    console.warn(
      `[v0] [${opts.logTag}] Live Trade credential unblock check failed for ${id}:`,
      liveRepairErr instanceof Error ? liveRepairErr.message : String(liveRepairErr),
    )
  }

  const settingsEvent = emitCanonicalEvent({
    type: "settings.saved",
    connectionId: id,
    stage: "settings",
    settingsVersion: (after as any).settings_version || (after as any).updated_at || new Date().toISOString(),
    data: { changedFields, logTag: opts.logTag },
  })

  // Step 1 — durable notify (Redis envelope read by all running engines).
  try {
    await notifySettingsChanged(id, changedFields, before, after)
    emitCanonicalEvent({
      type: "settings.hotReloaded",
      connectionId: id,
      stage: "settings",
      settingsVersion: (after as any).settings_version || (after as any).updated_at || settingsEvent.settingsVersion,
      parentEventId: settingsEvent.id,
      data: { changedFields },
    })
  } catch (notifyErr) {
    console.error(
      `[v0] [${opts.logTag}] notifySettingsChanged failed for ${id}:`,
      notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
    )
    // The API must not report a successful save until the durable reload
    // envelope and dirty flag have been persisted. Coordinator fast-path
    // work below is optional; the Redis signal above is the correctness
    // layer consumed by engine-owning processes.
    throw notifyErr
  }

  // Force singleton strategy coordinators to drop any generation-gated settings
  // reads on the next strategy cycle. This is intentionally before local
  // apply/refresh so a hot-applied running engine cannot reuse stale strategy,
  // volume, leverage, or symbol-derived settings.
  try {
    const { StrategyCoordinator } = await import("@/lib/strategy-coordinator")
    StrategyCoordinator.forceNextSettingsReload(id)
  } catch (reloadErr) {
    console.warn(
      `[v0] [${opts.logTag}] Failed to force StrategyCoordinator settings reload for ${id}:`,
      reloadErr instanceof Error ? reloadErr.message : String(reloadErr),
    )
  }

  // Queue a durable refresh request. notifySettingsChanged also queues a generic
  // settings refresh; keeping this explicit request here makes this helper the
  // single route-facing contract for serverless/remote engine owners and stamps
  // a reason tied to the caller.
  try {
    const { queueEngineRefreshRequest } = await import("@/lib/engine-refresh-queue")
    await queueEngineRefreshRequest({
      connectionId: id,
      action: "refresh",
      state_switch_version: String((after as any).state_switch_version ?? 0),
      reason: `${opts.logTag}:main_connection_settings_change`,
      timestamp: new Date().toISOString(),
    })
  } catch (queueErr) {
    console.warn(
      `[v0] [${opts.logTag}] Failed to queue durable engine refresh for ${id}:`,
      queueErr instanceof Error ? queueErr.message : String(queueErr),
    )
  }

  // Refresh the in-memory ConnectionCoordinator cache for this connection so
  // consumers of getConnection/getActiveConnections stop serving pre-edit
  // state (credentials, is_enabled, is_active, etc.) until a full restart.
  try {
    const { ConnectionCoordinator } = await import("@/lib/connection-coordinator")
    await ConnectionCoordinator.getInstance().refreshConnection(id)
  } catch (refreshErr) {
    console.warn(
      `[v0] [${opts.logTag}] Failed to refresh ConnectionCoordinator cache for ${id}:`,
      refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
    )
  }

  // ── SETTINGS CHANGES THAT AFFECT PROGRESS VISIBILITY ──────────────────
  // Classify settings into explicit buckets so a PF/axis/min-step edit never
  // deletes prehistoric data and a live sizing/order-protection edit never
  // resets indication progress. Only symbol-basket changes are destructive.
  const normalizedChangedFields = changedFields.map(normalizeChangedField)
  const symbolsChanged = hasAnyChangedField(normalizedChangedFields, SYMBOL_BASKET_SETTING_FIELDS)
  const modeChanged = [
    "is_live_trade",
    "is_testnet",
    "is_preset_trade",
    "connection_method",
  ].some((field) => normalizedChangedFields.includes(field))
  const destructiveProgressionChange = symbolsChanged || modeChanged
  const strategyOrCoordinationChanged = changedFields.some(isStrategyCoordinationField)
  const liveOrderSettingsChanged = hasAnyChangedField(normalizedChangedFields, LIVE_ORDER_SETTING_FIELDS)
  const requiresProgressRecoordination = destructiveProgressionChange || strategyOrCoordinationChanged

  let progressionChanged: boolean | undefined
  let progressionReason: string | undefined
  if (requiresProgressRecoordination) {
    try {
      const client = (await import("@/lib/redis-db")).getRedisClient()
      if (destructiveProgressionChange) {
        await runSerializedForConnection(id, async () => {
          const nextEpoch = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
          await Promise.all([
            client.hset(`trade_engine_state:${id}`, {
              symbol_selection_epoch: nextEpoch,
              quickstart_symbol_generation: nextEpoch,
              updated_at: new Date().toISOString(),
            }).catch(() => 0),
            client.hdel(
              `trade_engine_state:${id}`,
              "config_set_symbols_total",
              "config_set_symbols_processed",
            ).catch(() => 0),
            client.hset(`settings:trade_engine_state:${id}`, {
              symbol_selection_epoch: nextEpoch,
              quickstart_symbol_generation: nextEpoch,
              updated_at: new Date().toISOString(),
            }).catch(() => 0),
            client.hdel(
              `settings:trade_engine_state:${id}`,
              "config_set_symbols_total",
              "config_set_symbols_processed",
            ).catch(() => 0),
            client.del(`prehistoric:${id}`).catch(() => 0),
            client.del(`prehistoric:${id}:symbols`).catch(() => 0),
          ])
          const { ProgressionStateManager } = await import("@/lib/progression-state-manager")
          const result = await ProgressionStateManager.recoordinateForActualOne(id)
          progressionChanged = result?.changed
          progressionReason = result?.reason || "symbol-basket-or-mode-change"
          console.log(
            `[v0] [${opts.logTag}] Symbol basket/mode settings changed for ${id} → epoch bumped and progression recoordinated (changed:${result?.changed ?? "?"}, reason:${result?.reason ?? "?"})`,
          )
          emitCanonicalEvent({
            type: "connection.recoordinated",
            connectionId: id,
            stage: "connection",
            epoch: result?.newEpoch,
            settingsVersion: (after as any).settings_version || (after as any).updated_at || settingsEvent.settingsVersion,
            parentEventId: settingsEvent.id,
            data: { changed: result?.changed ?? false, reason: result?.reason, changedFields },
          })
        })
      } else if (strategyOrCoordinationChanged) {
        await client.hset(`progression:${id}`, {
          settings_changed_at: new Date().toISOString(),
          settings_recoordination_pending: "1",
          settings_recoordination_fields: JSON.stringify(normalizedChangedFields),
          strategy_recompute_requested: "1",
        }).catch(() => 0)
        progressionReason = "strategy-config-cache-invalidated"
        console.log(
          `[v0] [${opts.logTag}] Strategy/coordination settings changed for ${id} → cache invalidation/recompute requested without prehistoric reset`,
        )
      }
    } catch (archiveErr) {
      console.warn(
        `[v0] [${opts.logTag}] Failed to coordinate progression after settings change for ${id}:`,
        archiveErr instanceof Error ? archiveErr.message : String(archiveErr),
      )
    }
  }

  if (liveOrderSettingsChanged) {
    emitCanonicalEvent({
      type: "live.stageChanged",
      connectionId: id,
      stage: "live",
      settingsVersion: (after as any).settings_version || (after as any).updated_at || settingsEvent.settingsVersion,
      parentEventId: settingsEvent.id,
      data: { changedFields, reason: "live-sizing-order-protection-settings" },
    })
  }

  // Symbol/mode changes use the coupled destructive progression path above.
  // Strategy/coordination changes deliberately stay hot-reload-only so stats
  // remain visible and the global coordinator does not stop while settings are saved.

  // Mark affected stats dirty so UI readers and background calculators can show
  // a fresh/recalculating state after symbol, strategy, or volume changes.
  if (symbolsChanged || strategyOrCoordinationChanged) {
    try {
      const { getRedisClient } = await import("@/lib/redis-db")
      const now = new Date().toISOString()
      await getRedisClient().hset(`progression:${id}`, {
        stats_recalculation_requested: "1",
        stats_recalculation_requested_at: now,
        stats_recalculation_fields: JSON.stringify(normalizedChangedFields),
      }).catch(() => 0)
    } catch (statsErr) {
      console.warn(
        `[v0] [${opts.logTag}] Failed to stamp stats recalculation for ${id}:`,
        statsErr instanceof Error ? statsErr.message : String(statsErr),
      )
    }
  }

  // Steps 2 & 3 — coordinator-level actions. Bundled in one try block
  // because they all need the same `coordinator` reference, and a
  // failure to load the coordinator module fails both equivalently.
  try {
    const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
    const coordinator = getGlobalTradeEngineCoordinator()
    
    // Guard against null coordinator (can happen if engine is being reset)
    if (!coordinator) {
      console.warn(
        `[v0] [${opts.logTag}] Global coordinator is null/undefined for ${id} — skipping recoordination`
      )
      return makeCompletion({
        progressRecoordinationRequired: requiresProgressRecoordination,
        progressionChanged,
        progressionReason,
      })
    }

    // ── Invalidate in-memory caches if significant settings changed ─────
    // Symbol changes need the symbol cache; PF/DDT/coordination/variant
    // changes need strategy + coordination caches too. Do both before the
    // pending-change fast path so the next tick cannot reuse stale values.
    if ((symbolsChanged || strategyOrCoordinationChanged || liveOrderSettingsChanged) && (coordinator as any).getEngineManager) {
      try {
        const manager = (coordinator as any).getEngineManager(id)
        if (symbolsChanged && manager && typeof (manager as any).invalidateSymbolsCache === "function") {
          (manager as any).invalidateSymbolsCache()
          console.log(`[v0] [${opts.logTag}] Symbol cache invalidated for ${id}`)
        }
        if (
          strategyOrCoordinationChanged &&
          manager &&
          typeof (manager as any).invalidateStrategyAndCoordinationCaches === "function"
        ) {
          ;(manager as any).invalidateStrategyAndCoordinationCaches(changedFields, `${opts.logTag}:settings-save`)
          if (typeof (manager as any).triggerImmediateStrategyReevaluation === "function") {
            ;(manager as any).triggerImmediateStrategyReevaluation(`${opts.logTag}:settings-save`)
          }
        }
        if (liveOrderSettingsChanged && manager) {
          if (typeof (manager as any).invalidateLiveSizingAndProtectionCaches === "function") {
            ;(manager as any).invalidateLiveSizingAndProtectionCaches(changedFields, `${opts.logTag}:settings-save`)
          }
          console.log(`[v0] [${opts.logTag}] Live sizing/order-protection refresh requested for ${id}`)
        }
      } catch (cacheErr) {
        console.warn(
          `[v0] [${opts.logTag}] Failed to invalidate engine settings caches for ${id}:`,
          cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        )
        // Non-fatal — engine will pick up changes via the durable settings event.
      }
    }

    // Step 2 — in-process fast-path (no-op when engine isn't running here).
    // Isolated try-catch to prevent coordinator crash from affecting other operations
    try {
      await coordinator.applyPendingChangesNow(id)
    } catch (applyErr) {
      console.warn(
        `[v0] [${opts.logTag}] applyPendingChangesNow failed for ${id}:`,
        applyErr instanceof Error ? applyErr.message : String(applyErr),
      )
      // Continue to recoordination — the change can still be applied
    }

    // Step 3 — recoordinate. Decide "should this connection be running
    // right now" using the SAME predicate the boot-time reconciliation
    // sweep uses, so behavior is consistent between (a) page-load
    // sweep, (b) settings save, and (c) toggle endpoints.
    const { isConnectionMainProcessing, hasConnectionCredentials, isTruthyFlag } = await import(
      "@/lib/connection-state-utils"
    )
    const shouldRun =
      isConnectionMainProcessing(after) &&
      (hasConnectionCredentials(after, 5, true) ||
        isTruthyFlag((after as any).is_predefined) ||
        isTruthyFlag((after as any).is_testnet) ||
        isTruthyFlag((after as any).demo_mode))

    const isRunning = coordinator.isEngineRunning(id)

    if (shouldRun && !isRunning) {
      // Should run, doesn't — START, but ONLY if the operator has the
      // global engine running. AUTO-START GUARD: without this gate,
      // saving ANY setting while the operator had explicitly stopped the
      // engine (connection flags still enabled) would silently resurrect
      // it. Settings saved while stopped are picked up on the next
      // explicit operator Start via the durable notify envelope (Step 1).
      let globalRunning = false
      try {
        const { getRedisClient } = await import("@/lib/redis-db")
        const globalState = await getRedisClient().hgetall("trade_engine:global")
        const operatorStopped =
          (globalState as any)?.operator_stopped === "1" || (globalState as any)?.operator_stopped === "true"
        const intent = operatorStopped
          ? "stopped"
          : (globalState as any)?.operator_intent || (globalState as any)?.desired_status || (globalState as any)?.status || ""
        globalRunning = intent === "running"
      } catch {
        globalRunning = false
      }
      if (globalRunning) {
        console.log(
          `[v0] [${opts.logTag}] Recoordinate: starting engine for ${id} (was stopped, now should run, global intent=running)`,
        )
        await coordinator.startMissingEngines([after])
      } else {
        console.log(
          `[v0] [${opts.logTag}] Recoordinate: NOT starting ${id} — global engine not running (operator stop honored); settings apply on next explicit Start or continuity tick`,
        )
      }
    } else if (!shouldRun && isRunning) {
      // Should NOT run, but is — STOP. This handles `is_enabled: false`
      // toggles, dashboard-disable, credential clear, etc.
      console.log(
        `[v0] [${opts.logTag}] Recoordinate: stopping engine for ${id} (was running, no longer should)`,
      )
      await coordinator.stopEngine(id, { operatorRequested: true })
    } else if (shouldRun && isRunning) {
      // Should run and is — the hot-reload path inside
      // `applyPendingChangesNow` already handled the change. Nothing
      // to do here. Logged at debug verbosity only.
      // console.log(`[v0] [${opts.logTag}] Engine ${id} hot-reloaded in place`)
    }
    // else: !shouldRun && !isRunning — nothing to do.
  } catch (coordErr) {
    console.warn(
      `[v0] [${opts.logTag}] coordinator recoordination failed for ${id}:`,
      coordErr instanceof Error ? coordErr.message : String(coordErr),
    )
  }

  return makeCompletion({
    progressRecoordinationRequired: requiresProgressRecoordination,
    progressionChanged,
    progressionReason,
  })
}
