// Risk management system for trading bot
import { query } from "./db"

export interface RiskLimits {
  max_position_size: number
  max_daily_loss: number
  max_drawdown_percent: number
  max_leverage: number
  max_open_positions: number
}

export interface RiskCheck {
  allowed: boolean
  reason?: string
  current_exposure?: number
  available_capital?: number
}

export class RiskManager {
  private portfolioId: number
  private limits: RiskLimits

  constructor(portfolioId: number, limits: RiskLimits) {
    this.portfolioId = portfolioId
    this.limits = limits
  }

  async checkPositionRisk(quantity: number, price: number, leverage = 1.0): Promise<RiskCheck> {
    // Check leverage limit
    if (leverage > this.limits.max_leverage) {
      return {
        allowed: false,
        reason: `Leverage ${leverage}x exceeds maximum ${this.limits.max_leverage}x`,
      }
    }

    // Calculate position size
    const positionSize = quantity * price * leverage

    // Check position size limit
    if (positionSize > this.limits.max_position_size) {
      return {
        allowed: false,
        reason: `Position size $${positionSize} exceeds maximum $${this.limits.max_position_size}`,
      }
    }

    // Check open positions count
    const openPositions = await query(
      "SELECT COUNT(*) as count FROM positions WHERE portfolio_id = $1 AND status = $2",
      [this.portfolioId, "open"],
    )

    const currentOpenCount = openPositions[0]?.count || 0

    if (currentOpenCount >= this.limits.max_open_positions) {
      return {
        allowed: false,
        reason: `Maximum open positions (${this.limits.max_open_positions}) reached`,
      }
    }

    // Check daily loss limit
    const dailyPnL = await this.getDailyPnL()

    if (dailyPnL < -this.limits.max_daily_loss) {
      return {
        allowed: false,
        reason: `Daily loss limit reached: $${Math.abs(dailyPnL)} / $${this.limits.max_daily_loss}`,
      }
    }

    // Check drawdown
    const drawdown = await this.getCurrentDrawdown()

    if (drawdown > this.limits.max_drawdown_percent) {
      return {
        allowed: false,
        reason: `Drawdown ${drawdown}% exceeds maximum ${this.limits.max_drawdown_percent}%`,
      }
    }

    // Get portfolio value for exposure calculation
    const portfolio = await query("SELECT total_value FROM portfolios WHERE id = $1", [this.portfolioId])

    const portfolioValue = portfolio[0]?.total_value || 0
    const currentExposure = await this.getTotalExposure()

    return {
      allowed: true,
      current_exposure: currentExposure,
      available_capital: portfolioValue - currentExposure,
    }
  }

  private async getDailyPnL(): Promise<number> {
    const result = await query(
      `SELECT COALESCE(SUM(realized_pnl), 0) as daily_pnl
       FROM positions
       WHERE portfolio_id = $1
       AND closed_at >= CURRENT_DATE`,
      [this.portfolioId],
    )

    return result[0]?.daily_pnl || 0
  }

  private async getCurrentDrawdown(): Promise<number> {
    const portfolio = await query("SELECT total_value, initial_value FROM portfolios WHERE id = $1", [this.portfolioId])

    if (portfolio.length === 0) return 0

    const { total_value, initial_value } = portfolio[0]

    if (initial_value === 0) return 0

    const drawdown = ((initial_value - total_value) / initial_value) * 100

    return Math.max(0, drawdown)
  }

  private async getTotalExposure(): Promise<number> {
    const result = await query(
      `SELECT COALESCE(SUM(quantity * current_price * leverage), 0) as exposure
       FROM positions
       WHERE portfolio_id = $1 AND status = $2`,
      [this.portfolioId, "open"],
    )

    return result[0]?.exposure || 0
  }

  async updateRiskLimits(newLimits: Partial<RiskLimits>): Promise<void> {
    this.limits = { ...this.limits, ...newLimits }

    await query(
      `UPDATE risk_limits
       SET max_position_size = $1,
           max_daily_loss = $2,
           max_drawdown_percent = $3,
           max_leverage = $4,
           max_open_positions = $5
       WHERE portfolio_id = $6`,
      [
        this.limits.max_position_size,
        this.limits.max_daily_loss,
        this.limits.max_drawdown_percent,
        this.limits.max_leverage,
        this.limits.max_open_positions,
        this.portfolioId,
      ],
    )
  }
}
