/**
 * Exchange Position Manager
 * Redis-native: All data stored in Redis via redis-db
 *
 * SYSTEM INTERNAL - FOR REAL STRATEGY MIRRORING ONLY
 * Logs actual exchange live positions for history and statistics.
 */

import { initRedis, getRedisClient, getSettings, setSettings } from "@/lib/redis-db"
import { VolumeCalculator } from "./volume-calculator"

export interface ExchangePositionCreateParams {
  connectionId: string
  realPseudoPositionId: string
  mainPseudoPositionId?: string
  basePseudoPositionId?: string
  exchangeId: string
  exchangeOrderId?: string
  symbol: string
  side: "long" | "short"
  entryPrice: number
  quantity: number
  volumeUsd: number
  leverage?: number
  takeprofit?: number
  stoploss?: number
  trailingEnabled?: boolean
  trailStart?: number
  trailStop?: number
  tradeMode: "preset" | "main"
  indicationType?: string
  // ── Set lineage (optional, mirrored from the upstream Real position
  //    when the real position descends from a coordinated Main Set) ────
  // These tags travel from Strategy-Coordinator (Main) → Real → Live
  // and end up on the persisted exchange-position record so post-trade
  // statistics can dimension by Set Type. All optional; manual / legacy
  // call sites continue to work unchanged. Field meaning matches
  // `LivePosition.setKey` etc. exactly — see live-stage.ts for docs.
  setKey?: string
  parentSetKey?: string
  setVariant?: "default" | "trailing" | "block" | "dca"
  axisWindows?: { prev: number; last: number; cont: number; pause: number }
}

export interface ExchangePositionUpdateParams {
  currentPrice: number
  unrealizedPnl: number
  realizedPnl?: number
  feesPaid?: number
  fundingFees?: number
  trailActivated?: boolean
  trailHighPrice?: number
}

export interface ExchangePositionCloseParams {
  closedPrice: number
  realizedPnl: number
  feesPaid: number
  closeReason: "take_profit" | "stop_loss" | "manual" | "liquidated" | "trailing_stop"
}

