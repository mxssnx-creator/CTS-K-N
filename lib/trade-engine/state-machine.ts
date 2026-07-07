/**
 * PHASE 5: Trade Engine State Machine
 * 
 * Orchestrates the complete trading lifecycle:
 * 1. Monitor positions and indicators
 * 2. Evaluate trading signals
 * 3. Execute orders with risk checks
 * 4. Track results and progression
 */

import { createExchangeConnector } from "@/lib/exchange-connectors"
import { positionTracker, LivePosition, OrderRecord } from "@/lib/positions/position-tracker"
import { indicatorCalculator, PriceData } from "@/lib/indicators/calculator"
import { getRedisClient, getConnection } from "@/lib/redis-db"
// shim: existing code uses redisDb.set; map to InlineLocalRedis instance.
const redisDb = {
  set: (key: string, val: string, opts?: { ex?: number }) =>
    opts?.ex ? getRedisClient().setex(key, opts.ex, val) : getRedisClient().set(key, val),
}

export interface TradeEngineConfig {
  connectionId: string
  symbols: string[]
  indicators: {
    rsi?: { enabled: boolean; period?: number }
    macd?: { enabled: boolean }
    bollinger?: { enabled: boolean }
    atr?: { enabled: boolean }
  }
  progressionLimits: {
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
  riskManagement: {
    maxPositionSize: number // % of balance
    maxLeveragePerPosition: number
    stopLossPercent: number
    takeProfitPercent: number
    maxConcurrentOrders: number
  }
}

export type EngineState = "idle" | "monitoring" | "evaluating" | "executing" | "error" | "stopped"

export class TradeEngineStateMachine {
  private state: EngineState = "idle"
  private config: TradeEngineConfig | null = null
  private statePrefix = "engine:"
  private monitoringTimer?: NodeJS.Timeout
  private isCycleRunning = false

  /**
   * Initialize engine with config
   */
  async initialize(config: TradeEngineConfig): Promise<boolean> {
    try {
      this.config = config
      this.state = "monitoring"

      const key = `${this.statePrefix}${config.connectionId}:config`
      await redisDb.set(key, JSON.stringify(config), { ex: 3600 })

      console.log(`[v0] [TradeEngine] Initialized for connection ${config.connectionId}`)
      console.log(`[v0] [TradeEngine] Monitoring symbols: ${config.symbols.join(", ")}`)

      return true
    } catch (error) {
      console.error(`[v0] [TradeEngine] Failed to initialize:`, error)
      this.state = "error"
      return false
    }
  }

  /**
   * Start monitoring cycle
   */
  async startMonitoringCycle(intervalMs: number = 5000): Promise<NodeJS.Timeout> {
    if (!this.config) {
      throw new Error("Engine not initialized")
    }

    // Prevent duplicate monitoring cycles
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer)
    }

    console.log(`[v0] [TradeEngine] Starting monitoring cycle (${intervalMs}ms interval)`)

    this.monitoringTimer = setInterval(async () => {
      if (this.isCycleRunning) return // Prevent overlap
      this.isCycleRunning = true
      try {
        await this.executeCycle()
      } finally {
        this.isCycleRunning = false
      }
    }, intervalMs)

