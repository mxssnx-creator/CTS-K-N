Warning: truncated output (original token count: 52942)
Total output lines: 5041

import {
  ensureUniqueSiteInstanceWithClient,
  GLOBAL_SITE_INSTANCE_KEY,
  GLOBAL_SITE_INSTANCE_ID_KEY,
} from "./site-instance"
import {
  removeConnectionSecondaryIndexes,
  syncConnectionSecondaryIndexes,
} from "./database-indexes"
import { createKiloDatabaseQuery, type KiloDatabaseMethod } from "./kilo-database-client"
import { scanRedisKeys } from "./redis-scan"

/**
 * Redis Database Layer - High Performance Edition v3.0
 * In-memory Redis client for Next.js runtime
 * Handles all database operations for connections, trades, positions, settings
 * Optimized for 80K+ ops/sec with logging disabled
 * @version 3.0.0 - Cache rebuild forced
 *
 * IMPORTANT: This file must NOT import 'fs' or 'path' as it's used by client components
 */

// Force webpack cache invalidation
const REDIS_DB_VERSION = "3.0.0"
void REDIS_DB_VERSION

interface SortedSetEntry {
  score: number
  member: string
}

interface SortedSetData {
  entries: SortedSetEntry[]
  memberIndex: Map<string, SortedSetEntry>
}

interface RedisData {
  strings: Map<string, string>
  hashes: Map<string, Record<string, string>>
  sets: Map<string, Set<string>>
  lists: Map<string, string[]>
  sorted_sets: Map<string, SortedSetData>
  ttl: Map<string, number> // key -> expiration timestamp in ms
  requestStats: {
    lastSecond: number
    requestCount: number
    operationsPerSecond: number
  }
}

// Global storage for persistence across hot reloads
const globalForRedis = globalThis as unknown as {
  __redis_data?: RedisData
  // In-flight guard for loadFromDisk — ensures concurrent initRedis() calls
  // from different module scopes share a single disk-read rather than racing
  // to overwrite each other's post-migration state.
  __redis_load_promise?: Promise<boolean>
  // In-flight guard for the CORE init (client construction + snapshot load +
  // ping), shared across module scopes. Migrations call ensureCoreRedis()
  // instead of initRedis() so the init→runMigrations→init cycle can't deadlock.
  __redis_core_promise?: Promise<void>
  // In-flight guard for the FULL init (core + migrations). All callers await
  // this single promise, so no request proceeds with un-migrated data — the
  // race that existed when isConnected flipped true before migrations ran.
  __redis_init_promise?: Promise<void>
  // True once the on-disk snapshot has been loaded (or confirmed absent) for
  // this process. Gated on its own flag — not on the presence of __redis_data —
  // because the constructor always creates the data maps, so a sync getter that
  // builds the instance early would otherwise make the loader think the
  // snapshot was already applied and skip it, booting with an empty store.
  __redis_snapshot_loaded?: boolean
  // Process-global snapshot state. Next production route bundles can evaluate
  // this module more than once inside one PID; class statics are therefore not
  // a sufficient mutex or generation counter.
  __redis_snapshot_save_promise?: Promise<boolean>
  __redis_snapshot_mutation_version?: number
  __redis_snapshot_persisted_version?: number
  __redis_snapshot_write_counter?: number
  __redis_persistence_tick_started?: boolean
  __redis_persistence_signals_attached?: boolean
  __redis_snapshot_last_error_warn?: number
  // Global equivalent of the module-scoped `isConnected` flag. Allows fresh
  // Next.js dev route modules (which re-evaluate and get isConnected=false) to
  // see the real connected state without re-running initRedis/migrations.
  __redis_fully_connected?: boolean
  __redis_backend?: RedisBackend
  __redis_volatile_startup_cleanup_ran?: boolean
  __connection_state_queues?: Map<string, Promise<void>>
  __kilo_snapshot_revision?: number
  __kilo_snapshot_last_synced_at?: number
  __kilo_snapshot_schema_promise?: Promise<void>
  __kilo_snapshot_refresh_promise?: Promise<boolean>
  __kilo_database_query?: (
    sql: string,
    params: unknown[],
    method: KiloDatabaseMethod,
  ) => Promise<{ rows: unknown[] | unknown[][] }>
}

export type RedisBackend = "inline-local" | "redis-network" | "kilo-sqlite-snapshot"

const KILO_SNAPSHOT_TABLE = "cts_runtime_snapshot"

function hasKiloManagedDatabaseConfig(): boolean {
  return Boolean(process.env.DB_URL && process.env.DB_TOKEN)
}

async function executeKiloDatabaseQuery(
  sql: string,
  params: unknown[] = [],
  method: KiloDatabaseMethod = "all",
): Promise<any[]> {
  const url = String(process.env.DB_URL || "").trim()
  const token = String(process.env.DB_TOKEN || "").trim()
  if (!url || !token) throw new Error("Kilo managed database credentials are not configured")

  if (!globalForRedis.__kilo_database_query) {
    globalForRedis.__kilo_database_query = createKiloDatabaseQuery({ url, token })
  }
  const payload = await globalForRedis.__kilo_database_query(sql, params, method)
  if (Array.isArray(payload?.rows)) return payload.rows as any[]
  return []
}

function databaseRowValue(row: any, name: string, index: number): unknown {
  if (row && !Array.isArray(row) && typeof row === "object") return row[name]
  if (Array.isArray(row)) return row[index]
  return undefined
}

async function ensureKiloSnapshotSchema(): Promise<void> {
  if (!hasKiloManagedDatabaseConfig()) return
  if (!globalForRedis.__kilo_snapshot_schema_promise) {
    globalForRedis.__kilo_snapshot_schema_promise = executeKiloDatabaseQuery(
      `CREATE TABLE IF NOT EXISTS ${KILO_SNAPSHOT_TABLE} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_scope TEXT,
        lease_until INTEGER
      )`,
      [],
      "run",
    ).then(() => undefined).catch((error) => {
      globalForRedis.__kilo_snapshot_schema_promise = undefined
      throw error
    })
  }
  return globalForRedis.__kilo_snapshot_schema_promise
}

export function isSharedPersistenceBackend(
  backend: RedisBackend | string = getRedisBackend(),
): boolean {
  return backend === "redis-network" || backend === "kilo-sqlite-snapshot"
}

export function isKiloSnapshotBackend(
  backend: RedisBackend | string = getRedisBackend(),
): boolean {
  return backend === "kilo-sqlite-snapshot"
}

export interface RedisClientLike {
  ping(): Promise<string>
  info(): Promise<string>
  get(key: string): Promise<string | null>
  mget(...keys: string[]): Promise<Array<string | null>>
  set(key: string, value: string, options?: { EX?: number; PX?: number; NX?: boolean; XX?: boolean }): Promise<string | null>
  setex(key: string, seconds: number, value: string): Promise<void | string>
  incr(key: string): Promise<number>
  incrby(key: string, increment: number): Promise<number>
  del(...keys: string[]): Promise<number>
  flushDb(): Promise<void>
  hset(key: string, dataOrField: Record<string, string> | string, value?: string): Promise<number>
  hmset(...args: string[]): Promise<void>
  hgetall(key: string): Promise<Record<string, string>>
  hlen(key: string): Promise<number>
  hget(key: string, field: string): Promise<string | null>
  hdel(key: string, ...fields: string[]): Promise<number>
  hincrby(key: string, field: string, increment: number): Promise<number>
  hincrbyfloat(key: string, field: string, increment: number): Promise<number>
  sadd(key: string, ...members: string[]): Promise<number>
  scard(key: string): Promise<number>
  smembers(key: string): Promise<string[]>
  sismember(key: string, member: string): Promise<number>
  srem(key: string, ...members: string[]): Promise<number>
  expire(key: string, seconds: number): Promise<number>
  persist(key: string): Promise<number>
  lpush(key: string, ...values: string[]): Promise<number>
  rpush(key: string, ...values: string[]): Promise<number>
  lrange(key: string, start: number, stop: number): Promise<string[]>
  ltrim(key: string, start: number, stop: number): Promise<void>
  llen(key: string): Promise<number>
  lrem(key: string, count: number, value: string): Promise<number>
  lpos(key: string, value: string): Promise<number | null>
  lpop(key: string): Promise<string | null>
  rpop(key: string): Promise<string | null>
  eval?(script: string, options: { keys: string[]; arguments: string[] }): Promise<any>
  dbSize(): Promise<number>
  keys(pattern: string): Promise<string[]>
  scan?(cursor: string | number, ...args: any[]): Promise<{ cursor: string; keys: string[] } | [string, string[]]>
  zadd(key: string, score: number, member: string): Promise<number>
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>
  zrange(key: string, start: number, stop: number): Promise<string[]>
  zrevrange(key: string, start: number, stop: number): Promise<string[]>
  zscore(key: string, member: string): Promise<string | null>
  zcard(key: string): Promise<number>
  exists(key: string): Promise<number>
  ttl(key: string): Promise<number>
  multi(): { [k: string]: any; exec: () => Promise<any[]> }
  pipeline(): { [k: string]: any; exec: () => Promise<any[]> }
  saveToDisk(): Promise<boolean>
  loadFromDisk(): Promise<boolean>
  saveToDiskSync(): boolean
  persistNow(): Promise<boolean>
  cleanupExpiredKeysPublic(): Promise<number>
  trackDatabaseOperation(limit: number): Promise<{ current: number; limit: number; exceeded: boolean }>
  getDatabaseOperationCount(): Promise<number>
}


export class InlineLocalRedis implements RedisClientLike {
  private data: RedisData

  constructor() {
    // Use global storage for persistence across hot reloads
    if (!globalForRedis.__redis_data) {
      // Initialize with defaults. Do NOT fire loadFromDisk() here — initRedis()
      // awaits it explicitly after construction when wasEmpty=true. Firing a
      // background load here races with initRedis() and overwrites migration
      // writes (ensureBaseConnections / migration 021) because the unawaited
      // Promise settles AFTER migrations have already set is_enabled_dashboard=1.
      globalForRedis.__redis_data = {
        strings: new Map(),
        hashes: new Map(),
        sets: new Map(),
        lists: new Map(),
        sorted_sets: new Map(),
        ttl: new Map(),
        requestStats: {
          lastSecond: Math.floor(Date.now() / 1000),
          requestCount: 0,
          operationsPerSecond: 0,
        },
      }
    }
    
    // Ensure ttl map exists for older data structures
    if (!globalForRedis.__redis_data.ttl) {
      globalForRedis.__redis_data.ttl = new Map()
    }
    
    this.data = globalForRedis.__redis_data
    
    // Run cleanup every 60 seconds to remove expired keys
    this.startTTLCleanup();
    
    // Schedule an atomic disk snapshot at least once per minute.
    this.startPersistence();
  }

  // ──────────────────────────────────────────────────────────────────────
  // Disk persistence (snapshot-based, single instance)
  // ─────────────────────────────────�������────────────────────────────────────
  //
  // The "local Redis" is in-memory only, so without a snapshot every
  // deploy / container restart / serverless cold-start wipes EVERYTHING:
  // connections, settings, progression counters, prehistoric flags.
  //
  // This implementation does the simplest thing that survives a restart on
  // a single warm instance:
  //   • saveToDisk():       JSON-serialise data, write atomically (tmp + rename)
  //   • saveToDiskSync():   same, blocking — used in SIGTERM/SIGINT/beforeExit
  //   • loadFromDisk():     read + restore Maps/Sets; rename corrupt file aside
  //   • startPersistence(): once-per-process 60-second interval + signal handlers
  //
  // Notes:
  //   • Defaults to `<cwd>/.v0-data/redis-snapshot.json`, falls back to
  //     `/tmp/v0-redis-snapshot.json` if the cwd path is not writable
  //     (Vercel serverless restricts writes outside `/tmp`).
  //   • This is NOT cross-instance durable. Vercel `/tmp` is per warm
  //     instance; a fresh cold instance starts empty and rebuilds via
  //     migrations. Swap the body of save/load for Vercel Blob to gain
  //     cross-instance durability without changing this surface.
  //   • Browser builds: every entry point exits early via the `process`
  //     guard so client bundles never pull in `node:fs`. We use dynamic
  //     `await import("node:fs/promises")` to keep the file's "no static
  //     fs/path imports" contract (see header comment).
  //
  // Failure-mode philosophy: the in-memory store keeps working regardless
  // of disk failures — the only observable effect of a broken disk is a
  // single rate-limited warning per minute and no cross-restart recovery.

  private markDirty(): void {
    globalForRedis.__redis_snapshot_mutation_version = this.mutationVersion() + 1
  }

  private mutationVersion(): number {
    return globalForRedis.__redis_snapshot_mutation_version ?? 0
  }

  private persistedVersion(): number {
    return globalForRedis.__redis_snapshot_persisted_version ?? -1
  }

  private markPersisted(version: number): void {
    globalForRedis.__redis_snapshot_persisted_version = Math.max(this.persistedVersion(), version)
  }

  private nextWriteSuffix(): string {
    const counter = (globalForRedis.__redis_snapshot_write_counter ?? 0) + 1
    globalForRedis.__redis_snapshot_write_counter = counter
    return `${process.pid ?? "browser"}.${counter}.${Date.now()}`
  }

  /** Resolve snapshot path; honours `V0_REDIS_SNAPSHOT_PATH` env override. */
  private async resolveSnapshotPath(): Promise<{ dir: string; file: string } | null> {
    if (typeof process === "undefined" || !process.versions?.node) return null
    try {
      // Bare specifier (no `node:` URI scheme) — Webpack 5's bundler can
      // analyse this and Node's resolver maps it to the built-in. The
      // `node:path` form triggers `UnhandledSchemeError` on the Edge
      // build because Webpack's scheme handler doesn't recognise it.
      // Bare imports are aliased to `false` for the Edge runtime in
      // `next.config.mjs`, which short-circuits the load (the runtime
      // guard above already returns `null` before this line ever runs).
      const path = await import("path")
      const explicit = process.env.V0_REDIS_SNAPSHOT_PATH
      if (explicit) {
        return { dir: path.dirname(explicit), file: explicit }
      }
      // Prefer cwd/.v0-data; fall back to /tmp in restricted environments.
      const primary = path.join(process.cwd(), ".v0-data", "redis-snapshot.json")
      return { dir: path.dirname(primary), file: primary }
    } catch {
      return null
    }
  }

