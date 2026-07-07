/**
 * High-Performance Pseudo Positions Coordinator
 * Handles 250+ positions with O(1) lookups using indexed arrays and Maps
 * Target: <100ms processing cycle for all position updates
 */

import { PositionsCacheOptimizer } from "@/lib/positions-cache-optimizer"

export interface PositionIndexEntry {
  id: number
  symbol: string
  side: "long" | "short"
  configKey: string // symbol:side:tp:sl
}

export class PseudoPositionsCoordinator {
  private connectionId: string
  private cacheOptimizer: PositionsCacheOptimizer
  private positionArray: any[] = [] // O(1) append, O(n) iterate
  private symbolIndex: Map<string, number[]> = new Map() // symbol -> array indices
  private configIndex: Map<string, number> = new Map() // configKey -> array index
  private lastRefresh = 0
  private readonly REFRESH_INTERVAL = 1000 // 1 second between full refreshes

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.cacheOptimizer = new PositionsCacheOptimizer(connectionId)
  }

  /**
   * Initialize and warm caches on startup
   */
  async initialize(): Promise<void> {
    console.log(`[v0] Initializing PseudoPositionsCoordinator for connection ${this.connectionId}`)
    await this.cacheOptimizer.warmCache()
    await this.rebuildIndices()
  }

  /**
   * Rebuild all indices (call on startup or after cache invalidation)
   * Time: O(n) where n = number of positions (happens infrequently)
   */
  private async rebuildIndices(): Promise<void> {
    try {
      const symbolIndex = await this.cacheOptimizer.getAllActivePositions()

      this.positionArray = []
      this.symbolIndex.clear()
      this.configIndex.clear()

      let arrayIndex = 0
      for (const [symbol, positions] of symbolIndex) {
        this.symbolIndex.set(symbol, [])

        for (const pos of positions) {
          this.positionArray.push(pos)
          this.symbolIndex.get(symbol)!.push(arrayIndex)

          // Build config key for quick deduplication check
          const configKey = `${symbol}:${pos.side}:${pos.takeprofit_factor}:${pos.stoploss_ratio}`
          this.configIndex.set(configKey, arrayIndex)

          arrayIndex++
        }
      }

      this.lastRefresh = Date.now()
    } catch (error) {
      console.error("[v0] Failed to rebuild indices:", error)
    }
  }

  /**
   * Get all positions for a symbol (O(1) after first lookup)
   * Uses index to get array positions, then direct array access
   */
  getPositionsBySymbol(symbol: string): any[] {
    const indices = this.symbolIndex.get(symbol) || []
    return indices.map((idx) => this.positionArray[idx])
  }

  /**
   * Get position by configuration (O(1) lookup)
   * Configuration: symbol:side:tp_factor:sl_ratio
   */
  getPositionByConfig(symbol: string, side: string, tpFactor: number, slRatio: number): any | null {
    const configKey = `${symbol}:${side}:${tpFactor}:${slRatio}`
    const index = this.configIndex.get(configKey)
    return index !== undefined ? this.positionArray[index] : null
  }

  /**
   * Add position to indices
   * Time: O(1) append + O(1) Map insertions
   */
  addPositionToIndices(position: any): void {
    const arrayIndex = this.positionArray.length
    this.positionArray.push(position)

    // Update symbol index
    if (!this.symbolIndex.has(position.symbol)) {
      this.symbolIndex.set(position.symbol, [])
    }
    this.symbolIndex.get(position.symbol)!.push(arrayIndex)

    // Update config index
    const configKey = `${position.symbol}:${position.side}:${position.takeprofit_factor}:${position.stoploss_ratio}`
    this.configIndex.set(configKey, arrayIndex)
  }

  /**
   * Remove position from indices
   * Time: O(1) set removal, O(n) array splice (but typically n=1 per symbol)
   */
  removePositionFromIndices(positionId: number): void {
    const arrayIndex = this.positionArray.findIndex((p) => p.id === positionId)
    if (arrayIndex === -1) return

    const position = this.positionArray[arrayIndex]

    // Remove from symbol index
    const symbolIndices = this.symbolIndex.get(position.symbol) || []
    const symbolIndexPos = symbolIndices.indexOf(arrayIndex)
    if (symbolIndexPos !== -1) {
      symbolIndices.splice(symbolIndexPos, 1)
    }

    // Remove from config index
    const configKey = `${position.symbol}:${position.side}:${position.takeprofit_factor}:${position.stoploss_ratio}`
    this.configIndex.delete(configKey)

    // Remove from array (swap-and-pop for O(1) instead of O(n))
    const lastIndex = this.positionArray.length - 1
    if (arrayIndex !== lastIndex) {
      this.positionArray[arrayIndex] = this.positionArray[lastIndex]
      // Update indices to point to new location
      const movedPosition = this.positionArray[arrayIndex]
      const movedSymbolIndices = this.symbolIndex.get(movedPosition.symbol) || []
      const movedPos = movedSymbolIndices.indexOf(lastIndex)
      if (movedPos !== -1) {
        movedSymbolIndices[movedPos] = arrayIndex
      }
    }
    this.positionArray.pop()
  }

  /**
   * Iterate all positions for updates
   * Time: O(n) optimal for this operation - must check all positions
   * NO LOGGING in this loop - only at start/end
   */
  async updateAllPositions(updateFn: (pos: any) => Promise<void>): Promise<number> {
    let updated = 0

    // Batch updates in groups of 10 for efficiency
    for (let i = 0; i < this.positionArray.length; i += 10) {
      const batch = this.positionArray.slice(i, Math.min(i + 10, this.positionArray.length))
      await Promise.all(batch.map(async (pos) => {
        try {
          await updateFn(pos)
          updated++
        } catch (error) {
          // Only log errors, not successes
          console.error(`[v0] Failed to update position ${pos.id}:`, error)
        }
      }))
    }

    return updated
  }

  /**
   * Get count of positions (O(1) - just array length)
   */
  getCount(): number {
    return this.positionArray.length
  }

  /**
   * Get count for specific symbol (O(1) - Map lookup)
   */
  getCountBySymbol(symbol: string): number {
    return (this.symbolIndex.get(symbol) || []).length
  }

  /**
   * Check if position with config already exists (O(1) lookup)
   */
  hasPositionWithConfig(symbol: string, side: string, tpFactor: number, slRatio: number): boolean {
    const configKey = `${symbol}:${side}:${tpFactor}:${slRatio}`
    return this.configIndex.has(configKey)
  }

  /**
   * Refresh indices if cache is stale
   * Time: O(n) but only happens every 1 second max
   */
  async refreshIfNeeded(): Promise<void> {
    const now = Date.now()
    if (now - this.lastRefresh > this.REFRESH_INTERVAL) {
      await this.rebuildIndices()
    }
  }

  /**
   * Get all positions (for reporting/debugging)
   */
  getAllPositions(): any[] {
    return [...this.positionArray]
  }

  /**
   * Get positions by side (O(n) filter, but typically small n)
   */
  getPositionsBySide(side: "long" | "short"): any[] {
    return this.positionArray.filter((p) => p.side === side)
  }

  /**
   * Get statistics for display/monitoring
   * Time: O(n) but infrequent call
   */
  getStatistics(): {
    totalPositions: number
    positionsBySymbol: Record<string, number>
    positionsBySide: { long: number; short: number }
    avgPositionsPerSymbol: number
  } {
    const positionsBySymbol: Record<string, number> = {}
    let longCount = 0
    let shortCount = 0

    for (const [symbol, indices] of this.symbolIndex) {
      positionsBySymbol[symbol] = indices.length
    }

    for (const pos of this.positionArray) {
      if (pos.side === "long") longCount++
      else if (pos.side === "short") shortCount++
    }

    const totalPositions = this.positionArray.length
    const avgPerSymbol = this.symbolIndex.size > 0 ? totalPositions / this.symbolIndex.size : 0

    return {
      totalPositions,
      positionsBySymbol,
      positionsBySide: { long: longCount, short: shortCount },
      avgPositionsPerSymbol: Math.round(avgPerSymbol * 100) / 100,
    }
  }
}
