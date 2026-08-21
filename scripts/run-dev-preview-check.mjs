#!/usr/bin/env node

/** Safe bounded development-mode engine soak with paper positions only. */

import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import process from "node:process"
import { acquireDevArtifactLock } from "./dev-artifact-lock.mjs"
import { startPreviewRedisHarness } from "./preview-redis-harness.mjs"

const port = Number(process.env.PORT || 3103)
const baseUrl = `http://127.0.0.1:${port}`
const nextBin = "node_modules/next/dist/bin/next"
// Next 15 development webpack and instrumentation require the canonical
// `.next` tree; a custom dev dist can emit incompatible runtime chunks across
// its app/pages compilers. The harness owns and cleans this tree exclusively;
// production preview uses `.next-prod` and Kilo runs only after Dev completes.
const devDistDir = ".next"
const devDistPath = resolve(process.cwd(), devDistDir)
const snapshotPath = `/tmp/cts-dev-preview-${process.pid}.json`
const debugAdminSecret = `cts-dev-soak-${process.pid}-admin-secret`
const runtimeStartedAt = new Date().toISOString()
const runtimeBootId = `dev-preview_${Date.now()}_${process.pid}`
const maxSymbolsRequested = process.argv.includes("--max-symbols")
const fullSoakRequested = process.env.DEV_PREVIEW_FULL_SOAK === "1"
const devSoakSymbolCount = maxSymbolsRequested
  ? 32
  : Math.max(1, Math.min(32, Number(process.env.DEV_SOAK_SYMBOL_COUNT || 12)))
// Cold Next compilation plus one exhaustive Base→Main→Real→Live pass grows
// with the selected basket. Give the default command enough observation time
// to prove at least three completed cycles instead of failing a healthy,
// still-running first pass at an arbitrary 60-second boundary.
// An explicit DEV_SOAK_DURATION_MS (constrained host) bypasses the 90s floor so
// the exhaustive engine + in-process Redis can complete inside the container
// memory ceiling instead of being OOM-killed mid-soak.
const devSoakDurationMs = process.env.DEV_SOAK_DURATION_MS
  ? Number(process.env.DEV_SOAK_DURATION_MS)
  : fullSoakRequested && maxSymbolsRequested
    ? 20 * 60_000
    : Math.max(90_000, 60_000 + devSoakSymbolCount * 10_000)
// The regular interactive dev command intentionally stays at 4 GiB. The
// default dev-preview path boots the full Base->Main->Real->Live pipeline
// (Next compiler + in-process Redis + engine working set) in one Node
// process; its transient peak exceeds a sub-8 GiB heap and triggers a GC
// death-loop that starves the soak. Default to a 12 GiB heap so a full
// smoke pass completes on dev/production hosts (~15-16 GiB); the exhaustive
// stress soak is opt-in via DEV_PREVIEW_FULL_SOAK=1. A constrained host can
// lower it with DEV_NODE_HEAP_MB (CI smoke pins it to 4096).
const devNodeHeapMb = Math.max(
  4096,
  Math.min(12288, Number(process.env.DEV_NODE_HEAP_MB || 12288)),
)
// Match the installed Linux application wrapper. A 192 MiB semi-space lets
// one exhaustive symbol accumulate a very large young generation before V8
// scavenges/promotes it, which produced repeatable 3–5 second control-plane
// stalls. 128 MiB retains allocation throughput while bounding each young-GC
// working set; operators can still profile 32–192 MiB explicitly.
const devNodeSemiSpaceMb = Math.max(
  32,
  Math.min(192, Number(process.env.DEV_NODE_SEMI_SPACE_MB || 128)),
)
let outputTail = ""
let previewRedisEnvironment = {}
let auditConnectionId = ""
const releaseDevArtifactLock = acquireDevArtifactLock({ artifactName: "next-dev" })

async function removeHarnessArtifacts() {
  await rm(snapshotPath, { force: true })
  // Next compiler workers can release files shortly after their launcher
  // exits. fs.promises.rm retries transient ENOTEMPTY/EBUSY races instead of
  // turning an otherwise healthy soak into a cleanup failure.
  await rm(devDistPath, {
    recursive: true,
    force: true,
    maxRetries: 12,
    retryDelay: 200,
  })
}

