#!/usr/bin/env node
/**
 * Offline N-symbol end-to-end engine soak (paper/simulated only).
 *
 * Runs the production build (NEXT_DIST_DIR, default .next-offline — build it
 * first with `NEXT_DIST_DIR=.next-offline pnpm run build`) through
 * scripts/start-production.mjs with the full in-process engine, synthetic
 * candles (FORCE_SIMULATED=1), empty credentials, a throwaway loopback Redis
 * and the fail-closed loopback-only network guard
 * (scripts/test-network-isolation.cjs). The existing
 * scripts/verify-prod-soak.mjs drives QuickStart and the Base->Main->Real->Live
 * lifecycle; this driver adds a parallel sampler (RSS, Redis keys, stats API
 * NaN scan, realtime pass timing), a one-second liveness prober (HTTP
 * responsiveness while the engine computes on the same thread), a final
 * stats-vs-ledger audit (scripts/audit-offline-engine-stats.mjs) and a
 * per-symbol Set inventory, written as a JSON report plus a Markdown summary.
 *
 *   OFFLINE_SYMBOL_COUNT=70                    4..128 symbols (forced order first)
 *   OFFLINE_SYMBOLS=BTCUSDT,SOLUSDT,...        explicit list (overrides the count)
 *   OFFLINE_REDIS_URL=redis://127.0.0.1:6399   (loopback only, flushed per run)
 *   OFFLINE_NORMAL=on|off                      Normal strategy toggle
 *   OFFLINE_DURATION_MS=600000                 measured soak window
 *   OFFLINE_SYNTHETIC_VOLATILITY=40            synthetic random-walk multiplier
 *   OFFLINE_CYCLE_DIAGNOSTIC_MS=5000           log every realtime pass slower than this
 *   OFFLINE_PORT=3132  OFFLINE_REPORT=<path.json>  OFFLINE_REPORT_MD=<path.md>
 *   OFFLINE_LABEL=<text>                       label written into the report
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import process from "node:process"
import { createClient } from "redis"
import { runAudit, sampleOnce } from "./audit-offline-engine-stats.mjs"

// The engine always puts these four first (lib/forced-symbols.ts) and the
// verifier compares the published basket in exact order.
const SYMBOL_UNIVERSE = [
  "BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT", "ETHUSDT", "BNBUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT",
  "DOTUSDT", "ATOMUSDT", "LTCUSDT", "UNIUSDT", "NEARUSDT", "OPUSDT", "ARBUSDT", "APTUSDT", "SUIUSDT", "INJUSDT",
  "TIAUSDT", "SEIUSDT", "WLDUSDT", "PYTHUSDT", "JUPUSDT", "TRXUSDT", "ETCUSDT", "FILUSDT", "AAVEUSDT", "RUNEUSDT",
  "FETUSDT", "ICPUSDT", "HBARUSDT", "XLMUSDT", "ALGOUSDT", "VETUSDT", "SANDUSDT", "MANAUSDT", "AXSUSDT", "GALAUSDT",
  "CRVUSDT", "LDOUSDT", "STXUSDT", "IMXUSDT", "ORDIUSDT", "WIFUSDT", "ENAUSDT", "TONUSDT", "KASUSDT", "HYPEUSDT",
  "PEPEUSDT", "SHIBUSDT", "BONKUSDT", "FLOKIUSDT", "ONDOUSDT", "RENDERUSDT", "TAOUSDT", "MKRUSDT", "COMPUSDT", "SNXUSDT",
  "DYDXUSDT", "GMXUSDT", "PENDLEUSDT", "JTOUSDT", "STRKUSDT", "ZROUSDT", "EIGENUSDT", "POLUSDT", "MNTUSDT", "EGLDUSDT",
  "FLOWUSDT", "CHZUSDT", "APEUSDT", "BLURUSDT", "MINAUSDT", "KSMUSDT", "ZECUSDT", "DASHUSDT", "XTZUSDT", "EOSUSDT",
  "IOTAUSDT", "NEOUSDT", "QTUMUSDT", "ZILUSDT", "ONEUSDT", "ROSEUSDT", "KAVAUSDT", "CELOUSDT", "ARUSDT", "GRTUSDT",
  "THETAUSDT", "ENSUSDT", "SUSHIUSDT", "1INCHUSDT", "YFIUSDT", "BALUSDT", "ZRXUSDT", "BATUSDT", "ANKRUSDT", "SKLUSDT",
  "STORJUSDT", "LRCUSDT", "MASKUSDT", "CFXUSDT", "AGLDUSDT", "MAGICUSDT", "HOOKUSDT", "IDUSDT", "ARKMUSDT", "CYBERUSDT",
  "MEMEUSDT", "ACEUSDT", "NFPUSDT", "AIUSDT", "XAIUSDT", "MANTAUSDT", "ALTUSDT", "PIXELUSDT", "PORTALUSDT", "AEVOUSDT",
  "BOMEUSDT", "ETHFIUSDT", "SAGAUSDT", "WUSDT", "NOTUSDT", "IOUSDT", "ZKUSDT", "BBUSDT",
]

function resolveSymbols() {
  const explicit = String(process.env.OFFLINE_SYMBOLS || "")
    .split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)
  if (explicit.length > 0) {
    if (new Set(explicit).size !== explicit.length) throw new Error("OFFLINE_SYMBOLS contains duplicates")
    return explicit
  }
  const count = Math.round(Number(process.env.OFFLINE_SYMBOL_COUNT || 70))
  if (!Number.isFinite(count) || count < 4 || count > SYMBOL_UNIVERSE.length) {
    throw new Error(`OFFLINE_SYMBOL_COUNT must be 4..${SYMBOL_UNIVERSE.length}`)
  }
  return SYMBOL_UNIVERSE.slice(0, count)
}

const SYMBOLS = resolveSymbols()
const tag = `[offline-${SYMBOLS.length}]`
const redisUrl = process.env.OFFLINE_REDIS_URL || "redis://127.0.0.1:6399"
if (!/^redis:\/\/(127\.0\.0\.1|localhost):\d+$/.test(redisUrl)) throw new Error("OFFLINE_REDIS_URL must be loopback")
const port = Number(process.env.OFFLINE_PORT || 3132)
const baseUrl = `http://127.0.0.1:${port}`
const distDir = process.env.NEXT_DIST_DIR || ".next-offline"
const normalOff = process.env.OFFLINE_NORMAL === "off"
const durationMs = Number(process.env.OFFLINE_DURATION_MS || 600_000)
const heapMb = Number(process.env.OFFLINE_NODE_HEAP_MB || 8192)
const cycleDiagnosticMs = Math.max(5_000, Number(process.env.OFFLINE_CYCLE_DIAGNOSTIC_MS || 5_000) || 5_000)
const label = String(process.env.OFFLINE_LABEL || "")
const reportPath = process.env.OFFLINE_REPORT ||
  `offline-${SYMBOLS.length === 50 ? 50 : SYMBOLS.length}-${normalOff ? "normal-off" : "normal-on"}.json`
const reportMdPath = process.env.OFFLINE_REPORT_MD || reportPath.replace(/\.json$/i, "") + ".md"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** OFFLINE_EXTRA_ENV='{"KEY":"value"}' adds server variables (never live-trading switches). */
function extraServerEnv() {
  if (!process.env.OFFLINE_EXTRA_ENV) return {}
  const parsed = JSON.parse(process.env.OFFLINE_EXTRA_ENV)
  const forbidden = /^(FORCE_LIVE|FORCE_SIMULATED|ALLOW_LIVE_ORDER_PLACEMENT|ALLOW_INLINE_REDIS_LIVE_TRADING|CTS_LIVE_TRADING_CONFIGURED|.*API_KEY|.*API_SECRET|REDIS_URL)$/
  return Object.fromEntries(Object.entries(parsed || {})
    .filter(([key]) => !forbidden.test(key))
    .map(([key, value]) => [key, String(value)]))
}

