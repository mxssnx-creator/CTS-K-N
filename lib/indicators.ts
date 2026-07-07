/**
 * Technical Indicators Library
 * Implements common trading indicators: RSI, MACD, Bollinger Bands, Parabolic SAR, etc.
 */

export interface IndicatorConfig {
  type: "rsi" | "macd" | "bollinger" | "sar" | "ema" | "sma" | "stochastic" | "adx"
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
    if (!prices || prices.length === 0) return 50
    if (prices.length < period + 1) return 50

    const changes = []
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i] - prices[i - 1])
    }

    const gains = changes.map((c) => (c > 0 ? c : 0))
    const losses = changes.map((c) => (c < 0 ? Math.abs(c) : 0))

    const avgGain = gains.slice(-period).reduce((sum, g) => sum + g, 0) / period
    const avgLoss = losses.slice(-period).reduce((sum, l) => sum + l, 0) / period

    if (avgLoss === 0) return avgGain > 0 ? 100 : 50
    const rs = avgGain / avgLoss
    return 100 - 100 / (1 + rs)
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
   * Generate trading signal from indicator
   */
  static generateSignal(indicator: IndicatorConfig, prices: number[]): IndicatorSignal {
    const currentPrice = prices[prices.length - 1]

    switch (indicator.type) {
      case "rsi": {
        const rsi = this.calculateRSI(prices, indicator.params.period || 14)
        const oversold = indicator.params.oversold || 30
        const overbought = indicator.params.overbought || 70

        if (rsi < oversold) {
          return {
            type: "rsi",
            strength: (oversold - rsi) / oversold,
            direction: "long",
            value: rsi,
            timestamp: new Date(),
          }
        } else if (rsi > overbought) {
          return {
            type: "rsi",
            strength: (rsi - overbought) / (100 - overbought),
            direction: "short",
            value: rsi,
            timestamp: new Date(),
          }
        }
        return { type: "rsi", strength: 0, direction: "neutral", value: rsi, timestamp: new Date() }
      }

      case "macd": {
        const macd = this.calculateMACD(prices)
        const strength = Math.min(Math.abs(macd.histogram) / currentPrice, 1)

        return {
          type: "macd",
          strength,
          direction: macd.histogram > 0 ? "long" : macd.histogram < 0 ? "short" : "neutral",
          value: macd.histogram,
          timestamp: new Date(),
        }
      }

      case "bollinger": {
        const bb = this.calculateBollingerBands(prices, indicator.params.period || 20, indicator.params.stdDev || 2)
        const position = (currentPrice - bb.lower) / (bb.upper - bb.lower)

        if (position < 0.2) {
          return {
            type: "bollinger",
            strength: 1 - position / 0.2,
            direction: "long",
            value: position,
            timestamp: new Date(),
          }
        } else if (position > 0.8) {
          return {
            type: "bollinger",
            strength: (position - 0.8) / 0.2,
            direction: "short",
            value: position,
            timestamp: new Date(),
          }
        }
        return { type: "bollinger", strength: 0, direction: "neutral", value: position, timestamp: new Date() }
      }

      case "sar": {
        const highs = prices.map((p) => p * 1.01) // Approximate highs
        const lows = prices.map((p) => p * 0.99) // Approximate lows
        const sar = this.calculateParabolicSAR(highs, lows)

        const distance = Math.abs(currentPrice - sar.sar) / currentPrice
        const strength = Math.min(distance * 10, 1)

        return {
          type: "sar",
          strength,
          direction: sar.trend === "up" ? "long" : "short",
          value: sar.sar,
          timestamp: new Date(),
        }
      }

      case "adx": {
        const highs = prices.map((p) => p * 1.01) // Approximate highs
        const lows = prices.map((p) => p * 0.99) // Approximate lows
        const adx = this.calculateADX(highs, lows, prices, indicator.params.period || 14)

        const strength = Math.min(adx.adx / 50, 1) // Normalize to 0-1

        return {
          type: "adx",
          strength,
          direction: adx.plusDI > adx.minusDI ? "long" : adx.minusDI > adx.plusDI ? "short" : "neutral",
          value: adx.adx,
          timestamp: new Date(),
        }
      }

      default:
        return { type: indicator.type, strength: 0, direction: "neutral", value: 0, timestamp: new Date() }
    }
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
