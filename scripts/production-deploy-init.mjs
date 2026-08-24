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
  const adminSecret = String(process.env.ADMIN_SECRET || "").trim()
  const response = await fetch(new URL(pathname, BASE_URL), {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(adminSecret ? { Authorization: `Bearer ${adminSecret}` } : {}),
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

async function injectCredentials() {
  try {
    const result = await request("/api/system/inject-credentials", { method: "POST", timeoutMs: 30_000 })
    console.log("[Prod Init] Injected predefined base credentials from environment")
    return result
  } catch (error) {
    const message = `[Prod Init] Credential injection skipped or failed: ${error instanceof Error ? error.message : String(error)}`
    if (process.env.CTS_REQUIRE_LIVE_TRADE_READY === "1") throw new Error(message)
    console.warn(message)
    return null
  }
}

async function verifyLiveTradeReadiness() {
  const required = process.env.CTS_REQUIRE_LIVE_TRADE_READY === "1"
  const summary = await request("/api/system/inject-credentials", { timeoutMs: 30_000 })
  const liveConnectionIds = Array.isArray(summary?.liveTradeReady)
    ? summary.liveTradeReady.filter((value) => typeof value === "string" && value.length > 0)
    : []

  if (!required && liveConnectionIds.length === 0) return { required, connectionIds: [] }
  if (liveConnectionIds.length === 0) {
    throw new Error("No exchange has valid credentials and persisted live trade enabled; configure credentials for BingX, Bybit, Pionex, or OrangeX")
  }

  const states = await Promise.all(liveConnectionIds.map(async (connectionId) => {
    const state = await request(`/api/connections/${encodeURIComponent(connectionId)}/engine-states`, { timeoutMs: 30_000 })
    const main = state?.modes?.mainTrade
    if (
      state?.success !== true ||
      main?.effective !== true ||
      main?.executionMode !== "live" ||
      main?.credentialsValid !== true ||
      main?.durableCoordinationReady !== true
    ) {
      throw new Error(
        `Live trading readiness failed for ${connectionId}: ${main?.blockCode || main?.blockReason || "unknown state"}`,
      )
    }
    return connectionId
  }))
  console.log(`[Prod Init] Live trade ready for ${states.join(", ")} (no exchange order submitted)`)
  return { required, connectionIds: states }
}

async function verifyDirectTradeProcessor(maxAttempts = 20) {
  let last = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Direct Trade is connection-scoped. A request without a connection ID
    // resolves the legacy/default X01 keyspace and can therefore report a null
    // processor even while the explicitly enabled X02 worker owns a fresh
    // lease. Verify every required scope through the aggregate endpoint.
    last = await request("/api/trade-engine/direct-trade/status?aggregate=1", { timeoutMs: 10_000 })
    const requiredConnections = Array.isArray(last?.connections)
      ? last.connections.filter((entry) => entry?.required === true)
      : []
    if (
      last?.success === true &&
      last?.aggregate === true &&
      last?.processorHealthy === true &&
      requiredConnections.every((entry) => entry?.healthy === true)
    ) {
      const ticks = requiredConnections.map((entry) => ({
        connectionId: String(entry.connectionId || "unknown"),
        tickCount: Number(entry?.processor?.tickCount) || 0,
      }))
      if (last?.processorRequired === true) {
        console.log(`[Prod Init] Direct-Trade processor leases are healthy: ${ticks.map((entry) => `${entry.connectionId}=${entry.tickCount}`).join(", ")}`)
      } else {
        console.log("[Prod Init] Direct-Trade processor lease is not currently required")
      }
      return {
        healthy: true,
        required: last?.processorRequired === true,
        connections: ticks,
      }
    }
    if (attempt < maxAttempts) await sleep(1_000)
  }
  const compact = {
    required: last?.processorRequired === true,
    healthy: last?.processorHealthy === true,
    connections: Array.isArray(last?.connections)
      ? last.connections
        .filter((entry) => entry?.required === true)
        .map((entry) => ({
          connectionId: String(entry?.connectionId || "unknown"),
          healthy: entry?.healthy === true,
          openPositions: Number(entry?.openPositions) || 0,
          lastTick: entry?.processor?.lastTick || null,
          tickCount: Number(entry?.processor?.tickCount) || 0,
        }))
      : [],
  }
  throw new Error(`Direct-Trade processor did not publish a fresh leased heartbeat: ${JSON.stringify(compact)}`)
}

async function verifyProdVstMainEngine(liveTrade, maxAttempts = 45) {
  // X02 is the installer-default execution target because it is explicitly
  // BingX Prod-VST.  Readiness alone proves that credentials *could* place an
  // order; this verifies that the queued, durable Main Trade owner actually
  // consumed the start request and began publishing a runtime heartbeat.
  if (!liveTrade?.connectionIds?.includes("bingx-x02")) {
    return { verified: false, skipped: "BingX X02 Prod-VST credentials are not configured" }
  }

  let last = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await request("/api/connections/bingx-x02/engine-states", { timeoutMs: 30_000 })
    const main = last?.modes?.mainTrade
    if (
      last?.success === true &&
      last?.enabled?.flag === true &&
      main?.effective === true &&
      last?.engineRunning === true &&
      last?.runtimeEvidence?.heartbeatFresh === true
    ) {
      console.log("[Prod Init] BingX X02 Prod-VST Main Trade owner is running with a fresh heartbeat")
      return { verified: true, connectionId: "bingx-x02", heartbeatAt: last.runtimeEvidence.heartbeatAt }
    }
    if (attempt < maxAttempts) await sleep(1_000)
  }
  throw new Error(
    `BingX X02 Prod-VST Main Trade engine did not start after credential injection: ${JSON.stringify(last)}`,
  )
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
  await injectCredentials()
  const readiness = await waitForReadiness()
  await injectCredentials()
  const core = await verifyCoreApis()
  const liveTrade = await verifyLiveTradeReadiness()
  const directTradeProcessor = await verifyDirectTradeProcessor()
  const vstMainEngine = await verifyProdVstMainEngine(liveTrade)
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
    liveTradeReady: liveTrade.connectionIds,
    vstMainEngine,
    directTradeProcessor,
    connectionCount: core.connectionCount,
    durationMs: Date.now() - startedAt,
  }, null, 2))
}

main().catch((error) => {
  console.error(`[Prod Init] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
