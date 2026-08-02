#!/usr/bin/env node
/**
 * Self-contained Direct-Trade development API soak.
 *
 * Starts a temporary, explicitly paper-only Next development server and runs
 * `test-direct-trade-dev-soak.mjs` against it. The synthetic-market switch is
 * accepted only by lib/direct-trade-market-history.ts, so it exercises the
 * real route, Redis persistence, configuration index and pulse workflow
 * without public-market transport or any order endpoint.
 *
 * Environment overrides:
 *   DIRECT_TRADE_DEV_PORT=3116
 *   DIRECT_TRADE_DEV_SYMBOLS=1 (use 32 for full API capacity)
 *   DIRECT_TRADE_DEV_HISTORY_HOURS=90
 *   DIRECT_TRADE_DEV_SOAK_ROUNDS=2
 *   DIRECT_TRADE_DEV_SOAK_INTERVAL_MS=1000
 */

import { spawn } from "node:child_process"
import process from "node:process"

const port = Math.max(1024, Math.floor(Number(process.env.DIRECT_TRADE_DEV_PORT) || 3116))
const baseUrl = `http://127.0.0.1:${port}`
let server
let outputTail = ""

function appendTail(chunk) {
  outputTail = `${outputTail}${String(chunk)}`.slice(-24_000)
}

async function waitForReady() {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (server?.exitCode != null) throw new Error(`Dev server exited ${server.exitCode}\n${outputTail}`)
    try {
      const response = await fetch(`${baseUrl}/api/health/liveness`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch { /* server is still compiling */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Dev server did not become ready\n${outputTail}`)
}

async function stopServer() {
  if (!server?.pid) return
  try { process.kill(-server.pid, "SIGTERM") } catch { server.kill("SIGTERM") }
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  try { process.kill(-server.pid, "SIGKILL") } catch { /* process already stopped */ }
}

async function main() {
  const snapshotPath = `/tmp/cts-direct-trade-dev-${process.pid}.json`
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      FORCE_SIMULATED: "1",
      FORCE_LIVE: "0",
      DIRECT_TRADE_SYNTHETIC_MARKET_DATA: "1",
      DISABLE_TRADE_ENGINE_AUTOSTART: "1",
      DISABLE_TRADE_ENGINE_IN_PROCESS: "1",
      DISABLE_IN_PROCESS_CONTINUITY: "1",
      BINGX_API_KEY: "",
      BINGX_API_SECRET: "",
      BYBIT_API_KEY: "",
      BYBIT_API_SECRET: "",
      V0_REDIS_SNAPSHOT_PATH: snapshotPath,
      PORT: String(port),
      // The isolated maximum-grid dev test intentionally keeps all Redis
      // chunks in the inline emulator. Next restarts a dev worker at 80% of
      // V8's heap limit, so 6 GiB can restart *after* a valid 32×90h publish.
      // Production Redis is external; this larger value is test-runner only.
      NODE_OPTIONS: process.env.DIRECT_TRADE_DEV_NODE_OPTIONS || "--max-old-space-size=12288",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", appendTail)
  server.stderr.on("data", appendTail)
  await waitForReady()

  await new Promise((resolve, reject) => {
    const soak = spawn(process.execPath, ["scripts/test-direct-trade-dev-soak.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DIRECT_TRADE_BASE_URL: baseUrl,
        DIRECT_TRADE_DEV_HISTORY_HOURS: process.env.DIRECT_TRADE_DEV_HISTORY_HOURS || "90",
        DIRECT_TRADE_DEV_SOAK_ROUNDS: process.env.DIRECT_TRADE_DEV_SOAK_ROUNDS || "2",
        DIRECT_TRADE_DEV_SOAK_INTERVAL_MS: process.env.DIRECT_TRADE_DEV_SOAK_INTERVAL_MS || "1000",
        DIRECT_TRADE_DEV_SYMBOLS: process.env.DIRECT_TRADE_DEV_SYMBOLS || "1",
      },
      stdio: "inherit",
    })
    soak.once("error", reject)
    soak.once("exit", (code, signal) => code === 0
      ? resolve(undefined)
      : reject(new Error(`Direct-Trade dev soak exited code=${code} signal=${signal || "none"}`)))
  })

  // The API soak validates calculation/pulse. This separate, execution-free
  // lifecycle contract validates that an open row has its own stage/index and
  // becomes part of realised PF/DDT only after it is closed.
  await new Promise((resolve, reject) => {
    const lifecycle = spawn(process.execPath, ["scripts/test-direct-trade-position-lifecycle.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, DIRECT_TRADE_BASE_URL: baseUrl },
      stdio: "inherit",
    })
    lifecycle.once("error", reject)
    lifecycle.once("exit", (code, signal) => code === 0
      ? resolve(undefined)
      : reject(new Error(`Direct-Trade lifecycle test exited code=${code} signal=${signal || "none"}`)))
  })
}

main()
  .catch((error) => {
    console.error("[run-direct-trade-dev-soak] failed:", error instanceof Error ? error.message : String(error))
    if (outputTail) console.error(`[run-direct-trade-dev-soak] server tail:\n${outputTail}`)
    process.exitCode = 1
  })
  .finally(stopServer)
