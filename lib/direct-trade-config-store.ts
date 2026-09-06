import { gzip, gunzip } from "node:zlib"
import { getRedisBackend, type RedisClientLike } from "@/lib/redis-db"
import {
  directTradeConfigChunkKeyForScope,
  directTradeKeyspace,
} from "@/lib/direct-trade-keyspace"

// The legacy single-value key remains readable for small installations. A
// maximum-symbol/long-history grid can exceed V8's largest string, so large
// grids are prepared as independently readable chunks and made visible only
// when their small manifest is published atomically with its other indexes.
export const DIRECT_TRADE_CONFIGS_KEY = "direct_trade:configs"
export const DIRECT_TRADE_CONFIG_MANIFEST_KEY = "direct_trade:configs:manifest"
export const DIRECT_TRADE_EXECUTION_INDEX_KEY = "direct_trade:execution-index"
export const DIRECT_TRADE_EXECUTION_SIGNAL_INDEX_KEY = "direct_trade:execution-signal-index"
export const DIRECT_TRADE_ACTIVE_SIGNAL_KEYS_KEY = "direct_trade:active-signals"

export const DIRECT_TRADE_CONFIG_CHUNK_SIZE = 10_000
export const DIRECT_TRADE_CONFIG_LEGACY_MAX_BYTES = 1 * 1024 * 1024
export const DIRECT_TRADE_CONFIG_CHUNK_ENCODING = "gzip-base64-json" as const
const DIRECT_TRADE_CONFIG_GUNZIP_MAX_BYTES = 128 * 1024 * 1024
const DIRECT_TRADE_CONFIG_READ_CHUNK_BATCH_SIZE = 2
export const DIRECT_TRADE_CONFIG_STAGING_SECONDS = 1800
export const DIRECT_TRADE_CONFIG_READER_GRACE_SECONDS = 300

export interface DirectTradeConfigManifest {
  version: 1 | 2
  encoding?: typeof DIRECT_TRADE_CONFIG_CHUNK_ENCODING
  generation: string
  chunkSize: number
  chunks: number
  total: number
  publishedAt: string
}

export interface PreparedDirectTradeConfigStore {
  manifest: DirectTradeConfigManifest | null
  legacyJson: string | null
  previousManifest: DirectTradeConfigManifest | null
}

export interface DirectTradeConfigStoreWriter {
  append(configs: Iterable<unknown>): Promise<void>
  finish(): Promise<PreparedDirectTradeConfigStore>
  renew(leaseToken: string): Promise<boolean>
  abort(): Promise<void>
}

export interface DirectTradeConfigCompactionResult {
  compacted: boolean
  connectionId: string | null
  previousGeneration: string | null
  generation: string | null
  chunks: number
  total: number
  originalBytes: number
  storedBytes: number
}

function safeManifest(raw: string | null): DirectTradeConfigManifest | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    if (
      (value?.version === 1 || value?.version === 2) &&
      (value?.version !== 2 || value?.encoding === DIRECT_TRADE_CONFIG_CHUNK_ENCODING) &&
      typeof value?.generation === "string" &&
      Number.isInteger(value?.chunkSize) && value.chunkSize > 0 &&
      Number.isInteger(value?.chunks) && value.chunks >= 0 &&
      Number.isInteger(value?.total) && value.total >= 0
    ) return value as DirectTradeConfigManifest
  } catch {}
  return null
}

function gzipConfigChunk(raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    gzip(raw, { level: 6 }, (error, compressed) => {
      if (error) reject(error)
      else resolve(compressed.toString("base64"))
    })
  })
}

function gunzipConfigChunk(raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    gunzip(
      Buffer.from(raw, "base64"),
      { maxOutputLength: DIRECT_TRADE_CONFIG_GUNZIP_MAX_BYTES },
      (error, decompressed) => {
        if (error) reject(error)
        else resolve(decompressed.toString("utf8"))
      },
    )
  })
}

