import { v4 as uuidv4 } from "uuid"
import type { StrategyConfig, PseudoPosition, MainStrategyType, AdjustmentType } from "./types"

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

interface BlockAdjustmentState {
  blockSize: number
  isAdjusted: boolean // true = using increased volume, false = using standard volume
  lastCheckProfit: number // profit factor from last check
  isEnabled: boolean // true = block strategy enabled, false = disabled
  performanceHistory: {
    withBlock: number[] // PnL values with block strategy
    withoutBlock: number[] // PnL values without block strategy
  }
}

export class StrategyEngine {
  private strategies: Map<string, StrategyResult> = new Map()
  private pseudoPositions: Map<string, PseudoPosition[]> = new Map()
  private blockAdjustmentStates: Map<number, BlockAdjustmentState> = new Map()

  calculateBaseStrategy(
    pseudoPositions: PseudoPosition[],
    config: StrategyConfig,
    applyAdjustments = true,
  ): StrategyResult {
    const lastPositions = pseudoPositions.slice(-config.last_positions_count)
    const avgProfitFactor = this.calculateAverageProfitFactor(lastPositions)

    // Check if meets minimum criteria (0.4)
    const isValid = avgProfitFactor >= 0.4

    let adjustedVolumeFactor = config.volume_factor
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
      }

