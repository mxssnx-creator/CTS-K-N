import { getRedisClient, initRedis } from "@/lib/redis-db"
import { dbCoordinator } from "@/lib/database-coordinator"
import { ExchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { IndicatorCalculator } from "@/lib/indicators/calculator"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { getMaxLeverageForConnection } from "@/lib/leverage-policy"

/**
 * Trade Execution Orchestrator
 * Manages the complete order flow from signal to execution to tracking
 * Handles buy signals, sell signals, and error recovery
 */

export interface TradeExecutionResult {
  success: boolean
  orderId?: string
  positionId?: string
  entryPrice?: number
  size?: number
  error?: string
  details?: string
}

export interface SignalEvaluation {
  symbol: string
  signal: "buy" | "sell" | "hold"
  confidence: number
  indicatorScores: Record<string, number>
  reasons: string[]
}

export class TradeExecutionOrchestrator {
  private static instance: TradeExecutionOrchestrator
  private readonly log = (msg: string) => console.log(`[v0] [Trade-Orchestrator] ${msg}`)
  private readonly error = (msg: string) => console.error(`[v0] [Trade-Orchestrator] ERROR: ${msg}`)

  private constructor() {}

  static getInstance(): TradeExecutionOrchestrator {
    if (!TradeExecutionOrchestrator.instance) {
      TradeExecutionOrchestrator.instance = new TradeExecutionOrchestrator()
    }
    return TradeExecutionOrchestrator.instance
  }

  /**
   * Execute a complete buy signal flow
   */
  async executeBuySignal(connectionId: string, symbol: string, signal: SignalEvaluation): Promise<TradeExecutionResult> {
    const startTime = Date.now()

    try {
      this.log(
        `Executing buy signal for ${symbol} (confidence: ${signal.confidence.toFixed(2)}, reasons: ${signal.reasons.join(", ")})`
      )

      // Step 1: Validate connection
      const connector = ExchangeConnectorFactory.getConnector(connectionId)
      if (!connector) {
        throw new Error(`Connector not found for ${connectionId}`)
      }

      // Step 2: Get current market data
      const balance = await connector.getBalance()
      if (!balance.success) {
        throw new Error(`Failed to fetch balance: ${balance.error}`)
      }

      this.log(`  Current balance: ${balance.balance} USDT`)

      // Step 3: Get current positions
      const positions = await dbCoordinator.getPositions(connectionId)
      const existingPosition = positions[symbol]

      this.log(`  Existing position: ${existingPosition ? `${existingPosition.size} @ ${existingPosition.entryPrice}` : "none"}`)

      // Step 4: Check progression limits
      const progression = await ProgressionStateManager.getProgressionState(connectionId)
      const limitCheck = await this.validateProgressionLimits(connectionId, symbol, progression)

      if (!limitCheck.valid) {
        return {
          success: false,
          error: `Progression limit exceeded: ${limitCheck.reason}`,
        }
      }

      this.log(`  Progression limits OK: ${limitCheck.reason}`)

      // Step 5: Calculate position size
      const size = await this.calculatePositionSize(connectionId, balance.balance, existingPosition)

      if (size <= 0) {
        return {
          success: false,
          error: "Position size too small after risk calculation",
        }
      }

      this.log(`  Calculated size: ${size}`)

      // Step 6: Place order with retry logic
      const orderResult = await this.placeOrderWithRetry(connector, symbol, "buy", size)

      if (!orderResult.success) {
        return {
          success: false,
          error: `Failed to place order: ${orderResult.error}`,
        }
      }

      this.log(`  ✓ Order placed: ${orderResult.orderId}`)

      // Step 7: Track order in database
      await dbCoordinator.storeOrder(connectionId, orderResult.orderId || "", {
        id: orderResult.orderId,
        connectionId,
        symbol,
        side: "buy",
        quantity: size,
        price: 0, // Will be filled by exchange
        status: "pending",
        createdAt: new Date().toISOString(),
      })

      // Step 8: Create or update position
      // Operator policy: persist the *venue max* leverage for this exchange
      // (e.g. BingX → 150x). Strategy-derived per-variant leverage is an
      // internal coordination signal and must not appear on actual
      // executed positions. The single source of truth is
      // `getMaxLeverageForConnection`; the venue still applies its own
      // per-symbol bracket via setLeverage downstream so this is safe.
      const maxLeverage = await getMaxLeverageForConnection(connectionId)
      const newPosition = {
        id: `pos_${Date.now()}`,
        connectionId,
        symbol,
        side: "long" as const,
        size,
        entryPrice: orderResult.entryPrice || 0,
        currentPrice: orderResult.entryPrice || 0,
        unrealizedPnl: 0,
        leverage: maxLeverage,
        status: "open",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      await dbCoordinator.storePosition(connectionId, symbol, newPosition)

      // Step 9: Record trade
      await dbCoordinator.recordTrade(connectionId, {
        id: `trade_${Date.now()}`,
        connectionId,
        symbol,
        side: "long",
        entryPrice: orderResult.entryPrice || 0,
        size,
        signalConfidence: signal.confidence,
        orderId: orderResult.orderId,
        createdAt: new Date().toISOString(),
      })

      const duration = Date.now() - startTime
      this.log(`✓ Buy signal executed in ${duration}ms: ${symbol} x${size} @ ${orderResult.entryPrice}`)

      return {
        success: true,
        orderId: orderResult.orderId,
        positionId: newPosition.id,
        entryPrice: orderResult.entryPrice,
        size,
      }
    } catch (err) {
      const duration = Date.now() - startTime
      this.error(`Buy signal failed after ${duration}ms: ${err}`)

      return {
        success: false,
        error: String(err),
      }
    }
  }

  /**
   * Execute a complete sell signal flow
   */
  async executeSellSignal(connectionId: string, symbol: string, signal: SignalEvaluation): Promise<TradeExecutionResult> {
    const startTime = Date.now()

    try {
      this.log(`Executing sell signal for ${symbol} (confidence: ${signal.confidence.toFixed(2)})`)

      // Step 1: Get connector
      const connector = ExchangeConnectorFactory.getConnector(connectionId)
      if (!connector) {
        throw new Error(`Connector not found for ${connectionId}`)
      }

      // Step 2: Get existing position
      const position = await dbCoordinator.getPosition(connectionId, symbol)
      if (!position || position.status !== "open") {
        return {
          success: false,
          error: "No open position to close",
        }
      }

      this.log(`  Closing position: ${position.size} @ ${position.entryPrice}`)

      // Step 3: Close position with retry — use inverted direction
      const closeSide = position.direction === "short" ? "buy" : "sell"
      const closeResult = await this.closePositionWithRetry(connector, symbol, closeSide, position.size)

      if (!closeResult.success) {
        return {
          success: false,
          error: `Failed to close position: ${closeResult.error}`,
        }
      }

      this.log(`  ✓ Position closed: ${closeResult.orderId}`)

      // Step 4: Update position status
      position.status = "closed"
      position.updated_at = new Date().toISOString()
      await dbCoordinator.storePosition(connectionId, symbol, position)

      // Step 5: Record close trade
      await dbCoordinator.recordTrade(connectionId, {
        id: `trade_close_${Date.now()}`,
        connectionId,
        symbol,
        side: "close",
        exitPrice: closeResult.exitPrice || 0,
        size: position.size,
        pnl: closeResult.pnl || 0,
        orderId: closeResult.orderId,
        createdAt: new Date().toISOString(),
      })

      const duration = Date.now() - startTime
      this.log(`✓ Sell signal executed in ${duration}ms: ${symbol} closed @ ${closeResult.exitPrice} (PnL: ${closeResult.pnl})`)

      return {
        success: true,
        orderId: closeResult.orderId,
      }
    } catch (err) {
      const duration = Date.now() - startTime
      this.error(`Sell signal failed after ${duration}ms: ${err}`)

      return {
        success: false,
        error: String(err),
      }
    }
  }

  /**
   * Place order with exponential backoff retry
   */
  private async placeOrderWithRetry(
    connector: any,
    symbol: string,
    side: "buy" | "sell",
    size: number,
    maxAttempts: number = 3
  ): Promise<any> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.log(`  Placing order (attempt ${attempt}/${maxAttempts})...`)

        const result = await connector.placeOrder(symbol, side, size, undefined, "market")

        if (result.success) {
          return result
        }

        this.log(`  Order attempt ${attempt} failed: ${result.error}`)

        if (attempt < maxAttempts) {
          const backoffMs = Math.pow(2, attempt - 1) * 1000
          this.log(`  Retrying in ${backoffMs}ms...`)
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
        }
      } catch (error) {
        this.error(`Order attempt ${attempt} error: ${error}`)

        if (attempt < maxAttempts) {
          const backoffMs = Math.pow(2, attempt - 1) * 1000
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
        }
      }
    }

    return {
      success: false,
      error: `Failed to place order after ${maxAttempts} attempts`,
    }
  }

  /**
   * Close position with retry
   */
  private async closePositionWithRetry(connector: any, symbol: string, side: string, size: number, maxAttempts: number = 3): Promise<any> {
    const closeSide = side || "sell"
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.log(`  Closing position (attempt ${attempt}/${maxAttempts}, side=${closeSide})...`)

        const result = await connector.placeOrder(symbol, closeSide, size, undefined, "market")

        if (result.success) {
          return result
        }

        if (attempt < maxAttempts) {
          const backoffMs = Math.pow(2, attempt - 1) * 1000
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
        }
      } catch (error) {
        this.error(`Close attempt ${attempt} error: ${error}`)

        if (attempt < maxAttempts) {
          const backoffMs = Math.pow(2, attempt - 1) * 1000
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
        }
      }
    }

    return {
      success: false,
      error: `Failed to close position after ${maxAttempts} attempts`,
    }
  }

  /**
   * Validate progression limits before opening new position
   */
  private async validateProgressionLimits(
    connectionId: string,
    symbol: string,
    progression: any
  ): Promise<{ valid: boolean; reason: string }> {
    const positions = await dbCoordinator.getPositions(connectionId)
    const openPositions = Object.values(positions).filter((p: any) => p.status === "open")

    // Check max open positions
    if (openPositions.length >= 5) {
      return { valid: false, reason: "Max open positions (5) reached" }
    }

    // Check if position already exists for symbol
    if (positions[symbol] && positions[symbol].status === "open") {
      return { valid: false, reason: `Position already open for ${symbol}` }
    }

    return { valid: true, reason: "All limits OK" }
  }

  /**
   * Execute close-all signal - closes all open positions for a symbol or globally
   * Uses the new closeAllPositions API for efficiency
   */
  async executeCloseAllSignal(connectionId: string, symbol?: string): Promise<TradeExecutionResult> {
    const startTime = Date.now()

    try {
      this.log(`Executing close-all signal${symbol ? ` for ${symbol}` : " globally"}`)

      const connector = ExchangeConnectorFactory.getConnector(connectionId)
      if (!connector) {
        throw new Error(`Connector not found for ${connectionId}`)
      }

      // Use new API method for efficient bulk close
      const result = await connector.executeSwapTrade("closeAllPositions", { symbol })

      if (!result.success) {
        throw new Error(result.error || "Failed to close all positions")
      }

      const closedPositions = result.successful || []
      this.log(`✓ Closed ${closedPositions.length} positions${symbol ? ` for ${symbol}` : " globally"}`)

      // Update database
      const positions = await dbCoordinator.getPositions(connectionId)
      for (const [sym, pos] of Object.entries(positions)) {
        if (!symbol || sym === symbol) {
          await dbCoordinator.storePosition(connectionId, sym, {
            ...pos,
            status: "closed",
            updated_at: new Date().toISOString(),
          })
        }
      }

      const duration = Date.now() - startTime
      return {
        success: true,
        details: `Closed ${closedPositions.length} positions in ${duration}ms`,
      }
    } catch (err) {
      const duration = Date.now() - startTime
      this.error(`Close-all signal failed after ${duration}ms: ${err}`)
      return {
        success: false,
        error: String(err),
      }
    }
  }

  /**
   * Execute batch buy signals - places multiple orders efficiently using batchPlaceOrders
   */
  async executeBatchBuySignals(
    connectionId: string,
    signals: Array<{ symbol: string; signal: SignalEvaluation }>
  ): Promise<Array<TradeExecutionResult>> {
    const startTime = Date.now()

    try {
      if (signals.length === 0) {
        return []
      }

      this.log(`Executing batch buy signals for ${signals.length} symbols`)

      const connector = ExchangeConnectorFactory.getConnector(connectionId)
      if (!connector) {
        throw new Error(`Connector not found for ${connectionId}`)
      }

      // Get balance once
      const balance = await connector.getBalance()
      if (!balance.success) {
        throw new Error(`Failed to fetch balance: ${balance.error}`)
      }

      // Build order array
      const orders = []
      const resultMap: Record<string, TradeExecutionResult> = {}

      for (const { symbol, signal } of signals) {
        const size = await this.calculatePositionSize(connectionId, balance.balance, null)

        if (size > 0) {
          orders.push({
            symbol,
            side: "buy",
            quantity: size,
            type: "market",
          })

          resultMap[symbol] = {
            success: false,
            size,
          }
        } else {
          resultMap[symbol] = {
            success: false,
            error: "Position size too small",
          }
        }
      }

      if (orders.length === 0) {
        this.log("No valid orders to place in batch")
        return Object.values(resultMap)
      }

      // Use new API method for efficient batch placement (max 5 per call)
      const batchSize = 5
      const allResults: Array<any> = []

      for (let i = 0; i < orders.length; i += batchSize) {
        const batch = orders.slice(i, Math.min(i + batchSize, orders.length))
        const result = await connector.executeSwapTrade("batchPlaceOrders", { orders: batch })

        if (result.success && result.orders) {
          allResults.push(...result.orders)
        }

        if (result.errors) {
          this.error(`Batch ${Math.floor(i / batchSize) + 1} had errors: ${JSON.stringify(result.errors)}`)
        }
      }

      // Update results and database
      for (const order of allResults) {
        const symbol = order.symbol || ""
        if (resultMap[symbol]) {
          resultMap[symbol].success = true
          resultMap[symbol].orderId = order.orderId
          resultMap[symbol].entryPrice = order.price

          // Store in database
          await dbCoordinator.storeOrder(connectionId, order.orderId, {
            id: order.orderId,
            connectionId,
            symbol,
            side: "buy",
            quantity: order.quantity,
            price: order.price,
            status: "pending",
            createdAt: new Date().toISOString(),
          })

          // Operator policy: store venue max leverage on the persisted
          // position so reconciliation/UI render the actual margin
          // semantics. Resolved once per batch via the connection lookup.
          const batchMaxLeverage = await getMaxLeverageForConnection(connectionId)
          await dbCoordinator.storePosition(connectionId, symbol, {
            id: `pos_${Date.now()}`,
            connectionId,
            symbol,
            side: "long",
            size: order.quantity,
            entryPrice: order.price,
            currentPrice: order.price,
            unrealizedPnl: 0,
            leverage: batchMaxLeverage,
            status: "open",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
        }
      }

      const duration = Date.now() - startTime
      const successCount = Object.values(resultMap).filter(r => r.success).length
      this.log(`✓ Batch buy signals executed in ${duration}ms: ${successCount}/${signals.length} successful`)

      return Object.values(resultMap)
    } catch (err) {
      const duration = Date.now() - startTime
      this.error(`Batch buy signals failed after ${duration}ms: ${err}`)

      return signals.map(s => ({
        success: false,
        error: String(err),
      }))
    }
  }

  /**
   * Execute bulk order cancellation
   */
  async executeBulkCancelSignal(
    connectionId: string,
    symbol: string,
    orderIds: string[]
  ): Promise<TradeExecutionResult> {
    const startTime = Date.now()

    try {
      this.log(`Executing bulk cancel for ${orderIds.length} orders on ${symbol}`)

      const connector = ExchangeConnectorFactory.getConnector(connectionId)
      if (!connector) {
        throw new Error(`Connector not found for ${connectionId}`)
      }

      // Use new API method for efficient batch cancellation
      const result = await connector.executeSwapTrade("batchCancelOrders", { symbol, orderIds })

      if (!result.success) {
        throw new Error(result.error || "Failed to cancel orders")
      }

      const successCount = result.successful?.length || 0
      const failedCount = result.failed?.length || 0

      this.log(`✓ Cancelled ${successCount} orders, ${failedCount} failed`)

      const duration = Date.now() - startTime
      return {
        success: true,
        details: `Cancelled ${successCount}/${orderIds.length} orders in ${duration}ms`,
      }
    } catch (err) {
      const duration = Date.now() - startTime
      this.error(`Bulk cancel failed after ${duration}ms: ${err}`)
      return {
        success: false,
        error: String(err),
      }
    }
  }

  /**
   * Query open orders for a symbol
   */
  async queryOpenOrders(connectionId: string, symbol: string): Promise<Array<any>> {
    try {
      const connector = ExchangeConnectorFactory.getConnector(connectionId)
      if (!connector) {
        throw new Error(`Connector not found for ${connectionId}`)
      }

      const result = await connector.executeSwapTrade("getOpenOrders", { symbol })

      if (!result.success) {
        this.error(`Failed to query open orders: ${result.error}`)
        return []
      }

      return result.orders || []
    } catch (err) {
      this.error(`Query open orders failed: ${err}`)
      return []
    }
  }

  /**
   * Set kill switch for automatic order cancellation after timeout
   */
  async setEmergencyKillSwitch(connectionId: string, timeoutSeconds: number): Promise<TradeExecutionResult> {
    const startTime = Date.now()

    try {
      if (timeoutSeconds < 10 || timeoutSeconds > 120) {
        throw new Error("Timeout must be between 10 and 120 seconds")
      }

      this.log(`Setting kill switch with ${timeoutSeconds}s timeout`)

      const connector = ExchangeConnectorFactory.getConnector(connectionId)
      if (!connector) {
        throw new Error(`Connector not found for ${connectionId}`)
      }

      const result = await connector.executeSwapTrade("setKillSwitch", {
        type: "ACTIVATE",
        timeOut: timeoutSeconds,
      })

      if (!result.success) {
        throw new Error(result.error || "Failed to set kill switch")
      }

      const duration = Date.now() - startTime
      this.log(`✓ Kill switch activated: ${result.status} (trigger: ${result.triggerTime}ms)`)

      return {
        success: true,
        details: `Kill switch active for ${timeoutSeconds}s`,
      }
    } catch (err) {
      const duration = Date.now() - startTime
      this.error(`Kill switch failed after ${duration}ms: ${err}`)
      return {
        success: false,
        error: String(err),
      }
    }
  }

  /**
   * Calculate position size based on risk and available balance
   */
  private async calculatePositionSize(connectionId: string, availableBalance: number, existingPosition: any): Promise<number> {
    // Risk 2% of balance per position
    const riskAmount = availableBalance * 0.02

    // Base position size
    const baseSize = Math.max(0.001, riskAmount / 100) // Minimum 0.001

    // Reduce if position already exists (pyramid)
    const pyramidFactor = existingPosition ? 0.5 : 1.0

    return Math.floor(baseSize * pyramidFactor * 1000) / 1000
  }
}

// Export singleton
export const tradeOrchestrator = TradeExecutionOrchestrator.getInstance()
