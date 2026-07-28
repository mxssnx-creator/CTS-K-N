import { getRedisClient, initRedis, type RedisClientLike } from "@/lib/redis-db"
import {
  SIGNAL_SOURCE_DEFINITIONS,
  getSignalSourceDescriptors,
  signalSourceSupportsSymbol,
  type SignalCandle,
  type SignalSourceDefinition,
  type SignalSourceDescriptor,
} from "@/lib/signal-source-registry"
import {
  SIGNAL_TRAILING_DEFAULT_MIN_STOP_PCT,
  SIGNAL_TRAILING_DEFAULT_POSITIVE_MOVE_RATIO,
  SIGNAL_TRAILING_DEFAULT_START_PCT,
  SIGNAL_TRAILING_DEFAULT_UPDATE_STOP_RANGE_RATIO,
  SIGNAL_TRAILING_MIN_STOP_PCT_FLOOR,
} from "@/lib/signal-trailing"
import {
  SIGNAL_MAX_POSITIONS_DEFAULT,
  SIGNAL_POSITION_SELECTION_MODE,
  calculateSignalCandidateQuality,
  normalizeSignalMaxPositions,
  normalizeSignalPositionSelectionMode,
  signalCandidateRankKey,
  type SignalPositionSelectionMode,
} from "@/lib/signal-position-policy"
import {
  PREVIOUS_POSITION_MIN_PF_RATIO,
  movePctToMainTradePfRatio,
} from "@/lib/main-trade-profit-factor"

export type SignalDirection = "long" | "short"
export type SignalPerformanceDirection = SignalDirection | "overall"
export const SIGNAL_PERFORMANCE_LOOKBACK = 12
export const SIGNAL_SOURCE_PERFORMANCE_LOOKBACK = 12
export const SIGNAL_LANE_PERFORMANCE_LOOKBACK = 10
export const SIGNAL_LIVE_DISABLE_LOOKBACK = 16
export const SIGNAL_CONFIG_MINIMUM_PF_RATIO = PREVIOUS_POSITION_MIN_PF_RATIO
export const SIGNAL_REQUEST_INTERVAL_MIN_SECONDS = 30
export const SIGNAL_REQUEST_INTERVAL_MAX_SECONDS = 3600

export interface SignalSourceSettings {
  enabled: boolean
  weight: number
  disabledSymbols: string[]
  disabledLanes: string[]
}

export interface SignalIndicationSettings {
  enabled: boolean
  directExecutionEnabled: boolean
  trailingEnabled: boolean
  trailingOnly: boolean
  trailingStartPct: number
  trailingMinStopPct: number
  trailingPositiveMoveRatio: number
  trailingUpdateStopRangeRatio: number
  timeframeMinutes: number
  candleLimit: number
  maxSourcesPerCycle: number
  maxPositionsTotal: number
  positionSelectionMode: SignalPositionSelectionMode
  requestIntervalSeconds: number
  requestTimeoutMs: number
  concurrency: number
  minimumSourceSignals: number
  minimumAgreement: number
  minimumConfidence: number
  minimumStrength: number
  stopLossMinPct: number
  stopLossMaxPct: number
  stopLossAtrMultiplier: number
  takeProfitRewardRisk: number
  takeProfitMaxPct: number
  performanceLookback: number
  performanceMinSamples: number
  performanceDisableBelowPnl: number
  configMinimumPfRatio: number
  performanceCooldownMinutes: number
  circuitFailureThreshold: number
  circuitCooldownSeconds: number
  databaseSize: number
  sources: Record<string, SignalSourceSettings>
}

export interface SignalRisk {
  stopLossPct: number
  takeProfitPct: number
  rewardRisk: number
  sourceIds: string[]
  sourceId?: string
  configId?: string
  configIds?: string[]
  signalLanes?: Array<{ sourceId: string; configId: string }>
  trailing?: boolean
  trailingStopPct?: number
  agreement: number
  confidence: number
  generatedAt: number
}

export interface SignalSourceEvaluation {
  sourceId: string
  sourceName: string
  direction: SignalDirection
  confidence: number
  strength: number
  stopLossPct: number
  takeProfitPct: number
  rewardRisk: number
  atrPct: number
  lastPrice: number
  candleCount: number
  weight: number
}

export interface SignalPerformanceState {
  sourceId: string
  symbol: string
  direction: SignalDirection
  count: number
  wins: number
  grossProfit: number
  grossLoss: number
  profitFactor: number
  totalPnl: number
  averagePnl: number
  winRate: number
  autoDisabled: boolean
  disabledUntil: number
  updatedAt: number
  configId?: string
  costRelativeRatio?: number
  permanentlyDisabled?: boolean
}

export interface SignalPerformanceDecision {
  allowed: boolean
  probe: boolean
  state: SignalPerformanceState
  reason: "bootstrap" | "performing" | "negative_pnl" | "cooldown_probe"
}

export interface SignalSourceHealth {
  sourceId: string
  successes: number
  failures: number
  consecutiveFailures: number
  lastLatencyMs: number
  lastCandleCount: number
  lastStopLossPct?: number
  lastSuccessAt?: number
  lastFailureAt?: number
  lastError?: string
  circuitOpenUntil: number
}

export interface ProcessSignalIndicationsOptions {
  connectionId: string
  symbol: string
  settings?: unknown
  positionCostPct?: number
  now?: number
  fetchImpl?: typeof fetch
  sourceCursor?: number
  persist?: boolean
}

export interface SignalSettingsResponse {
  settings: SignalIndicationSettings
  sources: SignalSourceDescriptor[]
}

const CORE_SOURCE_IDS = ["bingx-swap", "binance-usdm", "bybit-linear", "okx-swap"]
const PERFORMANCE_TTL_SECONDS = 90 * 24 * 60 * 60
const HEALTH_TTL_SECONDS = 7 * 24 * 60 * 60
export const SIGNAL_INDICATION_STORAGE_KEY = "indications:signal"

const RECORD_SIGNAL_OUTCOME_LUA = `
local markerKey = KEYS[1]
local sampleKey = KEYS[2]
local stateKey = KEYS[3]
local indexKey = KEYS[4]
local marker = redis.call("SET", markerKey, ARGV[1], "NX", "EX", ARGV[2])
if not marker then return 0 end

redis.call("LPUSH", sampleKey, ARGV[3])
redis.call("LTRIM", sampleKey, 0, tonumber(ARGV[4]) - 1)
local samples = redis.call("LRANGE", sampleKey, 0, tonumber(ARGV[4]) - 1)
local count = 0
local wins = 0
local totalPnl = 0
local grossProfit = 0
local grossLoss = 0
for _, raw in ipairs(samples) do
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == "table" then
    local pnl = tonumber(decoded["pnl"])
    if pnl then
      count = count + 1
      totalPnl = totalPnl + pnl
      if pnl > 0 then
        wins = wins + 1
        grossProfit = grossProfit + pnl
      elseif pnl < 0 then
        grossLoss = grossLoss - pnl
      end
    end
  end
end
local profitFactor = 0
if grossLoss > 0 then
  profitFactor = grossProfit / grossLoss
elseif grossProfit > 0 then
  profitFactor = 999
end
local autoDisabled = count >= tonumber(ARGV[5]) and totalPnl < tonumber(ARGV[6])
local disabledUntil = 0
if autoDisabled then disabledUntil = tonumber(ARGV[1]) + tonumber(ARGV[7]) end
redis.call("HSET", stateKey,
  "sourceId", ARGV[8],
  "symbol", ARGV[9],
  "direction", ARGV[10],
  "count", tostring(count),
  "wins", tostring(wins),
  "grossProfit", tostring(grossProfit),
  "grossLoss", tostring(grossLoss),
  "profitFactor", tostring(profitFactor),
  "totalPnl", tostring(totalPnl),
  "averagePnl", tostring(count > 0 and totalPnl / count or 0),
  "winRate", tostring(count > 0 and wins / count or 0),
  "autoDisabled", autoDisabled and "1" or "0",
  "disabledUntil", tostring(disabledUntil),
  "updatedAt", ARGV[1])
redis.call("SADD", indexKey, stateKey)
redis.call("EXPIRE", markerKey, tonumber(ARGV[2]))
redis.call("EXPIRE", sampleKey, tonumber(ARGV[2]))
redis.call("EXPIRE", stateKey, tonumber(ARGV[2]))
redis.call("EXPIRE", indexKey, tonumber(ARGV[2]))
return 1
`

const DEFAULT_SOURCE_SETTINGS = Object.fromEntries(
  SIGNAL_SOURCE_DEFINITIONS.map((source) => [
    source.id,
    {
      enabled: source.enabledByDefault,
      weight: source.priority === 1 ? 1 : source.priority === 2 ? 0.9 : 0.75,
      disabledSymbols: [],
      disabledLanes: [],
    },
  ]),
) as Record<string, SignalSourceSettings>

export const DEFAULT_SIGNAL_INDICATION_SETTINGS: SignalIndicationSettings = {
  enabled: true,
  directExecutionEnabled: true,
  trailingEnabled: true,
  trailingOnly: false,
  trailingStartPct: SIGNAL_TRAILING_DEFAULT_START_PCT,
  trailingMinStopPct: SIGNAL_TRAILING_DEFAULT_MIN_STOP_PCT,
  trailingPositiveMoveRatio: SIGNAL_TRAILING_DEFAULT_POSITIVE_MOVE_RATIO,
  trailingUpdateStopRangeRatio: SIGNAL_TRAILING_DEFAULT_UPDATE_STOP_RANGE_RATIO,
  timeframeMinutes: 1,
  candleLimit: 60,
  maxSourcesPerCycle: SIGNAL_SOURCE_DEFINITIONS.length,
  maxPositionsTotal: SIGNAL_MAX_POSITIONS_DEFAULT,
  positionSelectionMode: SIGNAL_POSITION_SELECTION_MODE,
  requestIntervalSeconds: SIGNAL_REQUEST_INTERVAL_MIN_SECONDS,
  requestTimeoutMs: 2500,
  concurrency: 10,
  minimumSourceSignals: 3,
  minimumAgreement: 0.6,
  minimumConfidence: 0.6,
  minimumStrength: 0.2,
  stopLossMinPct: 0.2,
  stopLossMaxPct: 1.5,
  stopLossAtrMultiplier: 0.85,
  takeProfitRewardRisk: 1.8,
  takeProfitMaxPct: 5,
  performanceLookback: SIGNAL_PERFORMANCE_LOOKBACK,
  performanceMinSamples: SIGNAL_PERFORMANCE_LOOKBACK,
  performanceDisableBelowPnl: 0,
  configMinimumPfRatio: SIGNAL_CONFIG_MINIMUM_PF_RATIO,
  performanceCooldownMinutes: 60,
  circuitFailureThreshold: 3,
  circuitCooldownSeconds: 120,
  databaseSize: 250,
  sources: DEFAULT_SOURCE_SETTINGS,
}

