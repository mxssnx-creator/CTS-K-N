// Order execution engine for trading bot
import { query } from "./db"

export interface OrderParams {
  user_id: number
  portfolio_id: number
  trading_pair_id: number
  order_type: "market" | "limit" | "stop_loss" | "take_profit"
  side: "buy" | "sell"
  price?: number
  quantity: number
  time_in_force?: "GTC" | "IOC" | "FOK"
}

export interface ExecutionResult {
  success: boolean
  order_id?: number
  filled_quantity?: number
  average_price?: number
  error?: string
}

export class OrderExecutor {
  async executeOrder(params: OrderParams): Promise<ExecutionResult> {
    try {
      console.log("[v0] Executing order:", params)

      // Create order in database
      const orderResult = await query(
        `INSERT INTO orders 
         (user_id, portfolio_id, trading_pair_id, order_type, side, price, quantity, 
          remaining_quantity, time_in_force, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9)
         RETURNING id`,
        [
          params.user_id,
          params.portfolio_id,
          params.trading_pair_id,
          params.order_type,
          params.side,
          params.price || null,
          params.quantity,
          params.time_in_force || "GTC",
          "pending",
        ],
      )

      const orderId = orderResult[0].id

      // Simulate order execution (in production, this would call exchange API)
      const executionPrice = params.price || (await this.getMarketPrice(params.trading_pair_id))
      const filledQuantity = params.quantity

      // Update order status
      await query(
        `UPDATE orders
         SET status = $1,
             filled_quantity = $2,
             average_fill_price = $3,
             executed_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        ["filled", filledQuantity, executionPrice, orderId],
      )

      // Create trade record
      await query(
        `INSERT INTO trades (order_id, price, quantity, executed_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
        [orderId, executionPrice, filledQuantity],
      )

      console.log(`[v0] Order ${orderId} executed successfully`)

      return {
        success: true,
        order_id: orderId,
        filled_quantity: filledQuantity,
        average_price: executionPrice,
      }
    } catch (error) {
      console.error("[v0] Order execution error:", error)
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }
    }
  }

  async cancelOrder(orderId: number, userId: number): Promise<boolean> {
    try {
      const result = await query(
        `UPDATE orders
         SET status = $1
         WHERE id = $2 AND user_id = $3 AND status IN ($4, $5)
         RETURNING id`,
        ["cancelled", orderId, userId, "pending", "open"],
      )

      return result.length > 0
    } catch (error) {
      console.error("[v0] Order cancellation error:", error)
      return false
    }
  }

  private async getMarketPrice(tradingPairId: number): Promise<number> {
    // In production, fetch from exchange API
    // For now, get latest market data from database
    const result = await query(
      `SELECT close FROM market_data
       WHERE trading_pair_id = $1
       ORDER BY timestamp DESC
       LIMIT 1`,
      [tradingPairId],
    )

    if (result.length > 0) {
      return result[0].close
    }

    // Fallback to a default price (should not happen in production)
    return 50000
  }

  async getOrderStatus(orderId: number, userId: number) {
    const result = await query(
      `SELECT o.*, tp.symbol
       FROM orders o
       JOIN trading_pairs tp ON o.trading_pair_id = tp.id
       WHERE o.id = $1 AND o.user_id = $2`,
      [orderId, userId],
    )

    return result[0] || null
  }
}
