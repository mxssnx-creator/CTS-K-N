#!/usr/bin/env node

/** Safe 12-symbol development-mode engine soak with paper positions only. */

import { spawn } from "node:child_process"
import { rmSync } from "node:fs"
import process from "node:process"

const port = Number(process.env.PORT || 3103)
const baseUrl = `http://127.0.0.1:${port}`
const nextBin = "node_modules/next/dist/bin/next"
const snapshotPath = `/tmp/cts-dev-preview-${process.pid}.json`
let outputTail = ""

rmSync(snapshotPath, { force: true })

function keepTail(chunk) {
  outputTail = `${outputTail}${String(chunk)}`.slice(-16_000)
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

function runSoakVerifier() {
  return new Promise((resolve, reject) => {
    const verifier = spawn(process.execPath, ["scripts/verify-prod-soak.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BASE_URL: baseUrl,
        PORT: String(port),
        START_SIMULATED_ENGINE: "1",
        SYMBOL_COUNT: "12",
        SOAK_DURATION_MS: process.env.DEV_SOAK_DURATION_MS || "60000",
        RUNTIME_MODE: "development",
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
  if (!child || child.exitCode != null) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  if (child.exitCode == null) child.kill("SIGKILL")
}

async function main() {
  const server = spawn(process.execPath, [nextBin, "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DISABLE_TRADE_ENGINE_AUTOSTART: "1",
      DISABLE_TRADE_ENGINE_IN_PROCESS: "0",
      DISABLE_IN_PROCESS_CONTINUITY: "0",
      ALLOW_PROD_SIMULATED: "1",
      FORCE_SIMULATED: "1",
      FORCE_LIVE: "0",
      V0_DEV_SYMBOL_COUNT: "12",
      ENGINE_SYMBOL_CONCURRENCY: process.env.DEV_ENGINE_SYMBOL_CONCURRENCY || "2",
      STRATEGY_FLOW_SYMBOL_CONCURRENCY: process.env.DEV_STRATEGY_SYMBOL_CONCURRENCY || "2",
      PREHISTORIC_SYMBOL_CONCURRENCY: process.env.DEV_PREHISTORIC_SYMBOL_CONCURRENCY || "1",
      MARKET_DATA_LOAD_CONCURRENCY: "1",
      CRON_SYMBOL_LIMIT: "12",
      BINGX_API_KEY: "",
      BINGX_API_SECRET: "",
      BYBIT_API_KEY: "",
      BYBIT_API_SECRET: "",
      PIONEX_API_KEY: "",
      PIONEX_API_SECRET: "",
      ORANGEX_API_KEY: "",
      ORANGEX_API_SECRET: "",
      V0_REDIS_SNAPSHOT_PATH: snapshotPath,
      NODE_OPTIONS: "--max-old-space-size=5632 --max-semi-space-size=256 --expose-gc",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", keepTail)
  server.stderr.on("data", keepTail)

  try {
    await waitForReady(server)
    await runSoakVerifier()
    console.log(JSON.stringify({
      success: true,
      mode: "development-paper-engine",
      symbols: 12,
      realExchangeOrdersSubmitted: 0,
    }, null, 2))
  } finally {
    await stopServer(server)
    rmSync(snapshotPath, { force: true })
  }
}

main().catch((error) => {
  console.error("[run-dev-preview-check] failed:", error instanceof Error ? error.message : String(error))
  if (outputTail) console.error(`[run-dev-preview-check] server tail:\n${outputTail}`)
  process.exit(1)
})