const globalSignalState = globalThis as typeof globalThis & {
  __signalSourceFetchCache?: Map<string, { expiresAt: number; promise: Promise<SignalCandle[]> }>
  __signalSourceHealth?: Map<string, SignalSourceHealth>
  __signalCycleCache?: Map<string, { expiresAt: number; indications: any[] }>
  __signalCycleInflight?: Map<string, Promise<any[]>>
  __signalCycleGeneration?: number
  __signalSettingsCache?: { expiresAt: number; settings: SignalIndicationSettings }
}

const FETCH_CACHE = globalSignalState.__signalSourceFetchCache ??
  (globalSignalState.__signalSourceFetchCache = new Map())
const HEALTH_CACHE = globalSignalState.__signalSourceHealth ??
  (globalSignalState.__signalSourceHealth = new Map())
const CYCLE_CACHE = globalSignalState.__signalCycleCache ??
  (globalSignalState.__signalCycleCache = new Map())
const CYCLE_INFLIGHT = globalSignalState.__signalCycleInflight ??
  (globalSignalState.__signalCycleInflight = new Map())
const FETCH_CACHE_MAX = 2048
const CYCLE_CACHE_MAX = 2048

export function invalidateSignalCycleCache(): void {
  CYCLE_CACHE.clear()
  CYCLE_INFLIGHT.clear()
  globalSignalState.__signalCycleGeneration =
    (globalSignalState.__signalCycleGeneration ?? 0) + 1
}

export function invalidateSignalSettingsCache(): void {
  delete globalSignalState.__signalSettingsCache
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback))
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 1 || value === "1" || value === "true") return true
  if (value === false || value === 0 || value === "0" || value === "false") return false
  return fallback
}

export function normalizeSignalIndicationSettings(input: unknown): SignalIndicationSettings {
  const raw = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, any>
    : {}
  const sourceInput = raw.sources && typeof raw.sources === "object" && !Array.isArray(raw.sources)
    ? raw.sources as Record<string, any>
    : {}
  const sources = Object.fromEntries(SIGNAL_SOURCE_DEFINITIONS.map((source) => {
    const fallback = DEFAULT_SOURCE_SETTINGS[source.id]
    const incoming = sourceInput[source.id] && typeof sourceInput[source.id] === "object"
      ? sourceInput[source.id]
      : {}
    const disabledSymbols = Array.isArray(incoming.disabledSymbols)
      ? Array.from(new Set(
          incoming.disabledSymbols
            .map((value: unknown) => String(value ?? "").trim())
            .filter(Boolean)
            .map((value: string) => normalizeSymbol(value)),
        )).slice(0, 200)
      : []
    const disabledLanes = Array.isArray(incoming.disabledLanes)
      ? Array.from(new Set(
          incoming.disabledLanes
            .map(normalizeDisabledSignalLane)
            .filter((value: string | null): value is string => Boolean(value)),
        )).slice(0, 400)
      : []
    return [source.id, {
      enabled: bool(incoming.enabled, fallback.enabled),
      weight: boundedNumber(incoming.weight, fallback.weight, 0.1, 2),
      disabledSymbols,
      disabledLanes,
    }]
  })) as Record<string, SignalSourceSettings>

  const stopLossMinPct = boundedNumber(
    raw.stopLossMinPct,
    DEFAULT_SIGNAL_INDICATION_SETTINGS.stopLossMinPct,
    0.2,
    2,
  )
  const stopLossMaxPct = Math.max(
    stopLossMinPct,
    boundedNumber(raw.stopLossMaxPct, DEFAULT_SIGNAL_INDICATION_SETTINGS.stopLossMaxPct, 0.2, 5),
  )
  // Exact-config evaluation uses a fixed window so equal lanes always use the
  // same evidence. Source-wide rows remain diagnostic and never suppress an
  // independent exact configuration.
  const performanceLookback = SIGNAL_PERFORMANCE_LOOKBACK
  const performanceMinSamples = SIGNAL_PERFORMANCE_LOOKBACK
  const maxSourcesPerCycle = Math.round(boundedNumber(
    raw.maxSourcesPerCycle,
    DEFAULT_SIGNAL_INDICATION_SETTINGS.maxSourcesPerCycle,
    3,
    SIGNAL_SOURCE_DEFINITIONS.length,
  ))
  const minimumSourceSignals = Math.min(
    maxSourcesPerCycle,
    Math.round(boundedNumber(
      raw.minimumSourceSignals,
      DEFAULT_SIGNAL_INDICATION_SETTINGS.minimumSourceSignals,
      2,
      20,
    )),
  )
  const legacyCacheIntervalSeconds = Number(raw.cacheTtlMs) / 1000
  const requestIntervalSeconds = Math.round(boundedNumber(
    raw.requestIntervalSeconds,
    Number.isFinite(legacyCacheIntervalSeconds)
      ? legacyCacheIntervalSeconds
      : DEFAULT_SIGNAL_INDICATION_SETTINGS.requestIntervalSeconds,
    SIGNAL_REQUEST_INTERVAL_MIN_SECONDS,
    SIGNAL_REQUEST_INTERVAL_MAX_SECONDS,
  ))
  const trailingOnly = bool(raw.trailingOnly, DEFAULT_SIGNAL_INDICATION_SETTINGS.trailingOnly)
  const trailingEnabled =
    trailingOnly || bool(raw.trailingEnabled, DEFAULT_SIGNAL_INDICATION_SETTINGS.trailingEnabled)

  return {
    enabled: bool(raw.enabled, true),
    // Fresh exact configurations always bootstrap. Keep the legacy response
    // field pinned to true so persisted settings and clients retain a stable
    // schema without allowing a bypass of the mature exact-config gate.
    directExecutionEnabled: true,
    trailingEnabled,
    trailingOnly,
    trailingStartPct: boundedNumber(
      raw.trailingStartPct,
      DEFAULT_SIGNAL_INDICATION_SETTINGS.trailingStartPct,
      0,
      10,
    ),
    // This floor is an execution invariant. Persisted legacy values and
    // manually-crafted API payloads cannot weaken the Signal trailing stop.
    trailingMinStopPct: boundedNumber(
      raw.trailingMinStopPct,
      DEFAULT_SIGNAL_INDICATION_SETTINGS.trailingMinStopPct,
      SIGNAL_TRAILING_MIN_STOP_PCT_FLOOR,
      10,
    ),
    trailingPositiveMoveRatio: boundedNumber(
      raw.trailingPositiveMoveRatio,
      DEFAULT_SIGNAL_INDICATION_SETTINGS.trailingPositiveMoveRatio,
      0.05,
      1,
    ),
    trailingUpdateStopRangeRatio: boundedNumber(
      raw.trailingUpdateStopRangeRatio,
      DEFAULT_SIGNAL_INDICATION_SETTINGS.trailingUpdateStopRangeRatio,
      0.1,
      1,
    ),
    // Signal is intentionally a one-minute short-horizon lane. Common
    // technical indicators own the configurable 1/5/15-minute grid.
    timeframeMinutes: 1,
    candleLimit: Math.round(boundedNumber(raw.candleLimit, 60, 20, 250)),
    maxSourcesPerCycle,
    maxPositionsTotal: normalizeSignalMaxPositions(raw.maxPositionsTotal),
    positionSelectionMode: normalizeSignalPositionSelectionMode(raw.positionSelectionMode),
    requestIntervalSeconds,
    requestTimeoutMs: Math.round(boundedNumber(raw.requestTimeoutMs, 2500, 500, 10_000)),
    concurrency: Math.round(boundedNumber(raw.concurrency, 10, 1, 10)),
    minimumSourceSignals,
    minimumAgreement: boundedNumber(raw.minimumAgreement, 0.6, 0.5, 1),
    minimumConfidence: boundedNumber(raw.minimumConfidence, 0.6, 0.5, 0.99),
    minimumStrength: boundedNumber(raw.minimumStrength, 0.2, 0.05, 0.95),
    stopLossMinPct,
    stopLossMaxPct,
    stopLossAtrMultiplier: boundedNumber(raw.stopLossAtrMultiplier, 0.85, 0.1, 3),
    takeProfitRewardRisk: boundedNumber(raw.takeProfitRewardRisk, 1.8, 1.1, 5),
    takeProfitMaxPct: boundedNumber(raw.takeProfitMaxPct, 5, 0.5, 22),
    performanceLookback,
    performanceMinSamples,
    performanceDisableBelowPnl: 0,
    // This is a system-wide Previous-position contract, not a per-request
    // tuning knob. Legacy payloads cannot weaken or raise the exact gate.
    configMinimumPfRatio: SIGNAL_CONFIG_MINIMUM_PF_RATIO,
    performanceCooldownMinutes: Math.round(boundedNumber(raw.performanceCooldownMinutes, 60, 1, 24 * 60)),
    circuitFailureThreshold: Math.round(boundedNumber(raw.circuitFailureThreshold, 3, 1, 20)),
    circuitCooldownSeconds: Math.round(boundedNumber(raw.circuitCooldownSeconds, 120, 10, 3600)),
    databaseSize: Math.round(boundedNumber(raw.databaseSize, 250, 25, 2000)),
    sources,
  }
}

export function signalSettingsResponse(input: unknown): SignalSettingsResponse {
  return {
    settings: normalizeSignalIndicationSettings(input),
    sources: getSignalSourceDescriptors(),
  }
}

export async function loadSignalIndicationSettings(): Promise<SignalIndicationSettings> {
  const cached = globalSignalState.__signalSettingsCache
  if (cached && cached.expiresAt > Date.now()) return cached.settings
  await initRedis()
  const raw = await getRedisClient().get(SIGNAL_INDICATION_STORAGE_KEY).catch(() => null)
  let settings: SignalIndicationSettings
  if (!raw) {
    settings = normalizeSignalIndicationSettings(DEFAULT_SIGNAL_INDICATION_SETTINGS)
  } else {
    try {
      settings = normalizeSignalIndicationSettings(JSON.parse(raw))
    } catch {
      settings = normalizeSignalIndicationSettings(DEFAULT_SIGNAL_INDICATION_SETTINGS)
    }
  }
  // Strategy coordination calls this once per symbol. A short shared cache
  // prevents that fan-out from becoming an equivalent Redis request fan-out;
  // the settings POST invalidates it synchronously before notifying engines.
  globalSignalState.__signalSettingsCache = {
    expiresAt: Date.now() + 5_000,
    settings,
  }
  return settings
}

