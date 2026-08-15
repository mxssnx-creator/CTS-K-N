import { resolveRedisRuntimeRoot } from "./redis-runtime-root"

type RuntimeBootRoot = (typeof globalThis | NodeJS.Process) & {
  __cts_runtime_boot_id?: string
  __cts_runtime_started_at?: string
}

const runtimeBootRoot = resolveRedisRuntimeRoot() as RuntimeBootRoot

function safeBootToken(value: string): string {
  return value
    .trim()
    .slice(0, 160)
    .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
}

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

/**
 * Stable runtime identity shared by every Next.js worker in one server boot.
 *
 * The launchers set CTS_RUNTIME_BOOT_ID before spawning Next, so route workers
 * inherit the same value even though they have separate OS processes and VM
 * globals. Direct/custom launchers remain supported through a process-local
 * fallback; operators can set CTS_RUNTIME_BOOT_ID for the same cross-worker
 * guarantee in bespoke process managers.
 */
export function getRuntimeBootId(): string {
  const configured = safeBootToken(String(process.env.CTS_RUNTIME_BOOT_ID || ""))
  if (configured) return configured
  runtimeBootRoot.__cts_runtime_boot_id ||= createBootId()
  return runtimeBootRoot.__cts_runtime_boot_id
}

export function getRuntimeStartedAt(): string {
  const configured = String(process.env.CTS_RUNTIME_STARTED_AT || "").trim()
  if (configured && Number.isFinite(Date.parse(configured))) return configured
  runtimeBootRoot.__cts_runtime_started_at ||= new Date().toISOString()
  return runtimeBootRoot.__cts_runtime_started_at
}
