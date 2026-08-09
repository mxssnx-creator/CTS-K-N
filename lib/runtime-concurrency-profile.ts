/**
 * Runtime-aware defaults for the single authoritative Node engine owner.
 *
 * Promise concurrency overlaps I/O, but it does not execute JavaScript on
 * additional CPU cores. The profile therefore reserves capacity for health,
 * Redis, settings and live-order control, and opens only conservative
 * calculation lanes by default. Existing environment variables remain the
 * explicit override for a host-specific benchmark.
 */

import { availableParallelism, freemem, loadavg, totalmem } from "node:os"

export interface RuntimeConcurrencyProfile {
  cpuCount: number
  cpuSource: "env" | "availableParallelism" | "fallback"
  symbolConcurrency: number
  historicSymbolConcurrency: number
  calculationConcurrency: number
  indicationTypeConcurrency: number
  ioConcurrency: number
  load1m: number
  memoryTotalMB: number
  memoryFreeMB: number
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : null
}

function bounded(value: number, minimum: number, maximum: number, itemCount = Number.POSITIVE_INFINITY): number {
  const itemLimit = Number.isFinite(itemCount) ? Math.max(1, Math.floor(itemCount)) : maximum
  return Math.max(minimum, Math.min(maximum, itemLimit, Math.floor(value)))
}

/** Return the CPU count available to this process/container, not os.cpus(). */
export function getRuntimeCpuCount(env: NodeJS.ProcessEnv = process.env): {
  count: number
  source: RuntimeConcurrencyProfile["cpuSource"]
} {
  const configured = positiveInteger(env.CTS_CPU_COUNT)
  if (configured) return { count: configured, source: "env" }
  try {
    const detected = positiveInteger(availableParallelism())
    if (detected) return { count: detected, source: "availableParallelism" }
  } catch {
    // Older/embedded runtimes may not expose uv_available_parallelism().
  }
  return { count: 1, source: "fallback" }
}

/**
 * Build one snapshot used by installer/runtime diagnostics and pool defaults.
 * The divisor intentionally preserves control-plane headroom: 9 CPUs -> 2
 * default lanes, matching the measured fastest CTS profile.
 */
export function getRuntimeConcurrencyProfile(
  itemCount = Number.POSITIVE_INFINITY,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConcurrencyProfile {
  const cpu = getRuntimeCpuCount(env)
  const adaptiveLanes = bounded((cpu.count + 1) / 4, 1, 4, itemCount)
  const memoryTotalMB = Math.max(0, Math.round(totalmem() / 1024 / 1024))
  const memoryFreeMB = Math.max(0, Math.round(freemem() / 1024 / 1024))
  const load = Number(loadavg()[0])
  return {
    cpuCount: cpu.count,
    cpuSource: cpu.source,
    symbolConcurrency: adaptiveLanes,
    historicSymbolConcurrency: adaptiveLanes,
    calculationConcurrency: adaptiveLanes,
    indicationTypeConcurrency: bounded(Math.min(2, adaptiveLanes), 1, 2, itemCount),
    ioConcurrency: Math.max(4, Math.min(32, cpu.count * 2)),
    load1m: Number.isFinite(load) && load >= 0 ? Math.round(load * 100) / 100 : 0,
    memoryTotalMB,
    memoryFreeMB,
  }
}
