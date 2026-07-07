/**
 * Position Threshold Manager
 * Maintains database length limits (mostly 250 positions) per type/configuration
 * Implements FIFO and performance-based pruning strategies
 */

import { initRedis, getSettings, setSettings } from "@/lib/redis-db"
import { query } from "@/lib/db"

export interface PositionThresholdConfig {
  maxPositionsPerSymbol: number // 250 per symbol
  maxPositionsPerType: number // 250 per type (base, main, real, live)
  maxPositionsPerConnection: number // 1000 total
  pruneStrategy: "fifo" | "performance" | "hybrid" // How to prune when over limit
  performanceMetric: "profitFactor" | "winRate" | "sharpe" // Which metric to use for performance pruning
}

export class PositionThresholdManager {
  private connectionId: string
  private config: PositionThresholdConfig = {
    maxPositionsPerSymbol: 250,
    maxPositionsPerType: 250,
    maxPositionsPerConnection: 1000,
    pruneStrategy: "hybrid", // Use performance-based pruning, fall back to FIFO if needed
    performanceMetric: "profitFactor"
  }

  constructor(connectionId: string, config?: Partial<PositionThresholdConfig>) {
    this.connectionId = connectionId
    if (config) {
      this.config = { ...this.config, ...config }
    }
  }

  /**
   * Enforce position limits for a specific symbol and type
   * Prunes excess positions based on strategy (FIFO, performance, hybrid)
   */
  async enforceThresholds(symbol: string, strategyType: "base" | "main" | "real" | "live"): Promise<{ pruned: number; remaining: number }> {
    try {
      // Get current positions count
      const key = `positions:${this.connectionId}:${symbol}:${strategyType}`
      const stored = await getSettings(key)
      const positions = stored?.positions || []
      
      if (positions.length <= this.config.maxPositionsPerType) {
        return { pruned: 0, remaining: positions.length }
      }

      // Need to prune
      const excessCount = positions.length - this.config.maxPositionsPerType
      const prunedPositions = await this.prunePositions(positions, excessCount)

      // Update Redis with pruned list
      await setSettings(key, { positions: prunedPositions, count: prunedPositions.length, lastPruned: new Date() })

      console.log(`[v0] [PositionThreshold] ${symbol}:${strategyType}: Pruned ${excessCount} positions, remaining=${prunedPositions.length}`)
      
      return { pruned: excessCount, remaining: prunedPositions.length }
    } catch (error) {
      console.error(`[v0] [PositionThreshold] Error enforcing thresholds for ${symbol}:${strategyType}:`, error)
      return { pruned: 0, remaining: 0 }
    }
  }

  /**
   * Prune positions using configured strategy
   */
  private async prunePositions(positions: any[], targetRemoveCount: number): Promise<any[]> {
    if (this.config.pruneStrategy === "fifo") {
      // Remove oldest positions first
      return positions.slice(targetRemoveCount)
    } else if (this.config.pruneStrategy === "performance") {
      // Remove lowest performing positions
      const sorted = positions.sort((a, b) => {
        const metricA = a[this.config.performanceMetric] || 0
        const metricB = b[this.config.performanceMetric] || 0
        return metricB - metricA // Sort descending (highest performance first)
      })
      return sorted.slice(0, positions.length - targetRemoveCount)
    } else {
      // Hybrid: Try performance pruning, but ensure we keep recent high-performers
      const performanceScore = positions.map(p => ({
        position: p,
        score: (p[this.config.performanceMetric] || 0) + ((new Date(p.created).getTime() - Date.now()) / 86400000) * 0.1 // Recent bonus
      }))
      
      const sorted = performanceScore.sort((a, b) => b.score - a.score)
      return sorted.slice(0, positions.length - targetRemoveCount).map(s => s.position)
    }
  }

  /**
   * Check and enforce all thresholds for a connection
   */
  async enforceAllThresholds(): Promise<{ totalPruned: number; remaining: number }> {
    try {
      let totalPruned = 0
      let totalRemaining = 0

      // Get all unique symbols for this connection
      const symbolsKey = `symbols:${this.connectionId}`
      const symbolsStored = await getSettings(symbolsKey)
      const symbols = symbolsStored?.symbols || []

      // Enforce limits for each symbol and type combination
      for (const symbol of symbols) {
        for (const type of ["base", "main", "real", "live"] as const) {
          const result = await this.enforceThresholds(symbol, type)
          totalPruned += result.pruned
          totalRemaining += result.remaining
        }
      }

      return { totalPruned, remaining: totalRemaining }
    } catch (error) {
      console.error(`[v0] [PositionThreshold] Error enforcing all thresholds:`, error)
      return { totalPruned: 0, remaining: 0 }
    }
  }

  /**
   * Get current position counts per type
   */
  async getPositionCounts(symbol: string): Promise<Record<string, number>> {
    try {
      const counts: Record<string, number> = {}

      for (const type of ["base", "main", "real", "live"] as const) {
        const key = `positions:${this.connectionId}:${symbol}:${type}`
        const stored = await getSettings(key)
        counts[type] = stored?.positions?.length || 0
      }

      return counts
    } catch (error) {
      console.error(`[v0] [PositionThreshold] Error getting position counts:`, error)
      return { base: 0, main: 0, real: 0, live: 0 }
    }
  }
}
