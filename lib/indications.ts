import { v4 as uuidv4 } from "uuid"
import type { IndicationConfig, PseudoPosition } from "./types"
import { db } from "@/lib/database"
import { calculateSignedResultR } from "@/lib/profit-factor"

export interface IndicationResult {
  id: string
  type: "direction" | "move" | "active"
  symbol: string
  range: number
  config: IndicationConfig
  signal_strength: number
  entry_price: number
  timestamp: Date
  pseudo_positions: PseudoPosition[]
}

export class IndicationEngine {
  private marketData: Map<string, number[]> = new Map()
  private activeIndications: Map<string, IndicationResult> = new Map()
  private cachedPositionCost: number | null = null
  private lastPositionCostFetch = 0
  private readonly CACHE_TTL = 60000 // 1 minute cache

  private async getPositionCost(): Promise<number> {
    const now = Date.now()
    if (this.cachedPositionCost !== null && now - this.lastPositionCostFetch < this.CACHE_TTL) {
      return this.cachedPositionCost
    }

    try {
      const value = await db.getSetting("positionCost")
      this.cachedPositionCost = value ? Number.parseFloat(value) : 0.1 // Default 10%
      this.lastPositionCostFetch = now
      return this.cachedPositionCost
    } catch (error) {
      console.error("[v0] Failed to get positionCost setting:", error)
      return 0.1 // Default 10%
    }
  }

  // Direction Change Indication
  async calculateDirectionIndication(
    symbol: string,
    prices: number[],
    config: IndicationConfig,
  ): Promise<IndicationResult | null> {
    if (prices.length < config.range * 2) return null

    const recentPrices = prices.slice(-config.range * 2)
    const firstHalf = recentPrices.slice(0, config.range)
    const secondHalf = recentPrices.slice(config.range)

    const firstDirection = this.calculateDirection(firstHalf)
    const secondDirection = this.calculateDirection(secondHalf)

    if (Math.abs(firstDirection) > 0.1 && Math.abs(secondDirection) > 0.1) {
      if ((firstDirection > 0 && secondDirection < 0) || (firstDirection < 0 && secondDirection > 0)) {
        const signalStrength = Math.abs(firstDirection) + Math.abs(secondDirection)

        if (signalStrength >= (config.price_change_ratio || 0.1)) {
          return await this.createIndicationResult(
            "direction",
            symbol,
            config,
            signalStrength,
            prices[prices.length - 1],
          )
        }
      }
    }

    return null
  }

  // Move Indication (without opposite direction requirement)
  async calculateMoveIndication(
    symbol: string,
    prices: number[],
    config: IndicationConfig,
  ): Promise<IndicationResult | null> {
    if (prices.length < config.range) return null

    const recentPrices = prices.slice(-config.range)
    const direction = this.calculateDirection(recentPrices)
    const priceChange = Math.abs(direction)

    if (priceChange >= (config.price_change_ratio || 0.1)) {
      return await this.createIndicationResult("move", symbol, config, priceChange, prices[prices.length - 1])
    }

    return null
  }

  // Active Indication (fast price change)
  async calculateActiveIndication(
    symbol: string,
    prices: number[],
    config: IndicationConfig,
  ): Promise<IndicationResult | null> {
    if (prices.length < 2) return null

    const currentPrice = prices[prices.length - 1]
    const previousPrice = prices[prices.length - 2]
    const priceChangeRatio = Math.abs((currentPrice - previousPrice) / previousPrice)

    const threshold = config.price_change_ratio || 0.5
    if (priceChangeRatio >= threshold / 100) {
      return await this.createIndicationResult("active", symbol, config, priceChangeRatio * 100, currentPrice)
    }

    return null
  }

  private calculateDirection(prices: number[]): number {
    if (prices.length < 2) return 0

    const start = prices[0]
    const end = prices[prices.length - 1]
    return (end - start) / start
  }

  private async createIndicationResult(
    type: "direction" | "move" | "active",
    symbol: string,
    config: IndicationConfig,
    signalStrength: number,
    entryPrice: number,
  ): Promise<IndicationResult> {
    const id = uuidv4()
    const pseudoPositions = await this.generatePseudoPositions(symbol, entryPrice, config)

    return {
      id,
      type,
      symbol,
      range: config.range,
      config,
      signal_strength: signalStrength,
      entry_price: entryPrice,
      timestamp: new Date(),
      pseudo_positions: pseudoPositions,
    }
  }

