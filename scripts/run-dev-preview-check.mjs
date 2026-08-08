#!/usr/bin/env node

/** Safe bounded development-mode engine soak with paper positions only. */

import { spawn } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"

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
const maxSymbolsRequested = process.argv.includes("--max-symbols")
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
  : Math.max(90_000, 60_000 + devSoakSymbolCount * 10_000)
// The regular interactive dev command intentionally stays at 4 GiB. A long
// HMR soak compiles every operations/statistics route and retains those module
// graphs for the whole run, so allow the dedicated debug harness to use the
// same larger heap class as scripts/dev-debug.js without changing production.
const devNodeHeapMb = Math.max(
  4096,
  Math.min(12288, Number(process.env.DEV_NODE_HEAP_MB || 12288)),
)
let outputTail = ""

rmSync(snapshotPath, { force: true })
rmSync(devDistPath, { recursive: true, force: true })

function keepTail(chunk) {
  // Runtime summaries are coalesced. Keep a bounded diagnostic tail large
  // enough for a compiler stack without retaining half a megabyte of stdout.
  outputTail = `${outputTail}${String(chunk)}`.slice(-128_000)
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
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(new URL(pathname, baseUrl), {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
      ...options,
      headers: { Accept: "application/json", ...(options.headers || {}) },
    })
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

async function prewarmDevRoutes() {
  // Next dev compiles App routes on first request. Compiling eleven large API
  // graphs concurrently while the engine is allocating Strategy Sets can make
  // Next expose a half-installed route module ("handler is not a function").
  // Compile them serially before QuickStart so the soak measures application
  // processing and route execution, not a compiler stampede.
  const inventory = await requestJson("/api/connections")
  const connectionId = String(inventory?.connections?.[0]?.id || "")
  if (!connectionId) throw new Error("Dev route warmup found no connection")
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
  await requestJson(`/api/settings/connections/${encoded}/toggle-dashboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(120_000),
  })

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

function runSoakVerifier() {
  return new Promise((resolve, reject) => {
    const verifier = spawn(process.execPath, ["scripts/verify-prod-soak.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BASE_URL: baseUrl,
        PORT: String(port),
        START_SIMULATED_ENGINE: "1",
        SYMBOL_COUNT: String(devSoakSymbolCount),
        SOAK_DURATION_MS: String(devSoakDurationMs),
        RUNTIME_MODE: "development",
        SOAK_ADMIN_SECRET: debugAdminSecret,
        // Constrained-host budgets: the in-process simulated Redis cannot churn
        // 1–7 day TTL progression/snapshot keys within a memory-fitting short
        // soak, so raise the post-warmup RSS and database key-growth budgets
        // above the strict CI defaults. Production CI leaves these unset.
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
// The full stress soak runs the exhaustive engine against the in-process Redis,
// which holds the entire key set in the Node heap and OOMs small containers
// before its plateau/leak checks can pass. This smoke covers the real
// production-critical path — boot, migrations, explicit QuickStart symbol
// preservation (the dev-preview regression), and endpoint health — without the
// unbounded key growth that exhausts an in-process Redis in a constrained box.
async function runSmokeVerifier() {
  const SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT",
    "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT", "ATOMUSDT", "LTCUSDT",
  ].slice(0, Math.max(1, devSoakSymbolCount))
  const quickStart = await requestJson("/api/trade-engine/quick-start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "enable",
      symbolCount: SYMBOLS.length,
      symbols: SYMBOLS,
      liveTrade: false,
      is_live_trade: false,
      baseProfitFactor: 0.8,
      mainProfitFactor: 0.75,
      realProfitFactor: 0.75,
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
  const connectionId = String(status?.connections?.[0]?.id || "bingx-x01")
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
}

async function main() {
  const server = spawn(process.execPath, [nextBin, "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      NEXT_DIST_DIR: devDistDir,
      DISABLE_TRADE_ENGINE_AUTOSTART: "1",
      DISABLE_TRADE_ENGINE_IN_PROCESS: "0",
      DISABLE_IN_PROCESS_CONTINUITY: "0",
      ALLOW_PROD_SIMULATED: "1",
      FORCE_SIMULATED: "1",
      FORCE_LIVE: "0",
      V0_DEV_SYMBOL_COUNT: String(devSoakSymbolCount),
      ENGINE_SYMBOL_CONCURRENCY: process.env.DEV_ENGINE_SYMBOL_CONCURRENCY || "2",
      STRATEGY_FLOW_SYMBOL_CONCURRENCY: process.env.DEV_STRATEGY_SYMBOL_CONCURRENCY || "2",
      // The development verifier runs Next's compiler, the inline Redis
      // fallback and the complete engine in one process. Exercise the full
      // cartesian Main calculation, but keep the existing explicit Real-row
      // output boundary small enough that the diagnostic process does not
      // retain multi-gigabyte transient graphs. Production/operator defaults
      // remain unchanged.
      STRATEGY_REAL_SETS_CEILING: process.env.DEV_STRATEGY_REAL_SETS_CEILING || "600",
      STRATEGY_VARIANT_BUILD_CONCURRENCY: process.env.DEV_STRATEGY_VARIANT_BUILD_CONCURRENCY || "32",
      PREHISTORIC_SYMBOL_CONCURRENCY: process.env.DEV_PREHISTORIC_SYMBOL_CONCURRENCY || "1",
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
      NODE_OPTIONS: `--max-old-space-size=${devNodeHeapMb} --max-semi-space-size=192 --expose-gc`,
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
    const fullSoak = process.env.DEV_PREVIEW_FULL_SOAK === "1"
    try {
      if (fullSoak) {
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
      mode: fullSoak ? "development-paper-engine-stress" : "development-paper-engine-smoke",
      symbols: devSoakSymbolCount,
      nodeHeapLimitMb: devNodeHeapMb,
      realExchangeOrdersSubmitted: 0,
    }, null, 2))
  } finally {
    await stopServer(server)
    rmSync(snapshotPath, { force: true })
    rmSync(devDistPath, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error("[run-dev-preview-check] failed:", error instanceof Error ? error.message : String(error))
  if (outputTail) console.error(`[run-dev-preview-check] server tail:\n${outputTail}`)
  process.exit(1)
})