export class ExchangePositionManager {
  private connectionId: string

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  /**
   * Mirror a Real Pseudo Position to Active Exchange Position
   */
  async mirrorToExchange(params: ExchangePositionCreateParams): Promise<string> {
    const positionId = `aex_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    try {
      await initRedis()
      const client = getRedisClient()

      const volumeResult = await VolumeCalculator.calculateVolumeForConnection(
        params.connectionId,
        params.symbol,
        params.entryPrice,
      )

      const finalQuantity = volumeResult.volume
      const finalVolumeUsd = volumeResult.volumeUsd ?? 0
      const finalLeverage = volumeResult.leverage

      // Compute used balance (margin) alongside the leveraged notional
      // so post-trade stats and dashboards can dimension by either
      // figure without re-deriving on read. Margin = notional / leverage.
      const marginUsd = (finalLeverage ?? 0) > 0 ? finalVolumeUsd / (finalLeverage ?? 1) : finalVolumeUsd

      const position = {
        id: positionId,
        connection_id: params.connectionId,
        real_pseudo_position_id: params.realPseudoPositionId,
        main_pseudo_position_id: params.mainPseudoPositionId || null,
        base_pseudo_position_id: params.basePseudoPositionId || null,
        exchange_id: params.exchangeId,
        exchange_order_id: params.exchangeOrderId || null,
        symbol: params.symbol,
        side: params.side,
        entry_price: params.entryPrice,
        current_price: params.entryPrice,
        quantity: finalQuantity,
        volume_usd: finalVolumeUsd,
        margin_usd: Math.round(marginUsd * 100) / 100,
        leverage: finalLeverage,
        takeprofit: params.takeprofit || null,
        stoploss: params.stoploss || null,
        trailing_enabled: params.trailingEnabled || false,
        trail_start: params.trailStart || null,
        trail_stop: params.trailStop || null,
        trail_activated: false,
        trail_high_price: null,
        trade_mode: params.tradeMode,
        indication_type: params.indicationType || null,
        // ── Set lineage (Main → Real → Live → Exchange) ────────────────
        // These tags let the operator and downstream analytics rebuild
        // the Set Type chain that produced any given exchange position.
        // Legacy callers that pass nothing default to null, so the JSON
        // shape stays consistent across new and old records.
        set_key:         params.setKey         || null,
        parent_set_key:  params.parentSetKey   || null,
        set_variant:     params.setVariant     || null,
        axis_windows:    params.axisWindows    || null,
        status: "open",
        sync_status: "synced",
        unrealized_pnl: 0,
        realized_pnl: 0,
        fees_paid: 0,
        funding_fees: 0,
        max_profit: 0,
        max_loss: 0,
        max_drawdown: 0,
        price_high: params.entryPrice,
        price_low: params.entryPrice,
        opened_at: new Date().toISOString(),
        closed_at: null,
        hold_duration_seconds: 0,
      }

      await setSettings(`exchange_position:${positionId}`, position)
      await client.sadd(`exchange_positions:${params.connectionId}`, positionId)
      await client.sadd(`exchange_positions:${params.connectionId}:open`, positionId)
      await client.sadd(`exchange_positions:${params.connectionId}:${params.symbol}`, positionId)

      // Index by exchange ID for fast lookups
      await setSettings(`exchange_position_by_eid:${params.exchangeId}`, { id: positionId })

      await this.logCoordinationEvent({
        connectionId: params.connectionId,
        exchangePositionId: positionId,
        exchangeId: params.exchangeId,
        eventType: "position_opened",
        eventData: JSON.stringify({
          ...params,
          calculatedVolume: finalQuantity,
          calculatedVolumeUsd: finalVolumeUsd,
          calculatedLeverage: finalLeverage,
        }),
        triggeredBy: "system",
      })

      console.log(`[v0] Mirrored position to exchange: ${positionId} (Vol: ${finalQuantity}, USD: ${finalVolumeUsd}, Lev: ${finalLeverage}x)`)
      return positionId
    } catch (error) {
      console.error("[v0] Failed to mirror position to exchange:", error)
      throw error
    }
  }

  /**
   * Update exchange position with current market data
   */
  async updatePosition(exchangeId: string, updates: ExchangePositionUpdateParams): Promise<void> {
    const startTime = Date.now()

    try {
      await initRedis()

      // Find position by exchange ID
      const lookup = await getSettings(`exchange_position_by_eid:${exchangeId}`)
      if (!lookup?.id) {
        console.warn(`[v0] Position not found for exchange ID: ${exchangeId}`)
        return
      }

      const position = await getSettings(`exchange_position:${lookup.id}`)
      if (!position || position.status !== "open") return

      const pnlChange = updates.unrealizedPnl - (position.unrealized_pnl || 0)
      const maxProfit = Math.max(position.max_profit || 0, updates.unrealizedPnl)
      const maxLoss = Math.min(position.max_loss || 0, updates.unrealizedPnl)
      const priceHigh = Math.max(position.price_high || position.entry_price, updates.currentPrice)
      const priceLow = Math.min(position.price_low || position.entry_price, updates.currentPrice)
      const currentDrawdown = maxProfit > 0 ? ((maxProfit - updates.unrealizedPnl) / maxProfit) * 100 : 0
      const maxDrawdown = Math.max(position.max_drawdown || 0, currentDrawdown)

      let trailActivated = position.trail_activated
      let trailHighPrice = position.trail_high_price

      if (position.trailing_enabled && !trailActivated) {
        // For shorts, price DROP is profitable — invert the direction
        // so trail_start correctly gates at a positive percentage.
        const priceDelta = position.direction === "short"
          ? (position.entry_price - updates.currentPrice)
          : (updates.currentPrice - position.entry_price)
        const profitPercent = (priceDelta / position.entry_price) * 100
        if (profitPercent >= (position.trail_start || 0)) {
          trailActivated = true
          trailHighPrice = updates.currentPrice
        }
      }

      if (trailActivated) {
        // Trail-high: tracks the most-favourable price since activation.
        // For longs, that's the HIGHEST price; for shorts, the LOWEST.
        const isFavourable = position.direction === "short"
          ? updates.currentPrice < (trailHighPrice || Infinity)
          : updates.currentPrice > (trailHighPrice || -Infinity)
        if (isFavourable) {
          trailHighPrice = updates.currentPrice
        }
      }

      await setSettings(`exchange_position:${lookup.id}`, {
        ...position,
        current_price: updates.currentPrice,
        unrealized_pnl: updates.unrealizedPnl,
        realized_pnl: updates.realizedPnl ?? position.realized_pnl,
        fees_paid: updates.feesPaid ?? position.fees_paid,
        funding_fees: updates.fundingFees ?? position.funding_fees,
        max_profit: maxProfit,
        max_loss: maxLoss,
        max_drawdown: maxDrawdown,
        price_high: priceHigh,
        price_low: priceLow,
        trail_activated: trailActivated,
        trail_high_price: trailHighPrice,
        last_updated_at: new Date().toISOString(),
        last_sync_at: new Date().toISOString(),
        sync_status: "synced",
      })

      await this.logCoordinationEvent({
        connectionId: position.connection_id,
        exchangePositionId: lookup.id,
        exchangeId,
        eventType: "price_updated",
        eventData: JSON.stringify({ price: updates.currentPrice, pnl: updates.unrealizedPnl, pnlChange }),
        processingDurationMs: Date.now() - startTime,
        triggeredBy: "system",
      })
    } catch (error) {
      console.error(`[v0] Failed to update position ${exchangeId}:`, error)

      const lookup = await getSettings(`exchange_position_by_eid:${exchangeId}`)
      if (lookup?.id) {
        const pos = await getSettings(`exchange_position:${lookup.id}`)
        if (pos) {
          await setSettings(`exchange_position:${lookup.id}`, {
            ...pos,
            sync_status: "error",
            sync_error_message: error instanceof Error ? error.message : "Unknown error",
            sync_retry_count: (pos.sync_retry_count || 0) + 1,
          })
        }
      }
      throw error
    }
  }

  /**
   * Close exchange position
   */
  async closePosition(exchangeId: string, closeParams: ExchangePositionCloseParams): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()

      const lookup = await getSettings(`exchange_position_by_eid:${exchangeId}`)
      if (!lookup?.id) {
        console.warn(`[v0] Position not found for closing: ${exchangeId}`)
        return
      }

      const position = await getSettings(`exchange_position:${lookup.id}`)
      if (!position || position.status !== "open") return

      const holdDuration = Math.floor((Date.now() - new Date(position.opened_at).getTime()) / 1000)

      await setSettings(`exchange_position:${lookup.id}`, {
        ...position,
        current_price: closeParams.closedPrice,
        realized_pnl: closeParams.realizedPnl,
        fees_paid: closeParams.feesPaid,
        status: "closed",
        closed_at: new Date().toISOString(),
        hold_duration_seconds: holdDuration,
        last_updated_at: new Date().toISOString(),
      })

      // Move from open set to closed set
      await client.srem(`exchange_positions:${position.connection_id}:open`, lookup.id)
      await client.sadd(`exchange_positions:${position.connection_id}:closed`, lookup.id)

      await this.updateStatistics(
        position.connection_id,
        position.symbol,
        position.indication_type,
        position.trade_mode,
      )

      await this.logCoordinationEvent({
        connectionId: position.connection_id,
        exchangePositionId: lookup.id,
        exchangeId,
        eventType: closeParams.closeReason.includes("profit")
          ? "take_profit_hit"
          : closeParams.closeReason.includes("loss")
            ? "stop_loss_hit"
            : "manual_close",
        eventData: JSON.stringify(closeParams),
        triggeredBy: closeParams.closeReason === "manual" ? "manual" : "system",
      })

      console.log(`[v0] Closed position ${exchangeId} (Reason: ${closeParams.closeReason}, PnL: ${closeParams.realizedPnl})`)
    } catch (error) {
      console.error(`[v0] Failed to close position ${exchangeId}:`, error)
      throw error
    }
  }

  /**
   * Update statistics using Redis
   */
  private async updateStatistics(
    connectionId: string,
    symbol: string,
    indicationType: string | null,
    tradeMode: "preset" | "main",
  ): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()

      // Get all positions for this connection+symbol from the last 24h
      const allPosIds = await client.smembers(`exchange_positions:${connectionId}:${symbol}`)
      const periodStart = Date.now() - 24 * 60 * 60 * 1000
      const positions: any[] = []

      for (const posId of allPosIds) {
        const pos = await getSettings(`exchange_position:${posId}`)
        if (!pos) continue
        if (pos.indication_type !== indicationType || pos.trade_mode !== tradeMode) continue
        if (new Date(pos.opened_at).getTime() < periodStart) continue
        positions.push(pos)
      }

      if (positions.length === 0) return

      const closedPositions = positions.filter((p) => p.status === "closed")
      const winningPositions = closedPositions.filter((p) => (p.realized_pnl || 0) > 0).length
      const losingPositions = closedPositions.filter((p) => (p.realized_pnl || 0) < 0).length

      const totalPnl = closedPositions.reduce((sum, p) => sum + (p.realized_pnl || 0), 0)
      const totalFees = closedPositions.reduce((sum, p) => sum + (p.fees_paid || 0), 0)
      const netPnl = totalPnl - totalFees

      const winRate = (winningPositions + losingPositions) > 0 ? winningPositions / (winningPositions + losingPositions) : 0

      const totalWins = closedPositions.filter((p) => (p.realized_pnl || 0) > 0).reduce((sum, p) => sum + (p.realized_pnl || 0), 0)
      const totalLosses = Math.abs(closedPositions.filter((p) => (p.realized_pnl || 0) < 0).reduce((sum, p) => sum + (p.realized_pnl || 0), 0))
      
      // Cost-adjusted PF: totalWinPnL / (totalLossPnL + totalPositionCosts)
      // Position cost = entry_price × quantity × 0.001 (0.1% maker fee)
      const totalPositionCosts = closedPositions.reduce((sum, p) => {
        if (Number.isFinite(p.entry_price) && Number.isFinite(p.quantity) && 
            p.entry_price > 0 && p.quantity > 0) {
          return sum + (p.entry_price * p.quantity * 0.001)
        }
        return sum
      }, 0)
      
      const adjustedDenominator = totalLosses + totalPositionCosts
      const profitFactor = adjustedDenominator > 0 ? totalWins / adjustedDenominator : totalWins > 0 ? 999 : 0

      const statsKey = `exchange_stats:${connectionId}:${symbol}:${indicationType || "preset"}:${tradeMode}`
      await setSettings(statsKey, {
        connection_id: connectionId,
        symbol,
        indication_type: indicationType,
        trade_mode: tradeMode,
        total_positions: positions.length,
        winning_positions: winningPositions,
        losing_positions: losingPositions,
        total_pnl: totalPnl,
        total_fees: totalFees,
        net_pnl: netPnl,
        win_rate: winRate,
        profit_factor: profitFactor,
        last_calculated_at: new Date().toISOString(),
      })
    } catch (error) {
      console.error("[v0] Failed to update statistics:", error)
    }
  }

  /**
   * Log coordination event to Redis
   */
  private async logCoordinationEvent(params: {
    connectionId: string
    exchangePositionId?: string
    exchangeId: string
    eventType: string
    eventData?: string
    oldState?: string
    newState?: string
    success?: boolean
    errorMessage?: string
    processingDurationMs?: number
    triggeredBy: string
  }): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()
      const logId = `coord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

      await setSettings(`coord_log:${params.connectionId}:${logId}`, {
        ...params,
        success: params.success === true,
        timestamp: new Date().toISOString(),
      })

      // Store in Redis list instead of sorted set (Upstash doesn't support zadd)
      const coordLogsKey = `coord_logs:${params.connectionId}`
      let coordLogs: string[] = []
      
      const existing = await client.get(coordLogsKey)
      if (existing) {
        try { coordLogs = JSON.parse(existing) } catch { coordLogs = [] }
      }
      
      // Prepend new entry
      coordLogs.unshift(logId)
      
      // Trim to max 500 entries
      if (coordLogs.length > 500) {
        const toRemove = coordLogs.slice(500)
        for (const id of toRemove) {
          await client.del(`coord_log:${params.connectionId}:${id}`)
        }
        coordLogs = coordLogs.slice(0, 500)
      }
      
      await client.set(coordLogsKey, JSON.stringify(coordLogs))
    } catch (error) {
      console.error("[v0] Failed to log coordination event:", error)
    }
  }

  /**
   * Get active positions for a connection from Redis
   */
  async getActivePositions(filters?: {
    symbol?: string
    side?: "long" | "short"
    tradeMode?: "preset" | "main"
    indicationType?: string
  }): Promise<any[]> {
    try {
      await initRedis()
      const client = getRedisClient()

      const openIds = await client.smembers(`exchange_positions:${this.connectionId}:open`)
      const positions: any[] = []

      for (const posId of openIds) {
        const pos = await getSettings(`exchange_position:${posId}`)
        if (!pos) continue

        if (filters?.symbol && pos.symbol !== filters.symbol) continue
        if (filters?.side && pos.side !== filters.side) continue
        if (filters?.tradeMode && pos.trade_mode !== filters.tradeMode) continue
        if (filters?.indicationType && pos.indication_type !== filters.indicationType) continue

        positions.push(pos)
      }

      return positions.sort((a, b) => new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime())
    } catch (error) {
      console.error("[v0] Failed to get active positions:", error)
      return []
    }
  }

  /**
   * Get statistics for a symbol from Redis
   */
  async getStatistics(symbol: string, indicationType?: string, _hours = 24): Promise<any> {
    try {
      await initRedis()
      const statsKey = `exchange_stats:${this.connectionId}:${symbol}:${indicationType || "preset"}:preset`
      return await getSettings(statsKey) || null
    } catch (error) {
      console.error("[v0] Failed to get statistics:", error)
      return null
    }
  }

  /**
   * Get coordination logs from Redis
   */
  async getCoordinationLogs(exchangeId?: string, limit = 100): Promise<any[]> {
    try {
      await initRedis()
      const client = getRedisClient()

      // Use list-based approach
      const coordLogsKey = `coord_logs:${this.connectionId}`
      const existing = await client.get(coordLogsKey)
      let logIds: string[] = []
      if (existing) {
        try { logIds = JSON.parse(existing) } catch { logIds = [] }
      }
      const logs: any[] = []

      for (const logId of logIds.reverse()) {
        const log = await getSettings(`coord_log:${this.connectionId}:${logId}`)
        if (!log) continue
        if (exchangeId && log.exchangeId !== exchangeId) continue
        logs.push(log)
      }

      return logs.slice(0, limit)
    } catch (error) {
      console.error("[v0] Failed to get coordination logs:", error)
      return []
    }
  }
}
