import { canonicalSymbolCount, resolveCanonicalSymbols } from "@/lib/connection-symbols"

describe("canonical connection symbol resolution", () => {
  test("prefers the active runtime basket over a stale scalar count", () => {
    const result = canonicalSymbolCount(
      536,
      { symbol_count: "536" },
      { active_symbols: JSON.stringify(Array.from({ length: 80 }, (_, i) => `S${i}`)) },
    )

    expect(result).toEqual({ count: 80, source: "active_symbols" })
  })

  test("does not let a legacy exchange catalog hide the active basket", () => {
    const result = resolveCanonicalSymbols(
      { symbols: JSON.stringify(Array.from({ length: 536 }, (_, i) => `CATALOG${i}`)) },
      { active_symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"] },
    )

    expect(result).toEqual({
      count: 4,
      source: "active_symbols",
      symbols: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"],
    })
  })

  test("uses the first non-empty authoritative field and de-duplicates symbols", () => {
    expect(resolveCanonicalSymbols(
      { force_symbols: "" },
      { selected_symbols: ["eurusd", "EURUSD", "gbpusd"] },
    )).toEqual({
      count: 2,
      source: "selected_symbols",
      symbols: ["EURUSD", "GBPUSD"],
    })
  })

  test("falls back to a positive scalar only when no basket exists", () => {
    expect(canonicalSymbolCount("536", { symbols: "" })).toEqual({
      count: 536,
      source: "scalar_fallback",
    })
  })
})