function safePart(value: string): string {
  return String(value || "unknown").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "unknown"
}

function normalizeSymbol(symbol: string): string {
  return String(symbol || "unknown").toUpperCase().replace(/[^A-Z0-9]+/g, "")
}

export function signalSourceLaneIdentity(
  symbol: string,
  direction: SignalDirection,
): string {
  return `${normalizeSymbol(symbol)}:${direction}`
}

function normalizeDisabledSignalLane(value: unknown): string | null {
  const match = String(value ?? "").trim().match(/^(.+):(long|short)$/i)
  if (!match) return null
  const symbol = normalizeSymbol(match[1])
  if (!symbol) return null
  return signalSourceLaneIdentity(symbol, match[2].toLowerCase() as SignalDirection)
}

export function signalSourceLaneManuallyDisabled(
  settings: SignalIndicationSettings,
  sourceId: string,
  symbol: string,
  direction: SignalDirection,
): boolean {
  const source = settings.sources[sourceId]
  if (!source) return true
  const normalizedSymbol = normalizeSymbol(symbol)
  return (
    source.disabledSymbols.includes(normalizedSymbol) ||
    source.disabledLanes.includes(signalSourceLaneIdentity(normalizedSymbol, direction))
  )
}

function performanceStateKey(
  connectionId: string,
  sourceId: string,
  symbol: string,
  direction: SignalDirection,
): string {
  return `signal:performance:${safePart(connectionId)}:${safePart(sourceId)}:${normalizeSymbol(symbol)}:${direction}`
}

function signalPerformanceV2SourceKey(connectionId: string, sourceId: string): string {
  return `signal:performance:v2:${safePart(connectionId)}:source:${safePart(sourceId)}`
}

function signalPerformanceV2LaneKey(
  connectionId: string,
  sourceId: string,
  symbol: string,
  direction: SignalPerformanceDirection,
): string {
  return (
    `signal:performance:v2:${safePart(connectionId)}:lane:${safePart(sourceId)}:` +
    `${normalizeSymbol(symbol)}:${direction}`
  )
}

function signalPerformanceV2ConfigKey(
  connectionId: string,
  sourceId: string,
  symbol: string,
  direction: SignalPerformanceDirection,
  configId: string,
  liveOnly = false,
): string {
  return (
    `signal:performance:v2:${safePart(connectionId)}:` +
    `${liveOnly ? "live_config" : "config"}:${safePart(sourceId)}:` +
    `${normalizeSymbol(symbol)}:${direction}:${safePart(configId)}`
  )
}

function performanceNumber(raw: Record<string, string> | null | undefined, field: string): number {
  const value = Number(raw?.[field])
  return Number.isFinite(value) ? value : 0
}

function signalPerformanceV2Allowed(
  raw: Record<string, string> | null | undefined,
  minimumSamples: number,
  minimumAverage: number,
): boolean {
  if (raw?.permanentlyDisabled === "1" || raw?.permanentlyDisabled === "true") return false
  const count = performanceNumber(raw, "count")
  if (count < minimumSamples) return true
  return performanceNumber(raw, "averagePnl") + Number.EPSILON >= minimumAverage
}

/**
 * Source and source×symbol×direction rows are diagnostics. They are retained
 * for analytics, but cannot block a separate exact configuration lane.
 */
export async function getSignalSourceLanePerformanceDecision(
  client: RedisClientLike,
  input: {
    connectionId: string
    sourceId: string
    symbol: string
    direction: SignalDirection
  },
): Promise<{ allowed: boolean; sourceAllowed: boolean; laneAllowed: boolean }> {
  void client
  void input
  return { allowed: true, sourceAllowed: true, laneAllowed: true }
}

export interface SignalConfigurationPerformanceRequest {
  sourceId: string
  symbol: string
  direction: SignalDirection
  configId: string
}

export interface SignalConfigurationPerformanceDecision {
  allowed: boolean
  ratio: number
  samples: number
  permanentlyDisabled: boolean
}

/**
 * Fresh lanes bootstrap through the first twelve results. Thereafter, the
 * exact source × symbol × direction × config lane must meet the canonical
 * Previous-position ratio; a permanently disabled real-exchange lane remains
 * blocked. The legacy direct-execution setting cannot bypass either rule.
 */
export function signalConfigurationExecutionAllowed(
  directExecutionEnabled: boolean,
  decision: SignalConfigurationPerformanceDecision | undefined,
): boolean {
  void directExecutionEnabled
  return decision ? decision.allowed && !decision.permanentlyDisabled : true
}

export function signalConfigurationPerformanceIdentity(
  request: SignalConfigurationPerformanceRequest,
): string {
  return (
    `${safePart(request.sourceId)}|${normalizeSymbol(request.symbol)}|` +
    `${request.direction}|${request.configId}`
  )
}

/**
 * One bounded Redis pipeline resolves every exact Signal configuration before
 * Base materialisation. The first 12 outcomes bootstrap; mature config lanes
 * require the configured PositionCost-relative average and a 16-live-result
 * permanent-disable lane must remain healthy.
 */
export async function getSignalConfigurationPerformanceBatch(
  connectionId: string,
  requests: readonly SignalConfigurationPerformanceRequest[],
  minimumRatio = SIGNAL_CONFIG_MINIMUM_PF_RATIO,
): Promise<Map<string, SignalConfigurationPerformanceDecision>> {
  const unique = Array.from(new Map(requests.map((request) => [
    signalConfigurationPerformanceIdentity(request),
    request,
  ])).entries())
  const output = new Map<string, SignalConfigurationPerformanceDecision>()
  if (unique.length === 0) return output
  await initRedis()
  const client = getRedisClient()
  const pipeline = client.multi()
  for (const [, request] of unique) {
    pipeline.hgetall(signalPerformanceV2ConfigKey(
      connectionId,
      request.sourceId,
      request.symbol,
      request.direction,
      request.configId,
      false,
    ))
    pipeline.hgetall(signalPerformanceV2ConfigKey(
      connectionId,
      request.sourceId,
      request.symbol,
      request.direction,
      request.configId,
      true,
    ))
  }
  const values = await pipeline.exec().catch(() => [])
  unique.forEach(([identity], index) => {
    const configValue = values?.[index * 2]
    const liveValue = values?.[index * 2 + 1]
    const configRaw = (Array.isArray(configValue) ? configValue?.[1] : configValue) as
      | Record<string, string>
      | undefined
    const liveRaw = (Array.isArray(liveValue) ? liveValue?.[1] : liveValue) as
      | Record<string, string>
      | undefined
    const samples = performanceNumber(configRaw, "count")
    const ratio = performanceNumber(configRaw, "averagePnl")
    const permanentlyDisabled =
      liveRaw?.permanentlyDisabled === "1" ||
      liveRaw?.permanentlyDisabled === "true"
    output.set(identity, {
      allowed:
        !permanentlyDisabled &&
        (samples < SIGNAL_PERFORMANCE_LOOKBACK || ratio + Number.EPSILON >= minimumRatio),
      ratio,
      samples,
      permanentlyDisabled,
    })
  })
  return output
}

function emptyPerformanceState(sourceId: string, symbol: string, direction: SignalDirection): SignalPerformanceState {
  return {
    sourceId,
    symbol: normalizeSymbol(symbol),
    direction,
    count: 0,
    wins: 0,
    grossProfit: 0,
    grossLoss: 0,
    profitFactor: 0,
    totalPnl: 0,
    averagePnl: 0,
    winRate: 0,
    autoDisabled: false,
    disabledUntil: 0,
    updatedAt: 0,
  }
}

function parsePerformanceState(
  raw: Record<string, string> | null | undefined,
  sourceId: string,
  symbol: string,
  direction: SignalDirection,
): SignalPerformanceState {
  const fallback = emptyPerformanceState(sourceId, symbol, direction)
  if (!raw || Object.keys(raw).length === 0) return fallback
  const count = Math.max(0, Number(raw.count) || 0)
  const wins = Math.max(0, Number(raw.wins) || 0)
  const grossProfit = Math.max(0, Number(raw.grossProfit) || 0)
  const grossLoss = Math.max(0, Number(raw.grossLoss) || 0)
  const totalPnl = Number(raw.totalPnl) || 0
  const storedProfitFactor = Number(raw.profitFactor)
  const profitFactor = Number.isFinite(storedProfitFactor) && storedProfitFactor >= 0
    ? storedProfitFactor
    : grossLoss > 0
      ? grossProfit / grossLoss
      : grossProfit > 0
        ? 999
        : 0
  return {
    sourceId: raw.sourceId || sourceId,
    symbol: raw.symbol || fallback.symbol,
    direction:
      raw.direction === "long" || raw.direction === "short"
        ? raw.direction
        : direction,
    count,
    wins,
    grossProfit,
    grossLoss,
    profitFactor,
    totalPnl,
    averagePnl: count > 0 ? totalPnl / count : 0,
    winRate: count > 0 ? wins / count : 0,
    autoDisabled: raw.autoDisabled === "1" || raw.autoDisabled === "true",
    disabledUntil: Math.max(0, Number(raw.disabledUntil) || 0),
    updatedAt: Math.max(0, Number(raw.updatedAt) || 0),
  }
}

export async function getSignalPerformanceState(
  client: RedisClientLike,
  input: {
    connectionId: string
    sourceId: string
    symbol: string
    direction: SignalDirection
  },
): Promise<SignalPerformanceState> {
  const key = performanceStateKey(
    input.connectionId,
    input.sourceId,
    input.symbol,
    input.direction,
  )
  return parsePerformanceState(
    await client.hgetall(key).catch(() => ({})),
    input.sourceId,
    input.symbol,
    input.direction,
  )
}

export async function getSignalPerformanceDecision(
  client: RedisClientLike,
  input: {
    connectionId: string
    sourceId: string
    symbol: string
    direction: SignalDirection
    settings: SignalIndicationSettings
    now?: number
  },
): Promise<SignalPerformanceDecision> {
  const now = input.now ?? Date.now()
  const key = performanceStateKey(input.connectionId, input.sourceId, input.symbol, input.direction)
  const state = await getSignalPerformanceState(client, input)
  const enoughSamples =
    state.count >= input.settings.performanceMinSamples &&
    state.count >= Math.min(input.settings.performanceLookback, input.settings.performanceMinSamples)
  if (!enoughSamples) return { allowed: true, probe: false, state, reason: "bootstrap" }
  if (state.totalPnl >= input.settings.performanceDisableBelowPnl) {
    return { allowed: true, probe: false, state, reason: "performing" }
  }
  if (now < state.disabledUntil) {
    return { allowed: false, probe: false, state: { ...state, autoDisabled: true }, reason: "negative_pnl" }
  }

  const cooldownMs = input.settings.performanceCooldownMinutes * 60_000
  const probeKey = `${key}:probe`
  const lease = await client.set(probeKey, String(now), { NX: true, PX: cooldownMs }).catch(() => null)
  if (lease === "OK") {
    return { allowed: true, probe: true, state: { ...state, autoDisabled: true }, reason: "cooldown_probe" }
  }
  return { allowed: false, probe: false, state: { ...state, autoDisabled: true }, reason: "negative_pnl" }
}