function keepTail(chunk) {
  // Runtime summaries are coalesced. Keep a bounded diagnostic tail large
  // enough for a compiler stack without retaining half a megabyte of stdout.
  outputTail = `${outputTail}${String(chunk)}`.slice(-128_000)
  if (process.env.DEV_PREVIEW_STREAM_SERVER_LOGS === "1") {
    process.stdout.write(chunk)
  }
}

async function waitForReady(child, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Dev server exited with ${child.exitCode}\n${outputTail}`)
    try {
      const response = await fetch(`${baseUrl}/api/health/liveness`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch { /* compilation/startup in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Dev server did not become ready\n${outputTail}`)
}

async function requestJson(pathname, options = {}) {
  let lastFailure = ""
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 60_000)
  const requestOptions = { ...options }
  delete requestOptions.timeoutMs
  for (let attempt = 1; attempt <= 4; attempt++) {
    let response
    try {
      response = await fetch(new URL(pathname, baseUrl), {
        cache: "no-store",
        ...requestOptions,
        signal: requestOptions.signal || AbortSignal.timeout(timeoutMs),
        headers: { Accept: "application/json", ...(requestOptions.headers || {}) },
      })
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
        continue
      }
      break
    }
    const text = await response.text()
    if (response.ok) {
      try {
        return text ? JSON.parse(text) : {}
      } catch {
        lastFailure = `non-JSON content: ${text.slice(0, 1_000)}`
      }
    } else {
      lastFailure = `HTTP ${response.status}: ${text.slice(0, 1_000)}`
    }
    // Next dev can finish the request that triggered an App-route compile a
    // few milliseconds before its route manifest has been atomically swapped.
    // A bounded warmup retry is allowed here only; the subsequent soak makes
    // every application request exactly once and remains fail-fast.
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
  }
  throw new Error(`Dev route warmup ${pathname} failed after compilation retries: ${lastFailure}`)
}

async function resolveAuditConnectionId() {
  if (auditConnectionId) return auditConnectionId
  const inventory = await requestJson("/api/connections")
  const connections = Array.isArray(inventory?.connections) ? inventory.connections : []
  const requested = String(process.env.DEV_SOAK_CONNECTION_ID || "").trim()
  const selected = requested
    ? connections.find((connection) => String(connection?.id) === requested)
    : connections[0]
  const resolved = String(selected?.id || "").trim()
  if (!resolved) {
    throw new Error(
      requested
        ? `Dev audit connection ${requested} was not found`
        : "Dev audit requires an explicit available connection",
    )
  }
  auditConnectionId = resolved
  return auditConnectionId
}

