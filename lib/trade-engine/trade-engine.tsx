/**
 * Trade Engine - Dual-Mode Parallel System
 * Service Name: project_name-trade
 * Runs BOTH Preset Trade and Main System Trade simultaneously
 * Each mode has its own independent interval progression
 *
 * Preset Trade: Common indicators (RSI, MACD, Bollinger, SAR, ADX) - wider TP/SL for short-term
 * Main System Trade: Step-based indications (Direction, Move, Active, Optimal) - standard ranges
 */

import { sql, query, getDatabaseType } from "@/lib/db"
import { IndicationProcessor } from "./indication-processor-fixed"
import { StrategyProcessor } from "./strategy-processor"
import { PseudoPositionManager } from "./pseudo-position-manager"
import { RealtimeProcessor } from "./realtime-processor"
import { IndicationStateManager } from "@/lib/indication-state-manager"
import { PositionFlowCoordinator } from "@/lib/position-flow-coordinator"
import { getDataCleanupManager } from "@/lib/data-cleanup-manager"
import { clampConcurrency, mapSettledWithConcurrency, mapWithConcurrency } from "@/lib/bounded-concurrency"

export const TRADE_SERVICE_NAME = "TradeEngine-PerConnection"

export interface TradeEngineConfig {
  connectionId: string
  tradeInterval: number
  realInterval: number
  maxConcurrency?: number
}

interface SettingsCache {
  indication: any
  strategy: any
  symbols: string[]
  lastUpdate: number
}

interface ComponentHealth {
  status: "healthy" | "degraded" | "unhealthy"
  lastCycleDuration: number
  errorCount: number
  successRate: number
}

export class TradeEngine {
  private connectionId: string
  private isRunning = false
  private presetTradeLoopPromise?: Promise<void>
  private mainTradeLoopPromise?: Promise<void>
  private realLoopPromise?: Promise<void>

  private indicationProcessor: IndicationProcessor
  private strategyProcessor: StrategyProcessor
  private pseudoPositionManager: PseudoPositionManager
  private realtimeProcessor: RealtimeProcessor
  private indicationStateManager: IndicationStateManager
  private positionFlowCoordinator: PositionFlowCoordinator

  private settingsCache: SettingsCache | null = null
  private maxConcurrency: number
  private presetProcessingQueue: Set<string> = new Set()
  private mainProcessingQueue: Set<string> = new Set()

  private tradeInterval = 1.0
  private realInterval = 0.3

  private healthCheckInterval?: NodeJS.Timeout
  private componentHealth: {
    preset: ComponentHealth
    main: ComponentHealth
    realtime: ComponentHealth
  }

  constructor(config: TradeEngineConfig) {
    this.connectionId = config.connectionId
    this.maxConcurrency = clampConcurrency(
      config.maxConcurrency ?? process.env.PRESET_SYMBOL_CONCURRENCY,
      4,
      8,
    )
    this.tradeInterval = config.tradeInterval
    this.realInterval = config.realInterval

    console.log(`[v0] Initializing ${TRADE_SERVICE_NAME} for connection:`, this.connectionId)
    console.log(`[v0] Service runs continuously with three parallel loops:`)
    console.log(`[v0] - Preset Loop: ${this.tradeInterval}s (common indicators)`)
    console.log(`[v0] - Main Loop: ${this.tradeInterval}s (step-based indications)`)
    console.log(`[v0] - Real Positions Loop: ${this.realInterval}s (exchange mirroring)`)

    this.componentHealth = {
      preset: { status: "healthy", lastCycleDuration: 0, errorCount: 0, successRate: 100 },
      main: { status: "healthy", lastCycleDuration: 0, errorCount: 0, successRate: 100 },
      realtime: { status: "healthy", lastCycleDuration: 0, errorCount: 0, successRate: 100 },
    }

    this.indicationProcessor = new IndicationProcessor(config.connectionId)
    this.strategyProcessor = new StrategyProcessor(config.connectionId)
    this.pseudoPositionManager = new PseudoPositionManager(config.connectionId)
    this.realtimeProcessor = new RealtimeProcessor(config.connectionId)
    this.indicationStateManager = new IndicationStateManager(config.connectionId)
    this.positionFlowCoordinator = new PositionFlowCoordinator(config.connectionId)
  }

