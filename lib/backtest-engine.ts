/**
 * Backtesting Engine
 * Evaluates preset strategies using historical data with profit factor and drawdown metrics
 */

import { resolveStopLossPercent } from "@/lib/tp-sl-ratio"
import { getSettings, setSettings } from "@/lib/redis-db"
import { sql } from "@/lib/db"
import { calculateSignedResultR } from "@/lib/profit-factor"

interface BacktestTrade {
  symbol: string
  side: "long" | "short"
  entry_price: number
  exit_price: number
  entry_time: Date
  exit_time: Date
  profit_loss: number
  signedResultR: number
  profit_factor: number
  signed_result_r: number
  strategy_config: any
}

interface DrawdownPeriod {
  start: Date
  end: Date
  duration_hours: number
  max_drawdown_percent: number
}

export class BacktestEngine {
  private presetId: string
  private connectionId: string
  private startDate: Date
  private endDate: Date
  private symbols: string[]

  constructor(presetId: string, connectionId: string, startDate: Date, endDate: Date, symbols: string[]) {
    this.presetId = presetId
    this.connectionId = connectionId
    this.startDate = startDate
    this.endDate = endDate
    this.symbols = symbols
  }

  /**
   * Run backtest for preset
   */
  async runBacktest(): Promise<string> {
    try {
      // Create backtest result record in Redis
      const resultId = `backtest:${this.presetId}:${Date.now()}`
      
      const backtestResult = {
        id: resultId,
        preset_id: this.presetId,
        connection_id: this.connectionId,
        start_date: this.startDate.toISOString(),
        end_date: this.endDate.toISOString(),
        symbols: this.symbols,
        status: "in_progress",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      // Store in Redis
      const backtests = (await getSettings("backtest_results")) || []
      backtests.push(backtestResult)
      await setSettings("backtest_results", backtests)

      const backtestId = backtestResult.id

      // Run backtest asynchronously
      this.executeBacktest(backtestId).catch((error) => {
        console.error("[v0] Backtest execution failed:", error)
        this.updateBacktestStatus(backtestId, "failed", error.message)
      })

      return backtestId
    } catch (error) {
      console.error("[v0] Failed to start backtest:", error)
      throw error
    }
  }

  /**
   * Execute backtest
   */
  private async executeBacktest(backtestId: string): Promise<void> {
    try {
      // Get preset configuration
      const [preset] = await sql`
        SELECT * FROM presets WHERE id = ${this.presetId}
      `

      if (!preset) {
        throw new Error("Preset not found")
      }

      // Get historical market data
      const marketData = await this.getHistoricalMarketData()

      // Generate and test strategies
      const trades = await this.simulateTrades(preset, marketData)

      // Calculate metrics
      const metrics = this.calculateMetrics(trades)

      // Update backtest result
      await sql`
        UPDATE backtest_results
        SET
          total_trades = ${metrics.totalTrades},
          winning_trades = ${metrics.winningTrades},
          losing_trades = ${metrics.losingTrades},
          win_rate = ${metrics.winRate},
          total_profit = ${metrics.totalProfit},
          total_loss = ${metrics.totalLoss},
          net_profit = ${metrics.netProfit},
          profit_factor = ${metrics.profitFactor},
          max_drawdown = ${metrics.maxDrawdown},
          max_drawdown_duration_hours = ${metrics.maxDrawdownDuration},
          avg_drawdown = ${metrics.avgDrawdown},
          avg_win = ${metrics.avgWin},
          avg_loss = ${metrics.avgLoss},
          largest_win = ${metrics.largestWin},
          largest_loss = ${metrics.largestLoss},
          avg_trade_duration_minutes = ${metrics.avgTradeDuration},
          sharpe_ratio = ${metrics.sharpeRatio},
          sortino_ratio = ${metrics.sortinoRatio},
          status = 'completed',
          completed_at = CURRENT_TIMESTAMP
        WHERE id = ${backtestId}
      `

      console.log(`[v0] Backtest ${backtestId} completed successfully`)
    } catch (error) {
      console.error(`[v0] Backtest ${backtestId} failed:`, error)
      throw error
    }
  }

  /**
   * Get historical market data
   */
  private async getHistoricalMarketData(): Promise<any[]> {
    try {
      const data = await sql`
        SELECT * FROM market_data
        WHERE connection_id = ${this.connectionId}
          AND symbol = ANY(${this.symbols})
          AND timestamp BETWEEN ${this.startDate.toISOString()} AND ${this.endDate.toISOString()}
        ORDER BY timestamp ASC
      `

      return data
    } catch (error) {
      console.error("[v0] Failed to get historical market data:", error)
      return []
    }
  }

  /**
   * Simulate trades based on preset strategies
   */
  private async simulateTrades(preset: any, marketData: any[]): Promise<BacktestTrade[]> {
    const trades: BacktestTrade[] = []

    // Group market data by symbol
    const dataBySymbol = new Map<string, any[]>()
    for (const data of marketData) {
      if (!dataBySymbol.has(data.symbol)) {
        dataBySymbol.set(data.symbol, [])
      }
      dataBySymbol.get(data.symbol)!.push(data)
    }

    // Simulate trades for each symbol
    for (const [symbol, symbolData] of dataBySymbol) {
      const symbolTrades = this.simulateSymbolTrades(preset, symbol, symbolData)
      trades.push(...symbolTrades)
    }

    return trades
  }

  /**
   * Simulate trades for a single symbol
   */
  private simulateSymbolTrades(preset: any, symbol: string, marketData: any[]): BacktestTrade[] {
    const trades: BacktestTrade[] = []

    // Generate strategy combinations from preset
    const strategies = this.generateStrategyCombinations(preset)

    // For each strategy, simulate trades
    for (const strategy of strategies) {
      let i = 0
      while (i < marketData.length - 1) {
        // Check for entry signal (simplified - would use actual indication logic)
        const entrySignal = this.checkEntrySignal(marketData, i, strategy)

        if (entrySignal) {
          const trade = this.simulateTrade(symbol, marketData, i, strategy)
          if (trade) {
            trades.push(trade)
            // Skip ahead to avoid overlapping trades
            i += Math.floor(strategy.position_timeout_hours * 60) // Assuming 1 data point per minute
          }
        }
        i++
      }
    }

    return trades
  }

  /**
   * Generate strategy combinations from preset
   */
  private generateStrategyCombinations(preset: any): any[] {
    const strategies: any[] = []

    // Generate combinations of TP/SL/Trailing
    for (const tpStep of preset.takeprofit_steps) {
      for (const slRatio of preset.stoploss_ratios) {
        // Without trailing
        strategies.push({
          takeprofit_factor: tpStep,
          stoploss_ratio: slRatio,
          trailing_enabled: false,
          position_timeout_hours: 2,
        })

        // With trailing (if enabled)
        if (preset.trailing_enabled) {
          for (const trailStart of preset.trail_starts) {
            for (const trailStop of preset.trail_stops) {
              strategies.push({
                takeprofit_factor: tpStep,
                stoploss_ratio: slRatio,
                trailing_enabled: true,
                trail_start: trailStart,
                trail_stop: trailStop,
                position_timeout_hours: 2,
              })
            }
          }
        }
      }
    }

    return strategies
  }

  /**
   * Check for entry signal (simplified)
   */
  private checkEntrySignal(marketData: any[], index: number, strategy: any): boolean {
    // Simplified entry logic - in production, use actual indication calculations
    if (index < 10) return false

    const recentPrices = marketData.slice(index - 10, index).map((d) => d.price)
    const currentPrice = marketData[index].price

    // Simple momentum check
    const avgPrice = recentPrices.reduce((sum, p) => sum + p, 0) / recentPrices.length
    const priceChange = (currentPrice - avgPrice) / avgPrice

    // Random entry with 5% probability (for simulation)
    return Math.abs(priceChange) > 0.01 && Math.random() < 0.05
  }

  /**
   * Simulate a single trade
   */
  private simulateTrade(symbol: string, marketData: any[], entryIndex: number, strategy: any): BacktestTrade | null {
    const entryPrice = marketData[entryIndex].price
    const entryTime = new Date(marketData[entryIndex].timestamp)
    const side: "long" | "short" = Math.random() > 0.5 ? "long" : "short"

    // Calculate TP and SL prices
    const tpPrice =
      side === "long"
        ? entryPrice * (1 + (strategy.takeprofit_factor * 0.001) / 0.1) // TP in relation to 0.1% position cost
        : entryPrice * (1 - (strategy.takeprofit_factor * 0.001) / 0.1)

    const stopLossPercent = resolveStopLossPercent(strategy.takeprofit_factor, strategy.stoploss_ratio)
    const slPrice =
      side === "long"
        ? entryPrice * (1 - stopLossPercent / 100)
        : entryPrice * (1 + stopLossPercent / 100)

    // Simulate price movement until TP, SL, or timeout
    let exitPrice = entryPrice
    let exitTime = entryTime
    let exitReason = "timeout"
    let highestPrice = entryPrice
    let trailingStopPrice = slPrice

    const maxDuration = strategy.position_timeout_hours * 60 // minutes
    let duration = 0

    for (let i = entryIndex + 1; i < marketData.length && duration < maxDuration; i++) {
      const currentPrice = marketData[i].price
      const currentTime = new Date(marketData[i].timestamp)
      duration = (currentTime.getTime() - entryTime.getTime()) / (1000 * 60)

      // Update trailing stop if enabled
      if (strategy.trailing_enabled) {
        if (side === "long" && currentPrice > highestPrice) {
          highestPrice = currentPrice
          const profitPercent = (currentPrice - entryPrice) / entryPrice
          if (profitPercent >= strategy.trail_start) {
            trailingStopPrice = currentPrice * (1 - strategy.trail_stop)
          }
        } else if (side === "short" && currentPrice < highestPrice) {
          highestPrice = currentPrice
          const profitPercent = (entryPrice - currentPrice) / entryPrice
          if (profitPercent >= strategy.trail_start) {
            trailingStopPrice = currentPrice * (1 + strategy.trail_stop)
          }
        }
      }

      // Check exit conditions
      if (side === "long") {
        if (currentPrice >= tpPrice) {
          exitPrice = tpPrice
          exitTime = currentTime
          exitReason = "takeprofit"
          break
        }
        if (currentPrice <= (strategy.trailing_enabled ? trailingStopPrice : slPrice)) {
          exitPrice = strategy.trailing_enabled ? trailingStopPrice : slPrice
          exitTime = currentTime
          exitReason = "stoploss"
          break
        }
      } else {
        if (currentPrice <= tpPrice) {
          exitPrice = tpPrice
          exitTime = currentTime
          exitReason = "takeprofit"
          break
        }
        if (currentPrice >= (strategy.trailing_enabled ? trailingStopPrice : slPrice)) {
          exitPrice = strategy.trailing_enabled ? trailingStopPrice : slPrice
          exitTime = currentTime
          exitReason = "stoploss"
          break
        }
      }

      // Update exit price for timeout
      exitPrice = currentPrice
      exitTime = currentTime
    }

    // Calculate P&L and cost-normalized signed return (R)
    const profitLoss = side === "long" ? exitPrice - entryPrice : entryPrice - exitPrice
    const signedPricePercent = (profitLoss / entryPrice) * 100
    const positionCostPct = this.getPositionCostPct(strategy)
    const signedResultR = signedPricePercent / positionCostPct

    return {
      symbol,
      side,
      entry_price: entryPrice,
      exit_price: exitPrice,
      entry_time: entryTime,
      exit_time: exitTime,
      profit_loss: profitLoss,
      signedResultR,
      profit_factor: Math.max(0, signedResultR),
      signed_result_r: signedResultR,
      strategy_config: strategy,
    }
  }

  private getPositionCostPct(strategy: any): number {
    const rawPositionCostPct = Number(
      strategy?.positionCostPct ??
        strategy?.position_cost_pct ??
        strategy?.position_cost ??
        strategy?.positionCost ??
        0.1,
    )

    return Number.isFinite(rawPositionCostPct) && rawPositionCostPct > 0 ? rawPositionCostPct : 0.1
  }

  /**
   * Calculate backtest metrics
   */
  private calculateMetrics(trades: BacktestTrade[]) {
    const totalTrades = trades.length
    const winningTrades = trades.filter((t) => t.profit_loss > 0).length
    const losingTrades = trades.filter((t) => t.profit_loss <= 0).length
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0

    const totalProfit = trades.filter((t) => t.signedResultR > 0).reduce((sum, t) => sum + t.signedResultR, 0)
    const totalLoss = Math.abs(trades.filter((t) => t.signedResultR <= 0).reduce((sum, t) => sum + t.signedResultR, 0))
    const netProfit = totalProfit - totalLoss
    
    // Cost-adjusted PF: totalProfit / (totalLoss + totalPositionCosts)
    // Position cost = entry_price × quantity × 0.001 (0.1% maker fee)
    // For backtest trades, we calculate cost from entry_price and assume unit qty
    const totalPositionCosts = trades.reduce((sum, t) => {
      if (Number.isFinite(t.entry_price) && t.entry_price > 0) {
        // Backtest assumes unit quantity, so cost = entry_price × 0.001
        return sum + (t.entry_price * 0.001)
      }
      return sum
    }, 0)
    
    const adjustedDenominator = totalLoss + totalPositionCosts
    const profitFactor = adjustedDenominator > 0 ? totalProfit / adjustedDenominator : totalProfit > 0 ? 999 : 0

    const avgWin = winningTrades > 0 ? totalProfit / winningTrades : 0
    const avgLoss = losingTrades > 0 ? totalLoss / losingTrades : 0
    const largestWin = trades.length > 0 ? Math.max(...trades.map((t) => t.profit_loss)) : 0
    const largestLoss = trades.length > 0 ? Math.min(...trades.map((t) => t.profit_loss)) : 0

    const avgTradeDuration =
      trades.length > 0
        ? trades.reduce((sum, t) => sum + (t.exit_time.getTime() - t.entry_time.getTime()), 0) /
          trades.length /
          (1000 * 60)
        : 0

    // Calculate drawdown
    const drawdownMetrics = this.calculateDrawdown(trades)

    // Calculate Sharpe and Sortino ratios
    const returns = trades.map((t) => t.signedResultR)
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length
    const stdDev = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length)
    const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0

    const negativeReturns = returns.filter((r) => r < 0)
    const downstdDev =
      negativeReturns.length > 0
        ? Math.sqrt(negativeReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / negativeReturns.length)
        : 0
    const sortinoRatio = downstdDev > 0 ? avgReturn / downstdDev : 0

    return {
      totalTrades,
      winningTrades,
      losingTrades,
      winRate,
      totalProfit,
      totalLoss,
      netProfit,
      profitFactor,
      maxDrawdown: drawdownMetrics.maxDrawdown,
      maxDrawdownDuration: drawdownMetrics.maxDrawdownDuration,
      avgDrawdown: drawdownMetrics.avgDrawdown,
      avgWin,
      avgLoss,
      largestWin,
      largestLoss,
      avgTradeDuration,
      sharpeRatio,
      sortinoRatio,
    }
  }

