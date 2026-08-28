import {
  absoluteStopLoss,
  absoluteTakeProfit,
  positionMargin,
  positionPnl,
  positionQuantity,
  positionTrailingDistancePercent,
} from "@/components/live-trading/live-trading-format"

describe("live trading protection display values", () => {
  test("converts stored trailing ratios to operator percentages", () => {
    expect(positionTrailingDistancePercent({
      id: "row",
      symbol: "BTCUSDT",
      trailingProfile: { stopRatio: 0.005 },
    })).toBe(0.5)
  })

  test("keeps an explicit operator percentage authoritative", () => {
    expect(positionTrailingDistancePercent({
      id: "row",
      symbol: "BTCUSDT",
      trailingProfile: { stopRatio: 0.005 },
      manualProtectionOverride: { trailingDistancePct: 0.75 },
    })).toBe(0.75)
  })

  test("null manual values restore the persisted row SL and TP instead of hiding them", () => {
    const position = {
      id: "row",
      symbol: "ETHUSDT",
      stopLossPrice: 98,
      takeProfitPrice: 104,
      manualProtectionOverride: {
        stopLossPrice: null,
        takeProfitPrice: null,
      },
    }
    expect(absoluteStopLoss(position)).toBe(98)
    expect(absoluteTakeProfit(position)).toBe(104)
  })

  test("shows confirmed quantity, never an unfilled requested size", () => {
    const pending = {
      id: "pending-row",
      symbol: "BTCUSDT",
      status: "pending",
      quantity: 10,
      unrealizedPnL: -99,
      exchangeData: { marginUsd: 50 },
    }
    expect(positionQuantity(pending)).toBe(0)
    expect(positionPnl(pending)).toBe(0)
    expect(positionMargin(pending)).toBe(0)
    expect(positionQuantity({
      id: "partial-row",
      symbol: "BTCUSDT",
      status: "partially_filled",
      quantity: 10,
      executedQuantity: 2,
    })).toBe(2)
  })

  test("shows the DCA-rebased target before the original strategy percentage", () => {
    expect(absoluteTakeProfit({
      id: "dca-row",
      symbol: "ETHUSDT",
      direction: "long",
      averageExecutionPrice: 100,
      takeProfit: 5,
      dcaTakeProfitPrice: 102,
    })).toBe(102)
  })
})
