import type { StrategyConfig, PseudoPosition, MainStrategyType, AdjustmentType } from "./types"
import { buildStopLossRatios } from "@/lib/stoploss-ratio-range"
import { calculateBlockVolumeMultiplier } from "@/lib/block-count-state"
import {
  MAIN_TRADE_BASE_PF_RATIO_DEFAULT,
  MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
} from "@/lib/main-trade-profit-factor"

function strategyId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `strategy-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

export interface StrategyResult {
  id: string
  name: string
  mainType: MainStrategyType
  adjustments: AdjustmentType[]
  config: StrategyConfig
  isActive: boolean
  validation_state: "valid" | "invalid" | "pending"
  last_positions: PseudoPosition[]
  avg_profit_factor: number
  should_open_position: boolean
  volume_factor: number
  stats: {
    last_8_avg: number
    last_20_avg: number
    last_50_avg: number
    positions_per_day: number
    drawdown_hours: number
    total_trades: number
    win_rate: number
  }
}

export interface StrategyType {
  id: string
  name: string
  description: string
  config: StrategyConfig
}

/**
 * Read-only/demo strategy projection.
 *
 * Production coordination is owned by StrategyCoordinator. This class keeps
 * the Strategies demo endpoint contract-shaped, but deliberately shares the
 * same volume invariants: normal Base is identity 1 and an enabled Block uses
 * its absolute count target immediately without a private bootstrap state.
 */
export class StrategyEngine {
  private strategies: Map<string, StrategyResult> = new Map()
  private pseudoPositions: Map<string, PseudoPosition[]> = new Map()

  calculateBaseStrategy(
    pseudoPositions: PseudoPosition[],
    config: StrategyConfig,
    applyAdjustments = true,
  ): StrategyResult {
    const lastPositions = pseudoPositions.slice(-config.last_positions_count)
    const avgProfitFactor = this.calculateAverageProfitFactor(lastPositions)

    const isValid = avgProfitFactor >= MAIN_TRADE_BASE_PF_RATIO_DEFAULT

    let adjustedVolumeFactor = 1
    const appliedAdjustments: AdjustmentType[] = []

    if (applyAdjustments && config.adjustments) {
      if (config.adjustments.block?.enabled) {
        adjustedVolumeFactor = this.applyBlockAdjustment(
          pseudoPositions,
          config,
          config.adjustments.block.blockSize,
          config.adjustments.block.adjustmentRatio,
        )
        appliedAdjustments.push("block")
      } else if (config.adjustments.dca?.enabled) {
        // Block and DCA are independent physical/result lanes in production.
        // This legacy single-result projection cannot represent two lanes, so
        // never multiply them together when an imported config enables both.
        adjustedVolumeFactor = this.applyDCAdjustment(
          lastPositions,
          config.adjustments.dca.levels,
        )
        appliedAdjustments.push("dca")
      }
    }

    return {
      id: strategyId(),
      name: `Base Strategy (Last ${config.last_positions_count})${this.getAdjustmentSuffix(appliedAdjustments)}`,
      mainType: "base",
      adjustments: appliedAdjustments,
      config,
      isActive: false,
      validation_state: isValid ? "valid" : "invalid",
      last_positions: lastPositions,
      avg_profit_factor: avgProfitFactor,
      should_open_position: isValid,
      volume_factor: adjustedVolumeFactor,
      stats: this.calculateStrategyStats(pseudoPositions, config),
    }
  }

  calculateMainStrategy(
    pseudoPositions: PseudoPosition[],
    config: StrategyConfig,
    applyAdjustments = true,
  ): StrategyResult {
    const mainPositions = pseudoPositions.slice(-config.main_positions_count)

    const positivePositions = mainPositions.filter((p) => p.profit_factor > 0)
    const negativePositions = mainPositions.filter((p) => p.profit_factor <= 0)

    const positiveAvg = positivePositions.length > 0 ? this.calculateAverageProfitFactor(positivePositions) : 0
    const negativeAvg = negativePositions.length > 0 ? this.calculateAverageProfitFactor(negativePositions) : 0

    const overallAvg = this.calculateAverageProfitFactor(mainPositions)
    const isValid = overallAvg >= MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT

    let adjustedVolumeFactor = 1
    const appliedAdjustments: AdjustmentType[] = []

    if (applyAdjustments && config.adjustments) {
      if (config.adjustments.block?.enabled) {
        adjustedVolumeFactor = this.applyBlockAdjustment(
          pseudoPositions,
          config,
          config.adjustments.block.blockSize,
          config.adjustments.block.adjustmentRatio,
        )
        appliedAdjustments.push("block")
      } else if (config.adjustments.dca?.enabled) {
        // Keep legacy/demo output to one independent adjustment lane.
        adjustedVolumeFactor = this.applyDCAdjustment(
          mainPositions,
          config.adjustments.dca.levels,
        )
        appliedAdjustments.push("dca")
      }
    }

    return {
      id: strategyId(),
      name: `Main Strategy (${config.main_positions_count} positions)${this.getAdjustmentSuffix(appliedAdjustments)}`,
      mainType: "main",
      adjustments: appliedAdjustments,
      config,
      isActive: false,
      validation_state: isValid ? "valid" : "invalid",
      last_positions: mainPositions,
      avg_profit_factor: overallAvg,
      should_open_position: isValid,
      volume_factor: adjustedVolumeFactor,
      stats: this.calculateStrategyStats(pseudoPositions, config),
    }
  }

  private calculateRealStrategyInternal(
    pseudoPositions: PseudoPosition[],
    config: StrategyConfig,
    positionCount: number,
    applyAdjustments = true,
  ): StrategyResult {
    const lastPositions = pseudoPositions.slice(-config.last_positions_count)
    const avgProfitFactor = this.calculateAverageProfitFactor(lastPositions)

    const last20 = pseudoPositions.slice(-20)
    const last25 = pseudoPositions.slice(-25)

    const avg20 = this.calculateAverageProfitFactor(last20)
    const avg25 = this.calculateAverageProfitFactor(last25)

    const isValid =
      (avg20 >= MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT ||
        avg25 >= MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT) &&
      avgProfitFactor >= MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT

    let adjustedVolumeFactor = 1
    const appliedAdjustments: AdjustmentType[] = []

    if (applyAdjustments && config.adjustments) {
      if (config.adjustments.block?.enabled) {
        adjustedVolumeFactor = this.applyBlockAdjustment(
          pseudoPositions,
          config,
          config.adjustments.block.blockSize,
          config.adjustments.block.adjustmentRatio,
        )
        appliedAdjustments.push("block")
      } else if (config.adjustments.dca?.enabled) {
        // Keep legacy/demo output to one independent adjustment lane.
        adjustedVolumeFactor = this.applyDCAdjustment(
          lastPositions,
          config.adjustments.dca.levels,
        )
        appliedAdjustments.push("dca")
      }
    }

    return {
      id: strategyId(),
      name: `Real Strategy (${positionCount} positions)${this.getAdjustmentSuffix(appliedAdjustments)}`,
      mainType: "real",
      adjustments: appliedAdjustments,
      config: { ...config, last_positions_count: positionCount },
      isActive: false,
      validation_state: isValid ? "valid" : "invalid",
      last_positions: lastPositions,
      avg_profit_factor: avgProfitFactor,
      should_open_position: isValid,
      volume_factor: adjustedVolumeFactor,
      stats: this.calculateStrategyStats(pseudoPositions, config),
    }
  }

  private applyBlockAdjustment(
    _pseudoPositions: PseudoPosition[],
    _config: StrategyConfig,
    blockCount: number,
    blockAdjustmentRatio = 1,
  ): number {
    // Demo projection mirrors the production cold-start contract:
    // Base 1 + (Base 1 × ratio × count). There is no private state machine and
    // no dependency on a preceding negative block. Mature PF no-regression is
    // evaluated by StrategyCoordinator against realised per-lane windows.
    return calculateBlockVolumeMultiplier(blockCount, blockAdjustmentRatio)
  }

  private applyDCAdjustment(positions: PseudoPosition[], _dcaLevels: number): number {
    const lossPositions = positions.filter((p) => p.profit_factor < 0)

    if (lossPositions.length > 0) {
      // DCA is its own identity-based lane. It must never compound a Block,
      // Main, Preset, Signal, or other adjustment factor.
      return 1 + lossPositions.length / positions.length
    }

    return 1
  }

  private getAdjustmentSuffix(adjustments: AdjustmentType[]): string {
    if (adjustments.length === 0) return ""
    return ` + ${adjustments.map((adj) => adj.toUpperCase()).join(" + ")}`
  }

  generateAllStrategies(
    pseudoPositions: PseudoPosition[],
    blockAdjustmentRatio = 1,
    _blockAutoDisableEnabled = true,
    _blockAutoDisableComparisonWindow = 50,
  ): StrategyResult[] {
    const strategies: StrategyResult[] = []

    const baseConfigs = this.generateBaseConfigurations()

    baseConfigs.forEach((config) => {
      strategies.push(this.calculateBaseStrategy(pseudoPositions, config, false))
      strategies.push(this.calculateMainStrategy(pseudoPositions, config, false))
      ;[2, 4].forEach((count) => {
        strategies.push(this.calculateRealStrategyInternal(pseudoPositions, config, count, false))
      })
      ;[2, 4].forEach((blockSize) => {
        const configWithBlock: StrategyConfig = {
          ...config,
          adjustments: {
            block: {
              enabled: true,
              blockSize,
              adjustmentRatio: blockAdjustmentRatio,
            },
          },
        }
        strategies.push(this.calculateBaseStrategy(pseudoPositions, configWithBlock, true))
        strategies.push(this.calculateMainStrategy(pseudoPositions, configWithBlock, true))
      })
      ;[3, 5].forEach((levels) => {
        const configWithDCA: StrategyConfig = {
          ...config,
          adjustments: {
            dca: {
              enabled: true,
              levels,
            },
          },
        }
        strategies.push(this.calculateBaseStrategy(pseudoPositions, configWithDCA, true))
        strategies.push(this.calculateMainStrategy(pseudoPositions, configWithDCA, true))
      })

    })

    return strategies.slice(0, 150)
  }

  private calculateAverageProfitFactor(positions: PseudoPosition[]): number {
    if (positions.length === 0) return 0
    return positions.reduce((sum, p) => sum + p.profit_factor, 0) / positions.length
  }

  private calculateStrategyStats(positions: PseudoPosition[], config: StrategyConfig) {
    const last8 = positions.slice(-8)
    const last20 = positions.slice(-20)
    const last50 = positions.slice(-50)

    const winningPositions = positions.filter((p) => p.profit_factor > 0)
    const winRate = positions.length > 0 ? winningPositions.length / positions.length : 0

    const drawdownHours = this.calculateDrawdownHours(positions)

    return {
      last_8_avg: this.calculateAverageProfitFactor(last8),
      last_20_avg: this.calculateAverageProfitFactor(last20),
      last_50_avg: this.calculateAverageProfitFactor(last50),
      positions_per_day: this.calculatePositionsPerDay(positions),
      drawdown_hours: drawdownHours,
      total_trades: positions.length,
      win_rate: winRate,
    }
  }

  private calculatePositionsPerDay(positions: PseudoPosition[]): number {
    if (positions.length < 2) return 0

    const firstDate = new Date(positions[0].created_at)
    const lastDate = new Date(positions[positions.length - 1].created_at)
    const daysDiff = (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24)

    return daysDiff > 0 ? positions.length / daysDiff : 0
  }

  private calculateDrawdownHours(positions: PseudoPosition[]): number {
    let maxProfit = 0
    let drawdownHours = 0
    let currentDrawdownStart: Date | null = null

    positions.forEach((position) => {
      if (position.profit_factor > maxProfit) {
        maxProfit = position.profit_factor
        if (currentDrawdownStart) {
          const drawdownEnd = new Date(position.updated_at)
          drawdownHours += (drawdownEnd.getTime() - currentDrawdownStart.getTime()) / (1000 * 60 * 60)
          currentDrawdownStart = null
        }
      } else if (position.profit_factor <= maxProfit && !currentDrawdownStart) {
        currentDrawdownStart = new Date(position.updated_at)
      }
    })

    return drawdownHours
  }

  validateStrategyForTrading(strategy: StrategyResult): boolean {
    return (
      strategy.validation_state === "valid" &&
      strategy.should_open_position &&
      strategy.avg_profit_factor >= MAIN_TRADE_BASE_PF_RATIO_DEFAULT
    )
  }

  private generateBaseConfigurations(): StrategyConfig[] {
    const configs: StrategyConfig[] = []

    const stopLossRatios = buildStopLossRatios()
    for (let tp = 2; tp <= 22; tp++) {
      for (const sl of stopLossRatios) {
        configs.push({
          takeprofit_factor: tp,
          stoploss_ratio: sl,
          trailing_enabled: false,
          last_positions_count: 8,
          main_positions_count: 3,
          volume_factor: 1,
        })
        ;[0.3, 0.6, 1.0].forEach((trailStart) => {
          ;[0.1, 0.2, 0.3].forEach((trailStop) => {
            configs.push({
              takeprofit_factor: tp,
              stoploss_ratio: sl,
              trailing_enabled: true,
              trail_start: trailStart,
              trail_stop: trailStop,
              last_positions_count: 8,
              main_positions_count: 3,
              volume_factor: 1,
            })
          })
        })
      }
    }

    return configs.slice(0, 50)
  }
}
