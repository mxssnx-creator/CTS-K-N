import type { RedisClientLike } from "@/lib/redis-db"
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

export interface DirectTradeConfigManifest {
  version: 1
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

function safeManifest(raw: string | null): DirectTradeConfigManifest | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    if (
      value?.version === 1 &&
      typeof value?.generation === "string" &&
      Number.isInteger(value?.chunkSize) && value.chunkSize > 0 &&
      Number.isInteger(value?.chunks) && value.chunks >= 0 &&
      Number.isInteger(value?.total) && value.total >= 0
    ) return value as DirectTradeConfigManifest
  } catch {}
  return null
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
    await client.set(directTradeConfigChunkKey(generation, chunks, connectionId), JSON.stringify(rows))
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
        return { manifest: null, legacyJson: JSON.stringify(pending), previousManifest }
      }
      if (pending.length > 0) await flush()
      return {
        manifest: {
          version: 1,
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
  client: Pick<RedisClientLike, "del">,
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
    await client.del(...keys).catch(() => 0)
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
  const parsedChunks = new Map<number, any[]>()
  const chunkIndexes = [...byChunk.keys()]
  for (let start = 0; start < chunkIndexes.length; start += 32) {
    const batch = chunkIndexes.slice(start, start + 32)
    const values = await client.mget(...batch.map((chunkIndex) => directTradeConfigChunkKey(manifest.generation, chunkIndex, connectionId)))
    for (let offset = 0; offset < batch.length; offset++) {
      try {
        const parsed = values[offset] ? JSON.parse(values[offset] as string) : []
        if (Array.isArray(parsed)) parsedChunks.set(batch[offset], parsed)
      } catch {}
    }
  }
  return uniqueIndexes.map((index) => {
    const chunk = parsedChunks.get(Math.floor(index / manifest.chunkSize))
    return chunk?.[index % manifest.chunkSize]
  }).filter((config) => config && typeof config === "object")
}
