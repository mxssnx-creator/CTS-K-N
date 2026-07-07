// Portfolio analytics and performance tracking
import { query } from "./db"

export interface PortfolioMetrics {
  total_value: number
  total_return: number
  total_return_percent: number
  daily_pnl: number
  weekly_pnl: number
  monthly_pnl: number
  sharpe_ratio: number
  max_drawdown: number
  win_rate: number
  profit_factor: number
  average_win: number
  average_loss: number
  total_trades: number
  winning_trades: number
  losing_trades: number
}

export class PortfolioAnalytics {
  private portfolioId: number

  constructor(portfolioId: number) {
    this.portfolioId = portfolioId
  }

  async calculateMetrics(): Promise<PortfolioMetrics> {
    const portfolio = await this.getPortfolioData()
    const positions = await this.getClosedPositions()

    const totalReturn = portfolio.total_value - portfolio.initial_value
    const totalReturnPercent = (totalReturn / portfolio.initial_value) * 100

    const dailyPnL = await this.calculatePeriodPnL(1)
    const weeklyPnL = await this.calculatePeriodPnL(7)
    const monthlyPnL = await this.calculatePeriodPnL(30)

    const winningPositions = positions.filter((p) => p.realized_pnl > 0)
    const losingPositions = positions.filter((p) => p.realized_pnl <= 0)

    const totalWins = winningPositions.reduce((sum, p) => sum + p.realized_pnl, 0)
    const totalLosses = Math.abs(losingPositions.reduce((sum, p) => sum + p.realized_pnl, 0))

    const winRate = positions.length > 0 ? (winningPositions.length / positions.length) * 100 : 0
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? 999 : 0
    const averageWin = winningPositions.length > 0 ? totalWins / winningPositions.length : 0
    const averageLoss = losingPositions.length > 0 ? totalLosses / losingPositions.length : 0

    const sharpeRatio = await this.calculateSharpeRatio()
    const maxDrawdown = await this.calculateMaxDrawdown()

    return {
      total_value: portfolio.total_value,
      total_return: totalReturn,
      total_return_percent: totalReturnPercent,
      daily_pnl: dailyPnL,
      weekly_pnl: weeklyPnL,
      monthly_pnl: monthlyPnL,
      sharpe_ratio: sharpeRatio,
      max_drawdown: maxDrawdown,
      win_rate: winRate,
      profit_factor: profitFactor,
      average_win: averageWin,
      average_loss: averageLoss,
      total_trades: positions.length,
      winning_trades: winningPositions.length,
      losing_trades: losingPositions.length,
    }
  }

  private async getPortfolioData() {
    const result = await query("SELECT * FROM portfolios WHERE id = $1", [this.portfolioId])
    return result[0]
  }

  private async getClosedPositions() {
    return await query(
      `SELECT * FROM positions 
       WHERE portfolio_id = $1 AND status = $2
       ORDER BY closed_at DESC`,
      [this.portfolioId, "closed"],
    )
  }

  private async calculatePeriodPnL(days: number): Promise<number> {
    const result = await query(
      `SELECT COALESCE(SUM(realized_pnl), 0) as pnl
       FROM positions
       WHERE portfolio_id = ? 
       AND status = ?
       AND closed_at >= datetime('now', '-${days} days')`,
      [this.portfolioId, "closed"],
    )

    return result[0]?.pnl || 0
  }

  private async calculateSharpeRatio(): Promise<number> {
    // Simplified Sharpe ratio calculation
    const returns = await query(
      `SELECT realized_pnl, closed_at
       FROM positions
       WHERE portfolio_id = $1 AND status = $2
       ORDER BY closed_at ASC`,
      [this.portfolioId, "closed"],
    )

    if (returns.length < 2) return 0

    const dailyReturns = returns.map((r) => r.realized_pnl)
    const avgReturn = dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length
    const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (dailyReturns.length - 1)
    const stdDev = Math.sqrt(variance)

    // Assuming risk-free rate of 0 for simplicity
    return stdDev > 0 ? avgReturn / stdDev : 0
  }

  private async calculateMaxDrawdown(): Promise<number> {
    const history = await query(
      `SELECT total_value, updated_at
       FROM portfolio_history
       WHERE portfolio_id = $1
       ORDER BY updated_at ASC`,
      [this.portfolioId],
    )

    if (history.length < 2) return 0

    let maxValue = history[0].total_value
    let maxDrawdown = 0

    for (const record of history) {
      if (record.total_value > maxValue) {
        maxValue = record.total_value
      }

      const drawdown = ((maxValue - record.total_value) / maxValue) * 100
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown
      }
    }

    return maxDrawdown
  }

  async getPerformanceHistory(days = 30) {
    return await query(
      `SELECT 
         DATE(updated_at) as date,
         AVG(total_value) as value,
         COUNT(*) as data_points
       FROM portfolio_history
       WHERE portfolio_id = ?
       AND updated_at >= datetime('now', '-${days} days')
       GROUP BY DATE(updated_at)
       ORDER BY date ASC`,
      [this.portfolioId],
    )
  }
}
