import type { RedisClientLike } from "@/lib/redis-db"
import {
  buildLivePositionCompatibilitySnapshot,
  LIVE_POSITION_MIRROR_VERSION,
} from "@/lib/live-position-mirror"

/**
 * Retention policy for diagnostics and runtime projections.
 *
 * The live exchange book is deliberately treated differently from
 * diagnostics: active rows must survive a restart until reconciliation proves
 * that they are terminal, while terminal rows and all diagnostic projections
 * are bounded. This module is also used by the maintenance script so the
 * production repair and the recurring startup repair share one policy.
 */
export const VOLUME_DETAIL_RETENTION_SECONDS = 30 * 24 * 60 * 60
export const LIVE_TERMINAL_RETENTION_SECONDS = 30 * 24 * 60 * 60
export const LIVE_FAILURE_RETENTION_SECONDS = 7 * 24 * 60 * 60
export const DIRECT_ORDER_CONTROL_RETENTION_SECONDS = 30 * 24 * 60 * 60
/** Completed Direct-Trade statistics are a rebuildable read model. */
export const DIRECT_STATISTICS_RETENTION_SECONDS = 30 * 24 * 60 * 60
export const SIGNAL_PERFORMANCE_RETENTION_SECONDS = 90 * 24 * 60 * 60
export const BLOCK_PROCESSED_MARKER_RETENTION_SECONDS = 30 * 24 * 60 * 60
export const STRATEGY_RESULT_RING_RETENTION_SECONDS = 90 * 24 * 60 * 60
export const INDICATION_RESULT_RETENTION_SECONDS = 7 * 24 * 60 * 60
export const INDICATION_SNAPSHOT_RETENTION_SECONDS = 24 * 60 * 60
/** Rolling per-Set rows are refreshed by active writers; inactive Sets expire. */
export const INDICATION_SET_RETENTION_SECONDS = 7 * 24 * 60 * 60
export const INDICATION_INDEX_RETENTION_SECONDS = 7 * 24 * 60 * 60
export const INDICATION_OUTCOME_RETENTION_SECONDS = 7 * 24 * 60 * 60
export const PENDING_OUTCOME_RETENTION_SECONDS = 24 * 60 * 60
export const LIVE_ORDER_RETENTION_SECONDS = 7 * 24 * 60 * 60
export const LIVE_TRACKING_RETENTION_SECONDS = 7 * 24 * 60 * 60
export const LIVE_MOVED_MARKER_RETENTION_SECONDS = 60 * 60
export const VOLUME_INDEX_LIMIT = 500
export const LIVE_CLOSED_INDEX_LIMIT = 5_000
export const STRATEGY_RESULT_RING_LIMIT = 600
export const VOLUME_ORPHAN_GRACE_SECONDS = 10 * 60

const TERMINAL_LIVE_STATUSES = new Set([
  "closed",
  "rejected",
  "cancelled",
  "canceled",
  "expired",
  "error",
])

// `filled` is terminal for an exchange-order record, but it is an active
// position lifecycle state until the position later closes. Keep that
// distinction explicit so retention repair cannot move a filled entry into a
// closed-position interpretation or expire its live exposure snapshot.
const TERMINAL_ORDER_STATUSES = new Set([
  ...TERMINAL_LIVE_STATUSES,
  "filled",
  "done",
])

const FAILURE_LIVE_STATUSES = new Set([
  "rejected",
  "cancelled",
  "canceled",
  "expired",
  "error",
])

export type LiveRetentionClass = "active" | "terminal" | "unknown"

export interface RetentionRepairReport {
  scanned: number
  ttlRepaired: number
  compatibilityMirrorsCompacted: number
  terminalRowsBounded: number
  orphanVolumeDetailsDeleted: number
  orphanStrategyMembershipsDeleted: number
  indexesTrimmed: number
  staleIndexMembersRemoved: number
  typeMismatches: number
  errors: number
}

export interface RetentionCursorState {
  [pattern: string]: string | undefined
}

export interface RetentionRepairPageResult {
  report: RetentionRepairReport
  cursors: RetentionCursorState
}