async function recordSignalPerformanceLane(input: {
  client: RedisClientLike
  key: string
  indexKey: string
  markerId: string
  sourceId: string
  symbol: string
  direction: SignalPerformanceDirection
  sampleValue: number
  closedAt: number
  lookback: number
  minimumSamples: number
  disableBelowTotal: number
  cooldownMs: number
  laneKind: "source" | "lane" | "config" | "live_config"
  configId?: string
  permanent?: boolean
}): Promise<void> {
  const sampleKey = `${input.key}:samples`
  const marker = `${input.key}:position:${safePart(input.markerId)}`
  const sample = JSON.stringify({
    positionId: input.markerId,
    pnl: input.sampleValue,
    closedAt: input.closedAt,
  })
  let recorded = false
  if (typeof input.client.eval === "function") {
    try {
      const result = await input.client.eval(RECORD_SIGNAL_OUTCOME_LUA, {
        keys: [marker, sampleKey, input.key, input.indexKey],
        arguments: [
          String(input.closedAt),
          String(PERFORMANCE_TTL_SECONDS),
          sample,
          String(input.lookback),
          String(input.minimumSamples),
          String(input.disableBelowTotal),
          String(input.cooldownMs),
          input.sourceId,
          normalizeSymbol(input.symbol),
          input.direction,
        ],
      })
      recorded = Number(result) === 0 || Number(result) === 1
    } catch {
      recorded = false
    }
  }
  if (!recorded) {
    const claimed = await input.client.set(marker, String(input.closedAt), {
      NX: true,
      EX: PERFORMANCE_TTL_SECONDS,
    }).catch(() => null)
    if (claimed !== "OK") return
    const write = input.client.multi()
    write.lpush(sampleKey, sample)
    write.ltrim(sampleKey, 0, input.lookback - 1)
    write.expire(sampleKey, PERFORMANCE_TTL_SECONDS)
    write.sadd(input.indexKey, input.key)
    write.expire(input.indexKey, PERFORMANCE_TTL_SECONDS)
    await write.exec()
    const samples = await input.client.lrange(sampleKey, 0, input.lookback - 1)
    const values = samples.map((raw) => {
      try {
        return Number(JSON.parse(raw)?.pnl)
      } catch {
        return Number.NaN
      }
    }).filter(Number.isFinite)
    const count = values.length
    const totalPnl = values.reduce((sum, value) => sum + value, 0)
    const grossProfit = values.filter((value) => value > 0)
      .reduce((sum, value) => sum + value, 0)
    const grossLoss = Math.abs(values.filter((value) => value < 0)
      .reduce((sum, value) => sum + value, 0))
    const wins = values.filter((value) => value > 0).length
    const autoDisabled =
      count >= input.minimumSamples &&
      totalPnl < input.disableBelowTotal
    await input.client.hset(input.key, {
      sourceId: input.sourceId,
      symbol: normalizeSymbol(input.symbol),
      direction: input.direction,
      count: String(count),
      wins: String(wins),
      grossProfit: String(grossProfit),
      grossLoss: String(grossLoss),
      profitFactor: String(
        grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
      ),
      totalPnl: String(totalPnl),
      averagePnl: String(count > 0 ? totalPnl / count : 0),
      winRate: String(count > 0 ? wins / count : 0),
      autoDisabled: autoDisabled ? "1" : "0",
      disabledUntil: String(
        autoDisabled ? input.closedAt + input.cooldownMs : 0,
      ),
      updatedAt: String(input.closedAt),
    })
    await input.client.expire(input.key, PERFORMANCE_TTL_SECONDS)
  }

  const state = await input.client.hgetall(input.key).catch(() => ({}))
  const metadata: Record<string, string> = {
    laneKind: input.laneKind,
    ...(input.configId && { configId: input.configId }),
  }
  if (
    input.permanent &&
    performanceNumber(state, "count") >= input.minimumSamples &&
    performanceNumber(state, "averagePnl") < 0
  ) {
    metadata.permanentlyDisabled = "1"
  }
  await input.client.hset(input.key, metadata)
  await input.client.expire(input.key, PERFORMANCE_TTL_SECONDS)
}

export async function recordSignalPerformanceOutcome(input: {
  connectionId: string
  positionId: string
  symbol: string
  direction: SignalDirection
  pnl: number
  pnlPct?: number
  positionCostPct?: number
  sourceIds: readonly string[]
  signalLanes?: ReadonlyArray<{ sourceId: string; configId: string }>
  liveExchange?: boolean
  settings?: unknown
  closedAt?: number
}): Promise<void> {
  if (
    !input.connectionId ||
    !input.positionId ||
    (input.direction !== "long" && input.direction !== "short") ||
    !Number.isFinite(input.pnl)
  ) {
    return
  }
  await initRedis()
  const client = getRedisClient()
  const settings = input.settings === undefined
    ? await loadSignalIndicationSettings()
    : normalizeSignalIndicationSettings(input.settings)
  // Exact execution lanes own their result exclusively. Contributor sourceIds
  // remain diagnostic context and must not let a consensus (or any direct
  // source) loss disable healthy sibling sources. Legacy positions without an
  // exact lane retain the established source + consensus aggregation.
  const laneSourceIds = (input.signalLanes || [])
    .map((lane) => safePart(String(lane.sourceId || "")))
    .filter(Boolean)
  const sourceIds = [...new Set(
    laneSourceIds.length > 0
      ? laneSourceIds
      : [
          ...input.sourceIds.map(safePart).filter(Boolean),
          "consensus",
        ],
  )]
  const closedAt = input.closedAt ?? Date.now()
  const explicitMovePct = Number(input.pnlPct)
  const marketMovePct = Number.isFinite(explicitMovePct)
    ? explicitMovePct
    : input.pnl
  const positionCostPct =
    Number(input.positionCostPct) > 0 ? Number(input.positionCostPct) : 0.1
  // Previous-position quality is stored in PositionCost-relative units so
  // different volumes remain comparable. Older close callers and deterministic
  // tests may not yet carry pnlPct; their signed PnL is retained as a
  // compatibility fallback instead of silently dropping the outcome.
  const costRelativeRatio = movePctToMainTradePfRatio(
    marketMovePct,
    positionCostPct,
  )

  await Promise.all(sourceIds.map(async (sourceId) => {
    const key = performanceStateKey(input.connectionId, sourceId, input.symbol, input.direction)
    const marker = `${key}:position:${safePart(input.positionId)}`
    const sampleKey = `${key}:samples`
    const indexKey = `signal:performance:index:${safePart(input.connectionId)}`
    const sample = JSON.stringify({
      positionId: input.positionId,
      pnl: costRelativeRatio,
      marketMovePct,
      positionCostPct,
      closedAt,
    })
    if (typeof client.eval === "function") {
      try {
        const recorded = await client.eval(RECORD_SIGNAL_OUTCOME_LUA, {
          keys: [marker, sampleKey, key, indexKey],
          arguments: [
            String(closedAt),
            String(PERFORMANCE_TTL_SECONDS),
            sample,
            String(settings.performanceLookback),
            String(settings.performanceMinSamples),
            String(settings.performanceDisableBelowPnl),
            String(settings.performanceCooldownMinutes * 60_000),
            sourceId,
            normalizeSymbol(input.symbol),
            input.direction,
          ],
        })
        if (Number(recorded) === 0 || Number(recorded) === 1) return
      } catch {
        // The adapter-safe fallback below is also idempotent. If Redis
        // committed before a transport error, its marker prevents replay.
      }
    }
    const claimed = await client.set(marker, String(closedAt), {
      NX: true,
      EX: PERFORMANCE_TTL_SECONDS,
    }).catch(() => null)
    if (claimed !== "OK") return
    try {
      const write = client.multi()
      write.lpush(sampleKey, sample)
      write.ltrim(sampleKey, 0, settings.performanceLookback - 1)
      write.expire(sampleKey, PERFORMANCE_TTL_SECONDS)
      write.sadd(indexKey, key)
      write.expire(indexKey, PERFORMANCE_TTL_SECONDS)
      await write.exec()

      const rawSamples = await client.lrange(sampleKey, 0, settings.performanceLookback - 1)
      const pnls = rawSamples.map((raw) => {
        try {
          return Number(JSON.parse(raw)?.pnl)
        } catch {
          return Number.NaN
        }
      }).filter(Number.isFinite)
      const count = pnls.length
      const totalPnl = pnls.reduce((sum, pnl) => sum + pnl, 0)
      const wins = pnls.filter((pnl) => pnl > 0).length
      const grossProfit = pnls
        .filter((pnl) => pnl > 0)
        .reduce((sum, pnl) => sum + pnl, 0)
      const grossLoss = Math.abs(pnls
        .filter((pnl) => pnl < 0)
        .reduce((sum, pnl) => sum + pnl, 0))
      const profitFactor = grossLoss > 0
        ? grossProfit / grossLoss
        : grossProfit > 0
          ? 999
          : 0
      const autoDisabled =
        count >= settings.performanceMinSamples &&
        totalPnl < settings.performanceDisableBelowPnl
      const disabledUntil = autoDisabled
        ? closedAt + settings.performanceCooldownMinutes * 60_000
        : 0
      await client.hset(key, {
        sourceId,
        symbol: normalizeSymbol(input.symbol),
        direction: input.direction,
        count: String(count),
        wins: String(wins),
        grossProfit: String(grossProfit),
        grossLoss: String(grossLoss),
        profitFactor: String(profitFactor),
        totalPnl: String(totalPnl),
        averagePnl: String(count > 0 ? totalPnl / count : 0),
        winRate: String(count > 0 ? wins / count : 0),
        autoDisabled: autoDisabled ? "1" : "0",
        disabledUntil: String(disabledUntil),
        updatedAt: String(closedAt),
      })
      await client.expire(key, PERFORMANCE_TTL_SECONDS)
    } catch (error) {
      await client.del(marker).catch(() => 0)
      throw error
    }
  }))

  const v2IndexKey = `signal:performance:v2:index:${safePart(input.connectionId)}`
  const cooldownMs = settings.performanceCooldownMinutes * 60_000
  const attributedSources = sourceIds
  // Source, source×symbol×direction and exact-config rows all use the same
  // PositionCost-relative unit. Long+Short rows are stored beside the
  // direction-specific admission rows for independent aggregate analytics.
  await Promise.all(attributedSources.flatMap((sourceId) => [
    recordSignalPerformanceLane({
      client,
      key: signalPerformanceV2SourceKey(input.connectionId, sourceId),
      indexKey: v2IndexKey,
      markerId: input.positionId,
      sourceId,
      symbol: "_overall",
      direction: "overall",
      sampleValue: costRelativeRatio,
      closedAt,
      lookback: SIGNAL_SOURCE_PERFORMANCE_LOOKBACK,
      minimumSamples: SIGNAL_SOURCE_PERFORMANCE_LOOKBACK,
      disableBelowTotal: 0,
      cooldownMs,
      laneKind: "source",
    }),
    ...([input.direction, "overall"] as const).map((performanceDirection) =>
      recordSignalPerformanceLane({
        client,
        key: signalPerformanceV2LaneKey(
          input.connectionId,
          sourceId,
          input.symbol,
          performanceDirection,
        ),
        indexKey: v2IndexKey,
        markerId: input.positionId,
        sourceId,
        symbol: input.symbol,
        direction: performanceDirection,
        sampleValue: costRelativeRatio,
        closedAt,
        lookback: SIGNAL_LANE_PERFORMANCE_LOOKBACK,
        minimumSamples: SIGNAL_LANE_PERFORMANCE_LOOKBACK,
        disableBelowTotal: 0,
        cooldownMs,
        laneKind: "lane",
      }),
    ),
  ]))

  const exactLanes = Array.from(new Map(
    (input.signalLanes || []).map((lane) => {
      const normalized = {
        sourceId: safePart(String(lane.sourceId || "")),
        configId: String(lane.configId || ""),
      }
      return [`${normalized.sourceId}|${normalized.configId}`, normalized]
    }),
  ).values()).filter((lane) => lane.sourceId && lane.configId)
  await Promise.all(exactLanes.flatMap((lane) =>
    ([input.direction, "overall"] as const).flatMap((performanceDirection) => {
      const tasks: Promise<void>[] = [
        recordSignalPerformanceLane({
          client,
          key: signalPerformanceV2ConfigKey(
            input.connectionId,
            lane.sourceId,
            input.symbol,
            performanceDirection,
            lane.configId,
            false,
          ),
          indexKey: v2IndexKey,
          markerId: input.positionId,
          sourceId: lane.sourceId,
          symbol: input.symbol,
          direction: performanceDirection,
          sampleValue: costRelativeRatio,
          closedAt,
          lookback: SIGNAL_PERFORMANCE_LOOKBACK,
          minimumSamples: SIGNAL_PERFORMANCE_LOOKBACK,
          disableBelowTotal:
            settings.configMinimumPfRatio * SIGNAL_PERFORMANCE_LOOKBACK,
          cooldownMs,
          laneKind: "config",
          configId: lane.configId,
        }),
      ]
      if (input.liveExchange) {
        tasks.push(recordSignalPerformanceLane({
          client,
          key: signalPerformanceV2ConfigKey(
            input.connectionId,
            lane.sourceId,
            input.symbol,
            performanceDirection,
            lane.configId,
            true,
          ),
          indexKey: v2IndexKey,
          markerId: input.positionId,
          sourceId: lane.sourceId,
          symbol: input.symbol,
          direction: performanceDirection,
          sampleValue: costRelativeRatio,
          closedAt,
          lookback: SIGNAL_LIVE_DISABLE_LOOKBACK,
          minimumSamples: SIGNAL_LIVE_DISABLE_LOOKBACK,
          disableBelowTotal: 0,
          cooldownMs,
          laneKind: "live_config",
          configId: lane.configId,
          permanent: true,
        }))
      }
      return tasks
    }),
  ))
}

