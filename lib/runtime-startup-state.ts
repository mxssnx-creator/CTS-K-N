import { getRedisClient } from "@/lib/redis-db"
import { getDeploymentRuntimeLabel, isServerlessDeploymentRuntime } from "@/lib/deployment-runtime"

type RuntimeStartupStatus = "starting" | "ready" | "error"

type StartupRuntimeGlobal = typeof globalThis & {
  __cts_runtime_boot_id?: string
}

const runtimeGlobal = globalThis as StartupRuntimeGlobal

function createBootId(): string {
  const suffix = (() => {
    try {
      return globalThis.crypto?.randomUUID?.().slice(0, 12)
    } catch {
      return undefined
    }
  })() || Math.random().toString(36).slice(2, 14)
  return `boot_${Date.now()}_${process.pid}_${suffix}`
}

export function getRuntimeBootId(): string {
  runtimeGlobal.__cts_runtime_boot_id ||= createBootId()
  return runtimeGlobal.__cts_runtime_boot_id
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
  await persistStartupState("starting", source, { started_at: new Date().toISOString() })
}

export async function markRuntimeStartupReady(source: string): Promise<void> {
  await persistStartupState("ready", source)
}

export async function markRuntimeStartupFailed(source: string, error: unknown): Promise<void> {
  await persistStartupState("error", source, {
    failed_at: new Date().toISOString(),
    last_error: error instanceof Error ? error.message : String(error),
  })
}
