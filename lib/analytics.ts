import type { TradingPosition } from "./trading"
import { resolvePositionCostNotional } from "./tp-sl-ratio"

export interface AnalyticsFilter {
  symbols: string[]
  timeRange: {
    start: Date
    end: Date
  }
  indicationTypes: string[]
  strategyTypes: string[]
  trailingEnabled?: boolean
  minProfitFactor?: number
  maxDrawdown?: number
}

export interface StrategyAnalytics {
  strategy_name: string
  strategy_type: string
  total_trades: number
  profit_factor: number
  profit_factor_last_50: number
  trades_per_day: number
  drawdown_time: number
  takeprofit_factor: number
  tp_sl_ratio: number
  average_hold_time: number
  trailing_info: {
    enabled: boolean
    trail_start?: number
    trail_stop?: number
  }
  volume_factor: number
  win_rate: number
  total_pnl: number
  largest_win: number
  largest_loss: number
  sharpe_ratio: number
  max_consecutive_losses: number
  recovery_factor: number
  avg_base_volume?: number
  avg_adjusted_volume?: number
  total_volume_traded?: number
}

export interface SymbolAnalytics {
  symbol: string
  total_trades: number
  win_rate: number
  total_pnl: number
  avg_profit_per_trade: number
  best_strategy: string
  worst_strategy: string
  volatility: number
  correlation_with_btc: number
}

export interface TimeSeriesData {
  timestamp: Date
  balance: number
  equity: number
  margin: number
  open_positions: number
  daily_pnl: number
  cumulative_pnl: number
  /** Peak-to-current realised P&L drawdown on the same USD zero baseline. */
  drawdown: number
}

function positionEventTimestamp(position: TradingPosition): number {
  const raw = position.status === "closed"
    ? position.closed_at || position.opened_at
    : position.opened_at
  const timestamp = new Date(raw).getTime()
  return Number.isFinite(timestamp) ? timestamp : Number.NaN
}

function chronologicalPositions(positions: readonly TradingPosition[]): TradingPosition[] {
  return [...positions].sort((left, right) =>
    positionEventTimestamp(left) - positionEventTimestamp(right) ||
    left.id.localeCompare(right.id),
  )
}

export class AnalyticsEngine {
  private positions: TradingPosition[] = []

  constructor(positions: TradingPosition[]) {
    this.positions = positions
  }

  // Filter positions based on criteria
  filterPositions(filter: AnalyticsFilter): TradingPosition[] {
    return this.positions.filter((position) => {
      // Symbol filter
      const symbol = String(position.symbol || "").toUpperCase()
      if (
        filter.symbols.length > 0 &&
        !filter.symbols.some((candidate) => candidate.toUpperCase() === symbol)
      ) {
        return false
      }

      // Time range filter
      const positionTimestamp = positionEventTimestamp(position)
      const startTimestamp = filter.timeRange.start.getTime()
      const endTimestamp = filter.timeRange.end.getTime()
      if (
        !Number.isFinite(positionTimestamp) ||
        positionTimestamp < startTimestamp ||
        positionTimestamp > endTimestamp
      ) {
        return false
      }

      // Indication type filter
      const indicationType = String(position.indication_type || "").toLowerCase()
      if (
        filter.indicationTypes.length > 0 &&
        !filter.indicationTypes.some((candidate) => candidate.toLowerCase() === indicationType)
      ) {
        return false
      }

      // Strategy type filter
      if (filter.strategyTypes.length > 0) {
        const strategyType = String(position.strategy_type || "").toLowerCase()
        const matchesStrategy = filter.strategyTypes.some((type) =>
          strategyType.includes(type.toLowerCase()),
        )
        if (!matchesStrategy) return false
      }

      // Trailing filter
      if (filter.trailingEnabled !== undefined) {
        const hasTrailing =
          (position as TradingPosition & { trailing_enabled?: boolean }).trailing_enabled === true ||
          position.strategy_type.toLowerCase().includes("trail")
        if (filter.trailingEnabled !== hasTrailing) return false
      }

      return true
    })
  }

