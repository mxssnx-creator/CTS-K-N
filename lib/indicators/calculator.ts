/**
 * PHASE 4: Indicator Calculation Engine
 * 
 * Evaluates technical indicators in real-time
 * Caches calculations in Redis with configurable TTL
 * Supports: RSI, MACD, Bollinger Bands, EMA, ATR, Momentum, Divergence
 */

import { getRedisClient } from "@/lib/redis-db"
// shim: existing code uses redisDb.set/get; map to InlineLocalRedis instance.
const redisDb = {
  get: (key: string) => getRedisClient().get(key),
  set: (key: string, val: string, opts?: { ex?: number }) =>
    opts?.ex ? getRedisClient().setex(key, opts.ex, val) : getRedisClient().set(key, val),
}

export interface IndicatorResult {
  indicator: string
  symbol: string
  value: number
  signal?: string // "buy" | "sell" | "neutral"
  strength: number // 0-1 confidence
  timestamp: number
}

export interface PriceData {
  symbol: string
  prices: number[]
  volumes?: number[]
  timestamps?: number[]
}

export class IndicatorCalculator {
  private readonly CACHE_PREFIX = "indicator:"
  private readonly CACHE_TTL = 300 // 5 minutes

  /**
   * Calculate RSI (Relative Strength Index)
   */
  calculateRSI(prices: number[], period: number = 14): number {
    if (prices.length < period + 1) return 50 // Neutral if not enough data

    let gainSum = 0
    let lossSum = 0

    for (let i = prices.length - period; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1]
      if (change > 0) gainSum += change
      else lossSum += Math.abs(change)
    }

    const avgGain = gainSum / period
    const avgLoss = lossSum / period

    if (avgLoss === 0) return avgGain === 0 ? 50 : 100

    const rs = avgGain / avgLoss
    const rsi = 100 - (100 / (1 + rs))

