import { readFileSync } from "node:fs"
import { totalmem } from "node:os"

export interface StrategyMemoryGuardLimits {
  totalMemoryMb: number
  usableMemoryMb: number
  rssSoftMb: number
  rssHardMb: number
  rssEmergencyMb: number
  rssResumeMb: number
}

export type StrategyMemoryPressureLevel = "healthy" | "elevated" | "high" | "critical"

export interface StrategyMemoryPressureSnapshot extends StrategyMemoryGuardLimits {
  sampledAt: number
  rssMb: number
  heapUsedMb: number
  heapTotalMb: number
  externalMb: number
  arrayBuffersMb: number
  heapLimitMb: number
  rssRatio: number
  heapRatio: number
  level: StrategyMemoryPressureLevel
}

export interface StrategyMemoryCoordinationSnapshot {
  activeFlows: number
  queuedFlows: number
  maxActiveFlows: number
  throttleCount: number
  gcCount: number
  totalWaitMs: number
  peakRssMb: number
  lastGcAt: number
  lastGcDurationMs: number
  lastGcLevel: StrategyMemoryPressureLevel | "none"
  lastLabel: string
  lastPressure: StrategyMemoryPressureSnapshot
}

function finitePositive(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function cgroupMemoryLimitMb(): number | null {
  for (const filename of [
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  ]) {
    try {
      const raw = readFileSync(filename, "utf8").trim()
      if (!raw || raw === "max") continue
      const bytes = finitePositive(raw)
      // cgroup v1 uses a near-MAX_INT sentinel when no memory limit exists.
      if (bytes && bytes < 2 ** 60) return bytes / 1024 / 1024
    } catch {
      // The next supported cgroup path or host total remains available.
    }
  }
  return null
}

/**
 * Resolve the memory actually available to this Node runtime.
 *
 * `os.totalmem()` can expose the host total inside a constrained container, so
 * an explicit operator limit and cgroup limit take precedence whenever they
 * are smaller. The result is used only for throttling; V8's own heap ceiling
 * remains authoritative for allocation failure.
 */
export function detectRuntimeMemoryTotalMb(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const candidates = [
    // Linux installs set the application service's actual MemoryMax. It is a
    // stricter and more relevant boundary than the surrounding host/cgroup.
    finitePositive(env.CTS_RUNTIME_MEMORY_MAX_MB),
    finitePositive(env.CTS_MEMORY_LIMIT_MB),
    cgroupMemoryLimitMb(),
    finitePositive(totalmem() / 1024 / 1024),
  ].filter((value): value is number => value !== null && value >= 512)
  return Math.max(512, Math.floor(candidates.length > 0 ? Math.min(...candidates) : 4096))
}

/**
 * Keep Strategy allocation throttling aligned with Inline Redis' proportional
 * policy even when a shared/external Redis backend is active and therefore has
 * not installed `globalThis.__redis_mem_limits`.
 */
export function resolveStrategyMemoryGuardLimits(
  sharedLimits?: { rssSoftMB?: unknown; rssHardMB?: unknown },
  totalMemoryMb = detectRuntimeMemoryTotalMb(),
  env: NodeJS.ProcessEnv = process.env,
): StrategyMemoryGuardLimits {
  const total = Math.max(512, finitePositive(totalMemoryMb) ?? 4096)
  const usable = Math.max(1500, total - 1500)
  const configuredSoft =
    finitePositive(env.CTS_RSS_SOFT_LIMIT_MB) ??
    finitePositive(env.CTS_RUNTIME_MEMORY_HIGH_MB) ??
    finitePositive(sharedLimits?.rssSoftMB)
  const configuredHard =
    finitePositive(env.CTS_RSS_HARD_LIMIT_MB) ??
    finitePositive(env.CTS_RUNTIME_MEMORY_MAX_MB) ??
    finitePositive(sharedLimits?.rssHardMB)
  const rssSoftMb = Math.round(Math.min(
    Math.max(384, total - 256),
    configuredSoft ?? usable * 0.72,
  ))
  // A standalone soft limit (used by Dev/preview harnesses) must still create
  // an actual overrun boundary. Keep enough room for one exhaustive symbol to
  // finish and publish its checkpoint before the next symbol is admitted.
  const derivedHard = configuredHard ?? (
    configuredSoft
      ? Math.min(total * 0.94, Math.max(rssSoftMb + 512, rssSoftMb * 1.5))
      : usable * 0.82
  )
  const rssHardMb = Math.max(
    rssSoftMb + 128,
    Math.round(derivedHard),
  )
  const emergencyReserveMb = Math.max(
    128,
    Math.min(1024, Math.round(rssHardMb * 0.15)),
  )
  const rssEmergencyMb = Math.max(
    rssSoftMb,
    rssHardMb - emergencyReserveMb,
  )
  return {
    totalMemoryMb: Math.round(total),
    usableMemoryMb: Math.round(usable),
    rssSoftMb,
    rssHardMb,
    rssEmergencyMb,
    rssResumeMb: Math.min(rssSoftMb, Math.max(256, rssEmergencyMb - 128)),
  }
}

function roundMb(bytes: unknown): number {
  const value = Number(bytes)
  return Number.isFinite(value) && value > 0
    ? Math.round((value / 1024 / 1024) * 10) / 10
    : 0
}

/** One allocation-light process sample shared by admission and monitoring. */
export function sampleStrategyMemoryPressure(
  sharedLimits?: { rssSoftMB?: unknown; rssHardMB?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): StrategyMemoryPressureSnapshot {
  const limits = resolveStrategyMemoryGuardLimits(
    sharedLimits,
    detectRuntimeMemoryTotalMb(env),
    env,
  )
  const memory = process.memoryUsage()
  const rssMb = roundMb(memory.rss)
  const heapUsedMb = roundMb(memory.heapUsed)
  const configuredHeapMb = finitePositive(env.CTS_NODE_HEAP_MB)
  // `heapTotal` is committed pages rather than V8's real ceiling. The launch
  // contract is authoritative; this conservative fallback still detects a
  // runaway heap when a caller did not export CTS_NODE_HEAP_MB.
  const heapLimitMb = Math.max(
    256,
    Math.round(configuredHeapMb ?? Math.max(roundMb(memory.heapTotal) * 4, 1024)),
  )
  const rssRatio = limits.rssHardMb > 0 ? rssMb / limits.rssHardMb : 0
  const heapRatio = heapLimitMb > 0 ? heapUsedMb / heapLimitMb : 0
  const level: StrategyMemoryPressureLevel =
    rssMb >= limits.rssHardMb || heapRatio >= 0.9
      ? "critical"
      : rssMb >= limits.rssEmergencyMb || heapRatio >= 0.82
        ? "high"
        : rssMb >= limits.rssSoftMb || heapRatio >= 0.68
          ? "elevated"
          : "healthy"
  return {
    ...limits,
    sampledAt: Date.now(),
    rssMb,
    heapUsedMb,
    heapTotalMb: roundMb(memory.heapTotal),
    externalMb: roundMb(memory.external),
    arrayBuffersMb: roundMb(memory.arrayBuffers),
    heapLimitMb,
    rssRatio: Math.round(rssRatio * 10_000) / 10_000,
    heapRatio: Math.round(heapRatio * 10_000) / 10_000,
    level,
  }
}

type MemoryCoordinationState = {
  activeFlows: number
  queuedFlows: number
  throttleCount: number
  gcCount: number
  totalWaitMs: number
  peakRssMb: number
  lastLabel: string
  lastPressure?: StrategyMemoryPressureSnapshot
  lastGcAt: number
  lastGcDurationMs: number
  lastGcLevel: StrategyMemoryPressureLevel | "none"
}

const memoryGlobal = globalThis as typeof globalThis & {
  __cts_strategy_memory_coordination__?: MemoryCoordinationState
}
const memoryCoordination = memoryGlobal.__cts_strategy_memory_coordination__ ??= {
  activeFlows: 0,
  queuedFlows: 0,
  throttleCount: 0,
  gcCount: 0,
  totalWaitMs: 0,
  peakRssMb: 0,
  lastLabel: "startup",
  lastGcAt: 0,
  lastGcDurationMs: 0,
  lastGcLevel: "none",
}

function configuredMaxActiveFlows(env: NodeJS.ProcessEnv): number {
  const configured = Number(
    env.CTS_STRATEGY_MEMORY_MAX_ACTIVE_FLOWS ??
    env.STRATEGY_FLOW_SYMBOL_CONCURRENCY ??
    1,
  )
  return Math.max(1, Math.min(4, Number.isFinite(configured) ? Math.floor(configured) : 1))
}

function updateMemoryCoordinationSample(
  label: string,
  sample: StrategyMemoryPressureSnapshot,
): void {
  memoryCoordination.lastLabel = label
  memoryCoordination.lastPressure = sample
  memoryCoordination.peakRssMb = Math.max(memoryCoordination.peakRssMb, sample.rssMb)
}

async function yieldForMemory(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

export function resolveStrategyGcCooldownMs(
  level: StrategyMemoryPressureLevel,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const [envKey, fallback, minimum, maximum] = level === "critical"
    ? ["CTS_STRATEGY_GC_CRITICAL_INTERVAL_MS", 1_000, 250, 10_000]
    : level === "high"
      ? ["CTS_STRATEGY_GC_HIGH_INTERVAL_MS", 5_000, 1_000, 60_000]
      : ["CTS_STRATEGY_GC_ELEVATED_INTERVAL_MS", 30_000, 5_000, 300_000]
  const configured = Number(env[envKey])
  return Number.isFinite(configured)
    ? Math.max(minimum, Math.min(maximum, Math.round(configured)))
    : fallback
}

async function collectForMemoryPressure(
  level: StrategyMemoryPressureLevel,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const now = Date.now()
  // Multiple symbol pools can queue on the process-wide lease at once. They
  // must share one pressure-dependent cooldown; allowing each high-pressure
  // waiter to force GC produced a synchronous collection loop every 250 ms.
  // Critical pressure still reacts within one second, while an ordinary soft
  // crossing is collected at most once per 30 seconds.
  if (now - memoryCoordination.lastGcAt < resolveStrategyGcCooldownMs(level, env)) return
  const gc = (globalThis as typeof globalThis & {
    gc?: (options?: {
      type?: "major" | "minor"
      execution?: "sync" | "async"
    }) => void | Promise<void>
  }).gc
  if (typeof gc !== "function") return
  const startedAt = Date.now()
  // Elevated/high pressure is sampled at the symbol admission boundary, after
  // the previous heavyweight graph became unreachable. Use Node's asynchronous
  // Major collector there so Redis/UI callbacks can keep progressing. Critical
  // pressure remains synchronous: preserving the process takes precedence.
  if (level === "critical") {
    gc()
  } else {
    await Promise.resolve(gc({ type: "major", execution: "async" }))
  }
  memoryCoordination.gcCount++
  memoryCoordination.lastGcAt = now
  memoryCoordination.lastGcDurationMs = Date.now() - startedAt
  memoryCoordination.lastGcLevel = level
  await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * Acquire one process-wide Strategy allocation lease.
 *
 * Every connection and every outer symbol pool shares this HMR-safe gate. New
 * large graphs contract to one in-flight flow as soon as RSS/heap pressure is
 * elevated. At high pressure, no new flow starts until active graphs have
 * completed and GC has restored safe headroom. Waiting is cancellable by the
 * engine generation guard, so stop/reconfigure remains responsive.
 */
export async function acquireStrategyMemoryLease(options: {
  label: string
  isCurrent?: () => boolean
  env?: NodeJS.ProcessEnv
}): Promise<(() => void) | null> {
  const env = options.env ?? process.env
  const startedAt = Date.now()
  let throttled = false
  memoryCoordination.queuedFlows++
  try {
    while (options.isCurrent?.() !== false) {
      const sharedLimits = (globalThis as typeof globalThis & {
        __redis_mem_limits?: { rssSoftMB?: unknown; rssHardMB?: unknown }
      }).__redis_mem_limits
      let sample = sampleStrategyMemoryPressure(sharedLimits, env)
      updateMemoryCoordinationSample(options.label, sample)

      if (sample.level === "elevated" || sample.level === "high" || sample.level === "critical") {
        if (!throttled) {
          throttled = true
          memoryCoordination.throttleCount++
        }
        await collectForMemoryPressure(sample.level, env)
        sample = sampleStrategyMemoryPressure(sharedLimits, env)
        updateMemoryCoordinationSample(options.label, sample)
      }

      const maxActive = configuredMaxActiveFlows(env)
      const pressureLimit = sample.level === "healthy" ? maxActive : 1
      const highRecoveredEnough =
        sample.level !== "high" && sample.level !== "critical" ||
        (
          memoryCoordination.activeFlows === 0 &&
          sample.rssMb < sample.rssHardMb &&
          sample.heapRatio < 0.75
        )

      if (highRecoveredEnough && memoryCoordination.activeFlows < pressureLimit) {
        memoryCoordination.activeFlows++
        memoryCoordination.totalWaitMs += Date.now() - startedAt
        let released = false
        return () => {
          if (released) return
          released = true
          memoryCoordination.activeFlows = Math.max(0, memoryCoordination.activeFlows - 1)
        }
      }

      // High/critical pressure gets a longer recovery window; ordinary queue
      // contention stays responsive without a busy loop.
      await yieldForMemory(
        sample.level === "critical" ? 500 : sample.level === "high" ? 250 : 40,
      )
    }
    return null
  } finally {
    memoryCoordination.queuedFlows = Math.max(0, memoryCoordination.queuedFlows - 1)
  }
}

/** Best-effort inter-stage collection; admission remains the hard gate. */
export async function relieveStrategyMemoryPressure(label: string): Promise<StrategyMemoryPressureSnapshot> {
  const sharedLimits = (globalThis as typeof globalThis & {
    __redis_mem_limits?: { rssSoftMB?: unknown; rssHardMB?: unknown }
  }).__redis_mem_limits
  let sample = sampleStrategyMemoryPressure(sharedLimits)
  updateMemoryCoordinationSample(label, sample)
  if (sample.level !== "healthy") {
    await collectForMemoryPressure(sample.level)
    sample = sampleStrategyMemoryPressure(sharedLimits)
    updateMemoryCoordinationSample(label, sample)
  }
  return sample
}

export function getStrategyMemoryCoordinationSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): StrategyMemoryCoordinationSnapshot {
  const pressure = memoryCoordination.lastPressure ?? sampleStrategyMemoryPressure(undefined, env)
  return {
    activeFlows: memoryCoordination.activeFlows,
    queuedFlows: memoryCoordination.queuedFlows,
    maxActiveFlows: configuredMaxActiveFlows(env),
    throttleCount: memoryCoordination.throttleCount,
    gcCount: memoryCoordination.gcCount,
    totalWaitMs: memoryCoordination.totalWaitMs,
    peakRssMb: memoryCoordination.peakRssMb,
    lastGcAt: memoryCoordination.lastGcAt,
    lastGcDurationMs: memoryCoordination.lastGcDurationMs,
    lastGcLevel: memoryCoordination.lastGcLevel,
    lastLabel: memoryCoordination.lastLabel,
    lastPressure: pressure,
  }
}