  // Generate strategy analytics
  generateStrategyAnalytics(filter: AnalyticsFilter): StrategyAnalytics[] {
    const filteredPositions = this.filterPositions(filter)
    const strategiesMap = new Map<string, TradingPosition[]>()

    // Group positions by strategy
    filteredPositions.forEach((position) => {
      const key = position.strategy_type
      if (!strategiesMap.has(key)) {
        strategiesMap.set(key, [])
      }
      strategiesMap.get(key)!.push(position)
    })

    const analytics: StrategyAnalytics[] = []

    strategiesMap.forEach((positions, strategyName) => {
      const closedPositions = chronologicalPositions(positions.filter((p) => p.status === "closed"))
      if (closedPositions.length === 0) return
      const winningPositions = closedPositions.filter((p) => p.profit_loss > 0)
      const losingPositions = closedPositions.filter((p) => p.profit_loss < 0)

      const totalPnl = closedPositions.reduce((sum, p) => sum + p.profit_loss, 0)
      const totalVolume = closedPositions.reduce((sum, p) => sum + p.volume, 0)
      const profitFactor = this.calculateProfitFactor(closedPositions)

      // Calculate time-based metrics
      const timeRange = this.getTimeRange(closedPositions)
      const tradesPerDay = closedPositions.length / timeRange

      // Calculate drawdown
      const drawdownTime = this.calculateDrawdownTime(closedPositions)

      // Calculate hold time
      const avgHoldTime = this.calculateAverageHoldTime(closedPositions)

      // Get last 50 positions for recent performance
      const last50 = closedPositions.slice(-50)
      const profitFactorLast50 = this.calculateProfitFactor(last50)

      const positionsWithVolumeFactor = closedPositions.filter((p) => p.volume_factor !== undefined)
      const avgVolumeFactor =
        positionsWithVolumeFactor.length > 0
          ? positionsWithVolumeFactor.reduce((sum, p) => sum + (p.volume_factor || 1), 0) /
            positionsWithVolumeFactor.length
          : 1

      const avgBaseVolume =
        positionsWithVolumeFactor.length > 0
          ? positionsWithVolumeFactor.reduce((sum, p) => sum + (p.base_volume || 0), 0) /
            positionsWithVolumeFactor.length
          : undefined

      const avgAdjustedVolume =
        positionsWithVolumeFactor.length > 0
          ? positionsWithVolumeFactor.reduce((sum, p) => sum + (p.adjusted_volume || 0), 0) /
            positionsWithVolumeFactor.length
          : undefined
      const trailingPositions = closedPositions.filter((position) =>
        (position as TradingPosition & { trailing_enabled?: boolean }).trailing_enabled === true ||
        position.strategy_type.toLowerCase().includes("trail"),
      )
      const averageOptional = (field: "trail_start" | "trail_stop"): number | undefined => {
        const values = trailingPositions
          .map((position) => Number((position as TradingPosition & Record<string, unknown>)[field]))
          .filter(Number.isFinite)
        return values.length > 0
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : undefined
      }
      const maxDrawdown = this.calculateMaximumDrawdown(closedPositions)

      analytics.push({
        strategy_name: strategyName,
        strategy_type: this.getStrategyType(strategyName),
        total_trades: closedPositions.length,
        profit_factor: profitFactor,
        profit_factor_last_50: profitFactorLast50,
        trades_per_day: tradesPerDay,
        drawdown_time: drawdownTime,
        takeprofit_factor: this.extractTakeProfitFactor(closedPositions),
        tp_sl_ratio: this.calculateTPSLRatio(closedPositions),
        average_hold_time: avgHoldTime,
        trailing_info: {
          enabled: trailingPositions.length > 0,
          trail_start: averageOptional("trail_start"),
          trail_stop: averageOptional("trail_stop"),
        },
        volume_factor: avgVolumeFactor,
        win_rate: winningPositions.length + losingPositions.length > 0
          ? winningPositions.length / (winningPositions.length + losingPositions.length)
          : 0,
        total_pnl: totalPnl,
        largest_win: Math.max(...closedPositions.map((p) => p.profit_loss), 0),
        largest_loss: Math.min(...closedPositions.map((p) => p.profit_loss), 0),
        sharpe_ratio: this.calculateSharpeRatio(closedPositions),
        max_consecutive_losses: this.calculateMaxConsecutiveLosses(closedPositions),
        recovery_factor: maxDrawdown > 0
          ? totalPnl / maxDrawdown
          : totalPnl > 0
            ? Number.POSITIVE_INFINITY
            : 0,
        avg_base_volume: avgBaseVolume,
        avg_adjusted_volume: avgAdjustedVolume,
        total_volume_traded: totalVolume,
      })
    })

    const minimumRealizedPf = Number(filter.minProfitFactor)
    const maximumDrawdownHours = Number(filter.maxDrawdown)
    return analytics
      .filter((strategy) =>
        (!Number.isFinite(minimumRealizedPf) || minimumRealizedPf <= 0 ||
          strategy.profit_factor >= minimumRealizedPf) &&
        (!Number.isFinite(maximumDrawdownHours) || maximumDrawdownHours <= 0 ||
          strategy.drawdown_time <= maximumDrawdownHours),
      )
      .sort((a, b) => b.profit_factor - a.profit_factor)
  }

