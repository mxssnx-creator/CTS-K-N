import { v4 as uuidv4 } from "uuid"
import type { RealPosition } from "./types"

export interface TradingPosition extends RealPosition {
  unrealized_pnl: number
  realized_pnl: number
  margin_used: number
  liquidation_price?: number
  fees_paid: number
  hold_time: number // in minutes
  max_profit: number
  max_loss: number
  position_side?: "long" | "short"
  contract_type?: "usdt-perpetual" | "coin-perpetual" | "spot"
  leverage?: number
  volume_factor?: number
  base_volume?: number // Base volume before factor adjustment
  adjusted_volume?: number // Volume after applying volume_factor
  indication_type?: "direction" | "move" | "active"
}

export interface TradingStats {
  total_positions: number
  open_positions: number
  closed_positions: number
  total_volume: number
  total_pnl: number
  win_rate: number
  avg_hold_time: number
  largest_win: number
  largest_loss: number
  balance: number
  equity: number
  margin: number
  free_margin: number
}

export interface TimeRangeStats {
  positions_count: number
  total_pnl: number
  win_rate: number
  avg_profit: number
  balance_change: number
}

export class TradingEngine {
  private positions: Map<string, TradingPosition> = new Map()
  private connectionBalances: Map<string, number> = new Map()
  private baseVolumeFactor = 0.01 // Default base volume factor

  setBaseVolumeFactor(factor: number): void {
    this.baseVolumeFactor = factor
  }

  calculateVolume(baseVolume: number, volumeFactor = 1): { base: number; adjusted: number; factor: number } {
    const base = baseVolume * this.baseVolumeFactor
    const adjusted = base * volumeFactor
    return {
      base,
      adjusted,
      factor: volumeFactor,
    }
  }

  async openPosition(
    connectionId: string,
    symbol: string,
    side: "buy" | "sell",
    volume: number,
    price: number,
    takeProfit?: number,
    stopLoss?: number,
    strategyType?: string,
    leverage?: number,
    positionSide?: "long" | "short",
    volumeFactor?: number,
    indicationType?: "direction" | "move" | "active",
  ): Promise<TradingPosition> {
    const finalLeverage = leverage || 150 // Default to BingX max (150x); call sites should pass explicit max via getMaxLeverageForExchange()
    const finalPositionSide = positionSide || (side === "buy" ? "long" : "short")

    const volumeCalc = volumeFactor ? this.calculateVolume(volume, volumeFactor) : null
    const finalVolume = volumeCalc ? volumeCalc.adjusted : volume

    const position: TradingPosition = {
      id: uuidv4(),
      connection_id: connectionId,
      exchange_position_id: `ext_${Date.now()}`,
      symbol,
      strategy_type: strategyType || "manual",
      volume: finalVolume,
      entry_price: price,
      current_price: price,
      takeprofit: takeProfit,
      stoploss: stopLoss,
      profit_loss: 0,
      status: "open",
      opened_at: new Date().toISOString(),
      unrealized_pnl: 0,
      realized_pnl: 0,
      margin_used: (finalVolume * price) / finalLeverage, // Margin based on leverage
      fees_paid: finalVolume * price * 0.001, // 0.1% fee
      hold_time: 0,
      max_profit: 0,
      max_loss: 0,
      position_side: finalPositionSide,
      contract_type: "usdt-perpetual",
      leverage: finalLeverage,
      volume_factor: volumeCalc?.factor,
      base_volume: volumeCalc?.base,
      adjusted_volume: volumeCalc?.adjusted,
      indication_type: indicationType,
    }

    console.log(
      `[v0] Opening ${finalPositionSide.toUpperCase()} position with ${finalLeverage}x leverage${volumeCalc ? ` (volume factor: ${volumeCalc.factor}x, base: ${volumeCalc.base}, adjusted: ${volumeCalc.adjusted})` : ""}`,
    )
    this.positions.set(position.id, position)
    return position
  }

  async openHedgedPositions(
    connectionId: string,
    symbol: string,
    volume: number,
    price: number,
    longTakeProfit?: number,
    longStopLoss?: number,
    shortTakeProfit?: number,
    shortStopLoss?: number,
    strategyType?: string,
    leverage?: number,
    volumeFactor?: number,
    indicationType?: "direction" | "move" | "active",
  ): Promise<{ longPosition: TradingPosition; shortPosition: TradingPosition }> {
    const longPosition = await this.openPosition(
      connectionId,
      symbol,
      "buy",
      volume,
      price,
      longTakeProfit,
      longStopLoss,
      strategyType,
      leverage,
      "long",
      volumeFactor,
      indicationType,
    )

    const shortPosition = await this.openPosition(
      connectionId,
      symbol,
      "sell",
      volume,
      price,
      shortTakeProfit,
      shortStopLoss,
      strategyType,
      leverage,
      "short",
      volumeFactor,
      indicationType,
    )

    console.log(`[v0] Opened hedged positions: LONG ${longPosition.id} and SHORT ${shortPosition.id}`)

    return { longPosition, shortPosition }
  }

