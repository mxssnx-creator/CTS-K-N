/**
 * Engine Progression Logs - Stores detailed logs of all engine operations
 * Uses simple Redis lists (not sorted sets) for compatibility with Upstash
 */

import { getRedisClient } from "@/lib/redis-db"
import { boundedLogLimit, compactLogValue, serializeLogValue } from "@/lib/log-payload"
import { logRuntimeError } from "@/lib/runtime-log-throttle"

export interface ProgressionLogEntry {
  timestamp: string
  level: "info" | "warning" | "error" | "debug"
  phase: string
  message: string
  details?: Record<string, any>
  connectionId: string
}

const LOG_RETENTION_HOURS = 24
const MAX_LOGS_PER_CONNECTION = 500

// In-memory buffer for batch logging (reduces Redis writes significantly).
//
// HMR SAFETY: in Next.js dev mode every save hot-reloads the module,
// which would leak a fresh `setInterval` on every reload if state were
// kept in plain module-scoped `let`s. We pin the buffer and timer on
// `globalThis` so they survive reloads, and we clear any pre-existing
// timer before scheduling a new one.
type ProgressionGlobals = {
  logBuffer?: Map<string, string[]>
  coalesced?: Map<string, {
    lastEmittedAt: number
    suppressedEvents: number
    lastSeenAt: number
  }>
  flushTimer?: NodeJS.Timeout | null
  flushTimerStarted?: boolean
  flushes?: Map<string, Promise<void>>
  flushAllPromise?: Promise<void>
}
const g = globalThis as unknown as { __v0_progression?: ProgressionGlobals }
if (!g.__v0_progression) g.__v0_progression = {}
const PG = g.__v0_progression

const logBuffer: Map<string, string[]> =
  PG.logBuffer ?? (PG.logBuffer = new Map<string, string[]>())
const coalesced = PG.coalesced ?? (PG.coalesced = new Map())
const flushes = PG.flushes ?? (PG.flushes = new Map())
const BUFFER_FLUSH_SIZE = 25 // Flush every 25 logs to reduce Redis write pressure
const BUFFER_FLUSH_INTERVAL = 3000 // Or every 3 seconds
const MAX_BUFFER_PER_KEY = 250
const MAX_BUFFER_KEYS = 256
const MAX_COALESCE_KEYS = 1024
const HOT_PHASE_INTERVAL_MS = 15_000
const LOG_FLUSH_TIMEOUT_MS = 300

// Healthy processing phases can fire once per symbol and per engine tick. They
// are useful as heartbeat evidence, but recording every occurrence creates log
// I/O and heap pressure that competes with the engine itself. Errors, warnings,
// lifecycle transitions, and live-order activity are deliberately excluded.
const COALESCED_HEALTHY_PHASES = new Set([
  "cycle_start",
  "cycle_complete",
  "indications",
  "indications_sets",
  "strategies",
  "strategies_realtime",
  "strategy_flow",
  "main_stage",
  "real_stage",
  "realtime",
  "preset_historical_progress",
  "prehistoric_progress",
])

// Important phases that should flush immediately
const IMMEDIATE_FLUSH_PHASES = [
  "initializing", "prehistoric_data", "error", "engine_started", "engine_stopped",
  "engine_starting", "engine_error", "quickstart"
]

function isImmediateFlushPhase(phase: string): boolean {
  // Keep lifecycle transitions fast, but do not treat high-frequency
  // per-symbol/per-set phases such as `indications`, `indications_sets`,
  // `strategies`, `strategies_realtime`, `realtime`, or `live_trading`
  // order attempts as console/log
  // flush blockers on every event. The previous substring check matched
  // thousands of hot-path events during 12-symbol dev/prod comparison runs and
  // could starve dashboard progress endpoints behind stdout/Redis log churn.
  if (phase.startsWith("quickstart")) return true
  return IMMEDIATE_FLUSH_PHASES.includes(phase)
}

function coalesceHealthyEvent(
  connectionId: string,
  phase: string,
  level: ProgressionLogEntry["level"],
  details: Record<string, any> | undefined,
  now: number,
): { suppressed: boolean; suppressedEvents: number; windowMs: number } {
  if (
    (level !== "info" && level !== "debug") ||
    !COALESCED_HEALTHY_PHASES.has(phase)
  ) {
    return { suppressed: false, suppressedEvents: 0, windowMs: 0 }
  }

  const symbol = String(details?.symbol || details?.asset || "_cycle")
    .trim()
    .toUpperCase()
    .slice(0, 40)
  const key = `${connectionId}|${phase}|${symbol}`
  const previous = coalesced.get(key)
  if (previous && now - previous.lastEmittedAt < HOT_PHASE_INTERVAL_MS) {
    previous.suppressedEvents++
    previous.lastSeenAt = now
    // Refresh insertion order so bounded eviction removes genuinely cold keys.
    coalesced.delete(key)
    coalesced.set(key, previous)
    return { suppressed: true, suppressedEvents: previous.suppressedEvents, windowMs: 0 }
  }

  const suppressedEvents = previous?.suppressedEvents || 0
  const windowMs = previous ? Math.max(0, now - previous.lastEmittedAt) : 0
  coalesced.delete(key)
  coalesced.set(key, {
    lastEmittedAt: now,
    suppressedEvents: 0,
    lastSeenAt: now,
  })
  while (coalesced.size > MAX_COALESCE_KEYS) {
    const oldest = coalesced.keys().next().value
    if (!oldest) break
    coalesced.delete(oldest)
  }
  return { suppressed: false, suppressedEvents, windowMs }
}