export async function listSignalPerformance(
  connectionId: string,
): Promise<SignalPerformanceState[]> {
  await initRedis()
  const client = getRedisClient()
  const indexKey = `signal:performance:index:${safePart(connectionId)}`
  const keys = await client.smembers(indexKey).catch(() => [])
  const states = await Promise.all(keys.map(async (key) => {
    const raw = await client.hgetall(key).catch(() => ({}))
    const parts = key.split(":")
    const direction = parts.at(-1) === "short" ? "short" : "long"
    const symbol = parts.at(-2) || "unknown"
    const sourceId = parts.at(-3) || "unknown"
    return parsePerformanceState(raw, sourceId, symbol, direction)
  }))
  return states.sort((left, right) =>
    left.symbol.localeCompare(right.symbol) ||
    left.direction.localeCompare(right.direction) ||
    left.sourceId.localeCompare(right.sourceId),
  )
}

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0
  const alpha = 2 / (period + 1)
  let current = values[0]
  for (let index = 1; index < values.length; index++) {
    current = values[index] * alpha + current * (1 - alpha)
  }
  return current
}

function rsi(values: number[], period = 14): number {
  if (values.length < 2) return 50
  const start = Math.max(1, values.length - period)
  let gains = 0
  let losses = 0
  let samples = 0
  for (let index = start; index < values.length; index++) {
    const delta = values[index] - values[index - 1]
    if (delta > 0) gains += delta
    else losses -= delta
    samples++
  }
  if (samples === 0) return 50
  const averageGain = gains / samples
  const averageLoss = losses / samples
  if (averageLoss === 0) return averageGain > 0 ? 100 : 50
  return 100 - 100 / (1 + averageGain / averageLoss)
}

function atr(candles: SignalCandle[], period = 14): number {
  if (candles.length < 2) return 0
  const start = Math.max(1, candles.length - period)
  let sum = 0
  let count = 0
  for (let index = start; index < candles.length; index++) {
    const current = candles[index]
    const previousClose = candles[index - 1].close
    sum += Math.max(
      current.high - current.low,
      Math.abs(current.high - previousClose),
      Math.abs(current.low - previousClose),
    )
    count++
  }
  return count > 0 ? sum / count : 0
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function recentReturn(closes: number[], periods: number): number {
  if (closes.length <= periods) return 0
  const previous = closes[closes.length - 1 - periods]
  const current = closes[closes.length - 1]
  return previous > 0 ? current / previous - 1 : 0
}

export function evaluateSignalCandles(input: {
  source: SignalSourceDefinition
  candles: SignalCandle[]
  settings: SignalIndicationSettings
  positionCostPct: number
  weight?: number
}): SignalSourceEvaluation | null {
  const candles = input.candles.slice(-Math.max(20, input.settings.candleLimit))
  if (candles.length < 20) return null
  const closes = candles.map((candle) => candle.close)
  const latest = candles[candles.length - 1]
  if (!(latest.close > 0)) return null

  const averageTrueRange = atr(candles)
  const fallbackRange = candles.slice(-10).reduce(
    (sum, candle) => sum + Math.abs(candle.close - candle.open),
    0,
  ) / Math.min(10, candles.length)
  const atrPct = (Math.max(averageTrueRange, fallbackRange) / latest.close) * 100
  const fast = ema(closes.slice(-30), 5)
  const slow = ema(closes.slice(-45), 13)
  const trendScale = Math.max(averageTrueRange, latest.close * 0.0005)
  const trendScore = clamp((fast - slow) / trendScale, -1, 1)
  const momentum3 = recentReturn(closes, 3)
  const momentum9 = recentReturn(closes, 9)
  const movementScale = Math.max(atrPct / 100, 0.0005)
  const momentumScore = clamp(momentum3 / movementScale, -1, 1)
  const rsiScore = clamp((rsi(closes) - 50) / 30, -1, 1)
  const rangeWindow = candles.slice(-14)
  const rangeHigh = Math.max(...rangeWindow.map((candle) => candle.high))
  const rangeLow = Math.min(...rangeWindow.map((candle) => candle.low))
  const rangeScore = rangeHigh > rangeLow
    ? clamp(((latest.close - rangeLow) / (rangeHigh - rangeLow) - 0.5) * 2, -1, 1)
    : 0
  const recentVolumes = candles.slice(-20).map((candle) => candle.volume).filter((volume) => volume > 0)
  const averageVolume = recentVolumes.length > 0
    ? recentVolumes.reduce((sum, volume) => sum + volume, 0) / recentVolumes.length
    : 0
  const volumeImpulse = averageVolume > 0
    ? clamp((latest.volume / averageVolume - 1) * Math.sign(momentum3 || trendScore), -1, 1)
    : 0
  const rawScore =
    trendScore * 0.35 +
    momentumScore * 0.3 +
    rsiScore * 0.18 +
    rangeScore * 0.12 +
    volumeImpulse * 0.05
  const strength = Math.abs(rawScore)
  if (!Number.isFinite(strength) || strength < input.settings.minimumStrength) return null

  const positionCostFloor = Math.max(0, Number(input.positionCostPct) || 0) + 0.08
  const rawStopLossPct = atrPct * input.settings.stopLossAtrMultiplier + positionCostFloor
  // A tight stop in a volatile market is not a low-risk trade; it is merely a
  // likely stop-out. Reject instead of clipping when the required ATR band is
  // materially above the configured short-trade ceiling.
  if (rawStopLossPct > input.settings.stopLossMaxPct * 1.25) return null
  const stopLossPct = clamp(
    rawStopLossPct,
    input.settings.stopLossMinPct,
    input.settings.stopLossMaxPct,
  )
  const rewardRisk = input.settings.takeProfitRewardRisk
  const minimumTakeProfitPct = stopLossPct * rewardRisk
  if (minimumTakeProfitPct > input.settings.takeProfitMaxPct) return null
  const momentumTarget = Math.abs(momentum9) * 100 * 0.75
  const takeProfitPct = clamp(
    Math.max(minimumTakeProfitPct, momentumTarget),
    minimumTakeProfitPct,
    input.settings.takeProfitMaxPct,
  )
  const confidence = clamp(
    0.5 + strength * 0.45 + Math.min(0.04, candles.length / 2500),
    0.5,
    0.99,
  )
  if (confidence < input.settings.minimumConfidence) return null

  return {
    sourceId: input.source.id,
    sourceName: input.source.name,
    direction: rawScore >= 0 ? "long" : "short",
    confidence,
    strength,
    stopLossPct,
    takeProfitPct,
    rewardRisk: takeProfitPct / stopLossPct,
    atrPct,
    lastPrice: latest.close,
    candleCount: candles.length,
    weight: boundedNumber(input.weight, 1, 0.1, 2),
  }
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return []
  const output = new Array<R>(values.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(values.length, concurrency)) },
    async () => {
      while (cursor < values.length) {
        const index = cursor++
        output[index] = await mapper(values[index], index)
      }
    },
  )
  await Promise.all(workers)
  return output
}