  // Generate symbol analytics
  generateSymbolAnalytics(filter: AnalyticsFilter): SymbolAnalytics[] {
    const filteredPositions = this.filterPositionsForAggregateMetrics(filter)
    const symbolsMap = new Map<string, TradingPosition[]>()

    filteredPositions.forEach((position) => {
      if (!symbolsMap.has(position.symbol)) {
        symbolsMap.set(position.symbol, [])
      }
      symbolsMap.get(position.symbol)!.push(position)
    })

    const analytics: SymbolAnalytics[] = []

    symbolsMap.forEach((positions, symbol) => {
      const closedPositions = chronologicalPositions(positions.filter((p) => p.status === "closed"))
      if (closedPositions.length === 0) return
      const winningPositions = closedPositions.filter((p) => p.profit_loss > 0)
      const losingPositions = closedPositions.filter((p) => p.profit_loss < 0)
      const totalPnl = closedPositions.reduce((sum, p) => sum + p.profit_loss, 0)

      // Find best and worst performing strategies for this symbol
      const strategyPerformance = this.getStrategyPerformanceBySymbol(closedPositions)

      analytics.push({
        symbol,
        total_trades: closedPositions.length,
        win_rate: winningPositions.length + losingPositions.length > 0
          ? winningPositions.length / (winningPositions.length + losingPositions.length)
          : 0,
        total_pnl: totalPnl,
        avg_profit_per_trade: closedPositions.length > 0 ? totalPnl / closedPositions.length : 0,
        best_strategy: strategyPerformance.best,
        worst_strategy: strategyPerformance.worst,
        volatility: this.calculateVolatility(closedPositions),
        // Correlation requires a synchronized BTC return series. This page
        // currently receives positions only, so never fabricate a value with
        // Math.random(); report the exact identity case and 0 (unavailable)
        // for other symbols until the price-series source is present.
        correlation_with_btc: symbol === "BTCUSDT" ? 1 : 0,
      })
    })

    return analytics.sort((a, b) => b.total_pnl - a.total_pnl)
  }

  // Generate time series data for charts
  generateTimeSeriesData(filter: AnalyticsFilter): TimeSeriesData[] {
    const filteredPositions = chronologicalPositions(this.filterPositionsForAggregateMetrics(filter))

    const timeSeriesData: TimeSeriesData[] = []
    let cumulativePnl = 0
    // No account-balance snapshot is part of this position-only data source.
    // Expose an exact relative P&L curve with a zero baseline instead of
    // fabricating a 10,000 USD starting balance.
    let balance = 0
    let peakBalance = 0

    // Group by the actual metric event: close time for realised P&L and open
    // time for positions which are still open. This keeps a date-range filter
    // and every daily series on the same observable timeline.
    const dailyGroups = new Map<string, TradingPosition[]>()
    filteredPositions.forEach((position) => {
      const timestamp = positionEventTimestamp(position)
      if (!Number.isFinite(timestamp)) return
      const date = new Date(timestamp).toISOString().slice(0, 10)
      if (!dailyGroups.has(date)) {
        dailyGroups.set(date, [])
      }
      dailyGroups.get(date)!.push(position)
    })

    dailyGroups.forEach((positions, dateString) => {
      const date = new Date(`${dateString}T00:00:00.000Z`)
      const closedPositions = positions.filter((p) => p.status === "closed")
      const dailyPnl = closedPositions.reduce((sum, p) => sum + p.profit_loss, 0)

      cumulativePnl += dailyPnl
      balance += dailyPnl
      peakBalance = Math.max(peakBalance, balance)

      const dayEnd = date.getTime() + 24 * 60 * 60 * 1000 - 1
      const openAtDayEnd = filteredPositions.filter((position) => {
        const openedAt = new Date(position.opened_at).getTime()
        if (!Number.isFinite(openedAt) || openedAt > dayEnd) return false
        if (position.status === "open" || !position.closed_at) return true
        const closedAt = new Date(position.closed_at).getTime()
        return Number.isFinite(closedAt) && closedAt > dayEnd
      })
      const isCurrentUtcDay = dateString === new Date().toISOString().slice(0, 10)
      const currentOpenPositions = isCurrentUtcDay
        ? openAtDayEnd.filter((position) => position.status === "open")
        : []
      const marginUsed = currentOpenPositions.reduce((sum, p) => sum + (p.margin_used || 0), 0)
      const currentUnrealizedPnl = currentOpenPositions.reduce(
        (sum, p) => sum + (p.unrealized_pnl || 0),
        0,
      )

      timeSeriesData.push({
        timestamp: date,
        balance: balance,
        // Historical unrealised snapshots are not available. Past points are
        // therefore the exact realised curve; only today adds current open P&L.
        equity: balance + currentUnrealizedPnl,
        margin: marginUsed,
        open_positions: openAtDayEnd.length,
        daily_pnl: dailyPnl,
        cumulative_pnl: cumulativePnl,
        drawdown: Math.max(0, peakBalance - balance),
      })
    })

    return timeSeriesData
  }

