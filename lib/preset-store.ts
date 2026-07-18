import {
  DEFAULT_PRESET_OPTIMIZER_SETTINGS,
  aggregateCandles,
  normalizeCandles,
  normalizePresetOptimizerSettings,
  optimizePresetsForSymbol,
  type OptimizedPreset,
  type PresetIndicatorType,
  type PresetOptimizationResult,
  type PresetOptimizerSettings,
} from "@/lib/preset-optimizer"
import {
  getAppSettings,
  getConnection,
  getRedisClient,
  initRedis,
  setAppSettings,
} from "@/lib/redis-db"
import { getHistoricCandlesForRange } from "@/lib/trade-engine/market-data-cache"
import { getCanonicalConnectionSettingsOverlay } from "@/lib/connection-settings-overlay"
import { concurrencyFromEnv, mapWithConcurrency } from "@/lib/bounded-concurrency"

const PREFIX = "preset_optimizer:v2"
const GENERATION_RETENTION = 2
const OPTIMIZATION_LOCK_SECONDS = 20 * 60
const FALLBACK_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]
const HISTORIC_COVERAGE_RATIO = 0.9

export interface PresetOptimizationProgress {
  connectionId: string
  status: "idle" | "running" | "completed" | "failed"
  generationId?: string
  startedAt?: string
  completedAt?: string
  currentSymbol?: string
  symbolsCompleted: number
  symbolsTotal: number
  evaluatedConfigurations: number
  presetsGenerated: number
  sourceCandles: number
  sampledCandles: number
  error?: string
}

export interface PresetOverview {
  connectionId: string
  generationId: string | null
  settings: PresetOptimizerSettings
  presets: OptimizedPreset[]
  summary: {
    total: number
    eligible: number
    selected: number
    symbols: number
    indicatorTypes: number
    averageProfitFactor: number
    averageWinRate: number
    averageDrawdownHours: number
    netR: number
    daily: Array<{
      day: number
      date: string
      profitFactor: number
      netR: number
      positions: number
    }>
  }
  facets: {
    symbols: string[]
    indicatorTypes: string[]
  }
  progress: PresetOptimizationProgress
  engine: Record<string, string>
}

export interface PresetListFilters {
  symbol?: string | null
  indicatorType?: string | null
  eligibleOnly?: boolean
  selectedOnly?: boolean
  trailing?: "all" | "enabled" | "disabled"
  limit?: number
}

function activeGenerationKey(connectionId: string): string {
  return `${PREFIX}:${connectionId}:active_generation`
}

function generationsKey(connectionId: string): string {
  return `${PREFIX}:${connectionId}:generations`
}

function generationPrefix(connectionId: string, generationId: string): string {
  return `${PREFIX}:${connectionId}:generation:${generationId}`
}

function rankingKey(connectionId: string, generationId: string): string {
  return `${generationPrefix(connectionId, generationId)}:ranking`
}

function candidateKey(connectionId: string, generationId: string, presetId: string): string {
  return `${generationPrefix(connectionId, generationId)}:candidate:${presetId}`
}

function candidateIndexKey(connectionId: string, generationId: string): string {
  return `${generationPrefix(connectionId, generationId)}:candidates`
}

function generationKeyIndexKey(connectionId: string, generationId: string): string {
  return `${generationPrefix(connectionId, generationId)}:keys`
}

function selectedKey(connectionId: string): string {
  return `${PREFIX}:${connectionId}:selected`
}

function progressKey(connectionId: string): string {
  return `${PREFIX}:${connectionId}:progress`
}

function engineKey(connectionId: string): string {
  return `${PREFIX}:${connectionId}:engine`
}

function lockKey(connectionId: string): string {
  return `${PREFIX}:${connectionId}:optimization_lock`
}

function scoreForPreset(preset: OptimizedPreset): number {
  // Eligibility is the primary ordering dimension. The score itself remains
  // visible and auditable; the large offset only controls the Redis ranking.
  return (preset.metrics.eligible ? 1_000_000 : 0) + preset.metrics.score
}

function historicCoverage(candles: Array<{ timestamp: number }>): number {
  if (candles.length < 2) return 0
  return Math.max(0, candles[candles.length - 1].timestamp - candles[0].timestamp)
}