    return Math.round(rsi * 100) / 100
  }

  /**
   * Calculate MACD (Moving Average Convergence Divergence)
   */
  calculateMACD(
    prices: number[],
    fastPeriod: number = 12,
    slowPeriod: number = 26,
    signalPeriod: number = 9
  ): {
    macd: number
    signal: number
    histogram: number
  } {
    const ema12 = this.calculateEMA(prices, fastPeriod)
    const ema26 = this.calculateEMA(prices, slowPeriod)
    const macd = ema12 - ema26

    const macdValues: number[] = []
    for (let i = 0; i < Math.min(prices.length, 100); i++) {
      const slice = prices.slice(Math.max(0, prices.length - i - slowPeriod - 50))
      if (slice.length >= slowPeriod) {
        const e12 = this.calculateEMA(slice, fastPeriod)
        const e26 = this.calculateEMA(slice, slowPeriod)
        macdValues.push(e12 - e26)
      }
    }

    const signal = macdValues.length > 0 ? this.calculateEMA(macdValues.reverse(), signalPeriod) : macd
    const histogram = macd - signal

    return {
      macd: Math.round(macd * 10000) / 10000,
      signal: Math.round(signal * 10000) / 10000,
      histogram: Math.round(histogram * 10000) / 10000,
    }
  }

  /**
   * Calculate EMA (Exponential Moving Average)
   */
  calculateEMA(prices: number[], period: number): number {
    if (prices.length === 0) return 0

    const multiplier = 2 / (period + 1)
    let ema = this.calculateSMA(prices.slice(0, period), period)

    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * multiplier + ema * (1 - multiplier)
    }

    return ema
  }

  /**
   * Calculate SMA (Simple Moving Average)
   */
  calculateSMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1]

    const slice = prices.slice(prices.length - period)
    return slice.reduce((a, b) => a + b, 0) / period
  }

  /**
   * Calculate Bollinger Bands
   */
  calculateBollingerBands(prices: number[], period: number = 20, stdDev: number = 2): {
    upper: number
    middle: number
    lower: number
  } {
    const middle = this.calculateSMA(prices, period)

    const slice = prices.slice(prices.length - period)
    const variance = slice.reduce((sum, price) => sum + Math.pow(price - middle, 2), 0) / period
    const std = Math.sqrt(variance)

    return {
      upper: Math.round((middle + stdDev * std) * 100) / 100,
      middle: Math.round(middle * 100) / 100,
      lower: Math.round((middle - stdDev * std) * 100) / 100,
    }
  }

  /**
   * Calculate ATR (Average True Range) - for volatility
   */
  calculateATR(
    prices: number[],
    volumes?: number[],
    period: number = 14
  ): {
    atr: number
    volatility: number
  } {
    if (prices.length < period) {
      return { atr: 0, volatility: 0 }
    }

    let trueRanges: number[] = []

    for (let i = 1; i < prices.length; i++) {
      const tr = Math.max(
        prices[i] - prices[i - 1],
        Math.abs(prices[i] - (prices[i - 1] || prices[i])),
        Math.abs(prices[i - 1] - (prices[i] || prices[i - 1]))
      )
      trueRanges.push(tr)
    }

    const atr = trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period
    const volatility = (atr / prices[prices.length - 1]) * 100

    return {
      atr: Math.round(atr * 10000) / 10000,
      volatility: Math.round(volatility * 100) / 100,
    }
  }

  /**
   * Calculate momentum for trend strength
   */
  calculateMomentum(prices: number[], period: number = 10): {
    momentum: number
    trend: "bullish" | "bearish" | "neutral"
  } {
    if (prices.length < period) {
      return { momentum: 0, trend: "neutral" }
    }

    const currentPrice = prices[prices.length - 1]
    const previousPrice = prices[prices.length - period]
    const momentum = ((currentPrice - previousPrice) / previousPrice) * 100

    let trend: "bullish" | "bearish" | "neutral" = "neutral"
    if (momentum > 1) trend = "bullish"
    else if (momentum < -1) trend = "bearish"

    return {
      momentum: Math.round(momentum * 100) / 100,
      trend,
    }
  }

  /**
   * Detect divergence (price making new high but indicator not)
   */
  detectDivergence(
    prices: number[],
    indicatorValues: number[],
    lookback: number = 20
  ): {
    bullishDivergence: boolean
    bearishDivergence: boolean
    strength: number
  } {
    const prices_slice = prices.slice(-lookback)
    const indicator_slice = indicatorValues.slice(-lookback)

    const priceMin = Math.min(...prices_slice)
    const priceMax = Math.max(...prices_slice)
    const indMin = Math.min(...indicator_slice)
    const indMax = Math.max(...indicator_slice)

    // Bullish: price makes lower low, but indicator makes higher low
    const bullishDivergence =
      prices_slice[prices_slice.length - 1] < priceMin * 1.01 && indicator_slice[indicator_slice.length - 1] > indMin

    // Bearish: price makes higher high, but indicator makes lower high
    const bearishDivergence =
      prices_slice[prices_slice.length - 1] > priceMax * 0.99 && indicator_slice[indicator_slice.length - 1] < indMax

    const strength = bullishDivergence || bearishDivergence ? 0.7 : 0

    return { bullishDivergence, bearishDivergence, strength }
  }

  /**
   * Cache indicator result
   */
  async cacheResult(symbol: string, indicator: string, result: IndicatorResult): Promise<void> {
    try {
      const key = `${this.CACHE_PREFIX}${symbol}:${indicator}`
      await redisDb.set(key, JSON.stringify(result), { ex: this.CACHE_TTL })
    } catch (error) {
      console.error(`[v0] [IndicatorCalculator] Failed to cache result:`, error)
    }
  }

  /**
   * Get cached result
   */
  async getCachedResult(symbol: string, indicator: string): Promise<IndicatorResult | null> {
    try {
      const key = `${this.CACHE_PREFIX}${symbol}:${indicator}`
      const data = await redisDb.get(key)
      return data ? JSON.parse(data) : null
    } catch (error) {
      console.error(`[v0] [IndicatorCalculator] Failed to get cached result:`, error)
      return null
    }
  }

  /**
   * Evaluate multiple indicators for signal
   */
  async evaluateSignals(
    symbol: string,
    priceData: PriceData,
    indicators: {
      rsi?: { enabled: boolean; period?: number; overbought?: number; oversold?: number }
      macd?: { enabled: boolean }
      bollinger?: { enabled: boolean; period?: number; stdDev?: number }
      atr?: { enabled: boolean; period?: number }
    }
  ): Promise<{
    signal: "buy" | "sell" | "neutral"
    strength: number
    components: Record<string, IndicatorResult>
  }> {
    const components: Record<string, IndicatorResult> = {}
    let buySignals = 0
    let sellSignals = 0
    let totalStrength = 0

    try {
      // RSI evaluation
      if (indicators.rsi?.enabled) {
        const rsi = this.calculateRSI(priceData.prices, indicators.rsi.period || 14)
        const overbought = indicators.rsi.overbought || 70
        const oversold = indicators.rsi.oversold || 30

        let signal: "buy" | "sell" | "neutral" = "neutral"
        let strength = 0

        if (rsi < oversold) {
          signal = "buy"
          strength = Math.abs(rsi - 30) / 30
          buySignals++
        } else if (rsi > overbought) {
          signal = "sell"
          strength = Math.abs(rsi - 70) / 30
          sellSignals++
        }

        components.rsi = {
          indicator: "rsi",
          symbol,
          value: rsi,
          signal,
          strength,
          timestamp: Date.now(),
        }

        totalStrength += strength
      }

      // MACD evaluation
      if (indicators.macd?.enabled) {
        const macd = this.calculateMACD(priceData.prices)

        let signal: "buy" | "sell" | "neutral" = "neutral"
        let strength = 0.5

        if (macd.histogram > 0 && macd.macd > macd.signal) {
          signal = "buy"
          buySignals++
        } else if (macd.histogram < 0 && macd.macd < macd.signal) {
          signal = "sell"
          sellSignals++
        }

        components.macd = {
          indicator: "macd",
          symbol,
          value: macd.histogram,
          signal,
          strength,
          timestamp: Date.now(),
        }

        totalStrength += strength
      }

      // Bollinger Bands evaluation
      if (indicators.bollinger?.enabled) {
        const bands = this.calculateBollingerBands(priceData.prices, indicators.bollinger.period || 20, indicators.bollinger.stdDev || 2)
        const currentPrice = priceData.prices[priceData.prices.length - 1]

        let signal: "buy" | "sell" | "neutral" = "neutral"
        let strength = 0.5

        if (currentPrice < bands.lower) {
          signal = "buy"
          buySignals++
        } else if (currentPrice > bands.upper) {
          signal = "sell"
          sellSignals++
        }

        components.bollinger = {
          indicator: "bollinger",
          symbol,
          value: currentPrice,
          signal,
          strength,
          timestamp: Date.now(),
        }

        totalStrength += strength
      }

      // ATR evaluation (volatility)
      if (indicators.atr?.enabled) {
        const atr = this.calculateATR(priceData.prices, priceData.volumes, indicators.atr.period || 14)

        const signal: "buy" | "sell" | "neutral" = atr.volatility > 2 ? "neutral" : "buy" // Low volatility = good entry
        const strength = atr.volatility < 2 ? 0.5 : 0.2

        components.atr = {
          indicator: "atr",
          symbol,
          value: atr.atr,
          signal,
          strength,
          timestamp: Date.now(),
        }

        totalStrength += strength
      }

      // Determine overall signal
      const avgStrength = Object.keys(components).length > 0 ? totalStrength / Object.keys(components).length : 0
      let finalSignal: "buy" | "sell" | "neutral" = "neutral"

      if (buySignals > sellSignals && buySignals > 0) {
        finalSignal = "buy"
      } else if (sellSignals > buySignals && sellSignals > 0) {
        finalSignal = "sell"
      }

      console.log(`[v0] [IndicatorCalculator] Signal evaluated for ${symbol}: ${finalSignal} (strength=${avgStrength})`)

      return {
        signal: finalSignal,
        strength: Math.round(avgStrength * 100) / 100,
        components,
      }
    } catch (error) {
      console.error(`[v0] [IndicatorCalculator] Failed to evaluate signals:`, error)
      return { signal: "neutral", strength: 0, components }
    }
  }
}

// Export singleton
export const indicatorCalculator = new IndicatorCalculator()
