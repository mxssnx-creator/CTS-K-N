import { normalizeSymbolAliasesInPatch } from "@/lib/connection-symbol-aliases"

const mandatory = ["BTCUSDT", "SOLUSDT", "BCHUSDT", "XRPUSDT"]
const extras = Array.from({ length: 28 }, (_, index) => `ALT${index + 1}USDT`)

describe("connection symbol alias normalization", () => {
  test("force symbols outrank a stale selected-symbol mirror at the 32-symbol ceiling", () => {
    const force = [...mandatory, ...extras]
    const staleSelected = [...mandatory, "ACEUSDT", "COWUSDT", "AKEUSDT"]
    const normalized = normalizeSymbolAliasesInPatch({
      force_symbols: JSON.stringify(force),
      selected_symbols: JSON.stringify(staleSelected),
      active_symbols: JSON.stringify(force),
      symbols: JSON.stringify(force),
      symbol_count: "32",
    }, { marketType: "crypto" })

    for (const field of ["force_symbols", "selected_symbols", "active_symbols", "symbols"]) {
      expect(JSON.parse(String(normalized[field]))).toEqual(force)
    }
    expect(normalized.symbol_count).toBe("32")
  })

  test("mandatory symbols stay inside, rather than above, the requested maximum", () => {
    const operatorSelection = Array.from({ length: 32 }, (_, index) => `VOL${index + 1}USDT`)
    const normalized = normalizeSymbolAliasesInPatch({
      force_symbols: operatorSelection,
      symbol_count: 32,
    }, { marketType: "crypto" })
    const symbols = JSON.parse(String(normalized.force_symbols))

    expect(symbols).toHaveLength(32)
    expect(symbols.slice(0, 4)).toEqual(mandatory)
  })

  test("an explicit automatic-selection clear cannot resurrect another stale alias", () => {
    const normalized = normalizeSymbolAliasesInPatch({
      force_symbols: "",
      selected_symbols: JSON.stringify([...mandatory, "STALEUSDT"]),
      symbol_count: "32",
    })

    expect(normalized).toMatchObject({
      force_symbols: "",
      selected_symbols: "",
      active_symbols: "",
      symbols: "",
      symbol_count: "32",
    })
  })

  test("keeps InstaForex pairs canonical without adding crypto quote assets", () => {
    const normalized = normalizeSymbolAliasesInPatch({
      force_symbols: ["eur/usd.fx", "USDJPY", "eur/usd.fx"],
      selected_symbols: ["STALEUSDT"],
      symbol_count: 8,
    }, { exchange: "instaforex" })

    for (const field of ["force_symbols", "selected_symbols", "active_symbols", "symbols"]) {
      expect(JSON.parse(String(normalized[field]))).toEqual(["EURUSD", "USDJPY"])
    }
    expect(normalized.symbol_count).toBe("2")
  })
})
