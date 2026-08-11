import { type NextRequest, NextResponse } from "next/server"
import { getSettings, setSettings, getRedisClient, initRedis } from "@/lib/redis-db"
import {
  clampDirectTradeSymbolCount,
  DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION,
  DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL,
} from "@/lib/direct-trade-limits"
import {
  normaliseDirectTradeTimeframes,
  normaliseDirectTradeStrategyTypes,
  normaliseEntryTactics,
  normaliseExitTactics,
  normaliseDirectTradeTakeProfitRatioRange,
  normaliseDirectTradeTakeProfitRatioStep,
  DIRECT_TRADE_RECENT_PF_DEFAULT,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_STEP_DEFAULT,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE,
  type DirectTradeEntryTiming,
  type DirectTradeEntryTactic,
  type DirectTradeExitTactic,
  type DirectTradeTimeframe,
  type DirectTradeStrategyType,
} from "@/lib/direct-trade-coordination"
import {
  DIRECT_TRADE_ACTIVE_SIGNAL_KEYS_KEY,
  DIRECT_TRADE_EXECUTION_INDEX_KEY,
  DIRECT_TRADE_EXECUTION_SIGNAL_INDEX_KEY,
  getDirectTradeConfigManifest,
  readDirectTradeConfigsAtIndexes,
} from "@/lib/direct-trade-config-store"
import { normalizePositionCostPercent, POSITION_COST_PERCENT_DEFAULT } from "@/lib/position-cost"
import { DEFAULT_DCA_PROFILE, normalizeDcaProfile, type DcaProfile } from "@/lib/dca-strategy"
import {
  buildDirectTradeOpenPositionStage,
  DIRECT_TRADE_OPEN_POSITION_STAGE_KEY,
} from "@/lib/direct-trade-position-stage"

export const dynamic = "force-dynamic"

const DIRECT_TRADE_STATE_KEY = "direct_trade:state"
const DIRECT_TRADE_EXECUTION_CONFIGS_KEY = "direct_trade:execution-configs"
const DIRECT_TRADE_STATS_KEY = "direct_trade:stats"
const DIRECT_TRADE_POSITIONS_KEY = "direct_trade:positions"
const DIRECT_TRADE_PROCESSOR_KEY = "direct_trade:processor"
const DIRECT_TRADE_PROCESSOR_LEASE_KEY = "direct_trade:processor:lease"
const DIRECT_TRADE_CONFIG_STATUS_KEY = "direct_trade:config-status"
const DIRECT_TRADE_CONFIG_PERFORMANCE_KEY = "direct_trade:config-performance"
const DIRECT_TRADE_CALCULATION_KEY = "direct_trade:calculation"
const DIRECT_TRADE_STATISTICS_INDEX_KEY = "direct_trade:statistics-index"
const DIRECT_TRADE_PROCESSOR_LEASE_MS = 6_000
// The processor reads only compact active-signal slices. A 280 ms loop keeps
// coordinated entries and control-order reconciliation responsive without
// polling the complete historical matrix.
const DIRECT_TRADE_PROCESSING_INTERVAL_DEFAULT_MS = 280

export interface DirectTradeState {
  enabled: boolean
  liveMode: boolean
  // Live Direct-Trade never guesses an exchange target. An explicit
  // connection is required before an entry may leave the Paper path.
  connectionId: string | null
  startedAt: string | null
  lastRecalcAt: string | null
  recalcIntervalMs: number
  symbolCount: number
  symbolOrder: "volatility_1h" | "volume" | "volatility"
  minVolFactor: number
  positionCostPercent: number
  maxSlRatio: number
  slRatioStep: number
  // Inverse orders have a separate protection ratio. It can never exceed
  // 125% of the paired TP distance.
  inverseMaxSlRatio: number
  timeframes: DirectTradeTimeframe[]
  strategyTypes: DirectTradeStrategyType[]
  historyHours: number
  entryTactics: DirectTradeEntryTactic[]
  exitTactics: DirectTradeExitTactic[]
  entryTiming: DirectTradeEntryTiming
  activityVolumeRatio: number
  maxHoldMinutes: number
  // Integer multipliers of PositionCost used to build the TP grid. The
  // default starts at 4× PositionCost and may be configured from 2× to 22×.
  takeProfitRatioRange: [number, number]
  // The selected range uses unit handles; this is the sparse Set-generation
  // stride, kept separate so a 32-symbol matrix remains bounded.
  takeProfitRatioStep: number
  blockRange: [number, number]
  // The Block increase ratio is independent from the base position-size
  // factor. For a base quantity B and N valid Blocks: B + (N × B × ratio).
  blockVolumeRatio: number
  // Independent PF floor multiplier for each Block count.
  blockProfitFactorRatio: number
  // Global open-position ceiling. It keeps the requested 300-position paper
  // capacity global instead of accidentally allowing 300 per symbol/lane.
  maxTotalPositions: number
  maxPositionsPerSymbol: number
  maxPositionsPerDirection: number
  processingIntervalMs: number
  // Evaluation settings (Pos Count for PF/DDT checks)
  keepEnabledPosCount: number     // Per symbol/direction/config: last N pos to check keep-enabled
  deactivatePosCount: number      // Negative last-N average permanently disables this exact config lineage
  minProfitFactor: number         // Min PF to keep config enabled
  // Separate historical last-position gate for fresh entries. It has no
  // authority to abandon an already-open position.
  minRecentProfitFactor: number
  recentEvaluationPositions: number
  maxDrawdownTimeMin: number      // Max avg DDT to keep config enabled
  prevPosWindow: number           // Rolling window for overall PF/DDT eval
  prevPosMinCount: number         // Min positions before eval activates
  evalPosCount: number            // Coordination eval count
  trailingEnabled: boolean        // Trailing stop on/off
  dcaProfile: DcaProfile
}