if (!existsSync(resolve(distDir, "standalone", "server.js")) && !existsSync(resolve(distDir, "BUILD_ID"))) {
  throw new Error(`Missing production build in ${distDir}; run NEXT_DIST_DIR=${distDir} pnpm run build`)
}

try {
  await fetch(`${baseUrl}/api/health/liveness`, { signal: AbortSignal.timeout(1_000) })
  throw new Error(`port ${port} is already serving; stop the previous server first`)
} catch (error) {
  if (String(error?.message || "").includes("already serving")) throw error
}

const redis = createClient({ url: redisUrl })
redis.on("error", () => {})
await redis.connect()
await redis.flushAll()

const serverLog = []
const cycleDiagnostics = []
const server = spawn(process.execPath, ["scripts/start-production.mjs"], {
  cwd: process.cwd(),
  detached: true,
  env: {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8",
    NODE_ENV: "production", NEXT_DIST_DIR: distDir, HOST: "127.0.0.1", PORT: String(port),
    NEXT_TELEMETRY_DISABLED: "1",
    REDIS_URL: redisUrl, ALLOW_PROD_INLINE_REDIS: "0", ALLOW_INLINE_REDIS_LIVE_TRADING: "0",
    DISABLE_TRADE_ENGINE_AUTOSTART: "1", DISABLE_TRADE_ENGINE_IN_PROCESS: "0", DISABLE_IN_PROCESS_CONTINUITY: "0",
    // Base validates on measured history (default gate on). Prehistoric
    // closes seed the Base type×direction buckets, so a fresh database
    // reaches Main/Real/Live with the default. OFFLINE_BASE_REQUIRE_MEASURED_HISTORY=0
    // selects the estimate-only escape hatch for comparison runs.
    CTS_BASE_REQUIRE_MEASURED_HISTORY: process.env.OFFLINE_BASE_REQUIRE_MEASURED_HISTORY || "1",
    // Paper fixture volatility (~1.5%/h) so positions can reach TP/SL in a bounded run.
    CTS_SYNTHETIC_VOLATILITY_MULTIPLIER: process.env.OFFLINE_SYNTHETIC_VOLATILITY || "40",
    ALLOW_PROD_SIMULATED: "1", FORCE_SIMULATED: "1", FORCE_LIVE: "0", ALLOW_LIVE_ORDER_PLACEMENT: "0",
    V0_DEV_SYMBOL_COUNT: String(SYMBOLS.length), CRON_SYMBOL_LIMIT: String(SYMBOLS.length),
    CTS_NODE_HEAP_MB: String(heapMb),
    CTS_MEMORY_LIMIT_MB: process.env.OFFLINE_MEMORY_LIMIT_MB || "12288",
    CTS_RSS_SOFT_LIMIT_MB: process.env.OFFLINE_RSS_SOFT_LIMIT_MB || "7168",
    CTS_RSS_HARD_LIMIT_MB: process.env.OFFLINE_RSS_HARD_LIMIT_MB || "10240",
    CTS_STRATEGY_MEMORY_MAX_ACTIVE_FLOWS: "1",
    ENGINE_SYMBOL_CONCURRENCY: "2", STRATEGY_FLOW_SYMBOL_CONCURRENCY: "2", PREHISTORIC_SYMBOL_CONCURRENCY: "1",
    PREHISTORIC_RANGE_HOURS: process.env.OFFLINE_PREHISTORIC_RANGE_HOURS || "1",
    STRATEGY_REAL_SETS_CEILING: "600", MARKET_DATA_LOAD_CONCURRENCY: "1",
    // Every realtime pass slower than this logs its elapsed time, phase split
    // and slowest symbols ([CycleDiagnostic]); the soak records those lines.
    REALTIME_CANONICAL_CYCLE_BUDGET_MS: String(cycleDiagnosticMs),
    // The server env is a whitelist: Common history knobs and any extra
    // comparison settings must be passed explicitly.
    ...Object.fromEntries(
      ["COMMON_HISTORY_MINUTES", "COMMON_HISTORY_SIMULATED_BACKFILL", "INDICATION_EXACT_SNAPSHOT_CACHE_MS", "INDICATION_STORE_SKIP_UNCHANGED"]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, String(process.env[key])]),
    ),
    ...extraServerEnv(),
    ADMIN_SECRET: `offline-${SYMBOLS.length}-${process.pid}-admin-secret`,
    BINGX_API_KEY: "", BINGX_API_SECRET: "", BYBIT_API_KEY: "", BYBIT_API_SECRET: "",
    V0_REDIS_SNAPSHOT_PATH: `/tmp/cts-offline-${process.pid}.json`,
    NODE_OPTIONS: [
      `--max-old-space-size=${heapMb}`, "--max-semi-space-size=128", "--expose-gc",
      `--require=${resolve("scripts/test-network-isolation.cjs")}`,
    ].join(" "),
  },
  stdio: ["ignore", "pipe", "pipe"],
})
const onLog = (chunk) => {
  const text = String(chunk)
  if (process.env.OFFLINE_SERVER_LOGS === "1") process.stderr.write(text)
  for (const line of text.split("\n")) {
    if (/unhandled|uncaught|blocks external|FATAL|out of memory|Test isolation/i.test(line)) serverLog.push(line.slice(0, 500))
    if (line.includes("[CycleDiagnostic]")) cycleDiagnostics.push({ at: Date.now(), line: line.slice(0, 600) })
  }
  if (serverLog.length > 2_000) serverLog.splice(0, serverLog.length - 2_000)
  if (cycleDiagnostics.length > 4_000) cycleDiagnostics.splice(0, cycleDiagnostics.length - 4_000)
}
server.stdout.on("data", onLog)
server.stderr.on("data", onLog)

