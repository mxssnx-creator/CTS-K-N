import {
  CANONICAL_FORCED_BASE_SYMBOLS,
  CANONICAL_FORCED_SYMBOLS,
  canonicalForcedBaseSymbols,
  canonicalForcedSymbols,
  withCanonicalForcedSymbols,
} from "@/lib/forced-symbols"
import {
  DEFAULT_SYMBOL_COUNT,
  getExplicitLocalSymbolCap,
} from "@/lib/symbol-selection-defaults"

describe("canonical mandatory symbol basket", () => {
  test("is exact, stable and returned through defensive copies", () => {
    expect(CANONICAL_FORCED_BASE_SYMBOLS).toEqual(["BTC", "SOL", "BCH", "XRP"])
    expect(CANONICAL_FORCED_SYMBOLS).toEqual(["BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT"])
    expect(canonicalForcedBaseSymbols()).toEqual(CANONICAL_FORCED_BASE_SYMBOLS)
    expect(canonicalForcedSymbols()).toEqual(CANONICAL_FORCED_SYMBOLS)
    expect(canonicalForcedSymbols()).not.toBe(CANONICAL_FORCED_SYMBOLS)
  })

  test("normalizes aliases, deduplicates, puts mandatory symbols first and retains extras", () => {
    expect(withCanonicalForcedSymbols([
      "eth/usdt",
      "btc-usdt",
      " sol ",
      "ETHUSDT",
      "invalid symbol!",
    ])).toEqual([
      "BTCUSDT",
      "SOLUSDT",
      "BCHUSDT",
      "XRPUSDT",
      "ETHUSDT",
    ])
  })

  test("CPU or local caps can trim extras but never the mandatory quartet", () => {
    const requested = ["ETHUSDT", "DOGEUSDT", "LINKUSDT"]
    expect(withCanonicalForcedSymbols(requested, 1)).toEqual(CANONICAL_FORCED_SYMBOLS)
    expect(withCanonicalForcedSymbols(requested, 5)).toEqual([
      ...CANONICAL_FORCED_SYMBOLS,
      "ETHUSDT",
    ])
    expect(DEFAULT_SYMBOL_COUNT).toBe(4)
    expect(getExplicitLocalSymbolCap({ NODE_ENV: "development", V0_DEV_SYMBOL_COUNT: "1" })).toBe(4)
    expect(getExplicitLocalSymbolCap({ NODE_ENV: "production", V0_DEV_SYMBOL_COUNT: "9" })).toBe(9)
  })
})
