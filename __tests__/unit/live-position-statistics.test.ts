import { calculateLivePositionStatistics } from "@/lib/live-position-statistics"

describe("complete live position/order/statistics relations", () => {
  test("keeps every engine lane independent even when some sets have no results", () => {
    const stats = calculateLivePositionStatistics([{
      id: "direct-only",
      symbol: "BTCUSDT",
      direction: "long",
      status: "closed",
      executionIntent: "direct-trade",
      executedQuantity: 1,
      closedQuantity: 1,
      totalExecutedQuantity: 1,
      averageExecutionPrice: 100,
      fills: [{ quantity: 1, price: 100 }],
      realizedPnL: -1,
    }])

    expect(Object.keys(stats.bySource).sort()).toEqual([
      "direct-trade",
      "main-trade",
      "preset-trade",
      "signal-trade",
      "unknown",
    ])
    expect(stats.bySource["direct-trade"]).toMatchObject({ positions: 1, closed: 1, realizedPnl: -1 })
    expect(stats.bySource["main-trade"]).toMatchObject({ positions: 0, realizedPnl: 0 })
    expect(stats.bySource["preset-trade"]).toMatchObject({ positions: 0, realizedPnl: 0 })
    expect(stats.bySource["signal-trade"]).toMatchObject({ positions: 0, realizedPnl: 0 })
  })

  test("reconciles quantities, volumes, partials, lineage, sources, protection, and PnL", () => {
    const positions = [
      {
        id: "main-open",
        symbol: "BTCUSDT",
        direction: "long",
        status: "open",
        orderId: "entry-main",
        stopLossOrderId: "sl-main",
        stopLossArmedQuantity: 0.02,
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
      venueLegsQuantityCovered: 1,
      venueLegsQuantityUnknown: 0,
      venueLegsQuantityDrifted: 0,
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
      expect.stringContaining("stop-loss venue order has no authoritative armed quantity"),
    ]))
    expect(stats.protection.venueLegsQuantityUnknown).toBe(1)
  })

  test("surfaces independently drifted SL and TP venue coverage", () => {
    const stats = calculateLivePositionStatistics([{
      id: "quantity-drift",
      symbol: "ETHUSDT",
      direction: "long",
      status: "closing_partial",
      executedQuantity: 0.8,
      totalExecutedQuantity: 1,
      closedQuantity: 0.2,
      averageExecutionPrice: 100,
      fills: [{ quantity: 1, price: 100 }],
      stopLoss: 1,
      takeProfit: 2,
      stopLossOrderId: "sl-quantity-drift",
      takeProfitOrderId: "tp-quantity-covered",
      stopLossArmedQuantity: 1,
      takeProfitArmedQuantity: 0.8,
    }])

    expect(stats.open).toBe(1)
    expect(stats.protection).toMatchObject({
      venueLegsQuantityCovered: 1,
      venueLegsQuantityUnknown: 0,
      venueLegsQuantityDrifted: 1,
    })
    expect(stats.relationIntegrity.mismatches).toEqual(expect.arrayContaining([
      expect.stringContaining("stop-loss venue quantity 1 != open quantity 0.8"),
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

  test("counts venue-authoritative quantity adjustments without fabricating fills", () => {
    const stats = calculateLivePositionStatistics([{
      id: "exchange-adjusted",
      symbol: "BTCUSDT",
      direction: "long",
      status: "open",
      executionMode: "live",
      executedQuantity: 2,
      totalExecutedQuantity: 2,
      averageExecutionPrice: 100,
      fills: [{ quantity: 1, price: 100 }],
      exchangeQuantityAdjustments: [{
        id: "exchange-adjusted:ledger:1",
        source: "exchange_reconcile",
        quantity: 1,
        price: 101,
        timestamp: 1,
      }],
    }])

    expect(stats.relationIntegrity).toMatchObject({ success: true, mismatchCount: 0 })
    expect(stats.lifetimeQuantity).toBe(2)
    expect(stats.lifetimeVolumeUsd).toBe(201)
  })

  test("keeps incomplete exchange settlement out of realized outcomes and indication totals", () => {
    const stats = calculateLivePositionStatistics([{
      id: "pending-accounting",
      symbol: "ETHUSDT",
      direction: "short",
      status: " CLOSED ",
      executionMode: "live",
      orderId: "entry-pending",
      executedQuantity: 1,
      closedQuantity: 1,
      totalExecutedQuantity: 1,
      averageExecutionPrice: 100,
      fills: [{ quantity: 1, price: 100 }],
      realizedPnL: 0,
      realizedPnlComplete: false,
      realizedPnlSource: "exchange_unresolved",
      indicationType: "trend",
    }])

    expect(stats).toMatchObject({
      closed: 1,
      accountingPending: 1,
      realizedPnl: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
    })
    expect(stats.byIndicationType.trend).toMatchObject({
      closed: 1,
      accountingPending: 1,
      realizedPnl: 0,
    })
  })

  test("counts one farther security stop per physical slot while preserving independent row controls", () => {
    const common = {
      symbol: "BTCUSDT",
      direction: "long",
      status: "open",
      stopLoss: 1,
      takeProfit: 2,
      executedQuantity: 0.1,
      totalExecutedQuantity: 0.1,
      averageExecutionPrice: 100,
      fills: [{ quantity: 0.1, price: 100 }],
      stopLossArmedQuantity: 0.1,
      takeProfitArmedQuantity: 0.1,
      securityStopRequired: true,
      securityStopStatus: "armed",
      securityStopPrice: 97,
      priceTick: 0.1,
    }
    const stats = calculateLivePositionStatistics([
      {
        ...common,
        id: "row-a",
        orderId: "entry-a",
        stopLossOrderId: "sl-a",
        takeProfitOrderId: "tp-a",
        stopLossPrice: 98,
        securityStopOrderId: "security-slot",
      },
      {
        ...common,
        id: "row-b",
        orderId: "entry-b",
        stopLossOrderId: "sl-b",
        takeProfitOrderId: "tp-b",
        stopLossPrice: 99,
        controlOrderSetCoverage: {
          "set-b": {
            securityStopRequired: true,
            securityStopStatus: "armed",
            securityStopOrderId: "security-slot",
            securityStopPrice: 97,
          },
        },
      },
    ])

    expect(stats.protection).toMatchObject({
      securityStopsRequired: 1,
      securityStopsArmed: 1,
      securityStopsMissing: 0,
      venueLegsQuantityCovered: 4,
    })
    expect(stats.relationIntegrity).toMatchObject({ success: true, mismatchCount: 0 })
  })

  test("surfaces a missing or inward slot security stop", () => {
    const stats = calculateLivePositionStatistics([{
      id: "unsafe-security",
      symbol: "ETHUSDT",
      direction: "short",
      status: "open",
      orderId: "entry",
      executedQuantity: 1,
      totalExecutedQuantity: 1,
      averageExecutionPrice: 100,
      fills: [{ quantity: 1, price: 100 }],
      stopLoss: 1,
      takeProfit: 2,
      stopLossOrderId: "sl",
      takeProfitOrderId: "tp",
      stopLossPrice: 102,
      stopLossArmedQuantity: 1,
      takeProfitArmedQuantity: 1,
      securityStopRequired: true,
      securityStopStatus: "invalid_range",
      securityStopPrice: 101,
    }])

    expect(stats.protection).toMatchObject({
      securityStopsRequired: 1,
      securityStopsArmed: 0,
      securityStopsMissing: 1,
    })
    expect(stats.relationIntegrity.mismatches).toEqual(expect.arrayContaining([
      expect.stringContaining("required slot security stop is not armed"),
    ]))
  })

  test("does not turn pending or rejected requested size into fills, volume, or PnL", () => {
    const stats = calculateLivePositionStatistics([
      {
        id: "pending-request",
        symbol: "BTCUSDT",
        direction: "long",
        status: "pending",
        executionMode: "live",
        executionIntent: "direct-trade",
        quantity: 5,
        averageExecutionPrice: 100,
        markPrice: 90,
      },
      {
        id: "rejected-request",
        symbol: "ETHUSDT",
        direction: "short",
        status: "rejected",
        executionMode: "live",
        executionIntent: "main-trade",
        quantity: 7,
        averageExecutionPrice: 100,
        markPrice: 90,
      },
    ])

    expect(stats).toMatchObject({
      positions: 2,
      filled: 0,
      open: 1,
      lifetimeQuantity: 0,
      openQuantity: 0,
      closedQuantity: 0,
      lifetimeVolumeUsd: 0,
      openVolumeUsd: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      relationIntegrity: { success: true, mismatchCount: 0 },
    })
    expect(stats.bySource["direct-trade"]).toMatchObject({ positions: 1, filled: 0, openQuantity: 0 })
    expect(stats.bySource["main-trade"]).toMatchObject({ positions: 1, filled: 0, openQuantity: 0 })
  })

  test("keeps an explicit Signal execution independent from its optional preset attribution", () => {
    const stats = calculateLivePositionStatistics([{
      id: "signal-with-preset",
      symbol: "SOLUSDT",
      direction: "long",
      status: "closed",
      executionIntent: "signal",
      presetId: "signal-risk-preset",
      executedQuantity: 1,
      closedQuantity: 1,
      totalExecutedQuantity: 1,
      averageExecutionPrice: 100,
      fills: [{ quantity: 1, price: 100 }],
      realizedPnL: 1,
    }])

    expect(stats.bySource["signal-trade"]).toMatchObject({ positions: 1, filled: 1, closed: 1 })
    expect(stats.bySource["preset-trade"]).toMatchObject({ positions: 0, filled: 0, closed: 0 })
  })

  test("uses an armed shared-security record even when stale pending coverage appears first", () => {
    const stats = calculateLivePositionStatistics([{
      id: "shared-security-projection",
      symbol: "BTCUSDT",
      direction: "long",
      status: "open",
      orderId: "entry-shared-security",
      stopLossOrderId: "sl-shared-security",
      takeProfitOrderId: "tp-shared-security",
      stopLossArmedQuantity: 1,
      takeProfitArmedQuantity: 1,
      stopLoss: 1,
      takeProfit: 2,
      stopLossPrice: 98,
      priceTick: 0.1,
      executedQuantity: 1,
      totalExecutedQuantity: 1,
      averageExecutionPrice: 100,
      fills: [{ quantity: 1, price: 100 }],
      controlOrderSetCoverage: {
        stale: {
          securityStopRequired: true,
          securityStopStatus: "pending",
        },
        current: {
          securityStopRequired: true,
          securityStopStatus: "armed",
          securityStopOrderId: "security-shared-slot",
          securityStopPrice: 97,
        },
      },
    }])

    expect(stats.protection).toMatchObject({
      securityStopsRequired: 1,
      securityStopsArmed: 1,
      securityStopsMissing: 0,
    })
    expect(stats.relationIntegrity).toMatchObject({ success: true, mismatchCount: 0 })
  })

  test("rejects a security stop that is farther by one tick but misses the maximum-range gap", () => {
    const stats = calculateLivePositionStatistics([{
      id: "security-gap-too-small",
      symbol: "BTCUSDT",
      direction: "long",
      status: "open",
      orderId: "entry-gap",
      stopLossOrderId: "sl-gap",
      takeProfitOrderId: "tp-gap",
      stopLossArmedQuantity: 1,
      takeProfitArmedQuantity: 1,
      stopLoss: 10,
      takeProfit: 2,
      stopLossPrice: 90,
      priceTick: 0.1,
      executedQuantity: 1,
      totalExecutedQuantity: 1,
      averageExecutionPrice: 100,
      fills: [{ quantity: 1, price: 100 }],
      securityStopRequired: true,
      securityStopStatus: "armed",
      securityStopOrderId: "security-gap",
      securityStopPrice: 89.9,
    }])

    expect(stats.relationIntegrity.success).toBe(false)
    expect(stats.relationIntegrity.mismatches).toEqual(expect.arrayContaining([
      expect.stringContaining("security gap"),
      expect.stringContaining("required 1"),
    ]))
  })

  test("rejects a row control order reused by another logical position", () => {
    const row = {
      symbol: "ETHUSDT",
      direction: "long",
      status: "open",
      stopLoss: 1,
      takeProfit: 2,
      executedQuantity: 1,
      totalExecutedQuantity: 1,
      averageExecutionPrice: 100,
      fills: [{ quantity: 1, price: 100 }],
      stopLossOrderId: "duplicate-row-sl",
      stopLossArmedQuantity: 1,
      takeProfitArmedQuantity: 1,
    }
    const stats = calculateLivePositionStatistics([
      { ...row, id: "row-one", orderId: "entry-one", takeProfitOrderId: "tp-one" },
      { ...row, id: "row-two", orderId: "entry-two", takeProfitOrderId: "tp-two" },
    ])

    expect(stats.relationIntegrity.success).toBe(false)
    expect(stats.relationIntegrity.mismatches).toEqual(expect.arrayContaining([
      expect.stringContaining("order duplicate-row-sl: exclusive entry/row control is shared"),
    ]))
  })

  test("rejects multiple armed security IDs hidden inside one slot coverage projection", () => {
    const stats = calculateLivePositionStatistics([{
      id: "duplicate-security-ids",
      symbol: "SOLUSDT",
      direction: "long",
      status: "open",
      orderId: "entry-duplicate-security",
      stopLossOrderId: "sl-duplicate-security",
      takeProfitOrderId: "tp-duplicate-security",
      stopLossArmedQuantity: 1,
      takeProfitArmedQuantity: 1,
      stopLoss: 1,
      takeProfit: 2,
      stopLossPrice: 98,
      priceTick: 0.1,
      executedQuantity: 1,
      totalExecutedQuantity: 1,
      averageExecutionPrice: 100,
      fills: [{ quantity: 1, price: 100 }],
      securityStopOrderId: "security-a",
      securityStopPrice: 97,
      securityStopRequired: true,
      securityStopStatus: "armed",
      controlOrderSetCoverage: {
        conflict: {
          securityStopOrderId: "security-b",
          securityStopPrice: 96.5,
          securityStopRequired: true,
          securityStopStatus: "armed",
        },
      },
    }])

    expect(stats.relationIntegrity.success).toBe(false)
    expect(stats.relationIntegrity.mismatches).toEqual(expect.arrayContaining([
      expect.stringContaining("expected one security order, found 2"),
    ]))
  })
})
