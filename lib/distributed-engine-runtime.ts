export type EngineRuntimeHash = Record<string, unknown> | null | undefined

export const ENGINE_PROCESSOR_HEARTBEAT_FRESH_MS = 90_000
export const ENGINE_STARTUP_GRACE_MS = 120_000

const RUNNING_STATUSES = new Set([
  "active",
  "historic",
  "historical",
  "initializing",
  "live_trading",
  "loading",
  "ready",
  "realtime",
  "running",
  "starting",
])

const STOPPED_STATUSES = new Set(["disabled", "error", "idle", "paused", "stopped"])

const ACTIVITY_FIELDS = [
  "last_processor_heartbeat",
  "last_indication_run",
  "last_heartbeat_at",
  "last_heartbeat_iso",
  "last_activity_at",
  "last_cycle_at",
  "last_update",
  "updated_at",
  "started_at",
  "last_started_at",
] as const

const HEARTBEAT_FIELDS = [
  "last_processor_heartbeat",
  "last_indication_run",
  "last_heartbeat_at",
  "last_heartbeat_iso",
] as const

export function parseRuntimeTimestamp(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1_000 : numeric
  }
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function parseRedisRuntimeFlag(value: unknown): boolean | null {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  const normalized = String(value ?? "").trim().toLowerCase()
  if (["1", "true", "running", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "stopped", "no", "off"].includes(normalized)) return false
  return null
}

function newestTimestamp(hash: EngineRuntimeHash, fields: readonly string[]): number {
  if (!hash) return 0
  let newest = 0
  for (const field of fields) newest = Math.max(newest, parseRuntimeTimestamp(hash[field]))
  return newest
}

function selectCurrentStatus(states: readonly EngineRuntimeHash[]): {
  status: string
  activityAt: number
} {
  let selectedStatus = ""
  let selectedActivityAt = -1
  for (const state of states) {
    if (!state) continue
    const status = String(state.status || state.actual_status || "").trim().toLowerCase()
    if (!status) continue
    const activityAt = newestTimestamp(state, ACTIVITY_FIELDS)
    // Later entries win an exact tie. Callers therefore pass legacy state
    // first and the canonical/scoped settings hash last.
    if (activityAt >= selectedActivityAt) {
      selectedStatus = status
      selectedActivityAt = activityAt
    }
  }
  return { status: selectedStatus, activityAt: Math.max(0, selectedActivityAt) }
}

export type DistributedEngineRuntime = {
  running: boolean
  reason:
    | "connection-disabled"
    | "operator-stopped"
    | "runtime-stopped"
    | "fresh-heartbeat"
    | "startup-grace"
    | "no-runtime-proof"
  runningHint: boolean | null
  status: string
  globalIntent: string
  operatorStopped: boolean
  heartbeatAt: number
  heartbeatAgeMs: number | null
  heartbeatFresh: boolean
  startupFresh: boolean
}

/**
 * Resolve engine liveness from process-independent Redis evidence.
 *
 * Next.js can evaluate separate route bundles in isolated module contexts,
 * even inside one OS process. An in-memory coordinator queried by a read-only
 * route can consequently be empty while another context owns a healthy
 * engine. Conversely, persisted `status=running` can survive a crash. A fresh
 * processor heartbeat is the durable proof; the running flag plus a recent
 * running-state write covers only the short pre-heartbeat startup window.
 */
export function resolveDistributedEngineRuntime(input: {
  runningHint?: unknown
  states?: readonly EngineRuntimeHash[]
  globalState?: EngineRuntimeHash
  connectionEnabled?: boolean
  now?: number
  heartbeatFreshMs?: number
  startupGraceMs?: number
}): DistributedEngineRuntime {
  const now = input.now ?? Date.now()
  const heartbeatFreshMs = input.heartbeatFreshMs ?? ENGINE_PROCESSOR_HEARTBEAT_FRESH_MS
  const startupGraceMs = input.startupGraceMs ?? ENGINE_STARTUP_GRACE_MS
  const states = input.states || []
  const runningHint = parseRedisRuntimeFlag(input.runningHint)
  const { status, activityAt } = selectCurrentStatus(states)

  let heartbeatAt = 0
  for (const state of states) heartbeatAt = Math.max(heartbeatAt, newestTimestamp(state, HEARTBEAT_FIELDS))
  const heartbeatAgeMs = heartbeatAt > 0 ? Math.max(0, now - heartbeatAt) : null
  const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAt <= now + 5_000 && heartbeatAgeMs < heartbeatFreshMs
  const startupAgeMs = activityAt > 0 ? Math.max(0, now - activityAt) : null
  const startupFresh =
    runningHint === true &&
    RUNNING_STATUSES.has(status) &&
    startupAgeMs !== null &&
    activityAt <= now + 5_000 &&
    startupAgeMs < startupGraceMs

  const globalState = input.globalState || {}
  const globalIntent = String(
    globalState.operator_intent || globalState.desired_status || globalState.status || "",
  ).trim().toLowerCase()
  const operatorStopMarker = parseRedisRuntimeFlag(globalState.operator_stopped)
  const operatorStopAt = Math.max(
    parseRuntimeTimestamp(globalState.operator_stopped_at),
    parseRuntimeTimestamp(globalState.stopped_at),
  )
  const resumedAt = parseRuntimeTimestamp(globalState.resumed_at)
  // Stop is a sticky safety veto until a newer explicit Resume transition is
  // durably visible. This ordering handles eventual-consistency windows where
  // a read can briefly observe the old marker after Resume has published the
  // newer running intent.
  const operatorStopSuperseded =
    operatorStopMarker === true &&
    globalIntent === "running" &&
    operatorStopAt > 0 &&
    resumedAt > operatorStopAt
  const operatorStopped =
    (operatorStopMarker === true && !operatorStopSuperseded) ||
    globalIntent === "paused" ||
    globalIntent === "stopped"

  let reason: DistributedEngineRuntime["reason"] = "no-runtime-proof"
  let running = false
  if (input.connectionEnabled === false) {
    reason = "connection-disabled"
  } else if (operatorStopped) {
    reason = "operator-stopped"
  } else if (runningHint === false || STOPPED_STATUSES.has(status)) {
    reason = "runtime-stopped"
  } else if (heartbeatFresh) {
    running = true
    reason = "fresh-heartbeat"
  } else if (startupFresh) {
    running = true
    reason = "startup-grace"
  }

  return {
    running,
    reason,
    runningHint,
    status,
    globalIntent,
    operatorStopped,
    heartbeatAt,
    heartbeatAgeMs,
    heartbeatFresh,
    startupFresh,
  }
}
