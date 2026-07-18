#!/usr/bin/env node

import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import process from "node:process"
import { pathToFileURL } from "node:url"

export function parseEnvironmentFile(source) {
  const parsed = {}
  for (const rawLine of source.split(/\n/)) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    if (!line.trim() || line.trimStart().startsWith("#")) continue
    const separator = line.indexOf("=")
    if (separator < 1) throw new Error("Environment file contains a malformed line")
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1)
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`)
    if (value.includes("\0")) throw new Error(`Environment value contains NUL: ${key}`)

    const quote = value[0]
    if ((quote === "\"" || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1)
      if (quote === "\"") {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\"/g, "\"")
          .replace(/\\\\/g, "\\")
      }
    }
    parsed[key] = value
  }
  return parsed
}

export async function main(argv = process.argv.slice(2)) {
  const separator = argv.indexOf("--")
  if (separator !== 1 || !argv[0] || !argv[2]) {
    throw new Error("Usage: run-with-env.mjs ENV_FILE -- COMMAND [ARG ...]")
  }
  const envFile = argv[0]
  const command = argv[2]
  const args = argv.slice(3)
  const source = await readFile(envFile, "utf8")
  const env = { ...process.env, ...parseEnvironmentFile(source) }

  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  })
  const forward = (signal) => {
    if (!child.killed) child.kill(signal)
  }
  process.once("SIGINT", () => forward("SIGINT"))
  process.once("SIGTERM", () => forward("SIGTERM"))

  await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Child terminated by ${signal}`))
      else if (code === 0) resolve()
      else reject(new Error(`Child exited with status ${code ?? "unknown"}`))
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[run-with-env] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