  /**
   * Calculate drawdown metrics
   */
  private calculateDrawdown(trades: BacktestTrade[]) {
    // Sort trades by exit time
    const sortedTrades = [...trades].sort((a, b) => a.exit_time.getTime() - b.exit_time.getTime())

    let cumulativePnL = 0
    let peak = 0
    let maxDrawdown = 0
    let currentDrawdownStart: Date | null = null
    let maxDrawdownDuration = 0
    const drawdownPeriods: DrawdownPeriod[] = []

    for (const trade of sortedTrades) {
      cumulativePnL += trade.profit_loss

      if (cumulativePnL > peak) {
        // New peak - end any current drawdown
        if (currentDrawdownStart) {
          const duration = (trade.exit_time.getTime() - currentDrawdownStart.getTime()) / (1000 * 60 * 60)
          drawdownPeriods.push({
            start: currentDrawdownStart,
            end: trade.exit_time,
            duration_hours: duration,
            max_drawdown_percent: ((peak - cumulativePnL) / peak) * 100,
          })
          currentDrawdownStart = null
        }
        peak = cumulativePnL
      } else if (cumulativePnL < peak) {
        // In drawdown
        if (!currentDrawdownStart) {
          currentDrawdownStart = trade.exit_time
        }

        const currentDrawdown = ((peak - cumulativePnL) / peak) * 100
        if (currentDrawdown > maxDrawdown) {
          maxDrawdown = currentDrawdown
        }
      }
    }

    // Calculate max drawdown duration
    if (drawdownPeriods.length > 0) {
      maxDrawdownDuration = Math.max(...drawdownPeriods.map((d) => d.duration_hours))
    }

    // Calculate average drawdown
    const avgDrawdown =
      drawdownPeriods.length > 0
        ? drawdownPeriods.reduce((sum, d) => sum + d.max_drawdown_percent, 0) / drawdownPeriods.length
        : 0

    return {
      maxDrawdown,
      maxDrawdownDuration,
      avgDrawdown,
    }
  }

  /**
   * Update backtest status
   */
  private async updateBacktestStatus(backtestId: string, status: string, errorMessage?: string): Promise<void> {
    try {
      await sql`
        UPDATE backtest_results
        SET status = ${status}, error_message = ${errorMessage || null}
        WHERE id = ${backtestId}
      `
    } catch (error) {
      console.error("[v0] Failed to update backtest status:", error)
    }
  }
}

export async function runPresetBacktest(presetId: string, connectionId: string, periodDays = 30): Promise<string> {
  const endDate = new Date()
  const startDate = new Date(endDate.getTime() - periodDays * 24 * 60 * 60 * 1000)

  const connection = await getSettings(`connection:${connectionId}`)
  const symbols = connection?.symbols || ["BTCUSDT", "ETHUSDT", "XRPUSDT"]

  const engine = new BacktestEngine(presetId, connectionId, startDate, endDate, symbols)
  return await engine.runBacktest()
}
