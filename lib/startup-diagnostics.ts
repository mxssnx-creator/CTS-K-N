import { getRedisBackend, getRedisClient, initRedis, type RedisBackend } from "@/lib/redis-db"

export const STARTUP_DIAGNOSTIC_KEYS = {
  phase: "startup:phase",
  lastSuccessAt: "startup:last_success_at",
  lastError: "startup:last_error",
  migrationStatus: "startup:migration_status",
  redisBackend: "startup:redis_backend",
  coverageRepairStatus: "startup:coverage_repair_status",
  instrumentationRegisteredAt: "startup:instrumentation_registered_at",
} as const

export type StartupPhase =
  | "instrumentation_registered"
  | "redis_initializing"
  | "redis_ready"
  | "migrations_running"
  | "migrations_complete"
  | "coverage_repair_running"
  | "coverage_repair_complete"
  | "startup_coordinator_running"
  | "startup_coordinator_complete"
  | "system_initialize_running"
  | "system_initialize_complete"
  | "auto_start_running"
  | "continuity_runner_started"
  | "ready"
  | "error"

export interface StartupDiagnosticsSnapshot {
  phase: string | null
  last_success_at: string | null
  last_error: string | null
  migration_status: Record<string, unknown> | null
  redis_backend: RedisBackend | string | null
  coverage_repair_status: Record<string, unknown> | null
  instrumentation_registered_at: string | null
  observed_at: string
}

function serialize(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

async function writeKey(key: string, value: unknown): Promise<void> {
  const client = getRedisClient()
  await client.set(key, serialize(value))
}

export async function recordStartupPhase(phase: StartupPhase | string, details?: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString()
  const value = details ? { phase, at: now, ...details } : phase
  await writeKey(STARTUP_DIAGNOSTIC_KEYS.phase, value)
  await writeKey(STARTUP_DIAGNOSTIC_KEYS.lastSuccessAt, now)
}

export async function recordStartupError(error: unknown, phase?: string): Promise<void> {
  const now = new Date().toISOString()
  await writeKey(STARTUP_DIAGNOSTIC_KEYS.phase, "error")
  await writeKey(STARTUP_DIAGNOSTIC_KEYS.lastError, {
    phase: phase || null,
    at: now,
    message: error instanceof Error ? error.message : String(error),
  })
}

export async function recordInstrumentationRegistered(): Promise<void> {
  const now = new Date().toISOString()
  await writeKey(STARTUP_DIAGNOSTIC_KEYS.instrumentationRegisteredAt, now)
  await recordStartupPhase("instrumentation_registered")
}

export async function recordRedisBackend(backend: RedisBackend | string = getRedisBackend()): Promise<void> {
  await writeKey(STARTUP_DIAGNOSTIC_KEYS.redisBackend, backend)
}

export async function recordMigrationStatus(status: Record<string, unknown>): Promise<void> {
  await writeKey(STARTUP_DIAGNOSTIC_KEYS.migrationStatus, { ...status, recorded_at: new Date().toISOString() })
}

export async function recordCoverageRepairStatus(status: Record<string, unknown>): Promise<void> {
  await writeKey(STARTUP_DIAGNOSTIC_KEYS.coverageRepairStatus, { ...status, recorded_at: new Date().toISOString() })
}

function parseMaybeJson(raw: string | null): any {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return raw }
}

export async function getStartupDiagnostics(): Promise<StartupDiagnosticsSnapshot> {
  await initRedis()
  const client = getRedisClient()
  const [phase, lastSuccessAt, lastError, migrationStatus, redisBackend, coverageRepairStatus, instrumentationRegisteredAt] =
    await client.mget(
      STARTUP_DIAGNOSTIC_KEYS.phase,
      STARTUP_DIAGNOSTIC_KEYS.lastSuccessAt,
      STARTUP_DIAGNOSTIC_KEYS.lastError,
      STARTUP_DIAGNOSTIC_KEYS.migrationStatus,
      STARTUP_DIAGNOSTIC_KEYS.redisBackend,
      STARTUP_DIAGNOSTIC_KEYS.coverageRepairStatus,
      STARTUP_DIAGNOSTIC_KEYS.instrumentationRegisteredAt,
    )

  return {
    phase: parseMaybeJson(phase),
    last_success_at: lastSuccessAt,
    last_error: parseMaybeJson(lastError),
    migration_status: parseMaybeJson(migrationStatus),
    redis_backend: redisBackend || getRedisBackend(),
    coverage_repair_status: parseMaybeJson(coverageRepairStatus),
    instrumentation_registered_at: instrumentationRegisteredAt,
    observed_at: new Date().toISOString(),
  }
}
