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
import process from "node:process"

const port = Math.max(1024, Math.floor(Number(process.env.DIRECT_TRADE_PREFLIGHT_PORT) || 3117))
const baseUrl = `http://127.0.0.1:${port}`
const token = `direct-trade-preflight-${process.pid}-0123456789`
const snapshotPath = `/tmp/cts-direct-trade-live-preflight-${process.pid}.json`
const symbolCount = Math.max(1, Math.min(4, Math.floor(Number(process.env.DIRECT_TRADE_PREFLIGHT_SYMBOLS) || 1)))
let server
let worker
let outputTail = ""

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
  try { process.kill(-child.pid, "SIGKILL") } catch { /* already stopped */ }
}

async function main() {
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
      PORT: String(port),
      NODE_OPTIONS: process.env.DIRECT_TRADE_PREFLIGHT_NODE_OPTIONS || "--max-old-space-size=4096",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
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
        timeframes: ["1m"],
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
  }
}

main().catch((error) => {
  console.error(`[test-direct-trade-live-preflight] ${error instanceof Error ? error.message : String(error)}`)
  if (outputTail) console.error(`[test-direct-trade-live-preflight] tail:\n${outputTail}`)
  process.exitCode = 1
})
