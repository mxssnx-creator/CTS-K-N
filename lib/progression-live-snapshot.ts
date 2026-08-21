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
  const { progression, prehistoric, realtime: realtimeHash, engineState } = input

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
  historic.progressPercent = historicTotal > 0
    ? Math.min(100, Math.round((historicProcessed / historicTotal) * 100))
    : 0

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

  counters.indication = indication
  counters.strategy = strategy
  counters.realtime = realtimeCycles
  counters.indicationLive = indicationLive
  counters.strategyLive = strategyLive
  counters.realtimeLive = realtimeLive
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
    [progression, "last_update"],
    [progression, "last_activity_at"],
    [realtimeHash, "last_cycle_at"],
    [engineState, "last_processor_heartbeat"],
  ])
  if (lastUpdate) metadata.lastUpdate = lastUpdate
  metadata.volatileProgression = {
    source: "direct-redis-overlay",
    refreshedAt: input.now ?? Date.now(),
  }

  next.historic = historic
  next.realtime = realtime
  next.metadata = metadata
  return next
}