function sourceHealthKey(connectionId: string, sourceId: string): string {
  return `${safePart(connectionId)}:${safePart(sourceId)}`
}

function defaultSourceHealth(sourceId: string): SignalSourceHealth {
  return {
    sourceId,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    lastLatencyMs: 0,
    lastCandleCount: 0,
    circuitOpenUntil: 0,
  }
}

async function persistSourceHealth(
  client: RedisClientLike,
  connectionId: string,
  health: SignalSourceHealth,
): Promise<void> {
  await client.hset(`signal:source_health:${safePart(connectionId)}`, health.sourceId, JSON.stringify(health))
  await client.expire(`signal:source_health:${safePart(connectionId)}`, HEALTH_TTL_SECONDS)
}

async function updateSourceHealth(
  client: RedisClientLike,
  connectionId: string,
  source: SignalSourceDefinition,
  update: {
    success: boolean
    latencyMs: number
    candleCount?: number
    error?: unknown
    settings: SignalIndicationSettings
    now: number
    stopLossPct?: number
  },
): Promise<SignalSourceHealth> {
  const key = sourceHealthKey(connectionId, source.id)
  const previous = HEALTH_CACHE.get(key) ?? defaultSourceHealth(source.id)
  const errorText = update.error instanceof Error ? update.error.message : String(update.error || "")
  const health: SignalSourceHealth = update.success
    ? {
        ...previous,
        successes: previous.successes + 1,
        consecutiveFailures: 0,
        lastLatencyMs: update.latencyMs,
        lastCandleCount: update.candleCount ?? previous.lastCandleCount,
        lastStopLossPct: update.stopLossPct ?? previous.lastStopLossPct,
        lastSuccessAt: update.now,
        lastError: undefined,
        circuitOpenUntil: 0,
      }
    : {
        ...previous,
        failures: previous.failures + 1,
        consecutiveFailures: previous.consecutiveFailures + 1,
        lastLatencyMs: update.latencyMs,
        lastFailureAt: update.now,
        lastError: errorText.replace(/\s+/g, " ").slice(0, 240),
        circuitOpenUntil:
          previous.consecutiveFailures + 1 >= update.settings.circuitFailureThreshold
            ? update.now + update.settings.circuitCooldownSeconds * 1000
            : previous.circuitOpenUntil,
      }
  HEALTH_CACHE.set(key, health)
  await persistSourceHealth(client, connectionId, health).catch(() => {})
  return health
}

async function updateSourceStopLoss(
  client: RedisClientLike,
  connectionId: string,
  source: SignalSourceDefinition,
  stopLossPct: number,
): Promise<void> {
  const key = sourceHealthKey(connectionId, source.id)
  const previous = HEALTH_CACHE.get(key) ?? defaultSourceHealth(source.id)
  const next = { ...previous, lastStopLossPct: stopLossPct }
  HEALTH_CACHE.set(key, next)
  await persistSourceHealth(client, connectionId, next).catch(() => {})
}

function trimFetchCache(now: number): void {
  for (const [key, cached] of FETCH_CACHE) {
    if (cached.expiresAt <= now) FETCH_CACHE.delete(key)
  }
  while (FETCH_CACHE.size >= FETCH_CACHE_MAX) {
    const oldest = FETCH_CACHE.keys().next().value
    if (oldest === undefined) break
    FETCH_CACHE.delete(oldest)
  }
}

function buildSimulatedSignalCandles(
  symbol: string,
  sourceId: string,
  limit: number,
  now: number,
): SignalCandle[] {
  const symbolSeed = [...normalizeSymbol(symbol)].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  const sourceSeed = [...sourceId].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  const base = 50 + (symbolSeed % 450) + (sourceSeed % 7) / 10
  const count = Math.max(20, limit)
  return Array.from({ length: count }, (_, index) => {
    // Deterministic, liquid-looking upward candles make every enabled source
    // exercise the same Signal consensus path in FORCE_SIMULATED debug/soak
    // runs without issuing an external HTTP request.
    const previous = base * (1 + Math.max(0, index - 1) * 0.0008)
    const close = base * (1 + index * 0.0008)
    return {
      timestamp: now - (count - 1 - index) * 60_000,
      open: previous,
      high: Math.max(previous, close) * 1.0006,
      low: Math.min(previous, close) * 0.9994,
      close,
      volume: 1_000 + index * 5 + (sourceSeed % 31),
    }
  })
}

async function fetchSourceCandles(input: {
  client: RedisClientLike
  connectionId: string
  source: SignalSourceDefinition
  symbol: string
  settings: SignalIndicationSettings
  now: number
  fetchImpl: typeof fetch
  useCache: boolean
}): Promise<SignalCandle[]> {
  const healthKey = sourceHealthKey(input.connectionId, input.source.id)
  let health = HEALTH_CACHE.get(healthKey)
  if (!health) {
    const persisted = await input.client
      .hget(`signal:source_health:${safePart(input.connectionId)}`, input.source.id)
      .catch(() => null)
    if (persisted) {
      try {
        health = { ...defaultSourceHealth(input.source.id), ...JSON.parse(persisted) }
        HEALTH_CACHE.set(healthKey, health)
      } catch {
        health = undefined
      }
    }
  }
  if (health && health.circuitOpenUntil > input.now) {
    throw new Error(`circuit_open_until_${health.circuitOpenUntil}`)
  }
  const cacheKey = [
    safePart(input.connectionId),
    input.source.id,
    normalizeSymbol(input.symbol),
    input.settings.timeframeMinutes,
    input.settings.candleLimit,
  ].join(":")
  if (input.useCache) {
    const cached = FETCH_CACHE.get(cacheKey)
    if (cached && cached.expiresAt > input.now) return cached.promise
  }

  const requestPromise = (async () => {
    const startedAt = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), input.settings.requestTimeoutMs)
    try {
      const request = input.source.buildRequest({
        symbol: input.symbol,
        limit: input.settings.candleLimit,
        now: input.now,
      })
      const response = await input.fetchImpl(request.url, {
        ...request.init,
        headers: {
          Accept: "application/json",
          ...(request.init?.headers || {}),
        },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`http_${response.status}`)
      const contentType = response.headers.get("content-type") || ""
      if (contentType && !contentType.toLowerCase().includes("json")) {
        throw new Error(`unexpected_content_type_${contentType.split(";")[0]}`)
      }
      const payload = await response.json()
      const candles = input.source.parse(payload).slice(-input.settings.candleLimit)
      if (candles.length < 20) throw new Error(`insufficient_candles_${candles.length}`)
      await updateSourceHealth(input.client, input.connectionId, input.source, {
        success: true,
        latencyMs: Date.now() - startedAt,
        candleCount: candles.length,
        settings: input.settings,
        now: input.now,
      })
      return candles
    } catch (error) {
      await updateSourceHealth(input.client, input.connectionId, input.source, {
        success: false,
        latencyMs: Date.now() - startedAt,
        error,
        settings: input.settings,
        now: input.now,
      })
      throw error
    } finally {
      clearTimeout(timeout)
    }
  })()

  if (input.useCache) {
    trimFetchCache(input.now)
    FETCH_CACHE.set(cacheKey, {
      expiresAt: input.now + input.settings.requestIntervalSeconds * 1000,
      promise: requestPromise,
    })
    requestPromise.catch(() => {
      const cached = FETCH_CACHE.get(cacheKey)
      if (cached?.promise === requestPromise) FETCH_CACHE.delete(cacheKey)
    })
  }
  return requestPromise
}

function selectSources(
  settings: SignalIndicationSettings,
  symbol: string,
  cursor: number,
): SignalSourceDefinition[] {
  const enabled = SIGNAL_SOURCE_DEFINITIONS.filter((source) =>
    settings.sources[source.id]?.enabled !== false &&
    !settings.sources[source.id]?.disabledSymbols.includes(normalizeSymbol(symbol)) &&
    signalSourceSupportsSymbol(source, symbol),
  )
  const max = Math.min(settings.maxSourcesPerCycle, enabled.length)
  if (enabled.length <= max) return [...enabled]

  const core = CORE_SOURCE_IDS
    .map((id) => enabled.find((source) => source.id === id))
    .filter((source): source is SignalSourceDefinition => Boolean(source))
    .slice(0, Math.min(4, max))
  const coreIds = new Set(core.map((source) => source.id))
  const rotating = enabled
    .filter((source) => !coreIds.has(source.id))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
  const slots = max - core.length
  if (slots <= 0 || rotating.length === 0) return core
  // Advance by a complete page, not by one source. This preserves the
  // always-on liquid core while covering every enabled secondary source in
  // ceil(rotating / slots) uncached cycles instead of repeatedly fetching
  // almost the same overlapping page.
  const start = (Math.abs(cursor) * slots) % rotating.length
  const selected = [...core]
  for (let offset = 0; offset < rotating.length && selected.length < max; offset++) {
    selected.push(rotating[(start + offset) % rotating.length])
  }
  return selected
}

