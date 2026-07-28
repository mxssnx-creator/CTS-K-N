/**
 * Engine Progression Logs - Stores detailed logs of all engine operations
 * Uses simple Redis lists (not sorted sets) for compatibility with Upstash
 */

import { getRedisClient } from "@/lib/redis-db"

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
}
const g = globalThis as unknown as { __v0_progression?: ProgressionGlobals }
if (!g.__v0_progression) g.__v0_progression = {}
const PG = g.__v0_progression

const logBuffer: Map<string, string[]> =
  PG.logBuffer ?? (PG.logBuffer = new Map<string, string[]>())
const coalesced = PG.coalesced ?? (PG.coalesced = new Map())
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
    const logEntry = `${timestamp}|${level}|${phase}|${message}|${JSON.stringify(effectiveDetails || {})}`
    
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
      console.log(`[v0] [${level.toUpperCase()}] [${phase}] ${message}`, effectiveDetails ? JSON.stringify(effectiveDetails).slice(0, 200) : "")
    }
  } catch (error) {
    // Silent fail - logging should never block main operations
    console.error("[v0] [LogError] Failed to log:", error)
  }
}

/**
 * Flush log buffer for a specific key
 */
async function flushLogBuffer(logKey: string): Promise<void> {
  const buffer = logBuffer.get(logKey)
  if (!buffer || buffer.length === 0) return
  
  // Copy and clear buffer immediately to prevent duplicate writes
  const toFlush = [...buffer]
  logBuffer.set(logKey, [])
  
  try {
    const client = getRedisClient()
    
    // ── Progression logs should appear in chronological order ──────────
    // We use lpush to prepend to a Redis list (lpush prepends to the
    // head; lrange returns from head to tail). Without reversing the
    // entries, the FIRST entry in toFlush becomes the HEAD (index 0),
    // so lrange(0, MAX) returns them in chronological order as written.
    //
    // Previously we did `lpush(...toFlush.reverse())` which reversed
    // the order, making lrange read them backwards. The reader at line
    // 158 does NOT reverse, so logs appeared in reverse chronological
    // order. Removing the .reverse() here fixes the bug — logs now
    // display oldest first.
    await Promise.race([
      (async () => {
        await client.lpush(logKey, ...toFlush)
        await client.ltrim(logKey, 0, MAX_LOGS_PER_CONNECTION - 1)
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("progression log flush timeout")), LOG_FLUSH_TIMEOUT_MS)),
    ])
  } catch (error) {
    // Put entries back if flush failed
    const currentBuffer = logBuffer.get(logKey) || []
    const merged = [...toFlush.slice(-100), ...currentBuffer]
    logBuffer.set(logKey, merged.slice(-MAX_BUFFER_PER_KEY))
  }
}

/**
 * Flush all log buffers
 */
export async function flushAllLogBuffers(): Promise<void> {
  const keys = Array.from(logBuffer.keys())
  await Promise.all(keys.map(key => flushLogBuffer(key).catch(() => {})))
}

/**
 * Force flush logs for a specific connection
 */
export async function forceFlushLogs(connectionId: string): Promise<void> {
  const logKey = `engine_logs:${connectionId}`
  await flushLogBuffer(logKey)
}

/**
 * Get all progression logs for a connection
 * OPTIMIZED: Uses native Redis list operations and forces flush first
 */
export async function getProgressionLogs(
  connectionId: string,
  options: { flush?: boolean } = {},
): Promise<ProgressionLogEntry[]> {
  try {
    // Force flush all pending logs first to ensure we get the latest entries
    // for log-detail views. Progress/status routes can pass flush:false after
    // doing their own bounded connection-local flush, avoiding a global flush
    // fan-out on every card poll.
    if (options.flush !== false) {
      await flushAllLogBuffers()
    }
    
    const client = getRedisClient()
    const logKey = `engine_logs:${connectionId}`

    // Use lrange for efficient list retrieval
    const logs = await client.lrange(logKey, 0, MAX_LOGS_PER_CONNECTION - 1)
    if (!logs || logs.length === 0) return []

    // Parse each log entry from "timestamp|level|phase|message|details_json"
    return logs
      .map((entry) => {
        try {
          const parts = entry.split("|")
          if (parts.length < 4) return null
          
          const [timestamp, level, phase, message, ...detailsParts] = parts
          const detailsJson = detailsParts.join("|") // Rejoin in case details contained |
          let details: Record<string, any> = {}
          try {
            details = JSON.parse(detailsJson || "{}")
          } catch {
            details = {}
          }
          
          return {
            timestamp,
            level: (level as any) || "info",
            phase,
            message,
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