/**
 * Log a progression event for a connection
 * OPTIMIZED: Uses in-memory buffering with immediate flush for important events
 */
export async function logProgressionEvent(
  connectionId: string,
  phase: string,
  level: "info" | "warning" | "error" | "debug",
  message: string,
  details?: Record<string, any>
): Promise<void> {
  try {
    const now = Date.now()
    const coalescing = coalesceHealthyEvent(connectionId, phase, level, details, now)
    if (coalescing.suppressed) return
    const timestamp = new Date(now).toISOString()
    const logKey = `engine_logs:${connectionId}`
    const effectiveDetails = coalescing.suppressedEvents > 0
      ? {
          ...(details || {}),
          suppressedEvents: coalescing.suppressedEvents,
          coalescedWindowMs: coalescing.windowMs,
        }
      : details
    
    // Format: "timestamp|level|phase|message|details_json"
    const logEntry = `${timestamp}|${level}|${phase.slice(0, 120).replace(/\|/g, "/")}|${message.slice(0, 2_000).replace(/\|/g, "/")}|${serializeLogValue(effectiveDetails || {})}`
    
    // Add to buffer instead of writing immediately
    if (!logBuffer.has(logKey)) {
      while (logBuffer.size >= MAX_BUFFER_KEYS) {
        const emptyKey = Array.from(logBuffer.entries()).find(([, entries]) => entries.length === 0)?.[0]
        const evictedKey = emptyKey || logBuffer.keys().next().value
        if (!evictedKey) break
        logBuffer.delete(evictedKey)
      }
      logBuffer.set(logKey, [])
    }
    const buffer = logBuffer.get(logKey)!
    buffer.push(logEntry)
    if (buffer.length > MAX_BUFFER_PER_KEY) {
      buffer.splice(0, buffer.length - MAX_BUFFER_PER_KEY)
    }
    
    // Start flush timer if not started. The `PG.flushTimerStarted`
    // flag is keyed on globalThis so HMR module reloads don't spawn
    // duplicate timers; if a stale timer somehow survives in
    // `PG.flushTimer`, clear it before installing the new one.
    if (!PG.flushTimerStarted) {
      if (PG.flushTimer) {
        clearInterval(PG.flushTimer)
      }
      PG.flushTimerStarted = true
      PG.flushTimer = setInterval(flushAllLogBuffers, BUFFER_FLUSH_INTERVAL)
      // Avoid preventing process exit in scripts/tests.
      PG.flushTimer.unref?.()
    }
    
    // Immediate flush for important phases or errors
    const isImportant = isImmediateFlushPhase(phase) || level === "error" || level === "warning"
    if (isImportant || buffer.length >= BUFFER_FLUSH_SIZE) {
      // Never let Redis logging latency block live trading/progression. The
      // periodic flush remains the durability safety net.
      void flushLogBuffer(logKey)
    }

    // Console log for important events (info for important phases, always for errors/warnings)
    if (level === "error" || level === "warning" || isImportant) {
      console.log(`[v0] [${level.toUpperCase()}] [${phase.slice(0, 120)}] ${message.slice(0, 2_000)}`, effectiveDetails ? serializeLogValue(effectiveDetails).slice(0, 200) : "")
    }
  } catch (error) {
    // Silent fail - logging should never block main operations
    logRuntimeError("progression-log-encode", 30_000, "[LogError] Failed to encode diagnostic event", compactLogValue(error))
  }
}

/**
 * Flush log buffer for a specific key
 */
function flushLogBuffer(logKey: string): Promise<void> {
  const existing = flushes.get(logKey)
  if (existing) return existing
  const buffer = logBuffer.get(logKey)
  if (!buffer?.length || flushes.size >= 4) return Promise.resolve()
  const toFlush = buffer.splice(0, MAX_BUFFER_PER_KEY)
  // A caller timing out does not cancel Redis. Keep ownership until the actual
  // write settles; never replay an ambiguously committed diagnostic batch.
  const pending = (async () => {
    try {
      const client = getRedisClient()
      await client.lpush(logKey, ...toFlush) // newest first
      await client.ltrim(logKey, 0, MAX_LOGS_PER_CONNECTION - 1)
      await client.expire(logKey, LOG_RETENTION_HOURS * 60 * 60)
    } catch (error) {
      logRuntimeError("progression-log-write", 30_000, "[EngineLog] Diagnostic batch dropped after Redis failure", compactLogValue(error))
    }
  })().finally(() => {
    if (flushes.get(logKey) === pending) flushes.delete(logKey)
  })
  flushes.set(logKey, pending)
  return pending
}

