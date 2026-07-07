/**
 * Preset Configuration Generator
 * Generates all possible configuration combinations for testing
 */

import type { IndicatorConfig } from "./indicators"
import { db } from "@/lib/database"

export interface PresetConfiguration {
  id: string
  indicator: IndicatorConfig
  symbol: string
  timeframe: string // "4h", "8h", "12h"
  takeprofit_factor: number
  stoploss_ratio: number
  trailing_enabled: boolean
  trail_start?: number
  trail_stop?: number
  position_cost: number
}

export class PresetConfigGenerator {
  private static cachedPositionCost: number | null = null
  private static lastFetch = 0

  private static async getPositionCost(): Promise<number> {
    const now = Date.now()
    if (this.cachedPositionCost !== null && now - this.lastFetch < 60000) {
      return this.cachedPositionCost
    }

    try {
      const value = await db.getSetting("positionCost")
      this.cachedPositionCost = value ? Number.parseFloat(value) : 0.1 // Default 10%
      this.lastFetch = now
      return this.cachedPositionCost
    } catch (error) {
      console.error("[v0] Failed to get positionCost:", error)
      return 0.1 // Default 10%
    }
  }

  /**
   * Generate all indicator configurations
   */
  static generateIndicatorConfigs(): IndicatorConfig[] {
    const configs: IndicatorConfig[] = []

    // RSI configurations
    for (const period of [7, 14, 21]) {
      for (const oversold of [20, 30]) {
        for (const overbought of [70, 80]) {
          configs.push({
            type: "rsi",
            params: { period, oversold, overbought },
          })
        }
      }
    }

    // MACD configurations
    for (const fast of [8, 12]) {
      for (const slow of [21, 26]) {
        for (const signal of [7, 9]) {
          configs.push({
            type: "macd",
            params: { fast, slow, signal },
          })
        }
      }
    }

    // Bollinger Bands configurations
    for (const period of [15, 20, 25]) {
      for (const stdDev of [1.5, 2, 2.5]) {
        configs.push({
          type: "bollinger",
          params: { period, stdDev },
        })
      }
    }

    // Parabolic SAR configurations
    for (const acceleration of [0.01, 0.02, 0.03]) {
      for (const maximum of [0.15, 0.2, 0.25]) {
        configs.push({
          type: "sar",
          params: { acceleration, maximum },
        })
      }
    }

    // EMA configurations
    for (const period of [9, 20, 50, 100, 200]) {
      configs.push({
        type: "ema",
        params: { period },
      })
    }

    return configs
  }

  /**
   * Generate all preset configurations for testing
   * Now async to read positionCost from settings
   */
  static async generateAllConfigurations(
    symbols: string[],
    indicatorConfigs: IndicatorConfig[],
    maxConfigs = 500,
  ): Promise<PresetConfiguration[]> {
    const configurations: PresetConfiguration[] = []
    const timeframes = ["4h", "8h", "12h"]
    const takeprofitFactors = [2, 3, 4, 6, 8, 12]
    const stoplossRatios = [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5]
    const trailStarts = [0.3, 0.6, 1.0]
    const trailStops = [0.1, 0.2, 0.3]

    const positionCost = await this.getPositionCost()

    let configId = 0

    for (const symbol of symbols) {
      for (const indicator of indicatorConfigs) {
        for (const timeframe of timeframes) {
          for (const tp of takeprofitFactors) {
            for (const sl of stoplossRatios) {
              // Without trailing
              configurations.push({
                id: `config_${configId++}`,
                indicator,
                symbol,
                timeframe,
                takeprofit_factor: tp,
                stoploss_ratio: sl,
                trailing_enabled: false,
                position_cost: positionCost,
              })

              // With trailing (sample combinations)
              if (configurations.length < maxConfigs) {
                for (const trailStart of trailStarts) {
                  for (const trailStop of trailStops) {
                    configurations.push({
                      id: `config_${configId++}`,
                      indicator,
                      symbol,
                      timeframe,
                      takeprofit_factor: tp,
                      stoploss_ratio: sl,
                      trailing_enabled: true,
                      trail_start: trailStart,
                      trail_stop: trailStop,
                      position_cost: positionCost,
                    })

                    if (configurations.length >= maxConfigs) break
                  }
                  if (configurations.length >= maxConfigs) break
                }
              }

              if (configurations.length >= maxConfigs) break
            }
            if (configurations.length >= maxConfigs) break
          }
          if (configurations.length >= maxConfigs) break
        }
        if (configurations.length >= maxConfigs) break
      }
      if (configurations.length >= maxConfigs) break
    }

    return configurations.slice(0, maxConfigs)
  }

  /**
   * Filter configurations by validation criteria
   */
  static filterValidConfigurations(
    configurations: PresetConfiguration[],
    results: Map<string, { profitFactor: number; drawdownHours: number }>,
    minProfitFactor = 0.6,
    maxDrawdownHours = 12,
  ): PresetConfiguration[] {
    return configurations.filter((config) => {
      const result = results.get(config.id)
      if (!result) return false

      return result.profitFactor >= minProfitFactor && result.drawdownHours <= maxDrawdownHours
    })
  }
}
