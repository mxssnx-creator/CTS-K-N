/**
 * Config Set Processor
 * Processes prehistoric data through indication and strategy config managers
 * Each configuration combination calculates independently and stores results
 * 
 * Phase 5-6 Implementation: Fills config sets with calculated results
 */

import { IndicationConfigManager, IndicationResult, IndicationConfig } from "@/lib/indication-config-manager"
import { StrategyConfigManager, PseudoPosition, StrategyConfig } from "@/lib/strategy-config-manager"
import { getRedisClient, initRedis, setSettings, getAppSettings, getConnection } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { canonicalTotalForSymbols, clampProcessedToTotal, getCanonicalSymbolSelection, ownsCanonicalSymbolSelectionEpoch } from "@/lib/trade-engine/symbol-selection-ownership"
import { calculatePseudoClosePnl } from "@/lib/pseudo-position-costs"
import { emitEngineStageAck } from "@/lib/engine-stage-ack"
import { buildProgressionScope } from "@/lib/progression-scope"
import {
  concurrencyFromEnv,
  createAdaptiveConcurrencyLimiter,
  forEachWithConcurrency,
  mapWithConcurrency,
} from "@/lib/bounded-concurrency"
import { getHistoricCandlesForRange } from "./market-data-cache"
import { normalizeMarketType } from "@/lib/market-types"
// Diagnostics must never synchronously write to disk during strategy preparation.
// Kept opt-in so an operator can isolate a slow Historic phase without adding
// a hot-path allocation or persistent log volume in ordinary production.
const HISTORIC_DEBUG_TIMING_ENV_KEY = ["CTS", "ENGINE", "DEBUG", "TIMING"].join("_")
const __DBGC = (message: string): void => {
  // Resolve the name dynamically so this remains an operator-controlled
  // production diagnostic instead of being removed by Next's build-time env
  // substitution.
  if (process.env[HISTORIC_DEBUG_TIMING_ENV_KEY] === "1") {
    // Production strips console.log; this explicit diagnostic stays visible
    // through the retained warning channel only when the operator enables it.
    console.warn(`[v0] [HistoricTiming] ${message}`)
  }
}
import { ENGINE_STAGE_HISTORY_CANDLES } from "@/lib/market-data-loader"
import {
  clearHistoricCalculationState,
  clearHistoricAggregateMarkers,
  clearHistoricListCompletionMarkers,
  incrementHistoricAggregateOnce,
  incrementHistoricAggregatesOnce,
} from "@/lib/redis-idempotent-list"
import {
  getRuntimeCapabilityConcurrency,
  getRuntimeConcurrencyProfile,
} from "@/lib/runtime-concurrency-profile"
import {
  HISTORIC_FOUR_HOUR_BUCKET_HOURS,
  HISTORIC_FOUR_HOUR_PF_MINIMUM,
  HISTORIC_FOUR_HOUR_PF_NEUTRAL,
  HISTORIC_FOUR_HOUR_SCHEMA_VERSION,
  createHistoricFourHourAccumulator,
  historicFourHourBucketStarts,
  historicFourHourRedisIncrements,
  markHistoricFourHourCoverage,
  recordHistoricFourHourIndications,
  recordHistoricFourHourPositions,
  type HistoricFourHourAccumulator,
} from "@/lib/historic-four-hour-stats"

type HistoricCalculationRunner = <T>(task: () => Promise<T>) => Promise<T>

/**
 * A complete historic grid can spend minutes inside the first symbol. Symbol
 * completion is consequently too coarse to prove liveness. These bounded
 * calculation-group updates let the UI show real work without declaring a
 * partially processed symbol complete.
 */
type HistoricWorkReporter = (
  stage: "indications" | "strategies",
  success: boolean,
) => void

interface HistoricIndicationWindowSeries {
  directions: Int8Array
  magnitudes: Float64Array
}

type HistoricIndicationResultsByConfig = Map<string, IndicationResult[]>

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

// Historical calculations run inside the API/engine process.  Keep every
// calculation complete, but return control often enough for health, cron and
// lease-recovery work to run while an initial long-range bootstrap is active.
// This is deliberately an environment setting rather than a strategy value:
// changing it affects scheduling only, never evaluation results.
const HISTORIC_CALC_YIELD_EVERY = Math.max(
  64,
  Math.min(8192, Number.parseInt(process.env.PREHISTORIC_CALC_YIELD_EVERY || "256", 10) || 256),
)

function groupConfigsByType<T extends { type?: string }>(configs: T[]): Array<[string, T[]]> {
  const grouped = new Map<string, T[]>()
  for (const config of configs) {
    const type = config.type || "unknown"
    const bucket = grouped.get(type)
    if (bucket) bucket.push(config)
    else grouped.set(type, [config])
  }
  return Array.from(grouped.entries())
}

function historicStrategyCalculationUnitCount(configs: readonly StrategyConfig[]): number {
  let count = 0
  for (const [, typeConfigs] of groupConfigsByType([...configs])) {
    const fingerprints = new Set<string>()
    for (const config of typeConfigs) {
      fingerprints.add([
        config.type,
        Number(config.position_cost_step),
        Number(config.takeprofit),
        Number(config.stoploss),
        Boolean(config.trailing),
      ].join("|"))
    }
    count += fingerprints.size
  }
  return count
}

/**
 * The legacy historic indication calculator currently consumes only these
 * four numeric inputs; `type` is a display/configuration identity and does not
 * alter the pure calculation. Grouping across type labels is therefore exact,
 * not sampling: every config keeps its own aggregate and enabled state while
 * one result vector is reused for mathematically identical inputs.
 */
export function groupHistoricIndicationCalculationConfigs(
  configs: readonly IndicationConfig[],
): IndicationConfig[][] {
  const groups = new Map<string, IndicationConfig[]>()
  for (const config of configs) {
    const fingerprint = [
      Number(config.steps),
      Number(config.drawdown_ratio),
      Number(config.active_ratio),
      Number(config.last_part_ratio),
    ].join("|")
    const bucket = groups.get(fingerprint)
    if (bucket) bucket.push(config)
    else groups.set(fingerprint, [config])
  }
  return [...groups.values()].map((group) =>
    [...group].sort((left, right) => String(left.id).localeCompare(String(right.id))),
  )
}

/**
 * Arrange exact factor groups by the price-window geometry they share. This
 * must not merge factor groups: it merely lets the historic calculator visit
 * one geometry once and materialise each factor's independent result vector.
 */
