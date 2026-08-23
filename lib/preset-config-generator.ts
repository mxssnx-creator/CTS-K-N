/**
 * Preset Configuration Generator
 * Generates all possible configuration combinations for testing
 */

import type { IndicatorConfig } from "./indicators"
import { db } from "@/lib/database"
import { buildStopLossRatios } from "@/lib/stoploss-ratio-range"
import {
  DEFAULT_TAKE_PROFIT_POSITION_COST_STEPS,
  normalizePositionCostPercent,
} from "@/lib/position-cost"
import { getCanonicalConnectionSettingsOverlay } from "@/lib/connection-settings-overlay"
import { REALIZED_PROFIT_FACTOR_MIN_DEFAULT } from "@/lib/profit-factor-defaults"

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
  private static readonly cachedPositionCosts = new Map<string, { value: number; loadedAt: number }>()

  private static async getPositionCost(connectionId?: string): Promise<number> {
    const now = Date.now()
    const scope = String(connectionId || "").trim()
    const cached = this.cachedPositionCosts.get(scope)
    if (cached && now - cached.loadedAt < 60_000) {
      return cached.value
    }

    try {
      if (scope) {
        // A selected connection owns its own cost basis.  Never borrow a
        // global/X01 setting when the user is testing another connection.
        const settings = await getCanonicalConnectionSettingsOverlay(scope)
        const value = normalizePositionCostPercent(
          settings.positionCost ?? settings.exchangePositionCost ?? settings.exchange_position_cost,
        )
        this.cachedPositionCosts.set(scope, { value, loadedAt: now })
        return value
      }

      // Compatibility for older direct callers that predate connection
      // selection. New API routes always provide `connectionId` above.
      const value = normalizePositionCostPercent(await db.getSetting("positionCost"))
      this.cachedPositionCosts.set(scope, { value, loadedAt: now })
      return value
    } catch (error) {
      console.error("[v0] Failed to get positionCost:", error)
      return 0.1 // Default 0.10%
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
    connectionId?: string,
  ): Promise<PresetConfiguration[]> {
    const configurations: PresetConfiguration[] = []
    const timeframes = ["4h", "8h", "12h"]
    const takeprofitFactors = DEFAULT_TAKE_PROFIT_POSITION_COST_STEPS
    const stoplossRatios = buildStopLossRatios()
    const trailStarts = [0.3, 0.6, 1.0]
    const trailStops = [0.1, 0.2, 0.3]

    const positionCost = await this.getPositionCost(connectionId)

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

              // With trailing. Every configured combination remains present;
              // runtime batching controls throughput, never topology.
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
                }
              }
            }
          }
        }
      }
    }

    return configurations
  }

  /**
   * Filter configurations by validation criteria
   */
  static filterValidConfigurations(
    configurations: PresetConfiguration[],
    results: Map<string, { profitFactor: number; drawdownHours: number }>,
    minProfitFactor = REALIZED_PROFIT_FACTOR_MIN_DEFAULT,
    maxDrawdownHours = 12,
  ): PresetConfiguration[] {
    return configurations.filter((config) => {
      const result = results.get(config.id)
      if (!result) return false

      return result.profitFactor >= minProfitFactor && result.drawdownHours <= maxDrawdownHours
    })
  }
}
