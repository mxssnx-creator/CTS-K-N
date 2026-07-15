const buildCandles = () => {
  const end = Date.now() - 60_000
  return Array.from({ length: 400 }, (_, index) => {
    const timestamp = end - (399 - index) * 5 * 60_000
    const baseline = 100 + index * 0.25
    return {
      timestamp,
      open: baseline - 0.05,
      high: baseline + 0.4,
      low: baseline - 0.1,
      close: baseline,
      volume: 100 + index,
    }
  })
}

const mockGetHistoricCandlesForRange = jest.fn(async () => buildCandles())
const mockGetOHLCV = jest.fn(async (..._args: unknown[]) => null as Array<Record<string, number>> | null)

jest.mock("@/lib/trade-engine/market-data-cache", () => ({
  getHistoricCandlesForRange: (...args: unknown[]) => mockGetHistoricCandlesForRange(...args),
}))

jest.mock("@/lib/exchange-connectors", () => ({
  createExchangeConnector: jest.fn(async () => ({
    getOHLCV: (...args: unknown[]) => mockGetOHLCV(...args),
  })),
}))

jest.mock("@/lib/connection-settings-overlay", () => ({
  getCanonicalConnectionSettingsOverlay: jest.fn(async () => ({})),
}))

function resetInlineRedisGlobals() {
  delete (globalThis as any).__redis_data
  delete (globalThis as any).__redis_load_promise
  delete (globalThis as any).__redis_core_promise
  delete (globalThis as any).__redis_init_promise
  delete (globalThis as any).__redis_snapshot_loaded
  delete (globalThis as any).__redis_fully_connected
  delete (globalThis as any).__redis_backend
  delete (globalThis as any).__redis_cleanup_started
}

