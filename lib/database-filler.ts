/**
 * Database Filler
 * Fills Redis sets and hashes with processed data from prehistoric calculations,
 * indications, and strategies
 */

import { getRedisClient } from "@/lib/redis-db"
import { EngineProgressManager, getProgressManager } from "./engine-progress-manager"
import { EngineLogger, getEngineLogger } from "./engine-logger"
import { CandleData, IndicatorResult } from "./prehistoric-calculator"
import { IndicationResult } from "./indication-evaluator"
import { StrategyResult } from "./strategy-evaluator"

export interface DatabaseFillStats {
  symbolsProcessed: number
  candlesStored: number
  indicationsStored: number
  strategiesStored: number
  setsCreated: number
  hashesCreated: number
  errors: number
  duration: number
}

export class DatabaseFiller {
  private connectionId: string
  private progressManager: EngineProgressManager
  private logger: EngineLogger

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.progressManager = getProgressManager(connectionId)
    this.logger = getEngineLogger(connectionId)
  }

  /**
   * Fill database with prehistoric calculation results
   */
  async fillPrehistoricData(symbol: string, candles: CandleData[], indicators: IndicatorResult[]): Promise<void> {
    try {
      const client = getRedisClient()

      // Store candles in sorted set (by timestamp)
      const candleKey = `prehistoric:${this.connectionId}:${symbol}:candles`
      for (const candle of candles) {
        await client.zadd(candleKey, candle.timestamp, JSON.stringify(candle))
      }

      // Store indicators by type in separate lists
      const indicatorByType = new Map<string, IndicatorResult[]>()
      for (const ind of indicators) {
        if (!indicatorByType.has(ind.type)) {
          indicatorByType.set(ind.type, [])
        }
        indicatorByType.get(ind.type)!.push(ind)
      }

      for (const [type, typeIndicators] of indicatorByType) {
        const key = `prehistoric:${this.connectionId}:${symbol}:indicators:${type}`
        for (const ind of typeIndicators) {
          await client.lpush(key, JSON.stringify(ind))
        }
        await client.ltrim(key, 0, 9999) // Keep last 10k per type
      }

      // Create summary hash
      const summaryKey = `prehistoric:${this.connectionId}:${symbol}:summary`
      await client.hset(summaryKey, {
        symbol,
        candlesCount: candles.length.toString(),
        indicatorsCount: indicators.length.toString(),
        typesCount: indicatorByType.size.toString(),
        lastUpdate: new Date().toISOString(),
      })

      // Add to symbols set
      await client.sadd(`prehistoric:${this.connectionId}:symbols`, symbol)

      await this.logger.logPrehistoric(symbol, `✓ Database filled: ${candles.length} candles, ${indicators.length} indicators`)
    } catch (error) {
      await this.progressManager.addError('db_fill', error instanceof Error ? error.message : 'Failed to fill prehistoric data', symbol)
    }
  }

  /**
   * Fill database with indication results
   */
  async fillIndications(symbol: string, indications: IndicationResult[]): Promise<void> {
    try {
      const client = getRedisClient()

      // Store by type
      const byType = new Map<string, IndicationResult[]>()
      for (const ind of indications) {
        if (!byType.has(ind.type)) {
          byType.set(ind.type, [])
        }
        byType.get(ind.type)!.push(ind)
      }

      for (const [type, typeInds] of byType) {
        const key = `indications:${this.connectionId}:${symbol}:${type}`
        for (const ind of typeInds) {
          await client.lpush(key, JSON.stringify(ind))
        }
        // Cap at 1000 (down from 5000) — dashboard reads at most ~50 at a
        // time and these lists explode under prehistoric (one entry per
        // candle × per type). Lower cap shrinks the in-memory snapshot
        // without affecting any consumer behaviour.
        await client.ltrim(key, 0, 999)
        // 24h TTL: prehistoric per-symbol×type fills are diagnostic only,
        // never durable state. Without the TTL, cancelled/abandoned
        // symbols leak forever.
        await client.expire(key, 86400).catch(() => 0)
      }

      // Store in overall symbol list
      const symbolKey = `indications:${this.connectionId}:${symbol}`
      for (const ind of indications) {
        await client.lpush(symbolKey, JSON.stringify(ind))
      }
      await client.ltrim(symbolKey, 0, 1999) // 2k cap (down from 10k)
      await client.expire(symbolKey, 86400).catch(() => 0)

      // Update indication counts hash
      const countsKey = `indications:${this.connectionId}:counts`
      for (const [type, typeInds] of byType) {
        await client.hincrby(countsKey, type, typeInds.length)
      }
      await client.hincrby(countsKey, 'total', indications.length)

      await this.logger.logPrehistoric(symbol, `✓ Indications filled: ${indications.length} total, ${byType.size} types`)
    } catch (error) {
      await this.progressManager.addError('db_fill', error instanceof Error ? error.message : 'Failed to fill indications', symbol)
    }
  }

  /**
   * Fill database with strategy results
   */
  async fillStrategies(symbol: string, strategies: StrategyResult[]): Promise<void> {
    try {
      const client = getRedisClient()

      // Store by stage
      const byStage = new Map<string, StrategyResult[]>()
      for (const strat of strategies) {
        if (!byStage.has(strat.stage)) {
          byStage.set(strat.stage, [])
        }
        byStage.get(strat.stage)!.push(strat)
      }

      for (const [stage, stageStrats] of byStage) {
        const key = `strategies:${this.connectionId}:${symbol}:${stage}`
        for (const strat of stageStrats) {
          await client.lpush(key, JSON.stringify(strat))
        }
        await client.ltrim(key, 0, 999) // 1k cap (down from 5k); see indications block above
        await client.expire(key, 86400).catch(() => 0)
      }

      // Store in overall symbol list
      const symbolKey = `strategies:${this.connectionId}:${symbol}`
      for (const strat of strategies) {
        await client.lpush(symbolKey, JSON.stringify(strat))
      }
      await client.ltrim(symbolKey, 0, 1999) // 2k cap (down from 10k)
      await client.expire(symbolKey, 86400).catch(() => 0)

      // Update strategy counts hash
      const countsKey = `strategies:${this.connectionId}:counts`
      for (const [stage, stageStrats] of byStage) {
        await client.hincrby(countsKey, stage, stageStrats.length)
      }
      await client.hincrby(countsKey, 'total', strategies.length)

      await this.logger.logPrehistoric(symbol, `✓ Strategies filled: ${strategies.length} total, ${byStage.size} stages`)
    } catch (error) {
      await this.progressManager.addError('db_fill', error instanceof Error ? error.message : 'Failed to fill strategies', symbol)
    }
  }

  /**
   * Create indexes for fast querying
   */
  async createIndexes(symbols: string[]): Promise<void> {
    try {
      const client = getRedisClient()

      // Create symbol index — single SADD with variadic members so N
      // symbols equals 1 Redis round-trip instead of N sequential
      // awaits. Both ioredis and node-redis support `sadd(key, ...members)`.
      const symbolKey = `engine:${this.connectionId}:symbols`
      const progressionKey = `engine:${this.connectionId}:progression`
      await Promise.all([
        symbols.length > 0
          ? (client as any).sadd(symbolKey, ...symbols)
          : Promise.resolve(0),
        client.hset(progressionKey, {
          symbolsCount: symbols.length.toString(),
          lastUpdate: new Date().toISOString(),
        }),
      ])

      await this.logger.logSystem(`✓ Created indexes for ${symbols.length} symbols`)
    } catch (error) {
      await this.progressManager.addError('db_index', error instanceof Error ? error.message : 'Failed to create indexes')
    }
  }

  /**
   * Fill complete database for a symbol
   */
  async fillCompleteSymbolData(
    symbol: string,
    candles: CandleData[],
    indicators: IndicatorResult[],
    indicationResults: IndicationResult[],
    strategyResults: StrategyResult[]
  ): Promise<DatabaseFillStats> {
    const startTime = Date.now()
    let errors = 0

    try {
      await this.fillPrehistoricData(symbol, candles, indicators)
      await this.fillIndications(symbol, indicationResults)
      await this.fillStrategies(symbol, strategyResults)

      return {
        symbolsProcessed: 1,
        candlesStored: candles.length,
        indicationsStored: indicationResults.length,
        strategiesStored: strategyResults.length,
        setsCreated: 3,
        hashesCreated: 3,
        errors: 0,
        duration: Date.now() - startTime,
      }
    } catch (error) {
      errors++
      return {
        symbolsProcessed: 0,
        candlesStored: 0,
        indicationsStored: 0,
        strategiesStored: 0,
        setsCreated: 0,
        hashesCreated: 0,
        errors,
        duration: Date.now() - startTime,
      }
    }
  }

  /**
   * Get fill statistics
   */
  async getFillStats(): Promise<{
    symbolsCount: number
    totalCandles: number
    totalIndications: number
    totalStrategies: number
    lastUpdate: string | null
  }> {
    try {
      const client = getRedisClient()

      const symbolsCount = await client.scard(`engine:${this.connectionId}:symbols`)
      const summaryKey = `engine:${this.connectionId}:progression`
      const summary = await client.hgetall(summaryKey)

      return {
        symbolsCount,
        totalCandles: parseInt(summary?.totalCandles || '0', 10),
        totalIndications: parseInt(summary?.totalIndications || '0', 10),
        totalStrategies: parseInt(summary?.totalStrategies || '0', 10),
        lastUpdate: summary?.lastUpdate || null,
      }
    } catch (error) {
      return {
        symbolsCount: 0,
        totalCandles: 0,
        totalIndications: 0,
        totalStrategies: 0,
        lastUpdate: null,
      }
    }
  }
}
