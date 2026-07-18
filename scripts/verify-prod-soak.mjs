#!/usr/bin/env node

/** Bounded production-mode engine/UI/API coordination soak (simulated orders only). */

const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3102}`
const MIN_DURATION_MS = Math.max(5_000, Number(process.env.SOAK_MIN_DURATION_MS || 60_000))
const DURATION_MS = Math.max(MIN_DURATION_MS, Number(process.env.SOAK_DURATION_MS || 90_000))
const POLL_MS = Math.max(750, Number(process.env.SOAK_POLL_MS || 2_000))
const SYMBOL_COUNT = Math.max(1, Math.min(32, Number(process.env.SYMBOL_COUNT || 12)))
const START_SIMULATED_ENGINE = process.env.START_SIMULATED_ENGINE === "1"
const RUNTIME_MODE = process.env.RUNTIME_MODE || "production"
const DEBUG_ADMIN_SECRET = String(process.env.SOAK_ADMIN_SECRET || "")
const RSS_GROWTH_LIMIT_KB = Math.max(
  128 * 1024,
  Number(
    process.env.SOAK_RSS_GROWTH_LIMIT_KB ||
    (RUNTIME_MODE === "development" ? 1024 * 1024 : 512 * 1024),
  ),
)
const SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT",
  "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "ATOMUSDT", "LTCUSDT",
  "UNIUSDT", "NEARUSDT", "OPUSDT", "ARBUSDT", "APTUSDT", "SUIUSDT",
  "INJUSDT", "TIAUSDT", "SEIUSDT", "WLDUSDT", "PYTHUSDT", "JUPUSDT",
  "TRXUSDT", "ETCUSDT", "FILUSDT", "AAVEUSDT", "RUNEUSDT", "FETUSDT",
  "ICPUSDT", "HBARUSDT",
].slice(0, SYMBOL_COUNT)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function request(pathname, { method = "GET", body, timeoutMs = 30_000, headers = {} } = {}) {
  const started = Date.now()
  const response = await fetch(new URL(pathname, BASE_URL), {
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
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${pathname} HTTP ${response.status}: ${text.slice(0, 300)}`)
  let json
  try { json = text ? JSON.parse(text) : {} } catch { throw new Error(`${pathname} returned invalid JSON`) }
  return { json, latencyMs: Date.now() - started }
}