async function stop() {
  try { process.kill(-server.pid, "SIGTERM") } catch {}
  await Promise.race([new Promise((r) => server.once("exit", r)), sleep(8_000)])
  try { process.kill(-server.pid, "SIGKILL") } catch {}
}

/** One-second liveness probe: how long an HTTP request waits behind engine work. */
function startLivenessProber() {
  const latencies = []
  let running = true
  ;(async () => {
    while (running) {
      const started = Date.now()
      try {
        await fetch(`${baseUrl}/api/health/liveness`, { signal: AbortSignal.timeout(30_000), cache: "no-store" })
        latencies.push({ at: started, ms: Date.now() - started })
      } catch {
        latencies.push({ at: started, ms: Date.now() - started, failed: true })
      }
      await sleep(Math.max(0, 1_000 - (Date.now() - started)))
    }
  })()
  return { latencies, stop: () => { running = false } }
}

async function progressionPassFields(connectionId) {
  const hash = await redis.hGetAll(`progression:${connectionId}:main`).catch(() => ({}))
  const pick = (key) => (hash[key] === undefined || hash[key] === "" ? null : Number(hash[key]))
  return {
    realtimeCycleCount: pick("realtime_cycle_count"),
    lastPassMs: pick("realtime_pass_last_ms"),
    lastPassAt: pick("realtime_pass_last_at"),
    passMsMax: pick("realtime_pass_max_ms"),
    lastPassSymbols: pick("realtime_pass_last_symbols"),
    symbolP50Ms: pick("realtime_pass_last_symbol_p50_ms"),
    symbolP95Ms: pick("realtime_pass_last_symbol_p95_ms"),
    symbolMaxMs: pick("realtime_pass_last_symbol_max_ms"),
    indicationMs: pick("realtime_pass_last_indication_ms"),
    pseudoMs: pick("realtime_pass_last_pseudo_ms"),
    strategyMs: pick("realtime_pass_last_strategy_ms"),
    slowest: hash.realtime_pass_last_slowest || null,
    slowPassCount: pick("canonical_cycle_slow_count"),
    symbolErrors: pick("indication_symbol_errors_count"),
    simulatedCreated: pick("live_simulated_positions_created_count"),
    simulatedClosed: pick("live_simulated_positions_closed_count"),
  }
}

