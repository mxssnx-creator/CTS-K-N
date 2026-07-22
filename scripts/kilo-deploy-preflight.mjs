#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs"
import process from "node:process"

const REQUIRED_SCHEMA_VERSION = 82
const failures = []
const checks = []

function pass(message) {
  checks.push(message)
  console.log(`[Kilo Preflight] PASS ${message}`)
}

function fail(message) {
  failures.push(message)
  console.error(`[Kilo Preflight] FAIL ${message}`)
}

function assert(condition, message) {
  if (condition) pass(message)
  else fail(message)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function configuredSecret(value) {
  const normalized = String(value || "").trim()
  return normalized.length >= 16 && !/^(?:replace|change|your)[_-]?/i.test(normalized)
}

function validateRuntimeEnvironment() {
  const sharedRedis = Boolean(
    process.env.REDIS_URL ||
      process.env.KV_URL ||
      (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
      (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
  )
  const managedSnapshot = Boolean(
    (process.env.DB_URL && process.env.DB_TOKEN) ||
    (process.env.KILO_DB_URL && process.env.KILO_DB_TOKEN) ||
    (process.env.KILO_DATABASE_URL && process.env.KILO_DATABASE_TOKEN),
  )
  const paperFallback = process.env.ALLOW_PROD_INLINE_REDIS !== "0" && process.env.ALLOW_INLINE_REDIS_LIVE_TRADING !== "1"
  assert(
    sharedRedis || managedSnapshot || paperFallback,
    "shared Redis, Kilo managed persistence, or an explicitly non-live paper fallback is configured",
  )
  assert(configuredSecret(process.env.ADMIN_SECRET), "ADMIN_SECRET is configured")
  assert(configuredSecret(process.env.CRON_SECRET), "CRON_SECRET is configured")
  assert(configuredSecret(process.env.ENCRYPTION_KEY), "ENCRYPTION_KEY is configured")
  assert(configuredSecret(process.env.JWT_SECRET), "JWT_SECRET is configured")
  const appUrl = String(process.env.NEXT_PUBLIC_APP_URL || process.env.DEPLOYMENT_URL || "")
  assert(/^https:\/\//i.test(appUrl), "the public HTTPS deployment URL is configured")

  if (process.env.KILO_REQUIRE_REMOTE_INSTALL_OWNER === "1") {
    const ownerUrl = String(process.env.REMOTE_INSTALL_OWNER_URL || "")
    let secureOwner = false
    try {
      const owner = new URL(ownerUrl)
      const app = new URL(appUrl)
      secureOwner = owner.protocol === "https:" && !owner.username && !owner.password && owner.origin !== app.origin
    } catch { /* asserted below */ }
    assert(secureOwner, "a distinct HTTPS long-lived remote-install owner is configured")
    assert(configuredSecret(process.env.REMOTE_INSTALL_OWNER_SECRET), "REMOTE_INSTALL_OWNER_SECRET is configured")
  }

  if (process.env.KILO_REQUIRE_DEPLOY_CREDENTIALS === "1") {
    assert(configuredSecret(process.env.CLOUDFLARE_API_TOKEN), "CLOUDFLARE_API_TOKEN is configured")
    assert(/^[a-f0-9]{32}$/i.test(String(process.env.CLOUDFLARE_ACCOUNT_ID || "")), "CLOUDFLARE_ACCOUNT_ID is configured")
  }
}

function main() {
  const nodeMajor = Number(process.versions.node.split(".")[0])
  assert(nodeMajor >= 20, "Node.js 20 or newer is active")
  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "open-next.config.ts",
    "wrangler.jsonc",
    "custom-worker.ts",
    "scripts/post-deploy-verify.sh",
    "scripts/kilo-deploy.mjs",
    "scripts/verify-deployment-contract.mjs",
  ]) {
    assert(existsSync(file), `${file} exists`)
  }

  const pkg = readJson("package.json")
  assert(pkg.packageManager === "pnpm@10.28.1", "pnpm is pinned to 10.28.1")
  assert(!existsSync("bun.lock") && !existsSync("bun.lockb"), "no competing Bun lockfile can override pnpm")
  assert(pkg.dependencies?.["@opennextjs/cloudflare"] === "1.20.1", "OpenNext Cloudflare adapter is pinned")
  assert(pkg.devDependencies?.wrangler === "4.86.0", "Wrangler is pinned")

  const wrangler = readJson("wrangler.jsonc")
  assert(wrangler.name === "cts-k-n", "Cloudflare worker has the canonical CTS-K-N name")
  assert(wrangler.main === "./custom-worker.ts", "custom worker is the deployment entrypoint")
  assert(wrangler.compatibility_flags?.includes("nodejs_compat"), "nodejs_compat is enabled")
  assert(new Date(wrangler.compatibility_date) >= new Date("2024-09-23"), "compatibility date supports OpenNext")
  assert(wrangler.assets?.directory === ".open-next/assets", "OpenNext assets binding is configured")
  assert(wrangler.triggers?.crons?.includes("* * * * *"), "one-minute Cron Trigger is configured")
  assert(wrangler.vars?.DISABLE_IN_PROCESS_CONTINUITY === "1", "request-worker continuity ownership is disabled")
  assert(wrangler.vars?.DISABLE_TRADE_ENGINE_IN_PROCESS === "1", "request-worker engine ownership is disabled")
  assert(
    wrangler.vars?.ALLOW_PROD_INLINE_REDIS === "1",
    "Kilo paper/UI fallback is enabled while real-order fallback remains blocked",
  )
  assert(
    wrangler.vars?.KILO_LOCAL_PREVIEW_INLINE_REDIS === undefined,
    "local Inline Redis preview override is not shipped to production",
  )
  assert(wrangler.secrets?.required?.includes("ADMIN_SECRET"), "ADMIN_SECRET is a required Worker secret")
  assert(wrangler.secrets?.required?.includes("CRON_SECRET"), "CRON_SECRET is a required Worker secret")
  assert(wrangler.secrets?.required?.includes("ENCRYPTION_KEY"), "ENCRYPTION_KEY is a required Worker secret")
  assert(wrangler.secrets?.required?.includes("JWT_SECRET"), "JWT_SECRET is a required Worker secret")

  const worker = readFileSync("custom-worker.ts", "utf8")
  assert(worker.includes("async scheduled"), "custom worker exports a scheduled handler")
  assert(worker.includes("/api/cron/server-continuity"), "scheduled handler invokes server continuity")
  assert(worker.includes("/api/cron/sync-live-positions"), "scheduled handler invokes live-position recovery")
  assert(worker.includes("CRON_SECRET"), "scheduled handler authenticates cron requests")
  const openNextConfig = readFileSync("open-next.config.ts", "utf8")
  assert(openNextConfig.includes('buildCommand: "node scripts/build-next-with-trace-retry.mjs"'), "OpenNext uses the trace-validating Next build wrapper")
  const traceBuildWrapper = readFileSync("scripts/build-next-with-trace-retry.mjs", "utf8")
  assert(traceBuildWrapper.includes('"pnpm@10.28.1"'), "trace-validating Next build is pinned through Corepack")

  const migrations = readFileSync("lib/redis-migrations.ts", "utf8")
  const versions = Array.from(migrations.matchAll(/\bversion:\s*(\d+)\s*,/g), (match) => Number(match[1]))
  assert(Math.max(0, ...versions) === REQUIRED_SCHEMA_VERSION, `repository schema is v${REQUIRED_SCHEMA_VERSION}`)

  if (process.env.KILO_REQUIRE_RUNTIME_ENV === "1") validateRuntimeEnvironment()
  else pass("runtime-secret validation is deferred to Kilo runtime and post-deploy verification")

  if (failures.length > 0) {
    throw new Error(`${failures.length} Kilo deployment preflight check(s) failed`)
  }
  console.log(JSON.stringify({ success: true, checks: checks.length, schemaVersion: REQUIRED_SCHEMA_VERSION }))
}

try {
  main()
} catch (error) {
  console.error(`[Kilo Preflight] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
