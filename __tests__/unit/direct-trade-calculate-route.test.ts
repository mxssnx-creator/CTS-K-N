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
  return Array.from({ length: 300 }, (_, index) => {
    const close = 100 + index * 0.3
    return {
      time: end - (299 - index) * 60_000,
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
    const history = upwardHistory()
    fetchBingXPublicMock.mockResolvedValue({ ok: true, json: async () => ({ data: history }) })
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
        timeframes: ["5m"],
        entryTactics: ["breakout"],
        exitTactics: ["bracket"],
        trailingEnabled: false,
        activityVolumeRatio: 0,
      }),
    }) as any)
    const payload = await response.json()

    expect(payload.success).toBe(true)
    // The optimized 4–8× range uses a Set-creation step of two, materialising
    // 4, 6 and 8. Fixed and Auto remain absent when trailing is disabled;
    // DCA remains its own non-Block lineage.
    expect(payload.configTotal).toBe(312)
    expect(payload.executionConfigTotal).toEqual(expect.any(Number))
    expect(payload.summary).toMatchObject({ historyHours: 60, combinations: 1, evaluatedSets: 312 })
    expect(payload.summary).toMatchObject({
      symbols: ["BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT"],
      blockEnabled: true,
      blockEvaluatedSets: 72 * 12 * 4,
    })
    expect(payload.summary.byBlockCount["1"]).toMatchObject({ evaluated: 288 })
    expect(payload.summary.byBlockCount["12"]).toMatchObject({ evaluated: 288 })
    expect(payload.summary.byStrategyType).toMatchObject({
      standard: { evaluated: 72 },
      trailing_fixed: { evaluated: 0 },
      trailing_auto: { evaluated: 0 },
      combination: { evaluated: 72 },
      inverse: { evaluated: 120 },
      high_protection: { evaluated: 24 },
      dca: { evaluated: 24 },
    })
    expect(payload.summary.byDirection).toMatchObject({
      long: { evaluated: 156 },
      short: { evaluated: 156 },
    })
    expect(payload.summary.byStopLossRatio).toMatchObject({
      "0.25": { evaluated: 72 },
      "0.5": { evaluated: 72 },
      "0.75": { evaluated: 96 },
      "1": { evaluated: 24 },
      "1.25": { evaluated: 24 },
    })
    expect(payload.summary.byTakeProfitPositionCostRatio).toMatchObject({
      "4": { evaluated: 104 },
      "6": { evaluated: 104 },
      "8": { evaluated: 104 },
    })
    expect(payload.summary.byExitTactic.bracket).toMatchObject({
      evaluated: 312,
      disabled: payload.summary.byExitTactic.bracket.evaluated - payload.summary.byExitTactic.bracket.valid,
      totalPnl: expect.any(Number),
      netProfit: expect.any(Number),
      netLoss: expect.any(Number),
      profitFactorInfinite: expect.any(Boolean),
    })
    expect(fetchBingXPublicMock.mock.calls[0][0]).toContain("interval=1m")
    expect(fetchBingXPublicMock.mock.calls[0][0]).toContain("startTime=")
    const persisted = JSON.parse((await getRedisClient().get("direct_trade:configs")) || "[]")
    const statisticsIndex = JSON.parse((await getRedisClient().get("direct_trade:statistics-index")) || "{}")
    expect(persisted).toHaveLength(312)
    expect(new Set(persisted.map((config: any) => config.setKey)).size).toBe(312)
    expect(persisted.every((config: any) => config.blockEvaluations === undefined)).toBe(true)
    expect(statisticsIndex).toMatchObject({ schemaVersion: 2 })
    expect(Array.isArray(statisticsIndex.rows) && statisticsIndex.rows.length > 0).toBe(true)
    expect(statisticsIndex.rows.every((row: any) => row.blockEvaluations === undefined)).toBe(true)
    expect(Object.values(statisticsIndex.topRowIndexes || {}).every((indexes: any) =>
      Array.isArray(indexes) && indexes.every((index: any) => Number.isInteger(index)),
    )).toBe(true)
    expect(persisted.every((config: any) => config.timeframe === "5m" && config.bestMarketExitAnalysisOnly === true)).toBe(true)
    expect(persisted.every((config: any) =>
      Number.isFinite(config.takeprofit) &&
      Number.isFinite(config.takeProfitPositionCostRatio) &&
      Number.isFinite(config.stoploss),
    )).toBe(true)
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
        timeframes: ["5m"],
        entryTactics: ["breakout"],
        exitTactics: ["bracket"],
        trailingEnabled: true,
        activityVolumeRatio: 0,
      }),
    }) as any)
    const payload = await response.json()
    const persisted = JSON.parse((await getRedisClient().get("direct_trade:configs")) || "[]")

    expect(payload.success).toBe(true)
    expect(payload.configTotal).toBe(1608)
    expect(payload.summary.byStrategyType).toMatchObject({
      standard: { evaluated: 72 },
      trailing_fixed: { evaluated: 216 },
      trailing_auto: { evaluated: 216 },
      combination: { evaluated: 504 },
      inverse: { evaluated: 480 },
      high_protection: { evaluated: 96 },
      dca: { evaluated: 24 },
    })
    const byType = (strategyType: string) => persisted.filter((config: any) => config.strategyType === strategyType)
    expect(byType("trailing_fixed").every((config: any) => config.trailingMode === "fixed")).toBe(true)
    expect(byType("trailing_auto").every((config: any) => config.trailingMode === "auto")).toBe(true)
    expect(new Set(byType("combination").map((config: any) => config.trailingMode))).toEqual(new Set(["none", "fixed", "auto"]))
    expect(new Set(persisted.map((config: any) => config.setKey)).size).toBe(1608)
  })

  test("applies the configured SL ratio step without omitting the requested protection maximum", async () => {
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
        timeframes: ["5m"],
        strategyTypes: ["standard"],
        entryTactics: ["breakout"],
        exitTactics: ["bracket"],
        trailingEnabled: false,
        activityVolumeRatio: 0,
        maxSlRatio: 0.75,
        slRatioStep: 0.5,
      }),
    }) as any)
    const payload = await response.json()
    const persisted = JSON.parse((await getRedisClient().get("direct_trade:configs")) || "[]")

    expect(payload.success).toBe(true)
    // Three optimized TP Set ratios (4, 6, 8× PositionCost) × two configured
    // SL ratios × independently evaluated long/short.
    expect(payload.configTotal).toBe(48)
    expect(new Set(persisted.map((config: any) => Number((config.stoploss / config.takeprofit).toFixed(2))))).toEqual(new Set([0.25, 0.75]))
  })

  test("converts the configured PositionCost TP multiples and keeps Block ratio separate from base volume", async () => {
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
        timeframes: ["5m"],
        strategyTypes: ["standard"],
        entryTactics: ["breakout"],
        exitTactics: ["bracket"],
        trailingEnabled: false,
        activityVolumeRatio: 0,
        positionCostPercent: 0.1,
        takeProfitRatioRange: [4, 6],
        takeProfitRatioStep: 1,
        blockRange: [3, 3],
        blockVolumeRatio: 1.5,
      }),
    }) as any)
    const payload = await response.json()
    const persisted = JSON.parse((await getRedisClient().get("direct_trade:configs")) || "[]")

    expect(payload.success).toBe(true)
    expect(payload.configTotal).toBe(72)
    expect(new Set(persisted.map((config: any) => config.takeProfitPositionCostRatio))).toEqual(new Set([4, 5, 6]))
    expect(new Set(persisted.map((config: any) => config.takeprofit))).toEqual(new Set([0.4, 0.5, 0.6]))
    expect(persisted.every((config: any) => config.blockCount === 3 && config.blockVolumeRatio === 1.5)).toBe(true)
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
      body: JSON.stringify({ symbolCount: 1, historyHours: 1, timeframes: ["5m"] }),
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