async function prewarmDevRoutes() {
  // Next dev compiles App routes on first request. Compiling eleven large API
  // graphs concurrently while the engine is allocating Strategy Sets can make
  // Next expose a half-installed route module ("handler is not a function").
  // Compile them serially before QuickStart so the soak measures application
  // processing and route execution, not a compiler stampede.
  const connectionId = await resolveAuditConnectionId()
  const encoded = encodeURIComponent(connectionId)
  for (const pathname of [
    "/api/health",
    "/api/system/init-status",
    "/api/system/status",
    "/api/system/monitoring",
    "/api/trade-engine/status-all",
    "/api/trade-engine/detailed-logs",
    "/api/settings",
    "/api/indications/config-counts",
    `/api/connections/progression/${encoded}/stats`,
    `/api/settings/connections/${encoded}/settings`,
    `/api/trading/trade-history?connection_id=${encoded}&limit=500`,
    `/api/logistics/queue?connectionId=${encoded}`,
    `/api/trading/live-positions?connection_id=${encoded}`,
    `/api/exchange/live-summary?connection_id=${encoded}`,
    `/api/preset-optimizer?connectionId=${encoded}`,
    `/api/connections/${encoded}/engine-states`,
    `/api/settings/indications/signal?connectionId=${encoded}`,
    `/api/indications/signals/status?connectionId=${encoded}`,
    `/api/statistics/indications?connectionId=${encoded}`,
  ]) {
    await requestJson(pathname)
  }

  // Compile the state-changing toggle route before the engine begins its
  // memory-intensive Historic/Strategy work. An empty POST is a strict no-op:
  // it neither starts nor stops the connection, but avoids a first-use HMR
  // compile competing with the post-soak disable/re-enable contract.
  const toggleWarmup = await fetch(`${baseUrl}/api/settings/connections/${encoded}/toggle-dashboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(120_000),
  })
  if (!toggleWarmup.ok && toggleWarmup.status !== 429) {
    throw new Error(`Dev toggle-route warmup returned HTTP ${toggleWarmup.status}`)
  }
  if (toggleWarmup.status === 429) {
    // Back-to-back persistent-Redis restart tests intentionally share the
    // route limiter. A 429 proves the route compiled and correctly rejected a
    // no-op warmup; do not retry and consume more quota. The real lifecycle
    // toggle remains a strict post-soak assertion after the 60-second window.
    console.warn("[run-dev-preview-check] toggle warmup rate-limited; route compiled, continuing")
  }

  // The soak reads this authenticated diagnostic every tenth round. Compile
  // it before the engine starts allocating so a parallel production run cannot
  // turn its first 600-module cold build into a false request timeout.
  await requestJson(`/api/debug/progression-dump?id=${encoded}`, {
    headers: { Authorization: `Bearer ${debugAdminSecret}` },
  })

  // The lifecycle soak resolves a row by exact id when it leaves the bounded
  // overview history between polls. Compile that detail route before the
  // exhaustive engine allocation begins; a 404 for the synthetic id is the
  // expected warmup response.
  const detailWarmup = await fetch(
    `${baseUrl}/api/positions/__dev_soak_warmup__?connection_id=${encoded}`,
    { cache: "no-store", signal: AbortSignal.timeout(60_000) },
  )
  if (detailWarmup.status !== 404 && !detailWarmup.ok) {
    throw new Error(`Dev position-detail warmup returned HTTP ${detailWarmup.status}`)
  }

  // Compile the exact page changed by this release in development too. The
  // production verifier already checks its rendered output; this catches a
  // development-only module/style failure before the engine soak begins.
  const livePage = await fetch(`${baseUrl}/live-trading`, {
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  })
  if (!livePage.ok) throw new Error(`Dev Live Trading page warmup returned HTTP ${livePage.status}`)
  const livePageHtml = await livePage.text()
  if (!livePageHtml.includes("Live Trading")) {
    throw new Error("Dev Live Trading page warmup did not render its release marker")
  }
  const signalPage = await fetch(`${baseUrl}/settings/indications/signal`, {
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  })
  if (!signalPage.ok) throw new Error(`Dev Signal Settings page warmup returned HTTP ${signalPage.status}`)
  const signalPageHtml = await signalPage.text()
  if (!signalPageHtml.includes("Signal")) {
    throw new Error("Dev Signal Settings page warmup did not render its release marker")
  }
  for (const pathname of [
    "/statistics",
    "/statistics/indications/common",
    "/statistics/indications/signal",
  ]) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`Dev statistics page ${pathname} returned HTTP ${response.status}`)
    const html = await response.text()
    if (!html.includes("/_next/static/")) {
      throw new Error(`Dev statistics page ${pathname} did not render client assets`)
    }
  }
}

function assertDevOutputIntegrity() {
  for (const relativePath of ["routes-manifest.json", "server/app-paths-manifest.json"]) {
    const manifestPath = resolve(devDistPath, relativePath)
    const raw = readFileSync(manifestPath, "utf8")
    if (!raw.trim()) throw new Error(`Development manifest is empty: ${manifestPath}`)
    JSON.parse(raw)
  }
}

async function runSoakVerifier() {
  const connectionId = await resolveAuditConnectionId()
  return new Promise((resolve, reject) => {
    const verifier = spawn(process.execPath, ["scripts/verify-prod-soak.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...previewRedisEnvironment,
        BASE_URL: baseUrl,
        PORT: String(port),
        SOAK_CONNECTION_ID: connectionId,
        START_SIMULATED_ENGINE: "1",
        SYMBOL_COUNT: String(devSoakSymbolCount),
        SOAK_DURATION_MS: String(devSoakDurationMs),
        // Historic must finish *and* hand off to at least three observable
        // Main cycles. The base 32-symbol window measures the complete cold
        // load; this bounded grace covers only the productive post-Historic
        // transition and exits as soon as its existing criteria are met.
        SOAK_PRODUCTIVE_COMPLETION_GRACE_MS:
          process.env.DEV_SOAK_PRODUCTIVE_COMPLETION_GRACE_MS ||
          (fullSoakRequested && maxSymbolsRequested ? "600000" : "180000"),
        RUNTIME_MODE: "development",
        SOAK_ADMIN_SECRET: debugAdminSecret,
        // Keep the verifier's absolute RSS budget aligned with the heap that
        // this harness actually assigned to the development server. Without
        // this explicit hand-off the verifier falls back to the production
        // 5.5 GiB heap profile and can reject a healthy 12 GiB full-dev run.
        CTS_NODE_HEAP_MB: String(devNodeHeapMb),
        // Constrained-host budgets: the exhaustive calculation can churn 1–7
        // day TTL progression keys during a short soak. Keep explicit debug
        // budgets above the strict production defaults; full soaks still use
        // one shared Redis backend across every Next.js worker.
        SOAK_RSS_GROWTH_LIMIT_KB: process.env.DEV_SOAK_RSS_GROWTH_LIMIT_KB || String(3 * 1024 * 1024),
        SOAK_DB_GROWTH_LIMIT: process.env.DEV_SOAK_DB_GROWTH_LIMIT || String(60_000),
      },
      stdio: "inherit",
    })
    verifier.once("error", reject)
    verifier.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Development soak verifier exited code=${code} signal=${signal || "none"}`))
    })
  })
}

