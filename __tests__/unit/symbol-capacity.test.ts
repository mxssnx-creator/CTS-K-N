import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { DIRECT_TRADE_MAX_SYMBOLS, clampDirectTradeSymbolCount } from "@/lib/direct-trade-limits"
import { QUICKSTART_UI_MAX_SYMBOLS } from "@/lib/quickstart-timeouts"
import {
  EXCHANGE_SYMBOL_COUNT_MAX,
  HIGH_SCALE_SYMBOL_STRESS_TARGET,
  clampExchangeSymbolCount,
  isHighScaleSymbolCount,
  sameSymbolSet,
  summarizeSymbols,
} from "@/lib/symbol-capacity"

describe("exchange-wide symbol capacity", () => {
  test("shares one bounded 1,000-symbol contract across QuickStart and Direct Trade", () => {
    expect(EXCHANGE_SYMBOL_COUNT_MAX).toBe(1_000)
    expect(HIGH_SCALE_SYMBOL_STRESS_TARGET).toBeGreaterThan(100)
    expect(QUICKSTART_UI_MAX_SYMBOLS).toBe(EXCHANGE_SYMBOL_COUNT_MAX)
    expect(DIRECT_TRADE_MAX_SYMBOLS).toBe(EXCHANGE_SYMBOL_COUNT_MAX)

    expect(clampExchangeSymbolCount(128.9)).toBe(128)
    expect(clampExchangeSymbolCount(10_000)).toBe(1_000)
    expect(clampExchangeSymbolCount("invalid", 17)).toBe(17)
    expect(clampDirectTradeSymbolCount(0)).toBe(4)
    expect(clampDirectTradeSymbolCount(10_000)).toBe(1_000)
  })

  test("classifies the high-scale reference and summarizes long baskets without duplicates", () => {
    expect(isHighScaleSymbolCount(99)).toBe(false)
    expect(isHighScaleSymbolCount(100)).toBe(true)
    expect(isHighScaleSymbolCount(HIGH_SCALE_SYMBOL_STRESS_TARGET)).toBe(true)
    expect(summarizeSymbols(["A", "B", "A", "C", "D"], 2)).toBe("A, B … +2")
    expect(sameSymbolSet(["BTCUSDT", "ETHUSDT"], ["ETHUSDT", "BTCUSDT"])).toBe(true)
    expect(sameSymbolSet(["BTCUSDT", "BTCUSDT"], ["BTCUSDT", "BTCUSDT"])).toBe(false)
  })

  test("removes the legacy 50-symbol settings endpoint cap", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/api/settings/connections/[id]/symbols/route.ts"),
      "utf8",
    )
    expect(source).toContain("clampExchangeSymbolCount(")
    expect(source).not.toContain("Math.min(50")
  })
})
