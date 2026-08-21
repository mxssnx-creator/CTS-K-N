/**
 * Runtime-aware defaults for the single authoritative Node engine owner.
 *
 * Promise concurrency overlaps I/O, but it does not execute JavaScript on
 * additional CPU cores. The profile therefore reserves capacity for health,
 * Redis, settings and live-order control, and opens only conservative
 * calculation lanes by default. Existing environment variables remain the
 * explicit override for a host-specific benchmark.
 */

import { readFileSync } from "node:fs"
import { availableParallelism, freemem, loadavg, totalmem } from "node:os"

export type ProcessingCapability = "control" | "cpu" | "mixed" | "io"
export type RuntimePressureLevel = "healthy" | "elevated" | "high" | "critical"

export interface RuntimePressureInput {
  load1m?: number
  memoryTotalMB?: number
  memoryFreeMB?: number
  rssMB?: number
  rssSoftLimitMB?: number
  eventLoopUtilizationPct?: number
  eventLoopDelayP95Ms?: number
}

export interface RuntimeConcurrencyProfile {
  cpuCount: number
  cpuSource: "env" | "availableParallelism" | "fallback"
  symbolConcurrency: number
  historicSymbolConcurrency: number
  calculationConcurrency: number
  indicationTypeConcurrency: number
  ioConcurrency: number
  capabilityConcurrency: Record<ProcessingCapability, number>
  pressureLevel: RuntimePressureLevel
  pressureScore: number
  pressureReasons: string[]
  load1m: number
  memoryTotalMB: number
  memoryFreeMB: number
  processRssMB: number
  rssSoftLimitMB: number
}

export interface RuntimeMemoryBudgetInput {
  hostTotalMB?: number
  hostFreeMB?: number
  cgroupLimitMB?: number
  cgroupUsedMB?: number
}

export interface RuntimeMemoryBudget {
  totalMB: number
  freeMB: number
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : null
}

