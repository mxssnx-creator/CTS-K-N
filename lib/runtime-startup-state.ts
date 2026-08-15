import { getRedisClient } from "@/lib/redis-db"
import { getDeploymentRuntimeLabel, isServerlessDeploymentRuntime } from "@/lib/deployment-runtime"
import { getRuntimeBootId, getRuntimeStartedAt } from "@/lib/runtime-boot-id"

export { getRuntimeBootId, getRuntimeStartedAt } from "@/lib/runtime-boot-id"

type RuntimeStartupStatus = "starting" | "ready" | "error"

type StartupRuntimeGlobal = typeof globalThis & {
  __cts_runtime_lifecycle_recorded_boot_id?: string
}

const runtimeGlobal = globalThis as StartupRuntimeGlobal

async function recordRuntimeBootOnce(): Promise<void> {
  const bootId = getRuntimeBootId()
  if (runtimeGlobal.__cts_runtime_lifecycle_recorded_boot_id === bootId) return
  const client = getRedisClient()
  const claimed = await client.set(`system:runtime_lifecycle:boot:${bootId}`, "1", {
    NX: true,
    EX: 60 * 60 * 24 * 90,
  })
  runtimeGlobal.__cts_runtime_lifecycle_recorded_boot_id = bootId
  if (!claimed) return
  const previous = await client.hgetall("system:runtime_lifecycle").catch(() => ({})) as Record<string, string>
  const bootCount = await client.hincrby("system:runtime_lifecycle", "boot_count", 1)
  const restartCount = Math.max(0, bootCount - 1)
  await client.hset("system:runtime_lifecycle", {
    last_boot_id: bootId,
    previous_boot_id: previous.last_boot_id || "",
    last_started_at: getRuntimeStartedAt(),
    boot_count: String(bootCount),
    service_restart_count: String(restartCount),
    reload_count: String(restartCount),
    updated_at: new Date().toISOString(),
  })
}

export type RuntimeRecoveryKind = "self_heal" | "crash" | "startup_failure" | "problem"

export async function recordRuntimeRecoveryEvent(
  kind: RuntimeRecoveryKind,
  reason: unknown,
): Promise<void> {
  const client = getRedisClient()
  const now = new Date().toISOString()
  await Promise.all([
    client.hincrby("system:runtime_lifecycle", "recovery_count", 1),
    client.hincrby("system:runtime_lifecycle", `${kind}_count`, 1),
  ])
  await client.hset("system:runtime_lifecycle", {
    last_recovery_kind: kind,
    last_recovery_reason: reason instanceof Error ? reason.message : String(reason),
    last_recovery_at: now,
    updated_at: now,
  })
}

export function getContinuitySchedulerMode(): "external-minute" | "in-process-minute" {
  const external =
    process.env.DISABLE_IN_PROCESS_CONTINUITY === "1" ||
    isServerlessDeploymentRuntime()
  return external ? "external-minute" : "in-process-minute"
}

async function persistStartupState(
  status: RuntimeStartupStatus,
  source: string,
  extra: Record<string, string> = {},
): Promise<void> {
  const now = new Date().toISOString()
  const client = getRedisClient()
  const common = {
    status,
    boot_id: getRuntimeBootId(),
    source,
    runtime: process.env.NEXT_RUNTIME || "nodejs",
    deployment_runtime: getDeploymentRuntimeLabel(),
    node_env: process.env.NODE_ENV || "development",
    scheduler_mode: getContinuitySchedulerMode(),
    process_id: String(process.pid),
    updated_at: now,
    ...extra,
  }

  await client.hset("system:startup", common)
  if (status === "ready") {
    await Promise.all([
      client.hset("system:startup", {
        completed_at: now,
        instrumentation_boot_completed_at: now,
        last_error: "",
      }),
      client.set("system:startup:completed_at", now),
    ])
  }
}

export async function markRuntimeStartupStarting(source: string): Promise<void> {
  await recordRuntimeBootOnce()
  await persistStartupState("starting", source, { started_at: getRuntimeStartedAt() })
}

export async function markRuntimeStartupReady(source: string): Promise<void> {
  await persistStartupState("ready", source)
}

export async function markRuntimeStartupFailed(source: string, error: unknown): Promise<void> {
  await recordRuntimeRecoveryEvent("startup_failure", error).catch(() => {})
  await persistStartupState("error", source, {
    failed_at: new Date().toISOString(),
    last_error: error instanceof Error ? error.message : String(error),
  })
}