// Bounded, memory-fitting preview verification for constrained hosts (default).
// The full stress soak requires shared Redis and is intentionally opt-in on
// small CI runners. This smoke covers the real
// production-critical path — boot, migrations, explicit QuickStart symbol
// preservation (the dev-preview regression), and endpoint health — without the
// unbounded key growth that exhausts an in-process Redis in a constrained box.
async function runSmokeVerifier() {
  const SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT",
    "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "ATOMUSDT", "LTCUSDT",
    "UNIUSDT", "NEARUSDT", "OPUSDT", "ARBUSDT", "APTUSDT", "SUIUSDT",
    "INJUSDT", "TIAUSDT", "SEIUSDT", "WLDUSDT", "PYTHUSDT", "JUPUSDT",
    "TRXUSDT", "ETCUSDT", "FILUSDT", "AAVEUSDT", "RUNEUSDT", "FETUSDT",
    "ICPUSDT", "HBARUSDT",
  ].slice(0, Math.max(1, devSoakSymbolCount))
  const connectionId = await resolveAuditConnectionId()
  const quickStart = await requestJson("/api/trade-engine/quick-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "enable",
      connectionId,
      symbolCount: SYMBOLS.length,
      symbols: SYMBOLS,
      liveTrade: false,
      is_live_trade: false,
      baseProfitFactor: 1,
      mainProfitFactor: 1,
      realProfitFactor: 1,
      prevPosMinCount: 1,
      mainEvalPosCount: 1,
      realEvalPosCount: 1,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  const configuredSymbols = Array.isArray(quickStart?.connection?.symbols)
    ? quickStart.connection.symbols.map(String)
    : []
  if (
    configuredSymbols.length !== SYMBOLS.length ||
    configuredSymbols.some((symbol, index) => symbol !== SYMBOLS[index])
  ) {
    throw new Error(`QuickStart did not preserve the requested ${SYMBOLS.length}-symbol set`)
  }
  if (quickStart?.connection?.liveTradeRequested !== false || quickStart?.connection?.liveTradeEnabled !== false) {
    throw new Error("Safe smoke unexpectedly enabled live exchange trading")
  }
  const status = await requestJson("/api/trade-engine/status-all")
  if (!status) throw new Error("status-all returned no data")
  const healthEndpoints = [
    "/api/health",
    "/api/system/init-status",
    "/api/system/status",
    "/api/system/monitoring",
    "/api/trade-engine/status-all",
    "/api/indications/config-counts",
    "/api/settings",
    `/api/connections/${encodeURIComponent(connectionId)}/engine-states`,
  ]
  for (let round = 0; round < 3; round++) {
    for (const pathname of healthEndpoints) {
      const result = await requestJson(pathname).catch(() => null)
      if (result === null) throw new Error(`Smoke health poll round ${round} failed for ${pathname}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return { symbols: SYMBOLS.length }
}

async function stopServer(child) {
  if (!child?.pid) return
  const signalProcessGroup = (signal) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
      return true
    } catch (error) {
      if (error?.code === "ESRCH") return false
      throw error
    }
  }

  signalProcessGroup("SIGTERM")
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  // Next dev owns compiler workers and child processes. Killing only the
  // launcher can leave those descendants writing a cache after this harness
  // has removed it, corrupting the next run. Signal the complete process
  // group even when the launcher already exited after SIGTERM.
  signalProcessGroup("SIGKILL")
  // The launcher can report exit before its compiler descendants have left
  // the detached process group. Do not remove `.next` while those workers can
  // still write to it.
  if (process.platform !== "win32" && child.pid) {
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      try {
        process.kill(-child.pid, 0)
      } catch (error) {
        if (error?.code === "ESRCH") break
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } else if (child.exitCode == null) {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ])
  }
}

async function main() {
  await removeHarnessArtifacts()
  const redisHarness = await startPreviewRedisHarness({
    required: fullSoakRequested,
    label: "development full soak",
  })
  previewRedisEnvironment = redisHarness.environment
  const server = spawn(process.execPath, [nextBin, "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      ...previewRedisEnvironment,
      NEXT_DIST_DIR: devDistDir,
      CTS_RUNTIME_BOOT_ID: runtimeBootId,
      CTS_RUNTIME_STARTED_AT: runtimeStartedAt,
      DISABLE_TRADE_ENGINE_AUTOSTART: "1",
      DISABLE_TRADE_ENGINE_IN_PROCESS: "0",
      DISABLE_IN_PROCESS_CONTINUITY: "0",
      ALLOW_PROD_SIMULATED: "1",
      // The harness is deliberately single-process; permit its inline Redis
      // fallback when no external preview Redis is available.
      ALLOW_PROD_INLINE_REDIS: "1",
      FORCE_SIMULATED: "1",
      FORCE_LIVE: "0",
      V0_DEV_SYMBOL_COUNT: String(devSoakSymbolCount),
      ENGINE_SYMBOL_CONCURRENCY: process.env.DEV_ENGINE_SYMBOL_CONCURRENCY || "2",
      STRATEGY_FLOW_SYMBOL_CONCURRENCY: process.env.DEV_STRATEGY_SYMBOL_CONCURRENCY || "2",
      // A cold exhaustive replay retains large immutable result vectors while
      // Next's development compiler is resident in the same process. Keep one
      // historic symbol active at a time and give the adaptive limiter a real
      // RSS pressure boundary; without a soft limit RSS pressure is
      // intentionally unknown and CPU lanes cannot contract before long GC
      // pauses starve health/control routes.
      PREHISTORIC_SYMBOL_CONCURRENCY:
        process.env.DEV_PREHISTORIC_SYMBOL_CONCURRENCY || "1",
      PREHISTORIC_CONFIG_CONCURRENCY:
        process.env.DEV_PREHISTORIC_CONFIG_CONCURRENCY || "2",
      PREHISTORIC_CONFIG_TYPE_CONCURRENCY:
        process.env.DEV_PREHISTORIC_CONFIG_TYPE_CONCURRENCY || "1",
      PREHISTORIC_CALC_YIELD_EVERY:
        process.env.DEV_PREHISTORIC_CALC_YIELD_EVERY || "256",
      // Full dev soaks validate every configuration and every selected symbol,
      // but use a bounded one-hour market window by default so the complete
      // Base→Main→Real→Live lifecycle fits the 20-minute acceptance budget.
      // Production keeps the canonical eight-hour default unless an operator
      // explicitly supplies PREHISTORIC_RANGE_HOURS.
      PREHISTORIC_RANGE_HOURS:
        process.env.DEV_PREHISTORIC_RANGE_HOURS || "1",
      // The measured 32-symbol development plateau is roughly 5.1-6.0 GiB.
      // A 5 GiB soft boundary therefore classified the normal working set as
      // critical and forced continuous throttling/collection. Keep adequate
      // headroom above that plateau while leaving the independent 7 GiB
      // emergency, 8 GiB hard stop, and 10 GiB absolute ceiling unchanged.
      CTS_RSS_SOFT_LIMIT_MB:
        process.env.DEV_RSS_SOFT_LIMIT_MB || "6400",
      CTS_RSS_HARD_LIMIT_MB:
        process.env.DEV_RSS_HARD_LIMIT_MB || "8192",
      CTS_MEMORY_LIMIT_MB:
        process.env.DEV_MEMORY_LIMIT_MB || "10240",
      CTS_NODE_HEAP_MB: String(devNodeHeapMb),
      // Keep non-critical Major collections outside the API p95 sampling
      // majority. Even a five-minute cadence aligns enough multi-second
      // stop-the-world phases with UI refreshes to fill the entire p95 tail in
      // a 20-minute 32-symbol run. The per-symbol admission guard still
      // collects immediately at high/critical pressure, and the independent
      // 8 GiB hard boundary remains the crash barrier.
      CTS_MAINTENANCE_GC_INTERVAL_MS:
        process.env.DEV_MAINTENANCE_GC_INTERVAL_MS ||
        process.env.CTS_MAINTENANCE_GC_INTERVAL_MS ||
        "600000",
      CTS_STRATEGY_GC_ELEVATED_INTERVAL_MS:
        process.env.DEV_STRATEGY_GC_ELEVATED_INTERVAL_MS ||
        process.env.CTS_STRATEGY_GC_ELEVATED_INTERVAL_MS ||
        "600000",
      CTS_STRATEGY_MEMORY_MAX_ACTIVE_FLOWS:
        process.env.DEV_STRATEGY_MEMORY_MAX_ACTIVE_FLOWS || "1",
      // Exercise the full cartesian Main calculation, but keep the existing
      // explicit Real-row
      // output boundary small enough that the diagnostic process does not
      // retain multi-gigabyte transient graphs. Production/operator defaults
      // remain unchanged.
      STRATEGY_REAL_SETS_CEILING: process.env.DEV_STRATEGY_REAL_SETS_CEILING || "600",
      STRATEGY_VARIANT_BUILD_CONCURRENCY: process.env.DEV_STRATEGY_VARIANT_BUILD_CONCURRENCY || "1",
      MARKET_DATA_LOAD_CONCURRENCY: "1",
      CRON_SYMBOL_LIMIT: String(devSoakSymbolCount),
      REDIS_DEBUG_ENABLED: "1",
      ADMIN_SECRET: debugAdminSecret,
      BINGX_API_KEY: "",
      BINGX_API_SECRET: "",
      BYBIT_API_KEY: "",
      BYBIT_API_SECRET: "",
      PIONEX_API_KEY: "",
      PIONEX_API_SECRET: "",
      ORANGEX_API_KEY: "",
      ORANGEX_API_SECRET: "",
      V0_REDIS_SNAPSHOT_PATH: snapshotPath,
      // Constrained CI/dev hosts commonly expose fewer inotify watches than
      // exhaustive engine datasets create files/modules. Polling keeps the
      // long debug soak deterministic without changing application behavior.
      WATCHPACK_POLLING: process.env.WATCHPACK_POLLING || "true",
      // Keep every runtime memory guard on the same heap contract as the
      // actual Node process. NODE_OPTIONS alone is not visible to guards that
      // intentionally read the explicit CTS limit, which otherwise makes a
      // 12 GiB dev worker behave as if it had the 5.5 GiB production default.
      NODE_OPTIONS: `--max-old-space-size=${devNodeHeapMb} --max-semi-space-size=${devNodeSemiSpaceMb} --expose-gc`,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", keepTail)
  server.stderr.on("data", keepTail)

  try {
    await waitForReady(server)
    assertDevOutputIntegrity()
    await prewarmDevRoutes()
    assertDevOutputIntegrity()
    try {
      if (fullSoakRequested) {
        await runSoakVerifier()
      } else {
        await runSmokeVerifier()
      }
    } catch (error) {
      try {
        assertDevOutputIntegrity()
        console.error(`[run-dev-preview-check] ${devDistDir} manifests remained valid at failure`)
      } catch (manifestError) {
        console.error(
          `[run-dev-preview-check] ${devDistDir} integrity failed:`,
          manifestError instanceof Error ? manifestError.message : String(manifestError),
        )
      }
      throw error
    }
    assertDevOutputIntegrity()
    console.log(JSON.stringify({
      success: true,
      mode: fullSoakRequested ? "development-paper-engine-stress" : "development-paper-engine-smoke",
      symbols: devSoakSymbolCount,
      nodeHeapLimitMb: devNodeHeapMb,
      nodeSemiSpaceMb: devNodeSemiSpaceMb,
      redisBackend: redisHarness.kind,
      realExchangeOrdersSubmitted: 0,
    }, null, 2))
  } finally {
    await stopServer(server)
    await redisHarness.stop()
    await removeHarnessArtifacts()
  }
}

main()
  .catch((error) => {
    console.error("[run-dev-preview-check] failed:", error instanceof Error ? error.message : String(error))
    if (outputTail) console.error(`[run-dev-preview-check] server tail:\n${outputTail}`)
    process.exitCode = 1
  })
  .finally(releaseDevArtifactLock)