export interface DirectTradeStats {
  totalOrders: number
  totalFilled: number
  totalPnl: number
  winCount: number
  lossCount: number
  profitFactor: number | null
  profitFactorInfinite?: boolean
  maxDrawdownTimeMin: number
  currentDrawdownTimeMin: number
  lastPositionAt: string | null
  pnlHistory: { time: string; pnl: number; cumPnl: number }[]
  // Rolling windows
  last12Pos: { pf: number | null; pfInfinite?: boolean; ddt: number; pnl: number }
  last25Pos: { pf: number | null; pfInfinite?: boolean; ddt: number; pnl: number }
  last50Pos: { pf: number | null; pfInfinite?: boolean; ddt: number; pnl: number }
  last4h: { pf: number | null; pfInfinite?: boolean; ddt: number; pnl: number }
  last12h: { pf: number | null; pfInfinite?: boolean; ddt: number; pnl: number }
  last48h: { pf: number | null; pfInfinite?: boolean; ddt: number; pnl: number }
}

const DEFAULT_STATE: DirectTradeState = {
  enabled: false,
  liveMode: false,
  connectionId: null,
  startedAt: null,
  lastRecalcAt: null,
  recalcIntervalMs: 2 * 60 * 60 * 1000, // 2 hours
  symbolCount: 8,
  symbolOrder: "volatility_1h",
  minVolFactor: 0.1,
  positionCostPercent: POSITION_COST_PERCENT_DEFAULT,
  maxSlRatio: 0.75,
  slRatioStep: 0.25,
  inverseMaxSlRatio: 1.25,
  timeframes: ["5m", "15m", "30m"],
  strategyTypes: ["standard", "trailing_fixed", "trailing_auto", "combination", "inverse", "high_protection", "dca"],
  historyHours: 48,
  entryTactics: ["relative"],
  exitTactics: ["bracket", "momentum_reversal", "relative", "time"],
  entryTiming: "current",
  activityVolumeRatio: 1,
  maxHoldMinutes: 120,
  takeProfitRatioRange: DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE,
  takeProfitRatioStep: DIRECT_TRADE_TAKE_PROFIT_RATIO_STEP_DEFAULT,
  blockRange: [1, 12],
  blockVolumeRatio: 1,
  blockProfitFactorRatio: 0.8,
  maxTotalPositions: 300,
  maxPositionsPerSymbol: DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL,
  maxPositionsPerDirection: DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION,
  processingIntervalMs: DIRECT_TRADE_PROCESSING_INTERVAL_DEFAULT_MS,
  // Evaluation defaults
  keepEnabledPosCount: 12,
  deactivatePosCount: 16,
  minProfitFactor: 0.8,
  minRecentProfitFactor: DIRECT_TRADE_RECENT_PF_DEFAULT,
  recentEvaluationPositions: 12,
  maxDrawdownTimeMin: 10,
  prevPosWindow: 25,
  prevPosMinCount: 5,
  evalPosCount: 12,
  trailingEnabled: true,
  dcaProfile: DEFAULT_DCA_PROFILE,
}

const DEFAULT_STATS: DirectTradeStats = {
  totalOrders: 0,
  totalFilled: 0,
  totalPnl: 0,
  winCount: 0,
  lossCount: 0,
  profitFactor: null,
  profitFactorInfinite: false,
  maxDrawdownTimeMin: 0,
  currentDrawdownTimeMin: 0,
  lastPositionAt: null,
  pnlHistory: [],
  last12Pos: { pf: 0, ddt: 0, pnl: 0 },
  last25Pos: { pf: 0, ddt: 0, pnl: 0 },
  last50Pos: { pf: 0, ddt: 0, pnl: 0 },
  last4h: { pf: 0, ddt: 0, pnl: 0 },
  last12h: { pf: 0, ddt: 0, pnl: 0 },
  last48h: { pf: 0, ddt: 0, pnl: 0 },
}

async function getClient() {
  await initRedis()
  return getRedisClient()
}

