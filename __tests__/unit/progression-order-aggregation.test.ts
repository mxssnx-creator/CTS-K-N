jest.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: unknown) => ({ body, init }) },
}))

const hgetall = jest.fn(async (key: string) => {
  if (key === "live_orders_by_symbol_v2:conn-1") {
    return {
      "BTCUSDT:long:placed": "2",
      "BTCUSDT:long:filled": "1",
      "BTCUSDT:long:failed": "1",
      "BTCUSDT:short:placed": "3",
      "BTCUSDT:short:filled": "2",
      "ETHUSDT:short:failed": "4",
      SOLUSDT: JSON.stringify({ side: "sell", count: 2, failed: 1 }),
      XRPUSDT: JSON.stringify({ direction: "long", placed: 5, filled: 4, failed: 1 }),
      UNKNOWNUSDT: JSON.stringify({ count: 100 }),
      "BROKEN:side:ignored": "99",
      MALFORMED: "{not json",
    }
  }
  if (key === "strategy_block_pf_stats:conn-1") {
    return {
      "s:BTCUSDT:active:calculated": "4",
      "s:BTCUSDT:active:evaluated": "4",
      "s:BTCUSDT:active:eligible": "3",
      "s:BTCUSDT:active:comparisons": "3",
      "s:BTCUSDT:active:cold_start": "1",
      "s:BTCUSDT:active:outperformed": "2",
      "s:BTCUSDT:active:underperformed": "1",
      "s:BTCUSDT:active:passed": "3",
      "s:BTCUSDT:active:emitted": "2",
      "s:BTCUSDT:active:avg_observed_pf": "1.75",
      "s:BTCUSDT:active:avg_normal_pf": "2",
      "s:BTCUSDT:active:avg_configured_min_pf": "1.2",
      "s:BTCUSDT:active:avg_min_pf": "2",
      "s:BTCUSDT:active:avg_pf_difference": "-0.25",
      "s:BTCUSDT:active:strategy_enabled": "1",
      "s:BTCUSDT:active:real:long": "4",
      "s:BTCUSDT:active:real:short": "1",
      "s:BTCUSDT:active:live:long": "4",
      "s:BTCUSDT:active:live:short": "3",
      "s:BTCUSDT:active:combined:long": "4",
      "s:BTCUSDT:active:combined:short": "3",
      "s:BTCUSDT:active:volume_increment:long": "3",
      "s:BTCUSDT:active:volume_increment:short": "2.25",
      "s:BTCUSDT:c:1:calculated": "4",
      "s:BTCUSDT:c:1:evaluated": "0",
      "s:BTCUSDT:c:1:eligible": "3",
      "s:BTCUSDT:c:1:disabled": "4",
      "s:BTCUSDT:c:1:comparisons": "0",
      "s:BTCUSDT:c:1:cold_start": "4",
      "s:BTCUSDT:c:1:outperformed": "0",
      "s:BTCUSDT:c:1:underperformed": "0",
      "s:BTCUSDT:c:1:passed": "0",
      "s:BTCUSDT:c:1:emitted": "0",
      "s:BTCUSDT:c:1:rejected": "0",
      "s:BTCUSDT:c:1:active": "0",
      "s:BTCUSDT:c:1:paused": "0",
      "s:BTCUSDT:c:1:avg_observed_pf": "2",
      "s:BTCUSDT:c:1:avg_normal_pf": "2",
      "s:BTCUSDT:c:1:avg_configured_min_pf": "0.96",
      "s:BTCUSDT:c:1:avg_min_pf": "2",
      "s:BTCUSDT:c:1:avg_pf_difference": "0",
      "s:BTCUSDT:c:1:avg_volume_increment": "1",
      "s:BTCUSDT:c:1:sample_count": "0",
      "s:BTCUSDT:scoped_snapshot": JSON.stringify({
        updatedAt: 1_800_000_000_000,
        window: 15,
        minimumSampleCount: 5,
        maxStack: 2,
        lanes: {
          "direction:overall": {
            evaluated: 2,
            counts: {
              "1": {
                calculated: 2,
                evaluated: 2,
                eligible: 2,
                comparisons: 2,
                coldStart: 0,
                outperformed: 2,
                underperformed: 0,
                passed: 2,
                emitted: 2,
                rejected: 0,
                active: 1,
                paused: 0,
                sampleCount: 30,
                observedProfitFactorSum: 4.8,
                normalProfitFactorSum: 4,
                configuredMinimumProfitFactorSum: 2,
                minimumProfitFactorSum: 4,
                profitFactorDifferenceSum: 0.8,
                volumeIncrementSum: 2,
              },
            },
          },
          "signal:binance-usdm:long": {
            evaluated: 1,
            counts: {
              "2": {
                calculated: 1,
                evaluated: 1,
                eligible: 1,
                comparisons: 1,
                coldStart: 0,
                outperformed: 1,
                underperformed: 0,
                passed: 1,
                emitted: 1,
                rejected: 0,
                active: 0,
                paused: 0,
                sampleCount: 15,
                observedProfitFactorSum: 1.8,
                normalProfitFactorSum: 1.5,
                configuredMinimumProfitFactorSum: 1.4,
                minimumProfitFactorSum: 1.5,
                profitFactorDifferenceSum: 0.3,
                volumeIncrementSum: 2,
              },
            },
          },
        },
      }),
    }
  }
  return {}
})