/** Set keys per symbol and type (a SCAN at the end; never during the window). */
async function setInventory(connectionId) {
  const prefix = `indication_set:${connectionId}:`
  const bySymbol = new Map()
  const byType = new Map()
  let total = 0
  for await (const keys of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 5_000 })) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const [symbol, type] = key.slice(prefix.length).split(":")
      if (!symbol || !type) continue
      total++
      bySymbol.set(symbol, (bySymbol.get(symbol) || 0) + 1)
      byType.set(type, (byType.get(type) || 0) + 1)
    }
  }
  const perSymbol = [...bySymbol.values()].sort((a, b) => a - b)
  return {
    total,
    symbolsWithSets: bySymbol.size,
    perSymbolMin: perSymbol[0] || 0,
    perSymbolMedian: perSymbol[Math.floor(perSymbol.length / 2)] || 0,
    perSymbolMax: perSymbol.at(-1) || 0,
    byType: Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1])),
  }
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

/** Elapsed times of passes over the diagnostic threshold, parsed from [CycleDiagnostic]. */
function slowPasses(lines) {
  const out = []
  for (const { line } of lines) {
    const match = /realtime-progression completed after the slow-cycle threshold in (\d+)ms/.exec(line)
    if (match) out.push(Number(match[1]))
  }
  return out
}

