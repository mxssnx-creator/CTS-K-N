#!/usr/bin/env node

/** Bounded production-mode engine/UI/API coordination soak (simulated orders only). */

const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3102}`
const MIN_DURATION_MS = Math.max(5_000, Number(process.env.SOAK_MIN_DURATION_MS || 60_000))
const DURATION_MS = Math.max(MIN_DURATION_MS, Number(process.env.SOAK_DURATION_MS || 90_000))
const POLL_MS = Math.max(750, Number(process.env.SOAK_POLL_MS || 2_000))
const SYMBOL_COUNT = Math.max(1, Math.min(32, Number(process.env.SYMBOL_COUNT || 12)))
const START_SIMULATED_ENGINE = process.env.START_SIMULATED_ENGINE === "1"
const SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT",
  "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "ATOMUSDT", "LTCUSDT",
  "UNIUSDT", "NEARUSDT", "OPUSDT", "ARBUSDT", "APTUSDT", "SUIUSDT",
  "INJUSDT", "TIAUSDT", "SEIUSDT", "WLDUSDT", "PYTHUSDT", "JUPUSDT",
  "TRXUSDT", "ETCUSDT", "FILUSDT", "AAVEUSDT", "RUNEUSDT", "FETUSDT",
  "ICPUSDT", "HBARUSDT",
].slice(0, SYMBOL_COUNT)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function request(pathname, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const started = Date.now()
  const response = await fetch(new URL(pathname, BASE_URL), {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
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
      body: { action: "enable", connectionId, symbolCount: SYMBOLS.length, symbols: SYMBOLS },
      timeoutMs: 120_000,
    })).json
    connectionId = String(quickStart?.connection?.id || connectionId)

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
      if (rounds % 10 === 0) {
        const raw = (await request(`/api/debug/progression-dump?id=${encodeURIComponent(connectionId)}`)).json
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
  }

  const rssSeries = memory.map((sample) => sample.rssKb).filter((value) => value > 0)
  if (rssSeries.length > 1) {
    // Historical bootstrap is allowed a temporary peak. Leak detection starts
    // after the first third of the soak and compares the final resident set to
    // that warm baseline; one-time allocations that are released do not fail.
    const warmIndex = Math.min(rssSeries.length - 1, Math.floor(rssSeries.length / 3))
    const warmBaseline = rssSeries[warmIndex]
    const finalRss = rssSeries.at(-1)
    if (finalRss - warmBaseline > 512 * 1024) {
      throw new Error(
        `Post-warmup RSS kept growing: baseline=${warmBaseline}KiB final=${finalRss}KiB ` +
        `peak=${Math.max(...rssSeries)}KiB`,
      )
    }
  }

  latencies.sort((a, b) => a - b)
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] || 0
  console.log(JSON.stringify({
    success: true,
    mode: START_SIMULATED_ENGINE ? "production-simulated-engine" : "production-read-only",
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
    databaseKeysStart: memory[0]?.databaseKeys || 0,
    databaseKeysEnd: memory.at(-1)?.databaseKeys || 0,
    engineCyclesStart: memory[0]?.engineCycles || 0,
    engineCyclesEnd: memory.at(-1)?.engineCycles || 0,
    latencyP95Ms: p95,
  }, null, 2))
}

main().catch((error) => {
  console.error("[verify-prod-soak] failed:", error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