  async start(config: TradeEngineConfig): Promise<void> {
    if (this.isRunning) {
      console.log(`[v0] ${TRADE_SERVICE_NAME} already running for connection:`, this.connectionId)
      return
    }

    console.log(
      `[v0] Starting ${TRADE_SERVICE_NAME} in DUAL-MODE (Preset + Main System) for connection:`,
      this.connectionId,
    )

    try {
      await this.updateEngineState("starting")

      await this.loadEngineSettings()

      const [connectionSettings] = await sql<{ connection_settings: string }>`
        SELECT connection_settings FROM exchange_connections
        WHERE id = ${this.connectionId}
      `

      const settings = connectionSettings?.connection_settings ? JSON.parse(connectionSettings.connection_settings) : {}

      console.log("[v0] Loaded connection-specific settings:", settings)

      const cleanupManager = getDataCleanupManager()
      await cleanupManager.start()

      await this.loadPrehistoricData()

      await this.getSymbols()
      await this.realtimeProcessor.initializeStream()

      this.isRunning = true

      this.presetTradeLoopPromise = this.runPresetTradeLoop()
      this.mainTradeLoopPromise = this.runMainTradeLoop()
      this.realLoopPromise = this.runRealPositionsLoop()
      this.startHealthMonitoring()

      await this.updateEngineState("running")
      console.log(`[v0] ${TRADE_SERVICE_NAME} started successfully with all three loops running continuously`)
    } catch (error) {
      console.error(`[v0] Failed to start ${TRADE_SERVICE_NAME}:`, error)
      await this.updateEngineState("error", error instanceof Error ? error.message : "Unknown error")
      await this.cleanup()
      throw error
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      console.log(`[v0] ${TRADE_SERVICE_NAME} not running`)
      return
    }

    console.log(`[v0] Stopping ${TRADE_SERVICE_NAME} for connection:`, this.connectionId)

    this.isRunning = false

    await Promise.all([this.presetTradeLoopPromise, this.mainTradeLoopPromise, this.realLoopPromise].filter(Boolean))

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = undefined
    }

    await this.cleanup()

    const cleanupManager = getDataCleanupManager()
    cleanupManager.stop()

    await this.updateEngineState("stopped")

