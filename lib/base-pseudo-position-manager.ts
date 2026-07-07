/**
 * Base Pseudo Position Manager
 * Manages UNLIMITED configuration sets, each with up to 250 database entries
 * Each unique config (TP/SL/Trailing) creates its own independent set
 * Volume calculations removed - Base level uses COUNT and RATIOS only
 * Volume is calculated exclusively at Exchange level
 * NOW: Redis-based, no SQL
 */

import { getSettings, setSettings, getRedisClient } from "@/lib/redis-db"
import type { PerformanceThresholds } from "./types"
import { logProgressionEvent } from "./engine-progression-logs"

export class BasePseudoPositionManager {
  private connectionId: string
  private thresholds: PerformanceThresholds
  private databaseSizeLimit = 250

  constructor(connectionId: string, databaseSizeLimit?: number) {
    this.connectionId = connectionId
    this.databaseSizeLimit = databaseSizeLimit || 250
    this.thresholds = {
      initial_min_win_rate: 0.4,
      expanded_min_win_rate: 0.45,
      expanded_min_profit_ratio: 1.2,
      production_min_win_rate: 0.42,
      production_max_drawdown: 0.3,
      pause_threshold_win_rate: 0.38,
      resume_threshold_win_rate: 0.43,
    }
  }

  /**
   * Set database size limit from settings
   * Each configuration set has its OWN independent limit
   */
  setDatabaseSizeLimit(limit: number): void {
    this.databaseSizeLimit = limit
    console.log(`[v0] Base position database size limit set to ${limit}`)
  }

  /**
   * Get or create base position for a SPECIFIC configuration
   * Each unique config gets its own base position (unlimited)
   * Each base position can have up to 250 entries in pseudo_positions table
   */
  async getOrCreateBasePosition(
    symbol: string,
    indicationType: "direction" | "move" | "active" | "optimal" | "active_advanced",
    range: number,
    direction: "long" | "short",
    tpFactor: number,
    slRatio: number,
    trailingEnabled: boolean,
    trailStart: number | null,
    trailStop: number | null,
    drawdownRatio?: number,
    marketChangeRange?: number,
    lastPartRatio?: number,
  ): Promise<string | null> {
    try {
      // Load all base positions from Redis
      const basePositions = (await getSettings(`base_positions:${this.connectionId}`)) || []

      // Try to find existing base position for this EXACT configuration
      const configKey = this.generateConfigKey({
        symbol,
        indicationType,
        range,
        direction,
        tpFactor,
        slRatio,
        trailingEnabled,
        trailStart,
        trailStop,
        drawdownRatio,
        marketChangeRange,
        lastPartRatio,
      })

      const existing = basePositions.find((p: any) => p.config_key === configKey)

      if (existing) {
        if (existing.total_positions >= this.databaseSizeLimit) {
          console.log(`[v0] Base position ${existing.id} reached ${this.databaseSizeLimit} database entry limit`)
          return null
        }

        if (existing.status === "failed") {
          console.log(`[v0] Base position ${existing.id} has failed status`)
          return null
        }

        return existing.id
      }

      // Create new base position for this configuration
      return await this.createBasePosition(
        symbol,
        indicationType,
        range,
        direction,
        tpFactor,
        slRatio,
        trailingEnabled,
        trailStart,
        trailStop,
        drawdownRatio,
        marketChangeRange,
        lastPartRatio,
      )
    } catch (error) {
      console.error("[v0] Error in getOrCreateBasePosition:", error)
      return null
    }
  }

