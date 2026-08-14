import {
  ensureUniqueSiteInstanceWithClient,
  GLOBAL_SITE_INSTANCE_KEY,
  GLOBAL_SITE_INSTANCE_ID_KEY,
} from "./site-instance"
import {
  removeConnectionSecondaryIndexes,
  syncConnectionSecondaryIndexes,
} from "./database-indexes"
import { createKiloDatabaseQuery, hasKiloDatabaseBackend, resolveKiloDatabaseConfig, type KiloDatabaseMethod } from "./kilo-database-client"
import { scanRedisKeys } from "./redis-scan"
import { resolveRedisRuntimeRoot } from "./redis-runtime-root"
import {
  archiveClosedLivePositionAnalytics,
  buildLivePositionAnalyticsSnapshot,
  liveClosedAnalyticsDataKey,
  liveClosedAnalyticsTimeKey,
} from "./live-position-analytics-archive"

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

function isKiloLocalPreviewRuntime(): boolean {
  if (
    process.env.KILO_LOCAL_PREVIEW_INLINE_REDIS !== "1" ||
    process.env.ALLOW_INLINE_REDIS_LIVE_TRADING === "1" ||
    !(
      process.env.KILO_DEPLOYMENT === "1" ||
      String(process.env.CTS_DEPLOYMENT_RUNTIME || "").toLowerCase() === "kilo-deploy"
    )
  ) return false
  try {
    const appUrl = String(process.env.NEXT_PUBLIC_APP_URL || process.env.DEPLOYMENT_URL || "")
    const hostname = new URL(appUrl).hostname
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
  } catch {
    return false
  }
}

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

