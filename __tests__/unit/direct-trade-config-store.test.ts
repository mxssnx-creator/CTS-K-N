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
})
