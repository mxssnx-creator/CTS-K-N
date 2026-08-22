/**
 * Overlay the volatile, worker-owned progression fields onto a cached full
 * stats projection. The complete projection can be expensive for a large
 * Strategy Set graph; these counters must nevertheless remain current so a
 * selected connection never appears stuck while that projection is rebuilding.
 */

type Hash = Record<string, string | undefined>
type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function number(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function hasField(hash: Hash, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(hash, field)
}

function firstKnown(
  fields: ReadonlyArray<readonly [Hash, string]>,
  fallback: number,
): number {
  for (const [hash, field] of fields) {
    if (hasField(hash, field)) return number(hash[field])
  }
  return fallback
}

function firstText(fields: ReadonlyArray<readonly [Hash, string]>): string {
  for (const [hash, field] of fields) {
    const value = String(hash[field] || "").trim()
    if (value) return value
  }
  return ""
}

function cloneSnapshot(snapshot: unknown): JsonRecord | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null
  return JSON.parse(JSON.stringify(snapshot)) as JsonRecord
}

export interface ProgressionVolatileOverlayInput {
  progression: Hash
  prehistoric: Hash
  realtime: Hash
  engineState: Hash
  /** The worker-owned phase projection has priority over route-level markers. */
  engineProgression?: Hash
  now?: number
}

/**
 * Does not mutate the cached snapshot. A stale historic generation is rejected
 * when its symbol-selection epoch differs from the active engine generation.
 */
