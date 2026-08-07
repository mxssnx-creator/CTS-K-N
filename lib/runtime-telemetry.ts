/** Node-only runtime telemetry for the detailed statistics surfaces. */

import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { getRuntimeConcurrencyProfile } from "@/lib/runtime-concurrency-profile"

const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
eventLoopDelay.enable()

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
  try {
    const memory = process.memoryUsage()
    const eventLoop = performance.eventLoopUtilization()
    return {
      capturedAt: new Date().toISOString(),
      concurrency: getRuntimeConcurrencyProfile(itemCount),
      memory: {
        rssMB: rounded(memory.rss / 1024 / 1024),
        heapUsedMB: rounded(memory.heapUsed / 1024 / 1024),
        heapTotalMB: rounded(memory.heapTotal / 1024 / 1024),
        externalMB: rounded(memory.external / 1024 / 1024),
        arrayBuffersMB: rounded((memory.arrayBuffers || 0) / 1024 / 1024),
      },
      eventLoop: {
        utilizationPct: rounded(eventLoop.utilization * 100),
        delayP50Ms: rounded(eventLoopDelay.percentile(50) / 1e6),
        delayP95Ms: rounded(eventLoopDelay.percentile(95) / 1e6),
        delayMaxMs: rounded(eventLoopDelay.max / 1e6),
      },
      node: {
        version: process.version,
        pid: process.pid,
      },
    }
  } catch {
    return {
      capturedAt: new Date().toISOString(),
      concurrency: getRuntimeConcurrencyProfile(itemCount),
      memory: { rssMB: 0, heapUsedMB: 0, heapTotalMB: 0, externalMB: 0, arrayBuffersMB: 0 },
      eventLoop: { utilizationPct: 0, delayP50Ms: 0, delayP95Ms: 0, delayMaxMs: 0 },
      node: { version: process.version, pid: process.pid },
    }
  }
}
