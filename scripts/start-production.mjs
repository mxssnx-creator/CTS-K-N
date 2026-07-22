#!/usr/bin/env node

/** Start the exact production artifact created by Next's standalone output. */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import process from "node:process"

const projectRoot = resolve(process.cwd())
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
const env = {
  ...process.env,
  PORT: port,
  HOSTNAME: hostname,
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

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}

child.once("error", (error) => {
  console.error(`[production-start] failed: ${error.message}`)
  process.exitCode = 1
})
child.once("exit", (code, signal) => {
  if (signal) {
    process.exitCode = signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1
    return
  }
  process.exitCode = code ?? 1
})