  /** Fallback: write to `/tmp` when the primary path is read-only. */
  private async tmpFallbackPath(): Promise<{ dir: string; file: string } | null> {
    if (typeof process === "undefined" || !process.versions?.node) return null
    try {
      // Bare specifier — see comment in `resolveSnapshotPath`.
      const path = await import("path")
      return { dir: "/tmp", file: path.join("/tmp", "v0-redis-snapshot.json") }
    } catch {
      return null
    }
  }

  /**
   * Build a JSON-safe snapshot of the in-memory data. We can't JSON-stringify
   * Maps and Sets directly, so we materialise them as arrays of entries.
   * Format is versioned (`v: 1`) so future shape changes can migrate cleanly.
   */
  private buildSnapshot(): string {
    const d = this.data
    return JSON.stringify({
      v: 1,
      savedAt: Date.now(),
      strings: Array.from(d.strings.entries()),
      hashes: Array.from(d.hashes.entries()),
      sets: Array.from(d.sets.entries()).map(([k, s]) => [k, Array.from(s)]),
      lists: Array.from(d.lists.entries()),
      sorted_sets: Array.from(d.sorted_sets.entries()).map(([k, z]) => [k, z.entries]),
      ttl: Array.from(d.ttl.entries()),
      mutationVersion: this.mutationVersion(),
    })
  }

  /** Restore Maps/Sets from a parsed snapshot. Tolerant of partial files. */
  private applySnapshot(parsed: any): boolean {
    if (!parsed || typeof parsed !== "object") return false
    const d = this.data
    try {
      if (Array.isArray(parsed.strings))
        d.strings = new Map(parsed.strings)
      if (Array.isArray(parsed.hashes))
        d.hashes = new Map(parsed.hashes)
      if (Array.isArray(parsed.sets))
        d.sets = new Map(parsed.sets.map(([k, s]: [string, string[]]) => [k, new Set(s)]))
      if (Array.isArray(parsed.lists))
        d.lists = new Map(parsed.lists)
      if (Array.isArray(parsed.sorted_sets))
        d.sorted_sets = new Map(
          parsed.sorted_sets.map(([k, z]: [string, SortedSetEntry[] | { entries?: SortedSetEntry[] }]) => [
            k,
            this.createSortedSet(Array.isArray(z) ? z : z?.entries || []),
          ]),
        )
      if (Array.isArray(parsed.ttl))
        d.ttl = new Map(parsed.ttl)
      return true
    } catch {
      return false
    }
  }

  private isCleanForSharedRefresh(): boolean {
    return this.persistedVersion() >= this.mutationVersion()
  }

  /**
   * Load the latest cross-worker checkpoint from Kilo's managed SQLite
   * database. A warm isolate refreshes only while its local snapshot is clean;
   * silently replacing unpersisted writes would be worse than surfacing the
   * optimistic-concurrency conflict at the next persistence barrier.
   */
  async refreshFromSharedSnapshot(force = false): Promise<boolean> {
    if (!hasKiloManagedDatabaseConfig()) return false
    if (!force && !this.isCleanForSharedRefresh()) return false
    if (globalForRedis.__kilo_snapshot_refresh_promise) {
      return globalForRedis.__kilo_snapshot_refresh_promise
    }

    const refresh = (async () => {
      await ensureKiloSnapshotSchema()
      const rows = await executeKiloDatabaseQuery(
        `SELECT revision, payload, updated_at FROM ${KILO_SNAPSHOT_TABLE} WHERE id = 1`,
        [],
        "all",
      )
      const row = rows[0]
      if (!row) {
        globalForRedis.__kilo_snapshot_revision = 0
        globalForRedis.__kilo_snapshot_last_synced_at = Date.now()
        return false
      }

      const revision = Number(databaseRowValue(row, "revision", 0) || 0)
      const currentRevision = Number(globalForRedis.__kilo_snapshot_revision || 0)
      if (!force && revision <= currentRevision) {
        globalForRedis.__kilo_snapshot_last_synced_at = Date.now()
        return true
      }
      const raw = String(databaseRowValue(row, "payload", 1) || "")
      const parsed = JSON.parse(raw)
      if (!this.applySnapshot(parsed)) {
        throw new Error(`Kilo shared snapshot revision ${revision} has an invalid payload`)
      }
      if (currentRevision === 0) this.clearRestoredInlineProcessOwnership()
      globalForRedis.__kilo_snapshot_revision = revision
      globalForRedis.__kilo_snapshot_last_synced_at = Date.now()
      globalForRedis.__redis_snapshot_mutation_version = Number(parsed?.mutationVersion || 0)
      this.markPersisted(this.mutationVersion())
      return true
    })()
    globalForRedis.__kilo_snapshot_refresh_promise = refresh
    try {
      return await refresh
    } finally {
      if (globalForRedis.__kilo_snapshot_refresh_promise === refresh) {
        globalForRedis.__kilo_snapshot_refresh_promise = undefined
      }
    }
  }

  private async saveToSharedSnapshotUnlocked(): Promise<boolean> {
    if (!hasKiloManagedDatabaseConfig()) return false
    await ensureKiloSnapshotSchema()
    const expectedRevision = Number(globalForRedis.__kilo_snapshot_revision || 0)
    const snapshotVersion = this.mutationVersion()
    const payload = this.buildSnapshot()
    const rows = await executeKiloDatabaseQuery(
      `INSERT INTO ${KILO_SNAPSHOT_TABLE} (id, revision, payload, updated_at, lease_owner, lease_scope, lease_until)
       VALUES (1, 1, ?, ?, NULL, NULL, NULL)
       ON CONFLICT(id) DO UPDATE SET
         revision = ${KILO_SNAPSHOT_TABLE}.revision + 1,
         payload = excluded.payload,
         updated_at = excluded.updated_at
       WHERE ${KILO_SNAPSHOT_TABLE}.revision = ?
       RETURNING revision`,
      [payload, Date.now(), expectedRevision],
      "all",
    )
    const nextRevision = Number(databaseRowValue(rows[0], "revision", 0) || 0)
    if (!Number.isFinite(nextRevision) || nextRevision <= expectedRevision) {
      console.warn(
        `[v0] [Redis Persistence] Kilo snapshot CAS conflict at revision ${expectedRevision}; refusing stale overwrite`,
      )
      return false
    }
    globalForRedis.__kilo_snapshot_revision = nextRevision
    globalForRedis.__kilo_snapshot_last_synced_at = Date.now()
    this.markPersisted(snapshotVersion)
    return true
  }

