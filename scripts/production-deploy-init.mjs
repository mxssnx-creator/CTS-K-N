#!/usr/bin/env node

/** Portable production startup/migration verification for Node 20+. */

import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"

function resolveBaseUrl() {
  const raw =
    process.env.DEPLOYMENT_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://127.0.0.1:3002"
  const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return new URL(normalized).toString().replace(/\/$/, "")
}

const BASE_URL = resolveBaseUrl()

async function request(pathname, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const response = await fetch(new URL(pathname, BASE_URL), {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { /* reported below */ }
  if (!response.ok) {
    throw new Error(`${method} ${pathname} returned HTTP ${response.status}: ${text.slice(0, 240)}`)
  }
  if (payload === null) throw new Error(`${method} ${pathname} returned invalid JSON`)
  return payload
}

async function waitForHealth(maxAttempts = 30) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const health = await request("/api/health", { timeoutMs: 5_000 })
      if (health?.status || health?.alive === true) return
    } catch {
      // The deployment may still be warming or migrating.
    }
    if (attempt < maxAttempts) await sleep(2_000)
  }
  throw new Error("API did not become healthy within 60 seconds")
}

async function initialize() {
  const result = await request("/api/system/initialize", {
    method: "POST",
    body: {},
    timeoutMs: 90_000,
  })
  if (result?.success !== true) throw new Error(`System initialization failed: ${JSON.stringify(result)}`)
}

async function waitForReadiness(maxAttempts = 45) {
  let last = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await request("/api/system/init-status", { timeoutMs: 30_000 })
    const current = Number(last?.migrations?.current_version)
    const latest = Number(last?.migrations?.latest_version)
    if (last?.ready === true && current === latest && latest > 0) return last
    if (last?.status === "error") throw new Error(`Startup entered error state: ${JSON.stringify(last)}`)
    if (attempt < maxAttempts) await sleep(2_000)
  }
  throw new Error(`Startup/migrations were not ready within 90 seconds: ${JSON.stringify(last)}`)
}

async function verifyCoreApis() {
  const [connectionsPayload, settings, engine, database] = await Promise.all([
    request("/api/connections"),
    request("/api/settings"),
    request("/api/trade-engine/status"),
    request("/api/settings/database-status"),
  ])
  const connections = Array.isArray(connectionsPayload)
    ? connectionsPayload
    : connectionsPayload?.connections
  if (!Array.isArray(connections) || connections.length < 1) throw new Error("No initialized connection exists")
  if (!settings || typeof settings !== "object") throw new Error("Settings API schema is invalid")
  if (!engine || typeof engine !== "object") throw new Error("Trade-engine status schema is invalid")
  if (!database?.isConnected) throw new Error("Database status is not connected")
  if (process.env.REQUIRE_SHARED_PERSISTENCE === "1" && database?.isSharedConfigured !== true) {
    throw new Error("Database is not backed by the required shared Redis persistence")
  }
  if (process.env.REQUIRE_SHARED_PERSISTENCE === "1" && database?.liveOrderCoordinationReady !== true) {
    throw new Error("Live-order coordination is not ready on the shared Redis database")
  }
  return { connectionCount: connections.length, database }
}

async function main() {
  const startedAt = Date.now()
  console.log(`[Prod Init] Target ${BASE_URL}`)
  await waitForHealth()
  await initialize()
  const readiness = await waitForReadiness()
  const core = await verifyCoreApis()
  if (Number(core.database?.schemaVersion) !== Number(readiness.migrations.current_version)) {
    throw new Error(`Database schema version mismatch: ${core.database?.schemaVersion} != ${readiness.migrations.current_version}`)
  }

  console.log(JSON.stringify({
    success: true,
    baseUrl: BASE_URL,
    schemaVersion: readiness.migrations.current_version,
    siteInstanceId: readiness.system.site_instance_id,
    databaseBackend: core.database.backend,
    sharedRedis: core.database.isSharedConfigured,
    liveOrderCoordinationReady: core.database.liveOrderCoordinationReady === true,
    connectionCount: core.connectionCount,
    durationMs: Date.now() - startedAt,
  }, null, 2))
}

main().catch((error) => {
  console.error(`[Prod Init] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