function summarize({ samples, liveness, audit, inventory, startedAt }) {
  const all = samples.filter((sample) => !sample.error)
  // Steady state: from 5 minutes after the first complete realtime pass.
  const firstPassAt = all.find((sample) => Number(sample.pass?.lastPassMs) > 0)?.at
  const steadyFrom = firstPassAt ? Date.parse(firstPassAt) + 5 * 60_000 : startedAt
  const steady = all.filter((sample) => Date.parse(sample.at) >= steadyFrom)
  const ok = steady.length >= 3 ? steady : all
  const windowLiveness = liveness.filter((row) => row.at >= steadyFrom)
  const livenessMs = windowLiveness.map((row) => row.ms)
  const passes = slowPasses(cycleDiagnostics)
  const lastPassMs = ok.map((sample) => sample.pass?.lastPassMs).filter((value) => Number.isFinite(value) && value > 0)
  const first = ok[0] || {}
  const last = ok.at(-1) || {}
  const lifetime = [...all].reverse().find((sample) => sample.runtime?.eventLoopLifetime)?.runtime?.eventLoopLifetime || null
  const symbolP95 = ok.map((sample) => sample.pass?.symbolP95Ms).filter((value) => Number.isFinite(value) && value > 0)
  const phase = (key) => percentile(ok.map((sample) => sample.pass?.[key]).filter(Number.isFinite), 50)
  return {
    label,
    symbols: SYMBOLS.length,
    durationMs,
    samples: ok.length,
    steadyStateFrom: new Date(steadyFrom).toISOString(),
    eventLoopLifetime: lifetime,
    perSymbolMs: { p95OfPassP95: percentile(symbolP95, 95), maxOfPassMax: Math.max(0, ...ok.map((sample) => sample.pass?.symbolMaxMs || 0)) },
    phaseSplitMedianMs: { indication: phase("indicationMs"), pseudo: phase("pseudoMs"), strategy: phase("strategyMs") },
    simulatedOrders: { created: all.at(-1)?.pass?.simulatedCreated ?? null, closed: all.at(-1)?.pass?.simulatedClosed ?? null },
    symbolErrors: all.at(-1)?.pass?.symbolErrors ?? null,
    realtimePass: {
      sampledLastPassMs: { p50: percentile(lastPassMs, 50), p95: percentile(lastPassMs, 95), max: lastPassMs.length ? Math.max(...lastPassMs) : null },
      recordedMaxMs: last.pass?.passMsMax ?? null,
      passes: last.pass?.passCount ?? null,
      realtimeCycleCount: last.pass?.realtimeCycleCount ?? null,
      slowPassThresholdMs: cycleDiagnosticMs,
      slowPassCount: passes.length,
      slowPassMs: { p50: percentile(passes, 50), p95: percentile(passes, 95), max: passes.length ? Math.max(...passes) : null },
      avgCycleTimeMs: last.avgCycleTimeMs ?? null,
    },
    liveness: {
      probes: livenessMs.length,
      failed: windowLiveness.filter((row) => row.failed).length,
      p50Ms: percentile(livenessMs, 50), p95Ms: percentile(livenessMs, 95), p99Ms: percentile(livenessMs, 99),
      maxMs: livenessMs.length ? Math.max(...livenessMs) : null,
      over1sPct: livenessMs.length ? Math.round((livenessMs.filter((ms) => ms > 1_000).length / livenessMs.length) * 1000) / 10 : null,
    },
    statsApiSlowestMs: { p50: percentile(ok.map((s) => s.slowestMs), 50), p95: percentile(ok.map((s) => s.slowestMs), 95), max: ok.length ? Math.max(...ok.map((s) => s.slowestMs)) : null },
    rssMb: { start: first.rssMb ?? null, peak: ok.length ? Math.max(...ok.map((s) => s.rssMb || 0)) : null, end: last.rssMb ?? null },
    heapUsedMb: { start: first.runtime?.heapUsedMB ?? null, peak: ok.length ? Math.max(...ok.map((s) => s.runtime?.heapUsedMB || 0)) : null, end: last.runtime?.heapUsedMB ?? null },
    redisKeys: { start: first.redisKeys ?? null, peak: ok.length ? Math.max(...ok.map((s) => s.redisKeys || 0)) : null, end: last.redisKeys ?? null },
    redisUsedMb: { start: first.redisUsedMb ?? null, peak: ok.length ? Math.max(...ok.map((s) => s.redisUsedMb || 0)) : null, end: last.redisUsedMb ?? null },
    positions: { open: last.openPositions ?? null, closed: last.closedPositions ?? null },
    setInventory: inventory,
    auditIssues: audit?.issues?.length ?? null,
    serverAlerts: serverLog.length,
    sampleFailures: ok.reduce((sum, sample) => sum + (sample.failures?.length || 0), 0),
    nanPaths: [...new Set(ok.flatMap((sample) => sample.nanPaths || []))].slice(0, 20),
  }
}

