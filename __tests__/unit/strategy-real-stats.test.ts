import {
  ADJUST_POSITION_DIFFERENCE_RATIO_STEP,
  buildRealStagePositionStats,
  inferRealStrategyVariant,
  isOpenLiveExposureStatus,
} from "@/lib/strategy-real-stats"

describe("Strategy Stage Real detailed position stats", () => {
  test.each([
    ["BTCUSDT:direction:long#default", "default"],
    ["BTCUSDT:direction:long:t30-10#axis:p4", "trailing"],
    ["BTCUSDT:direction:long:t30-10#block:active:2", "block"],
    ["ETHUSDT:trend:short#dca", "dca"],
  ])("infers %s as %s", (setKey, expected) => {
    expect(inferRealStrategyVariant(setKey)).toBe(expected)
  })

  test("keeps full Overall counts while exposing hedge and current open directions separately", () => {
    const result = buildRealStagePositionStats({
      validPositionsHash: {
        overall: "10",
        "by_symbol:BTCUSDT": "6",
        "by_symbol:ETHUSDT": "4",
        "by_variant:default": "4",
        "by_variant:trailing": "2",
        "by_variant:block": "3",
        "by_variant:dca": "1",
      },
      hedgePosAccHash: {
        "BTCUSDT:direction:long:long": "3",
        "BTCUSDT:direction:long:short": "1",
        "BTCUSDT:direction:long:sets_long": "3",
        "BTCUSDT:direction:long:sets_short": "1",
        "BTCUSDT:direction:long:ts": "100",
        "BTCUSDT:move:long": "1",
        "BTCUSDT:move:short": "1",
        "ETHUSDT:trend:long": "1",
        "ETHUSDT:trend:short": "3",
      },
      strategyVariants: {
        default: { createdSets: 4, passedSets: 4, entriesCount: 400, avgProfitFactor: 1.5, avgDrawdownTime: 8 },
        trailing: { createdSets: 2, passedSets: 2, entriesCount: 200, avgProfitFactor: 1.7, avgDrawdownTime: 6 },
        block: { createdSets: 3, passedSets: 3, entriesCount: 300, avgProfitFactor: 1.8, avgDrawdownTime: 5 },
        dca: { createdSets: 1, passedSets: 1, entriesCount: 100, avgProfitFactor: 1.6, avgDrawdownTime: 7 },
        overall: { entriesCount: 1_000 },
      },
      overallSets: 12,
      overallOrders: 8,
      openPositions: {
        source: "live-exchange",
        bySymbol: [
          { symbol: "BTCUSDT", long: 2, short: 1 },
          { symbol: "ETHUSDT", long: 0, short: 3 },
        ],
      },
    })

    expect(result.overall).toMatchObject({
      sets: 12,
      positions: 10,
      orders: 8,
      positionCountSource: "confirmed-ledger",
    })
    expect(result.overall).not.toHaveProperty("positionsWithHedge")
    expect(result.openPositions).toEqual({
      positions: 6,
      symbolCount: 2,
      longPositions: 2,
      shortPositions: 4,
      longSymbolCount: 1,
      shortSymbolCount: 2,
      source: "live-exchange",
      bySymbol: [
        { symbol: "BTCUSDT", longPositions: 2, shortPositions: 1, positions: 3 },
        { symbol: "ETHUSDT", longPositions: 0, shortPositions: 3, positions: 3 },
      ],
    })
    expect(result.hedge).toMatchObject({
      grossPositions: 10,
      remainingPositions: 4,
      offsetPositionLegs: 6,
      hedgedPairs: 3,
      hedgeOffsetRatio: 0.6,
      hedgeOffsetPercent: 60,
    })
    expect(result.strategyTypes.default.positions).toBe(4)
    expect(result.strategyTypes.trailing.positions).toBe(2)
    expect(result.adjustTypes.block).toMatchObject({
      positions: 3,
      withoutStrategyPositions: 6,
      withStrategyPositions: 9,
      positionDifference: 3,
      differenceRatio: 0.5,
      differencePercent: 50,
      ratioStep: ADJUST_POSITION_DIFFERENCE_RATIO_STEP,
      ratioLevel: 0.6,
    })
    expect(result.adjustTypes.dca).toMatchObject({
      positions: 1,
      withoutStrategyPositions: 6,
      withStrategyPositions: 7,
      differenceRatio: 0.167,
      differencePercent: 16.7,
      ratioLevel: 0.2,
    })
  })

  test("never offsets unrelated Base strategies even when their global directions match", () => {
    const result = buildRealStagePositionStats({
      validPositionsHash: { overall: "4" },
      hedgePosAccHash: {
        "BTCUSDT:direction:long": "5",
        "BTCUSDT:direction:short": "0",
        "BTCUSDT:move:long": "0",
        "BTCUSDT:move:short": "5",
      },
    })

    // The independent hedge ledger can be larger than the Overall position
    // ledger, but must never inflate or reduce Overall.
    expect(result.overall.positions).toBe(4)
    expect(result.hedge.remainingPositions).toBe(10)
    expect(result.hedge.offsetPositionLegs).toBe(0)
  })

  test("uses evaluation counts only for pre-ledger variant history", () => {
    const result = buildRealStagePositionStats({
      strategyVariants: {
        default: { entriesCount: 8 },
        trailing: { entriesCount: 2 },
        block: { entriesCount: 2 },
        dca: { entriesCount: 0 },
        overall: { entriesCount: 12 },
      },
    })

    expect(result.overall).toMatchObject({
      positions: 12,
      positionCountSource: "evaluation-fallback",
    })
    expect(result.strategyTypes.default).toMatchObject({
      positions: 8,
      positionCountSource: "evaluation-fallback",
    })
    expect(result.adjustTypes.block.differenceRatio).toBe(0.2)
    expect(result.adjustTypes.block.ratioLevel).toBe(0.2)
  })

  test("does not present a partially rolled-out variant ledger as complete", () => {
    const result = buildRealStagePositionStats({
      validPositionsHash: {
        overall: "10",
        "by_variant:default": "1",
      },
      strategyVariants: {
        default: { entriesCount: 6 },
        trailing: { entriesCount: 2 },
        block: { entriesCount: 2 },
        dca: { entriesCount: 0 },
        overall: { entriesCount: 10 },
      },
    })

    expect(result.strategyTypes.default).toMatchObject({
      positions: 6,
      positionCountSource: "evaluation-fallback",
    })
  })

  test("aggregates only the supplied current snapshot by unique symbol and direction", () => {
    const result = buildRealStagePositionStats({
      validPositionsHash: { overall: "99" },
      openPositions: {
        source: "real-stage",
        bySymbol: [
          { symbol: " btcusdt ", long: 1, short: 0 },
          { symbol: "BTCUSDT", longPositions: 2, shortPositions: 1 },
          { symbol: "ETHUSDT", long: 0, short: 2 },
          { symbol: "", long: 100, short: 100 },
        ],
      },
    })

    expect(result.overall.positions).toBe(99)
    expect(result.openPositions).toMatchObject({
      positions: 6,
      symbolCount: 2,
      longPositions: 3,
      shortPositions: 3,
      longSymbolCount: 1,
      shortSymbolCount: 2,
      source: "real-stage",
    })
    expect(result.openPositions.bySymbol[0]).toEqual({
      symbol: "BTCUSDT",
      longPositions: 3,
      shortPositions: 1,
      positions: 4,
    })
  })

  test.each([
    ["open", true],
    ["filled", true],
    ["partially_filled", true],
    ["simulated", true],
    ["closing", true],
    ["closing_partial", true],
    ["pending", false],
    ["pending_fill", false],
    ["placed", false],
    ["placed_unconfirmed", false],
    ["rejected", false],
    ["closed", false],
  ])("classifies %s as open exposure=%s", (status, expected) => {
    expect(isOpenLiveExposureStatus(status)).toBe(expected)
  })
})
