import {
  ADJUST_POSITION_DIFFERENCE_RATIO_STEP,
  buildRealStagePositionStats,
  inferRealStrategyVariant,
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

  test("combines confirmed variants, related-Base hedge netting, and symbol directions", () => {
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
    })

    expect(result.overall).toMatchObject({
      positions: 10,
      positionsWithHedge: 4,
      hedgeReducedPositions: 6,
      hedgedPairs: 3,
      longPositions: 5,
      shortPositions: 5,
      hedgeOffsetRatio: 0.6,
      hedgeOffsetPercent: 60,
      positionCountSource: "confirmed-ledger",
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
    expect(result.symbols).toEqual([
      {
        symbol: "BTCUSDT",
        longPositions: 4,
        shortPositions: 2,
        grossPositions: 6,
        positionsWithHedge: 2,
        hedgedPairs: 2,
        unclassifiedPositions: 0,
      },
      {
        symbol: "ETHUSDT",
        longPositions: 1,
        shortPositions: 3,
        grossPositions: 4,
        positionsWithHedge: 2,
        hedgedPairs: 1,
        unclassifiedPositions: 0,
      },
    ])
  })

  test("never offsets unrelated Base strategies even when their global directions match", () => {
    const result = buildRealStagePositionStats({
      validPositionsHash: { overall: "10" },
      hedgePosAccHash: {
        "BTCUSDT:direction:long": "5",
        "BTCUSDT:direction:short": "0",
        "BTCUSDT:move:long": "0",
        "BTCUSDT:move:short": "5",
      },
    })

    expect(result.overall.positions).toBe(10)
    expect(result.overall.positionsWithHedge).toBe(10)
    expect(result.overall.hedgeReducedPositions).toBe(0)
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
      positionsWithHedge: 12,
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
})