function lowStopConsensus(
  evaluations: SignalSourceEvaluation[],
  settings: SignalIndicationSettings,
): { direction: SignalDirection; contributors: SignalSourceEvaluation[]; risk: SignalRisk } | null {
  if (evaluations.length < settings.minimumSourceSignals) return null
  const voteWeight = (evaluation: SignalSourceEvaluation) => {
    const lowStopBonus = 1 + 0.2 * (1 - evaluation.stopLossPct / settings.stopLossMaxPct)
    return evaluation.weight * evaluation.confidence * evaluation.strength * lowStopBonus
  }
  const byDirection = {
    long: evaluations.filter((evaluation) => evaluation.direction === "long"),
    short: evaluations.filter((evaluation) => evaluation.direction === "short"),
  }
  const longWeight = byDirection.long.reduce((sum, evaluation) => sum + voteWeight(evaluation), 0)
  const shortWeight = byDirection.short.reduce((sum, evaluation) => sum + voteWeight(evaluation), 0)
  const totalWeight = longWeight + shortWeight
  if (!(totalWeight > 0)) return null
  const direction: SignalDirection = longWeight >= shortWeight ? "long" : "short"
  const contributors = byDirection[direction]
  const winningWeight = direction === "long" ? longWeight : shortWeight
  const agreement = winningWeight / totalWeight
  if (contributors.length < settings.minimumSourceSignals || agreement < settings.minimumAgreement) return null

  const orderedByStop = [...contributors].sort(
    (left, right) => left.stopLossPct - right.stopLossPct || right.confidence - left.confidence,
  )
  const lowRiskPool = orderedByStop.slice(0, Math.max(1, Math.ceil(orderedByStop.length / 2)))
  const riskWeight = lowRiskPool.reduce((sum, evaluation) => sum + voteWeight(evaluation), 0)
  const stopLossPct = clamp(
    lowRiskPool.reduce(
      (sum, evaluation) => sum + evaluation.stopLossPct * voteWeight(evaluation),
      0,
    ) / Math.max(riskWeight, Number.EPSILON),
    settings.stopLossMinPct,
    settings.stopLossMaxPct,
  )
  const averageRewardRisk = contributors.reduce(
    (sum, evaluation) => sum + evaluation.rewardRisk * voteWeight(evaluation),
    0,
  ) / winningWeight
  const rewardRisk = clamp(
    Math.max(settings.takeProfitRewardRisk, averageRewardRisk),
    1.1,
    5,
  )
  const minimumTakeProfitPct = stopLossPct * settings.takeProfitRewardRisk
  if (minimumTakeProfitPct > settings.takeProfitMaxPct) return null
  const takeProfitPct = clamp(
    Math.max(
      stopLossPct * rewardRisk,
      lowRiskPool.reduce((sum, evaluation) => sum + evaluation.takeProfitPct, 0) / lowRiskPool.length,
    ),
    minimumTakeProfitPct,
    settings.takeProfitMaxPct,
  )
  const confidence = clamp(
    agreement * 0.55 +
    contributors.reduce((sum, evaluation) => sum + evaluation.confidence, 0) / contributors.length * 0.45,
    0.5,
    0.99,
  )
  return {
    direction,
    contributors,
    risk: {
      stopLossPct,
      takeProfitPct,
      rewardRisk: takeProfitPct / stopLossPct,
      sourceIds: contributors.map((evaluation) => evaluation.sourceId),
      agreement,
      confidence,
      generatedAt: Date.now(),
    },
  }
}

export function normalizeSignalRisk(value: unknown): SignalRisk | undefined {
  const raw = value && typeof value === "object" ? value as Record<string, any> : {}
  const sourceIds = Array.isArray(raw.sourceIds)
    ? [...new Set(raw.sourceIds.map((item: unknown) => safePart(String(item))).filter(Boolean))]
    : []
  const stopLossPct = Number(raw.stopLossPct)
  const takeProfitPct = Number(raw.takeProfitPct)
  if (
    sourceIds.length === 0 ||
    !Number.isFinite(stopLossPct) ||
    !Number.isFinite(takeProfitPct) ||
    stopLossPct <= 0 ||
    takeProfitPct <= 0
  ) {
    return undefined
  }
  return {
    stopLossPct,
    takeProfitPct,
    rewardRisk: Number(raw.rewardRisk) > 0 ? Number(raw.rewardRisk) : takeProfitPct / stopLossPct,
    sourceIds,
    ...(raw.sourceId && { sourceId: safePart(String(raw.sourceId)) }),
    ...(raw.configId && { configId: String(raw.configId) }),
    ...(Array.isArray(raw.configIds) && {
      configIds: [...new Set(raw.configIds.map((item: unknown) => String(item)).filter(Boolean))],
    }),
    ...(Array.isArray(raw.signalLanes) && {
      signalLanes: Array.from(
        new Map(
          raw.signalLanes
            .map((lane: any) => ({
              sourceId: safePart(String(lane?.sourceId || "")),
              configId: String(lane?.configId || ""),
            }))
            .filter((lane: { sourceId: string; configId: string }) =>
              Boolean(lane.sourceId && lane.configId),
            )
            .map((lane: { sourceId: string; configId: string }) => [
              `${lane.sourceId}|${lane.configId}`,
              lane,
            ]),
        ).values(),
      ),
    }),
    ...(raw.trailing !== undefined && { trailing: bool(raw.trailing, false) }),
    ...(Number(raw.trailingStopPct) > 0 && {
      trailingStopPct: Number(raw.trailingStopPct),
    }),
    agreement: clamp(Number(raw.agreement) || 0, 0, 1),
    confidence: clamp(Number(raw.confidence) || 0, 0, 1),
    generatedAt: Math.max(0, Number(raw.generatedAt) || Date.now()),
  }
}

/**
 * Merge Signal attribution when a Signal/default or Signal/Block leg joins an
 * already-open position owned by another indication type.
 *
 * Source ids are a union for terminal per-source PnL booking. Protection uses
 * the tightest positive SL and TP percentages observed so an accumulation can
 * never silently widen an already-established risk contract.
 */
export function mergeSignalRisks(...values: unknown[]): SignalRisk | undefined {
  const risks = values
    .map(normalizeSignalRisk)
    .filter((risk): risk is SignalRisk => Boolean(risk))
  if (risks.length === 0) return undefined
  if (risks.length === 1) return {
    ...risks[0],
    sourceIds: [...risks[0].sourceIds],
    ...(risks[0].configIds && { configIds: [...risks[0].configIds] }),
    ...(risks[0].signalLanes && {
      signalLanes: risks[0].signalLanes.map((lane) => ({ ...lane })),
    }),
  }

  const stopLossPct = Math.min(...risks.map((risk) => risk.stopLossPct))
  const takeProfitPct = Math.min(...risks.map((risk) => risk.takeProfitPct))
  return {
    stopLossPct,
    takeProfitPct,
    rewardRisk: takeProfitPct / stopLossPct,
    sourceIds: [...new Set(risks.flatMap((risk) => risk.sourceIds))],
    configIds: [...new Set(risks.flatMap((risk) =>
      risk.configIds?.length
        ? risk.configIds
        : risk.configId
          ? [risk.configId]
          : [],
    ))],
    signalLanes: Array.from(
      new Map(
        risks
          .flatMap((risk) => risk.signalLanes || [])
          .map((lane) => [`${lane.sourceId}|${lane.configId}`, { ...lane }]),
      ).values(),
    ),
    agreement: Math.max(...risks.map((risk) => risk.agreement)),
    confidence: Math.max(...risks.map((risk) => risk.confidence)),
    generatedAt: Math.max(...risks.map((risk) => risk.generatedAt)),
  }
}

