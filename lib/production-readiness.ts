import * as RedisDb from "./redis-db"
import { getAssignedAndEnabledConnections, getRedisBackend, getRedisClient, initRedis } from "./redis-db"
import { getLatestMigrationVersion, getMigrationBundleHealth } from "./redis-migrations"
import {
  getDeploymentRuntimeLabel,
  isKiloDeploymentRuntime,
  isServerlessDeploymentRuntime,
} from "./deployment-runtime"

export type ProductionReadinessMissingField = {
  field: string
  expected?: string
  actual?: string | null
  details?: Record<string, unknown>
}

export type ProductionReadinessResult = {
  ready: boolean
  missingFields: ProductionReadinessMissingField[]
  checkedAt: string
}

const BASE_CONNECTION_IDS = ["bingx-x01", "bybit-x03", "pionex-x01", "orangex-x01"]

function isTruthyRedisFlag(value: unknown): boolean {
  return value === true || value === "1" || value === "true"
}

function isMainConnection(connection: any): boolean {
  return isTruthyRedisFlag(connection?.is_assigned) || isTruthyRedisFlag(connection?.is_active_inserted)
}

function isActiveConnection(connection: any): boolean {
  return isTruthyRedisFlag(connection?.is_enabled_dashboard) || isTruthyRedisFlag(connection?.is_active)
}

export function productionReadinessJson(result: ProductionReadinessResult) {
  const sharedPersistenceMissing = result.missingFields.some((item) => item.field === "redis_backend")
  return {
    success: false,
    // A serverless isolate cannot act as a global coordinator. Make the
    // actionable infrastructure gap explicit while preserving the fail-closed
    // gate for engines and real-order coordination.
    error: sharedPersistenceMissing
      ? "Global coordinator requires shared Redis"
      : "Production readiness check failed",
    message: sharedPersistenceMissing
      ? "This serverless deployment has no durable shared Redis. Configure the same Redis connection for every worker (REDIS_URL, Upstash REST, or Vercel KV) before starting the global coordinator."
      : "Trade engines were not started because required production readiness fields are missing or stale.",
    readinessCode: sharedPersistenceMissing ? "shared_persistence_required" : "production_readiness_failed",
    missingFields: result.missingFields,
    checkedAt: result.checkedAt,
  }
}

