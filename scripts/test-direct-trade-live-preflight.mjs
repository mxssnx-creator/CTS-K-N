#!/usr/bin/env node

/**
 * Direct-Trade live lifecycle preflight.
 *
 * This is a paper-only contract test. It starts the real Next API and the
 * real Direct-Trade processor, requests Live mode with a deliberately stale
 * paper range, and proves that the worker first publishes an exact 48h
 * calculation before its realtime ticks continue. FORCE_SIMULATED is forced
 * in the child server, so this test can never submit an exchange order.
 */

import { spawn } from "node:child_process"
import { readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import process from "node:process"

const port = Math.max(1024, Math.floor(Number(process.env.DIRECT_TRADE_PREFLIGHT_PORT) || 3117))
const baseUrl = `http://127.0.0.1:${port}`
const token = `direct-trade-preflight-${process.pid}-0123456789`
const snapshotPath = `/tmp/cts-direct-trade-live-preflight-${process.pid}.json`
// Keep this dev-based lifecycle test physically separate from the canonical
// production build. Next dev removes BUILD_ID and rewrites compiler metadata;
// sharing `.next` would make an otherwise valid production artifact unusable.
const preflightDistDir = `.next-live-preflight-${process.pid}`
const sourceMetadataSnapshots = new Map(
  ["next-env.d.ts", "tsconfig.json"].map((file) => [file, readFileSync(file, "utf8")]),
)
const symbolCount = Math.max(1, Math.min(4, Math.floor(Number(process.env.DIRECT_TRADE_PREFLIGHT_SYMBOLS) || 1)))
let server
let worker
let outputTail = ""

function nextServerProcessIds() {
  if (process.platform === "win32") return []
  let entries = []
  try { entries = readdirSync("/proc", { withFileTypes: true }) } catch { return [] }
  const pids = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    try {
      if (readFileSync(`/proc/${entry.name}/comm`, "utf8").trim().startsWith("next-server")) {
        pids.push(Number(entry.name))
      }
    } catch { /* process exited during inspection */ }
  }
  return pids
}