type RetentionKind =
  | "volume-index"
  | "volume-detail"
  | "live-json"
  | "live-pointer"
  | "live-moved-marker"
  | "live-closed-index"
  | "live-hash"
  | "direct-control"
  | "signal-performance"
  | "block-marker"
  | "strategy-ring"
  | "strategy-membership"
  | "indication"
  | "indication-set"
  | "indication-index"
  | "pending-outcomes"
  | "pending-outcome-guard"
  | "live-order"
  | "direct-statistics"

interface RetentionPattern {
  pattern: string
  kind: RetentionKind
}

/**
 * Order matters: volume indexes are visited before orphan detail keys so a
 * detail referenced by the current index is never removed in the same pass.
 */
export const RETENTION_PATTERNS: readonly RetentionPattern[] = [
  { pattern: "volume_calcs:*", kind: "volume-index" },
  { pattern: "volume_calc:*", kind: "volume-detail" },
  { pattern: "live:position:tracking:*", kind: "live-pointer" },
  { pattern: "live:position:*", kind: "live-json" },
  { pattern: "live:positions:*:moved:*", kind: "live-moved-marker" },
  { pattern: "live:positions:*:closed", kind: "live-closed-index" },
  { pattern: "live_positions:*", kind: "live-hash" },
  { pattern: "live:direct_order_control:*", kind: "direct-control" },
  { pattern: "direct_trade:statistics-index", kind: "direct-statistics" },
  { pattern: "direct_trade:*:statistics-index", kind: "direct-statistics" },
  { pattern: "live:order:*", kind: "live-order" },
  { pattern: "signal:performance:*", kind: "signal-performance" },
  { pattern: "block_count_pause_processed:*", kind: "block-marker" },
  { pattern: "strategy_set_result_ring:*", kind: "strategy-ring" },
  { pattern: "strategy_position_set_memberships:*", kind: "strategy-membership" },
  { pattern: "indication_sets:index:*", kind: "indication-index" },
  { pattern: "indication_sets:outcome_keys:index:*", kind: "indication-index" },
  { pattern: "indication_outcomes_pending:*", kind: "pending-outcomes" },
  { pattern: "indication_outcomes_pending_guard:*", kind: "pending-outcome-guard" },
  // This also matches `:outcomes`, `:outcome_stats`, and
  // `:outcome_closed_ids`; the handler classifies those suffixes by type.
  { pattern: "indication_set:*", kind: "indication-set" },
  { pattern: "indication:*", kind: "indication" },
]

function normalizeStatus(value: unknown): string {
  return String(value ?? "").trim().toLowerCase()
}

function recordStatus(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ""
  const record = value as Record<string, unknown>
  return normalizeStatus(record.status ?? record.state ?? record.executionStatus)
}

/** Classify a parsed JSON/object live row without ever guessing active state. */
export function classifyLiveRetention(value: unknown): LiveRetentionClass {
  const status = recordStatus(value)
  if (!status) return "unknown"
  return TERMINAL_LIVE_STATUSES.has(status) ? "terminal" : "active"
}

export function liveRetentionSecondsForStatus(status: unknown): number | null {
  const normalized = normalizeStatus(status)
  if (!TERMINAL_LIVE_STATUSES.has(normalized)) return null
  return FAILURE_LIVE_STATUSES.has(normalized)
    ? LIVE_FAILURE_RETENTION_SECONDS
    : LIVE_TERMINAL_RETENTION_SECONDS
}

export function indicationRetentionSecondsForKey(key: string): number | null {
  const normalized = String(key || "")
  // Configuration definitions and their maintained config index are durable
  // user settings, not rolling indication results.
  if (normalized.endsWith(":configs:index")) return null
  if (normalized.includes(":config:") && !/:results(?::|$)/.test(normalized) && !/:ref(?::|$)/.test(normalized)) {
    return null
  }
  if (/:results(?::|$)/.test(normalized) || /:ref(?::|$)/.test(normalized)) {
    return INDICATION_RESULT_RETENTION_SECONDS
  }
  return INDICATION_SNAPSHOT_RETENTION_SECONDS
}

function emptyReport(): RetentionRepairReport {
  return {
    scanned: 0,
    ttlRepaired: 0,
    compatibilityMirrorsCompacted: 0,
    terminalRowsBounded: 0,
    orphanVolumeDetailsDeleted: 0,
    orphanStrategyMembershipsDeleted: 0,
    indexesTrimmed: 0,
    staleIndexMembersRemoved: 0,
    typeMismatches: 0,
    errors: 0,
  }
}

