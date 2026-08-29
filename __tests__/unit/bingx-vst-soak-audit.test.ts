import {
  auditVstSoakExecutionRelations,
  auditVstSoakCounters,
  deriveVstSoakProtectionBand,
  evaluateVstSoakOrderHeadroom,
  normalizeVstSoakCounterSnapshot,
  parseVstSoakExcludedSymbols,
  rankVstSoakSymbolLiquidity,
  vstSoakDirectionForCycle,
} from "@/lib/bingx-vst-soak-audit"

describe("BingX Prod-VST soak accounting audit", () => {
  test("derives liquidation-safe long and short row/security bands", () => {
    expect(deriveVstSoakProtectionBand({
      direction: "long",
      entryPrice: 100,
      liquidationPrice: 80,
      priceTick: 0.1,
    })).toMatchObject({
      source: "liquidation",
      riskDistance: 20,
      initialStopPrice: 88,
      ratchetedStopPrice: 90,
      staleStopPrice: 89,
      takeProfitPrice: 112,
      securityStopPrice: 86.8,
    })
    expect(deriveVstSoakProtectionBand({
      direction: "short",
      entryPrice: 100,
      liquidationPrice: 120,
      priceTick: 0.1,
    })).toMatchObject({
      source: "liquidation",
      initialStopPrice: 112,
      ratchetedStopPrice: 110,
      staleStopPrice: 111,
      takeProfitPrice: 88,
      securityStopPrice: 113.2,
    })
  })

  test("uses the documented fallback when VST omits liquidation and rejects unsafe ranges", () => {
    expect(deriveVstSoakProtectionBand({
      direction: "long",
      entryPrice: 100,
      liquidationPrice: 0,
      priceTick: 0.1,
    })).toMatchObject({
      source: "fallback",
      riskDistance: 8,
      initialStopPrice: 95.2,
      ratchetedStopPrice: 96,
      staleStopPrice: 95.6,
      takeProfitPrice: 104.8,
      securityStopPrice: 94.7,
    })
    expect(() => deriveVstSoakProtectionBand({
      direction: "long",
      entryPrice: 100,
      liquidationPrice: 99,
      priceTick: 0.1,
    })).toThrow("exceed 12 ticks")
  })

  test("selects currently executable VST books instead of assuming mainnet liquidity", () => {
    const ranked = rankVstSoakSymbolLiquidity([
      { symbol: "BTC-USDT", bid: 99.9, ask: 100.1, last: 100 },
      { symbol: "ETHUSDT", bid: 98, ask: 102, last: 100 },
      { symbol: "SOLUSDT", bid: 49.98, ask: 50.02, last: 50 },
      { symbol: "BCHUSDT", bid: 199.5, ask: 200.5, last: 200 },
      { symbol: "XRPUSDT", bid: 0.999, ask: 1.001, last: 1 },
    ], 75)

    expect(ranked.filter((row) => row.eligible).map((row) => row.symbol)).toEqual([
      "SOLUSDT",
      "BTCUSDT",
      "XRPUSDT",
      "BCHUSDT",
    ])
    expect(ranked.find((row) => row.symbol === "ETHUSDT")).toMatchObject({ eligible: false })
    expect(ranked.every((row) => Number.isFinite(row.spreadBps))).toBe(true)
  })

  test("fails closed when a VST ticker has no authoritative two-sided book", () => {
    const ranked = rankVstSoakSymbolLiquidity([
      { symbol: "BTCUSDT", bid: 100, last: 100 },
      { symbol: "SOLUSDT", bid: 0, ask: 10, last: 10 },
    ])

    expect(ranked).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: "BTCUSDT", eligible: false, spreadBps: Number.POSITIVE_INFINITY }),
      expect.objectContaining({ symbol: "SOLUSDT", eligible: false, spreadBps: Number.POSITIVE_INFINITY }),
    ]))
  })

  test("reserves one shared-account order beyond the complete protection set", () => {
    expect(evaluateVstSoakOrderHeadroom(196, 200)).toEqual({
      limit: 200,
      observedOpenOrders: 196,
      maxConcurrentControlOrders: 3,
      safetyReserve: 1,
      requiredHeadroom: 4,
      availableHeadroom: 4,
      safe: true,
    })
    expect(evaluateVstSoakOrderHeadroom(197, 200)).toMatchObject({
      requiredHeadroom: 4,
      availableHeadroom: 3,
      safe: false,
    })
    expect(evaluateVstSoakOrderHeadroom("invalid", 200)).toMatchObject({
      observedOpenOrders: 200,
      availableHeadroom: 0,
      safe: false,
    })
  })

  test.each([4, 5, 6, 7, 8])(
    "balances 16 cycles and flips each reused symbol with %i executable symbols",
    (symbolCount) => {
      const cycles = Array.from({ length: 16 }, (_, index) => ({
        symbol: index % symbolCount,
        direction: vstSoakDirectionForCycle(index, symbolCount),
      }))
      expect(cycles.filter((cycle) => cycle.direction === "long")).toHaveLength(8)
      expect(cycles.filter((cycle) => cycle.direction === "short")).toHaveLength(8)
      for (let symbol = 0; symbol < symbolCount; symbol++) {
        const directions = new Set(cycles.filter((cycle) => cycle.symbol === symbol).map((cycle) => cycle.direction))
        expect(directions).toEqual(new Set(["long", "short"]))
      }
    },
  )

  test("rejects invalid direction-plan coordinates", () => {
    expect(() => vstSoakDirectionForCycle(-1, 5)).toThrow("non-negative cycle")
    expect(() => vstSoakDirectionForCycle(0, 0)).toThrow("positive symbol count")
  })

  test("parses deterministic comma/space separated VST symbol exclusions", () => {
    expect(parseVstSoakExcludedSymbols(" btc-usdt, ETH/USDT  btc_usdt\nSOL:USDT ")).toEqual([
      "BTCUSDT",
      "ETHUSDT",
      "SOLUSDT",
    ])
    expect(parseVstSoakExcludedSymbols(undefined)).toEqual([])
  })

  test("reconciles exact count, per-symbol, and fill-volume deltas", () => {
    const before = normalizeVstSoakCounterSnapshot({
      progression: {
        live_orders_placed_count: "10",
        live_orders_filled_count: "9",
        live_positions_created_count: "4",
        live_orders_accumulated_count: "3",
        live_volume_usd_total: "100",
      },
      perSymbol: { "BTCUSDT:long:placed": "6", "BTCUSDT:long:filled": "5" },
    })
    const after = normalizeVstSoakCounterSnapshot({
      progression: {
        live_orders_placed_count: "14",
        live_orders_filled_count: "13",
        live_positions_created_count: "6",
        live_orders_accumulated_count: "5",
        live_volume_usd_total: "121.25",
      },
      perSymbol: {
        "BTCUSDT:long:placed": "8",
        "BTCUSDT:long:filled": "7",
        "SOLUSDT:short:placed": "2",
        "SOLUSDT:short:filled": "2",
      },
      perSource: {
        "direct-trade:placed": "2",
        "direct-trade:filled": "2",
        "direct-trade:position_created": "1",
        "direct-trade:accumulated": "1",
        "direct-trade:volume_usd": "10.5",
        "main-trade:placed": "2",
        "main-trade:filled": "2",
        "main-trade:position_created": "1",
        "main-trade:accumulated": "1",
        "main-trade:volume_usd": "10.75",
      },
    })

    const audit = auditVstSoakCounters({
      before,
      after,
      cycles: [
        { symbol: "BTCUSDT", direction: "long", tradePath: "direct-trade", entryVolumeUsd: 5, accumulationVolumeUsd: 5.5 },
        { symbol: "SOLUSDT", direction: "short", tradePath: "main-trade", entryVolumeUsd: 5.25, accumulationVolumeUsd: 5.5 },
      ],
    })

    expect(audit.success).toBe(true)
    expect(audit.mismatches).toEqual([])
    expect(audit.actualDelta.progression).toMatchObject({
      live_orders_placed_count: 4,
      live_orders_filled_count: 4,
      live_positions_created_count: 2,
      live_orders_accumulated_count: 2,
      live_volume_usd_total: 21.25,
    })
    expect(audit.actualDelta.perSource).toMatchObject({
      "direct-trade:filled": 2,
      "main-trade:filled": 2,
    })
    expect(audit.actualDelta.perSymbol).toMatchObject({
      "BTCUSDT:long:filled": 2,
      "SOLUSDT:short:filled": 2,
    })
  })

  test("reports count, coordination, and material volume differences", () => {
    const before = normalizeVstSoakCounterSnapshot({})
    const after = normalizeVstSoakCounterSnapshot({
      progression: {
        live_orders_placed_count: 2,
        live_orders_filled_count: 1,
        live_positions_created_count: 2,
        live_orders_accumulated_count: 0,
        live_volume_usd_total: 4,
      },
      perSymbol: { "XRPUSDT:long:placed": 2, "XRPUSDT:long:filled": 1 },
    })
    const audit = auditVstSoakCounters({
      before,
      after,
      cycles: [{ symbol: "XRPUSDT", direction: "long", entryVolumeUsd: 5, accumulationVolumeUsd: 5 }],
    })

    expect(audit.success).toBe(false)
    expect(audit.mismatches).toEqual(expect.arrayContaining([
      expect.stringContaining("live_orders_filled_count"),
      expect.stringContaining("live_positions_created_count"),
      expect.stringContaining("live_orders_accumulated_count"),
      expect.stringContaining("perSymbol XRPUSDT:long:filled"),
      expect.stringContaining("live_volume_usd_total"),
    ]))
  })

  test("reconciles order, position, protection, partial-fill, and path relations", () => {
    const paths = ["direct-trade", "main-trade", "preset-trade", "signal-trade"]
    const cycles = paths.map((tradePath, index) => ({
      symbol: ["BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT"][index],
      direction: index % 2 === 0 ? "long" as const : "short" as const,
      tradePath,
      quantityStep: 0.001,
      priceTick: 0.1,
      entry: { orderId: `${index}-entry`, submittedQuantity: 0.01, filledQuantity: 0.01, filledPrice: 100, volumeUsd: 1, status: "FILLED" },
      accumulation: { orderId: `${index}-acc`, submittedQuantity: 0.01, filledQuantity: 0.01, filledPrice: 101, volumeUsd: 1.01, status: "FILLED" },
      close: { orderId: `${index}-close`, submittedQuantity: 0.02, filledQuantity: 0.02, filledPrice: 102, volumeUsd: 2.04, status: "FILLED" },
      protection: {
        orderId: `${index}-stop`,
        takeProfitOrderId: `${index}-take-profit`,
        securityStopOrderId: `${index}-security`,
        requireTakeProfit: true,
        requireSecurity: true,
        stopPrice: index % 2 === 0 ? 95 : 105,
        takeProfitPrice: index % 2 === 0 ? 105 : 95,
        securityStopPrice: index % 2 === 0 ? 90 : 110,
        stopLossQuantity: 0.02,
        takeProfitQuantity: 0.02,
        securityStopArmedQuantity: 0.02,
        securityQuantityBacked: true,
        securityRetainedThroughClose: true,
        observedOpen: true,
        securityObservedOpen: true,
        cancelled: true,
        securityCancelled: true,
        observedCancelled: true,
        securityObservedCancelled: true,
      },
      positionQuantityAfterEntry: 0.01,
      positionQuantityAfterAccumulation: 0.02,
      positionQuantityAfterClose: 0,
      flatAfter: true,
    }))

    const audit = auditVstSoakExecutionRelations({ cycles })
    expect(audit).toMatchObject({
      success: true,
      uniqueOrderIds: true,
      partialFillsObserved: 0,
      totals: { exposureOrders: 8, closeOrders: 4, protectionOrders: 12 },
    })
    expect(audit.mismatches).toEqual([])
  })

  test("detects broken partial-fill, position, protection, and duplicate-ID relations", () => {
    const audit = auditVstSoakExecutionRelations({
      expectedTradePaths: ["direct-trade"],
      cycles: [{
        symbol: "BTCUSDT",
        direction: "long",
        tradePath: "direct-trade",
        quantityStep: 0.001,
        priceTick: 0.1,
        entry: { orderId: "duplicate", submittedQuantity: 0.02, filledQuantity: 0.01, filledPrice: 100, status: "FILLED" },
        accumulation: { orderId: "duplicate", submittedQuantity: 0.01, filledQuantity: 0.01, filledPrice: 100, status: "NEW" },
        close: { orderId: "close", submittedQuantity: 0.02, filledQuantity: 0.01, filledPrice: 100, status: "FILLED" },
        protection: { orderId: "stop", observedOpen: true, cancelled: false, observedCancelled: false },
        positionQuantityAfterEntry: 0.02,
        positionQuantityAfterAccumulation: 0.04,
        positionQuantityAfterClose: 0.01,
        flatAfter: false,
      }],
    })
    expect(audit.success).toBe(false)
    expect(audit.partialFillsObserved).toBe(2)
    expect(audit.uniqueOrderIds).toBe(false)
    expect(audit.mismatches).toEqual(expect.arrayContaining([
      expect.stringContaining("protection"),
      expect.stringContaining("entry relation"),
      expect.stringContaining("accumulation relation"),
      expect.stringContaining("close relation"),
      expect.stringContaining("final relation"),
      expect.stringContaining("not unique"),
    ]))
  })

  test("rejects a tick-aligned security stop that is not the required 10% row range farther", () => {
    const audit = auditVstSoakExecutionRelations({
      expectedTradePaths: ["main-trade"],
      cycles: [{
        symbol: "BTCUSDT",
        direction: "long",
        tradePath: "main-trade",
        quantityStep: 0.001,
        priceTick: 0.1,
        entry: { orderId: "entry", submittedQuantity: 0.01, filledQuantity: 0.01, filledPrice: 100, status: "FILLED" },
        accumulation: { orderId: "acc", submittedQuantity: 0.01, filledQuantity: 0.01, filledPrice: 100, status: "FILLED" },
        close: { orderId: "close", submittedQuantity: 0.02, filledQuantity: 0.02, filledPrice: 100, status: "FILLED" },
        protection: {
          orderId: "stop",
          takeProfitOrderId: "tp",
          securityStopOrderId: "security",
          requireTakeProfit: true,
          requireSecurity: true,
          stopPrice: 95,
          takeProfitPrice: 105,
          securityStopPrice: 94.9,
          stopLossQuantity: 0.02,
          takeProfitQuantity: 0.02,
          securityStopArmedQuantity: 0.02,
          securityQuantityBacked: true,
          securityRetainedThroughClose: true,
          observedOpen: true,
          securityObservedOpen: true,
          cancelled: true,
          securityCancelled: true,
          observedCancelled: true,
          securityObservedCancelled: true,
        },
        positionQuantityAfterEntry: 0.01,
        positionQuantityAfterAccumulation: 0.02,
        positionQuantityAfterClose: 0,
        flatAfter: true,
      }],
    })

    expect(audit.success).toBe(false)
    expect(audit.mismatches).toEqual(expect.arrayContaining([
      expect.stringContaining("requiredSecurityGap=0.5"),
    ]))
  })

  test("fails closed instead of silently defaulting a completed cycle to Long", () => {
    expect(() => auditVstSoakCounters({
      before: normalizeVstSoakCounterSnapshot({}),
      after: normalizeVstSoakCounterSnapshot({}),
      cycles: [{
        symbol: "BTCUSDT",
        direction: "" as "long",
        entryVolumeUsd: 1,
        accumulationVolumeUsd: 1,
      }],
    })).toThrow("requires one effective direction")
  })
})