function bounded(value: number, minimum: number, maximum: number, itemCount = Number.POSITIVE_INFINITY): number {
  const itemLimit = Number.isFinite(itemCount) ? Math.max(1, Math.floor(itemCount)) : maximum
  return Math.max(minimum, Math.min(maximum, itemLimit, Math.floor(value)))
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function finitePositive(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function readCgroupMemoryMb(filenames: string[]): number | null {
  for (const filename of filenames) {
    try {
      const raw = readFileSync(filename, "utf8").trim()
      // cgroup v2 reports `max` for an unlimited container; cgroup v1 can
      // expose a near-MAX_INT sentinel for the same condition.
      if (!raw || raw === "max") continue
      const bytes = finitePositive(raw)
      if (bytes > 0 && bytes < 2 ** 60) return bytes / 1024 / 1024
    } catch {
      // The next cgroup version/path or host metric remains available.
    }
  }
  return null
}

/**
 * Resolve the memory budget visible to this process rather than the host.
 *
 * `os.totalmem()` and `os.freemem()` frequently report the physical host from
 * inside a container.  Treating those values as the engine budget lets a
 * 4–8 GiB service keep every lane open even though its cgroup is about to
 * OOM-kill it.  This helper makes the adaptive profile use the same service
 * and cgroup ceiling as the Strategy admission guard.
 */
export function resolveRuntimeMemoryBudget(
  env: NodeJS.ProcessEnv = process.env,
  observed: RuntimeMemoryBudgetInput = {},
): RuntimeMemoryBudget {
  const hostTotalMB = finitePositive(observed.hostTotalMB) ||
    Math.max(0, totalmem() / 1024 / 1024)
  const hostFreeMB = finiteNonNegative(
    observed.hostFreeMB,
    Math.max(0, freemem() / 1024 / 1024),
  )
  const cgroupLimitMB = finitePositive(observed.cgroupLimitMB) || readCgroupMemoryMb([
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  ]) || 0
  const observedCgroupUsed = observed.cgroupUsedMB
  const cgroupUsedMB = observedCgroupUsed === undefined
    ? readCgroupMemoryMb([
      "/sys/fs/cgroup/memory.current",
      "/sys/fs/cgroup/memory/memory.usage_in_bytes",
    ])
    : finiteNonNegative(observedCgroupUsed)
  const serviceLimitMB = finitePositive(env.CTS_RUNTIME_MEMORY_MAX_MB) ||
    finitePositive(env.CTS_MEMORY_LIMIT_MB)

  const totalCandidates = [hostTotalMB, cgroupLimitMB, serviceLimitMB]
    .filter((value) => value > 0)
  const totalMB = Math.max(0, Math.floor(
    totalCandidates.length > 0 ? Math.min(...totalCandidates) : hostTotalMB,
  ))

  const freeCandidates = [hostFreeMB]
  if (cgroupLimitMB > 0 && cgroupUsedMB !== null) {
    freeCandidates.push(Math.max(0, cgroupLimitMB - cgroupUsedMB))
  }
  const freeMB = Math.max(0, Math.floor(Math.min(
    totalMB || Number.POSITIVE_INFINITY,
    ...freeCandidates.filter((value) => Number.isFinite(value) && value >= 0),
  )))

  return { totalMB, freeMB }
}

function readProcessRssMB(): number {
  try {
    return finiteNonNegative(process.memoryUsage().rss / 1024 / 1024)
  } catch {
    return 0
  }
}

function readRedisRssSoftLimitMB(env: NodeJS.ProcessEnv): number {
  const configured = finiteNonNegative(env.CTS_RSS_SOFT_LIMIT_MB)
  if (configured > 0) return configured
  // Linux installs always persist both values, but the production service
  // high-water mark is the correct fallback for older/smaller deployments.
  // Without it an otherwise constrained worker reports RSS pressure as zero
  // and keeps its CPU lanes fully open until the kernel intervenes.
  const runtimeHigh = finiteNonNegative(env.CTS_RUNTIME_MEMORY_HIGH_MB)
  if (runtimeHigh > 0) return runtimeHigh
  try {
    const limits = (globalThis as typeof globalThis & {
      __redis_mem_limits?: { rssSoftMB?: number }
    }).__redis_mem_limits
    return finiteNonNegative(limits?.rssSoftMB)
  } catch {
    return 0
  }
}

function classifyPressure(
  cpuCount: number,
  metrics: Required<RuntimePressureInput>,
  adaptiveEnabled: boolean,
): { score: number; level: RuntimePressureLevel; reasons: string[] } {
  if (!adaptiveEnabled) return { score: 0, level: "healthy", reasons: [] }

  let score = 0
  const reasons: string[] = []
  const add = (points: number, reason: string) => {
    score += points
    reasons.push(reason)
  }

  const loadRatio = cpuCount > 0 ? metrics.load1m / cpuCount : 0
  if (loadRatio >= 1.5) add(3, "cpu_load_critical")
  else if (loadRatio >= 1) add(2, "cpu_load_high")
  else if (loadRatio >= 0.75) add(1, "cpu_load_elevated")

  const freeRatio = metrics.memoryTotalMB > 0
    ? metrics.memoryFreeMB / metrics.memoryTotalMB
    : 1
  if (freeRatio <= 0.05) add(3, "system_memory_critical")
  else if (freeRatio <= 0.1) add(2, "system_memory_high")
  else if (freeRatio <= 0.2) add(1, "system_memory_elevated")

  const rssRatio = metrics.rssSoftLimitMB > 0
    ? metrics.rssMB / metrics.rssSoftLimitMB
    : 0
  if (rssRatio >= 0.95) add(3, "process_rss_critical")
  else if (rssRatio >= 0.8) add(2, "process_rss_high")
  else if (rssRatio >= 0.65) add(1, "process_rss_elevated")

  if (metrics.eventLoopUtilizationPct >= 95) add(3, "event_loop_utilization_critical")
  else if (metrics.eventLoopUtilizationPct >= 85) add(2, "event_loop_utilization_high")
  else if (metrics.eventLoopUtilizationPct >= 70) add(1, "event_loop_utilization_elevated")

  if (metrics.eventLoopDelayP95Ms >= 250) add(3, "event_loop_delay_critical")
  else if (metrics.eventLoopDelayP95Ms >= 100) add(2, "event_loop_delay_high")
  else if (metrics.eventLoopDelayP95Ms >= 50) add(1, "event_loop_delay_elevated")

  const level: RuntimePressureLevel = score >= 6
    ? "critical"
    : score >= 4
      ? "high"
      : score >= 2
        ? "elevated"
        : "healthy"
  return { score, level, reasons }
}

function reduceCpuLanes(base: number, pressure: RuntimePressureLevel): number {
  if (pressure === "critical") return 1
  if (pressure === "high") return Math.max(1, Math.ceil(base / 2))
  if (pressure === "elevated") return Math.max(1, base - 1)
  return base
}

function reduceIoLanes(base: number, pressure: RuntimePressureLevel): number {
  if (pressure === "critical") return Math.max(2, Math.ceil(base / 4))
  if (pressure === "high") return Math.max(2, Math.ceil(base / 2))
  if (pressure === "elevated") return Math.max(2, Math.ceil(base * 0.75))
  return base
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
  pressureInput: RuntimePressureInput = {},
): RuntimeConcurrencyProfile {
  const cpu = getRuntimeCpuCount(env)
  const baseCpuLanes = bounded((cpu.count + 1) / 4, 1, 4, itemCount)
  const detectedMemory = resolveRuntimeMemoryBudget(env)
  const detectedMemoryTotalMB = detectedMemory.totalMB
  const detectedMemoryFreeMB = detectedMemory.freeMB
  const detectedLoad = Number(loadavg()[0])
  const memoryTotalMB = finiteNonNegative(pressureInput.memoryTotalMB, detectedMemoryTotalMB)
  const memoryFreeMB = finiteNonNegative(pressureInput.memoryFreeMB, detectedMemoryFreeMB)
  const load = finiteNonNegative(pressureInput.load1m, finiteNonNegative(detectedLoad))
  const processRssMB = finiteNonNegative(pressureInput.rssMB, readProcessRssMB())
  const rssSoftLimitMB = finiteNonNegative(
    pressureInput.rssSoftLimitMB,
    readRedisRssSoftLimitMB(env),
  )
  const metrics: Required<RuntimePressureInput> = {
    load1m: load,
    memoryTotalMB,
    memoryFreeMB,
    rssMB: processRssMB,
    rssSoftLimitMB,
    eventLoopUtilizationPct: finiteNonNegative(pressureInput.eventLoopUtilizationPct),
    eventLoopDelayP95Ms: finiteNonNegative(pressureInput.eventLoopDelayP95Ms),
  }
  const adaptiveEnabled = env.CTS_ADAPTIVE_CONCURRENCY !== "0"
  const pressure = classifyPressure(cpu.count, metrics, adaptiveEnabled)
  const adaptiveLanes = bounded(
    reduceCpuLanes(baseCpuLanes, pressure.level),
    1,
    4,
    itemCount,
  )
  const baseIoConcurrency = Math.max(4, Math.min(32, cpu.count * 2))
  // I/O is a host-wide budget shared by nested persistence/read groups. It is
  // intentionally not capped by the outer CPU item count (for example, two
  // symbols can still safely pipeline more than two independent Redis writes).
  const ioConcurrency = Math.max(
    1,
    Math.min(32, Math.floor(reduceIoLanes(baseIoConcurrency, pressure.level))),
  )
  const mixedConcurrency = bounded(
    pressure.level === "healthy" && cpu.count >= 8
      ? adaptiveLanes + 1
      : adaptiveLanes,
    1,
    6,
    itemCount,
  )
  const controlConcurrency = bounded(
    pressure.level === "critical" ? 1 : Math.min(2, Math.max(1, cpu.count)),
    1,
    2,
    itemCount,
  )
  return {
    cpuCount: cpu.count,
    cpuSource: cpu.source,
    symbolConcurrency: adaptiveLanes,
    historicSymbolConcurrency: adaptiveLanes,
    calculationConcurrency: adaptiveLanes,
    indicationTypeConcurrency: bounded(Math.min(2, adaptiveLanes), 1, 2, itemCount),
    ioConcurrency,
    capabilityConcurrency: {
      control: controlConcurrency,
      cpu: adaptiveLanes,
      mixed: mixedConcurrency,
      io: ioConcurrency,
    },
    pressureLevel: pressure.level,
    pressureScore: pressure.score,
    pressureReasons: pressure.reasons,
    load1m: Number.isFinite(load) && load >= 0 ? Math.round(load * 100) / 100 : 0,
    memoryTotalMB,
    memoryFreeMB,
    processRssMB: Math.round(processRssMB * 10) / 10,
    rssSoftLimitMB: Math.round(rssSoftLimitMB * 10) / 10,
  }
}

/** Resolve the current lane count for one work capability. Re-sample between batches. */
export function getRuntimeCapabilityConcurrency(
  capability: ProcessingCapability,
  itemCount = Number.POSITIVE_INFINITY,
  env: NodeJS.ProcessEnv = process.env,
  pressureInput: RuntimePressureInput = {},
): number {
  return getRuntimeConcurrencyProfile(itemCount, env, pressureInput)
    .capabilityConcurrency[capability]
}
