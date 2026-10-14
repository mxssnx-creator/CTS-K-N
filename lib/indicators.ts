/**
 * Technical Indicators Library
 * Implements common trading indicators: RSI, MACD, Bollinger Bands, Parabolic SAR, etc.
 */
import { latestWilderRsi } from "@/lib/wilder-rsi"
import { toCommonParameters, type PresetIndicatorType } from "@/lib/preset-optimizer"
import { createCommonSeriesContext } from "@/lib/common-indicators/context"
import { getCommonRule } from "@/lib/common-indicators/registry"
import type { CommonIndicatorType } from "@/lib/common-indicator-config"
import { evaluateTechnicalIndicators } from "@/lib/technical-indicators"

export interface IndicatorConfig {
  type: PresetIndicatorType
  params: Record<string, number>
}

export interface IndicatorSignal {
  type: string
  strength: number // 0-1
  direction: "long" | "short" | "neutral"
  value: number
  timestamp: Date
}

export class TechnicalIndicators {
  /**
   * Calculate RSI (Relative Strength Index)
   */
  static calculateRSI(prices: number[], period = 14): number {
    return latestWilderRsi(prices || [], period)
  }

  /**
   * Calculate MACD (Moving Average Convergence Divergence)
   */
  static calculateMACD(
    prices: number[],
    fastPeriod = 12,
    slowPeriod = 26,
    signalPeriod = 9,
  ): { macd: number; signal: number; histogram: number } {
    if (!prices || prices.length < slowPeriod) {
      return { macd: 0, signal: 0, histogram: 0 }
    }

    const fastEMA = this.calculateEMA(prices, fastPeriod)
    const slowEMA = this.calculateEMA(prices, slowPeriod)
    const macd = fastEMA - slowEMA

    // For signal line, we'd need historical MACD values
    // Simplified: use current MACD as signal
    const signal = macd * 0.9 // Approximation

    return {
      macd,
      signal,
      histogram: macd - signal,
    }
  }

  /**
   * Calculate Bollinger Bands
   */
  static calculateBollingerBands(
    prices: number[],
    period = 20,
    stdDev = 2,
  ): { upper: number; middle: number; lower: number; bandwidth: number } {
    if (!prices || prices.length < period) {
      const fallbackPrice = prices && prices.length > 0 ? prices[prices.length - 1] : 0
      return { upper: fallbackPrice, middle: fallbackPrice, lower: fallbackPrice, bandwidth: 0 }
    }

    const sma = this.calculateSMA(prices, period)
    const variance =
      prices
        .slice(-period)
        .map((p) => Math.pow(p - sma, 2))
        .reduce((sum, v) => sum + v, 0) / period
    const std = Math.sqrt(variance)

    const upper = sma + stdDev * std
    const lower = sma - stdDev * std
    const bandwidth = sma > 0 ? ((upper - lower) / sma) * 100 : 0

    return { upper, middle: sma, lower, bandwidth }
  }

  /**
   * Calculate Parabolic SAR
   */
  static calculateParabolicSAR(
    highs: number[],
    lows: number[],
    acceleration = 0.02,
    maximum = 0.2,
  ): { sar: number; trend: "up" | "down" } {
    if (!highs || !lows || highs.length < 2 || lows.length < 2) {
      const fallbackValue = lows && lows.length > 0 ? lows[lows.length - 1] : 0
      return { sar: fallbackValue, trend: "up" }
    }

    const currentHigh = highs[highs.length - 1]
    const currentLow = lows[lows.length - 1]
    const prevHigh = highs[highs.length - 2]
    const prevLow = lows[lows.length - 2]

    // Simplified SAR calculation
    const trend = currentHigh > prevHigh ? "up" : "down"
    const sar = trend === "up" ? currentLow * 0.98 : currentHigh * 1.02

    return { sar, trend }
  }

  /**
   * Calculate EMA (Exponential Moving Average)
   */
  static calculateEMA(prices: number[], period: number): number {
    if (!prices || prices.length === 0) return 0
    if (prices.length < period) return prices[prices.length - 1]

    const multiplier = 2 / (period + 1)
    let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period

    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema
    }

