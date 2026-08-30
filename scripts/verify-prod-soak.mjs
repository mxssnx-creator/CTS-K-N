#!/usr/bin/env node

/** Bounded production-mode engine/UI/API coordination soak (simulated orders only). */

const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3102}`
const MIN_DURATION_MS = Math.max(5_000, Number(process.env.SOAK_MIN_DURATION_MS || 60_000))
const DURATION_MS = Math.max(MIN_DURATION_MS, Number(process.env.SOAK_DURATION_MS || 90_000))
const POLL_MS = Math.max(750, Number(process.env.SOAK_POLL_MS || 2_000))
const SIGNAL_OBSERVATION_INTERVAL_MS = Math.max(
  30_000,
  Number(process.env.SIGNAL_OBSERVATION_INTERVAL_MS || 30_000),
)
// Startup is intentionally excluded from the measured soak window. A cold
// 32-symbol historic graph may need minutes to publish its first productive
// Main cycle on a constrained Linux host; treating that bounded bootstrap as
// a 0-cycle regression made the verifier fail while the engine was still
// correctly gated. Operators can shorten this only for focused diagnostics.
const BOOTSTRAP_READY_TIMEOUT_MS = Math.max(
  120_000,
  Number(process.env.SOAK_BOOTSTRAP_READY_TIMEOUT_MS || 10 * 60_000),
)
const SYMBOL_COUNT = Math.max(1, Math.min(32, Number(process.env.SYMBOL_COUNT || 12)))
const START_SIMULATED_ENGINE = process.env.START_SIMULATED_ENGINE === "1"
const VERIFY_SIGNAL_ENGINE = process.env.VERIFY_SIGNAL_ENGINE === "1"
const SIGNAL_FOCUSED_SOAK = process.env.SIGNAL_FOCUSED_SOAK === "1"
const SIGNAL_MAX_POSITIONS_TOTAL = 120
// One open Signal row is represented by at most six bounded keys: the
// canonical position, its tracking row + tracking index, the compatibility
// mirror, the execution-slot claim, and the strategy-Set membership. This is
// fixed topology, not per-cycle history.
const SIGNAL_POSITION_STORAGE_KEYS_PER_ROW = 6
const SIGNAL_POSITION_TOPOLOGY_KEY_BUDGET = VERIFY_SIGNAL_ENGINE
  ? SIGNAL_MAX_POSITIONS_TOTAL * SIGNAL_POSITION_STORAGE_KEYS_PER_ROW
  : 0
// Outside the separately indexed Set/outcome inventory, each symbol owns a
// finite collection of market-cache, stage/progression, position/history and
// tracking keys. The exhaustive 32-symbol Shared-Redis run stabilizes below
// 830 keys/symbol; keep explicit headroom for all enabled strategy variants
// while the independent low-water plateau check still rejects per-cycle growth.
const NON_INVENTORY_KEYS_PER_SYMBOL_BUDGET = 1_000
const MIN_PRODUCTIVE_CYCLES = Math.max(1, Number(process.env.SOAK_MIN_PRODUCTIVE_CYCLES || 3))
// A maximum-symbol cold Historic build can legitimately finish at the end of
// the fixed observation window. Optional grace keeps polling only until the
// requested Historic coverage and productive Main cycles are observable; it
// never weakens either acceptance criterion or extends past this hard bound.
const PRODUCTIVE_COMPLETION_GRACE_MS = Math.max(
  0,
  Number(process.env.SOAK_PRODUCTIVE_COMPLETION_GRACE_MS || 0),
)
const RUNTIME_MODE = process.env.RUNTIME_MODE || "production"
const DEBUG_ADMIN_SECRET = String(process.env.SOAK_ADMIN_SECRET || "")
const REQUESTED_CONNECTION_ID = String(process.env.SOAK_CONNECTION_ID || "").trim()
const HEAP_GROWTH_LIMIT_KB = Math.max(
  128 * 1024,
  Number(
    process.env.SOAK_HEAP_GROWTH_LIMIT_KB ||
    process.env.SOAK_RSS_GROWTH_LIMIT_KB ||
    (
      RUNTIME_MODE === "development" ||
      (RUNTIME_MODE === "production" && process.env.ALLOW_PROD_INLINE_REDIS === "1")
        ? 1024 * 1024
        : 512 * 1024
    ),
  ),
)
const CONFIGURED_NODE_HEAP_MB = Math.max(512, Number(process.env.CTS_NODE_HEAP_MB || 5632))
const RSS_PEAK_LIMIT_KB = Math.max(
  1024 * 1024,
  Number(process.env.SOAK_RSS_PEAK_LIMIT_KB || (CONFIGURED_NODE_HEAP_MB + 1024) * 1024),
)
const SYMBOLS = [
  // Match the runtime's mandatory quartet exactly so this harness proves the
  // same physical basket it requests instead of checking only the persisted
  // pre-canonicalized QuickStart response.
  "BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT", "ETHUSDT", "BNBUSDT", "DOGEUSDT",
  "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "ATOMUSDT", "LTCUSDT",
  "UNIUSDT", "NEARUSDT", "OPUSDT", "ARBUSDT", "APTUSDT", "SUIUSDT",
  "INJUSDT", "TIAUSDT", "SEIUSDT", "WLDUSDT", "PYTHUSDT", "JUPUSDT",
  "TRXUSDT", "ETCUSDT", "FILUSDT", "AAVEUSDT", "RUNEUSDT", "FETUSDT",
  "ICPUSDT",
].slice(0, SYMBOL_COUNT)

// Constrained-host override for the post-bootstrap database key-growth budget.
// The default budget (max(1500, symbols*50)) assumes a soak long enough for
// long-TTL per-cycle progression/snapshot keys to churn toward steady state.
// The in-process simulated Redis used by the dev-preview harness cannot churn
// 1–7 day TTL keys within a memory-fitting short soak, so it only observes the
// accumulation phase. A constrained host may raise this budget; production CI
// leaves it at the strict default.
const DB_STABLE_GROWTH_LIMIT = Math.max(
  1_500 + SIGNAL_POSITION_TOPOLOGY_KEY_BUDGET,
  SYMBOLS.length * 50 + SIGNAL_POSITION_TOPOLOGY_KEY_BUDGET,
  Number(process.env.SOAK_DB_GROWTH_LIMIT || 0),
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function describeRequestError(error) {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause
  if (!cause) return `${error.name}: ${error.message}`
  const detail = cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : String(cause)
  return `${error.name}: ${error.message} (cause: ${detail})`
}

async function request(pathname, {
  method = "GET",
  body,
  timeoutMs = RUNTIME_MODE === "development" ? 60_000 : 30_000,
  headers = {},
} = {}) {
  const started = Date.now()
  let response
  try {
    response = await fetch(new URL(pathname, BASE_URL), {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new Error(
      `${method} ${pathname} failed after ${Date.now() - started}ms: ` +
      describeRequestError(error),
    )
  }
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${pathname} HTTP ${response.status}: ${text.slice(0, 4_000)}`)
  let json
  try { json = text ? JSON.parse(text) : {} } catch { throw new Error(`${pathname} returned invalid JSON`) }
  const completedAt = Date.now()
  return { json, latencyMs: completedAt - started, completedAt }
}

async function requestWithRetry(pathname, options = {}, maxRetries = 3) {
  let lastError
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await request(pathname, options)
    } catch (error) {
      lastError = error
      if (error instanceof Error && error.message && error.message.includes("fetch failed")) {
        if (attempt < maxRetries) {
          console.warn(
            `[prod-soak:retry] ${pathname} transport failure ` +
            `(attempt ${attempt}/${maxRetries}); retrying without resetting soak state`,
          )
          await sleep(Math.min(10_000, attempt * 3_000))
          continue
        }
      }
      throw error
    }
  }
  throw lastError
}

async function requestLifecycleToggle(pathname, body) {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await requestWithRetry(pathname, {
        method: "POST",
        body,
        timeoutMs: 120_000,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const retryAfterMatch = message.match(/"retryAfter"\s*:\s*(\d+)/)
      const resetTimeMatch = message.match(/"resetTime"\s*:\s*(\d+)/)
      if (attempt < maxAttempts && message.includes("HTTP 429") && retryAfterMatch) {
        const retryAfterMs = Number(retryAfterMatch[1]) * 1_000
        const resetDelayMs = resetTimeMatch ? Number(resetTimeMatch[1]) - Date.now() : 0
        const boundedDelayMs = Math.min(70_000, Math.max(1_000, retryAfterMs, resetDelayMs) + 1_500)
        console.warn(
          `[prod-soak:toggle-retry] persistent restart test inherited the toggle limiter; ` +
          `waiting ${boundedDelayMs}ms before bounded lifecycle retry ${attempt}/${maxAttempts - 1}`,
        )
        await sleep(boundedDelayMs)
        continue
      }
      throw error
    }
  }
  throw new Error("Lifecycle toggle retry exhausted")
}