export function overlayVolatileProgressionStats(
  snapshot: unknown,
  input: ProgressionVolatileOverlayInput,
): JsonRecord | null {
  const next = cloneSnapshot(snapshot)
  if (!next) return null

  const historic = record(next.historic)
  const realtime = record(next.realtime)
  const counters = record(realtime.cycleCounters)
  const metadata = record(next.metadata)
  const processing = record(historic.processing)
  const configWork = record(historic.configWork)
  const {
    progression,
    prehistoric,
    realtime: realtimeHash,
    engineState,
    engineProgression = {},
  } = input

  const activeEpoch = String(
    engineState.symbol_selection_epoch || engineState.quickstart_symbol_generation || "",
  ).trim()
  const historicEpoch = String(prehistoric.symbol_selection_epoch || "").trim()
  const ownsCurrentHistoricGeneration = !activeEpoch || !historicEpoch || activeEpoch === historicEpoch
  const historicTotal = number(historic.symbolsTotal)
  const rawHistoricProcessed = firstKnown([
    [prehistoric, "symbols_processed"],
    [progression, "prehistoric_symbols_processed_count"],
    [engineState, "config_set_symbols_processed"],
  ], number(historic.symbolsProcessed))
  const historicProcessed = ownsCurrentHistoricGeneration
    ? historicTotal > 0 ? Math.min(rawHistoricProcessed, historicTotal) : rawHistoricProcessed
    : 0
  historic.symbolsProcessed = historicProcessed
  historic.candlesLoaded = firstKnown([
    [prehistoric, "candles_loaded"],
    [progression, "prehistoric_candles_processed"],
    [engineState, "config_set_candles_processed"],
  ], number(historic.candlesLoaded))
  historic.indicatorsCalculated = firstKnown([
    [prehistoric, "indicators_calculated"],
    [engineState, "config_set_indication_results"],
  ], number(historic.indicatorsCalculated))
  historic.cyclesCompleted = firstKnown([
    [progression, "prehistoric_cycles_completed"],
    [engineState, "config_set_symbols_processed"],
  ], number(historic.cyclesCompleted))
  historic.isComplete = historicTotal > 0 && historicProcessed >= historicTotal
  const symbolProgressPercent = historicTotal > 0
    ? Math.min(100, Math.round((historicProcessed / historicTotal) * 100))
    : 0
  // The exhaustive historic grid can spend minutes in the first symbol. Keep
  // its actual calculation-group counter live even when the expensive full
  // stats projection is served from the bounded stale cache.
  const configWorkTotal = firstKnown([
    [prehistoric, "config_work_units_total"],
    [progression, "prehistoric_config_work_units_total"],
  ], number(configWork.total))
  const rawConfigWorkCompleted = firstKnown([
    [prehistoric, "config_work_units_completed"],
    [progression, "prehistoric_config_work_units_completed"],
  ], number(configWork.completed))
  const configWorkCompleted = configWorkTotal > 0
    ? Math.min(rawConfigWorkCompleted, configWorkTotal)
    : rawConfigWorkCompleted
  const configWorkFailed = firstKnown([
    [prehistoric, "config_work_failed_units"],
    [progression, "prehistoric_config_work_failed_units"],
  ], number(configWork.failed))
  const configWorkPercent = configWorkTotal > 0
    ? Math.min(100, Math.round((configWorkCompleted / configWorkTotal) * 100))
    : 0
  historic.progressPercent = Math.max(symbolProgressPercent, configWorkPercent)
  historic.configWork = {
    ...configWork,
    completed: configWorkCompleted,
    total: configWorkTotal,
    failed: configWorkFailed,
    currentSymbol: firstText([
      [prehistoric, "config_work_current_symbol"],
      [progression, "prehistoric_config_work_current_symbol"],
      [prehistoric, "current_symbol"],
    ]) || String(configWork.currentSymbol || ""),
    currentStage: firstText([
      [prehistoric, "config_work_current_stage"],
      [progression, "prehistoric_config_work_current_stage"],
    ]) || String(configWork.currentStage || ""),
    lastActivityAt: firstText([
      [prehistoric, "config_work_last_activity_at"],
      [progression, "prehistoric_config_work_last_activity_at"],
    ]) || String(configWork.lastActivityAt || ""),
  }

  const indication = firstKnown([
    [progression, "indication_cycle_count"],
    [realtimeHash, "cycle_count"],
    [engineState, "indication_cycle_count"],
  ], number(counters.indication))
  const strategy = firstKnown([
    [progression, "strategy_cycle_count"],
    [engineState, "strategy_cycle_count"],
  ], number(counters.strategy))
  const realtimeCycles = firstKnown([
    [progression, "realtime_cycle_count"],
    [realtimeHash, "cycle_count"],
    [engineState, "realtime_cycle_count"],
  ], number(counters.realtime))
  const indicationLive = firstKnown([
    [progression, "indication_live_cycle_count"],
  ], number(counters.indicationLive))
  const strategyLive = firstKnown([
    [progression, "strategy_live_cycle_count"],
  ], number(counters.strategyLive))
  const realtimeLive = firstKnown([
    [progression, "realtime_live_cycle_count"],
  ], number(counters.realtimeLive))
  const livePositions = firstKnown([
    [progression, "live_positions_cycle_count"],
    [engineState, "live_positions_cycle_count"],
  ], number(counters.livePositions))

  counters.indication = indication
  counters.strategy = strategy
  counters.realtime = realtimeCycles
  counters.indicationLive = indicationLive
  counters.strategyLive = strategyLive
  counters.realtimeLive = realtimeLive
  counters.livePositions = livePositions
  realtime.cycleCounters = counters
  realtime.indicationCycles = indicationLive || indication
  realtime.strategyCycles = strategyLive || strategy
  realtime.realtimeCycles = realtimeCycles
  realtime.framesProcessed = firstKnown([
    [progression, "frames_processed"],
  ], number(realtime.framesProcessed))
  historic.processing = {
    ...processing,
    indicationChurnCycles: indication,
    strategyChurnCycles: strategy,
  }

  const lastUpdate = firstText([
    [engineProgression, "updated_at"],
    [progression, "last_update"],
    [progression, "last_activity_at"],
    [prehistoric, "config_work_last_activity_at"],
    [progression, "prehistoric_config_work_last_activity_at"],
    [realtimeHash, "last_cycle_at"],
    [engineState, "last_processor_heartbeat"],
  ])
  if (lastUpdate) metadata.lastUpdate = lastUpdate
  // The full projection can be deliberately stale while a large graph is
  // being materialised. Phase/progress are worker-owned volatile fields, so
  // surface their current values alongside the counters instead of leaving a
  // card visually parked on an old "idle" or "prehistoric" phase.
  const phase = firstText([
    [engineProgression, "phase"],
    [progression, "phase"],
    [engineState, "phase"],
  ])
  const progress = firstKnown([
    [engineProgression, "progress"],
    [progression, "progress"],
    [engineState, "progress"],
  ], number(metadata.progress))
  if (phase) {
    metadata.phase = phase
    next.phase = phase
  }
  metadata.progress = progress
  next.progress = progress
  metadata.volatileProgression = {
    source: "direct-redis-overlay",
    refreshedAt: input.now ?? Date.now(),
  }

  next.historic = historic
  next.realtime = realtime
  next.metadata = metadata
  return next
}
