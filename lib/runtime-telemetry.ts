/** Node-only runtime telemetry for the detailed statistics surfaces. */

import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { getRuntimeConcurrencyProfile } from "@/lib/runtime-concurrency-profile"
import { getStrategyMemoryCoordinationSnapshot } from "@/lib/strategy-memory-guard"

type EventLoopDelayReader = {
  enable: () => void
  percentile: (percentile: number) => number
  readonly max: number
  reset?: () => void
}

type EventLoopUtilizationSnapshot = {
  active?: number
  idle?: number
  utilization?: number
}

// Workerd exposes the Node perf_hooks surface for compatibility, but some
// versions throw "not implemented" when monitorEventLoopDelay is invoked.
// Telemetry is observational and must never turn that optional capability into
// a critical startup dependency for the trading engine.
const eventLoopDelay: EventLoopDelayReader | null = (() => {
  try {
    if (typeof monitorEventLoopDelay !== "function") return null
    const reader = monitorEventLoopDelay({ resolution: 20 }) as EventLoopDelayReader
    if (!reader || typeof reader.enable !== "function" || typeof reader.percentile !== "function") return null
    reader.enable()
    return reader
  } catch {
    return null
  }
})()

// `performance.eventLoopUtilization()` without a prior snapshot is lifetime
// cumulative. Feeding that value into the adaptive lane controller made a
// busy cold start look permanently critical even after the event loop had
// recovered. Store the baseline on the Node global rather than a route bundle:
// Next may evaluate the same module in more than one server chunk, but those
// chunks share the owner process and must report the same measurement window.
const EVENT_LOOP_BASELINE_GLOBAL_KEY = "__cts_runtime_event_loop_baseline__"
type RuntimeTelemetryGlobal = typeof globalThis & {
  [EVENT_LOOP_BASELINE_GLOBAL_KEY]?: EventLoopUtilizationSnapshot
}

function readEventLoopBaseline(): EventLoopUtilizationSnapshot | null {
  const value = (globalThis as RuntimeTelemetryGlobal)[EVENT_LOOP_BASELINE_GLOBAL_KEY]
  return value && typeof value === "object" ? value : null
}

function writeEventLoopBaseline(value: EventLoopUtilizationSnapshot): void {
  ;(globalThis as RuntimeTelemetryGlobal)[EVENT_LOOP_BASELINE_GLOBAL_KEY] = value
}

function rounded(value: number, digits = 1): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function intervalEventLoopUtilizationPct(
  current: EventLoopUtilizationSnapshot | null | undefined,
  previous: EventLoopUtilizationSnapshot | null | undefined,
): number {
  if (!current || !previous) return 0
  const active = Math.max(0, Number(current.active || 0) - Number(previous.active || 0))
  const idle = Math.max(0, Number(current.idle || 0) - Number(previous.idle || 0))
  const elapsed = active + idle
  if (elapsed <= 0) return 0
  return (active / elapsed) * 100
}

/**
 * A point-in-time snapshot. Values are observational only and never drive
 * trading decisions, so a telemetry failure can safely return zeros.
 */
export function getRuntimeTelemetry(itemCount = Number.POSITIVE_INFINITY) {
  const capturedAt = new Date().toISOString()
  let memory = { rssMB: 0, heapUsedMB: 0, heapTotalMB: 0, externalMB: 0, arrayBuffersMB: 0 }
  let eventLoop = { utilizationPct: 0, delayP50Ms: 0, delayP95Ms: 0, delayMaxMs: 0 }
  let memoryCollection = {
    highWaterMarkMB: 0,
    inFlight: false,
    lastAt: 0,
    lastMode: "none",
    lastDurationMs: 0,
  }

  try {
    const usage = process.memoryUsage()
    memory = {
      rssMB: rounded(usage.rss / 1024 / 1024),
      heapUsedMB: rounded(usage.heapUsed / 1024 / 1024),
      heapTotalMB: rounded(usage.heapTotal / 1024 / 1024),
      externalMB: rounded(usage.external / 1024 / 1024),
      arrayBuffersMB: rounded((usage.arrayBuffers || 0) / 1024 / 1024),
    }
  } catch {
    // Process memory metrics are optional in Node-compatible worker runtimes.
  }

  try {
    const utilizationReader = (performance as typeof performance & {
      eventLoopUtilization?: () => EventLoopUtilizationSnapshot
    }).eventLoopUtilization
    const utilization = typeof utilizationReader === "function"
      ? utilizationReader.call(performance)
      : null
    const utilizationPct = intervalEventLoopUtilizationPct(
      utilization,
      readEventLoopBaseline(),
    )
    if (utilization) writeEventLoopBaseline(utilization)
    const delayP50Ms = eventLoopDelay ? rounded(eventLoopDelay.percentile(50) / 1e6) : 0
    const delayP95Ms = eventLoopDelay ? rounded(eventLoopDelay.percentile(95) / 1e6) : 0
    const delayMaxMs = eventLoopDelay ? rounded(eventLoopDelay.max / 1e6) : 0
    // Histogram values are also interval telemetry. Reset after sampling so a
    // cold-build pause cannot throttle every later healthy runtime cycle.
    try { eventLoopDelay?.reset?.() } catch { /* optional histogram reset */ }
    eventLoop = {
      utilizationPct: rounded(utilizationPct),
      delayP50Ms,
      delayP95Ms,
      delayMaxMs,
    }
  } catch {
    // Workerd currently provides perf_hooks stubs that may throw. Keep the
    // supported memory/concurrency fields and publish zero event-loop values.
  }

  try {
    const monitor = (globalThis as typeof globalThis & {
      __memory_monitor__?: {
        highWaterMark?: number
        gcInFlight?: boolean
        lastGC?: number
        lastGCMode?: string
        lastGCDurationMs?: number
      }
    }).__memory_monitor__
    memoryCollection = {
      highWaterMarkMB: rounded(Number(monitor?.highWaterMark || 0)),
      inFlight: monitor?.gcInFlight === true,
      lastAt: Number(monitor?.lastGC || 0),
      lastMode: String(monitor?.lastGCMode || "none"),
      lastDurationMs: rounded(Number(monitor?.lastGCDurationMs || 0)),
    }
  } catch {
    // Collection telemetry is best-effort and never controls admission.
  }

  const concurrency = getRuntimeConcurrencyProfile(itemCount, process.env, {
    rssMB: memory.rssMB,
    eventLoopUtilizationPct: eventLoop.utilizationPct,
    eventLoopDelayP95Ms: eventLoop.delayP95Ms,
  })
  const strategyMemory = getStrategyMemoryCoordinationSnapshot(process.env)

  return {
    capturedAt,
    concurrency,
    memory,
    memoryCollection,
    strategyMemory,
    eventLoop,
    node: {
      version: process.version,
      pid: process.pid,
    },
  }
}