  // Helper methods
  private filterPositionsForAggregateMetrics(filter: AnalyticsFilter): TradingPosition[] {
    const filtered = this.filterPositions(filter)
    const minimumRealizedPf = Number(filter.minProfitFactor)
    const maximumDrawdownHours = Number(filter.maxDrawdown)
    const hasProfitFactorFilter = Number.isFinite(minimumRealizedPf) && minimumRealizedPf > 0
    const hasDrawdownFilter = Number.isFinite(maximumDrawdownHours) && maximumDrawdownHours > 0
    if (!hasProfitFactorFilter && !hasDrawdownFilter) return filtered

    const grouped = new Map<string, TradingPosition[]>()
    for (const position of filtered) {
      const rows = grouped.get(position.strategy_type) || []
      rows.push(position)
      grouped.set(position.strategy_type, rows)
    }
    const allowed = new Set<string>()
    for (const [strategyType, positions] of grouped) {
      const closed = positions.filter((position) => position.status === "closed")
      if (closed.length === 0) continue
      const profitFactor = this.calculateProfitFactor(closed)
      const drawdownHours = this.calculateDrawdownTime(closed)
      if (
        (!hasProfitFactorFilter || profitFactor >= minimumRealizedPf) &&
        (!hasDrawdownFilter || drawdownHours <= maximumDrawdownHours)
      ) {
        allowed.add(strategyType)
      }
    }
    return filtered.filter((position) => allowed.has(position.strategy_type))
  }

  private calculateProfitFactor(positions: TradingPosition[]): number {
    const grossProfit = positions.filter((p) => p.profit_loss > 0).reduce((sum, p) => sum + p.profit_loss, 0)
    const grossLoss = Math.abs(positions.filter((p) => p.profit_loss < 0).reduce((sum, p) => sum + p.profit_loss, 0))

    // Realised Profit Factor is always gross profit ÷ absolute gross loss.
    // Main-stage PositionCost ratios are a separate gate and must never alter
    // execution-history PF.
    return grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0
  }

  private calculateDrawdownTime(positions: TradingPosition[]): number {
    const chronological = chronologicalPositions(positions)
    let equity = 0
    let peakEquity = 0
    let drawdownHours = 0
    let drawdownStartMs: number | null = null

    for (const position of chronological) {
      const eventMs = new Date(position.closed_at || position.opened_at).getTime()
      if (!Number.isFinite(eventMs)) continue
      equity += Number(position.profit_loss) || 0
      if (equity >= peakEquity) {
        peakEquity = equity
        if (drawdownStartMs !== null) {
          drawdownHours += Math.max(0, eventMs - drawdownStartMs) / 3_600_000
          drawdownStartMs = null
        }
      } else if (drawdownStartMs === null) {
        drawdownStartMs = eventMs
      }
    }
    if (drawdownStartMs !== null && chronological.length > 0) {
      const last = chronological[chronological.length - 1]
      const lastMs = new Date(last.closed_at || last.opened_at).getTime()
      if (Number.isFinite(lastMs)) {
        drawdownHours += Math.max(0, lastMs - drawdownStartMs) / 3_600_000
      }
    }

    return drawdownHours
  }

  private calculateMaximumDrawdown(positions: TradingPosition[]): number {
    const chronological = chronologicalPositions(positions)
    let equity = 0
    let peak = 0
    let maximum = 0
    for (const position of chronological) {
      equity += Number(position.profit_loss) || 0
      peak = Math.max(peak, equity)
      maximum = Math.max(maximum, peak - equity)
    }
    return maximum
  }

