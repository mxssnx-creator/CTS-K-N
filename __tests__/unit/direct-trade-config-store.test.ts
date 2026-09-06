import {
  DIRECT_TRADE_CONFIG_MANIFEST_KEY,
  DIRECT_TRADE_CONFIGS_KEY,
  DIRECT_TRADE_CONFIG_CHUNK_ENCODING,
  compactDirectTradeConfigGeneration,
  createDirectTradeConfigStoreWriter,
  publishDirectTradeConfigStore,
  cleanupDirectTradeOrphanChunks,
  deleteDirectTradeConfigGeneration,
  directTradeConfigChunkKey,
  getDirectTradeConfigManifest,
  prepareDirectTradeConfigStore,
  readDirectTradeConfigsAtIndexes,
} from "@/lib/direct-trade-config-store"

function resetInlineRedisGlobals() {
  delete (globalThis as any).__redis_data
  delete (globalThis as any).__redis_load_promise
  delete (globalThis as any).__redis_core_promise
  delete (globalThis as any).__redis_init_promise
  delete (globalThis as any).__redis_snapshot_loaded
  delete (globalThis as any).__redis_fully_connected
  delete (globalThis as any).__redis_backend
}

describe("Direct-Trade chunked configuration store", () => {
  beforeEach(() => {
    jest.resetModules()
    resetInlineRedisGlobals()
  })

  afterEach(() => resetInlineRedisGlobals())

  test("publishes a chunk manifest without serializing a long grid as one value", async () => {
    const { getRedisClient } = await import("@/lib/redis-db")
    const redis = getRedisClient()
    const configs = Array.from({ length: 10_001 }, (_, index) => ({ setKey: `set-${index}`, index }))
    const prepared = await prepareDirectTradeConfigStore(redis, configs)
    expect(prepared.legacyJson).toBeNull()
    expect(prepared.manifest).toMatchObject({
      version: 2,
      encoding: DIRECT_TRADE_CONFIG_CHUNK_ENCODING,
      chunks: 2,
      total: 10_001,
    })
    await redis.set(DIRECT_TRADE_CONFIG_MANIFEST_KEY, JSON.stringify(prepared.manifest))

    const firstChunk = await redis.get(directTradeConfigChunkKey(prepared.manifest!.generation, 0))
    expect(firstChunk).not.toBeNull()
    expect(firstChunk).not.toMatch(/^\s*\[/)
    expect(Buffer.byteLength(firstChunk || "", "utf8")).toBeLessThan(
      Buffer.byteLength(JSON.stringify(configs.slice(0, 10_000)), "utf8") / 2,
    )

    const rows = await readDirectTradeConfigsAtIndexes(redis, [0, 9_999, 10_000])
    expect(rows).toEqual([configs[0], configs[9_999], configs[10_000]])
    expect(await redis.get(DIRECT_TRADE_CONFIGS_KEY)).toBeNull()

    await deleteDirectTradeConfigGeneration(redis, prepared.manifest)
    await redis.del(DIRECT_TRADE_CONFIG_MANIFEST_KEY)
  })

  test("keeps chunk manifests and rows independent between connections", async () => {
    const [{ getRedisClient }, { directTradeKeyspace }] = await Promise.all([
      import("@/lib/redis-db"),
      import("@/lib/direct-trade-keyspace"),
    ])
    const redis = getRedisClient()
    const leftId = "bingx-x01"
    const rightId = "bingx-x02"
    const leftConfigs = Array.from({ length: 10_001 }, (_, index) => ({ setKey: `left-${index}` }))
    const rightConfigs = Array.from({ length: 10_001 }, (_, index) => ({ setKey: `right-${index}` }))
    const [left, right] = await Promise.all([
      prepareDirectTradeConfigStore(redis, leftConfigs, leftId),
      prepareDirectTradeConfigStore(redis, rightConfigs, rightId),
    ])
    const leftKeys = directTradeKeyspace(leftId)
    const rightKeys = directTradeKeyspace(rightId)
    await Promise.all([
      redis.set(leftKeys.configManifest, JSON.stringify(left.manifest)),
      redis.set(rightKeys.configManifest, JSON.stringify(right.manifest)),
    ])
    await expect(readDirectTradeConfigsAtIndexes(redis, [10_000], leftId)).resolves.toEqual([leftConfigs[10_000]])
    await expect(readDirectTradeConfigsAtIndexes(redis, [10_000], rightId)).resolves.toEqual([rightConfigs[10_000]])
    await Promise.all([
      deleteDirectTradeConfigGeneration(redis, left.manifest, leftId),
      deleteDirectTradeConfigGeneration(redis, right.manifest, rightId),
    ])
    await redis.del(leftKeys.configManifest, rightKeys.configManifest)
  })

  test("retains compact legacy JSON for genuinely small grids", async () => {
    const { getRedisClient } = await import("@/lib/redis-db")
    const redis = getRedisClient()
    const configs = [{ setKey: "small-1" }, { setKey: "small-2" }]

    const prepared = await prepareDirectTradeConfigStore(redis, configs)

    expect(prepared.manifest).toBeNull()
    expect(JSON.parse(prepared.legacyJson || "[]")).toEqual(configs)
  })

  test("compresses a sub-10k grid when its JSON would still exceed the safe legacy value", async () => {
    const { getRedisClient } = await import("@/lib/redis-db")
    const redis = getRedisClient()
    const configs = Array.from({ length: 300 }, (_, index) => ({
      setKey: `large-row-${index}`,
      repeated: "same-runtime-projection".repeat(220),
    }))

    const prepared = await prepareDirectTradeConfigStore(redis, configs)
    expect(prepared.legacyJson).toBeNull()
    expect(prepared.manifest).toMatchObject({ version: 2, chunks: 1, total: configs.length })
    await redis.set(DIRECT_TRADE_CONFIG_MANIFEST_KEY, JSON.stringify(prepared.manifest))
    await expect(readDirectTradeConfigsAtIndexes(redis, [0, 299])).resolves.toEqual([configs[0], configs[299]])
  })

  test("continues to read uncompressed version-1 chunk generations", async () => {
    const { getRedisClient } = await import("@/lib/redis-db")
    const redis = getRedisClient()
    const generation = "legacy-v1"
    const configs = [{ setKey: "legacy-0" }, { setKey: "legacy-1" }]
    await redis.set(directTradeConfigChunkKey(generation, 0), JSON.stringify(configs))
    await redis.set(DIRECT_TRADE_CONFIG_MANIFEST_KEY, JSON.stringify({
      version: 1,
      generation,
      chunkSize: 10_000,
      chunks: 1,
      total: configs.length,
      publishedAt: new Date().toISOString(),
    }))

    await expect(readDirectTradeConfigsAtIndexes(redis, [1])).resolves.toEqual([configs[1]])
  })

  test("atomically compacts a published version-1 generation without changing indexes", async () => {
    const [{ getRedisClient }, { directTradeKeyspace }] = await Promise.all([
      import("@/lib/redis-db"),
      import("@/lib/direct-trade-keyspace"),
    ])
    const redis = getRedisClient()
    const connectionId = "bingx-compact"
    const generation = "uncompressed-generation"
    const configs = Array.from({ length: 50 }, (_, index) => ({
      setKey: `compact-${index}`,
      score: index,
      repeated: "same-value".repeat(100),
    }))
    const keyspace = directTradeKeyspace(connectionId)
    const oldChunkKey = directTradeConfigChunkKey(generation, 0, connectionId)
    await redis.set(oldChunkKey, JSON.stringify(configs))
    await redis.set(keyspace.configManifest, JSON.stringify({
      version: 1,
      generation,
      chunkSize: 10_000,
      chunks: 1,
      total: configs.length,
      publishedAt: new Date().toISOString(),
    }))

    const result = await compactDirectTradeConfigGeneration(redis, connectionId)
    const compactedManifest = await getDirectTradeConfigManifest(redis, connectionId)

    expect(result).toMatchObject({
      compacted: true,
      previousGeneration: generation,
      chunks: 1,
      total: configs.length,
    })
    expect(result.storedBytes).toBeLessThan(result.originalBytes)
    expect(compactedManifest).toMatchObject({
      version: 2,
      encoding: DIRECT_TRADE_CONFIG_CHUNK_ENCODING,
      total: configs.length,
    })
    expect(await redis.ttl(oldChunkKey)).toBeGreaterThan(0)
    expect(await redis.ttl(oldChunkKey)).toBeLessThanOrEqual(300)
    await expect(readDirectTradeConfigsAtIndexes(redis, [0, 49], connectionId)).resolves.toEqual([
      configs[0],
      configs[49],
    ])
  })
  test("staged chunks expire, renew only for the owner and survive ambiguous publication cleanup", async () => {
    const { getRedisClient } = await import("@/lib/redis-db")
    const { directTradeKeyspace } = await import("@/lib/direct-trade-keyspace")
    const redis = getRedisClient(), scope = "lifecycle", keys = directTradeKeyspace(scope)
    const writer = await createDirectTradeConfigStoreWriter(redis, scope)
    await writer.append(Array.from({ length: 10_001 }, (_, index) => ({ index })))
    const prepared = await writer.finish()
    const chunk = directTradeConfigChunkKey(prepared.manifest!.generation, 0, scope)
    expect(await redis.ttl(chunk)).toBeGreaterThan(300)
    await redis.set(keys.calculationLease, "owner")
    expect(await writer.renew("stale")).toBe(false)
    expect(await writer.renew("owner")).toBe(true)
    expect(await publishDirectTradeConfigStore(redis, prepared, { connectionId: scope, leaseToken: "owner", values: {} })).toBe(true)
    await writer.abort()
    expect(await redis.ttl(chunk)).toBe(-1)
    await expect(readDirectTradeConfigsAtIndexes(redis, [10_000], scope)).resolves.toEqual([{ index: 10_000 }])
    const next = await prepareDirectTradeConfigStore(redis, [{ index: "next" }], scope)
    expect(await publishDirectTradeConfigStore(redis, next, { connectionId: scope, leaseToken: "owner", values: {} })).toBe(true)
    expect(await redis.ttl(chunk)).toBeGreaterThan(0)
    expect(await redis.ttl(chunk)).toBeLessThanOrEqual(300)
  })

  test("stale ownership and incomplete staging cannot replace current indexes", async () => {
    const { getRedisClient } = await import("@/lib/redis-db")
    const { directTradeKeyspace } = await import("@/lib/direct-trade-keyspace")
    const redis = getRedisClient(), scope = "stale", keys = directTradeKeyspace(scope)
    await redis.set(keys.calculationLease, "new-owner")
    await redis.set(keys.executionIndex, "previous-index")
    const prepared = await prepareDirectTradeConfigStore(redis, Array.from({ length: 10_001 }, (_, index) => ({ index })), scope)
    const options = { connectionId: scope, leaseToken: "stale", values: { [keys.executionIndex]: "changed" } }
    expect(await publishDirectTradeConfigStore(redis, prepared, options)).toBe(false)
    await redis.del(directTradeConfigChunkKey(prepared.manifest!.generation, 1, scope))
    await expect(publishDirectTradeConfigStore(redis, prepared, { ...options, leaseToken: "new-owner" })).rejects.toThrow("incomplete")
    expect(await redis.get(keys.executionIndex)).toBe("previous-index")
    await expect(publishDirectTradeConfigStore(redis, prepared, { ...options, values: { "live:position:other": "bad" } })).rejects.toThrow("foreign")
  })

  test("aborting staging retains only a short grace period", async () => {
    const { getRedisClient } = await import("@/lib/redis-db")
    const redis = getRedisClient()
    const writer = await createDirectTradeConfigStoreWriter(redis, "abort")
    await writer.append(Array.from({ length: 10_001 }, (_, index) => ({ index })))
    const prepared = await writer.finish()
    await writer.abort()
    expect(await redis.ttl(directTradeConfigChunkKey(prepared.manifest!.generation, 0, "abort"))).toBeLessThanOrEqual(300)
    await expect(writer.append([{}])).rejects.toThrow("finished")
  })

  test("orphan audit protects active leases and requires atomic cleanup", async () => {
    const { getRedisClient } = await import("@/lib/redis-db")
    const { directTradeKeyspace } = await import("@/lib/direct-trade-keyspace")
    const redis = getRedisClient(), keys = directTradeKeyspace("audit")
    const old = `${(Date.now() - 86_400_000).toString(36)}-old`
    const chunk = directTradeConfigChunkKey(old, 0, "audit")
    await redis.set(chunk, "old")
    expect((await cleanupDirectTradeOrphanChunks(redis, { connectionId: "audit" })).candidates).toBe(1)
    await expect(cleanupDirectTradeOrphanChunks(redis, { connectionId: "audit", apply: true })).rejects.toThrow("atomic")
    await redis.set(keys.calculationLease, "owner")
    expect((await cleanupDirectTradeOrphanChunks(redis, { connectionId: "audit" })).skippedActiveLease).toBe(true)
    expect(await redis.get(chunk)).toBe("old")
  })

})
