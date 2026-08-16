import {
  calculatePositionCostRelativeAverageRatio,
  calculatePositionProtectionPrices,
} from "@/lib/position-flow-coordinator"

describe("position-flow protection calculations", () => {
  test("long TP is above entry and SL is below entry", () => {
    expect(calculatePositionProtectionPrices({
      entry_price: 100,
      direction: "long",
      takeprofit_factor: 3,
      stoploss_ratio: 1.5,
    })).toEqual({ takeprofit: 103, stoploss: 98.5 })
  })

  test("short TP is below entry and SL is above entry", () => {
    const protection = calculatePositionProtectionPrices({
      entry_price: 100,
      direction: "short",
      takeprofit_factor: 3,
      stoploss_ratio: 1.5,
    })
    expect(protection.takeprofit).toBeCloseTo(97)
    expect(protection.stoploss).toBeCloseTo(101.5)
  })

  test("uses the PositionCost-relative ratio instead of classic gross PF", () => {
    // Each position's raw pnl% move is converted to the ratio scale (neutral
    // 1.00, +0.10 per PositionCost of positive move) via movePctToMainTradePfRatio
    // before averaging, since callers compare the result directly against a
    // MainTradeStage ratio setting (e.g. stageSettings.realRatio).
    // cost=0.1: 0.3% -> 1.30, 0.1% -> 1.10, -0.1% -> 0.90; avg = 1.10
    expect(calculatePositionCostRelativeAverageRatio([
      { profit_loss: 0.3 },
      { profit_loss: 0.1 },
      { profit_loss: -0.1 },
    ], 0.1)).toBeCloseTo(1.1)
    // cost=0.1: 1.12% -> 1.0 + (1.12/0.1)*0.1 = 2.12; avg of two equal values = 2.12
    expect(calculatePositionCostRelativeAverageRatio([
      { profit_loss: 1.12 },
      { profit_loss: 1.12 },
    ], 0.1)).toBeCloseTo(2.12)
  })
})
