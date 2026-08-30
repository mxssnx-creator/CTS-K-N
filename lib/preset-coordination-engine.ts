/**
 * Preset Coordination Engine
 * Handles multiple configuration sets with independent position limits
 * Loads historical data only if not exists, calculates missing timeranges
 * Coordinates real position opening based on evaluation results
 */

import { sql, execute } from "@/lib/db"
import type { PresetType, PresetConfigurationSet, PresetCoordinationResult } from "@/lib/types-preset-coordination"
import { calculateIndicators, type IndicatorConfig } from "./indicators"
// Plain `crypto` — Edge build aliases this to `false` via `next.config.mjs`.
import * as crypto from "crypto"
import { PresetPseudoPositionManager } from "./preset-pseudo-position-manager"
import { DataSyncManager } from "./data-sync-manager"
import { logProgressionEvent } from "./engine-progression-logs"
import { concurrencyFromEnv, mapWithConcurrency } from "./bounded-concurrency"
import { VolumeCalculator } from "./volume-calculator"
import { exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { normalizeExchangeId, normalizeMarketSymbol, normalizeMarketType, getDefaultSymbolsForMarket, type MarketType } from "@/lib/market-types"
import { isForexSymbol, normalizeForexSymbol } from "@/lib/forex-market"
import { fetchDirectTradeMinuteHistory } from "@/lib/direct-trade-market-history"
import { resolvePositionNotionalUsd } from "@/lib/live-position-pnl"
import { effectivePositionCostPercent } from "@/lib/position-cost"

function toEpochMilliseconds(value: unknown): number {
  if (value instanceof Date) {
    const timestamp = value.getTime()
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0
  }
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 100_000_000_000 ? numeric * 1000 : numeric
  }
  const parsed = Date.parse(String(value ?? ""))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export interface PresetCoordinationConfig {
  connectionId: string
  presetTypeId: string
  autoInitiate: boolean
  calculateHistory: boolean
}

export class PresetCoordinationEngine {
  private connectionId: string
  private presetTypeId: string
  private isRunning = false
  private coordinationInterval?: NodeJS.Timeout
  private presetType: PresetType | null = null
  private configurationSets: PresetConfigurationSet[] = []
  private positionLimits: Map<string, number> = new Map()
  private lastPositionTime: Map<string, number> = new Map()
  private pseudoPositionManager: PresetPseudoPositionManager
  private marketContext: {
    exchange: string
    marketType: MarketType
    positionCostPercent: number
    lotSize?: number
    quoteToUsdRate?: number
    spreadBufferPips?: number
    spreadMultiplier?: number
  } | null = null
  private currentMarketCache: Map<string, { fetchedAt: number; candles: any[] }> = new Map()
  private positionCostCache: Map<string, { value: number; fetchedAt: number }> = new Map()
  private readonly POSITION_COST_CACHE_TTL_MS = 30_000

  private readonly MAX_CONCURRENT_SYMBOLS = concurrencyFromEnv(
    ["PRESET_SYMBOL_CONCURRENCY", "ENGINE_SYMBOL_CONCURRENCY"],
    4,
    8,
  )
  private readonly MAX_CONCURRENT_CONFIG_SETS = concurrencyFromEnv(
    ["PRESET_CONFIG_SET_CONCURRENCY"],
    2,
    4,
  )
  private readonly MAX_CONCURRENT_INDICATIONS = concurrencyFromEnv(
    ["PRESET_COMBINATION_CONCURRENCY"],
    8,
    20,
  )

  constructor(connectionId: string, presetTypeId: string) {
    this.connectionId = connectionId
    this.presetTypeId = presetTypeId
    this.pseudoPositionManager = new PresetPseudoPositionManager(connectionId, presetTypeId)
  }

  /**
   * Start the preset coordination engine
   */
  async start(config: PresetCoordinationConfig): Promise<void> {
    if (this.isRunning) {
      console.log("[v0] Preset coordination engine already running")
      return
    }

    console.log("[v0] Starting preset coordination engine")

    try {
      // Load preset type and configuration sets
      await this.loadPresetConfiguration()

      if (config.calculateHistory) {
        // Load historical data for all symbols (only if not exists)
        await this.loadHistoricalDataIfNeeded()
      }

      // Calculate coordination results for all configuration combinations
      await this.calculateCoordinationResults()

      if (config.autoInitiate) {
        // Start coordination interval loop
        await this.startCoordinationLoop()
      }

      await this.pseudoPositionManager.start()

      this.isRunning = true
      console.log("[v0] Preset coordination engine started successfully")
    } catch (error) {
      console.error("[v0] Failed to start preset coordination engine:", error)
      throw error
    }
  }

  /**
   * Stop the preset coordination engine
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return

    console.log("[v0] Stopping preset coordination engine")

    if (this.coordinationInterval) clearInterval(this.coordinationInterval)

    await this.pseudoPositionManager.stop()

    this.isRunning = false
    console.log("[v0] Preset coordination engine stopped")
  }

  /**
   * Load preset type and configuration sets
   */
  private async loadPresetConfiguration(): Promise<void> {
    // Load preset type
    const [presetType] = await sql`
      SELECT * FROM preset_types WHERE id = ${this.presetTypeId}
    `

    if (!presetType) {
      throw new Error(`Preset type ${this.presetTypeId} not found`)
    }

    this.presetType = presetType as PresetType

    // Load configuration sets
    const sets = await sql`
      SELECT cs.* FROM preset_configuration_sets cs
      INNER JOIN preset_type_sets pts ON cs.id = pts.configuration_set_id
      WHERE pts.preset_type_id = ${this.presetTypeId}
        AND pts.is_active = true
        AND cs.is_active = true
      ORDER BY pts.priority ASC
    `

    this.configurationSets = sets as PresetConfigurationSet[]

    console.log(`[v0] Loaded ${this.configurationSets.length} configuration sets`)
  }

  /**
   * Load historical data only if not already exists
   * Calculate only missing timerange
   */
  private async loadHistoricalDataIfNeeded(): Promise<void> {
    console.log("[v0] Checking historical data...")
    const symbolDayRequirements = new Map<string, number>()

    for (const configSet of this.configurationSets) {
      const symbols = await this.getSymbolsForConfigSet(configSet)
      for (const symbol of symbols) {
        const existingDays = symbolDayRequirements.get(symbol) || 0
        symbolDayRequirements.set(symbol, Math.max(existingDays, configSet.range_days))
      }
    }

    const symbolEntries = Array.from(symbolDayRequirements.entries())
    let completed = 0

    await mapWithConcurrency(
      symbolEntries,
      this.MAX_CONCURRENT_SYMBOLS,
      async ([symbol, requiredDays]) => {
          try {
            const endTime = new Date()
            const startTime = new Date(endTime.getTime() - requiredDays * 24 * 60 * 60 * 1000)
            const syncStatus = await DataSyncManager.checkSyncStatus(
              this.connectionId,
              symbol,
              "market_data",
              startTime,
              endTime,
            )

            if (!syncStatus.needsSync) {
              console.log(`[v0] Historical data for ${symbol} already fully synced`)
              completed++
              return
            }

            for (const missingRange of syncStatus.missingRanges) {
              await this.loadHistoricalDataRangeForSymbol(symbol, missingRange.start, missingRange.end)
            }

            completed++
            await logProgressionEvent(this.connectionId, "preset_historical_progress", "info", "Historical sync progress", {
              completed,
              total: symbolEntries.length,
              symbol,
              requiredDays,
              missingRanges: syncStatus.missingRanges.length,
            })
          } catch (error) {
            console.error(`[v0] Failed to check/load historical data for ${symbol}:`, error)
            completed++
          }
      },
    )

    console.log("[v0] Historical data check complete")
  }

  /**
   * Load historical data for a symbol (only missing timerange)
   */
  private async loadHistoricalDataRangeForSymbol(symbol: string, startTime: Date, endTime: Date): Promise<void> {
    // Fetch historical OHLCV data from exchange
    // This is a placeholder - actual implementation depends on exchange API
    const historicalData = await this.fetchHistoricalOHLCV(symbol, startTime, endTime)

    // Store in database
    if (historicalData.length > 0) {
      await this.storeHistoricalData(symbol, historicalData)
      await DataSyncManager.logSync(
        this.connectionId,
        symbol,
        "market_data",
        startTime,
        endTime,
        historicalData.length,
        "success",
      )
      console.log(
        `[v0] Loaded ${historicalData.length} candles for ${symbol} [${startTime.toISOString()} → ${endTime.toISOString()}]`,
      )
    } else {
      await DataSyncManager.logSync(this.connectionId, symbol, "market_data", startTime, endTime, 0, "partial")
    }
  }

  /**
   * Calculate coordination results for all configuration combinations
   */
  private async calculateCoordinationResults(): Promise<void> {
    console.log("[v0] Calculating coordination results...")

    // ── Per-config-set fan-out ─────────────────────────────────────────
    // ConfigurationSets are independent — each writes to its own
    // result keyspace — so iterate them in parallel. Within a single
    // configSet we still fan out across symbols with a bounded
    // concurrency cap (MAX_CONCURRENT_SYMBOLS), matching the pattern
    // used in `loadHistoricalDataIfNeeded` above. This turns the
    // previous O(configSets × symbols) sequential chain into a
    // bounded-parallel fan-out that scales with hardware/Redis
    // capacity instead of with the size of the basket.
    await mapWithConcurrency(
      this.configurationSets,
      this.MAX_CONCURRENT_CONFIG_SETS,
      async (configSet) => {
        try {
          const symbols = await this.getSymbolsForConfigSet(configSet)
          await mapWithConcurrency(symbols, this.MAX_CONCURRENT_SYMBOLS, async (symbol) => {
            await this.calculateConfigSetResults(configSet, symbol).catch((err) => {
              console.error(
                `[v0] calculateConfigSetResults failed for set=${configSet.id} symbol=${symbol}:`,
                err instanceof Error ? err.message : String(err),
              )
            })
          })
        } catch (error) {
          console.error(`[v0] Failed to calculate results for config set ${configSet.id}:`, error)
        }
      },
    )

    console.log("[v0] Coordination results calculation complete")
  }

  /**
   * Calculate results for a specific configuration set and symbol
   * Now processes indication combinations asynchronously in parallel
   */
  private async calculateConfigSetResults(configSet: PresetConfigurationSet, symbol: string): Promise<void> {
    // Get historical data
    const historicalData = await this.getHistoricalData(symbol, configSet.range_days)

    if (historicalData.length < 100) {
      console.log(`[v0] Insufficient historical data for ${symbol}`)
      return
    }

    // Generate all indication parameter combinations (50% range with dynamic steps)
    const indicationCombinations = this.generateIndicationCombinations(configSet)

    // Generate all position range combinations
    const positionRangeCombinations = this.generatePositionRangeCombinations(configSet)

    // Generate all trailing combinations
    const trailingCombinations = this.generateTrailingCombinations(configSet)

    const allCombinations: Array<{
      indication: any
      position: any
      trailing: any
    }> = []

    for (const indicationParams of indicationCombinations) {
      for (const positionRange of positionRangeCombinations) {
        for (const trailing of trailingCombinations) {
          allCombinations.push({
            indication: indicationParams,
            position: positionRange,
            trailing: trailing,
          })
        }
      }
    }

    console.log(`[v0] Processing ${allCombinations.length} combinations for ${symbol} asynchronously`)

    // Process combinations in parallel batches
    await this.processCombinationsInParallel(configSet, symbol, historicalData, allCombinations)
  }

  /**
   * Process indication combinations in parallel batches for faster execution
   */
  private async processCombinationsInParallel(
    configSet: PresetConfigurationSet,
    symbol: string,
    historicalData: any[],
    combinations: Array<{ indication: any; position: any; trailing: any }>,
  ): Promise<void> {
    await mapWithConcurrency(
      combinations,
      this.MAX_CONCURRENT_INDICATIONS,
      async (combo) => {
          try {
            await this.calculateCombinationResult(
              configSet,
              symbol,
              historicalData,
              combo.indication,
              combo.position,
              combo.trailing,
            )
          } catch (error) {
            console.error(`[v0] Failed to calculate combination for ${symbol}:`, error)
          }
      },
    )
  }

  /**
   * Calculate result for a specific combination
   * Now fully async and can run in parallel with other combinations
   */
  private async calculateCombinationResult(
    configSet: PresetConfigurationSet,
    symbol: string,
    historicalData: any[],
    indicationParams: any,
    positionRange: any,
    trailing: any,
  ): Promise<void> {
    // Calculate indicators asynchronously for parallel processing
    const result = await this.calculateIndicatorsAsync(historicalData, configSet, indicationParams)

    // Simulate trades asynchronously for parallel processing
    const positionCostPercent = await this.getPositionCostPercent(symbol)
    const trades = await this.simulateTradesAsync(
      historicalData,
      result.signals,
      positionRange.takeprofit,
      positionRange.stoploss,
      trailing.enabled,
      trailing.start,
      trailing.stop,
      positionCostPercent,
    )

    // Calculate performance metrics
    const metrics = this.calculatePerformanceMetrics(trades, configSet)

    // Store result
    const paramsHash = this.hashIndicationParams(indicationParams)

    await sql`
      INSERT INTO preset_coordination_results (
        id, preset_type_id, configuration_set_id, symbol,
        indication_type, indication_params,
        takeprofit_factor, stoploss_ratio,
        trailing_enabled, trail_start, trail_stop,
        profit_factor, win_rate, total_trades, winning_trades, losing_trades,
        avg_profit, avg_loss, max_drawdown, drawdown_time_hours,
        profit_factor_last_25, profit_factor_last_50, positions_per_24h,
        is_valid, validation_reason, last_validated_at,
        created_at, updated_at
      ) VALUES (
        ${this.generateId()}, ${this.presetTypeId}, ${configSet.id}, ${symbol},
        ${configSet.indication_type}, ${JSON.stringify(indicationParams)},
        ${positionRange.takeprofit}, ${positionRange.stoploss},
        ${trailing.enabled}, ${trailing.start}, ${trailing.stop},
        ${metrics.profitFactor}, ${metrics.winRate}, ${metrics.totalTrades},
        ${metrics.winningTrades}, ${metrics.losingTrades},
        ${metrics.avgProfit}, ${metrics.avgLoss}, ${metrics.maxDrawdown},
        ${metrics.drawdownTimeHours}, ${metrics.profitFactorLast25},
        ${metrics.profitFactorLast50}, ${metrics.positionsPer24h},
        ${metrics.isValid}, ${metrics.validationReason}, datetime('now'),
        datetime('now'), datetime('now')
      )
      ON CONFLICT (preset_type_id, configuration_set_id, symbol, indication_type, takeprofit_factor, stoploss_ratio, trailing_enabled, trail_start, trail_stop)
      DO UPDATE SET
        profit_factor = ${metrics.profitFactor},
        win_rate = ${metrics.winRate},
        total_trades = ${metrics.totalTrades},
        winning_trades = ${metrics.winningTrades},
        losing_trades = ${metrics.losingTrades},
        avg_profit = ${metrics.avgProfit},
        avg_loss = ${metrics.avgLoss},
        max_drawdown = ${metrics.maxDrawdown},
        drawdown_time_hours = ${metrics.drawdownTimeHours},
        profit_factor_last_25 = ${metrics.profitFactorLast25},
        profit_factor_last_50 = ${metrics.profitFactorLast50},
        positions_per_24h = ${metrics.positionsPer24h},
        is_valid = ${metrics.isValid},
        validation_reason = ${metrics.validationReason},
        last_validated_at = datetime('now'),
        updated_at = datetime('now')
    `

    // Initialize position limit tracking for this configuration
    await this.initializePositionLimit(configSet, symbol, indicationParams, positionRange, trailing, paramsHash)
  }

  /**
   * Calculate indicators asynchronously for parallel processing
   */
  private async calculateIndicatorsAsync(
    historicalData: any[],
    configSet: PresetConfigurationSet,
    indicationParams: any,
  ): Promise<{ signals: any[] }> {
    return new Promise((resolve) => {
      // Yield between configuration sets so a large legacy Preset matrix does
      // not monopolize the event loop. Each signal is calculated only from
      // candles available before its entry; a single final-candle signal would
      // not produce a meaningful historical trade series.
      setImmediate(() => {
        const rows = historicalData
          .map((d) => ({
            price: Number(d.close),
            timestamp: toEpochMilliseconds(d.timestamp ?? d.time),
          }))
          .filter((row) => row.price > 0)
        const prices = rows.map((row) => row.price)
        const indicatorConfig: IndicatorConfig = {
          type: configSet.indication_type as IndicatorConfig["type"],
          params: indicationParams,
        }
        const configuredPeriods = Object.values(indicationParams || {})
          .map(Number)
          .filter((value) => Number.isFinite(value) && value > 0)
        const lookback = Math.min(300, Math.max(32, Math.floor(Math.max(...configuredPeriods, 14) * 2)))
        const signals: any[] = []
        for (let index = Math.max(lookback, 1); index < prices.length - 1; index += 1) {
          const window = prices.slice(Math.max(0, index - lookback + 1), index + 1)
          const [signal] = calculateIndicators(window, [indicatorConfig])
          if (signal && signal.direction !== "neutral" && Number(signal.strength) > 0) {
            signals.push({
              ...signal,
              index,
              timestamp: rows[index]?.timestamp || signal.timestamp,
            })
          }
        }
        resolve({ signals })
      })
    })
  }

  /**
   * Simulate trades asynchronously for parallel processing
   */
  private async simulateTradesAsync(
    historicalData: any[],
    signals: any[],
    tpFactor: number,
    slRatio: number,
    trailingEnabled: boolean,
    trailStart: number | null,
    trailStop: number | null,
    positionCostPercent: number,
  ): Promise<any[]> {
    return new Promise((resolve) => {
      // Wrap synchronous simulation in Promise for async execution
      setImmediate(() => {
        const trades = this.simulateTrades(
          historicalData,
          signals,
          tpFactor,
          slRatio,
          trailingEnabled,
          trailStart,
          trailStop,
          positionCostPercent,
        )
        resolve(trades)
      })
    })
  }

  /**
   * Start coordination loop for real trading
   */
  private async startCoordinationLoop(): Promise<void> {
    if (!this.presetType) return

    const intervalMs = this.presetType.evaluation_interval_hours * 60 * 60 * 1000

    this.coordinationInterval = setInterval(async () => {
      try {
        await this.processCoordinationCycle()
      } catch (error) {
        console.error("[v0] Coordination cycle error:", error)
      }
    }, intervalMs)

    // Run first cycle immediately
    await this.processCoordinationCycle()
  }

  /**
   * Process coordination cycle - check valid configurations and open positions
   * Now processes results asynchronously in parallel
   */
  private async processCoordinationCycle(): Promise<void> {
    console.log("[v0] Processing coordination cycle...")

    // Get all valid coordination results
    const validResults = await sql`
      SELECT * FROM preset_coordination_results
      WHERE preset_type_id = ${this.presetTypeId}
        AND is_valid = 1
      ORDER BY profit_factor_last_25 DESC, profit_factor_last_50 DESC
    `

    await mapWithConcurrency(
      validResults,
      this.MAX_CONCURRENT_INDICATIONS,
      async (result) => {
          try {
            await this.evaluateAndOpenPosition(result as PresetCoordinationResult)
          } catch (error) {
            console.error(`[v0] Failed to evaluate result ${(result as PresetCoordinationResult).id}:`, error)
          }
      },
    )

    console.log("[v0] Coordination cycle complete")
  }

  /**
   * Evaluate coordination result and open position if conditions met
   * Now uses separate pseudo position manager
   */
  private async evaluateAndOpenPosition(result: PresetCoordinationResult): Promise<void> {
    if (!this.presetType) return

    // Check if last 25 or 50 positions are profitable
    const isLast25Profitable = result.profit_factor_last_25 > 0
    const isLast50Profitable = result.profit_factor_last_50 > 0

    if (!isLast25Profitable && !isLast50Profitable) {
      return // Skip if not profitable in recent positions
    }

    // Get current market signal
    const currentSignal = await this.getCurrentMarketSignal(result)

    if (!currentSignal || currentSignal.direction === "neutral") {
      return
    }

    // Check position limits
    const canOpen = await this.checkPositionLimit(result, currentSignal.direction)

    if (!canOpen) {
      return
    }

    // Check timeout
    const lastPositionKey = `${result.symbol}-${result.indication_type}-${currentSignal.direction}`
    const lastPositionTime = this.lastPositionTime.get(lastPositionKey) || 0
    const timeSinceLastPosition = Date.now() - lastPositionTime

    if (timeSinceLastPosition < this.presetType!.timeout_after_position * 1000) {
      return
    }

    // Get current price
    const currentPrice = await this.getCurrentPrice(result.symbol)

    const positionId = await this.pseudoPositionManager.createPseudoPosition(result, currentSignal, currentPrice)

    if (positionId) {
      // Update position limit and cooldown
      await this.updatePositionLimit(result, currentSignal.direction, 1)
      this.lastPositionTime.set(lastPositionKey, Date.now())

      console.log(`[v0] Created pseudo position ${positionId} for ${result.symbol} (${currentSignal.direction})`)
    }
  }

  /**
   * Check if position can be opened for this configuration + direction
   */
  private async checkPositionLimit(result: PresetCoordinationResult, direction: string): Promise<boolean> {
    const paramsHash = this.hashIndicationParams(result.indication_params)

    const [limit] = await sql`
      SELECT * FROM preset_position_limits
      WHERE preset_type_id = ${this.presetTypeId}
        AND configuration_set_id = ${result.configuration_set_id}
        AND symbol = ${result.symbol}
        AND indication_params_hash = ${paramsHash}
        AND takeprofit_factor = ${result.takeprofit_factor}
        AND stoploss_ratio = ${result.stoploss_ratio}
        AND direction = ${direction}
        AND trailing_enabled = ${result.trailing_enabled}
        AND trail_start = ${result.trail_start}
        AND trail_stop = ${result.trail_stop}
    `

    if (!limit) return false

    // Position-count fields are retained for schema compatibility only.
    // Preset types process every exact configuration lane without a numerical
    // type/range/direction ceiling; 0 is the durable "Unlimited" value.

    // Check cooldown
    if (limit.cooldown_until && new Date(limit.cooldown_until) > new Date()) {
      return false
    }

    return true
  }

  /**
   * Update position limit after opening position
   */
  private async updatePositionLimit(
    result: PresetCoordinationResult,
    direction: string,
    change: number,
  ): Promise<void> {
    const paramsHash = this.hashIndicationParams(result.indication_params)

    await sql`
      UPDATE preset_position_limits
      SET current_positions = current_positions + ${change},
          last_position_opened_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE preset_type_id = ${this.presetTypeId}
        AND configuration_set_id = ${result.configuration_set_id}
        AND symbol = ${result.symbol}
        AND indication_params_hash = ${paramsHash}
        AND takeprofit_factor = ${result.takeprofit_factor}
        AND stoploss_ratio = ${result.stoploss_ratio}
        AND direction = ${direction}
        AND trailing_enabled = ${result.trailing_enabled}
        AND trail_start = ${result.trail_start}
        AND trail_stop = ${result.trail_stop}
    `
  }

  /**
   * Initialize position limit tracking for a specific configuration combination
   * Creates separate limits for long and short directions
   */
  private async initializePositionLimit(
    configSet: PresetConfigurationSet,
    symbol: string,
    indicationParams: any,
    positionRange: any,
    trailing: any,
    paramsHash: string,
  ): Promise<void> {
    if (!this.presetType) return

    const maxPositions = 0

    // Initialize for both long and short directions
    for (const direction of ["long", "short"]) {
      await sql`
        INSERT INTO preset_position_limits (
          id, preset_type_id, configuration_set_id, symbol,
          indication_params_hash, takeprofit_factor, stoploss_ratio,
          direction, trailing_enabled, trail_start, trail_stop,
          max_positions, current_positions,
          created_at, updated_at
        ) VALUES (
          ${this.generateId()}, ${this.presetTypeId}, ${configSet.id}, ${symbol},
          ${paramsHash}, ${positionRange.takeprofit}, ${positionRange.stoploss},
          ${direction}, ${trailing.enabled}, ${trailing.start}, ${trailing.stop},
          ${maxPositions}, 0,
          datetime('now'), datetime('now')
        )
        ON CONFLICT (
          preset_type_id, configuration_set_id, symbol, indication_params_hash,
          takeprofit_factor, stoploss_ratio, direction, trailing_enabled, trail_start, trail_stop
        ) DO UPDATE SET
          max_positions = ${maxPositions},
          updated_at = datetime('now')
      `
    }
  }

  /**
   * Open real position on exchange
   */
  private async openRealPosition(result: PresetCoordinationResult, signal: any): Promise<void> {
    // Get current price
    const currentPrice = await this.getCurrentPrice(result.symbol)

    try {
      // Read the same persisted connection used by the active engine. This
      // legacy coordinator is retained for backwards compatibility, but it
      // must never use the old synthetic ExchangeAPI (which returned fake
      // order IDs instead of submitting or tracking a venue order).
      const [connection] = await sql<any>`
        SELECT * FROM connections WHERE id = ${this.connectionId}
      `

      const presetEnabled = connection?.is_preset_trade === true ||
        connection?.is_preset_trade === 1 ||
        connection?.is_preset_trade === "1" ||
        connection?.preset_trade_requested === true ||
        connection?.preset_trade_requested === 1 ||
        connection?.preset_trade_requested === "1"
      if (!presetEnabled) return

      // Preset live orders must use the same PositionCost/lot contract as the
      // main live stage. The former fixed quantity of 100 was a raw base-unit
      // guess and could create an oversized order (especially on BTC or when
      // a Forex result was expressed in lots).
      const volumeResult = await VolumeCalculator.calculateVolumeForConnection(
        this.connectionId,
        result.symbol,
        currentPrice,
        {
          tradeMode: "preset",
          indicationType: result.indication_type,
          positionCostPercentOverride: await this.getPositionCostPercent(result.symbol),
          marketType: connection.market_type || connection.asset_class,
          lotSize: Number(connection.lot_size) > 0 ? Number(connection.lot_size) : undefined,
          quoteToUsdRate: Number(connection.quote_to_usd_rate) > 0
            ? Number(connection.quote_to_usd_rate)
            : undefined,
        },
      )
      const positionSize = Number(volumeResult.finalVolume || volumeResult.volume || 0)
      if (!(positionSize > 0) || volumeResult.conversionAvailable === false) {
        throw new Error(
          volumeResult.adjustmentReason
          || ("Preset live sizing produced no executable quantity for " + result.symbol),
        )
      }

      const { placeLiveOrder } = await import("@/lib/live-order-service")
      const orderResult = await placeLiveOrder({
        connectionId: this.connectionId,
        connection: {
          ...connection,
          id: connection.id || this.connectionId,
          api_key: connection.api_key || connection.apiKey || "",
          api_secret: connection.api_secret || connection.apiSecret || "",
        },
        symbol: result.symbol,
        side: signal.direction,
        positionDirection: signal.direction,
        quantity: positionSize,
        price: currentPrice,
        leverage: 1,
        orderType: "market",
        source: "preset-coordination",
        safetyPayload: {
          confirmLiveOrderPlacement: true,
          presetTrade: true,
        },
        // The preset SQL ledger owns this legacy row; the shared order service
        // still owns connector safety and authoritative fill parsing.
        persistPosition: false,
        updateCounters: false,
        marketType: connection.market_type || connection.asset_class,
        lotSize: Number(connection.lot_size) > 0 ? Number(connection.lot_size) : undefined,
        quoteToUsdRate: Number(connection.quote_to_usd_rate) > 0
          ? Number(connection.quote_to_usd_rate)
          : undefined,
        // A preset entry is not complete until both controls are accepted.
        // The shared service derives the exact prices again from the
        // authoritative fill before arming non-native conditional orders.
        requireProtection: true,
        protectionStopLossPercent: Number(result.stoploss_ratio),
        protectionTakeProfitPercent: Number(result.takeprofit_factor),
      })

      if (!orderResult?.success || orderResult.mode !== "live") {
        throw new Error(orderResult?.error || `Preset live order was not executed in live mode (${orderResult?.mode || "unknown"})`)
      }

      const fillPrice = Number(orderResult.fill?.filledPrice) || 0
      const filledQuantity = Number(orderResult.fill?.filledQty) || 0
      if (!(fillPrice > 0) || !(filledQuantity > 0)) {
        throw new Error("Preset live order returned no authoritative execution fill")
      }
      const tradeId = this.generateId()
      await sql`
        INSERT INTO preset_real_trades (
          id, connection_id, preset_type_id, configuration_set_id,
          coordination_result_id, symbol, direction,
          entry_price, quantity, leverage,
          indication_type, takeprofit_factor, stoploss_ratio,
          trailing_enabled, trail_start, trail_stop,
          status, opened_at, created_at
        ) VALUES (
          ${tradeId}, ${this.connectionId}, ${this.presetTypeId},
          ${result.configuration_set_id}, ${result.id},
          ${result.symbol}, ${signal.direction},
          ${fillPrice}, ${filledQuantity}, 1,
          ${result.indication_type}, ${result.takeprofit_factor}, ${result.stoploss_ratio},
          ${result.trailing_enabled}, ${result.trail_start}, ${result.trail_stop},
          'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `

      console.log(`[v0] Preset exchange order placed: ${orderResult.orderId}`)

      // Calculate TP and SL prices from the authoritative fill, not the
      // pre-submit ticker. This keeps protection and reporting aligned after
      // slippage or a delayed market fill.
      const isLong = signal.direction === "long"
      const tpPrice = isLong
        ? fillPrice * (1 + result.takeprofit_factor / 100)
        : fillPrice * (1 - result.takeprofit_factor / 100)
      const slPrice = isLong
        ? fillPrice * (1 - result.stoploss_ratio / 100)
        : fillPrice * (1 + result.stoploss_ratio / 100)

      // Mirror to exchange position manager for tracking
      const { ExchangePositionManager } = await import("@/lib/exchange-position-manager")
      const positionManager = new ExchangePositionManager(this.connectionId)

      await positionManager.mirrorToExchange({
        connectionId: this.connectionId,
        realPseudoPositionId: result.id,
        exchangeId: orderResult.orderId,
        symbol: result.symbol,
        side: signal.direction,
        entryPrice: fillPrice,
        quantity: filledQuantity,
        volumeUsd: resolvePositionNotionalUsd({
          symbol: result.symbol,
          marketType: connection.market_type || connection.asset_class,
          volumeKind: connection.quantity_unit,
          lotSize: Number(connection.lot_size) > 0 ? Number(connection.lot_size) : undefined,
          quoteToUsdRate: Number(connection.quote_to_usd_rate) > 0
            ? Number(connection.quote_to_usd_rate)
            : undefined,
          status: "filled",
          executedQuantity: filledQuantity,
          entryPrice: fillPrice,
        }),
        leverage: 1,
        positionTicket: Number(orderResult.protection?.positionTicket) > 0
          ? Number(orderResult.protection.positionTicket)
          : undefined,
        takeprofit: tpPrice,
        stoploss: slPrice,
        trailingEnabled: result.trailing_enabled,
        trailStart: result.trail_start ?? undefined,
        trailStop: result.trail_stop ?? undefined,
        tradeMode: "preset",
        indicationType: result.indication_type,
      })
    } catch (error) {
      console.error("[v0] Failed to open position on exchange:", error)
      // Do not write a real-trade ledger row when the venue order did not
      // succeed. The pseudo position remains the paper/strategy record and
      // can be reconciled independently.
    }
  }

  // ============ HELPER METHODS ============

  private async getSymbolsForConfigSet(configSet: PresetConfigurationSet): Promise<string[]> {
    const context = await this.getMarketContext()
    const normalizeSymbols = (symbols: unknown): string[] => {
      if (!Array.isArray(symbols)) return []
      return Array.from(new Set(symbols.map((symbol) => {
        const value = context.marketType === "forex"
          ? normalizeForexSymbol(symbol)
          : normalizeMarketSymbol(symbol, "crypto")
        return value
      }).filter((symbol) => context.marketType === "forex" ? isForexSymbol(symbol) : Boolean(symbol))))
    }
    switch (configSet.symbol_mode) {
      case "main":
        return context.marketType === "forex"
          ? getDefaultSymbolsForMarket("forex")
          : ["BTCUSDT", "ETHUSDT", "BNBUSDT"]
      case "forced":
        return normalizeSymbols(configSet.symbols)
      case "manual":
        return normalizeSymbols(configSet.symbols)
      case "exchange":
        return await this.getTopSymbolsByExchange(configSet)
      default:
        return []
    }
  }

  private async getTopSymbolsByExchange(configSet: PresetConfigurationSet): Promise<string[]> {
    const context = await this.getMarketContext()
    const requested = Math.max(1, Math.min(50, Math.floor(Number(configSet.exchange_limit) || 1)))
    const order = configSet.exchange_order_by
    const sort = order === "volatility" || order === "price_change" ? "volatility" : "volume"
    try {
      const { fetchTopSymbols } = await import("@/lib/top-symbols")
      const ranked = await fetchTopSymbols(context.exchange, requested, sort)
      const symbols = ranked.symbols
        .map((ticker) => context.marketType === "forex"
          ? normalizeForexSymbol(ticker.symbol)
          : normalizeMarketSymbol(ticker.symbol, "crypto"))
        .filter((symbol) => context.marketType === "forex" ? isForexSymbol(symbol) : Boolean(symbol))
      if (symbols.length > 0) return Array.from(new Set(symbols))
    } catch (error) {
      console.warn(`[v0] Preset top-symbol selection failed for ${context.exchange}:`, error instanceof Error ? error.message : String(error))
    }
    return context.marketType === "forex"
      ? getDefaultSymbolsForMarket("forex").slice(0, requested)
      : ["BTCUSDT", "ETHUSDT", "SOLUSDT"].slice(0, requested)
  }

  private generateIndicationCombinations(configSet: PresetConfigurationSet): any[] {
    // Generate parameter combinations with 50% range and dynamic steps
    const combinations: any[] = []
    const baseParams = configSet.indication_params

    // For each parameter, generate range (50% difference)
    for (const [key, value] of Object.entries(baseParams)) {
      if (typeof value === "number") {
        const min = Math.floor(value * 0.5) // 50% below
        const max = Math.ceil(value * 1.5) // 50% above
        const step = Math.floor((max - min) / 10) || 1 // Dynamic step based on range

        for (let v = min; v <= max; v += step) {
          combinations.push({ ...baseParams, [key]: v })
        }
      }
    }

    return combinations.length > 0 ? combinations : [baseParams]
  }

  private generatePositionRangeCombinations(configSet: PresetConfigurationSet): any[] {
    const combinations: any[] = []

    for (let tp = configSet.takeprofit_min; tp <= configSet.takeprofit_max; tp += configSet.takeprofit_step) {
      for (let sl = configSet.stoploss_min; sl <= configSet.stoploss_max; sl += configSet.stoploss_step) {
        combinations.push({ takeprofit: tp, stoploss: sl })
      }
    }

    return combinations
  }

  private generateTrailingCombinations(configSet: PresetConfigurationSet): any[] {
    const combinations: any[] = []

    // Without trailing
    combinations.push({ enabled: false, start: null, stop: null })

    // With trailing (if enabled)
    if (configSet.trailing_enabled) {
      for (const start of configSet.trail_starts) {
        for (const stop of configSet.trail_stops) {
          combinations.push({ enabled: true, start, stop })
        }
      }
    }

    return combinations
  }

  private simulateTrades(
    historicalData: any[],
    signals: any[],
    tpFactor: number,
    slRatio: number,
    trailingEnabled: boolean,
    trailStart: number | null,
    trailStop: number | null,
    positionCostPercent: number,
  ): any[] {
    const rows = historicalData.map((row: any) => {
      const close = Number(row.close || 0)
      const open = Number(row.open || close || 0)
      const high = Number(row.high || close || 0)
      const low = Number(row.low || close || 0)
      return {
        timestamp: toEpochMilliseconds(row.timestamp ?? row.time),
        open,
        high,
        low,
        close,
      }
    }).filter((row) => row.timestamp > 0 && row.open > 0 && row.high >= Math.max(row.open, row.close) && row.low > 0 && row.low <= Math.min(row.open, row.close) && row.close > 0)
    if (rows.length < 2) return []
    const tp = Number(tpFactor)
    const sl = Number(slRatio)
    if (!(tp > 0) || !(sl > 0)) return []
    const cost = Number.isFinite(Number(positionCostPercent)) && Number(positionCostPercent) >= 0
      ? Number(positionCostPercent)
      : 0.1
    const orderedSignals = [...signals]
      .filter((signal) => signal?.direction === "long" || signal?.direction === "short")
      .sort((left, right) => {
        const leftIndex = Number(left.index)
        const rightIndex = Number(right.index)
        const leftTime = toEpochMilliseconds(left.timestamp)
        const rightTime = toEpochMilliseconds(right.timestamp)
        return (Number.isFinite(leftIndex) ? leftIndex : Number.MAX_SAFE_INTEGER) -
          (Number.isFinite(rightIndex) ? rightIndex : Number.MAX_SAFE_INTEGER) ||
          leftTime - rightTime
      })
    const trades: any[] = []
    let nextEntryIndex = 1
    for (const signal of orderedSignals) {
      const rawSignalIndex = Number(signal.index)
      const signalTimestamp = toEpochMilliseconds(signal.timestamp)
      const timestampIndex = signalTimestamp > 0
        ? rows.findIndex((row) => row.timestamp >= signalTimestamp)
        : -1
      const candidateIndex = timestampIndex >= 0 ? timestampIndex : rawSignalIndex
      const signalIndex = Number.isFinite(candidateIndex)
        ? Math.max(0, Math.min(rows.length - 2, Math.floor(candidateIndex)))
        : 0
      const entryIndex = Math.max(nextEntryIndex, signalIndex + 1)
      if (entryIndex >= rows.length) break
      const isLong = signal.direction === "long"
      const entryPrice = rows[entryIndex].open
      if (!(entryPrice > 0)) continue
      const takeProfitPrice = isLong
        ? entryPrice * (1 + tp / 100)
        : entryPrice * (1 - tp / 100)
      const stopLossPrice = isLong
        ? entryPrice * (1 - sl / 100)
        : entryPrice * (1 + sl / 100)
      let bestPrice = entryPrice
      let trailingActive = false
      let exitPrice = rows[rows.length - 1].close
      let exitIndex = rows.length - 1
      let exitReason = "end_of_history"

      for (let index = entryIndex; index < rows.length; index += 1) {
        const row = rows[index]
        // If one OHLC candle touches both controls, use the stop first. The
        // candle has no intra-bar ordering, so this conservative convention
        // avoids manufacturing an optimistic result.
        if (isLong && row.low <= stopLossPrice) {
          exitPrice = stopLossPrice
          exitIndex = index
          exitReason = "stoploss"
          break
        }
        if (!isLong && row.high >= stopLossPrice) {
          exitPrice = stopLossPrice
          exitIndex = index
          exitReason = "stoploss"
          break
        }
        if (isLong && row.high >= takeProfitPrice) {
          exitPrice = takeProfitPrice
          exitIndex = index
          exitReason = "takeprofit"
          break
        }
        if (!isLong && row.low <= takeProfitPrice) {
          exitPrice = takeProfitPrice
          exitIndex = index
          exitReason = "takeprofit"
          break
        }
        if (trailingEnabled && Number(trailStart) > 0 && Number(trailStop) > 0) {
          const favorablePct = isLong
            ? ((row.high - entryPrice) / entryPrice) * 100
            : ((entryPrice - row.low) / entryPrice) * 100
          if (favorablePct >= Number(trailStart)) trailingActive = true
          if (isLong) bestPrice = Math.max(bestPrice, row.high)
          else bestPrice = Math.min(bestPrice, row.low)
          if (trailingActive) {
            const trailingStop = isLong
              ? bestPrice * (1 - Number(trailStop) / 100)
              : bestPrice * (1 + Number(trailStop) / 100)
            if ((isLong && row.low <= trailingStop) || (!isLong && row.high >= trailingStop)) {
              exitPrice = trailingStop
              exitIndex = index
              exitReason = "trailing_stop"
              break
            }
          }
        }
      }
      const grossProfitPercent = isLong
        ? ((exitPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - exitPrice) / entryPrice) * 100
      trades.push({
        entryPrice,
        exitPrice,
        profit: grossProfitPercent - cost,
        grossProfitPercent,
        positionCostPercent: cost,
        direction: signal.direction,
        reason: exitReason,
        timestamp: rows[exitIndex].timestamp,
        entryTimestamp: rows[entryIndex].timestamp,
      })
      nextEntryIndex = exitIndex + 1
    }
    return trades
  }

  private calculatePerformanceMetrics(trades: any[], configSet: PresetConfigurationSet): any {
    // Calculate performance metrics from simulated trades
    const totalTrades = trades.length
    const winningTrades = trades.filter((t: any) => t.profit > 0).length
    const losingTrades = totalTrades - winningTrades
    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0

    const totalProfit = trades.reduce((sum: number, t: any) => sum + Math.max(0, t.profit), 0)
    const totalLoss = Math.abs(trades.reduce((sum: number, t: any) => sum + Math.min(0, t.profit), 0))
    const profitFactor = totalLoss > 0
      ? totalProfit / totalLoss
      : totalProfit > 0
        ? Number.POSITIVE_INFINITY
        : 0

    const avgProfit = winningTrades > 0 ? totalProfit / winningTrades : 0
    const avgLoss = losingTrades > 0 ? totalLoss / losingTrades : 0

    // Calculate last 25 and 50 positions profit factor
    const last25 = trades.slice(-25)
    const last50 = trades.slice(-50)

    const profitFactorLast25 = this.calculateProfitFactorForTrades(last25)
    const profitFactorLast50 = this.calculateProfitFactorForTrades(last50)

    // Calculate positions per 24h
    const tradeTimes = trades.map((trade: any) => toEpochMilliseconds(trade.timestamp)).filter((timestamp) => timestamp > 0)
    const timeSpan = tradeTimes.length > 1
      ? Math.max(1 / 60, (Math.max(...tradeTimes) - Math.min(...tradeTimes)) / (1000 * 60 * 60))
      : 1
    const positionsPer24h = (totalTrades / timeSpan) * 24

    const drawdownMetrics = this.calculateDrawdownMetrics(trades)
    const configuredDrawdownLimit = Number(configSet.drawdown_time_max)
    const drawdownWithinLimit = !Number.isFinite(configuredDrawdownLimit) || configuredDrawdownLimit <= 0 ||
      drawdownMetrics.maxDrawdownDuration <= configuredDrawdownLimit

    // Validation
    const isValid =
      profitFactor >= configSet.profit_factor_min &&
      totalTrades >= configSet.trades_per_48h_min &&
      (profitFactorLast25 > 0 || profitFactorLast50 > 0) &&
      drawdownWithinLimit

    const validationReason = !isValid
      ? `Profit factor: ${profitFactor.toFixed(2)}, Trades: ${totalTrades}, Last 25 PF: ${profitFactorLast25.toFixed(2)}`
      : "Valid"

    return {
      profitFactor,
      winRate,
      totalTrades,
      winningTrades,
      losingTrades,
      avgProfit,
      avgLoss,
      maxDrawdown: drawdownMetrics.maxDrawdown,
      drawdownTimeHours: drawdownMetrics.maxDrawdownDuration,
      profitFactorLast25,
      profitFactorLast50,
      positionsPer24h,
      isValid,
      validationReason,
    }
  }

  private calculateDrawdownMetrics(trades: any[]): { maxDrawdown: number; maxDrawdownDuration: number } {
    if (trades.length === 0) {
      return { maxDrawdown: 0, maxDrawdownDuration: 0 }
    }

    const sortedTrades = [...trades]
      .map((trade) => ({
        ...trade,
        timestampMs: toEpochMilliseconds(trade.timestamp),
        profitValue: Number(trade.profit),
      }))
      .filter((trade) => trade.timestampMs > 0 && Number.isFinite(trade.profitValue))
      .sort((a, b) => a.timestampMs - b.timestampMs)

    if (sortedTrades.length === 0) return { maxDrawdown: 0, maxDrawdownDuration: 0 }

    // Simulated profits are percentages, so start with a 100-point equity
    // baseline. This keeps max drawdown meaningful even when the first trades
    // are losers instead of silently reporting zero.
    let cumulativeEquity = 100
    let peak = 100
    let maxDrawdown = 0
    let currentDrawdownStartMs: number | null = null
    let maxDrawdownDuration = 0

    for (const trade of sortedTrades) {
      cumulativeEquity += trade.profitValue

      if (cumulativeEquity >= peak) {
        peak = cumulativeEquity
        currentDrawdownStartMs = null
      } else {
        if (currentDrawdownStartMs === null) currentDrawdownStartMs = trade.timestampMs
        const currentDrawdown = Math.max(0, ((peak - cumulativeEquity) / Math.max(peak, 1)) * 100)
        if (currentDrawdown > maxDrawdown) {
          maxDrawdown = currentDrawdown
        }
        const drawdownStartMs = currentDrawdownStartMs ?? trade.timestampMs
        const duration = (trade.timestampMs - drawdownStartMs) / (1000 * 60 * 60)
        if (duration > maxDrawdownDuration) maxDrawdownDuration = duration
      }
    }

    if (currentDrawdownStartMs !== null) {
      const lastTradeTime = sortedTrades[sortedTrades.length - 1].timestampMs
      const duration = (lastTradeTime - currentDrawdownStartMs) / (1000 * 60 * 60)
      if (duration > maxDrawdownDuration) {
        maxDrawdownDuration = duration
      }
    }

    return { maxDrawdown, maxDrawdownDuration }
  }

  private calculateProfitFactorForTrades(trades: any[]): number {
    if (trades.length === 0) return 0

    const totalProfit = trades.reduce((sum: number, t: any) => sum + Math.max(0, t.profit), 0)
    const totalLoss = Math.abs(trades.reduce((sum: number, t: any) => sum + Math.min(0, t.profit), 0))

    return totalLoss > 0
      ? totalProfit / totalLoss
      : totalProfit > 0
        ? Number.POSITIVE_INFINITY
        : 0
  }

  private hashIndicationParams(params: any): string {
    return crypto.createHash("sha256").update(JSON.stringify(params)).digest("hex")
  }

  private async getHistoricalData(symbol: string, days: number): Promise<any[]> {
    const result = await sql`
      SELECT * FROM preset_historical_data
      WHERE connection_id = ${this.connectionId}
        AND symbol = ${symbol}
        AND timestamp > NOW() - INTERVAL '${days} days'
      ORDER BY timestamp ASC
    `
    return result
  }

  private async getCurrentMarketSignal(result: PresetCoordinationResult): Promise<any> {
    const cached = this.currentMarketCache.get(result.symbol)
    const now = Date.now()
    let candles = cached && now - cached.fetchedAt < 15_000 ? cached.candles : []
    if (candles.length < 20) {
      try {
        const historical = await this.getHistoricalData(result.symbol, 2)
        candles = historical.slice(-300).map((row: any) => ({
          timestamp: Number(row.timestamp || 0),
          open: Number(row.open || row.close || 0),
          high: Number(row.high || row.close || 0),
          low: Number(row.low || row.close || 0),
          close: Number(row.close || 0),
          volume: Number(row.volume || 0),
        })).filter((row: any) => row.close > 0)
      } catch {
        candles = []
      }
    }
    if (candles.length < 20) {
      try {
        candles = await this.fetchHistoricalOHLCV(
          result.symbol,
          new Date(now - 6 * 60 * 60 * 1000),
          new Date(now),
        )
      } catch {
        candles = []
      }
    }
    if (candles.length < 20) return { direction: "neutral", strength: 0 }
    this.currentMarketCache.set(result.symbol, { fetchedAt: now, candles: candles.slice(-300) })
    const prices = candles.map((row: any) => Number(row.close)).filter((price: number) => price > 0)
    const [signal] = calculateIndicators(prices, [{
      type: result.indication_type as IndicatorConfig["type"],
      params: result.indication_params || {},
    }])
    return signal
      ? { direction: signal.direction, strength: Number(signal.strength) || 0 }
      : { direction: "neutral", strength: 0 }
  }

  private async getCurrentPrice(symbol: string): Promise<number> {
    const [result] = await sql<any>`
      SELECT price FROM market_data
      WHERE connection_id = ${this.connectionId}
        AND symbol = ${symbol}
      ORDER BY timestamp DESC
      LIMIT 1
    `
    const databasePrice = Number(result?.price || 0)
    if (databasePrice > 0) return databasePrice
    try {
      const connector = await exchangeConnectorFactory.getOrCreateConnector(this.connectionId)
      const ticker = connector ? await connector.getTicker(symbol) : null
      const bid = Number(ticker?.bid || 0)
      const ask = Number(ticker?.ask || 0)
      const last = Number(ticker?.last || 0)
      return last > 0 ? last : bid > 0 && ask > 0 ? (bid + ask) / 2 : Math.max(bid, ask)
    } catch {
      return 0
    }
  }

  private async fetchHistoricalOHLCV(symbol: string, startTime: Date, endTime: Date): Promise<any[]> {
    const context = await this.getMarketContext()
    const historyHours = Math.max(1 / 60, (endTime.getTime() - startTime.getTime()) / 3_600_000)
    const canonical = context.marketType === "forex"
      ? normalizeForexSymbol(symbol)
      : normalizeMarketSymbol(symbol, "crypto")
    if (context.marketType === "forex" && isForexSymbol(canonical)) {
      const { fetchInstaForexMinuteHistory } = await import("@/lib/direct-trade-market-history")
      return (await fetchInstaForexMinuteHistory(canonical, historyHours))
        .filter((row) => row.time >= startTime.getTime() && row.time <= endTime.getTime())
        .map((row) => ({
          timestamp: row.time,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
        }))
    }
    if (context.exchange === "bingx" || context.exchange === "bybit") {
      return (await fetchDirectTradeMinuteHistory(context.exchange, canonical, historyHours))
        .filter((row) => row.time >= startTime.getTime() && row.time <= endTime.getTime())
        .map((row) => ({
          timestamp: row.time,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
        }))
    }
    const connector = await exchangeConnectorFactory.getOrCreateConnector(this.connectionId)
    if (!connector) return []
    const limit = Math.max(100, Math.min(5_000, Math.ceil(historyHours * 60)))
    const candles = await connector.getOHLCV(canonical, "1m", limit)
    return (candles || [])
      .filter((row: any) => Number(row.timestamp) >= startTime.getTime() && Number(row.timestamp) <= endTime.getTime())
      .map((row: any) => ({
        timestamp: Number(row.timestamp),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume || 0),
      }))
  }

  private async getMarketContext(): Promise<{
    exchange: string
    marketType: MarketType
    positionCostPercent: number
    lotSize?: number
    quoteToUsdRate?: number
    spreadBufferPips?: number
    spreadMultiplier?: number
  }> {
    if (this.marketContext) return this.marketContext
    const [connection] = await sql<any>`SELECT * FROM connections WHERE id = ${this.connectionId}`
    const exchange = normalizeExchangeId(connection?.exchange || "bingx")
    const marketType = normalizeMarketType(connection?.market_type || connection?.asset_class, exchange)
    const configuredCost = Number(connection?.position_cost_percent)
    this.marketContext = {
      exchange,
      marketType,
      positionCostPercent: Number.isFinite(configuredCost) && configuredCost > 0 ? configuredCost : 0.1,
      lotSize: Number(connection?.lot_size) > 0 ? Number(connection.lot_size) : undefined,
      quoteToUsdRate: Number(connection?.quote_to_usd_rate) > 0 ? Number(connection.quote_to_usd_rate) : undefined,
      spreadBufferPips: Number.isFinite(Number(connection?.spread_buffer_pips)) && Number(connection?.spread_buffer_pips) >= 0
        ? Number(connection.spread_buffer_pips)
        : undefined,
      spreadMultiplier: Number.isFinite(Number(connection?.spread_multiplier)) && Number(connection?.spread_multiplier) >= 0
        ? Number(connection.spread_multiplier)
        : undefined,
    }
    return this.marketContext
  }

  /**
   * Resolve the actual cost coordinate for a symbol. Forex spreads are a
   * broker quote, not a static crypto fee assumption, so every optimization
   * symbol gets the latest cached broker tick widened by the configured
   * safety buffer. The short cache prevents a Cartesian preset matrix from
   * hammering the quote endpoint while still refreshing several times per
   * minute during a long run.
   */
  private async getPositionCostPercent(symbol: string): Promise<number> {
    const context = await this.getMarketContext()
    if (context.marketType !== "forex" || !isForexSymbol(symbol)) {
      return context.positionCostPercent
    }
    const canonical = normalizeForexSymbol(symbol)
    const cached = this.positionCostCache.get(canonical)
    if (cached && Date.now() - cached.fetchedAt < this.POSITION_COST_CACHE_TTL_MS) {
      return cached.value
    }

    let value = context.positionCostPercent
    try {
      const connector = await exchangeConnectorFactory.getOrCreateConnector(this.connectionId)
      const ticker = connector ? await connector.getTicker(canonical) : null
      value = effectivePositionCostPercent(
        context.positionCostPercent,
        ticker,
        canonical,
        {
          marketType: "forex",
          spreadBufferPips: context.spreadBufferPips,
          spreadMultiplier: context.spreadMultiplier,
        },
      )
    } catch {
      // A temporary quote outage must not discard a valid cached optimization;
      // retain the configured minimum until the next bounded refresh.
    }
    this.positionCostCache.set(canonical, { value, fetchedAt: Date.now() })
    return value
  }

  private async storeHistoricalData(symbol: string, data: any[]): Promise<void> {
    if (data.length === 0) return

    // Batch insert historical data using SQLite
    const batches = this.createBatches(data, 100)
    for (const batch of batches) {
      // Build INSERT statement with multiple VALUES
      const placeholders = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")

      const values: any[] = []
      for (const d of batch) {
        values.push(this.generateId(), this.connectionId, symbol, d.open, d.high, d.low, d.close, d.volume, d.timestamp)
      }

      const query = `
        INSERT INTO preset_historical_data (
          id, connection_id, symbol, open, high, low, close, volume, timestamp
        ) VALUES ${placeholders}
        ON CONFLICT (connection_id, symbol, timestamp) DO NOTHING
      `

      try {
        await execute(query, values)
      } catch (error) {
        console.error("[v0] Failed to insert historical data batch:", error)
      }
    }
  }

  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = []
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize))
    }
    return batches
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }
}

interface IndicatorSignal {
  type: string
  strength: number
  direction: "long" | "short" | "neutral"
  value: number
  timestamp: Date
}
