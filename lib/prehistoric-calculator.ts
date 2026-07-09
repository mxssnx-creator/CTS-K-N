/**
 * Prehistoric Calculator
 * Calculates technical indicators and processes historical data for indications and strategies
 */

import { getRedisClient } from "@/lib/redis-db"
import { EngineProgressManager, getProgressManager } from "./engine-progress-manager"
import { EngineLogger, getEngineLogger } from "./engine-logger"

export interface CandleData {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface IndicatorResult {
  type: string
  value: number
  signal: 'buy' | 'sell' | 'neutral'
  confidence: number
  strength: number
  parameters: Record<string, any>
}

export interface PrehistoricCalculationResult {
  symbol: string
  candlesProcessed: number
  indicatorsCalculated: number
  duration: number // ms
  errors: number
  results: IndicatorResult[]
}

export class PrehistoricCalculator {
  private connectionId: string
  private progressManager: EngineProgressManager
  private logger: EngineLogger

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.progressManager = getProgressManager(connectionId)
    this.logger = getEngineLogger(connectionId)
  }

  /**
   * Process prehistoric data for a symbol
   */
  async processSymbol(symbol: string, candles?: CandleData[]): Promise<PrehistoricCalculationResult> {
    const startTime = Date.now()
    let errors = 0
    const results: IndicatorResult[] = []

    if (!candles || candles.length === 0) {
      const client = getRedisClient()
      const raw = await client.lrange(`prehistoric:${this.connectionId}:${symbol}:candles`, 0, -1)
      candles = raw.map(r => JSON.parse(r))
    }

    await this.logger.logPrehistoric(symbol, `Processing ${candles.length} candles...`)

    try {
      // Update Redis with prehistoric progress tracking
      const client = getRedisClient()
      if (client) {
        await client.hset(`prehistoric:${this.connectionId}`, {
          current_symbol: symbol,
          candles_total: candles.length.toString(),
          start_time: startTime.toString(),
        })
      }

      // Calculate all indicators for each candle
      for (let i = 0; i < candles.length; i++) {
        const candle = candles[i]
        const previousCandles = candles.slice(0, i)

        // Calculate indicators
        const indicators = await this.calculateIndicators(candle, previousCandles)
        results.push(...indicators)

        // Store calculated data
        await this.storeCalculatedData(symbol, candle, indicators)

        // Update progress every 10 candles
        if (i % 10 === 0 && client) {
          await client.hset(`prehistoric:${this.connectionId}`, {
            candles_loaded: (i + 1).toString(),
            indicators_calculated: results.length.toString(),
            duration: (Date.now() - startTime).toString(),
          })
        }
      }

      const duration = Date.now() - startTime

      // Update final progress
      if (client) {
        await client.hset(`prehistoric:${this.connectionId}`, {
          candles_loaded: candles.length.toString(),
          indicators_calculated: results.length.toString(),
          duration: duration.toString(),
        })
      }

      await this.progressManager.updateSymbolPrehistoric(
        symbol,
        candles.length,
        errors,
        duration,
        true
      )

      await this.logger.logPrehistoric(symbol, `✓ Processed ${candles.length} candles, ${results.length} indicators in ${duration}ms`, {
        candles: candles.length,
        indicators: results.length,
        duration,
      })

      return {
        symbol,
        candlesProcessed: candles.length,
        indicatorsCalculated: results.length,
        duration,
        errors,
        results,
      }
    } catch (error) {
      errors++
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      await this.progressManager.addError('prehistoric_calc', errorMessage, symbol)
      await this.logger.logError(symbol, 'prehistoric_calc', errorMessage, error instanceof Error ? error : undefined)

      return {
        symbol,
        candlesProcessed: 0,
        indicatorsCalculated: 0,
        duration: Date.now() - startTime,
        errors,
        results: [],
      }
    }
  }

  /**
   * Calculate technical indicators for a candle
   */
  private async calculateIndicators(candle: CandleData, previousCandles: CandleData[]): Promise<IndicatorResult[]> {
    const indicators: IndicatorResult[] = []

    // RSI
    if (previousCandles.length >= 14) {
      const rsi = this.calculateRSI(previousCandles.slice(-14).concat([candle]))
      indicators.push({
        type: 'rsi',
        value: rsi,
        signal: rsi < 30 ? 'buy' : rsi > 70 ? 'sell' : 'neutral',
        confidence: Math.abs(rsi - 50) / 50,
        strength: Math.abs(rsi - 50) / 50,
        parameters: { period: 14 },
      })
    }

    // MACD
    if (previousCandles.length >= 26) {
      const macd = this.calculateMACD(previousCandles.slice(-26).concat([candle]))
      indicators.push({
        type: 'macd',
        value: macd.histogram,
        signal: macd.histogram > 0 ? 'buy' : macd.histogram < 0 ? 'sell' : 'neutral',
        confidence: Math.abs(macd.histogram) / (Math.abs(macd.macd) + 0.0001),
        strength: Math.abs(macd.histogram) / (Math.abs(macd.macd) + 0.0001),
        parameters: { fast: 12, slow: 26, signal: 9 },
      })
    }

    // Bollinger Bands
    if (previousCandles.length >= 20) {
      const bb = this.calculateBollingerBands(previousCandles.slice(-20).concat([candle]))
      indicators.push({
        type: 'bollinger',
        value: bb.percentB,
        signal: bb.percentB < 0 ? 'buy' : bb.percentB > 1 ? 'sell' : 'neutral',
        confidence: Math.abs(bb.percentB - 0.5) * 2,
        strength: Math.abs(bb.percentB - 0.5) * 2,
        parameters: { period: 20, stdDev: 2 },
      })
    }

    // EMA
    if (previousCandles.length >= 12) {
      const ema = this.calculateEMA(previousCandles.slice(-12).concat([candle]), 12)
      indicators.push({
        type: 'ema',
        value: ema,
        signal: candle.close > ema ? 'buy' : candle.close < ema ? 'sell' : 'neutral',
        confidence: Math.abs(candle.close - ema) / ema,
        strength: Math.abs(candle.close - ema) / ema,
        parameters: { period: 12 },
      })
    }

    // SMA
    if (previousCandles.length >= 20) {
      const sma = this.calculateSMA(previousCandles.slice(-20).concat([candle]), 20)
      indicators.push({
        type: 'sma',
        value: sma,
        signal: candle.close > sma ? 'buy' : candle.close < sma ? 'sell' : 'neutral',
        confidence: Math.abs(candle.close - sma) / sma,
        strength: Math.abs(candle.close - sma) / sma,
        parameters: { period: 20 },
      })
    }

    // Stochastic
    if (previousCandles.length >= 14) {
      const stoch = this.calculateStochastic(previousCandles.slice(-14).concat([candle]))
      indicators.push({
        type: 'stochastic',
        value: stoch.k,
        signal: stoch.k < 20 ? 'buy' : stoch.k > 80 ? 'sell' : 'neutral',
        confidence: Math.abs(stoch.k - 50) / 50,
        strength: Math.abs(stoch.k - 50) / 50,
        parameters: { kPeriod: 14, dPeriod: 3 },
      })
    }

    // ATR
    if (previousCandles.length >= 14) {
      const atr = this.calculateATR(previousCandles.slice(-14).concat([candle]))
      indicators.push({
        type: 'atr',
        value: atr,
        signal: 'neutral',
        confidence: 0.5,
        strength: atr / candle.close,
        parameters: { period: 14 },
      })
    }

    return indicators
  }