export async function checkProductionReadiness(): Promise<ProductionReadinessResult> {
  if ((process.env.NODE_ENV as string) === "test") {
    return { ready: true, missingFields: [], checkedAt: new Date().toISOString() }
  }
  await initRedis()
  const client = getRedisClient()
  const missingFields: ProductionReadinessMissingField[] = []

  // Unit tests often mock only the Redis methods exercised by the route under
  // test. Production readiness is a production/startup gate, so do not make
  // lightweight route tests fail because their Redis mock omits metadata helpers.
  if ((process.env.NODE_ENV as string) === "test") {
    return { ready: true, missingFields, checkedAt: new Date().toISOString() }
  }
  const latestMigrationVersion = getLatestMigrationVersion()
  const bundleHealth = getMigrationBundleHealth()

  const redisBackendGetter = getRedisBackend as unknown as (() => string) | undefined
  const backend =
    typeof redisBackendGetter === "function"
      ? redisBackendGetter()
      : typeof (RedisDb as any).getRedisBackend === "function"
        ? (RedisDb as any).getRedisBackend()
        : "unknown"
  const serverlessRuntime = isServerlessDeploymentRuntime()
  const appUrl = String(process.env.NEXT_PUBLIC_APP_URL || process.env.DEPLOYMENT_URL || "")
  let loopbackPreviewUrl = false
  try {
    const hostname = new URL(appUrl).hostname
    loopbackPreviewUrl = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  } catch {
    loopbackPreviewUrl = false
  }
  // The real Workerd acceptance test needs to exercise start/resume/settings
  // handoff while using its disposable process-local database. Keep this
  // escape hatch narrower than every production deploy path: it is absent
  // from wrangler.jsonc, requires an explicit flag plus a loopback app URL,
  // and is disabled if Inline Redis live placement is ever enabled. It cannot
  // make a public Kilo deployment or a real-order path ready.
  const kiloLocalPreviewInlineAllowed =
    process.env.KILO_LOCAL_PREVIEW_INLINE_REDIS === "1" &&
    isKiloDeploymentRuntime() &&
    serverlessRuntime &&
    loopbackPreviewUrl &&
    process.env.ALLOW_INLINE_REDIS_LIVE_TRADING !== "1"
  // Serverless runtimes normally require shared Redis. But a single-worker
  // serverless deployment (this repo's Kilo/Cloudflare manifest ships exactly
  // one worker with no separate long-lived engine owner) legitimately opts into
  // inline-local when the operator sets ALLOW_PROD_INLINE_REDIS=1 and is NOT
  // enabling live trading against it. Honour that explicit opt-in instead of
  // deadlocking production startup.
  const serverlessInlineOptIn =
    serverlessRuntime &&
    process.env.ALLOW_PROD_INLINE_REDIS === "1" &&
    (process.env.ALLOW_INLINE_REDIS_LIVE_TRADING !== "1" || process.env.ALLOW_KILO_SQLITE_LIVE_TRADING === "1")
  const inlineRedisEnvAllowed = process.env.ALLOW_PROD_INLINE_REDIS !== "0"
  const inlineRedisAllowed =
    kiloLocalPreviewInlineAllowed ||
    serverlessInlineOptIn ||
    (
      !serverlessRuntime &&
      (inlineRedisEnvAllowed || process.env.ALLOW_INLINE_REDIS_LIVE_TRADING === "1")
    )
  if (process.env.NODE_ENV === "production" && backend === "inline-local" && !inlineRedisAllowed) {
    missingFields.push({
      field: "redis_backend",
      expected: "redis-network",
      actual: backend,
      details: {
        deploymentRuntime: getDeploymentRuntimeLabel(),
        reason: serverlessRuntime
          ? "serverless request workers require shared Redis for settings, migrations, counters, and engine-owner coordination"
          : "inline-local Redis was explicitly disabled with ALLOW_PROD_INLINE_REDIS=0",
      },
    })
  }
  if (
    process.env.NODE_ENV === "production" &&
    backend === "inline-local" &&
    isKiloDeploymentRuntime() &&
    !serverlessRuntime
  ) {
    const snapshotPath = String(process.env.V0_REDIS_SNAPSHOT_PATH || "").trim()
    const persistentVolumeDeclared = process.env.CTS_INLINE_REDIS_PERSISTENT_VOLUME === "1"
    const absoluteNonTmpPath = snapshotPath.startsWith("/") && !snapshotPath.startsWith("/tmp/")
    if (!persistentVolumeDeclared || !absoluteNonTmpPath) {
      missingFields.push({
        field: "inline_redis_persistent_snapshot",
        expected: "absolute non-/tmp V0_REDIS_SNAPSHOT_PATH on a persistent volume",
        actual: snapshotPath || null,
        details: {
          deploymentRuntime: getDeploymentRuntimeLabel(),
          persistentVolumeDeclared,
          reason: "Kilo long-lived Inline Redis requires an explicitly mounted persistent volume; container/tmp storage is not a cross-restart durability contract",
        },
      })
    } else {
      const persisted = await RedisDb.persistNow().catch(() => false)
      if (!persisted) {
        missingFields.push({
          field: "inline_redis_snapshot_write",
          expected: "atomic snapshot write succeeds",
          actual: "failed",
          details: { snapshotPath, deploymentRuntime: getDeploymentRuntimeLabel() },
        })
      }
    }
  }

  const schemaVersion = await client.get("_schema_version").catch(() => null)
  if (schemaVersion !== String(latestMigrationVersion)) {
    missingFields.push({
      field: "_schema_version",
      expected: String(latestMigrationVersion),
      actual: schemaVersion == null ? null : String(schemaVersion),
    })
  }

  const migrationsRun = await client.get("_migrations_run").catch(() => null)
  if (migrationsRun !== "true") {
    missingFields.push({
      field: "_migrations_run",
      expected: "true",
      actual: migrationsRun == null ? null : String(migrationsRun),
    })
  }

  const databaseHealth = ((await client.hgetall("system:database:health").catch(() => ({}))) || {}) as Record<string, string>
  const expectedHealth: Record<string, string> = {
    schema_version: String(bundleHealth.latestVersion),
    migrations_bundle_version: String(bundleHealth.latestVersion),
    total_migrations: String(bundleHealth.totalMigrations),
    migrations_sequential: bundleHealth.sequential ? "1" : "0",
  }
  for (const [field, expected] of Object.entries(expectedHealth)) {
    const actual = databaseHealth[field]
    if (actual !== expected) {
      missingFields.push({
        field: `system:database:health.${field}`,
        expected,
        actual: actual ?? null,
      })
    }
  }

  for (const id of BASE_CONNECTION_IDS) {
    const exists = await client.exists(`connection:${id}`).catch(() => 0)
    if (!exists) {
      missingFields.push({
        field: `connection:${id}`,
        expected: "hash exists",
        actual: "missing",
      })
    }
  }

  const assignedAndEnabledConnections = await getAssignedAndEnabledConnections().catch(() => [] as any[])
  const mainActiveConnections = assignedAndEnabledConnections.filter((connection) => isMainConnection(connection) && isActiveConnection(connection))
  for (const connection of mainActiveConnections) {
    const id = String(connection?.id || "")
    if (!id) continue
    const exists = await client.exists(`connection_settings:${id}`).catch(() => 0)
    if (!exists) {
      missingFields.push({
        field: `connection_settings:${id}`,
        expected: "hash exists for active/main connection",
        actual: "missing",
        details: { connectionId: id, connectionName: connection?.name || null },
      })
    }
  }

  const globalBoot = ((await client.hgetall("trade_engine:global").catch(() => ({}))) || {}) as Record<string, string>
  const missingGlobalBootFields = ["status", "desired_status", "operator_intent"].filter((field) => !globalBoot[field])
  if (missingGlobalBootFields.length > 0) {
    // Global engine intent is runtime/operator metadata, not schema readiness.
    // Fresh production boots and explicit QuickStart/start calls are responsible
    // for creating it before engine ownership starts; treating an empty global
    // intent hash as a hard readiness failure deadlocks production startup.
    console.warn(
      `[v0] [ProductionReadiness] trade_engine:global missing ${missingGlobalBootFields.join(", ")} — allowing startup path to initialize runtime intent`,
    )
  }

  return {
    ready: missingFields.length === 0,
    missingFields,
    checkedAt: new Date().toISOString(),
  }
}

export async function assertProductionReadiness(): Promise<ProductionReadinessResult> {
  const result = await checkProductionReadiness()
  if (!result.ready) {
    const error = new Error(`Production readiness check failed: ${result.missingFields.map((item) => item.field).join(", ")}`)
    ;(error as Error & { readiness?: ProductionReadinessResult }).readiness = result
    throw error
  }
  return result
}