    return this.monitoringTimer
  }

  /**
   * Execute one complete monitoring/trading cycle
   */
  private async executeCycle(): Promise<void> {
    if (!this.config) return

    try {
      this.state = "monitoring"

      // Load real credentials from DB so the connector can make authenticated
      // calls. Passing empty strings previously caused the factory to return a
      // SimulatedConnector, which never makes real exchange requests. The
      // state-machine cycle is used for legacy position tracking and is only
      // called when the full live-stage pipeline does NOT handle the symbol.
      const connData = await getConnection(this.config.connectionId)
      const connector = await createExchangeConnector(
        connData?.exchange || this.config.connectionId,
        {
          apiKey:    connData?.api_key    || "",
          apiSecret: connData?.api_secret || "",
          apiType:   connData?.api_type,
          contractType: connData?.contract_type,
          isTestnet: connData?.is_testnet === true || connData?.is_testnet === "true",
        },
      )

      // Get current balance
      const balance = await connector.getBalance()
      if (!balance.success) {
        console.warn(`[v0] [TradeEngine] Failed to get balance`)
        return
      }

      // Fetch fresh positions from exchange
      const exchangePositions = await connector.getPositions()

      // Update local position tracking
      for (const exPos of exchangePositions) {
        const exPosAny = exPos as any
        const localPos: LivePosition = {
          id: `${exPos.symbol}-${Date.now()}`,
          connection_id: this.config!.connectionId,
          symbol: exPos.symbol,
          side: exPosAny.side?.toUpperCase() === "LONG" ? "long" : "short",
          entry_price: typeof exPos.entryPrice === "number" ? exPos.entryPrice : parseFloat(String(exPos.entryPrice)),
          current_price: typeof exPos.markPrice === "number" ? exPos.markPrice : parseFloat(String(exPos.markPrice)),
          quantity: typeof exPos.contracts === "number" ? exPos.contracts : parseFloat(String(exPos.contracts)),
          leverage: typeof exPos.leverage === "number" ? exPos.leverage : parseFloat(String(exPos.leverage)),
          margin_type: exPosAny.marginType?.toUpperCase() === "CROSSED" ? "cross" : "isolated",
          unrealized_pnl: typeof exPos.unrealizedPnl === "number" ? exPos.unrealizedPnl : parseFloat(String(exPos.unrealizedPnl)),
          unrealized_pnl_percent: (typeof exPos.unrealizedPnl === "number" ? exPos.unrealizedPnl : parseFloat(String(exPos.unrealizedPnl))) / ((typeof exPos.contracts === "number" ? exPos.contracts : parseFloat(String(exPos.contracts))) * (typeof exPos.entryPrice === "number" ? exPos.entryPrice : parseFloat(String(exPos.entryPrice)))) * 100,
          liquidation_price: exPos.liquidationPrice ? (typeof exPos.liquidationPrice === "number" ? exPos.liquidationPrice : parseFloat(String(exPos.liquidationPrice))) : undefined,
          timestamp: Date.now(),
          last_update: Date.now(),
        }

        await positionTracker.recordPosition(localPos)
      }

      // Evaluate signals for each symbol IN PARALLEL — each symbol's
      // signal evaluation is independent (its own price stream + its
      // own indicator state) so there's no reason to serialise. Bug
      // fix: dense symbol baskets (e.g. 10+ symbols) used to multiply
      // exchange-API latency by N because of the awaited for-loop.
      // `allSettled` keeps a single symbol's failure from aborting
      // the rest of the cycle — errors are already logged inside
      // `evaluateAndTrade`.
      this.state = "evaluating"

      await Promise.allSettled(
        this.config.symbols.map((symbol) => this.evaluateAndTrade(symbol, connector)),
      )

      this.state = "monitoring"
    } catch (error) {
      console.error(`[v0] [TradeEngine] Cycle error:`, error)
      this.state = "error"
    }
  }

  /**
   * Evaluate indicators and execute trading logic
   */
  private async evaluateAndTrade(symbol: string, connector: any): Promise<void> {
    if (!this.config) return

    try {
      // Get REAL price data from exchange connector
      const priceData = await connector.getLatestPriceData(symbol, 100) // Last 100 candles

      // Evaluate signals with REAL market data
      const signals = await indicatorCalculator.evaluateSignals(symbol, priceData, this.config.indicators)

      if (signals.signal === "buy" && signals.strength > 0.5) {
        await this.executeBuySignal(symbol, connector, signals.strength)
      } else if (signals.signal === "sell" && signals.strength > 0.5) {
        await this.executeSellSignal(symbol, connector, signals.strength)
      }
    } catch (error) {
      console.error(`[v0] [TradeEngine] Failed to evaluate ${symbol}:`, error)
    }
  }

  /**
   * Execute buy signal
   */
  private async executeBuySignal(symbol: string, connector: any, strength: number): Promise<void> {
    if (!this.config) return

    try {
      this.state = "executing"

      // Validate progression limits
      const validation = await positionTracker.validateProgressionLimits(
        this.config.connectionId,
        symbol,
        "long",
        this.config.progressionLimits.long
      )

      if (!validation.valid) {
        console.log(`[v0] [TradeEngine] Buy signal rejected: ${validation.reason}`)
        return
      }

      // Calculate position size based on risk
      const exposure = await positionTracker.calculateExposure(this.config.connectionId)
      const maxPositionSize = this.config.riskManagement.maxPositionSize
      const availableRisk = Math.max(0, maxPositionSize - exposure.riskExposure)

      if (availableRisk < 1) {
        console.log(`[v0] [TradeEngine] Insufficient risk allocation (${availableRisk}%)`)
        return
      }

      // Place order
      const quantity = Math.round((availableRisk / 100) * strength * 1000) / 1000
      const result = await connector.placeOrder(symbol, "buy", quantity, undefined, "market")

      if (result.success) {
        // Record order
        const order: OrderRecord = {
          id: result.orderId || `order-${Date.now()}`,
          connection_id: this.config.connectionId,
          symbol,
          side: "buy",
          quantity,
          price: 0, // Will be filled
          order_type: "market",
          status: "pending",
          filled_quantity: 0,
          filled_price: 0,
          timestamp: Date.now(),
        }

        await positionTracker.recordOrder(order)
        console.log(`[v0] [TradeEngine] Buy order placed: ${symbol} x${quantity}`)
      }

      this.state = "monitoring"
    } catch (error) {
      console.error(`[v0] [TradeEngine] Failed to execute buy signal:`, error)
      this.state = "error"
    }
  }

  /**
   * Execute sell signal
   */
  private async executeSellSignal(symbol: string, connector: any, strength: number): Promise<void> {
    if (!this.config) return

    try {
      this.state = "executing"

      // Get existing long position
      const position = await positionTracker.getPosition(this.config.connectionId, symbol)

      if (!position || position.side !== "long") {
        console.log(`[v0] [TradeEngine] No long position to sell for ${symbol}`)
        return
      }

      // Close position
      const result = await connector.closePosition(symbol)

      if (result.success) {
        await positionTracker.removePosition(this.config.connectionId, symbol)
        console.log(`[v0] [TradeEngine] Sell order executed: ${symbol}`)
      }

      this.state = "monitoring"
    } catch (error) {
      console.error(`[v0] [TradeEngine] Failed to execute sell signal:`, error)
      this.state = "error"
    }
  }

  /**
   * Get current state
   */
  getState(): EngineState {
    return this.state
  }

  /**
   * Stop engine gracefully
   */
  async stop(): Promise<void> {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer)
      this.monitoringTimer = undefined
    }
    this.state = "stopped"
    console.log(`[v0] [TradeEngine] Stopped`)
  }

  /**
   * Emergency close all positions
   */
  async emergencyClose(connector: any): Promise<number> {
    if (!this.config) return 0

    try {
      console.log(`[v0] [TradeEngine] EMERGENCY: Closing all positions`)

      const positions = await positionTracker.getPositions(this.config.connectionId)
      let closedCount = 0

      for (const pos of positions) {
        try {
          const result = await connector.closePosition(pos.symbol)
          if (result.success) {
            await positionTracker.removePosition(this.config.connectionId, pos.symbol)
            closedCount++
          }
        } catch (error) {
          console.error(`[v0] [TradeEngine] Failed to close ${pos.symbol}:`, error)
        }
      }

      console.log(`[v0] [TradeEngine] Emergency close: ${closedCount}/${positions.length} positions closed`)
      return closedCount
    } catch (error) {
      console.error(`[v0] [TradeEngine] Emergency close failed:`, error)
      return 0
    }
  }
}

// Export singleton
export const tradeEngine = new TradeEngineStateMachine()
