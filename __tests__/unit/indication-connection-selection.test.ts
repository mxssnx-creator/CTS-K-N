describe("connection-scoped indication selection", () => {
  beforeEach(() => {
    jest.resetModules()
  })

  test("keeps Signal and other Main indication toggles isolated per connection", async () => {
    const profiles: Record<string, Record<string, unknown>> = {
      "active_indications:conn-a": {
        direction: "false",
        move: "true",
        active: "true",
        optimal: "false",
        auto: "false",
        signal: "false",
        trend: "true",
        break: "false",
      },
      "active_indications:conn-b": {
        direction: "true",
        move: "false",
        active: "true",
        optimal: "true",
        auto: "false",
        signal: "true",
        trend: "false",
        break: "true",
      },
    }
    const redis = {
      get: jest.fn().mockResolvedValue(null),
    }
    jest.doMock("@/lib/redis-db", () => ({
      initRedis: jest.fn().mockResolvedValue(undefined),
      getRedisClient: jest.fn(() => redis),
      getMarketData: jest.fn(),
      saveIndication: jest.fn(),
      storeIndications: jest.fn(),
      getAppSettings: jest.fn().mockResolvedValue({
        directionEnabled: true,
        moveEnabled: true,
        activeEnabled: true,
        optimalEnabled: true,
        autoEnabled: true,
        trendEnabled: true,
        ctsGTrendEnabled: "false",
        ctsGTrendMinimumSpreadRatio: 0.002,
        ctsGMinimumConfidence: 0.7,
        breakRange: 24,
        breakNoisePct: 0.1,
      }),
      getSettings: jest.fn(async (key: string) => profiles[key] ?? null),
    }))

    const { __indicationProcessorTestUtils } = await import(
      "@/lib/trade-engine/indication-processor-fixed"
    )
    __indicationProcessorTestUtils.invalidateIndicationSettingsCache()

    const first = await __indicationProcessorTestUtils.getSettingsCachedModule("conn-a")
    const second = await __indicationProcessorTestUtils.getSettingsCachedModule("conn-b")

    expect(first).toEqual(expect.objectContaining({
      directionEnabled: false,
      moveEnabled: true,
      signalSettings: expect.objectContaining({ enabled: false }),
      trendEnabled: true,
      breakEnabled: false,
      ctsGTrendEnabled: false,
      ctsGTrendMinimumSpreadRatio: 0.002,
      ctsGMinimumConfidence: 0.7,
      breakRange: 24,
      breakNoisePct: 0.1,
    }))
    expect(second).toEqual(expect.objectContaining({
      directionEnabled: true,
      moveEnabled: false,
      signalSettings: expect.objectContaining({ enabled: true }),
      trendEnabled: false,
      breakEnabled: true,
    }))
    expect(redis.get).toHaveBeenCalledTimes(4)
  })

  test("invalidates only the changed connection and preserves default-enabled Signal", async () => {
    let signalA = false
    const getSettings = jest.fn(async (key: string) => {
      if (key === "active_indications:conn-a") return { signal: String(signalA) }
      return null
    })
    const redis = { get: jest.fn().mockResolvedValue(null) }
    jest.doMock("@/lib/redis-db", () => ({
      initRedis: jest.fn().mockResolvedValue(undefined),
      getRedisClient: jest.fn(() => redis),
      getMarketData: jest.fn(),
      saveIndication: jest.fn(),
      storeIndications: jest.fn(),
      getAppSettings: jest.fn().mockResolvedValue({}),
      getSettings,
    }))

    const { __indicationProcessorTestUtils } = await import(
      "@/lib/trade-engine/indication-processor-fixed"
    )
    __indicationProcessorTestUtils.invalidateIndicationSettingsCache()

    const beforeA = await __indicationProcessorTestUtils.getSettingsCachedModule("conn-a")
    const defaultB = await __indicationProcessorTestUtils.getSettingsCachedModule("conn-b")
    expect(beforeA.signalSettings.enabled).toBe(false)
    expect(defaultB.signalSettings.enabled).toBe(true)
    expect(defaultB).toMatchObject({ breakEnabled: true, ctsGTrendEnabled: true, breakRange: 16 })

    signalA = true
    __indicationProcessorTestUtils.invalidateIndicationSettingsCache("conn-a")
    const afterA = await __indicationProcessorTestUtils.getSettingsCachedModule("conn-a")
    const cachedB = await __indicationProcessorTestUtils.getSettingsCachedModule("conn-b")
    expect(afterA.signalSettings.enabled).toBe(true)
    expect(cachedB.signalSettings.enabled).toBe(true)
    expect(getSettings).toHaveBeenCalledTimes(3)
  })
})