  async acquireSharedSnapshotLease(scope: string, ttlMs = 70_000, waitMs = 8_000): Promise<string | null> {
    if (!hasKiloManagedDatabaseConfig()) return null
    await ensureKiloSnapshotSchema()
    const owner = `${scope}:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`
    const deadline = Date.now() + Math.max(0, waitMs)
    do {
      const now = Date.now()
      const rows = await executeKiloDatabaseQuery(
        `UPDATE ${KILO_SNAPSHOT_TABLE}
         SET lease_owner = ?, lease_scope = ?, lease_until = ?
         WHERE id = 1 AND (lease_until IS NULL OR lease_until < ? OR lease_owner = ?)
         RETURNING lease_owner`,
        [owner, scope, now + ttlMs, now, owner],
        "all",
      )
      if (String(databaseRowValue(rows[0], "lease_owner", 0) || "") === owner) return owner
      if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40 + Math.floor(Math.random() * 40)))
    } while (Date.now() < deadline)
    return null
  }

  async releaseSharedSnapshotLease(owner: string): Promise<void> {
    if (!hasKiloManagedDatabaseConfig() || !owner) return
    await executeKiloDatabaseQuery(
      `UPDATE ${KILO_SNAPSHOT_TABLE}
       SET lease_owner = NULL, lease_scope = NULL, lease_until = NULL
       WHERE id = 1 AND lease_owner = ?`,
      [owner],
      "run",
    )
  }

  /**
   * A disk snapshot is restored by a brand-new process. InlineLocalRedis is
   * deliberately single-process, so runtime ownership from the previous PID
   * can never still be valid even when its saved heartbeat is only a few
   * milliseconds old. Preserve durable settings/progression/history, but drop
   * process leases and liveness proofs before startup reconciliation runs.
   */
  private clearRestoredInlineProcessOwnership(): void {
    const processOwnedPrefixes = ["engine_lock:", "engine_is_running:", "cron_lock:"]
    for (const key of Array.from(this.data.strings.keys())) {
      if (!processOwnedPrefixes.some((prefix) => key.startsWith(prefix))) continue
      this.data.strings.delete(key)
      this.data.ttl.delete(key)
    }

    for (const [key, hash] of this.data.hashes.entries()) {
      if (key === "trade_engine:global") {
        hash.actual_status = "stopped"
        hash.active_worker_id = ""
        hash.last_heartbeat_at = "0"
        hash.last_heartbeat_iso = ""
        hash.runtime_owner_mode = ""
        continue
      }
      if (!key.startsWith("trade_engine_state:") && !key.startsWith("settings:trade_engine_state:")) continue
      delete hash.last_processor_heartbeat
      delete hash.last_indication_run
      delete hash.active_worker_id
      delete hash.worker_id
      if (hash.status === "running" || hash.status === "starting") hash.status = "stopped"
    }
    this.markDirty()
  }

  /** Single rate-limited warning per minute so a broken disk doesn't spam logs. */
  private warnRateLimited(msg: string, err: unknown): void {
    const now = Date.now()
    if (now - (globalForRedis.__redis_snapshot_last_error_warn ?? 0) < 60_000) return
    globalForRedis.__redis_snapshot_last_error_warn = now
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`[v0] [Redis Persistence] ${msg}: ${detail}`)
  }

  async loadFromDisk(): Promise<boolean> {
    // ── Safety guard: prevent snapshot reload if engine is running ──
    // In dev mode, multiple Next.js workers each call initRedis()
    // independently. Each worker loads the snapshot, which can overwrite
    // lock values held by a live engine in a different worker. This causes
    // "ownership loss" crashes. Check the global flag published by the
    // trade-engine coordinator; if ANY engine is active, skip the reload.
    const globalCtx = globalThis as any
    const coordinator = globalCtx.__tradeEngineCoordinator
    const coordinatorHasEngines =
      coordinator &&
      typeof coordinator.getActiveEngineCount === "function" &&
      Number(coordinator.getActiveEngineCount()) > 0
    if (globalCtx.__engine_manager_instance?.isEngineRunning || coordinatorHasEngines) {
      console.log(`[v0] [Redis] Snapshot reload skipped: engine/coordinator running in this process`)
      return false
    }

    if (hasKiloManagedDatabaseConfig()) {
      return this.refreshFromSharedSnapshot(true)
    }

    const target = await this.resolveSnapshotPath()
    if (!target) return false
    // Bare specifier — see comment in `resolveSnapshotPath`. Type alias
    // also drops the `node:` prefix so the bundler doesn't analyse it.
    let fs: typeof import("fs/promises")
    try {
      fs = await import("fs/promises")
    } catch {
      return false
    }
    // An explicit path is an operator durability contract. Never silently
    // restore from `/tmp` when that path is configured: an ephemeral fallback
    // could resurrect a different/stale database and falsely report success.
    const candidates = process.env.V0_REDIS_SNAPSHOT_PATH
      ? [target]
      : [target, await this.tmpFallbackPath()].filter(Boolean) as Array<{ file: string }>
    for (const c of candidates) {
      try {
        const raw = await fs.readFile(c.file, "utf8")
        const parsed = JSON.parse(raw)
        if (this.applySnapshot(parsed)) {
          this.markPersisted(this.mutationVersion())
          this.clearRestoredInlineProcessOwnership()
          const keys =
            this.data.strings.size + this.data.hashes.size + this.data.sets.size +
            this.data.lists.size + this.data.sorted_sets.size
          console.log(`[v0] [Redis Persistence] Restored ${keys} keys from ${c.file}`)
          return true
        }
        // Parsed but didn't fit — quarantine and continue.
        try { await fs.rename(c.file, `${c.file}.corrupt-${Date.now()}`) } catch {}
      } catch (err: any) {
        if (err?.code === "ENOENT") continue // no snapshot yet
        if (err instanceof SyntaxError) {
          // Corrupt JSON — move it aside so we don't keep failing.
          try { await fs.rename(c.file, `${c.file}.corrupt-${Date.now()}`) } catch {}
          continue
        }
        // Other I/O error — try fallback.
        continue
      }
    }
    return false
  }

  async saveToDisk(): Promise<boolean> {
    // The same source module may be bundled/evaluated independently by several
    // Next route chunks in one process. Coordinate through globalThis so those
    // copies cannot write/rename the same snapshot concurrently.
    const existing = globalForRedis.__redis_snapshot_save_promise
    if (existing) return existing
    if (this.persistedVersion() >= this.mutationVersion()) return true
    const write = this.saveToDiskUnlocked()
    globalForRedis.__redis_snapshot_save_promise = write
    try {
      return await write
    } finally {
      if (globalForRedis.__redis_snapshot_save_promise === write) {
        delete globalForRedis.__redis_snapshot_save_promise
      }
    }
  }

  private async saveToDiskUnlocked(): Promise<boolean> {
    try {
      if (hasKiloManagedDatabaseConfig()) {
        return await this.saveToSharedSnapshotUnlocked()
      }
      const primary = await this.resolveSnapshotPath()
      if (!primary) return false
      // Bare specifier — see comment in `resolveSnapshotPath`.
      let fs: typeof import("fs/promises")
      try {
        fs = await import("fs/promises")
      } catch {
        return false
      }
      const snapshotVersion = this.mutationVersion()
      const json = this.buildSnapshot()
      // With an explicit persistent-volume path, fail closed instead of
      // silently succeeding on ephemeral `/tmp`.
      const candidates = process.env.V0_REDIS_SNAPSHOT_PATH
        ? [primary]
        : [primary, await this.tmpFallbackPath()].filter(Boolean) as Array<{ dir: string; file: string }>
      for (const c of candidates) {
        try {
          await fs.mkdir(c.dir, { recursive: true })
          // Keep every physical attempt unique as an extra fail-safe for a
          // synchronous shutdown flush or another JS realm.
          const tmpPath = `${c.file}.${this.nextWriteSuffix()}.tmp`
          const handle = await fs.open(tmpPath, "w")
          try {
            await handle.writeFile(json, "utf8")
            await handle.sync()
          } finally {
            await handle.close()
          }
          // Atomic on POSIX — readers either see old or new, never partial.
          await fs.rename(tmpPath, c.file)
          // Persist the directory entry as well. Some filesystems can otherwise
          // lose a just-renamed file after a power loss even though file data was
          // fsynced. Unsupported directory fsync is harmless.
          try {
            const dirHandle = await fs.open(c.dir, "r")
            try { await dirHandle.sync() } finally { await dirHandle.close() }
          } catch {}
          this.markPersisted(snapshotVersion)
          return true
        } catch (err) {
          // Try next fallback. Only warn after we've exhausted everything.
          if (c === candidates[candidates.length - 1]) {
            this.warnRateLimited(`save failed (${c.file})`, err)
          }
          continue
        }
      }
      return false
    } catch (error) {
      this.warnRateLimited("snapshot save failed", error)
      return false
    }
  }

  /** Synchronous variant for SIGTERM / SIGINT / beforeExit handlers. */
  saveToDiskSync(): boolean {
    if (typeof process === "undefined" || !process.versions?.node) return false
    // Type aliases use bare specifiers so TypeScript's emitted .d.ts
    // (and any incremental compile cache) don't carry `node:` URIs that
    // could re-enter the bundler graph.
    let fsSync: typeof import("fs"), pathMod: typeof import("path")
    try {
      // `Function("return require")` breaks inside a production Webpack/Next
      // bundle because CommonJS require is module-scoped rather than global.
      // Node's getBuiltinModule bypasses the bundle safely and is available on
      // supported Node 20/22 runtimes. Keep the dynamic-require fallback for
      // early Node 20 patch releases.
      const getBuiltinModule = (process as any).getBuiltinModule as undefined | ((name: string) => any)
      if (typeof getBuiltinModule === "function") {
        fsSync = getBuiltinModule("fs")
        pathMod = getBuiltinModule("path")
      } else {
        const dynamicRequire = Function("m", "return require(m)") as (m: string) => any
        fsSync = dynamicRequire("fs")
        pathMod = dynamicRequire("path")
      }
    } catch {
      return false
    }
    const explicit = process.env.V0_REDIS_SNAPSHOT_PATH
    const primaryFile = explicit || pathMod.join(process.cwd(), ".v0-data", "redis-snapshot.json")
    const tmpFile = pathMod.join("/tmp", "v0-redis-snapshot.json")
    if (this.persistedVersion() >= this.mutationVersion()) return true
    const snapshotVersion = this.mutationVersion()
    const json = this.buildSnapshot()
    const candidates = explicit ? [primaryFile] : [primaryFile, tmpFile]
    for (const file of candidates) {
      try {
        const dir = pathMod.dirname(file)
        fsSync.mkdirSync(dir, { recursive: true })
        const tmp = `${file}.${this.nextWriteSuffix()}.tmp`
        const fd = fsSync.openSync(tmp, "w")
        try {
          fsSync.writeFileSync(fd, json, "utf8")
          fsSync.fsyncSync(fd)
        } finally {
          fsSync.closeSync(fd)
        }
        fsSync.renameSync(tmp, file)
        try {
          const dirFd = fsSync.openSync(dir, "r")
          try { fsSync.fsyncSync(dirFd) } finally { fsSync.closeSync(dirFd) }
        } catch {}
        this.markPersisted(snapshotVersion)
        return true
      } catch {
        continue
      }
    }
    return false
  }

  async startPersistence(): Promise<boolean> {
    if (typeof process === "undefined" || !process.versions?.node) return false
    if (globalForRedis.__redis_persistence_tick_started) return true
    globalForRedis.__redis_persistence_tick_started = true

    // ── Continuous session persistence ──
    // The default recovery checkpoint is exactly one minute in every runtime.
    // Critical order transitions still flush synchronously before exchange
    // mutation; this periodic checkpoint covers settings and recomputable
    // progression/stats state without putting disk I/O in every 200–300 ms
    // engine cycle. An explicit override may request a faster checkpoint, but
    // is capped at 60 seconds so persistence can never become less frequent.
    // unref() so this timer never holds the process open during a graceful exit.
    const configuredInterval = Number(process.env.INLINE_REDIS_SNAPSHOT_INTERVAL_MS)
    const defaultInterval = 60_000
    const snapshotIntervalMs = Number.isFinite(configuredInterval) && configuredInterval > 0
      ? Math.max(5_000, Math.min(60_000, Math.floor(configuredInterval)))
      : defaultInterval
    const t = setInterval(() => {
      this.saveToDisk().catch(() => { /* warned inside saveToDisk */ })
    }, snapshotIntervalMs)
    if (typeof t.unref === "function") t.unref()

    // Flush-on-exit handlers (idempotent).
    if (!globalForRedis.__redis_persistence_signals_attached) {
      globalForRedis.__redis_persistence_signals_attached = true
      const flush = () => { try { this.saveToDiskSync() } catch {} }
      // setMaxListeners is a NodeEventEmitter API; guard for ts safety.
      try { (process as any).setMaxListeners?.(50) } catch {}
      process.on("SIGTERM", flush)
      process.on("SIGINT", flush)
      process.on("beforeExit", flush)
    }
    return true
  }
  

  async cleanupVolatileRuntimeState({
    mode,
    reason = "startup",
  }: { mode?: "activeOwnerSafe" | string; reason?: string } = {}): Promise<{ deleted: number; preserved: number }> {
    const staleMs = Number(process.env.VOLATILE_STATE_STALE_MS || process.env.REDIS_VOLATILE_STALE_MS || 6 * 60 * 60 * 1000)
    const ownerFreshMs = Number(process.env.VOLATILE_STATE_OWNER_FRESH_MS || process.env.PROCESSOR_HEARTBEAT_FRESH_MS || 90_000)
    const now = Date.now()
    let deleted = 0
    let preserved = 0
    const activeOwnerSafe = mode === "activeOwnerSafe"
    const activeOwnerCache = new Map<string, boolean>()

    const deleteKey = (key: string) => {
      const before = this.data.strings.has(key) || this.data.hashes.has(key) || this.data.sets.has(key) || this.data.lists.has(key) || this.data.sorted_sets.has(key)
      this.deleteKey(key)
      if (before) deleted++
    }
    const olderThanThreshold = (key: string, raw?: string | null): boolean => {
      const ttl = this.data.ttl?.get(key)
      if (ttl && ttl <= now) return true
      const timestamp = Number(raw || "")
      if (Number.isFinite(timestamp) && timestamp > 0 && now - timestamp > staleMs) return true
      return !ttl && !timestamp
    }
    const extractPipelineConnectionId = (key: string): string | null => {
      const prefixes = [
        "pseudo_position:",
        "pseudo_positions:",
        "settings:pseudo_position:",
        "settings:pseudo_positions:",
        "strategies:",
        "settings:strategies:",
        "indication_set:",
        "indication_outcomes_pending:",
      ]
      for (const prefix of prefixes) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const connectionId = rest.split(":")[0]
        return connectionId && connectionId !== "all" && connectionId !== "active" && connectionId !== "counter" && connectionId !== "metadata"
          ? connectionId
          : null
      }
      return null
    }
    const hasFreshOwner = (connectionId: string): boolean => {
      if (activeOwnerCache.has(connectionId)) return activeOwnerCache.get(connectionId)!
      const heartbeatFields = ["last_processor_heartbeat", "last_indication_run"]
      let freshest = 0
      for (const stateKey of [`trade_engine_state:${connectionId}`, `settings:trade_engine_state:${connectionId}`]) {
        const state = this.data.hashes.get(stateKey)
        if (!state) continue
        for (const field of heartbeatFields) {
          const raw = state[field]
          const numeric = Number(raw || "")
          const parsed = Number.isFinite(numeric) && numeric > 0 ? numeric : new Date(String(raw || "")).getTime()
          if (Number.isFinite(parsed) && parsed > freshest) freshest = parsed
        }
      }
      const fresh = freshest > 0 && now - freshest < ownerFreshMs
      activeOwnerCache.set(connectionId, fresh)
      return fresh
    }
    const isPipelineFamily = (key: string): boolean => {
      return key.startsWith("pseudo_position:") || key.startsWith("pseudo_positions:") ||
        key.startsWith("settings:pseudo_position") || key.startsWith("settings:pseudo_positions:") ||
        key.startsWith("indication_set:") || key.startsWith("indication_outcomes_pending:") ||
        key.startsWith("strategies:") || key.startsWith("settings:strategies")
    }
    const shouldDelete = (key: string, raw?: string | null): boolean => {
      // Volatile-state cleanup policy — same in all modes:
      // live:position:tracking:* and :moved: are transient indexes; always safe to drop.
      if (key.startsWith("live:position:") || key.startsWith("live:positions:") || key.startsWith("settings:live:")) {
        return key.startsWith("live:position:tracking:") || key.includes(":moved:")
      }
      // live:lock:* is a transient gate: delete only expired/old/missing-TTL locks.
      if (key.startsWith("live:lock:")) return olderThanThreshold(key, raw)
      // Prehistoric gates/progress are boot cache gates, not authoritative data.
      if (key.startsWith("prehistoric_loaded:") || key.startsWith("prehistoric:progress:")) return olderThanThreshold(key, raw)
      // Pipeline families are rebuilt each cycle. In production startup cleanup,
      // preserve them for connections with a fresh distributed processor owner.
      if (isPipelineFamily(key)) {
        const connectionId = extractPipelineConnectionId(key)
        if (activeOwnerSafe && connectionId && hasFreshOwner(connectionId)) return false
        return true
      }
      return false
    }

    for (const [key, value] of Array.from(this.data.strings.entries())) shouldDelete(key, value) ? deleteKey(key) : preserved++
    for (const key of Array.from(this.data.hashes.keys())) shouldDelete(key) ? deleteKey(key) : preserved++
    for (const key of Array.from(this.data.sets.keys())) shouldDelete(key) ? deleteKey(key) : preserved++
    for (const key of Array.from(this.data.lists.keys())) shouldDelete(key) ? deleteKey(key) : preserved++
    for (const key of Array.from(this.data.sorted_sets.keys())) shouldDelete(key) ? deleteKey(key) : preserved++

    if (deleted > 0) {
      console.log(`[v0] [Redis Memory] Volatile startup cleanup (${reason}): deleted ${deleted} keys, preserved ${preserved}`)
    }
    return { deleted, preserved }
  }

  private startTTLCleanup(): void {
    // TTL-based cleanup + LRU eviction when heap memory exceeds threshold.
    // In dev mode the InlineLocalRedis emulator holds the ENTIRE dataset on
    // the Node heap (in prod this lives in real Redis, off-heap). During live
    // trading the per-cycle pipeline writes thousands of `pseudo_position:*`
    // and `config_set:*` hashes plus a growing `pseudo_positions:{conn}` set
    // every second; left unchecked this drove heapUsed past the 4GB V8 ceiling
    // and OOM-killed next-server seconds after live trading began.
    const globalCleanup = globalThis as unknown as {
      __redis_cleanup_started?: boolean
      __redis_mem_limits?: { heapMB: number; rssSoftMB: number; rssHardMB: number; maxKeys: number }
    }

    // ── Dynamic memory limits ────────────────────────────────────────────────
    // Computed BEFORE the startup guard so the thresholds update on every
    // HMR reload (the guard below only prevents the timer from being
    // registered twice, not the threshold computation from re-running).
    // Reads /proc/meminfo each time so values are always proportional to
    // the actual VM; fallback 4096 MB for unknown environments.
    {
      const _readVmTotalMB = (): number => {
        try {
          const fs = require("fs") as typeof import("fs")
          const raw = fs.readFileSync("/proc/meminfo", "utf8")
          const match = raw.match(/MemTotal:\s+(\d+)\s+kB/)
          return match ? Math.round(parseInt(match[1], 10) / 1024) : 4_096
        } catch {
          return 4_096
        }
      }
      const vmTotalMB   = _readVmTotalMB()
      // Reserve 1.5 GB for OS + other processes. On the 8.4 GB VM usable = 6.9 GB.
      // Kernel OOM on Linux typically fires at ~95% physical RAM consumption;
      // we keep a ~18% buffer (rssHard at 82%) so the EMERGENCY pause (×1.07)
      // fires at ~88%, well below kernel OOM. With SYMBOL_CONCURRENCY=1 and
      // exchange-close retries eliminated, working RSS is ~3-4 GB; the old
      // 75% rssHard (4769 MB) was tripping CRITICAL evictions on normal traffic.
      const usableMB    = Math.max(1_500, vmTotalMB - 1_500)
      // Heap trigger: 60% of usable (was 55%)
      const heapMB      = Math.round(usableMB * 0.60)
      // RSS soft: 72% of usable — force GC above this (was 65%).
      const rssSoftMB   = Math.round(usableMB * 0.72)
      // RSS hard: 82% of usable — critical eviction + sleep above this (was 75%).
      const rssHardMB   = Math.round(usableMB * 0.82)
      const _nSyms      = Math.max(1, parseInt(process.env.V0_DEV_SYMBOL_COUNT ?? "1", 10) || 1)
      const maxKeys     = Math.round(1_000 + _nSyms * 800 * Math.max(1, usableMB / 2_048))
      const prev = globalCleanup.__redis_mem_limits
      const changed = !prev || prev.rssHardMB !== rssHardMB
      globalCleanup.__redis_mem_limits = { heapMB, rssSoftMB, rssHardMB, maxKeys }
      if (changed) {
        console.log(
          `[v0] [Redis Memory] VM=${vmTotalMB}MB usable=${usableMB}MB ` +
          `→ heapTrigger=${heapMB}MB rssSoft=${rssSoftMB}MB rssHard=${rssHardMB}MB maxKeys=${maxKeys}`
        )
      }
    }

    if (globalCleanup.__redis_cleanup_started) return
    globalCleanup.__redis_cleanup_started = true

    const MEM = globalCleanup.__redis_mem_limits

    // Run an immediate targeted flush at startup to clear volatile key families
    // that accumulate across hot-reload cycles.
    void this.cleanupVolatileRuntimeState({ mode: "activeOwnerSafe", reason: "inline-startup" })

    // Keep the once-per-second timer cheap: memoryUsage() and Map.size reads are
    // O(1), while TTL expiry and eviction each scan key maps. Run those full
    // scans at a slower cadence during normal operation, but bypass the cadence
    // immediately when memory crosses the configured heap/RSS thresholds.
    const FULL_CLEANUP_INTERVAL_MS = 15_000
    let _lastFullCleanupMs = 0

    // Throttle eviction log output: only print once per 60 s when stuck above
    // the threshold so the server log stays readable.
    let _lastEvictionLogMs = 0

    const ttlCleanupTimer = setInterval(() => {
      try {
        const now        = Date.now()
        const mem        = process.memoryUsage?.() || { heapUsed: 0, rss: 0 }
        const heapUsedMB = mem.heapUsed / 1024 / 1024
        const rssMB      = mem.rss      / 1024 / 1024
        const totalKeys  = this.data.strings.size + this.data.hashes.size +
                           this.data.sets.size + this.data.lists.size + this.data.sorted_sets.size

        // Always read the current thresholds from globalThis so HMR reloads
        // that update percentages are reflected immediately in the timer callback
        // without needing a process restart. Fallback to the module-level MEM
        // snapshot if the global was somehow cleared.
        const CMEM = (globalThis as any).__redis_mem_limits as typeof MEM | undefined ?? MEM

        // Three-tier pressure response:
        //   NORMAL  → TTL cleanup only on the slower full-scan cadence
        //   WARM    → immediately evict + GC when heap/RSS/key pressure is high
        //   CRITICAL → immediately volatile cleanup + 3× evict passes + GC
        const isCritical = rssMB > CMEM.rssHardMB
        const isWarm     = isCritical || heapUsedMB > CMEM.heapMB || rssMB > CMEM.rssSoftMB || totalKeys > CMEM.maxKeys
        const shouldRunFullCleanup = isWarm || now - _lastFullCleanupMs >= FULL_CLEANUP_INTERVAL_MS

        if (!shouldRunFullCleanup) return
        _lastFullCleanupMs = now

        // Expired-key cleanup scans the TTL map, so avoid doing it every second
        // unless pressure requires immediate cleanup.
        this.cleanupExpiredKeys()

        if (!isWarm) return

        if (now - _lastEvictionLogMs > 60_000) {
          _lastEvictionLogMs = now
          const reason = isCritical
            ? `CRITICAL RSS=${rssMB.toFixed(0)}MB >hard ${CMEM.rssHardMB}MB`
            : rssMB > CMEM.rssSoftMB
              ? `RSS=${rssMB.toFixed(0)}MB >soft ${CMEM.rssSoftMB}MB`
              : heapUsedMB > CMEM.heapMB
                ? `Heap=${heapUsedMB.toFixed(0)}MB >${CMEM.heapMB}MB`
                : `Keys=${totalKeys} >${CMEM.maxKeys}`
          // describeKeyFamilies() performs full key-family scans; only pay that
          // cost when a log line will actually be emitted.
          const families = this.describeKeyFamilies()
          console.log(`[v0] [Redis Memory] ${reason} — evicting. Families: ${families}`)
        }

        if (isCritical) {
          // CRITICAL: purge volatile families first, then run 3 eviction passes
          // to maximally reclaim before the engine's next cycle can add more.
          void this.cleanupVolatileRuntimeState({ mode: "activeOwnerSafe", reason: "critical-rss" })
          this.evictOldRecords()
          this.evictOldRecords()
          this.evictOldRecords()
          ;(globalThis as any).gc?.()
        } else {
          this.evictOldRecords()
          ;(globalThis as any).gc?.()
        }
      } catch {
        // Swallow errors so the cleanup timer never dies
      }
    }, 1_000)
    ttlCleanupTimer.unref?.()
  }
  
  /**
   * Diagnostic: histogram of key counts (and rough sizes for big sets/strings)
   * grouped by the first two `:`-separated segments. Lets the memory-pressure
   * log show exactly WHICH key families grow instead of guessing.
   */
  private describeKeyFamilies(): string {
    const counts = new Map<string, { n: number; approxBytes: number }>()
    const famOf = (k: string) => k.split(":").slice(0, 2).join(":")
    const bump = (k: string, bytes: number) => {
      const fam = famOf(k)
      const cur = counts.get(fam) || { n: 0, approxBytes: 0 }
      cur.n++
      cur.approxBytes += bytes
      counts.set(fam, cur)
    }
    try {
      for (const [k, v] of this.data.strings.entries()) bump(k, typeof v === "string" ? v.length : 64)
      for (const [k, h] of this.data.hashes.entries()) {
        let bytes = 0
        for (const f in h) bytes += f.length + (h[f]?.length ?? 0) + 32
        bump(k, bytes)
      }
      for (const [k, s] of this.data.sets.entries()) bump(k, s.size * 48)
      for (const [k, l] of this.data.lists.entries()) {
        let bytes = 0
        for (const item of l) bytes += (item?.length ?? 0) + 16
        bump(k, bytes)
      }
      for (const [k, z] of this.data.sorted_sets.entries()) bump(k, z.entries.length * 64)
      const top = [...counts.entries()]
        .sort((a, b) => b[1].approxBytes - a[1].approxBytes)
        .slice(0, 8)
        .map(([fam, c]) => `${fam}=${c.n}keys/${(c.approxBytes / 1048576).toFixed(1)}MB`)
      return top.join(" | ")
    } catch {
      return "unavailable"
    }
  }

  private cleanupExpiredKeys(): number {
    const now = Date.now()
    const ttlMap = this.data.ttl
    if (!ttlMap) return 0
    
    let cleaned = 0
    for (const [key, expireAt] of ttlMap.entries()) {
      if (now >= expireAt) {
        this.deleteKey(key)
        ttlMap.delete(key)
        cleaned++
      }
    }
    return cleaned
  }
  
  private evictOldRecords(): number {
    // LRU/FIFO eviction of the key families that accumulate unboundedly on the
    // Node heap in the dev emulator. In production these live in real Redis
    // (off-heap) so this is a dev-only safety net, but it is essential: during
    // live trading the pipeline creates thousands of these per minute.
    let evicted = 0

    // Keys that must NEVER be evicted by memory pressure — they are either
    // stateful operator decisions or live-position tracking records.
    //
    // IMPORTANT: "settings:*" was previously fully protected, but
    // "settings:pseudo_position*" and "settings:strategies*" are high-volume
    // transient pipeline data (not operator config) and must be evictable.
    // The protected guard is narrowed to the genuine operator sub-families only.
    const isProtected = (k: string): boolean => {
      if (k.startsWith("live:position:"))    return true  // open/closed live positions
      if (k.startsWith("live:positions:"))   return true  // open/closed index LISTs
      if (k.startsWith("progression:"))      return true  // progression counters
      if (/^prehistoric:[^:]+$/.test(k))     return true  // prehistoric summary hash for stats
      if (/^prehistoric:[^:]+:symbols$/.test(k)) return true  // processed-symbol denominator set
      if (/^prehistoric:[^:]+:done$/.test(k)) return true  // realtime gate marker
      if (/^prehistoric:[^:]+:firstpass:done$/.test(k)) return true  // first-pass gate
      if (k.startsWith("connection:"))       return true  // exchange credentials
      if (k.startsWith("strategy_count:"))   return true  // strategy count totals
      if (k.startsWith("real_pi_acc:"))      return true  // real PI accumulation
      if (k.startsWith("axis_pos_acc:"))     return true  // axis position accumulation
      if (k.startsWith("strategy_pos_entry_ids:")) return true
      if (k.startsWith("strategy_set_entry_counts:")) return true
      if (k.startsWith("strategy_set_active_entry_counts:")) return true
      if (k.startsWith("strategy_set_closed_counts:")) return true
      if (k.startsWith("strategy_set_result_ring:")) return true
      if (k.startsWith("strategy_position_set_memberships:")) return true
      if (k.startsWith("strategy_set_keys:")) return true
      if (k.startsWith("strategy_active_set_keys:")) return true
      if (k.startsWith("strategy_closed_set_keys:")) return true
      if (k.startsWith("strategy_ledger_totals:")) return true
      if (k.startsWith("app_settings"))      return true  // global app settings
      if (k.startsWith("trade_engine:"))     return true  // engine state
      if (k.startsWith("_migration"))        return true  // migration markers
      if (k.startsWith("_schema_version"))   return true  // schema version
      if (k.startsWith("market_data:"))      return true  // candle blobs (separate cap)
      // strategies:{conn}:live:count — single small key used for dashboard display;
      // written once per cycle (not per symbol) and must survive the strategies:* cap.
      if (/^strategies:[^:]+:live:count$/.test(k)) return true
      // strategies:{conn}:*:total — per-stage set counts for the dashboard.
      if (/^strategies:[^:]+:[^:]+:total$/.test(k)) return true
      // Protect genuine operator settings but NOT transient pipeline families.
      // settings:pseudo_position* and settings:strategies* are written every
      // realtime cycle and must be subject to FIFO caps.
      if (k.startsWith("settings:")) {
        // Transient pipeline families — NOT protected
        if (k.startsWith("settings:pseudo_position")) return false
        if (k.startsWith("settings:strategies"))       return false
        return true  // all other settings: keys are protected operator config
      }
      return false
    }

    // ── Single-pass categorisation ────────────────────────────────────────────
    // The previous multi-pass approach iterated all keys once per family rule
    // (13 hash rules + 9 string rules + 1 candle rule + 1 list rule = 24 passes).
    // At 8000 keys that was 192,000 startsWith() comparisons per eviction run,
    // every 2 seconds. The new approach iterates each store ONCE and categorises
    // into named buckets in-place using early-exit prefix switching — O(N) total
    // with ~8× fewer comparisons per key (average 3 prefix checks vs 24).
    //
    // Bucket names mirror the old family rules, so the cap values are unchanged.
    // ── Dynamic per-symbol eviction caps ──────────────────────────────────
    // Scale linearly with symbol count only — do NOT scale with RAM because
    // larger machines don't need more indication/strategy keys, they just have
    // more headroom before OOM. Scaling caps with RAM was the root cause of
    // the 5+ GB RSS on the 8 GB VM (indication_set floor was 5000 × large hashes).
    const _N = Math.max(1, parseInt(process.env.V0_DEV_SYMBOL_COUNT ?? "1", 10) || 1)

    const CAPS: Record<string, number> = {
      // Pseudo-positions: hard cap independent of RAM — 200 per symbol is plenty
      pseudo_position:              _N * 200,
      s_pseudo_position:            _N * 100,
      // Strategy sets: tight cap; these are rebuilt every cycle
      strategies:                   Math.max(50, _N * 20),
      s_strategies:                 Math.max(10, _N * 8),
      config_set:                   Math.max(400, _N * 25),
      strategy_positions:           Math.max(200, _N * 15),
      strategy_detail:              Math.max(200, _N * 15),
      real_stage:                   Math.max(200, _N * 15),
      // Indication families — drastically reduced to prevent OOM
      indication:                   Math.max(100, _N * 25),
      indications:                  Math.max(50,  _N * 10),
      // indication_set: was 5000 floor, now tight — only need N_symbols × N_types × 2dirs
      // With 4 symbols × 6 types × 2 dirs = 48 max, keep 200 for headroom
      indication_set:               Math.max(200, _N * 50),
      indication_outcomes_pending:  Math.max(50,  _N * 5),
      axis_pos_acc:                 5,
      prehistoric:                  20,
      live_history:                 Math.max(200, _N * 15),
      // string-only
      indications_str:              Math.max(30,  _N * 8),
      dedup:                        Math.max(500, _N * 30),
      candle_cache:                 Math.max(10,  _N * 3),
      candles:                      Math.max(10,  _N * 3),
    }

    // Classify a key into a bucket name; returns null for protected/untracked keys.
    // The switch-ladder uses fast prefix tests ordered by probability of hit —
    // high-frequency pipeline keys first, protected-class checks last.
    const classify = (k: string): string | null => {
      if (isProtected(k)) return null
      // Transient pipeline families (highest write frequency)
      if (k.startsWith("pseudo_position:"))     return "pseudo_position"
      if (k.startsWith("settings:pseudo_position")) return "s_pseudo_position"
      if (k.startsWith("settings:strategies"))  return "s_strategies"
      if (k.startsWith("strategies:")) {
        if (k.startsWith("strategies:all") ||
            k.startsWith("strategies:counter") ||
            k.startsWith("strategies:metadata")) return null
        return "strategies"
      }
      if (k.startsWith("indication_set:"))                 return "indication_set"
      if (k.startsWith("indication_outcomes_pending:"))   return "indication_outcomes_pending"
      if (k.startsWith("axis_pos_acc:"))                  return "axis_pos_acc"
      if (k.startsWith("indication:"))                    return "indication"
      if (k.startsWith("indications:"))                   return "indications"
      if (k.startsWith("config_set:") ||
          k.includes(":config_set:"))            return "config_set"
      if (k.startsWith("strategy:")) {
        if (k.includes(":positions"))            return "strategy_positions"
        if (k.includes(":detail"))               return "strategy_detail"
        return null
      }
      if (k.startsWith("real_stage:") ||
          k.startsWith("realstage:"))            return "real_stage"
      if (k.startsWith("prehistoric:"))          return "prehistoric"
      if (k.startsWith("live_positions:") &&
          k.includes(":history"))                return "live_history"
      if (k.startsWith("strategy_detail:"))      return "strategy_detail"
      if (k.startsWith("candle_cache:") ||
          k.startsWith("market_data_cache:"))    return "candle_cache"
      if (k.startsWith("market_data:") &&
          k.endsWith(":candles"))                return "candles"
      if (k.includes(":exists:") ||
          k.includes(":dedup:"))                 return "dedup"
      return null
    }

    // Helper: trim a bucket array to its cap and evict.
    const trimBucket = (bucket: string[], cap: number): number => {
      if (bucket.length <= cap) return 0
      const drop = bucket.length - cap
      for (let i = 0; i < drop; i++) this.deleteKey(bucket[i])
      return drop
    }

    // ── HASH single-pass ─────────────────��────────────────────────────────
    const hashBuckets = new Map<string, string[]>()
    for (const [key] of this.data.hashes.entries()) {
      const bucket = classify(key)
      if (bucket === null) continue
      let arr = hashBuckets.get(bucket)
      if (!arr) { arr = []; hashBuckets.set(bucket, arr) }
      arr.push(key)
    }
    for (const [bucket, keys] of hashBuckets) {
      const cap = CAPS[bucket] ?? 0
      evicted += trimBucket(keys, cap)
    }

    // ── STRING single-pass ────────────────────────────────────────────────
    // indications:* string blobs get a lower string cap (vs hash cap) since
    // the blob format is larger than the hash representation.
    const strBuckets = new Map<string, string[]>()
    for (const [key] of this.data.strings.entries()) {
      const bucket = classify(key)
      if (bucket === null) continue
      // String-specific override for indications: lower cap.
      const strBucket = bucket === "indications" ? "indications_str" : bucket
      let arr = strBuckets.get(strBucket)
      if (!arr) { arr = []; strBuckets.set(strBucket, arr) }
      arr.push(key)
    }
    for (const [bucket, keys] of strBuckets) {
      const cap = CAPS[bucket] ?? 0
      evicted += trimBucket(keys, cap)
    }

    // ── LIST single-pass ────────────��──────…22942 tokens truncated…on every poll interval.
          console.debug("[v0] [redis-db] getAllConnections: skipping malformed connection hash", {
            id: id || undefined,
            name: name || undefined,
            exchange: exchange || undefined,
          })
          return false
        })

      __connCache = { at: Date.now(), value: connections }
      return connections
    } finally {
      __connInflight = null
    }
  })()

  return __connInflight
}


