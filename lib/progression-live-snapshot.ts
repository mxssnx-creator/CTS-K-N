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

function percentage(numerator: number, denominator: number, cap = true): number {
  if (!(denominator > 0)) return 0
  const value = Math.round((numerator / denominator) * 1000) / 10
  return cap ? Math.min(100, Math.max(0, value)) : Math.max(0, value)
}

function parseSymbols(value: unknown): Set<string> {
  const text = String(value || "").trim()
  if (!text) return new Set()
  let values: unknown[] = []
  try {
    const parsed = JSON.parse(text)
    values = Array.isArray(parsed) ? parsed : []
  } catch {
    values = text.split(",")
  }
  return new Set(values
    .map((item) => typeof item === "string" ? item : String(record(item).symbol || ""))
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean))
}

function activeSymbolFilter(engineState: Hash): Set<string> {
  for (const field of ["selected_symbols", "active_symbols", "force_symbols", "symbols"]) {
    const symbols = parseSymbols(engineState[field])
    if (symbols.size > 0) return symbols
  }
  return new Set()
}

/**
 * Current strategy rows are per-symbol overwrite snapshots.  A stale full
 * response must retain the exact same semantics as the fresh route: include
 * only the active basket and only samples with a fresh worker timestamp.
 */
function aggregateFreshRowField(
  hash: Hash,
  field: string,
  legacyField: string,
  activeSymbols: Set<string>,
  now: number,
): number {
  let total = 0
  let samples = 0
  for (const key of Object.keys(hash)) {
    if (!key.startsWith("s:") || !key.endsWith(":ts")) continue
    const symbol = key.slice(2, -3)
    if (activeSymbols.size > 0 && !activeSymbols.has(symbol.toUpperCase())) continue
    const timestamp = number(hash[key])
    if (!(timestamp > 0) || now - timestamp > 5 * 60_000) continue
    total += number(hash[`s:${symbol}:${field}`])
    samples++
  }
  return samples > 0 ? total : number(hash[field] ?? hash[legacyField])
}

