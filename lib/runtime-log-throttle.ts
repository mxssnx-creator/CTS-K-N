type RuntimeLogState = {
  lastEmittedAt: number
  suppressed: number
}

type RuntimeLogGlobals = {
  entries?: Map<string, RuntimeLogState>
}

const runtimeGlobal = globalThis as typeof globalThis & {
  __v0_runtime_log_throttle?: RuntimeLogGlobals
}
runtimeGlobal.__v0_runtime_log_throttle ??= {}
const entries =
  runtimeGlobal.__v0_runtime_log_throttle.entries ??
  (runtimeGlobal.__v0_runtime_log_throttle.entries = new Map())

const MAX_RUNTIME_LOG_KEYS = 512
type RuntimeLogWriter = (...values: unknown[]) => void

function touch(key: string, state: RuntimeLogState): void {
  entries.delete(key)
  entries.set(key, state)
  while (entries.size > MAX_RUNTIME_LOG_KEYS) {
    const oldest = entries.keys().next().value
    if (!oldest) break
    entries.delete(oldest)
  }
}

/**
 * Emit a healthy runtime message at most once per interval and account for the
 * messages skipped in between. This controls stdout serialization and retains
 * one compact heartbeat without muting warnings or errors.
 */
function emitRuntimeLog(
  key: string,
  intervalMs: number,
  message: string | (() => string),
  writer: RuntimeLogWriter,
  ...details: unknown[]
): boolean {
  const now = Date.now()
  const normalizedKey = String(key || "runtime").slice(0, 180)
  const previous = entries.get(normalizedKey)
  if (previous && now - previous.lastEmittedAt < Math.max(1_000, intervalMs)) {
    previous.suppressed++
    touch(normalizedKey, previous)
    return false
  }

  const suppressed = previous?.suppressed || 0
  touch(normalizedKey, { lastEmittedAt: now, suppressed: 0 })
  const renderedMessage = typeof message === "function" ? message() : message
  if (suppressed > 0) {
    writer(renderedMessage, ...details, `[${suppressed} repetitive messages coalesced]`)
  } else {
    writer(renderedMessage, ...details)
  }
  return true
}

export function logRuntimeInfo(
  key: string,
  intervalMs: number,
  message: string | (() => string),
  ...details: unknown[]
): boolean {
  return emitRuntimeLog(key, intervalMs, message, (...values) => console.log(...values), ...details)
}

/**
 * Preserve warning severity while coalescing an expected/recoverable warning
 * condition. Unexpected warnings and all errors should continue to use the
 * normal immediate console path.
 */
export function logRuntimeWarning(
  key: string,
  intervalMs: number,
  message: string | (() => string),
  ...details: unknown[]
): boolean {
  return emitRuntimeLog(key, intervalMs, message, (...values) => console.warn(...values), ...details)
}

export function clearRuntimeLogThrottle(prefix?: string): void {
  if (!prefix) {
    entries.clear()
    return
  }
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key)
  }
}

export const __runtimeLogThrottleTestUtils = {
  size(): number {
    return entries.size
  },
}
