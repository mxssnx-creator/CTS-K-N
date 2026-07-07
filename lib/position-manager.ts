// Position management for trading bot
import { query } from "./db"
import { OrderExecutor } from "./order-executor"

export interface PositionUpdate {
  current_price: number
  unrealized_pnl: number
}

export class PositionManager {
  private orderExecutor: OrderExecutor

  constructor() {
    this.orderExecutor = new OrderExecutor()
  }

  async updatePosition(positionId: number, update: PositionUpdate): Promise<void> {
    await query(
      `UPDATE positions
       SET current_price = $1,
           unrealized_pnl = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [update.current_price, update.unrealized_pnl, positionId],
    )
  }

  async checkStopLossAndTakeProfit(positionId: number): Promise<boolean> {
    const positions = await query(
      `SELECT p.*, tp.symbol, pf.user_id
       FROM positions p
       JOIN trading_pairs tp ON p.trading_pair_id = tp.id
       JOIN portfolios pf ON p.portfolio_id = pf.id
       WHERE p.id = $1 AND p.status = $2`,
      [positionId, "open"],
    )

    if (positions.length === 0) return false

    const position = positions[0]
    let shouldClose = false
    let closeReason = ""

    // Check stop loss
    if (position.stop_loss) {
      if (position.position_type === "long" && position.current_price <= position.stop_loss) {
        shouldClose = true
        closeReason = "Stop loss triggered"
      } else if (position.position_type === "short" && position.current_price >= position.stop_loss) {
        shouldClose = true
        closeReason = "Stop loss triggered"
      }
    }

    // Check take profit
    if (position.take_profit && !shouldClose) {
      if (position.position_type === "long" && position.current_price >= position.take_profit) {
        shouldClose = true
        closeReason = "Take profit triggered"
      } else if (position.position_type === "short" && position.current_price <= position.take_profit) {
        shouldClose = true
        closeReason = "Take profit triggered"
      }
    }

    if (shouldClose) {
      console.log(`[v0] ${closeReason} for position ${positionId}`)
      await this.closePosition(positionId, position.user_id, closeReason)
      return true
    }

    return false
  }

  async closePosition(positionId: number, userId: number, reason: string): Promise<boolean> {
    try {
      const positions = await query(`SELECT * FROM positions WHERE id = $1 AND status = $2`, [positionId, "open"])

      if (positions.length === 0) return false

      const position = positions[0]

      // Calculate realized PnL
      const realizedPnl = this.calculateRealizedPnL(position)

      // Execute closing order
      const closeSide = position.position_type === "long" ? "sell" : "buy"

      const executionResult = await this.orderExecutor.executeOrder({
        user_id: userId,
        portfolio_id: position.portfolio_id,
        trading_pair_id: position.trading_pair_id,
        order_type: "market",
        side: closeSide,
        quantity: position.quantity,
      })

      if (!executionResult.success) {
        console.error("[v0] Failed to execute closing order:", executionResult.error)
        return false
      }

      // Update position status
      await query(
        `UPDATE positions
         SET status = $1,
             realized_pnl = $2,
             closed_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        ["closed", realizedPnl, positionId],
      )

      // Update portfolio value
      await this.updatePortfolioValue(position.portfolio_id, realizedPnl)

      console.log(`[v0] Position ${positionId} closed. Reason: ${reason}. PnL: ${realizedPnl}`)

      return true
    } catch (error) {
      console.error("[v0] Error closing position:", error)
      return false
    }
  }

  private calculateRealizedPnL(position: any): number {
    const priceDiff = position.current_price - position.entry_price
    const multiplier = position.position_type === "long" ? 1 : -1

    return priceDiff * position.quantity * multiplier * position.leverage
  }

  private async updatePortfolioValue(portfolioId: number, pnlChange: number): Promise<void> {
    await query(
      `UPDATE portfolios
       SET total_value = total_value + $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [pnlChange, portfolioId],
    )
  }

  async getOpenPositions(portfolioId: number) {
    return await query(
      `SELECT p.*, tp.symbol, tp.base_currency, tp.quote_currency
       FROM positions p
       JOIN trading_pairs tp ON p.trading_pair_id = tp.id
       WHERE p.portfolio_id = $1 AND p.status = $2
       ORDER BY p.opened_at DESC`,
      [portfolioId, "open"],
    )
  }

  async updateTrailingStop(positionId: number): Promise<void> {
    const positions = await query("SELECT * FROM positions WHERE id = $1 AND status = $2", [positionId, "open"])

    if (positions.length === 0) return

    const position = positions[0]

    // Only update if position has unrealized profit
    if (position.unrealized_pnl <= 0) return

    // Calculate new trailing stop based on current price
    const trailingStopDistance = position.entry_price * 0.02 // 2% trailing

    let newStopLoss: number

    if (position.position_type === "long") {
      newStopLoss = position.current_price - trailingStopDistance
      // Only update if new stop loss is higher than current
      if (!position.stop_loss || newStopLoss > position.stop_loss) {
        await query("UPDATE positions SET stop_loss = $1 WHERE id = $2", [newStopLoss, positionId])
        console.log(`[v0] Updated trailing stop for position ${positionId} to ${newStopLoss}`)
      }
    } else {
      newStopLoss = position.current_price + trailingStopDistance
      // Only update if new stop loss is lower than current
      if (!position.stop_loss || newStopLoss < position.stop_loss) {
        await query("UPDATE positions SET stop_loss = $1 WHERE id = $2", [newStopLoss, positionId])
        console.log(`[v0] Updated trailing stop for position ${positionId} to ${newStopLoss}`)
      }
    }
  }
}
