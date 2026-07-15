import {
  DEFAULT_PRESET_OPTIMIZER_SETTINGS,
  aggregateCandles,
  buildCommonIndicatorConfigurations,
  buildTrailingConfigurations,
  generatePresetSignals,
  normalizePresetOptimizerSettings,
  optimizePresetsForSymbol,
  rangeValues,
  type PresetCandle,
} from "@/lib/preset-optimizer"

describe("preset optimizer", () => {
  test("normalizes the requested production ranges and defaults", () => {
    const settings = normalizePresetOptimizerSettings({
      historyDays: 99,
      presetsPerSymbol: 0,
      minProfitFactor: 0.73,
      maxDrawdownHours: 5,
      takeProfit: { min: 3, max: 30, step: 1 },
      stopLossRatio: { min: 0.25, max: 2, step: 0.25 },
      trailingStart: { min: 0.5, max: 1.5, step: 0.1 },
      trailingStop: { min: 0.2, max: 0.4, step: 0.1 },
      trailingStepRatio: 0.5,
      trailingIndependent: "false",
      autoGenerate: "false",
      blockEnabled: "false",
      blockVolumeRatio: 9,
      blockMaxStack: 0,
      blockPauseCountRatio: 1.3,
      blockActiveRealEnabled: "false",
    })

    expect(settings).toMatchObject({
      historyDays: 14,
      presetsPerSymbol: 1,
      minProfitFactor: 0.7,
      maxDrawdownHours: 5,
      takeProfit: { min: 3, max: 30, step: 1 },
      stopLossRatio: { min: 0.25, max: 2, step: 0.25 },
      trailingStart: { min: 0.5, max: 1.5, step: 0.1 },
      trailingStop: { min: 0.2, max: 0.4, step: 0.1 },
      trailingStepRatio: 0.5,
      trailingIndependent: false,
      autoGenerate: false,
      blockEnabled: false,
      blockVolumeRatio: 3,
      blockMaxStack: 1,
      blockPauseCountRatio: 1.5,
      blockActiveRealEnabled: false,
    })
    expect(DEFAULT_PRESET_OPTIMIZER_SETTINGS.presetsPerSymbol).toBe(4)
    expect(DEFAULT_PRESET_OPTIMIZER_SETTINGS).toMatchObject({
      historyDays: 14,
      minProfitFactor: 0.7,
      maxDrawdownHours: 5,
      takeProfit: { min: 3, max: 30, step: 1 },
      stopLossRatio: { min: 0.25, max: 2, step: 0.25 },
      trailingStart: { min: 0.5, max: 1.5, step: 0.1 },
      trailingStop: { min: 0.2, max: 0.4, step: 0.1 },
      trailingStepRatio: 0.5,
      autoGenerate: true,
      autoSelect: true,
      blockEnabled: true,
      blockVolumeRatio: 1,
      blockMaxStack: 10,
      blockPauseCountRatio: 1,
      blockActiveRealEnabled: true,
      blockActiveLiveEnabled: true,
    })
    expect(DEFAULT_PRESET_OPTIMIZER_SETTINGS.indicatorTypes).toHaveLength(9)
    expect(rangeValues(settings.stopLossRatio)).toHaveLength(8)
  })

  test("aggregates historical candles without losing intra-bucket highs, lows, or volume", () => {
    const candles: PresetCandle[] = Array.from({ length: 8 }, (_, index) => ({
      timestamp: index + 1,
      open: 100 + index,
      high: index === 2 ? 150 : 101 + index,
      low: index === 5 ? 50 : 99 + index,
      close: 100.5 + index,
      volume: index + 1,
    }))

    const result = aggregateCandles(candles, 2)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ open: 100, high: 150, volume: 10 })
    expect(result[1]).toMatchObject({ low: 50, close: 107.5, volume: 26 })
  })

  test("builds independent trailing ranges with step equal to the configured stop factor", () => {
    const settings = normalizePresetOptimizerSettings({
      trailingEnabled: true,
      trailingIndependent: true,
      trailingStart: { min: 0.5, max: 0.5, step: 0.1 },
      trailingStop: { min: 0.4, max: 0.4, step: 0.1 },
      trailingStepRatio: 0.5,
    })
    expect(buildTrailingConfigurations(settings)).toEqual([
      { enabled: false, independent: false, startRatio: 0, stopRatio: 0, stepRatio: 0 },
      { enabled: true, independent: true, startRatio: 0.5, stopRatio: 0.4, stepRatio: 0.2 },
    ])
  })

  test("calculates a cost-normalized ranked preset from real candle paths", () => {
    const start = Date.UTC(2026, 6, 1)
    const candles = Array.from({ length: 400 }, (_, index) => {
      const baseline = 100 + Math.sin(index / 5) * 3 + index * 0.002
      return {
        timestamp: start + index * 5 * 60_000,
        open: baseline - 0.1,
        high: baseline + 0.45,
        low: baseline - 0.45,
        close: baseline,
        volume: 100 + index,
      }
    })
    const result = optimizePresetsForSymbol({
      connectionId: "preset-test",
      symbol: "BTCUSDT",
      candles,
      now: candles[candles.length - 1].timestamp,
      positionCostPct: 0.1,
      commonSettings: {
        rsi: {
          enabled: true,
          period: { from: 6, to: 6, step: 1 },
          oversold: { from: 45, to: 45, step: 1 },
          overbought: { from: 55, to: 55, step: 1 },
        },
      },
      settings: {
        historyDays: 1,
        presetsPerSymbol: 1,
        minProfitFactor: 0.4,
        maxDrawdownHours: 24,
        takeProfit: { min: 3, max: 3, step: 1 },
        stopLossRatio: { min: 1, max: 1, step: 0.25 },
        trailingEnabled: false,
        indicatorTypes: ["rsi"],
        maxIndicatorVariantsPerType: 1,
        maxSignalsPerVariant: 16,
        maxCandlesPerRun: 500,
      },
    })

    expect(result.evaluatedConfigurations).toBe(1)
    expect(result.sampledCandles).toBeGreaterThan(40)
    expect(result.presets).toHaveLength(1)
    expect(result.presets[0]).toMatchObject({
      connectionId: "preset-test",
      symbol: "BTCUSDT",
      rank: 1,
      positionCostPct: 0.1,
      takeProfitRatio: 3,
      takeProfitPct: 0.3,
      stopLossToTakeProfitRatio: 1,
      stopLossPct: 0.3,
      takeProfitEnabled: true,
    })
    expect(result.presets[0].metrics.totalPositions).toBeGreaterThan(0)
    expect(result.presets[0].metrics.totalPositions).toBeLessThanOrEqual(result.signals)
    expect(result.presets[0].metrics.daily).toHaveLength(1)
  })

  test("uses each common indicator's real calculation and configuration parameters", () => {
    const start = Date.UTC(2026, 5, 1)
    const candles = Array.from({ length: 500 }, (_, index) => {
      const close = 100 + Math.sin(index / 11) * 4 + Math.sin(index / 3) * 0.7 + index * 0.01
      return {
        timestamp: start + index * 5 * 60_000,
        open: close - 0.1,
        high: close + 0.6,
        low: close - 0.6,
        close,
        volume: 100 + index,
      }
    })
    const configurations = buildCommonIndicatorConfigurations({}, normalizePresetOptimizerSettings({
      indicatorTypes: ["rsi", "macd", "bollinger", "ema", "sma", "stochastic", "adx", "atr", "sar"],
      maxIndicatorVariantsPerType: 1,
    }))
    expect(new Set(configurations.map((configuration) => configuration.type))).toEqual(
      new Set(["rsi", "macd", "bollinger", "ema", "sma", "stochastic", "adx", "atr", "sar"]),
    )
    for (const configuration of configurations) {
      const signals = generatePresetSignals(candles, configuration, 32)
      expect(signals.length).toBeGreaterThan(0)
      expect(signals.length).toBeLessThanOrEqual(32)
      expect(signals.every((signal) => signal.direction === "long" || signal.direction === "short")).toBe(true)
    }

    const macdFastSignal = generatePresetSignals(candles, {
      type: "macd",
      params: { fast: 8, slow: 21, signal: 3 },
    }, 32)
    const macdSlowSignal = generatePresetSignals(candles, {
      type: "macd",
      params: { fast: 8, slow: 21, signal: 15 },
    }, 32)
    expect(macdFastSignal).not.toEqual(macdSlowSignal)

    const emaSignals = generatePresetSignals(candles, {
      type: "ema",
      params: { short: 5, long: 18 },
    }, 32)
    const smaSignals = generatePresetSignals(candles, {
      type: "sma",
      params: { short: 5, long: 18 },
    }, 32)
    expect(emaSignals).not.toEqual(smaSignals)
  })

  test("spreads historical signals across a 14-day window and keeps daily totals exact", () => {
    const historyTo = Date.UTC(2026, 6, 15)
    const candles = Array.from({ length: 24 * 14 + 1 }, (_, index) => {
      const close = 100 + index * 0.25
      return {
        timestamp: historyTo - (24 * 14 - index) * 60 * 60_000,
        open: close - 0.05,
        high: close + 0.5,
        low: close - 0.1,
        close,
        volume: 100 + index,
      }
    })
    const result = optimizePresetsForSymbol({
      connectionId: "preset-14-day",
      symbol: "BTCUSDT",
      candles,
      now: historyTo,
      positionCostPct: 0.1,
      commonSettings: {
        parabolicSAR: {
          enabled: true,
          acceleration: { from: 0.02, to: 0.02, step: 0.005 },
          maximum: { from: 0.2, to: 0.2, step: 0.05 },
        },
      },
      settings: {
        historyDays: 14,
        presetsPerSymbol: 1,
        minProfitFactor: 0.4,
        maxDrawdownHours: 5,
        takeProfit: { min: 3, max: 3, step: 1 },
        stopLossRatio: { min: 1, max: 1, step: 0.25 },
        trailingEnabled: false,
        indicatorTypes: ["sar"],
        maxIndicatorVariantsPerType: 1,
        maxSignalsPerVariant: 48,
        maxCandlesPerRun: 500,
      },
    })
    const metrics = result.presets[0].metrics
    expect(metrics.daily).toHaveLength(14)
    expect(metrics.daily.reduce((sum, day) => sum + day.positions, 0)).toBe(metrics.totalPositions)
    expect(metrics.daily.filter((day) => day.positions > 0).length).toBeGreaterThanOrEqual(12)
    expect(metrics).toMatchObject({
      totalPositions: 48,
      winningPositions: 48,
      losingPositions: 0,
      profitFactor: 999,
      drawdownTimeHours: 0,
      eligible: true,
    })
  })
})