function listeningProcessIds(targetPort) {
  if (process.platform === "win32") return []
  const portHex = Number(targetPort).toString(16).toUpperCase().padStart(4, "0")
  const socketInodes = new Set()
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let contents = ""
    try { contents = readFileSync(table, "utf8") } catch { continue }
    for (const line of contents.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/)
      if (fields.length >= 10 && fields[3] === "0A" && String(fields[1] || "").endsWith(`:${portHex}`)) {
        socketInodes.add(fields[9])
      }
    }
  }
  if (socketInodes.size === 0) return []
  let entries = []
  try { entries = readdirSync("/proc", { withFileTypes: true }) } catch { return [] }
  const pids = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    let descriptors = []
    try { descriptors = readdirSync(`/proc/${entry.name}/fd`) } catch { continue }
    for (const descriptor of descriptors) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${entry.name}/fd/${descriptor}`))
        if (match && socketInodes.has(match[1])) {
          pids.push(Number(entry.name))
          break
        }
      } catch { /* descriptor exited during inspection */ }
    }
  }
  return pids
}

function preflightProcessIds() {
  if (process.platform === "win32") return []
  let entries = []
  try { entries = readdirSync("/proc", { withFileTypes: true }) } catch { return [] }
  const marker = `NEXT_DIST_DIR=${preflightDistDir}`
  const pids = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    try {
      const environment = readFileSync(`/proc/${entry.name}/environ`, "utf8").split("\0")
      if (environment.includes(marker)) pids.push(Number(entry.name))
    } catch { /* process exited or hides its environment */ }
  }
  return pids
}

function appendTail(chunk) {
  outputTail = `${outputTail}${String(chunk)}`.slice(-24_000)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path}: HTTP ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

async function waitForServer() {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (server?.exitCode != null) throw new Error(`Next exited with ${server.exitCode}\n${outputTail}`)
    try {
      const response = await fetch(`${baseUrl}/api/health/liveness`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch { /* startup/route compilation */ }
    await sleep(250)
  }
  throw new Error(`Next did not become ready\n${outputTail}`)
}

async function waitForWarmup() {
  const deadline = Date.now() + 180_000
  let last = null
  while (Date.now() < deadline) {
    last = await request("/api/trade-engine/direct-trade/status")
    const historyHours = Number(last?.calculation?.historyHours)
    const tickCount = Number(last?.processor?.tickCount || 0)
    const calculationReady = last?.calculationProgress?.status === "ready"
    if (
      last?.state?.liveMode === true &&
      calculationReady &&
      historyHours === 48 &&
      tickCount > 0 &&
      last?.processor?.isHealthy === true
    ) return last
    await sleep(1_000)
  }
  throw new Error(`48h live warmup/realtime tick did not complete: ${JSON.stringify(last)}`)
}

async function stopChild(child) {
  if (!child?.pid) return
  try { process.kill(-child.pid, "SIGTERM") } catch { child.kill("SIGTERM") }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(5_000),
  ])
  // Next can replace its compiler/server child while the wrapper is exiting.
  // Re-signal the private process group for a bounded interval so no late
  // child can recreate the isolated dist directory after cleanup.
  for (let attempt = 0; attempt < 10; attempt++) {
    try { process.kill(-child.pid, "SIGKILL") } catch { /* group already stopped */ }
    await sleep(100)
    try {
      process.kill(-child.pid, 0)
    } catch {
      break
    }
  }
  if (child.nextServerBefore || child.listeningBefore) {
    let quietPasses = 0
    for (let pass = 0; pass < 30 && quietPasses < 5; pass++) {
      const lateNextServers = nextServerProcessIds()
        .filter((pid) => !(child.nextServerBefore || new Set()).has(pid))
      const latePortProcesses = listeningProcessIds(port)
        .filter((pid) => !(child.listeningBefore || new Set()).has(pid))
      // Compiler children do not listen and can use `node` rather than the
      // `next-server` comm name. The unique dist env marker is therefore the
      // exact final ownership check for every process allowed to write here.
      const lateOwned = [...new Set([
        ...lateNextServers,
        ...latePortProcesses,
        ...preflightProcessIds(),
      ])]
      if (lateOwned.length === 0) {
        quietPasses++
      } else {
        quietPasses = 0
        for (const pid of lateOwned) {
          try { process.kill(pid, "SIGKILL") } catch { /* process exited during inspection */ }
        }
      }
      await sleep(100)
    }
  }
}

async function main() {
  rmSync(snapshotPath, { force: true })
  rmSync(preflightDistDir, { recursive: true, force: true })
  const nextServerBefore = new Set(nextServerProcessIds())
  const listeningBefore = new Set(listeningProcessIds(port))
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      FORCE_SIMULATED: "1",
      FORCE_LIVE: "0",
      ALLOW_LIVE_ORDER_PLACEMENT: "0",
      DIRECT_TRADE_PROCESSOR_TOKEN: token,
      DIRECT_TRADE_SYNTHETIC_MARKET_DATA: "1",
      DISABLE_TRADE_ENGINE_AUTOSTART: "1",
      DISABLE_TRADE_ENGINE_IN_PROCESS: "1",
      DISABLE_IN_PROCESS_CONTINUITY: "1",
      BINGX_API_KEY: "",
      BINGX_API_SECRET: "",
      V0_REDIS_SNAPSHOT_PATH: snapshotPath,
      NEXT_DIST_DIR: preflightDistDir,
      PORT: String(port),
      NODE_OPTIONS: process.env.DIRECT_TRADE_PREFLIGHT_NODE_OPTIONS || "--max-old-space-size=4096",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.nextServerBefore = nextServerBefore
  server.listeningBefore = listeningBefore
  server.stdout.on("data", appendTail)
  server.stderr.on("data", appendTail)

  try {
    await waitForServer()
    const symbols = ["BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT"].slice(0, Math.max(4, symbolCount))
    const started = await request("/api/trade-engine/direct-trade", {
      method: "POST",
      body: JSON.stringify({
        action: "start",
        liveMode: true,
        connectionId: "bingx-x01",
        symbolCount,
        symbols,
        // Both paper and live paths use the unified 48h warmup contract.
        historyHours: 48,
        timeframes: ["5m"],
        strategyTypes: ["standard"],
        entryTactics: ["breakout"],
        exitTactics: ["bracket"],
        trailingEnabled: false,
        minRecentProfitFactor: 0.8,
        recentEvaluationPositions: 3,
        minProfitFactor: 0.8,
        maxDrawdownTimeMin: 10,
        activityVolumeRatio: 0,
        processingIntervalMs: 500,
      }),
    })
    if (!started?.success || started?.state?.liveMode !== true) {
      throw new Error(`Could not enter Direct-Trade live lifecycle: ${JSON.stringify(started)}`)
    }

    worker = spawn(process.execPath, ["scripts/direct-trade-processor.mjs", "--port", String(port)], {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        PORT: String(port),
        DIRECT_TRADE_PROCESSOR_TOKEN: token,
        DIRECT_TRADE_LIVE_HISTORY_HOURS: "48",
        DIRECT_TRADE_SYNTHETIC_MARKET_DATA: "1",
        NODE_OPTIONS: process.env.DIRECT_TRADE_PREFLIGHT_NODE_OPTIONS || "--max-old-space-size=4096",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    worker.stdout.on("data", appendTail)
    worker.stderr.on("data", appendTail)

    const status = await waitForWarmup()
    console.log(JSON.stringify({
      success: true,
      paperOnly: true,
      liveLifecycleExercised: true,
      requestedPaperHistoryHours: 48,
      requiredLiveHistoryHours: 48,
      publishedHistoryHours: Number(status.calculation.historyHours),
      calculationStatus: status.calculationProgress.status,
      processorTicks: Number(status.processor.tickCount),
      processorHealthy: status.processor.isHealthy === true,
      realExchangeOrdersSubmitted: 0,
    }, null, 2))
  } finally {
    await stopChild(worker)
    await stopChild(server)
    rmSync(preflightDistDir, { recursive: true, force: true })
    rmSync(snapshotPath, { force: true })
    for (const [file, contents] of sourceMetadataSnapshots) writeFileSync(file, contents)
    // Close the final write-after-exit race even on runtimes whose process
    // group visibility lags behind the child exit notification.
    await sleep(500)
    rmSync(preflightDistDir, { recursive: true, force: true })
    rmSync(snapshotPath, { force: true })
  }
}

main().catch((error) => {
  console.error(`[test-direct-trade-live-preflight] ${error instanceof Error ? error.message : String(error)}`)
  if (outputTail) console.error(`[test-direct-trade-live-preflight] tail:\n${outputTail}`)
  process.exitCode = 1
})