export interface ConnectionCountDiagnostics {
  connection_hash_count: number
  legacy_connection_set_count: number
}

export async function getConnectionCountDiagnostics(): Promise<ConnectionCountDiagnostics> {
  await initRedis()
  const client = getClient()
  const [connections, legacyCount] = await Promise.all([
    getAllConnections(),
    client.scard("connections").catch((error: unknown) => {
      console.warn(
        "[v0] [redis-db] Failed to count legacy connections set",
        error instanceof Error ? error.message : error,
      )
      return 0
    }),
  ])

  return {
    connection_hash_count: connections.length,
    legacy_connection_set_count: Number(legacyCount) || 0,
  }
}

export async function reconcileLegacyConnectionsSetFromHashes(): Promise<ConnectionCountDiagnostics & { repaired: boolean }> {
  await initRedis()
  const client = getClient()
  const connections = await getAllConnections()
  const ids = connections
    .map((connection) => String(connection?.id ?? "").trim())
    .filter((id): id is string => id.length > 0)

  await client.del("connections")
  if (ids.length > 0) {
    await client.sadd("connections", ...ids)
  }

  return {
    connection_hash_count: connections.length,
    legacy_connection_set_count: ids.length,
    repaired: true,
  }
}

export async function saveConnection(connection: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const id = connection.id || connection.name
  if (!id) {
    throw new Error("Connection must have an id or name")
  }
  const [previousRaw, previousSettings] = await Promise.all([
    client.hgetall(`connection:${id}`).catch(() => ({})),
    client.hgetall(`settings:connection:${id}`).catch(() => ({})),
  ])
  const previous = { id, ...(previousSettings || {}), ...(previousRaw || {}) }
  
  const data = flattenForHmset({
    ...connection,
    id,
    updated_at: new Date().toISOString(),
  })
  
  await Promise.all([
    client.hset(`connection:${id}`, data),
    client.sadd("connections", id),
    syncConnectionSecondaryIndexes(client, { ...data, id }, previous),
  ])
  invalidateConnectionsCache()
}