async function persistSignalCycle(
  client: RedisClientLike,
  connectionId: string,
  symbol: string,
  indications: any[],
  settings: SignalIndicationSettings,
  diagnostic: Record<string, unknown>,
): Promise<void> {
  const activeCount = indications.length
  const pipeline = client.multi()
  const activeKey = `indication_sets_active:${connectionId}`
  const activeRawKey = `indications_active:${connectionId}`
  const setWindow5 = `indication_sets_window:${connectionId}:last5`
  const setWindow60 = `indication_sets_window:${connectionId}:last60min`
  const rawWindow5 = `indications_window:${connectionId}:last5`
  const rawWindow60 = `indications_window:${connectionId}:last60min`
  for (const key of [activeKey, activeRawKey, setWindow5, setWindow60, rawWindow5, rawWindow60]) {
    pipeline.hset(key, `${symbol}:signal`, String(activeCount))
  }
  pipeline.expire(activeKey, 600)
  pipeline.expire(activeRawKey, 600)
  pipeline.expire(setWindow5, 300)
  pipeline.expire(setWindow60, 4200)
  pipeline.expire(rawWindow5, 300)
  pipeline.expire(rawWindow60, 4200)

  for (const indication of indications) {
    const direction = indication?.metadata?.direction
    if (direction !== "long" && direction !== "short") continue
    const sourceId = safePart(
      indication?.metadata?.signal?.sourceId ||
      indication?.metadata?.signal?.sourceIds?.[0] ||
      "consensus",
    )
    const setKey =
      `indication_set:${connectionId}:${symbol}:signal:${direction}:source:${sourceId}`
    const entry = {
      id: `signal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date(indication.timestamp || Date.now()).toISOString(),
      type: "signal",
      direction,
      profitFactor: indication.profitFactor,
      signalScore: indication.signalScore,
      rawSignalStrength: indication.rawSignalStrength,
      confidence: indication.confidence,
      config: {
        sourceId,
        sourceIds: indication.metadata?.signal?.sourceIds || [],
        timeframeMinutes: settings.timeframeMinutes,
      },
      metadata: indication.metadata,
    }
    pipeline.rpush(setKey, JSON.stringify(entry))
    pipeline.ltrim(setKey, -settings.databaseSize, -1)
    pipeline.sadd(`indication_sets:index:${connectionId}`, setKey)
    pipeline.sadd(`indication_sets:index:${connectionId}:${symbol}`, setKey)
    pipeline.sadd(`indication_sets:index:${connectionId}:${symbol}:signal`, setKey)
  }
  if (activeCount > 0) {
    pipeline.hincrby(`progression:${connectionId}`, "indication_sets_total", activeCount)
  }
  const diagnosticKey = `signal:cycle:${safePart(connectionId)}:${normalizeSymbol(symbol)}`
  pipeline.set(diagnosticKey, JSON.stringify({ ...diagnostic, timestamp: Date.now() }))
  pipeline.expire(diagnosticKey, 3600)
  const rankKey = signalCandidateRankKey(connectionId)
  const primary = indications[0]
  if (
    primary &&
    (primary.direction === "long" || primary.direction === "short")
  ) {
    const confidence = clamp(Number(primary.confidence) || 0, 0, 1)
    const agreement = clamp(Number(primary.metadata?.signal?.agreement) || 0, 0, 1)
    const strength = clamp(Number(primary.rawSignalStrength) || 0, 0, 1)
    const rewardRisk = clamp(Number(primary.metadata?.signal?.rewardRisk) || 0, 0, 5)
    pipeline.hset(rankKey, normalizeSymbol(symbol), JSON.stringify({
      symbol: normalizeSymbol(symbol),
      direction: primary.direction,
      score: calculateSignalCandidateQuality({
        confidence,
        agreement,
        strength,
        rewardRisk,
      }),
      confidence,
      agreement,
      strength,
      rewardRisk,
      generatedAt: Number(primary.timestamp) || Date.now(),
      expiresAt: Date.now() + Math.max(120_000, settings.requestIntervalSeconds * 3_000),
    }))
  } else {
    pipeline.hdel(rankKey, normalizeSymbol(symbol))
  }
  pipeline.expire(rankKey, 24 * 60 * 60)
  await pipeline.exec()
}

async function processSignalIndicationsUncached(
  options: ProcessSignalIndicationsOptions,
): Promise<any[]> {
  const settings = normalizeSignalIndicationSettings(options.settings)
  const now = options.now ?? Date.now()
  await initRedis()
  const client = getRedisClient()
  const shouldPersist = options.persist !== false
  if (!settings.enabled) {
    if (shouldPersist) {
      await persistSignalCycle(client, options.connectionId, options.symbol, [], settings, {
        enabled: false,
        selectedSources: 0,
        successfulSources: 0,
      }).catch(() => {})
    }
    return []
  }

  // General Jest suites must not start hundreds of real internet requests.
  // Dedicated adapter/live-source tests pass an explicit fetch implementation.
  if (
    process.env.NODE_ENV === "test" &&
    !options.fetchImpl &&
    process.env.FORCE_SIMULATED !== "1"
  ) return []

  const sourceCursor = options.sourceCursor ?? await client
    .incr(`signal:source_cursor:${safePart(options.connectionId)}:${normalizeSymbol(options.symbol)}`)
    .catch(() => 0)
  client.expire(
    `signal:source_cursor:${safePart(options.connectionId)}:${normalizeSymbol(options.symbol)}`,
    86400,
  ).catch(() => 0)
  const sources = selectSources(settings, options.symbol, sourceCursor)
  const fetchImpl = options.fetchImpl ?? fetch
  const simulatedSourceData =
    !options.fetchImpl &&
    process.env.FORCE_SIMULATED === "1" &&
    process.env.FORCE_LIVE !== "1"

  const fetched = await mapLimit(sources, settings.concurrency, async (source) => {
    try {
      const candles = simulatedSourceData
        ? buildSimulatedSignalCandles(
            options.symbol,
            source.id,
            settings.candleLimit,
            now,
          )
        : await fetchSourceCandles({
            client,
            connectionId: options.connectionId,
            source,
            symbol: options.symbol,
            settings,
            now,
            fetchImpl,
            useCache: !options.fetchImpl,
          })
      if (simulatedSourceData) {
        await updateSourceHealth(client, options.connectionId, source, {
          success: true,
          latencyMs: 0,
          candleCount: candles.length,
          settings,
          now,
        })
      }
      const evaluation = evaluateSignalCandles({
        source,
        candles,
        settings,
        positionCostPct: Number(options.positionCostPct) || 0.1,
        weight: settings.sources[source.id]?.weight,
      })
      if (evaluation) {
        await updateSourceStopLoss(
          client,
          options.connectionId,
          source,
          evaluation.stopLossPct,
        )
      }
      return evaluation
    } catch {
      return null
    }
  })
  const evaluated = fetched.filter((evaluation): evaluation is SignalSourceEvaluation => Boolean(evaluation))

  const allowedEvaluations = (await Promise.all(evaluated.map(async (evaluation) => {
    if (signalSourceLaneManuallyDisabled(
      settings,
      evaluation.sourceId,
      options.symbol,
      evaluation.direction,
    )) {
      return null
    }
    const decision = await getSignalSourceLanePerformanceDecision(client, {
      connectionId: options.connectionId,
      sourceId: evaluation.sourceId,
      symbol: options.symbol,
      direction: evaluation.direction,
    })
    return decision.allowed ? evaluation : null
  }))).filter((evaluation): evaluation is SignalSourceEvaluation => Boolean(evaluation))

  const consensus = lowStopConsensus(allowedEvaluations, settings)
  const indications: any[] = []
  // Every website source remains an independent Signal lane. Source and
  // source×symbol diagnostics do not suppress another exact configuration;
  // exact Previous-position quality is enforced downstream.
  const directSources = [...allowedEvaluations].sort(
    (left, right) =>
      left.stopLossPct - right.stopLossPct ||
      right.confidence - left.confidence ||
      right.strength - left.strength ||
      left.sourceId.localeCompare(right.sourceId),
  )
  for (const evaluation of directSources) {
    indications.push({
      type: "signal",
      symbol: options.symbol,
      value: evaluation.lastPrice,
      profitFactor: evaluation.rewardRisk,
      signalScore: evaluation.rewardRisk,
      rawSignalStrength: evaluation.strength,
      confidence: evaluation.confidence,
      timestamp: now,
      direction: evaluation.direction,
      metadata: {
        direction: evaluation.direction,
        primary: indications.length === 0,
        mode: "direct_source",
        signal: {
          sourceId: evaluation.sourceId,
          sourceIds: [evaluation.sourceId],
          stopLossPct: evaluation.stopLossPct,
          takeProfitPct: evaluation.takeProfitPct,
          rewardRisk: evaluation.rewardRisk,
          agreement: 1,
          confidence: evaluation.confidence,
          generatedAt: now,
          atrPct: evaluation.atrPct,
          candleCount: evaluation.candleCount,
          selectedSourceCount: sources.length,
          evaluatedSourceCount: evaluated.length,
          allowedSourceCount: allowedEvaluations.length,
        },
      },
    })
  }
  if (consensus) {
    const consensusDecision = await getSignalPerformanceDecision(client, {
      connectionId: options.connectionId,
      sourceId: "consensus",
      symbol: options.symbol,
      direction: consensus.direction,
      settings,
      now,
    })
    if (consensusDecision.allowed) {
      const sourceSummary = consensus.contributors.map((evaluation) => ({
        sourceId: evaluation.sourceId,
        direction: evaluation.direction,
        confidence: evaluation.confidence,
        strength: evaluation.strength,
        stopLossPct: evaluation.stopLossPct,
        takeProfitPct: evaluation.takeProfitPct,
        atrPct: evaluation.atrPct,
        candleCount: evaluation.candleCount,
      }))
      indications.push({
        type: "signal",
        symbol: options.symbol,
        value: consensus.contributors.reduce(
          (sum, evaluation) => sum + evaluation.lastPrice,
          0,
        ) / consensus.contributors.length,
        profitFactor: consensus.risk.rewardRisk,
        signalScore: consensus.risk.rewardRisk,
        rawSignalStrength: consensus.contributors.reduce(
          (sum, evaluation) => sum + evaluation.strength,
          0,
        ) / consensus.contributors.length,
        confidence: consensus.risk.confidence,
        timestamp: now,
        direction: consensus.direction,
        metadata: {
          direction: consensus.direction,
          primary: true,
          mode: "multi_source_consensus",
          signal: {
            ...consensus.risk,
            sourceId: "consensus",
            contributors: sourceSummary,
            selectedSourceCount: sources.length,
            evaluatedSourceCount: evaluated.length,
            allowedSourceCount: allowedEvaluations.length,
            performanceProbe: consensusDecision.probe,
          },
        },
      })
    }
  }

  if (shouldPersist) {
    await persistSignalCycle(client, options.connectionId, options.symbol, indications, settings, {
      enabled: true,
      selectedSources: sources.map((source) => source.id),
      successfulSources: evaluated.map((evaluation) => evaluation.sourceId),
      performanceAllowedSources: allowedEvaluations.map((evaluation) => evaluation.sourceId),
      direction: indications[0]?.metadata?.direction ?? null,
      sourceRegistrySize: SIGNAL_SOURCE_DEFINITIONS.length,
    }).catch(() => {})
  }
  return indications
}

export async function processSignalIndications(
  options: ProcessSignalIndicationsOptions,
): Promise<any[]> {
  const settings = normalizeSignalIndicationSettings(options.settings)
  // Explicit fetch implementations are test/diagnostic calls and deliberately
  // bypass the production cycle cache so every requested adapter is exercised.
  if (options.fetchImpl || options.persist === false || !settings.enabled) {
    return processSignalIndicationsUncached({ ...options, settings })
  }
  const now = options.now ?? Date.now()
  const settingsFingerprint = JSON.stringify({
    directExecutionEnabled: settings.directExecutionEnabled,
    timeframeMinutes: settings.timeframeMinutes,
    candleLimit: settings.candleLimit,
    maxSourcesPerCycle: settings.maxSourcesPerCycle,
    maxPositionsTotal: settings.maxPositionsTotal,
    positionSelectionMode: settings.positionSelectionMode,
    requestIntervalSeconds: settings.requestIntervalSeconds,
    minimumSourceSignals: settings.minimumSourceSignals,
    minimumAgreement: settings.minimumAgreement,
    minimumConfidence: settings.minimumConfidence,
    minimumStrength: settings.minimumStrength,
    stopLossMinPct: settings.stopLossMinPct,
    stopLossMaxPct: settings.stopLossMaxPct,
    stopLossAtrMultiplier: settings.stopLossAtrMultiplier,
    takeProfitRewardRisk: settings.takeProfitRewardRisk,
    takeProfitMaxPct: settings.takeProfitMaxPct,
    configMinimumPfRatio: settings.configMinimumPfRatio,
    sources: settings.sources,
  })
  const key = `${safePart(options.connectionId)}:${normalizeSymbol(options.symbol)}:${settingsFingerprint}`
  const cached = CYCLE_CACHE.get(key)
  if (cached && cached.expiresAt > now) return cached.indications
  const inflight = CYCLE_INFLIGHT.get(key)
  if (inflight) return inflight

  while (CYCLE_CACHE.size >= CYCLE_CACHE_MAX) {
    const oldest = CYCLE_CACHE.keys().next().value
    if (oldest === undefined) break
    CYCLE_CACHE.delete(oldest)
  }
  const generation = globalSignalState.__signalCycleGeneration ?? 0
  const promise = processSignalIndicationsUncached({ ...options, settings, now })
    .then((indications) => {
      if ((globalSignalState.__signalCycleGeneration ?? 0) === generation) {
        CYCLE_CACHE.set(key, {
          expiresAt: now + settings.requestIntervalSeconds * 1000,
          indications,
        })
      }
      return indications
    })
    .finally(() => {
      if (CYCLE_INFLIGHT.get(key) === promise) CYCLE_INFLIGHT.delete(key)
    })
  CYCLE_INFLIGHT.set(key, promise)
  return promise
}

export async function getSignalSourceHealth(connectionId: string): Promise<SignalSourceHealth[]> {
  await initRedis()
  const raw: Record<string, string> = await getRedisClient()
    .hgetall(`signal:source_health:${safePart(connectionId)}`)
    .catch(() => ({} as Record<string, string>))
  return SIGNAL_SOURCE_DEFINITIONS.map((source) => {
    try {
      const parsed = raw[source.id] ? JSON.parse(raw[source.id]) : {}
      return { ...defaultSourceHealth(source.id), ...parsed, sourceId: source.id }
    } catch {
      return defaultSourceHealth(source.id)
    }
  })
}

export const __signalIndicationTestUtils = {
  atr,
  clearCaches(): void {
    FETCH_CACHE.clear()
    HEALTH_CACHE.clear()
    invalidateSignalCycleCache()
  },
  ema,
  lowStopConsensus,
  rsi,
  selectSources,
}
