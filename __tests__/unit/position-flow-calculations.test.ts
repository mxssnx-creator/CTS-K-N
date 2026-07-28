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
    expect(calculatePositionCostRelativeAverageRatio([
      { profit_loss: 0.3 },
      { profit_loss: 0.1 },
      { profit_loss: -0.1 },
    ], 0.1)).toBeCloseTo(0.1)
    expect(calculatePositionCostRelativeAverageRatio([
      { profit_loss: 1.12 },
      { profit_loss: 1.12 },
    ], 0.1)).toBeCloseTo(1.12)
  })
})
