import { initRedis, getRedisClient } from "@/lib/redis-db"
import { UnifiedLogger, ErrorCode, LogContext, withErrorHandling } from "@/lib/error-handling"

/**
 * Progression Limits & Risk Management System
 * Enforces trading limits and validates position sizing
 */

export interface ProgressionLimits {
  long: {
    enabled: boolean
    maxLevels: number
    maxSize: number
    maxLeverage: number
    priceStep: number
  }
  short: {
    enabled: boolean
    maxLevels: number
    maxSize: number
    maxLeverage: number
    priceStep: number
  }
  combined: {
    maxOpenPositions: number
    maxDrawdown: number
    maxHoldTime: number
  }
}

export interface TradeExecutionConstraints {
  available: boolean
  reason: string
  suggestedSize?: number
  maxSize: number
  leverage: number
  riskPercent: number
}

/**
 * Progression Limits Manager
 */
export class ProgressionLimitsManager {
  private static instance: ProgressionLimitsManager

  private constructor() {}

  static getInstance(): ProgressionLimitsManager {
    if (!ProgressionLimitsManager.instance) {
      ProgressionLimitsManager.instance = new ProgressionLimitsManager()
    }
    return ProgressionLimitsManager.instance
  }

  /**
   * Get default progression limits
   */
  private getDefaultLimits(): ProgressionLimits {
    return {
      long: {
        enabled: true,
        maxLevels: 5,
        maxSize: 1.0,
        maxLeverage: 10,
        priceStep: 100, // Distance between levels in USDT
      },
      short: {
        enabled: true,
        maxLevels: 3,
        maxSize: 0.5,
        maxLeverage: 5,
        priceStep: 100,
      },
      combined: {
        maxOpenPositions: 5,
        maxDrawdown: -0.2, // -20%
        maxHoldTime: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
      },
    }
  }

  /**
   * Load progression limits for connection
   */
  async getProgressionLimits(connectionId: string): Promise<ProgressionLimits> {
    const context: LogContext = {
      component: "ProgressionLimits",
      operation: "getProgressionLimits",
      connectionId,
    }

    const { success, data } = await withErrorHandling(context, async () => {
      await initRedis()
      const client = getRedisClient()

      const key = `progression_limits:${connectionId}`
      const stored = await (client as any).hgetall(key)

      if (!stored || Object.keys(stored).length === 0) {
        return this.getDefaultLimits()
      }

      // Parse stored limits
      return {
        long: JSON.parse(stored.long || JSON.stringify(this.getDefaultLimits().long)),
        short: JSON.parse(stored.short || JSON.stringify(this.getDefaultLimits().short)),
        combined: JSON.parse(stored.combined || JSON.stringify(this.getDefaultLimits().combined)),
      }
    })

    return data || this.getDefaultLimits()
  }

  /**
   * Validate if new trade can be opened
   */
  async validateTradeExecution(
    connectionId: string,
    symbol: string,
    side: "long" | "short",
    size: number,
    leverage: number,
    balance: number,
    existingPositions: Record<string, any>
  ): Promise<TradeExecutionConstraints> {
    const context: LogContext = {
      component: "ProgressionLimits",
      operation: "validateTradeExecution",
      connectionId,
      symbol,
    }

    try {
      const limits = await this.getProgressionLimits(connectionId)
      const sideLimits = limits[side]

      // Check 1: Is this side enabled?
      if (!sideLimits.enabled) {
        return {
          available: false,
          reason: `${side} trading disabled in progression limits`,
          maxSize: 0,
          leverage: 0,
          riskPercent: 0,
        }
      }

      // Check 2: Max open positions
      const openCount = Object.values(existingPositions).filter((p: any) => p.status === "open").length
      if (openCount >= limits.combined.maxOpenPositions) {
        return {
          available: false,
          reason: `Max open positions (${limits.combined.maxOpenPositions}) already reached`,
          maxSize: 0,
          leverage: 0,
          riskPercent: 0,
        }
      }

      // Check 3: Already has position for this symbol?
      if (existingPositions[symbol] && existingPositions[symbol].status === "open") {
        return {
          available: false,
          reason: `Position already open for ${symbol}`,
          maxSize: 0,
          leverage: 0,
          riskPercent: 0,
        }
      }

      // Check 4: Leverage within limits
      if (leverage > sideLimits.maxLeverage) {
        return {
          available: false,
          reason: `Leverage ${leverage}x exceeds limit of ${sideLimits.maxLeverage}x`,
          maxSize: size,
          leverage: sideLimits.maxLeverage,
          riskPercent: (size / balance) * 100,
        }
      }

      // Check 5: Size within limits
      if (size > sideLimits.maxSize) {
        return {
          available: false,
          reason: `Size ${size} exceeds limit of ${sideLimits.maxSize}`,
          maxSize: sideLimits.maxSize,
          leverage,
          riskPercent: (sideLimits.maxSize / balance) * 100,
        }
      }

      // Check 6: Risk percent (2% max per trade)
      const riskPercent = (size / balance) * 100
      if (riskPercent > 2) {
        const maxSafeSize = balance * 0.02 // 2% of balance
        return {
          available: false,
          reason: `Risk ${riskPercent.toFixed(2)}% exceeds 2% per trade limit`,
          maxSize: maxSafeSize,
          leverage,
          riskPercent,
        }
      }

      // All checks passed
      return {
        available: true,
        reason: "All progression limits satisfied",
        suggestedSize: size,
        maxSize: Math.min(sideLimits.maxSize, balance * 0.02), // 2% of balance
        leverage,
        riskPercent,
      }
    } catch (error) {
      UnifiedLogger.error(context, ErrorCode.VALIDATION_FAILED, "Validation failed", error)

      return {
        available: false,
        reason: "Validation error: " + String(error),
        maxSize: 0,
        leverage: 0,
        riskPercent: 0,
      }
    }
  }

