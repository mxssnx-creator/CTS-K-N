import { resolvePrehistoricConfigLimit, selectBalancedConfigs } from "@/lib/trade-engine/balanced-config-selection"

describe("balanced prehistoric config selection", () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test("round-robins types instead of letting insertion order monopolise the budget", () => {
    const configs = [
      ...Array.from({ length: 20 }, (_, id) => ({ type: "SMA", id: `sma-${id}` })),
      ...Array.from({ length: 20 }, (_, id) => ({ type: "EMA", id: `ema-${id}` })),
      ...Array.from({ length: 20 }, (_, id) => ({ type: "RSI", id: `rsi-${id}` })),
      ...Array.from({ length: 20 }, (_, id) => ({ type: "MACD", id: `macd-${id}` })),
    ]

    const selected = selectBalancedConfigs(configs, 32)
    expect(selected).toHaveLength(32)
    expect(Object.fromEntries(
      ["SMA", "EMA", "RSI", "MACD"].map((type) => [type, selected.filter((config) => config.type === type).length]),
    )).toEqual({ SMA: 8, EMA: 8, RSI: 8, MACD: 8 })
  })

  test("uses a bounded default and honours domain override", () => {
    delete process.env.PREHISTORIC_CONFIG_LIMIT
    delete process.env.PREHISTORIC_INDICATION_CONFIG_LIMIT
    expect(resolvePrehistoricConfigLimit("indication", 100)).toBe(32)

    process.env.PREHISTORIC_INDICATION_CONFIG_LIMIT = "48"
    expect(resolvePrehistoricConfigLimit("indication", 100)).toBe(48)
    expect(resolvePrehistoricConfigLimit("strategy", 12)).toBe(12)
  })
})