function overlayCurrentStrategyRows(
  next: JsonRecord,
  strategyDetails: NonNullable<ProgressionVolatileOverlayInput["strategyDetails"]>,
  engineState: Hash,
  now: number,
): void {
  const activeSymbols = activeSymbolFilter(engineState)
  const baseHash = strategyDetails.base || {}
  const mainHash = strategyDetails.main || {}
  const realHash = strategyDetails.real || {}
  const liveHash = strategyDetails.live || {}
  const hasBaseRows = Object.keys(baseHash).length > 0
  const hasMainRows = Object.keys(mainHash).length > 0
  const hasRealRows = Object.keys(realHash).length > 0
  const hasLiveRows = Object.keys(liveHash).length > 0
  // Do not manufacture a zero-only projection when the worker has not yet
  // written any per-stage detail. The cached completed projection remains the
  // truthful view until a current snapshot exists.
  if (!hasBaseRows && !hasMainRows && !hasRealRows && !hasLiveRows) return

  const rows = record(next.strategyRows)
  const base = record(rows.base)
  const main = record(rows.main)
  const cachedMainBreakdown = record(main.breakdown)
  const real = record(rows.real)
  const live = record(rows.live)

  const baseTotal = aggregateFreshRowField(baseHash, "row_total", "created_sets", activeSymbols, now)
  const baseValid = aggregateFreshRowField(baseHash, "row_valid", "passed_sets", activeSymbols, now)
  const mainValid = aggregateFreshRowField(mainHash, "row_valid", "parent_sets_passed", activeSymbols, now)
  const mainOverall = aggregateFreshRowField(mainHash, "row_overall", "created_sets", activeSymbols, now)
  const realValid = aggregateFreshRowField(realHash, "row_valid", "created_sets", activeSymbols, now)
  const realEvaluated = aggregateFreshRowField(realHash, "row_real_evaluated", "evaluated", activeSymbols, now)
  const realActive = aggregateFreshRowField(realHash, "row_active", "sets_running_now", activeSymbols, now)
  const liveTotal = aggregateFreshRowField(liveHash, "row_total", "evaluated", activeSymbols, now)
  const liveMirrored = aggregateFreshRowField(liveHash, "row_mirrored", "created_sets", activeSymbols, now)
  const baseTotalOpen = aggregateFreshRowField(baseHash, "row_total_open", "sets_running_now", activeSymbols, now)
  const baseValidOpen = aggregateFreshRowField(baseHash, "row_valid_open", "sets_running_now", activeSymbols, now)
  const mainValidOpen = aggregateFreshRowField(mainHash, "row_valid_open", "sets_running_now", activeSymbols, now)
  const mainOverallOpen = aggregateFreshRowField(mainHash, "row_overall_open", "sets_running_now", activeSymbols, now)
  const mainOpenBreakdown = {
    standard: aggregateFreshRowField(mainHash, "row_overall_open_standard", "row_overall_open_standard", activeSymbols, now),
    trailing: aggregateFreshRowField(mainHash, "row_overall_open_trailing", "row_overall_open_trailing", activeSymbols, now),
    positionCount: aggregateFreshRowField(mainHash, "row_overall_open_position_count", "row_overall_open_position_count", activeSymbols, now),
    block: aggregateFreshRowField(mainHash, "row_overall_open_block", "row_overall_open_block", activeSymbols, now),
    dca: aggregateFreshRowField(mainHash, "row_overall_open_dca", "row_overall_open_dca", activeSymbols, now),
  }
  const realActiveExact = aggregateFreshRowField(realHash, "row_active_exact", "sets_running_now", activeSymbols, now)

  next.strategyRows = {
    ...rows,
    base: hasBaseRows ? {
      ...base,
      total: baseTotal,
      valid: baseValid,
      totalOpen: baseTotalOpen,
      validOpen: baseValidOpen,
      validRatio: percentage(baseValid, baseTotal),
    } : base,
    main: hasMainRows ? {
      ...main,
      valid: mainValid,
      overall: mainOverall,
      validOpen: mainValidOpen,
      overallOpen: mainOverallOpen,
      overallToValidRatio: percentage(mainOverall, mainValid, false),
      breakdown: {
        ...cachedMainBreakdown,
        ...mainOpenBreakdown,
      },
    } : main,
    real: hasRealRows ? {
      ...real,
      valid: realValid,
      evaluated: realEvaluated,
      rejected: aggregateFreshRowField(realHash, "row_real_rejected", "row_real_rejected", activeSymbols, now),
      active: realActive,
      activeExactRows: realActiveExact,
      validRatio: percentage(realValid, realEvaluated),
      activeRatio: percentage(realActive, realValid),
    } : real,
    live: hasLiveRows ? {
      ...live,
      total: liveTotal,
      mirrored: liveMirrored,
      active: aggregateFreshRowField(liveHash, "row_active", "sets_running_now", activeSymbols, now),
      blockCreated: aggregateFreshRowField(liveHash, "row_live_block_created", "row_live_block_created", activeSymbols, now),
      blockValid: aggregateFreshRowField(liveHash, "row_live_block_valid", "row_live_block_valid", activeSymbols, now),
      executable: aggregateFreshRowField(liveHash, "row_live_executable", "created_sets", activeSymbols, now),
      mirroredRatio: percentage(liveMirrored, liveTotal),
      executablePerRow: percentage(
        aggregateFreshRowField(liveHash, "row_live_executable", "created_sets", activeSymbols, now),
        liveTotal,
        false,
      ),
    } : live,
    updatedAt: now,
    semantics: "current-open-row-snapshot",
  }
  next.stageEvalPercent = {
    ...record(next.stageEvalPercent),
    ...(hasBaseRows ? { base: percentage(baseValid, baseTotal) } : {}),
    ...(hasMainRows ? { main: percentage(mainValid, baseTotal) } : {}),
    ...(hasRealRows ? { real: percentage(realValid, realEvaluated) } : {}),
    ...(hasLiveRows ? { live: percentage(liveMirrored, liveTotal) } : {}),
  }

  // The card's compact overview is a view of the same current-open rows, not
  // a second ledger. Keep it coherent during the stale full-projection window
  // so Main coordination cannot read current while the adjacent card says 0.
  const overview = record(next.connectionStageOverview)
  if (Object.keys(overview).length > 0) {
    const overviewBase = record(overview.base)
    const overviewMain = record(overview.main)
    const overviewReal = record(overview.real)
    const overviewBreakdown = record(overviewMain.breakdown)
    const effectiveBase = hasBaseRows
      ? {
          ...overviewBase,
          total: baseTotalOpen,
          valid: baseValidOpen,
          validPercent: percentage(baseValidOpen, baseTotalOpen),
        }
      : overviewBase
    const effectiveMain = hasMainRows
      ? {
          ...overviewMain,
          valid: mainValidOpen,
          overall: mainOverallOpen,
          additional: Math.max(0, mainOverallOpen - mainValidOpen),
          expansionPercent: percentage(mainOverallOpen, mainValidOpen, false),
          breakdown: { ...overviewBreakdown, ...mainOpenBreakdown },
        }
      : overviewMain
    const effectiveReal = hasRealRows
      ? {
          ...overviewReal,
          valid: realValid,
          active: realActive,
          activeExactSets: realActiveExact,
          activePercent: percentage(realActive, realValid),
        }
      : overviewReal
    const effectiveBreakdown = record(effectiveMain.breakdown)
    const breakdownTotal = [
      number(effectiveBreakdown.standard),
      number(effectiveBreakdown.trailing),
      number(effectiveBreakdown.positionCount),
      number(effectiveBreakdown.block),
      number(effectiveBreakdown.dca),
    ].reduce((sum, value) => sum + value, 0)
    const errors: string[] = []
    if (number(effectiveBase.valid) > number(effectiveBase.total)) {
      errors.push(`Base Valid ${number(effectiveBase.valid)} exceeds Base Total ${number(effectiveBase.total)}`)
    }
    if (number(effectiveMain.overall) < number(effectiveMain.valid)) {
      errors.push(`Main Overall ${number(effectiveMain.overall)} is below Main Valid ${number(effectiveMain.valid)}`)
    }
    if (number(effectiveReal.active) > number(effectiveReal.valid)) {
      errors.push(`Real Active ${number(effectiveReal.active)} exceeds Real Valid ${number(effectiveReal.valid)}`)
    }
    const breakdownComplete = number(effectiveMain.overall) === 0 || breakdownTotal === number(effectiveMain.overall)
    if (!breakdownComplete) {
      errors.push(`Main breakdown ${breakdownTotal} does not equal Overall ${number(effectiveMain.overall)}`)
    }
    next.connectionStageOverview = {
      ...overview,
      base: effectiveBase,
      main: { ...effectiveMain, breakdownComplete },
      real: effectiveReal,
      integrity: { valid: errors.length === 0, errors },
    }
  }
}