  private async generatePseudoPositions(
    symbol: string,
    entryPrice: number,
    config: IndicationConfig,
  ): Promise<PseudoPosition[]> {
    const positions: PseudoPosition[] = []
    const positionCost = await this.getPositionCost()

    // Stop-loss grid: operator-spec extension to 3.0 with step 0.25.
    // Coarser-but-wider sweep (12 values vs the legacy 0.2..2.2/0.1 = 21):
    // Updated to new unified ranges: SL 0.2 to 2.2 with 0.1 step (21 values)
    // TP factors 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22 (11 values)
    for (let tpFactor = 2; tpFactor <= 22; tpFactor += 2) {
      for (let slRatio = 0.2; slRatio <= 2.2 + 1e-9; slRatio += 0.1) {
        const slRatioFixed = Number(slRatio.toFixed(1))
        positions.push(
          this.createPseudoPosition(symbol, entryPrice, tpFactor, slRatioFixed, false, positionCost, config.type),
        )

        const trailStarts = [0.3, 0.6, 1.0]
        const trailStops = [0.1, 0.2, 0.3]

        trailStarts.forEach((trailStart) => {
          trailStops.forEach((trailStop) => {
            positions.push(
              this.createPseudoPosition(
                symbol,
                entryPrice,
                tpFactor,
                slRatioFixed,
                true,
                positionCost,
                config.type,
                trailStart,
                trailStop,
              ),
            )
          })
        })
      }
    }

    return positions.slice(0, 250)
  }

  private createPseudoPosition(
    symbol: string,
    entryPrice: number,
    tpFactor: number,
    slRatio: number,
    trailingEnabled: boolean,
    positionCost: number,
    indicationType: string,
    trailStart?: number,
    trailStop?: number,
  ): PseudoPosition {
    const validIndicationType = ["direction", "move", "active"].includes(indicationType)
      ? (indicationType as "direction" | "move" | "active")
      : "direction"

    return {
      id: uuidv4(),
      connection_id: "system",
      symbol,
      indication_type: validIndicationType,
      takeprofit_factor: tpFactor,
      stoploss_ratio: slRatio,
      trailing_enabled: trailingEnabled,
      trail_start: trailStart,
      trail_stop: trailStop,
      entry_price: entryPrice,
      current_price: entryPrice,
      profit_factor: 0,
      signedResultR: 0,
      costNormalizedReturn: 0,
      position_cost: positionCost,
      status: "open",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
  }

  // Update pseudo positions with current market data
  updatePseudoPositions(positions: PseudoPosition[], currentPrice: number): PseudoPosition[] {
    return positions.map((position) => {
      const direction = position.direction === "short" ? "short" : "long"
      const signedPricePercent =
        direction === "long"
          ? ((currentPrice - position.entry_price) / position.entry_price) * 100
          : ((position.entry_price - currentPrice) / position.entry_price) * 100
      const positionCostPct = Number.isFinite(position.position_cost) && position.position_cost > 0 ? position.position_cost : 0.1
      const signedResultR = signedPricePercent / positionCostPct

      return {
        ...position,
        current_price: currentPrice,
        signedResultR,
        costNormalizedReturn: signedResultR,
        profit_factor: Math.max(0, signedResultR),
        signed_result_r: signedResultR,
        updated_at: new Date().toISOString(),
      }
    })
  }

  // Get indication statistics
  getIndicationStats(positions: PseudoPosition[]) {
    const profitable = positions.filter((p) => (p.signedResultR ?? p.costNormalizedReturn ?? p.profit_factor) > 0).length
    const total = positions.length
    const avgSignedResultR = positions.reduce((sum, p) => sum + (p.signedResultR ?? p.costNormalizedReturn ?? p.profit_factor), 0) / total

    return {
      total_positions: total,
      profitable_positions: profitable,
      profit_ratio: profitable / total,
      avg_signed_result_r: avgSignedResultR,
      last_8_avg: this.calculateLastNAverage(positions, 8),
      last_20_avg: this.calculateLastNAverage(positions, 20),
      last_50_avg: this.calculateLastNAverage(positions, 50),
    }
  }

  private calculateLastNAverage(positions: PseudoPosition[], n: number): number {
    const recent = positions.slice(-n)
    return recent.reduce((sum, p) => sum + (p.signedResultR ?? p.costNormalizedReturn ?? p.profit_factor), 0) / recent.length
  }
}
