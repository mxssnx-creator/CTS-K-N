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
      BYBIT_API_KEY: "bybit-live-key-1234567890",
      BYBIT_API_SECRET: "bybit-live-secret-1234567890",
      ADMIN_SECRET: "inject-test-admin-secret-1234567890",
    }
  })

  afterEach(() => resetInlineRedisGlobals())

  afterAll(() => {
    process.env = originalEnv
  })

  it("injects both supported server venues and exposes their persisted live-ready state", async () => {
    const [{ POST, GET }, { getRedisClient }] = await Promise.all([
      import("@/app/api/system/inject-credentials/route"),
      import("@/lib/redis-db"),
    ])

    const request = new Request("http://localhost/api/system/inject-credentials", {
      headers: { Authorization: "Bearer inject-test-admin-secret-1234567890" },
    })
    const injected = await (await POST(request)).json()
    expect(injected.success).toBe(true)
    expect(injected.results["bingx-x01"]).toContain("live trade enabled")
    expect(injected.results["bybit-x03"]).toContain("live trade enabled")

    const status = await (await GET(request)).json()
    expect(status.liveTradeReady).toEqual(expect.arrayContaining(["bingx-x01", "bybit-x03"]))
    expect(status.database["bingx-x01"]).toMatchObject({ hasCredentials: true, liveTradeEnabled: true })
    expect(status.database["bybit-x03"]).toMatchObject({ hasCredentials: true, liveTradeEnabled: true })

    const redis = getRedisClient()
    await expect(redis.hgetall("connection:bybit-x03")).resolves.toMatchObject({
      is_live_trade: "1",
      live_trade_enabled: "1",
      live_trade_requested: "1",
      connection_method: "library",
      connection_library: "sdk",
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