async function decodeConfigChunk(
  raw: string | null,
  manifest: DirectTradeConfigManifest,
): Promise<any[]> {
  if (!raw) return []
  try {
    const json = manifest.version === 2 && manifest.encoding === DIRECT_TRADE_CONFIG_CHUNK_ENCODING
      ? await gunzipConfigChunk(raw)
      : raw
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function directTradeConfigChunkKey(
  generation: string,
  index: number,
  connectionId?: string | null,
): string {
  return directTradeConfigChunkKeyForScope(generation, index, connectionId)
}

export async function getDirectTradeConfigManifest(
  client: Pick<RedisClientLike, "get">,
  connectionId?: string | null,
): Promise<DirectTradeConfigManifest | null> {
  return safeManifest(await client.get(directTradeKeyspace(connectionId).configManifest).catch(() => null))
}

/**
 * Write the immutable chunk generation without making it current. The caller
 * publishes `manifest` in its final transaction alongside calculation,
 * execution and statistics indexes. Therefore a crash can leave unused chunks
 * but can never expose a partial configuration grid.
 */
export async function prepareDirectTradeConfigStore(
  client: RedisClientLike,
  configs: unknown[],
  connectionId?: string | null,
): Promise<PreparedDirectTradeConfigStore> {
  const writer = await createDirectTradeConfigStoreWriter(client, connectionId)
  try {
    await writer.append(configs)
    return await writer.finish()
  } catch (error) {
    await writer.abort().catch(() => undefined)
    throw error
  }
}

/**
 * Streaming writer for maximum grids. It retains at most one configuration
 * chunk, while old readers remain on the previous manifest until `finish()` is
 * published by the caller's final transaction.
 */
export async function createDirectTradeConfigStoreWriter(
  client: RedisClientLike,
  connectionId?: string | null,
): Promise<DirectTradeConfigStoreWriter> {
  const previousManifest = await getDirectTradeConfigManifest(client, connectionId)
  const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const pending: unknown[] = []
  let chunks = 0
  let total = 0
  let finished = false

  const flush = async () => {
    const rows = pending.splice(0, DIRECT_TRADE_CONFIG_CHUNK_SIZE)
    const compressed = await gzipConfigChunk(JSON.stringify(rows))
    // Include an ambiguously acknowledged SET in abort cleanup as well.
    const index = chunks++
    await client.set(directTradeConfigChunkKey(generation, index, connectionId), compressed, {
      EX: DIRECT_TRADE_CONFIG_STAGING_SECONDS,
    })
  }

  return {
    async append(configs: Iterable<unknown>) {
      if (finished) throw new Error("Direct-Trade config writer is already finished")
      for (const config of configs) {
        pending.push(config)
        total++
        // Keep a full chunk buffered until one more row arrives; that allows
        // small exact-10k installations to retain their legacy representation.
        if (pending.length > DIRECT_TRADE_CONFIG_CHUNK_SIZE) await flush()
      }
    },
    async finish() {
      if (finished) throw new Error("Direct-Trade config writer is already finished")
      finished = true
      if (chunks === 0) {
        const legacyJson = JSON.stringify(pending)
        if (Buffer.byteLength(legacyJson, "utf8") <= DIRECT_TRADE_CONFIG_LEGACY_MAX_BYTES) {
          return { manifest: null, legacyJson, previousManifest }
        }
        await flush()
      }
      if (pending.length > 0) await flush()
      return {
        manifest: {
          version: 2,
          encoding: DIRECT_TRADE_CONFIG_CHUNK_ENCODING,
          generation,
          chunkSize: DIRECT_TRADE_CONFIG_CHUNK_SIZE,
          chunks,
          total,
          publishedAt: new Date().toISOString(),
        },
        legacyJson: null,
        previousManifest,
      }
    },
    async renew(leaseToken: string) {
      const keys = directTradeKeyspace(connectionId)
      const chunkKeys = Array.from({ length: chunks }, (_, i) => directTradeConfigChunkKey(generation, i, connectionId))
      if (typeof client.eval === "function") {
        const result = await client.eval(`
          if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
          local raw = redis.call('GET', KEYS[2])
          if raw then
            local ok, m = pcall(cjson.decode, raw)
            if not ok or type(m) ~= 'table' then return 0 end
            if m.generation == ARGV[2] then return 1 end
          end
          for i=3,#KEYS do redis.call('EXPIRE', KEYS[i], ARGV[3]) end
          return 1`, { keys: [keys.calculationLease, keys.configManifest, ...chunkKeys],
          arguments: [leaseToken, generation, String(DIRECT_TRADE_CONFIG_STAGING_SECONDS)] })
        return Number(result) === 1
      }
      if (await client.get(keys.calculationLease) !== leaseToken) return false
      if ((await getDirectTradeConfigManifest(client, connectionId))?.generation === generation) return true
      for (const key of chunkKeys) await client.expire(key, DIRECT_TRADE_CONFIG_STAGING_SECONDS)
      return true
    },
    async abort() {
      finished = true
      pending.length = 0
      await retireDirectTradeConfigGeneration(client, {
        version: 2, encoding: DIRECT_TRADE_CONFIG_CHUNK_ENCODING, generation,
        chunkSize: DIRECT_TRADE_CONFIG_CHUNK_SIZE, chunks, total, publishedAt: new Date().toISOString(),
      }, connectionId)
    },
  }
}

/** Never expire the current generation, including an ambiguously acknowledged publication. */
export async function retireDirectTradeConfigGeneration(
  client: RedisClientLike, manifest: DirectTradeConfigManifest | null, connectionId?: string | null,
): Promise<void> {
  if (!manifest || manifest.chunks <= 0) return
  const keys = directTradeKeyspace(connectionId)
  for (let start = 0; start < manifest.chunks; start += 100) {
    const chunkKeys = Array.from({ length: Math.min(100, manifest.chunks - start) }, (_, i) =>
      directTradeConfigChunkKey(manifest.generation, start + i, connectionId))
    if (typeof client.eval === "function") {
      await client.eval(`
        local raw = redis.call('GET', KEYS[1])
        if raw then
          local ok, m = pcall(cjson.decode, raw)
          if not ok or type(m) ~= 'table' or m.generation == ARGV[1] then return 0 end
        end
        for i=2,#KEYS do redis.call('EXPIRE', KEYS[i], ARGV[2]) end
        return #KEYS-1`, { keys: [keys.configManifest, ...chunkKeys],
        arguments: [manifest.generation, String(DIRECT_TRADE_CONFIG_READER_GRACE_SECONDS)] })
    } else {
      if ((await getDirectTradeConfigManifest(client, connectionId))?.generation === manifest.generation) return
      for (const key of chunkKeys) await client.expire(key, DIRECT_TRADE_CONFIG_READER_GRACE_SECONDS)
    }
  }
}

/** Shared Redis commits ownership, complete chunks, indexes and retirement atomically. */
export async function publishDirectTradeConfigStore(
  client: RedisClientLike, prepared: PreparedDirectTradeConfigStore,
  options: { connectionId?: string | null; leaseToken: string; values: Record<string, string>; deleteKeys?: string[]; expires?: Record<string, number> },
): Promise<boolean> {
  const keys = directTradeKeyspace(options.connectionId)
  const manifest = prepared.manifest
  const chunks = manifest ? Array.from({ length: manifest.chunks }, (_, i) =>
    directTradeConfigChunkKey(manifest.generation, i, options.connectionId)) : []
  const values = { ...options.values, [manifest ? keys.configManifest : keys.configs]:
    manifest ? JSON.stringify(manifest) : prepared.legacyJson || "[]" }
  const deletes = [...(options.deleteKeys || []), manifest ? keys.configs : keys.configManifest]
  const allowed = new Set([keys.configManifest, keys.configs, keys.executionIndex, keys.executionSignalIndex,
    keys.activeSignals, keys.calculation, keys.statisticsIndex, keys.calculationProgress])
  if ([...Object.keys(values), ...deletes, ...Object.keys(options.expires || {})].some(key => !allowed.has(key))) {
    throw new Error("Direct-Trade publication contains a foreign key")
  }
  if (Object.values(options.expires || {}).some(ttl => !Number.isSafeInteger(ttl) || ttl <= 0)) {
    throw new Error("Direct-Trade publication contains an invalid expiry")
  }
  if (typeof client.eval === "function") {
    const result = await client.eval(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      local values = cjson.decode(ARGV[2])
      local deletes = cjson.decode(ARGV[3])
      local expires = cjson.decode(ARGV[4])
      for i=3,#KEYS do if redis.call('EXISTS', KEYS[i]) == 0 then return -1 end end
      local previous = redis.call('GET', KEYS[2])
      for i=3,#KEYS do redis.call('PERSIST', KEYS[i]) end
      for key,value in pairs(values) do redis.call('SET', key, value) end
      for _,key in ipairs(deletes) do redis.call('DEL', key) end
      for key,ttl in pairs(expires) do redis.call('EXPIRE', key, ttl) end
      if previous then
        local ok,m = pcall(cjson.decode, previous)
        if ok and type(m) == 'table' and type(m.generation) == 'string'
          and m.generation ~= ARGV[5] and type(m.chunks) == 'number'
          and m.chunks >= 0 and m.chunks <= 10000 and m.chunks == math.floor(m.chunks) then
          for i=0,m.chunks-1 do redis.call('EXPIRE', ARGV[6]..m.generation..':'..i, ARGV[7]) end
        end
      end
      return 1`, { keys: [keys.calculationLease, keys.configManifest, ...chunks], arguments: [options.leaseToken,
      JSON.stringify(values), JSON.stringify(deletes), JSON.stringify(options.expires || {}), manifest?.generation || "",
      `${keys.namespace}:configs:chunk:`, String(DIRECT_TRADE_CONFIG_READER_GRACE_SECONDS)] })
    if (Number(result) === -1) throw new Error("Direct-Trade staged generation is incomplete")
    return Number(result) === 1
  }
  // Process-local simulation has no competing Redis process. Shared adapters
  // always expose EVAL and never fall back after a failed atomic operation.
  if (await client.get(keys.calculationLease) !== options.leaseToken) return false
  for (const key of chunks) if (!(await client.exists(key))) throw new Error("Direct-Trade staged generation is incomplete")
  const previous = await getDirectTradeConfigManifest(client, options.connectionId)
  const transaction = client.multi()
  for (const key of chunks) transaction.persist(key)
  for (const [key, value] of Object.entries(values)) transaction.set(key, value)
  for (const key of deletes) transaction.del(key)
  for (const [key, ttl] of Object.entries(options.expires || {})) transaction.expire(key, ttl)
  const results = await transaction.exec()
  if (results.some(value => value instanceof Error)) throw new Error("Direct-Trade publication failed")
  if (previous?.generation !== manifest?.generation) await retireDirectTradeConfigGeneration(client, previous, options.connectionId)
  return true
}

export async function deleteDirectTradeConfigGeneration(
  client: Pick<RedisClientLike, "del" | "eval">,
  manifest: DirectTradeConfigManifest | null,
  connectionId?: string | null,
): Promise<void> {
  if (!manifest || manifest.chunks <= 0) return
  const batchSize = 100
  for (let start = 0; start < manifest.chunks; start += batchSize) {
    const keys = Array.from(
      { length: Math.min(batchSize, manifest.chunks - start) },
      (_, offset) => directTradeConfigChunkKey(manifest.generation, start + offset, connectionId),
    )
    if (getRedisBackend() === "redis-network" && typeof client.eval === "function") {
      const unlinked = await client.eval(
        "return redis.call('UNLINK', unpack(KEYS))",
        { keys, arguments: [] },
      ).then(() => true).catch(() => false)
      if (unlinked) continue
    }
    await client.del(...keys).catch(() => 0)
  }
}

/**
 * Rewrite an already-published version-1 JSON generation into the compressed
 * version-2 format without recalculating or reordering any configuration.
 * Publication is compare-and-swap guarded by the exact prior manifest, so a
 * concurrent calculation can win safely and the compactor will discard its
 * unreachable generation instead of replacing newer results.
 */
export async function compactDirectTradeConfigGeneration(
  client: RedisClientLike,
  connectionId?: string | null,
  onProgress?: (progress: { completed: number; total: number; originalBytes: number; storedBytes: number }) => void,
): Promise<DirectTradeConfigCompactionResult> {
  const keys = directTradeKeyspace(connectionId)
  const previousManifestRaw = await client.get(keys.configManifest).catch(() => null)
  const previousManifest = safeManifest(previousManifestRaw)
  if (!previousManifest || previousManifest.version === 2) {
    return {
      compacted: false,
      connectionId: connectionId || null,
      previousGeneration: previousManifest?.generation || null,
      generation: previousManifest?.generation || null,
      chunks: previousManifest?.chunks || 0,
      total: previousManifest?.total || 0,
      originalBytes: 0,
      storedBytes: 0,
    }
  }

  const generation = `${Date.now().toString(36)}-compact-${Math.random().toString(36).slice(2, 10)}`
  let chunksWritten = 0
  let originalBytes = 0
  let storedBytes = 0
  let published = false

  try {
    for (let index = 0; index < previousManifest.chunks; index++) {
      const raw = await client.get(
        directTradeConfigChunkKey(previousManifest.generation, index, connectionId),
      )
      if (raw === null) {
        throw new Error(`Direct-Trade config generation ${previousManifest.generation} is missing chunk ${index}`)
      }
      const compressed = await gzipConfigChunk(raw)
      chunksWritten++
      await client.set(directTradeConfigChunkKey(generation, index, connectionId), compressed, { EX: DIRECT_TRADE_CONFIG_STAGING_SECONDS })
      originalBytes += Buffer.byteLength(raw, "utf8")
      storedBytes += Buffer.byteLength(compressed, "utf8")
      onProgress?.({
        completed: chunksWritten,
        total: previousManifest.chunks,
        originalBytes,
        storedBytes,
      })
    }

    const nextManifest: DirectTradeConfigManifest = {
      version: 2,
      encoding: DIRECT_TRADE_CONFIG_CHUNK_ENCODING,
      generation,
      chunkSize: previousManifest.chunkSize,
      chunks: previousManifest.chunks,
      total: previousManifest.total,
      publishedAt: new Date().toISOString(),
    }
    const nextManifestRaw = JSON.stringify(nextManifest)

    const nextChunks = Array.from({ length: nextManifest.chunks }, (_, index) => directTradeConfigChunkKey(generation, index, connectionId))
    if (typeof client.eval === "function") {
      const result = await client.eval(`
        if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
        for i=2,#KEYS do if redis.call('EXISTS', KEYS[i]) == 0 then return -1 end end
        for i=2,#KEYS do redis.call('PERSIST', KEYS[i]) end
        redis.call('SET', KEYS[1], ARGV[2])
        for i=0,#KEYS-2 do redis.call('EXPIRE', ARGV[3]..i, ARGV[4]) end
        return 1`,
        { keys: [keys.configManifest, ...nextChunks], arguments: [previousManifestRaw || "", nextManifestRaw,
          `${keys.namespace}:configs:chunk:${previousManifest.generation}:`, String(DIRECT_TRADE_CONFIG_READER_GRACE_SECONDS)] },
      )
      if (Number(result) === -1) throw new Error("Direct-Trade staged compaction is incomplete")
      published = Number(result) === 1
    } else {
      const currentManifestRaw = await client.get(keys.configManifest)
      if (currentManifestRaw === previousManifestRaw) {
        for (const key of nextChunks) if (!(await client.exists(key))) throw new Error("Direct-Trade staged compaction is incomplete")
        for (const key of nextChunks) await client.persist(key)
        await client.set(keys.configManifest, nextManifestRaw)
        published = true
        await retireDirectTradeConfigGeneration(client, previousManifest, connectionId)
      }
    }
    if (!published) {
      throw new Error("Direct-Trade config manifest changed during compaction")
    }

    return {
      compacted: true,
      connectionId: connectionId || null,
      previousGeneration: previousManifest.generation,
      generation,
      chunks: nextManifest.chunks,
      total: nextManifest.total,
      originalBytes,
      storedBytes,
    }
  } catch (error) {
    if (!published && chunksWritten > 0) {
      await retireDirectTradeConfigGeneration(client, {
        version: 2,
        encoding: DIRECT_TRADE_CONFIG_CHUNK_ENCODING,
        generation,
        chunkSize: previousManifest.chunkSize,
        chunks: chunksWritten,
        total: 0,
        publishedAt: new Date().toISOString(),
      }, connectionId)
    }
    throw error
  }
}

export async function readDirectTradeConfigsAtIndexes(
  client: Pick<RedisClientLike, "get" | "mget">,
  indexes: number[],
  connectionId?: string | null,
): Promise<any[]> {
  const uniqueIndexes = [...new Set(indexes.filter((index) => Number.isInteger(index) && index >= 0))]
  if (uniqueIndexes.length === 0) return []
  const keys = directTradeKeyspace(connectionId)
  const manifest = await getDirectTradeConfigManifest(client, connectionId)
  if (!manifest) {
    const raw = await client.get(keys.configs).catch(() => null)
    if (!raw) return []
    try {
      const configs = JSON.parse(raw)
      return Array.isArray(configs)
        ? uniqueIndexes.map((index) => configs[index]).filter((config) => config && typeof config === "object")
        : []
    } catch {
      return []
    }
  }

  const byChunk = new Map<number, number[]>()
  for (const index of uniqueIndexes) {
    if (index >= manifest.total) continue
    const chunkIndex = Math.floor(index / manifest.chunkSize)
    const entries = byChunk.get(chunkIndex)
    if (entries) entries.push(index)
    else byChunk.set(chunkIndex, [index])
  }
  const selectedConfigs = new Map<number, any>()
  const chunkIndexes = [...byChunk.keys()]
  for (let start = 0; start < chunkIndexes.length; start += DIRECT_TRADE_CONFIG_READ_CHUNK_BATCH_SIZE) {
    const batch = chunkIndexes.slice(start, start + DIRECT_TRADE_CONFIG_READ_CHUNK_BATCH_SIZE)
    const values = await client.mget(...batch.map((chunkIndex) => directTradeConfigChunkKey(manifest.generation, chunkIndex, connectionId)))
    for (let offset = 0; offset < batch.length; offset++) {
      const chunkIndex = batch[offset]
      const parsed = await decodeConfigChunk(values[offset] as string | null, manifest)
      for (const configIndex of byChunk.get(chunkIndex) || []) {
        const config = parsed[configIndex % manifest.chunkSize]
        if (config && typeof config === "object") selectedConfigs.set(configIndex, config)
      }
    }
  }
  return uniqueIndexes
    .map((index) => selectedConfigs.get(index))
    .filter((config) => config && typeof config === "object")
}

/** Retire only pre-TTL orphan chunks. Active calculations, current results and
 * every key with an expiry are protected again inside the atomic operation. */
export async function cleanupDirectTradeOrphanChunks(
  client: RedisClientLike,
  options: { connectionId: string; apply?: boolean; cursor?: string; maxPages?: number; now?: number },
): Promise<{ cursor: string; scanned: number; candidates: number; removed: number; skippedActiveLease: boolean }> {
  const keys = directTradeKeyspace(options.connectionId)
  const prefix = `${keys.namespace}:configs:chunk:`
  const now = options.now ?? Date.now()
  const maxPages = Math.min(1000, Math.max(1, Math.floor(options.maxPages || 100)))
  let cursor = options.cursor || "0"
  if (!/^\d+$/.test(cursor)) throw new Error("Invalid Redis scan cursor")
  let scanned = 0, candidates = 0, removed = 0
  if (options.apply && typeof client.eval !== "function") throw new Error("Orphan cleanup requires atomic Redis EVAL")
  if (typeof client.scan !== "function") throw new Error("Orphan cleanup requires bounded Redis SCAN")
  for (let page = 0; page < maxPages; page++) {
    if (await client.exists(keys.calculationLease)) return { cursor, scanned, candidates, removed, skippedActiveLease: true }
    const raw = await client.get(keys.configManifest)
    const manifest = safeManifest(raw)
    if (raw && !manifest) throw new Error("Invalid current manifest; refusing orphan cleanup")
    const result = await client.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 250)
    cursor = String(Array.isArray(result) ? result[0] : result.cursor)
    const foundKeys = Array.isArray(result) ? result[1] : result.keys
    for (const key of foundKeys) {
      scanned++
      if (!key.startsWith(prefix)) continue
      const match = /^([a-z0-9]+-(?:compact-)?[a-z0-9]+):(\d+)$/.exec(key.slice(prefix.length))
      if (!match || match[1] === manifest?.generation) continue
      const createdAt = parseInt(match[1].split("-")[0], 36)
      if (!Number.isSafeInteger(createdAt) || createdAt <= 0 || now - createdAt < DIRECT_TRADE_CONFIG_STAGING_SECONDS * 1000) continue
      if (await client.ttl(key) !== -1) continue
      candidates++
      if (options.apply) {
        const count = await client.eval!(`
          if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
          local raw = redis.call('GET', KEYS[2])
          if raw then
            local ok,m = pcall(cjson.decode, raw)
            if not ok or type(m) ~= 'table' or type(m.generation) ~= 'string' or m.generation == ARGV[1] then return 0 end
          end
          if redis.call('TTL', KEYS[3]) ~= -1 then return 0 end
          return redis.call('UNLINK', KEYS[3])`, {
          keys: [keys.calculationLease, keys.configManifest, key], arguments: [match[1]],
        })
        removed += Number(count)
      }
    }
    if (cursor === "0") break
  }
  return { cursor, scanned, candidates, removed, skippedActiveLease: false }
}