export async function deleteConnection(id: string): Promise<void> {
  await initRedis()
  const client = getClient()
  const [raw, settings] = await Promise.all([
    client.hgetall(`connection:${id}`).catch(() => ({})),
    client.hgetall(`settings:connection:${id}`).catch(() => ({})),
  ])
  const previous = { id, ...(settings || {}), ...(raw || {}) }
  await Promise.all([
    client.del(`connection:${id}`),
    client.del(`settings:connection:${id}`),
    client.srem("connections", id),
    removeConnectionSecondaryIndexes(client, previous),
  ])
  invalidateConnectionsCache()
}

// ========== Settings Operations ==========

export async function getSettings(key: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`settings:${key}`)
  const parsed = parseHash(hash)
  // ARRAY ROUND-TRIP: setSettings(key, someArray) flattens the array into
  // index-keyed hash fields ("0","1","2",...). Without this reconstruction
  // the caller gets back an OBJECT {0:..,1:..} where it stored an array —
  // every `getSettings("orders") || []` site then crashed on .filter/.slice.
  // Detect the all-numeric-keys shape and rebuild the original array.
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed)
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      return keys
        .map(Number)
        .sort((a, b) => a - b)
        .map((i) => (parsed as Record<string, any>)[String(i)])
    }
  }
  return parsed
}

export async function setSettings(key: string, value: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const data = flattenForHmset(value)
  await client.hset(`settings:${key}`, data)
}

export async function persistNow(): Promise<boolean> {
  const client = getClient()
  if (typeof (client as any).persistNow === "function") {
    return (client as any).persistNow()
  }
  if (typeof (client as any).saveToDisk === "function") {
    return (client as any).saveToDisk()
  }
  return false
}

/**
 * Serialize a state-changing request or bounded engine cycle across Kilo
 * request workers. Network Redis already supplies command-level atomicity and
 * InlineLocalRedis is deliberately single-process, so only the managed
 * snapshot backend needs this coarse global lease.
 */
export async function withSharedPersistenceLease<T>(
  scope: string,
  work: () => Promise<T>,
  options: { ttlMs?: number; waitMs?: number } = {},
): Promise<T> {
  await initRedis()
  const client = getClient()
  if (!isKiloSnapshotBackend() || !(client instanceof InlineLocalRedis)) return work()

  const owner = await client.acquireSharedSnapshotLease(
    scope,
    options.ttlMs ?? 70_000,
    options.waitMs ?? 8_000,
  )
  if (!owner) throw new Error(`Timed out waiting for Kilo shared-state lease (${scope})`)
  try {
    await client.refreshFromSharedSnapshot(true)
    const result = await work()
    const persisted = await client.persistNow()
    if (!persisted) {
      throw new Error(`Kilo shared-state revision conflict while committing ${scope}`)
    }
    return result
  } finally {
    await client.releaseSharedSnapshotLease(owner).catch(() => undefined)
  }
}

export async function getAllSettings(): Promise<Record<string, any>> {
  await initRedis()
  const client = getClient()
  const keys = await client.keys("settings:*")
  if (keys.length === 0) return {}

  // Fan out every hgetall in parallel — sequential awaits compounded
  // latency linearly with the number of settings hashes, which showed
  // up in export and admin-dashboard endpoints.
  const hashes = await Promise.all(
    keys.map((k) => client.hgetall(k).catch(() => null)),
  )
  const settings: Record<string, any> = {}
  for (let i = 0; i < keys.length; i++) {
    const hash = hashes[i]
    if (!hash) continue
    settings[keys[i].replace("settings:", "")] = parseHash(hash)
  }
  return settings
}

// ─────────────────────��─────────────────��─────────────────────────────
// Canonical app-settings helpers
//
// The project historically drifted between two Redis hashes:
//   - "app_settings" — written by /api/settings (GET/POST/PUT) from the UI
//   - "all_settings" — read by several trade-engine modules
// These helpers unify the view so any consumer gets the operator's saved
// settings regardless of which key happens to hold them. The paired
// `setAppSettings` writer mirrors to BOTH keys so legacy readers that
// haven't been migrated yet (and any forks that expect one or the other)
// continue to work.
//
// `getAppSettings()` returns a merged record with `app_settings` winning
// on conflict (it's the canonical UI-facing key). Missing keys silently
// fall back to an empty object so callers can use `?? default` patterns.
// ─��─��──────────────────────────────────────────��──────────────────────

const APP_SETTINGS_KEY_CANONICAL = "app_settings" as const
const APP_SETTINGS_KEY_LEGACY    = "all_settings" as const

let appSettingsCache: { value: Record<string, any>; ts: number; version: number } | null = null
// Hard-refresh deadline — picks up silent Redis writes that happened
// without going through our mirror writer (e.g. an out-of-band SET from
// a migration script or another Vercel region). The version-counter
// check below handles the common case in single-digit milliseconds.
const APP_SETTINGS_HARD_REFRESH_MS = 30_000

export async function getAppSettings(
  options: { bypassCache?: boolean } = {},
): Promise<Record<string, any>> {
  const now = Date.now()
  const liveVersion = getSettingsVersionCachedSync()
  if (
    !options.bypassCache &&
    appSettingsCache &&
    appSettingsCache.version === liveVersion &&
    now - appSettingsCache.ts < APP_SETTINGS_HARD_REFRESH_MS
  ) {
    return appSettingsCache.value
  }
  try {
    const [canonical, legacy] = await Promise.all([
      getSettings(APP_SETTINGS_KEY_CANONICAL),
      getSettings(APP_SETTINGS_KEY_LEGACY),
    ])
    // Legacy provides fallback values — canonical overrides on conflict.
    const merged = { ...(legacy || {}), ...(canonical || {}) }
    appSettingsCache = { value: merged, ts: now, version: liveVersion }
    return merged
  } catch {
    return appSettingsCache?.value ?? {}
  }
}

/**
 * Convenience scalar reader — falls back through:
 *   1. Individual `settings:{field}` hash (legacy orphan-key path)
 *   2. Canonical `app_settings.{field}`
 *   3. Legacy `all_settings.{field}`
 *   4. Caller-supplied default
 */
export async function getAppSetting<T = unknown>(
  field: string,
  fallback: T,
): Promise<T> {
  try {
    // 1. Individual key (some historical code writes these as scalar hashes)
    const individual = await getSettings(field)
    if (individual !== null && individual !== undefined) {
      const maybeScalar =
        typeof individual === "object" && individual && "value" in individual
          ? (individual as any).value
          : individual
      if (maybeScalar !== null && maybeScalar !== undefined) {
        return maybeScalar as T
      }
    }
  } catch {
    /* non-critical */
  }
  const merged = await getAppSettings()
  const value = merged[field]
  if (value === undefined || value === null) return fallback
  return value as T
}

/**
 * Writer that keeps the canonical + legacy hashes in sync. Call this
 * from the settings UI/API instead of `setSettings("app_settings", ...)`
 * so trade-engine consumers that read `all_settings` also pick up the
 * operator's latest values on the next cycle. Also bumps the global
 * `settings_version` counter so long-running processors detect the
 * change without waiting for their local TTL to expire.
 */
export async function setAppSettings(value: Record<string, any>): Promise<void> {
  await Promise.all([
    setSettings(APP_SETTINGS_KEY_CANONICAL, value),
    setSettings(APP_SETTINGS_KEY_LEGACY,    value),
  ])
  // Bump first so the new version number is known before we stamp the
  // cache; otherwise the same-process cache would look "stale" to the
  // next reader and cause an unnecessary Redis re-read.
  const newVersion = await bumpSettingsVersion()
  appSettingsCache = { value, ts: Date.now(), version: newVersion }
}

/** Invalidates the in-process app-settings cache. Callable from any write path. */
export function invalidateAppSettingsCache(): void {
  appSettingsCache = null
}

// ──────────���──��─────────────────────���──────────────���─���────────────���───
// Live-settings version counter
//
// When an operator hits Save in the Settings UI, the server updates the
// canonical + legacy Redis hashes. But the trade engine is a long-running
// process on its own timers (possibly on another serverless instance),
// so it needs a CHEAP signal that "something changed, bust your cache".
//
// Pattern: a monotonic integer counter at key `settings_version`.
//   - Writers call `bumpSettingsVersion()` (INCR) after every save.
//   - Consumers call `getSettingsVersion()` once per cycle (O(1) GET)
//     and compare against their last-seen value. On mismatch they
//     invalidate their cache of parsed settings fields.
//
// The counter read is itself cached in-process for 250 ms so a tight
// inner loop doing many reads doesn't hammer Redis on every call.
// ─────────────────────────────────────────────────────────────────────

const SETTINGS_VERSION_KEY = "settings_version" as const
let _settingsVersionCached: number = 0
let _settingsVersionFetchedAt = 0
let _settingsVersionRefreshing = false
const SETTINGS_VERSION_READ_TTL_MS = 250

/**
 * Synchronous snapshot of the latest settings version. Used by hot-path
 * cycle loops that can't await. Never hits Redis — returns the value
 * maintained by the most recent call to `getSettingsVersion()` (or the
 * background poll). Callers that see a stale value will simply get a
 * belated refresh on the next cycle, which is acceptable because the
 * soft-refresh deadline kicks in anyway.
 */
export function getSettingsVersionCachedSync(): number {
  // Opportunistically fire a background refresh if the snapshot is
  // older than the read TTL so cycle loops that never call the async
  // variant still see updates within ~250 ms + one cycle.
  const now = Date.now()
  if (
    !_settingsVersionRefreshing &&
    now - _settingsVersionFetchedAt > SETTINGS_VERSION_READ_TTL_MS
  ) {
    _settingsVersionRefreshing = true
    ;(async () => {
      try {
        await initRedis()
        const client = getClient()
        const raw = await client.get(SETTINGS_VERSION_KEY)
        const parsed = Number(raw)
        _settingsVersionCached = Number.isFinite(parsed) ? parsed : _settingsVersionCached
        _settingsVersionFetchedAt = Date.now()
      } catch {
        _settingsVersionFetchedAt = Date.now()
      } finally {
        _settingsVersionRefreshing = false
      }
    })()
  }
  return _settingsVersionCached
}