async function getState(): Promise<DirectTradeState> {
  try {
    const client = await getClient()
    const raw = await client.get(DIRECT_TRADE_STATE_KEY)
    if (raw) {
      const persisted = JSON.parse(raw)
      // Upgrade only the exact former default pair. Any mixed values remain
      // deliberate operator capacity choices.
      const hasLegacyCapacityDefaults = Number(persisted?.maxPositionsPerSymbol) === 3
        && Number(persisted?.maxPositionsPerDirection) === 2
      return {
        ...DEFAULT_STATE,
        ...persisted,
        liveMode: persisted?.liveMode === true,
        connectionId: normaliseConnectionId(persisted?.connectionId),
        symbolOrder: normaliseSymbolOrder(persisted?.symbolOrder),
        // Migrate the former 1m/10m/15m defaults to the optimized exact
        // 5m/15m/30m coordination set.
        timeframes: normaliseDirectTradeTimeframes(persisted?.timeframes),
        strategyTypes: normaliseDirectTradeStrategyTypes(persisted?.strategyTypes),
        entryTactics: normaliseEntryTactics(persisted?.entryTactics),
        exitTactics: normaliseExitTactics(persisted?.exitTactics),
        entryTiming: persisted?.entryTiming === "last_confirmed" ? "last_confirmed" : "current",
        recalcIntervalMs: clampRecalculationInterval(persisted?.recalcIntervalMs, DEFAULT_STATE.recalcIntervalMs),
        // Migrate the former shipped 60h default to the unified 48h default;
        // any other persisted value remains an explicit operator choice.
        historyHours: Number(persisted?.historyHours) === 60
          ? DEFAULT_STATE.historyHours
          : Math.max(1, Number(persisted?.historyHours) || DEFAULT_STATE.historyHours),
        activityVolumeRatio: Math.max(0, Number(persisted?.activityVolumeRatio) || DEFAULT_STATE.activityVolumeRatio),
        positionCostPercent: normalizePositionCostPercent(persisted?.positionCostPercent ?? DEFAULT_STATE.positionCostPercent),
        maxHoldMinutes: Math.max(1, Number(persisted?.maxHoldMinutes) || DEFAULT_STATE.maxHoldMinutes),
        // The former 4–12 range was the shipped default, not an intentional
        // cap. Upgrade that exact legacy default to the optimized 4–8 contract;
        // any other persisted range remains the operator's explicit choice.
        takeProfitRatioRange: Array.isArray(persisted?.takeProfitRatioRange)
          && Number(persisted.takeProfitRatioRange[0]) === 4
          && Number(persisted.takeProfitRatioRange[1]) === 12
          ? DEFAULT_STATE.takeProfitRatioRange
          : normaliseDirectTradeTakeProfitRatioRange(
            persisted?.takeProfitRatioRange,
            DEFAULT_STATE.takeProfitRatioRange,
          ),
        takeProfitRatioStep: normaliseDirectTradeTakeProfitRatioStep(
          persisted?.takeProfitRatioStep,
          DEFAULT_STATE.takeProfitRatioStep,
        ),
        maxTotalPositions: clampOpenPositionLimit(persisted?.maxTotalPositions, DEFAULT_STATE.maxTotalPositions),
        slRatioStep: clampStopLossRatioStep(persisted?.slRatioStep, DEFAULT_STATE.slRatioStep),
        // 10 was the former shipped default. Migrate exactly that value to
        // the new stricter default, while preserving custom choices.
        minRecentProfitFactor: Math.max(
          0.8,
          Number(persisted?.minRecentProfitFactor) === 10
            ? DIRECT_TRADE_RECENT_PF_DEFAULT
            : Number(persisted?.minRecentProfitFactor) || DEFAULT_STATE.minRecentProfitFactor,
        ),
        recentEvaluationPositions: Math.max(3, Math.floor(Number(persisted?.recentEvaluationPositions) || DEFAULT_STATE.recentEvaluationPositions)),
        // Migrate the former hard-coded 500 ms default while preserving an
        // intentional operator-selected interval.
        processingIntervalMs: clampProcessingInterval(
          Number(persisted?.processingIntervalMs) === 500
            ? DIRECT_TRADE_PROCESSING_INTERVAL_DEFAULT_MS
            : persisted?.processingIntervalMs,
        ),
        blockRange: normaliseBlockRange(persisted?.blockRange, DEFAULT_STATE.blockRange),
        blockVolumeRatio: clampBlockVolumeRatio(persisted?.blockVolumeRatio, DEFAULT_STATE.blockVolumeRatio),
        blockProfitFactorRatio: clampBlockProfitFactorRatio(persisted?.blockProfitFactorRatio, DEFAULT_STATE.blockProfitFactorRatio),
        maxPositionsPerSymbol: hasLegacyCapacityDefaults
          ? DEFAULT_STATE.maxPositionsPerSymbol
          : Math.max(1, Math.min(300, Math.floor(Number(persisted?.maxPositionsPerSymbol) || DEFAULT_STATE.maxPositionsPerSymbol))),
        maxPositionsPerDirection: hasLegacyCapacityDefaults
          ? DEFAULT_STATE.maxPositionsPerDirection
          : Math.max(1, Math.min(300, Math.floor(Number(persisted?.maxPositionsPerDirection) || DEFAULT_STATE.maxPositionsPerDirection))),
        inverseMaxSlRatio: clampInverseStopLossRatio(persisted?.inverseMaxSlRatio),
        dcaProfile: normalizeDcaProfile(persisted?.dcaProfile ?? persisted),
      }
    }
  } catch {}
  return { ...DEFAULT_STATE }
}

async function setState(state: DirectTradeState): Promise<void> {
  const client = await getClient()
  await client.set(DIRECT_TRADE_STATE_KEY, JSON.stringify(state))
}

function clampStopLossRatio(value: unknown, fallback = 0.75): number {
  const raw = Number(value)
  const clamped = Math.max(0.25, Math.min(0.75, Number.isFinite(raw) ? raw : fallback))
  return Number((Math.round(clamped / 0.25) * 0.25).toFixed(2))
}

function clampInverseStopLossRatio(value: unknown, fallback = 1.25): number {
  const raw = Number(value)
  const clamped = Math.max(0.25, Math.min(1.25, Number.isFinite(raw) ? raw : fallback))
  return Number((Math.round(clamped / 0.25) * 0.25).toFixed(2))
}

function clampStopLossRatioStep(value: unknown, fallback = 0.25): number {
  const raw = Number(value)
  const clamped = Math.max(0.25, Math.min(0.75, Number.isFinite(raw) ? raw : fallback))
  return Number((Math.round(clamped / 0.25) * 0.25).toFixed(2))
}

function clampOpenPositionLimit(value: unknown, fallback = 300): number {
  const raw = Number(value)
  return Math.max(1, Math.min(300, Math.floor(Number.isFinite(raw) ? raw : fallback)))
}