  /**
   * Check position drawdown against max drawdown limit
   */
  async checkDrawdown(
    connectionId: string,
    position: any,
    currentPrice: number
  ): Promise<{ withinLimit: boolean; drawdown: number; maxDrawdown: number; reason: string }> {
    const context: LogContext = {
      component: "ProgressionLimits",
      operation: "checkDrawdown",
      connectionId,
    }

    try {
      const limits = await this.getProgressionLimits(connectionId)

      // Calculate drawdown
      const priceDiff = currentPrice - position.entryPrice
      const drawdown = priceDiff / position.entryPrice

      const withinLimit = drawdown >= limits.combined.maxDrawdown

      return {
        withinLimit,
        drawdown,
        maxDrawdown: limits.combined.maxDrawdown,
        reason: withinLimit
          ? "Drawdown within limits"
          : `Drawdown ${(drawdown * 100).toFixed(2)}% exceeds ${(limits.combined.maxDrawdown * 100).toFixed(2)}%`,
      }
    } catch (error) {
      UnifiedLogger.error(context, ErrorCode.VALIDATION_FAILED, "Drawdown check failed", error)

      return {
        withinLimit: false,
        drawdown: 0,
        maxDrawdown: 0,
        reason: "Drawdown check error: " + String(error),
      }
    }
  }

  /**
   * Check if position has exceeded hold time
   */
  checkHoldTime(position: any, maxHoldTime: number): { exceeded: boolean; heldFor: number; reason: string } {
    const createdAt = new Date(position.created_at).getTime()
    const heldFor = Date.now() - createdAt

    const exceeded = heldFor > maxHoldTime

    return {
      exceeded,
      heldFor,
      reason: exceeded
        ? `Position held for ${(heldFor / 1000 / 60 / 60).toFixed(1)} hours exceeds ${(maxHoldTime / 1000 / 60 / 60).toFixed(1)} hour limit`
        : `Position held for ${(heldFor / 1000 / 60).toFixed(1)} minutes`,
    }
  }

  /**
   * Calculate suggested position size based on available balance and limits
   */
  async calculateOptimalPositionSize(
    connectionId: string,
    side: "long" | "short",
    balance: number,
    currentLeverage: number
  ): Promise<number> {
    const context: LogContext = {
      component: "ProgressionLimits",
      operation: "calculateOptimalPositionSize",
      connectionId,
    }

    try {
      const limits = await this.getProgressionLimits(connectionId)
      const sideLimits = limits[side]

      // Calculate based on 2% risk rule
      const riskAmount = balance * 0.02
      const baseSize = riskAmount / 100

      // Apply side-specific max
      const maxByLimit = sideLimits.maxSize
      const optimalSize = Math.min(baseSize, maxByLimit)

      return Math.max(0.001, optimalSize)
    } catch (error) {
      UnifiedLogger.error(context, ErrorCode.VALIDATION_FAILED, "Size calculation failed", error)
      // Fallback: 2% risk with 1x leverage
      return (balance * 0.02) / 100
    }
  }

  /**
   * Store custom progression limits
   */
  async setProgressionLimits(connectionId: string, limits: ProgressionLimits): Promise<boolean> {
    const context: LogContext = {
      component: "ProgressionLimits",
      operation: "setProgressionLimits",
      connectionId,
    }

    const { success } = await withErrorHandling(context, async () => {
      await initRedis()
      const client = getRedisClient()

      const key = `progression_limits:${connectionId}`
      const data = {
        long: JSON.stringify(limits.long),
        short: JSON.stringify(limits.short),
        combined: JSON.stringify(limits.combined),
      }

      await (client as any).hset(key, data)
      await (client as any).expire(key, 30 * 24 * 60 * 60) // 30 days

      UnifiedLogger.info(context, `Progression limits updated: long.maxLevels=${limits.long.maxLeverage}, short.maxLevels=${limits.short.maxLeverage}`)

      return true
    })

    return success
  }
}

export const progressionLimitsManager = ProgressionLimitsManager.getInstance()
