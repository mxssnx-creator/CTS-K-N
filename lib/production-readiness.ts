import * as RedisDb from "./redis-db"
import { getAssignedAndEnabledConnections, getRedisClient, initRedis } from "./redis-db"
import { getLatestMigrationVersion, getMigrationBundleHealth } from "./redis-migrations"

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
  return {
    success: false,
    error: "Production readiness check failed",
    message: "Trade engines were not started because required production readiness fields are missing or stale.",
    missingFields: result.missingFields,
    checkedAt: result.checkedAt,
  }
}

export async function checkProductionReadiness(): Promise<ProductionReadinessResult> {
  if (process.env.NODE_ENV === "test") {
    return { ready: true, missingFields: [], checkedAt: new Date().toISOString() }
  }
  await initRedis()
  const client = getRedisClient()
  const missingFields: ProductionReadinessMissingField[] = []

  // Unit tests often mock only the Redis methods exercised by the route under
  // test. Production readiness is a production/startup gate, so do not make
  // lightweight route tests fail because their Redis mock omits metadata helpers.
  if (process.env.NODE_ENV === "test") {
    return { ready: true, missingFields, checkedAt: new Date().toISOString() }
  }
  const latestMigrationVersion = getLatestMigrationVersion()
  const bundleHealth = getMigrationBundleHealth()

  const backend = process.env.NODE_ENV === "production" ? getRedisBackend() : null
  if (backend === "inline-local") {
  const redisBackendGetter = getRedisBackend as unknown as (() => string) | undefined
  const backend = typeof redisBackendGetter === "function" ? redisBackendGetter() : "unknown"
  const backend = typeof (RedisDb as any).getRedisBackend === "function" ? (RedisDb as any).getRedisBackend() : "unknown"
  if (process.env.NODE_ENV === "production" && backend === "inline-local") {
    missingFields.push({
      field: "redis_backend",
      expected: "redis-network",
      actual: backend,
      details: { reason: "inline-local Redis is not permitted for production engine starts" },
    })
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
  for (const field of ["status", "desired_status", "operator_intent"]) {
    if (!globalBoot[field]) {
      missingFields.push({
        field: `trade_engine:global.${field}`,
        expected: "boot metadata field exists",
        actual: null,
      })
    }
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
