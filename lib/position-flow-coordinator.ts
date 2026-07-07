/**
 * Position Flow Coordinator
 * Manages the complete flow: Base Pseudo -> Main Pseudo -> Real Pseudo -> Exchange Positions
 * Handles performance tracking, validation, and mirroring to exchange
 * 
 * Redis-native: All data stored in Redis via redis-db
 */

import { initRedis, getSettings, setSettings, getRedisClient } from "@/lib/redis-db"
import { BasePseudoPositionManager } from "./base-pseudo-position-manager"
import { ExchangePositionManager } from "./exchange-position-manager"
import { logProgressionEvent } from "./engine-progression-logs"

export class PositionFlowCoordinator {
  private connectionId: string
  private basePseudoManager: BasePseudoPositionManager
  private exchangePositionManager: ExchangePositionManager

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.basePseudoManager = new BasePseudoPositionManager(connectionId)
    this.exchangePositionManager = new ExchangePositionManager(connectionId)
  }

  /**
   * Handle pseudo position close event
   */
  async onPseudoPositionClose(pseudoPositionId: string): Promise<void> {
    try {
      await initRedis()
      const position = await getSettings(`pseudo_position:${pseudoPositionId}`)

      if (!position) {
        console.log(`[v0] Position ${pseudoPositionId} not found`)
        return
      }

      const profitLoss = this.calculateProfitLoss(position)
      const isWin = position.direction === "long"
        ? position.current_price >= position.entry_price * (1 + (position.takeprofit_factor || 1) / 100)
        : position.current_price <= position.entry_price * (1 - (position.takeprofit_factor || 1) / 100)
      const drawdown = this.calculateDrawdown(position)

      if (position.position_level === "base" && position.base_position_id) {
        await this.basePseudoManager.updatePerformance(position.base_position_id, profitLoss, isWin, drawdown)
        await this.evaluateForMainPseudoGraduation(position.base_position_id, position.symbol)
      }

      if (position.position_level === "main") {
        await this.evaluateForRealPseudoGraduation(position)
      }

      console.log(
        `[v0] Processed ${position.position_level} position close ${pseudoPositionId}: ${isWin ? "WIN" : "LOSS"} ${profitLoss.toFixed(2)}%`,
      )
    } catch (error) {
      console.error(`[v0] Error handling pseudo position close:`, error)
    }
  }

  /**
   * Process validation for Real Pseudo Positions
   */
  async processRealPseudoValidation(symbol: string): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()
      await this.reconcileActiveRealPseudo()

      // Get main pseudo positions for this connection+symbol
      const positionIds = await client.smembers(`pseudo_positions:${this.connectionId}:main`)
      
      for (const posId of positionIds) {
        const mainPos = await getSettings(`pseudo_position:${posId}`)
        if (!mainPos || mainPos.symbol !== symbol || (mainPos.status !== "open" && mainPos.status !== "active")) continue // "active" kept for legacy Redis data
        if ((mainPos.profit_factor || 0) < 0.6) continue

        // Check if real pseudo already exists
        const existingReal = await getSettings(`real_pseudo:${this.connectionId}:main:${posId}`)
        if (existingReal) continue

        if (await this.isValidForRealPseudo(mainPos)) {
          await this.createRealPseudoPosition(mainPos)
        }
      }
    } catch (error) {
      console.error(`[v0] Error processing real pseudo validation for ${symbol}:`, error)
    }
  }

  /**
   * Check if Main Pseudo position qualifies for Real Pseudo
   */
  private async isValidForRealPseudo(mainPosition: any): Promise<boolean> {
    if ((mainPosition.profit_factor || 0) < 0.6) return false

    const hoursOpen = mainPosition.created_at
      ? (Date.now() - new Date(mainPosition.created_at).getTime()) / (1000 * 60 * 60)
      : 0
    if (hoursOpen > 12) return false

    if (mainPosition.base_position_id) {
      const basePos = await getSettings(`base_pseudo:${mainPosition.base_position_id}`)
      if (basePos && (basePos.status === "failed" || (basePos.win_rate || 0) < 0.4)) {
        return false
      }
    }

    return true
  }

  /**
   * Create Real Pseudo Position from validated Main Pseudo
   */
  private async createRealPseudoPosition(mainPosition: any): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()
      const realId = `rp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      const realPseudo = {
        id: realId,
        connection_id: this.connectionId,
        main_config_id: mainPosition.id,
        base_config_id: mainPosition.base_position_id,
        symbol: mainPosition.symbol,
        side: mainPosition.direction,
        entry_price: mainPosition.entry_price,
        quantity: mainPosition.quantity || 1,
        takeprofit: mainPosition.entry_price * (1 + (mainPosition.takeprofit_factor || 1) / 100),
        stoploss: mainPosition.entry_price * (1 - (mainPosition.stoploss_ratio || 1) / 100),
        trailing_enabled: mainPosition.trailing_enabled || false,
        trail_start: mainPosition.trail_start,
        trail_stop: mainPosition.trail_stop,
        status: "validated",
        validated_at: new Date().toISOString(),
        profit_factor: mainPosition.profit_factor,
      }

      await setSettings(`real_pseudo:${realId}`, realPseudo)
      await setSettings(`real_pseudo:${this.connectionId}:main:${mainPosition.id}`, { id: realId })
      await client.sadd(`real_pseudo_positions:${this.connectionId}`, realId)

      console.log(`[v0] Created Real Pseudo position ${realId} for ${mainPosition.symbol} from Main ${mainPosition.id}`)
    } catch (error) {
      console.error(`[v0] Error creating Real Pseudo position:`, error)
    }
  }

  /**
   * Process mirroring of Real Pseudo positions to exchange
   */
  async processExchangeMirroring(): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()
      await this.reconcileActiveRealPseudo()

      const realPosIds = await client.smembers(`real_pseudo_positions:${this.connectionId}`)

      for (const realId of realPosIds) {
        const realPos = await getSettings(`real_pseudo:${realId}`)
        if (!realPos || realPos.status !== "validated") continue

        // Check not already mirrored
        const mirrored = await getSettings(`exchange_mirror:${this.connectionId}:${realId}`)
        if (mirrored) continue

        const lastXProfitFactor = await this.getLastXPositionsProfitFactor(realPos.base_config_id, 30)

        if (lastXProfitFactor < 0.6) {
          console.log(`[v0] Last 30 positions PF ${lastXProfitFactor.toFixed(2)} < 0.6, skipping exchange mirror`)
          continue
        }

        await this.exchangePositionManager.mirrorToExchange(realPos)
        await setSettings(`exchange_mirror:${this.connectionId}:${realId}`, {
          mirrored_at: new Date().toISOString(),
        })

        await this.closeOrInvalidateRealPseudo(realId, "mirrored_to_live_exchange")
        console.log(`[v0] Mirrored REAL PSEUDO ${realId} to EXCHANGE (PF: ${lastXProfitFactor.toFixed(2)})`)
      }
    } catch (error) {
      console.error(`[v0] Error processing exchange mirroring:`, error)
    }
  }

  private calculateProfitLoss(position: any): number {
    const priceChange = (position.current_price - position.entry_price) / position.entry_price
    const multiplier = position.direction === "long" ? 1 : -1
    return priceChange * multiplier * 100
  }

  private calculateDrawdown(position: any): number {
    const profitLoss = this.calculateProfitLoss(position)
    return profitLoss < 0 ? Math.abs(profitLoss) : 0
  }

  /**
   * MAIN PSEUDO: Evaluate base positions with profit factor
   */
  private async evaluateForMainPseudoGraduation(basePositionId: string, symbol: string): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()
      const basePos = await getSettings(`base_pseudo:${basePositionId}`)
      if (!basePos) return

      const profitFactor =
        (basePos.winning_positions || 0) > 0 && (basePos.losing_positions || 0) > 0
          ? ((basePos.avg_profit || 0) * (basePos.win_rate || 0)) / ((basePos.avg_loss || 1) * (1 - (basePos.win_rate || 0)))
          : 0

      if (profitFactor < 0.5) return
      if ((basePos.total_positions || 0) < 10) return

      // Check if MAIN PSEUDO already exists for this base
      const existingMain = await getSettings(`main_pseudo:${this.connectionId}:base:${basePositionId}`)
      if (existingMain) return

      const mainId = `mp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const mainPseudo = {
        id: mainId,
        connection_id: this.connectionId,
        symbol: basePos.symbol || symbol,
        indication_type: basePos.indication_type,
        indication_range: basePos.indication_range,
        takeprofit_factor: basePos.takeprofit_factor,
        stoploss_ratio: basePos.stoploss_ratio,
        trailing_enabled: basePos.trailing_enabled || false,
        trail_start: basePos.trail_start,
        trail_stop: basePos.trail_stop,
        entry_price: basePos.entry_price,
        current_price: basePos.entry_price,
        direction: basePos.direction,
        status: "main_active",
        base_position_id: basePositionId,
        position_level: "main",
        profit_factor: profitFactor,
        created_at: new Date().toISOString(),
      }

      await setSettings(`pseudo_position:${mainId}`, mainPseudo)
      await setSettings(`main_pseudo:${this.connectionId}:base:${basePositionId}`, { id: mainId })
      await client.sadd(`pseudo_positions:${this.connectionId}:main`, mainId)
      await client.sadd(`main_pseudo:${this.connectionId}`, mainId)

      console.log(`[v0] Created MAIN PSEUDO ${mainId} for base ${basePositionId} (PF: ${profitFactor.toFixed(2)})`)
      
      // Log main pseudo graduation
      await logProgressionEvent(this.connectionId, "main_pseudo_graduated", "info", `Graduated to main pseudo position`, {
        basePositionId,
        mainPositionId: mainId,
        symbol: basePos.symbol || symbol,
        indicationType: basePos.indication_type,
        profitFactor: profitFactor.toFixed(2),
      })
    } catch (error) {
      console.error(`[v0] Error evaluating for main pseudo graduation:`, error)
    }
  }

  /**
   * REAL PSEUDO: Validate MAIN positions with drawdown time from last X positions
   */
  private async evaluateForRealPseudoGraduation(mainPosition: any): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()

      // Get recent main positions for this base
      const mainPosIds = await client.smembers(`pseudo_positions:${this.connectionId}:main`)
      const lastXPositions: any[] = []

      for (const posId of mainPosIds) {
        const pos = await getSettings(`pseudo_position:${posId}`)
        if (pos && pos.base_position_id === mainPosition.base_position_id) {
          lastXPositions.push(pos)
        }
      }

      // Sort by created_at DESC and take last 20
      lastXPositions.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      const recentPositions = lastXPositions.slice(0, 20)

      if (recentPositions.length < 10) return

      const avgDrawdownTime = this.calculateAverageDrawdownTime(recentPositions)
      const recentProfitFactor = this.calculateProfitFactorFromPositions(recentPositions)

      if (recentProfitFactor < 0.6) return
      if (avgDrawdownTime > 12) return

      // Check if REAL PSEUDO already exists
      const existingReal = await getSettings(`real_pseudo:${this.connectionId}:main:${mainPosition.id}`)
      if (existingReal) return

      const realId = `rp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const realPseudo = {
        id: realId,
        connection_id: this.connectionId,
        main_config_id: mainPosition.id,
        base_config_id: mainPosition.base_position_id,
        symbol: mainPosition.symbol,
        side: mainPosition.direction,
        entry_price: mainPosition.entry_price,
        quantity: mainPosition.quantity || 1,
        takeprofit: mainPosition.entry_price * (1 + (mainPosition.takeprofit_factor || 1) / 100),
        stoploss: mainPosition.entry_price * (1 - (mainPosition.stoploss_ratio || 1) / 100),
        trailing_enabled: mainPosition.trailing_enabled || false,
        trail_start: mainPosition.trail_start,
        trail_stop: mainPosition.trail_stop,
        status: "validated",
        validated_at: new Date().toISOString(),
        profit_factor: recentProfitFactor,
        avg_drawdown_time: avgDrawdownTime,
      }

      await setSettings(`real_pseudo:${realId}`, realPseudo)
      await setSettings(`real_pseudo:${this.connectionId}:main:${mainPosition.id}`, { id: realId })
      await client.sadd(`real_pseudo_positions:${this.connectionId}`, realId)
      await client.sadd(`real_pseudo:${this.connectionId}`, realId)

      console.log(`[v0] Created REAL PSEUDO ${realId} representing MAIN ${mainPosition.id} (PF: ${recentProfitFactor.toFixed(2)}, DD: ${avgDrawdownTime.toFixed(1)}h)`)
      
      // Log real pseudo graduation
      await logProgressionEvent(this.connectionId, "real_pseudo_graduated", "info", `Graduated to real pseudo position`, {
        mainPositionId: mainPosition.id,
        realPositionId: realId,
        symbol: mainPosition.symbol,
        profitFactor: recentProfitFactor.toFixed(2),
        avgDrawdownTime: avgDrawdownTime.toFixed(1),
      })
    } catch (error) {
      console.error(`[v0] Error evaluating for real pseudo graduation:`, error)
    }
  }

  private calculateAverageDrawdownTime(positions: any[]): number {
    if (positions.length === 0) return 0
    const totalDrawdownHours = positions.reduce((sum: number, pos: any) => {
      const hoursOpen = pos.closed_at
        ? (new Date(pos.closed_at).getTime() - new Date(pos.created_at).getTime()) / (1000 * 60 * 60)
        : 0
      return sum + hoursOpen
    }, 0)
    return totalDrawdownHours / positions.length
  }

  private calculateProfitFactorFromPositions(positions: any[]): number {
    const wins = positions.filter((p: any) => (p.profit_loss || 0) > 0)
    const losses = positions.filter((p: any) => (p.profit_loss || 0) < 0)
    if (losses.length === 0) return wins.length > 0 ? 999 : 0
    const avgWin = wins.reduce((sum: number, p: any) => sum + (p.profit_loss || 0), 0) / (wins.length || 1)
    const avgLoss = Math.abs(losses.reduce((sum: number, p: any) => sum + (p.profit_loss || 0), 0) / losses.length)
    const winRate = wins.length / positions.length
    return (avgWin * winRate) / (avgLoss * (1 - winRate))
  }

  private async getLastXPositionsProfitFactor(baseConfigId: string, count: number): Promise<number> {
    try {
      await initRedis()
      const client = getRedisClient()
      const mainPosIds = await client.smembers(`pseudo_positions:${this.connectionId}:main`)
      const positions: any[] = []

      for (const posId of mainPosIds) {
        const pos = await getSettings(`pseudo_position:${posId}`)
        if (pos && pos.base_position_id === baseConfigId && (pos.status || "").includes("closed")) {
          positions.push(pos)
        }
      }

      positions.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
      return this.calculateProfitFactorFromPositions(positions.slice(0, count))
    } catch {
      return 0
    }
  }

  async closeOrInvalidateRealPseudo(realId: string, reason: string = "processed_or_invalid"): Promise<void> {
    try {
      const client = getRedisClient()
      await client.srem(`real_pseudo:${this.connectionId}`, realId)
      await client.srem(`real_pseudo_positions:${this.connectionId}`, realId)
      const pos = await getSettings(`real_pseudo:${realId}`)
      if (pos) {
        pos.status = "closed"
        pos.closed_at = new Date().toISOString()
        pos.close_reason = reason
        await setSettings(`real_pseudo:${realId}`, pos)
      }
      await logProgressionEvent(this.connectionId, "real_pseudo_closed", "info", `Real pseudo closed: ${reason}`, { realId, reason })
    } catch (e) {
      console.error("[v0] closeOrInvalidateRealPseudo error", e)
    }
  }

  async reconcileActiveRealPseudo(): Promise<number> {
    try {
      const client = getRedisClient()
      const ids = await client.smembers(`real_pseudo:${this.connectionId}`)
      let removed = 0
      for (const id of ids) {
        const p = await getSettings(`real_pseudo:${id}`)
        const invalid = !p || p.status !== "validated" || (p.status === "closed")
        if (invalid) {
          await client.srem(`real_pseudo:${this.connectionId}`, id)
          await client.srem(`real_pseudo_positions:${this.connectionId}`, id)
          removed++
        }
      }
      if (removed > 0) {
        await logProgressionEvent(this.connectionId, "real_pseudo_reconciled", "info", `Reconciled removed ${removed} stale real pseudo positions`)
      }
      return removed
    } catch {
      return 0
    }
  }
}