  /**
   * Store calculated data in Redis
   */
  private async storeCalculatedData(symbol: string, candle: CandleData, indicators: IndicatorResult[]): Promise<void> {
    try {
      const client = getRedisClient()

      // Store candle data
      const candleKey = `prehistoric:${this.connectionId}:${symbol}:candles`
      await client.lpush(candleKey, JSON.stringify(candle))
      await client.ltrim(candleKey, 0, 4999) // Keep last 5000 candles

      // Store indicator results
      for (const indicator of indicators) {
        const indicatorKey = `prehistoric:${this.connectionId}:${symbol}:indicators:${indicator.type}`
        await client.lpush(indicatorKey, JSON.stringify({
          ...indicator,
          timestamp: candle.timestamp,
        }))
        await client.ltrim(indicatorKey, 0, 999) // Keep last 1000 per indicator
      }

    } catch (error) {
      console.error(`[PrehistoricCalc] Failed to store data for ${symbol}:`, error)
    }
  }

  /**
   * RSI Calculation
   */
  private calculateRSI(candles: CandleData[]): number {
    const period = 14
    if (candles.length < period + 1) return 50

    let gains = 0
    let losses = 0

    for (let i = 1; i < candles.length; i++) {
      const change = candles[i].close - candles[i - 1].close
      if (change > 0) gains += change
      else losses += Math.abs(change)
    }

    const avgGain = gains / period
    const avgLoss = losses / period

    if (avgLoss === 0) return 100
    const rs = avgGain / avgLoss
    return 100 - (100 / (1 + rs))
  }

  /**
   * MACD Calculation
   */
  private calculateMACD(candles: CandleData[]): { macd: number; signal: number; histogram: number } {
    const ema12 = this.calculateEMA(candles, 12)
    const ema26 = this.calculateEMA(candles, 26)
    const macd = ema12 - ema26

    // Simplified signal line
    const signal = macd * 0.9 // Approximation
    const histogram = macd - signal

    return { macd, signal, histogram }
  }

  /**
   * Bollinger Bands Calculation
   */
  private calculateBollingerBands(candles: CandleData[]): { upper: number; middle: number; lower: number; percentB: number } {
    const period = 20
    const closes = candles.slice(-period).map(c => c.close)
    const sma = closes.reduce((a, b) => a + b, 0) / period
    const stdDev = Math.sqrt(closes.reduce((sum, c) => sum + Math.pow(c - sma, 2), 0) / period)

    const upper = sma + (stdDev * 2)
    const lower = sma - (stdDev * 2)
    const percentB = (candles[candles.length - 1].close - lower) / (upper - lower)

    return { upper, middle: sma, lower, percentB }
  }

  /**
   * EMA Calculation
   */
  private calculateEMA(candles: CandleData[], period: number): number {
    const multiplier = 2 / (period + 1)
    let ema = candles[0].close

    for (let i = 1; i < candles.length; i++) {
      ema = (candles[i].close - ema) * multiplier + ema
    }

    return ema
  }

  /**
   * SMA Calculation
   */
  private calculateSMA(candles: CandleData[], period: number): number {
    const closes = candles.slice(-period).map(c => c.close)
    return closes.reduce((a, b) => a + b, 0) / period
  }

  /**
   * Stochastic Calculation
   */
  private calculateStochastic(candles: CandleData[]): { k: number; d: number } {
    const period = 14
    const recent = candles.slice(-period)
    const high = Math.max(...recent.map(c => c.high))
    const low = Math.min(...recent.map(c => c.low))
    const close = candles[candles.length - 1].close

    const k = high !== low ? ((close - low) / (high - low)) * 100 : 50
    const d = k // Simplified

    return { k, d }
  }

  /**
   * ATR Calculation
   */
  private calculateATR(candles: CandleData[]): number {
    const period = 14
    let atr = 0

    for (let i = 1; i < candles.length; i++) {
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      )
      atr += tr
    }

    return atr / period
  }
}