function addReport(target: RetentionRepairReport, source: RetentionRepairReport): void {
  target.scanned += source.scanned
  target.ttlRepaired += source.ttlRepaired
  target.compatibilityMirrorsCompacted += source.compatibilityMirrorsCompacted
  target.terminalRowsBounded += source.terminalRowsBounded
  target.orphanVolumeDetailsDeleted += source.orphanVolumeDetailsDeleted
  target.orphanStrategyMembershipsDeleted += source.orphanStrategyMembershipsDeleted
  target.indexesTrimmed += source.indexesTrimmed
  target.staleIndexMembersRemoved += source.staleIndexMembersRemoved
  target.typeMismatches += source.typeMismatches
  target.errors += source.errors
}

async function hasExpectedType(
  client: RedisClientLike,
  key: string,
  expected: string,
  report: RetentionRepairReport,
): Promise<boolean> {
  if (typeof client.type !== "function") return true
  try {
    const actual = String(await client.type(key))
    if (actual === "none" || actual === expected) return actual === expected
    report.typeMismatches++
    return false
  } catch {
    // The type command is an optional adapter capability. If an older adapter
    // cannot answer it, the operation below remains guarded by the caller's
    // existing error boundary.
    return true
  }
}

async function hasAnyExpectedType(
  client: RedisClientLike,
  key: string,
  expected: readonly string[],
  report: RetentionRepairReport,
): Promise<boolean> {
  if (typeof client.type !== "function") return true
  try {
    const actual = String(await client.type(key))
    if (actual === "none" || expected.includes(actual)) return actual !== "none"
    report.typeMismatches++
    return false
  } catch {
    return true
  }
}

function normalizeScanResult(result: any): { cursor: string; keys: string[] } {
  if (Array.isArray(result)) {
    return {
      cursor: String(result[0] ?? "0"),
      keys: Array.isArray(result[1]) ? result[1].map(String) : [],
    }
  }
  return {
    cursor: String(result?.cursor ?? "0"),
    keys: Array.isArray(result?.keys) ? result.keys.map(String) : [],
  }
}

function normalizeSetScanResult(result: any): { cursor: string; members: string[] } {
  if (Array.isArray(result)) {
    return {
      cursor: String(result[0] ?? "0"),
      members: Array.isArray(result[1]) ? result[1].map(String) : [],
    }
  }
  return {
    cursor: String(result?.cursor ?? "0"),
    members: Array.isArray(result?.members)
      ? result.members.map(String)
      : Array.isArray(result?.values)
        ? result.values.map(String)
        : [],
  }
}

async function scanSetPage(
  client: RedisClientLike,
  key: string,
  cursor: string,
  count: number,
  match?: string,
): Promise<{ cursor: string; members: string[] }> {
  const sscan = (client as any).sscan
  if (typeof sscan === "function") {
    const args = match
      ? ["MATCH", match, "COUNT", count]
      : ["COUNT", count]
    return normalizeSetScanResult(await sscan.call(client, key, cursor, ...args))
  }
  // All built-in adapters implement SSCAN. This fallback is for small test
  // doubles and older third-party adapters only; it remains bounded before
  // returning the first page so a missing SSCAN cannot create another giant
  // materialisation in the retention worker.
  const members = typeof client.smembers === "function" ? await client.smembers(key) : []
  const filtered = match
    ? members.filter((member) => String(member).startsWith(match.replace(/\\\*/g, "*")))
    : members
  const start = Math.max(0, Number(cursor) || 0)
  const page = filtered.slice(start, start + count)
  const next = start + page.length >= filtered.length ? "0" : String(start + page.length)
  return { cursor: next, members: page }
}

async function boundedWorkers<T>(
  values: readonly T[],
  worker: (value: T) => Promise<void>,
  concurrency = 24,
): Promise<void> {
  let next = 0
  const workerCount = Math.min(Math.max(1, concurrency), values.length)
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++
      if (index >= values.length) return
      await worker(values[index])
    }
  }))
}

async function scanPage(
  client: RedisClientLike,
  pattern: string,
  cursor: string,
  count: number,
): Promise<{ cursor: string; keys: string[] }> {
  if (typeof client.scan !== "function") {
    const keys = typeof client.keys === "function" ? await client.keys(pattern) : []
    return { cursor: "0", keys: keys.slice(0, count).map(String) }
  }
  return normalizeScanResult(await client.scan(cursor, "MATCH", pattern, "COUNT", count))
}

