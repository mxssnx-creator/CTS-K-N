/** Node-only runtime telemetry for the detailed statistics surfaces. */

import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { getRuntimeConcurrencyProfile } from "@/lib/runtime-concurrency-profile"
import { getStrategyMemoryCoordinationSnapshot } from "@/lib/strategy-memory-guard"

type EventLoopDelayReader = {
  enable: () => void
  percentile: (percentile: number) => number
  readonly max: number
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

function rounded(value: number, digits = 1): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
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
      eventLoopUtilization?: () => { utilization?: number }
    }).eventLoopUtilization
    const utilization = typeof utilizationReader === "function"
      ? utilizationReader.call(performance)
      : null
    eventLoop = {
      utilizationPct: rounded(Number(utilization?.utilization || 0) * 100),
      delayP50Ms: eventLoopDelay ? rounded(eventLoopDelay.percentile(50) / 1e6) : 0,
      delayP95Ms: eventLoopDelay ? rounded(eventLoopDelay.percentile(95) / 1e6) : 0,
      delayMaxMs: eventLoopDelay ? rounded(eventLoopDelay.max / 1e6) : 0,
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