function markdown(summary, verifierExit) {
  const row = (name, value) => `| ${name} | ${value ?? "–"} |`
  const range = (value) => (value ? `${value.start ?? "–"} → peak ${value.peak ?? "–"} → ${value.end ?? "–"}` : "–")
  const pct = (value) => (value ? `p50 ${value.p50 ?? "–"} / p95 ${value.p95 ?? "–"} / max ${value.max ?? "–"}` : "–")
  return [
    `# Offline ${summary.symbols}-symbol engine soak${summary.label ? ` — ${summary.label}` : ""}`,
    "",
    `Window ${Math.round(summary.durationMs / 60_000)} min; steady state from ${summary.steadyStateFrom} (${summary.samples} samples); verifier exit ${verifierExit}.`,
    "",
    "| Measure | Value |",
    "|---|---|",
    row("Realtime pass, sampled last pass (ms)", pct(summary.realtimePass.sampledLastPassMs)),
    row("Realtime pass, recorded max (ms)", summary.realtimePass.recordedMaxMs),
    row(`Passes over ${summary.realtimePass.slowPassThresholdMs} ms`, `${summary.realtimePass.slowPassCount} (${pct(summary.realtimePass.slowPassMs)})`),
    row("Realtime cycles / passes", `${summary.realtimePass.realtimeCycleCount ?? "–"} / ${summary.realtimePass.passes ?? "–"}`),
    row("Per-symbol pass time (ms)", `p95 of pass p95 ${summary.perSymbolMs.p95OfPassP95 ?? "–"} / max ${summary.perSymbolMs.maxOfPassMax || "–"}`),
    row("Phase split per pass, median (ms)", `indication ${summary.phaseSplitMedianMs.indication ?? "–"} / pseudo ${summary.phaseSplitMedianMs.pseudo ?? "–"} / strategy ${summary.phaseSplitMedianMs.strategy ?? "–"}`),
    row("Event-loop delay, process lifetime (ms)", summary.eventLoopLifetime ? `p50 ${summary.eventLoopLifetime.delayP50Ms} / p95 ${summary.eventLoopLifetime.delayP95Ms} / p99 ${summary.eventLoopLifetime.delayP99Ms} / max ${summary.eventLoopLifetime.delayMaxMs}` : "–"),
    row("Simulated positions created / closed (counters)", `${summary.simulatedOrders.created ?? "–"} / ${summary.simulatedOrders.closed ?? "–"}`),
    row("Indication symbol errors", summary.symbolErrors),
    row("Liveness latency (ms)", `p50 ${summary.liveness.p50Ms} / p95 ${summary.liveness.p95Ms} / p99 ${summary.liveness.p99Ms} / max ${summary.liveness.maxMs}; >1 s ${summary.liveness.over1sPct}% of ${summary.liveness.probes}`),
    row("Slowest stats route per sample (ms)", pct(summary.statsApiSlowestMs)),
    row("RSS (MB)", range(summary.rssMb)),
    row("Heap used (MB)", range(summary.heapUsedMb)),
    row("Redis keys", range(summary.redisKeys)),
    row("Redis used_memory (MB)", range(summary.redisUsedMb)),
    row("Set keys (total / per symbol min–median–max)", summary.setInventory ? `${summary.setInventory.total} / ${summary.setInventory.perSymbolMin}–${summary.setInventory.perSymbolMedian}–${summary.setInventory.perSymbolMax} (${summary.setInventory.symbolsWithSets} symbols)` : "–"),
    row("Paper positions open / closed", `${summary.positions.open} / ${summary.positions.closed}`),
    row("Audit issues / server alerts / sample failures", `${summary.auditIssues} / ${summary.serverAlerts} / ${summary.sampleFailures}`),
    "",
  ].join("\n")
}