function clampProcessingInterval(value: unknown, fallback = DIRECT_TRADE_PROCESSING_INTERVAL_DEFAULT_MS): number {
  const raw = Number(value)
  return Math.max(100, Math.min(5_000, Math.round(Number.isFinite(raw) ? raw : fallback)))
}

function normaliseConnectionId(value: unknown): string | null {
  const id = typeof value === "string" ? value.trim() : ""
  return /^[A-Za-z0-9._:-]{1,160}$/.test(id) ? id : null
}

function normaliseSymbolOrder(value: unknown): DirectTradeState["symbolOrder"] {
  return value === "volume" || value === "volatility"
    ? value
    : "volatility_1h"
}

function clampRecalculationInterval(value: unknown, fallback = 2 * 60 * 60 * 1000): number {
  const raw = Number(value)
  return Math.max(5 * 60_000, Math.min(24 * 60 * 60_000, Math.round(Number.isFinite(raw) ? raw : fallback)))
}

function normaliseBlockRange(value: unknown, fallback: [number, number] = [1, 12]): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return fallback
  const requestedMinimum = Number(value[0])
  const requestedMaximum = Number(value[1])
  const minimum = Math.max(0, Math.min(120, Math.floor(Number.isFinite(requestedMinimum) ? requestedMinimum : fallback[0])))
  const maximum = Math.max(minimum, Math.min(120, Math.floor(Number.isFinite(requestedMaximum) ? requestedMaximum : fallback[1])))
  return [minimum, maximum]
}

function clampBlockVolumeRatio(value: unknown, fallback = 1): number {
  const raw = Number(value)
  const clamped = Math.max(0.1, Math.min(10, Number.isFinite(raw) ? raw : fallback))
  return Number((Math.round(clamped * 10) / 10).toFixed(1))
}

function clampBlockProfitFactorRatio(value: unknown, fallback = 0.8): number {
  const raw = Number(value)
  const clamped = Math.max(0.2, Math.min(5, Number.isFinite(raw) ? raw : fallback))
  return Number(clamped.toFixed(2))
}

function boundedArray(value: unknown, maximum: number): any[] {
  return Array.isArray(value) ? value.slice(-maximum) : []
}

function processorLeaseMs(): number {
  // The real process lease is intentionally fixed. The short override exists
  // only for explicitly simulated crash/restart harnesses, never a production
  // or live-order runtime, so stateful recovery tests remain fast enough to be
  // run on every release.
  const requested = Number(process.env.DIRECT_TRADE_TEST_LEASE_MS)
  if (process.env.FORCE_SIMULATED === "1" && Number.isFinite(requested)) {
    return Math.max(100, Math.min(DIRECT_TRADE_PROCESSOR_LEASE_MS, Math.floor(requested)))
  }
  return DIRECT_TRADE_PROCESSOR_LEASE_MS
}

async function acquireProcessorLease(client: any, instanceId: string): Promise<boolean> {
  if (!instanceId || instanceId.length > 160) return false
  const created = await client.set(DIRECT_TRADE_PROCESSOR_LEASE_KEY, instanceId, {
    NX: true,
    PX: processorLeaseMs(),
  }).catch(() => null)
  if (created === "OK" || created === true) return true

  // A current lease may only be renewed by its exact owner. This gives one
  // processor authority over simulated or live positions and prevents a
  // second script from duplicating entries after a reload.
  const owner = await client.get(DIRECT_TRADE_PROCESSOR_LEASE_KEY).catch(() => null)
  if (owner !== instanceId) return false
  const renewed = await client.set(DIRECT_TRADE_PROCESSOR_LEASE_KEY, instanceId, {
    XX: true,
    PX: processorLeaseMs(),
  }).catch(() => null)
  return renewed === "OK" || renewed === true
}

async function getStats(): Promise<DirectTradeStats> {
  try {
    const client = await getClient()
    const raw = await client.get(DIRECT_TRADE_STATS_KEY)
    if (raw) return { ...DEFAULT_STATS, ...JSON.parse(raw) }
  } catch {}
  return { ...DEFAULT_STATS }
}

async function getExecutionConfigs(options: { activeOnly?: boolean; signalKeys?: string[] } = {}): Promise<any[]> {
  try {
    const client = await getClient()
    const [indexRaw, signalIndexRaw, activeSignalRaw, manifest] = await Promise.all([
      client.get(DIRECT_TRADE_EXECUTION_INDEX_KEY),
      client.get(DIRECT_TRADE_EXECUTION_SIGNAL_INDEX_KEY),
      options.activeOnly ? client.get(DIRECT_TRADE_ACTIVE_SIGNAL_KEYS_KEY) : Promise.resolve(null),
      getDirectTradeConfigManifest(client),
    ])
    const indexes = indexRaw ? JSON.parse(indexRaw) : []
    if (indexRaw && Array.isArray(indexes)) {
      let signalKeys = Array.isArray(options.signalKeys)
        ? options.signalKeys.filter((key): key is string => typeof key === "string" && key.length > 0)
        : []
      if (options.activeOnly && activeSignalRaw) {
        try {
          const active = JSON.parse(activeSignalRaw)
          if (Array.isArray(active?.keys)) {
            signalKeys = active.keys.filter((key: unknown): key is string => typeof key === "string" && key.length > 0)
          }
        } catch {}
      }
      if (signalKeys.length > 0 && signalIndexRaw) {
        try {
          const signalIndex = JSON.parse(signalIndexRaw)
          const selected = signalKeys.flatMap((key) => Array.isArray(signalIndex?.[key]) ? signalIndex[key] : [])
          return (await readDirectTradeConfigsAtIndexes(client, selected.map(Number)))
            .sort((left, right) => Number(right?.score || 0) - Number(left?.score || 0))
        } catch {}
      }
      // A manifest means a maximum grid is chunked. Refuse to recreate a
      // giant JSON response when no causal signal selection was supplied;
      // the processor asks with `activeOnly=1` after each pulse instead.
      if (manifest) return []
      return (await readDirectTradeConfigsAtIndexes(client, indexes.map(Number)))
        .sort((left, right) => Number(right?.score || 0) - Number(left?.score || 0))
    }
  } catch {}
  // Compatibility for existing installations until their next calculation.
  return getJsonArray(DIRECT_TRADE_EXECUTION_CONFIGS_KEY)
}

