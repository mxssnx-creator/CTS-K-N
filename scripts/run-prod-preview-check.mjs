#!/usr/bin/env node

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import process from "node:process"

const port = Number(process.env.PORT || 3102)
const baseUrl = `http://127.0.0.1:${port}`
const nextBin = "node_modules/next/dist/bin/next"
const distDir = process.env.NEXT_DIST_DIR || ".next-prod"
let outputTail = ""

function keepTail(chunk) {
  outputTail = `${outputTail}${String(chunk)}`.slice(-12_000)
}

async function waitForReady(child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Preview server exited with ${child.exitCode}\n${outputTail}`)
    try {
      const response = await fetch(`${baseUrl}/api/health/liveness`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch { /* startup in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Preview server did not become ready\n${outputTail}`)
}

function runVerifier() {
  return new Promise((resolve, reject) => {
    const verifier = spawn(process.execPath, ["scripts/verify-prod-preview.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, BASE_URL: baseUrl, PORT: String(port) },
      stdio: "inherit",
    })
    verifier.once("error", reject)
    verifier.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Preview verifier exited code=${code} signal=${signal || "none"}`))
    })
  })
}

async function stopServer(child) {
  if (child.exitCode != null) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  if (child.exitCode == null) child.kill("SIGKILL")
}

async function main() {
  if (!existsSync(`${distDir}/BUILD_ID`)) {
    throw new Error(`Production build not found in ${distDir}; run NEXT_DIST_DIR=${distDir} npm run build first`)
  }

  const child = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_DIST_DIR: distDir,
      DISABLE_TRADE_ENGINE_AUTOSTART: "1",
      DISABLE_TRADE_ENGINE_IN_PROCESS: "1",
      DISABLE_IN_PROCESS_CONTINUITY: "1",
      ALLOW_PROD_INLINE_REDIS: "1",
      ALLOW_INLINE_REDIS_LIVE_TRADING: "0",
      FORCE_SIMULATED: "1",
      BINGX_API_KEY: "",
      BINGX_API_SECRET: "",
      BYBIT_API_KEY: "",
      BYBIT_API_SECRET: "",
      PIONEX_API_KEY: "",
      PIONEX_API_SECRET: "",
      ORANGEX_API_KEY: "",
      ORANGEX_API_SECRET: "",
      V0_REDIS_SNAPSHOT_PATH: `/tmp/cts-prod-preview-${process.pid}.json`,
      NODE_OPTIONS: "--max-old-space-size=5632 --max-semi-space-size=256 --expose-gc",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", keepTail)
  child.stderr.on("data", keepTail)

  try {
    await waitForReady(child)
    await runVerifier()
  } finally {
    await stopServer(child)
  }
}

main().catch((error) => {
  console.error("[run-prod-preview-check] failed:", error instanceof Error ? error.message : String(error))
  process.exit(1)
})