interface VolumeReferenceState {
  references: Set<string>
  complete: boolean
}

const MAX_VOLUME_INDEX_SCAN_PAGES = 64

async function loadVolumeReferences(client: RedisClientLike): Promise<VolumeReferenceState> {
  const references = new Set<string>()
  const keys: string[] = []
  let cursor = "0"
  let pages = 0
  let complete = true
  const visitedCursors = new Set<string>()
  do {
    if (visitedCursors.has(cursor)) {
      complete = false
      break
    }
    visitedCursors.add(cursor)
    const result = await scanPage(client, "volume_calcs:*", cursor, 250)
    cursor = result.cursor
    keys.push(...result.keys)
    pages++
    if (pages >= MAX_VOLUME_INDEX_SCAN_PAGES && cursor !== "0") {
      complete = false
      break
    }
  } while (cursor !== "0")

  await boundedWorkers(keys, async (key) => {
    try {
      const raw = await client.get(key)
      if (!raw) {
        complete = false
        return
      }
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        complete = false
        return
      }
      const connectionId = key.slice("volume_calcs:".length)
      for (const value of parsed.slice(0, VOLUME_INDEX_LIMIT)) {
        const id = String(value || "").trim()
        if (id) references.add(`volume_calc:${connectionId}:${id}`)
      }
    } catch {
      // The repair remains best-effort; a malformed index never authorizes a
      // detail deletion.
      complete = false
    }
  }, 8)
  return { references, complete }
}

async function ensureTtl(
  client: RedisClientLike,
  key: string,
  seconds: number,
  report: RetentionRepairReport,
): Promise<void> {
  const ttl = await client.ttl(key)
  if (ttl >= 0 || ttl === -2) return
  if (await client.expire(key, seconds)) report.ttlRepaired++
}

async function repairVolumeIndex(
  client: RedisClientLike,
  key: string,
  report: RetentionRepairReport,
  apply: boolean,
): Promise<void> {
  if (!await hasExpectedType(client, key, "string", report)) return
  const raw = await client.get(key)
  let parsed: unknown = null
  try { parsed = raw ? JSON.parse(raw) : null } catch { parsed = null }
  if (Array.isArray(parsed) && parsed.length > VOLUME_INDEX_LIMIT && apply) {
    await client.set(key, JSON.stringify(parsed.slice(0, VOLUME_INDEX_LIMIT)), {
      EX: VOLUME_DETAIL_RETENTION_SECONDS,
    })
    report.indexesTrimmed++
    return
  }
  if (apply) await ensureTtl(client, key, VOLUME_DETAIL_RETENTION_SECONDS, report)
}

async function repairVolumeDetail(
  client: RedisClientLike,
  key: string,
  volumeReferences: VolumeReferenceState,
  report: RetentionRepairReport,
  apply: boolean,
): Promise<void> {
  if (!await hasExpectedType(client, key, "string", report)) return
  const ttl = await client.ttl(key)
  if (ttl === -2) return
  if (volumeReferences.references.has(key)) {
    if (apply && ttl < 0) await ensureTtl(client, key, VOLUME_DETAIL_RETENTION_SECONDS, report)
    return
  }

  // A detail is only an orphan after the writer had enough time to publish the
  // index. This grace period prevents a concurrent detail→index write from
  // being deleted between its two commands.
  let createdAt = 0
  try {
    const raw = await client.get(key)
    const parsed = raw ? JSON.parse(raw) : null
    createdAt = Date.parse(parsed?.created_at ?? parsed?.createdAt ?? parsed?.timestamp ?? "")
  } catch {
    report.errors++
  }
  const oldEnough = Number.isFinite(createdAt) && Date.now() - createdAt > VOLUME_ORPHAN_GRACE_SECONDS * 1000
  if (oldEnough && volumeReferences.complete) {
    if (apply && await client.del(key)) report.orphanVolumeDetailsDeleted++
    return
  }
  if (apply && ttl < 0) await ensureTtl(client, key, VOLUME_DETAIL_RETENTION_SECONDS, report)
}

