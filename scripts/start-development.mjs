#!/usr/bin/env node

/** Start Next development with one boot identity inherited by every worker. */

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import process from "node:process"

const forwarded = process.argv.slice(2)
const hasPort = forwarded.some((arg) => arg === "-p" || arg === "--port" || arg.startsWith("--port="))
const nextArgs = ["dev", ...(hasPort ? [] : ["-p", String(process.env.PORT || "3000")]), ...forwarded]
const runtimeStartedAt = process.env.CTS_RUNTIME_STARTED_AT || new Date().toISOString()
const runtimeBootId = process.env.CTS_RUNTIME_BOOT_ID ||
  `dev_${Date.now()}_${process.pid}_${randomUUID().slice(0, 12)}`

const child = spawn(process.execPath, [resolve("node_modules/next/dist/bin/next"), ...nextArgs], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    CTS_RUNTIME_BOOT_ID: runtimeBootId,
    CTS_RUNTIME_STARTED_AT: runtimeStartedAt,
  },
  stdio: "inherit",
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}

child.once("error", (error) => {
  console.error(`[development-start] failed: ${error.message}`)
  process.exitCode = 1
})
child.once("exit", (code, signal) => {
  if (signal) {
    process.exitCode = signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1
    return
  }
  process.exitCode = code ?? 1
})
