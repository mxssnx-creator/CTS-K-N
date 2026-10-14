import { allowedStopLossPrice } from "@/lib/protection-allowed-range"

/**
 * "Allowed SL distance automatically": the stop is placed at the nearest
 * price the venue accepts — off the mark on the protective side, inside the
 * liquidation price, on the tick — instead of being rejected.
 */
describe("allowedStopLossPrice", () => {
  test("a stop inside the allowed range stays exactly as derived", () => {
    expect(allowedStopLossPrice({ direction: "long", entryPrice: 100, stopPrice: 99.4, markPrice: 100.2, liquidationPrice: 80, priceTick: 0.01 }))
      .toEqual({ stopPrice: 99.4, adjusted: false, reason: "within_range" })
  })

  test("a long stop too close to the mark moves away from it by the required ticks", () => {
    expect(allowedStopLossPrice({ direction: "long", entryPrice: 100, stopPrice: 99.4, markPrice: 99.41, liquidationPrice: 80, priceTick: 0.01 }))
      .toEqual({ stopPrice: 99.39, adjusted: true, reason: "mark_distance" })
  })

  test("a short stop too close to the mark moves above it", () => {
    expect(allowedStopLossPrice({ direction: "short", entryPrice: 100, stopPrice: 100.6, markPrice: 100.6, liquidationPrice: 120, priceTick: 0.01 }).reason)
      .toBe("crossed")
    expect(allowedStopLossPrice({ direction: "short", entryPrice: 100, stopPrice: 100.6, markPrice: 100.595, liquidationPrice: 120, priceTick: 0.01 }))
      .toEqual({ stopPrice: 100.62, adjusted: true, reason: "mark_distance" })
  })

  test("a stop beyond the liquidation price is pulled inside it with a safety gap", () => {
    // Liquidation 99.5 at high leverage: gap = max(2 ticks, 10 % of 0.5) = 0.05.
    expect(allowedStopLossPrice({ direction: "long", entryPrice: 100, stopPrice: 99.4, markPrice: 100, liquidationPrice: 99.5, priceTick: 0.01 }))
      .toEqual({ stopPrice: 99.55, adjusted: true, reason: "liquidation" })
    expect(allowedStopLossPrice({ direction: "short", entryPrice: 100, stopPrice: 100.6, markPrice: 100, liquidationPrice: 100.5, priceTick: 0.01 }))
      .toEqual({ stopPrice: 100.45, adjusted: true, reason: "liquidation" })
  })

  test("a crossed stop is left to the caller's close", () => {
    expect(allowedStopLossPrice({ direction: "long", entryPrice: 100, stopPrice: 99.4, markPrice: 99.3, priceTick: 0.01 }))
      .toEqual({ stopPrice: 99.4, adjusted: false, reason: "crossed" })
  })

  test("no room between liquidation and mark is reported, not invented", () => {
    expect(allowedStopLossPrice({ direction: "long", entryPrice: 100, stopPrice: 99.4, markPrice: 99.56, liquidationPrice: 99.5, priceTick: 0.01 }))
      .toEqual({ stopPrice: 99.4, adjusted: false, reason: "unsatisfiable" })
  })

  test("more required ticks widen the distance to the mark", () => {
    expect(allowedStopLossPrice({ direction: "long", entryPrice: 100, stopPrice: 99.4, markPrice: 99.45, priceTick: 0.01, minMarkTicks: 10 }))
      .toEqual({ stopPrice: 99.35, adjusted: true, reason: "mark_distance" })
  })

  test("invalid input is returned untouched", () => {
    expect(allowedStopLossPrice({ direction: "long", entryPrice: 0, stopPrice: 99.4 }).reason).toBe("invalid")
  })
})
