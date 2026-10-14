#!/usr/bin/env node

/**
 * Long-running engine observation on the production build (paper orders).
 *
 * Starts an isolated redis-server and the production server (.next-prod),
 * QuickStarts one connection with the requested basket in paper mode using
 * the system's own strategy thresholds (no bootstrap overrides), lets the
 * prehistoric bootstrap evaluate the configured window, then observes the
 * realtime phase. Every poll appends one JSON line with stage, position,
 * result, latency and memory figures; the end of the run writes the complete
 * simulated trade list and the final API snapshots for the report.
 *
 *   OBS_OUT_DIR=/path OBS_PREHISTORIC_HOURS=24 OBS_SYMBOL_COUNT=15 \
 *   OBS_REALTIME_MS=3600000 node scripts/run-engine-observation.mjs
 *
 * Exchange credentials are blanked in both modes, so this harness can never
 * submit an exchange order:
 *  - OBS_MARKET_DATA=real (default): public venue market data through the
 *    credential-less connector, paper orders (live trade off). Additionally
 *    LIVE_ORDER_CONNECTION_IDS names no connection (every exchange write is
 *    refused) and ALLOW_LIVE_ORDER_PLACEMENT=0 keeps mainnet placement off.
 *  - OBS_MARKET_DATA=synthetic: FORCE_SIMULATED=1 with the generated price
 *    fixture of the preview harnesses (no network at all).
 */

import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { createClient } from "redis"
import { startPreviewRedisHarness } from "./preview-redis-harness.mjs"