describe("preset optimizer store and API integration", () => {
  const connectionId = "preset-integration-bingx"
  const originalEnv = { ...process.env }

  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    mockGetHistoricCandlesForRange.mockImplementation(async () => buildCandles())
    mockGetOHLCV.mockResolvedValue(null)
    resetInlineRedisGlobals()
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      V0_REDIS_SNAPSHOT_PATH: `/tmp/cts-preset-store-${process.pid}-${Date.now()}.json`,
      ALLOW_PROD_INLINE_REDIS: "1",
      ALLOW_INLINE_REDIS_LIVE_TRADING: "1",
    }
    delete process.env.REDIS_URL
  })

  afterEach(() => {
    resetInlineRedisGlobals()
    process.env = originalEnv
  })

  test("generates, ranks, auto-selects, reloads, and applies an eligible preset", async () => {
    const redisDb = await import("@/lib/redis-db")
    const store = await import("@/lib/preset-store")
    await redisDb.initRedis()
    await redisDb.createConnection({
      id: connectionId,
      name: "Preset Integration BingX",
      exchange: "bingx",
      api_key: "preset-integration-key-123",
      api_secret: "preset-integration-secret-123",
      is_preset_trade: "1",
      preset_trade_requested: "1",
      symbols: JSON.stringify(["BTCUSDT"]),
      exchangePositionCost: "0.1",
    })
    await redisDb.getRedisClient().set("indications:common", JSON.stringify({
      parabolicSAR: {
        enabled: true,
        acceleration: { from: 0.02, to: 0.02, step: 0.005 },
        maximum: { from: 0.2, to: 0.2, step: 0.05 },
      },
    }))

    const settings = await store.savePresetOptimizerSettings({
      historyDays: 1,
      presetsPerSymbol: 4,
      minProfitFactor: 0.4,
      maxDrawdownHours: 24,
      takeProfit: { min: 3, max: 3, step: 1 },
      stopLossRatio: { min: 1, max: 1, step: 0.25 },
      trailingEnabled: false,
      autoGenerate: false,
      autoSelect: true,
      indicatorTypes: ["sar"],
      maxIndicatorVariantsPerType: 1,
      maxSignalsPerVariant: 16,
      maxCandlesPerRun: 500,
    })
    expect(settings).toMatchObject({ presetsPerSymbol: 4, autoSelect: true, indicatorTypes: ["sar"] })

    const blockSettings = await store.savePresetOptimizerSettings({
      blockEnabled: true,
      blockVolumeRatio: 1.75,
      blockMaxStack: 3,
      blockPauseCountRatio: 2.5,
      blockActiveRealEnabled: false,
      blockActiveLiveEnabled: true,
    }, connectionId)
    expect(blockSettings).toMatchObject({
      blockEnabled: true,
      blockVolumeRatio: 1.75,
      blockMaxStack: 3,
      blockPauseCountRatio: 2.5,
      blockActiveRealEnabled: false,
      blockActiveLiveEnabled: true,
    })
    await expect(redisDb.getRedisClient().hgetall(`connection_settings:${connectionId}`)).resolves.toMatchObject({
      variantBlockEnabled: "true",
      blockVolumeRatio: "1.75",
      blockMaxStack: "3",
      blockPauseCountRatio: "2.5",
      blockActiveRealEnabled: "false",
      blockActiveLiveEnabled: "true",
    })

    const progress = await store.runPresetOptimization({ connectionId, symbols: ["BTCUSDT"] })
    expect(progress).toMatchObject({
      status: "completed",
      symbolsCompleted: 1,
      symbolsTotal: 1,
    })
    expect(progress.evaluatedConfigurations).toBeGreaterThan(0)
    expect(progress.sourceCandles).toBe(400)
    expect(mockGetHistoricCandlesForRange).toHaveBeenCalledWith(
      "BTCUSDT",
      expect.objectContaining({ batchChunks: 4 }),
    )

    const overview = await store.getPresetOverview(connectionId)
    expect(overview.generationId).toBeTruthy()
    expect(overview.progress.status).toBe("completed")
    expect(overview.presets.length).toBeGreaterThan(0)
    expect(overview.summary.total).toBe(overview.presets.length)
    expect(overview.presets[0]).toMatchObject({
      connectionId,
      symbol: "BTCUSDT",
      positionCostPct: 0.1,
      takeProfitRatio: 3,
      takeProfitPct: 0.3,
      stopLossPct: 0.3,
      selected: true,
    })
    expect(overview.presets[0].metrics.eligible).toBe(true)

    const sourcePosition = {
      id: "real-preset-1",
      symbol: "BTC-USDT",
      direction: "long",
      indicationType: "sar",
      stopLoss: 9,
      takeProfit: 12,
      setVariant: "default",
    }
    const applied = await store.applySelectedPresetToRealPosition(
      connectionId,
      sourcePosition,
      { is_preset_trade: "1" },
    )
    expect(applied).toMatchObject({
      presetId: overview.presets[0].id,
      presetIndicatorType: "sar",
      presetPositionCostPct: 0.1,
      stopLoss: 0.3,
      takeProfit: 0.3,
    })

    const blockApplied = await store.applySelectedPresetToRealPosition(
      connectionId,
      {
        ...sourcePosition,
        id: "real-preset-block-3",
        setKey: "sar:long#block:3",
        setVariant: "block",
        blockBaseVolumeMultiplier: 2,
        blockVolumeRatio: 1.75,
        blockCalculatedVolumeMultiplier: 10.5,
        sizeMultiplier: 10.5,
      },
      { is_preset_trade: "1" },
    )
    expect(blockApplied).toMatchObject({
      setVariant: "block",
      blockBaseVolumeMultiplier: 2,
      blockVolumeRatio: 1.75,
      blockCalculatedVolumeMultiplier: 10.5,
      sizeMultiplier: 10.5,
      stopLoss: 0.3,
      takeProfit: 0.3,
    })

    const disabled = await store.applySelectedPresetToRealPosition(
      connectionId,
      sourcePosition,
      { is_preset_trade: "0" },
    )
    expect(disabled).toEqual(sourcePosition)

    jest.resetModules()
    const reloadedStore = await import("@/lib/preset-store")
    const reloaded = await reloadedStore.getPresetOverview(connectionId)
    expect(reloaded.generationId).toBe(overview.generationId)
    expect(reloaded.presets[0].id).toBe(overview.presets[0].id)
    expect(reloaded.engine).toMatchObject({ enabled: "1", requested: "1" })
  })

  test("serves persisted optimizer data through the production API contract", async () => {
    const { NextRequest } = await import("next/server")
    const redisDb = await import("@/lib/redis-db")
    const store = await import("@/lib/preset-store")
    const route = await import("@/app/api/preset-optimizer/route")
    await redisDb.initRedis()
    await redisDb.createConnection({
      id: connectionId,
      name: "Preset API BingX",
      exchange: "bingx",
      api_key: "preset-api-key-12345",
      api_secret: "preset-api-secret-12345",
      is_preset_trade: "1",
      symbols: JSON.stringify(["BTCUSDT"]),
      exchangePositionCost: "0.1",
    })
    await store.savePresetOptimizerSettings({
      historyDays: 1,
      presetsPerSymbol: 4,
      minProfitFactor: 0.4,
      maxDrawdownHours: 24,
      takeProfit: { min: 3, max: 3, step: 1 },
      stopLossRatio: { min: 1, max: 1, step: 0.25 },
      trailingEnabled: false,
      autoGenerate: false,
      autoSelect: true,
      indicatorTypes: ["sar"],
      maxIndicatorVariantsPerType: 1,
      maxSignalsPerVariant: 16,
      maxCandlesPerRun: 500,
    })
    await store.runPresetOptimization({ connectionId, symbols: ["BTCUSDT"] })

    const response = await route.GET(new NextRequest(
      `http://localhost/api/preset-optimizer?connectionId=${connectionId}&limit=50`,
    ))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ connectionId })
    expect(body.data.presets.length).toBeGreaterThan(0)
    expect(body.data.settings.presetsPerSymbol).toBe(4)
    expect(body.data.summary.selected).toBeGreaterThan(0)

    const preset = body.data.presets[0]
    const selectResponse = await route.POST(new NextRequest("http://localhost/api/preset-optimizer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId,
        action: "select",
        presetId: preset.id,
        symbol: "BTCUSDT",
        indicatorType: "*",
      }),
    }))
    expect(selectResponse.status).toBe(200)
    expect(await selectResponse.json()).toMatchObject({ success: true, preset: { id: preset.id, selected: true } })

    const resolved = await store.resolveSelectedPresetForPosition(connectionId, {
      symbol: "BTCUSDT",
      indicationType: "unknown",
    })
    expect(resolved?.id).toBe(preset.id)

    const activeGeneration = await redisDb.getRedisClient().get(`preset_optimizer:v2:${connectionId}:active_generation`)
    const candidateKey = `preset_optimizer:v2:${connectionId}:generation:${activeGeneration}:candidate:${preset.id}`
    const storedCandidate = JSON.parse(String(await redisDb.getRedisClient().get(candidateKey)))
    await redisDb.getRedisClient().set(candidateKey, JSON.stringify({
      ...storedCandidate,
      metrics: { ...storedCandidate.metrics, eligible: false },
    }))
    const ineligibleResponse = await route.POST(new NextRequest("http://localhost/api/preset-optimizer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connectionId,
        action: "select",
        presetId: preset.id,
        symbol: "BTCUSDT",
        indicatorType: "*",
      }),
    }))
    expect(ineligibleResponse.status).toBe(400)
    expect(await ineligibleResponse.json()).toMatchObject({ success: false, error: expect.stringMatching(/not eligible/i) })
  })

  test("fills a 14-day optimizer window from compact exchange candles when the chunk cache is too short", async () => {
    const end = Date.now() - 60_000
    const exchangeCandles = Array.from({ length: 14 * 24 * 4 }, (_, index) => {
      const close = 100 + index * 0.03
      return {
        timestamp: end - (14 * 24 * 4 - 1 - index) * 15 * 60_000,
        open: close - 0.02,
        high: close + 0.25,
        low: close - 0.08,
        close,
        volume: 1_000 + index,
      }
    })
    mockGetOHLCV.mockResolvedValue(exchangeCandles)

    const redisDb = await import("@/lib/redis-db")
    const store = await import("@/lib/preset-store")
    await redisDb.initRedis()
    await redisDb.createConnection({
      id: connectionId,
      name: "Preset 14-day BingX",
      exchange: "bingx",
      api_key: "preset-history-key-12345",
      api_secret: "preset-history-secret-12345",
      api_type: "perpetual_futures",
      is_preset_trade: "1",
      symbols: JSON.stringify(["BTCUSDT"]),
      exchangePositionCost: "0.1",
    })
    await redisDb.getRedisClient().set("indications:common", JSON.stringify({
      parabolicSAR: {
        enabled: true,
        acceleration: { from: 0.02, to: 0.02, step: 0.005 },
        maximum: { from: 0.2, to: 0.2, step: 0.05 },
      },
    }))
    await store.savePresetOptimizerSettings({
      historyDays: 14,
      presetsPerSymbol: 1,
      minProfitFactor: 0.4,
      maxDrawdownHours: 5,
      takeProfit: { min: 3, max: 3, step: 1 },
      stopLossRatio: { min: 1, max: 1, step: 0.25 },
      trailingEnabled: false,
      autoGenerate: false,
      autoSelect: true,
      indicatorTypes: ["sar"],
      maxIndicatorVariantsPerType: 1,
      maxSignalsPerVariant: 24,
      maxCandlesPerRun: 2_000,
    })

    const progress = await store.runPresetOptimization({ connectionId, symbols: ["BTCUSDT"] })
    expect(mockGetOHLCV).toHaveBeenCalledWith("BTCUSDT", "15m", expect.any(Number))
    expect(progress).toMatchObject({ status: "completed", symbolsCompleted: 1, sourceCandles: exchangeCandles.length })
    const overview = await store.getPresetOverview(connectionId)
    expect(overview.presets).toHaveLength(1)
    expect(Date.parse(overview.presets[0].historyTo) - Date.parse(overview.presets[0].historyFrom))
      .toBeGreaterThan(13 * 24 * 60 * 60_000)
  })

  test("processes 32 symbols with only one prehistoric candle batch resident at a time", async () => {
    const symbols = Array.from({ length: 32 }, (_, index) => `P${String(index + 1).padStart(2, "0")}USDT`)
    let activeLoads = 0
    let peakConcurrentLoads = 0
    mockGetHistoricCandlesForRange.mockImplementation(async () => {
      activeLoads++
      peakConcurrentLoads = Math.max(peakConcurrentLoads, activeLoads)
      await new Promise<void>((resolve) => setImmediate(resolve))
      const candles = buildCandles()
      activeLoads--
      return candles
    })

    const redisDb = await import("@/lib/redis-db")
    const store = await import("@/lib/preset-store")
    await redisDb.initRedis()
    await redisDb.createConnection({
      id: connectionId,
      name: "Preset 32 Symbol Stress",
      exchange: "bingx",
      is_preset_trade: "1",
      symbols: JSON.stringify(symbols),
      exchangePositionCost: "0.1",
    })
    await store.savePresetOptimizerSettings({
      historyDays: 1,
      presetsPerSymbol: 4,
      minProfitFactor: 0.4,
      maxDrawdownHours: 24,
      takeProfit: { min: 3, max: 3, step: 1 },
      stopLossRatio: { min: 1, max: 1, step: 0.25 },
      trailingEnabled: false,
      autoGenerate: false,
      autoSelect: true,
      indicatorTypes: ["sar"],
      maxIndicatorVariantsPerType: 1,
      maxSignalsPerVariant: 16,
      maxCandlesPerRun: 500,
    })

    const progress = await store.runPresetOptimization({ connectionId, symbols })
    expect(progress).toMatchObject({
      status: "completed",
      symbolsCompleted: 32,
      symbolsTotal: 32,
      presetsGenerated: 32,
      sourceCandles: 12_800,
    })
    expect(mockGetHistoricCandlesForRange).toHaveBeenCalledTimes(32)
    expect(peakConcurrentLoads).toBe(1)
    const overview = await store.getPresetOverview(connectionId)
    expect(overview.summary).toMatchObject({ total: 32, eligible: 32, selected: 32, symbols: 32 })
  })
})
