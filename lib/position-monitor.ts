import { getRedisClient, initRedis } from "@/lib/redis-db"
import { dbCoordinator } from "@/lib/database-coordinator"
import { UnifiedLogger, ErrorCode, LogContext } from "@/lib/error-handling"
import { ExchangeConnectorFactory } from "@/lib/exchange-connectors/factory"

/**
 * Position Monitoring & Lifecycle Management
 * Tracks positions in real-time and manages their lifecycle
 */

export interface PositionUpdate {
  symbol: string
  currentPrice: number
  markPrice?: number
  unrealizedPnL: number
  percentPnL: number
  liquidationPrice?: number
  timestamp: number
}

export interface PositionMonitoringResult {
  symbol: string
  status: "active" | "closed" | "liquidated" | "error"
  lastPrice: number
  pnl: number
  percentPnL: number
  timeHeld: number
  error?: string
}

/**
 * Position Monitor
 * Monitors positions and manages their complete lifecycle
 */
export class PositionMonitor {
  private static instance: PositionMonitor
  private readonly log = (msg: string) => console.log(`[v0] [Position-Monitor] ${msg}`)
  private readonly error = (msg: string) => console.error(`[v0] [Position-Monitor] ERROR: ${msg}`)

  private constructor() {}

  static getInstance(): PositionMonitor {
    if (!PositionMonitor.instance) {
      PositionMonitor.instance = new PositionMonitor()
    }
    return PositionMonitor.instance
  }

  /**
   * Monitor all positions for a connection
   * Fetches current state from exchange and updates database
   */
  async monitorPositions(connectionId: string): Promise<PositionMonitoringResult[]> {
    const startTime = Date.now()
    const context: LogContext = {
      component: "PositionMonitor",
      operation: "monitorPositions",
      connectionId,
    }

    try {
      this.log(`Starting position monitoring for ${connectionId}`)

      // Get connector
      const connector = ExchangeConnectorFactory.getConnector(connectionId)
      if (!connector) {
        this.error(`Connector not found for ${connectionId}`)
        return []
      }

      // Fetch positions from exchange
      const exchangePositions = await connector.getPositions()
      this.log(`Fetched ${exchangePositions.length} positions from exchange`)

      // Get currently tracked positions
      const trackedPositions = await dbCoordinator.getPositions(connectionId)

      const results: PositionMonitoringResult[] = []

      // Update each position
      for (const exchangePos of exchangePositions) {
        try {
          const symbol = exchangePos.symbol
          const tracked = trackedPositions[symbol]

          // Update position in database
          const updated = {
            ...tracked,
            currentPrice: exchangePos.currentPrice || exchangePos.markPrice,
            markPrice: exchangePos.markPrice,
            unrealizedPnl: exchangePos.unrealizedPnl,
            updated_at: new Date().toISOString(),
          }

          await dbCoordinator.storePosition(connectionId, symbol, updated)

          // Calculate metrics
          const percentPnL = updated.unrealizedPnl / (updated.size * updated.entryPrice)
          const timeHeld = Date.now() - new Date(updated.created_at).getTime()

          results.push({
            symbol,
            status: "active",
            lastPrice: updated.currentPrice,
            pnl: updated.unrealizedPnl,
            percentPnL,
            timeHeld,
          })

          this.log(`  ${symbol}: $${updated.currentPrice} (PnL: $${updated.unrealizedPnL} / ${(percentPnL * 100).toFixed(2)}%)`)
        } catch (err) {
          this.error(`Failed to update position: ${err}`)
          results.push({
            symbol: exchangePos.symbol,
            status: "error",
            lastPrice: 0,
            pnl: 0,
            percentPnL: 0,
            timeHeld: 0,
            error: String(err),
          })
        }
      }

      // Check for closed positions
      for (const [symbol, tracked] of Object.entries(trackedPositions)) {
        if (tracked.status === "open" && !exchangePositions.find((p: any) => p.symbol === symbol)) {
          // Position no longer on exchange = closed
          tracked.status = "closed"
          tracked.updated_at = new Date().toISOString()
          await dbCoordinator.storePosition(connectionId, symbol, tracked)

          results.push({
            symbol,
            status: "closed",
            lastPrice: tracked.currentPrice,
            pnl: tracked.unrealizedPnl,
            percentPnL: tracked.unrealizedPnL / (tracked.size * tracked.entryPrice),
            timeHeld: Date.now() - new Date(tracked.created_at).getTime(),
          })

          this.log(`  Position closed: ${symbol}`)
        }
      }

      const duration = Date.now() - startTime
      this.log(`Position monitoring complete in ${duration}ms: ${results.length} positions updated`)

      return results
    } catch (err) {
      this.error(`Position monitoring failed: ${err}`)
      return []
    }
  }