function finiteNonNegative(value, label) {
  if (value == null) return 0
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} is invalid: ${value}`)
  return number
}

function isTruthy(value) {
  return value === true || value === 1 || value === "1" || value === "true"
}

function detailedMonitorSample(payload, connectionId, expectedEnabled) {
  if (
    payload?.success !== true ||
    !Array.isArray(payload?.logs) ||
    !Array.isArray(payload?.monitoring?.alerts) ||
    !Array.isArray(payload?.monitoring?.connections)
  ) {
    throw new Error("Detailed Logs monitoring schema failed during soak")
  }
  const connection = payload.monitoring.connections.find(
    (item) => String(item?.id) === String(connectionId),
  )
  if (!connection) throw new Error(`Detailed Logs did not expose connection ${connectionId}`)
  if (expectedEnabled !== undefined && connection.dashboardEnabled !== expectedEnabled) {
    throw new Error(
      `Detailed Logs dashboard state mismatch for ${connectionId}: ` +
      `${connection.dashboardEnabled} != ${expectedEnabled}`,
    )
  }
  const processed = finiteNonNegative(
    connection?.prehistoric?.symbolsProcessed,
    "detailedLogs.prehistoric.symbolsProcessed",
  )
  const total = finiteNonNegative(
    connection?.prehistoric?.symbolsTotal,
    "detailedLogs.prehistoric.symbolsTotal",
  )
  if (total > 0 && processed > total) {
    throw new Error(`Detailed Logs historic count exceeds total: ${processed}/${total}`)
  }
  if (connection?.lifecycle?.stalled === true) {
    throw new Error(
      `Detailed Logs detected a stalled lifecycle: ${JSON.stringify(connection.lifecycle)}`,
    )
  }
  const signalCapacityTotal = finiteNonNegative(
    connection?.signalCapacity?.total,
    "detailedLogs.signalCapacity.total",
  )
  const signalCapacityLimit = finiteNonNegative(
    connection?.signalCapacity?.limit,
    "detailedLogs.signalCapacity.limit",
  )
  if (signalCapacityLimit < 1 || signalCapacityTotal > signalCapacityLimit) {
    throw new Error(
      `Detailed Logs Signal capacity is invalid: ${signalCapacityTotal}/${signalCapacityLimit}`,
    )
  }
  if (String(connection?.signalCapacity?.selectionMode || "") !== "best_first") {
    throw new Error("Detailed Logs does not expose best-first Signal selection")
  }
  return {
    status: String(connection?.lifecycle?.status || ""),
    processed,
    total,
    alerts: payload.monitoring.alerts.length,
    logRows: payload.logs.length,
    signalCapacityTotal,
    signalCapacityLimit,
  }
}

function progressionSample(stats) {
  const stages = stats?.breakdown?.strategies || stats?.strategies || {}
  const sample = {
    historicPercent: finiteNonNegative(stats?.historic?.progressPercent, "historic.progressPercent"),
    historicSymbols: finiteNonNegative(stats?.historic?.symbolsProcessed, "historic.symbolsProcessed"),
    historicTotal: finiteNonNegative(stats?.historic?.symbolsTotal, "historic.symbolsTotal"),
    historicCandles: finiteNonNegative(stats?.historic?.candlesLoaded, "historic.candlesLoaded"),
    historicCycles: finiteNonNegative(stats?.historic?.cyclesCompleted, "historic.cyclesCompleted"),
    realtimeCycles: finiteNonNegative(stats?.realtime?.realtimeCycles, "realtime.realtimeCycles"),
    realtimeFrames: finiteNonNegative(stats?.realtime?.framesProcessed, "realtime.framesProcessed"),
    base: finiteNonNegative(stages.base, "strategies.base"),
    main: finiteNonNegative(stages.main, "strategies.main"),
    real: finiteNonNegative(stages.real, "strategies.real"),
    live: finiteNonNegative(stages.live, "strategies.live"),
    baseEvaluated: finiteNonNegative(stages.baseEvaluated, "strategies.baseEvaluated"),
    mainEvaluated: finiteNonNegative(stages.mainEvaluated, "strategies.mainEvaluated"),
    realEvaluated: finiteNonNegative(stages.realEvaluated, "strategies.realEvaluated"),
  }
  return {
    ...sample,
    score: Object.values(sample).reduce((sum, value) => sum + value, 0),
  }
}

const VARIANT_NAMES = ["default", "trailing", "block", "dca"]

function strategyRuntimeSample(stats) {
  const variants = stats?.strategyVariants || {}
  // The detailed Real-stage ledger is intentionally nested below
  // `strategyDetail.real`: the top-level response contains the compact
  // per-variant tiles only. Reading a non-existent top-level `positionStats`
  // made this soak permanently report the evaluation fallback, then classify
  // the legitimate fallback -> confirmed-ledger hand-off as a regression.
  // Keep the legacy fallback solely for an older deployed response shape.
  const realPositionStats = stats?.strategyDetail?.real?.positionStats || stats?.positionStats || {}
  const normalizedVariants = {}
  for (const variant of [...VARIANT_NAMES, "overall"]) {
    const row = variants?.[variant] || {}
    normalizedVariants[variant] = {
      createdSets: finiteNonNegative(row.createdSets, `strategyVariants.${variant}.createdSets`),
      passedSets: finiteNonNegative(row.passedSets, `strategyVariants.${variant}.passedSets`),
      entriesCount: finiteNonNegative(row.entriesCount, `strategyVariants.${variant}.entriesCount`),
      positionsCount: finiteNonNegative(row.positionsCount, `strategyVariants.${variant}.positionsCount`),
      avgProfitFactor: finiteNonNegative(row.avgProfitFactor, `strategyVariants.${variant}.avgProfitFactor`),
      avgDrawdownTime: finiteNonNegative(row.avgDrawdownTime, `strategyVariants.${variant}.avgDrawdownTime`),
      passRate: finiteNonNegative(row.passRate, `strategyVariants.${variant}.passRate`),
    }
    if (normalizedVariants[variant].passRate > 100) {
      throw new Error(`strategyVariants.${variant}.passRate exceeds 100`)
    }
  }
  const variantPositionSum = VARIANT_NAMES.reduce(
    (sum, variant) => sum + normalizedVariants[variant].positionsCount,
    0,
  )
  if (normalizedVariants.overall.positionsCount !== variantPositionSum) {
    throw new Error(`Variant position total mismatch: ${normalizedVariants.overall.positionsCount} != ${variantPositionSum}`)
  }

  const coordination = stats?.mainCoordination || {}
  const allowedVariants = new Set(VARIANT_NAMES)
  for (const variant of coordination.activeVariants || []) {
    if (!allowedVariants.has(String(variant))) throw new Error(`Unknown active strategy variant: ${variant}`)
  }
  const axisWindows = coordination.axisWindows || {}
  for (const [axis, expectedMax] of Object.entries({ prev: 12, last: 4, cont: 8, pause: 8 })) {
    const rows = axisWindows?.[axis]
    if (!Array.isArray(rows) || rows.length !== expectedMax + 1) {
      throw new Error(`mainCoordination.axisWindows.${axis} does not expose 0..${expectedMax}`)
    }
    rows.forEach((row, index) => {
      if (Number(row?.window) !== index) throw new Error(`${axis}[${index}].window is ${row?.window}`)
      finiteNonNegative(row?.sets, `${axis}[${index}].sets`)
      finiteNonNegative(row?.pos, `${axis}[${index}].pos`)
    })
  }
  return {
    variants: normalizedVariants,
    // Overall can become ledger-backed as soon as `valid_positions_v2.overall`
    // exists, while the four per-variant counters deliberately remain on the
    // evaluation fallback until their subtotal covers that overall ledger.
    // Track the source of the values compared above, not the independent
    // overall source, so the one legitimate fallback -> confirmed transition
    // is recognized without masking any later counter regression.
    positionCountSource: String(
      realPositionStats?.strategyTypes?.default?.positionCountSource ||
      realPositionStats?.adjustTypes?.block?.positionCountSource ||
      "evaluation-fallback"
    ),
    mainCycles: finiteNonNegative(coordination.totalCycles, "mainCoordination.totalCycles"),
    mainReusedCycles: finiteNonNegative(
      coordination.reusedCycles,
      "mainCoordination.reusedCycles",
    ),
    // Full Main evaluations and Live-only cache hits are separate counters;
    // both are productive coordination activity, while only the former
    // rebuilds the expensive Base->Main->Real matrix.
    mainActivityCycles:
      finiteNonNegative(coordination.totalCycles, "mainCoordination.totalCycles") +
      finiteNonNegative(coordination.reusedCycles, "mainCoordination.reusedCycles"),
    mainCreated: finiteNonNegative(coordination.totalCreated, "mainCoordination.totalCreated"),
    mainReused: finiteNonNegative(coordination.totalReused, "mainCoordination.totalReused"),
    realActive: finiteNonNegative(stats?.openPositions?.real?.open, "openPositions.real.open"),
    realActiveAverage: finiteNonNegative(stats?.openPositions?.real?.activeAvg, "openPositions.real.activeAvg"),
    realActiveSamples: finiteNonNegative(stats?.openPositions?.real?.activeSamples, "openPositions.real.activeSamples"),
  }
}

function signalRuntimeSample(
  stats,
  settingsPayload,
  statusPayload,
  positionsPayload,
  indicationAnalytics,
  connectionId,
) {
  const settings = settingsPayload?.settings || {}
  const descriptors = Array.isArray(settingsPayload?.sources) ? settingsPayload.sources : []
  const configuredSources = settings?.sources && typeof settings.sources === "object"
    ? Object.entries(settings.sources)
    : []
  const connectionStatus = Array.isArray(statusPayload?.connections)
    ? statusPayload.connections.find((item) =>
      String(item?.connectionId ?? item?.id) === String(connectionId),
    ) || {}
    : {}
  const sourceHealth = Array.isArray(connectionStatus?.sourceHealth)
    ? connectionStatus.sourceHealth
    : []
  const performance = Array.isArray(connectionStatus?.performance)
    ? connectionStatus.performance
    : []
  const positions = Array.isArray(positionsPayload?.positions) ? positionsPayload.positions : []
  const terminalStatuses = new Set(["closed", "rejected", "error", "cancelled", "failed"])
  const signalPositions = positions.filter((position) => (
    String(position?.indicationType ?? position?.indication_type ?? "").toLowerCase() === "signal" ||
    Array.isArray(position?.signalRisk?.sourceIds)
  ))
  const openSignalPositions = signalPositions.filter(
    (position) => !terminalStatuses.has(String(position?.status || "").toLowerCase()),
  )
  const signalTrailingPositions = signalPositions.filter((position) => (
    String(position?.executionLane ?? position?.execution_lane ?? "") === "signal_trailing" ||
    String(position?.trailingProfile?.mode || "") === "signal_dynamic"
  ))
  const openSignalTrailingPositions = signalTrailingPositions.filter(
    (position) => !terminalStatuses.has(String(position?.status || "").toLowerCase()),
  )
  const blockRows = Array.isArray(
    stats?.strategyDetail?.real?.positionStats?.adjustTypes?.block?.scopedEvaluations,
  )
    ? stats.strategyDetail.real.positionStats.adjustTypes.block.scopedEvaluations
        .filter((row) => row?.laneKind === "signal_source")
    : []
  const sourceHealthRows = sourceHealth.map((row) => ({
    sourceId: String(row?.sourceId || ""),
    successes: finiteNonNegative(row?.successes, `signal.sourceHealth.${row?.sourceId}.successes`),
    failures: finiteNonNegative(row?.failures, `signal.sourceHealth.${row?.sourceId}.failures`),
    consecutiveFailures: finiteNonNegative(
      row?.consecutiveFailures,
      `signal.sourceHealth.${row?.sourceId}.consecutiveFailures`,
    ),
    lastCandleCount: finiteNonNegative(
      row?.lastCandleCount,
      `signal.sourceHealth.${row?.sourceId}.lastCandleCount`,
    ),
  }))
  const performanceRows = performance.map((row) => ({
    sourceId: String(row?.sourceId || ""),
    symbol: String(row?.symbol || ""),
    direction: String(row?.direction || ""),
    count: finiteNonNegative(row?.count, "signal.performance.count"),
    totalPnl: Number(row?.totalPnl || 0),
    profitFactor: finiteNonNegative(row?.profitFactor, "signal.performance.profitFactor"),
    autoDisabled: row?.autoDisabled === true,
  }))
  const blockSum = (field) => blockRows.reduce(
    (sum, row) => sum + finiteNonNegative(row?.[field], `signal.block.${field}`),
    0,
  )
  const analyticsWindows = indicationAnalytics?.signal?.windows || {}
  const analyticsRankings = indicationAnalytics?.signal?.rankings || {}
  const analyticsSources = Array.isArray(indicationAnalytics?.signal?.sources)
    ? indicationAnalytics.signal.sources
    : []
  const commonTypes = Array.isArray(indicationAnalytics?.common?.types)
    ? indicationAnalytics.common.types
    : []

  return {
    enabled: settings?.enabled === true,
    directExecutionEnabled: settings?.directExecutionEnabled === true,
    requestIntervalSeconds: finiteNonNegative(
      settings?.requestIntervalSeconds,
      "signal.settings.requestIntervalSeconds",
    ),
    maxSourcesPerCycle: finiteNonNegative(
      settings?.maxSourcesPerCycle,
      "signal.settings.maxSourcesPerCycle",
    ),
    maxPositionsTotal: finiteNonNegative(
      settings?.maxPositionsTotal,
      "signal.settings.maxPositionsTotal",
    ),
    positionSelectionMode: String(settings?.positionSelectionMode || ""),
    trailingEnabled: settings?.trailingEnabled === true,
    trailingOnly: settings?.trailingOnly === true,
    trailingStartPct: finiteNonNegative(settings?.trailingStartPct, "signal.settings.trailingStartPct"),
    trailingMinStopPct: finiteNonNegative(settings?.trailingMinStopPct, "signal.settings.trailingMinStopPct"),
    trailingPositiveMoveRatio: finiteNonNegative(
      settings?.trailingPositiveMoveRatio,
      "signal.settings.trailingPositiveMoveRatio",
    ),
    trailingUpdateStopRangeRatio: finiteNonNegative(
      settings?.trailingUpdateStopRangeRatio,
      "signal.settings.trailingUpdateStopRangeRatio",
    ),
    signalVolumeFactor: finiteNonNegative(
      settingsPayload?.signalVolumeFactor,
      "signal.settings.signalVolumeFactor",
    ),
    registeredSources: descriptors.length,
    configuredSources: configuredSources.length,
    enabledSources: configuredSources.filter(([, value]) => value?.enabled === true).length,
    sourceHealthCount: sourceHealthRows.length,
    sourcesExercised: sourceHealthRows.filter((row) => row.successes > 0).length,
    sourceSuccesses: sourceHealthRows.reduce((sum, row) => sum + row.successes, 0),
    sourceFailures: sourceHealthRows.reduce((sum, row) => sum + row.failures, 0),
    sourceConsecutiveFailures: sourceHealthRows.reduce((sum, row) => sum + row.consecutiveFailures, 0),
    signalIndicationsTotal: finiteNonNegative(
      stats?.breakdown?.indications?.signal,
      "signal.indications.total",
    ),
    signalIndicationsActive: finiteNonNegative(
      stats?.activeCounts?.indications?.signal,
      "signal.indications.active",
    ),
    signalSetsActive: finiteNonNegative(
      stats?.activeProgressing?.indications?.signal?.sets,
      "signal.activeProgressing.sets",
    ),
    signalTrackingsTotal: finiteNonNegative(
      stats?.activeProgressing?.indications?.signal?.trackings,
      "signal.activeProgressing.trackings",
    ),
    signalPositionSlotsActive: finiteNonNegative(
      stats?.activeProgressing?.indications?.signal?.positions,
      "signal.activeProgressing.positions",
    ),
    signalPositions: signalPositions.length,
    openSignalPositions: openSignalPositions.length,
    defaultSignalPositions: signalPositions.length - signalTrailingPositions.length,
    signalTrailingPositions: signalTrailingPositions.length,
    openSignalTrailingPositions: openSignalTrailingPositions.length,
    activeSignalTrailingStops: signalTrailingPositions.filter(
      (position) => position?.trailingActive === true || position?.trailing_active === true,
    ).length,
    signalBlockLaneRows: blockRows.length,
    signalBlockCalculated: blockSum("calculated"),
    signalBlockEvaluated: blockSum("evaluated"),
    signalBlockEligible: blockSum("eligible"),
    signalBlockEmitted: blockSum("emitted"),
    signalBlockActive: blockSum("active"),
    signalBlockDisabled: blockSum("disabled"),
    performanceLaneCount: performanceRows.length,
    performanceClosedSamples: performanceRows.reduce((sum, row) => sum + row.count, 0),
    performanceAutoDisabled: performanceRows.filter((row) => row.autoDisabled).length,
    analyticsClosedPositions: finiteNonNegative(
      indicationAnalytics?.signal?.counts?.closedPositions,
      "signal.analytics.closedPositions",
    ),
    analyticsOpenPositions: finiteNonNegative(
      indicationAnalytics?.signal?.counts?.openPositions,
      "signal.analytics.openPositions",
    ),
    analyticsSourceCount: analyticsSources.length,
    analyticsSourceSymbolRows: analyticsSources.reduce(
      (sum, source) => sum + (Array.isArray(source?.symbols) ? source.symbols.length : 0),
      0,
    ),
    analyticsCommonTypeCount: commonTypes.length,
    sourcePerformanceLookback: finiteNonNegative(
      indicationAnalytics?.signal?.settings?.sourcePerformanceLookback,
      "signal.analytics.sourcePerformanceLookback",
    ),
    lanePerformanceLookback: finiteNonNegative(
      indicationAnalytics?.signal?.settings?.lanePerformanceLookback,
      "signal.analytics.lanePerformanceLookback",
    ),
    analyticsWindowTrades: Object.fromEntries(
      ["positions12", "positions50", "hours8", "hours48"].map((window) => [
        window,
        finiteNonNegative(analyticsWindows?.[window]?.trades, `signal.analytics.${window}.trades`),
      ]),
    ),
    analyticsRankingRows: Object.fromEntries(
      ["positions12", "positions50", "hours8", "hours48"].map((window) => [
        window,
        {
          top: Array.isArray(analyticsRankings?.[window]?.top)
            ? analyticsRankings[window].top.length
            : 0,
          worst: Array.isArray(analyticsRankings?.[window]?.worst)
            ? analyticsRankings[window].worst.length
            : 0,
        },
      ]),
    ),
    sourceHealth: sourceHealthRows,
    performance: performanceRows,
  }
}

function assertPositionQuantityIntegrity(position, executionProgress) {
  const label = `position ${position?.id || "unknown"}`
  const executed = finiteNonNegative(position?.executedQuantity, `${label}.executedQuantity`)
  const total = finiteNonNegative(position?.totalExecutedQuantity ?? executed, `${label}.totalExecutedQuantity`)
  const closed = finiteNonNegative(position?.closedQuantity, `${label}.closedQuantity`)
  const openQuantity = position?.status === "closed" ? 0 : executed
  if (total + 1e-10 < openQuantity + closed) {
    throw new Error(`${label} total quantity ${total} is smaller than open+closed ${openQuantity + closed}`)
  }

  if (position?.combinedPosCounts) {
    const allocations = position?.posCountsSetQuantities || {}
    const allocationTotal = Object.values(allocations).reduce((sum, value) => (
      sum + finiteNonNegative(value, `${label}.posCountsSetQuantities`)
    ), 0)
    const expectedOpen = openQuantity
    if (Math.abs(allocationTotal - expectedOpen) > Math.max(1e-10, expectedOpen * 1e-8)) {
      throw new Error(`${label} Set allocation ${allocationTotal} != open quantity ${expectedOpen}`)
    }
    const ratioKeys = Object.keys(position?.posCountsSetRatios || {})
    const memberKeys = Array.from(new Set((position?.accumulatedSetKeys || []).map(String)))
    if (ratioKeys.some((key) => !memberKeys.includes(key))) {
      throw new Error(`${label} has a ratio for a Set outside accumulatedSetKeys`)
    }
  }

  for (const execution of position?.partialOrderExecutions || []) {
    const id = String(execution?.id || "")
    if (!id) throw new Error(`${label} has a partial execution without stable id`)
    const cumulative = finiteNonNegative(execution.cumulativeFilledQuantity, `${label}.${id}.cumulative`)
    const prior = executionProgress.get(id) || 0
    if (cumulative + 1e-12 < prior) throw new Error(`${label}.${id} cumulative fill regressed ${prior} -> ${cumulative}`)
    executionProgress.set(id, cumulative)
    const before = finiteNonNegative(execution.positionQuantityBefore, `${label}.${id}.before`)
    const after = finiteNonNegative(execution.positionQuantityAfter, `${label}.${id}.after`)
    if (after > before + 1e-10) throw new Error(`${label}.${id} reduction increased quantity`)
    const afterParts = Object.values(execution.setQuantities || {}).reduce((sum, value) => sum + Number(value || 0), 0)
    if (Math.abs(afterParts - after) > Math.max(1e-10, after * 1e-8)) {
      throw new Error(`${label}.${id} part quantities ${afterParts} != ${after}`)
    }
    if (execution.setQuantityDeltas) {
      const deltaParts = Object.values(execution.setQuantityDeltas).reduce((sum, value) => sum + Number(value || 0), 0)
      if (Math.abs(deltaParts - (after - before)) > Math.max(1e-10, before * 1e-8)) {
        throw new Error(`${label}.${id} part deltas ${deltaParts} != physical delta ${after - before}`)
      }
    }
  }
}

async function main() {
  if (SIGNAL_FOCUSED_SOAK && !VERIFY_SIGNAL_ENGINE) {
    throw new Error("SIGNAL_FOCUSED_SOAK requires VERIFY_SIGNAL_ENGINE=1")
  }
  const inventory = (await request("/api/connections")).json
  const availableConnections = Array.isArray(inventory?.connections) ? inventory.connections : []
  const selectedConnection = REQUESTED_CONNECTION_ID
    ? availableConnections.find((connection) => String(connection?.id) === REQUESTED_CONNECTION_ID)
    : availableConnections[0]
  let connectionId = String(selectedConnection?.id || "")
  if (!connectionId) {
    throw new Error(
      REQUESTED_CONNECTION_ID
        ? `Requested production soak connection ${REQUESTED_CONNECTION_ID} is unavailable`
        : "No connection available for production soak",
    )
  }

  if (START_SIMULATED_ENGINE) {
    const quickStart = (await request("/api/trade-engine/quick-start", {
      method: "POST",
      // Explicit paper mode is essential: missing credentials must remain a
      // hard block for requested live trading, while this bounded harness must
      // exercise order/position lifecycle without touching an exchange.
      body: {
        action: "enable",
        connectionId,
        symbolCount: SYMBOLS.length,
        symbols: SYMBOLS,
        liveTrade: false,
        is_live_trade: false,
        // The normal Real-stage defaults intentionally require a longer
        // position-history warmup than this bounded smoke. Mirror the fresh
        // live-QuickStart bootstrap thresholds inside the isolated snapshot so
        // Base -> Main -> Real -> Live/paper is exercised within one minute.
        baseProfitFactor: 1,
        mainProfitFactor: 1,
        realProfitFactor: 1,
        prevPosMinCount: 1,
        mainEvalPosCount: 1,
        realEvalPosCount: 1,
      },
      timeoutMs: 120_000,
    })).json
    connectionId = String(quickStart?.connection?.id || connectionId)
    const configuredSymbols = Array.isArray(quickStart?.connection?.symbols)
      ? quickStart.connection.symbols.map(String)
      : []
    if (configuredSymbols.length !== SYMBOLS.length || configuredSymbols.some((symbol, index) => symbol !== SYMBOLS[index])) {
      throw new Error(`QuickStart did not preserve the requested ${SYMBOLS.length}-symbol set`)
    }
    if (quickStart?.connection?.liveTradeRequested !== false || quickStart?.connection?.liveTradeEnabled !== false) {
      throw new Error("Safe soak unexpectedly enabled live exchange trading")
    }

    // QuickStart already performs the one targeted start for `connectionId`.
    // Do not call start-all here: it starts unrelated assigned engines and
    // then force-takes over this very engine, resetting its historic/main
    // hand-off while the verifier is about to measure it. This fixture must
    // validate the requested connection, not mutate global fleet ownership.
    // Wait until that targeted engine publishes the exact configured basket.
    const inventoryDeadline = Date.now() + 120_000
    let lastInventory = ""
    while (Date.now() < inventoryDeadline) {
      const status = (await request("/api/trade-engine/status-all", {
        timeoutMs: 60_000,
      })).json
      const active = Array.isArray(status?.engines)
        ? status.engines.find((entry) => String(entry?.connectionId) === connectionId)
        : null
      const symbols = Array.isArray(active?.engineStatus?.symbols)
        ? active.engineStatus.symbols.map(String)
        : []
      lastInventory = JSON.stringify({
        engine: Boolean(active),
        running: active?.isRunning,
        symbols,
      })
      if (
        active &&
        symbols.length === SYMBOLS.length &&
        symbols.every((symbol, index) => symbol === SYMBOLS[index])
      ) {
        break
      }
      await sleep(500)
    }
    const readyStatus = (await request("/api/trade-engine/status-all", {
      timeoutMs: 60_000,
    })).json
    const readyEngine = Array.isArray(readyStatus?.engines)
      ? readyStatus.engines.find((entry) => String(entry?.connectionId) === connectionId)
      : null
    const readySymbols = Array.isArray(readyEngine?.engineStatus?.symbols)
      ? readyEngine.engineStatus.symbols.map(String)
      : []
    if (
      !readyEngine ||
      readySymbols.length !== SYMBOLS.length ||
      readySymbols.some((symbol, index) => symbol !== SYMBOLS[index])
    ) {
      throw new Error(`Engine did not publish the exact ${SYMBOLS.length}-symbol basket: ${lastInventory}`)
    }

    if (VERIFY_SIGNAL_ENGINE) {
      const current = (await request(
        `/api/settings/indications/signal?connectionId=${encodeURIComponent(connectionId)}`,
        { timeoutMs: 120_000 },
      )).json
      const currentSources = current?.settings?.sources && typeof current.settings.sources === "object"
        ? current.settings.sources
        : {}
      const enabledSources = Object.fromEntries(
        Object.entries(currentSources).map(([sourceId, source]) => [
          sourceId,
          { ...(source || {}), enabled: true },
        ]),
      )
      const applied = (await request("/api/settings/indications/signal", {
        method: "POST",
        body: {
          settings: {
            ...(current?.settings || {}),
            enabled: true,
            directExecutionEnabled: true,
            requestIntervalSeconds: 30,
            maxPositionsTotal: SIGNAL_MAX_POSITIONS_TOTAL,
            positionSelectionMode: "best_first",
            trailingEnabled: true,
            trailingOnly: false,
            trailingStartPct: 0,
            trailingMinStopPct: 0.8,
            trailingPositiveMoveRatio: 0.4,
            trailingUpdateStopRangeRatio: 0.5,
            sources: enabledSources,
          },
          signalVolumeFactor: Number(current?.signalVolumeFactor || 1),
        },
        timeoutMs: 120_000,
      })).json
      if (
        applied?.success !== true ||
        applied?.settings?.enabled !== true ||
        applied?.settings?.directExecutionEnabled !== true ||
        Number(applied?.settings?.requestIntervalSeconds) !== 30 ||
        Number(applied?.settings?.maxPositionsTotal) !== SIGNAL_MAX_POSITIONS_TOTAL ||
        applied?.settings?.positionSelectionMode !== "best_first" ||
        applied?.settings?.trailingEnabled !== true ||
        applied?.settings?.trailingOnly !== false ||
        Number(applied?.settings?.trailingStartPct) !== 0 ||
        Number(applied?.settings?.trailingMinStopPct) !== 0.8 ||
        Number(applied?.settings?.trailingPositiveMoveRatio) !== 0.4 ||
        Number(applied?.settings?.trailingUpdateStopRangeRatio) !== 0.5
      ) {
        throw new Error(`Signal runtime settings were not applied atomically: ${JSON.stringify(applied)}`)
      }
      const disabled = (await request("/api/statistics/indications", {
        method: "PATCH",
        body: {
          sourceId: "binance-usdm",
          symbol: "BTCUSDT",
          enabled: false,
        },
        timeoutMs: 120_000,
      })).json
      if (
        disabled?.success !== true ||
        !Array.isArray(disabled?.disabledSymbols) ||
        !disabled.disabledSymbols.includes("BTCUSDT")
      ) {
        throw new Error(`Signal source-symbol disable was not applied: ${JSON.stringify(disabled)}`)
      }
      const disabledSnapshot = (await request(
        `/api/statistics/indications?connectionId=${encodeURIComponent(connectionId)}`,
        { timeoutMs: 120_000 },
      )).json
      const disabledSource = disabledSnapshot?.signal?.sources?.find(
        (source) => source?.id === "binance-usdm",
      )
      const disabledSymbol = disabledSource?.symbols?.find(
        (symbol) => symbol?.symbol === "BTCUSDT",
      )
      if (disabledSymbol?.disabled !== true) {
        throw new Error("Signal analytics did not expose the persisted source-symbol disable state")
      }
      const reenabled = (await request("/api/statistics/indications", {
        method: "PATCH",
        body: {
          sourceId: "binance-usdm",
          symbol: "BTCUSDT",
          enabled: true,
        },
        timeoutMs: 120_000,
      })).json
      if (
        reenabled?.success !== true ||
        reenabled?.disabledSymbols?.includes("BTCUSDT")
      ) {
        throw new Error(`Signal source-symbol re-enable was not applied: ${JSON.stringify(reenabled)}`)
      }
    }

    const [connectionSettings, globalSettings] = await Promise.all([
      request(
        `/api/settings/connections/${encodeURIComponent(connectionId)}/settings`,
        { timeoutMs: 120_000 },
      ),
      request("/api/settings", { timeoutMs: 120_000 }),
    ])
    const stored = connectionSettings.json?.settings || {}
    const coordination = stored.coordination_settings || stored.coordinationSettings || {}
    const posCountsRatio = Number(stored.posCountsVolumeRatio ?? coordination.posCountsVolumeRatio)
    const positionCost = Number(globalSettings.json?.settings?.positionCost)
    if (posCountsRatio !== 3) {
      throw new Error(`Position-count volume ratio default is ${posCountsRatio}, expected 3`)
    }
    if (positionCost !== 0.1) {
      throw new Error(`System positionCost default is ${positionCost}, expected 0.1%`)
    }
  }

  const livePositionsPath =
    `/api/trading/live-positions?connection_id=${encodeURIComponent(connectionId)}&closedLimit=500`
  const endpointSchedules = [
    // Match the actual independent UI consumers instead of synchronously
    // hammering every route on the verifier's two-second bookkeeping cadence.
    // The first round still samples the complete surface and the last
    // validated payload remains authoritative between scheduled refreshes.
    // These periods mirror the shipped dashboard/live/logistics fallbacks;
    // SSE-triggered refreshes are exercised independently by lifecycle events.
    { build: () => "/api/health", intervalMs: 15_000 },
    { build: () => "/api/system/init-status", intervalMs: 60_000 },
    { build: () => "/api/system/status", intervalMs: 15_000 },
    { build: () => "/api/system/monitoring", intervalMs: 45_000 },
    { build: () => "/api/trade-engine/status-all", intervalMs: 8_000 },
    { build: () => "/api/indications/config-counts", intervalMs: 60_000 },
    // Sample progression more often than the UI's 15-second safety poll so
    // three complete Main cycles and monotonic counters remain well observed.
    { build: () => `/api/connections/progression/${encodeURIComponent(connectionId)}/stats`, intervalMs: 5_000 },
    { build: () => `/api/trading/trade-history?connection_id=${encodeURIComponent(connectionId)}&limit=500`, intervalMs: 30_000 },
    { build: () => `/api/logistics/queue?connectionId=${encodeURIComponent(connectionId)}`, intervalMs: 15_000 },
    { build: () => livePositionsPath, intervalMs: 10_000 },
    { build: () => `/api/preset-optimizer?connectionId=${encodeURIComponent(connectionId)}`, intervalMs: 60_000 },
    { build: () => `/api/connections/${encodeURIComponent(connectionId)}/engine-states`, intervalMs: 15_000 },
  ]
  // Signal settings, source health, and closed-position PF/DDT analytics change
  // on the Signal engine cadence (minimum 30 seconds), not on the 2-second
  // operational heartbeat. Polling these full snapshots in the same Promise.all
  // fan-out as every health endpoint can block the dev event loop and measures
  // self-inflicted request contention instead of the continuously running
  // engine. Observe them sequentially at their real update cadence while the
  // core runtime endpoints remain under the unchanged high-frequency load.
  const signalEndpointBuilders = [
    () => `/api/settings/indications/signal?connectionId=${encodeURIComponent(connectionId)}`,
    () => `/api/indications/signals/status?connectionId=${encodeURIComponent(connectionId)}`,
    () => `/api/statistics/indications?connectionId=${encodeURIComponent(connectionId)}`,
    () => `/api/trade-engine/detailed-logs?connectionId=${encodeURIComponent(connectionId)}`,
  ]

  // Settings writes above can legitimately schedule a historic recoordination.
  // Begin the measured soak only once the *targeted* engine has published its
  // first real Main cycle for the exact basket. This distinguishes a bounded
  // cold-start from a stuck engine and prevents unrelated global starts from
  // being mistaken for a Main-cycle regression.
  const bootstrapWaitStartedAt = Date.now()
  const bootstrapReadyDeadline = bootstrapWaitStartedAt + BOOTSTRAP_READY_TIMEOUT_MS
  let bootstrapReady = !START_SIMULATED_ENGINE
  let bootstrapDiagnostic = "not required"
  while (!bootstrapReady && Date.now() < bootstrapReadyDeadline) {
    const [statusResponse, statsResponse] = await Promise.all([
      requestWithRetry("/api/trade-engine/status-all", { timeoutMs: 120_000 }),
      requestWithRetry(
        `/api/connections/progression/${encodeURIComponent(connectionId)}/stats`,
        { timeoutMs: 120_000 },
      ),
    ])
    const engine = Array.isArray(statusResponse.json?.engines)
      ? statusResponse.json.engines.find((entry) => String(entry?.connectionId) === connectionId)
      : null
    const activeSymbols = Array.isArray(engine?.engineStatus?.symbols)
      ? engine.engineStatus.symbols.map(String)
      : []
    const main = strategyRuntimeSample(statsResponse.json)
    const historic = progressionSample(statsResponse.json)
    const exactBasket =
      activeSymbols.length === SYMBOLS.length &&
      activeSymbols.every((symbol, index) => symbol === SYMBOLS[index])
    const historicComplete =
      historic.historicSymbols === SYMBOLS.length &&
      historic.historicTotal === SYMBOLS.length
    bootstrapDiagnostic = JSON.stringify({
      running: engine?.isEngineRunning === true,
      exactBasket,
      activeSymbols: activeSymbols.length,
      historic: `${historic.historicSymbols}/${historic.historicTotal}`,
      mainCycles: main.mainCycles,
      mainCreated: main.mainCreated,
      mainReused: main.mainReused,
      phase: statsResponse.json?.phase || statsResponse.json?.metadata?.phase || "",
    })
    bootstrapReady = engine?.isEngineRunning === true && exactBasket && historicComplete && main.mainCycles >= 1
    if (!bootstrapReady) await sleep(1_000)
  }
  if (!bootstrapReady) {
    throw new Error(
      `Targeted Main engine did not become productive within ${BOOTSTRAP_READY_TIMEOUT_MS}ms: ${bootstrapDiagnostic}`,
    )
  }
  const bootstrapReadyWaitMs = Date.now() - bootstrapWaitStartedAt

  const startedAt = Date.now()
  const progression = []
  const memory = []
  const siteIds = new Set()
  const bootIds = new Set()
  const latencies = []
  const steadyLatencies = []
  const latencyByPath = new Map()
  const signalLatencies = []
  const steadySignalLatencies = []
  const liveExecution = []
  const strategyRuntime = []
  const signalRuntime = []
  const detailedMonitorRuntime = []
  const positionLifecycle = new Map()
  const lifecycleTerminalStatuses = new Set([
    "closed",
    "rejected",
    "error",
    "cancelled",
    "canceled",
    "failed",
  ])
  const executionProgress = new Map()
  let simulatedPositionsPeak = 0
  let realPositionsPeak = 0
  let paperPositionsPeak = 0
  let paperRunningSetsPeak = 0
  let paperUpdateCyclesPeak = 0
  let rounds = 0
  let requests = 0
  let signalObservationRequests = 0
  let lastSignalObservationAt = 0
  let signalObservation = new Map()
  let lastByPath = new Map()
  const lastEndpointObservationAt = new Map()

  const recordLatency = (path, latencyMs) => {
    const values = latencyByPath.get(path) || []
    values.push(latencyMs)
    latencyByPath.set(path, values)
  }

  const productiveRequirementsMet = () => {
    if (!START_SIMULATED_ENGINE || progression.length === 0 || strategyRuntime.length === 0) return !START_SIMULATED_ENGINE
    const firstMainActivityCycles = strategyRuntime[0]?.mainActivityCycles || 0
    const finalMainActivityCycles = strategyRuntime.at(-1)?.mainActivityCycles || 0
    const finalProgression = progression.at(-1)
    return (
      finalMainActivityCycles - firstMainActivityCycles >= MIN_PRODUCTIVE_CYCLES
      && finalProgression?.historicSymbols === SYMBOLS.length
      && finalProgression?.historicTotal === SYMBOLS.length
    )
  }

  const refreshSignalObservation = async (recordAsSteady) => {
    if (!VERIFY_SIGNAL_ENGINE) return
    for (const build of signalEndpointBuilders) {
      const path = build()
      // Signal observations are diagnostic reads. A single socket reset during
      // a stop-the-world GC or a development server hand-off must not erase a
      // fully accumulated long-soak sample; persistent failures still exhaust
      // the bounded retry budget and fail the run.
      const response = await requestWithRetry(path)
      if (path.startsWith("/api/trade-engine/detailed-logs")) {
        detailedMonitorRuntime.push(detailedMonitorSample(response.json, connectionId, true))
      }
      signalObservation.set(path, response.json)
      requests++
      signalObservationRequests++
      latencies.push(response.latencyMs)
      recordLatency(path, response.latencyMs)
      signalLatencies.push(response.latencyMs)
      if (recordAsSteady) {
        steadyLatencies.push(response.latencyMs)
        steadySignalLatencies.push(response.latencyMs)
      }
    }
    lastSignalObservationAt = Date.now()
  }

  const baseDeadline = startedAt + DURATION_MS
  const hardDeadline = baseDeadline + PRODUCTIVE_COMPLETION_GRACE_MS
  while (
    Date.now() < baseDeadline
    || (Date.now() < hardDeadline && !productiveRequirementsMet())
  ) {
    const roundStarted = Date.now()
    const observationNow = Date.now()
    const scheduledEndpoints = endpointSchedules.filter(({ build, intervalMs }) => {
      const path = build()
      const previous = lastEndpointObservationAt.get(path) || 0
      return previous === 0 || intervalMs === 0 || observationNow - previous >= intervalMs
    })
    const paths = scheduledEndpoints.map(({ build }) => build())
    // Keep endpoint identity when a saturated runtime rejects one request.
    // `Promise.all()` only reports the first array index, which made a broad
    // dispatcher stall look like a health-route bug and hid the actual busy
    // route. Settling the same concurrent fan-out preserves the load shape
    // while giving the recovery review a precise failure set.
    // Keep the concurrent pressure shape, but tolerate a bounded transient
    // transport reset. Next development and a memory-pressured production
    // worker can close existing keep-alive sockets during GC/restart hand-off;
    // retrying the same read proves recovery while three consecutive failures
    // still surface as a hard availability error.
    const settledResponses = await Promise.allSettled(
      paths.map((path) => requestWithRetry(path)),
    )
    const endpointFailures = settledResponses
      .map((result, index) => result.status === "rejected"
        ? `${paths[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        : null)
      .filter(Boolean)
    if (endpointFailures.length > 0) {
      throw new Error(`Endpoint failures in soak round ${rounds + 1}: ${endpointFailures.join(" | ")}`)
    }
    const responses = settledResponses.map((result) => {
      if (result.status !== "fulfilled") throw new Error("unreachable settled response")
      return result.value
    })
    rounds++
    requests += responses.length
    latencies.push(...responses.map((response) => response.latencyMs))
    responses.forEach((response, index) => recordLatency(paths[index], response.latencyMs))
    // Exclude the first five rounds from the steady-state latency contract.
    // Next dev compiles route chunks on first access and production performs
    // cold initialization/migration reads; neither is representative of the
    // continuously running API/order coordination hot path.
    if (rounds > 5) steadyLatencies.push(...responses.map((response) => response.latencyMs))

    const byPath = new Map(lastByPath)
    paths.forEach((path, index) => {
      byPath.set(path, responses[index].json)
      // Browser fallback timers are scheduled after their individual request
      // completes. Recording one shared pre-fan-out timestamp made every
      // independent dashboard consumer re-converge on the same wall-clock
      // boundary, creating an artificial 12-route burst once per common
      // interval. Preserve the initial mount fan-out, then let actual response
      // completion times establish the same naturally staggered phases as the
      // shipped UI.
      lastEndpointObservationAt.set(path, responses[index].completedAt)
    })
    if (
      VERIFY_SIGNAL_ENGINE &&
      (
        signalObservation.size === 0 ||
        Date.now() - lastSignalObservationAt >= SIGNAL_OBSERVATION_INTERVAL_MS
      )
    ) {
      await refreshSignalObservation(rounds > 5)
    }
    for (const [path, payload] of signalObservation) byPath.set(path, payload)
    lastByPath = byPath
    const init = byPath.get("/api/system/init-status")
    if (!init?.ready || init?.system?.startup?.status !== "ready") throw new Error("Startup lost readiness during soak")
    if (Number(init?.migrations?.current_version) !== Number(init?.migrations?.latest_version)) {
      throw new Error("Migration state regressed during soak")
    }
    siteIds.add(init?.system?.site_instance_id)
    bootIds.add(init?.system?.startup?.boot_id)

    const stats = byPath.get(`/api/connections/progression/${encodeURIComponent(connectionId)}/stats`)
    const sample = progressionSample(stats)
    if (sample.historicTotal > 0 && sample.historicTotal !== SYMBOLS.length) {
      throw new Error(`Historic denominator drifted from the selected basket: ${sample.historicTotal}/${SYMBOLS.length}`)
    }
    if (sample.historicTotal > 0 && sample.historicSymbols > sample.historicTotal) {
      throw new Error(`Historic processed count exceeds total: ${sample.historicSymbols}/${sample.historicTotal}`)
    }
    const expectedHistoricPercent = sample.historicTotal > 0
      ? Math.min(100, Math.round((sample.historicSymbols / sample.historicTotal) * 100))
      : 0
    if (sample.historicPercent !== expectedHistoricPercent) {
      throw new Error(
        `Historic percent disagrees with current coverage: ` +
        `${sample.historicPercent}% != ${sample.historicSymbols}/${sample.historicTotal} (${expectedHistoricPercent}%)`,
      )
    }
    if (sample.baseEvaluated > 0 && sample.base > sample.baseEvaluated) {
      throw new Error(`Base output exceeds its evaluated pool: ${sample.base} > ${sample.baseEvaluated}`)
    }
    if (sample.mainEvaluated > 0 && sample.main > sample.mainEvaluated) {
      throw new Error(`Main output exceeds its evaluated pool: ${sample.main} > ${sample.mainEvaluated}`)
    }
    // The headline Real "active" count is intentionally lineage-collapsed
    // while Live counts exact mirrored execution rows, so Live may be larger.
    // The row contract itself must remain bounded: mirrored Live rows can
    // never exceed the complete Real input presented to Live.
    const strategyRows = stats?.strategyRows || {}
    const liveRowTotal = finiteNonNegative(strategyRows?.live?.total, "strategyRows.live.total")
    const liveRowMirrored = finiteNonNegative(strategyRows?.live?.mirrored, "strategyRows.live.mirrored")
    if (liveRowMirrored > liveRowTotal) {
      throw new Error(`Live mirrored row exceeds its Real-row input: ${liveRowMirrored} > ${liveRowTotal}`)
    }
    if (sample.real > sample.realEvaluated && sample.realEvaluated > 0) {
      throw new Error(`Real output exceeds its evaluated pool: ${sample.real} > ${sample.realEvaluated}`)
    }
    for (const [stage, value] of Object.entries(stats?.stageEvalPercent || {})) {
      const percent = Number(value)
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        throw new Error(`stageEvalPercent.${stage} is invalid: ${value}`)
      }
    }
    const previousSample = progression.at(-1)
    if (previousSample && sample.historicCycles < previousSample.historicCycles) {
      throw new Error(`Historic cycles regressed: ${previousSample.historicCycles} → ${sample.historicCycles}`)
    }
    if (previousSample && sample.realtimeCycles < previousSample.realtimeCycles) {
      throw new Error(`Realtime cycles regressed: ${previousSample.realtimeCycles} → ${sample.realtimeCycles}`)
    }
    progression.push(sample)
    const runtimeSample = strategyRuntimeSample(stats)
    const previousRuntime = strategyRuntime.at(-1)
    if (previousRuntime && runtimeSample.mainCycles < previousRuntime.mainCycles) {
      throw new Error(`Main strategy cycles regressed: ${previousRuntime.mainCycles} -> ${runtimeSample.mainCycles}`)
    }
    if (previousRuntime && runtimeSample.mainReusedCycles < previousRuntime.mainReusedCycles) {
      throw new Error(
        `Main reused cycles regressed: ${previousRuntime.mainReusedCycles} -> ` +
        `${runtimeSample.mainReusedCycles}`,
      )
    }
    for (const variant of [...VARIANT_NAMES, "overall"]) {
      for (const field of ["createdSets", "passedSets", "entriesCount", "positionsCount"]) {
        const confirmedLedgerJustBecameAuthoritative =
          field === "positionsCount" &&
          previousRuntime?.positionCountSource !== "confirmed-ledger" &&
          runtimeSample.positionCountSource === "confirmed-ledger"
        if (
          previousRuntime &&
          runtimeSample.variants[variant][field] < previousRuntime.variants[variant][field] &&
          !confirmedLedgerJustBecameAuthoritative
        ) {
          throw new Error(`strategyVariants.${variant}.${field} regressed`)
        }
      }
    }
    strategyRuntime.push(runtimeSample)

    const engineInventory = byPath.get("/api/trade-engine/status-all")
    const engine = Array.isArray(engineInventory?.engines)
      ? engineInventory.engines.find((entry) => String(entry?.connectionId) === connectionId)
      : null
    const activeSymbols = Array.isArray(engine?.engineStatus?.symbols) ? engine.engineStatus.symbols.map(String) : []
    if (!engine || activeSymbols.length !== SYMBOLS.length || activeSymbols.some((symbol, index) => symbol !== SYMBOLS[index])) {
      throw new Error(
        `Engine is not coordinating the exact ${SYMBOLS.length}-symbol set: ` +
        JSON.stringify({
          foundEngine: Boolean(engine),
          activeSymbols,
          expectedSymbols: SYMBOLS,
          status: engine?.engineStatus?.status,
          running: engine?.isEngineRunning,
        }),
      )
    }
    if (engine?.isLiveTrading !== false) throw new Error("Engine status reports live trading during safe paper soak")

    const positions = byPath.get(livePositionsPath)
    if (!Array.isArray(positions?.realPositions) || !Array.isArray(positions?.simulatedPositions)) {
      throw new Error("Live-position API schema failed during soak")
    }
    if (positions?.dataIntegrity?.liveExecutionMode !== "simulation" || positions?.dataIntegrity?.liveTradeRequested !== false) {
      throw new Error("Live-position API left explicit simulation mode during soak")
    }
    const currentPositionIds = new Set()
    for (const position of positions.positions || []) {
      const id = String(position?.id || "")
      if (!id) throw new Error("Live-position API returned a position without id")
      currentPositionIds.add(id)
      assertPositionQuantityIntegrity(position, executionProgress)
      const previous = positionLifecycle.get(id)
      if (
        previous &&
        lifecycleTerminalStatuses.has(String(previous.status || "").toLowerCase()) &&
        !lifecycleTerminalStatuses.has(String(position.status || "").toLowerCase())
      ) {
        throw new Error(`Terminal position ${id} reopened (${previous.status} -> ${position.status})`)
      }
      positionLifecycle.set(id, { status: position.status, lastSeenRound: rounds })
    }
    const disappearedActivePositionIds = []
    for (const [id, previous] of positionLifecycle) {
      if (
        !lifecycleTerminalStatuses.has(String(previous.status || "").toLowerCase()) &&
        previous.lastSeenRound < rounds &&
        !currentPositionIds.has(id)
      ) {
        disappearedActivePositionIds.push(id)
      }
    }
    // The overview intentionally exposes a bounded terminal-history ring.
    // Under exhaustive high-load processing a row can close and leave that
    // page between polls. Resolve the exact durable record before treating
    // its absence from the overview as lifecycle loss.
    for (const id of disappearedActivePositionIds) {
      const detail = (await request(
        `/api/positions/${encodeURIComponent(id)}?connection_id=${encodeURIComponent(connectionId)}`,
      )).json
      const terminalStatus = String(detail?.data?.status || "").toLowerCase()
      if (!lifecycleTerminalStatuses.has(terminalStatus)) {
        throw new Error(
          `Active position ${id} disappeared without a terminal record ` +
          `(detail status=${terminalStatus || "missing"})`,
        )
      }
      positionLifecycle.set(id, { status: terminalStatus, lastSeenRound: rounds })
    }
    realPositionsPeak = Math.max(realPositionsPeak, positions.realPositions.length)
    simulatedPositionsPeak = Math.max(simulatedPositionsPeak, positions.simulatedPositions.length)
    if (realPositionsPeak > 0 || Number(positions?.counts?.real || 0) > 0) {
      throw new Error("A real exchange position appeared during safe paper soak")
    }
    liveExecution.push({
      ordersSimulated: finiteNonNegative(stats?.liveExecution?.ordersSimulated, "liveExecution.ordersSimulated"),
      ordersPlaced: finiteNonNegative(stats?.liveExecution?.ordersPlaced, "liveExecution.ordersPlaced"),
      ordersFilled: finiteNonNegative(stats?.liveExecution?.ordersFilled, "liveExecution.ordersFilled"),
      positionsCreated: finiteNonNegative(stats?.liveExecution?.positionsCreated, "liveExecution.positionsCreated"),
      positionsClosed: finiteNonNegative(stats?.liveExecution?.positionsClosed, "liveExecution.positionsClosed"),
      simulatedPositionsCreated: finiteNonNegative(
        stats?.liveExecution?.simulatedPositionsCreated,
        "liveExecution.simulatedPositionsCreated",
      ),
      simulatedPositionsClosed: finiteNonNegative(
        stats?.liveExecution?.simulatedPositionsClosed,
        "liveExecution.simulatedPositionsClosed",
      ),
    })
    paperPositionsPeak = Math.max(
      paperPositionsPeak,
      finiteNonNegative(stats?.openPositions?.pseudo?.open, "openPositions.pseudo.open"),
    )
    paperRunningSetsPeak = Math.max(
      paperRunningSetsPeak,
      finiteNonNegative(stats?.openPositions?.pseudo?.runningSets, "openPositions.pseudo.runningSets"),
    )
    paperUpdateCyclesPeak = Math.max(
      paperUpdateCyclesPeak,
      finiteNonNegative(stats?.realtime?.pseudoPositionUpdates?.updateCycles, "realtime.pseudoPositionUpdates.updateCycles"),
    )
    const signalSample = signalRuntimeSample(
      stats,
      byPath.get(`/api/settings/indications/signal?connectionId=${encodeURIComponent(connectionId)}`),
      byPath.get(`/api/indications/signals/status?connectionId=${encodeURIComponent(connectionId)}`),
      positions,
      byPath.get(`/api/statistics/indications?connectionId=${encodeURIComponent(connectionId)}`),
      connectionId,
    )
    const previousSignalSample = signalRuntime.at(-1)
    if (
      VERIFY_SIGNAL_ENGINE &&
      signalSample.openSignalPositions > signalSample.maxPositionsTotal
    ) {
      throw new Error(
        `Signal position capacity exceeded: ` +
        `${signalSample.openSignalPositions}/${signalSample.maxPositionsTotal}`,
      )
    }
    if (
      VERIFY_SIGNAL_ENGINE &&
      previousSignalSample &&
      signalSample.signalIndicationsTotal < previousSignalSample.signalIndicationsTotal
    ) {
      throw new Error(
        `Signal indication count regressed: ` +
        `${previousSignalSample.signalIndicationsTotal} -> ${signalSample.signalIndicationsTotal}`,
      )
    }
    if (
      VERIFY_SIGNAL_ENGINE &&
      previousSignalSample &&
      signalSample.sourceSuccesses < previousSignalSample.sourceSuccesses
    ) {
      throw new Error(
        `Signal source-success count regressed: ` +
        `${previousSignalSample.sourceSuccesses} -> ${signalSample.sourceSuccesses}`,
      )
    }
    signalRuntime.push(signalSample)

    const history = byPath.get(`/api/trading/trade-history?connection_id=${encodeURIComponent(connectionId)}&limit=500`)
    if (!history?.success || !Array.isArray(history.rows) || history.rows.length > 500) {
      throw new Error("Trade history bounds/schema failed during soak")
    }
    for (const key of ["wins", "losses", "netPnl", "winRate"]) {
      if (!Number.isFinite(Number(history?.summary?.[key] ?? 0))) throw new Error(`Trade history ${key} is invalid`)
    }

    const monitoring = byPath.get("/api/system/monitoring")
    memory.push({
      rssKb: finiteNonNegative(monitoring?.rss, "monitoring.rss"),
      heapUsedKb: finiteNonNegative(monitoring?.heapUsed, "monitoring.heapUsed"),
      databaseKeys: finiteNonNegative(monitoring?.database?.keys, "monitoring.database.keys"),
      indicationSetInventoryKeys: finiteNonNegative(
        monitoring?.database?.indicationSetInventoryKeys,
        "monitoring.database.indicationSetInventoryKeys",
      ),
      indicationOutcomeAuxiliaryKeys: finiteNonNegative(
        monitoring?.database?.indicationOutcomeAuxiliaryKeys,
        "monitoring.database.indicationOutcomeAuxiliaryKeys",
      ),
      indicationSetInventoryConnections: finiteNonNegative(
        monitoring?.database?.indicationSetInventoryConnections,
        "monitoring.database.indicationSetInventoryConnections",
      ),
      engineCycles: Math.max(
        finiteNonNegative(monitoring?.engines?.indications?.cycleCount, "monitoring.indicationCycles"),
        finiteNonNegative(monitoring?.engines?.strategies?.cycleCount, "monitoring.strategyCycles"),
        finiteNonNegative(monitoring?.engines?.realtime?.cycleCount, "monitoring.realtimeCycles"),
      ),
    })

    if (rounds === 1 || rounds % 10 === 0) {
      const latestMemory = memory.at(-1)
      console.error(
        `[prod-soak] round=${rounds} rss=${latestMemory.rssKb}KiB heap=${latestMemory.heapUsedKb}KiB ` +
        `keys=${latestMemory.databaseKeys} inventory=${latestMemory.indicationSetInventoryKeys}` +
        `+${latestMemory.indicationOutcomeAuxiliaryKeys} scopes=${latestMemory.indicationSetInventoryConnections} ` +
        `cycles=${latestMemory.engineCycles} score=${progression.at(-1)?.score || 0} ` +
        `signal=${signalSample.signalIndicationsTotal} sources=${signalSample.sourcesExercised}/` +
        `${signalSample.registeredSources} signalPos=${signalSample.signalPositions} ` +
        `trailingPos=${signalSample.signalTrailingPositions}`,
      )
      // The raw progression dump is intentionally unavailable in production.
      // Canonical monitoring/stats above remain the production assertion; only
      // development soaks may add the debug-only Redis breakdown.
      if (rounds % 10 === 0 && RUNTIME_MODE !== "production") {
        if (DEBUG_ADMIN_SECRET.length < 16) {
          throw new Error("SOAK_ADMIN_SECRET is required for the authenticated development progression dump")
        }
        const raw = (await request(
          `/api/debug/progression-dump?id=${encodeURIComponent(connectionId)}`,
          { headers: { Authorization: `Bearer ${DEBUG_ADMIN_SECRET}` } },
        )).json
        const selectCycles = (value = {}) => Object.fromEntries(
          Object.entries(value).filter(([key]) => key === "cycle_count" || key.endsWith("_cycle_count")),
        )
        console.error(`[prod-soak:cycles] ${JSON.stringify({
          monitoring: monitoring?.engines,
          services: monitoring?.services,
          stats: stats?.realtime?.cycleCounters,
          activeProgression: stats?.metadata?.activeProgression ? {
            key: stats.metadata.activeProgression.key,
            engineType: stats.metadata.activeProgression.engine_type,
            epoch: stats.metadata.activeProgression.epoch,
          } : null,
          progression: selectCycles(raw?.progression),
          realtime: selectCycles(raw?.realtime),
          runtime: stats?.runtime ? {
            memory: stats.runtime.memory,
            memoryCollection: stats.runtime.memoryCollection,
            strategyMemory: stats.runtime.strategyMemory,
            eventLoop: stats.runtime.eventLoop,
            concurrency: stats.runtime.concurrency,
          } : null,
        })}`)
      }
    }

    await sleep(Math.max(0, POLL_MS - (Date.now() - roundStarted)))
  }

  // Capture one fresh terminal Signal snapshot so the reported source,
  // position, PF/DDT, and ranking counts describe the end of the complete
  // five-minute window rather than a cache up to one interval old.
  if (VERIFY_SIGNAL_ENGINE && lastByPath.size > 0) {
    await refreshSignalObservation(rounds > 5)
    for (const [path, payload] of signalObservation) lastByPath.set(path, payload)
    const finalSignalSample = signalRuntimeSample(
      lastByPath.get(`/api/connections/progression/${encodeURIComponent(connectionId)}/stats`),
      lastByPath.get(`/api/settings/indications/signal?connectionId=${encodeURIComponent(connectionId)}`),
      lastByPath.get(`/api/indications/signals/status?connectionId=${encodeURIComponent(connectionId)}`),
      lastByPath.get(livePositionsPath),
      lastByPath.get(`/api/statistics/indications?connectionId=${encodeURIComponent(connectionId)}`),
      connectionId,
    )
    const previousFinalSignal = signalRuntime.at(-1)
    if (finalSignalSample.openSignalPositions > finalSignalSample.maxPositionsTotal) {
      throw new Error(
        `Final Signal position capacity exceeded: ` +
        `${finalSignalSample.openSignalPositions}/${finalSignalSample.maxPositionsTotal}`,
      )
    }
    if (
      previousFinalSignal &&
      (
        finalSignalSample.signalIndicationsTotal < previousFinalSignal.signalIndicationsTotal ||
        finalSignalSample.sourceSuccesses < previousFinalSignal.sourceSuccesses
      )
    ) {
      throw new Error("Final Signal observation regressed")
    }
    signalRuntime.push(finalSignalSample)
  }

  // Exercise the real dashboard disable/re-enable lifecycle only after the
  // complete soak sample has been captured. Stopping a connection must cancel
  // timers immediately without deleting its verified Historic cache; the
  // subsequent enable must hydrate that same N/N generation and resume
  // processing without a crash, duplicate start, or false stalled alert.
  let connectionToggleVerified = false
  if (START_SIMULATED_ENGINE && process.env.VERIFY_CONNECTION_TOGGLE !== "0") {
    const finalBeforeToggle = progression.at(-1)
    const togglePath = `/api/settings/connections/${encodeURIComponent(connectionId)}/toggle-dashboard`
    const disabled = (await requestLifecycleToggle(togglePath, { enabled: false })).json
    if (
      disabled?.success !== true ||
      isTruthy(disabled?.connection?.is_enabled_dashboard) ||
      disabled?.engine?.status !== "stopped"
    ) {
      throw new Error(`Connection disable contract failed: ${JSON.stringify(disabled)}`)
    }
    const disabledMonitorPayload = (await request(
      `/api/trade-engine/detailed-logs?connectionId=${encodeURIComponent(connectionId)}`,
      { timeoutMs: 120_000 },
    )).json
    const disabledMonitor = detailedMonitorSample(disabledMonitorPayload, connectionId, false)
    if (disabledMonitor.status !== "disabled") {
      throw new Error(`Detailed Logs did not show disabled lifecycle: ${disabledMonitor.status}`)
    }

    const reenabled = (await requestLifecycleToggle(togglePath, { enabled: true })).json
    if (
      reenabled?.success !== true ||
      !isTruthy(reenabled?.connection?.is_enabled_dashboard) ||
      !["started", "queued"].includes(String(reenabled?.engine?.status || ""))
    ) {
      throw new Error(`Connection re-enable contract failed: ${JSON.stringify(reenabled)}`)
    }

    const resumeDeadline = Date.now() + 120_000
    let lastResumeDiagnostic = ""
    while (Date.now() < resumeDeadline) {
      const [engineResponse, statsResponse, monitorResponse] = await Promise.all([
        request("/api/trade-engine/status-all", { timeoutMs: 60_000 }),
        request(
          `/api/connections/progression/${encodeURIComponent(connectionId)}/stats`,
          { timeoutMs: 60_000 },
        ),
        request(
          `/api/trade-engine/detailed-logs?connectionId=${encodeURIComponent(connectionId)}`,
          { timeoutMs: 60_000 },
        ),
      ])
      const engine = Array.isArray(engineResponse.json?.engines)
        ? engineResponse.json.engines.find((item) => String(item?.connectionId) === connectionId)
        : null
      const symbols = Array.isArray(engine?.engineStatus?.symbols)
        ? engine.engineStatus.symbols.map(String)
        : []
      const resumedProgress = progressionSample(statsResponse.json)
      const resumedMonitor = detailedMonitorSample(monitorResponse.json, connectionId, true)
      lastResumeDiagnostic = JSON.stringify({
        engine: Boolean(engine),
        symbols: symbols.length,
        historic: `${resumedProgress.historicSymbols}/${resumedProgress.historicTotal}`,
        lifecycle: resumedMonitor.status,
      })
      const historicPreserved =
        resumedProgress.historicTotal === finalBeforeToggle?.historicTotal &&
        resumedProgress.historicSymbols >= (finalBeforeToggle?.historicSymbols || 0)
      if (
        engine &&
        symbols.length === SYMBOLS.length &&
        symbols.every((symbol, index) => symbol === SYMBOLS[index]) &&
        historicPreserved &&
        resumedMonitor.status !== "disabled" &&
        resumedMonitor.status !== "stalled"
      ) {
        connectionToggleVerified = true
        break
      }
      await sleep(1_000)
    }
    if (!connectionToggleVerified) {
      throw new Error(`Connection did not resume with preserved Historic state: ${lastResumeDiagnostic}`)
    }
  }

  // The bounded lifecycle can still be filling its 500-row terminal ring
  // during the final third of a short soak. Each retained row owns a hash and
  // JSON mirror, while up to SIGNAL_MAX_POSITIONS_TOTAL Signal rows remain
  // open. DB_STABLE_GROWTH_LIMIT includes the exact six-key-per-row topology;
  // the absolute limit below still fails unbounded per-cycle/config growth.
  const databaseStableGrowthLimit = DB_STABLE_GROWTH_LIMIT

  if (siteIds.size !== 1 || siteIds.has(null) || siteIds.has(undefined)) throw new Error("Site identity changed during soak")
  if (bootIds.size !== 1) throw new Error("Runtime boot identity changed without a process restart")
  if (START_SIMULATED_ENGINE) {
    const firstScore = progression[0]?.score || 0
    const maxScore = Math.max(...progression.map((sample) => sample.score))
    const firstCycles = memory[0]?.engineCycles || 0
    const maxCycles = Math.max(...memory.map((sample) => sample.engineCycles))
    if (maxScore <= firstScore && maxCycles <= firstCycles) {
      throw new Error("Simulated production engine progression did not advance")
    }
    if (maxCycles <= firstCycles) {
      throw new Error(`System monitoring cycle counters did not advance (${firstCycles} → ${maxCycles})`)
    }
    const firstMainActivityCycles = strategyRuntime[0]?.mainActivityCycles || 0
    const finalMainActivityCycles = strategyRuntime.at(-1)?.mainActivityCycles || 0
    if (finalMainActivityCycles - firstMainActivityCycles < MIN_PRODUCTIVE_CYCLES) {
      throw new Error(
        `Main strategy coordination advanced only ` +
        `${finalMainActivityCycles - firstMainActivityCycles} cycles ` +
        `(full=${strategyRuntime.at(-1)?.mainCycles || 0}, ` +
        `reused=${strategyRuntime.at(-1)?.mainReusedCycles || 0}); ` +
        `expected >= ${MIN_PRODUCTIVE_CYCLES}`,
      )
    }
    const finalProgression = progression.at(-1)
    if (
      finalProgression?.historicSymbols !== SYMBOLS.length ||
      finalProgression?.historicTotal !== SYMBOLS.length
    ) {
      throw new Error(
        `Historic/Main processing remained incomplete: ` +
        `${finalProgression?.historicSymbols || 0}/${finalProgression?.historicTotal || SYMBOLS.length}`,
      )
    }
    const peakLiveSets = Math.max(...progression.map((sample) => sample.live))
    const simulatedOrdersPeak = Math.max(...liveExecution.map((sample) => sample.ordersSimulated))
    const simulatedCreatedPeak = Math.max(...liveExecution.map((sample) => sample.simulatedPositionsCreated))
    // `openPositions.pseudo` is the upstream strategy-evaluation ledger, not
    // the executed paper-order store. Those short-lived rows may legitimately
    // close before a 2-second poll while LiveStage's simulated positions remain
    // authoritative and fully filled. Prove the paper lifecycle from its real
    // durable/API surfaces instead of requiring an unrelated pseudo row to be
    // open at sample time.
    if (simulatedPositionsPeak < 1 || simulatedOrdersPeak < 1 || simulatedCreatedPeak < 1) {
      throw new Error(
        `Paper position lifecycle was not exercised (pseudoLiveSets=${peakLiveSets}, ` +
        `simulatedPositions=${simulatedPositionsPeak}, simulatedOrders=${simulatedOrdersPeak}, ` +
        `simulatedPositionsCreated=${simulatedCreatedPeak})`,
      )
    }
    // This verifier runs with explicit simulated execution. Real venue counters
    // may have a historical baseline, but must not move during the paper run.
    // Simulated orders have their own counters and are never a subset of real
    // placed/filled orders.
    const firstLiveExecution = liveExecution[0]
    if (liveExecution.some((sample) =>
      sample.ordersPlaced !== firstLiveExecution.ordersPlaced ||
      sample.ordersFilled !== firstLiveExecution.ordersFilled ||
      sample.positionsCreated !== firstLiveExecution.positionsCreated ||
      sample.positionsClosed !== firstLiveExecution.positionsClosed,
    )) {
      throw new Error("Forced-simulation soak mutated real exchange execution counters")
    }
    if (VERIFY_SIGNAL_ENGINE) {
      const finalSignal = signalRuntime.at(-1)
      const signalIndicationsPeak = Math.max(...signalRuntime.map((sample) => sample.signalIndicationsTotal))
      const signalPositionsPeak = Math.max(...signalRuntime.map((sample) => sample.signalPositions))
      const signalTrailingPositionsPeak = Math.max(
        ...signalRuntime.map((sample) => sample.signalTrailingPositions),
      )
      if (
        !finalSignal?.enabled ||
        !finalSignal.directExecutionEnabled ||
        finalSignal.requestIntervalSeconds < 30 ||
        finalSignal.maxSourcesPerCycle > 35 ||
        finalSignal.maxPositionsTotal !== SIGNAL_MAX_POSITIONS_TOTAL ||
        finalSignal.positionSelectionMode !== "best_first" ||
        !finalSignal.trailingEnabled ||
        finalSignal.trailingOnly ||
        finalSignal.trailingStartPct !== 0 ||
        finalSignal.trailingMinStopPct < 0.8 ||
        finalSignal.trailingPositiveMoveRatio !== 0.4 ||
        finalSignal.trailingUpdateStopRangeRatio !== 0.5 ||
        finalSignal.sourcePerformanceLookback !== 12 ||
        finalSignal.lanePerformanceLookback !== 10 ||
        finalSignal.signalVolumeFactor < 1
      ) {
        throw new Error(`Signal settings contract failed: ${JSON.stringify(finalSignal)}`)
      }
      if (
        finalSignal.registeredSources !== 35 ||
        finalSignal.configuredSources !== 35 ||
        finalSignal.enabledSources !== 35 ||
        finalSignal.sourceHealthCount !== 35 ||
        finalSignal.sourcesExercised !== 35 ||
        finalSignal.analyticsSourceCount !== 35 ||
        finalSignal.analyticsCommonTypeCount < 7
      ) {
        throw new Error(
          `Signal source coverage incomplete: registered=${finalSignal.registeredSources} ` +
          `configured=${finalSignal.configuredSources} enabled=${finalSignal.enabledSources} ` +
          `health=${finalSignal.sourceHealthCount} exercised=${finalSignal.sourcesExercised} ` +
          `analyticsSources=${finalSignal.analyticsSourceCount} ` +
          `commonTypes=${finalSignal.analyticsCommonTypeCount}`,
        )
      }
      if (signalIndicationsPeak < 1) {
        throw new Error("Signal engine produced no indications during the bounded runtime")
      }
      if (signalPositionsPeak < 1 || signalTrailingPositionsPeak < 1) {
        throw new Error(
          `Independent Signal position lanes were not exercised ` +
          `(signal=${signalPositionsPeak}, trailing=${signalTrailingPositionsPeak})`,
        )
      }
    }
  }

  // Cold bootstrap creates the fixed indication-set inventory lazily. The
  // opposite Long/Short side can first qualify late in a short soak, so total
  // DBSIZE is not itself a steady-state leak signal. Subtract the exact indexed
  // Set inventory and assert the remaining keyspace over the final 20 seconds.
  // The absolute topology guard below independently bounds total Set growth.
  const databaseKeySeries = memory.map((sample) => sample.databaseKeys)
  const databaseSetInventorySeries = memory.map((sample) => sample.indicationSetInventoryKeys)
  const databaseOutcomeAuxiliarySeries = memory.map((sample) => sample.indicationOutcomeAuxiliaryKeys)
  const databaseNonInventoryKeySeries = memory.map((sample) =>
    Math.max(
      0,
      sample.databaseKeys - sample.indicationSetInventoryKeys - sample.indicationOutcomeAuxiliaryKeys,
    ),
  )
  const databaseStableSamples = Math.max(
    5,
    Math.min(databaseKeySeries.length, Math.ceil(20_000 / POLL_MS)),
  )
  const databaseStableSeries = databaseNonInventoryKeySeries.slice(-databaseStableSamples)
  const databaseStableVolatility = databaseStableSeries.length > 0
    ? Math.max(...databaseStableSeries) - Math.min(...databaseStableSeries)
    : 0
  // A Set LIST and its maintained indexes are separate Redis operations, so
  // a high-concurrency sample can briefly observe the LIST before SCARD sees
  // the corresponding bounded inventory member. Compare low-water baselines
  // across both halves of the window; a real monotonic writer raises that
  // baseline, while harmless write/index visibility oscillation does not.
  const databaseStableSplit = Math.max(1, Math.floor(databaseStableSeries.length / 2))
  const databaseStableFirstHalf = databaseStableSeries.slice(0, databaseStableSplit)
  const databaseStableSecondHalf = databaseStableSeries.slice(databaseStableSplit)
  const databaseStableFirstLow = databaseStableFirstHalf.length > 0
    ? Math.min(...databaseStableFirstHalf)
    : 0
  const databaseStableSecondLow = databaseStableSecondHalf.length > 0
    ? Math.min(...databaseStableSecondHalf)
    : databaseStableFirstLow
  const databaseStableGrowth = Math.max(0, databaseStableSecondLow - databaseStableFirstLow)
  const databaseStableTotalSeries = databaseKeySeries.slice(-databaseStableSamples)
  const databaseStableTotalGrowth = databaseStableTotalSeries.length > 0
    ? Math.max(...databaseStableTotalSeries) - Math.min(...databaseStableTotalSeries)
    : 0
  const databaseStableSetInventorySeries = databaseSetInventorySeries.slice(-databaseStableSamples)
  const databaseStableSetInventoryGrowth = databaseStableSetInventorySeries.length > 0
    ? Math.max(...databaseStableSetInventorySeries) - Math.min(...databaseStableSetInventorySeries)
    : 0
  const databaseStableOutcomeAuxiliarySeries = databaseOutcomeAuxiliarySeries.slice(-databaseStableSamples)
  const databaseStableOutcomeAuxiliaryGrowth = databaseStableOutcomeAuxiliarySeries.length > 0
    ? Math.max(...databaseStableOutcomeAuxiliarySeries) - Math.min(...databaseStableOutcomeAuxiliarySeries)
    : 0
  // Exhaustive Default/Additional/Common/Signal grids deliberately replaced
  // the old sampled topology. `totalPossibleSets` is the per-symbol Long/Short
  // capacity, while the monitoring counters are summed across every materialized
  // connection scope. Keep those dimensions explicit: the old `sets * 4`
  // formula omitted both symbol and connection identity and failed a healthy
  // 32-symbol run once its lazy inventory passed that undersized estimate.
  //
  // Each materialized Set owns one indexed primary key and at most three
  // indexed outcome auxiliaries (`:outcomes`, `:outcome_stats`, dedupe ids).
  // Bound both indexes independently by the canonical grid, then subtract
  // them from DBSIZE and apply a strict absolute/plateau budget to every other
  // key. This accepts finite lazy materialization without masking an unindexed
  // per-cycle writer.
  const configurationCounts = lastByPath.get("/api/indications/config-counts") || {}
  const totalPossibleSets = finiteNonNegative(
    configurationCounts?.totalPossibleSets,
    "indicationConfigurationCounts.totalPossibleSets",
  )
  if (totalPossibleSets < 1) {
    throw new Error("Indication configuration topology is empty during soak")
  }
  const inventoryConnectionScopes = Math.max(
    1,
    memory.at(-1)?.indicationSetInventoryConnections || 0,
  )
  const indicationSetInventoryCapacity =
    totalPossibleSets * SYMBOLS.length * inventoryConnectionScopes
  const indicationOutcomeAuxiliaryCapacity = indicationSetInventoryCapacity * 3
  const indicationSetInventoryKeysEnd = memory.at(-1)?.indicationSetInventoryKeys || 0
  const indicationOutcomeAuxiliaryKeysEnd = memory.at(-1)?.indicationOutcomeAuxiliaryKeys || 0
  if (indicationSetInventoryKeysEnd > indicationSetInventoryCapacity) {
    throw new Error(
      `Indication Set inventory exceeds canonical topology: ` +
      `${indicationSetInventoryKeysEnd} > ${indicationSetInventoryCapacity}`,
    )
  }
  if (indicationOutcomeAuxiliaryKeysEnd > indicationOutcomeAuxiliaryCapacity) {
    throw new Error(
      `Indication outcome auxiliaries exceed canonical topology: ` +
      `${indicationOutcomeAuxiliaryKeysEnd} > ${indicationOutcomeAuxiliaryCapacity}`,
    )
  }
  const databaseNonInventoryAbsoluteLimit = Math.max(
    5_000,
    SYMBOLS.length * NON_INVENTORY_KEYS_PER_SYMBOL_BUDGET +
      inventoryConnectionScopes * 2_000 +
      SIGNAL_POSITION_TOPOLOGY_KEY_BUDGET,
  )
  const databaseNonInventoryKeysEnd = databaseNonInventoryKeySeries.at(-1) || 0
  const databaseAbsoluteLimit =
    indicationSetInventoryKeysEnd +
    indicationOutcomeAuxiliaryKeysEnd +
    databaseNonInventoryAbsoluteLimit
  const databasePlateauWithinBudget = databaseStableGrowth <= databaseStableGrowthLimit
  if (!databasePlateauWithinBudget) {
    throw new Error(
      `Database keys did not plateau after bootstrap: growth=${databaseStableGrowth} ` +
      `limit=${databaseStableGrowthLimit} totalGrowth=${databaseStableTotalGrowth} ` +
      `nonInventoryVolatility=${databaseStableVolatility} ` +
      `boundedSetInventoryGrowth=${databaseStableSetInventoryGrowth} ` +
      `boundedOutcomeAuxiliaryGrowth=${databaseStableOutcomeAuxiliaryGrowth}`,
    )
  }
  if (databaseNonInventoryKeysEnd > databaseNonInventoryAbsoluteLimit) {
    throw new Error(
      `Unindexed database key count exceeds bounded ${SYMBOLS.length}-symbol budget: ` +
      `${databaseNonInventoryKeysEnd} > ${databaseNonInventoryAbsoluteLimit} ` +
      `(total=${databaseKeySeries.at(-1) || 0}, indexedSets=${indicationSetInventoryKeysEnd}, ` +
      `indexedOutcomes=${indicationOutcomeAuxiliaryKeysEnd})`,
    )
  }

  const rssSeries = memory.map((sample) => sample.rssKb).filter((value) => value > 0)
  const heapSeries = memory.map((sample) => sample.heapUsedKb).filter((value) => value > 0)
  // Production's prehistoric replay is an intentional startup allocation
  // phase. Leak assessment begins only after engine cycles become productive;
  // otherwise a bounded cold-start ramp is misclassified as a steady-state
  // leak. Dev starts productive immediately and uses the full sample series.
  const firstProductiveMemoryIndex = RUNTIME_MODE === "production"
    ? memory.findIndex((sample) => sample.engineCycles > 0)
    : 0
  const heapLeakSeries = firstProductiveMemoryIndex >= 0
    ? heapSeries.slice(firstProductiveMemoryIndex)
    : []
  let heapLeakEvaluated = false
  let heapGrowthKb = 0
  let heapWithinBudget = true
  if (heapLeakSeries.length >= 6) {
    // Historical bootstrap is allowed a temporary peak. Leak detection starts
    // after the first third of the soak and compares the final live JS heap to
    // that warm baseline; one-time allocations that are released do not fail.
    const warmIndex = Math.min(heapLeakSeries.length - 1, Math.floor(heapLeakSeries.length / 3))
    const warmBaselineWindow = heapLeakSeries.slice(
      Math.max(0, warmIndex - 2),
      Math.min(heapLeakSeries.length, warmIndex + 3),
    )
    const warmBaseline = Math.min(...warmBaselineWindow)
    // Strategy calculation is bursty: each symbol temporarily owns a complete
    // 300k+ evaluation matrix. Compare post-GC low-water marks rather than an
    // arbitrary final in-flight peak. The peak is still reported and the key
    // plateau/absolute topology guards above remain independent.
    const finalLowWaterSamples = Math.max(
      5,
      Math.min(heapLeakSeries.length, Math.ceil(30_000 / POLL_MS)),
    )
    const finalHeap = Math.min(...heapLeakSeries.slice(-finalLowWaterSamples))
    heapLeakEvaluated = true
    heapGrowthKb = finalHeap - warmBaseline
    heapWithinBudget = heapGrowthKb <= HEAP_GROWTH_LIMIT_KB
    // V8 may retain already-committed pages after a successful GC, so RSS is
    // not a reliable JS liveness measure. Heap low-water detects retained
    // objects; the independent absolute RSS cap below still guards OOM risk.
    if (!heapWithinBudget) {
      throw new Error(
        `Post-warmup JS heap kept growing: baseline=${warmBaseline}KiB final=${finalHeap}KiB ` +
        `peak=${Math.max(...heapSeries)}KiB limit=${HEAP_GROWTH_LIMIT_KB}KiB`,
      )
    }
  }
  const rssPeakKb = rssSeries.length ? Math.max(...rssSeries) : 0
  const rssWithinAbsoluteBudget = rssPeakKb <= RSS_PEAK_LIMIT_KB
  if (!rssWithinAbsoluteBudget) {
    throw new Error(
      `Process RSS exceeded absolute safety cap: peak=${rssPeakKb}KiB ` +
      `limit=${RSS_PEAK_LIMIT_KB}KiB configuredHeap=${CONFIGURED_NODE_HEAP_MB}MiB`,
    )
  }

  const percentile95 = (sortedValues) => {
    if (sortedValues.length === 0) return 0
    // Nearest-rank p95. `floor(n * .95)` selected the 96th order statistic
    // for most sample counts and, at n=20, incorrectly treated the maximum as
    // p95. Keep the sort explicit so the reported contract is reproducible.
    return sortedValues[Math.max(0, Math.ceil(sortedValues.length * 0.95) - 1)] || 0
  }
  latencies.sort((a, b) => a - b)
  steadyLatencies.sort((a, b) => a - b)
  signalLatencies.sort((a, b) => a - b)
  steadySignalLatencies.sort((a, b) => a - b)
  const p95 = percentile95(latencies)
  const steadyP95 = percentile95(steadyLatencies) || p95
  const signalP95 = percentile95(signalLatencies)
  const steadySignalP95 = percentile95(steadySignalLatencies) || signalP95
  // A production process backed by network Redis keeps the strict 1s API
  // contract. The explicitly opt-in InlineLocalRedis preview is a single
  // Node event loop running the exhaustive indication grid and the HTTP
  // control plane together; its measured CPU-bound tail is allowed a separate
  // bounded budget instead of being mislabeled as a network-production pass.
  // Operators/CI may set the limit explicitly for a constrained host.
  const defaultP95LimitMs = RUNTIME_MODE === "production" ? 1_000 : 3_000
  const configuredP95LimitMs = Number(process.env.SOAK_API_P95_LIMIT_MS)
  const steadyP95LimitMs = Number.isFinite(configuredP95LimitMs) && configuredP95LimitMs > 0
    ? configuredP95LimitMs
    : RUNTIME_MODE === "production"
      ? (process.env.ALLOW_PROD_INLINE_REDIS === "1" ? 3_000 : 1_000)
      : defaultP95LimitMs
  const contractP95 = SIGNAL_FOCUSED_SOAK ? steadySignalP95 : steadyP95
  const routeLatencyP95Ms = Object.fromEntries(
    [...latencyByPath.entries()]
      .map(([path, values]) => {
        const sorted = [...values].sort((a, b) => a - b)
        return [
          path,
          percentile95(sorted),
        ]
      })
      .sort((left, right) => Number(right[1]) - Number(left[1])),
  )
  const slowestRouteSummary = Object.entries(routeLatencyP95Ms)
    .slice(0, 4)
    .map(([path, value]) => `${path}=${value}ms`)
    .join(", ")
  if (contractP95 > steadyP95LimitMs) {
    throw new Error(
      `${SIGNAL_FOCUSED_SOAK ? "Signal API" : "Steady-state API"} p95 ${contractP95}ms ` +
      `exceeds ${steadyP95LimitMs}ms ${RUNTIME_MODE} limit; slowest routes: ${slowestRouteSummary}`,
    )
  }
  const finalSignal = signalRuntime.at(-1)
  console.log(JSON.stringify({
    success: true,
    mode: START_SIMULATED_ENGINE
      ? `${RUNTIME_MODE}-${SIGNAL_FOCUSED_SOAK ? "signal-" : ""}paper-engine`
      : `${RUNTIME_MODE}-read-only`,
    validationScope: SIGNAL_FOCUSED_SOAK ? "signal-engine" : "full-system",
    orderRequests: 0,
    durationMs: Date.now() - startedAt,
    bootstrapReadyWaitMs,
    configuredDurationMs: DURATION_MS,
    productiveCompletionGraceMs: PRODUCTIVE_COMPLETION_GRACE_MS,
    symbols: SYMBOLS.length,
    rounds,
    requests,
    signalObservationRequests,
    signalObservationIntervalMs: VERIFY_SIGNAL_ENGINE
      ? SIGNAL_OBSERVATION_INTERVAL_MS
      : 0,
    connectionId,
    siteInstanceId: [...siteIds][0],
    bootId: [...bootIds][0],
    progressionStart: progression[0],
    progressionEnd: progression.at(-1),
    progressionPeakScore: Math.max(...progression.map((sample) => sample.score)),
    rssStartKb: rssSeries[0] || 0,
    rssPeakKb,
    rssEndKb: rssSeries.at(-1) || 0,
    rssPeakLimitKb: RSS_PEAK_LIMIT_KB,
    rssWithinAbsoluteBudget,
    heapStartKb: heapSeries[0] || 0,
    heapPeakKb: heapSeries.length ? Math.max(...heapSeries) : 0,
    heapEndKb: heapSeries.at(-1) || 0,
    heapGrowthLimitKb: HEAP_GROWTH_LIMIT_KB,
    heapLeakEvaluated,
    heapLeakSamples: heapLeakSeries.length,
    heapGrowthKb,
    heapWithinBudget,
    databaseKeysStart: memory[0]?.databaseKeys || 0,
    databaseKeysEnd: memory.at(-1)?.databaseKeys || 0,
    databaseStableGrowth,
    databaseStableVolatility,
    databaseStableTotalGrowth,
    databaseStableSetInventoryGrowth,
    databaseStableOutcomeAuxiliaryGrowth,
    indicationSetInventoryKeysEnd,
    indicationOutcomeAuxiliaryKeysEnd,
    indicationSetInventoryConnections: inventoryConnectionScopes,
    indicationSetInventoryCapacity,
    indicationOutcomeAuxiliaryCapacity,
    databaseNonInventoryKeysEnd,
    databaseNonInventoryAbsoluteLimit,
    nonInventoryKeysPerSymbolBudget: NON_INVENTORY_KEYS_PER_SYMBOL_BUDGET,
    databaseStableGrowthLimit,
    signalPositionTopologyKeyBudget: SIGNAL_POSITION_TOPOLOGY_KEY_BUDGET,
    databasePlateauWithinBudget,
    databaseAbsoluteLimit,
    engineCyclesStart: memory[0]?.engineCycles || 0,
    engineCyclesEnd: memory.at(-1)?.engineCycles || 0,
    mainStrategyCyclesStart: strategyRuntime[0]?.mainCycles || 0,
    mainStrategyCyclesEnd: strategyRuntime.at(-1)?.mainCycles || 0,
    strategyVariantEnd: strategyRuntime.at(-1)?.variants,
    realActiveEnd: strategyRuntime.at(-1)?.realActive || 0,
    realActiveAverageEnd: strategyRuntime.at(-1)?.realActiveAverage || 0,
    observedPositionLifecycles: positionLifecycle.size,
    observedPartialExecutions: executionProgress.size,
    detailedMonitorObservations: detailedMonitorRuntime.length,
    detailedMonitorAlertsPeak: detailedMonitorRuntime.length
      ? Math.max(...detailedMonitorRuntime.map((sample) => sample.alerts))
      : 0,
    detailedMonitorRowsPeak: detailedMonitorRuntime.length
      ? Math.max(...detailedMonitorRuntime.map((sample) => sample.logRows))
      : 0,
    connectionToggleVerified,
    simulatedOrdersPeak: liveExecution.length ? Math.max(...liveExecution.map((sample) => sample.ordersSimulated)) : 0,
    simulatedPositionsCreatedPeak: liveExecution.length
      ? Math.max(...liveExecution.map((sample) => sample.simulatedPositionsCreated))
      : 0,
    simulatedPositionsClosedPeak: liveExecution.length
      ? Math.max(...liveExecution.map((sample) => sample.simulatedPositionsClosed))
      : 0,
    simulatedPositionsPeak,
    realPositionsPeak,
    paperPositionsPeak,
    paperRunningSetsPeak,
    paperUpdateCyclesPeak,
    signalEngine: finalSignal ? {
      settings: {
        enabled: finalSignal.enabled,
        directExecutionEnabled: finalSignal.directExecutionEnabled,
        requestIntervalSeconds: finalSignal.requestIntervalSeconds,
        maxSourcesPerCycle: finalSignal.maxSourcesPerCycle,
        maxPositionsTotal: finalSignal.maxPositionsTotal,
        positionSelectionMode: finalSignal.positionSelectionMode,
        trailingEnabled: finalSignal.trailingEnabled,
        trailingOnly: finalSignal.trailingOnly,
        trailingStartPct: finalSignal.trailingStartPct,
        trailingMinStopPct: finalSignal.trailingMinStopPct,
        trailingPositiveMoveRatio: finalSignal.trailingPositiveMoveRatio,
        trailingUpdateStopRangeRatio: finalSignal.trailingUpdateStopRangeRatio,
        signalVolumeFactor: finalSignal.signalVolumeFactor,
        sourcePerformanceLookback: finalSignal.sourcePerformanceLookback,
        lanePerformanceLookback: finalSignal.lanePerformanceLookback,
      },
      registeredSources: finalSignal.registeredSources,
      configuredSources: finalSignal.configuredSources,
      enabledSources: finalSignal.enabledSources,
      sourceHealthCount: finalSignal.sourceHealthCount,
      sourcesExercised: finalSignal.sourcesExercised,
      sourceSuccessesStart: signalRuntime[0]?.sourceSuccesses || 0,
      sourceSuccessesEnd: finalSignal.sourceSuccesses,
      sourceFailuresEnd: finalSignal.sourceFailures,
      sourceConsecutiveFailuresEnd: finalSignal.sourceConsecutiveFailures,
      indicationsStart: signalRuntime[0]?.signalIndicationsTotal || 0,
      indicationsEnd: finalSignal.signalIndicationsTotal,
      indicationsPeak: Math.max(...signalRuntime.map((sample) => sample.signalIndicationsTotal)),
      activeIndicationsPeak: Math.max(
        ...signalRuntime.map((sample) => sample.signalIndicationsActive),
      ),
      activeSetsPeak: Math.max(...signalRuntime.map((sample) => sample.signalSetsActive)),
      trackingsPeak: Math.max(...signalRuntime.map((sample) => sample.signalTrackingsTotal)),
      activePositionSlotsPeak: Math.max(
        ...signalRuntime.map((sample) => sample.signalPositionSlotsActive),
      ),
      signalPositionsPeak: Math.max(...signalRuntime.map((sample) => sample.signalPositions)),
      openSignalPositionsPeak: Math.max(
        ...signalRuntime.map((sample) => sample.openSignalPositions),
      ),
      defaultSignalPositionsPeak: Math.max(
        ...signalRuntime.map((sample) => sample.defaultSignalPositions),
      ),
      signalTrailingPositionsPeak: Math.max(
        ...signalRuntime.map((sample) => sample.signalTrailingPositions),
      ),
      openSignalTrailingPositionsPeak: Math.max(
        ...signalRuntime.map((sample) => sample.openSignalTrailingPositions),
      ),
      activeSignalTrailingStopsPeak: Math.max(
        ...signalRuntime.map((sample) => sample.activeSignalTrailingStops),
      ),
      signalBlockLaneRowsPeak: Math.max(
        ...signalRuntime.map((sample) => sample.signalBlockLaneRows),
      ),
      signalBlockCalculatedPeak: Math.max(
        ...signalRuntime.map((sample) => sample.signalBlockCalculated),
      ),
      signalBlockEvaluatedPeak: Math.max(
        ...signalRuntime.map((sample) => sample.signalBlockEvaluated),
      ),
      signalBlockEligiblePeak: Math.max(
        ...signalRuntime.map((sample) => sample.signalBlockEligible),
      ),
      signalBlockEmittedPeak: Math.max(
        ...signalRuntime.map((sample) => sample.signalBlockEmitted),
      ),
      signalBlockActivePeak: Math.max(
        ...signalRuntime.map((sample) => sample.signalBlockActive),
      ),
      signalBlockDisabledPeak: Math.max(
        ...signalRuntime.map((sample) => sample.signalBlockDisabled),
      ),
      performanceLaneCountEnd: finalSignal.performanceLaneCount,
      performanceClosedSamplesEnd: finalSignal.performanceClosedSamples,
      performanceAutoDisabledEnd: finalSignal.performanceAutoDisabled,
      analyticsClosedPositionsEnd: finalSignal.analyticsClosedPositions,
      analyticsOpenPositionsEnd: finalSignal.analyticsOpenPositions,
      analyticsSourceCount: finalSignal.analyticsSourceCount,
      analyticsSourceSymbolRows: finalSignal.analyticsSourceSymbolRows,
      analyticsCommonTypeCount: finalSignal.analyticsCommonTypeCount,
      analyticsWindowTrades: finalSignal.analyticsWindowTrades,
      analyticsRankingRows: finalSignal.analyticsRankingRows,
      sourceHealth: finalSignal.sourceHealth,
      performance: finalSignal.performance,
    } : null,
    latencyP95Ms: p95,
    steadyLatencyP95Ms: steadyP95,
    signalLatencyP95Ms: signalP95,
    steadySignalLatencyP95Ms: steadySignalP95,
    latencyContractScope: SIGNAL_FOCUSED_SOAK ? "signal-api" : "all-api",
    latencyContractP95Ms: contractP95,
    steadyLatencyP95LimitMs: steadyP95LimitMs,
    routeLatencyP95Ms,
  }, null, 2))
}

main().catch((error) => {
  console.error("[verify-prod-soak] failed:", error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