export function groupHistoricIndicationCalculationGroupsByGeometry(
  calculationGroups: readonly IndicationConfig[][],
): IndicationConfig[][][] {
  const groups = new Map<string, IndicationConfig[][]>()
  for (const calculationConfigs of calculationGroups) {
    const reference = calculationConfigs[0]
    if (!reference) continue
    const key = `${Number(reference.steps)}|${Number(reference.last_part_ratio)}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(calculationConfigs)
    else groups.set(key, [calculationConfigs])
  }
  return [...groups.values()]
}

interface HistoricPricePoint {
  price: number
  timestamp: string
}

interface HistoricPriceSeries {
  points: HistoricPricePoint[]
  prices: number[]
  /** prefixSums[n] is the exact accumulated price sum before index n. */
  prefixSums: number[]
  averageBarVolatility: number
}

function normalizeHistoricTimestamp(value: unknown): number {
  if (typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))) {
    let numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) {
      // Exchange payloads use both epoch seconds and epoch milliseconds.
      if (numeric < 100_000_000_000) numeric *= 1000
      return numeric
    }
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

function buildHistoricPriceSeries(candles: readonly any[]): HistoricPriceSeries {
  const points: HistoricPricePoint[] = []
  for (const candle of candles || []) {
    const price = Number(candle?.close ?? candle?.price ?? candle?.last ?? 0)
    const timestamp = normalizeHistoricTimestamp(
      candle?.timestamp ?? candle?.time ?? candle?.openTime,
    )
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(timestamp) || timestamp <= 0) continue
    points.push({ price, timestamp: new Date(timestamp).toISOString() })
  }

  const prices = points.map((point) => point.price)
  const prefixSums = new Array<number>(prices.length + 1)
  prefixSums[0] = 0
  let volatilitySum = 0
  let volatilityCount = 0
  for (let index = 0; index < prices.length; index++) {
    prefixSums[index + 1] = prefixSums[index] + prices[index]
    if (index === 0) continue
    const previous = prices[index - 1]
    volatilitySum += Math.abs(prices[index] - previous) / previous
    volatilityCount++
  }

  return {
    points,
    prices,
    prefixSums,
    averageBarVolatility: volatilityCount > 0 ? volatilitySum / volatilityCount : 0,
  }
}

export const HISTORIC_STRATEGY_ENTRY_THRESHOLD_MIN = 0.00005
export const HISTORIC_STRATEGY_ENTRY_THRESHOLD_MAX = 0.002

/**
 * Resolve the strategy replay entry threshold from the actual bar cadence.
 *
 * The legacy fixed 0.20% threshold was written for minute candles. After the
 * canonical feed moved to one-second bars, even a complete 90-minute fixture
 * typically moves only ~0.004% per bar and could never open a pseudo-position.
 * The adaptive threshold preserves the legacy 0.20% ceiling on volatile data,
 * while keeping a 0.005% noise floor for flat/synthetic second histories.
 */
export function resolveHistoricStrategyEntryThreshold(averageBarVolatility: unknown): number {
  const volatility = Number(averageBarVolatility)
  const safeVolatility = Number.isFinite(volatility) && volatility > 0 ? volatility : 0
  return Math.min(
    HISTORIC_STRATEGY_ENTRY_THRESHOLD_MAX,
    Math.max(HISTORIC_STRATEGY_ENTRY_THRESHOLD_MIN, safeVolatility * 1.5),
  )
}

function historicGenerationFromScope(scope: string): string {
  const separator = scope.lastIndexOf(":")
  return (separator > 0 ? scope.slice(0, separator) : scope).replace(/[^A-Za-z0-9._-]/g, "_")
}

function historicAggregateKey(connectionId: string, kind: "indications" | "strategies", generation: string): string {
  return `historic:aggregate:${connectionId}:${kind}:${generation}`
}

export function historicFourHourAggregateKey(connectionId: string, generation: string): string {
  return `historic:aggregate:${connectionId}:four-hour:${generation}`
}

export function historicProcessedIntervalsKey(
  connectionId: string,
  symbol: string,
  generation: string,
): string {
  const normalizedSymbol = String(symbol || "unknown").replace(/[^A-Za-z0-9._-]/g, "_")
  const normalizedGeneration = String(generation || "legacy").replace(/[^A-Za-z0-9._-]/g, "_")
  return `prehistoric:${connectionId}:${normalizedSymbol}:processed_intervals:${normalizedGeneration}`
}

function historicAggregateMarkerKey(
  connectionId: string,
  kind: "indication" | "strategy" | "four-hour",
  configId: string,
  scope: string,
): string {
  return `historic:aggregate-marker:${connectionId}:${kind}:${configId}:${scope.replace(/[^A-Za-z0-9._:-]/g, "_")}`
}

/**
 * The aggregate key already scopes a marker to one connection, kind and
 * historic generation.  Store only the exact config/symbol identity inside
 * its idempotency Set instead of repeating the complete Redis key hundreds of
 * thousands of times during a full 32-symbol indication bootstrap.
 *
 * JSON makes the pair unambiguous even for imported/custom config IDs.  The
 * full marker key is still supplied to the aggregate helper for rolling-upgrade
 * compatibility with scalar and older full-key marker members.
 */
function historicAggregateMarkerMember(configId: string, scope: string): string {
  const normalizedScope = String(scope || "")
  const separator = normalizedScope.lastIndexOf(":")
  const symbol = separator >= 0
    ? normalizedScope.slice(separator + 1)
    : normalizedScope
  return JSON.stringify([String(configId || ""), symbol])
}

export interface ProcessingResult {
  indicationConfigs: number
  indicationResults: number
  strategyConfigs: number
  strategyPositions: number
  symbolsTotal: number
  symbolsProcessed: number
  symbolsWithoutData: number
  candlesProcessed: number
  errors: number
  duration: number
  // Interval-stepping metrics
  intervalsProcessed: number
  missingIntervalsLoaded: number
  timeframeSeconds: number
  rangeStartMs: number
  rangeEndMs: number
}

export interface PrehistoricProcessingOptions {
  finalizePhase?: boolean
  shouldContinue?: () => boolean
  symbolSelectionEpoch?: string
  /**
   * Reports completed calculation groups to an enclosing owner-aware
   * admission. This is real work progress, not a timer heartbeat.
   */
  onProgress?: (progress: {
    stage: "indications" | "strategies"
    symbol: string
    completedUnits: number
    totalUnits: number
  }) => void
}

class PrehistoricProcessingCancelledError extends Error {
  constructor(connectionId: string) {
    super(`Historic processing for ${connectionId} was superseded`)
    this.name = "PrehistoricProcessingCancelledError"
  }
}

export class ConfigSetProcessor {
  private connectionId: string
  private epoch: number
  private indicationManager: IndicationConfigManager
  private strategyManager: StrategyConfigManager

  constructor(connectionId: string, epoch: number) {
    this.connectionId = connectionId
    this.epoch = epoch
    this.indicationManager = new IndicationConfigManager(connectionId)
    this.strategyManager = new StrategyConfigManager(connectionId)
  }

  /**
   * Initialize default config sets if they don't exist
   * Creates baseline configurations for indications and strategies
   */
  async initializeConfigSets(): Promise<{ indications: number; strategies: number }> {
    console.log(`[v0] [ConfigSetProcessor] Initializing config sets for ${this.connectionId}`)

    __DBGC(`INIT_before_existing_indications ${this.connectionId}`)
    const existingIndications = await this.indicationManager.getAllConfigs()
    __DBGC(`INIT_after_existing_indications ${this.connectionId} count=${existingIndications.length}`)
    const existingStrategies = await this.strategyManager.getAllConfigs()
    __DBGC(`INIT_after_existing_strategies ${this.connectionId} count=${existingStrategies.length}`)

    let newIndications = 0
    let newStrategies = 0

    if (existingIndications.length === 0) {
      console.log(`[v0] [ConfigSetProcessor] Creating default indication configs...`)
      __DBGC(`INIT_before_generate_indications ${this.connectionId}`)
      const indicationConfigs = await this.indicationManager.generateDefaultConfigs()
      __DBGC(`INIT_after_generate_indications ${this.connectionId} count=${indicationConfigs.length}`)
      newIndications = indicationConfigs.length
      console.log(`[v0] [ConfigSetProcessor] Created ${newIndications} indication configs`)
    } else {
      console.log(`[v0] [ConfigSetProcessor] Found ${existingIndications.length} existing indication configs`)
    }

    if (existingStrategies.length === 0) {
      console.log(`[v0] [ConfigSetProcessor] Creating default strategy configs...`)
      __DBGC(`INIT_before_generate_strategies ${this.connectionId}`)
      const strategyConfigs = await this.strategyManager.generateDefaultConfigs()
      __DBGC(`INIT_after_generate_strategies ${this.connectionId} count=${strategyConfigs.length}`)
      newStrategies = strategyConfigs.length
      console.log(`[v0] [ConfigSetProcessor] Created ${newStrategies} strategy configs`)
    } else {
      console.log(`[v0] [ConfigSetProcessor] Found ${existingStrategies.length} existing strategy configs`)
    }

    return {
      indications: existingIndications.length + newIndications,
      strategies: existingStrategies.length + newStrategies,
    }
  }

  /**
   * Process prehistoric data through all config sets.
   * Processes ONLY missing time intervals (skips already-loaded ranges).
   * Steps through the full time range one timeframe interval at a time.
   *
   * @param symbols       - Symbols to process
   * @param rangeStart    - Start of the historical range (default: now - 1 day)
   * @param rangeEnd      - End of the historical range (default: now)
   * @param timeframeSec  - Timeframe interval in seconds (default: 1 = 1-second bars)
   */
  async processPrehistoricData(
    symbols: string[],
    rangeStart?: Date,
    rangeEnd?: Date,
    timeframeSec: number = 1,
    options: PrehistoricProcessingOptions = {},
  ): Promise<ProcessingResult> {
    const startTime = Date.now()
    const now = new Date()
    const effectiveEnd = rangeEnd ?? now
    // Default fallback — 8 hours, matches engine-manager DEFAULT_RANGE_HOURS.
    const effectiveStart = rangeStart ?? new Date(now.getTime() - 8 * 60 * 60 * 1000)
    await initRedis()
    const connection = await getConnection(this.connectionId).catch(() => null)
    const marketType = normalizeMarketType(
      connection?.market_type ?? connection?.asset_class,
      connection?.exchange,
    )
    // InstaForex publishes chart history at M1 granularity. The engine's
    // default 1-second setting remains valid for crypto, but repeating the
    // same M1 candle across sixty synthetic 1-second buckets would inflate
    // historic counts and make FX signals look fresher than they are.
    const processingTimeframeSec = marketType === "forex"
      ? Math.max(60, Math.floor(Number(timeframeSec) || 1))
      : Math.max(1, Math.floor(Number(timeframeSec) || 1))
    const intervalMs = processingTimeframeSec * 1000
    const runtimeConcurrency = getRuntimeConcurrencyProfile(symbols.length)

    // Bounded nested budgets. The former defaults (8 symbols × 8 types ×
    // 24 configs, twice for indication+strategy) could schedule hundreds of
    // large calculations at once. These pools still overlap independent I/O
    // and config work, but cap outer fan-out and divide each domain's total
    // config budget across active types.
    const SYMBOL_CONCURRENCY = concurrencyFromEnv(
      ["PREHISTORIC_SYMBOL_CONCURRENCY"],
      runtimeConcurrency.historicSymbolConcurrency,
      4,
      symbols.length,
    )
    const CONFIG_CONCURRENCY = concurrencyFromEnv(
      ["PREHISTORIC_CONFIG_CONCURRENCY"],
      runtimeConcurrency.calculationConcurrency,
      8,
    )
    const CONFIG_TYPE_CONCURRENCY = concurrencyFromEnv(
      ["PREHISTORIC_CONFIG_TYPE_CONCURRENCY"],
      runtimeConcurrency.indicationTypeConcurrency,
      4,
    )
    // Keep one host-wide I/O budget even though symbol and calculation pools
    // are nested. On the measured 9-CPU profile this resolves to four writes
    // per active calculation group: up to 16 concurrent Redis operations,
    // leaving control-plane headroom while avoiding one-by-one persistence.
    const PERSIST_CONCURRENCY = concurrencyFromEnv(
      ["PREHISTORIC_PERSIST_CONCURRENCY"],
      Math.max(
        1,
        Math.floor(
          runtimeConcurrency.ioConcurrency /
          Math.max(1, SYMBOL_CONCURRENCY * CONFIG_CONCURRENCY),
        ),
      ),
      32,
    )
    // Indication and strategy calculations are launched as independent async
    // branches for each symbol. One shared limiter keeps their combined CPU
    // use inside the current host capability instead of allowing each nested
    // pool to consume the full budget independently.
    const calculationLimiter = createAdaptiveConcurrencyLimiter(
      CONFIG_CONCURRENCY,
      () => Math.min(
        CONFIG_CONCURRENCY,
        getRuntimeCapabilityConcurrency("cpu", Number.POSITIVE_INFINITY),
      ),
    )
    const runCalculation: HistoricCalculationRunner = (task) => calculationLimiter.run(task)

    const assertRunActive = () => {
      if (options.shouldContinue && !options.shouldContinue()) {
        throw new PrehistoricProcessingCancelledError(this.connectionId)
      }
    }
    const initialSelection = await getCanonicalSymbolSelection(this.connectionId)
    const writerSelectionEpoch = options.symbolSelectionEpoch ?? initialSelection?.epoch ?? ""
    const historicGeneration = historicGenerationFromScope(
      `${writerSelectionEpoch || this.epoch}:all`,
    )
    const fourHourAggregateKey = historicFourHourAggregateKey(
      this.connectionId,
      historicGeneration,
    )
    const canonicalSymbolsTotal = await canonicalTotalForSymbols(this.connectionId, symbols)
    const ownsCurrentSelection = await ownsCanonicalSymbolSelectionEpoch(this.connectionId, symbols, writerSelectionEpoch)
    const stillOwnsCurrentSelection = () => ownsCanonicalSymbolSelectionEpoch(this.connectionId, symbols, writerSelectionEpoch)
    const assertCurrentSelection = async () => {
      assertRunActive()
      if (!(await stillOwnsCurrentSelection())) {
        throw new PrehistoricProcessingCancelledError(this.connectionId)
      }
      assertRunActive()
    }
    assertRunActive()
    if (!ownsCurrentSelection) throw new PrehistoricProcessingCancelledError(this.connectionId)

    console.log(
      `[v0] [ConfigSetProcessor] ▶ prehistoric start | symbols=${symbols.length} canonicalTotal=${canonicalSymbolsTotal} | ` +
      `range=${effectiveStart.toISOString()} → ${effectiveEnd.toISOString()} | ` +
      `timeframe=${processingTimeframeSec}s | market=${marketType} | symbolConcurrency=${SYMBOL_CONCURRENCY} | configTypeConcurrency=${CONFIG_TYPE_CONCURRENCY} | ` +
      `configConcurrency=${CONFIG_CONCURRENCY} | persistConcurrency=${PERSIST_CONCURRENCY}`
    )

    await assertCurrentSelection()
    const client = getRedisClient()
    const progressionScope = buildProgressionScope(this.connectionId, "main")
    const prehistoricKey = progressionScope.prehistoricKey
    const prehistoricSymbolsKey = `${prehistoricKey}:symbols`
    let alreadyProcessedSymbols = Number(await client.scard(prehistoricSymbolsKey).catch(() => 0)) || 0
    const previousFourHourAggregate = await client
      .hgetall(fourHourAggregateKey)
      .catch(() => ({} as Record<string, string>))
    const previousGenerationComplete =
      previousFourHourAggregate.complete === "1" ||
      previousFourHourAggregate.complete === "true"
    const startsFreshCompletedGeneration =
      previousGenerationComplete &&
      (alreadyProcessedSymbols === 0 || alreadyProcessedSymbols >= canonicalSymbolsTotal)

    // A completed projection is immutable. If its canonical symbol SET was
    // cleared/expired, or a full owner explicitly starts it again, this is a
    // fresh calculation cycle. Delete the HASH values together with their
    // markers and interval checkpoints; clearing only markers is precisely
    // what caused repeated config/symbol rows to accumulate in production.
    if (startsFreshCompletedGeneration) {
      await Promise.all([
        clearHistoricCalculationState(client, this.connectionId),
        clearHistoricListCompletionMarkers(client, this.connectionId),
        client.del(prehistoricSymbolsKey),
      ])
      alreadyProcessedSymbols = 0
      console.warn(
        `[v0] [ConfigSetProcessor] Reset completed historic aggregate before fresh generation ` +
        `${historicGeneration}`,
      )
    }
    const engineProgressionKey = progressionScope.engineProgressionKey
    const legacyEngineProgressionKey = `engine_progression:${this.connectionId}`
    const mirrorProgressHash = async (patch: Record<string, any>) => {
      const stringPatch = Object.fromEntries(
        Object.entries(patch).map(([key, value]) => [key, typeof value === "string" ? value : String(value)]),
      )
      await Promise.all([
        client.hset(progressionScope.progressionKey, {
          ...stringPatch,
          connection_id: this.connectionId,
          engine_type: progressionScope.engineType,
          symbol_selection_epoch: writerSelectionEpoch,
        }).catch(() => 0),
        client.hset(progressionScope.legacyProgressionKey, {
          ...stringPatch,
          symbol_selection_epoch: writerSelectionEpoch,
        }).catch(() => 0),
      ])
    }
    const hincrProgressHash = async (field: string, amount: number) => {
      await Promise.all([
        client.hincrby(progressionScope.progressionKey, field, amount).catch(() => 0),
        client.hincrby(progressionScope.legacyProgressionKey, field, amount).catch(() => 0),
      ])
    }
    const setEngineProgress = async (patch: Record<string, unknown>) => {
      const stamped = {
        ...patch,
        connection_id: this.connectionId,
        engine_type: progressionScope.engineType,
        symbol_selection_epoch: writerSelectionEpoch,
        updated_at: String(patch.updated_at || new Date().toISOString()),
      }
      await Promise.all([
        setSettings(engineProgressionKey, stamped).catch(() => undefined),
        setSettings(legacyEngineProgressionKey, stamped).catch(() => undefined),
      ])
    }

    await assertCurrentSelection()

    // Mutable aggregates updated from parallel workers — guard with a lightweight
    // local function since JS is single-threaded inside the event loop there's
    // no true race, but this keeps the reads/writes explicit.
    let totalIndicationResults = 0
    let totalStrategyPositions = 0
    let symbolsProcessed = 0
    let symbolsWithoutData = 0
    let candlesProcessed = 0
    let errors = 0
    let totalIntervalsProcessed = 0
    let missingIntervalsLoaded = 0

    const tConfigsStart = Date.now()
    const [allIndicationConfigs, allStrategyConfigs] = await Promise.all([
      this.indicationManager.getEnabledConfigs(),
      this.strategyManager.getEnabledConfigs(),
    ])
    await assertCurrentSelection()
    // Bootstrap/replay processes every enabled configuration. Concurrency is
    // bounded below, but selection is never truncated by a top-K core.
    const indicationConfigs = allIndicationConfigs
    const strategyConfigs = allStrategyConfigs
    const indicationCalculationGroups = groupHistoricIndicationCalculationConfigs(indicationConfigs)
    await this.indicationManager.setResultReferences(
      indicationCalculationGroups.flatMap((group) => {
        const referenceConfigId = group[0]?.id || ""
        return group.map((config) => ({ configId: config.id, referenceConfigId }))
      }),
    )
    await assertCurrentSelection()
    const tConfigsMs = Date.now() - tConfigsStart

    console.log(
      `[v0] [ConfigSetProcessor] loaded exhaustive bootstrap grids: ` +
      `${indicationConfigs.length} indication configs, ` +
      `${strategyConfigs.length} strategy configs; ` +
      `${indicationCalculationGroups.length} unique indication calculations (in ${tConfigsMs}ms)`
    )

    // A first symbol can legitimately take a while: the configured exhaustive
    // grid has many exact groups and every result still has to be persisted.
    // Publish group-level work units so a healthy cold bootstrap is visibly
    // advancing before its first whole symbol completes. These are actual
    // calculation groups, never timers or synthetic heartbeats.
    const indicationWorkUnitsPerSymbol = groupHistoricIndicationCalculationGroupsByGeometry(
      indicationCalculationGroups,
    ).length
    const strategyWorkUnitsPerSymbol = historicStrategyCalculationUnitCount(strategyConfigs)
    const configWorkUnitsPerSymbol = Math.max(
      1,
      indicationWorkUnitsPerSymbol + strategyWorkUnitsPerSymbol,
    )
    const configWorkUnitsTotal = Math.max(
      1,
      canonicalSymbolsTotal * configWorkUnitsPerSymbol,
    )
    const initialConfigWorkUnits = Math.min(
      configWorkUnitsTotal,
      Math.max(0, alreadyProcessedSymbols) * configWorkUnitsPerSymbol,
    )
    let pendingConfigWorkUnits = 0
    let pendingConfigWorkFailures = 0
    let configWorkFlush: Promise<void> | null = null
    let configWorkCurrentSymbol = ""
    let configWorkCurrentStage = "initializing"
    let configWorkLastEngineProgressAt = 0

    const flushConfigWorkProgress = (): Promise<void> => {
      if (configWorkFlush) return configWorkFlush
      configWorkFlush = (async () => {
        while (pendingConfigWorkUnits > 0) {
          const units = pendingConfigWorkUnits
          const failures = pendingConfigWorkFailures
          pendingConfigWorkUnits = 0
          pendingConfigWorkFailures = 0
          try {
            await assertCurrentSelection()
            const completed = Math.min(
              configWorkUnitsTotal,
              Number(await client.hincrby(prehistoricKey, "config_work_units_completed", units)) || 0,
            )
            const now = Date.now()
            const activityAt = new Date(now).toISOString()
            await client.hset(prehistoricKey, {
              config_work_units_total: String(configWorkUnitsTotal),
              config_work_current_symbol: configWorkCurrentSymbol,
              config_work_current_stage: configWorkCurrentStage,
              config_work_last_activity_at: activityAt,
              config_work_last_activity_ms: String(now),
              ...(failures > 0 ? {
                config_work_failed_units: String(
                  Math.max(0, Number(await client.hincrby(prehistoricKey, "config_work_failed_units", failures)) || 0),
                ),
              } : {}),
            })
            await mirrorProgressHash({
              prehistoric_config_work_units_completed: completed,
              prehistoric_config_work_units_total: configWorkUnitsTotal,
              prehistoric_config_work_failed_units: Math.max(
                0,
                Number(await client.hget(prehistoricKey, "config_work_failed_units").catch(() => 0)) || 0,
              ),
              prehistoric_config_work_current_symbol: configWorkCurrentSymbol,
              prehistoric_config_work_current_stage: configWorkCurrentStage,
              prehistoric_config_work_last_activity_at: activityAt,
            })
            // Progression writes are deliberately throttled. The unit counter
            // itself is atomic and exact; this more expensive UI projection
            // only needs human-scale updates.
            if (
              completed >= configWorkUnitsTotal ||
              now - configWorkLastEngineProgressAt >= 750
            ) {
              configWorkLastEngineProgressAt = now
              const percent = Math.min(
                95,
                15 + Math.round((completed / configWorkUnitsTotal) * 80),
              )
              await setEngineProgress({
                phase: "prehistoric_data",
                progress: percent,
                detail: `Prehistoric calc ${configWorkCurrentStage} — ${configWorkCurrentSymbol || "preparing"}; ` +
                  `${completed}/${configWorkUnitsTotal} configuration groups`,
                sub_current: Math.min(canonicalSymbolsTotal, Math.floor(completed / configWorkUnitsPerSymbol)),
                sub_total: canonicalSymbolsTotal,
                sub_item: configWorkCurrentSymbol || "configuration groups",
                updated_at: activityAt,
              })
            }
            try {
              options.onProgress?.({
                stage: configWorkCurrentStage === "strategies" ? "strategies" : "indications",
                symbol: configWorkCurrentSymbol,
                completedUnits: completed,
                totalUnits: configWorkUnitsTotal,
              })
            } catch {
              // An observability callback must never invalidate calculated
              // historic results or their durable progress projection.
            }
          } catch (error) {
            // A superseded generation must not write its remaining work into a
            // new selection's progress hash. The succeeding owner publishes its
            // own units; ordinary telemetry failures remain non-fatal.
            if (error instanceof PrehistoricProcessingCancelledError) {
              pendingConfigWorkUnits = 0
              pendingConfigWorkFailures = 0
              return
            }
          }
        }
      })().finally(() => {
        configWorkFlush = null
        if (pendingConfigWorkUnits > 0) void flushConfigWorkProgress()
      })
      return configWorkFlush
    }

    const reportConfigWork: HistoricWorkReporter = (stage, success) => {
      configWorkCurrentStage = stage
      pendingConfigWorkUnits++
      if (!success) pendingConfigWorkFailures++
      void flushConfigWorkProgress()
    }

    // Publish the active generation before the first symbol starts. The
    // dashboard can therefore distinguish an empty/in-progress exhaustive
    // calculation from a missing statistic, and never falls back to an older
    // generation while settings are being recoordinated.
    await assertCurrentSelection()
    const fourHourStartedAtMs = Date.now()
    await Promise.all([
      client.hset(fourHourAggregateKey, {
        schema_version: String(HISTORIC_FOUR_HOUR_SCHEMA_VERSION),
        bucket_hours: String(HISTORIC_FOUR_HOUR_BUCKET_HOURS),
        neutral_pf: String(HISTORIC_FOUR_HOUR_PF_NEUTRAL),
        minimum_pf: String(HISTORIC_FOUR_HOUR_PF_MINIMUM),
        generation: historicGeneration,
        run_started_at_ms: String(fourHourStartedAtMs),
        complete: "0",
        range_start_ms: String(effectiveStart.getTime()),
        range_end_ms: String(effectiveEnd.getTime()),
        symbols_expected: String(canonicalSymbolsTotal),
        symbols_processed: String(alreadyProcessedSymbols),
        indication_configs: String(indicationConfigs.length),
        strategy_configs: String(strategyConfigs.length),
        updated_at_ms: String(fourHourStartedAtMs),
      }),
      client.expire(fourHourAggregateKey, 7 * 24 * 60 * 60),
      client.hset(prehistoricKey, {
        historic_four_hour_generation: historicGeneration,
        historic_four_hour_key: fourHourAggregateKey,
      }),
    ])

    // Store range/concurrency metadata for dashboard. One write is enough;
    // the previous duplicate Promise.all issued the exact same HSET twice.
    try {
      await assertCurrentSelection()
      await client.hset(prehistoricKey, {
        range_start: effectiveStart.toISOString(),
        range_end: effectiveEnd.toISOString(),
        timeframe_seconds: String(processingTimeframeSec),
        ...(ownsCurrentSelection ? {
          symbol_selection_epoch: writerSelectionEpoch,
          symbols_total: String(canonicalSymbolsTotal),
        } : {}),
        symbol_concurrency: String(SYMBOL_CONCURRENCY),
        config_type_concurrency: String(CONFIG_TYPE_CONCURRENCY),
        persist_concurrency: String(PERSIST_CONCURRENCY),
        indication_configs: String(indicationConfigs.length),
        indication_configs_available: String(allIndicationConfigs.length),
        indication_calculation_groups: String(indicationCalculationGroups.length),
        strategy_configs: String(strategyConfigs.length),
        strategy_configs_available: String(allStrategyConfigs.length),
        config_work_units_total: String(configWorkUnitsTotal),
        config_work_units_completed: String(initialConfigWorkUnits),
        config_work_failed_units: "0",
        config_work_current_stage: "preparing",
        config_work_current_symbol: "",
        config_work_last_activity_at: new Date().toISOString(),
        config_concurrency: String(CONFIG_CONCURRENCY),
        candles_loaded: "0",
        intervals_processed: "0",
        missing_intervals: "0",
        // Portable/serverless owners may process a large selection in bounded
        // chunks. Never regress the visible X/N count to zero at the start of
        // the next chunk; the SET remains the monotonic source of truth.
        symbols_processed: String(clampProcessedToTotal(alreadyProcessedSymbols, canonicalSymbolsTotal)),
        updated_at: new Date().toISOString(),
      }).catch(() => 0)
    } catch { /* non-critical */ }

    const progressKey = progressionScope.progressionKey

    // Worker that processes a single symbol end-to-end. All DB writes inside
    // are fired with Promise.all where possible to minimise the await chain.
    const processOneSymbol = async (symbol: string): Promise<void> => {
      const tSymStart = Date.now()
      let symbolWorkReported = 0
      const reportSymbolWork: HistoricWorkReporter = (stage, success) => {
        symbolWorkReported++
        reportConfigWork(stage, success)
      }
      const finishUnreportedSymbolWork = (success: boolean) => {
        const remaining = Math.max(0, configWorkUnitsPerSymbol - symbolWorkReported)
        if (remaining === 0) return
        const indicationRemaining = Math.min(
          remaining,
          Math.max(0, indicationWorkUnitsPerSymbol - symbolWorkReported),
        )
        for (let index = 0; index < indicationRemaining; index++) {
          reportSymbolWork("indications", success)
        }
        for (let index = indicationRemaining; index < remaining; index++) {
          reportSymbolWork("strategies", success)
        }
      }
      try {
        __DBGC(`PS_sym_start ${symbol}`)
        await assertCurrentSelection()
        configWorkCurrentSymbol = symbol
        configWorkCurrentStage = "loading"
        const symbolStartedAt = new Date().toISOString()
        await client.hset(prehistoricKey, {
          current_symbol: symbol,
          config_work_current_symbol: symbol,
          config_work_current_stage: "loading",
          config_work_last_activity_at: symbolStartedAt,
        }).catch(() => 0)
        await mirrorProgressHash({
          prehistoric_current_symbol: symbol,
          prehistoric_config_work_current_symbol: symbol,
          prehistoric_config_work_current_stage: "loading",
          prehistoric_config_work_last_activity_at: symbolStartedAt,
        })
        // --- Load all available candles for this symbol ---
        let candles: any[] = []

        const candlesRaw = await client.get(`market_data:${symbol}:candles`)
        if (candlesRaw) {
          candles = JSON.parse(candlesRaw)
        }

        // The hot candles key is deliberately bounded. Load only the
        // requested prehistoric interval from canonical chunks so a cold
        // production start keeps the full range without duplicating it in the
        // realtime envelope.
        const requiredHistoryCandles = marketType === "forex"
          ? Math.max(Math.floor(ENGINE_STAGE_HISTORY_CANDLES / 60), 1)
          : ENGINE_STAGE_HISTORY_CANDLES
        const requestedRangeCandles = Math.max(
          requiredHistoryCandles,
          Math.ceil(Math.max(0, effectiveEnd.getTime() - effectiveStart.getTime()) / intervalMs),
        )
        if (candles.length < requestedRangeCandles) {
          const chunkCandles = await getHistoricCandlesForRange(symbol, {
            startMs: effectiveStart.getTime(),
            endMs: effectiveEnd.getTime(),
          })
          if (chunkCandles.length > candles.length) candles = chunkCandles
        }

        // ── Fallback read switched from `:1m` → `:1s` (spec §7.3) ───
        //
        // The market-data loader was migrated to 1-second timeframe so
        // the legacy `:1m` suffix is no longer populated on fresh
        // deployments. The canonical `:candles` snapshot above is
        // still tried first; the `:1s` JSON envelope is the
        // authoritative fallback.
        if (!candles || candles.length === 0) {
          const marketDataRaw = await client.get(`market_data:${symbol}:1s`)
          if (marketDataRaw) {
            const marketDataObj = JSON.parse(marketDataRaw)
            if (marketDataObj?.candles) {
              candles = marketDataObj.candles
            }
          }
        }
        await assertCurrentSelection()
        __DBGC(`PS_sym_candles ${symbol} ${candles.length}`)

        if (candles.length === 0) {
          console.log(`[v0] [ConfigSetProcessor] ⚠ no candles for ${symbol} — skipping`)
          symbolsWithoutData++
          await assertCurrentSelection()
          // CRITICAL ("0/N stuck" + stalled progress-bar fix): a symbol with
          // no prehistoric candles must STILL count toward the processed
          // total, otherwise `symbols_processed` can never reach
          // `symbols_total` (dashboard sticks at "X/N") AND the percent bar
          // — computed from the local `symbolsProcessed` below — can never
          // reach 95%. Increment the local counter, add to the canonical SET
          // (single atomic source of truth), and mirror BOTH the distinct
          // count and the legacy `prehistoric_symbols_processed_count` field.
          // SADD is idempotent so a replay can't double-count.
          symbolsProcessed++
          try {
            const added = Number(await client.sadd(prehistoricSymbolsKey, symbol)) || 0
            await client.expire(prehistoricSymbolsKey, 86400)
            if (added > 0) {
              await hincrProgressHash("prehistoric_symbols_processed_count", 1)
            }
            const distinctSkipProcessed = clampProcessedToTotal(await client.scard(prehistoricSymbolsKey), canonicalSymbolsTotal)
            await client.hset(prehistoricKey, {
              symbols_processed: String(distinctSkipProcessed),
              symbol_selection_epoch: writerSelectionEpoch,
              last_update: new Date().toISOString(),
            })
            await ProgressionStateManager.incrementPrehistoricCycle(
              this.connectionId,
              symbol,
              writerSelectionEpoch,
            ).catch(() => {})
            // Advance the dashboard percent bar even for data-less symbols,
            // using the SAME `engine_progression` schema the main path writes.
            const totalSyms = Math.max(1, canonicalSymbolsTotal)
            const skipPct = Math.min(95, 15 + Math.round((distinctSkipProcessed / totalSyms) * 80))
            void setEngineProgress({
              phase: "prehistoric_data",
              progress: skipPct,
              detail: `Prehistoric calc filling sets — ${distinctSkipProcessed}/${totalSyms} symbols processed (no data: ${symbol})`,
              sub_current: distinctSkipProcessed,
              sub_total: totalSyms,
              sub_item: symbol,
              connection_id: this.connectionId,
              updated_at: new Date().toISOString(),
            }).catch(() => { /* non-critical */ })
          } catch { /* non-critical */ }
          await logProgressionEvent(this.connectionId, "config_set_symbol_skipped", "warning", `No prehistoric candles for ${symbol}`, {
            symbol,
            stage: "prehistoric",
          })
          // No calculation group is skipped silently: this symbol's work was
          // conclusively evaluated as data-less, so mark its planned units as
          // complete while keeping the no-data warning visible.
          finishUnreportedSymbolWork(true)
          return
        }

        // --- Determine which time intervals are already processed ---
        const processedKey = historicProcessedIntervalsKey(
          this.connectionId,
          symbol,
          historicGeneration,
        )
        let processedIntervals: Set<number> = new Set()
        try {
          const processedRaw = await client.get(processedKey)
          if (processedRaw) {
            const arr: number[] = JSON.parse(processedRaw)
            processedIntervals = new Set(arr)
          }
        } catch { /* non-critical */ }
        const hadProcessedIntervals = processedIntervals.size > 0
        const processedIntervalsBefore = processedIntervals.size

        // --- Step through time range interval by interval, processing only missing ones ---
        let currentTs = effectiveStart.getTime()
        const endTs = effectiveEnd.getTime()

        // Pre-sort candles by timestamp for faster bucket filtering.
        const candlesSorted = candles
          .map((c: any) => {
            const cTs = typeof c.timestamp === "number"
              ? c.timestamp
              : new Date(c.timestamp || c.time).getTime()
            return { ...c, _ts: cTs }
          })
          .sort((a: any, b: any) => a._ts - b._ts)

        const intervalCandles: any[] = []
        let symbolIntervalCount = 0
        let symbolMissingCount = 0

        // Use a single linear scan over pre-sorted candles instead of filtering
        // per-bucket. O(n+B) instead of O(n*B).
        let cursor = 0
        while (currentTs < endTs) {
          const bucketTs = Math.floor(currentTs / intervalMs) * intervalMs
          symbolIntervalCount++
          if (!processedIntervals.has(bucketTs)) {
            // Advance cursor to first candle >= bucketTs
            while (cursor < candlesSorted.length && candlesSorted[cursor]._ts < bucketTs) cursor++
            let hadMatch = false
            let probe = cursor
            while (probe < candlesSorted.length && candlesSorted[probe]._ts < bucketTs + intervalMs) {
              intervalCandles.push(candlesSorted[probe])
              probe++
              hadMatch = true
            }
            if (hadMatch) {
              symbolMissingCount++
              processedIntervals.add(bucketTs)
            }
          }
          currentTs += intervalMs
          if (symbolIntervalCount % 1000 === 0) {
            await yieldToEventLoop()
          }
        }

        const newlyProcessedIntervals = Math.max(0, processedIntervals.size - processedIntervalsBefore)
        totalIntervalsProcessed += newlyProcessedIntervals
        missingIntervalsLoaded += symbolMissingCount

        // A caught-up symbol must not re-run its entire candle window. The old
        // fallback selected all candles whenever no interval was missing,
        // duplicating indication/strategy entries on every restart/replay.
        const combinedCandles = intervalCandles.length > 0
          ? intervalCandles
          : hadProcessedIntervals
            ? []
            : candlesSorted
        candlesProcessed += combinedCandles.length
        symbolsProcessed++

        await assertCurrentSelection()

        // --- Prepare the idempotent progress write. It runs only AFTER all
        // config writes and the interval checkpoint succeed. ---
        // Use the same canonical processed-symbol SET as the skip/error paths
        // before touching the legacy counter. A settings restart or duplicate
        // bootstrap can replay the same symbol; blind HINCRBY made the status
        // state report 30/15 symbols in 15-symbol live tests even though the
        // distinct processed set was correct. SADD gives us an idempotent
        // "new symbol" signal, then SCARD becomes the displayed count.
        const writeProgress = async () => {
          await assertCurrentSelection()
          const added = Number(await client.sadd(prehistoricSymbolsKey, symbol).catch(() => 0)) || 0
          await client.expire(prehistoricSymbolsKey, 86400).catch(() => 0)
          if (added > 0) {
            await hincrProgressHash("prehistoric_symbols_processed_count", 1).catch(() => 0)
          }
          const distinctProcessed = clampProcessedToTotal(await client.scard(prehistoricSymbolsKey).catch(() => 0), canonicalSymbolsTotal)
          await Promise.all([
            hincrProgressHash("prehistoric_candles_processed", combinedCandles.length),
            hincrProgressHash("prehistoric_intervals_processed", newlyProcessedIntervals),
            hincrProgressHash("prehistoric_missing_loaded", symbolMissingCount),
            mirrorProgressHash({
              prehistoric_symbols_processed_count: String(distinctProcessed),
              prehistoric_current_symbol: symbol,
              prehistoric_timeframe_seconds: String(processingTimeframeSec),
            }),
            client.hset(prehistoricKey, {
              symbols_processed: String(distinctProcessed),
            }),
            client.expire(progressKey, 7 * 24 * 60 * 60),
          ])
        }

        // --- Run indications + strategies in parallel for this symbol ---
        const tCalcStart = Date.now()
        const historicSeries = buildHistoricPriceSeries(combinedCandles)
        const symbolHistoricScope = `${writerSelectionEpoch || this.epoch}:${symbol}`
        const fourHourStats = createHistoricFourHourAccumulator()
        markHistoricFourHourCoverage(
          fourHourStats,
          historicFourHourBucketStarts(historicSeries.points.map((point) => point.timestamp)),
          {
            indicationConfigs: indicationConfigs.length,
            strategyConfigs: strategyConfigs.length,
          },
        )
        __DBGC(`PS_sym_before_calc ${symbol} combinedCandles=${combinedCandles.length}`)
        const [indicationResults, strategyPositions] = await Promise.all([
          combinedCandles.length > 0
            ? this.processIndicationConfigs(
                symbol,
                combinedCandles,
                indicationCalculationGroups,
                CONFIG_CONCURRENCY,
                PERSIST_CONCURRENCY,
                assertRunActive,
                symbolHistoricScope,
                historicSeries,
                historicGeneration,
                runCalculation,
                reportSymbolWork,
                fourHourStats,
              )
            : Promise.resolve(0),
          combinedCandles.length > 0
            ? this.processStrategyConfigs(
                symbol,
                combinedCandles,
                strategyConfigs,
                CONFIG_CONCURRENCY,
                CONFIG_TYPE_CONCURRENCY,
                PERSIST_CONCURRENCY,
                assertRunActive,
                symbolHistoricScope,
                historicSeries,
                historicGeneration,
                runCalculation,
                reportSymbolWork,
                fourHourStats,
              )
            : Promise.resolve(0),
        ])
        __DBGC(`PS_sym_after_calc ${symbol} ind=${indicationResults} strat=${strategyPositions}`)
        const tCalcMs = Date.now() - tCalcStart
        await assertCurrentSelection()

        // Commit the complete symbol/window projection in one idempotent
        // aggregate operation. A crash before the interval checkpoint can
        // safely retry: the compact generation marker prevents double counts.
        if (combinedCandles.length > 0) {
          await incrementHistoricAggregateOnce(
            client as any,
            historicAggregateMarkerKey(
              this.connectionId,
              "four-hour",
              "all-configs",
              symbolHistoricScope,
            ),
            fourHourAggregateKey,
            historicFourHourRedisIncrements(fourHourStats),
            7 * 24 * 60 * 60,
            historicAggregateMarkerMember("four-hour", symbolHistoricScope),
          )
          const fourHourUpdatedAtMs = Date.now()
          await Promise.all([
            client.hset(fourHourAggregateKey, {
              updated_at_ms: String(fourHourUpdatedAtMs),
              complete: "0",
            }),
            client.expire(fourHourAggregateKey, 7 * 24 * 60 * 60),
            client.hset(prehistoricKey, {
              historic_four_hour_generation: historicGeneration,
              historic_four_hour_key: fourHourAggregateKey,
            }),
          ])
        }

        // Checkpoint only after every Set write completed. A crash before this
        // point leaves the interval eligible for a correct retry instead of
        // silently skipping partially generated output.
        try {
          await client.set(processedKey, JSON.stringify([...processedIntervals]), { EX: 7 * 24 * 60 * 60 })
        } catch (checkpointError) {
          throw new Error(
            `Failed to checkpoint historic intervals for ${symbol}: ${
              checkpointError instanceof Error ? checkpointError.message : String(checkpointError)
            }`,
          )
        }

        totalIndicationResults += indicationResults
        totalStrategyPositions += strategyPositions

        // Fan-out the counter writes & completion marker.
        // NOTE: Track prehistoric stats separately so they don't bleed into
        // realtime counts. The `indications_count` and `strategies_count` are
        // realtime-authoritative (written by engine-manager). Prehistoric phase
        // writes to separate `prehistoric_indications_total` and
        // `prehistoric_strategies_total` keys. This prevents the "jumped counters"
        // effect when transitioning from setup to live trading.
        //
        // CRITICAL ("0/N stuck" fix): `symbols_processed` is derived from the
        // cardinality of the `prehistoric:{id}:symbols` SET, NOT the shared
        // mutable `symbolsProcessed` local. With SYMBOL_CONCURRENCY parallel
        // workers, writing `String(symbolsProcessed)` raced — an out-of-order
        // async write could stamp a STALE (lower) value over a newer one,
        // freezing the dashboard at "X/N". SADD + SCARD is order-independent
        // and idempotent, so the distinct count is always monotonic and exact.
        await assertCurrentSelection()
        await writeProgress()
        const distinctProcessed = clampProcessedToTotal(await client
          .scard(prehistoricSymbolsKey)
          .catch(() => symbolsProcessed), canonicalSymbolsTotal)
        await Promise.all([
          hincrProgressHash("prehistoric_indications_total", indicationResults),
          hincrProgressHash("prehistoric_strategies_total", strategyPositions),
          client.expire(progressKey, 7 * 24 * 60 * 60),
          client.expire(prehistoricSymbolsKey, 86400),
          // Shared totals must be atomic under parallel symbol workers. An
          // absolute HSET could finish out of order and regress a newer total.
          client.hincrby(prehistoricKey, "candles_loaded", combinedCandles.length),
          client.hincrby(prehistoricKey, "intervals_processed", newlyProcessedIntervals),
          client.hincrby(prehistoricKey, "missing_intervals", symbolMissingCount),
          client.hset(prehistoricKey, { symbols_processed: String(distinctProcessed) }),
          // Bump the canonical `prehistoric_cycles_completed` counter and
          // mirror the processed symbols into the hash via the shared
          // ProgressionStateManager primitive. Without this call, the
          // engine-boot prehistoric path wrote per-field stats directly
          // but left `prehistoric_cycles_completed` at 0 forever — which
          // broke `/api/system/verify-engine` (reads the field), the
          // `progression/[id]/stats` route, and every dashboard that
          // distinguishes "prehistoric done" from "never ran".
          ProgressionStateManager.incrementPrehistoricCycle(
            this.connectionId,
            symbol,
            writerSelectionEpoch,
          ).catch(() => { /* non-critical */ }),
        ]).catch(() => { /* non-critical */ })

        // ── Live phase progression update (per-symbol cadence) ─────────
        // Push the actual percent + sub_progress (X/Y symbols) into
        // `engine_progression:{id}` so the dashboard progress bar
        // advances in real time as parallel workers tick off symbols.
        // The phase percent maps the prehistoric work onto the
        // 15 → 95 range (live_trading @ 100 is set by the engine boot
        // path's post-prehistoric handler). Fire-and-forget — a stuck
        // Redis write should never delay the next symbol.
        try {
          // Use the monotonic SCARD-derived `distinctProcessed` (NOT the racy
          // `symbolsProcessed` local) for BOTH the percent and the X/Y display
          // so the progress bar and the "symbols processed of N" label can
          // never regress under parallel workers — they advance in lockstep
          // with the authoritative distinct-symbol set.
          const total = Math.max(1, canonicalSymbolsTotal)
          const pct = Math.min(95, 15 + Math.round((distinctProcessed / total) * 80))
          void setEngineProgress({
            phase: "prehistoric_data",
            progress: pct,
            detail: `Prehistoric calc filling sets — ${distinctProcessed}/${total} symbols processed`,
            sub_current: distinctProcessed,
            sub_total: total,
            sub_item: symbol,
            connection_id: this.connectionId,
            updated_at: new Date().toISOString(),
          }).catch(() => { /* non-critical */ })
        } catch { /* non-critical */ }

        const tSymMs = Date.now() - tSymStart
        console.log(
          `[v0] [ConfigSetProcessor] ✓ ${symbol} | candles=${combinedCandles.length} | ` +
          `intervals=${symbolIntervalCount} (missing=${symbolMissingCount}) | ` +
          `indications=${indicationResults} | strategies=${strategyPositions} | ` +
          `calc=${tCalcMs}ms | total=${tSymMs}ms`
        )
      } catch (error) {
        if (error instanceof PrehistoricProcessingCancelledError) throw error
        console.error(`[v0] [ConfigSetProcessor] ✗ ${symbol}:`, error instanceof Error ? error.message : String(error))
        errors++
        await assertCurrentSelection()
        // CRITICAL ("stuck below 100%" fix): a symbol that throws mid-process
        // must STILL count toward progress, otherwise the SCARD-derived
        // distinct count never reaches N and the bar freezes forever. Mirror
        // the skip-branch accounting: add to the canonical SET (idempotent),
        // bump the legacy counter, and advance the dashboard percent using the
        // monotonic distinct count.
        symbolsProcessed++
        try {
          const added = Number(await client.sadd(prehistoricSymbolsKey, symbol)) || 0
          await client.expire(prehistoricSymbolsKey, 86400)
          if (added > 0) {
            await hincrProgressHash("prehistoric_symbols_processed_count", 1)
          }
          const distinctErrProcessed = clampProcessedToTotal(await client.scard(prehistoricSymbolsKey), canonicalSymbolsTotal)
          await client.hset(prehistoricKey, {
            symbols_processed: String(distinctErrProcessed),
            symbol_selection_epoch: writerSelectionEpoch,
            last_update: new Date().toISOString(),
          })
          await ProgressionStateManager.incrementPrehistoricCycle(
            this.connectionId,
            symbol,
            writerSelectionEpoch,
          ).catch(() => {})
          const totalSyms = Math.max(1, canonicalSymbolsTotal)
          const errPct = Math.min(95, 15 + Math.round((distinctErrProcessed / totalSyms) * 80))
          void setEngineProgress({
            phase: "prehistoric_data",
            progress: errPct,
            detail: `Prehistoric calc filling sets — ${distinctErrProcessed}/${totalSyms} symbols processed (error: ${symbol})`,
            sub_current: distinctErrProcessed,
            sub_total: totalSyms,
            sub_item: symbol,
            connection_id: this.connectionId,
            updated_at: new Date().toISOString(),
          }).catch(() => { /* non-critical */ })
        } catch { /* non-critical */ }
        await logProgressionEvent(this.connectionId, "config_set_symbol_error", "error", `Prehistoric processing failed for ${symbol}`, {
          symbol,
          error: error instanceof Error ? error.message : String(error),
        })
        // Keep the work meter honest after an isolated symbol failure. The
        // red failed-unit count distinguishes attempted/error work from a
        // healthy completed calculation; it never opens the historic gate.
        finishUnreportedSymbolWork(false)
      }
    }

    // Ordered cursor-based pool: no O(n) queue.shift() churn and no unbounded
    // Promise fan-out. Per-symbol errors remain isolated inside processOneSymbol.
    await mapWithConcurrency(symbols, SYMBOL_CONCURRENCY, processOneSymbol, {
      yieldEvery: 1,
      getConcurrency: () => Math.min(
        SYMBOL_CONCURRENCY,
        getRuntimeCapabilityConcurrency("mixed", symbols.length),
      ),
    })
    // Drain the throttled work-meter queue before publishing the final
    // prehistoric result. Otherwise a fast final symbol could flip the gate
    // while the UI still sees a stale in-flight configuration count.
    await flushConfigWorkProgress()
    await assertCurrentSelection()

    const duration = Date.now() - startTime
    const finalDistinctProcessed = clampProcessedToTotal(
      Number(await client.scard(prehistoricSymbolsKey).catch(() => symbolsProcessed)) || 0,
      canonicalSymbolsTotal,
    )
    await assertCurrentSelection()
    const failedConfigWorkUnits = Math.max(
      0,
      Number(await client.hget(prehistoricKey, "config_work_failed_units").catch(() => 0)) || 0,
    )
    const fourHourComplete =
      finalDistinctProcessed >= canonicalSymbolsTotal &&
      errors === 0 &&
      failedConfigWorkUnits === 0
    const fourHourCompletedAtMs = Date.now()
    await Promise.all([
      client.hset(fourHourAggregateKey, {
        schema_version: String(HISTORIC_FOUR_HOUR_SCHEMA_VERSION),
        bucket_hours: String(HISTORIC_FOUR_HOUR_BUCKET_HOURS),
        neutral_pf: String(HISTORIC_FOUR_HOUR_PF_NEUTRAL),
        minimum_pf: String(HISTORIC_FOUR_HOUR_PF_MINIMUM),
        generation: historicGeneration,
        complete: fourHourComplete ? "1" : "0",
        range_start_ms: String(effectiveStart.getTime()),
        range_end_ms: String(effectiveEnd.getTime()),
        symbols_expected: String(canonicalSymbolsTotal),
        symbols_processed: String(finalDistinctProcessed),
        indication_configs: String(indicationConfigs.length),
        strategy_configs: String(strategyConfigs.length),
        symbols_without_data: String(symbolsWithoutData),
        failed_config_work_units: String(failedConfigWorkUnits),
        updated_at_ms: String(fourHourCompletedAtMs),
      }),
      client.expire(fourHourAggregateKey, 7 * 24 * 60 * 60),
      client.hset(prehistoricKey, {
        historic_four_hour_generation: historicGeneration,
        historic_four_hour_key: fourHourAggregateKey,
        historic_four_hour_complete: fourHourComplete ? "1" : "0",
        historic_four_hour_updated_at_ms: String(fourHourCompletedAtMs),
      }),
    ])
    const result: ProcessingResult = {
      indicationConfigs: indicationConfigs.length,
      indicationResults: totalIndicationResults,
      strategyConfigs: strategyConfigs.length,
      strategyPositions: totalStrategyPositions,
      symbolsTotal: canonicalSymbolsTotal,
      symbolsProcessed: finalDistinctProcessed,
      symbolsWithoutData,
      candlesProcessed,
      errors,
      duration,
      intervalsProcessed: totalIntervalsProcessed,
      missingIntervalsLoaded,
      timeframeSeconds: processingTimeframeSec,
      rangeStartMs: effectiveStart.getTime(),
      rangeEndMs: effectiveEnd.getTime(),
    }

    console.log(
      `[v0] [ConfigSetProcessor] Prehistoric processing complete: ` +
      `${totalIndicationResults} indication results, ${totalStrategyPositions} positions in ${duration}ms`
    )

    await logProgressionEvent(this.connectionId, "config_set_processing", "info", 
      `Processed prehistoric data through config sets`, result)

    await logProgressionEvent(this.connectionId, "config_set_processing_summary", errors > 0 ? "warning" : "info", "Prehistoric config processing summary", {
      symbolsTotal: result.symbolsTotal,
      symbolsProcessed: result.symbolsProcessed,
      symbolsWithoutData: result.symbolsWithoutData,
      candlesProcessed: result.candlesProcessed,
      indicationConfigs: result.indicationConfigs,
      strategyConfigs: result.strategyConfigs,
      indicationResults: result.indicationResults,
      strategyPositions: result.strategyPositions,
      errors: result.errors,
      durationMs: result.duration,
    })

    // ── Aggregate per-stage avg profit factor from prehistoric positions ──
    //
    // The realtime strategy-coordinator writes
    // `strategy_detail:{connId}:{base|main|real}.avg_profit_factor` once it
    // starts running. During pure prehistoric processing those keys stay
    // empty, so the dashboard's Base/Main/Real PF tiles read 0/— even
    // though we just generated thousands of historic positions with full
    // PnL data. Spec ask: "Show / Add also Average Profitfactors for
    // Strategies Base, Main, Real (for Historic Processing Info / Stats)."
    //
    // We compute one aggregate PF over all prehistoric position results
    // and mirror it into the three stage hashes. Per-stage tiering does
    // not exist in the prehistoric data model (StrategyConfig has no
    // tier field), so the same aggregate is written across all three;
    // once the realtime strategy-coordinator runs, its tier-specific
    // writes naturally overwrite these prehistoric placeholders. We use
    // SETNX-style logic via plain HSET because callers downstream
    // already accept the field whenever it is present.
    //
    // PF = sum(positive results %) / |sum(negative results %)|.
    // Capped at 9.999 so a no-loss prehistoric run renders cleanly.
    try {
      let posSum = 0
      let negAbsSum = 0
      let resultCount = 0
      const tStart = Date.now()
      // The aggregate is generated while every config batch is persisted and
      // is not subject to the bounded 250-row diagnostic retention. Prefer it
      // for PF/counts; only old data created before the aggregate existed uses
      // the bounded-list compatibility scan below.
      const aggregateSnapshot = await client
        .hgetall(historicAggregateKey(this.connectionId, "strategies", historicGeneration))
        .catch(() => ({} as Record<string, string>))
      const hasCompleteAggregate = Object.prototype.hasOwnProperty.call(aggregateSnapshot, "closed_count")

      if (hasCompleteAggregate) {
        posSum = Number(aggregateSnapshot.gross_profit) || 0
        negAbsSum = Number(aggregateSnapshot.gross_loss) || 0
        resultCount = Number(aggregateSnapshot.closed_count) || 0
      } else {
        // Compatibility only: cap concurrency on the fallback path so an
        // older snapshot cannot create an unbounded LRANGE fan-out.
        const PF_SCAN_CONCURRENCY = 16
        const configAggregates = await mapWithConcurrency(
          strategyConfigs,
          PF_SCAN_CONCURRENCY,
          async (cfg) => {
            assertRunActive()
            let configPosSum = 0
            let configNegAbsSum = 0
            let configResultCount = 0
            try {
              const setKey = `strategy:${this.connectionId}:config:${cfg.id}:positions`
              const entries = (await client.lrange(setKey, 0, StrategyConfigManager.MAX_POSITIONS - 1)) || []
              for (const entry of entries) {
                if (!entry) continue
                // ── Closed-only gate (spec: "Main Sets / Pos Coord ones must
                //    evaluate previous CLOSED pseudo positions, not opened ones") ──
                //
                // Entries are produced via `StrategyConfigManager.serializeSetEntry`,
                // which writes a POSITIONAL "|"-delimited tuple:
                //   entry_time|symbol|entry_price|take_profit|stop_loss|
                //   status|result|exit_time|exit_price
                //
                // The previous parser tried two branches that never matched
                // real production rows:
                //   (1) `JSON.parse` — only legacy payloads use that
                //   (2) regex `\bresult=…` — assumed key=value pairs that
                //       this serializer does NOT produce
                // The result was `resultCount` permanently 0 — and worse,
                // had parsing succeeded the aggregate would have summed
                // OPEN positions because the prehistoric fill path appends
                // `status:"open"` rows alongside `status:"closed"` ones.
                //
                // Now: parse with the canonical `StrategyConfigManager.parseEntry`
                // helper (already used by `getLatestPosition` / `getStats`),
                // then hard-gate on `status === "closed"`. Floating
                // mark-to-market PnL on still-open prehistoric trades is
                // excluded from the aggregate that mirrors into
                //   strategy_detail:{base|main|real}.avg_profit_factor
                //   progression:{id}.strategy_{base|main|real}_avg_profit_factor
                //   prehistoric:{id}.historic_avg_profit_factor
                // — all of which feed the Main-stage position-factor
                // coordination layer.
                const parsed = StrategyConfigManager.parseEntry(String(entry))
                if (!parsed) continue
                if (parsed.status !== "closed") continue
                const resultPct = Number(parsed.result)
                if (!Number.isFinite(resultPct)) continue
                if (resultPct > 0) configPosSum += resultPct
                else if (resultPct < 0) configNegAbsSum += Math.abs(resultPct)
                configResultCount++
            }
            } catch (err) {
              if (err instanceof PrehistoricProcessingCancelledError) throw err
              console.warn(
                `[v0] [ConfigSetProcessor] PF scan failed for ${cfg.id}:`,
                err instanceof Error ? err.message : String(err),
              )
            }
            return {
              posSum: configPosSum,
              negAbsSum: configNegAbsSum,
              resultCount: configResultCount,
            }
          },
        )
        for (const aggregate of configAggregates) {
          posSum += aggregate.posSum
          negAbsSum += aggregate.negAbsSum
          resultCount += aggregate.resultCount
        }
      }
      await assertCurrentSelection()

      // Always write the PF field so the dashboard's "Historic PF" tile
      // renders immediately, even when no closed positions exist yet.
      // If positions exist, compute; otherwise default to 0 so the UI
      // shows a valid value instead of undefined/blank.
      let pfStr = "0.0000"
      let pfSource = "no_closed_positions"
      if (resultCount > 0 && (posSum > 0 || negAbsSum > 0)) {
        const rawPF = negAbsSum > 0 ? posSum / negAbsSum : 9.999 // all-wins ceiling
        const aggregatePF = Math.min(9.999, Math.max(0, rawPF))
        pfStr = aggregatePF.toFixed(4)
        pfSource = "prehistoric_aggregate"
      }
      
      const { hsetProgression } = await import("./progression-writes")
      const stageWrites: Promise<any>[] = []
      for (const stage of ["base", "main", "real"] as const) {
        const stageKey = `strategy_detail:${this.connectionId}:${stage}`
        stageWrites.push(
          client.hset(stageKey, {
            avg_profit_factor: pfStr,
            // Mark provenance so anyone debugging the dashboard can tell
            // this PF was synthesised from prehistoric positions and not
            // from realtime strategy-coordinator. The realtime writer
            // replaces both provenance and sample count with its own values.
            avg_profit_factor_source: pfSource,
            avg_profit_factor_count: String(resultCount),
            avg_profit_factor_calc_at: new Date().toISOString(),
          }),
        )
        stageWrites.push(client.expire(stageKey, 86400))
        // Also mirror into the canonical progression hash so the
        // legacy fallback chain in the /stats route can find it
        // even if the per-stage detail hash is unreadable for any
        // reason. Stage-specific keys avoid clobbering the
        // realtime writer's own writes.
        // Use validated wrapper to prevent stale writes
        stageWrites.push(
          hsetProgression(this.connectionId, `strategy_${stage}_avg_profit_factor`, pfStr, {
            connectionId: this.connectionId,
            epoch: this.epoch,
            logStaleRejects: false,
          }),
        )
      }
      // Single overall key for the dashboard's "Historic PF" surface.
      // Always written (even with 0.0000 if no closed positions) so the
      // UI field is never undefined.
      stageWrites.push(
        client.hset(prehistoricKey, {
          historic_avg_profit_factor: pfStr,
          historic_avg_profit_factor_count: String(resultCount),
          historic_avg_profit_factor_at: new Date().toISOString(),
        }),
      )
      await Promise.all(stageWrites)
      
      if (resultCount > 0) {
        console.log(
          `[v0] [ConfigSetProcessor] Historic PF aggregated: ${pfStr} ` +
          `(across ${resultCount} positions, +${posSum.toFixed(2)}% / ` +
          `-${negAbsSum.toFixed(2)}%, ${Date.now() - tStart}ms)`,
        )
      } else {
        console.log(
          `[v0] [ConfigSetProcessor] Historic PF initialized: 0.0000 ` +
          `(no closed positions yet, scan ${Date.now() - tStart}ms)`,
        )
      }
    } catch (err) {
      if (err instanceof PrehistoricProcessingCancelledError) throw err
      // Aggregate PF is a UX nicety — never fail the prehistoric run.
      console.warn(
        `[v0] [ConfigSetProcessor] Historic PF aggregation failed:`,
        err instanceof Error ? err.message : String(err),
      )
    }

    // Flip `prehistoric_phase_active` to "false" and refresh last_update.
    // Downstream readers (verify-engine API, progression stats API, the
    // dashboard prehistoric card) use this as the authoritative "historical
    // calc is done" signal. Without this call the phase stayed `active`
    // forever even though processing had finished.
    try {
      if (options.finalizePhase !== false) {
        await assertCurrentSelection()
        await ProgressionStateManager.completePrehistoricPhase(
          this.connectionId,
          canonicalSymbolsTotal,
          writerSelectionEpoch,
          errors === 0,
        )
      }
    } catch (err) {
      if (err instanceof PrehistoricProcessingCancelledError) throw err
      console.warn(
        `[v0] [ConfigSetProcessor] completePrehistoricPhase failed:`,
        err instanceof Error ? err.message : String(err),
      )
    }

    // Persist the authoritative "historical processing last-run" metadata.
    // Lives at `prehistoric:{connId}` (same hash that carries counters
    // like `candles_loaded` and `symbols_processed`) so every consumer
    // that already reads that hash picks up the timestamps for free:
    //
    //   - last_run_at          : ISO timestamp of the run END
    //   - last_run_started_at  : ISO timestamp of the run START
    //   - processing_duration_ms : total ms spent in processPrehistoricData
    //   - last_run_errors      : error count from the just-finished run
    //   - last_run_symbols     : symbols actually processed this run
    //
    // The UI prehistoric card / progression dashboard surfaces these
    // directly. Prior behaviour: no timestamps at all — the "last
    // processed" column was permanently blank. TTL matches the sibling
    // keys (24h) so state doesn't linger forever after a disconnect.
    try {
      await assertCurrentSelection()
      const client = getRedisClient()
      const finishedAt = new Date()
      await client.hset(prehistoricKey, {
        last_run_at: finishedAt.toISOString(),
        last_run_at_ms: String(finishedAt.getTime()),
        last_run_started_at: new Date(startTime).toISOString(),
        last_run_started_at_ms: String(startTime),
        processing_duration_ms: String(duration),
        last_run_errors: String(errors),
        last_run_symbols: String(symbolsProcessed),
        last_run_candles: String(candlesProcessed),
        last_run_indication_results: String(totalIndicationResults),
        last_run_strategy_positions: String(totalStrategyPositions),
      })
      await client.expire(`prehistoric:${this.connectionId}`, 86400)
    } catch (err) {
      if (err instanceof PrehistoricProcessingCancelledError) throw err
      console.warn(
        `[v0] [ConfigSetProcessor] Failed to persist last-run metadata:`,
        err instanceof Error ? err.message : String(err),
      )
    }

    if (options.finalizePhase !== false) {
      await assertCurrentSelection()
      emitEngineStageAck(this.connectionId, "prehistoric_data", "ack", "Prehistoric processing completed", { symbolsProcessed: finalDistinctProcessed, candlesProcessed, totalIndicationResults, totalStrategyPositions })
      emitEngineStageAck(this.connectionId, "base_sets", "ack", "Base set stage completed", { totalStrategyPositions })
      emitEngineStageAck(this.connectionId, "main_sets", "ack", "Main set stage completed", { totalStrategyPositions })
      emitEngineStageAck(this.connectionId, "real_sets", "ack", "Real set stage completed", { totalStrategyPositions })

      // Aggregate marker keys are idempotency guards for the active historic
      // generation only. The durable aggregates and Set ledgers have already
      // been written, so remove the guards after a complete generation to
      // prevent one marker key per config/symbol from becoming permanent DB
      // growth during repeated realtime/recoordination cycles.
      const completionClient = getRedisClient()
      await Promise.all([
        clearHistoricAggregateMarkers(completionClient, this.connectionId).catch(() => 0),
        clearHistoricListCompletionMarkers(completionClient, this.connectionId).catch(() => 0),
      ])
    }

    return result
  }

  /**
   * Process candles through all indication configs.
   * Every config remains independently counted. Configs with mathematically
   * identical inputs reuse one pure calculation and one bounded detail list;
   * their aggregate markers and configuration identities remain separate.
   */
  private async processIndicationConfigs(
    symbol: string,
    candles: any[],
    calculationGroups: IndicationConfig[][],
    concurrency: number,
    persistenceConcurrency: number,
    assertRunActive: () => void = () => {},
    dedupeScope = "",
    historicSeries?: HistoricPriceSeries,
    historicGeneration = "",
    runCalculation: HistoricCalculationRunner = (task) => task(),
    reportWork?: HistoricWorkReporter,
    fourHourStats?: HistoricFourHourAccumulator,
  ): Promise<number> {
    if (calculationGroups.length === 0) return 0

    const client = getRedisClient()
    const aggregateKey = historicGeneration
      ? historicAggregateKey(this.connectionId, "indications", historicGeneration)
      : ""
    // 729 exact calculation variants currently share only 81 window
    // geometries (steps × last-part split). Cache those immutable profiles
    // for this symbol/run; factor-specific signal materialization remains
    // independent and exact.
    const windowSeriesCache = new Map<string, Promise<HistoricIndicationWindowSeries | null>>()
    // A calculation group represents one exact factor combination. Several
    // such groups can still share one immutable window geometry
    // (steps × last-part split). Run those factors together: this walks every
    // price window once, while each config keeps a separate result vector,
    // list identity, aggregate marker and retry semantics.
    const geometryGroups = groupHistoricIndicationCalculationGroupsByGeometry(calculationGroups)
    const perCalculationResults = await mapWithConcurrency(
      geometryGroups,
      concurrency,
      async (geometryCalculationGroups) => {
        let succeeded = false
        try {
          assertRunActive()
          await yieldToEventLoop()
          assertRunActive()
          const references = geometryCalculationGroups.map((group) => group[0])
          const resultsByConfig = await runCalculation(() => this.calculateIndicationResultsForConfigs(
            symbol,
            candles,
            references,
            historicSeries,
            windowSeriesCache,
          ))
          const persisted = await mapWithConcurrency(
            geometryCalculationGroups,
            Math.max(1, Math.min(persistenceConcurrency, geometryCalculationGroups.length)),
            async (calculationConfigs) => {
              const referenceConfig = calculationConfigs[0]
              const results = resultsByConfig.get(String(referenceConfig.id)) || []
              if (fourHourStats) {
                recordHistoricFourHourIndications(
                  fourHourStats,
                  results,
                  calculationConfigs.length,
                )
              }
              if (results.length === 0) return 0
              let buyCount = 0
              let sellCount = 0
              for (const result of results) {
                if (result.signal === "buy") buyCount++
                else if (result.signal === "sell") sellCount++
              }
              const neutralCount = results.length - buyCount - sellCount
              assertRunActive()
              let detailRowsAccepted = results.length
              // Every alias resolves to the deterministic group's reference LIST,
              // so immutable detail rows are persisted only once.
              if (typeof (this.indicationManager as any).addResults === "function") {
                const added = await (this.indicationManager as any).addResults(
                  referenceConfig.id,
                  results,
                  dedupeScope,
                )
                detailRowsAccepted = Number.isFinite(Number(added)) ? Number(added) : results.length
              } else {
                await forEachWithConcurrency(
                  results,
                  Math.max(1, Math.min(16, persistenceConcurrency)),
                  async (result) => { await this.indicationManager.addResult(referenceConfig.id, result) },
                  { yieldEvery: 16 },
                )
              }

              if (!historicGeneration) return detailRowsAccepted
              // One atomic script replaces one awaited EVAL per alias. Config
              // identities remain separate Set members and retry-safe, while the
              // aggregate receives the exact accepted-alias multiplier.
              const aggregateMarkerKeys = calculationConfigs.map((config) => historicAggregateMarkerKey(
                this.connectionId,
                "indication",
                config.id,
                dedupeScope,
              ))
              const aggregateMarkerMembers = calculationConfigs.map((config) =>
                historicAggregateMarkerMember(config.id, dedupeScope),
              )
              const acceptedAliases = await incrementHistoricAggregatesOnce(
                client as any,
                aggregateMarkerKeys,
                aggregateKey,
                [
                  { field: "result_count", value: results.length },
                  { field: "buy_count", value: buyCount },
                  { field: "sell_count", value: sellCount },
                  { field: "neutral_count", value: neutralCount },
                ],
                7 * 24 * 60 * 60,
                aggregateMarkerMembers,
              )
              return acceptedAliases * results.length
            },
            { yieldEvery: 1 },
          )
          succeeded = true
          return persisted.reduce((sum, value) => sum + value, 0)
        } catch (error) {
          if (error instanceof PrehistoricProcessingCancelledError) throw error
          console.error(
            `[v0] [ConfigSetProcessor] ✗ indication geometry group ${geometryCalculationGroups[0]?.[0]?.id || "unknown"}:`,
            error instanceof Error ? error.message : String(error),
          )
          return 0
        } finally {
          reportWork?.("indications", succeeded)
        }
      },
      {
        yieldEvery: 1,
        getConcurrency: () => Math.min(
          concurrency,
          getRuntimeCapabilityConcurrency("cpu", geometryGroups.length),
        ),
      },
    )

    return perCalculationResults.reduce((sum, n) => sum + n, 0)
  }

  /**
   * Calculate indication results for a specific config
   * Uses config parameters to generate signals
   */
  private async calculateIndicationResults(
    symbol: string,
    candles: any[],
    config: IndicationConfig,
    historicSeries?: HistoricPriceSeries,
    windowSeriesCache?: Map<string, Promise<HistoricIndicationWindowSeries | null>>,
  ): Promise<IndicationResult[]> {
    const results = await this.calculateIndicationResultsForConfigs(
      symbol,
      candles,
      [config],
      historicSeries,
      windowSeriesCache,
    )
    return results.get(String(config.id)) || []
  }

  /**
   * Materialise all factor variants for one window geometry in one progressive
   * price walk. Callers must pass configs with equal steps and last-part ratio.
   * This is a scheduling/performance optimization only: every config receives
   * its own complete vector and is persisted independently by the caller.
   */
  private async calculateIndicationResultsForConfigs(
    symbol: string,
    candles: any[],
    configs: readonly IndicationConfig[],
    historicSeries?: HistoricPriceSeries,
    windowSeriesCache?: Map<string, Promise<HistoricIndicationWindowSeries | null>>,
  ): Promise<HistoricIndicationResultsByConfig> {
    const byConfig: HistoricIndicationResultsByConfig = new Map()
    if (configs.length === 0) return byConfig
    const config = configs[0]
    const { steps, last_part_ratio } = config

    if (!candles || candles.length < steps) {
      return byConfig
    }

    const series = historicSeries ?? buildHistoricPriceSeries(candles)
    const pricePoints = series.points
    const prices = series.prices

    if (prices.length < steps || steps < 4) {
      return byConfig
    }

    const requestedLastPart = Number(last_part_ratio)
    const lastPartRatio = Number.isFinite(requestedLastPart)
      ? Math.max(0.1, Math.min(0.9, requestedLastPart))
      : 0.5
    const lastPartLength = Math.max(2, Math.min(steps - 2, Math.round(steps * lastPartRatio)))
    const splitIndex = Math.max(1, steps - lastPartLength)
    const firstLength = splitIndex
    const secondLength = steps - splitIndex
    if (firstLength < 2 || secondLength < 2) return byConfig
    const variants = configs.map((variant) => ({
      id: String(variant.id),
      magnitudeFactor: (1 - Number(variant.drawdown_ratio) * 0.5) * Number(variant.active_ratio),
      results: [] as IndicationResult[],
    }))
    for (const variant of variants) byConfig.set(variant.id, variant.results)

    // ── Adaptive signal threshold ───────────────────────────────────────
    // Previously the gate was a hard-coded `adjustedMagnitude > 0.005`
    // (0.5%). That works on live exchange data (real volatility) but in the
    // sandbox the exchange fetch fails and we fall back to SYNTHETIC candles
    // that step only ~±0.0167%/bar. The windowed-average delta on that data
    // is ~0.01–0.05% — always below 0.5% — so prehistoric produced ZERO
    // indications (verified: candles=99 → indications=0) even though the
    // identical candles yielded strategies. That left every prehistoric Set
    // with no indication context.
    //
    // Fix: scale the threshold to the series' own volatility. We measure the
    // mean absolute bar-to-bar relative move and require the windowed delta
    // to exceed a fraction of it, clamped to a sane band. On live data this
    // resolves close to the original 0.5%; on flat synthetic data it drops
    // proportionally so meaningful relative moves still register.
    const avgBarVol = series.averageBarVolatility
    // Threshold = 1.5× the typical bar move, clamped to [0.0002, 0.005].
    // Upper clamp preserves the legacy 0.5% ceiling for high-volatility data;
    // lower clamp keeps a noise floor so a dead-flat series still gates out.
    const signalThreshold = Math.min(0.005, Math.max(0.0002, avgBarVol * 1.5))

    const windowCount = prices.length - steps + 1
    const windowCacheKey = `${steps}|${splitIndex}`
    let windowSeriesPromise = windowSeriesCache?.get(windowCacheKey)
    if (!windowSeriesPromise) {
      windowSeriesPromise = this.calculateIndicationWindowSeries(series, steps, splitIndex)
      windowSeriesCache?.set(windowCacheKey, windowSeriesPromise)
    }
    const windowSeries = await windowSeriesPromise
    if (!windowSeries) return byConfig

    for (let i = 0; i < windowCount; i++) {
      if ((i + 1) % HISTORIC_CALC_YIELD_EVERY === 0) {
        await yieldToEventLoop()
      }
      const magnitude = windowSeries.magnitudes[i]
      const candle = pricePoints[i + steps - 1] || pricePoints[i]
      for (const variant of variants) {
        const adjustedMagnitude = magnitude * variant.magnitudeFactor
        if (adjustedMagnitude <= signalThreshold) continue
        const signal = windowSeries.directions[i] > 0 ? "buy" : "sell"
        variant.results.push({
          timestamp: candle?.timestamp || new Date().toISOString(),
          symbol,
          value: signal === "buy" ? adjustedMagnitude * 100 : -adjustedMagnitude * 100,
          signal,
          confidence: Math.min(0.95, 0.5 + adjustedMagnitude),
        })
      }
    }

    // Every result belonging to this exact configuration is returned.
    // Persistence compaction may retain a bounded history, but it must never
    // truncate the current calculation pass or skip a configuration.
    return byConfig
  }

  private async calculateIndicationWindowSeries(
    series: HistoricPriceSeries,
    steps: number,
    splitIndex: number,
  ): Promise<HistoricIndicationWindowSeries | null> {
    const firstLength = splitIndex
    const secondLength = steps - splitIndex
    if (firstLength < 2 || secondLength < 2 || series.prices.length < steps) return null
    const windowCount = series.prices.length - steps + 1
    const directions = new Int8Array(windowCount)
    const magnitudes = new Float64Array(windowCount)
    for (let i = 0; i < windowCount; i++) {
      if ((i + 1) % HISTORIC_CALC_YIELD_EVERY === 0) await yieldToEventLoop()
      const firstEnd = i + splitIndex
      const windowEnd = i + steps
      const firstAvg = (series.prefixSums[firstEnd] - series.prefixSums[i]) / firstLength
      const secondAvg = (series.prefixSums[windowEnd] - series.prefixSums[firstEnd]) / secondLength
      directions[i] = secondAvg > firstAvg ? 1 : -1
      magnitudes[i] = Math.abs(secondAvg - firstAvg) / firstAvg
    }
    return { directions, magnitudes }
  }

  /**
   * Process candles through all strategy configs in parallel.
   * Positions generated per config are written as a single batched lpush.
   */
  private async processStrategyConfigs(
    symbol: string,
    candles: any[],
    configs: StrategyConfig[],
    concurrency: number,
    typeConcurrency: number,
    persistenceConcurrency: number,
    assertRunActive: () => void = () => {},
    dedupeScope = "",
    historicSeries?: HistoricPriceSeries,
    historicGeneration = "",
    runCalculation: HistoricCalculationRunner = (task) => task(),
    reportWork?: HistoricWorkReporter,
    fourHourStats?: HistoricFourHourAccumulator,
  ): Promise<number> {
    if (configs.length === 0) return 0

    // ── Systemwide fix: prehistoric must populate pos_history ───────────
    // The Main/Real min-pos gates (mainEvalPosCount / realEvalPosCount,
    // default 25/20) read `baseSet.prevPos.count` (sourced from the
    // pos_history:* hashes) to decide whether a Base Set has enough
    // historic context to be promoted. If this is empty when realtime
    // starts, the gates skip every Set and Main/Real stay 0 forever —
    // the user's "no sets evaluated" symptom.
    //
    // recordPosClosed() is what populates pos_history. It was previously
    // only called by the live close path (pseudo-position-manager.ts).
    // We now mirror every closed prehistoric position into pos_history
    // through the same semantic writer, batched into one Redis pipeline per
    // symbol-config so the command count stays bounded even when a single
    // config produces hundreds of historic closes.
    //
    // Spec: "Make sure prehistoric progress works completely correct
    //   with created sets data and then start realtime progress, AFTER
    //   prehistoric has finished, fix systemwide."
    const { recordPosClosedBatch } = await import("@/lib/pos-history")
    const piClient = getRedisClient()
    const appSettings = (await getAppSettings().catch(() => null)) || {}
    const configuredPositionCostPct = Number(
      appSettings.exchangePositionCost ?? appSettings.positionCost ?? 0.1,
    )
    const positionCostPct =
      Number.isFinite(configuredPositionCostPct) && configuredPositionCostPct > 0
        ? configuredPositionCostPct
        : 0.1
    const aggregateClient = getRedisClient()
    const aggregateKey = historicGeneration
      ? historicAggregateKey(this.connectionId, "strategies", historicGeneration)
      : ""

    const configTypeGroups = groupConfigsByType(configs)
    const activeTypeConcurrency = Math.max(1, Math.min(typeConcurrency, configTypeGroups.length))
    const perTypeConcurrency = Math.max(1, Math.floor(concurrency / activeTypeConcurrency))
    const perTypePersistenceConcurrency = Math.max(
      1,
      Math.floor(persistenceConcurrency / activeTypeConcurrency),
    )
    const perTypeCounts = await mapWithConcurrency(
      configTypeGroups,
      activeTypeConcurrency,
      async ([type, typeConfigs]) => {
        // Strategy configs with identical simulation parameters share the
        // expensive price walk. Persistence remains one independent batch per
        // config, preserving config identity and all direction/row counts.
        const calculationGroups = new Map<string, StrategyConfig[]>()
        for (const config of typeConfigs) {
          const key = [
            config.type,
            Number(config.position_cost_step),
            Number(config.takeprofit),
            Number(config.stoploss),
            Boolean(config.trailing),
          ].join("|")
          const bucket = calculationGroups.get(key)
          if (bucket) bucket.push(config)
          else calculationGroups.set(key, [config])
        }
        const perCalculationCounts = await mapWithConcurrency(
          [...calculationGroups.values()],
          perTypeConcurrency,
          async (calculationConfigs) => {
            let succeeded = false
            try {
              assertRunActive()
              await yieldToEventLoop()
              assertRunActive()
              const positions = await runCalculation(() => this.calculateStrategyPositions(
                symbol,
                candles,
                calculationConfigs[0],
                historicSeries,
                positionCostPct,
              ))
              if (fourHourStats) {
                recordHistoricFourHourPositions(
                  fourHourStats,
                  positions,
                  calculationConfigs.length,
                  positionCostPct,
                )
              }
              // A clean calculation with no qualifying pseudo-position is a
              // valid outcome, not a failed strategy group. Previously this
              // early return left `succeeded` false, causing every zero-result
              // group to inflate the production UI's failed-work counter.
              if (positions.length === 0) {
                succeeded = true
                return 0
              }
              const persistedCounts = await mapWithConcurrency(
                calculationConfigs,
                perTypePersistenceConcurrency,
                async (config) => {
                  assertRunActive()
                  let acceptedPositions = positions
                  if (typeof (this.strategyManager as any).addPositionsWithAccepted === "function") {
                    const batch = await (this.strategyManager as any).addPositionsWithAccepted(
                      config.id,
                      positions,
                      dedupeScope,
                    )
                    acceptedPositions = Array.isArray(batch?.accepted) ? batch.accepted : positions
                  } else if (typeof (this.strategyManager as any).addPositions === "function") {
                    await (this.strategyManager as any).addPositions(config.id, positions, dedupeScope)
                  } else {
                    await forEachWithConcurrency(
                      positions,
                      Math.max(1, Math.min(16, perTypePersistenceConcurrency)),
                      async (position) => { await this.strategyManager.addPosition(config.id, position) },
                      { yieldEvery: 16 },
                    )
                  }
                  assertRunActive()

                  const closed = positions.filter((p: PseudoPosition) => p.status === "closed")
                  const grossProfit = closed.reduce((sum, position) => sum + Math.max(0, Number(position.result) || 0), 0)
                  const grossLoss = closed.reduce((sum, position) => sum + Math.max(0, -(Number(position.result) || 0)), 0)
                  if (historicGeneration) {
                    await incrementHistoricAggregateOnce(
                      aggregateClient as any,
                      historicAggregateMarkerKey(this.connectionId, "strategy", config.id, dedupeScope),
                      aggregateKey,
                      [
                        { field: "position_count", value: positions.length },
                        { field: "closed_count", value: closed.length },
                        { field: "open_count", value: positions.length - closed.length },
                        { field: "winning_count", value: closed.filter((position) => (Number(position.result) || 0) > 0).length },
                        { field: "losing_count", value: closed.filter((position) => (Number(position.result) || 0) < 0).length },
                        { field: "gross_profit", value: grossProfit },
                        { field: "gross_loss", value: grossLoss },
                        { field: "pnl_sum", value: grossProfit - grossLoss },
                      ],
                      7 * 24 * 60 * 60,
                      historicAggregateMarkerMember(config.id, dedupeScope),
                    )
                  }

                  // ── Mirror closed positions into pos_history ─────────────
                  // Use only positions accepted by the idempotent list write;
                  // a retry may calculate the same rows but must not duplicate
                  // directional history or inflate Main/Real gates.
                  const acceptedClosed = acceptedPositions.filter((p: PseudoPosition) => p.status === "closed")
                  if (acceptedClosed.length > 0) {
                    try {
                      const pipeline = piClient.multi()
                      const toMs = (t: unknown): number => {
                        if (typeof t === "number") return t
                        if (typeof t === "string") {
                          const n = Number(t)
                          if (Number.isFinite(n) && n > 0) return n
                          const parsed = Date.parse(t)
                          return Number.isFinite(parsed) ? parsed : 0
                        }
                        return 0
                      }
                      // Per-position drawdown time is still calculated from
                      // the exact entry/exit pair. The batch writer only
                      // combines commutative counters and the equivalent
                      // rolling-list append; it never samples or drops rows.
                      recordPosClosedBatch({
                        connectionId: this.connectionId,
                        entries: acceptedClosed
                          .filter((p): p is PseudoPosition & { direction: "long" | "short" } =>
                            p.direction === "long" || p.direction === "short",
                          )
                          .map((p) => {
                          const entryMs = toMs(p.entry_time)
                          const exitMs = toMs(p.exit_time)
                          const drawdownMinutes =
                            entryMs > 0 && exitMs > entryMs ? (exitMs - entryMs) / 60000 : 0
                          const resultPct = Number(p.result) || 0
                          return {
                            symbol: p.symbol || symbol,
                            indicationType: p.indication_type || config.type || "unknown",
                            direction: p.direction,
                            pnl: resultPct,
                            pnlPct: resultPct,
                            positionCostPct,
                            drawdownMinutes,
                            entryPrice: p.entry_price,
                          }
                          }),
                        pipeline,
                      })
                      await (pipeline as any).exec()
                    } catch (piErr) {
                      console.warn(
                        `[v0] [ConfigSetProcessor] pos_history mirror failed for ${config.id}:`,
                        piErr instanceof Error ? piErr.message : String(piErr),
                      )
                    }
                  }

                  return acceptedPositions.length
                },
                { yieldEvery: 1 },
              )
              succeeded = true
              return persistedCounts.reduce((sum, count) => sum + count, 0)
            } catch (error) {
              if (error instanceof PrehistoricProcessingCancelledError) throw error
              console.error(
                `[v0] [ConfigSetProcessor] ✗ strategy group ${calculationConfigs[0]?.id || "unknown"} (${type}):`,
                error instanceof Error ? error.message : String(error),
              )
              return 0
            } finally {
              reportWork?.("strategies", succeeded)
            }
          },
          {
            yieldEvery: 1,
            getConcurrency: () => Math.min(
              perTypeConcurrency,
              getRuntimeCapabilityConcurrency("cpu", calculationGroups.size),
            ),
          },
        )
        return perCalculationCounts.reduce((sum, n) => sum + n, 0)
      },
      {
        yieldEvery: 1,
        getConcurrency: () => Math.min(
          activeTypeConcurrency,
          getRuntimeCapabilityConcurrency("mixed", configTypeGroups.length),
        ),
      },
    )

    return perTypeCounts.reduce((sum, n) => sum + n, 0)
  }

  /**
   * Calculate pseudo positions for a specific strategy config
   * Simulates trading with the config parameters
   */
  private async calculateStrategyPositions(
    symbol: string,
    candles: any[],
    config: StrategyConfig,
    historicSeries?: HistoricPriceSeries,
    positionCostPct = 0.1,
  ): Promise<PseudoPosition[]> {
    const positions: PseudoPosition[] = []
    const { position_cost_step, takeprofit, stoploss, type } = config

    if (!candles || candles.length < position_cost_step * 2) {
      return positions
    }

    const series = historicSeries ?? buildHistoricPriceSeries(candles)
    if (series.points.length < position_cost_step * 2) return positions
    const prices = series.points.map((point) => ({
      price: point.price,
      time: point.timestamp,
    }))
    const entryThreshold = resolveHistoricStrategyEntryThreshold(series.averageBarVolatility)

    let inPosition = false
    let entryPrice = 0
    let entryTime = ""
    let positionSide: "long" | "short" = "long"

    let rollingSum = prices.slice(0, position_cost_step).reduce((sum: number, p: any) => sum + p.price, 0)

    for (let i = position_cost_step; i < prices.length; i++) {
      if ((i + 1) % HISTORIC_CALC_YIELD_EVERY === 0) {
        await yieldToEventLoop()
      }
      const currentPrice = prices[i].price
      const currentTime = prices[i].time
      const avgPrice = rollingSum / position_cost_step

      if (!inPosition) {
        const priceDiff = (currentPrice - avgPrice) / avgPrice
        
        if (Math.abs(priceDiff) > entryThreshold) {
          inPosition = true
          entryPrice = currentPrice
          entryTime = currentTime
          positionSide = priceDiff > 0 ? "long" : "short"
        }
      } else {
        const pnl = positionSide === "long"
          ? (currentPrice - entryPrice) / entryPrice
          : (entryPrice - currentPrice) / entryPrice
        const netPnlPct = calculatePseudoClosePnl({
          entryPrice,
          currentPrice,
          quantity: 1,
          side: positionSide,
          positionCostPct,
        }).netPnlPct

        const takeProfitHit = pnl >= takeprofit
        const stopLossHit = pnl <= -stoploss

        if (takeProfitHit || stopLossHit) {
          positions.push({
            entry_time: entryTime,
            symbol,
            entry_price: entryPrice,
            take_profit: entryPrice * (1 + (positionSide === "long" ? takeprofit : -takeprofit)),
            stop_loss: entryPrice * (1 + (positionSide === "long" ? -stoploss : stoploss)),
            status: "closed",
            result: netPnlPct,
            exit_time: currentTime,
            exit_price: currentPrice,
            // Carry direction + indication_type into the in-memory
            // PseudoPosition so the prehistoric write path
            // (processStrategyConfigs) can populate pos_history with
            // the correct (symbol × type × long|short) bucket. The
            // legacy "|"-delimited Set serialization in
            // StrategyConfigManager.serializeEntry intentionally
            // ignores these — they are runtime-only metadata for the
            // historic write fan-out.
            direction: positionSide,
            indication_type: type,
            position_cost_pct: positionCostPct,
          })

          inPosition = false
        }
      }

      rollingSum += currentPrice - prices[i - position_cost_step].price
    }

    if (inPosition && prices.length > 0) {
      const lastPrice = prices[prices.length - 1].price
      const lastTime = prices[prices.length - 1].time
      const pnl = positionSide === "long"
        ? (lastPrice - entryPrice) / entryPrice
        : (entryPrice - lastPrice) / entryPrice
      const netPnlPct = calculatePseudoClosePnl({
        entryPrice,
        currentPrice: lastPrice,
        quantity: 1,
        side: positionSide,
        positionCostPct,
      }).netPnlPct

      positions.push({
        entry_time: entryTime,
        symbol,
        entry_price: entryPrice,
        take_profit: entryPrice * (1 + (positionSide === "long" ? takeprofit : -takeprofit)),
        stop_loss: entryPrice * (1 + (positionSide === "long" ? -stoploss : stoploss)),
        status: "open",
        result: netPnlPct,
        direction: positionSide,
        indication_type: type,
        position_cost_pct: positionCostPct,
      })
    }

    // Keep the complete current pass. History retention is applied only when
    // persisted and is independent from calculation completeness.
    return positions
  }

  /**
   * Get stats for all config sets
   */
  async getConfigSetStats(): Promise<{
    indications: { total: number; enabled: number; totalResults: number }
    strategies: { total: number; enabled: number; totalPositions: number }
  }> {
    const indicationConfigs = await this.indicationManager.getAllConfigs()
    const enabledIndications = indicationConfigs.filter(c => c.enabled)
    const strategyConfigs = await this.strategyManager.getAllConfigs()
    const enabledStrategies = strategyConfigs.filter(c => c.enabled)

    let totalIndicationResults = 0
    for (const config of enabledIndications) {
      totalIndicationResults += await this.indicationManager.getResultCount(config.id)
    }

    let totalStrategyPositions = 0
    for (const config of enabledStrategies) {
      totalStrategyPositions += await this.strategyManager.getPositionCount(config.id)
    }

    return {
      indications: {
        total: indicationConfigs.length,
        enabled: enabledIndications.length,
        totalResults: totalIndicationResults,
      },
      strategies: {
        total: strategyConfigs.length,
        enabled: enabledStrategies.length,
        totalPositions: totalStrategyPositions,
      },
    }
  }

  /**
   * Get best performing strategy configs
   */
  async getBestPerformingStrategies(limit: number = 10): Promise<Array<{
    config: StrategyConfig
    stats: any
  }>> {
    const configs = await this.strategyManager.getEnabledConfigs()
    // Fan out the per-config stats reads — each is an independent
    // Redis lookup and the sequential pattern serialised N round-trips
    // on dashboards that frequently call this for the top-N panel.
    const all = await mapWithConcurrency(
      configs,
      concurrencyFromEnv(["STRATEGY_STATS_READ_CONCURRENCY"], 4, 8, configs.length),
      async (config) => {
        const stats = await this.strategyManager.getStats(config.id)
        return { config, stats }
      },
      { yieldEvery: 1 },
    )
    return all
      .filter((r) => r.stats.totalPositions > 0)
      .sort((a, b) => b.stats.winRate - a.stats.winRate)
      .slice(0, limit)
  }
}
