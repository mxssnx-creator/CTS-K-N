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
let outputTail = ""

rmSync(snapshotPath, { force: true })
rmSync(devDistPath, { recursive: true, force: true })

function keepTail(chunk) {
  // Strategy processing is intentionally chatty in development. Keep enough
  // context that a compiler/runtime stack cannot be displaced by the next
  // symbol cycle before the harness reports it.
  outputTail = `${outputTail}${String(chunk)}`.slice(-512_000)
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
    `/api/connections/progression/${encoded}/stats`,
    `/api/trading/trade-history?connection_id=${encoded}&limit=500`,
    `/api/logistics/queue?connectionId=${encoded}`,
    `/api/trading/live-positions?connection_id=${encoded}`,
    `/api/exchange/live-summary?connection_id=${encoded}`,
    `/api/preset-optimizer?connectionId=${encoded}`,
    `/api/connections/${encoded}/engine-states`,
  ]) {
    await requestJson(pathname)
  }

  // The soak reads this authenticated diagnostic every tenth round. Compile
  // it before the engine starts allocating so a parallel production run cannot
  // turn its first 600-module cold build into a false request timeout.
  await requestJson(`/api/debug/progression-dump?id=${encoded}`, {
    headers: { Authorization: `Bearer ${debugAdminSecret}` },
  })

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
        SOAK_DURATION_MS: process.env.DEV_SOAK_DURATION_MS || "60000",
        RUNTIME_MODE: "development",
        SOAK_ADMIN_SECRET: debugAdminSecret,
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
      NODE_OPTIONS: "--max-old-space-size=4096 --max-semi-space-size=192 --expose-gc",
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
      await runSoakVerifier()
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
      mode: "development-paper-engine",
      symbols: devSoakSymbolCount,
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
