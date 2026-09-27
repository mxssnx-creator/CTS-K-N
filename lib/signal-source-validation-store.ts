import { getRedisClient, initRedis } from "@/lib/redis-db"
import type {
  SignalDispatchSnapshotView,
  SignalSourceRankingChange,
  SignalSourceRankingEntry,
  SignalSourceStatus,
} from "@/lib/signal-source-validation"

/**
 * Persistence for source-validation snapshots and the optimizer audit trail.
 * Kept separate from lib/signal-source-optimizer.ts so the dispatch path in
 * lib/signal-indication.ts can read snapshots without an import cycle.
 */

export const SIGNAL_SOURCE_AUDIT_MAX = 200
const SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60
const SNAPSHOT_CACHE_MS = 30_000

export interface SignalSourceValidationSnapshot {
  connectionId: string
  hourKey: string
  generatedAt: number
  trigger: "engine_start" | "hourly" | "manual"
  capacity: number
  activeCount: number
  validatedCount: number
  entries: SignalSourceRankingEntry[]
}

export interface SignalSourceAuditRecord {
  connectionId: string
  hourKey: string
  generatedAt: number
  trigger: SignalSourceValidationSnapshot["trigger"]
  capacity: number
  activeCount: number
  validatedCount: number
  outcomeCount: number
  replayOutcomeCount: number
  changes: SignalSourceRankingChange[]
  durationMs: number
}

function safePart(value: string): string {
  return String(value || "unknown").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "unknown"
}

export function signalSourceSnapshotKey(connectionId: string): string {
  return `signal:source_validation:${safePart(connectionId)}:snapshot`
}

export function signalSourceAuditKey(connectionId: string): string {
  return `signal:source_validation:${safePart(connectionId)}:audit`
}

export function signalSourceHourLockKey(connectionId: string, hourKey: string): string {
  return `signal:source_validation:${safePart(connectionId)}:hour:${hourKey}`
}

export function utcHourKey(now: number): string {
  return new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString().slice(0, 13)
}

const globalStore = globalThis as typeof globalThis & {
  __signalSourceSnapshotCache?: Map<string, { expiresAt: number; snapshot: SignalSourceValidationSnapshot | null }>
}
const SNAPSHOT_CACHE = globalStore.__signalSourceSnapshotCache ??
  (globalStore.__signalSourceSnapshotCache = new Map())

export function invalidateSignalSourceSnapshotCache(connectionId?: string): void {
  if (connectionId) SNAPSHOT_CACHE.delete(safePart(connectionId))
  else SNAPSHOT_CACHE.clear()
}

export async function readSignalSourceSnapshot(
  connectionId: string,
  options: { useCache?: boolean; now?: number } = {},
): Promise<SignalSourceValidationSnapshot | null> {
  const now = options.now ?? Date.now()
  const cacheKey = safePart(connectionId)
  const cached = SNAPSHOT_CACHE.get(cacheKey)
  if (options.useCache !== false && cached && cached.expiresAt > now) return cached.snapshot
  await initRedis()
  const raw = await getRedisClient().get(signalSourceSnapshotKey(connectionId)).catch(() => null)
  let snapshot: SignalSourceValidationSnapshot | null = null
  if (typeof raw === "string" && raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.entries)) snapshot = parsed
    } catch {
      snapshot = null
    }
  }
  SNAPSHOT_CACHE.set(cacheKey, { expiresAt: now + SNAPSHOT_CACHE_MS, snapshot })
  return snapshot
}

export async function writeSignalSourceSnapshot(
  snapshot: SignalSourceValidationSnapshot,
  audit: SignalSourceAuditRecord,
): Promise<void> {
  await initRedis()
  const client = getRedisClient()
  await client.set(signalSourceSnapshotKey(snapshot.connectionId), JSON.stringify(snapshot), {
    EX: SNAPSHOT_TTL_SECONDS,
  })
  const auditKey = signalSourceAuditKey(snapshot.connectionId)
  await client.lpush(auditKey, JSON.stringify(audit))
  await client.ltrim(auditKey, 0, SIGNAL_SOURCE_AUDIT_MAX - 1)
  await client.expire(auditKey, SNAPSHOT_TTL_SECONDS * 4).catch(() => 0)
  SNAPSHOT_CACHE.set(safePart(snapshot.connectionId), {
    expiresAt: Date.now() + SNAPSHOT_CACHE_MS,
    snapshot,
  })
}

export async function readSignalSourceAudit(
  connectionId: string,
  limit = 48,
): Promise<SignalSourceAuditRecord[]> {
  await initRedis()
  const rows = await getRedisClient()
    .lrange(signalSourceAuditKey(connectionId), 0, Math.max(0, Math.min(SIGNAL_SOURCE_AUDIT_MAX, limit) - 1))
    .catch((): string[] => [])
  const records: SignalSourceAuditRecord[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    try {
      records.push(JSON.parse(String(row)))
    } catch {
      // Skip corrupt audit rows; they are diagnostic only.
    }
  }
  return records
}

export function snapshotDispatchView(
  snapshot: SignalSourceValidationSnapshot | null,
): SignalDispatchSnapshotView | null {
  if (!snapshot) return null
  const statuses = new Map<string, SignalSourceStatus>()
  const ranks = new Map<string, number>()
  const negativeHoursUtc = new Map<string, readonly number[]>()
  for (const entry of snapshot.entries) {
    statuses.set(entry.sourceId, entry.status)
    if (entry.rank !== null && entry.rank !== undefined) ranks.set(entry.sourceId, entry.rank)
    negativeHoursUtc.set(entry.sourceId, entry.negativeHoursUtc || [])
  }
  return { statuses, ranks, negativeHoursUtc }
}