    return ema
  }

  /**
   * Calculate SMA (Simple Moving Average)
   */
  static calculateSMA(prices: number[], period: number): number {
    if (!prices || prices.length === 0) return 0
    if (prices.length < period) return prices[prices.length - 1]
    const slice = prices.slice(-period)
    return slice.length > 0 ? slice.reduce((sum, p) => sum + p, 0) / slice.length : 0
  }

  /**
   * Calculate Stochastic Oscillator
   */
  static calculateStochastic(highs: number[], lows: number[], closes: number[], period = 14): { k: number; d: number } {
    if (!highs || !lows || !closes || highs.length < period || lows.length < period || closes.length === 0) {
      return { k: 50, d: 50 }
    }

    const recentHighs = highs.slice(-period)
    const recentLows = lows.slice(-period)
    const currentClose = closes[closes.length - 1]

    const highestHigh = Math.max(...recentHighs)
    const lowestLow = Math.min(...recentLows)

    const range = highestHigh - lowestLow
    const k = range > 0 ? ((currentClose - lowestLow) / range) * 100 : 50
    const d = k * 0.9 // Simplified %D

    return { k, d }
  }

  /**
   * Calculate ADX (Average Directional Index)
   */
  static calculateADX(
    highs: number[],
    lows: number[],
    closes: number[],
    period = 14,
  ): { adx: number; plusDI: number; minusDI: number; trend: "strong" | "weak" } {
    if (
      !highs ||
      !lows ||
      !closes ||
      highs.length < period + 1 ||
      lows.length < period + 1 ||
      closes.length < period + 1
    ) {
      return { adx: 0, plusDI: 0, minusDI: 0, trend: "weak" }
    }

    // Calculate True Range (TR)
    const trueRanges: number[] = []
    for (let i = 1; i < highs.length; i++) {
      const high = highs[i]
      const low = lows[i]
      const prevClose = closes[i - 1]

      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
      trueRanges.push(tr)
    }

    // Calculate +DM and -DM
    const plusDM: number[] = []
    const minusDM: number[] = []

    for (let i = 1; i < highs.length; i++) {
      const upMove = highs[i] - highs[i - 1]
      const downMove = lows[i - 1] - lows[i]

      plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0)
      minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0)
    }

    // Calculate smoothed TR, +DM, -DM
    const smoothedTR = trueRanges.slice(-period).reduce((sum, tr) => sum + tr, 0)
    const smoothedPlusDM = plusDM.slice(-period).reduce((sum, dm) => sum + dm, 0)
    const smoothedMinusDM = minusDM.slice(-period).reduce((sum, dm) => sum + dm, 0)

    // Calculate +DI and -DI
    const plusDI = smoothedTR > 0 ? (smoothedPlusDM / smoothedTR) * 100 : 0
    const minusDI = smoothedTR > 0 ? (smoothedMinusDM / smoothedTR) * 100 : 0

    // Calculate DX
    const diSum = plusDI + minusDI
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0

    // ADX is smoothed DX (simplified: use current DX)
    const adx = dx

    return {
      adx,
      plusDI,
      minusDI,
      trend: adx > 25 ? "strong" : "weak",
    }
  }

  /**
   * Generate a trading signal from a close-only price series. The prices are
   * turned into candles (open = previous close, a small synthetic wick) — use
   * generateSignalFromCandles whenever real OHLCV is available. Every type is
   * the shared Common rule (lib/common-indicators/registry.ts) with the
   * preset's own parameters, so the preset runtime reads what the optimizer
   * tuned and what the live engine executes.
   */
  static generateSignal(indicator: IndicatorConfig, prices: number[]): IndicatorSignal {
    return this.generateSignalFromCandles(indicator, closeOnlyCandles(prices))
  }

  /** The shared Common rule of the indicator at the last candle (real OHLCV). */
  static generateSignalFromCandles(indicator: IndicatorConfig, candles: unknown[]): IndicatorSignal {
    const rawType = String(indicator.type)
    const canonicalType = (rawType === "sar" ? "psar" : rawType) as CommonIndicatorType
    const parameters = toCommonParameters(indicator.type, numericParams(indicator.params))
    const evaluated = evaluateTechnicalIndicators(candles, 14, [canonicalType], { [canonicalType]: parameters })
    const signal = evaluated[canonicalType]
    return {
      type: indicator.type,
      strength: signal?.strength || 0,
      direction: signal?.direction || "neutral",
      value: signal?.value || 0,
      timestamp: new Date(),
    }
  }

  /**
   * The indicator's reading at every candle (causal: bar i reads bars 0..i),
   * computed once over the series instead of re-evaluating a window per bar.
   */
  static signalSeriesFromCandles(
    indicator: IndicatorConfig,
    candles: unknown[],
  ): Array<{ direction: "long" | "short" | "neutral"; strength: number; value: number }> {
    const rule = getCommonRule(String(indicator.type))
    const context = createCommonSeriesContext(candles)
    const output = new Array(context.length).fill(null).map(() => ({ direction: "neutral" as const, strength: 0, value: 0 }))
    if (!rule) return output
    const params = rule.resolve(toCommonParameters(indicator.type, numericParams(indicator.params)), 14)
    const warmup = rule.warmup(params)
    const series: Array<{ direction: "long" | "short" | "neutral"; strength: number; value: number }> = output
    for (let index = Math.max(0, warmup - 1); index < context.length; index++) {
      const sample = rule.at(context, params, index)
      if (sample) series[index] = { direction: sample.direction, strength: Math.max(0, Math.min(1, sample.strength)), value: sample.value }
    }
    return series
  }

  /**
   * Combine multiple indicator signals
   */
  static combineSignals(signals: IndicatorSignal[]): { direction: "long" | "short" | "neutral"; strength: number } {
    if (signals.length === 0) return { direction: "neutral", strength: 0 }

    const longSignals = signals.filter((s) => s.direction === "long")
    const shortSignals = signals.filter((s) => s.direction === "short")

    const longStrength = longSignals.reduce((sum, s) => sum + s.strength, 0) / signals.length
    const shortStrength = shortSignals.reduce((sum, s) => sum + s.strength, 0) / signals.length

    if (longStrength > shortStrength && longStrength > 0.3) {
      return { direction: "long", strength: longStrength }
    } else if (shortStrength > longStrength && shortStrength > 0.3) {
      return { direction: "short", strength: shortStrength }
    }

    return { direction: "neutral", strength: 0 }
  }
}

