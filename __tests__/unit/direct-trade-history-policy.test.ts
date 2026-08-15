const historyPolicy = require("@/lib/direct-trade-history-policy.cjs")
import { DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT } from "@/lib/direct-trade-coordination"

describe("Direct-Trade bounded historic sufficiency", () => {
  const complete = {
    symbols: Array.from({ length: 8 }, (_, index) => `S${index}USDT`),
    validSets: 40,
    eligibleSymbolCount: 5,
    eligibleSymbolDirectionsByDirection: { long: 3, short: 3 },
    byDirection: { long: { valid: 20 }, short: { valid: 20 } },
    byStrategyType: {
      standard: { valid: 10 },
      trailing_fixed: { valid: 10 },
      dca: { valid: 2 },
    },
  }

  test("keeps a sufficient baseline without expanding it", () => {
    expect(historyPolicy.assessDirectTradeHistorySufficiency({
      summary: complete,
      configuredStrategyTypes: ["standard", "trailing_fixed", "dca"],
      requestedHistoryHours: 48,
      currentHistoryHours: 48,
    })).toMatchObject({
      sufficient: true,
      canProceed: true,
      expanded: false,
      nextHistoryHours: 48,
      reasons: [],
    })
  })

  test("expands once to the bounded maximum when samples or coverage are insufficient", () => {
    const result = historyPolicy.assessDirectTradeHistorySufficiency({
      summary: {
        ...complete,
        validSets: 3,
        eligibleSymbolCount: 1,
        eligibleSymbolDirectionsByDirection: { long: 1, short: 0 },
        byStrategyType: { standard: { valid: 3 }, trailing_fixed: { valid: 0 }, dca: { valid: 0 } },
      },
      configuredStrategyTypes: ["standard", "trailing_fixed", "dca"],
      requestedHistoryHours: 48,
      currentHistoryHours: 48,
    })

    expect(result).toMatchObject({
      sufficient: false,
      canProceed: false,
      atMaximum: false,
      nextHistoryHours: 90,
    })
    expect(result.reasons).toEqual(expect.arrayContaining([
      "valid_sets:3<16",
      "eligible_symbols:1<4",
      "short_symbol_coverage:0<2",
      "strategy_type:trailing_fixed:0",
      "strategy_type:dca:0",
    ]))
  })

  test("fails closed at the maximum without looping or weakening gates", () => {
    const result = historyPolicy.assessDirectTradeHistorySufficiency({
      summary: { symbols: ["BTCUSDT"], validSets: 0, byDirection: {}, byStrategyType: {} },
      configuredStrategyTypes: ["standard"],
      requestedHistoryHours: 48,
      currentHistoryHours: 90,
    })
    expect(result).toMatchObject({
      sufficient: false,
      atMaximum: true,
      canProceed: true,
      nextHistoryHours: 90,
    })
    expect(result.reasons).toEqual(expect.arrayContaining([
      "valid_sets:0<8",
      "long_valid_sets:0",
      "short_valid_sets:0",
      "strategy_type:standard:0",
    ]))
  })

  test("clamps malformed or excessive requested ranges", () => {
    expect(historyPolicy.clampDirectTradeHistoryHours(0)).toBe(1)
    expect(historyPolicy.clampDirectTradeHistoryHours(500)).toBe(90)
    expect(historyPolicy.clampDirectTradeHistoryHours("bad", 48)).toBe(48)
  })

  test("keeps the processor and calculation full-history PF default at 4", () => {
    expect(historyPolicy.DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT).toBe(4)
    expect(DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT).toBe(4)
  })
})
