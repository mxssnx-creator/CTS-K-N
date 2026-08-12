import { calculateLivePositionStatistics } from "@/lib/live-position-statistics"

describe("complete live position/order/statistics relations", () => {
  test("reconciles quantities, volumes, partials, lineage, sources, protection, and PnL", () => {
    const positions = [
      {
        id: "main-open",
        symbol: "BTCUSDT",
        direction: "long",
        status: "open",
        orderId: "entry-main",
        stopLossOrderId: "sl-main",
        stopLoss: 1,
        takeProfit: 2,
        protectionMode: "hybrid_control_system",
        systemProtectionLegs: ["take_profit"],
        setKey: "main-set",
        parentSetKey: "main-parent",
        accumulatedSetKeys: ["main-set", "dca-set"],
        setVariant: "dca",
        indicationType: "direction",
        executedQuantity: 0.02,
        closedQuantity: 0.01,
        totalExecutedQuantity: 0.03,
        averageExecutionPrice: 100,
        fills: [
          { quantity: 0.01, price: 100, fee: 0.01 },
          { quantity: 0.02, price: 101, fee: 0.02 },
        ],
        partialOrderExecutions: [{ executionId: "partial-1" }],
        realizedPnL: 0.5,
        unrealizedPnL: 1.25,
      },
      {
        id: "signal-closed",
        symbol: "SOLUSDT",
        direction: "short",
        status: "closed",
        orderId: "entry-signal",
        stopLossOrderId: "sl-signal",
        takeProfitOrderId: "tp-signal",
        setKey: "signal-set",
        accumulatedSetKeys: ["signal-set"],
        indicationType: "signal",
        signalRisk: { sourceIds: ["source-a"] },
        setVariant: "trailing",
        executedQuantity: 0.02,
        closedQuantity: 0.02,
        totalExecutedQuantity: 0.02,
        averageExecutionPrice: 100,
        fills: [{ quantity: 0.02, price: 100, fee: 0.01 }],
        realizedPnL: 2,
        realizedRoi: 10,
      },
      {
        id: "preset-combined",
        symbol: "XRPUSDT",
        direction: "long",
        status: "open",
        orderId: "entry-preset",
        stopLoss: 0,
        takeProfit: 0,
        presetId: "preset-1",
        setKey: "axis-a",
        accumulatedSetKeys: ["axis-a", "axis-b"],
        combinedPosCounts: true,
        posCountsSetQuantities: { "axis-a": 2, "axis-b": 1 },
        executedQuantity: 3,
        closedQuantity: 0,
        totalExecutedQuantity: 3,
        averageExecutionPrice: 0.5,
        fills: [{ quantity: 3, price: 0.5 }],
      },
      {
        id: "direct-open",
        symbol: "BCHUSDT",
        direction: "long",
        status: "open",
        executionIntent: "direct-trade",
        orderId: "entry-direct",
        stopLoss: 0,
        takeProfit: 0,
        executedQuantity: 0.1,
        totalExecutedQuantity: 0.1,
        averageExecutionPrice: 500,
        fills: [{ quantity: 0.1, price: 500 }],
      },
    ]

    const stats = calculateLivePositionStatistics(positions)
    expect(stats).toMatchObject({
      positions: 4,
      filled: 4,
      open: 3,
      closed: 1,
      partialExecutions: 1,
      lifetimeQuantity: 3.15,
      openQuantity: 3.12,
      closedQuantity: 0.03,
      realizedPnl: 2.5,
      unrealizedPnl: 1.25,
      wins: 1,
      losses: 0,
      winRate: 100,
      averageRealizedRoi: 10,
      relationIntegrity: { success: true, mismatchCount: 0, checkedPositions: 4 },
    })
    expect(stats.lifetimeVolumeUsd).toBeCloseTo(56.52, 10)
    expect(stats.bySource["main-trade"]).toMatchObject({ positions: 1, partialExecutions: 1 })
    expect(stats.bySource["signal-trade"]).toMatchObject({ positions: 1, closed: 1 })
    expect(stats.bySource["preset-trade"]).toMatchObject({ positions: 1, open: 1 })
    expect(stats.bySource["direct-trade"]).toMatchObject({ positions: 1, open: 1 })
    expect(stats.protection).toMatchObject({
      hybridControlSystem: 1,
      missingVenueLegsHandledBySystem: 1,
    })
  })

  test("surfaces broken physical/member and venue/system protection relations", () => {
    const stats = calculateLivePositionStatistics([{
      id: "broken",
      symbol: "BTCUSDT",
      direction: "long",
      status: "open",
      setKey: "member-a",
      accumulatedSetKeys: [],
      combinedPosCounts: true,
      posCountsSetQuantities: { "member-a": 0.2 },
      executedQuantity: 1,
      closedQuantity: 0.5,
      totalExecutedQuantity: 1,
      stopLoss: 1,
      takeProfit: 2,
      orderId: "duplicate",
      stopLossOrderId: "duplicate",
    }])

    expect(stats.relationIntegrity.success).toBe(false)
    expect(stats.relationIntegrity.mismatches).toEqual(expect.arrayContaining([
      expect.stringContaining("open+closed quantity"),
      expect.stringContaining("member allocation"),
      expect.stringContaining("take-profit has neither venue order nor system handling"),
      expect.stringContaining("order IDs are not unique"),
    ]))
  })

  test("tracks legacy and newly-stamped simulated protection as system handled without masking real gaps", () => {
    const simulated = calculateLivePositionStatistics([{
      id: "paper-protected",
      symbol: "SOLUSDT",
      direction: "short",
      status: "simulated",
      executionMode: "simulation",
      executedQuantity: 2,
      totalExecutedQuantity: 2,
      averageExecutionPrice: 150,
      stopLoss: 0.5,
      takeProfit: 1.25,
      stopLossPrice: 151,
      takeProfitPrice: 148,
      fills: [{ quantity: 2, price: 150 }],
    }])

    expect(simulated.relationIntegrity).toMatchObject({ success: true, mismatchCount: 0 })
    expect(simulated.protection).toMatchObject({
      systemClose: 1,
      missingVenueLegsHandledBySystem: 2,
    })

    const real = calculateLivePositionStatistics([{
      id: "real-unprotected",
      symbol: "SOLUSDT",
      direction: "short",
      status: "open",
      executionMode: "live",
      executedQuantity: 2,
      totalExecutedQuantity: 2,
      stopLoss: 0.5,
      takeProfit: 1.25,
      fills: [{ quantity: 2, price: 150 }],
    }])

    expect(real.relationIntegrity.success).toBe(false)
    expect(real.relationIntegrity.mismatches).toEqual(expect.arrayContaining([
      expect.stringContaining("stop-loss has neither venue order nor system handling"),
      expect.stringContaining("take-profit has neither venue order nor system handling"),
    ]))
  })

  test("does not claim system protection when an open execution has no authoritative price", () => {
    const stats = calculateLivePositionStatistics([{
      id: "paper-without-price",
      symbol: "ADAUSDT",
      direction: "long",
      status: "simulated",
      executionMode: "simulation",
      executedQuantity: 10,
      totalExecutedQuantity: 10,
      stopLoss: 0.5,
      takeProfit: 1,
      fills: [{ quantity: 10, price: 0 }],
    }])

    expect(stats.relationIntegrity.success).toBe(false)
    expect(stats.relationIntegrity.mismatches).toEqual(expect.arrayContaining([
      expect.stringContaining("open execution has no authoritative average price"),
    ]))
  })
})