      if (config.adjustments.dca?.enabled) {
        adjustedVolumeFactor = this.applyDCAdjustment(
          lastPositions,
          adjustedVolumeFactor,
          config.adjustments.dca.levels,
        )
        appliedAdjustments.push("dca")
      }
    }

    return {
      id: uuidv4(),
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
    const isValid = overallAvg > 0

    let adjustedVolumeFactor = config.volume_factor
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
      }

      if (config.adjustments.dca?.enabled) {
        adjustedVolumeFactor = this.applyDCAdjustment(
          mainPositions,
          adjustedVolumeFactor,
          config.adjustments.dca.levels,
        )
        appliedAdjustments.push("dca")
      }
    }

    return {
      id: uuidv4(),
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

    const last15 = pseudoPositions.slice(-15)
    const last25 = pseudoPositions.slice(-25)

    const avg15 = this.calculateAverageProfitFactor(last15)
    const avg25 = this.calculateAverageProfitFactor(last25)

    const isValid = (avg15 > 0.4 || avg25 > 0.4) && avgProfitFactor >= 0.4

    let adjustedVolumeFactor = config.volume_factor
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
      }

      if (config.adjustments.dca?.enabled) {
        adjustedVolumeFactor = this.applyDCAdjustment(
          lastPositions,
          adjustedVolumeFactor,
          config.adjustments.dca.levels,
        )
        appliedAdjustments.push("dca")
      }
    }

    return {
      id: uuidv4(),
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
    pseudoPositions: PseudoPosition[],
    config: StrategyConfig,
    blockSize: number,
    blockAdjustmentRatio = 1,
  ): number {
    const allBlocks = this.groupPositionsIntoBlocks(pseudoPositions, blockSize)
    const completeBlocks = allBlocks.filter((block) => block.length === blockSize)

    if (!this.blockAdjustmentStates.has(blockSize)) {
      this.blockAdjustmentStates.set(blockSize, {
        blockSize,
        isAdjusted: false,
        lastCheckProfit: 0,
        isEnabled: true,
        performanceHistory: {
          withBlock: [],
          withoutBlock: [],
        },
      })
    }

    const state = this.blockAdjustmentStates.get(blockSize)!

    if (!state.isEnabled) {
      return config.volume_factor
    }

    if (completeBlocks.length > 0) {
      const lastCompleteBlock = completeBlocks[completeBlocks.length - 1]
      const lastBlockProfit = this.calculateAverageProfitFactor(lastCompleteBlock)

      if (state.isAdjusted) {
        if (lastBlockProfit >= 0) {
          state.isAdjusted = false
          state.lastCheckProfit = lastBlockProfit
        } else {
          state.lastCheckProfit = lastBlockProfit
        }
      } else {
        if (lastBlockProfit < 0) {
          state.isAdjusted = true
          state.lastCheckProfit = lastBlockProfit
        } else {
          state.lastCheckProfit = lastBlockProfit
        }
      }
    }

    // This ratio will be multiplied with base position cost at Exchange level
    const adjustedBlocksCount = Array.from(this.blockAdjustmentStates.values()).filter(
      (s) => s.isAdjusted && s.isEnabled,
    ).length

    return config.volume_factor * (1 + adjustedBlocksCount * blockAdjustmentRatio)
  }

  private applyDCAdjustment(positions: PseudoPosition[], currentVolumeFactor: number, dcaLevels: number): number {
    const lossPositions = positions.filter((p) => p.profit_factor < 0)

    if (lossPositions.length > 0) {
      // Return ratio adjustment factor (not volume)
      return currentVolumeFactor * (1 + lossPositions.length / positions.length)
    }

    return currentVolumeFactor
  }

  private getAdjustmentSuffix(adjustments: AdjustmentType[]): string {
    if (adjustments.length === 0) return ""
    return ` + ${adjustments.map((adj) => adj.toUpperCase()).join(" + ")}`
  }

  generateAllStrategies(
    pseudoPositions: PseudoPosition[],
    blockAdjustmentRatio = 1,
    blockAutoDisableEnabled = true,
    blockAutoDisableComparisonWindow = 50,
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

      const configWithBoth: StrategyConfig = {
        ...config,
        adjustments: {
          block: {
            enabled: true,
            blockSize: 2,
            adjustmentRatio: blockAdjustmentRatio,
          },
          dca: {
            enabled: true,
            levels: 3,
          },
        },
      }
      strategies.push(this.calculateBaseStrategy(pseudoPositions, configWithBoth, true))
    })

    return strategies.slice(0, 150)
  }

  private calculateAverageProfitFactor(positions: PseudoPosition[]): number {
    if (positions.length === 0) return 0
    return positions.reduce((sum, p) => sum + p.profit_factor, 0) / positions.length
  }

  private groupPositionsIntoBlocks(positions: PseudoPosition[], blockSize: number): PseudoPosition[][] {
    const blocks: PseudoPosition[][] = []
    for (let i = 0; i < positions.length; i += blockSize) {
      blocks.push(positions.slice(i, i + blockSize))
    }
    return blocks
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

  private calculatePnLMoneySum(positions: PseudoPosition[]): number {
    if (positions.length === 0) return 0
    return positions.reduce((sum, p) => sum + p.profit_factor, 0)
  }

  private shouldDisableBlockStrategy(blockSize: number, positions: PseudoPosition[], comparisonWindow = 50): boolean {
    const state = this.blockAdjustmentStates.get(blockSize)
    if (!state) return false

    const recentPositions = positions.slice(-comparisonWindow)
    if (recentPositions.length < Math.min(20, comparisonWindow)) {
      return false
    }

    const allBlocks = this.groupPositionsIntoBlocks(recentPositions, blockSize)
    const completeBlocks = allBlocks.filter((block) => block.length === blockSize)

    if (completeBlocks.length < 2) return false

    const withBlockPnL: number[] = []
    const withoutBlockPnL: number[] = []

    completeBlocks.forEach((block, blockIndex) => {
      const blockPnL = this.calculatePnLMoneySum(block)

      if (blockIndex > 0) {
        const previousBlockProfit = this.calculateAverageProfitFactor(completeBlocks[blockIndex - 1])
        if (previousBlockProfit < 0) {
          withBlockPnL.push(blockPnL)
        } else {
          withoutBlockPnL.push(blockPnL)
        }
      } else {
        withoutBlockPnL.push(blockPnL)
      }
    })

    if (withBlockPnL.length < 2 || withoutBlockPnL.length < 2) {
      return false
    }

    const avgWithBlock = withBlockPnL.reduce((sum, pnl) => sum + pnl, 0) / withBlockPnL.length
    const avgWithoutBlock = withoutBlockPnL.reduce((sum, pnl) => sum + pnl, 0) / withoutBlockPnL.length

    console.log(
      `[v0] Block size ${blockSize} comparison (last ${comparisonWindow} positions): WITH=${avgWithBlock.toFixed(4)}, WITHOUT=${avgWithoutBlock.toFixed(4)}`,
    )

    return avgWithBlock < avgWithoutBlock
  }

  validateStrategyForTrading(strategy: StrategyResult): boolean {
    return strategy.validation_state === "valid" && strategy.should_open_position && strategy.avg_profit_factor >= 0.4
  }

  private generateBaseConfigurations(): StrategyConfig[] {
    const configs: StrategyConfig[] = []

    for (let tp = 2; tp <= 22; tp++) {
      for (let sl = 0.2; sl <= 2.2; sl += 0.1) {
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
