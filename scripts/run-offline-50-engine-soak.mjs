#!/usr/bin/env node
/**
 * Offline 50-symbol end-to-end engine soak (paper/simulated only).
 *
 * Runs the production build (NEXT_DIST_DIR, default .next-offline — build it
 * first with `NEXT_DIST_DIR=.next-offline pnpm run build`) through
 * scripts/start-production.mjs with the full in-process engine, synthetic
 * candles (FORCE_SIMULATED=1), empty credentials, a throwaway loopback Redis
 * and the fail-closed loopback-only network guard
 * (scripts/test-network-isolation.cjs). The existing
 * scripts/verify-prod-soak.mjs drives QuickStart and the Base->Main->Real->Live
 * lifecycle; this driver adds a parallel sampler (RSS, Redis keys, stats API
 * NaN scan) and a final stats-vs-ledger audit
 * (scripts/audit-offline-engine-stats.mjs).
 *
 *   OFFLINE_REDIS_URL=redis://127.0.0.1:6399   (loopback only, flushed per run)
 *   OFFLINE_NORMAL=on|off                      Normal strategy toggle
 *   OFFLINE_DURATION_MS=600000                 measured soak window
 *   OFFLINE_SYNTHETIC_VOLATILITY=40              synthetic random-walk multiplier
 *   OFFLINE_PORT=3132  OFFLINE_REPORT=<path.json>
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"
import { createClient } from "redis"
import { runAudit, sampleOnce } from "./audit-offline-engine-stats.mjs"

const SYMBOLS = [
  "BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT", "ETHUSDT", "BNBUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT",
  "DOTUSDT", "ATOMUSDT", "LTCUSDT", "UNIUSDT", "NEARUSDT", "OPUSDT", "ARBUSDT", "APTUSDT", "SUIUSDT", "INJUSDT",
  "TIAUSDT", "SEIUSDT", "WLDUSDT", "PYTHUSDT", "JUPUSDT", "TRXUSDT", "ETCUSDT", "FILUSDT", "AAVEUSDT", "RUNEUSDT",
  "FETUSDT", "ICPUSDT", "HBARUSDT", "XLMUSDT", "ALGOUSDT", "VETUSDT", "SANDUSDT", "MANAUSDT", "AXSUSDT", "GALAUSDT",
  "CRVUSDT", "LDOUSDT", "STXUSDT", "IMXUSDT", "ORDIUSDT", "WIFUSDT", "ENAUSDT", "TONUSDT", "KASUSDT", "HYPEUSDT",
]
const redisUrl = process.env.OFFLINE_REDIS_URL || "redis://127.0.0.1:6399"
if (!/^redis:\/\/(127\.0\.0\.1|localhost):\d+$/.test(redisUrl)) throw new Error("OFFLINE_REDIS_URL must be loopback")
const port = Number(process.env.OFFLINE_PORT || 3132)
const baseUrl = `http://127.0.0.1:${port}`
const distDir = process.env.NEXT_DIST_DIR || ".next-offline"
const normalOff = process.env.OFFLINE_NORMAL === "off"
const durationMs = Number(process.env.OFFLINE_DURATION_MS || 600_000)
const heapMb = Number(process.env.OFFLINE_NODE_HEAP_MB || 8192)
const reportPath = process.env.OFFLINE_REPORT || `offline-50-${normalOff ? "normal-off" : "normal-on"}.json`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    ADMIN_SECRET: `offline-50-${process.pid}-admin-secret`,
    BINGX_API_KEY: "", BINGX_API_SECRET: "", BYBIT_API_KEY: "", BYBIT_API_SECRET: "",
    V0_REDIS_SNAPSHOT_PATH: `/tmp/cts-offline-50-${process.pid}.json`,
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
  }
  if (serverLog.length > 2_000) serverLog.splice(0, serverLog.length - 2_000)
}
server.stdout.on("data", onLog)
server.stderr.on("data", onLog)

async function stop() {
  try { process.kill(-server.pid, "SIGTERM") } catch {}
  await Promise.race([new Promise((r) => server.once("exit", r)), sleep(8_000)])
  try { process.kill(-server.pid, "SIGKILL") } catch {}
}

let exitCode = 0
const samples = []
let verifierExit = null
try {
  const deadline = Date.now() + 120_000
  for (;;) {
    if (server.exitCode != null) throw new Error(`server exited ${server.exitCode}`)
    try { if ((await fetch(`${baseUrl}/api/health/liveness`)).ok) break } catch {}
    if (Date.now() > deadline) throw new Error("server did not become ready")
    await sleep(500)
  }
  const connections = await (await fetch(`${baseUrl}/api/connections`)).json()
  const connectionId = String(process.env.OFFLINE_CONNECTION_ID || connections?.connections?.[0]?.id || "")
  const verifier = spawn(process.execPath, ["scripts/verify-prod-soak.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env, BASE_URL: baseUrl, PORT: String(port), REDIS_URL: redisUrl,
      SOAK_CONNECTION_ID: connectionId, START_SIMULATED_ENGINE: "1",
      SYMBOL_COUNT: String(SYMBOLS.length), SOAK_SYMBOLS: SYMBOLS.join(","),
      SOAK_QUICKSTART_EXTRA: JSON.stringify(normalOff ? { normalEnabled: false } : {}),
      SOAK_DURATION_MS: String(durationMs), SOAK_PRODUCTIVE_COMPLETION_GRACE_MS: "300000",
      RUNTIME_MODE: "production", CTS_NODE_HEAP_MB: String(heapMb),
      SOAK_RSS_GROWTH_LIMIT_KB: String(3 * 1024 * 1024), SOAK_DB_GROWTH_LIMIT: "60000",
    },
    stdio: "inherit",
  })
  const verifierDone = new Promise((r) => verifier.once("exit", (code) => r(code ?? 1)))
  let done = false
  verifierDone.then((code) => { verifierExit = code; done = true })
  while (!done) {
    samples.push(await sampleOnce({ baseUrl, redis, connectionId, serverPid: server.pid }).catch((e) => ({ error: String(e) })))
    const last = samples.at(-1)
    console.error(`[offline-50] sample t=${samples.length} rssMb=${last.rssMb} keys=${last.redisKeys} open=${last.openPositions} closed=${last.closedPositions} nan=${(last.nanPaths || []).length} slowest=${last.slowestMs}`)
    await Promise.race([verifierDone, sleep(15_000)])
  }
  const audit = await runAudit({ baseUrl, redis, connectionId, symbols: SYMBOLS })
  const report = {
    normal: normalOff ? "off" : "on", symbols: SYMBOLS.length, durationMs, verifierExit,
    samples, audit, serverAlerts: serverLog.slice(-200),
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ verifierExit, auditIssues: audit.issues, serverAlerts: serverLog.length, reportPath }, null, 2))
  if (verifierExit !== 0 || audit.issues.length > 0 || serverLog.length > 0) exitCode = 1
} catch (error) {
  console.error("[offline-50] failed:", error?.stack || error)
  exitCode = 1
} finally {
  await stop()
  await redis.quit().catch(() => {})
  spawnSync("rm", ["-f", `/tmp/cts-offline-50-${process.pid}.json`, `/tmp/cts-offline-50-${process.pid}.json.live-wal`])
}
process.exit(exitCode)