async function getJsonArray(key: string): Promise<any[]> {
  try {
    const client = await getClient()
    const raw = await client.get(key)
    if (raw) {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    }
  } catch {}
  return []
}

async function getJsonObject(key: string): Promise<Record<string, unknown>> {
  try {
    const client = await getClient()
    const raw = await client.get(key)
    if (raw) {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
    }
  } catch {}
  return {}
}

async function getCalculation(): Promise<Record<string, unknown>> {
  return getJsonObject(DIRECT_TRADE_CALCULATION_KEY)
}

function statisticsFilterKey(timeframe: string, direction: string, state: string, strategyType = "all"): string {
  return `${timeframe}\u0001${direction}\u0001${state}\u0001${strategyType}`
}

function safeStatisticsSelection(value: string | null, allowed: readonly string[], fallback: string): string {
  return value && allowed.includes(value) ? value : fallback
}

// GET: compact runtime state, or a pre-computed paged Statistics read model.
export async function GET(request: NextRequest) {
  try {
    // Route tests and internal callers may provide a standard Request rather
    // than NextRequest. Keep the read path equally safe in both environments.
    const searchParams = request?.nextUrl?.searchParams ?? new URL(
      request?.url || "http://localhost/api/trade-engine/direct-trade",
    ).searchParams
    const view = searchParams.get("view") || "runtime"
    if (view === "statistics") {
      const [calculation, index] = await Promise.all([
        getCalculation(),
        getJsonObject(DIRECT_TRADE_STATISTICS_INDEX_KEY),
      ])
      const timeframe = safeStatisticsSelection(
        searchParams.get("timeframe"),
        ["all", ...Object.keys((calculation as any)?.byTimeframe || {})],
        "all",
      )
      const direction = safeStatisticsSelection(searchParams.get("direction"), ["all", "long", "short"], "all")
      const state = safeStatisticsSelection(searchParams.get("state"), ["all", "valid", "inactive"], "all")
      const strategyType = safeStatisticsSelection(
        searchParams.get("strategyType"),
        ["all", ...Object.keys((calculation as any)?.byStrategyType || {})],
        "all",
      )
      const key = statisticsFilterKey(timeframe, direction, state, strategyType)
      const totals = (index as any)?.totals && typeof (index as any).totals === "object" ? (index as any).totals : {}
      const topRows = (index as any)?.topRows && typeof (index as any).topRows === "object" ? (index as any).topRows : {}
      return NextResponse.json({
        success: true,
        calculation,
        selection: { timeframe, direction, state, strategyType },
        matched: Math.max(0, Number(totals[key]) || 0),
        rows: Array.isArray(topRows[key]) ? topRows[key] : [],
        rowLimit: 100,
        indexVersion: typeof (index as any)?.version === "string" ? (index as any).version : null,
      })
    }

    const includeExecution = searchParams.get("includeExecution") === "1"
    const activeOnly = searchParams.get("activeOnly") === "1"
    const signalKeys = searchParams.getAll("signalKey")
    const [state, stats, executionConfigs, positions, openPositionStage, configStatus, configPerformance, calculation] = await Promise.all([
      getState(),
      getStats(),
      includeExecution ? getExecutionConfigs({ activeOnly, signalKeys }) : Promise.resolve([]),
      getJsonArray(DIRECT_TRADE_POSITIONS_KEY),
      getJsonObject(DIRECT_TRADE_OPEN_POSITION_STAGE_KEY),
      getJsonObject(DIRECT_TRADE_CONFIG_STATUS_KEY),
      getJsonObject(DIRECT_TRADE_CONFIG_PERFORMANCE_KEY),
      getCalculation(),
    ])
    return NextResponse.json({
      success: true,
      state,
      stats,
      // The full historic grid is deliberately not returned here. Its compact
      // evaluation totals and paged Statistics read model live alongside it;
      // runtime workers receive only eligible independent candidates.
      activeConfigs: Math.max(0, Number((calculation as any)?.evaluatedSets) || executionConfigs.length),
      configTotal: Math.max(0, Number((calculation as any)?.evaluatedSets) || executionConfigs.length),
      validConfigTotal: Math.max(0, Number((calculation as any)?.validSets) || executionConfigs.length),
      ...(includeExecution ? { executionConfigs, executionSelection: activeOnly ? "active-signals" : signalKeys.length > 0 ? "signal-keys" : "all" } : {}),
      positions: positions.slice(-10_000),
      openPositionStage,
      configStatus,
      configPerformance,
      calculation,
    })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to get direct-trade state", details: String(error) },
      { status: 500 },
    )
  }
}