  /**
   * Create a new base pseudo position entry
   */
  private async createBasePosition(
    symbol: string,
    indicationType: "direction" | "move" | "active" | "optimal" | "active_advanced",
    range: number,
    direction: "long" | "short",
    tpFactor: number,
    slRatio: number,
    trailingEnabled: boolean,
    trailStart: number | null,
    trailStop: number | null,
    drawdownRatio?: number,
    marketChangeRange?: number,
    lastPartRatio?: number,
  ): Promise<string | null> {
    try {
      const basePositions = (await getSettings(`base_positions:${this.connectionId}`)) || []
      const positionId = `base:${this.connectionId}:${symbol}:${Date.now()}`

      const configKey = this.generateConfigKey({
        symbol,
        indicationType,
        range,
        direction,
        tpFactor,
        slRatio,
        trailingEnabled,
        trailStart,
        trailStop,
        drawdownRatio,
        marketChangeRange,
        lastPartRatio,
      })

      const newPosition = {
        id: positionId,
        connection_id: this.connectionId,
        symbol,
        indication_type: indicationType,
        indication_range: range,
        direction,
        takeprofit_factor: tpFactor,
        stoploss_ratio: slRatio,
        trailing_enabled: trailingEnabled,
        trail_start: trailStart,
        trail_stop: trailStop,
        drawdown_ratio: drawdownRatio || null,
        market_change_range: marketChangeRange || null,
        last_part_ratio: lastPartRatio || null,
        config_key: configKey,
        status: "evaluating",
        evaluation_count: 0,
        total_positions: 0,
        winning_positions: 0,
        losing_positions: 0,
        total_profit_loss: 0,
        max_drawdown: 0,
        win_rate: 0,
        avg_profit: 0,
        avg_loss: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      basePositions.push(newPosition)
      await setSettings(`base_positions:${this.connectionId}`, basePositions)

      console.log(
        `[v0] Created base position ${positionId} for ${symbol} ${indicationType} ${direction} TP=${tpFactor} SL=${slRatio} Trailing=${trailingEnabled}`,
      )
      
      // Log base pseudo position creation
      await logProgressionEvent(this.connectionId, "base_pseudo_created", "info", `Created base pseudo position for ${symbol}`, {
        symbol,
        indicationType,
        direction,
        tpFactor,
        slRatio,
        trailingEnabled,
        basePositionId: positionId,
      })
      
      // Update Redis counter for base pseudo positions
      try {
        const client = getRedisClient()
        await client.sadd(`base_pseudo:${this.connectionId}`, positionId)
        await client.sadd(`base_pseudo:${this.connectionId}:${indicationType}`, positionId)
      } catch { /* ignore Redis errors */ }
      
      return positionId
    } catch (error) {
      console.error("[v0] Error creating base position:", error)
      return null
    }
  }

  /**
   * Check if base position can create more test positions
   */
  async canCreatePosition(basePositionId: string): Promise<boolean> {
    try {
      const basePositions = (await getSettings(`base_positions:${this.connectionId}`)) || []
      const basePos = basePositions.find((p: any) => p.id === basePositionId)

      if (!basePos) return false

      if (basePos.status === "failed") return false

      if (basePos.status === "paused") {
        return basePos.win_rate >= this.thresholds.resume_threshold_win_rate
      }

      if (basePos.status === "evaluating") {
        if (basePos.total_positions < 10) return true
        if (basePos.total_positions < 50 && basePos.win_rate >= this.thresholds.initial_min_win_rate) {
          return true
        }
        return false
      }

      return basePos.status === "open" || basePos.status === "active" // "active" kept for legacy Redis data
    } catch (error) {
      console.error("[v0] Error in canCreatePosition:", error)
      return false
    }
  }

  /**
   * Update base position performance after a pseudo position closes
   */
  async updatePerformance(
    basePositionId: string,
    profitLoss: number,
    isWin: boolean,
    currentDrawdown: number,
  ): Promise<void> {
    try {
      const basePositions = (await getSettings(`base_positions:${this.connectionId}`)) || []
      const basePos = basePositions.find((p: any) => p.id === basePositionId)

      if (!basePos) return

      // Update metrics
      const totalPositions = basePos.total_positions + 1
      const winningPositions = basePos.winning_positions + (isWin ? 1 : 0)
      const losingPositions = basePos.losing_positions + (isWin ? 0 : 1)
      const totalProfitLoss = basePos.total_profit_loss + profitLoss
      const winRate = totalPositions > 0 ? winningPositions / totalPositions : 0
      const maxDrawdown = Math.max(basePos.max_drawdown, currentDrawdown)

      const avgProfit =
        winningPositions > 0 ? (totalProfitLoss + Math.abs(basePos.total_profit_loss)) / (2 * winningPositions) : 0
      const avgLoss = losingPositions > 0 ? Math.abs(totalProfitLoss - basePos.total_profit_loss) / losingPositions : 0

      // Update position in Redis
      const updatedPosition = {
        ...basePos,
        total_positions: totalPositions,
        winning_positions: winningPositions,
        losing_positions: losingPositions,
        total_profit_loss: totalProfitLoss,
        max_drawdown: maxDrawdown,
        win_rate: winRate,
        avg_profit: avgProfit,
        avg_loss: avgLoss,
        updated_at: new Date().toISOString(),
      }

      const updatedPositions = basePositions.map((p: any) => (p.id === basePositionId ? updatedPosition : p))
      await setSettings(`base_positions:${this.connectionId}`, updatedPositions)

      // Check thresholds and update status
      await this.checkThresholdsAndUpdateStatus(basePositionId, {
        totalPositions,
        winRate,
        avgProfit,
        avgLoss,
        maxDrawdown,
      })

      console.log(
        `[v0] Updated base position ${basePositionId}: ${totalPositions} positions, ${(winRate * 100).toFixed(1)}% win rate`,
      )
    } catch (error) {
      console.error("[v0] Error updating base position performance:", error)
    }
  }

  /**
   * Check performance thresholds and transition status
   */
  private async checkThresholdsAndUpdateStatus(
    basePositionId: string,
    metrics: {
      totalPositions: number
      winRate: number
      avgProfit: number
      avgLoss: number
      maxDrawdown: number
    },
  ): Promise<void> {
    try {
      const basePositions = (await getSettings(`base_positions:${this.connectionId}`)) || []
      const index = basePositions.findIndex((p: any) => p.id === basePositionId)

      if (index === -1) return

      const basePos = basePositions[index]
      let newStatus: "evaluating" | "active" | "paused" | "failed" | null = null

      // Phase 1 check (after 10 positions)
      if (metrics.totalPositions === 10) {
        if (metrics.winRate < this.thresholds.initial_min_win_rate) {
          newStatus = "failed"
          console.log(`[v0] Base position ${basePositionId} FAILED Phase 1: ${(metrics.winRate * 100).toFixed(1)}% < 40%`)
        } else {
          console.log(`[v0] Base position ${basePositionId} passed Phase 1: ${(metrics.winRate * 100).toFixed(1)}%`)
        }
      }

      // Phase 2 check (after 50 positions)
      if (metrics.totalPositions === 50 && newStatus !== "failed") {
        const profitRatio = metrics.avgLoss > 0 ? metrics.avgProfit / metrics.avgLoss : 0

        if (
          metrics.winRate >= this.thresholds.expanded_min_win_rate &&
          profitRatio >= this.thresholds.expanded_min_profit_ratio
        ) {
          newStatus = "active"
          console.log(
            `[v0] Base position ${basePositionId} PASSED Phase 2: ${(metrics.winRate * 100).toFixed(1)}%, profit ratio ${profitRatio.toFixed(2)}`,
          )
        } else {
          newStatus = "paused"
          console.log(
            `[v0] Base position ${basePositionId} PAUSED Phase 2: ${(metrics.winRate * 100).toFixed(1)}%, profit ratio ${profitRatio.toFixed(2)}`,
          )
        }
      }

      // Production monitoring (after Phase 2)
      if (metrics.totalPositions > 50 && newStatus === null) {
        if (metrics.winRate < this.thresholds.pause_threshold_win_rate) {
          newStatus = "paused"
          console.log(`[v0] Base position ${basePositionId} performance degraded, PAUSING`)
        }

        if (metrics.maxDrawdown > this.thresholds.production_max_drawdown) {
          newStatus = "paused"
          console.log(`[v0] Base position ${basePositionId} exceeded drawdown limit, PAUSING`)
        }
      }

      // Update status if changed
      if (newStatus) {
        basePositions[index].status = newStatus
        basePositions[index].updated_at = new Date().toISOString()
        await setSettings(`base_positions:${this.connectionId}`, basePositions)
      }
    } catch (error) {
      console.error("[v0] Error in checkThresholdsAndUpdateStatus:", error)
    }
  }

  /**
   * Generate unique config key for identifying duplicate configurations
   */
  private generateConfigKey(config: any): string {
    return `${config.symbol}:${config.indicationType}:${config.range}:${config.direction}:${config.tpFactor}:${config.slRatio}:${config.trailingEnabled}:${config.trailStart}:${config.trailStop}:${config.drawdownRatio}:${config.marketChangeRange}:${config.lastPartRatio}`
  }
}