export interface ProgressionVolatileOverlayInput {
  progression: Hash
  prehistoric: Hash
  realtime: Hash
  engineState: Hash
  /** The worker-owned phase projection has priority over route-level markers. */
  engineProgression?: Hash
  /** Current per-symbol strategy rows; fetched only for a stale full snapshot. */
  strategyDetails?: { base?: Hash; main?: Hash; real?: Hash; live?: Hash }
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
    strategyDetails,
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
  // Symbol progress owns the historic phase bar. Config work can advance
  // several calculation groups inside one symbol, so it must be displayed as
  // a separate sub-progress rather than making the symbol counter appear to
  // jump ahead of the actual completed-symbol numerator.
  historic.progressPercent = symbolProgressPercent
  historic.configWork = {
    ...configWork,
    completed: configWorkCompleted,
    total: configWorkTotal,
    failed: configWorkFailed,
    progressPercent: configWorkPercent,
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

  // The heavy stats projection deliberately permits a bounded stale window
  // while a large Strategy graph is materialised. Main coordination counters
  // are worker-owned atomics, just like the realtime cycle counters above;
  // leaving this nested block frozen made a healthy Main engine appear to run
  // zero cycles for the whole stale window.
  const mainCoordination = record(next.mainCoordination)
  const mainContext = record(mainCoordination.positionContext)
  const mainVariants = firstText([
    [progression, "strategies_main_active_variants"],
    [engineState, "strategies_main_active_variants"],
  ])
  if (mainVariants) {
    mainCoordination.activeVariants = mainVariants
      .split(",")
      .map((variant) => variant.trim())
      .filter(Boolean)
  }
  mainCoordination.activeVariantCount = firstKnown([
    [progression, "strategies_main_active_variant_count"],
    [engineState, "strategies_main_active_variant_count"],
  ], number(mainCoordination.activeVariantCount))
  mainCoordination.lastCreated = firstKnown([
    [progression, "strategies_main_last_created"],
    [engineState, "strategies_main_last_created"],
  ], number(mainCoordination.lastCreated))
  mainCoordination.lastReused = firstKnown([
    [progression, "strategies_main_last_reused"],
    [engineState, "strategies_main_last_reused"],
  ], number(mainCoordination.lastReused))
  mainCoordination.totalCreated = firstKnown([
    [progression, "strategies_main_related_created"],
    [engineState, "strategies_main_related_created"],
  ], number(mainCoordination.totalCreated))
  mainCoordination.totalReused = firstKnown([
    [progression, "strategies_main_related_reused"],
    [engineState, "strategies_main_related_reused"],
  ], number(mainCoordination.totalReused))
  mainCoordination.totalCycles = firstKnown([
    [progression, "strategies_main_cycles"],
    [engineState, "strategies_main_cycles"],
  ], number(mainCoordination.totalCycles))
  const totalMainCoordinationWork = number(mainCoordination.totalCreated) + number(mainCoordination.totalReused)
  mainCoordination.reuseRate = totalMainCoordinationWork > 0
    ? Math.round((number(mainCoordination.totalReused) / totalMainCoordinationWork) * 1000) / 10
    : 0
  mainContext.continuous = firstKnown([
    [progression, "strategies_main_ctx_continuous"],
    [engineState, "strategies_main_ctx_continuous"],
  ], number(mainContext.continuous))
  mainContext.lastWins = firstKnown([
    [progression, "strategies_main_ctx_last_wins"],
    [engineState, "strategies_main_ctx_last_wins"],
  ], number(mainContext.lastWins))
  mainContext.lastLosses = firstKnown([
    [progression, "strategies_main_ctx_last_losses"],
    [engineState, "strategies_main_ctx_last_losses"],
  ], number(mainContext.lastLosses))
  mainContext.prevLosses = firstKnown([
    [progression, "strategies_main_ctx_prev_losses"],
    [engineState, "strategies_main_ctx_prev_losses"],
  ], number(mainContext.prevLosses))
  mainContext.prevTotal = firstKnown([
    [progression, "strategies_main_ctx_prev_total"],
    [engineState, "strategies_main_ctx_prev_total"],
  ], number(mainContext.prevTotal))
  mainContext.updatedAt = firstKnown([
    [progression, "strategies_main_ctx_updated_at"],
    [engineState, "strategies_main_ctx_updated_at"],
  ], number(mainContext.updatedAt))
  mainCoordination.positionContext = mainContext
  next.mainCoordination = mainCoordination
  if (strategyDetails) {
    overlayCurrentStrategyRows(next, strategyDetails, engineState, input.now ?? Date.now())
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
