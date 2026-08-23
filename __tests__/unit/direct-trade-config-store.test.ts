import {
  DIRECT_TRADE_CONFIG_MANIFEST_KEY,
  DIRECT_TRADE_CONFIGS_KEY,
  deleteDirectTradeConfigGeneration,
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
    expect(prepared.manifest).toMatchObject({ version: 1, chunks: 2, total: 10_001 })
    await redis.set(DIRECT_TRADE_CONFIG_MANIFEST_KEY, JSON.stringify(prepared.manifest))

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
})