    console.log(`[v0] ${TRADE_SERVICE_NAME} stopped - all loops terminated`)
  }

  private async cleanup(): Promise<void> {
    try {
      this.realtimeProcessor.stopStream()
      this.presetProcessingQueue.clear()
      this.mainProcessingQueue.clear()
    } catch (error) {
      console.error("[v0] Error during cleanup:", error)
    }
  }

  private async runPresetTradeLoop(): Promise<void> {
    console.log(`[v0] Starting PRESET Trade Loop (interval: ${this.tradeInterval}s)`)
    console.log("[v0] Preset Mode: Common Indicators → Strategies → Pseudo Positions → Logging")
    console.log("[v0] Using non-overlapping progression: waits for completion before next cycle")

    let cycleCount = 0
    let totalDuration = 0
    let errorCount = 0

    while (this.isRunning) {
      const startTime = Date.now()

      try {
        const symbols = await this.getSymbolsCached()

        await this.processSymbolsPresetMode(symbols)

        const duration = Date.now() - startTime
        cycleCount++
        totalDuration += duration

        this.componentHealth.preset.lastCycleDuration = duration
        this.componentHealth.preset.successRate = ((cycleCount - errorCount) / cycleCount) * 100

        await sql`
          UPDATE trade_engine_state
          SET 
            last_preset_run = CURRENT_TIMESTAMP,
            preset_cycle_duration_ms = ${duration},
            preset_symbols_processed = ${symbols.length},
            preset_cycle_count = ${cycleCount},
            preset_avg_duration_ms = ${totalDuration / cycleCount}
          WHERE connection_id = ${this.connectionId}
        `

        console.log(`[v0] Preset trade cycle #${cycleCount} completed in ${duration}ms for ${symbols.length} symbols`)
      } catch (error) {
        errorCount++
        this.componentHealth.preset.errorCount++
        console.error("[v0] Preset Trade Loop error:", error)
      }

      if (this.isRunning) {
        await this.sleep(this.tradeInterval * 1000)
      }
    }

    console.log(`[v0] Preset Trade Loop stopped after ${cycleCount} cycles`)
  }

  private async runMainTradeLoop(): Promise<void> {
    console.log(`[v0] Starting MAIN SYSTEM Trade Loop (interval: ${this.tradeInterval}s)`)
    console.log("[v0] Main Mode: Step-based Indications → Strategies → Pseudo Positions → Logging")
    console.log("[v0] Using non-overlapping progression: waits for completion before next interval")

    let cycleCount = 0
    let totalDuration = 0
    let errorCount = 0

    while (this.isRunning) {
      const startTime = Date.now()

      try {
        const symbols = await this.getSymbolsCached()

        await this.processSymbolsMainMode(symbols)

        const duration = Date.now() - startTime
        cycleCount++
        totalDuration += duration

        this.componentHealth.main.lastCycleDuration = duration
        this.componentHealth.main.successRate = ((cycleCount - errorCount) / cycleCount) * 100

        await sql`
          UPDATE trade_engine_state
          SET 
            last_main_run = CURRENT_TIMESTAMP,
            main_cycle_duration_ms = ${duration},
            main_symbols_processed = ${symbols.length},
            main_cycle_count = ${cycleCount},
            main_avg_duration_ms = ${totalDuration / cycleCount}
          WHERE connection_id = ${this.connectionId}
        `

        console.log(
          `[v0] Main system trade cycle #${cycleCount} completed in ${duration}ms for ${symbols.length} symbols`,
        )
      } catch (error) {
        errorCount++
        this.componentHealth.main.errorCount++
        console.error("[v0] Main System Trade Loop error:", error)
      }

      if (this.isRunning) {
        await this.sleep(this.tradeInterval * 1000)
      }
    }

    console.log(`[v0] Main System Trade Loop stopped after ${cycleCount} cycles`)
  }

  private async processSymbolsPresetMode(symbols: string[]): Promise<void> {
    const results = await mapSettledWithConcurrency(
      symbols,
      clampConcurrency(this.maxConcurrency, 4, 8, symbols.length),
      (symbol) => this.processSymbolPreset(symbol),
    )
    const failures = results.filter((result) => result.status === "rejected")
    if (failures.length > 0) {
      console.warn(`[v0] ${failures.length} symbols failed in preset mode cycle`)
    }
  }

  private async processSymbolsMainMode(symbols: string[]): Promise<void> {
    const results = await mapSettledWithConcurrency(
      symbols,
      clampConcurrency(this.maxConcurrency, 4, 8, symbols.length),
      (symbol) => this.processSymbolMain(symbol),
    )
    const failures = results.filter((result) => result.status === "rejected")
    if (failures.length > 0) {
      console.warn(`[v0] ${failures.length} symbols failed in main mode cycle`)
    }
  }

  private async processSymbolPreset(symbol: string): Promise<void> {
    // Check if already processing (prevents duplicate work)
    if (this.presetProcessingQueue.has(symbol)) {
      return
    }

    this.presetProcessingQueue.add(symbol)

    try {
      // Indication output is a dependency of Strategy input for the same
      // symbol. The old Promise.all raced Strategy against its producer and
      // could evaluate the previous cycle's Redis snapshot. Preserve this
      // per-symbol order while symbols themselves run concurrently.
      const indications = await this.indicationProcessor.processIndication(symbol)
      await this.strategyProcessor.processStrategy(symbol, indications)
      await this.managePseudoPositionsWithValidation(symbol, "preset")

      await this.logTradeActivities(symbol, "preset")
    } catch (error) {
      console.error(`[v0] Error processing symbol ${symbol} in Preset mode:`, error)
    } finally {
      this.presetProcessingQueue.delete(symbol)
    }
  }

  private async processSymbolMain(symbol: string): Promise<void> {
    // Check if already processing
    if (this.mainProcessingQueue.has(symbol)) {
      return
    }

    this.mainProcessingQueue.add(symbol)

    try {
      // Process step-based indications
      await this.indicationStateManager.processStepBasedIndications(symbol)

      // Parallel validation and position management
      await Promise.all([
        this.positionFlowCoordinator.processRealPseudoValidation(symbol),
        this.managePseudoPositionsWithValidation(symbol, "main"),
      ])

      await this.logTradeActivities(symbol, "main")
    } catch (error) {
      console.error(`[v0] Error processing symbol ${symbol} in Main mode:`, error)
    } finally {
      this.mainProcessingQueue.delete(symbol)
    }
  }

  private async runRealPositionsLoop(): Promise<void> {
    console.log(`[v0] Starting Real Positions Loop (interval: ${this.realInterval}s)`)
    console.log("[v0] Real Positions Loop handles: Retrieve all → Update all → Send changes (batched)")
    console.log("[v0] Processes positions from BOTH Preset and Main System modes")
    console.log("[v0] Using non-overlapping progression: waits for completion before next interval")

    let cycleCount = 0
    let totalDuration = 0
    let errorCount = 0

    while (this.isRunning) {
      const startTime = Date.now()

      try {
        await this.positionFlowCoordinator.processExchangeMirroring()

        await this.realtimeProcessor.processRealtimeUpdates()

        const duration = Date.now() - startTime
        const positionCount = await this.pseudoPositionManager.getPositionCount()

        cycleCount++
        totalDuration += duration

        this.componentHealth.realtime.lastCycleDuration = duration
        this.componentHealth.realtime.successRate = ((cycleCount - errorCount) / cycleCount) * 100

        await sql`
          UPDATE trade_engine_state
          SET 
            last_real_run = CURRENT_TIMESTAMP,
            real_cycle_duration_ms = ${duration},
            active_real_positions_count = ${positionCount},
            real_cycle_count = ${cycleCount},
            real_avg_duration_ms = ${totalDuration / cycleCount}
          WHERE connection_id = ${this.connectionId}
        `

        console.log(`[v0] Real positions cycle #${cycleCount} completed in ${duration}ms, ${positionCount} positions`)
      } catch (error) {
        errorCount++
        this.componentHealth.realtime.errorCount++
        console.error("[v0] Real Positions Loop error:", error)
      }

      if (this.isRunning) {
        await this.sleep(this.realInterval * 1000)
      }
    }

    console.log(`[v0] Real Positions Loop stopped after ${cycleCount} cycles`)
  }

  private async loadPrehistoricData(): Promise<void> {
    try {
      console.log("[v0] Loading prehistoric data...")

      const [settingsRow] = await sql<{ value: string }>`
        SELECT value FROM system_settings
        WHERE key = 'timeRangeHistoryDays'
      `
      const historyDays = settingsRow ? Number.parseInt(settingsRow.value) : 5 // Default 5 days

      const [retentionRow] = await sql<{ value: string }>`
        SELECT value FROM system_settings
        WHERE key = 'marketDataRetentionDays'
      `
      const maxRetentionDays = retentionRow ? Number.parseInt(retentionRow.value) : 7
      const effectiveHistoryDays = Math.min(historyDays, maxRetentionDays)

      const symbols = await this.getSymbols()
      const endDate = new Date()
      const startDate = new Date(endDate.getTime() - effectiveHistoryDays * 24 * 60 * 60 * 1000)

      console.log(
        `[v0] Loading ${effectiveHistoryDays} days of historical data from ${startDate.toISOString()} to ${endDate.toISOString()} (parallel, concurrency=${Math.min(this.maxConcurrency, symbols.length)})`,
      )

      // ── Parallel prehistoric processing ─────────────────────────────────
      // Previously: nested sequential awaits — for every symbol the
      // process waited for indications to finish before starting
      // strategies, then moved to the next symbol. With N symbols and
      // ~5d of 1s candles per symbol this serialised dozens of seconds
      // of CPU+I/O that could run in parallel.
      //
      // Each symbol's pipeline is INDEPENDENT (different Redis
      // keyspaces, different candles, different config-set state),
      // so we fan them out with a bounded concurrency cap to avoid
      // saturating Redis or the event loop. The cap mirrors the
      // existing `maxConcurrency` used elsewhere in this engine
      // (preset / main loops) so behaviour stays consistent.
      const PREHISTORIC_CONCURRENCY = Math.max(
        1,
        Math.min(this.maxConcurrency || 8, symbols.length, 16),
      )
      const errors: Array<{ symbol: string; error: string }> = []
      await mapWithConcurrency(
        symbols,
        PREHISTORIC_CONCURRENCY,
        async (symbol) => {
          try {
            // For a single symbol, indications must produce the
            // historical sets BEFORE strategies can consume them —
            // strategy-processor reads `getHistoricalIndications`
            // for the same symbol. So we keep them serial PER symbol
            // but parallel ACROSS symbols, which is the correct
            // dependency-respecting fan-out.
            await this.indicationProcessor.processHistoricalIndications(symbol, startDate, endDate)
            await this.strategyProcessor.processHistoricalStrategies(symbol, startDate, endDate)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            errors.push({ symbol, error: msg })
            console.error(`[v0] [Prehistoric] ${symbol} failed:`, msg)
          }
        },
      )

      if (errors.length > 0) {
        console.warn(`[v0] Prehistoric data loaded with ${errors.length}/${symbols.length} symbol failures: ${errors.map((e) => e.symbol).join(", ")}`)
      } else {
        console.log(`[v0] Prehistoric data loaded successfully for ${symbols.length} symbols`)
      }
    } catch (error) {
      console.error("[v0] Failed to load prehistoric data:", error)
      throw error
    }
  }

  private async logTradeActivities(symbol: string, mode: "preset" | "main"): Promise<void> {
    try {
      const [stats] = await sql`
        SELECT 
          COUNT(DISTINCT i.id) as indication_count,
          COUNT(DISTINCT p.id) as position_count,
          AVG(p.profit_factor) as avg_profit_factor
        FROM indications i
        LEFT JOIN pseudo_positions p ON p.symbol = i.symbol AND p.mode = i.mode
        WHERE i.connection_id = ${this.connectionId}
          AND i.symbol = ${symbol}
          AND i.mode = ${mode}
          AND i.calculated_at > NOW() - INTERVAL '1 minute'
      `

      await sql`
        INSERT INTO trade_logs (
          connection_id, symbol, mode, log_type, log_data, created_at
        )
        VALUES (
          ${this.connectionId}, ${symbol}, ${mode}, 'trade_cycle',
          ${JSON.stringify(stats)},
          CURRENT_TIMESTAMP
        )
      `
    } catch (error) {
      console.error(`[v0] Failed to log trade activities for ${symbol} in ${mode} mode:`, error)
    }
  }

  private async getSymbolsCached(): Promise<string[]> {
    const now = Date.now()

    if (this.settingsCache && now - this.settingsCache.lastUpdate < 60000) {
      return this.settingsCache.symbols
    }

    const symbols = await this.getSymbols()

    this.settingsCache = {
      ...this.settingsCache,
      symbols,
      lastUpdate: now,
    } as SettingsCache

    return symbols
  }

  private async getSymbols(): Promise<string[]> {
    try {
      const settings = await sql`
        SELECT key, value FROM system_settings
        WHERE key IN ('useMainSymbols', 'mainSymbols', 'forcedSymbols', 'arrangementType', 'arrangementCount', 'quoteAsset')
      `

      const settingsMap = new Map(settings.map((s: any) => [s.key, s.value]))

      const useMainSymbols = settingsMap.get("useMainSymbols") === "true"
      const forcedSymbols = JSON.parse(String(settingsMap.get("forcedSymbols") || "[]"))
      const quoteAsset = settingsMap.get("quoteAsset") || "USDT"

      let baseSymbols: string[] = []

      if (useMainSymbols) {
        const mainSymbols = JSON.parse(String(settingsMap.get("mainSymbols") || "[]"))
        baseSymbols = mainSymbols
      } else {
        const arrangementType = String(settingsMap.get("arrangementType") || "marketCap24h")
        const arrangementCount = Number.parseInt(String(settingsMap.get("arrangementCount") || "30"))
        baseSymbols = await this.getSymbolsByArrangement(arrangementType, arrangementCount)
      }

      const allBaseSymbols = [...new Set([...forcedSymbols, ...baseSymbols])]

      const fullSymbols = allBaseSymbols.map((base) => `${base}${quoteAsset}`)

      console.log(`[v0] Selected ${fullSymbols.length} symbols:`, fullSymbols.slice(0, 10), "...")

      return fullSymbols
    } catch (error) {
      console.error("[v0] Failed to get symbols:", error)
      return ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"]
    }
  }

  private async getSymbolsByArrangement(arrangementType: string, count: number): Promise<string[]> {
    try {
      let orderBy = "volume_24h DESC" // default

      switch (arrangementType) {
        case "marketCap24h":
          orderBy = "market_cap DESC"
          break
        case "marketVolume":
          orderBy = "volume_24h DESC"
          break
        case "marketVolatility":
          orderBy = "price_change_24h_abs DESC"
          break
        case "priceChange24h":
          orderBy = "price_change_24h DESC"
          break
        case "liquidityScore":
          orderBy = "liquidity_score DESC"
          break
      }

      const limitPlaceholder = getDatabaseType() === "sqlite" ? "?" : "$1"
      const symbols = await query<any>(
        `
        SELECT REPLACE(symbol, 'USDT', '') as base_symbol 
        FROM trading_pairs
        WHERE is_active = true 
          AND symbol LIKE '%USDT'
        ORDER BY ${orderBy}
        LIMIT ${limitPlaceholder}
      `,
        [count],
      )

      return symbols.map((s: any) => s.base_symbol)
    } catch (error) {
      console.error(`[v0] Failed to get symbols by arrangement ${arrangementType}:`, error)
      // Fallback to default symbols
      return ["BTC", "ETH", "BNB", "XRP", "ADA", "SOL", "DOT", "MATIC", "AVAX", "LINK"]
    }
  }

  private startHealthMonitoring(): void {
    const healthCheckInterval = 10000 // Check every 10 seconds

    console.log(`[v0] Starting ${TRADE_SERVICE_NAME} health monitoring (interval: 10s)`)

    this.healthCheckInterval = setInterval(async () => {
      if (!this.isRunning) return

      try {
        // Update component health statuses
        this.componentHealth.preset.status = this.getComponentHealthStatus(
          this.componentHealth.preset.successRate,
          this.componentHealth.preset.lastCycleDuration,
          this.tradeInterval * 1000,
        )

        this.componentHealth.main.status = this.getComponentHealthStatus(
          this.componentHealth.main.successRate,
          this.componentHealth.main.lastCycleDuration,
          this.tradeInterval * 1000,
        )

        this.componentHealth.realtime.status = this.getComponentHealthStatus(
          this.componentHealth.realtime.successRate,
          this.componentHealth.realtime.lastCycleDuration,
          this.realInterval * 1000,
        )

        // Calculate overall health
        const overallHealth = this.calculateOverallHealth()

        // Update database with health status
        await sql`
          UPDATE trade_engine_state
          SET 
            health_status = ${overallHealth},
            preset_health = ${this.componentHealth.preset.status},
            main_health = ${this.componentHealth.main.status},
            realtime_health = ${this.componentHealth.realtime.status},
            last_health_check = CURRENT_TIMESTAMP
          WHERE connection_id = ${this.connectionId}
        `

        // Log if health is degraded or unhealthy
        if (overallHealth !== "healthy") {
          console.warn(`[v0] ${TRADE_SERVICE_NAME} health for ${this.connectionId}: ${overallHealth}`)
        }
      } catch (error) {
        console.error(`[v0] ${TRADE_SERVICE_NAME} health monitoring error:`, error)
      }
    }, healthCheckInterval)
  }

  private getComponentHealthStatus(
    successRate: number,
    lastCycleDuration: number,
    expectedInterval: number,
  ): "healthy" | "degraded" | "unhealthy" {
    if (successRate < 80 || lastCycleDuration > expectedInterval * 3) {
      return "unhealthy"
    }
    if (successRate < 95 || lastCycleDuration > expectedInterval * 2) {
      return "degraded"
    }
    return "healthy"
  }

  private calculateOverallHealth(): "healthy" | "degraded" | "unhealthy" {
    const components = [
      this.componentHealth.preset.status,
      this.componentHealth.main.status,
      this.componentHealth.realtime.status,
    ]

    const unhealthyCount = components.filter((s) => s === "unhealthy").length
    const degradedCount = components.filter((s) => s === "degraded").length

    if (unhealthyCount > 0) return "unhealthy"
    if (degradedCount > 0) return "degraded"
    return "healthy"
  }

  getHealthStatus() {
    return {
      overall: this.calculateOverallHealth(),
      components: {
        preset: { ...this.componentHealth.preset },
        main: { ...this.componentHealth.main },
        realtime: { ...this.componentHealth.realtime },
      },
      lastCheck: new Date(),
    }
  }

  async getStatus() {
    try {
      const [state] = await sql`
        SELECT * FROM trade_engine_state
        WHERE connection_id = ${this.connectionId}
      `
      return {
        ...(state || {}),
        streamStatus: this.realtimeProcessor.getStreamStatus(),
        presetProcessingQueueSize: this.presetProcessingQueue.size,
        mainProcessingQueueSize: this.mainProcessingQueue.size,
        health: this.getHealthStatus(),
      }
    } catch (error) {
      return null
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async loadEngineSettings(): Promise<void> {
    try {
      const settings = await sql`
        SELECT key, value FROM system_settings
        WHERE key IN (
          'mainEngineEnabled',
          'presetEngineEnabled', 
          'mainEngineIntervalMs',
          'presetEngineIntervalMs',
          'activeOrderHandlingIntervalMs',
          'positionCooldownMs',
          'maxPositionsPerConfigDirection',
          'maxConcurrentOperations',
          'negativeChangePercent',
          'positionCost',
          'baseVolumeFactor',
          'leveragePercentage',
          'useMaximalLeverage'
        )
      `

      const settingsMap = new Map(settings.map((s: any) => [s.key, s.value]))

      const mainIntervalMs = Number.parseInt(String(settingsMap.get("mainEngineIntervalMs") || "100"))
      const presetIntervalMs = Number.parseInt(String(settingsMap.get("presetEngineIntervalMs") || "100"))

      // Convert ms to seconds for internal use
      this.tradeInterval = mainIntervalMs / 1000
      this.realInterval = Number.parseInt(String(settingsMap.get("activeOrderHandlingIntervalMs") || "50")) / 1000

      this.maxConcurrency = Number.parseInt(String(settingsMap.get("maxConcurrentOperations") || "100"))

      console.log(
        `[v0] Loaded engine settings: mainInterval=${this.tradeInterval}s, realInterval=${this.realInterval}s, maxConcurrency=${this.maxConcurrency}`,
      )
    } catch (error) {
      console.error("[v0] Failed to load engine settings:", error)
    }
  }

  private async updateEngineState(
    status: "starting" | "running" | "stopped" | "error",
    errorMessage?: string,
  ): Promise<void> {
    try {
      // Check if state record exists
      const [existing] = await sql`
        SELECT id FROM trade_engine_state
        WHERE connection_id = ${this.connectionId}
      `

      if (existing) {
        // Update existing record
        await sql`
          UPDATE trade_engine_state
          SET 
            status = ${status},
            error_message = ${errorMessage || null},
            updated_at = CURRENT_TIMESTAMP
          WHERE connection_id = ${this.connectionId}
        `
      } else {
        // Create new record
        await sql`
          INSERT INTO trade_engine_state (
            connection_id, status, error_message, created_at, updated_at
          )
          VALUES (
            ${this.connectionId}, ${status}, ${errorMessage || null}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
        `
      }

      console.log(`[v0] ${TRADE_SERVICE_NAME} state updated to: ${status}`)
    } catch (error) {
      console.error(`[v0] Failed to update engine state:`, error)
    }
  }

  private async managePseudoPositionsWithValidation(symbol: string, mode: "preset" | "main"): Promise<void> {
    try {
      const baseIndications = await sql`
        SELECT * FROM indications
        WHERE connection_id = ${this.connectionId}
          AND symbol = ${symbol}
          AND mode = ${mode}
          AND calculated_at > NOW() - INTERVAL '5 minutes'
          AND profit_factor >= 0.7
        ORDER BY calculated_at DESC
        LIMIT 5
      `

      if (baseIndications.length === 0) return

      const mainSignals = await sql`
        SELECT * FROM pseudo_positions
        WHERE connection_id = ${this.connectionId}
          AND symbol = ${symbol}
          AND mode = ${mode}
          AND status = 'active'
          AND profit_factor >= 0.6
          AND created_at > NOW() - INTERVAL '1 hour'
      `

      for (const signal of mainSignals) {
        if (await this.isValidatedForReal(signal)) {
          await this.createRealPseudoPosition(symbol, signal, mode)
        }
      }
    } catch (error) {
      console.error(`[v0] Error managing pseudo positions for ${symbol} in ${mode} mode:`, error)
    }
  }

  private async isValidatedForReal(mainPosition: any): Promise<boolean> {
    try {
      const profitFactor = Number.parseFloat(mainPosition.profit_factor)
      const createdAt = new Date(mainPosition.created_at)
      const now = new Date()
      const hoursSinceCreation = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60)

      const meetsMinProfitFactor = profitFactor >= 0.6
      const withinDrawdownTime = hoursSinceCreation <= 12

      const [existing] = await sql`
        SELECT id FROM real_pseudo_positions
        WHERE main_position_id = ${mainPosition.id}
      `

      return meetsMinProfitFactor && withinDrawdownTime && !existing
    } catch (error) {
      console.error("[v0] Error validating for real:", error)
      return false
    }
  }

  private async createRealPseudoPosition(symbol: string, mainPosition: any, mode: "preset" | "main"): Promise<void> {
    try {
      await sql`
        INSERT INTO real_pseudo_positions (
          connection_id, main_position_id, symbol, side, mode,
          entry_price, quantity, status, validated_at
        )
        VALUES (
          ${this.connectionId}, ${mainPosition.id}, ${symbol}, ${mainPosition.side}, ${mode},
          ${mainPosition.entry_price}, ${mainPosition.quantity}, 'validated', CURRENT_TIMESTAMP
        )
      `

      console.log(`[v0] Created real pseudo position for ${symbol} in ${mode} mode`)
    } catch (error) {
      console.error(`[v0] Error creating real pseudo position for ${symbol}:`, error)
    }
  }
}