/**
 * Calculate all configured indicators for given price data
 */
export function calculateIndicators(prices: number[], indicators: IndicatorConfig[]): IndicatorSignal[] {
  return indicators.map((indicator) => TechnicalIndicators.generateSignal(indicator, prices))
}

/** As calculateIndicators, on real OHLCV candles (preferred). */
export function calculateIndicatorsFromCandles(candles: unknown[], indicators: IndicatorConfig[]): IndicatorSignal[] {
  return indicators.map((indicator) => TechnicalIndicators.generateSignalFromCandles(indicator, candles))
}

/**
 * Close-only prices as candles: open = previous close, a wick of 10 % of the
 * close-to-close move (at least 0.01 % of the price) and a volume that grows
 * with the move. Only for callers that have no OHLCV.
 */
function closeOnlyCandles(prices: number[]) {
  return prices.map((price, index) => {
    const previous = prices[Math.max(0, index - 1)] || price
    const spread = Math.max(Math.abs(price - previous), price * 0.0001)
    return {
      timestamp: index,
      open: previous,
      high: Math.max(previous, price) + spread * 0.1,
      low: Math.min(previous, price) - spread * 0.1,
      close: price,
      volume: Math.max(1, Math.abs(price - previous) * 1_000),
    }
  })
}

function numericParams(params: Record<string, unknown> | undefined): Record<string, number> {
  const output: Record<string, number> = {}
  for (const [key, value] of Object.entries(params || {})) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) output[key] = parsed
  }
  return output
}