async function repairLiveJson(
  client: RedisClientLike,
  key: string,
  report: RetentionRepairReport,
  apply: boolean,
): Promise<void> {
  if (key.startsWith("live:position:tracking:")) return
  if (!await hasExpectedType(client, key, "string", report)) return
  const raw = await client.get(key)
  if (!raw) return
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return

  // A hash-backed position can be compacted safely: the hash is the complete
  // ledger, while the string key is only a compatibility/recovery projection.
  // Never compact a JSON-only row because that would discard its only copy of
  // fills and Set attribution.
  const parsedRecord = parsed as Record<string, unknown>
  const mirrorVersion = Number(parsedRecord.liveMirrorVersion || 0)
  if (mirrorVersion === LIVE_POSITION_MIRROR_VERSION) {
    // Canonical writers update the hash and mirror in one ordered save path.
    // A current compact mirror needs no large HGETALL on every five-minute
    // sweep; the hash retention pass below only reads its scalar status.
    const classification = classifyLiveRetention(parsedRecord)
    if (apply && classification === "terminal") {
      const seconds = liveRetentionSecondsForStatus(recordStatus(parsedRecord))
      if (seconds) await ensureTtl(client, key, seconds, report)
    } else if (apply && classification === "active") {
      await client.persist(key).catch(() => 0)
    }
    return
  }
  const positionId = key.slice("live:position:".length)
  const connectionId = String(
    parsedRecord.connectionId ??
    parsedRecord.connection_id ??
    positionId.match(/^live:([^:]+):/)?.[1] ??
    "",
  ).trim()
  let hash: Record<string, unknown> | null = null
  if (connectionId && typeof client.hgetall === "function") {
    const candidate = await client
      .hgetall(`live_positions:${connectionId}:${positionId}`)
      .catch(() => null)
    if (candidate && Object.keys(candidate).length > 0) hash = candidate
  }
  const hashVersion = Number(hash?.version || 0)
  const jsonVersion = Number(parsedRecord.version || 0)
  const hashUpdatedAt = Number(hash?.updatedAt || 0)
  const jsonUpdatedAt = Number(parsedRecord.updatedAt || 0)
  const hashIsAtLeastAsRecent = !!hash && (
    hashVersion > jsonVersion ||
    (hashVersion === jsonVersion && hashUpdatedAt >= jsonUpdatedAt)
  )
  const source: Record<string, unknown> = hashIsAtLeastAsRecent && hash
    ? hash
    : parsedRecord
  const classification = classifyLiveRetention(source)
  if (apply && hashIsAtLeastAsRecent && hash) {
    const mirror = buildLivePositionCompatibilitySnapshot(source)
    const encodedMirror = JSON.stringify(mirror)
    if (encodedMirror !== raw) {
      await client.set(
        key,
        encodedMirror,
        classification === "terminal"
          ? { EX: liveRetentionSecondsForStatus(recordStatus(source)) || LIVE_TERMINAL_RETENTION_SECONDS }
          : undefined,
      )
      report.compatibilityMirrorsCompacted++
    }
    if (classification !== "terminal") await client.persist(key).catch(() => 0)
  }
  if (classification !== "terminal") return
  const seconds = liveRetentionSecondsForStatus(recordStatus(source))
  if (!seconds || !apply) return
  const before = await client.ttl(key)
  await ensureTtl(client, key, seconds, report)
  if (before < 0) report.terminalRowsBounded++
}

async function repairLiveClosedIndex(
  client: RedisClientLike,
  key: string,
  report: RetentionRepairReport,
  apply: boolean,
): Promise<void> {
  const length = await client.llen(key)
  if (length <= LIVE_CLOSED_INDEX_LIMIT) return
  if (apply) {
    await client.ltrim(key, 0, LIVE_CLOSED_INDEX_LIMIT - 1)
    report.indexesTrimmed++
  }
}

async function repairLiveHash(
  client: RedisClientLike,
  key: string,
  report: RetentionRepairReport,
  apply: boolean,
): Promise<void> {
  const status = typeof client.hget === "function"
    ? await client.hget(key, "status").catch(() => null)
    : null
  const classification = classifyLiveRetention({ status })
  if (classification === "active") {
    if (apply) await client.persist(key).catch(() => 0)
    return
  }
  if (classification !== "terminal") return
  const seconds = liveRetentionSecondsForStatus(status)
  if (!seconds || !apply) return
  const before = await client.ttl(key)
  await ensureTtl(client, key, seconds, report)
  if (before < 0) report.terminalRowsBounded++
}