  private calculateAverageHoldTime(positions: TradingPosition[]): number {
    const closedPositions = positions.filter((p) => p.status === "closed" && p.closed_at)
    if (closedPositions.length === 0) return 0

    const holdTimes = closedPositions.map((p) => {
      const openTime = new Date(p.opened_at).getTime()
      const closeTime = new Date(p.closed_at!).getTime()
      return Number.isFinite(openTime) && Number.isFinite(closeTime)
        ? Math.max(0, (closeTime - openTime) / (1000 * 60))
        : Number.NaN
    }).filter(Number.isFinite)

    return holdTimes.length > 0
      ? holdTimes.reduce((sum, value) => sum + value, 0) / holdTimes.length
      : 0
  }

  private getTimeRange(positions: TradingPosition[]): number {
    if (positions.length < 2) return 1
    const timestamps = positions.map(positionEventTimestamp).filter(Number.isFinite)
    if (timestamps.length < 2) return 1
    const earliest = Math.min(...timestamps)
    const latest = Math.max(...timestamps)
    return Math.max(1, (latest - earliest) / (1000 * 60 * 60 * 24) + 1)
  }

  private getStrategyType(strategyName: string): string {
    const normalized = strategyName.toLowerCase()
    if (normalized.includes("base")) return "Base"
    if (normalized.includes("partial") || normalized.includes("main")) return "Main"
    if (normalized.includes("count") || normalized.includes("real")) return "Real"
    if (normalized.includes("block")) return "Block"
    if (normalized.includes("dca")) return "DCA"
    return "Other"
  }

  private extractTakeProfitFactor(positions: TradingPosition[]): number {
    const distances = positions
      .filter((position) => Number(position.takeprofit) > 0 && Number(position.entry_price) > 0)
      .map((position) =>
        Math.abs(Number(position.takeprofit) - Number(position.entry_price)) /
        Number(position.entry_price) * 100,
      )
    return distances.length > 0
      ? distances.reduce((sum, distance) => sum + distance, 0) / distances.length
      : 0
  }

  private calculateTPSLRatio(positions: TradingPosition[]): number {
    const ratios = positions
      .filter((position) =>
        Number(position.takeprofit) > 0 &&
        Number(position.stoploss) > 0 &&
        Number(position.entry_price) > 0,
      )
      .map((position) => {
        const tpDistance = Math.abs(Number(position.takeprofit) - Number(position.entry_price))
        const slDistance = Math.abs(Number(position.entry_price) - Number(position.stoploss))
        return slDistance > 0 ? tpDistance / slDistance : Number.NaN
      })
      .filter(Number.isFinite)
    return ratios.length > 0
      ? ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length
      : 0
  }

  private calculateSharpeRatio(positions: TradingPosition[]): number {
    if (positions.length < 2) return 0

    const returns = positions
      .map((position) => {
        const notional = resolvePositionCostNotional(position)
        return notional > 0 ? position.profit_loss / notional : Number.NaN
      })
      .filter(Number.isFinite)
    if (returns.length < 2) return 0
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    const stdDev = Math.sqrt(variance)

    return stdDev > 0 ? avgReturn / stdDev : 0
  }

  private calculateMaxConsecutiveLosses(positions: TradingPosition[]): number {
    let maxConsecutive = 0
    let currentConsecutive = 0

    chronologicalPositions(positions).forEach((position) => {
      if (position.profit_loss < 0) {
        currentConsecutive++
        maxConsecutive = Math.max(maxConsecutive, currentConsecutive)
      } else {
        currentConsecutive = 0
      }
    })

    return maxConsecutive
  }

  private calculateVolatility(positions: TradingPosition[]): number {
    const returns = positions
      .map((position) => {
        const notional = resolvePositionCostNotional(position)
        return notional > 0 ? Number(position.profit_loss) / notional : Number.NaN
      })
      .filter(Number.isFinite)
    if (returns.length === 0) return 0
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    return Math.sqrt(variance)
  }

  private getStrategyPerformanceBySymbol(positions: TradingPosition[]): { best: string; worst: string } {
    const strategyPnl = new Map<string, number>()

    positions.forEach((position) => {
      const current = strategyPnl.get(position.strategy_type) || 0
      strategyPnl.set(position.strategy_type, current + position.profit_loss)
    })

    const sorted = Array.from(strategyPnl.entries()).sort((a, b) => b[1] - a[1])
    return {
      best: sorted[0]?.[0] || "N/A",
      worst: sorted[sorted.length - 1]?.[0] || "N/A",
    }
  }
}