/**
 * Returns the latest settings version. Cheap — cached for 250 ms. Safe
 * to call on every engine cycle. A strictly monotonic-increasing
 * integer; any change means "something changed, refresh your cache".
 */
export async function getSettingsVersion(): Promise<number> {
  const now = Date.now()
  if (now - _settingsVersionFetchedAt < SETTINGS_VERSION_READ_TTL_MS) {
    return _settingsVersionCached
  }
  if (_settingsVersionRefreshing) {
    // Another in-flight refresh is already going to land shortly; skip
    // the duplicate Redis call and return whatever we had.
    return _settingsVersionCached
  }
  _settingsVersionRefreshing = true
  try {
    await initRedis()
    const client = getClient()
    const raw = await client.get(SETTINGS_VERSION_KEY)
    const parsed = Number(raw)
    _settingsVersionCached = Number.isFinite(parsed) ? parsed : 0
    _settingsVersionFetchedAt = now
  } catch {
    // Keep the last-known value on a transient Redis error.
    _settingsVersionFetchedAt = now
  } finally {
    _settingsVersionRefreshing = false
  }
  return _settingsVersionCached
}

/**
 * Bumps the settings version counter. Call this from every write path
 * that mutates settings (including system settings, per-connection
 * settings, etc.) so cache holders know to refresh. Also invalidates
 * the in-process `appSettingsCache` so the next read in this process
 * is guaranteed fresh without waiting for the 2 s TTL.
 */
export async function bumpSettingsVersion(): Promise<number> {
  try {
    await initRedis()
    const client = getClient()
    const next = await client.incr(SETTINGS_VERSION_KEY)
    const parsed = Number(next)
    _settingsVersionCached = Number.isFinite(parsed) ? parsed : _settingsVersionCached + 1
    _settingsVersionFetchedAt = Date.now()
    // Flush the in-process caches immediately so the same process that
    // wrote the value doesn't hand out stale merged data to readers
    // that call `getAppSettings()` within the 2 s TTL window.
    invalidateAppSettingsCache()
    return _settingsVersionCached
  } catch {
    // If Redis is briefly unavailable, at least invalidate the local
    // cache so the same process re-fetches on next read.
    invalidateAppSettingsCache()
    return _settingsVersionCached
  }
}

// ========== Market Data Operations ==========

export async function getMarketData(symbol: string, interval: string): Promise<any | null> {
  // ── Spec §7 migration: 1s is the canonical timeframe ─────────────
  //
  // The market-data loader was migrated to write only the `:1s`
  // envelope, but dozens of legacy callsites still pass `"1m"`
  // (default in older code paths). Rather than churn every caller
  // we transparently fall back to `:1s` whenever the requested
  // interval is absent. The envelope shape is identical so consumers
  // can't tell the difference; only the `timeframe` field reports
  // "1s" instead of "1m", which all known readers ignore.
  await initRedis()
  const client = getClient()
  const primary = await client.get(`market_data:${symbol}:${interval}`)
  let data = primary
  if (!data && interval !== "1s") {
    data = await client.get(`market_data:${symbol}:1s`)
  }
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

export async function setMarketData(symbol: string, interval: string, data: any, ttlSeconds?: number): Promise<void> {
  await initRedis()
  const client = getClient()
  const finalTtl = ttlSeconds ?? 300
  await client.set(`market_data:${symbol}:${interval}`, JSON.stringify(data), { EX: finalTtl })
}

// ========== Position Operations ==========

export async function getPosition(id: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`position:${id}`)
  return parseHash(hash)
}

export async function getAllPositions(): Promise<any[]> {
  await initRedis()
  const client = getClient()
  return readIndexedHashes(client, SECONDARY_INDEX_KEYS.positions, "position:")
}

export async function savePosition(position: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const id = position.id
  if (!id) {
    throw new Error("Position must have an id")
  }
  await assertDatabaseWriteBudget("savePosition")

  // Special-case live positions (keys prefixed with "live:") — the live
  // pipeline uses JSON-string keys and open/closed indices under
  // `live:position:${id}` and `live:positions:${connectionId}`. The
  // legacy `position:${id}` hash form is preserved for non-live positions.
  if (String(id).startsWith("live:")) {
    const liveKey = `live:position:${id}`
    try {
      // Persist JSON snapshot (7 day TTL)
      await client.set(liveKey, JSON.stringify(position), ({ ex: 7 * 24 * 60 * 60 } as any))
    } catch {
      // Some adapters don't support EX option — fall back to set only
      await client.set(liveKey, JSON.stringify(position))
    }

	    const connId = position.connectionId || position.connection_id || "unknown"
	    if (!connId || connId === "unknown") {
	      return
	    }

	    // Maintain lightweight reverse indexes for exchange/client tracking IDs.
	    // Live reconciliation and operator diagnostics can resolve a venue order
	    // back to the exact system-owned LivePosition without relying only on
	    // symbol+direction matching (which is ambiguous during restarts,
	    // accumulation, or hedge-mode long+short coexistence).
	    try {
	      const exchangeData = position.exchangeData || {}
	      const trackingIds = new Set<string>()
	      for (const candidate of [
	        position.trackingId,
	        position.system_tracking_id,
	        position.connection_tracking_id,
	        position.exchangeTrackingId,
	        position.clientOrderId,
	        exchangeData.trackingId,
	        exchangeData.system_tracking_id,
	        exchangeData.connection_tracking_id,
	        exchangeData.exchangeTrackingId,
	        exchangeData.clientOrderId,
	      ]) {
	        if (candidate != null && String(candidate).length > 0) trackingIds.add(String(candidate))
	      }
	      if (Array.isArray(exchangeData.clientOrderIds)) {
	        for (const entry of exchangeData.clientOrderIds) {
	          const clientOrderId = entry?.clientOrderId ?? entry?.id
	          if (clientOrderId != null && String(clientOrderId).length > 0) trackingIds.add(String(clientOrderId))
	        }
	      }
	      for (const trackingId of trackingIds) {
	        const key = `live:position:tracking:${connId}:${trackingId}`
	        await client.set(key, id).catch(() => null)
	        await client.expire(key, 7 * 24 * 60 * 60).catch(() => 0)
	      }
	    } catch {
	      // best-effort diagnostics/reconciliation index
	    }

	    // Terminal => move from open index -> closed archive idempotently.
	    // ALL terminal statuses must leave the open index — previously only
	    // "closed" was handled, so "rejected"/"cancelled"/"error" positions fell
	    // into the else-branch below which RE-ADDED them to the open index on
	    // every save. That kept dead positions in the sync loop forever
	    // (observed: tracked=16 statuses={"rejected":16} re-synced every tick).
    const TERMINAL_LIVE_STATUSES = new Set(["closed", "rejected", "cancelled", "canceled", "error"])
    if (TERMINAL_LIVE_STATUSES.has(String(position.status))) {
      try {
        // Remove any existing entries from open list
        await client.lrem(`live:positions:${connId}`, 0, id).catch(() => 0)
        // Check if already in closed list to avoid duplicates.
        // IMPORTANT: lpos returns 0 (integer) when found at index 0 — truthy check
        // `!alreadyClosed` treats 0 as falsy and incorrectly re-adds the entry.
        // Use explicit null/undefined check instead.
        const alreadyClosed = await client.lpos(`live:positions:${connId}:closed`, id).catch(() => null)
        if (alreadyClosed === null || alreadyClosed === undefined) {
          // Only add if not already present
          await client.lpush(`live:positions:${connId}:closed`, id).catch(() => 0)
        }
        await client.ltrim(`live:positions:${connId}:closed`, 0, 499).catch(() => {})
        // Mark moved so closeLivePosition can detect duplicate increments
        await client.set(`live:positions:${connId}:moved:${id}`, String(Date.now())).catch(() => null)
        await client.expire(`live:positions:${connId}:moved:${id}`, 60 * 60).catch(() => 0)
        
        // Perf: Remove setKey/parentSetKey from live_set_keys index when position closes
        // so getOpenLiveSetKeys fast-path (coordinator's getOpenLiveSetKeys) returns only
        // keys for currently-open positions. This prevents stale keys from accumulating.
        if (position.setKey || position.parentSetKey) {
          try {
            const indexKey = `live_set_keys:${connId}`
            if (position.setKey) await client.srem(indexKey, position.setKey).catch(() => 0)
            if (position.parentSetKey) await client.srem(indexKey, position.parentSetKey).catch(() => 0)
          } catch {
            // best-effort index maintenance
          }
        }
      } catch {
        // best-effort
      }
    } else {
      // Ensure id appears once in the open index (dedupe via lrem -> lpush)
      try {
        await client.lrem(`live:positions:${connId}`, 0, id).catch(() => 0)
        await client.lpush(`live:positions:${connId}`, id).catch(() => 0)
        
        // Perf: Add setKey/parentSetKey to live_set_keys index when position opens so
        // coordinator's getOpenLiveSetKeys can retrieve all active set keys via O(1) SMEMBERS
        // instead of fetching all positions and iterating. Index is maintained as open positions
        // are placed/closed, automatically staying in sync with the live index.
        if (position.setKey || position.parentSetKey) {
          try {
            const indexKey = `live_set_keys:${connId}`
            if (position.setKey) await client.sadd(indexKey, position.setKey).catch(() => 0)
            if (position.parentSetKey) await client.sadd(indexKey, position.parentSetKey).catch(() => 0)
            // TTL: index is ephemeral and auto-maintained; 24h TTL allows recovery if a close
            // marker somehow fails to fire. Fallback scans in getLivePositions will repopulate if needed.
            await client.expire(indexKey, 86400).catch(() => 0)
          } catch {
            // best-effort index maintenance; coordinator falls back to scan on empty index
          }
        }
      } catch {
        // best-effort
      }
    }

    return
  }

  // Non-live positions: maintain as a hash (legacy behaviour)
  const data = flattenForHmset({
    ...position,
    updated_at: new Date().toISOString(),
  })

  await updatePositionIndexes(client, id, data)
  await client.hset(`position:${id}`, data)
}

export async function deletePosition(id: string): Promise<void> {
  await initRedis()
  const client = getClient()
  await removePositionIndexes(client, id)
  await client.del(`position:${id}`)
}

// ========== Trade Operations ==========

export async function getTrade(id: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`trade:${id}`)
  return parseHash(hash)
}

export async function getAllTrades(): Promise<any[]> {
  await initRedis()
  const client = getClient()
  return readIndexedHashes(client, SECONDARY_INDEX_KEYS.trades, "trade:")
}

export async function saveTrade(trade: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const id = trade.id
  if (!id) {
    throw new Error("Trade must have an id")
  }
  await assertDatabaseWriteBudget("saveTrade")
  
  const data = flattenForHmset({
    ...trade,
    updated_at: new Date().toISOString(),
  })
  
  await updateTradeIndexes(client, id, data)
  await client.hset(`trade:${id}`, data)
}

// ========== Indication Operations ==========

export async function getIndication(id: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`indication:${id}`)
  return parseHash(hash)
}

export async function getAllIndications(): Promise<any[]> {
  await initRedis()
  const client = getClient()
  return readIndexedHashes(client, SECONDARY_INDEX_KEYS.indications, "indication:")
}

export async function saveIndication(indication: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const id = indication.id
  if (!id) {
    throw new Error("Indication must have an id")
  }
  const budget = await assertDatabaseWriteBudget("saveIndication", { optional: true })
  if (!budget.allowed) return
  
  const data = flattenForHmset({
    ...indication,
    updated_at: new Date().toISOString(),
  })
  
  const key = `indication:${id}`
  await client.sadd(SECONDARY_INDEX_KEYS.indications, id)
  await client.hset(key, data)
  // Bound retention: prehistoric/realtime can mint hundreds of thousands
  // of these. Without a TTL the in-process Redis snapshot grows
  // unbounded (observed 295k keys / 39MB after a few quickstart runs)
  // and dev memory blows past the 6GB heap. 24h is plenty for any
  // dashboard/debug consumer; the `indications:{connId}:*` lists
  // (lib/indication-evaluator.ts) are the durable view.
  await client.expire(key, 86400).catch(() => 0)
}

// ========== Strategy Operations ==========

export async function getStrategy(id: string): Promise<any | null> {
  await initRedis()
  const client = getClient()
  const hash = await client.hgetall(`strategy:${id}`)
  return parseHash(hash)
}

export async function getAllStrategies(): Promise<any[]> {
  await initRedis()
  const client = getClient()
  return readIndexedHashes(client, SECONDARY_INDEX_KEYS.strategies, "strategy:")
}

export async function saveStrategy(strategy: any): Promise<void> {
  await initRedis()
  const client = getClient()
  const id = strategy.id
  if (!id) {
    throw new Error("Strategy must have an id")
  }
  await assertDatabaseWriteBudget("saveStrategy")
  
  const data = flattenForHmset({
    ...strategy,
    updated_at: new Date().toISOString(),
  })
  
  await client.sadd(SECONDARY_INDEX_KEYS.strategies, id)
  await client.hset(`strategy:${id}`, data)
}

// ========== Connection State Helpers ==========

export function getConnectionStates(connection: any): {
  base_enabled: boolean
  base_inserted: boolean
  main_enabled: boolean
  main_assigned: boolean
  is_active: boolean
} {
  return {
    base_enabled: isEnabledFlag(connection.is_enabled),
    base_inserted: isEnabledFlag(connection.is_inserted),
    main_enabled: isEnabledFlag(connection.is_enabled_dashboard),
    main_assigned:
      isEnabledFlag(connection.is_assigned) ||
      isEnabledFlag(connection.is_active_inserted) ||
      isEnabledFlag(connection.is_dashboard_inserted),
    is_active:
      (isEnabledFlag(connection.is_assigned) ||
        isEnabledFlag(connection.is_active_inserted) ||
        isEnabledFlag(connection.is_dashboard_inserted)) &&
      isEnabledFlag(connection.is_enabled_dashboard),
  }
}