async function loadPresetHistoricRange(input: {
  connection: Record<string, any> | null
  symbol: string
  startMs: number
  endMs: number
  settings: PresetOptimizerSettings
}): Promise<{ candles: unknown[]; sourceCandleCount: number; source: "chunk-cache" | "exchange" }> {
  let cachedRaw = await getHistoricCandlesForRange(input.symbol, {
    startMs: input.startMs,
    endMs: input.endMs,
    batchChunks: 4,
  })
  const cachedSourceCount = cachedRaw.length
  let cached = normalizeCandles(cachedRaw)
  cachedRaw = []
  const desiredCoverage = Math.max(1, input.endMs - input.startMs)
  const cachedCoverage = historicCoverage(cached)
  if (cached.length >= 40 && cachedCoverage >= desiredCoverage * HISTORIC_COVERAGE_RATIO) {
    return {
      candles: aggregateCandles(cached, input.settings.maxCandlesPerRun),
      sourceCandleCount: cachedSourceCount,
      source: "chunk-cache",
    }
  }

  // Keep only a bounded fallback while a compact 5m/15m public history request
  // is in flight. This prevents a short 1s cache tail plus the exchange range
  // from being simultaneously retained as two large arrays.
  const cachedFallback = aggregateCandles(cached, input.settings.maxCandlesPerRun)
  if (cachedFallback !== cached) cached = []
  const connection = input.connection || {}
  const apiKey = String(connection.api_key ?? connection.apiKey ?? "")
  const apiSecret = String(connection.api_secret ?? connection.apiSecret ?? "")
  const exchange = String(connection.exchange ?? "")
  const hasRealCredentials =
    apiKey.length >= 10 &&
    apiSecret.length >= 10 &&
    !/PLACEHOLDER|00998877|^test/i.test(apiKey) &&
    !/PLACEHOLDER|00998877|^test/i.test(apiSecret)
  if (!exchange || !hasRealCredentials) {
    return { candles: cachedFallback, sourceCandleCount: cachedSourceCount, source: "chunk-cache" }
  }

  try {
    const timeframe = input.settings.historyDays <= 2 ? "5m" : "15m"
    const intervalMs = timeframe === "5m" ? 5 * 60_000 : 15 * 60_000
    const limit = Math.min(1_440, Math.ceil(desiredCoverage / intervalMs) + 32)
    const { createExchangeConnector } = await import("@/lib/exchange-connectors")
    const connector = await createExchangeConnector(exchange, {
      apiKey,
      apiSecret,
      apiPassphrase: String(connection.api_passphrase ?? connection.apiPassphrase ?? "") || undefined,
      apiType: String(connection.api_type ?? connection.apiType ?? "perpetual_futures"),
      contractType: String(connection.contract_type ?? connection.contractType ?? "") || undefined,
      isTestnet: connection.is_testnet === true || connection.is_testnet === "1",
    })
    const exchangeRaw = await connector.getOHLCV(input.symbol, timeframe, limit)
    const exchangeCandles = normalizeCandles(Array.isArray(exchangeRaw) ? exchangeRaw : [])
      .filter((candle) => candle.timestamp >= input.startMs && candle.timestamp <= input.endMs)
    if (
      exchangeCandles.length >= 40 &&
      historicCoverage(exchangeCandles) > cachedCoverage
    ) {
      return {
        candles: aggregateCandles(exchangeCandles, input.settings.maxCandlesPerRun),
        sourceCandleCount: exchangeCandles.length,
        source: "exchange",
      }
    }
  } catch (error) {
    console.warn(
      `[PresetOptimizer] ${input.symbol} public historical fallback failed:`,
      error instanceof Error ? error.message : String(error),
    )
  }
  return { candles: cachedFallback, sourceCandleCount: cachedSourceCount, source: "chunk-cache" }
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback
  if (typeof raw !== "string") return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function parseSymbols(raw: unknown): string[] {
  const parsed = parseJson<unknown>(raw, raw)
  const values = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "string"
      ? parsed.split(/[\s,|]+/)
      : []
  return [...new Set(values
    .map((value) => String(value || "").trim().toUpperCase().replace("-", ""))
    .filter((symbol) => /^[A-Z0-9]+USDT$/.test(symbol)))]
}

function settingsFromApp(app: Record<string, any>): PresetOptimizerSettings {
  return normalizePresetOptimizerSettings({
    historyDays: app.presetHistoryDays,
    presetsPerSymbol: app.presetCountPerSymbol,
    minProfitFactor: app.profitFactorMinPreset,
    maxDrawdownHours: app.drawdownTimePreset,
    takeProfit: {
      min: app.presetTpMin,
      max: app.presetTpMax,
      step: app.presetTpStep,
    },
    stopLossRatio: {
      min: app.presetSlMin,
      max: app.presetSlMax,
      step: app.presetSlStep,
    },
    trailingEnabled: app.presetTrailingEnabled,
    trailingIndependent: app.presetTrailingIndependent,
    trailingStart: {
      min: app.presetTrailStartMin,
      max: app.presetTrailStartMax,
      step: app.presetTrailStartStep,
    },
    trailingStop: {
      min: app.presetTrailStopMin,
      max: app.presetTrailStopMax,
      step: app.presetTrailStopStep,
    },
    trailingStepRatio: app.presetTrailStepRatio,
    autoGenerate: app.presetAutoGenerate,
    autoSelect: app.presetAutoSelect,
    indicatorTypes: parseJson(app.presetIndicatorTypes, DEFAULT_PRESET_OPTIMIZER_SETTINGS.indicatorTypes),
    maxIndicatorVariantsPerType: app.presetMaxIndicatorVariants,
    maxSignalsPerVariant: app.presetMaxSignalsPerVariant,
    maxCandlesPerRun: app.presetMaxCandlesPerRun,
    blockEnabled: app.presetBlockEnabled ?? app.variantBlockEnabled ?? app.blockAdjustment,
    blockVolumeRatio: app.presetBlockVolumeRatio ?? app.blockVolumeRatio,
    blockProfitFactorRatio: app.presetBlockProfitFactorRatio ?? app.blockProfitFactorRatio,
    blockMaxStack: app.presetBlockMaxStack ?? app.blockMaxStack,
    blockPauseCountRatio: app.presetBlockPauseCountRatio ?? app.blockPauseCountRatio,
    blockActiveRealEnabled: app.presetBlockActiveRealEnabled ?? app.blockActiveRealEnabled,
    blockActiveLiveEnabled: app.presetBlockActiveLiveEnabled ?? app.blockActiveLiveEnabled,
  })
}

function settingsToApp(settings: PresetOptimizerSettings): Record<string, unknown> {
  return {
    presetHistoryDays: settings.historyDays,
    presetCountPerSymbol: settings.presetsPerSymbol,
    profitFactorMinPreset: settings.minProfitFactor,
    drawdownTimePreset: settings.maxDrawdownHours,
    presetTpMin: settings.takeProfit.min,
    presetTpMax: settings.takeProfit.max,
    presetTpStep: settings.takeProfit.step,
    presetSlMin: settings.stopLossRatio.min,
    presetSlMax: settings.stopLossRatio.max,
    presetSlStep: settings.stopLossRatio.step,
    presetTrailingEnabled: settings.trailingEnabled,
    presetTrailingIndependent: settings.trailingIndependent,
    presetTrailStartMin: settings.trailingStart.min,
    presetTrailStartMax: settings.trailingStart.max,
    presetTrailStartStep: settings.trailingStart.step,
    presetTrailStopMin: settings.trailingStop.min,
    presetTrailStopMax: settings.trailingStop.max,
    presetTrailStopStep: settings.trailingStop.step,
    presetTrailStepRatio: settings.trailingStepRatio,
    presetAutoGenerate: settings.autoGenerate,
    presetAutoSelect: settings.autoSelect,
    presetIndicatorTypes: settings.indicatorTypes,
    presetMaxIndicatorVariants: settings.maxIndicatorVariantsPerType,
    presetMaxSignalsPerVariant: settings.maxSignalsPerVariant,
    presetMaxCandlesPerRun: settings.maxCandlesPerRun,
    presetBlockEnabled: settings.blockEnabled,
    presetBlockVolumeRatio: settings.blockVolumeRatio,
    presetBlockProfitFactorRatio: settings.blockProfitFactorRatio,
    presetBlockMaxStack: settings.blockMaxStack,
    presetBlockPauseCountRatio: settings.blockPauseCountRatio,
    presetBlockActiveRealEnabled: settings.blockActiveRealEnabled,
    presetBlockActiveLiveEnabled: settings.blockActiveLiveEnabled,
  }
}

function overlayPresetBlockSettings(
  app: Record<string, any>,
  connectionSettings: Record<string, any>,
): Record<string, any> {
  if (Object.keys(connectionSettings).length === 0) return app
  return {
    ...app,
    presetBlockEnabled:
      connectionSettings.presetBlockEnabled ?? connectionSettings.variantBlockEnabled ?? app.presetBlockEnabled,
    presetBlockVolumeRatio:
      connectionSettings.presetBlockVolumeRatio ?? connectionSettings.blockVolumeRatio ?? app.presetBlockVolumeRatio,
    presetBlockProfitFactorRatio:
      connectionSettings.presetBlockProfitFactorRatio ?? connectionSettings.blockProfitFactorRatio ?? app.presetBlockProfitFactorRatio,
    presetBlockMaxStack:
      connectionSettings.presetBlockMaxStack ?? connectionSettings.blockMaxStack ?? app.presetBlockMaxStack,
    presetBlockPauseCountRatio:
      connectionSettings.presetBlockPauseCountRatio ?? connectionSettings.blockPauseCountRatio ?? app.presetBlockPauseCountRatio,
    presetBlockActiveRealEnabled:
      connectionSettings.presetBlockActiveRealEnabled ?? connectionSettings.blockActiveRealEnabled ?? app.presetBlockActiveRealEnabled,
    presetBlockActiveLiveEnabled:
      connectionSettings.presetBlockActiveLiveEnabled ?? connectionSettings.blockActiveLiveEnabled ?? app.presetBlockActiveLiveEnabled,
  }
}

function runtimeBlockSettings(settings: PresetOptimizerSettings): Record<string, string> {
  return {
    variantBlockEnabled: String(settings.blockEnabled),
    blockVolumeRatio: String(settings.blockVolumeRatio),
    blockProfitFactorRatio: String(settings.blockProfitFactorRatio),
    blockMaxStack: String(settings.blockMaxStack),
    blockPauseCountRatio: String(settings.blockPauseCountRatio),
    blockActiveRealEnabled: String(settings.blockActiveRealEnabled),
    blockActiveLiveEnabled: String(settings.blockActiveLiveEnabled),
  }
}

async function persistConnectionBlockSettings(
  connectionId: string,
  settings: PresetOptimizerSettings,
): Promise<void> {
  const [connection, current] = await Promise.all([
    getConnection(connectionId),
    getCanonicalConnectionSettingsOverlay(connectionId).catch(() => ({})),
  ])
  if (!connection) throw new Error("Connection not found")
  const currentSettings = settingsFromApp(overlayPresetBlockSettings({}, current))
  const changedFields = [
    currentSettings.blockEnabled !== settings.blockEnabled ? "variantBlockEnabled" : null,
    currentSettings.blockVolumeRatio !== settings.blockVolumeRatio ? "blockVolumeRatio" : null,
    currentSettings.blockProfitFactorRatio !== settings.blockProfitFactorRatio ? "blockProfitFactorRatio" : null,
    currentSettings.blockMaxStack !== settings.blockMaxStack ? "blockMaxStack" : null,
    currentSettings.blockPauseCountRatio !== settings.blockPauseCountRatio ? "blockPauseCountRatio" : null,
    currentSettings.blockActiveRealEnabled !== settings.blockActiveRealEnabled ? "blockActiveRealEnabled" : null,
    currentSettings.blockActiveLiveEnabled !== settings.blockActiveLiveEnabled ? "blockActiveLiveEnabled" : null,
  ].filter((field): field is string => field !== null)
  if (changedFields.length === 0) return

  const runtime = runtimeBlockSettings(settings)
  const updatedAt = new Date().toISOString()
  const settingsVersion = `preset-block:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  const { applyMainConnectionSettingsChange } = await import("@/lib/connection-recoordinator")
  await applyMainConnectionSettingsChange(connectionId, connection as Record<string, any>, {
    settingsPatch: runtime,
    tradeEngineStatePatch: { ...runtime, settings_change_marker: updatedAt },
    changedFieldsOverride: changedFields,
    settingsVersion,
    logTag: "Preset optimizer Block settings",
  })
}

export async function getPresetOptimizerSettings(connectionId?: string): Promise<PresetOptimizerSettings> {
  await initRedis()
  const app = (await getAppSettings({ bypassCache: true }).catch(() => ({}))) || {}
  if (!connectionId) return settingsFromApp(app as Record<string, any>)
  const connectionSettings = await getCanonicalConnectionSettingsOverlay(connectionId).catch(() => ({}))
  return settingsFromApp(overlayPresetBlockSettings(
    app as Record<string, any>,
    connectionSettings as Record<string, any>,
  ))
}

export async function savePresetOptimizerSettings(
  input: Record<string, unknown>,
  connectionId?: string,
): Promise<PresetOptimizerSettings> {
  await initRedis()
  const existingApp = (await getAppSettings({ bypassCache: true }).catch(() => ({}))) || {}
  const current = connectionId
    ? await getPresetOptimizerSettings(connectionId)
    : settingsFromApp(existingApp as Record<string, any>)
  const normalized = normalizePresetOptimizerSettings({ ...current, ...input })
  await setAppSettings({ ...existingApp, ...settingsToApp(normalized) })
  if (connectionId) await persistConnectionBlockSettings(connectionId, normalized)
  return normalized
}

export async function resolvePresetSymbols(connectionId: string, requested?: unknown): Promise<string[]> {
  const explicit = parseSymbols(requested)
  if (explicit.length > 0) return explicit
  await initRedis()
  const client = getRedisClient()
  const [connection, engineState, app] = await Promise.all([
    getConnection(connectionId).catch(() => null),
    client.hgetall(`settings:trade_engine_state:${connectionId}`).catch(() => ({})),
    getAppSettings().catch(() => ({})),
  ])
  const state = engineState as Record<string, string>
  const sources = [
    state.force_symbols,
    state.active_symbols,
    state.symbols,
    (connection as any)?.force_symbols,
    (connection as any)?.active_symbols,
    (connection as any)?.symbols,
    (app as any)?.mainSymbols,
    (app as any)?.main_symbols,
  ]
  for (const source of sources) {
    const symbols = parseSymbols(source)
    if (symbols.length > 0) return symbols
  }
  return FALLBACK_SYMBOLS
}

export async function getCommonIndicationSettings(): Promise<Record<string, unknown>> {
  await initRedis()
  const raw = await getRedisClient().get("indications:common").catch(() => null)
  return parseJson(raw, {})
}

async function getActiveGeneration(connectionId: string): Promise<string | null> {
  await initRedis()
  return getRedisClient().get(activeGenerationKey(connectionId))
}

async function loadPresetsByIds(
  connectionId: string,
  generationId: string,
  ids: string[],
): Promise<OptimizedPreset[]> {
  if (ids.length === 0) return []
  const client = getRedisClient()
  const values = await client.mget(...ids.map((id) => candidateKey(connectionId, generationId, id)))
  return values.flatMap((raw) => {
    const preset = parseJson<OptimizedPreset | null>(raw, null)
    return preset ? [preset] : []
  })
}

export async function listOptimizedPresets(
  connectionId: string,
  filters: PresetListFilters = {},
): Promise<{ generationId: string | null; presets: OptimizedPreset[] }> {
  await initRedis()
  const client = getRedisClient()
  const generationId = await getActiveGeneration(connectionId)
  if (!generationId) return { generationId: null, presets: [] }
  const maximum = Math.max(1, Math.min(5_000, Math.floor(filters.limit || 2_000)))
  const ids = await client.zrevrange(rankingKey(connectionId, generationId), 0, maximum - 1)
  const selected = await client.hgetall(selectedKey(connectionId)).catch(() => ({}))
  const selectedIds = new Set(Object.values(selected || {}))
  let presets = await loadPresetsByIds(connectionId, generationId, ids)
  presets = presets.map((preset) => ({ ...preset, selected: selectedIds.has(preset.id) }))
  if (filters.symbol) presets = presets.filter((preset) => preset.symbol === filters.symbol)
  if (filters.indicatorType) presets = presets.filter((preset) => preset.indicator.type === filters.indicatorType)
  if (filters.eligibleOnly) presets = presets.filter((preset) => preset.metrics.eligible)
  if (filters.selectedOnly) presets = presets.filter((preset) => preset.selected)
  if (filters.trailing === "enabled") presets = presets.filter((preset) => preset.trailing.enabled)
  if (filters.trailing === "disabled") presets = presets.filter((preset) => !preset.trailing.enabled)
  return { generationId, presets }
}

export async function getOptimizedPreset(
  connectionId: string,
  presetId: string,
): Promise<OptimizedPreset | null> {
  const generationId = await getActiveGeneration(connectionId)
  if (!generationId) return null
  const raw = await getRedisClient().get(candidateKey(connectionId, generationId, presetId))
  return parseJson(raw, null)
}

async function writeProgress(connectionId: string, progress: PresetOptimizationProgress): Promise<void> {
  const client = getRedisClient()
  await client.hset(progressKey(connectionId), Object.fromEntries(
    Object.entries(progress).map(([key, value]) => [key, value == null ? "" : String(value)]),
  ))
}

export async function getPresetOptimizationProgress(connectionId: string): Promise<PresetOptimizationProgress> {
  await initRedis()
  const raw = await getRedisClient().hgetall(progressKey(connectionId)).catch(() => ({})) as Record<string, string>
  return {
    connectionId,
    status: (raw?.status || "idle") as PresetOptimizationProgress["status"],
    generationId: raw?.generationId || undefined,
    startedAt: raw?.startedAt || undefined,
    completedAt: raw?.completedAt || undefined,
    currentSymbol: raw?.currentSymbol || undefined,
    symbolsCompleted: Number(raw?.symbolsCompleted || 0),
    symbolsTotal: Number(raw?.symbolsTotal || 0),
    evaluatedConfigurations: Number(raw?.evaluatedConfigurations || 0),
    presetsGenerated: Number(raw?.presetsGenerated || 0),
    sourceCandles: Number(raw?.sourceCandles || 0),
    sampledCandles: Number(raw?.sampledCandles || 0),
    error: raw?.error || undefined,
  }
}

async function persistGeneration(
  connectionId: string,
  generationId: string,
  presets: OptimizedPreset[],
  autoSelect: boolean,
): Promise<void> {
  const client = getRedisClient()
  const prefix = generationPrefix(connectionId, generationId)
  const ranking = rankingKey(connectionId, generationId)
  const index = candidateIndexKey(connectionId, generationId)
  const metadata = `${prefix}:metadata`
  const keyIndex = generationKeyIndexKey(connectionId, generationId)
  const generationKeys = new Set<string>([ranking, index, metadata, keyIndex])
  const pipeline = client.multi()
  for (const preset of presets) {
    const candidate = candidateKey(connectionId, generationId, preset.id)
    const symbolRanking = `${prefix}:symbol:${preset.symbol}:ranking`
    const indicatorRanking = `${prefix}:symbol:${preset.symbol}:indicator:${preset.indicator.type}:ranking`
    generationKeys.add(candidate)
    generationKeys.add(symbolRanking)
    generationKeys.add(indicatorRanking)
    pipeline.set(candidate, JSON.stringify(preset))
    pipeline.sadd(index, preset.id)
    pipeline.zadd(ranking, scoreForPreset(preset), preset.id)
    pipeline.zadd(symbolRanking, scoreForPreset(preset), preset.id)
    pipeline.zadd(indicatorRanking, scoreForPreset(preset), preset.id)
  }
  pipeline.hset(metadata, {
    generationId,
    connectionId,
    presetCount: String(presets.length),
    generatedAt: new Date().toISOString(),
  })
  for (const key of generationKeys) pipeline.sadd(keyIndex, key)
  await pipeline.exec()

  if (autoSelect) {
    const best = new Map<string, OptimizedPreset>()
    for (const preset of presets) {
      if (!preset.metrics.eligible) continue
      const exact = `${preset.symbol}:${preset.indicator.type}`
      const symbolBest = `${preset.symbol}:*`
      if (!best.has(exact) || preset.metrics.score > best.get(exact)!.metrics.score) best.set(exact, preset)
      if (!best.has(symbolBest) || preset.metrics.score > best.get(symbolBest)!.metrics.score) best.set(symbolBest, preset)
    }
    const selectedPipeline = client.multi()
    selectedPipeline.del(selectedKey(connectionId))
    for (const [field, preset] of best) selectedPipeline.hset(selectedKey(connectionId), field, preset.id)
    await selectedPipeline.exec()
  }

  // Publish the new generation only after every candidate and index exists.
  await Promise.all([
    client.set(activeGenerationKey(connectionId), generationId),
    client.zadd(generationsKey(connectionId), Date.now(), generationId),
  ])
}

async function cleanupOldGenerations(connectionId: string, activeGeneration: string): Promise<void> {
  const client = getRedisClient()
  const generations = await client.zrevrange(generationsKey(connectionId), 0, -1)
  const retained = [activeGeneration, ...generations.filter((generation) => generation !== activeGeneration)]
    .slice(0, GENERATION_RETENTION)
  const obsolete = generations.filter((generation) => !retained.includes(generation))
  for (const generationId of obsolete) {
    const prefix = generationPrefix(connectionId, generationId)
    const ids = await client.smembers(candidateIndexKey(connectionId, generationId)).catch(() => [])
    const keys = ids.map((id) => candidateKey(connectionId, generationId, id))
    // New generations maintain an exact key index, keeping cleanup
    // O(generation size) without a Redis-wide KEYS scan. The fallback only
    // handles generations created before this index existed.
    const keyIndex = generationKeyIndexKey(connectionId, generationId)
    let indexKeys = await client.smembers(keyIndex).catch(() => [])
    if (indexKeys.length === 0) indexKeys = await client.keys(`${prefix}:*`).catch(() => [])
    const deleteKeys = [...new Set([...keys, ...indexKeys, keyIndex])]
    for (let offset = 0; offset < deleteKeys.length; offset += 200) {
      await client.del(...deleteKeys.slice(offset, offset + 200)).catch(() => 0)
    }
  }
  // The Redis compatibility surface has no ZREM member command. Rebuild this
  // tiny (max two members) maintenance index without touching any candidates.
  await client.del(generationsKey(connectionId)).catch(() => 0)
  for (let index = 0; index < retained.length; index++) {
    await client.zadd(generationsKey(connectionId), Date.now() - index, retained[index])
  }
}

function optimizationGenerationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export async function runPresetOptimization(input: {
  connectionId: string
  symbols?: unknown
  settings?: Record<string, unknown>
}): Promise<PresetOptimizationProgress> {
  await initRedis()
  const client = getRedisClient()
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const acquired = await client.set(lockKey(input.connectionId), token, { NX: true, EX: OPTIMIZATION_LOCK_SECONDS })
  if (acquired !== "OK") {
    const existing = await getPresetOptimizationProgress(input.connectionId)
    throw new Error(`Preset optimization is already ${existing.status} for ${input.connectionId}`)
  }

  const generationId = optimizationGenerationId()
  const startedAt = new Date().toISOString()
  const progress: PresetOptimizationProgress = {
    connectionId: input.connectionId,
    generationId,
    status: "running",
    startedAt,
    symbolsCompleted: 0,
    symbolsTotal: 0,
    evaluatedConfigurations: 0,
    presetsGenerated: 0,
    sourceCandles: 0,
    sampledCandles: 0,
  }
  let progressWriteTail: Promise<void> = Promise.resolve()
  const queueProgressWrite = (): Promise<void> => {
    const snapshot = { ...progress }
    progressWriteTail = progressWriteTail
      .catch(() => {})
      .then(() => writeProgress(input.connectionId, snapshot))
    return progressWriteTail
  }

  try {
    const [savedSettings, commonSettings, connection, connectionSettings, appSettings, symbols] = await Promise.all([
      getPresetOptimizerSettings(input.connectionId),
      getCommonIndicationSettings(),
      getConnection(input.connectionId),
      getCanonicalConnectionSettingsOverlay(input.connectionId).catch(() => ({})),
      getAppSettings(),
      resolvePresetSymbols(input.connectionId, input.symbols),
    ])
    const settings = input.settings
      ? normalizePresetOptimizerSettings({ ...savedSettings, ...input.settings })
      : savedSettings
    progress.symbolsTotal = symbols.length
    await queueProgressWrite()

    const positionCostPct = Math.max(
      0.000001,
      Number(
        (connectionSettings as any)?.exchangePositionCost ??
        (connectionSettings as any)?.exchange_position_cost ??
        (connectionSettings as any)?.positionCost ??
        (connection as any)?.exchangePositionCost ??
        (connection as any)?.positionCost ??
        (appSettings as any)?.exchangePositionCost ??
        (appSettings as any)?.positionCost ??
        0.02,
      ) || 0.02,
    )
    const allPresets: OptimizedPreset[] = []
    const endMs = Date.now()
    const startMs = endMs - settings.historyDays * 24 * 60 * 60 * 1000

    // Each worker retains only one symbol's bounded historical window. A small
    // pool overlaps range I/O and calculation while keeping peak memory
    // proportional to the configured worker count; every worker releases its
    // candle array immediately after the symbol completes.
    await mapWithConcurrency(
      symbols,
      concurrencyFromEnv(["PRESET_OPTIMIZER_SYMBOL_CONCURRENCY"], 2, 4, symbols.length),
      async (symbol) => {
      progress.currentSymbol = symbol
      await queueProgressWrite()
      let candles: unknown[] = []
      try {
        const historic = await loadPresetHistoricRange({
          connection: connection as Record<string, any> | null,
          symbol,
          startMs,
          endMs,
          settings,
        })
        candles = historic.candles
        const result: PresetOptimizationResult = optimizePresetsForSymbol({
          connectionId: input.connectionId,
          symbol,
          candles,
          commonSettings,
          settings: settings as unknown as Record<string, unknown>,
          positionCostPct,
          sourceCandleCount: historic.sourceCandleCount,
          now: endMs,
        })
        allPresets.push(...result.presets)
        progress.evaluatedConfigurations += result.evaluatedConfigurations
        progress.presetsGenerated += result.presets.length
        progress.sourceCandles += result.sourceCandles
        progress.sampledCandles += result.sampledCandles
      } finally {
        // Do not retain full prehistoric arrays between symbols. This explicit
        // reassignment also makes the intended lifetime clear to V8/GC.
        candles = []
      }
      progress.symbolsCompleted++
      await queueProgressWrite()
      // Long 12/32-symbol runs can exceed the initial lock TTL. Refresh only
      // while this worker still owns the token so a second optimizer cannot
      // publish a competing generation mid-run.
      if (await client.get(lockKey(input.connectionId)).catch(() => null) === token) {
        await client.expire(lockKey(input.connectionId), OPTIMIZATION_LOCK_SECONDS).catch(() => 0)
      }
      },
    )

    await persistGeneration(input.connectionId, generationId, allPresets, settings.autoSelect)
    await cleanupOldGenerations(input.connectionId, generationId)
    progress.status = "completed"
    progress.currentSymbol = undefined
    progress.completedAt = new Date().toISOString()
    await queueProgressWrite()
    await progressWriteTail
    return progress
  } catch (error) {
    progress.status = "failed"
    progress.completedAt = new Date().toISOString()
    progress.error = error instanceof Error ? error.message : String(error)
    await queueProgressWrite().catch(() => {})
    throw error
  } finally {
    const current = await client.get(lockKey(input.connectionId)).catch(() => null)
    if (current === token) await client.del(lockKey(input.connectionId)).catch(() => 0)
  }
}

export async function selectOptimizedPreset(input: {
  connectionId: string
  presetId: string
  symbol?: string
  indicatorType?: PresetIndicatorType | "*"
}): Promise<OptimizedPreset> {
  await initRedis()
  const preset = await getOptimizedPreset(input.connectionId, input.presetId)
  if (!preset) throw new Error("Preset not found in the active generation")
  if (input.symbol && input.symbol !== preset.symbol) throw new Error("Preset symbol does not match selection target")
  if (!preset.metrics.eligible) {
    throw new Error("Preset is not eligible for live selection because it does not meet the configured thresholds")
  }
  const field = `${preset.symbol}:${input.indicatorType || preset.indicator.type}`
  await getRedisClient().hset(selectedKey(input.connectionId), field, preset.id)
  return { ...preset, selected: true }
}

function inferIndicationType(realPosition: Record<string, any>): string | null {
  const direct = realPosition.indicationType || realPosition.indication_type
  if (direct) return String(direct).toLowerCase()
  const key = String(realPosition.setKey || realPosition.parentSetKey || "").toLowerCase()
  return PRESET_TYPE_ALIASES.find((type) => key.includes(type)) || null
}

const PRESET_TYPE_ALIASES: PresetIndicatorType[] = [
  "bollinger", "stochastic", "macd", "rsi", "ema", "sma", "adx", "atr", "sar",
]

export async function resolveSelectedPresetForPosition(
  connectionId: string,
  realPosition: Record<string, any>,
): Promise<OptimizedPreset | null> {
  await initRedis()
  const client = getRedisClient()
  const symbol = String(realPosition.symbol || "").toUpperCase().replace("-", "")
  if (!symbol) return null
  const type = inferIndicationType(realPosition)
  const exactId = type ? await client.hget(selectedKey(connectionId), `${symbol}:${type}`) : null
  const presetId = exactId || await client.hget(selectedKey(connectionId), `${symbol}:*`)
  if (!presetId) return null
  const preset = await getOptimizedPreset(connectionId, presetId)
  return preset?.metrics.eligible ? preset : null
}

export async function applySelectedPresetToRealPosition<T extends Record<string, any>>(
  connectionId: string,
  realPosition: T,
  connectionSnapshot?: Record<string, any> | null,
): Promise<T> {
  const connection = connectionSnapshot ?? await getConnection(connectionId).catch(() => null)
  const presetMode = Boolean(
    (connection as any)?.is_preset_trade === true ||
    (connection as any)?.is_preset_trade === "1" ||
    (connection as any)?.is_preset_trade === "true" ||
    (connection as any)?.preset_trade_enabled === true ||
    (connection as any)?.preset_trade_enabled === "1",
  )
  if (!presetMode) return realPosition
  const preset = await resolveSelectedPresetForPosition(connectionId, realPosition)
  if (!preset) return realPosition
  const preserveAdjustment = realPosition.setVariant === "block" || realPosition.setVariant === "dca"
  return {
    ...realPosition,
    stopLoss: preset.stopLossPct,
    takeProfit: preset.takeProfitEnabled ? preset.takeProfitPct : 0,
    setVariant: preserveAdjustment ? realPosition.setVariant : preset.trailing.enabled ? "trailing" : "default",
    trailingProfile: preset.trailing.enabled
      ? {
          startRatio: preset.trailing.startRatio,
          stopRatio: preset.trailing.stopRatio,
          stepRatio: preset.trailing.stepRatio,
        }
      : undefined,
    presetId: preset.id,
    presetIndicatorType: preset.indicator.type,
    presetRank: preset.rank,
    presetPositionCostPct: preset.positionCostPct,
    presetProfitFactor: preset.metrics.profitFactor,
  }
}

export async function getPresetEngineState(connectionId: string): Promise<Record<string, string>> {
  await initRedis()
  const client = getRedisClient()
  const [stored, connection, tradeState] = await Promise.all([
    client.hgetall(engineKey(connectionId)).catch(() => ({})),
    getConnection(connectionId).catch(() => null),
    client.hgetall(`settings:trade_engine_state:${connectionId}`).catch(() => ({})),
  ])
  const presetEnabled = Boolean(
    (connection as any)?.is_preset_trade === true ||
    (connection as any)?.is_preset_trade === "1" ||
    (connection as any)?.is_preset_trade === "true" ||
    (connection as any)?.preset_trade_enabled === true ||
    (connection as any)?.preset_trade_enabled === "1"
  )
  return {
    ...(stored as Record<string, string>),
    enabled: presetEnabled ? "1" : "0",
    requested: (
      presetEnabled ||
      (connection as any)?.preset_trade_requested === true ||
      (connection as any)?.preset_trade_requested === "1" ||
      (connection as any)?.preset_trade_requested === "true"
    ) ? "1" : "0",
    blockedReason: String((connection as any)?.preset_trade_blocked_reason || ""),
    blockCode: String((connection as any)?.preset_trade_block_code || ""),
    status: String((tradeState as Record<string, string>)?.status || (stored as Record<string, string>)?.status || "stopped"),
    updatedAt: String((tradeState as Record<string, string>)?.updated_at || (stored as Record<string, string>)?.updatedAt || ""),
  }
}

export async function setPresetEngineState(
  connectionId: string,
  state: Record<string, string | number | boolean | null | undefined>,
): Promise<Record<string, string>> {
  await initRedis()
  const client = getRedisClient()
  await client.hset(engineKey(connectionId), Object.fromEntries(
    Object.entries(state).map(([key, value]) => [key, value == null ? "" : String(value)]),
  ))
  return client.hgetall(engineKey(connectionId))
}

function roundedAverage(values: number[]): number {
  return values.length > 0
    ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10_000) / 10_000
    : 0
}

export async function getPresetOverview(
  connectionId: string,
  filters: PresetListFilters = {},
): Promise<PresetOverview> {
  const [{ generationId, presets }, settings, progress, engine] = await Promise.all([
    listOptimizedPresets(connectionId, filters),
    getPresetOptimizerSettings(connectionId),
    getPresetOptimizationProgress(connectionId),
    getPresetEngineState(connectionId),
  ])
  const symbols = [...new Set(presets.map((preset) => preset.symbol))].sort()
  const indicatorTypes = [...new Set(presets.map((preset) => preset.indicator.type))].sort()
  const daily = Array.from({ length: settings.historyDays }, (_, index) => {
    const rows = presets.map((preset) => preset.metrics.daily[index]).filter(Boolean)
    return {
      day: index + 1,
      date: rows[0]?.date || "",
      profitFactor: roundedAverage(rows.map((row) => Math.min(10, row.profitFactor))),
      netR: Math.round(rows.reduce((sum, row) => sum + row.netR, 0) * 10_000) / 10_000,
      positions: rows.reduce((sum, row) => sum + row.positions, 0),
    }
  })
  return {
    connectionId,
    generationId,
    settings,
    presets,
    summary: {
      total: presets.length,
      eligible: presets.filter((preset) => preset.metrics.eligible).length,
      selected: presets.filter((preset) => preset.selected).length,
      symbols: symbols.length,
      indicatorTypes: indicatorTypes.length,
      averageProfitFactor: roundedAverage(presets.map((preset) => Math.min(10, preset.metrics.averageProfitFactor))),
      averageWinRate: roundedAverage(presets.map((preset) => preset.metrics.winRate)),
      averageDrawdownHours: roundedAverage(presets.map((preset) => preset.metrics.drawdownTimeHours)),
      netR: Math.round(presets.reduce((sum, preset) => sum + preset.metrics.netR, 0) * 10_000) / 10_000,
      daily,
    },
    facets: { symbols, indicatorTypes },
    progress,
    engine,
  }
}