const port = Number(process.env.OBS_PORT || 3102)
const baseUrl = `http://127.0.0.1:${port}`
const distDir = process.env.NEXT_DIST_DIR || ".next-prod"
const outDir = path.resolve(process.env.OBS_OUT_DIR || `/tmp/cts-observation-${Date.now()}`)
// The paper default is the BingX public-data connection: picking "the first
// connection" took an unordered Redis set member (mexc-x01, no connector).
const connectionRequested = String(process.env.OBS_CONNECTION_ID || "bingx-x01").trim()
const symbolCount = Math.max(1, Math.min(128, Number(process.env.OBS_SYMBOL_COUNT || 15)))
const prehistoricHours = Math.max(1, Math.min(50, Number(process.env.OBS_PREHISTORIC_HOURS || 24)))
const realtimeMs = Math.max(60_000, Number(process.env.OBS_REALTIME_MS || 60 * 60_000))
const bootstrapTimeoutMs = Math.max(5 * 60_000, Number(process.env.OBS_BOOTSTRAP_TIMEOUT_MS || 4 * 60 * 60_000))
const pollMs = Math.max(5_000, Number(process.env.OBS_POLL_MS || 30_000))
const coverageEveryMs = Math.max(pollMs, Number(process.env.OBS_COVERAGE_MS || 5 * 60_000))
const exactReplay = process.env.OBS_EXACT_REPLAY === "1"
// "paper" (default) never has exchange credentials. "vst" trades the X02
// Prod-VST account (virtual funds) and only that connection may write orders.
const runMode = process.env.OBS_MODE === "vst" ? "vst" : "paper"
const VST_CONFIRMATION = "X02 Prod-VST virtual funds only"
const VST_CONNECTION_ID = "bingx-x02"
const VST_ORIGIN = "https://open-api-vst.bingx.com"
if (runMode === "vst") {
  if (process.env.OBS_VST_CONFIRM !== VST_CONFIRMATION) throw new Error(`OBS_MODE=vst requires OBS_VST_CONFIRM="${VST_CONFIRMATION}"`)
  if (String(process.env.BINGX_X02_API_KEY || "").length < 10 || String(process.env.BINGX_X02_API_SECRET || "").length < 10) {
    throw new Error("OBS_MODE=vst requires BINGX_X02_API_KEY/SECRET in the environment")
  }
  if (connectionRequested && connectionRequested !== VST_CONNECTION_ID) throw new Error(`OBS_MODE=vst runs ${VST_CONNECTION_ID} only`)
}
// "real": public venue market data, paper orders (default). "synthetic": the
// offline preview fixture (FORCE_SIMULATED, generated prices).
const marketDataMode = runMode === "paper" && process.env.OBS_MARKET_DATA === "synthetic" ? "synthetic" : "real"
// Local scheduler <-> server shared secret for the cron routes (close accounting).
const cronSecret = randomBytes(24).toString("hex")
const quickStartExtra = (() => {
  const raw = String(process.env.OBS_QUICKSTART_EXTRA || "").trim()
  if (!raw) return {}
  const parsed = JSON.parse(raw)
  for (const forbidden of ["liveTrade", "is_live_trade", "symbols", "connectionId"]) {
    if (forbidden in parsed) throw new Error(`OBS_QUICKSTART_EXTRA may not override ${forbidden}`)
  }
  return parsed
})()
const BASKET = [
  "BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT", "ETHUSDT", "BNBUSDT", "DOGEUSDT",
  "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "ATOMUSDT", "LTCUSDT",
  "UNIUSDT", "NEARUSDT", "OPUSDT", "ARBUSDT", "APTUSDT", "SUIUSDT", "TRXUSDT",
]
const symbols = String(process.env.OBS_SYMBOLS || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
const basket = symbols.length > 0 ? symbols : BASKET.slice(0, symbolCount)

mkdirSync(outDir, { recursive: true })
const samplesPath = path.join(outDir, "samples.jsonl")
const eventsPath = path.join(outDir, "events.jsonl")
const serverLogPath = path.join(outDir, "server.log")
rmSync(samplesPath, { force: true })
rmSync(eventsPath, { force: true })
const snapshotPath = path.join(outDir, `redis-snapshot-${process.pid}.json`)
for (const file of [snapshotPath, `${snapshotPath}.live-wal`]) rmSync(file, { force: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const event = (type, detail = {}) => {
  const line = { at: new Date().toISOString(), type, ...detail }
  appendFileSync(eventsPath, `${JSON.stringify(line)}\n`)
  console.log(`[observe] ${line.at} ${type} ${JSON.stringify(detail).slice(0, 400)}`)
}

async function request(pathname, { method = "GET", body, timeoutMs = 60_000 } = {}) {
  const started = Date.now()
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  const ms = Date.now() - started
  let json = null
  try { json = JSON.parse(text) } catch { /* reported by the caller */ }
  return { ok: response.ok, status: response.status, ms, json, text: json ? "" : text.slice(0, 300) }
}

async function safeRequest(pathname, options) {
  try {
    return await request(pathname, options)
  } catch (error) {
    return { ok: false, status: 0, ms: 0, json: null, text: error instanceof Error ? error.message : String(error) }
  }
}

let serverChild = null
let redisHarness = null
let redisClient = null
let stopping = false

function startServer(redisEnvironment) {
  const child = spawn(process.execPath, ["scripts/start-production.mjs"], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      ...redisEnvironment,
      NODE_ENV: "production",
      NEXT_DIST_DIR: distDir,
      HOST: "127.0.0.1",
      PORT: String(port),
      DISABLE_TRADE_ENGINE_AUTOSTART: "1",
      DISABLE_TRADE_ENGINE_IN_PROCESS: "0",
      DISABLE_IN_PROCESS_CONTINUITY: "0",
      ALLOW_PROD_INLINE_REDIS: "0",
      ALLOW_INLINE_REDIS_LIVE_TRADING: "0",
      ...(marketDataMode === "synthetic"
        ? { ALLOW_PROD_SIMULATED: "1", FORCE_SIMULATED: "1" }
        : { ALLOW_PROD_SIMULATED: "0", FORCE_SIMULATED: "0" }),
      FORCE_LIVE: "0",
      CTS_LIVE_TRADING_CONFIGURED: "0",
      // Paper: no connection may write. VST: only X02; mainnet placement stays
      // off (ALLOW_LIVE_ORDER_PLACEMENT=0 admits BingX Prod-VST only).
      LIVE_ORDER_CONNECTION_IDS: runMode === "vst" ? VST_CONNECTION_ID : "__paper_only__",
      ALLOW_LIVE_ORDER_PLACEMENT: "0",
      CRON_SECRET: cronSecret,
      PREHISTORIC_RANGE_HOURS: String(prehistoricHours),
      ...(exactReplay ? { PREHISTORIC_EXACT_CONNECTIONS: connectionRequested || "bingx-x02" } : {}),
      V0_DEV_SYMBOL_COUNT: String(basket.length),
      CRON_SYMBOL_LIMIT: String(basket.length),
      CTS_NODE_HEAP_MB: process.env.OBS_NODE_HEAP_MB || "5632",
      CTS_MEMORY_LIMIT_MB: process.env.OBS_MEMORY_LIMIT_MB || "9216",
      CTS_RSS_SOFT_LIMIT_MB: process.env.OBS_RSS_SOFT_LIMIT_MB || "5120",
      CTS_RSS_HARD_LIMIT_MB: process.env.OBS_RSS_HARD_LIMIT_MB || "8192",
      MARKET_DATA_LOAD_CONCURRENCY: "1",
      BINGX_API_KEY: "",
      BINGX_API_SECRET: "",
      BINGX_APIKEY: "",
      BINGX_SECRET: "",
      BINGX_SECRET_KEY: "",
      ...(runMode === "vst"
        ? {
            BINGX_X02_API_KEY: process.env.BINGX_X02_API_KEY,
            BINGX_X02_API_SECRET: process.env.BINGX_X02_API_SECRET,
            BINGX_VST_ORIGIN: VST_ORIGIN,
            // Own client-order prefix: the deployed CTS-K-N and CTS-G orders on
            // the same account are foreign to this run and stay untouched.
            CTS_SYSTEM_ID: "cts-k-n-cloud",
            CTS_ACCEPT_LEGACY_ORDER_PREFIX: "0",
          }
        : { BINGX_X02_API_KEY: "", BINGX_X02_API_SECRET: "" }),
      BYBIT_API_KEY: "",
      BYBIT_API_SECRET: "",
      PIONEX_API_KEY: "",
      PIONEX_API_SECRET: "",
      ORANGEX_API_KEY: "",
      ORANGEX_API_SECRET: "",
      V0_REDIS_SNAPSHOT_PATH: snapshotPath,
      NODE_OPTIONS: ["--max-old-space-size=5632", "--max-semi-space-size=128", "--expose-gc"].join(" "),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const log = (chunk) => appendFileSync(serverLogPath, chunk)
  child.stdout.on("data", log)
  child.stderr.on("data", log)
  child.once("exit", (code, signal) => event("server_exit", { code, signal }))
  return child
}

async function waitForReady(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (serverChild?.exitCode != null) throw new Error(`server exited with ${serverChild.exitCode}`)
    const health = await safeRequest("/api/health/liveness", { timeoutMs: 2_000 })
    if (health.ok) return
    await sleep(500)
  }
  throw new Error("server did not become ready")
}

/** Resident memory of the server's process group in MiB. */
function serverRssMb() {
  if (!serverChild?.pid) return null
  const result = spawnSync("ps", ["-o", "rss=", "-g", String(serverChild.pid)], { encoding: "utf8" })
  if (result.status !== 0) return null
  const kb = result.stdout.split("\n").map(Number).filter(Number.isFinite).reduce((sum, value) => sum + value, 0)
  return Math.round(kb / 1024)
}

async function redisFigures() {
  if (!redisClient) return null
  try {
    const [size, memory] = await Promise.all([redisClient.dbSize(), redisClient.info("memory")])
    const used = Number((/used_memory:(\d+)/.exec(memory) || [])[1] || 0)
    return { keys: size, usedMb: Math.round(used / 1048576) }
  } catch {
    return null
  }
}

/** Source and first/last candle of each symbol's stored 1s series (real venue vs. synthetic). */
async function marketDataSources(connectionId) {
  if (!redisClient) return null
  const result = {}
  for (const symbol of basket) {
    try {
      const raw = await redisClient.get(`market_data:${connectionId}:${symbol}:1s`)
      const envelope = raw ? JSON.parse(raw) : null
      const meta = JSON.parse((await redisClient.get(`market_data:${connectionId}:${symbol}:history:meta`)) || "null")
      result[symbol] = {
        source: envelope?.source ?? null,
        lastClose: envelope?.candles?.[envelope.candles.length - 1]?.close ?? null,
        historyCandles: meta?.candleCount ?? null,
      }
    } catch {
      result[symbol] = { source: null }
    }
  }
  return result
}

function runCoverage(connectionId) {
  const result = spawnSync(process.execPath, ["scripts/verify-runtime-coverage.mjs", "--json", "--report-only"], {
    cwd: process.cwd(),
    env: { ...process.env, BASE_URL: baseUrl, CONNECTION_ID: connectionId, COVERAGE_REQUIRE_STAGES: "1" },
    encoding: "utf8",
    timeout: 120_000,
  })
  try {
    return JSON.parse(String(result.stdout || "").trim().split("\n").pop() || "null")
  } catch {
    return { errors: 1, warnings: 0, findings: [{ severity: "error", area: "coverage", message: "checker output unreadable" }] }
  }
}

const num = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function compactStats(stats) {
  if (!stats) return null
  const detail = stats.strategyDetail || {}
  const stage = (name) => ({
    evaluated: num(detail[name]?.evaluated),
    passed: num(detail[name]?.passed),
    created: num(detail[name]?.createdSets),
    running: num(detail[name]?.setsRunningNow),
    pf: num(detail[name]?.avgProfitFactor),
  })
  return {
    phase: stats.metadata?.phase || null,
    prehistoric: stats.historic
      ? {
          complete: stats.historic.isComplete === true,
          processed: num(stats.historic.symbolsProcessed),
          total: num(stats.historic.symbolsTotal),
          candles: num(stats.historic.candlesLoaded),
          frames: num(stats.historic.framesProcessed),
          progressPercent: num(stats.historic.progressPercent),
          configWork: stats.historic.configWork
            ? { completed: num(stats.historic.configWork.completed), total: num(stats.historic.configWork.total), failed: num(stats.historic.configWork.failed) }
            : null,
          profitFactor: num(stats.prehistoricMeta?.historicAvgProfitFactor),
          profitFactorCount: num(stats.prehistoricMeta?.historicAvgProfitFactorCount),
        }
      : null,
    cycles: num(stats.realtime?.indicationCycles),
    strategiesTotal: num(stats.realtime?.strategiesTotal),
    stages: { base: stage("base"), main: stage("main"), real: stage("real"), live: stage("live") },
    open: {
      pseudo: num(stats.openPositions?.pseudo?.open),
      real: num(stats.openPositions?.real?.open),
      live: num(stats.openPositions?.live?.open),
    },
    dispatch: stats.liveExecution?.dispatchOutcome || null,
    liveTier: stats.performanceTiers?.live
      ? {
          pf: num(stats.performanceTiers.live.avgProfitFactor),
          winRate: num(stats.performanceTiers.live.winRate),
          totalPnl: num(stats.performanceTiers.live.totalPnl),
          created: num(stats.performanceTiers.live.totalCreated),
          closed: num(stats.performanceTiers.live.totalClosed),
        }
      : null,
  }
}

async function collectSimulatedTrades(connectionId) {
  const rows = []
  const seen = new Set()
  let offset = 0
  for (let page = 0; page < 400; page++) {
    const response = await safeRequest(
      `/api/trading/trade-history?connection_id=${encodeURIComponent(connectionId)}&mode=simulated&offset=${offset}&limit=500`,
      { timeoutMs: 120_000 },
    )
    const pageRows = Array.isArray(response.json?.rows) ? response.json.rows : []
    for (const row of pageRows) {
      const id = String(row?.id || row?.positionId || "")
      if (!id || seen.has(id)) continue
      seen.add(id)
      rows.push(row)
    }
    const next = response.json?.paging?.nextOffset
    if (!response.ok || next === null || next === undefined || pageRows.length === 0) break
    offset = Number(next)
  }
  return rows
}

function summarizeTrades(rows) {
  const closed = rows.filter((row) => Number(row?.closedAt) > 0 && Number.isFinite(Number(row?.realizedPnl)))
  let grossProfit = 0, grossLoss = 0, wins = 0, losses = 0, net = 0, fees = 0
  const byHour = new Map()
  for (const row of closed) {
    const pnl = Number(row.realizedPnl)
    net += pnl
    fees += Number(row.fees) || 0
    if (pnl > 0) { wins++; grossProfit += pnl } else if (pnl < 0) { losses++; grossLoss -= pnl }
    const hour = Math.floor(Number(row.closedAt) / 3_600_000)
    byHour.set(hour, (byHour.get(hour) || 0) + pnl)
  }
  const hours = [...byHour.values()]
  return {
    closed: closed.length,
    wins,
    losses,
    net,
    fees,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    activeHours: hours.length,
    profitableHours: hours.filter((value) => value > 0).length,
  }
}

let schedulerChild = null
let liveConnectionId = ""

/** The minute scheduler drives the cron routes (close accounting, live sync) like production. */
function startScheduler() {
  const child = spawn(process.execPath, ["scripts/run-minute-scheduler.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "production", SCHEDULER_BASE_URL: baseUrl, CRON_SECRET: cronSecret },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const log = (chunk) => appendFileSync(path.join(outDir, "scheduler.log"), chunk)
  child.stdout.on("data", log)
  child.stderr.on("data", log)
  return child
}

/** Own open exchange rows and their protection, plus the settled results (VST). */
async function liveFigures(connectionId) {
  const [rows, book] = await Promise.all([
    openLiveRows(connectionId),
    safeRequest(`/api/results/book?connectionId=${encodeURIComponent(connectionId)}`, { timeoutMs: 60_000 }),
  ])
  const has = (value) => String(value ?? "").trim().length > 0
  const all = book.json?.windows?.all || null
  return {
    open: rows.length,
    withStopLoss: rows.filter((row) => has(row?.stopLossOrderId)).length,
    withTakeProfit: rows.filter((row) => has(row?.takeProfitOrderId)).length,
    withSecurityStop: rows.filter((row) => has(row?.securityStopOrderId) || has(row?.sharedSecurityOrderId)).length,
    settled: all?.settled ?? null,
    accountingPending: all?.accountingPending ?? null,
    profitFactor: all?.profitFactor ?? null,
    net: all?.net ?? null,
    hours: all?.hours ?? null,
  }
}

async function openLiveRows(connectionId) {
  const response = await safeRequest(`/api/trading/live-positions?connection_id=${encodeURIComponent(connectionId)}&closedLimit=1`, { timeoutMs: 60_000 })
  const rows = Array.isArray(response.json?.positions) ? response.json.positions : Array.isArray(response.json?.data) ? response.json.data : []
  return rows.filter((row) => ["open", "filled", "partially_filled", "closing", "closing_partial"].includes(String(row?.status || "").toLowerCase()))
}

/**
 * VST close-out: no new entries, then a coordinated reduce-only close of every
 * own open row (the same route the dashboard uses), until none is left.
 */
async function closeOut(connectionId) {
  const disable = await safeRequest(`/api/settings/connections/${encodeURIComponent(connectionId)}/live-trade`, {
    method: "POST",
    body: { is_live_trade: false },
    timeoutMs: 60_000,
  })
  event("closeout_live_trade_off", { status: disable.status })
  const deadline = Date.now() + 10 * 60_000
  let attempts = 0
  let open = await openLiveRows(connectionId)
  const initial = open.length
  while (open.length > 0 && Date.now() < deadline) {
    for (const row of open) {
      if (String(row?.status || "").toLowerCase().startsWith("closing")) continue
      attempts++
      const response = await safeRequest(
        `/api/trading/live-positions/${encodeURIComponent(String(row.id))}?connectionId=${encodeURIComponent(connectionId)}`,
        { method: "DELETE", timeoutMs: 90_000 },
      )
      event("closeout_close", { status: response.status, state: response.json?.state ?? null })
    }
    await sleep(10_000)
    open = await openLiveRows(connectionId)
  }
  event("closeout_done", { initialOpen: initial, closeRequests: attempts, stillOpen: open.length })
  return open.length
}

async function stop(reason) {
  if (stopping) return
  stopping = true
  event("stopping", { reason })
  if (runMode === "vst" && liveConnectionId && serverChild?.exitCode == null) {
    try { await closeOut(liveConnectionId) } catch (error) { event("closeout_failed", { error: error instanceof Error ? error.message : String(error) }) }
  }
  if (schedulerChild?.pid && schedulerChild.exitCode == null) {
    try { schedulerChild.kill("SIGTERM") } catch { /* already gone */ }
  }
  if (serverChild?.pid && serverChild.exitCode == null) {
    try { process.kill(-serverChild.pid, "SIGTERM") } catch { /* already gone */ }
    const deadline = Date.now() + 20_000
    while (serverChild.exitCode == null && Date.now() < deadline) await sleep(250)
    if (serverChild.exitCode == null) {
      try { process.kill(-serverChild.pid, "SIGKILL") } catch { /* already gone */ }
    }
  }
  try { await redisClient?.quit() } catch { /* closed */ }
  await redisHarness?.stop().catch(() => undefined)
}

process.on("SIGINT", () => { void stop("SIGINT").then(() => process.exit(130)) })
process.on("SIGTERM", () => { void stop("SIGTERM").then(() => process.exit(143)) })

async function main() {
  if (!existsSync(path.join(distDir, "BUILD_ID")) && !existsSync(path.join(distDir, "standalone"))) {
    throw new Error(`no production build in ${distDir}; run NEXT_DIST_DIR=${distDir} pnpm build first`)
  }
  redisHarness = await startPreviewRedisHarness({ required: true, label: "engine observation" })
  redisClient = createClient({ url: redisHarness.environment.REDIS_URL })
  redisClient.on("error", () => {})
  await redisClient.connect()
  event("redis_ready", { kind: redisHarness.kind })

  serverChild = startServer(redisHarness.environment)
  await waitForReady()
  event("server_ready", { distDir, port, runMode })
  schedulerChild = startScheduler()

  const inventory = await request("/api/connections")
  const connections = Array.isArray(inventory.json?.connections) ? inventory.json.connections : []
  const wanted = runMode === "vst" ? VST_CONNECTION_ID : connectionRequested
  const selected = wanted
    ? connections.find((connection) => String(connection?.id) === wanted)
    : connections[0]
  if (!selected) throw new Error(`connection ${wanted || "(first)"} not available`)
  let connectionId = String(selected.id)
  if (runMode === "vst") {
    const testnet = ["1", "true", "yes"].includes(String(selected.is_testnet ?? selected.isTestnet ?? "").toLowerCase()) ||
      String(selected.environment || "").toLowerCase() === "prod-vst"
    if (!testnet) throw new Error(`${connectionId} is not a Prod-VST (testnet) connection; refusing to trade`)
  }

  const quickStart = await request("/api/trade-engine/quick-start", {
    method: "POST",
    body: {
      action: "enable",
      connectionId,
      symbolCount: basket.length,
      symbols: basket,
      liveTrade: runMode === "vst",
      is_live_trade: runMode === "vst",
      // VST: the exchange minimum per order (the calculator clamps up to it).
      ...(runMode === "vst" ? { liveVolumeFactor: "0.1" } : {}),
      ...quickStartExtra,
    },
    timeoutMs: 180_000,
  })
  if (!quickStart.ok) throw new Error(`QuickStart failed: HTTP ${quickStart.status} ${quickStart.text}`)
  connectionId = String(quickStart.json?.connection?.id || connectionId)
  if (runMode === "vst") {
    liveConnectionId = connectionId
    if (connectionId !== VST_CONNECTION_ID) throw new Error(`QuickStart switched to ${connectionId}; refusing`)
    if (quickStart.json?.connection?.liveTradeEnabled !== true) {
      throw new Error(`live trade not enabled on ${connectionId}: ${String(quickStart.json?.connection?.liveTradeBlockedReason || quickStart.json?.connection?.live_trade_blocked_reason || "no reason given").slice(0, 200)}`)
    }
  } else if (quickStart.json?.connection?.liveTradeEnabled !== false) {
    throw new Error("observation must run in paper mode")
  }
  const startedAt = Date.now()
  event("quickstart", { connectionId, runMode, symbols: basket, prehistoricHours, exactReplay, marketDataMode, extra: quickStartExtra })
  writeFileSync(path.join(outDir, "run.json"), JSON.stringify({
    connectionId, runMode, symbols: basket, prehistoricHours, exactReplay, marketDataMode, realtimeMs, pollMs,
    startedAt: new Date(startedAt).toISOString(), quickStartExtra,
  }, null, 2))

  let bootstrapDoneAt = 0
  let lastCoverageAt = 0
  let lastPhase = ""
  const rssStart = serverRssMb()
  while (true) {
    const now = Date.now()
    const [stats, overview, status] = await Promise.all([
      safeRequest(`/api/connections/progression/${encodeURIComponent(connectionId)}/stats`, { timeoutMs: 120_000 }),
      safeRequest(`/api/trade-engine/functional-overview?connectionId=${encodeURIComponent(connectionId)}`, { timeoutMs: 120_000 }),
      safeRequest("/api/trade-engine/status", { timeoutMs: 60_000 }),
    ])
    const compact = compactStats(stats.json)
    const prehistoricComplete = compact?.prehistoric?.complete === true
    if (!bootstrapDoneAt && prehistoricComplete) {
      bootstrapDoneAt = now
      event("prehistoric_complete", { afterMs: now - startedAt, prehistoric: compact?.prehistoric, marketData: await marketDataSources(connectionId) })
      writeFileSync(path.join(outDir, "stats-after-prehistoric.json"), JSON.stringify(stats.json))
      // A run without market data evaluates nothing: stop instead of observing it for hours.
      if (Number(stats.json?.historic?.candlesLoaded) <= 0) throw new Error(`${connectionId}: prehistoric phase complete with 0 candles (no market data)`)
    }
    if (compact?.phase && compact.phase !== lastPhase) {
      lastPhase = compact.phase
      event("phase", { phase: compact.phase })
    }
    let coverage = null
    if (bootstrapDoneAt && now - lastCoverageAt >= coverageEveryMs) {
      lastCoverageAt = now
      coverage = runCoverage(connectionId)
    }
    const sample = {
      at: new Date(now).toISOString(),
      elapsedMs: now - startedAt,
      realtimeMs: bootstrapDoneAt ? now - bootstrapDoneAt : 0,
      http: {
        stats: { status: stats.status, ms: stats.ms },
        overview: { status: overview.status, ms: overview.ms },
        status: { status: status.status, ms: status.ms },
      },
      rssMb: serverRssMb(),
      redis: await redisFigures(),
      stats: compact,
      overview: overview.json
        ? {
            prehistoricDataLoaded: overview.json.prehistoricDataLoaded ?? null,
            stageSnapshots: overview.json.stageSnapshots ?? null,
            strategiesEvaluatedByStage: overview.json.strategiesEvaluatedByStage ?? null,
          }
        : null,
      live: runMode === "vst" ? await liveFigures(connectionId) : undefined,
      engineRunning: Array.isArray(status.json?.engines)
        ? status.json.engines.some((engine) => String(engine?.connectionId) === connectionId && engine?.isRunning)
        : status.json?.running ?? null,
      coverage: coverage ? { errors: coverage.errors, warnings: coverage.warnings, findings: coverage.findings?.slice(0, 20) } : undefined,
    }
    appendFileSync(samplesPath, `${JSON.stringify(sample)}\n`)
    console.log(
      `[observe] ${sample.at} t=${Math.round(sample.elapsedMs / 1000)}s phase=${compact?.phase || "?"} ` +
      `pre=${JSON.stringify(compact?.prehistoric)} stages=${JSON.stringify(compact?.stages)} ` +
      `open=${JSON.stringify(compact?.open)} rss=${sample.rssMb}MB redis=${JSON.stringify(sample.redis)}` +
      (coverage ? ` coverage=${coverage.errors}e/${coverage.warnings}w` : ""),
    )
    if (serverChild.exitCode != null) throw new Error("server exited during observation")
    if (!bootstrapDoneAt && now - startedAt > bootstrapTimeoutMs) {
      event("bootstrap_timeout", { afterMs: now - startedAt })
      break
    }
    if (bootstrapDoneAt && now - bootstrapDoneAt >= realtimeMs) break
    await sleep(pollMs)
  }

  // Final snapshots for the report.
  const [finalStats, finalOverview, results, history] = await Promise.all([
    safeRequest(`/api/connections/progression/${encodeURIComponent(connectionId)}/stats`, { timeoutMs: 180_000 }),
    safeRequest(`/api/trade-engine/functional-overview?connectionId=${encodeURIComponent(connectionId)}`, { timeoutMs: 180_000 }),
    safeRequest(`/api/results/book?connectionId=${encodeURIComponent(connectionId)}`, { timeoutMs: 180_000 }),
    collectSimulatedTrades(connectionId),
  ])
  writeFileSync(path.join(outDir, "stats-final.json"), JSON.stringify(finalStats.json))
  writeFileSync(path.join(outDir, "overview-final.json"), JSON.stringify(finalOverview.json))
  writeFileSync(path.join(outDir, "results-book-final.json"), JSON.stringify(results.json))
  writeFileSync(path.join(outDir, "simulated-trades.json"), JSON.stringify(history))
  const coverage = runCoverage(connectionId)
  writeFileSync(path.join(outDir, "coverage-final.json"), JSON.stringify(coverage))
  const summary = {
    connectionId,
    symbols: basket,
    prehistoricHours,
    exactReplay,
    startedAt: new Date(startedAt).toISOString(),
    prehistoricCompleteAfterMs: bootstrapDoneAt ? bootstrapDoneAt - startedAt : null,
    realtimeObservedMs: bootstrapDoneAt ? Date.now() - bootstrapDoneAt : 0,
    rssStartMb: rssStart,
    rssEndMb: serverRssMb(),
    trades: summarizeTrades(history),
    coverage: { errors: coverage?.errors ?? null, warnings: coverage?.warnings ?? null },
  }
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2))
  event("finished", summary)
}

main()
  .catch((error) => {
    event("failed", { error: error instanceof Error ? error.message : String(error) })
    process.exitCode = 1
  })
  .finally(() => stop("done"))
