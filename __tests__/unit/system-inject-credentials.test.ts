function resetInlineRedisGlobals() {
  delete (globalThis as any).__redis_data
  delete (globalThis as any).__redis_load_promise
  delete (globalThis as any).__redis_core_promise
  delete (globalThis as any).__redis_init_promise
  delete (globalThis as any).__redis_snapshot_loaded
  delete (globalThis as any).__redis_fully_connected
  delete (globalThis as any).__redis_backend
}

describe("production base-connection credential injection", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    jest.resetModules()
    resetInlineRedisGlobals()
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      BINGX_API_KEY: "bingx-live-key-1234567890",
      BINGX_API_SECRET: "bingx-live-secret-1234567890",
      BINGX_X02_API_KEY: "bingx-vst-key-1234567890",
      BINGX_X02_API_SECRET: "bingx-vst-secret-1234567890",
      BYBIT_API_KEY: "bybit-live-key-1234567890",
      BYBIT_API_SECRET: "bybit-live-secret-1234567890",
      ADMIN_SECRET: "inject-test-admin-secret-1234567890",
      V0_REDIS_SNAPSHOT_PATH: `/tmp/cts-system-inject-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
      // Queue persistence is what this route owns.  Keep the unit test out of
      // the in-process engine owner so it cannot start a background worker.
      NEXT_RUNTIME: "edge",
    }
  })

  afterEach(() => resetInlineRedisGlobals())

  afterAll(() => {
    process.env = originalEnv
  })

  it("injects every supported credential but auto-enables only BingX Prod-VST", async () => {
    const [{ POST, GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/system/inject-credentials/route"),
      import("@/lib/redis-db"),
    ])

    const request = new Request("http://localhost/api/system/inject-credentials", {
      headers: { Authorization: "Bearer inject-test-admin-secret-1234567890" },
    })
    const injected = await (await POST(request)).json()
    expect(injected.success).toBe(true)
    expect(injected.results["bingx-x01"]).toContain("operator live/dashboard state preserved")
    expect(injected.results["bybit-x03"]).toContain("operator live/dashboard state preserved")
    expect(injected.results["bingx-x02"]).toContain("Main Trade engine queued")

    const redis = getRedisClient()
    await expect(redis.hgetall("connection:bingx-x01")).resolves.toMatchObject({
      is_live_trade: "0",
      live_trade_enabled: "0",
      live_trade_requested: "0",
      is_enabled_dashboard: "0",
    })
    const status = await (await GET(request)).json()
    expect(status.database["bingx-x01"]).toMatchObject({ hasCredentials: true, liveTradeEnabled: false })
    expect(status.database["bybit-x03"]).toMatchObject({ hasCredentials: true, liveTradeEnabled: false })
    expect(status.liveTradeReady).toEqual(["bingx-x02"])

    await expect(redis.hgetall("connection:bybit-x03")).resolves.toMatchObject({
      is_live_trade: "0",
      connection_method: "library",
      connection_library: "sdk",
    })
    await expect(redis.hgetall("connection:bingx-x02")).resolves.toMatchObject({
      is_assigned: "1",
      is_active_inserted: "1",
      is_dashboard_inserted: "1",
      is_enabled_dashboard: "1",
      is_live_trade: "1",
      live_trade_enabled: "1",
    })
    await expect(redis.hgetall("settings:engine_coordinator:refresh_requested:bingx-x02")).resolves.toMatchObject({
      connectionId: "bingx-x02",
      action: "start",
      reason: "production_vst_credential_injection",
    })
    await expect(redis.smembers("connections:main:enabled")).resolves.not.toContain("bingx-x01")
    await expect(redis.smembers("connections:main:enabled")).resolves.not.toContain("bybit-x03")
  })

  it("preserves an explicit operator live selection on a non-VST connection", async () => {
    const [{ POST, GET }, { getRedisClient, initRedis }] = await Promise.all([
      import("@/app/api/system/inject-credentials/route"),
      import("@/lib/redis-db"),
    ])
    await initRedis()
    const redis = getRedisClient()
    await redis.hset("connection:bingx-x01", {
      is_live_trade: "1",
      live_trade_enabled: "1",
      live_trade_requested: "1",
      is_assigned: "1",
      is_enabled_dashboard: "1",
      state_switch_version: "0",
    })

    const request = new Request("http://localhost/api/system/inject-credentials", {
      headers: { Authorization: "Bearer inject-test-admin-secret-1234567890" },
    })
    expect((await (await POST(request)).json()).success).toBe(true)
    const status = await (await GET(request)).json()
    expect(status.liveTradeReady).toEqual(expect.arrayContaining(["bingx-x01", "bingx-x02"]))
    await expect(redis.hgetall("connection:bingx-x01")).resolves.toMatchObject({
      is_live_trade: "1",
      live_trade_enabled: "1",
      live_trade_requested: "1",
      is_enabled_dashboard: "1",
    })
    await expect(redis.smembers("connections:main:enabled")).resolves.toContain("bingx-x01")
  })

  it("preserves an explicit X02 operator disable across credential reinjection", async () => {
    const [{ POST }, { getRedisClient, initRedis }] = await Promise.all([
      import("@/app/api/system/inject-credentials/route"),
      import("@/lib/redis-db"),
    ])
    await initRedis()
    const redis = getRedisClient()
    await redis.hset("connection:bingx-x02", {
      is_live_trade: "0",
      live_trade_enabled: "0",
      live_trade_requested: "0",
      live_trade_changed_at: "2026-08-27T12:00:00.000Z",
      state_switch_version: "7",
    })

    const request = new Request("http://localhost/api/system/inject-credentials", {
      headers: { Authorization: "Bearer inject-test-admin-secret-1234567890" },
    })
    const injected = await (await POST(request)).json()
    expect(injected.success).toBe(true)
    expect(injected.results["bingx-x02"]).toContain("operator live state disabled")
    expect(injected.results["bingx-x02"]).toContain("Main Trade engine queued")
    await expect(redis.hgetall("connection:bingx-x02")).resolves.toMatchObject({
      is_live_trade: "0",
      live_trade_enabled: "0",
      live_trade_requested: "0",
    })
  })

  it("rejects credential injection without the admin bearer token", async () => {
    const { POST } = await import("@/app/api/system/inject-credentials/route")
    const response = await POST(new Request("http://localhost/api/system/inject-credentials"))
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Unauthorized",
    })
  })
})