  /**
   * Check positions for risk conditions
   * Returns positions that exceed limits
   */
  async checkRiskConditions(
    connectionId: string,
    maxDrawdown: number,
    maxHoldTime: number
  ): Promise<{ symbol: string; condition: string; value: number; threshold: number }[]> {
    const context: LogContext = {
      component: "PositionMonitor",
      operation: "checkRiskConditions",
      connectionId,
    }

    try {
      const positions = await dbCoordinator.getPositions(connectionId)
      const risks: { symbol: string; condition: string; value: number; threshold: number }[] = []

      for (const [symbol, position] of Object.entries(positions)) {
        if (position.status !== "open") continue

        // Check drawdown
        const drawdown = (position.unrealizedPnl || 0) / (position.size * position.entryPrice)
        if (drawdown < maxDrawdown) {
          risks.push({
            symbol,
            condition: "drawdown_exceeded",
            value: drawdown,
            threshold: maxDrawdown,
          })
        }

        // Check hold time
        const heldFor = Date.now() - new Date(position.created_at).getTime()
        if (heldFor > maxHoldTime) {
          risks.push({
            symbol,
            condition: "hold_time_exceeded",
            value: heldFor,
            threshold: maxHoldTime,
          })
        }

        // Check liquidation risk
        if (position.liquidationPrice) {
          const distToLiquidation = Math.abs(position.currentPrice - position.liquidationPrice)
          const priceAtLiquidation = position.liquidationPrice
          const currentDistance = Math.abs(position.currentPrice - priceAtLiquidation)
          const maxSafeDistance = Math.abs(position.entryPrice - priceAtLiquidation) * 0.1 // 10% of distance

          if (currentDistance < maxSafeDistance) {
            risks.push({
              symbol,
              condition: "liquidation_risk",
              value: currentDistance,
              threshold: maxSafeDistance,
            })
          }
        }
      }

      if (risks.length > 0) {
        this.log(`Found ${risks.length} risk conditions`)
        risks.forEach((r) => this.log(`  ${r.symbol}: ${r.condition}`))
      }

      return risks
    } catch (err) {
      UnifiedLogger.error(context, ErrorCode.DATABASE_ERROR, "Risk check failed", err)
      return []
    }
  }

  /**
   * Clean up closed positions after retention period
   */
  async cleanupClosedPositions(connectionId: string, retentionHours: number = 24): Promise<number> {
    const context: LogContext = {
      component: "PositionMonitor",
      operation: "cleanupClosedPositions",
      connectionId,
    }

    try {
      return await dbCoordinator.cleanupClosedPositions(connectionId, retentionHours)
    } catch (err) {
      UnifiedLogger.error(context, ErrorCode.DATABASE_ERROR, "Cleanup failed", err)
      return 0
    }
  }

  /**
   * Get position statistics
   */
  async getPositionStats(connectionId: string): Promise<{
    total: number
    open: number
    closed: number
    totalUnrealizedPnL: number
    averagePnLPercent: number
    winningPositions: number
    losingPositions: number
    winRate: number
  }> {
    try {
      const positions = await dbCoordinator.getPositions(connectionId)

      let total = 0
      let open = 0
      let closed = 0
      let totalUnrealizedPnL = 0
      let winningPositions = 0
      let losingPositions = 0
      const pnlPercents: number[] = []

      for (const position of Object.values(positions)) {
        total++

        if (position.status === "open") {
          open++
          totalUnrealizedPnL += position.unrealizedPnl || 0
        } else {
          closed++
        }

        const pnlPercent = (position.unrealizedPnl || 0) / (position.size * position.entryPrice)
        pnlPercents.push(pnlPercent)

        if (pnlPercent > 0) {
          winningPositions++
        } else {
          losingPositions++
        }
      }

      const averagePnLPercent = pnlPercents.length > 0 ? pnlPercents.reduce((a, b) => a + b) / pnlPercents.length : 0
      const winRate = total > 0 ? winningPositions / total : 0

      return {
        total,
        open,
        closed,
        totalUnrealizedPnL,
        averagePnLPercent,
        winningPositions,
        losingPositions,
        winRate,
      }
    } catch (err) {
      this.error(`Failed to calculate stats: ${err}`)
      return {
        total: 0,
        open: 0,
        closed: 0,
        totalUnrealizedPnL: 0,
        averagePnLPercent: 0,
        winningPositions: 0,
        losingPositions: 0,
        winRate: 0,
      }
    }
  }
}

export const positionMonitor = PositionMonitor.getInstance()