// Process-owned storage survives Next.js server-route VM boundaries as well as
// ordinary hot reloads. Browser and Jest runtimes intentionally fall back to
// globalThis; see resolveRedisRuntimeRoot().
const globalForRedis = resolveRedisRuntimeRoot() as unknown as {
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
  // Serialized append-only recovery journal for live-position lifecycle and
  // quantity mutations. The full Redis snapshot intentionally runs only once
  // per minute; this small WAL closes that crash window without serializing
  // the complete multi-megabyte database on every engine cycle.
  __redis_live_position_wal_promise?: Promise<boolean>
  __redis_live_position_wal_batch_scheduled?: Promise<boolean>
  __redis_live_position_wal_pending?: Map<string, {
    entry: string
    candidates: Array<{ dir: string; file: string }>
  }>
  __redis_live_position_wal_write_counter?: number
  // Global equivalent of the module-scoped `isConnected` flag. Allows fresh
  // Next.js dev route modules (which re-evaluate and get isConnected=false) to
  // see the real connected state without re-running initRedis/migrations.
  __redis_fully_connected?: boolean
  __redis_backend?: RedisBackend
  __redis_observed_rps?: { value: number; measuredAt: number }
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

// Direct-Trade's historic calculation is a deterministic, reconstructible
// cache. A 32-symbol grid is intentionally split into large Redis chunks; it
// must not be copied again into InlineLocalRedis's durability snapshot on each
// position heartbeat. Runtime state, settings, open/closed positions, PF/DDT
// and processor ownership remain durable. After a restart the absent
// calculation forces the processor to rebuild the exact current grid before
// admitting another entry.
const REBUILDABLE_DIRECT_TRADE_SNAPSHOT_KEYS = new Set([
  "direct_trade:configs",
  "direct_trade:configs:manifest",
  "direct_trade:execution-configs",
  "direct_trade:execution-index",
  "direct_trade:execution-signal-index",
  "direct_trade:active-signals",
  "direct_trade:calculation",
  "direct_trade:calculation-progress",
  "direct_trade:statistics-index",
])

function isRebuildableDirectTradeSnapshotKey(key: string): boolean {
  return key.startsWith("direct_trade:configs:chunk:") || REBUILDABLE_DIRECT_TRADE_SNAPSHOT_KEYS.has(key)
}

const KILO_SNAPSHOT_TABLE = "cts_runtime_snapshot"

function hasKiloManagedDatabaseConfig(): boolean {
  return hasKiloDatabaseBackend()
}

async function executeKiloDatabaseQuery(
  sql: string,
  params: unknown[] = [],
  method: KiloDatabaseMethod = "all",
): Promise<any[]> {
  const { url, token } = resolveKiloDatabaseConfig()
  if ((!url || !token) && !hasKiloDatabaseBackend()) throw new Error("Kilo managed database credentials are not configured")

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
  /**
   * Bounded diagnostic inventory. InlineLocalRedis implements this without
   * allocating a complete KEYS("*") result; network clients can omit it.
   */
  sampleKeys?(limit: number): Promise<string[]>
  scan?(cursor: string | number, ...args: any[]): Promise<{ cursor: string; keys: string[] } | [string, string[]]>
  zadd(key: string, score: number, member: string): Promise<number>
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>
  zcount(key: string, min: number | string, max: number | string): Promise<number>
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
  persistLivePositionCheckpoint?(position: Record<string, unknown>): Promise<boolean>
  cleanupExpiredKeysPublic(): Promise<number>
  trackDatabaseOperation(limit: number): Promise<{ current: number; limit: number; exceeded: boolean }>
  getDatabaseOperationCount(): Promise<number>
}


export class InlineLocalRedis implements RedisClientLike {
  private data: RedisData
  /**
   * Active SCAN cursors for the in-process Redis adapter.
   *
   * Redis cursors are opaque. Keeping the backing Map iterators here lets one
   * cursor visit each key once instead of rebuilding and filtering the whole
   * keyspace for every page. The previous implementation was O(keys × pages)
   * and could monopolise the HTTP event loop for several seconds while a
   * historic-generation marker cleanup was running.
   */
  private scanSessions = new Map<string, {
    pattern: string
    regex: RegExp
    iterators: Array<Iterator<string>>
    collectionIndex: number
    remaining: number
    seen: Set<string>
    page: number
    expiresAt: number
  }>()
  private scanSessionCounter = 0
  private ttlCleanupIterator: Iterator<[string, number]> | null = null
  private ttlCleanupRemaining = 0

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
    
    // Schedule an atomic disk snapshot at least once per minute. Workerd has
    // no writable host filesystem; its explicit loopback-only acceptance mode
    // keeps state in this one disposable isolate and must not spawn a failing
    // fsync loop. Public deployments cannot satisfy this narrow predicate.
    if (!isKiloLocalPreviewRuntime()) this.startPersistence()
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

  private hasActiveInlineEngineOwner(): boolean {
    for (const [key, value] of this.data.strings.entries()) {
      if (key.startsWith("engine_is_running:") && ["1", "true", "running"].includes(String(value).trim().toLowerCase())) {
        return true
      }
      // The ownership lease is acquired before the manager can publish its
      // first heartbeat/running flag.  Treat that short bootstrap period as
      // active too: a minute snapshot or a full keyspace eviction in that gap
      // can otherwise block the very engine that is meant to establish the
      // heartbeat.
      if (key.startsWith("engine_lock:") && String(value).trim()) return true
    }
    const globalEngine = this.data.hashes.get("trade_engine:global")
    return ["running", "starting"].includes(String(globalEngine?.actual_status || "").toLowerCase())
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
   * Build the legacy single-payload snapshot used by the managed shared
   * database adapter. Disk persistence uses the streaming v2 format below so
   * exhaustive indication/strategy grids never have to be duplicated into one
   * process-sized JSON string.
   */
  private buildSnapshot(): string {
    const d = this.data
    return JSON.stringify({
      v: 1,
      savedAt: Date.now(),
      strings: Array.from(d.strings.entries()).filter(([key]) => !isRebuildableDirectTradeSnapshotKey(key)),
      hashes: Array.from(d.hashes.entries()),
      sets: Array.from(d.sets.entries()).map(([k, s]) => [k, Array.from(s)]),
      lists: Array.from(d.lists.entries()),
      sorted_sets: Array.from(d.sorted_sets.entries()).map(([k, z]) => [k, z.entries]),
      ttl: Array.from(d.ttl.entries()).filter(([key]) => !isRebuildableDirectTradeSnapshotKey(key)),
      mutationVersion: this.mutationVersion(),
    })
  }

  /**
   * Yield a complete snapshot one Redis key at a time. Keeping each line
   * independently parseable avoids V8's maximum-string limit and bounds the
   * additional heap used while an exhaustive engine dataset is persisted.
   */
  private *snapshotV2Lines(snapshotVersion: number): Iterable<string> {
    const d = this.data
    yield JSON.stringify({ v: 2, savedAt: Date.now(), mutationVersion: snapshotVersion })
    // Map iterators include entries inserted after iteration began. The engine
    // writes new pipeline rows continuously, so iterating the live Maps here
    // could make a periodic snapshot chase a moving tail indefinitely. Capture
    // only the key plan at the declared mutation version. Values may change
    // while it is written; those mutations advance the global version and are
    // therefore included by the next snapshot instead of being falsely marked
    // durable by this one.
    const stringKeys = Array.from(d.strings.keys()).filter((key) => !isRebuildableDirectTradeSnapshotKey(key))
    const hashKeys = Array.from(d.hashes.keys())
    const setKeys = Array.from(d.sets.keys())
    const listKeys = Array.from(d.lists.keys())
    const sortedSetKeys = Array.from(d.sorted_sets.keys())
    const ttlKeys = Array.from(d.ttl.keys()).filter((key) => !isRebuildableDirectTradeSnapshotKey(key))

    for (const key of stringKeys) {
      if (d.strings.has(key)) yield JSON.stringify(["s", key, d.strings.get(key)])
    }
    for (const key of hashKeys) {
      const value = d.hashes.get(key)
      if (value) yield JSON.stringify(["h", key, value])
    }
    for (const key of setKeys) {
      const value = d.sets.get(key)
      if (value) yield JSON.stringify(["S", key, Array.from(value)])
    }
    for (const key of listKeys) {
      const value = d.lists.get(key)
      if (value) yield JSON.stringify(["l", key, value])
    }
    for (const key of sortedSetKeys) {
      const value = d.sorted_sets.get(key)
      if (value) yield JSON.stringify(["z", key, value.entries])
    }
    for (const key of ttlKeys) {
      if (d.ttl.has(key)) yield JSON.stringify(["t", key, d.ttl.get(key)])
    }
  }

  private async writeSnapshotV2(
    handle: { writeFile(data: string, options?: any): Promise<void> },
    snapshotVersion: number,
  ): Promise<void> {
    // Keep the buffered string deliberately small. A dense runtime can have
    // tens of thousands of JSON rows; accumulating a 1 MiB rope before the
    // next async write made the minute checkpoint monopolise the Node turn.
    const maxChunkBytes = 64 * 1024
    // A full local snapshot can contain tens of thousands of strategy and
    // position keys. Writing it atomically must not monopolise Node's event
    // loop for an entire minute tick: health, protected cron and control-order
    // routes need a chance to run while the temp file is being streamed. The
    // snapshot version still represents the state captured at start; writes
    // that land while yielding advance the mutation version and are included
    // by the next snapshot instead of being falsely marked durable.
    // Inline snapshots can contain a full running Strategy/Direct-Trade
    // generation. Yield on a short wall-clock quantum, with a small row-count
    // ceiling as a backstop. Yielding after *every* row kept the control plane
    // responsive but made a 100+ MiB, ~35k-row durability barrier take more
    // than 30 seconds because it scheduled tens of thousands of setImmediate
    // callbacks. That in turn blocked the Settings/Volume dialog response on
    // its mandatory persistNow() barrier. A 32-row ceiling plus the existing
    // 1 ms time ceiling keeps synchronous slices bounded while reducing
    // scheduler churn by an order of magnitude. The file remains atomically
    // published and changes that land meanwhile belong to the next versioned
    // checkpoint.
    const cooperativeYieldEveryRows = 32
    const cooperativeYieldAfterMs = 1
    let chunk = ""
    let chunkBytes = 0
    let rowsSinceYield = 0
    let lastYieldAt = Date.now()
    for (const line of this.snapshotV2Lines(snapshotVersion)) {
      const framed = `${line}\n`
      const framedBytes = Buffer.byteLength(framed)
      if (chunk && chunkBytes + framedBytes > maxChunkBytes) {
        await handle.writeFile(chunk, "utf8")
        chunk = ""
        chunkBytes = 0
      }
      if (framedBytes > maxChunkBytes) {
        await handle.writeFile(framed, "utf8")
      } else {
        chunk += framed
        chunkBytes += framedBytes
      }
      rowsSinceYield++
      if (
        rowsSinceYield >= cooperativeYieldEveryRows ||
        Date.now() - lastYieldAt >= cooperativeYieldAfterMs
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        rowsSinceYield = 0
        lastYieldAt = Date.now()
      }
    }
    if (chunk) await handle.writeFile(chunk, "utf8")
  }

  private writeSnapshotV2Sync(
    fsSync: typeof import("fs"),
    fd: number,
    snapshotVersion: number,
  ): void {
    const maxChunkBytes = 1024 * 1024
    let chunk = ""
    let chunkBytes = 0
    for (const line of this.snapshotV2Lines(snapshotVersion)) {
      const framed = `${line}\n`
      const framedBytes = Buffer.byteLength(framed)
      if (chunk && chunkBytes + framedBytes > maxChunkBytes) {
        fsSync.writeFileSync(fd, chunk, "utf8")
        chunk = ""
        chunkBytes = 0
      }
      if (framedBytes > maxChunkBytes) {
        fsSync.writeFileSync(fd, framed, "utf8")
      } else {
        chunk += framed
        chunkBytes += framedBytes
      }
    }
    if (chunk) fsSync.writeFileSync(fd, chunk, "utf8")
  }

  /**
   * Restore a v2 NDJSON snapshot without reading the entire file into a
   * string. Data is staged in fresh maps and swapped in only after every line
   * validates, so a torn/corrupt file can never partially replace live state.
   * `null` means the file is a legacy v1 JSON snapshot.
   */
  private async applySnapshotV2File(file: string): Promise<boolean | null> {
    const getBuiltinModule = (process as any).getBuiltinModule as undefined | ((name: string) => any)
    let fsSync: typeof import("fs")
    try {
      if (typeof getBuiltinModule === "function") {
        fsSync = getBuiltinModule("fs")
      } else {
        fsSync = await import("fs")
      }
    } catch {
      return false
    }

    const strings = new Map<string, string>()
    const hashes = new Map<string, Record<string, string>>()
    const sets = new Map<string, Set<string>>()
    const lists = new Map<string, string[]>()
    const sortedSets = new Map<string, ReturnType<InlineLocalRedis["createSortedSet"]>>()
    const ttl = new Map<string, number>()
    let header: { v: number; mutationVersion?: number } | null = null
    let lineNumber = 0
    const stream = fsSync.createReadStream(file, { encoding: "utf8" })
    // Avoid importing `node:readline` in this shared server module. Next's dev
    // dependency scanner otherwise tries to resolve the builtin for browser
    // route graphs and emits a warning on every API compilation. This bounded
    // splitter preserves streaming restore semantics without loading the full
    // snapshot into memory.
    async function* lines(): AsyncGenerator<string> {
      let pending = ""
      for await (const chunk of stream) {
        pending += String(chunk)
        let newline = pending.indexOf("\n")
        while (newline >= 0) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          yield line.endsWith("\r") ? line.slice(0, -1) : line
          newline = pending.indexOf("\n")
        }
      }
      if (pending) yield pending.endsWith("\r") ? pending.slice(0, -1) : pending
    }

    try {
      for await (const rawLine of lines()) {
        const line = String(rawLine)
        if (!line.trim()) continue
        lineNumber++
        const parsed = JSON.parse(line)
        if (lineNumber === 1) {
          if (!parsed || parsed.v !== 2) {
            stream.destroy()
            return null
          }
          header = parsed
          continue
        }
        if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
          throw new SyntaxError(`Invalid v2 snapshot record at line ${lineNumber}`)
        }
        const [type, key, value] = parsed
        switch (type) {
          case "s":
            strings.set(key, String(value ?? ""))
            break
          case "h":
            if (!value || typeof value !== "object" || Array.isArray(value)) {
              throw new SyntaxError(`Invalid hash record at line ${lineNumber}`)
            }
            hashes.set(key, value as Record<string, string>)
            break
          case "S":
            if (!Array.isArray(value)) throw new SyntaxError(`Invalid set record at line ${lineNumber}`)
            sets.set(key, new Set(value.map(String)))
            break
          case "l":
            if (!Array.isArray(value)) throw new SyntaxError(`Invalid list record at line ${lineNumber}`)
            lists.set(key, value.map(String))
            break
          case "z":
            if (!Array.isArray(value)) throw new SyntaxError(`Invalid sorted-set record at line ${lineNumber}`)
            sortedSets.set(key, this.createSortedSet(value as SortedSetEntry[]))
            break
          case "t": {
            const expiry = Number(value)
            if (!Number.isFinite(expiry)) throw new SyntaxError(`Invalid TTL record at line ${lineNumber}`)
            ttl.set(key, expiry)
            break
          }
          default:
            throw new SyntaxError(`Unknown v2 snapshot record at line ${lineNumber}`)
        }
      }
    } finally {
      stream.destroy()
    }

    if (!header) return false
    const d = this.data
    d.strings = strings
    d.hashes = hashes
    d.sets = sets
    d.lists = lists
    d.sorted_sets = sortedSets
    d.ttl = ttl
    globalForRedis.__redis_snapshot_mutation_version = Number(header.mutationVersion || 0)
    return true
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

  private async replayLivePositionWal(
    snapshotFile: string,
    fs: typeof import("fs/promises"),
  ): Promise<number> {
    const walFile = `${snapshotFile}.live-wal`
    let raw = ""
    try {
      raw = await fs.readFile(walFile, "utf8")
    } catch (error: any) {
      if (error?.code !== "ENOENT") this.warnRateLimited(`live-position WAL read failed (${walFile})`, error)
      return 0
    }

    // Keep only the newest valid record per position. A SIGKILL may leave one
    // partial final line; all earlier fsynced lines remain independently
    // parseable and the malformed tail is safely ignored.
    const newest = new Map<string, any>()
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        const connectionId = String(entry?.connectionId || entry?.position?.connectionId || "").trim()
        const positionId = String(entry?.positionId || entry?.position?.id || "").trim()
        if (entry?.v !== 1 || !connectionId || !positionId || !entry?.position) continue
        const key = `${connectionId}\u0000${positionId}`
        const previous = newest.get(key)
        const nextVersion = Number(entry.position.version || 0)
        const previousVersion = Number(previous?.position?.version || 0)
        const nextUpdatedAt = Number(entry.position.updatedAt || entry.at || 0)
        const previousUpdatedAt = Number(previous?.position?.updatedAt || previous?.at || 0)
        if (
          !previous ||
          nextVersion > previousVersion ||
          (nextVersion === previousVersion && nextUpdatedAt >= previousUpdatedAt)
        ) {
          newest.set(key, entry)
        }
      } catch {
        // A torn final append is expected after an abrupt process kill.
      }
    }

    const terminalStatuses = new Set(["closed", "rejected", "cancelled", "canceled", "error"])
    let restored = 0
    for (const entry of newest.values()) {
      const position = entry.position as Record<string, unknown>
      const connectionId = String(entry.connectionId || position.connectionId || "").trim()
      const positionId = String(entry.positionId || position.id || "").trim()
      const hashKey = `live_positions:${connectionId}:${positionId}`
      const jsonKey = `live:position:${positionId}`
      const current = this.data.hashes.get(hashKey)
      const currentVersion = Number(current?.version || 0)
      const currentUpdatedAt = Number(current?.updatedAt || 0)
      const walVersion = Number(position.version || 0)
      const walUpdatedAt = Number(position.updatedAt || entry.at || 0)
      if (
        current &&
        (
          walVersion < currentVersion ||
          (walVersion === currentVersion && walUpdatedAt <= currentUpdatedAt)
        )
      ) {
        continue
      }

      this.data.hashes.set(hashKey, normalizeRedisHash(position))
      this.data.strings.set(jsonKey, JSON.stringify(position))
      this.data.ttl.delete(hashKey)
      this.data.ttl.delete(jsonKey)

      const openIndexKey = `live:positions:${connectionId}`
      const closedIndexKey = `live:positions:${connectionId}:closed`
      const openIds = (this.data.lists.get(openIndexKey) || []).filter((id) => id !== positionId)
      const closedIds = (this.data.lists.get(closedIndexKey) || []).filter((id) => id !== positionId)
      if (terminalStatuses.has(String(position.status || "").toLowerCase())) {
        this.data.lists.set(openIndexKey, openIds)
        this.data.lists.set(closedIndexKey, [positionId, ...closedIds])
        const analytics = buildLivePositionAnalyticsSnapshot(position)
        if (analytics) {
          const analyticsDataKey = liveClosedAnalyticsDataKey(connectionId)
          const analyticsTimeKey = liveClosedAnalyticsTimeKey(connectionId)
          const analyticsRows = this.data.hashes.get(analyticsDataKey) || {}
          analyticsRows[positionId] = JSON.stringify(analytics)
          this.data.hashes.set(analyticsDataKey, analyticsRows)
          const zset = this.getSortedSet(analyticsTimeKey) || this.createSortedSet()
          const existing = zset.memberIndex.get(positionId)
          if (existing) {
            const existingIndex = this.insertionIndex(zset.entries, existing)
            if (zset.entries[existingIndex]?.member === positionId) {
              zset.entries.splice(existingIndex, 1)
            }
          }
          const entry = {
            score: Number(analytics.closedAt),
            member: positionId,
          }
          zset.memberIndex.set(positionId, entry)
          zset.entries.splice(this.insertionIndex(zset.entries, entry), 0, entry)
          this.data.sorted_sets.set(analyticsTimeKey, zset)
        }
      } else {
        this.data.lists.set(openIndexKey, [positionId, ...openIds])
        this.data.lists.set(closedIndexKey, closedIds)
      }
      this.data.ttl.delete(openIndexKey)
      this.data.ttl.delete(closedIndexKey)
      restored++
    }

    if (restored > 0) this.markDirty()
    return restored
  }

  private async compactLivePositionWalIfNeeded(
    walFile: string,
    fs: typeof import("fs/promises"),
  ): Promise<void> {
    // A complete Paper/Live position row can carry fills, trailing and lineage
    // diagnostics. Keep enough headroom for a dense restored book so a normal
    // initial recovery batch is not immediately compacted again for every
    // following checkpoint. The position cap remains the hard bound.
    const MAX_WAL_BYTES = 32 * 1024 * 1024
    const MAX_WAL_POSITIONS = 2_048
    const size = Number((await fs.stat(walFile)).size || 0)
    if (size <= MAX_WAL_BYTES) return

    const raw = await fs.readFile(walFile, "utf8")
    const newest = new Map<string, any>()
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        const connectionId = String(entry?.connectionId || entry?.position?.connectionId || "").trim()
        const positionId = String(entry?.positionId || entry?.position?.id || "").trim()
        if (entry?.v !== 1 || !connectionId || !positionId || !entry?.position) continue
        const key = `${connectionId}\u0000${positionId}`
        const previous = newest.get(key)
        const entryAt = Number(entry.position.updatedAt || entry.at || 0)
        const previousAt = Number(previous?.position?.updatedAt || previous?.at || 0)
        if (!previous || entryAt >= previousAt) newest.set(key, entry)
      } catch {
        // Ignore a torn tail while compacting earlier durable records.
      }
    }
    const retained = Array.from(newest.values())
      .sort((a, b) => Number(b.position?.updatedAt || b.at || 0) - Number(a.position?.updatedAt || a.at || 0))
      .slice(0, MAX_WAL_POSITIONS)
      .reverse()
    const compacted = retained.map((entry) => JSON.stringify(entry)).join("\n") + (retained.length > 0 ? "\n" : "")
    const tmp = `${walFile}.${this.nextWriteSuffix()}.tmp`
    const handle = await fs.open(tmp, "w")
    try {
      await handle.writeFile(compacted, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tmp, walFile)
  }

  async persistLivePositionCheckpoint(position: Record<string, unknown>): Promise<boolean> {
    if (isKiloLocalPreviewRuntime()) {
      // Workerd has no host filesystem. The disposable, loopback-only Kilo
      // acceptance runtime is forced to simulation and explicitly forbidden
      // from live exchange placement, so its in-isolate Redis row is the whole
      // paper checkpoint. Public Kilo deployments cannot enter this branch and
      // still require the managed database/shared persistence contract.
      this.markPersisted(this.mutationVersion())
      return true
    }
    if (hasKiloManagedDatabaseConfig()) return false
    const connectionId = String(position?.connectionId || position?.connection_id || "").trim()
    const positionId = String(position?.id || "").trim()
    if (!connectionId || !positionId) return false

    const primary = await this.resolveSnapshotPath()
    if (!primary) return false
    const candidates = process.env.V0_REDIS_SNAPSHOT_PATH
      ? [primary]
      : [primary, await this.tmpFallbackPath()].filter(Boolean) as Array<{ dir: string; file: string }>
    const entry = JSON.stringify({
      v: 1,
      at: Date.now(),
      connectionId,
      positionId,
      position,
    }) + "\n"

    // A restart can restore hundreds of Paper positions at once. Writing and
    // fsyncing every unchanged row independently serializes hundreds of disk
    // barriers, holds large closure chains, and can starve health/cron routes
    // during the exact period self-healing needs them most. Coalesce entries
    // during one event-loop turn, retaining only the newest checkpoint for an
    // individual position. Every caller still awaits the resulting batch fsync
    // before it observes success, so crash recovery remains durable.
    const pending =
      globalForRedis.__redis_live_position_wal_pending ??
      (globalForRedis.__redis_live_position_wal_pending = new Map())
    pending.set(`${connectionId}\u0000${positionId}`, { entry, candidates })

    let scheduled = globalForRedis.__redis_live_position_wal_batch_scheduled
    if (!scheduled) {
      scheduled = new Promise<boolean>((resolve) => {
        setImmediate(() => {
          const batch = globalForRedis.__redis_live_position_wal_pending || new Map()
          globalForRedis.__redis_live_position_wal_pending = new Map()
          delete globalForRedis.__redis_live_position_wal_batch_scheduled

          const previous = globalForRedis.__redis_live_position_wal_promise || Promise.resolve(true)
          const write = previous.catch(() => false).then(async () => {
            const checkpoints = [...batch.values()]
            if (checkpoints.length === 0) return true

            let lastError: unknown = new Error("No writable live-position WAL path")
            const batchCandidates = checkpoints[0].candidates
            const entries = checkpoints.map((checkpoint) => checkpoint.entry).join("")
            for (const candidate of batchCandidates) {
              const walFile = `${candidate.file}.live-wal`
              try {
                const fs = await import("fs/promises")
                await fs.mkdir(candidate.dir, { recursive: true })
                const handle = await fs.open(walFile, "a")
                try {
                  await handle.writeFile(entries, "utf8")
                  await handle.sync()
                } finally {
                  await handle.close()
                }
                await this.compactLivePositionWalIfNeeded(walFile, fs)
                globalForRedis.__redis_live_position_wal_write_counter =
                  Number(globalForRedis.__redis_live_position_wal_write_counter || 0) + checkpoints.length
                return true
              } catch (error) {
                lastError = error
              }
            }
            this.warnRateLimited("live-position WAL batch append failed", lastError)
            return false
          })
          globalForRedis.__redis_live_position_wal_promise = write
          void write.then(resolve).finally(() => {
            if (globalForRedis.__redis_live_position_wal_promise === write) {
              delete globalForRedis.__redis_live_position_wal_promise
            }
          })
        })
      })
      globalForRedis.__redis_live_position_wal_batch_scheduled = scheduled
    }

    return await scheduled
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
    let rows = await executeKiloDatabaseQuery(
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
    // Some managed SQLite gateways execute RETURNING correctly but expose its
    // result through a `run`/changes envelope, or omit rows for statements
    // that changed data. A follow-up read is safe here: the revision check
    // below still rejects a lost CAS race and never treats an empty result as
    // a successful overwrite.
    if (rows.length === 0) {
      rows = await executeKiloDatabaseQuery(
        `SELECT revision FROM ${KILO_SNAPSHOT_TABLE} WHERE id = 1`,
        [],
        "all",
      )
    }
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
      let rows = await executeKiloDatabaseQuery(
        `UPDATE ${KILO_SNAPSHOT_TABLE}
         SET lease_owner = ?, lease_scope = ?, lease_until = ?
         WHERE id = 1 AND (lease_until IS NULL OR lease_until < ? OR lease_owner = ?)
         RETURNING lease_owner`,
        [owner, scope, now + ttlMs, now, owner],
        "all",
      )
      if (rows.length === 0) {
        rows = await executeKiloDatabaseQuery(
          `SELECT lease_owner FROM ${KILO_SNAPSHOT_TABLE} WHERE id = 1`,
          [],
          "all",
        )
      }
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
        const restoredV2 = await this.applySnapshotV2File(c.file)
        let restored = restoredV2 === true
        let parsed: any = null
        if (restoredV2 === null) {
          const raw = await fs.readFile(c.file, "utf8")
          parsed = JSON.parse(raw)
          restored = this.applySnapshot(parsed)
          if (restored) {
            globalForRedis.__redis_snapshot_mutation_version = Number(parsed?.mutationVersion || 0)
          }
        }
        if (restored) {
          this.markPersisted(this.mutationVersion())
          const restoredLivePositions = await this.replayLivePositionWal(c.file, fs)
          this.clearRestoredInlineProcessOwnership()
          const keys =
            this.data.strings.size + this.data.hashes.size + this.data.sets.size +
            this.data.lists.size + this.data.sorted_sets.size
          console.log(
            `[v0] [Redis Persistence] Restored ${keys} keys from ${c.file}` +
            (restoredLivePositions > 0 ? ` plus ${restoredLivePositions} newer live-position checkpoint(s)` : ""),
          )
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
    if (isKiloLocalPreviewRuntime()) {
      this.markPersisted(this.mutationVersion())
      return true
    }
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
            await this.writeSnapshotV2(handle, snapshotVersion)
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
    const candidates = explicit ? [primaryFile] : [primaryFile, tmpFile]
    for (const file of candidates) {
      try {
        const dir = pathMod.dirname(file)
        fsSync.mkdirSync(dir, { recursive: true })
        const tmp = `${file}.${this.nextWriteSuffix()}.tmp`
        const fd = fsSync.openSync(tmp, "w")
        try {
          this.writeSnapshotV2Sync(fsSync, fd, snapshotVersion)
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
      // A full inline snapshot is intentionally a quiescent checkpoint. While
      // an engine is actively producing 280 ms Direct-Trade rows, the durable
      // live-position WAL records every lifecycle/quantity transition and a
      // full map walk can starve the shared HTTP control plane. The clean-stop
      // handler still writes the complete atomic snapshot, and the next idle
      // interval resumes periodic snapshots. Operators can opt in to the old
      // eager behaviour only after measuring their filesystem throughput.
      if (
        process.env.INLINE_REDIS_SNAPSHOT_WHILE_ENGINE_RUNNING !== "1" &&
        this.hasActiveInlineEngineOwner()
      ) return
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
    const hasFreshOwner = (connectionId: string): boolean =>