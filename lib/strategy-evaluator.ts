/**
 * Strategy Evaluator
 * Base/Main/Real stage processing with independent metrics tracking
 */

import { getRedisClient, getSettings, setSettings } from "@/lib/redis-db"
import { EngineProgressManager, getProgressManager } from "./engine-progress-manager"

export interface StrategyResult {
  id: string
  stage: 'base' | 'main' | 'real'
  symbol: string
  timestamp: string
  profitFactor: number
  drawdownTime: number // minutes
  winRate: number
  totalTrades: number
  passed: boolean
  confidence: number
  parameters: Record<string, any>
}

export interface StrategyStageStats {
  stage: 'base' | 'main' | 'real'
  setsCount: number
  evaluated: number
  passed: number
  failed: number
  passRate: number
  avgProfitFactor: number
  avgDrawdownTime: number
  avgWinRate: number
  avgConfidence: number
  symbols: Record<string, number>
}

export class StrategyEvaluator {
  private connectionId: string
  private progressManager: EngineProgressManager
  private stageStats: Map<string, StrategyStageStats> = new Map()

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.progressManager = getProgressManager(connectionId)
    this.initializeStageStats()
  }

  private initializeStageStats(): void {
    for (const stage of ['base', 'main', 'real'] as const) {
      this.stageStats.set(stage, {
        stage,
        setsCount: 0,
        evaluated: 0,
        passed: 0,
        failed: 0,
        passRate: 0,
        avgProfitFactor: 0,
        avgDrawdownTime: 0,
        avgWinRate: 0,
        avgConfidence: 0,
        symbols: {},
      })
    }
  }

  /**
   * Evaluate a strategy result and update metrics
   */
  async evaluateStrategy(result: StrategyResult): Promise<void> {
    // Update stage stats
    this.updateStageStats(result)
    
    // Store in Redis
    await this.storeStrategyResult(result)
    
    // Update progress manager
    await this.updateProgressManager()
    
    // Log evaluation
    await this.progressManager.incrementStrategyCycle(result.symbol)
  }

  /**
   * Evaluate multiple strategies in batch
   */
  async evaluateBatch(results: StrategyResult[]): Promise<void> {
    const stageGroups = new Map<string, StrategyResult[]>()
    
    for (const r of results) {
      if (!stageGroups.has(r.stage)) {
        stageGroups.set(r.stage, [])
      }
      stageGroups.get(r.stage)!.push(r)
    }

    for (const [stage, group] of stageGroups) {
      for (const r of group) {
        await this.evaluateStrategy(r)
      }
    }
  }

  /**
   * Get statistics for a specific stage
   */
  getStageStats(stage: 'base' | 'main' | 'real'): StrategyStageStats | undefined {
    return this.stageStats.get(stage)
  }

  /**
   * Get all stage statistics
   */
  getAllStageStats(): Map<string, StrategyStageStats> {
    return this.stageStats
  }

  /**
   * Get comprehensive summary
   */
  getSummary(): {
    totalEvaluated: number
    overallPassRate: number
    avgProfitFactor: number
    avgDrawdownTime: number
    stages: Array<{
      stage: string
      setsCount: number
      evaluated: number
      passed: number
      failed: number
      passRate: number
      avgProfitFactor: number
      avgDrawdownTime: number
      avgWinRate: number
      avgConfidence: number
    }>
  } {
    let totalEvaluated = 0
    let totalPassed = 0
    let totalPF = 0
    let totalDDT = 0

    const stages: Array<{
      stage: string
      setsCount: number
      evaluated: number
      passed: number
      failed: number
      passRate: number
      avgProfitFactor: number
      avgDrawdownTime: number
      avgWinRate: number
      avgConfidence: number
    }> = []

    for (const [stage, stats] of this.stageStats) {
      totalEvaluated += stats.evaluated
      totalPassed += stats.passed
      totalPF += stats.avgProfitFactor * stats.evaluated
      totalDDT += stats.avgDrawdownTime * stats.evaluated

      stages.push({
        stage,
        setsCount: stats.setsCount,
        evaluated: stats.evaluated,
        passed: stats.passed,
        failed: stats.failed,
        passRate: stats.passRate,
        avgProfitFactor: stats.avgProfitFactor,
        avgDrawdownTime: stats.avgDrawdownTime,
        avgWinRate: stats.avgWinRate,
        avgConfidence: stats.avgConfidence,
      })
    }

    return {
      totalEvaluated,
      overallPassRate: totalEvaluated > 0 ? (totalPassed / totalEvaluated) * 100 : 0,
      avgProfitFactor: totalEvaluated > 0 ? totalPF / totalEvaluated : 0,
      avgDrawdownTime: totalEvaluated > 0 ? totalDDT / totalEvaluated : 0,
      stages,
    }
  }

  /**
   * Update stage statistics for a strategy result
   */
  private updateStageStats(result: StrategyResult): void {
    const stats = this.stageStats.get(result.stage)
    if (!stats) return

    stats.evaluated++
    if (result.passed) {
      stats.passed++
    } else {
      stats.failed++
    }
    stats.passRate = (stats.passed / stats.evaluated) * 100
    stats.avgProfitFactor = ((stats.avgProfitFactor * (stats.evaluated - 1)) + result.profitFactor) / stats.evaluated
    stats.avgDrawdownTime = ((stats.avgDrawdownTime * (stats.evaluated - 1)) + result.drawdownTime) / stats.evaluated
    stats.avgWinRate = ((stats.avgWinRate * (stats.evaluated - 1)) + result.winRate) / stats.evaluated
    stats.avgConfidence = ((stats.avgConfidence * (stats.evaluated - 1)) + result.confidence) / stats.evaluated

    if (!stats.symbols[result.symbol]) {
      stats.symbols[result.symbol] = 0
    }
    stats.symbols[result.symbol]++
  }

  /**
   * Update progress manager with current stats
   */
  private async updateProgressManager(): Promise<void> {
    for (const stage of ['base', 'main', 'real'] as const) {
      const stats = this.stageStats.get(stage)!
      await this.progressManager.updateStrategyMetrics(
        stage,
        stats.setsCount,
        stats.evaluated,
        stats.passed,
        stats.failed,
        stats.avgProfitFactor,
        stats.avgDrawdownTime
      )
    }
  }

  /**
   * Store strategy result in Redis
   */
  private async storeStrategyResult(result: StrategyResult): Promise<void> {
    // DEV-MODE BYPASS: strategies:{conn}:{symbol} lists store up to 500 full
    // StrategyResult JSON objects (~2 KB each) per symbol per evaluation cycle.
    // At 20 symbols × 500 items × 2 KB = 20 MB of list data churning in the
    // InlineLocalRedis Map every cycle, OOM-killing the dev server.
    // StrategyEvaluator is not used by the core engine pipeline — only by
    // metrics-aggregator for historical querying — so these lists are safe to
    // skip in dev where cross-restart persistence is not required.
    if (process.env.NODE_ENV === "development") return
    try {
      const client = getRedisClient()
      
      // Store in stage-specific list
      const stageKey = `strategies:${this.connectionId}:${result.stage}`
      await client.lpush(stageKey, JSON.stringify(result))
      await client.ltrim(stageKey, 0, 999) // Keep last 1000 per stage

      // Store in symbol-specific list
      const symbolKey = `strategies:${this.connectionId}:${result.symbol}`
      await client.lpush(symbolKey, JSON.stringify(result))
      await client.ltrim(symbolKey, 0, 499) // Keep last 500 per symbol

      // Update sets count
      const setsKey = `strategies:${this.connectionId}:sets:${result.stage}`
      await client.incr(setsKey)
      const count = await client.get(setsKey)
      const setsCount = count ? parseInt(count as string, 10) : 0
      const stats = this.stageStats.get(result.stage)
      if (stats) {
        stats.setsCount = setsCount
      }

    } catch (error) {
      await this.progressManager.addError(
        'strategy_store',
        error instanceof Error ? error.message : 'Failed to store strategy result',
        result.symbol
      )
    }
  }

  /**
   * Get recent results by stage
   */
  async getRecentByStage(stage: 'base' | 'main' | 'real', limit: number = 50): Promise<StrategyResult[]> {
    try {
      const client = getRedisClient()
      const key = `strategies:${this.connectionId}:${stage}`
      const data = await client.lrange(key, 0, limit - 1)
      return data.map(d => JSON.parse(d as string))
    } catch (error) {
      return []
    }
  }

  /**
   * Get recent results by symbol
   */
  async getRecentBySymbol(symbol: string, limit: number = 50): Promise<StrategyResult[]> {
    try {
      const client = getRedisClient()
      const key = `strategies:${this.connectionId}:${symbol}`
      const data = await client.lrange(key, 0, limit - 1)
      return data.map(d => JSON.parse(d as string))
    } catch (error) {
      return []
    }
  }

  /**
   * Reset all statistics
   */
  reset(): void {
    this.initializeStageStats()
  }
}
