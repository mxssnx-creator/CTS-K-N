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
  await writer.append(configs)
  return writer.finish()
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
    await client.set(directTradeConfigChunkKey(generation, chunks, connectionId), compressed)
    chunks++
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
  }
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
      await client.set(directTradeConfigChunkKey(generation, index, connectionId), compressed)
      chunksWritten++
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

    if (getRedisBackend() === "redis-network" && typeof client.eval === "function") {
      const result = await client.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]); return 1 else return 0 end",
        { keys: [keys.configManifest], arguments: [previousManifestRaw || "", nextManifestRaw] },
      )
      published = Number(result) === 1
    } else {
      const currentManifestRaw = await client.get(keys.configManifest).catch(() => null)
      if (currentManifestRaw === previousManifestRaw) {
        await client.set(keys.configManifest, nextManifestRaw)
        published = true
      }
    }
    if (!published) {
      throw new Error("Direct-Trade config manifest changed during compaction")
    }

    await deleteDirectTradeConfigGeneration(client, previousManifest, connectionId)
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
      await deleteDirectTradeConfigGeneration(client, {
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