  async closePosition(positionId: string, closePrice?: number): Promise<TradingPosition | null> {
    const position = this.positions.get(positionId)
    if (!position || position.status !== "open") return null

    const finalPrice = closePrice || position.current_price
    const pnl = (finalPrice - position.entry_price) * position.volume * (position.leverage || 1)
    const closeFee = position.volume * finalPrice * 0.001

    const updatedPosition: TradingPosition = {
      ...position,
      current_price: finalPrice,
      profit_loss: pnl - position.fees_paid - closeFee,
      realized_pnl: pnl,
      status: "closed",
      closed_at: new Date().toISOString(),
      fees_paid: position.fees_paid + closeFee,
      hold_time: this.calculateHoldTime(position.opened_at),
    }

    this.positions.set(positionId, updatedPosition)
    return updatedPosition
  }

  async closeAllPositions(connectionId?: string): Promise<TradingPosition[]> {
    const closedPositions: TradingPosition[] = []

    for (const [id, position] of this.positions) {
      if (position.status === "open" && (!connectionId || position.connection_id === connectionId)) {
        const closed = await this.closePosition(id)
        if (closed) closedPositions.push(closed)
      }
    }

    return closedPositions
  }

  async closeProfitablePositions(connectionId?: string): Promise<TradingPosition[]> {
    const closedPositions: TradingPosition[] = []

    for (const [id, position] of this.positions) {
      if (
        position.status === "open" &&
        position.unrealized_pnl > 0 &&
        (!connectionId || position.connection_id === connectionId)
      ) {
        const closed = await this.closePosition(id)
        if (closed) closedPositions.push(closed)
      }
    }

    return closedPositions
  }

  updatePositionPrice(positionId: string, currentPrice: number): void {
    const position = this.positions.get(positionId)
    if (!position || position.status !== "open") return

    let unrealizedPnl: number
    if (position.position_side === "long") {
      unrealizedPnl = (currentPrice - position.entry_price) * position.volume * (position.leverage || 1)
    } else {
      unrealizedPnl = (position.entry_price - currentPrice) * position.volume * (position.leverage || 1)
    }

    const updatedPosition: TradingPosition = {
      ...position,
      current_price: currentPrice,
      unrealized_pnl: unrealizedPnl,
      profit_loss: unrealizedPnl - position.fees_paid,
      max_profit: Math.max(position.max_profit, unrealizedPnl),
      max_loss: Math.min(position.max_loss, unrealizedPnl),
      hold_time: this.calculateHoldTime(position.opened_at),
    }

    if (position.takeprofit) {
      const shouldClose =
        position.position_side === "long" ? currentPrice >= position.takeprofit : currentPrice <= position.takeprofit

      if (shouldClose) {
        this.closePosition(positionId, currentPrice)
        return
      }
    }

    if (position.stoploss) {
      const shouldClose =
        position.position_side === "long" ? currentPrice <= position.stoploss : currentPrice >= position.stoploss

      if (shouldClose) {
        this.closePosition(positionId, currentPrice)
        return
      }
    }

    this.positions.set(positionId, updatedPosition)
  }

  getTradingStats(connectionId?: string): TradingStats {
    const relevantPositions = Array.from(this.positions.values()).filter(
      (p) => !connectionId || p.connection_id === connectionId,
    )

    const openPositions = relevantPositions.filter((p) => p.status === "open")
    const closedPositions = relevantPositions.filter((p) => p.status === "closed")

    const totalPnl = relevantPositions.reduce((sum, p) => sum + p.profit_loss, 0)
    const totalVolume = relevantPositions.reduce((sum, p) => sum + p.volume, 0)

    const winningPositions = closedPositions.filter((p) => p.profit_loss > 0)
    const winRate = closedPositions.length > 0 ? winningPositions.length / closedPositions.length : 0

    const avgHoldTime =
      closedPositions.length > 0 ? closedPositions.reduce((sum, p) => sum + p.hold_time, 0) / closedPositions.length : 0

    const largestWin = Math.max(...closedPositions.map((p) => p.profit_loss), 0)
    const largestLoss = Math.min(...closedPositions.map((p) => p.profit_loss), 0)

    const balance = this.connectionBalances.get(connectionId || "default") || 10000
    const unrealizedPnl = openPositions.reduce((sum, p) => sum + p.unrealized_pnl, 0)
    const marginUsed = openPositions.reduce((sum, p) => sum + p.margin_used, 0)

    return {
      total_positions: relevantPositions.length,
      open_positions: openPositions.length,
      closed_positions: closedPositions.length,
      total_volume: totalVolume,
      total_pnl: totalPnl,
      win_rate: winRate,
      avg_hold_time: avgHoldTime,
      largest_win: largestWin,
      largest_loss: largestLoss,
      balance: balance + totalPnl,
      equity: balance + totalPnl + unrealizedPnl,
      margin: marginUsed,
      free_margin: balance + totalPnl - marginUsed,
    }
  }

