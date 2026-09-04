/**
 * Engine Progress Logging System
 * Provides detailed, structured logging for all engine processing phases and cycles
 */

import { getRedisClient, initRedis } from "@/lib/redis-db"

export interface EngineProgressLog {
  timestamp: string
  connectionId: string
  engine: "indications" | "strategies" | "realtime" | "pseudo_positions" | "coordinator"
  phase: string
  action: string
  status: "start" | "progress" | "complete" | "error"
  details: {
    symbolsProcessed?: number
    cycleCount?: number
    cycleDuration?: number
    successRate?: number
    errorCount?: number
    dataPoints?: any
  }
  metrics?: {
    memoryUsage?: number
    cpuUsage?: number
    queueSize?: number
  }
}

class StructuredLogger {
  private connectionId: string
  private logBuffer: EngineProgressLog[] = []
  private maxBufferSize = 1000
  private flushInterval = 10000 // 10 seconds
  private flushTimer?: NodeJS.Timeout
  private flushPromise: Promise<void> | null = null

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.startFlushTimer()
  }

  private startFlushTimer() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
    }
    this.flushTimer = setInterval(() => this.flushLogs(), this.flushInterval)
    this.flushTimer.unref?.() // Don't block process exit
  }

  destroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = undefined
    }
    this.flushLogs() // Final flush
  }

  async logCycleStart(engine: string, cycle: number) {
    const log: EngineProgressLog = {
      timestamp: new Date().toISOString(),
      connectionId: this.connectionId,
      engine: engine as any,
      phase: `cycle_${cycle}`,
      action: "start",
      status: "start",
      details: { cycleCount: cycle },
    }

    this.addToBuffer(log)
    console.log(`[v0] [${engine.toUpperCase()}] Cycle ${cycle} started`)
  }

  async logProcessing(engine: string, action: string, data: any) {
    const log: EngineProgressLog = {
      timestamp: new Date().toISOString(),
      connectionId: this.connectionId,
      engine: engine as any,
      phase: action,
      action: "processing",
      status: "progress",
      details: {
        symbolsProcessed: data.symbolsProcessed,
        cycleDuration: data.cycleDuration,
        successRate: data.successRate,
        dataPoints: data.dataPoints,
      },
    }

    this.addToBuffer(log)
    console.log(
      `[v0] [${engine.toUpperCase()}] ${action}: ${data.symbolsProcessed} symbols, ${data.cycleDuration}ms`
    )
  }

  async logCycleComplete(engine: string, cycle: number, duration: number, success: boolean, details: any) {
    const log: EngineProgressLog = {
      timestamp: new Date().toISOString(),
      connectionId: this.connectionId,
      engine: engine as any,
      phase: `cycle_${cycle}`,
      action: "complete",
      status: success ? "complete" : "error",
      details: {
        cycleCount: cycle,
        cycleDuration: duration,
        successRate: details.successRate || 100,
        errorCount: details.errorCount || 0,
        dataPoints: details.results,
      },
    }

    this.addToBuffer(log)
    console.log(
      `[v0] [${engine.toUpperCase()}] Cycle ${cycle} completed in ${duration}ms (${success ? "success" : "error"})`
    )
  }

  async logPhaseTransition(from: string, to: string, progress: number) {
    const log: EngineProgressLog = {
      timestamp: new Date().toISOString(),
      connectionId: this.connectionId,
      engine: "coordinator",
      phase: `transition_${from}_to_${to}`,
      action: "phase_change",
      status: "progress",
      details: { dataPoints: { progress } },
    }

    this.addToBuffer(log)
    console.log(`[v0] [COORDINATOR] Transitioning from ${from} to ${to} (${progress}% complete)`)
  }

  async logError(engine: string, error: Error, context: any) {
    const log: EngineProgressLog = {
      timestamp: new Date().toISOString(),
      connectionId: this.connectionId,
      engine: engine as any,
      phase: "error",
      action: "exception",
      status: "error",
      details: {
        dataPoints: {
          errorMessage: error.message,
          errorStack: error.stack,
          context,
        },
      },
    }

    this.addToBuffer(log)
    console.error(`[v0] [${engine.toUpperCase()}] ERROR: ${error.message}`, context)
  }

  private addToBuffer(log: EngineProgressLog) {
    this.logBuffer.push(log)
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.splice(0, this.logBuffer.length - this.maxBufferSize)
    }
    if (this.logBuffer.length >= this.maxBufferSize) {
      void this.flushLogs()
    }
  }

  private async flushLogs() {
    if (this.flushPromise) return this.flushPromise
    if (this.logBuffer.length === 0) return
    const batch = this.logBuffer.splice(0, this.maxBufferSize)
    this.flushPromise = (async () => {
      try {
        await initRedis()
        const client = getRedisClient()
        const logKey = `engine:logs:${this.connectionId}`
        const pipeline = client.pipeline()

        for (const log of batch) pipeline.lpush(logKey, JSON.stringify(log))
        pipeline.ltrim(logKey, 0, 999)
        pipeline.expire(logKey, 2592000) // 30 days
        const results = await pipeline.exec()
        if (results.some((result: any) => result instanceof Error || (Array.isArray(result) && result[0]))) {
          throw new Error("Engine structured-log pipeline returned an error")
        }
        console.log(`[v0] [Logger] Flushed ${batch.length} logs to Redis`)
      } catch (error) {
        // Logs are diagnostic. Drop this bounded batch rather than retrying it
        // indefinitely and competing with engine state under Redis pressure.
        console.error("[v0] [Logger] Failed to flush logs:", error)
      } finally {
        this.flushPromise = null
        if (this.logBuffer.length >= this.maxBufferSize) void this.flushLogs()
      }
    })()
    return this.flushPromise
  }

  async retrieveLogs(limit = 100) {
    try {
      await initRedis()
      const client = getRedisClient()
      const logKey = `engine:logs:${this.connectionId}`
      const boundedLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100)))
      const rawLogs = await client.lrange(logKey, 0, boundedLimit - 1)
      return rawLogs.map((log) => JSON.parse(log) as EngineProgressLog)
    } catch (error) {
      console.error("[v0] [Logger] Failed to retrieve logs:", error)
      return []
    }
  }
}

// Global logger instances
const loggers = new Map<string, StructuredLogger>()

export function getStructuredLogger(connectionId: string): StructuredLogger {
  if (!loggers.has(connectionId)) {
    loggers.set(connectionId, new StructuredLogger(connectionId))
  }
  return loggers.get(connectionId)!
}

export async function logProgressionEvent(
  connectionId: string,
  phase: string,
  level: "info" | "warn" | "error",
  message: string,
  details?: any
) {
  const logger = getStructuredLogger(connectionId)
  if (level === "error") {
    console.error(`[v0] [${phase.toUpperCase()}] ${message}`, details)
  } else if (level === "warn") {
    console.warn(`[v0] [${phase.toUpperCase()}] ${message}`, details)
  } else {
    console.log(`[v0] [${phase.toUpperCase()}] ${message}`, details)
  }
}