function indicationSetRetentionForKey(key: string): number {
  if (key.endsWith(":outcomes") || key.endsWith(":outcome_stats") || key.endsWith(":outcome_closed_ids")) {
    return INDICATION_OUTCOME_RETENTION_SECONDS
  }
  return INDICATION_SET_RETENTION_SECONDS
}

async function repairIndicationSet(
  client: RedisClientLike,
  key: string,
  report: RetentionRepairReport,
  apply: boolean,
): Promise<void> {
  const expected = key.endsWith(":outcome_stats")
    ? ["hash"]
    : key.endsWith(":outcome_closed_ids")
      ? ["set"]
      : key.endsWith(":outcomes")
        ? ["list"]
        : ["list", "string"]
  if (!await hasAnyExpectedType(client, key, expected, report)) return
  if (apply) await ensureTtl(client, key, indicationSetRetentionForKey(key), report)
}

async function repairIndicationIndex(
  client: RedisClientLike,
  key: string,
  report: RetentionRepairReport,
  apply: boolean,
  cursors: RetentionCursorState,
): Promise<void> {
  if (!await hasExpectedType(client, key, "set", report)) return
  if (apply) await ensureTtl(client, key, INDICATION_INDEX_RETENTION_SECONDS, report)

  // Indexes can contain hundreds of thousands of members. Never use
  // SMEMBERS in the production path: SSCAN keeps both Redis and Node memory
  // bounded and lets the next repair page continue from the last cursor.
  const memberCursorKey = `__setindex__:${key}`
  const cursor = String(cursors[memberCursorKey] ?? "0")
  const page = await scanSetPage(client, key, cursor, 500)
  cursors[memberCursorKey] = page.cursor
  if (page.members.length === 0 || !apply) return

  const stale: string[] = []
  await boundedWorkers(page.members, async (member) => {
    const validPrefix = member.startsWith("indication_set:")
    if (!validPrefix || !(await client.exists(member).catch(() => 0))) stale.push(member)
  }, 24)
  if (stale.length > 0) {
    const removed = await client.srem(key, ...stale)
    report.staleIndexMembersRemoved += Number(removed) || 0
  }
}

function escapeRedisGlob(value: string): string {
  return value.replace(/([\\*?\[\]])/g, "\\$1")
}

/**
 * A membership Set is deliberately durable while its position is active. A
 * missing membership cleanup is only removable when the close ledger already
 * contains an exact position identity. This prevents a concurrent entry from
 * losing its Set rows during the short interval between membership admission
 * and the first live-position snapshot.
 */
async function hasStrategyCloseEvidence(
  client: RedisClientLike,
  connectionId: string,
  positionId: string,
): Promise<boolean> {
  if (typeof client.type !== "function" || typeof client.sscan !== "function") return false
  const closeIdsKey = `strategy_set_close_ids:${connectionId}`
  if (String(await client.type(closeIdsKey).catch(() => "none")) !== "set") return false
  const prefix = `${positionId}|`
  const match = `${escapeRedisGlob(prefix)}*`
  let cursor = "0"
  const visited = new Set<string>()
  for (let pageIndex = 0; pageIndex < 16; pageIndex++) {
    if (visited.has(cursor)) return false
    visited.add(cursor)
    const page = await scanSetPage(client, closeIdsKey, cursor, 250, match)
    if (page.members.some((member) => String(member).startsWith(prefix))) return true
    cursor = page.cursor
    if (cursor === "0") return false
  }
  // A bounded repair must fail closed when a very large close ledger did not
  // expose the requested member within its budget.
  return false
}

type CanonicalLiveState = "absent" | "active" | "terminal" | "unknown"

