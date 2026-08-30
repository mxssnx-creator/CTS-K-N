#!/usr/bin/env node

/**
 * Direct-Trade live lifecycle preflight.
 *
 * This is a paper-only contract test. It starts the real Next API, verifies
 * that an unsafe Direct-Trade Live request is rejected by the shared native
 * protection gate, then starts the same configuration in paper mode and
 * proves that the worker publishes at least the 48h baseline (or one bounded
 * expansion up to 90h when coverage is sparse) before realtime ticks continue.
 * FORCE_SIMULATED is forced in the child server, so this test can never submit
 * an exchange order.
 */

import { spawn } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import process from "node:process"

const port = Math.max(1024, Math.floor(Number(process.env.DIRECT_TRADE_PREFLIGHT_PORT) || 3117))
const baseUrl = `http://127.0.0.1:${port}`
const token = `direct-trade-preflight-${process.pid}-0123456789`
const snapshotPath = `/tmp/cts-direct-trade-live-preflight-${process.pid}.json`
// Keep this dev-based lifecycle test physically separate from the canonical
// production build. Next dev removes BUILD_ID and rewrites compiler metadata;
// sharing `.next` would make an otherwise valid production artifact unusable.
const preflightDistDir = `.next-live-preflight-${process.pid}`
const testConnectionId = "bingx-x02"
const sourceMetadataSnapshots = new Map(
  ["next-env.d.ts", "tsconfig.json"].map((file) => [file, readFileSync(file, "utf8")]),
)
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

async function requestRaw(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  })
  const payload = await response.json().catch(() => ({}))
  return { response, payload }
}

async function request(path, options = {}) {
  const { response, payload } = await requestRaw(path, options)
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

async function waitForWarmup(expectedLiveMode = false) {
  const deadline = Date.now() + 180_000
  let last = null
  while (Date.now() < deadline) {
    last = await request(
      `/api/trade-engine/direct-trade/status?connectionId=${encodeURIComponent(testConnectionId)}`,
    )
    const historyHours = Number(last?.calculation?.historyHours)
    const tickCount = Number(last?.processor?.tickCount || 0)
    const calculationReady = last?.calculationProgress?.status === "ready"
    if (
      last?.state?.liveMode === expectedLiveMode &&
      calculationReady &&
      historyHours >= 48 &&
      historyHours <= 90 &&
      last?.processor?.historyPolicy?.canProceed !== false &&
      tickCount > 0 &&
      last?.processor?.isHealthy === true
    ) return last
    await sleep(1_000)
  }
  throw new Error(`Bounded 48-90h live warmup/realtime tick did not complete: ${JSON.stringify(last)}`)
}

async function stopChild(child) {
  if (!child?.pid) return
  try { process.kill(-child.pid, "SIGTERM") } catch { child.kill("SIGTERM") }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(5_000),
  ])
  // The child was spawned detached and therefore owns a private process group.
  // Signal only that exact group. Scanning /proc for every new next-server or
  // listener on the port can kill unrelated workspaces and is never safe in a
  // shared persistent runner.
  for (let attempt = 0; attempt < 10; attempt++) {
    try { process.kill(-child.pid, "SIGKILL") } catch { /* group already stopped */ }
    await sleep(100)
    try {
      process.kill(-child.pid, 0)
    } catch {
      break
    }
  }
}

async function main() {
  rmSync(snapshotPath, { force: true })
  rmSync(preflightDistDir, { recursive: true, force: true })
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
  server.stdout.on("data", appendTail)
  server.stderr.on("data", appendTail)

  try {
    await waitForServer()
    const symbols = ["BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT"].slice(0, Math.min(4, Math.max(1, symbolCount)))
    const startBody = {
      action: "start",
      connectionId: testConnectionId,
      symbolCount,
      symbols,
      // Live starts at 48h and may expand to 90h only if the result graph is
      // too sparse; no evaluation threshold is relaxed.
      historyHours: 48,
      timeframes: ["5m"],
      strategyTypes: ["standard"],
      entryTactics: ["breakout"],
      exitTactics: ["bracket"],
      trailingEnabled: false,
      minRecentProfitFactor: 0.8,
      recentEvaluationPositions: 3,
      minProfitFactor: 4,
      maxDrawdownTimeMin: 10,
      activityVolumeRatio: 0,
      processingIntervalMs: 500,
    }

    const liveAttempt = await requestRaw("/api/trade-engine/direct-trade", {
      method: "POST",
      body: JSON.stringify({ ...startBody, liveMode: true }),
    })
    if (
      liveAttempt.response.status !== 409
      || liveAttempt.payload?.code !== "direct_native_protection_not_ready"
    ) {
      throw new Error(
        `Unsafe Direct-Trade live request was not blocked as expected: ` +
        `${liveAttempt.response.status} ${JSON.stringify(liveAttempt.payload)}`,
      )
    }

    const started = await request("/api/trade-engine/direct-trade", {
      method: "POST",
      body: JSON.stringify({ ...startBody, liveMode: false }),
    })
    if (!started?.success || started?.state?.liveMode !== false) {
      throw new Error(`Could not enter Direct-Trade paper lifecycle: ${JSON.stringify(started)}`)
    }

    worker = spawn(process.execPath, [
      "scripts/direct-trade-processor.mjs",
      "--port",
      String(port),
      "--connection-id",
      testConnectionId,
    ], {
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

    const status = await waitForWarmup(false)
    console.log(JSON.stringify({
      success: true,
      paperOnly: true,
      liveEntryBlocked: true,
      liveBlockCode: liveAttempt.payload.code,
      paperLifecycleExercised: true,
      requestedPaperHistoryHours: 48,
      requiredLiveHistoryHours: 48,
      publishedHistoryHours: Number(status.calculation.historyHours),
      historyPolicy: status.processor.historyPolicy,
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
