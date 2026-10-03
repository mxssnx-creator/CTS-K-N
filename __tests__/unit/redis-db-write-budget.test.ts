describe("redis-db write budget enforcement", () => {
  const originalEnv = { ...process.env }

  async function loadRedisDb() {
    jest.resetModules()
    delete (globalThis as any).__redis_data
    delete (globalThis as any).__redis_load_promise
    delete (globalThis as any).__redis_core_promise
    delete (globalThis as any).__redis_init_promise
    delete (globalThis as any).__redis_snapshot_loaded
    delete (globalThis as any).__redis_fully_connected
    delete (globalThis as any).__redis_backend
    delete (globalThis as any).__redis_cleanup_started
    delete (globalThis as any).__db_ops_tracker
    delete (globalThis as any).__db_ops_second_tracker
    delete (globalThis as any).__db_write_budget_last_warn
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      REDIS_URL: "",
      KV_URL: "",
      UPSTASH_REDIS_REST_URL: "",
      KV_REST_API_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
      KV_REST_API_TOKEN: "",
    }
    return import("@/lib/redis-db")
  }

  afterEach(() => {
    jest.restoreAllMocks()
    process.env = originalEnv
  })

  it("throws a typed error when enabled caps block required writes", async () => {
    const redisDb = await loadRedisDb()
    const client = redisDb.getRedisClient()
    await client.hset("settings:system", { databaseLimitPerSecond: "1", databaseLimitPerMinute: "10" })

    await expect(redisDb.saveTrade({ id: "required-1" })).resolves.toBeUndefined()
    await expect(redisDb.saveTrade({ id: "required-2" })).rejects.toMatchObject({
      name: "DatabaseWriteRateLimitError",
      code: "DATABASE_WRITE_RATE_LIMIT_EXCEEDED",
      operationName: "saveTrade",
      scope: "second",
    })
  })

  it("treats zero caps as disabled", async () => {
    const redisDb = await loadRedisDb()
    const client = redisDb.getRedisClient()
    await client.hset("settings:system", { databaseLimitPerSecond: "0", databaseLimitPerMinute: "0" })

    await expect(redisDb.saveTrade({ id: "disabled-1" })).resolves.toBeUndefined()
    await expect(redisDb.saveTrade({ id: "disabled-2" })).resolves.toBeUndefined()
    await expect(client.hgetall("trade:disabled-2")).resolves.toMatchObject({ id: "disabled-2" })
  })

  it("skips optional indication snapshots instead of throwing", async () => {
    // Both writes must fall into the same one-second window: a real clock crossing a second boundary between them let the
    // second write through (flaked once in the server's deploy gate, 2026-10-03).
    const clock = jest.spyOn(Date, "now").mockReturnValue(1_791_000_000_500)
    const redisDb = await loadRedisDb()
    const client = redisDb.getRedisClient()
    await client.hset("settings:system", { databaseLimitPerSecond: "1", databaseLimitPerMinute: "10" })

    await expect(redisDb.saveIndication({ id: "optional-1" })).resolves.toBeUndefined()
    await expect(redisDb.saveIndication({ id: "optional-2" })).resolves.toBeUndefined()
    await expect(client.exists("indication:optional-1")).resolves.toBe(1)
    await expect(client.exists("indication:optional-2")).resolves.toBe(0)
    clock.mockRestore()
  })

  it("checks per-minute caps as well as per-second caps", async () => {
    // same reason, for the minute window: the two writes are one second apart inside one minute
    let now = 1_791_000_030_000
    const clock = jest.spyOn(Date, "now").mockImplementation(() => now)
    const redisDb = await loadRedisDb()
    const client = redisDb.getRedisClient()
    await client.hset("settings:system", { databaseLimitPerSecond: "100", databaseLimitPerMinute: "1" })

    await expect(redisDb.saveStrategy({ id: "minute-1" })).resolves.toBeUndefined()
    now += 1_000
    await expect(redisDb.saveStrategy({ id: "minute-2" })).rejects.toMatchObject({
      name: "DatabaseWriteRateLimitError",
      operationName: "saveStrategy",
      scope: "minute",
    })
    clock.mockRestore()
  })
})
