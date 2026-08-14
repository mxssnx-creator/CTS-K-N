#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const rawBaseUrl = process.argv[2] || process.env.DEPLOYMENT_URL || process.env.VERCEL_URL || process.env.NEXT_PUBLIC_APP_URL || ""
if (!rawBaseUrl) {
  console.error("[Deployment Contract] Missing deployment URL")
  process.exit(1)
}

const baseUrl = /^https?:\/\//.test(rawBaseUrl) ? rawBaseUrl.replace(/\/$/, "") : `https://${rawBaseUrl.replace(/\/$/, "")}`
const migrationSource = readFileSync(
  fileURLToPath(new URL("../lib/redis-migrations.ts", import.meta.url)),
  "utf8",
)
const migrationVersions = Array.from(migrationSource.matchAll(/\bversion:\s*(\d+)\s*,/g), (match) => Number(match[1]))
const expectedSchemaVersion = Math.max(0, ...migrationVersions)
const cloudflareRuntime = ["cloudflare-workers", "kilo-deploy"].includes(
  String(process.env.CTS_DEPLOYMENT_RUNTIME || "").trim().toLowerCase(),
)
const requireSharedPersistence = process.env.REQUIRE_SHARED_PERSISTENCE === "1" || (
  cloudflareRuntime && process.env.ALLOW_PROCESS_LOCAL_DEPLOY_VERIFY !== "1"
)
const requireFreshContinuity = process.env.REQUIRE_FRESH_CONTINUITY === "1"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function readJson(pathname) {
  const response = await fetch(new URL(pathname, baseUrl), {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(Number(process.env.DEPLOY_VERIFY_TIMEOUT_MS || 30_000)),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${pathname} did not return JSON`)
  }
}

async function main() {
  assert(expectedSchemaVersion > 0, "Could not determine the repository schema version")

  const [init, database, persistence] = await Promise.all([
    readJson("/api/system/init-status"),
    readJson("/api/settings/database-status"),
    readJson("/api/persistence/status"),
  ])

  const currentSchema = Number(init?.migrations?.current_version)
  const deployedLatestSchema = Number(init?.migrations?.latest_version)
  assert(init?.ready === true, `startup is not ready (${String(init?.status || "unknown")})`)
  assert(Number.isFinite(currentSchema), "current migration version is missing")
  assert(currentSchema === deployedLatestSchema, `migrations are incomplete (${currentSchema}/${deployedLatestSchema})`)
  assert(
    currentSchema === expectedSchemaVersion,
    `deployed schema/build is stale (${currentSchema}; repository expects ${expectedSchemaVersion})`,
  )
  assert(Number(database?.schemaVersion) === expectedSchemaVersion, "database-status reports a different schema version")
  assert(typeof init?.database?.backend === "string", "deployment does not expose the current persistence diagnostics")
  assert(typeof database?.backend === "string", "database-status does not expose the current backend diagnostics")
  assert(typeof persistence?.persistence?.scope === "string", "persistence endpoint is from an outdated build")
  assert(Boolean(init?.system?.site_instance_id), "durable site identity is missing")

  if (requireSharedPersistence) {
    assert(init?.database?.shared === true, "init-status reports process-local persistence")
    assert(database?.isSharedConfigured === true, "shared Redis is not configured")
    assert(database?.isCrossInstanceDurable === true, "database is not cross-instance durable")
    assert(database?.liveOrderCoordinationReady === true, "live-order coordination gate is not ready")
    assert(persistence?.persistence?.cross_instance_durable === true, "persistence is not cross-instance durable")
    assert(persistence?.features?.live_order_coordination === true, "live-order persistence coordination is unavailable")
  }

  if (requireFreshContinuity) {
    assert(init?.system?.continuity?.last_tick_fresh === true, "server-continuity minute tick is stale")
    assert(init?.system?.continuity?.live_recovery?.last_tick_fresh === true, "live-recovery minute tick is stale")
  }

  console.log(JSON.stringify({
    success: true,
    baseUrl,
    schemaVersion: currentSchema,
    backend: init.database.backend,
    sharedPersistence: init.database.shared === true,
    requireSharedPersistence,
    requireFreshContinuity,
    siteInstanceId: init.system.site_instance_id,
  }, null, 2))
}

main().catch((error) => {
  console.error(`[Deployment Contract] FAIL: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
