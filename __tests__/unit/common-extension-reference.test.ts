import { createCommonSeriesContext } from "@/lib/common-indicators/context"
import { relativeVigorIndex } from "@/lib/common-indicators/ao/research4"
import { COMMON_RULES, commonRuleStates } from "@/lib/common-indicators/registry"
import { syntheticCandles } from "@/lib/common-indicators/synthetic"
import { COMMON_HISTORY_MAX_MINUTES, commonHistoryMinutes } from "@/lib/common-indicators/history"
import { COMMON_INDICATOR_DEFINITIONS, DEFAULT_COMMON_INDICATION_SETTINGS, commonIndicatorParameterConfigurations, type CommonIndicatorSettings } from "@/lib/common-indicator-config"

test("the configurable history can warm every default tuple on the longest default timeframe", () => {
  const prior = process.env.COMMON_HISTORY_MINUTES
  try {
    process.env.COMMON_HISTORY_MINUTES = String(COMMON_HISTORY_MAX_MINUTES)
    expect(commonHistoryMinutes()).toBe(10080)
    for (const definition of COMMON_INDICATOR_DEFINITIONS) {
      const rule = COMMON_RULES.get(definition.type)!
      const tuples = commonIndicatorParameterConfigurations(definition, DEFAULT_COMMON_INDICATION_SETTINGS[definition.storageKey] as CommonIndicatorSettings)
      for (const tuple of tuples) {
        // One extra 30m bucket covers the incomplete last aggregation.
        expect((rule.warmup(rule.resolve(tuple, 14)) + 1) * 30).toBeLessThanOrEqual(commonHistoryMinutes())
      }
    }
  } finally {
    if (prior === undefined) delete process.env.COMMON_HISTORY_MINUTES
    else process.env.COMMON_HISTORY_MINUTES = prior
  }
})

test("ported RVI matches the reference's rational weighted calculation", () => {
  const changes = [1, 2, -1, 3, -2, 4, -3, 5, -4, 6]
  const ranges = [6, 8, 7, 10, 9, 12, 11, 14, 13, 16]
  const candles = changes.map((change, i) => ({ timestamp: Date.UTC(2026, 9, 1) + i * 15 * 60_000,
    open: 100, close: 100 + change, high: 100 + ranges[i] / 2, low: 100 - ranges[i] / 2, volume: 10 }))
  const { rvi, signal } = relativeVigorIndex(createCommonSeriesContext(candles, { tfMin: 15 }).ao().b, 2)
  expect(rvi[4]).toBe(10 / 97)
  expect(rvi[5]).toBe(9 / 108)
  expect(rvi[6]).toBe(9 / 120)
  expect(rvi[7]).toBe(9 / 132)
  expect(signal[7]).toBe((9 / 132 + 2 * (9 / 120) + 2 * (9 / 108) + 10 / 97) / 6)
})

test("holding an RVI event never extends it through a missing candle", () => {
  const candles = syntheticCandles("RVI-gap", 1, 1800, Date.UTC(2026, 9, 1), 4)
  const rule = COMMON_RULES.get("relativeVigor")!
  const raw = commonRuleStates(createCommonSeriesContext(candles, { tfMin: 1 }), rule, { period: 10, keep: 1 })
  const index = raw.findIndex((side, i) => i > 100 && i < 1700 && side !== 0)
  expect(index).toBeGreaterThan(100)
  const gapped = candles.map((bar, i) => i > index ? { ...bar, timestamp: bar.timestamp + 60_000 } : bar)
  const held = commonRuleStates(createCommonSeriesContext(gapped, { tfMin: 1 }), rule, { period: 10, keep: 20 })
  expect(held[index]).toBe(raw[index])
  expect(held[index + 1]).toBe(0)
  expect(held.slice(index + 1, index + 16).every(side => side === 0)).toBe(true)
})
