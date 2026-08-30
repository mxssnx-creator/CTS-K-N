#!/usr/bin/env node

/** Start the exact production artifact created by Next's standalone output. */

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import process from "node:process"

const projectRoot = resolve(process.cwd())
const runtimeDir = resolve(process.env.CTS_RUNTIME_DIR || resolve(projectRoot, ".cts-runtime"))
const configuredDistDir = process.env.NEXT_DIST_DIR || ".next"
const distDir = resolve(projectRoot, configuredDistDir)
const distName = basename(distDir)

if (dirname(distDir) !== projectRoot || !distName.startsWith(".next")) {
  throw new Error(`Refusing to start an unsafe Next dist directory: ${configuredDistDir}`)
}

const standaloneServer = resolve(distDir, "standalone", "server.js")
const port = String(process.env.PORT || "3002")
const hostname = String(process.env.HOST || process.env.HOSTNAME || "0.0.0.0")
// Bun is used as the compact global launcher, while the Next standalone
// artifact stays on Node for exact Next.js runtime compatibility.
const nodeRuntime = process.env.CTS_NODE_BIN || (process.versions.bun ? "node" : process.execPath)
const runtimeStartedAt = process.env.CTS_RUNTIME_STARTED_AT || new Date().toISOString()
const runtimeBootId = process.env.CTS_RUNTIME_BOOT_ID ||
  `prod_${Date.now()}_${process.pid}_${randomUUID().slice(0, 12)}`
const shutdownGraceMs = Math.max(
  1_000,
  Math.min(40_000, Number(process.env.CTS_SHUTDOWN_GRACE_MS || 30_000)),
)
const env = {
  ...process.env,
  // `next start` reads this variable to locate a non-default build directory.
  // Keep the fallback aligned with the validated artifact when standalone is
  // intentionally disabled (for example constrained production-preview runs).
  NEXT_DIST_DIR: configuredDistDir,
  PORT: port,
  HOSTNAME: hostname,
  CTS_RUNTIME_BOOT_ID: runtimeBootId,
  CTS_RUNTIME_STARTED_AT: runtimeStartedAt,
  CTS_RUNTIME_DIR: runtimeDir,
}

const [command, args, label] = existsSync(standaloneServer)
  ? [nodeRuntime, [standaloneServer], "standalone"]
  : [nodeRuntime, [resolve(projectRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", hostname, "-p", port], "next-start-fallback"]

console.log(`[production-start] ${label} on ${hostname}:${port} (dist=${distName})`)

const child = spawn(command, args, {
  cwd: projectRoot,
  env,
  stdio: "inherit",
})

let requestedShutdownSignal = null
let shutdownTimer = null

function childIsRunning() {
  return child.exitCode === null && child.signalCode === null
}

function requestShutdown(signal) {
  if (requestedShutdownSignal) return
  requestedShutdownSignal = signal
  if (childIsRunning()) child.kill(signal)
  shutdownTimer = setTimeout(() => {
    if (!childIsRunning()) return
    console.warn(
      `[production-start] runtime did not exit within ${shutdownGraceMs}ms after ${signal}; forcing termination`,
    )
    child.kill("SIGKILL")
  }, shutdownGraceMs)
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    requestShutdown(signal)
  })
}

child.once("error", (error) => {
  if (shutdownTimer) clearTimeout(shutdownTimer)
  console.error(`[production-start] failed: ${error.message}`)
  process.exitCode = 1
})
child.once("exit", (code, signal) => {
  if (shutdownTimer) clearTimeout(shutdownTimer)
  console.log(
    `[production-start] runtime exited code=${code ?? "none"} signal=${signal || "none"}`,
  )
  if (requestedShutdownSignal) {
    process.exitCode = 0
    return
  }
  if (signal) {
    process.exitCode = signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1
    return
  }
  process.exitCode = code ?? 1
})