let exitCode = 0
const samples = []
let verifierExit = null
const prober = startLivenessProber()
const soakStartedAt = Date.now()
try {
  const deadline = Date.now() + 120_000
  for (;;) {
    if (server.exitCode != null) throw new Error(`server exited ${server.exitCode}`)
    try { if ((await fetch(`${baseUrl}/api/health/liveness`)).ok) break } catch {}
    if (Date.now() > deadline) throw new Error("server did not become ready")
    await sleep(500)
  }
  const connections = await (await fetch(`${baseUrl}/api/connections`)).json()
  // the base BingX connection by default: /api/connections order is not stable
  const listed = (connections?.connections || []).map((row) => String(row?.id || ""))
  const connectionId = String(process.env.OFFLINE_CONNECTION_ID || (listed.includes("bingx-x01") ? "bingx-x01" : listed[0]) || "")
  const verifier = spawn(process.execPath, ["scripts/verify-prod-soak.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env, BASE_URL: baseUrl, PORT: String(port), REDIS_URL: redisUrl,
      // never hand live-trading switches to the verifier
      FORCE_LIVE: "0", ALLOW_LIVE_ORDER_PLACEMENT: "0", BINGX_API_KEY: "", BINGX_API_SECRET: "",
      SOAK_CONNECTION_ID: connectionId, START_SIMULATED_ENGINE: "1",
      SYMBOL_COUNT: String(SYMBOLS.length), SOAK_SYMBOLS: SYMBOLS.join(","),
      SOAK_QUICKSTART_EXTRA: JSON.stringify(normalOff ? { normalEnabled: false } : {}),
      SOAK_DURATION_MS: String(durationMs), SOAK_PRODUCTIVE_COMPLETION_GRACE_MS: "300000",
      RUNTIME_MODE: "production", CTS_NODE_HEAP_MB: String(heapMb),
      SOAK_RSS_GROWTH_LIMIT_KB: String(3 * 1024 * 1024), SOAK_DB_GROWTH_LIMIT: String(1_200 * SYMBOLS.length),
    },
    stdio: "inherit",
  })
  const verifierDone = new Promise((r) => verifier.once("exit", (code) => r(code ?? 1)))
  let done = false
  verifierDone.then((code) => { verifierExit = code; done = true })
  while (!done) {
    const sample = await sampleOnce({ baseUrl, redis, connectionId, serverPid: server.pid }).catch((e) => ({ error: String(e) }))
    if (!sample.error) sample.pass = await progressionPassFields(connectionId)
    samples.push(sample)
    const last = samples.at(-1)
    console.error(
      `${tag} sample t=${samples.length} rssMb=${last.rssMb} keys=${last.redisKeys} open=${last.openPositions} ` +
      `closed=${last.closedPositions} nan=${(last.nanPaths || []).length} slowest=${last.slowestMs} ` +
      `lastPassMs=${last.pass?.lastPassMs ?? "-"} cycles=${last.pass?.realtimeCycleCount ?? "-"}`,
    )
    await Promise.race([verifierDone, sleep(15_000)])
  }
  prober.stop()
  const audit = await runAudit({ baseUrl, redis, connectionId, symbols: SYMBOLS })
  const inventory = await setInventory(connectionId).catch((error) => ({ error: String(error) }))
  const summary = summarize({ samples, liveness: prober.latencies, audit, inventory, startedAt: soakStartedAt })
  const report = {
    label, normal: normalOff ? "off" : "on", symbols: SYMBOLS.length, symbolList: SYMBOLS, durationMs, verifierExit,
    summary, samples, liveness: prober.latencies, cycleDiagnostics: cycleDiagnostics.slice(-400), audit,
    serverAlerts: serverLog.slice(-200),
  }
  for (const path of [reportPath, reportMdPath]) mkdirSync(dirname(resolve(path)), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  writeFileSync(reportMdPath, markdown(summary, verifierExit))
  console.log(JSON.stringify({ verifierExit, auditIssues: audit.issues, serverAlerts: serverLog.length, reportPath, reportMdPath, summary }, null, 2))
  if (verifierExit !== 0 || audit.issues.length > 0 || serverLog.length > 0) exitCode = 1
} catch (error) {
  console.error(`${tag} failed:`, error?.stack || error)
  exitCode = 1
} finally {
  prober.stop()
  await stop()
  await redis.quit().catch(() => {})
  spawnSync("rm", ["-f", `/tmp/cts-offline-${process.pid}.json`, `/tmp/cts-offline-${process.pid}.json.live-wal`])
}
process.exit(exitCode)
