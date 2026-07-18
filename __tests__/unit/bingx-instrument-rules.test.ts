import {
  getMinimumBingXSmokeQuantity,
  normalizeBingXSymbol,
  parseBingXInstrumentRules,
  roundQuantityUp,
} from "@/lib/bingx-instrument-rules"

describe("BingX instrument rules", () => {
  const payload = {
    code: 0,
    data: [{
      symbol: "XRP-USDT",
      quantityPrecision: 1,
      pricePrecision: 4,
      tradeMinQuantity: "0.1",
      tradeMinUSDT: "2",
      status: "1",
    }],
  }

  test("normalizes exchange symbols and venue limits", () => {
    expect(normalizeBingXSymbol("xrp-usdt")).toBe("XRPUSDT")
    expect(parseBingXInstrumentRules(payload, "XRPUSDT")).toEqual({
      symbol: "XRPUSDT",
      exchangeSymbol: "XRP-USDT",
      quantityPrecision: 1,
      pricePrecision: 4,
      quantityStep: 0.1,
      minQuantity: 0.1,
      minNotionalUsdt: 2,
      status: "1",
    })
  })

  test("rounds upward and keeps the smoke above venue notional", () => {
    const rules = parseBingXInstrumentRules(payload, "XRPUSDT")
    expect(roundQuantityUp(1.01, rules)).toBe(1.1)
    const minimum = getMinimumBingXSmokeQuantity(rules, 0.5)
    expect(minimum.quantity).toBe(4.1)
    expect(minimum.notionalUsdt).toBeCloseTo(2.05)
  })

  test("fails closed for unknown instruments", () => {
    expect(() => parseBingXInstrumentRules(payload, "BTCUSDT")).toThrow("not found")
  })
})
