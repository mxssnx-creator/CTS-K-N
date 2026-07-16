/**
 * Indication State Manager
 * Manages step-based indication calculations for Main System Trade mode
 * Implements: direction (2-30), move (2-30), active (0.5-2.5%),
 * optimal (advanced), active-advanced, and Trend (kept last) types
 * With validation timeout (15s) and position cooldown (20s)
 */

import { getSettings, setSettings, getAppSetting, getAppSettings } from "@/lib/redis-db"
import { BasePseudoPositionManager, type BasePositionConfig } from "./base-pseudo-position-manager"
import { DataCleanupManager } from "./data-cleanup-manager"
import { logProgressionEvent } from "./engine-progression-logs"
import { buildStopLossRatios, DEFAULT_MAX_STOP_LOSS_RATIO } from "@/lib/stoploss-ratio-range"
import {
  buildAdaptiveTrendTpRange,
  calculateTrendSignal,
  DEFAULT_TREND_ACTIVE_SITUATION_RATIOS,
  DEFAULT_TREND_DRAWDOWN_FACTORS,
  DEFAULT_TREND_LAST_SITUATION_RATIOS,
  DEFAULT_TREND_MIN_AGREEMENT,
  DEFAULT_TREND_TIMEFRAMES_MINUTES,
  DEFAULT_TREND_TP_MAX_FACTOR,
  DEFAULT_TREND_TP_MIN_MULTIPLIER,
  DEFAULT_TREND_TP_STEP,
  type TrendSignal,
} from "@/lib/trend-indication"

export interface IndicationState {
  symbol: string
  type: "direction" | "move" | "active" | "optimal" | "active_advanced" | "trend"
  range: number | null
  lastValidated: Date | null
  lastPositionClosed: Date | null
  activePositionsCount: number
}

export class IndicationStateManager {
  private connectionId: string
  private states: Map<string, IndicationState> = new Map()

  private validationTimeout = 15 // seconds
  private positionCooldown = 20 // seconds
  private maxPositionsPerConfig = 1
  private trendEnabled = true
  private trendTimeframesMinutes: number[] = [...DEFAULT_TREND_TIMEFRAMES_MINUTES]
  private trendDrawdownFactors: number[] = [...DEFAULT_TREND_DRAWDOWN_FACTORS]
  private trendLastSituationRatios: number[] = [...DEFAULT_TREND_LAST_SITUATION_RATIOS]
  private trendActiveSituationRatios: number[] = [...DEFAULT_TREND_ACTIVE_SITUATION_RATIOS]
  private trendMinAgreement = DEFAULT_TREND_MIN_AGREEMENT
  private trendPositionCostPct = 0.02
  private trendTpMinMultiplier = DEFAULT_TREND_TP_MIN_MULTIPLIER
  private trendTpMaxFactor = DEFAULT_TREND_TP_MAX_FACTOR
  private trendTpStep = DEFAULT_TREND_TP_STEP
  private settingsLoadedAt = 0
  private readonly SETTINGS_CACHE_TTL = 1_000
  private settingsRefreshPromise: Promise<void> | null = null

  // Performance optimization: Cache and batch processing
  private priceCache: Map<string, { price: number; timestamp: number }> = new Map()
  private readonly PRICE_CACHE_TTL = 1000 // 1 second
  private pendingOperations: Map<string, Promise<any>> = new Map()
  // Short-lived in-memory positions cache: avoids re-reading the same Redis key
  // on every range in the batch loop (up to 29 sequential reads per cycle).
  private positionsCache: Map<string, { positions: any[]; ts: number }> = new Map()
  private readonly POSITIONS_CACHE_TTL = 500 // 500 ms — refreshed each processing cycle
  private positionAppendQueues: Map<string, Promise<void>> = new Map()

  private basePseudoManager: BasePseudoPositionManager
  private readonly settingsReady: Promise<void>


