import type { RedisClientLike } from "@/lib/redis-db"

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
export const SIGNAL_PERFORMANCE_RETENTION_SECONDS = 90 * 24 * 60 * 60
export const BLOCK_PROCESSED_MARKER_RETENTION_SECONDS = 30 * 24 * 60 * 60
export const STRATEGY_RESULT_RING_RETENTION_SECONDS = 90 * 24 * 60 * 60
export const INDICATION_RESULT_RETENTION_SECONDS = 7 * 24 * 60 * 60
export const INDICATION_SNAPSHOT_RETENTION_SECONDS = 24 * 60 * 60
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
  terminalRowsBounded: number
  orphanVolumeDetailsDeleted: number
  indexesTrimmed: number
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
  | "indication"

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
  { pattern: "signal:performance:*", kind: "signal-performance" },
  { pattern: "block_count_pause_processed:*", kind: "block-marker" },
  { pattern: "strategy_set_result_ring:*", kind: "strategy-ring" },
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
    terminalRowsBounded: 0,
    orphanVolumeDetailsDeleted: 0,
    indexesTrimmed: 0,
    errors: 0,
  }
}

function addReport(target: RetentionRepairReport, source: RetentionRepairReport): void {
  target.scanned += source.scanned
  target.ttlRepaired += source.ttlRepaired
  target.terminalRowsBounded += source.terminalRowsBounded
  target.orphanVolumeDetailsDeleted += source.orphanVolumeDetailsDeleted
  target.indexesTrimmed += source.indexesTrimmed
  target.errors += source.errors
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
  const raw = await client.get(key)
  if (!raw) return
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return }
  const classification = classifyLiveRetention(parsed)
  if (classification !== "terminal") return
  const seconds = liveRetentionSecondsForStatus(recordStatus(parsed))
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
  const raw = await client.hgetall(key)
  const classification = classifyLiveRetention(raw)
  if (classification !== "terminal") return
  const seconds = liveRetentionSecondsForStatus(recordStatus(raw))
  if (!seconds || !apply) return
  const before = await client.ttl(key)
  await ensureTtl(client, key, seconds, report)
  if (before < 0) report.terminalRowsBounded++
}

async function repairOneKey(
  client: RedisClientLike,
  key: string,
  kind: RetentionKind,
  volumeReferences: VolumeReferenceState,
  report: RetentionRepairReport,
  apply: boolean,
): Promise<void> {
  report.scanned++
  if (kind === "volume-index") return repairVolumeIndex(client, key, report, apply)
  if (kind === "volume-detail") return repairVolumeDetail(client, key, volumeReferences, report, apply)
  if (kind === "live-json") return repairLiveJson(client, key, report, apply)
  if (kind === "live-pointer") {
    if (apply) await ensureTtl(client, key, LIVE_TRACKING_RETENTION_SECONDS, report)
    return
  }
  if (kind === "live-moved-marker") {
    if (apply) await ensureTtl(client, key, LIVE_MOVED_MARKER_RETENTION_SECONDS, report)
    return
  }
  if (kind === "live-closed-index") return repairLiveClosedIndex(client, key, report, apply)
  if (kind === "live-hash") return repairLiveHash(client, key, report, apply)
  if (!apply) return

  const seconds =
    kind === "direct-control" ? DIRECT_ORDER_CONTROL_RETENTION_SECONDS
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
        await repairOneKey(client, key, descriptor.kind, volumeReferences, report, apply)
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