// POST: Update state (enable/disable, live/simulated, config changes)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const currentState = await getState()

    // Handle actions
    if (body.action === "start") {
      const newState: DirectTradeState = {
        ...currentState,
        enabled: true,
        startedAt: currentState.startedAt || new Date().toISOString(),
        ...(body.liveMode !== undefined ? { liveMode: body.liveMode === true } : {}),
        ...(body.connectionId !== undefined ? { connectionId: normaliseConnectionId(body.connectionId) } : {}),
        ...(body.symbolCount !== undefined ? { symbolCount: clampDirectTradeSymbolCount(body.symbolCount) } : {}),
        ...(body.symbolOrder !== undefined ? { symbolOrder: normaliseSymbolOrder(body.symbolOrder) } : {}),
        ...(body.minVolFactor !== undefined ? { minVolFactor: Math.max(0.1, Number(body.minVolFactor) || 0.1) } : {}),
        ...(body.positionCostPercent !== undefined ? { positionCostPercent: normalizePositionCostPercent(body.positionCostPercent) } : {}),
        ...(body.maxSlRatio !== undefined ? { maxSlRatio: clampStopLossRatio(body.maxSlRatio) } : {}),
        ...(body.slRatioStep !== undefined ? { slRatioStep: clampStopLossRatioStep(body.slRatioStep) } : {}),
        ...(body.inverseMaxSlRatio !== undefined ? { inverseMaxSlRatio: clampInverseStopLossRatio(body.inverseMaxSlRatio) } : {}),
        ...(body.timeframes ? { timeframes: normaliseDirectTradeTimeframes(body.timeframes) } : {}),
        ...(body.strategyTypes !== undefined ? { strategyTypes: normaliseDirectTradeStrategyTypes(body.strategyTypes) } : {}),
        ...(body.historyHours !== undefined ? { historyHours: Math.max(1, Number(body.historyHours) || DEFAULT_STATE.historyHours) } : {}),
        ...(body.recalcIntervalMs !== undefined ? { recalcIntervalMs: clampRecalculationInterval(body.recalcIntervalMs) } : {}),
        ...(body.entryTactics !== undefined ? { entryTactics: normaliseEntryTactics(body.entryTactics) } : {}),
        ...(body.exitTactics !== undefined ? { exitTactics: normaliseExitTactics(body.exitTactics) } : {}),
        ...(body.entryTiming !== undefined ? { entryTiming: body.entryTiming === "last_confirmed" ? "last_confirmed" : "current" as const } : {}),
        ...(body.activityVolumeRatio !== undefined ? { activityVolumeRatio: Math.max(0, Number(body.activityVolumeRatio) || 0) } : {}),
        ...(body.maxHoldMinutes !== undefined ? { maxHoldMinutes: Math.max(1, Number(body.maxHoldMinutes) || DEFAULT_STATE.maxHoldMinutes) } : {}),
        ...(body.takeProfitRatioRange !== undefined ? { takeProfitRatioRange: normaliseDirectTradeTakeProfitRatioRange(body.takeProfitRatioRange, currentState.takeProfitRatioRange) } : {}),
        ...(body.takeProfitRatioStep !== undefined ? { takeProfitRatioStep: normaliseDirectTradeTakeProfitRatioStep(body.takeProfitRatioStep, currentState.takeProfitRatioStep) } : {}),
        ...(body.blockRange !== undefined ? { blockRange: normaliseBlockRange(body.blockRange, currentState.blockRange) } : {}),
        ...(body.blockVolumeRatio !== undefined ? { blockVolumeRatio: clampBlockVolumeRatio(body.blockVolumeRatio, currentState.blockVolumeRatio) } : {}),
        ...(body.blockProfitFactorRatio !== undefined ? { blockProfitFactorRatio: clampBlockProfitFactorRatio(body.blockProfitFactorRatio, currentState.blockProfitFactorRatio) } : {}),
        ...(body.maxTotalPositions !== undefined ? { maxTotalPositions: clampOpenPositionLimit(body.maxTotalPositions) } : {}),
        ...(body.maxPositionsPerSymbol !== undefined ? { maxPositionsPerSymbol: Math.max(1, Math.min(300, Math.floor(Number(body.maxPositionsPerSymbol) || 1))) } : {}),
        ...(body.maxPositionsPerDirection !== undefined ? { maxPositionsPerDirection: Math.max(1, Math.min(300, Math.floor(Number(body.maxPositionsPerDirection) || 1))) } : {}),
        ...(body.processingIntervalMs !== undefined ? { processingIntervalMs: clampProcessingInterval(body.processingIntervalMs) } : {}),
        // Start is allowed to carry the complete current UI configuration.
        // Without these fields a just-started processor could briefly run on
        // stale PF/DDT/trailing limits until a later debounced config update.
        ...(body.keepEnabledPosCount !== undefined ? { keepEnabledPosCount: Math.max(3, Number(body.keepEnabledPosCount) || 3) } : {}),
        ...(body.deactivatePosCount !== undefined ? { deactivatePosCount: Math.max(3, Number(body.deactivatePosCount) || 3) } : {}),
        ...(body.minProfitFactor !== undefined ? { minProfitFactor: Math.max(0.8, Number(body.minProfitFactor) || 0.8) } : {}),
        ...(body.minRecentProfitFactor !== undefined ? { minRecentProfitFactor: Math.max(0.8, Number(body.minRecentProfitFactor) || 0.8) } : {}),
        ...(body.recentEvaluationPositions !== undefined ? { recentEvaluationPositions: Math.max(3, Math.floor(Number(body.recentEvaluationPositions) || 3)) } : {}),
        ...(body.maxDrawdownTimeMin !== undefined ? { maxDrawdownTimeMin: Math.max(1, Number(body.maxDrawdownTimeMin) || 1) } : {}),
        ...(body.prevPosWindow !== undefined ? { prevPosWindow: Math.max(5, Number(body.prevPosWindow) || 5) } : {}),
        ...(body.prevPosMinCount !== undefined ? { prevPosMinCount: Math.max(1, Number(body.prevPosMinCount) || 1) } : {}),
        ...(body.evalPosCount !== undefined ? { evalPosCount: Math.max(3, Number(body.evalPosCount) || 3) } : {}),
        ...(body.trailingEnabled !== undefined ? { trailingEnabled: body.trailingEnabled } : {}),
        ...(body.dcaProfile !== undefined ? { dcaProfile: normalizeDcaProfile(body.dcaProfile) } : {}),
      }
      if (newState.liveMode && !newState.connectionId) {
        return NextResponse.json({ error: "Select a live exchange connection before starting Direct-Trade live execution" }, { status: 409 })
      }
      await setState(newState)
      return NextResponse.json({ success: true, state: newState, message: "Direct-Trade started" })
    }

    if (body.action === "stop") {
      const newState: DirectTradeState = { ...currentState, enabled: false }
      await setState(newState)
      return NextResponse.json({ success: true, state: newState, message: "Direct-Trade stopped" })
    }

    if (body.action === "toggle-live") {
      const liveMode = body.liveMode !== undefined ? body.liveMode === true : !currentState.liveMode
      const connectionId = body.connectionId !== undefined
        ? normaliseConnectionId(body.connectionId)
        : currentState.connectionId
      if (liveMode && !connectionId) {
        return NextResponse.json({ error: "Select a live exchange connection before enabling Direct-Trade live execution" }, { status: 409 })
      }
      const newState: DirectTradeState = {
        ...currentState,
        liveMode,
        ...(connectionId !== undefined ? { connectionId } : {}),
      }
      await setState(newState)
      return NextResponse.json({ success: true, state: newState, message: `Live mode ${newState.liveMode ? "enabled" : "disabled"}` })
    }

    if (body.action === "update-config") {
      const newState: DirectTradeState = {
        ...currentState,
        ...(body.connectionId !== undefined ? { connectionId: normaliseConnectionId(body.connectionId) } : {}),
        ...(body.symbolCount !== undefined ? { symbolCount: clampDirectTradeSymbolCount(body.symbolCount) } : {}),
        ...(body.symbolOrder !== undefined ? { symbolOrder: normaliseSymbolOrder(body.symbolOrder) } : {}),
        ...(body.minVolFactor !== undefined ? { minVolFactor: Math.max(0.1, Number(body.minVolFactor) || 0.1) } : {}),
        ...(body.positionCostPercent !== undefined ? { positionCostPercent: normalizePositionCostPercent(body.positionCostPercent) } : {}),
        ...(body.maxSlRatio !== undefined ? { maxSlRatio: clampStopLossRatio(body.maxSlRatio) } : {}),
        ...(body.slRatioStep !== undefined ? { slRatioStep: clampStopLossRatioStep(body.slRatioStep) } : {}),
        ...(body.inverseMaxSlRatio !== undefined ? { inverseMaxSlRatio: clampInverseStopLossRatio(body.inverseMaxSlRatio) } : {}),
        ...(body.timeframes !== undefined ? { timeframes: normaliseDirectTradeTimeframes(body.timeframes) } : {}),
        ...(body.strategyTypes !== undefined ? { strategyTypes: normaliseDirectTradeStrategyTypes(body.strategyTypes) } : {}),
        ...(body.historyHours !== undefined ? { historyHours: Math.max(1, Number(body.historyHours) || DEFAULT_STATE.historyHours) } : {}),
        ...(body.recalcIntervalMs !== undefined ? { recalcIntervalMs: clampRecalculationInterval(body.recalcIntervalMs) } : {}),
        ...(body.entryTactics !== undefined ? { entryTactics: normaliseEntryTactics(body.entryTactics) } : {}),
        ...(body.exitTactics !== undefined ? { exitTactics: normaliseExitTactics(body.exitTactics) } : {}),
        ...(body.entryTiming !== undefined ? { entryTiming: body.entryTiming === "last_confirmed" ? "last_confirmed" : "current" as const } : {}),
        ...(body.activityVolumeRatio !== undefined ? { activityVolumeRatio: Math.max(0, Number(body.activityVolumeRatio) || 0) } : {}),
        ...(body.maxHoldMinutes !== undefined ? { maxHoldMinutes: Math.max(1, Number(body.maxHoldMinutes) || DEFAULT_STATE.maxHoldMinutes) } : {}),
        ...(body.takeProfitRatioRange !== undefined ? { takeProfitRatioRange: normaliseDirectTradeTakeProfitRatioRange(body.takeProfitRatioRange, currentState.takeProfitRatioRange) } : {}),
        ...(body.takeProfitRatioStep !== undefined ? { takeProfitRatioStep: normaliseDirectTradeTakeProfitRatioStep(body.takeProfitRatioStep, currentState.takeProfitRatioStep) } : {}),
        ...(body.blockRange !== undefined ? { blockRange: normaliseBlockRange(body.blockRange, currentState.blockRange) } : {}),
        ...(body.blockVolumeRatio !== undefined ? { blockVolumeRatio: clampBlockVolumeRatio(body.blockVolumeRatio, currentState.blockVolumeRatio) } : {}),
        ...(body.blockProfitFactorRatio !== undefined ? { blockProfitFactorRatio: clampBlockProfitFactorRatio(body.blockProfitFactorRatio, currentState.blockProfitFactorRatio) } : {}),
        ...(body.maxTotalPositions !== undefined ? { maxTotalPositions: clampOpenPositionLimit(body.maxTotalPositions) } : {}),
        ...(body.maxPositionsPerSymbol !== undefined ? { maxPositionsPerSymbol: Math.max(1, Math.min(300, Math.floor(Number(body.maxPositionsPerSymbol) || 1))) } : {}),
        ...(body.maxPositionsPerDirection !== undefined ? { maxPositionsPerDirection: Math.max(1, Math.min(300, Math.floor(Number(body.maxPositionsPerDirection) || 1))) } : {}),
        ...(body.processingIntervalMs !== undefined ? { processingIntervalMs: clampProcessingInterval(body.processingIntervalMs) } : {}),
        // Evaluation settings (instant effect on processor via loadState sync)
        ...(body.keepEnabledPosCount !== undefined ? { keepEnabledPosCount: Math.max(3, Number(body.keepEnabledPosCount) || 3) } : {}),
        ...(body.deactivatePosCount !== undefined ? { deactivatePosCount: Math.max(3, Number(body.deactivatePosCount) || 3) } : {}),
        ...(body.minProfitFactor !== undefined ? { minProfitFactor: Math.max(0.8, Number(body.minProfitFactor) || 0.8) } : {}),
        ...(body.minRecentProfitFactor !== undefined ? { minRecentProfitFactor: Math.max(0.8, Number(body.minRecentProfitFactor) || 0.8) } : {}),
        ...(body.recentEvaluationPositions !== undefined ? { recentEvaluationPositions: Math.max(3, Math.floor(Number(body.recentEvaluationPositions) || 3)) } : {}),
        ...(body.maxDrawdownTimeMin !== undefined ? { maxDrawdownTimeMin: Math.max(1, Number(body.maxDrawdownTimeMin) || 1) } : {}),
        ...(body.prevPosWindow !== undefined ? { prevPosWindow: Math.max(5, Number(body.prevPosWindow) || 5) } : {}),
        ...(body.prevPosMinCount !== undefined ? { prevPosMinCount: Math.max(1, Number(body.prevPosMinCount) || 1) } : {}),
        ...(body.evalPosCount !== undefined ? { evalPosCount: Math.max(3, Number(body.evalPosCount) || 3) } : {}),
        ...(body.trailingEnabled !== undefined ? { trailingEnabled: body.trailingEnabled } : {}),
        ...(body.dcaProfile !== undefined ? { dcaProfile: normalizeDcaProfile(body.dcaProfile) } : {}),
        ...(body.lastRecalcAt !== undefined && typeof body.lastRecalcAt === "string" ? { lastRecalcAt: body.lastRecalcAt } : {}),
      }
      await setState(newState)
      return NextResponse.json({ success: true, state: newState, message: "Config updated" })
    }

    if (body.action === "reset-stats") {
      const client = await getClient()
      await client.set(DIRECT_TRADE_STATS_KEY, JSON.stringify(DEFAULT_STATS))
      return NextResponse.json({ success: true, message: "Stats reset" })
    }

    if (body.action === "processor-sync") {
      const instanceId = typeof body.instanceId === "string" ? body.instanceId : ""
      const client = await getClient()
      const leaseHeld = await acquireProcessorLease(client, instanceId)
      if (!leaseHeld) {
        return NextResponse.json({ success: true, leaseHeld: false })
      }

      const now = new Date().toISOString()
      const positions = boundedArray(body.positions, 10_000)
      const openPositionStage = buildDirectTradeOpenPositionStage(positions, now)
      const stats = body.stats && typeof body.stats === "object" ? body.stats : DEFAULT_STATS
      const configStatus = body.configStatus && typeof body.configStatus === "object"
        ? body.configStatus
        : {}
      const configPerformance = body.configPerformance && typeof body.configPerformance === "object"
        ? body.configPerformance
        : {}
      const processor = {
        instanceId,
        lastTick: now,
        tickCount: Math.max(0, Math.floor(Number(body.tickCount) || 0)),
        errorsLast5min: Math.max(0, Math.floor(Number(body.errorsLast5min) || 0)),
        lastRecalcAt: typeof body.lastRecalcAt === "number" ? body.lastRecalcAt : null,
        positionCount: positions.length,
        configCount: Math.max(0, Math.floor(Number(body.configCount) || 0)),
      }
      const write = client.multi()
      write.set(DIRECT_TRADE_POSITIONS_KEY, JSON.stringify(positions))
      write.set(DIRECT_TRADE_OPEN_POSITION_STAGE_KEY, JSON.stringify(openPositionStage))
      write.set(DIRECT_TRADE_STATS_KEY, JSON.stringify(stats))
      write.set(DIRECT_TRADE_CONFIG_STATUS_KEY, JSON.stringify(configStatus))
      write.set(DIRECT_TRADE_CONFIG_PERFORMANCE_KEY, JSON.stringify(configPerformance))
      write.set(DIRECT_TRADE_PROCESSOR_KEY, JSON.stringify(processor))
      await write.exec()
      // The owner receives the compact, normalized settings acknowledgement
      // with the write it already performs. This lets a running worker react
      // to an operator save on its next sync instead of waiting for a loop
      // counter to reach an arbitrary polling interval.
      return NextResponse.json({
        success: true,
        leaseHeld: true,
        processor,
        state: await getState(),
      })
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to update direct-trade state", details: String(error) },
      { status: 500 },
    )
  }
}