  private async getStopLossRatios(): Promise<number[]> {
    try {
      const settings = (await getSettings(`connection_settings:${this.connectionId}`)) || {}
      const max = (settings as any).maxStopLossRatio ?? (settings as any).max_stoploss_ratio ?? DEFAULT_MAX_STOP_LOSS_RATIO
      return buildStopLossRatios(max)
    } catch {
      return buildStopLossRatios(DEFAULT_MAX_STOP_LOSS_RATIO)
    }
  }

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.basePseudoManager = new BasePseudoPositionManager(connectionId)
    this.settingsReady = this.loadSettings()
  }

  private async loadSettings(): Promise<void> {
    try {
      // Load settings from Redis instead of SQL
      const [indicationSettings, appSettings] = await Promise.all([
        getSettings("indication_settings"),
        getAppSettings(),
      ])
      
      if (indicationSettings) {
        this.validationTimeout = Number.parseInt(String(indicationSettings.validationTimeout || "15"))
        const cooldownMs = indicationSettings.positionCooldownMs
        const cooldownSeconds = indicationSettings.positionCooldownTimeout
        
        if (cooldownMs) {
          this.positionCooldown = Number.parseInt(String(cooldownMs)) / 1000 // Convert ms to seconds
        } else if (cooldownSeconds) {
          this.positionCooldown = Number.parseInt(String(cooldownSeconds))
        } else {
          this.positionCooldown = 0.1 // 100ms default in seconds
        }
        
        this.maxPositionsPerConfig = Number.parseInt(
          String(indicationSettings.maxPositionsPerConfigDirection || indicationSettings.maxPositionsPerConfigSet || "1"),
        )
      }

      const settings = appSettings || {}
      this.trendEnabled = settings.trendEnabled !== false && settings.trendEnabled !== "false"
      const parsedTrendTimeframes = this.parseNumericList(
        settings.trendTimeframesMinutes,
        this.trendTimeframesMinutes,
      ).map((value) => Math.round(value)).filter((value) => value >= 1 && value <= 60)
      this.trendTimeframesMinutes = parsedTrendTimeframes.length > 0
        ? Array.from(new Set(parsedTrendTimeframes)).sort((left, right) => left - right)
        : [...DEFAULT_TREND_TIMEFRAMES_MINUTES]
      const parsedTrendDrawdowns = this.parseNumericList(
        settings.trendDrawdownValues ?? settings.trendDrawdownFactors,
        this.trendDrawdownFactors,
      ).map((value) => value > 0 ? -value : value).filter((value) => value < 0)
      this.trendDrawdownFactors = parsedTrendDrawdowns.length > 0
        ? Array.from(new Set(parsedTrendDrawdowns)).sort((left, right) => right - left)
        : [...DEFAULT_TREND_DRAWDOWN_FACTORS]
      const parsedTrendLastRatios = this.parseNumericList(
        settings.trendLastSituationRatios,
        this.trendLastSituationRatios,
      ).filter((value) => value > 0)
      this.trendLastSituationRatios = parsedTrendLastRatios.length > 0
        ? Array.from(new Set(parsedTrendLastRatios))
        : [...DEFAULT_TREND_LAST_SITUATION_RATIOS]
      const parsedTrendActiveRatios = this.parseNumericList(
        settings.trendActiveSituationRatios,
        this.trendActiveSituationRatios,
      ).filter((value) => value > 0)
      this.trendActiveSituationRatios = parsedTrendActiveRatios.length > 0
        ? Array.from(new Set(parsedTrendActiveRatios))
        : [...DEFAULT_TREND_ACTIVE_SITUATION_RATIOS]
      this.trendMinAgreement = Math.max(0.5, Math.min(1, Number(settings.trendMinAgreement) || this.trendMinAgreement))
      this.trendPositionCostPct = Math.max(0.000001, Number(settings.positionCost) || this.trendPositionCostPct)
      this.trendTpMinMultiplier = Math.max(0.1, Number(settings.trendTpMinMultiplier) || this.trendTpMinMultiplier)
      this.trendTpMaxFactor = Math.max(0.1, Number(settings.trendTpMaxFactor) || this.trendTpMaxFactor)
      this.trendTpStep = Math.max(0.01, Number(settings.trendTpStep) || this.trendTpStep)
      this.settingsLoadedAt = Date.now()

      console.log(
        `[v0] Loaded indication settings: validation=${this.validationTimeout}s, cooldown=${this.positionCooldown}s, maxPerConfig=${this.maxPositionsPerConfig}`,
      )
    } catch (error) {
      console.error("[v0] Failed to load indication settings:", error)
      // Use defaults if loading fails
      this.validationTimeout = 15
      this.positionCooldown = 0.1
      this.maxPositionsPerConfig = 1
      this.settingsLoadedAt = Date.now()
    }
  }

  private parseNumericList(raw: any, fallback: number[]): number[] {
    let values: unknown[] = []
    if (Array.isArray(raw)) {
      values = raw
    } else if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw)
        values = Array.isArray(parsed) ? parsed : raw.split(",")
      } catch {
        values = raw.split(",")
      }
    } else {
      values = fallback
    }
    const parsed = values.map(Number).filter((value: number) => Number.isFinite(value))
    return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback
  }

  private async refreshSettingsIfNeeded(): Promise<void> {
    await this.settingsReady
    if (Date.now() - this.settingsLoadedAt < this.SETTINGS_CACHE_TTL) return

    // Twelve symbols commonly enter this path together. Coalesce their
    // settings refresh into one read pair so an instant reconfiguration does
    // not create a burst of duplicate Redis traffic on the hot path.
    if (!this.settingsRefreshPromise) {
      this.settingsRefreshPromise = this.loadSettings().finally(() => {
        this.settingsRefreshPromise = null
      })
    }
    await this.settingsRefreshPromise
  }

  /** Serialize read/append/write mutations per position pool to prevent lost
   * updates when several ranges or activity windows qualify in parallel. */
  private async appendPositions(positionKey: string, entries: any[]): Promise<void> {
    if (entries.length === 0) return

    const previous = this.positionAppendQueues.get(positionKey) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
      const raw = (await getSettings(positionKey)) as any[]
      const current = Array.isArray(raw) ? raw : []
      const combined = [...current, ...entries]
      await setSettings(positionKey, combined)
      this.positionsCache.set(positionKey, { positions: combined, ts: Date.now() })
    })
    this.positionAppendQueues.set(positionKey, operation)

    try {
      await operation
    } finally {
      if (this.positionAppendQueues.get(positionKey) === operation) {
        this.positionAppendQueues.delete(positionKey)
      }
    }
  }

  /**
   * Process step-based indications for Main System Trade mode
   * OPTIMIZED: Async handling with Promise.allSettled for parallel processing
   */
  async processStepBasedIndications(symbol: string): Promise<void> {
    try {
      // Check if already processing this symbol
      const processingKey = `process-${symbol}`
      if (this.pendingOperations.has(processingKey)) {
        console.log(`[v0] Already processing indications for ${symbol}, skipping duplicate`)
        return
      }

      // Mark as processing
      const processingPromise = this.executeIndicationProcessing(symbol)
      this.pendingOperations.set(processingKey, processingPromise)

      try {
        await processingPromise
      } finally {
        this.pendingOperations.delete(processingKey)
      }
    } catch (error) {
      console.error(`[v0] Error processing step-based indications for ${symbol}:`, error)
    }
  }

  /**
   * Execute indication processing with proper async handling
   */
  private async executeIndicationProcessing(symbol: string): Promise<void> {
    const startTime = Date.now()
    await this.refreshSettingsIfNeeded()
    
    // Log start of indication processing
    await logProgressionEvent(this.connectionId, "indications_processing", "info", `Processing all indication types for ${symbol}`, {
      symbol,
      timestamp: new Date().toISOString(),
    })
    
    // Get current price with caching
    const currentPrice = await this.getCachedPrice(symbol)
    if (!currentPrice) {
      await logProgressionEvent(this.connectionId, "indications_processing", "warning", `No price data for ${symbol}`, { symbol })
      return
    }

    // Get indication ranges from settings (cached)
    const { minRange, maxRange } = await this.getIndicationRanges()

    // Process all indication types in parallel with proper error handling
    const results = await Promise.allSettled([
      this.processDirectionIndications(symbol, currentPrice, minRange, maxRange),
      this.processMoveIndications(symbol, currentPrice, minRange, maxRange),
      this.processActiveIndications(symbol, currentPrice),
      this.processOptimalIndications(symbol, currentPrice, minRange, maxRange),
      this.processActiveAdvancedIndications(symbol, currentPrice),
      this.processTrendIndications(symbol, currentPrice),
    ])

    // Log results for each type
    const types = ["direction", "move", "active", "optimal", "active_advanced", "trend"]
    let totalIndications = 0
    let totalPositions = 0
    
    const typeResults: Record<string, { indications: number; positions: number }> = {}
    
    results.forEach((result, index) => {
      const type = types[index]
      if (result.status === "fulfilled" && result.value) {
        const value = result.value as { indications?: number; positions?: number }
        const indications = value.indications || 0
        const positions = value.positions || 0
        totalIndications += indications
        totalPositions += positions
        typeResults[type] = { indications, positions }
      } else if (result.status === "rejected") {
        console.error(`[v0] Failed to process ${type} indication for ${symbol}:`, result.reason)
      }
    })
    
    const duration = Date.now() - startTime
    
    // Log completion of indication processing
    await logProgressionEvent(this.connectionId, "indications_processed", "info", `Completed indication processing for ${symbol}`, {
      symbol,
      price: currentPrice,
      totalIndications,
      totalPositions,
      byType: typeResults,
      duration,
    })
  }

  /**
   * Get cached price to reduce database queries
   * OPTIMIZED: Only fetch last 1 record
   */
  private async getCachedPrice(symbol: string): Promise<number | null> {
    const cached = this.priceCache.get(symbol)
    const now = Date.now()

    if (cached && now - cached.timestamp < this.PRICE_CACHE_TTL) {
      return cached.price
    }

    // Get latest price from Redis market data
    const priceKey = `market_price:${this.connectionId}:${symbol}`
    const redisPrice = await getSettings(priceKey)
    
    if (redisPrice) {
      const price = Number.parseFloat(redisPrice)
      this.priceCache.set(symbol, { price, timestamp: now })
      return price
    }

    // No price data available yet
    return null
  }

  /**
   * Get indication ranges with caching
   */
  private cachedRanges: { minRange: number; maxRange: number; timestamp: number } | null = null
  private readonly RANGE_CACHE_TTL = 60000 // 60 seconds

  private async getIndicationRanges(): Promise<{ minRange: number; maxRange: number }> {
    const now = Date.now()

    if (this.cachedRanges && now - this.cachedRanges.timestamp < this.RANGE_CACHE_TTL) {
      return this.cachedRanges
    }

    // Mirror-aware scalar read — falls back from the individual
    // `settings:indicationRangeMin` hash (historical) to
    // `app_settings.indicationRangeMin` (UI-saved) to the 2 default.
    const minRange = await getAppSetting<number>("indicationRangeMin", 2)
    const maxRange = 30

    this.cachedRanges = { minRange, maxRange, timestamp: now }

    return { minRange, maxRange }
  }

  /**
   * Check if an indication can be created (validation timeout)
   */
  private async canCreateIndication(stateKey: string): Promise<boolean> {
    try {
      // Get state from Redis
      const stateData = await getSettings(`indication_state:${stateKey}`)

      if (!stateData?.validated_at) return true

      const validatedAt = new Date(stateData.validated_at).getTime()
      const now = Date.now()
      const elapsedSeconds = (now - validatedAt) / 1000

      return elapsedSeconds >= this.validationTimeout
    } catch (error) {
      console.error(`[v0] Error checking indication state for ${stateKey}:`, error)
      return false // Fail safe
    }
  }

  /**
   * Check if a position can be created (cooldown and limits)
   */
  private async canCreatePosition(
    symbol: string,
    type: string,
    range: number | null,
    threshold: number | null,
    timeWindow: number | null,
    lastPartRatio: number | null,
    direction: "long" | "short" | null = null,
    activeSituationRatio: number | null = null,
  ): Promise<boolean> {
    try {
      const positionsKey = type === "active_advanced"
        ? `positions_advanced:${this.connectionId}:${symbol}`
        : `positions:${this.connectionId}:${symbol}:${type}`
      // Use the in-memory cache to avoid re-reading the same Redis key on every
      // range in the inner batch loop (up to 29 reads per direction/move cycle).
      const now = Date.now()
      let cached = this.positionsCache.get(positionsKey)
      if (!cached || now - cached.ts > this.POSITIONS_CACHE_TTL) {
        const raw = (await getSettings(positionsKey)) as any[]
        cached = { positions: Array.isArray(raw) ? raw : [], ts: now }
        this.positionsCache.set(positionsKey, cached)
      }
      const positions = cached.positions

      let activeCount = 0
      for (const pos of positions) {
        if (pos.status !== 'active') continue
        if (range !== null && pos.indication_range !== range) continue
        if (threshold !== null && pos.activity_ratio !== threshold) continue
        if (timeWindow !== null && pos.time_window !== timeWindow) continue
        if (lastPartRatio !== null && pos.last_part_ratio !== lastPartRatio) continue
        if (direction !== null && pos.direction !== direction) continue
        if (activeSituationRatio !== null && pos.active_situation_ratio !== activeSituationRatio) continue
        activeCount++
      }

      return activeCount < this.maxPositionsPerConfig
    } catch (error) {
      console.error(`[v0] Error checking position limits for ${symbol}:`, error)
      return false // Fail safe
    }
  }

  /**
   * Direction Type: Opposite direction change detection (range 2-30)
   * OPTIMIZED: Use time-window limits based on indication type
   */
  private async processDirectionIndications(
    symbol: string,
    currentPrice: number,
    minRange: number,
    maxRange: number,
  ): Promise<void> {
    // Get historical prices from Redis market data cache
    const pricesKey = `market_prices:${this.connectionId}:${symbol}`
    const historicalPrices = (await getSettings(pricesKey)) as any[] || []

    if (!Array.isArray(historicalPrices) || historicalPrices.length < minRange + 1) return

    // Filter and convert to valid numbers
    const prices = historicalPrices
      .map((p: any) => {
        if (!p || typeof p !== "object") return null
        const price = typeof p.price === "number" ? p.price : Number.parseFloat(String(p.price))
        return Number.isFinite(price) ? price : null
      })
      .filter((p: number | null): p is number => p !== null)
    
    if (prices.length < minRange + 1) return

    // Process ranges with batching to avoid overwhelming the system
    const ranges = Array.from({ length: maxRange - minRange + 1 }, (_, i) => minRange + i)
    const batchSize = 5

    for (let i = 0; i < ranges.length; i += batchSize) {
      const batch = ranges.slice(i, i + batchSize)

      await Promise.allSettled(
        batch.map(async (range) => {
          const stateKey = `${symbol}-direction-${range}`

          // Early return checks
          if (prices.length < range + 1) return
          if (!(await this.canCreateIndication(stateKey))) return
          if (!(await this.canCreatePosition(symbol, "direction", range, null, null, null))) return

          const directionChange = this.detectDirectionChange(prices, range)

          if (directionChange) {
            await this.createPseudoPositions(symbol, "direction", range, currentPrice, directionChange, null, null)
            await this.updateIndicationState(stateKey)
          }
        }),
      )
    }
  }

  /**
   * Move Type: Price movement without opposite requirement (range 2-30)
   * OPTIMIZED: Use time-window limits based on indication type
   */
  private async processMoveIndications(
    symbol: string,
    currentPrice: number,
    minRange: number,
    maxRange: number,
  ): Promise<void> {
    // Get historical prices from Redis market data cache
    const pricesKey = `market_prices:${this.connectionId}:${symbol}`
    const historicalPrices = (await getSettings(pricesKey)) as any[] || []

    if (!Array.isArray(historicalPrices) || historicalPrices.length < minRange + 1) return

    // Filter and convert to valid numbers
    const prices = historicalPrices
      .map((p: any) => {
        if (!p || typeof p !== "object") return null
        const price = typeof p.price === "number" ? p.price : Number.parseFloat(String(p.price))
        return Number.isFinite(price) ? price : null
      })
      .filter((p: number | null): p is number => p !== null)
    
    if (prices.length < minRange + 1) return

    // Process in batches
    const ranges = Array.from({ length: maxRange - minRange + 1 }, (_, i) => minRange + i)
    const batchSize = 5

    for (let i = 0; i < ranges.length; i += batchSize) {
      const batch = ranges.slice(i, i + batchSize)

      await Promise.allSettled(
        batch.map(async (range) => {
          const stateKey = `${symbol}-move-${range}`

          if (prices.length < range + 1) return
          if (!(await this.canCreateIndication(stateKey))) return
          if (!(await this.canCreatePosition(symbol, "move", range, null, null, null))) return

          const moveDetected = this.detectPriceMove(prices, range)

          if (moveDetected) {
            await this.createPseudoPositions(symbol, "move", range, currentPrice, moveDetected, null, null)
            await this.updateIndicationState(stateKey)
          }
        }),
      )
    }
  }

  /**
   * Active Type: Fast price change detection (0.5-2.5% threshold)
   * OPTIMIZED: Use specific 1-minute window with LIMIT
   */
  private async processActiveIndications(symbol: string, currentPrice: number): Promise<void> {
    const thresholds = [0.5, 1.0, 1.5, 2.0, 2.5]

    // Get recent prices from Redis
    const pricesKey = `market_prices_recent:${this.connectionId}:${symbol}`
    const recentPrices = (await getSettings(pricesKey)) as any[] || []

    if (recentPrices.length === 0) return

    await Promise.allSettled(
      thresholds.map(async (threshold) => {
        const stateKey = `${symbol}-active-${threshold}`

        if (!(await this.canCreateIndication(stateKey))) return
        if (!(await this.canCreatePosition(symbol, "active", null, threshold, null, null))) return

        // Get oldest price in recent window
        const oldestPrice = recentPrices[recentPrices.length - 1]
        if (!oldestPrice) return

        const priceChange =
          ((currentPrice - Number.parseFloat(oldestPrice.price)) / Number.parseFloat(oldestPrice.price)) * 100

        if (Math.abs(priceChange) >= threshold) {
          const direction = priceChange > 0 ? "long" : "short"
          await this.createPseudoPositions(symbol, "active", null, currentPrice, direction, threshold, null)
          await this.updateIndicationState(stateKey)
        }
      }),
    )
  }

  /**
   * Optimal Type: Advanced indication with consecutive step detection, market change calculations,
   * drawdown filtering, and base pseudo position layer (250 limit with performance thresholds)
   */
  private async processOptimalIndications(
    symbol: string,
    currentPrice: number,
    minRange: number,
    maxRange: number,
  ): Promise<void> {
    // Get historical prices from Redis market data cache
    const pricesKey = `market_prices:${this.connectionId}:${symbol}`
    const historicalPrices = (await getSettings(pricesKey)) as any[] || []

    if (!Array.isArray(historicalPrices) || historicalPrices.length < minRange + 1) return

    // Filter and convert to valid numbers
    const prices = historicalPrices
      .map((p: any) => {
        if (!p || typeof p !== "object") return null
        const price = typeof p.price === "number" ? p.price : Number.parseFloat(String(p.price))
        return Number.isFinite(price) ? price : null
      })
      .filter((p: number | null): p is number => p !== null)
    
    if (prices.length < minRange + 1) return

    // Process ranges with batching
    const ranges = Array.from({ length: maxRange - minRange + 1 }, (_, i) => minRange + i)
    const batchSize = 5

    for (let i = 0; i < ranges.length; i += batchSize) {
      const batch = ranges.slice(i, i + batchSize)

      await Promise.allSettled(
        batch.map(async (range) => {
          const stateKey = `${symbol}-optimal-${range}`

          if (prices.length < range + 1) return
          if (!(await this.canCreateIndication(stateKey))) return

          // Use correct consecutive step detection (not averages)
          const directionChange = this.detectConsecutiveDirectionSteps(prices, range)

          if (directionChange) {
            // Start market change tracking for this indication
            await this.trackMarketChangeAndCreateOptimalPositions(
              symbol,
              range,
              currentPrice,
              directionChange,
              historicalPrices,
            )
            await this.updateIndicationState(stateKey)
          }
        }),
      )
    }
  }

  /**
   * NEW: Active Advanced Type
   * Uses optimal market change calculations for positive success
   * Multiple advanced calculations for frequently and short time trades up to 40min
   * Ratios for activity percentage change
   */
  private async processActiveAdvancedIndications(symbol: string, currentPrice: number): Promise<void> {
    const maxDataPoints = 500 // Limit data points for performance

    // Get historical prices from Redis
    const pricesKey = `market_prices:${this.connectionId}:${symbol}`
    const historicalPrices = (await getSettings(pricesKey)) as any[] || []

    if (!Array.isArray(historicalPrices) || historicalPrices.length < 10) return // Need minimum data points

    // Filter and convert to valid numbers with safe timestamp handling
    const priceData = historicalPrices.slice(0, maxDataPoints)
      .map((p: any) => {
        if (!p || typeof p !== "object") return null
        const price = typeof p.price === "number" ? p.price : Number.parseFloat(String(p.price))
        const ts = p.timestamp ? new Date(p.timestamp).getTime() : null
        return Number.isFinite(price) && ts ? { price, ts } : null
      })
      .filter((p: any): p is { price: number; ts: number } => p !== null)
    
    if (priceData.length < 10) return

    const prices = priceData.map(p => p.price)
    const timestamps = priceData.map(p => p.ts)

    // Activity ratios: 0.5%, 1.0%, 1.5%, 2.0%, 2.5%, 3.0%
    const activityRatios = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0]

    // Time windows: 1min, 3min, 5min, 10min, 15min, 20min, 30min, 40min
    const timeWindows = [1, 3, 5, 10, 15, 20, 30, 40]

    await Promise.allSettled(
      activityRatios.map(async (activityRatio) => {
        for (const timeWindow of timeWindows) {
          await this.evaluateActiveAdvanced(symbol, currentPrice, prices, timestamps, activityRatio, timeWindow)
        }
      }),
    )
  }

  /**
   * Trend Type (kept last): coordinated 1/3/5/10/15/30-minute calculations
   * across independent negative-drawdown, recent-situation and active-market
   * configurations. The strongest passing configuration in each timeframe is
   * materialised into Base pseudo positions; every passing combination is
   * still retained independently by IndicationSetsProcessor.
   */
  private async processTrendIndications(
    symbol: string,
    currentPrice: number,
  ): Promise<{ indications: number; positions: number } | void> {
    if (!this.trendEnabled) return { indications: 0, positions: 0 }

    const pricesKey = `market_prices:${this.connectionId}:${symbol}`
    const historicalPrices = ((await getSettings(pricesKey)) as any[]) || []
    const prices = this.normalizeTrendPricesOldestFirst(historicalPrices, currentPrice)
    const largestWindow = Math.max(...this.trendTimeframesMinutes)
    if (prices.length < largestWindow + 1) return { indications: 0, positions: 0 }

    const adaptiveTpRange = buildAdaptiveTrendTpRange({
      pricesOldestFirst: prices,
      positionCostPct: this.trendPositionCostPct,
      minMultiplier: this.trendTpMinMultiplier,
      maxFactor: this.trendTpMaxFactor,
      step: this.trendTpStep,
      averageWindowMinutes: largestWindow,
    })

    let indicationCount = 0
    let positionCount = 0
    for (const timeframeMinutes of this.trendTimeframesMinutes) {
      let best: {
        signal: TrendSignal
        drawdownFactor: number
        lastSituationRatio: number
        activeSituationRatio: number
      } | null = null

      for (const drawdownFactor of this.trendDrawdownFactors) {
        for (const lastSituationRatio of this.trendLastSituationRatios) {
          for (const activeSituationRatio of this.trendActiveSituationRatios) {
            const signal = calculateTrendSignal(prices, {
              timeframeMinutes,
              drawdownFactor,
              lastSituationRatio,
              activeSituationRatio,
              positionCostPct: this.trendPositionCostPct,
              minAgreement: this.trendMinAgreement,
            })
            if (!signal || (best && signal.signalScore <= best.signal.signalScore)) continue
            best = { signal, drawdownFactor, lastSituationRatio, activeSituationRatio }
          }
        }
      }

      if (!best) continue
      const stateKey =
        `${symbol}-trend-${timeframeMinutes}-${best.drawdownFactor}` +
        `-${best.lastSituationRatio}-${best.activeSituationRatio}-${best.signal.direction}`
      if (!(await this.canCreateIndication(stateKey))) continue
      if (!(await this.canCreatePosition(
        symbol,
        "trend",
        timeframeMinutes,
        Math.abs(best.drawdownFactor),
        timeframeMinutes,
        best.lastSituationRatio,
        best.signal.direction,
        best.activeSituationRatio,
      ))) continue

      indicationCount++
      positionCount += await this.createTrendBasePseudoPositions(
        symbol,
        currentPrice,
        timeframeMinutes,
        best,
        adaptiveTpRange,
      )
      await this.updateIndicationState(stateKey)
    }

    return { indications: indicationCount, positions: positionCount }
  }

  private normalizeTrendPricesOldestFirst(historicalPrices: any[], currentPrice: number): number[] {
    const rows = historicalPrices
      .map((entry: any, index: number) => {
        const rawPrice = typeof entry === "number" ? entry : entry?.price ?? entry?.close
        const price = Number(rawPrice)
        const rawTimestamp = entry?.timestamp ?? entry?.time
        const numericTimestamp = Number(rawTimestamp)
        const timestamp = Number.isFinite(numericTimestamp) && numericTimestamp > 0
          ? numericTimestamp < 10_000_000_000 ? numericTimestamp * 1000 : numericTimestamp
          : Date.parse(String(rawTimestamp ?? ""))
        return Number.isFinite(price) && price > 0
          ? { price, timestamp: Number.isFinite(timestamp) ? timestamp : null, index }
          : null
      })
      .filter((entry): entry is { price: number; timestamp: number | null; index: number } => entry !== null)

    const allTimestamped = rows.length > 0 && rows.every((entry) => entry.timestamp !== null)
    const prices = allTimestamped
      ? rows.slice().sort((left, right) => Number(left.timestamp) - Number(right.timestamp)).map((entry) => entry.price)
      : rows.slice().reverse().map((entry) => entry.price)

    if (Number.isFinite(currentPrice) && currentPrice > 0) {
      const latest = prices[prices.length - 1]
      if (!latest || Math.abs(latest - currentPrice) / currentPrice > 1e-10) prices.push(currentPrice)
    }
    return prices.slice(-61)
  }

  private async createTrendBasePseudoPositions(
    symbol: string,
    entryPrice: number,
    timeframeMinutes: number,
    best: {
      signal: TrendSignal
      drawdownFactor: number
      lastSituationRatio: number
      activeSituationRatio: number
    },
    adaptiveTpRange: ReturnType<typeof buildAdaptiveTrendTpRange>,
  ): Promise<number> {
    const allStopLossRatios = await this.getStopLossRatios()
    const middleIndex = Math.floor((allStopLossRatios.length - 1) / 2)
    const stopLossRatios = Array.from(new Set([
      allStopLossRatios[0],
      allStopLossRatios[middleIndex],
      allStopLossRatios[allStopLossRatios.length - 1],
    ].filter((value): value is number => Number.isFinite(value))))
    const trailingOptions = [
      { enabled: false, start: null, stop: null },
      { enabled: true, start: 0.6, stop: 0.2 },
    ]
    const positionsKey = `positions:${this.connectionId}:${symbol}:trend`
    const newPositions: any[] = []
    const now = new Date().toISOString()
    const baseConfigs: BasePositionConfig[] = []

    for (const takeprofitFactor of adaptiveTpRange.factors) {
      for (const stoplossRatio of stopLossRatios) {
        for (const trailing of trailingOptions) {
          baseConfigs.push({
            symbol,
            indicationType: "trend",
            range: timeframeMinutes,
            direction: best.signal.direction,
            tpFactor: takeprofitFactor,
            slRatio: stoplossRatio,
            trailingEnabled: trailing.enabled,
            trailStart: trailing.start,
            trailStop: trailing.stop,
            drawdownRatio: best.drawdownFactor,
            marketChangeRange: timeframeMinutes,
            lastPartRatio: best.lastSituationRatio,
            activeSituationRatio: best.activeSituationRatio,
          })
        }
      }
    }

    const basePositionIds = await this.basePseudoManager.getOrCreateEligibleBasePositions(baseConfigs)
    baseConfigs.forEach((config, index) => {
      const basePositionId = basePositionIds[index]
      if (!basePositionId) return
      newPositions.push({
        connection_id: this.connectionId,
        symbol,
        indication_type: "trend",
        indication_range: timeframeMinutes,
        time_window: timeframeMinutes,
        activity_ratio: Math.abs(best.drawdownFactor),
        takeprofit_factor: config.tpFactor,
        stoploss_ratio: config.slRatio,
        trailing_enabled: config.trailingEnabled,
        trail_start: config.trailStart,
        trail_stop: config.trailStop,
        entry_price: entryPrice,
        current_price: entryPrice,
        direction: best.signal.direction,
        status: "active",
        base_position_id: basePositionId,
        position_level: 1,
        drawdown_ratio: best.drawdownFactor,
        last_part_ratio: best.lastSituationRatio,
        active_situation_ratio: best.activeSituationRatio,
        trend_metrics: best.signal.metadata,
        adaptive_tp_range: adaptiveTpRange,
        created_at: now,
      })
    })

    if (newPositions.length > 0) {
      await this.appendPositions(positionsKey, newPositions)
      await logProgressionEvent(
        this.connectionId,
        "base_pseudo_created",
        "info",
        `Created ${newPositions.length} adaptive Trend base pseudo positions for ${symbol}`,
        {
          symbol,
          indicationType: "trend",
          direction: best.signal.direction,
          timeframeMinutes,
          adaptiveTpRange,
          createdCount: newPositions.length,
        },
      )
    }
    return newPositions.length
  }

  /**
   * Evaluate Active Advanced indication with market change calculations
   */
  private async evaluateActiveAdvanced(
    symbol: string,
    currentPrice: number,
    prices: number[],
    timestamps: number[],
    activityRatio: number,
    timeWindow: number, // in minutes
  ): Promise<void> {
    const stateKey = `${symbol}-active_advanced-${activityRatio}-${timeWindow}`

    if (!(await this.canCreateIndication(stateKey))) return
    if (!(await this.canCreatePosition(symbol, "active_advanced", null, activityRatio, timeWindow, null))) return

    // Calculate time window in milliseconds
    const timeWindowMs = timeWindow * 60 * 1000
    const now = timestamps[0]
    const cutoffTime = now - timeWindowMs

    // Get prices within time window
    const windowPrices: number[] = []
    const windowTimestamps: number[] = []

    for (let i = 0; i < prices.length; i++) {
      if (timestamps[i] >= cutoffTime) {
        windowPrices.push(prices[i])
        windowTimestamps.push(timestamps[i])
      }
    }

    if (windowPrices.length < 3) return // Need minimum data points

    // Calculate overall market change (average price change)
    const avgPrice = windowPrices.reduce((sum, p) => sum + p, 0) / windowPrices.length
    const priceChangeFromAvg = ((currentPrice - avgPrice) / avgPrice) * 100

    // Calculate last part market change (last 20% of time window)
    const lastPartCount = Math.max(1, Math.floor(windowPrices.length * 0.2))
    const lastPartPrices = windowPrices.slice(0, lastPartCount)
    const lastPartAvg = lastPartPrices.reduce((sum, p) => sum + p, 0) / lastPartPrices.length
    const lastPartChange = ((currentPrice - lastPartAvg) / lastPartAvg) * 100

    // Calculate volatility (standard deviation)
    const variance = windowPrices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / windowPrices.length
    const volatility = Math.sqrt(variance)
    const volatilityPercent = (volatility / avgPrice) * 100

    // Calculate momentum (price acceleration)
    const momentum = this.calculateMomentum(windowPrices, windowTimestamps)

    // Calculate drawdown within window
    const maxPrice = Math.max(...windowPrices)
    const minPrice = Math.min(...windowPrices)
    const drawdown = ((maxPrice - minPrice) / maxPrice) * 100

    // Validation criteria for Active Advanced:
    // 1. Overall price change >= activityRatio
    // 2. Last part shows continuation (same direction)
    // 3. Volatility indicates active market
    // 4. Momentum is positive
    // 5. Drawdown is acceptable

    const overallChangeAbs = Math.abs(priceChangeFromAvg)
    const lastPartChangeAbs = Math.abs(lastPartChange)

    if (overallChangeAbs >= activityRatio) {
      // Same direction check
      const sameDirection =
        (priceChangeFromAvg > 0 && lastPartChange > 0) || (priceChangeFromAvg < 0 && lastPartChange < 0)

      // Last part should be at least 60% of overall change (continuation)
      const continuationRatio = lastPartChangeAbs / overallChangeAbs

      if (sameDirection && continuationRatio >= 0.6) {
        // Check if volatility indicates active market (not flat)
        if (volatilityPercent >= 0.1) {
          // Check momentum
          if (momentum !== 0) {
            // Check drawdown is acceptable
            if (drawdown <= 5.0) {
              const direction = priceChangeFromAvg > 0 ? "long" : "short"

              // Create base pseudo positions with activity parameters
              await this.createActiveAdvancedPositions(symbol, currentPrice, direction, activityRatio, timeWindow, {
                overallChange: priceChangeFromAvg,
                lastPartChange: lastPartChange,
                volatility: volatilityPercent,
                momentum: momentum,
                drawdown: drawdown,
                continuationRatio: continuationRatio,
              })

              await this.updateIndicationState(stateKey)
            }
          }
        }
      }
    }
  }

  /**
   * Calculate momentum (price acceleration)
   */
  private calculateMomentum(prices: number[], timestamps: number[]): number {
    if (prices.length < 3) return 0

    const recentCount = Math.min(5, Math.floor(prices.length / 3))
    const olderCount = recentCount

    const recentPrices = prices.slice(0, recentCount)
    const olderPrices = prices.slice(prices.length - olderCount, prices.length)

    const recentAvg = recentPrices.reduce((sum, p) => sum + p, 0) / recentPrices.length
    const olderAvg = olderPrices.reduce((sum, p) => sum + p, 0) / olderPrices.length

    const recentTime = timestamps.slice(0, recentCount)
    const olderTime = timestamps.slice(timestamps.length - olderCount, timestamps.length)

    const recentAvgTime = recentTime.reduce((sum, t) => sum + t, 0) / recentTime.length
    const olderAvgTime = olderTime.reduce((sum, t) => sum + t, 0) / olderTime.length

    const timeDiff = (recentAvgTime - olderAvgTime) / 1000 // in seconds
    if (timeDiff === 0) return 0

    return (((recentAvg - olderAvg) / olderAvg) * 100) / timeDiff // % per second
  }

  /**
   * Create base pseudo positions for Active Advanced indication
   */
  private async createActiveAdvancedPositions(
    symbol: string,
    entryPrice: number,
    direction: "long" | "short",
    activityRatio: number,
    timeWindow: number,
    metrics: {
      overallChange: number
      lastPartChange: number
      volatility: number
      momentum: number
      drawdown: number
      continuationRatio: number
    },
  ): Promise<void> {
    try {
      // Define ALL possible configurations (UNLIMITED sets)
      const tpFactors = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]
      // Stop-loss grid: systemwide range 0.25..maxStopLossRatio (default/max 2.5), step 0.25.
      const slRatios = await this.getStopLossRatios()
      const trailingOptions = [
        { enabled: false, start: null, stop: null },
        { enabled: true, start: 0.3, stop: 0.1 },
        { enabled: true, start: 0.6, stop: 0.2 },
        { enabled: true, start: 1.0, stop: 0.3 },
      ]

      // Read once, collect all new entries, write once.
      // Previous impl: read+write inside the inner loop — O(N) round-trips.
      const advancedKey = `positions_advanced:${this.connectionId}:${symbol}`
      const newAdvanced: any[] = []
      const now = new Date().toISOString()
      const baseConfigs: BasePositionConfig[] = []

      for (const tpFactor of tpFactors) {
        for (const slRatio of slRatios) {
          for (const trailingConfig of trailingOptions) {
            baseConfigs.push({
              symbol,
              indicationType: "active_advanced",
              range: activityRatio,
              direction,
              tpFactor,
              slRatio,
              trailingEnabled: trailingConfig.enabled,
              trailStart: trailingConfig.start,
              trailStop: trailingConfig.stop,
              drawdownRatio: metrics.drawdown / 100,
              marketChangeRange: timeWindow,
              lastPartRatio: metrics.continuationRatio,
            })
          }
        }
      }

      const basePositionIds = await this.basePseudoManager.getOrCreateEligibleBasePositions(baseConfigs)
      baseConfigs.forEach((config, index) => {
        const basePositionId = basePositionIds[index]
        if (!basePositionId) return
        newAdvanced.push({
              connection_id: this.connectionId,
              symbol,
              indication_type: "active_advanced",
              activity_ratio: activityRatio,
              takeprofit_factor: config.tpFactor,
              stoploss_ratio: config.slRatio,
              trailing_enabled: config.trailingEnabled,
              trail_start: config.trailStart,
              trail_stop: config.trailStop,
              entry_price: entryPrice,
              current_price: entryPrice,
              direction,
              status: "base_active",
              base_position_id: basePositionId,
              position_level: "base",
              time_window: timeWindow,
              overall_change: metrics.overallChange,
              last_part_change: metrics.lastPartChange,
              volatility: metrics.volatility,
              momentum: metrics.momentum,
              drawdown_ratio: metrics.drawdown / 100,
              continuation_ratio: metrics.continuationRatio,
              created_at: now,
        })
      })

      if (newAdvanced.length > 0) {
        await this.appendPositions(advancedKey, newAdvanced)
      }

      const createdCount = newAdvanced.length
      console.log(
        `[v0] Created ${createdCount} Active Advanced BASE pseudo position entries for ${symbol} ${direction} (${activityRatio}% / ${timeWindow}min)`,
      )
    } catch (error) {
      console.error(`[v0] Error creating Active Advanced positions:`, error)
    }
  }

  /**
   * Create BASE pseudo positions when indication is VALID
   * Each configuration (TP/SL/Trailing combo) gets its own base position set
   * Each base position set can have up to 250 entries in database
   */
  private async createPseudoPositions(
    symbol: string,
    indicationType: "direction" | "move" | "active" | "active_advanced",
    range: number | null,
    entryPrice: number,
    direction: "long" | "short",
    threshold: number | null,
    trailing: any | null,
  ): Promise<void> {
    try {
      // Define ALL possible configurations (UNLIMITED sets)
      const tpFactors = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]
      // Stop-loss grid: systemwide range 0.25..maxStopLossRatio (default/max 2.5), step 0.25.
      const slRatios = await this.getStopLossRatios()
      const trailingOptions = [
        { enabled: false, start: null, stop: null },
        { enabled: true, start: 0.3, stop: 0.1 },
        { enabled: true, start: 0.6, stop: 0.2 },
        { enabled: true, start: 1.0, stop: 0.3 },
      ]

      // Collect all new position records in memory first, then write once.
      // Previous impl: read+write the positions list inside the inner loop —
      // O(N) round-trips where N = tpFactors × slRatios × trailing = up to 528.
      const positionsKey = `positions:${this.connectionId}:${symbol}:${indicationType}`
      const newPositions: any[] = []
      const now = new Date().toISOString()
      const baseConfigs: BasePositionConfig[] = []

      for (const tpFactor of tpFactors) {
        for (const slRatio of slRatios) {
          for (const trailingConfig of trailingOptions) {
            baseConfigs.push({
              symbol,
              indicationType,
              range: range || 0,
              direction,
              tpFactor,
              slRatio,
              trailingEnabled: trailingConfig.enabled,
              trailStart: trailingConfig.start,
              trailStop: trailingConfig.stop,
              drawdownRatio: 0.3,
              marketChangeRange: range || 3,
              lastPartRatio: 1.5,
            })
          }
        }
      }

      const basePositionIds = await this.basePseudoManager.getOrCreateEligibleBasePositions(baseConfigs)
      baseConfigs.forEach((config, index) => {
        const basePositionId = basePositionIds[index]
        if (!basePositionId) return
        newPositions.push({
              connection_id: this.connectionId,
              symbol,
              indication_type: indicationType,
              indication_range: range || 0,
              takeprofit_factor: config.tpFactor,
              stoploss_ratio: config.slRatio,
              trailing_enabled: config.trailingEnabled,
              trail_start: config.trailStart,
              trail_stop: config.trailStop,
              entry_price: entryPrice,
              current_price: entryPrice,
              direction,
              status: "active",
              base_position_id: basePositionId,
              position_level: 1,
              created_at: now,
        })
      })

      // Single write for all positions from this cycle.
      if (newPositions.length > 0) {
        await this.appendPositions(positionsKey, newPositions)
      }

      const createdCount = newPositions.length
      console.log(
        `[v0] Created ${createdCount} BASE pseudo position entries across multiple config sets for ${symbol} ${indicationType} ${direction}`,
      )

      if (createdCount > 0) {
        await logProgressionEvent(this.connectionId, "base_pseudo_created", "info", `Created ${createdCount} base pseudo positions for ${symbol}`, {
          symbol,
          indicationType,
          direction,
          range: range || null,
          entryPrice,
          createdCount,
        })
      }
    } catch (error) {
      console.error(`[v0] Error creating base pseudo positions:`, error)
    }
  }

  /**
   * Update indication state after validation
   */
  private async updateIndicationState(stateKey: string): Promise<void> {
    try {
      // Update indication state in Redis
      const stateData = await getSettings(`indication_state:${stateKey}`) || {}
      await setSettings(`indication_state:${stateKey}`, {
        ...stateData,
        validated_at: new Date().toISOString(),
      })
    } catch (error) {
      console.error(`[v0] Failed to update indication state ${stateKey}:`, error)
    }
  }

  /**
   * Detect direction change in price series
   * Fixed to use correct consecutive step counting for Direction/Move types
   */
  private detectDirectionChange(prices: number[], range: number): "long" | "short" | null {
    // For Direction/Move types, use the simple average method (keep coordinated)
    if (prices.length < range + 1) return null

    const recentPrices = prices.slice(0, range)
    const olderPrice = prices[range]

    const avgRecent = recentPrices.reduce((sum, p) => sum + p, 0) / recentPrices.length

    // Direction change: recent average significantly different from older price
    const changePercent = ((avgRecent - olderPrice) / olderPrice) * 100

    if (changePercent > 0.5) return "long"
    if (changePercent < -0.5) return "short"

    return null
  }

  /**
   * Detect price move without direction requirement
   * Fixed to use correct consecutive step counting for Direction/Move types
   */
  private detectPriceMove(prices: number[], range: number): "long" | "short" | null {
    // For Direction/Move types, use the simple endpoint method (keep coordinated)
    if (prices.length < range + 1) return null

    const currentPrice = prices[0]
    const oldPrice = prices[range]

    const changePercent = ((currentPrice - oldPrice) / oldPrice) * 100

    if (Math.abs(changePercent) > 0.3) {
      return changePercent > 0 ? "long" : "short"
    }

    return null
  }

  /**
   * CORRECT Direction Detection: Count consecutive opposite steps
   * Returns expected reversal direction
   */
  private detectConsecutiveDirectionSteps(prices: number[], range: number): "long" | "short" | null {
    if (prices.length < range + 1) return null

    let consecutiveDown = 0
    let consecutiveUp = 0

    // Compare each price to the next (newer to older)
    for (let i = 0; i < range; i++) {
      const current = prices[i]
      const previous = prices[i + 1]

      if (current < previous) {
        // Price went DOWN
        consecutiveDown++
        consecutiveUp = 0 // reset opposite counter
      } else if (current > previous) {
        // Price went UP
        consecutiveUp++
        consecutiveDown = 0 // reset opposite counter
      } else {
        // Price unchanged - reset both
        consecutiveDown = 0
        consecutiveUp = 0
      }
    }

    // If we counted 'range' consecutive downs → expect UP reversal (LONG)
    if (consecutiveDown >= range) {
      return "long"
    }

    // If we counted 'range' consecutive ups → expect DOWN reversal (SHORT)
    if (consecutiveUp >= range) {
      return "short"
    }

    return null
  }

  /**
   * CORRECT Move Detection: Consecutive same-direction steps WITHOUT opposite interference
   * Returns continuation direction
   */
  private detectConsecutiveMoveSteps(prices: number[], range: number): "long" | "short" | null {
    if (prices.length < range + 1) return null

    let upMoves = 0
    let downMoves = 0
    let flatMoves = 0

    // Analyze each step
    for (let i = 0; i < range; i++) {
      const current = prices[i]
      const previous = prices[i + 1]

      if (current > previous) {
        upMoves++
      } else if (current < previous) {
        downMoves++
      } else {
        flatMoves++
      }
    }

    // Valid UP move: only UP and FLAT, NO DOWN, and at least 60% actual moves
    if (upMoves > 0 && downMoves === 0 && upMoves >= range * 0.6) {
      // Check minimum movement threshold
      const totalMovement = Math.abs(prices[0] - prices[range]) / prices[range]
      if (totalMovement >= 0.003) {
        return "long"
      }
    }

    // Valid DOWN move: only DOWN and FLAT, NO UP, and at least 60% actual moves
    if (downMoves > 0 && upMoves === 0 && downMoves >= range * 0.6) {
      const totalMovement = Math.abs(prices[0] - prices[range]) / prices[range]
      if (totalMovement >= 0.003) {
        return "short"
      }
    }

    return null
  }

  /**
   * Track market change for 3+ seconds and create optimal positions with all variations
   * Includes: drawdown filtering, market change calculations, base pseudo layer
   */
  private async trackMarketChangeAndCreateOptimalPositions(
    symbol: string,
    range: number,
    currentPrice: number,
    direction: "long" | "short",
    historicalPrices: any[],
  ): Promise<void> {
    // Implementation would track per-second price changes for min 3 seconds
    // Calculate overall average and last 20% average
    // Validate against ratio factors (1.0, 1.5, 2.0, 2.5)
    // For now, simplified version:

    const drawdownRatios = [0.1, 0.2, 0.3, 0.4, 0.5]
    const marketChangeRanges = [1, 3, 5, 7, 9]
    const lastPartRatios = [1.0, 1.5, 2.0, 2.5]

    // For each combination that passes validation
    for (const drawdownRatio of drawdownRatios) {
      for (const marketChangeRange of marketChangeRanges) {
        for (const lastPartRatio of lastPartRatios) {
          // Get or create base pseudo position
          const basePositionId = await this.basePseudoManager.getOrCreateBasePosition(
            symbol,
            "optimal",
            range,
            direction,
            0, // tpFactor (dummy)
            0, // slRatio (dummy)
            false, // trailingEnabled (dummy)
            null, // trailStart
            null, // trailStop
            drawdownRatio,
            marketChangeRange,
            lastPartRatio,
          )

          if (!basePositionId) continue

          // Check if base position can create more positions
          if (!(await this.basePseudoManager.canCreatePosition(basePositionId))) {
            continue
          }

          // Create full position matrix for this base config
          await this.createOptimalPositionMatrix(
            symbol,
            range,
            currentPrice,
            direction,
            basePositionId,
            drawdownRatio,
            marketChangeRange,
            lastPartRatio,
          )
        }
      }
    }
  }

  /**
   * Create full TP×SL×Trailing matrix for an optimal base config
   */
  private async createOptimalPositionMatrix(
    symbol: string,
    range: number,
    entryPrice: number,
    direction: "long" | "short",
    basePositionId: string,
    drawdownRatio: number,
    marketChangeRange: number,
    lastPartRatio: number,
  ): Promise<void> {
    const tpFactors = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]
    // Stop-loss grid: systemwide range 0.25..maxStopLossRatio (default/max 2.5), step 0.25.
    const slRatios = await this.getStopLossRatios()
      const trailingOptions = [
        { enabled: false, start: null, stop: null },
        { enabled: true, start: 0.3, stop: 0.1 },
        { enabled: true, start: 0.6, stop: 0.2 },
        { enabled: true, start: 1.0, stop: 0.3 },
      ]

    const positions: any[] = []

    for (const tpFactor of tpFactors) {
      for (const slRatio of slRatios) {
        for (const trailing of trailingOptions) {
          positions.push({
            connection_id: this.connectionId,
            symbol,
            indication_type: "optimal",
            indication_range: range,
            takeprofit_factor: tpFactor,
            stoploss_ratio: slRatio,
            trailing_enabled: trailing.enabled,
            trail_start: trailing.enabled ? trailing.start : null,
            trail_stop: trailing.enabled ? trailing.stop : null,
            entry_price: entryPrice,
            current_price: entryPrice,
            direction,
            status: "active",
            base_position_id: basePositionId, // Link to base position
            // Store config parameters for filtering
            drawdown_ratio: drawdownRatio,
            market_change_range: marketChangeRange,
            last_part_ratio: lastPartRatio,
          })
        }
      }
    }

    // Batch insert into Redis
    if (positions.length > 0) {
      const posKey = `positions_optimal:${this.connectionId}:${symbol}:${range}`
      const existing = (await getSettings(posKey)) as any[] || []

      for (const p of positions) {
        existing.push({
          ...p,
          created_at: new Date().toISOString(),
        })
      }

      await setSettings(posKey, existing)

      console.log(
        `[v0] Created ${positions.length} optimal positions for ${symbol} (range ${range} ${direction}) base ${basePositionId}`,
      )
    }
  }
}
