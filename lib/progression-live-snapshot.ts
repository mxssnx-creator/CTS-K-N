import { resolveDistributedEngineRuntime } from "@/lib/distributed-engine-runtime"
import { resolveStageRowSnapshotFreshMs } from "@/lib/stage-row-snapshot"

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
  maxAgeMs: number,
): number {
  let total = 0
  let samples = 0
  for (const key of Object.keys(hash)) {
    if (!key.startsWith("s:") || !key.endsWith(":ts")) continue
    const symbol = key.slice(2, -3)
    if (activeSymbols.size > 0 && !activeSymbols.has(symbol.toUpperCase())) continue
    const timestamp = number(hash[key])
    if (!(timestamp > 0) || now - timestamp > maxAgeMs) continue
    total += number(hash[`s:${symbol}:${field}`])
    samples++
  }
  // A legacy field is a last-symbol/lifetime value, not a current
  // cross-symbol snapshot. Never resurrect it when all current rows are
  // stale or absent; the caller will keep the stage explicitly partial.
  return samples > 0 ? total : 0
}

type StageRowCoverage = {
  covered: number
  total: number
  oldestUpdatedAt: number
  latestUpdatedAt: number
  fresh: boolean
  complete: boolean
}

function summarizeStageRowCoverage(
  hash: Hash,
  activeSymbols: Set<string>,
  expectedSymbols: number,
  now: number,
  maxAgeMs: number,
): StageRowCoverage {
  const timestamps: number[] = []
  const knownSymbols = new Set<string>()
  for (const key of Object.keys(hash)) {
    if (!key.startsWith("s:") || !key.endsWith(":ts")) continue
    const symbol = key.slice(2, -3).toUpperCase()
    if (activeSymbols.size > 0 && !activeSymbols.has(symbol)) continue
    knownSymbols.add(symbol)
    const timestamp = number(hash[key])
    if (!(timestamp > 0) || now - timestamp > maxAgeMs) continue
    timestamps.push(timestamp)
  }
  const total = Math.max(activeSymbols.size, expectedSymbols, knownSymbols.size)
  const covered = timestamps.length
  const oldestUpdatedAt = covered > 0 ? Math.min(...timestamps) : 0
  const latestUpdatedAt = covered > 0 ? Math.max(...timestamps) : 0
  return {
    covered,
    total,
    oldestUpdatedAt,
    latestUpdatedAt,
    fresh: covered > 0 && now - oldestUpdatedAt <= maxAgeMs,
    complete: total > 0 && covered >= total,
  }
}