jest.mock("@/lib/redis-db", () => ({
  initRedis: jest.fn(async () => undefined),
  getRedisClient: jest.fn(() => ({
    hgetall,
    scard: jest.fn(async () => 0),
    get: jest.fn(async () => null),
    dbSize: jest.fn(async () => 0),
  })),
  getSettings: jest.fn(async () => ({})),
  getConnection: jest.fn(async () => ({})),
  getAppSettings: jest.fn(async () => ({})),
}))
jest.mock("@/lib/volume-calculator", () => ({
  VolumeCalculator: {
    resolveLiveEngine: jest.fn(() => ({ mainVolumeFactor: 1, presetVolumeFactor: 1, tradeMode: "main" })),
  },
}))
jest.mock("@/lib/trade-engine/closed-position-aggregation", () => ({
  aggregateLastXClosedPositions: jest.fn(() => ({ positions: [], summary: {} })),
}))
jest.mock("@/lib/trade-engine", () => ({ getGlobalCoordinator: jest.fn(() => null) }))
jest.mock("@/lib/trade-engine/symbol-selection-ownership", () => ({
  normalizeSymbolList: jest.fn((value) => (Array.isArray(value) ? value : [])),
}))

const { GET } = require("@/app/api/connections/progression/[id]/stats/route")

describe("progression stats order aggregation", () => {
  it("uses one aggregation for mixed canonical and legacy rows in rows and direction totals", async () => {
    const response = await GET({} as Request, { params: Promise.resolve({ id: "conn-1" }) })
    expect(response.body.error).toBeUndefined()
    const live = response.body.liveExecution

    expect(live.ordersByDirection).toEqual({
      long: { placed: 7, filled: 5, failed: 2 },
      short: { placed: 5, filled: 4, failed: 5 },
    })

    expect(live.ordersBySymbol).toEqual([
      {
        symbol: "XRPUSDT",
        long: { placed: 5, filled: 4, failed: 1 },
        short: { placed: 0, filled: 0, failed: 0 },
      },
      {
        symbol: "BTCUSDT",
        long: { placed: 2, filled: 1, failed: 1 },
        short: { placed: 3, filled: 2, failed: 0 },
      },
      {
        symbol: "SOLUSDT",
        long: { placed: 0, filled: 0, failed: 0 },
        short: { placed: 2, filled: 2, failed: 1 },
      },
      {
        symbol: "ETHUSDT",
        long: { placed: 0, filled: 0, failed: 0 },
        short: { placed: 0, filled: 0, failed: 4 },
      },
    ])

    expect(
      response.body.strategyDetail.real.positionStats.adjustTypes.block.activeOverlayEvaluation,
    ).toMatchObject({
      evaluated: 4,
      calculated: 4,
      comparisons: 3,
      coldStart: 1,
      outperformed: 2,
      underperformed: 1,
      passed: 3,
      emitted: 2,
      real: { long: 4, short: 1 },
      live: { long: 4, short: 3 },
      combined: { long: 4, short: 3 },
      volumeIncrement: { long: 3, short: 2.25 },
      avgObservedProfitFactor: 1.75,
      avgNormalProfitFactor: 2,
      avgConfiguredMinimumProfitFactor: 1.2,
      avgMinimumProfitFactor: 2,
      avgProfitFactorDifference: -0.25,
      strategyEnabled: true,
    })
    expect(
      response.body.strategyDetail.real.positionStats.adjustTypes.block.countEvaluations,
    ).toEqual([
      expect.objectContaining({
        count: 1,
        calculated: 4,
        evaluated: 0,
        eligible: 3,
        disabled: 4,
        coldStart: 4,
        emitted: 0,
        avgObservedProfitFactor: 2,
        avgNormalProfitFactor: 2,
        avgConfiguredMinimumProfitFactor: 0.96,
        avgMinimumProfitFactor: 2,
        avgProfitFactorDifference: 0,
      }),
    ])
    expect(
      response.body.strategyDetail.real.positionStats.adjustTypes.block.scopedEvaluations,
    ).toEqual([
      expect.objectContaining({
        symbol: "BTCUSDT",
        laneKind: "direction",
        scope: "overall",
        count: 1,
        calculated: 2,
        evaluated: 2,
        comparisons: 2,
        outperformed: 2,
        avgObservedProfitFactor: 2.4,
        avgNormalProfitFactor: 2,
        avgConfiguredMinimumProfitFactor: 1,
        avgMinimumProfitFactor: 2,
        avgProfitFactorDifference: 0.4,
        avgVolumeIncrement: 1,
      }),
      expect.objectContaining({
        symbol: "BTCUSDT",
        laneKind: "signal_source",
        sourceId: "binance-usdm",
        scope: "long",
        count: 2,
        calculated: 1,
        evaluated: 1,
        comparisons: 1,
        outperformed: 1,
        avgObservedProfitFactor: 1.8,
        avgNormalProfitFactor: 1.5,
        avgConfiguredMinimumProfitFactor: 1.4,
        avgMinimumProfitFactor: 1.5,
        avgProfitFactorDifference: 0.3,
        avgVolumeIncrement: 2,
      }),
    ])
  })
})
