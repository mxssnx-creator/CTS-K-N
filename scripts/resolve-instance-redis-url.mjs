#!/usr/bin/env node

const raw = String(process.env.CTS_REDIS_CANDIDATE || "").trim()
const db = Number(process.env.CTS_REDIS_DB)

if (!Number.isInteger(db) || db < 0 || db > 15) {
  process.stderr.write("CTS_REDIS_DB must be an integer from 0 through 15\n")
  process.exit(2)
}

if (!raw) process.exit(0)

let parsed
try {
  parsed = new URL(raw)
} catch {
  process.stderr.write("Configured REDIS_URL is invalid\n")
  process.exit(2)
}

if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
  process.stderr.write("Configured REDIS_URL must use redis:// or rediss://\n")
  process.exit(2)
}

const host = parsed.hostname.toLowerCase()
const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1"
if (isLocal) {
  const existingPath = parsed.pathname.replace(/^\/+|\/+$/g, "")
  if (existingPath && !/^\d+$/.test(existingPath)) {
    process.stderr.write("Local REDIS_URL has an unsupported non-numeric database path\n")
    process.exit(2)
  }
  if (existingPath && Number(existingPath) !== db) {
    process.stderr.write(`Local REDIS_URL selects DB ${existingPath}, but this instance owns DB ${db}\n`)
    process.exit(2)
  }
  parsed.pathname = `/${db}`
}

process.stdout.write(parsed.toString().replace(/\/$/, isLocal ? `/${db}` : ""))