async function canonicalLiveState(
  client: RedisClientLike,
  connectionId: string,
  positionId: string,
): Promise<CanonicalLiveState> {
  if (typeof client.type !== "function") return "unknown"
  const hashKey = `live_positions:${connectionId}:${positionId}`
  const hashType = String(await client.type(hashKey).catch(() => "unknown"))
  if (hashType === "hash") {
    const status = await client.hget(hashKey, "status").catch(() => null)
    if (!status) return "unknown"
    return classifyLiveRetention({ status }) === "terminal" ? "terminal" : "active"
  }
  if (hashType !== "none") return "unknown"

  const jsonKey = `live:position:${positionId}`
  const jsonType = String(await client.type(jsonKey).catch(() => "unknown"))
  if (jsonType === "none") return "absent"
  if (jsonType !== "string") return "unknown"
  const raw = await client.get(jsonKey).catch(() => null)
  if (!raw) return "absent"
  try {
    const parsed = JSON.parse(raw)
    const classification = classifyLiveRetention(parsed)
    return classification === "terminal" ? "terminal" : classification === "active" ? "active" : "unknown"
  } catch {
    return "unknown"
  }
}

async function repairStrategyMembership(
  client: RedisClientLike,
  key: string,
  report: RetentionRepairReport,
  apply: boolean,
): Promise<void> {
  const prefix = "strategy_position_set_memberships:"
  const rest = key.slice(prefix.length)
  const separator = rest.indexOf(":")
  if (separator <= 0 || separator >= rest.length - 1) return
  if (!await hasExpectedType(client, key, "set", report)) return

  const connectionId = rest.slice(0, separator)
  const positionId = rest.slice(separator + 1)
  if (!await hasStrategyCloseEvidence(client, connectionId, positionId)) return

  const state = await canonicalLiveState(client, connectionId, positionId)
  // Active and ambiguous state always wins. Terminal/absent state is safe only
  // after the close ledger has proved that the Set outcomes were booked.
  if (state === "active" || state === "unknown") return
  if (apply && await client.del(key)) report.orphanStrategyMembershipsDeleted++
}

async function repairPendingOutcome(
  client: RedisClientLike,
  key: string,
  report: RetentionRepairReport,
  apply: boolean,
  expected: string,
): Promise<void> {
  if (!await hasExpectedType(client, key, expected, report)) return
  if (apply) await ensureTtl(client, key, PENDING_OUTCOME_RETENTION_SECONDS, report)
}

async function repairLiveOrder(
  client: RedisClientLike,
  key: string,
  report: RetentionRepairReport,
  apply: boolean,
): Promise<void> {
  if (typeof client.type !== "function") return
  let actual = ""
  try { actual = String(await client.type(key)) } catch { return }
  if (actual === "none") return
  if (actual !== "string" && actual !== "hash") {
    report.typeMismatches++
    return
  }
  let value: unknown
  try {
    value = actual === "hash"
      ? await client.hgetall(key)
      : JSON.parse(String(await client.get(key) || ""))
  } catch {
    return
  }
  const status = recordStatus(value)
  const classification = TERMINAL_ORDER_STATUSES.has(status) ? "terminal" : status ? "active" : "unknown"
  if (classification !== "terminal") return
  const seconds = liveRetentionSecondsForStatus(status) || LIVE_ORDER_RETENTION_SECONDS
  if (!seconds || !apply) return
  const before = await client.ttl(key)
  await ensureTtl(client, key, Math.min(seconds, LIVE_ORDER_RETENTION_SECONDS), report)
  if (before < 0) report.terminalRowsBounded++
}