export function isConnectionAssignedToMain(connection: any): boolean {
  return (
    isEnabledFlag(connection.is_assigned) ||
    isEnabledFlag(connection.is_active_inserted) ||
    isEnabledFlag(connection.is_dashboard_inserted)
  )
}

export function isConnectionMainEnabled(connection: any): boolean {
  return isConnectionAssignedToMain(connection) && isEnabledFlag(connection.is_enabled_dashboard)
}

async function syncMainEnabledConnectionIndex(client: RedisClientLike, connection: any): Promise<void> {
  await syncConnectionSecondaryIndexes(client, connection)
}

export function isConnectionProcessingEnabled(connection: any): boolean {
  return isEnabledFlag(connection.is_enabled_dashboard)
}

export function isConnectionBaseEnabled(connection: any): boolean {
  return isEnabledFlag(connection.is_enabled)
}

export function buildMainConnectionEnableUpdate(_connection: any): any {
  return {
    is_assigned: "1",
    is_enabled_dashboard: "1",
    is_dashboard_inserted: "1",
    is_active_inserted: "1",
    is_active: "1",
    updated_at: new Date().toISOString(),
  }
}

export function buildMainConnectionDisableUpdate(_connection: any): any {
  return {
    is_assigned: "1",
    is_enabled_dashboard: "0",
    is_active: "0",
    updated_at: new Date().toISOString(),
  }
}

export function buildMainConnectionRemoveUpdate(_connection: any): any {
  return {
    is_assigned: "0",
    is_active_inserted: "0",
    is_dashboard_inserted: "0",
    is_enabled_dashboard: "0",
    is_active: "0",
    updated_at: new Date().toISOString(),
  }
}

export function buildBaseConnectionEnableUpdate(_connection: any): any {
  return {
    is_enabled: "1",
    is_inserted: "1",
    updated_at: new Date().toISOString(),
  }
}

// ========== Stats Operations ==========

export async function closeRedis(): Promise<void> {
  isConnected = false
  globalForRedis.__redis_fully_connected = false
}

export function getRedisRequestsPerSecond(): number {
  const data = globalForRedis.__redis_data
  if (!data || !data.requestStats) return 0
  const stats = data.requestStats
  // If still within the current second, return running count; otherwise return last completed second
  const nowSec = Math.floor(Date.now() / 1000)
  if (nowSec === stats.lastSecond) {
    return stats.requestCount
  }
  return stats.operationsPerSecond
}

export function getConnectionState(id: string): { isRunning: boolean } {
  // Simple state check based on global tracking
  const globalEngineState = globalThis as unknown as { __engine_states?: Map<string, boolean> }
  if (!globalEngineState.__engine_states) {
    globalEngineState.__engine_states = new Map()
  }
  return { isRunning: globalEngineState.__engine_states.get(id) ?? false }
}

export function setConnectionRunningState(id: string, isRunning: boolean): void {
  const globalEngineState = globalThis as unknown as { __engine_states?: Map<string, boolean> }
  if (!globalEngineState.__engine_states) {
    globalEngineState.__engine_states = new Map()
  }
  globalEngineState.__engine_states.set(id, isRunning)
}

// ========== Migration State Management ==========

const globalMigrationState = globalThis as unknown as { __migrations_run?: boolean }

/**
 * Check if migrations have run — uses in-memory state. Returns true if we've
 * already cached that migrations ran; false otherwise.
 * The actual durability check (reading Redis) happens during runMigrations,
 * which compares Redis schema_version against code's max. The in-memory state
 * here just avoids re-running migrations multiple times in the same process.
 */
export function haveMigrationsRun(): boolean {
  return globalMigrationState.__migrations_run ?? false
}

export function setMigrationsRun(value: boolean): void {
  globalMigrationState.__migrations_run = value
  // Also write to Redis for durability across process restart
  try {
    const client = getRedisClient()
    if (client && value) {
      // Non-blocking fire-and-forget Redis write
      client.set("_migrations_run", "true").catch(() => {
        // Ignore write failure — we have the in-memory state as fallback
      })
    }
  } catch {
    // Ignore Redis errors — in-memory state is sufficient fallback
  }
}

/**
 * Returns true when running in a production or Vercel preview environment.
 * Used to decide whether to run expensive "complete coverage" repair passes
 * on every cold start (required for correct migration state + non-zero counts).
 */
export function isProductionEnvironment(): boolean {
  if (typeof process === "undefined") return false
  const env = process.env.NODE_ENV
  const vercelEnv = process.env.VERCEL_ENV || process.env.VERCEL
  // Treat "production" and "preview" (Vercel PR previews) as "production mode" for migrations.
  if (env === "production") return true
  if (vercelEnv === "production" || vercelEnv === "preview") return true
  // Fallback for common hosting hints
  if (process.env.CI === "true" || process.env.VERCEL_GIT_COMMIT_SHA) return true
  return false
}

/**
 * Global Unique Site / Project / Page Instance
 * 
 * The COMPLETE SITE (independent of any individual connection) must be one
 * single unique continuous instance.
 * 
 * - Created exactly once (first ever boot or after explicit full reset).
 * - Every page refresh, new tab, independent open, cron, etc. reuses the
 *   exact same site_session_id.
 * - Prevents "starting new Overall Progression / Instances" on every visit.
 * - "Just Unique" for the whole project.
 */
export async function ensureUniqueSiteInstance(): Promise<{ siteSessionId: string; isNew: boolean }> {
  // This helper is called from production migration coverage while initRedis()
  // is already awaiting runMigrations(). Calling initRedis() again from that
  // path deadlocks on the in-flight global init promise. During an init run the
  // core client is already ready, so use ensureCoreRedis() and proceed; outside
  // init we still run the full init path for normal callers.
  if (globalForRedis.__redis_init_promise && !isConnected) {
    await ensureCoreRedis()
  } else {
    await initRedis()
  }
  const client = getRedisClient()
  if (!client) {
    return { siteSessionId: "fallback-" + Date.now(), isNew: true }
  }

  const result = await ensureUniqueSiteInstanceWithClient(client)
  if (result.isNew) {
    console.log(`[v0] [SiteInstance] Created the one unique site/project instance: ${result.siteSessionId}`)
  }
  return { siteSessionId: result.siteSessionId, isNew: result.isNew }
}

export async function getCurrentSiteInstanceId(): Promise<string | null> {
  await initRedis()
  const client = getRedisClient()
  if (!client) return null
  const durableId = await client.get(GLOBAL_SITE_INSTANCE_ID_KEY).catch(() => null)
  if (durableId) return durableId
  const data = await client.hgetall(GLOBAL_SITE_INSTANCE_KEY).catch(() => null)
  return data?.site_session_id || null
}

// ========== Engine Connection Operations ==========

export async function getActiveConnectionsForEngine(): Promise<any[]> {
  const client = getRedisClient()
  const indexedIds = await client.smembers("connections:main:enabled").catch(() => [] as string[])
  const connections: any[] = []

  if (indexedIds.length > 0) {
    await Promise.all(indexedIds.map(async (id) => {
      const data = await client.hgetall(`connection:${id}`).catch(() => ({}))
      const connection = { id, ...data }
      if (data && Object.keys(data).length > 0 && isConnectionMainEnabled(connection)) {
        connections.push(connection)
      } else {
        await client.srem("connections:main:enabled", id).catch(() => 0)
      }
    }))
    return connections
  }

  const ids = await client.smembers("connections").catch(() => [] as string[])
  for (const id of ids) {
    const data = await client.hgetall(`connection:${id}`)
    if (data && Object.keys(data).length > 0) {
      const connection = {
        id,
        ...data,
      }
      if (isConnectionMainEnabled(connection)) {
        connections.push(connection)
        await client.sadd("connections:main:enabled", id).catch(() => 0)
      }
    }
  }

  return connections
}

export async function getAllConnectionsWithStatus(): Promise<any[]> {
  return getAllConnections()
}

// ========== Additional CRUD Operations ==========

