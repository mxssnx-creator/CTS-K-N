describe("connection test stored credentials", () => {
  it("uses server-stored credentials when the edit dialog submits masked placeholders", async () => {
    jest.resetModules()
    const createExchangeConnector = jest.fn(async (_exchange: string, options: Record<string, unknown>) => ({
      testConnection: jest.fn(async () => ({ success: true, balance: 1250, capabilities: ["balance"] })),
      getFastPathStatus: jest.fn(() => ({ available: true })),
      getEnvironmentInfo: jest.fn(() => ({ environment: "prod-vst", isDemo: true, usesVirtualFunds: true })),
    }))
    const updateConnection = jest.fn(async () => ({}))
    jest.doMock("@/lib/exchange-connectors", () => ({ createExchangeConnector }))
    jest.doMock("@/lib/redis-db", () => ({
      initRedis: jest.fn(async () => undefined),
      getConnection: jest.fn(async () => ({
        id: "bingx-x02",
        name: "BingX Prod-VST",
        exchange: "bingx",
        api_key: "stored-api-key-1234567890",
        api_secret: "stored-api-secret-1234567890",
        api_type: "perpetual_futures",
        connection_method: "library",
        connection_library: "sdk",
        is_testnet: true,
        is_predefined: true,
      })),
      updateConnection,
      getSettings: jest.fn(async () => ({ minimum_connect_interval: 1 })),
      getAllConnections: jest.fn(async () => []),
    }))
    jest.doMock("@/lib/connection-rate-limiter", () => ({
      testConnectionLimiter: { checkLimit: jest.fn(async () => ({ allowed: true, remaining: 49, timeoutMs: 10_000 })) },
    }))
    jest.doMock("@/lib/rate-limiter", () => ({
      RateLimiter: class { async execute<T>(work: () => Promise<T>): Promise<T> { return work() } },
    }))
    jest.doMock("@/lib/system-logger", () => ({
      SystemLogger: { logConnection: jest.fn(async () => undefined), logError: jest.fn(async () => undefined) },
    }))

    const { POST } = await import("../../app/api/settings/connections/[id]/test/route")
    const response = await POST(
      new Request("http://localhost/api/settings/connections/bingx-x02/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: "••••7890", api_secret: "••••7890" }),
      }) as any,
      { params: Promise.resolve({ id: "bingx-x02" }) },
    )

    expect(response.status).toBe(200)
    expect(createExchangeConnector).toHaveBeenCalledWith("bingx", expect.objectContaining({
      apiKey: "stored-api-key-1234567890",
      apiSecret: "stored-api-secret-1234567890",
      isTestnet: true,
    }))
    expect(updateConnection).toHaveBeenCalledWith("bingx-x02", expect.objectContaining({ last_test_status: "success" }))
  })
})