function finiteNonNegative(value, label) {
  if (value == null) return 0
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} is invalid: ${value}`)
  return number
}

function progressionSample(stats) {
  const stages = stats?.breakdown?.strategies || stats?.strategies || {}
  const sample = {
    historicPercent: finiteNonNegative(stats?.historic?.progressPercent, "historic.progressPercent"),
    historicSymbols: finiteNonNegative(stats?.historic?.symbolsProcessed, "historic.symbolsProcessed"),
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

async function main() {
  const inventory = (await request("/api/connections")).json
  let connectionId = String(inventory?.connections?.[0]?.id || "")
  if (!connectionId) throw new Error("No connection available for production soak")

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
        baseProfitFactor: 0.75,
        mainProfitFactor: 0.75,
        realProfitFactor: 0.75,
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

    // Race the idempotent start lock deliberately; only one owner may attach.
    await Promise.all(Array.from({ length: 4 }, () => request("/api/trade-engine/start-all", {
      method: "POST",
      timeoutMs: 120_000,
    })))
  }

  const endpointBuilders = [
    () => "/api/health",
    () => "/api/system/init-status",
    () => "/api/system/status",
    () => "/api/system/monitoring",
    () => "/api/trade-engine/status-all",
    () => `/api/connections/progression/${encodeURIComponent(connectionId)}/stats`,
    () => `/api/trading/trade-history?connection_id=${encodeURIComponent(connectionId)}&limit=500`,
    () => `/api/logistics/queue?connectionId=${encodeURIComponent(connectionId)}`,
    () => `/api/trading/live-positions?connection_id=${encodeURIComponent(connectionId)}`,
    () => `/api/preset-optimizer?connectionId=${encodeURIComponent(connectionId)}`,
    () => `/api/connections/${encodeURIComponent(connectionId)}/engine-states`,
  ]

  const startedAt = Date.now()
  const progression = []
  const memory = []
  const siteIds = new Set()
  const bootIds = new Set()
  const latencies = []
  const liveExecution = []
  let simulatedPositionsPeak = 0
  let realPositionsPeak = 0
  let paperPositionsPeak = 0
  let paperRunningSetsPeak = 0
  let paperUpdateCyclesPeak = 0
  let rounds = 0
  let requests = 0

  while (Date.now() - startedAt < DURATION_MS) {
    const roundStarted = Date.now()
    const paths = endpointBuilders.map((build) => build())
    const responses = await Promise.all(paths.map((path) => request(path)))
    rounds++
    requests += responses.length
    latencies.push(...responses.map((response) => response.latencyMs))

    const byPath = new Map(paths.map((path, index) => [path, responses[index].json]))
    const init = byPath.get("/api/system/init-status")
    if (!init?.ready || init?.system?.startup?.status !== "ready") throw new Error("Startup lost readiness during soak")
    if (Number(init?.migrations?.current_version) !== Number(init?.migrations?.latest_version)) {
      throw new Error("Migration state regressed during soak")
    }
    siteIds.add(init?.system?.site_instance_id)
    bootIds.add(init?.system?.startup?.boot_id)

    const stats = byPath.get(`/api/connections/progression/${encodeURIComponent(connectionId)}/stats`)
    const sample = progressionSample(stats)
    if (sample.live > sample.real) throw new Error(`Live output exceeds Real output: ${sample.live} > ${sample.real}`)
    if (sample.real > sample.realEvaluated && sample.realEvaluated > 0) {
      throw new Error(`Real output exceeds its evaluated pool: ${sample.real} > ${sample.realEvaluated}`)
    }
    for (const [stage, value] of Object.entries(stats?.stageEvalPercent || {})) {
      const percent = Number(value)
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        throw new Error(`stageEvalPercent.${stage} is invalid: ${value}`)
      }
    }
    progression.push(sample)

    const engineInventory = byPath.get("/api/trade-engine/status-all")
    const engine = Array.isArray(engineInventory?.engines)
      ? engineInventory.engines.find((entry) => String(entry?.connectionId) === connectionId)
      : null
    const activeSymbols = Array.isArray(engine?.engineStatus?.symbols) ? engine.engineStatus.symbols.map(String) : []
    if (!engine || activeSymbols.length !== SYMBOLS.length || activeSymbols.some((symbol, index) => symbol !== SYMBOLS[index])) {
      throw new Error(`Engine is not coordinating the exact ${SYMBOLS.length}-symbol set`)
    }
    if (engine?.isLiveTrading !== false) throw new Error("Engine status reports live trading during safe paper soak")

    const positions = byPath.get(`/api/trading/live-positions?connection_id=${encodeURIComponent(connectionId)}`)
    if (!Array.isArray(positions?.realPositions) || !Array.isArray(positions?.simulatedPositions)) {
      throw new Error("Live-position API schema failed during soak")
    }
    if (positions?.dataIntegrity?.liveExecutionMode !== "simulation" || positions?.dataIntegrity?.liveTradeRequested !== false) {
      throw new Error("Live-position API left explicit simulation mode during soak")
    }
    realPositionsPeak = Math.max(realPositionsPeak, positions.realPositions.length)
    simulatedPositionsPeak = Math.max(simulatedPositionsPeak, positions.simulatedPositions.length)
    if (realPositionsPeak > 0 || Number(positions?.counts?.real || 0) > 0) {
      throw new Error("A real exchange position appeared during safe paper soak")
    }
    liveExecution.push({
      ordersSimulated: finiteNonNegative(stats?.liveExecution?.ordersSimulated, "liveExecution.ordersSimulated"),
      ordersPlaced: finiteNonNegative(stats?.liveExecution?.ordersPlaced, "liveExecution.ordersPlaced"),
      positionsCreated: finiteNonNegative(stats?.liveExecution?.positionsCreated, "liveExecution.positionsCreated"),
      positionsClosed: finiteNonNegative(stats?.liveExecution?.positionsClosed, "liveExecution.positionsClosed"),
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
      engineCycles:
        finiteNonNegative(monitoring?.engines?.indications?.cycleCount, "monitoring.indicationCycles") +
        finiteNonNegative(monitoring?.engines?.strategies?.cycleCount, "monitoring.strategyCycles"),
    })

    if (rounds === 1 || rounds % 10 === 0) {
      const latestMemory = memory.at(-1)
      console.error(
        `[prod-soak] round=${rounds} rss=${latestMemory.rssKb}KiB heap=${latestMemory.heapUsedKb}KiB ` +
        `keys=${latestMemory.databaseKeys} cycles=${latestMemory.engineCycles} score=${progression.at(-1)?.score || 0}`,
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
        })}`)
      }
    }

    await sleep(Math.max(0, POLL_MS - (Date.now() - roundStarted)))
  }

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
    const peakLiveSets = Math.max(...progression.map((sample) => sample.live))
    if (peakLiveSets < 1 || paperPositionsPeak < 1 || paperRunningSetsPeak < 1 || paperUpdateCyclesPeak < 1) {
      throw new Error(
        `Paper position lifecycle was not exercised (liveSets=${peakLiveSets}, ` +
        `open=${paperPositionsPeak}, runningSets=${paperRunningSetsPeak}, updates=${paperUpdateCyclesPeak})`,
      )
    }
    if (liveExecution.some((sample) => sample.ordersPlaced < sample.ordersSimulated)) {
      throw new Error("Simulated order counters exceed canonical placed-order counters")
    }
  }

  // Cold bootstrap legitimately creates the fixed indication-set inventory.
  // Once the final third begins, the key count must plateau: a per-cycle row
  // writer previously grew this series from ~45k to ~70k in one minute.
  const databaseKeySeries = memory.map((sample) => sample.databaseKeys)
  const databaseStableSeries = databaseKeySeries.slice(Math.floor(databaseKeySeries.length * 2 / 3))
  const databaseStableGrowth = databaseStableSeries.length > 0
    ? Math.max(...databaseStableSeries) - Math.min(...databaseStableSeries)
    : 0
  const databaseStableGrowthLimit = Math.max(500, SYMBOLS.length * 50)
  const databaseAbsoluteLimit = Math.max(5_000, SYMBOLS.length * 500)
  if (databaseStableGrowth > databaseStableGrowthLimit) {
    throw new Error(
      `Database keys did not plateau after bootstrap: growth=${databaseStableGrowth} ` +
      `limit=${databaseStableGrowthLimit}`,
    )
  }
  if ((databaseKeySeries.at(-1) || 0) > databaseAbsoluteLimit) {
    throw new Error(
      `Database key count exceeds bounded ${SYMBOLS.length}-symbol budget: ` +
      `${databaseKeySeries.at(-1)} > ${databaseAbsoluteLimit}`,
    )
  }

  const rssSeries = memory.map((sample) => sample.rssKb).filter((value) => value > 0)
  // Production's prehistoric replay is an intentional startup allocation
  // phase. Leak assessment begins only after engine cycles become productive;
  // otherwise a bounded cold-start ramp is misclassified as a steady-state
  // leak. Dev starts productive immediately and uses the full sample series.
  const firstProductiveMemoryIndex = RUNTIME_MODE === "production"
    ? memory.findIndex((sample) => sample.engineCycles > 0)
    : 0
  const leakSeries = firstProductiveMemoryIndex >= 0
    ? rssSeries.slice(firstProductiveMemoryIndex)
    : []
  let rssLeakEvaluated = false
  if (leakSeries.length >= 6) {
    // Historical bootstrap is allowed a temporary peak. Leak detection starts
    // after the first third of the soak and compares the final resident set to
    // that warm baseline; one-time allocations that are released do not fail.
    const warmIndex = Math.min(leakSeries.length - 1, Math.floor(leakSeries.length / 3))
    const warmBaseline = leakSeries[warmIndex]
    const finalRss = leakSeries.at(-1)
    rssLeakEvaluated = true
    // Next dev retains compiler/HMR module graphs as routes are first touched;
    // production has no compiler and therefore keeps the stricter 512 MiB
    // post-warmup budget. Both remain overrideable for constrained hosts.
    if (finalRss - warmBaseline > RSS_GROWTH_LIMIT_KB) {
      throw new Error(
        `Post-warmup RSS kept growing: baseline=${warmBaseline}KiB final=${finalRss}KiB ` +
        `peak=${Math.max(...rssSeries)}KiB limit=${RSS_GROWTH_LIMIT_KB}KiB`,
      )
    }
  }

  latencies.sort((a, b) => a - b)
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] || 0
  console.log(JSON.stringify({
    success: true,
    mode: START_SIMULATED_ENGINE ? `${RUNTIME_MODE}-paper-engine` : `${RUNTIME_MODE}-read-only`,
    orderRequests: 0,
    durationMs: Date.now() - startedAt,
    symbols: SYMBOLS.length,
    rounds,
    requests,
    connectionId,
    siteInstanceId: [...siteIds][0],
    bootId: [...bootIds][0],
    progressionStart: progression[0],
    progressionEnd: progression.at(-1),
    progressionPeakScore: Math.max(...progression.map((sample) => sample.score)),
    rssStartKb: rssSeries[0] || 0,
    rssPeakKb: rssSeries.length ? Math.max(...rssSeries) : 0,
    rssEndKb: rssSeries.at(-1) || 0,
    rssGrowthLimitKb: RSS_GROWTH_LIMIT_KB,
    rssLeakEvaluated,
    rssLeakSamples: leakSeries.length,
    databaseKeysStart: memory[0]?.databaseKeys || 0,
    databaseKeysEnd: memory.at(-1)?.databaseKeys || 0,
    databaseStableGrowth,
    databaseStableGrowthLimit,
    databaseAbsoluteLimit,
    engineCyclesStart: memory[0]?.engineCycles || 0,
    engineCyclesEnd: memory.at(-1)?.engineCycles || 0,
    simulatedOrdersPeak: liveExecution.length ? Math.max(...liveExecution.map((sample) => sample.ordersSimulated)) : 0,
    simulatedPositionsCreatedPeak: liveExecution.length ? Math.max(...liveExecution.map((sample) => sample.positionsCreated)) : 0,
    simulatedPositionsPeak,
    realPositionsPeak,
    paperPositionsPeak,
    paperRunningSetsPeak,
    paperUpdateCyclesPeak,
    latencyP95Ms: p95,
  }, null, 2))
}

main().catch((error) => {
  console.error("[verify-prod-soak] failed:", error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