  getTimeRangeStats(hours: number, connectionId?: string): TimeRangeStats {
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000)
    const relevantPositions = Array.from(this.positions.values()).filter(
      (p) =>
        (!connectionId || p.connection_id === connectionId) &&
        new Date(p.opened_at) >= cutoffTime &&
        p.status === "closed",
    )

    const totalPnl = relevantPositions.reduce((sum, p) => sum + p.profit_loss, 0)
    const winningPositions = relevantPositions.filter((p) => p.profit_loss > 0)
    const winRate = relevantPositions.length > 0 ? winningPositions.length / relevantPositions.length : 0
    const avgProfit = relevantPositions.length > 0 ? totalPnl / relevantPositions.length : 0

    return {
      positions_count: relevantPositions.length,
      total_pnl: totalPnl,
      win_rate: winRate,
      avg_profit: avgProfit,
      balance_change: totalPnl,
    }
  }

  getOpenPositions(connectionId?: string): TradingPosition[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.status === "open" && (!connectionId || p.connection_id === connectionId),
    )
  }

  getClosedPositions(connectionId?: string, limit = 50): TradingPosition[] {
    return Array.from(this.positions.values())
      .filter((p) => p.status === "closed" && (!connectionId || p.connection_id === connectionId))
      .sort((a, b) => new Date(b.closed_at || "").getTime() - new Date(a.closed_at || "").getTime())
      .slice(0, limit)
  }

  private calculateHoldTime(openedAt: string): number {
    return Math.floor((Date.now() - new Date(openedAt).getTime()) / (1000 * 60))
  }

  generateMockPositions(connectionId: string, count = 20): void {
    const symbols = ["BTCUSDT", "ETHUSDT", "XRPUSDT", "BCHUSDT", "LINKUSDT"]
    const strategies = ["Base Strategy", "Main Strategy", "Real Strategy", "Block Strategy", "DCA Strategy"]
    const indicationTypes: ("direction" | "move" | "active")[] = ["direction", "move", "active"]

    for (let i = 0; i < count; i++) {
      const symbol = symbols[Math.floor(Math.random() * symbols.length)]
      const strategy = strategies[Math.floor(Math.random() * strategies.length)]
      const entryPrice = 45000 + Math.random() * 10000
      const currentPrice = entryPrice + (Math.random() - 0.5) * 2000
      const baseVolume = 0.01 + Math.random() * 0.1
      const volumeFactor = 1 + Math.floor(Math.random() * 4) // 1-5
      const volumeCalc = this.calculateVolume(baseVolume, volumeFactor)

      const position: TradingPosition = {
        id: uuidv4(),
        connection_id: connectionId,
        exchange_position_id: `mock_${i}`,
        symbol,
        strategy_type: strategy,
        volume: volumeCalc.adjusted,
        entry_price: entryPrice,
        current_price: currentPrice,
        takeprofit: entryPrice * (1 + 0.02 + Math.random() * 0.03),
        stoploss: entryPrice * (1 - 0.01 - Math.random() * 0.02),
        profit_loss: (currentPrice - entryPrice) * volumeCalc.adjusted,
        status: Math.random() > 0.3 ? "open" : "closed",
        opened_at: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toISOString(),
        closed_at: Math.random() > 0.7 ? new Date().toISOString() : undefined,
        unrealized_pnl: (currentPrice - entryPrice) * volumeCalc.adjusted,
        realized_pnl: 0,
        margin_used: (volumeCalc.adjusted * entryPrice) / 150, // Margin based on leverage
        fees_paid: volumeCalc.adjusted * entryPrice * 0.001,
        hold_time: Math.floor(Math.random() * 1440), // 0-24 hours in minutes
        max_profit: Math.max(0, (currentPrice - entryPrice) * volumeCalc.adjusted),
        max_loss: Math.min(0, (currentPrice - entryPrice) * volumeCalc.adjusted),
        position_side: Math.random() > 0.5 ? "long" : "short",
        contract_type: "usdt-perpetual",
        leverage: 150,
        volume_factor: volumeCalc.factor,
        base_volume: volumeCalc.base,
        adjusted_volume: volumeCalc.adjusted,
        indication_type: indicationTypes[Math.floor(Math.random() * indicationTypes.length)],
      }

      this.positions.set(position.id, position)
    }

    this.connectionBalances.set(connectionId, 10000)
  }
}
