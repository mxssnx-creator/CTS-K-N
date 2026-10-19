/**
 * The 17 original Common types run on the shared rule registry. Their live
 * results must equal the frozen pre-registry implementation (PR #559 state of
 * lib/technical-indicators.ts) for every default parameter tuple, on several
 * synthetic markets, timeframes and series lengths — including the warm-up
 * edge (no result) and the shared-context path the exhaustive grid uses.
 *
 * Documented, intended difference: ATR's breakout baseline uses the configured
 * period (it was fixed to the 14-bar fallback), so ATR tuples with period ≠ 14
 * are compared separately.
 */
import {
  COMMON_INDICATOR_DEFINITIONS,
  DEFAULT_COMMON_INDICATION_SETTINGS,
  LEGACY_COMMON_INDICATOR_TYPES,
  commonIndicatorParameterConfigurations,
  type CommonIndicatorSettings,
} from "@/lib/common-indicator-config"
import { syntheticCandles } from "@/lib/common-indicators/synthetic"
import {
  createTechnicalIndicatorEvaluationContext,
  evaluateTechnicalIndicators,
  resampleTechnicalCandles,
} from "@/lib/technical-indicators"
import * as legacy from "../fixtures/legacy-technical-indicators"

const END = Date.UTC(2026, 9, 1, 12, 0)

function markets() {
  return [3, 11, 29].flatMap((seed) => [
    { name: `seed${seed}-1m-long`, candles: syntheticCandles("AAA-USDT", 1, 260, END, seed) },
    { name: `seed${seed}-1m-short`, candles: syntheticCandles("BBB-USDT", 1, 24, END, seed) },
  ])
}

/**
 * The documented RSI exception (audit F1): the frozen implementation voted
 * momentum inside the thresholds; the reversion rule is neutral there. The
 * frozen output is normalised the same way before comparing, so every other
 * RSI field must still match exactly.
 */
function withRsiNeutralZone<T>(output: T): T {
  const rsi = (output as any)?.rsi
  if (!rsi || !rsi.details) return output
  const { value, details } = rsi
  if (value > details.oversold && value < details.overbought) rsi.direction = "neutral"
  return output
}

describe("Common registry equivalence with the original implementation (17 types)", () => {
  const legacyDefinitions = COMMON_INDICATOR_DEFINITIONS.filter((definition) =>
    (LEGACY_COMMON_INDICATOR_TYPES as readonly string[]).includes(definition.type))

  test("covers exactly the 17 original types", () => {
    expect(legacyDefinitions.map((definition) => definition.type)).toEqual([...LEGACY_COMMON_INDICATOR_TYPES])
  })

  for (const timeframe of [1, 5, 15]) {
    test(`every default tuple matches on ${timeframe}m bars (with and without a shared context)`, () => {
      let compared = 0
      let present = 0
      for (const market of markets()) {
        const resampled = resampleTechnicalCandles(market.candles, timeframe)
        const sharedNew = createTechnicalIndicatorEvaluationContext(resampled)
        const sharedOld = legacy.createTechnicalIndicatorEvaluationContext(resampled)
        for (const definition of legacyDefinitions) {
          const settings = DEFAULT_COMMON_INDICATION_SETTINGS[definition.storageKey] as CommonIndicatorSettings
          for (const values of commonIndicatorParameterConfigurations(definition, settings)) {
            if (definition.type === "atr" && values.period !== 14) continue
            const parameters = { [definition.type]: values }
            const expected = withRsiNeutralZone(legacy.evaluateTechnicalIndicators(
              resampled, 14, [definition.type as legacy.TechnicalIndicatorResult["type"]], parameters as any, sharedOld,
            ))
            const actual = evaluateTechnicalIndicators(resampled, 14, [definition.type], parameters, sharedNew)
            const fresh = evaluateTechnicalIndicators(resampled, 14, [definition.type], parameters)
            expect(actual).toEqual(expected)
            expect(fresh).toEqual(expected)
            compared++
            if (Object.keys(expected).length > 0) present++
          }
        }
      }
      expect(compared).toBeGreaterThan(5_000)
      expect(present).toBeGreaterThan(0)
    })
  }

  test("the whole default catalogue of the 17 types matches when evaluated together", () => {
    for (const market of markets()) {
      const expected = withRsiNeutralZone(legacy.evaluateTechnicalIndicators(market.candles, 14))
      const actual = evaluateTechnicalIndicators(market.candles, 14, [...LEGACY_COMMON_INDICATOR_TYPES])
      // ATR's baseline is the documented exception (fallback period 14 = configured 14 here).
      expect(actual).toEqual(expected)
    }
  })

  test("RSI's middle zone is neutral (documented fix, audit F1)", () => {
    const candles = syntheticCandles("RSI-USDT", 1, 400, END, 9)
    const result = evaluateTechnicalIndicators(candles, 14, ["rsi"], { rsi: { period: 14, oversold: 30, overbought: 70 } }).rsi!
    if (result.value > 30 && result.value < 70) expect(result.direction).toBe("neutral")
  })

  test("ATR's breakout baseline uses the configured period (documented fix)", () => {
    const candles = syntheticCandles("CCC-USDT", 1, 200, END, 5)
    const result = evaluateTechnicalIndicators(candles, 14, ["atr"], { atr: { period: 21, multiplier: 1 } }).atr!
    const closes = candles.map((candle) => candle.close)
    const sma21 = closes.slice(-21).reduce((sum, value) => sum + value, 0) / 21
    expect(result.details.baseline).toBeCloseTo(sma21, 6)
  })
})
