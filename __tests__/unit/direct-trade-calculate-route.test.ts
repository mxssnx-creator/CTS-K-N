const fetchTopSymbolsMock = jest.fn()
const fetchBingXPublicMock = jest.fn()

jest.mock("@/lib/top-symbols", () => ({
  fetchTopSymbols: (...args: unknown[]) => fetchTopSymbolsMock(...args),
}))

jest.mock("@/lib/bingx-public-api", () => ({
  fetchBingXPublic: (...args: unknown[]) => fetchBingXPublicMock(...args),
}))

function resetInlineRedisGlobals() {
  delete (globalThis as any).__redis_data
  delete (globalThis as any).__redis_load_promise
  delete (globalThis as any).__redis_core_promise
  delete (globalThis as any).__redis_init_promise
  delete (globalThis as any).__redis_snapshot_loaded
  delete (globalThis as any).__redis_fully_connected
  delete (globalThis as any).__redis_backend
}

function upwardHistory() {
  const end = Date.now()
  return Array.from({ length: 120 }, (_, index) => {
    const close = 100 + index * 0.3
    return {
      time: end - (119 - index) * 60_000,
      open: close - 0.1,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: 100 + index,
    }
  })
}

describe("Direct-Trade historical calculation route", () => {
  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    resetInlineRedisGlobals()
    fetchTopSymbolsMock.mockResolvedValue({ symbols: [{ symbol: "BTCUSDT" }] })
    fetchBingXPublicMock.mockResolvedValue({ ok: true, json: async () => ({ data: upwardHistory() }) })
  })

  afterEach(() => resetInlineRedisGlobals())

  test("evaluates every requested TP/SL/trailing configuration as an independent 60h set", async () => {
    const [{ POST }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/calculate/route"),
      import("@/lib/redis-db"),
    ])
    const response = await POST(new Request("http://localhost/api/trade-engine/direct-trade/calculate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbolCount: 1,
        historyHours: 60,
        timeframes: ["1m"],
        entryTactics: ["breakout"],
        exitTactics: ["bracket"],
        trailingEnabled: false,
        activityVolumeRatio: 0,
      }),
    }) as any)
    const payload = await response.json()

    expect(payload.success).toBe(true)
    // With trailing disabled the default enabled types still stay isolated:
    // standard (48), Combination (48), inverse (80, up to 1.25× TP) and
    // high-protection (8). Fixed and Auto Trailing correctly have no lane.
    expect(payload.configTotal).toBe(184)
    expect(payload.executionConfigTotal).toEqual(expect.any(Number))
    expect(payload.summary).toMatchObject({ historyHours: 60, combinations: 1, evaluatedSets: 184 })
    expect(payload.summary.byStrategyType).toMatchObject({
      standard: { evaluated: 48 },
      trailing_fixed: { evaluated: 0 },
      trailing_auto: { evaluated: 0 },
      combination: { evaluated: 48 },
      inverse: { evaluated: 80 },
      high_protection: { evaluated: 8 },
    })
    expect(fetchBingXPublicMock.mock.calls[0][0]).toContain("interval=1m")
    expect(fetchBingXPublicMock.mock.calls[0][0]).toContain("startTime=")
    const persisted = JSON.parse((await getRedisClient().get("direct_trade:configs")) || "[]")
    expect(persisted).toHaveLength(184)
    expect(new Set(persisted.map((config: any) => config.setKey)).size).toBe(184)
    expect(persisted.every((config: any) => config.timeframe === "1m" && config.bestMarketExitAnalysisOnly === true)).toBe(true)
    expect(persisted.filter((config: any) => config.strategyType === "inverse").every((config: any) =>
      config.stoploss <= config.takeprofit * 1.25,
    )).toBe(true)
  })

  test("keeps Fixed Trailing, Auto Trailing and Combination as disjoint full-grid lineages", async () => {
    const [{ POST }, { getRedisClient }] = await Promise.all([
      import("@/app/api/trade-engine/direct-trade/calculate/route"),
      import("@/lib/redis-db"),
    ])
    const response = await POST(new Request("http://localhost/api/trade-engine/direct-trade/calculate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        symbolCount: 1,
        historyHours: 60,
        timeframes: ["1m"],
        entryTactics: ["breakout"],
        exitTactics: ["bracket"],
        trailingEnabled: true,
        activityVolumeRatio: 0,
      }),
    }) as any)
    const payload = await response.json()
    const persisted = JSON.parse((await getRedisClient().get("direct_trade:configs")) || "[]")

    expect(payload.success).toBe(true)
    expect(payload.configTotal).toBe(1024)
    expect(payload.summary.byStrategyType).toMatchObject({
      standard: { evaluated: 48 },
      trailing_fixed: { evaluated: 144 },
      trailing_auto: { evaluated: 144 },
      combination: { evaluated: 336 },
      inverse: { evaluated: 320 },
      high_protection: { evaluated: 32 },
    })
    const byType = (strategyType: string) => persisted.filter((config: any) => config.strategyType === strategyType)
    expect(byType("trailing_fixed").every((config: any) => config.trailingMode === "fixed")).toBe(true)
    expect(byType("trailing_auto").every((config: any) => config.trailingMode === "auto")).toBe(true)
    expect(new Set(byType("combination").map((config: any) => config.trailingMode))).toEqual(new Set(["none", "fixed", "auto"]))
    expect(new Set(persisted.map((config: any) => config.setKey)).size).toBe(1024)
  })

  test("allows one full-grid publisher while a concurrent request receives a retryable conflict", async () => {
    let releaseHistory: ((value: unknown) => void) | undefined
    fetchBingXPublicMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseHistory = resolve
    }))
    const { POST } = await import("@/app/api/trade-engine/direct-trade/calculate/route")
    const request = () => new Request("http://localhost/api/trade-engine/direct-trade/calculate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbolCount: 1, historyHours: 1, timeframes: ["1m"] }),
    }) as any

    const owner = POST(request())
    // The owner must have acquired the calculation lease before the duplicate
    // request starts. A single macrotask was only accidentally sufficient
    // while Redis initialisation was lighter; the chunked store now performs
    // its own async setup before the history request. Waiting for the mocked
    // blocked history call verifies the actual concurrency boundary instead
    // of racing module/Redis scheduling.
    for (let attempt = 0; attempt < 200 && !releaseHistory; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(releaseHistory).toEqual(expect.any(Function))
    const duplicate = await POST(request())
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toMatchObject({ retryAfterSeconds: 10 })

    releaseHistory!({ ok: true, json: async () => ({ data: upwardHistory() }) })
    expect((await owner).status).toBe(200)
  })
})