export async function createConnection(data: any): Promise<any> {
  await initRedis()
  const client = getRedisClient()
  const id = data.id || `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

  // Check if connection already exists to prevent duplicates — if it
  // does, update it in place rather than producing a conflicting
  // second row. This is the behaviour the orphan block below was
  // trying to express before it was accidentally left outside the
  // function body (which broke the build with "Return statement is
  // not allowed here" at the module top level).
  const existingConnection = await client.hgetall(`connection:${id}`)
  if (existingConnection && Object.keys(existingConnection).length > 0) {
    console.log(`[v0] [Redis] Connection already exists with id ${id}, updating instead of creating duplicate`)
    const merged = {
      ...data,
      id,
      updated_at: new Date().toISOString(),
    }
    await Promise.all([
      client.hset(`connection:${id}`, merged),
      client.sadd("connections", id),
      syncConnectionSecondaryIndexes(client, merged, { id, ...existingConnection }),
    ])
    invalidateConnectionsCache()
    return merged
  }

  const connectionData = {
    ...data,
    id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  await Promise.all([
    client.hset(`connection:${id}`, connectionData),
    client.sadd("connections", id),
    syncMainEnabledConnectionIndex(client, connectionData),
  ])
  invalidateConnectionsCache()
  return connectionData
}

export async function updateConnection(id: string, updates: any): Promise<any> {
  const client = getRedisClient()
  const existing = await client.hgetall(`connection:${id}`)
  if (!existing || Object.keys(existing).length === 0) {
    return null
  }
  const updatedAt = new Date().toISOString()
  const connectionPatch = Object.entries(updates || {}).reduce<Record<string, any>>(
    (patch, [key, value]) => {
      // `undefined` means "not supplied" for every settings/switch route. Do
      // not stringify it into Redis or accidentally clear a sibling setting.
      if (value !== undefined) patch[key] = value
      return patch
    },
    { updated_at: updatedAt },
  )
  const canonicalSettingsPatch = Object.entries(connectionPatch).reduce<Record<string, string>>(
    (patch, [key, value]) => {
      if (CONNECTION_SETTINGS_CANONICAL_FIELDS.has(key) && value !== undefined && value !== null) {
        patch[key] = typeof value === "string" ? value : JSON.stringify(value)
      }
      return patch
    },
    { updated_at: updatedAt },
  )

  // Write only changed fields. The former read/merge/full-HSET sequence lost
  // concurrent edits to unrelated fields because the last stale snapshot won.
  // Redis HSETs on disjoint fields now compose safely; same-field switches keep
  // normal last-writer semantics and are ordered by state_switch_version.
  await Promise.all([
    client.hset(`connection:${id}`, connectionPatch),
    // Keep the canonical settings mirror in the same write barrier. Readers
    // intentionally merge this hash with connection:{id}; leaving an older
    // mirror behind can override a newly enabled live-trade flag or symbol
    // basket and silently route a requested live run through simulation.
    client.hset(`settings:connection:${id}`, canonicalSettingsPatch),
  ])
  const updated = await client.hgetall(`connection:${id}`)
  await syncConnectionSecondaryIndexes(client, updated, { id, ...existing })
  invalidateConnectionsCache()
  return updated
}

export interface ConnectionStatePatchResult {
  applied: boolean
  connection: Record<string, any> | null
}

export interface ConnectionStateRelatedHashPatch {
  key: string
  patch: Record<string, unknown>
}

function redisHashValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null) return ""
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  return JSON.stringify(value)
}

/**
 * Atomically commit a runtime switch generation if it is newer than the
 * generation currently stored on the connection.
 *
 * Shared Redis uses one Lua compare-and-HSET across the connection and its
 * canonical settings mirror. Inline preview uses a global per-connection
 * promise queue. Returning `applied:false` lets route handlers stop before
 * publishing/queuing work for an obsolete user action.
 */
export async function updateConnectionState(
  id: string,
  updates: Record<string, any>,
  stateSwitchVersion: string | number,
  options: { relatedHashPatches?: ConnectionStateRelatedHashPatch[] } = {},
): Promise<ConnectionStatePatchResult> {
  const client = getRedisClient()
  const existing = await client.hgetall(`connection:${id}`)
  if (!existing || Object.keys(existing).length === 0) return { applied: false, connection: null }

  const proposedVersion = Number(stateSwitchVersion)
  if (!Number.isSafeInteger(proposedVersion) || proposedVersion < 0) {
    throw new Error(`Invalid state switch generation for ${id}: ${stateSwitchVersion}`)
  }
  const updatedAt = new Date().toISOString()
  const connectionPatch = Object.entries({
    ...updates,
    state_switch_version: String(proposedVersion),
    updated_at: updates.updated_at || updatedAt,
  }).reduce<Record<string, string>>((patch, [key, value]) => {
    if (value !== undefined) patch[key] = redisHashValue(value)
    return patch
  }, {})
  const canonicalSettingsPatch = Object.entries(connectionPatch).reduce<Record<string, string>>(
    (patch, [key, value]) => {
      if (key === "updated_at" || CONNECTION_SETTINGS_CANONICAL_FIELDS.has(key)) patch[key] = value
      return patch
    },
    {},
  )
  const relatedHashPatches = (options.relatedHashPatches || [])
    .filter((item) => item?.key && Object.keys(item.patch || {}).length > 0)
    .map((item) => ({
      key: item.key,
      patch: Object.entries(item.patch).reduce<Record<string, string>>((out, [field, value]) => {
        if (value !== undefined) out[field] = redisHashValue(value)
        return out
      }, {}),
    }))

  let applied = false
  if (getRedisBackend() === "redis-network") {
    if (typeof client.eval !== "function") {
      throw new Error("Shared Redis adapter does not support atomic state transitions")
    }
    const connectionEntries = Object.entries(connectionPatch)
    const settingsEntries = Object.entries(canonicalSettingsPatch)
    const relatedEntries = relatedHashPatches.map((item) => ({ key: item.key, entries: Object.entries(item.patch) }))
    const script = `
      if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
      local current = tonumber(redis.call('HGET', KEYS[1], 'state_switch_version') or '0') or 0
      local proposed = tonumber(ARGV[1])
      if (not proposed) or proposed <= current then return 0 end
      local index = 2
      local connectionCount = tonumber(ARGV[index]); index = index + 1
      for i = 1, connectionCount do
        redis.call('HSET', KEYS[1], ARGV[index], ARGV[index + 1])
        index = index + 2
      end
      local settingsCount = tonumber(ARGV[index]); index = index + 1
      for i = 1, settingsCount do
        redis.call('HSET', KEYS[2], ARGV[index], ARGV[index + 1])
        index = index + 2
      end
      local relatedCount = tonumber(ARGV[index]); index = index + 1
      for relatedIndex = 1, relatedCount do
        local fieldCount = tonumber(ARGV[index]); index = index + 1
        for fieldIndex = 1, fieldCount do
          redis.call('HSET', KEYS[relatedIndex + 2], ARGV[index], ARGV[index + 1])
          index = index + 2
        end
      end
      return 1
    `
    const result = await client.eval(script, {
      keys: [`connection:${id}`, `settings:connection:${id}`, ...relatedEntries.map((item) => item.key)],
      arguments: [
        String(proposedVersion),
        String(connectionEntries.length),
        ...connectionEntries.flatMap(([field, value]) => [field, value]),
        String(settingsEntries.length),
        ...settingsEntries.flatMap(([field, value]) => [field, value]),
        String(relatedEntries.length),
        ...relatedEntries.flatMap((item) => [
          String(item.entries.length),
          ...item.entries.flatMap(([field, value]) => [field, value]),
        ]),
      ],
    })
    applied = Number(result) === 1
  } else {
    const queues = globalForRedis.__connection_state_queues || new Map<string, Promise<void>>()
    globalForRedis.__connection_state_queues = queues
    const previous = queues.get(id) || Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      const latest = await client.hgetall(`connection:${id}`)
      if (!latest || Object.keys(latest).length === 0) return
      const currentVersion = Number(latest?.state_switch_version ?? 0)
      if (Number.isFinite(currentVersion) && proposedVersion <= currentVersion) return
      await Promise.all([
        client.hset(`connection:${id}`, connectionPatch),
        client.hset(`settings:connection:${id}`, canonicalSettingsPatch),
        ...relatedHashPatches.map((item) => client.hset(item.key, item.patch)),
      ])
      applied = true
    })
    queues.set(id, current)
    try {
      await current
    } finally {
      if (queues.get(id) === current) queues.delete(id)
    }
  }

  const connection = await client.hgetall(`connection:${id}`)
  if (applied) await syncMainEnabledConnectionIndex(client, connection)
  invalidateConnectionsCache()
  return { applied, connection }
}

export async function createPosition(data: any): Promise<any> {
  const client = getRedisClient()
  const id = data.id || `pos_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  const positionData = {
    ...data,
    id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  // ── Memory safety: expire positions after 30 days ──────────────────
  // Without TTL, positions accumulate indefinitely, consuming RAM.
  // 30 days is a reasonable retention window for trade history.
  const POSITION_TTL_SEC = 30 * 24 * 60 * 60
  await Promise.all([
    updatePositionIndexes(client, id, positionData),
    client.hset(`position:${id}`, positionData),
    client.expire(`position:${id}`, POSITION_TTL_SEC),
    client.sadd("positions:all", id),
  ])
  return positionData
}

export async function getIndications(connectionId?: string, symbol?: string): Promise<any[]> {
  const client = getRedisClient()
  const indications: any[] = []
  
  try {
    // Indications are stored as Redis lists at: indications:{connectionId}:{symbol}
    // If symbol is provided, fetch directly from that list
    if (connectionId && symbol) {
      const listKey = `indications:${connectionId}:${symbol}`
      const listData = await client.lrange(listKey, 0, 499) // Get last 500
      if (listData && listData.length > 0) {
        for (const item of listData) {
          try {
            const parsed = typeof item === "string" ? JSON.parse(item) : item
            indications.push(parsed)
          } catch (e) {
            // Skip malformed entries
          }
        }
        return indications
      }
    }
    
    // If no symbol specified, collect from all symbol lists for this connection
    if (connectionId) {
      const pattern = `indications:${connectionId}:*`
      const keys = await client.keys(pattern)
      
      for (const key of keys) {
        // Only process keys that are symbol-specific lists: indications:{connectionId}:{symbol}
        // Skip auxiliary keys: indications:{connectionId}:{symbol}:type, :latest, etc.
        // Pattern: key should end after symbol, no more colons
        const keyPattern = /^indications:[^:]+:[^:]+$/
        const isSymbolKey = keyPattern.test(key) && !key.includes(":type:") && !key.includes(":latest:")
        
        if (isSymbolKey) {
          // This is a symbol-specific list, fetch with LRANGE
          const listData = await client.lrange(key, 0, 499)
          if (listData && listData.length > 0) {
            for (const item of listData) {
              try {
                const parsed = typeof item === "string" ? JSON.parse(item) : item
                indications.push(parsed)
              } catch (e) {
                // Skip malformed entries
              }
            }
          }
        }
      }
      
      if (indications.length > 0) {
        return indications
      }
    }
    
    // Final fallback: no indications found
    return []
  } catch (e) {
    console.warn(`[v0] Error reading indications for ${connectionId}/${symbol}:`, e)
    return []
  }
}

/**
 * Store indications for a connection - HIGH FREQUENCY OPTIMIZED
 * Maintains independent sets per configuration type for optimal performance
 */
export async function storeIndications(connectionId: string, symbol: string, indications: any[]): Promise<void> {
  if (!indications || indications.length === 0) return
  
  const client = getRedisClient()
  const mainKey = `indications:${connectionId}`
  
  try {
    // Stamp new indications with metadata.
    const ts = new Date().toISOString()
    const newIndications = indications.map(ind => ({
      ...ind,
      symbol,
      connectionId,
      timestamp: ts,
      configSet: getConfigurationSet(ind.type, ind.value),
    }))

    // ── Main key: read → append → trim → write ───────────────────────────
    const existingRaw = await client.get(mainKey)
    let existing: any[] = []
    if (existingRaw) {
      try {
        existing = JSON.parse(typeof existingRaw === "string" ? existingRaw : JSON.stringify(existingRaw))
        if (!Array.isArray(existing)) existing = []
      } catch { existing = [] }
    }
    existing.push(...newIndications)
    // Keep latest 2500 (250 per symbol × 10 symbols typical)
    if (existing.length > 2500) existing = existing.slice(-2500)

    // ── Per-type keys: group by type in ONE O(N) pass, NOT O(N²) ─────────
    // The previous implementation called `indications.filter(i => i.type === ind.type)`
    // inside a `for (const ind of indications)` loop — O(N²). For a batch of N
    // indications that happens P times per second this is N × P string comparisons/s.
    // Group once into a Map<type, indication[]> so each type key is written once.
    const byType = new Map<string, any[]>()
    for (const ind of newIndications) {
      const t = ind.type as string
      let bucket = byType.get(t)
      if (!bucket) { bucket = []; byType.set(t, bucket) }
      bucket.push(ind)
    }

    // Fan out all writes in parallel — single await instead of sequential loop.
    await Promise.all([
      client.set(mainKey, JSON.stringify(existing), { EX: 3600 } as any),
      ...Array.from(byType.entries()).map(([type, typeInds]) =>
        client.set(`indications:${connectionId}:${type}`, JSON.stringify(typeInds), { EX: 3600 } as any)
      ),
    ])
  } catch (error) {
    console.error(`[v0] Error storing indications for ${connectionId}:`, error)
  }
}

/**
 * Determine configuration set based on indication parameters
 * Used for organizing independent sets per configuration combination
 */
function getConfigurationSet(type: string, value: any): string {
  // Map indication characteristics to configuration sets for independent tracking
  // This allows parallel processing of different configuration combinations
  if (!value || typeof value !== "object") return "config:default"
  
  const stepCount = value.stepCount || 10
  const drawdown = value.drawdownRatio || 0.2
  const activity = value.activityRatio || 0.05
  const rangeRatio = value.rangeRatio || 0.2
  
  // Create configuration hash to group similar configs together
  const configHash = Math.abs(
    ((stepCount * 7) ^ (Math.round(drawdown * 100) * 11) ^ 
     (Math.round(activity * 1000) * 13) ^ (Math.round(rangeRatio * 100) * 17)) % 1000
  )
  
  return `config:${type}:${configHash}`
}

export async function verifyRedisHealth(): Promise<{ healthy: boolean; latency: number; error?: string }> {
  const start = Date.now()
  try {
    const client = getRedisClient()
    // Simple ping test
    await client.set("health:check", Date.now().toString())
    const result = await client.get("health:check")
    const latency = Date.now() - start
    return {
      healthy: result !== null,
      latency,
    }
  } catch (error) {
    return {
      healthy: false,
      latency: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// ========== Connection Position and Trade Operations ==========

export async function getConnectionPositions(connectionId: string): Promise<any[]> {
  const client = getRedisClient()
  return readIndexedHashes(client, positionConnectionIndexKey(connectionId), "position:")
}

export async function getConnectionTrades(connectionId: string): Promise<any[]> {
  const client = getRedisClient()
  return readIndexedHashes(client, tradeConnectionIndexKey(connectionId), "trade:")
}

export async function getProgressionLogs(connectionId: string, limit: number = 50): Promise<any[]> {
  const client = getRedisClient()
  // Get logs from sorted set or list
  const logsKey = `progression:${connectionId}:logs`
  const logsList = await client.lrange(logsKey, 0, limit - 1)
  
  const logs: any[] = []
  for (const logStr of logsList) {
    try {
      const log = typeof logStr === "string" ? JSON.parse(logStr) : logStr
      logs.push(log)
    } catch {
      logs.push({ message: logStr, timestamp: new Date().toISOString() })
    }
  }
  
  return logs
}

export async function logProgressionEvent(
  connectionId: string,
  phase: string,
  level: "info" | "warning" | "error",
  message: string,
  metadata?: Record<string, any>
): Promise<void> {
  const client = getRedisClient()
  const budget = await assertDatabaseWriteBudget("logProgressionEvent", { optional: true })
  if (!budget.allowed) return
  const logsKey = `progression:${connectionId}:logs`
  
  const logEntry = JSON.stringify({
    timestamp: new Date().toISOString(),
    phase,
    level,
    message,
    ...metadata,
  })
  
  // Add to list (prepend for newest first)
  await client.lpush(logsKey, logEntry)
  // Keep only last 100 logs
  await client.ltrim(logsKey, 0, 99)
  // Set TTL of 7 days
  await client.expire(logsKey, 7 * 24 * 60 * 60)
}

// ========== Connection Filter Functions ==========

export async function getEnabledConnections(): Promise<any[]> {
  const allConnections = await getAllConnections()
  return allConnections.filter(conn => isEnabledFlag(conn.is_enabled) || isEnabledFlag(conn.enabled))
}

export async function getAssignedAndEnabledConnections(): Promise<any[]> {
  return getActiveConnectionsForEngine()
}

export async function getConnectionsByExchange(exchange: string): Promise<any[]> {
  const allConnections = await getAllConnections()
  return allConnections.filter(conn => 
    conn.exchange?.toLowerCase() === exchange.toLowerCase() ||
    conn.exchange_name?.toLowerCase() === exchange.toLowerCase()
  )
}

// ========== Missing Exports for db.ts compatibility ==========

export async function deleteSettings(key: string): Promise<void> {
  const client = getRedisClient()
  await client.del(`settings:${key}`)
}

export async function flushAll(): Promise<void> {
  const client = getRedisClient()
  await client.flushDb()
}

// Cache getRedisStats for 5 s. The key count comes from `client.dbSize()`
// rather than `client.keys("*")`, so this health/stat path avoids
// materializing the full key list while still protecting polling dashboards
// from repeatedly hitting Redis.
let _redisStatsCache: {
  value: { connected: boolean; memoryUsage: number; keyCount: number; uptime: number }
  ts: number
} | null = null
const REDIS_STATS_CACHE_TTL_MS = 5000

export async function getRedisStats(): Promise<{
  connected: boolean
  memoryUsage: number
  keyCount: number
  uptime: number
}> {
  const now = Date.now()
  if (_redisStatsCache && now - _redisStatsCache.ts < REDIS_STATS_CACHE_TTL_MS) {
    return _redisStatsCache.value
  }
  try {
    const client = getRedisClient()
    const keyCount = await client.dbSize()
    const value = {
      connected: true,
      memoryUsage: 0, // In-memory implementation doesn't track this
      keyCount,
      uptime: Date.now() - (globalThis as any).__redis_start_time || 0,
    }
    _redisStatsCache = { value, ts: now }
    return value
  } catch {
    const value = {
      connected: false,
      memoryUsage: 0,
      keyCount: 0,
      uptime: 0,
    }
    // Cache failures briefly too so a broken Redis doesn't pin the CPU
    // retrying connection on every polling request. Shorter TTL so
    // recovery is still detected quickly.
    _redisStatsCache = { value, ts: now - (REDIS_STATS_CACHE_TTL_MS - 1000) }
    return value
  }
}

export async function saveMarketData(symbol: string, timeframe: string, data: any): Promise<void> {
  const client = getRedisClient()
  const key = `market_data:${symbol}:${timeframe}`
  await client.set(key, JSON.stringify(data))
  // Set 24 hour TTL for market data
  await client.expire(key, 86400)
}

// ===========================================================================
// EXPLICIT PERSISTENCE FUNCTIONS
// ===========================================================================

export async function saveDatabaseSnapshot(): Promise<boolean> {
  const client = getRedisClient()
  await client.saveToDisk()
  return true
}

export async function loadDatabaseSnapshot(): Promise<boolean> {
  const client = getRedisClient()
  await client.loadFromDisk()
  return true
}

export function saveDatabaseSnapshotSync(): boolean {
  const client = getRedisClient()
  client.saveToDiskSync()
  return true
}

/**
 * Verify that a position was created by this system using system_tracking_id.
 * Prevents modifications to manually-entered or foreign orders.
 * @returns true if position has valid sys-* tracking ID, false otherwise
 */
export function isSystemCreatedPosition(position: Record<string, string> | null | undefined): boolean {
  if (!position) return false
  const trackingId = String(position.system_tracking_id || "").trim()
  // System tracking IDs follow format: sys-{connId}-{timestamp}-{random}
  return trackingId.startsWith("sys-") && trackingId.length > 10
}
