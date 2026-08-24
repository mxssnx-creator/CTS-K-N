import {
  clampDirectTradeVolumeFactor,
  DIRECT_TRADE_BASE_NOTIONAL_PER_FACTOR_USDT,
  DIRECT_TRADE_EFFECTIVE_VOLUME_RATIO,
  DIRECT_TRADE_VOLUME_FACTOR_DEFAULT,
  DIRECT_TRADE_VOLUME_FACTOR_MAX,
  DIRECT_TRADE_VOLUME_FACTOR_MIN,
} from "@/lib/direct-trade-limits"

describe("Direct-Trade volume factor contract", () => {
  test("uses the minimal default and clamps the slider boundaries", () => {
    expect(DIRECT_TRADE_VOLUME_FACTOR_DEFAULT).toBe(0.1)
    expect(clampDirectTradeVolumeFactor(undefined)).toBe(DIRECT_TRADE_VOLUME_FACTOR_MIN)
    expect(clampDirectTradeVolumeFactor(-4)).toBe(DIRECT_TRADE_VOLUME_FACTOR_MIN)
    expect(clampDirectTradeVolumeFactor(10)).toBe(DIRECT_TRADE_VOLUME_FACTOR_MAX)
    expect(clampDirectTradeVolumeFactor(99)).toBe(DIRECT_TRADE_VOLUME_FACTOR_MAX)
    expect(clampDirectTradeVolumeFactor(1.26)).toBe(1.3)
  })

  test("applies the five-times-lower effective volume ratio before exchange floors", () => {
    const requestedBaseNotional = DIRECT_TRADE_VOLUME_FACTOR_DEFAULT * DIRECT_TRADE_BASE_NOTIONAL_PER_FACTOR_USDT * DIRECT_TRADE_EFFECTIVE_VOLUME_RATIO
    expect(requestedBaseNotional).toBe(0.1)
    const previousFactorOneNotional = DIRECT_TRADE_BASE_NOTIONAL_PER_FACTOR_USDT
    const effectiveFactorOneNotional = DIRECT_TRADE_BASE_NOTIONAL_PER_FACTOR_USDT * DIRECT_TRADE_EFFECTIVE_VOLUME_RATIO
    expect(effectiveFactorOneNotional).toBe(previousFactorOneNotional * 0.2)
    // The factor is only the requested base amount. Live order normalization
    // applies venue quantity/notional floors after this calculation.
    expect(clampDirectTradeVolumeFactor(0.1)).toBe(0.1)
  })
})
