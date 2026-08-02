#!/usr/bin/env node
/**
 * Runs the Direct-Trade recovery contract against a real paper-only dev API.
 * It intentionally SIGKILLs the dev server between phases, preserving only
 * the inline Redis snapshot; no trade processor or exchange credential exists
 * in this harness.
 */

import { spawn } from "node:child_process"
import process from "node:process"

const port = Math.max(1024, Math.floor(Number(process.env.DIRECT_TRADE_RECOVERY_PORT) || 3126))
const baseUrl = `http://127.0.0.1:${port}`
const snapshotPath = `/tmp/cts-direct-trade-recovery-${process.pid}.json`
let server = null
let outputTail = ""

function appendTail(chunk) {
  outputTail = `${outputTail}${String(chunk)}`.slice(-24_000)
}

function serverEnv() {
  return {
    ...process.env,
    FORCE_SIMULATED: "1",
    DIRECT_TRADE_TEST_LEASE_MS: "350",
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
    NODE_OPTIONS: process.env.DIRECT_TRADE_RECOVERY_NODE_OPTIONS || "--max-old-space-size=2048",
  }
}

async function waitForReady() {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (server?.exitCode != null) throw new Error(`Dev server exited ${server.exitCode}\n${outputTail}`)
    try {
      const response = await fetch(`${baseUrl}/api/health/liveness`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch { /* compiling */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Dev server did not become ready\n${outputTail}`)
}

function startServer() {
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: serverEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", appendTail)
  server.stderr.on("data", appendTail)
}

async function stopServer(signal = "SIGTERM") {
  if (!server?.pid) return
  // Do not signal a negative process group here. Some constrained runners
  // place the harness and its child in a shared group, which would turn this
  // deliberately targeted simulated crash into a test-runner crash as well.
  server.kill(signal)
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 8_000)),
  ])
  if (server.exitCode == null) {
    server.kill("SIGKILL")
  }
  server = null
}

async function runPhase(phase) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/test-direct-trade-recovery-scenarios.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DIRECT_TRADE_BASE_URL: baseUrl,
        DIRECT_TRADE_RECOVERY_PHASE: phase,
        DIRECT_TRADE_RECOVERY_LEASE_WAIT_MS: "850",
      },
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => code === 0
      ? resolve(undefined)
      : reject(new Error(`Recovery phase ${phase} exited code=${code} signal=${signal || "none"}`)))
  })
}

try {
  startServer()
  await waitForReady()
  await runPhase("before-crash")
  // This is deliberately a hard crash, not a graceful Next shutdown.
  console.log("[direct-trade-recovery] simulating server crash")
  await stopServer("SIGKILL")
  console.log("[direct-trade-recovery] starting replacement server")
  startServer()
  await waitForReady()
  console.log("[direct-trade-recovery] validating recovered state")
  await runPhase("after-restart")
  console.log(JSON.stringify({ test: "direct-trade-recovery-soak", simulatedOnly: true, physicalCrashRestart: true }, null, 2))
} catch (error) {
  console.error(`[run-direct-trade-recovery-soak] ${error instanceof Error ? error.message : String(error)}`)
  if (outputTail) console.error(`[run-direct-trade-recovery-soak] server tail:\n${outputTail}`)
  process.exitCode = 1
} finally {
  await stopServer()
}
