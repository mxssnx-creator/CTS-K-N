import { StepBasedIndicators } from "@/lib/step-based-indicators"
import {
  COMMON_INDICATOR_DEFINITIONS,
  DEFAULT_COMMON_INDICATION_SETTINGS,
  commonIndicatorParameterConfigurations,
  type CommonIndicatorSettings,
} from "@/lib/common-indicator-config"
import {
  createTechnicalIndicatorEvaluationContext,
  evaluateTechnicalIndicators,
  normalizeTechnicalCandles,
  onBalanceVolume,
  resampleTechnicalCandles,
} from "@/lib/technical-indicators"

function candles(prices: number[]) {
  return prices.map((close, index) => ({
    timestamp: Date.UTC(2026, 0, 1, 0, index),
    open: index === 0 ? close : prices[index - 1],
    high: close + 0.2,
    low: close - 0.2,
    close,
    volume: 100 + index * 10,
  }))
}

describe("Common technical indicators", () => {
  test("normalizes chronological candles and supports the Common 30-minute range", () => {
    const source = candles(Array.from({ length: 30 }, (_, index) => 100 + index))
    const reversed = [...source].reverse()

    expect(normalizeTechnicalCandles(reversed)[0].close).toBe(100)
    const resampled = resampleTechnicalCandles(reversed, 30)
    expect(resampled).toHaveLength(1)
    expect(resampled[0]).toMatchObject({
      open: 100,
      close: 129,
      volume: source.reduce((sum, candle) => sum + candle.volume, 0),
    })
  })

  test("implements OBV volume accumulation independently for rising and falling closes", () => {
    const rising = candles([100, 101, 102, 103, 104, 105])
    const falling = candles([105, 104, 103, 102, 101, 100])

    expect(onBalanceVolume(rising).at(-1)).toBeGreaterThan(0)
    expect(onBalanceVolume(falling).at(-1)).toBeLessThan(0)

    const parameters = { obv: { shortPeriod: 2, longPeriod: 4 } }
    expect(evaluateTechnicalIndicators(rising, 14, ["obv"], parameters).obv?.direction)
      .toBe("long")
    expect(evaluateTechnicalIndicators(falling, 14, ["obv"], parameters).obv?.direction)
      .toBe("short")
  })

  test("implements Stochastic %K/%D with configured thresholds and warm-up", () => {
    const rising = candles([100, 101, 102, 103, 104, 105])
    const result = evaluateTechnicalIndicators(rising, 14, ["stochastic"], {
      stochastic: { kPeriod: 3, dPeriod: 2, oversold: 20, overbought: 80 },
    }).stochastic

    expect(result).toBeDefined()
    expect(result!.details.k).toBeGreaterThan(50)
    expect(result!.details.d).toBeGreaterThan(50)
    expect(result!.details).toMatchObject({ oversold: 20, overbought: 80 })

    expect(evaluateTechnicalIndicators(rising.slice(0, 3), 14, ["stochastic"], {
      stochastic: { kPeriod: 3, dPeriod: 2 },
    }).stochastic).toBeUndefined()
  })

  test("keeps Common timeframes independent from Trend through 30 minutes", () => {
    expect(
      (DEFAULT_COMMON_INDICATION_SETTINGS.ma as CommonIndicatorSettings).timeout,
    ).toBe(1)
    const result = StepBasedIndicators.calculateAll(
      candles(Array.from({ length: 120 }, (_, index) => 100 + index * 0.01)),
      [1, 3, 5, 15, 30],
      ["obv", "stochastic"],
    )

    expect(Object.keys(result)).toEqual(["1", "3", "5", "15", "30"])
    const expectedConfigurations = COMMON_INDICATOR_DEFINITIONS
      .filter((definition) => definition.type === "obv" || definition.type === "stochastic")
      .reduce((total, definition) => total + commonIndicatorParameterConfigurations(
        definition,
        DEFAULT_COMMON_INDICATION_SETTINGS[definition.storageKey] as CommonIndicatorSettings,
      ).length, 0)
    expect(result["1"].configurations).toHaveLength(expectedConfigurations)
    expect(expectedConfigurations).toBeGreaterThan(3)
    expect(result["1"].indicators.obv).toBeDefined()
    expect(result["1"].indicators.stochastic).toBeDefined()
  })

  test("streaming summaries exactly match the exhaustive aggregate", async () => {
    const source = candles(Array.from({ length: 180 }, (_, index) =>
      100 + Math.sin(index / 7) * 2 + index * 0.03,
    ))
    const enabled = ["ma", "rsi", "macd", "bollinger", "stochastic", "obv"] as const
    const exhaustive = await StepBasedIndicators.calculateAllAsync(
      source,
      [1, 5, 15],
      enabled,
      DEFAULT_COMMON_INDICATION_SETTINGS,
      8,
    )
    const streaming = await StepBasedIndicators.calculateSummariesAsync(
      source,
      [1, 5, 15],
      enabled,
      DEFAULT_COMMON_INDICATION_SETTINGS,
      8,
    )

    for (const timeframe of ["1", "5", "15"]) {
      expect(streaming[timeframe].indicators).toEqual(exhaustive[timeframe].indicators)
      expect(streaming[timeframe].summary).toEqual(exhaustive[timeframe].summary)
    }
  })

  test("reuses one timeframe context without changing any configuration result", () => {
    const source = resampleTechnicalCandles(
      candles(Array.from({ length: 240 }, (_, index) =>
        100 + Math.sin(index / 9) * 3 + index * 0.02,
      )),
      1,
    )
    const context = createTechnicalIndicatorEvaluationContext(source)

    for (const definition of COMMON_INDICATOR_DEFINITIONS) {
      const configurations = commonIndicatorParameterConfigurations(
        definition,
        DEFAULT_COMMON_INDICATION_SETTINGS[definition.storageKey] as CommonIndicatorSettings,
      )
      for (const parameters of [configurations[0], configurations.at(-1)]) {
        expect(evaluateTechnicalIndicators(
          source,
          14,
          [definition.type],
          { [definition.type]: parameters },
          context,
        )).toEqual(evaluateTechnicalIndicators(
          source,
          14,
          [definition.type],
          { [definition.type]: parameters },
        ))
      }
    }
  })
})