async function waitForDiagnosticFlush(pending: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, LOG_FLUSH_TIMEOUT_MS) })])
  } finally { if (timer) clearTimeout(timer) }
}

/**
 * Flush all log buffers
 */
export function flushAllLogBuffers(): Promise<void> {
  if (PG.flushAllPromise) return PG.flushAllPromise
  const keys = Array.from(logBuffer.keys())
  const pending = (async () => {
    for (let offset = 0; offset < keys.length; offset += 4) {
      await Promise.all(keys.slice(offset, offset + 4).map(key => flushLogBuffer(key)))
    }
  })().finally(() => { if (PG.flushAllPromise === pending) PG.flushAllPromise = undefined })
  PG.flushAllPromise = pending
  return pending
}

/**
 * Force flush logs for a specific connection
 */
export async function forceFlushLogs(connectionId: string): Promise<void> {
  const logKey = `engine_logs:${connectionId}`
  await waitForDiagnosticFlush(flushLogBuffer(logKey))
}

/**
 * Get all progression logs for a connection
 * OPTIMIZED: Uses native Redis list operations and forces flush first
 */
export async function getProgressionLogs(
  connectionId: string,
  options: { flush?: boolean; limit?: number } = {},
): Promise<ProgressionLogEntry[]> {
  try {
    // Force flush all pending logs first to ensure we get the latest entries
    // for log-detail views. Progress/status routes can pass flush:false after
    // doing their own bounded connection-local flush. Other connections are
    // never flushed by this read.
    if (options.flush !== false) {
      await forceFlushLogs(connectionId)
    }
    
    const client = getRedisClient()
    const logKey = `engine_logs:${connectionId}`

    // Use lrange for efficient list retrieval
    const logs = await client.lrange(logKey, 0, boundedLogLimit(options.limit) - 1)
    if (!logs || logs.length === 0) return []

    // Parse each log entry from "timestamp|level|phase|message|details_json"
    return logs
      .map((entry) => {
        try {
          if (entry.startsWith("{")) {
            const row = JSON.parse(entry)
            return { timestamp: row.timestamp, level: row.level || "info", phase: row.phase || row.category || "engine", message: String(row.message || row.action || ""), details: compactLogValue(row.details || row.data || {}), connectionId } as ProgressionLogEntry
          }
          const parts = entry.split("|")
          if (parts.length < 4) return null
          
          const [timestamp, level, phase, message, ...detailsParts] = parts
          const detailsJson = detailsParts.join("|") // Rejoin in case details contained |
          let details: Record<string, any> = {}
          try {
            details = compactLogValue(JSON.parse(detailsJson || "{}"))
          } catch {
            details = {}
          }
          
          return {
            timestamp,
            level: (level as any) || "info",
            phase,
            message: message.slice(0, 2_000),
            details,
            connectionId,
          } as ProgressionLogEntry
        } catch {
          return null
        }
      })
      .filter((entry): entry is ProgressionLogEntry => entry !== null)
  } catch (error) {
    console.error("[v0] [EngineLog] Failed to retrieve logs:", error instanceof Error ? error.message : String(error))
    return []
  }
}

/**
 * Clear logs for a connection
 */
export async function clearProgressionLogs(connectionId: string): Promise<void> {
  try {
    const client = getRedisClient()
    const logKey = `engine_logs:${connectionId}`
    await client.del(logKey)
    logBuffer.delete(logKey)
    for (const key of coalesced.keys()) {
      if (key.startsWith(`${connectionId}|`)) coalesced.delete(key)
    }
  } catch (error) {
    console.error("[v0] [EngineLog] Failed to clear logs:", error instanceof Error ? error.message : String(error))
  }
}

/**
 * Format logs for display
 */
export function formatLogsForDisplay(logs: ProgressionLogEntry[]): string {
  if (logs.length === 0) {
    return "No logs yet. Enable the connection to start logging."
  }

  return logs
    .map((log) => {
      const time = new Date(log.timestamp).toLocaleTimeString()
      const level = log.level.toUpperCase().padEnd(7)
      const details = log.details && Object.keys(log.details).length > 0 ? ` | ${JSON.stringify(log.details)}` : ""
      return `[${time}] ${level} | ${log.phase.padEnd(20)} | ${log.message}${details}`
    })
    .join("\n")
}

export const __progressionLogTestUtils = {
  reset(): void {
    if (PG.flushTimer) {
      clearInterval(PG.flushTimer)
      PG.flushTimer = null
    }
    PG.flushTimerStarted = false
    logBuffer.clear()
    coalesced.clear()
  },
  buffered(connectionId: string): string[] {
    return [...(logBuffer.get(`engine_logs:${connectionId}`) || [])]
  },
  coalescedSize(): number {
    return coalesced.size
  },
}