async function repairOneKey(
  client: RedisClientLike,
  key: string,
  kind: RetentionKind,
  volumeReferences: VolumeReferenceState,
  report: RetentionRepairReport,
  apply: boolean,
  cursors: RetentionCursorState,
): Promise<void> {
  report.scanned++
  if (kind === "volume-index") return repairVolumeIndex(client, key, report, apply)
  if (kind === "volume-detail") return repairVolumeDetail(client, key, volumeReferences, report, apply)
  if (kind === "live-json") return repairLiveJson(client, key, report, apply)
  if (kind === "live-pointer") {
    if (!await hasExpectedType(client, key, "string", report)) return
    if (apply) await ensureTtl(client, key, LIVE_TRACKING_RETENTION_SECONDS, report)
    return
  }
  if (kind === "live-moved-marker") {
    if (!await hasExpectedType(client, key, "string", report)) return
    if (apply) await ensureTtl(client, key, LIVE_MOVED_MARKER_RETENTION_SECONDS, report)
    return
  }
  if (kind === "live-closed-index") {
    if (!await hasExpectedType(client, key, "list", report)) return
    return repairLiveClosedIndex(client, key, report, apply)
  }
  if (kind === "live-hash") {
    if (!await hasExpectedType(client, key, "hash", report)) return
    return repairLiveHash(client, key, report, apply)
  }
  if (kind === "live-order") return repairLiveOrder(client, key, report, apply)
  if (kind === "strategy-membership") return repairStrategyMembership(client, key, report, apply)
  if (kind === "indication-set") return repairIndicationSet(client, key, report, apply)
  if (kind === "indication-index") return repairIndicationIndex(client, key, report, apply, cursors)
  if (kind === "pending-outcomes") return repairPendingOutcome(client, key, report, apply, "list")
  if (kind === "pending-outcome-guard") return repairPendingOutcome(client, key, report, apply, "set")
  if (!apply) return

  const seconds =
    kind === "direct-control" ? DIRECT_ORDER_CONTROL_RETENTION_SECONDS
      : kind === "direct-statistics" ? DIRECT_STATISTICS_RETENTION_SECONDS
      : kind === "signal-performance" ? SIGNAL_PERFORMANCE_RETENTION_SECONDS
        : kind === "block-marker" ? BLOCK_PROCESSED_MARKER_RETENTION_SECONDS
          : kind === "strategy-ring" ? STRATEGY_RESULT_RING_RETENTION_SECONDS
            : indicationRetentionSecondsForKey(key)
  if (!seconds) return
  if (kind === "strategy-ring") {
    // Result rings are lists in the canonical schema. A legacy wrong-type key
    // is still safe to expire; the LTRIM failure is intentionally ignored.
    await client.ltrim(key, 0, STRATEGY_RESULT_RING_LIMIT - 1).catch(() => undefined)
  }
  await ensureTtl(client, key, seconds, report)
}

/**
 * Repair one bounded SCAN page for every family. The caller retains cursors,
 * so recurring repair covers the whole keyspace without a giant KEYS call or
 * an unbounded Promise.all. `apply=false` makes the same routine a dry-run.
 */
export async function repairRedisRetentionPage(
  client: RedisClientLike,
  options: {
    cursors?: RetentionCursorState
    completedPatterns?: ReadonlySet<string>
    pageSize?: number
    apply?: boolean
  } = {},
): Promise<RetentionRepairPageResult> {
  const pageSize = Math.min(500, Math.max(25, Math.floor(options.pageSize ?? 250)))
  const apply = options.apply !== false
  const cursors: RetentionCursorState = { ...(options.cursors || {}) }
  const report = emptyReport()
  const volumeReferences = await loadVolumeReferences(client)

  for (const descriptor of RETENTION_PATTERNS) {
    if (options.completedPatterns?.has(descriptor.pattern)) continue
    const cursor = String(cursors[descriptor.pattern] ?? "0")
    let result: { cursor: string; keys: string[] }
    try {
      result = await scanPage(client, descriptor.pattern, cursor, pageSize)
    } catch {
      report.errors++
      continue
    }
    cursors[descriptor.pattern] = result.cursor
    await boundedWorkers(result.keys, async (key) => {
      try {
        await repairOneKey(client, key, descriptor.kind, volumeReferences, report, apply, cursors)
      } catch {
        report.errors++
      }
    })
  }
  return { report, cursors }
}

/** Run a complete bounded SCAN cycle, primarily for the maintenance script. */
export async function repairRedisRetentionAll(
  client: RedisClientLike,
  options: { pageSize?: number; apply?: boolean; maxPages?: number } = {},
): Promise<RetentionRepairReport> {
  const aggregate = emptyReport()
  const cursors: RetentionCursorState = {}
  const completedPatterns = new Set<string>()
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? 10_000))
  for (let page = 0; page < maxPages; page++) {
    const result = await repairRedisRetentionPage(client, {
      cursors,
      completedPatterns,
      pageSize: options.pageSize,
      apply: options.apply,
    })
    addReport(aggregate, result.report)
    Object.assign(cursors, result.cursors)
    for (const descriptor of RETENTION_PATTERNS) {
      if (cursors[descriptor.pattern] === "0") completedPatterns.add(descriptor.pattern)
    }
    if (completedPatterns.size === RETENTION_PATTERNS.length) break
  }
  return aggregate
}