function overlayCurrentStrategyRows(
  next: JsonRecord,
  strategyDetails: NonNullable<ProgressionVolatileOverlayInput["strategyDetails"]>,
  engineState: Hash,
  engineRunning: boolean,
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

  const expectedSymbols = number(record(next.historic).symbolsTotal)
  const maxAgeMs = resolveStageRowSnapshotFreshMs(Math.max(activeSymbols.size, expectedSymbols))
  const baseCoverage = summarizeStageRowCoverage(baseHash, activeSymbols, expectedSymbols, now, maxAgeMs)
  const mainCoverage = summarizeStageRowCoverage(mainHash, activeSymbols, expectedSymbols, now, maxAgeMs)
  const realCoverage = summarizeStageRowCoverage(realHash, activeSymbols, expectedSymbols, now, maxAgeMs)
  const liveCoverage = summarizeStageRowCoverage(liveHash, activeSymbols, expectedSymbols, now, maxAgeMs)
  const aggregateCompleteFreshRowField = (
    hash: Hash,
    coverage: StageRowCoverage,
    field: string,
    legacyField: string,
  ): number => coverage.complete
    ? aggregateFreshRowField(hash, field, legacyField, activeSymbols, now, maxAgeMs)
    : 0
  const openValue = (value: number): number => engineRunning ? value : 0

  const rows = record(next.strategyRows)
  const base = record(rows.base)
  const main = record(rows.main)
  const cachedMainBreakdown = record(main.breakdown)
  const real = record(rows.real)
  const live = record(rows.live)

  const baseTotal = aggregateCompleteFreshRowField(baseHash, baseCoverage, "row_total", "created_sets")
  const baseValid = aggregateCompleteFreshRowField(baseHash, baseCoverage, "row_valid", "passed_sets")
  const mainValid = aggregateCompleteFreshRowField(mainHash, mainCoverage, "row_valid", "parent_sets_passed")
  const mainOverall = aggregateCompleteFreshRowField(mainHash, mainCoverage, "row_overall", "created_sets")
  const realValid = aggregateCompleteFreshRowField(realHash, realCoverage, "row_valid", "created_sets")
  const realEvaluated = aggregateCompleteFreshRowField(realHash, realCoverage, "row_real_evaluated", "evaluated")
  const realActiveCycle = aggregateCompleteFreshRowField(realHash, realCoverage, "row_active", "sets_running_now")
  const liveTotal = aggregateCompleteFreshRowField(liveHash, liveCoverage, "row_total", "evaluated")
  const liveMirrored = aggregateCompleteFreshRowField(liveHash, liveCoverage, "row_mirrored", "created_sets")
  const baseTotalOpen = aggregateCompleteFreshRowField(baseHash, baseCoverage, "row_total_open", "sets_running_now")
  const baseValidOpen = aggregateCompleteFreshRowField(baseHash, baseCoverage, "row_valid_open", "sets_running_now")
  const mainValidOpen = aggregateCompleteFreshRowField(mainHash, mainCoverage, "row_valid_open", "sets_running_now")
  const mainOverallOpen = aggregateCompleteFreshRowField(mainHash, mainCoverage, "row_overall_open", "sets_running_now")
  const mainOpenBreakdown = {
    standard: aggregateCompleteFreshRowField(mainHash, mainCoverage, "row_overall_open_standard", "row_overall_open_standard"),
    trailing: aggregateCompleteFreshRowField(mainHash, mainCoverage, "row_overall_open_trailing", "row_overall_open_trailing"),
    positionCount: aggregateCompleteFreshRowField(mainHash, mainCoverage, "row_overall_open_position_count", "row_overall_open_position_count"),
    block: aggregateCompleteFreshRowField(mainHash, mainCoverage, "row_overall_open_block", "row_overall_open_block"),
    blockCalculated: aggregateCompleteFreshRowField(mainHash, mainCoverage, "row_block_calculated_open", "row_overall_open_block"),
    dca: aggregateCompleteFreshRowField(mainHash, mainCoverage, "row_overall_open_dca", "row_overall_open_dca"),
  }
  const realActiveExact = aggregateCompleteFreshRowField(realHash, realCoverage, "row_active_exact", "sets_running_now")

  next.strategyRows = {
    ...rows,
    base: hasBaseRows ? {
      ...base,
      total: baseTotal,
      valid: baseValid,
      totalOpen: openValue(baseTotalOpen),
      validOpen: openValue(baseValidOpen),
      validRatio: percentage(baseValid, baseTotal),
    } : base,
    main: hasMainRows ? {
      ...main,
      valid: mainValid,
      overall: mainOverall,
      validOpen: openValue(mainValidOpen),
      overallOpen: openValue(mainOverallOpen),
      overallToValidRatio: percentage(mainOverall, mainValid, false),
      breakdown: {
        ...cachedMainBreakdown,
        ...Object.fromEntries(
          Object.entries(mainOpenBreakdown).map(([field, value]) => [field, openValue(value)]),
        ),
      },
    } : main,
    real: hasRealRows ? {
      ...real,
      valid: realValid,
      evaluated: realEvaluated,
      rejected: aggregateCompleteFreshRowField(realHash, realCoverage, "row_real_rejected", "row_real_rejected"),
      active: openValue(realActiveCycle),
      activeExactRows: openValue(realActiveExact),
      validRatio: percentage(realValid, realEvaluated),
      activeRatio: percentage(openValue(realActiveCycle), realValid),
      blockRows: {
        evaluated: aggregateCompleteFreshRowField(realHash, realCoverage, "row_real_block_evaluated", "row_real_block_evaluated"),
        created: aggregateCompleteFreshRowField(realHash, realCoverage, "row_real_block_created", "row_real_block_created"),
        rejected: aggregateCompleteFreshRowField(realHash, realCoverage, "row_real_block_rejected", "row_real_block_rejected"),
      },
    } : real,
    live: hasLiveRows ? {
      ...live,
      total: liveTotal,
      mirrored: liveMirrored,
      active: openValue(aggregateCompleteFreshRowField(liveHash, liveCoverage, "row_active", "sets_running_now")),
      blockCreated: aggregateCompleteFreshRowField(liveHash, liveCoverage, "row_live_block_created", "row_live_block_created"),
      blockValid: aggregateCompleteFreshRowField(liveHash, liveCoverage, "row_live_block_valid", "row_live_block_valid"),
      rowExecutable: aggregateCompleteFreshRowField(liveHash, liveCoverage, "row_live_executable", "created_sets"),
      additionalDca: aggregateCompleteFreshRowField(liveHash, liveCoverage, "additional_dca_executable", "additional_dca_executable"),
      executable: aggregateCompleteFreshRowField(liveHash, liveCoverage, "executable_total", "created_sets"),
      mirroredRatio: percentage(liveMirrored, liveTotal),
      executablePerRow: percentage(
        aggregateCompleteFreshRowField(liveHash, liveCoverage, "row_live_executable", "created_sets"),
        liveTotal,
        false,
      ),
    } : live,
    updatedAt: [baseCoverage, mainCoverage, realCoverage, liveCoverage].every((stage) => stage.complete && stage.oldestUpdatedAt > 0)
      ? Math.min(baseCoverage.oldestUpdatedAt, mainCoverage.oldestUpdatedAt, realCoverage.oldestUpdatedAt, liveCoverage.oldestUpdatedAt)
      : 0,
    semantics: "latest-cycle-and-current-open-row-snapshot",
    snapshot: {
      engineRunning,
      coverage: {
        processed: Math.min(
          number(record(next.historic).symbolsProcessed),
          baseCoverage.covered,
          mainCoverage.covered,
          realCoverage.covered,
          liveCoverage.covered,
        ),
        total: Math.max(
          activeSymbols.size,
          expectedSymbols,
          baseCoverage.total,
          mainCoverage.total,
          realCoverage.total,
          liveCoverage.total,
        ),
        complete: record(next.historic).isComplete === true &&
          [baseCoverage, mainCoverage, realCoverage, liveCoverage].every((stage) => stage.complete),
      },
      stages: { base: baseCoverage, main: mainCoverage, real: realCoverage, live: liveCoverage },
    },
  }
  next.stageEvalPercent = {
    ...record(next.stageEvalPercent),
    ...(hasBaseRows ? { base: percentage(baseValid, baseTotal) } : {}),
    // Main's pass-rate denominator is the Base rows that survived the Base
    // gate (`baseValid`), not the raw Base output (`baseTotal`).  Main can
    // then fan out into physical axis/variant rows independently.
    ...(hasMainRows ? { main: percentage(mainValid, baseValid) } : {}),
    ...(hasRealRows ? { real: percentage(realValid, realEvaluated) } : {}),
    ...(hasLiveRows ? { live: percentage(liveMirrored, liveTotal) } : {}),
  }

  // The card's compact overview is a view of the same current-open rows, not
  // a second ledger. Keep it coherent during the stale full-projection window
  // so Main coordination cannot read current while the adjacent card says 0.
  const overview = record(next.connectionStageOverview)
  if (Object.keys(overview).length > 0) {
    const rowSnapshot = record(record(next.strategyRows).snapshot)
    const rowCoverage = record(rowSnapshot.coverage)
    const rowUpdatedAt = number(record(next.strategyRows).updatedAt)
    const rowCoverageProcessed = number(rowCoverage.processed)
    const rowCoverageTotal = number(rowCoverage.total)
    const overviewBase = record(overview.base)
    const overviewMain = record(overview.main)
    const overviewReal = record(overview.real)
    const overviewBreakdown = record(overviewMain.breakdown)
    const effectiveBase = hasBaseRows
      ? {
          ...overviewBase,
          total: openValue(baseTotalOpen),
          valid: openValue(baseValidOpen),
          validPercent: percentage(openValue(baseValidOpen), openValue(baseTotalOpen)),
        }
      : overviewBase
    const effectiveMain = hasMainRows
      ? {
          ...overviewMain,
          valid: openValue(mainValidOpen),
          overall: openValue(mainOverallOpen),
          additional: Math.max(0, openValue(mainOverallOpen) - openValue(mainValidOpen)),
          expansionPercent: percentage(openValue(mainOverallOpen), openValue(mainValidOpen), false),
          breakdown: {
            ...overviewBreakdown,
            ...Object.fromEntries(
              Object.entries(mainOpenBreakdown).map(([field, value]) => [field, openValue(value)]),
            ),
          },
        }
      : overviewMain
    const effectiveReal = hasRealRows
      ? {
          ...overviewReal,
          valid: realValid,
          active: openValue(realActiveCycle),
          activeExactSets: openValue(realActiveExact),
          activePercent: percentage(openValue(realActiveCycle), realValid),
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
      schemaVersion: 3,
      semantics: "latest-cycle-and-current-open-stage-relations",
      snapshot: {
        updatedAt: rowUpdatedAt,
        ageMs: rowUpdatedAt > 0
          ? Math.max(0, now - rowUpdatedAt)
          : null,
        fresh: engineRunning && rowUpdatedAt > 0 && now - rowUpdatedAt <= maxAgeMs,
        maxAgeMs,
        complete: rowCoverage.complete === true,
        engineRunning,
        coverage: {
          ...rowCoverage,
          processed: rowCoverageProcessed,
          total: rowCoverageTotal,
          percent: percentage(rowCoverageProcessed, rowCoverageTotal),
          complete: rowCoverage.complete === true,
        },
        stages: record(rowSnapshot.stages),
      },
      latestCycle: {
        base: { total: baseTotal, valid: baseValid },
        main: { valid: mainValid, overall: mainOverall },
        real: { valid: realValid, active: realActiveCycle, activeExactSets: realActiveExact },
        live: {
          total: liveTotal,
          mirrored: liveMirrored,
          executable: aggregateCompleteFreshRowField(liveHash, liveCoverage, "row_live_executable", "created_sets"),
        },
      },
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
  runningHint?: unknown
  globalEngineState?: Hash
  connectionEnabled?: boolean
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
  const now = input.now ?? Date.now()
  const engineRuntime = resolveDistributedEngineRuntime({
    runningHint: input.runningHint,
    states: [engineState, engineProgression],
    globalState: input.globalEngineState,
    connectionEnabled: input.connectionEnabled,
    now,
  })

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
  mainCoordination.reusedCycles = firstKnown([
    [progression, "strategies_main_reused_cycles"],
    [engineState, "strategies_main_reused_cycles"],
  ], number(mainCoordination.reusedCycles))
  mainCoordination.productiveCycles = number(mainCoordination.totalCycles) + number(mainCoordination.reusedCycles)
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
    overlayCurrentStrategyRows(next, strategyDetails, engineState, engineRuntime.running, now)
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
  metadata.engineRunning = engineRuntime.running
  metadata.runtimeEvidence = {
    reason: engineRuntime.reason,
    status: engineRuntime.status,
    globalIntent: engineRuntime.globalIntent,
    operatorStopped: engineRuntime.operatorStopped,
    heartbeatAt: engineRuntime.heartbeatAt || null,
    heartbeatAgeMs: engineRuntime.heartbeatAgeMs,
    heartbeatFresh: engineRuntime.heartbeatFresh,
  }
  metadata.volatileProgression = {
    source: "direct-redis-overlay",
    refreshedAt: now,
  }

  next.historic = historic
  next.realtime = realtime
  next.metadata = metadata
  return next
}
