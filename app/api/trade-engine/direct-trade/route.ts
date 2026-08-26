import { timingSafeEqual } from "node:crypto"
import { type NextRequest, NextResponse } from "next/server"
import {
  getSettings,
  setSettings,
  getRedisBackend,
  getRedisClient,
  initRedis,
  persistNow,
  getConnection,
} from "@/lib/redis-db"
import {
  clampDirectTradeSymbolCount,
  clampDirectTradeVolumeFactor,
  DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS,
  DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION,
  DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL,
  DIRECT_TRADE_EFFECTIVE_VOLUME_RATIO,
  DIRECT_TRADE_MAX_TOTAL_POSITIONS,
  DIRECT_TRADE_VOLUME_FACTOR_DEFAULT,
} from "@/lib/direct-trade-limits"
import {
  normaliseDirectTradeTimeframes,
  normaliseDirectTradeStrategyTypes,
  normaliseEntryTactics,
  normaliseEnabledDirectTradeIndicationTypes,
  normaliseExitTactics,
  normaliseDirectTradeTakeProfitRatioRange,
  normaliseDirectTradeTakeProfitRatioStep,
  normaliseDirectTradeTrailingMinTakeProfitRatio,
  DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT,
  DIRECT_TRADE_RECENT_PF_DEFAULT,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_STEP_DEFAULT,
  DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE,
  DIRECT_TRADE_TRAILING_MIN_TAKE_PROFIT_RATIO_DEFAULT,
  type DirectTradeEntryTiming,
  type DirectTradeEntryTactic,
  type DirectTradeExitTactic,
  type DirectTradeTimeframe,
  type DirectTradeStrategyType,
} from "@/lib/direct-trade-coordination"
import {
  acquireOrRenewDirectTradeProcessorLease,
  renewDirectTradeProcessorLease,
} from "@/lib/direct-trade-processor-lease"
import { resolveDirectTradeSettledExchangePnlUsdt } from "@/lib/direct-trade-overview-stats"
import {
  DIRECT_TRADE_ACTIVE_SIGNAL_KEYS_KEY,
  DIRECT_TRADE_EXECUTION_INDEX_KEY,
  DIRECT_TRADE_EXECUTION_SIGNAL_INDEX_KEY,
  getDirectTradeConfigManifest,
  readDirectTradeConfigsAtIndexes,
} from "@/lib/direct-trade-config-store"
import { normalizePositionCostPercent, POSITION_COST_PERCENT_DEFAULT } from "@/lib/position-cost"
import { normalizeMainTradePfRatio } from "@/lib/main-trade-profit-factor"
import { DEFAULT_DCA_PROFILE, normalizeDcaProfile, type DcaProfile } from "@/lib/dca-strategy"
import {
  buildDirectTradeOpenPositionStage,
  DIRECT_TRADE_OPEN_POSITION_STAGE_KEY,
} from "@/lib/direct-trade-position-stage"
import directTradeHistoryPolicy from "@/lib/direct-trade-history-policy.cjs"
import {
  DIRECT_TRADE_CONNECTION_INDEX_KEY,
  directTradeKeyspace,
  normalizeDirectTradeConnectionId,
} from "@/lib/direct-trade-keyspace"

const { clampDirectTradeHistoryHours } = directTradeHistoryPolicy

export const dynamic = "force-dynamic"

const DIRECT_TRADE_PROCESSOR_LEASE_MS = 6_000
// The processor reads only compact active-signal slices. A 280 ms loop keeps
// coordinated entries and control-order reconciliation responsive without
// polling the complete historical matrix.
const DIRECT_TRADE_PROCESSING_INTERVAL_DEFAULT_MS = 280

function sameProcessorSecret(received: string | null, expected: string): boolean {
  if (!received || !expected) return false
  const left = Buffer.from(received)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

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
  volumeFactorEffectiveRatio?: number
  volumeFactorDefaultsVersion?: number
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
  enabledIndicationTypes: DirectTradeEntryTactic[]
  exitTactics: DirectTradeExitTactic[]
  entryTiming: DirectTradeEntryTiming
  activityVolumeRatio: number
  maxHoldMinutes: number
  // Integer multipliers of PositionCost used to build the TP grid. The
  // fresh default starts at 5× PositionCost; legacy values 2×–22× remain
  // valid when an operator selected them explicitly.
  takeProfitRatioRange: [number, number]
  // The selected range uses unit handles; this is the sparse Set-generation
  // stride, kept separate so a 32-symbol matrix remains bounded.
  takeProfitRatioStep: number
  // Trailing variants are evaluated/opened only when their TP target is at
  // least this many PositionCost steps away. Non-trailing lanes remain intact.
  trailingMinTakeProfitRatio: number
  // Allows the previous shipped TP defaults to move to the 5× contract once
  // without repeatedly rewriting later operator choices.
  takeProfitDefaultsVersion?: number
  blockRange: [number, number]
  // The Block increase ratio is independent from the base position-size
  // factor. For a base quantity B and N valid Blocks: B + (N × B × ratio).
  blockVolumeRatio: number
  // Independent PF floor multiplier for each Block count.
  blockProfitFactorRatio: number
  // Global open-position ceiling. The shipped target is 100 active positions;
  // the independently configurable per-symbol/lane limits remain below it.
  maxTotalPositions: number
  maxPositionsPerSymbol: number
  maxPositionsPerDirection: number
  processingIntervalMs: number
  // Evaluation settings (Pos Count for PF/DDT checks)
  keepEnabledPosCount: number     // Per symbol/direction/config: last N pos to check keep-enabled
  deactivatePosCount: number      // Negative last-N average permanently disables this exact config lineage
  minProfitFactor: number         // Min PF to keep config enabled
  // Marks state written after Direct admission moved from classic realised PF
  // to the canonical PositionCost-relative selection coordinate.
  fullHistoryPfDefaultsVersion?: number
  // Allows the former shipped 300-position default to move to the calibrated
  // 100-position target without repeatedly rewriting later operator choices.
  positionCapacityDefaultsVersion?: number
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
  breakEvenCount: number
  settledClosedCount: number
  accountingPending: number
  openPositionCount: number
  openingPositionCount: number
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
  minVolFactor: DIRECT_TRADE_VOLUME_FACTOR_DEFAULT,
  volumeFactorEffectiveRatio: DIRECT_TRADE_EFFECTIVE_VOLUME_RATIO,
  volumeFactorDefaultsVersion: 1,
  positionCostPercent: POSITION_COST_PERCENT_DEFAULT,
  maxSlRatio: 0.75,
  slRatioStep: 0.25,
  inverseMaxSlRatio: 1.25,
  timeframes: ["5m", "15m", "30m"],
  strategyTypes: ["standard", "trailing_fixed", "trailing_auto", "combination", "inverse", "high_protection", "dca"],
  historyHours: 48,
  entryTactics: ["relative"],
  enabledIndicationTypes: ["relative"],
  exitTactics: ["bracket", "momentum_reversal", "relative", "time"],
  entryTiming: "current",
  activityVolumeRatio: 1,
  maxHoldMinutes: 120,
  takeProfitRatioRange: DIRECT_TRADE_TAKE_PROFIT_RATIO_DEFAULT_RANGE,
  takeProfitRatioStep: DIRECT_TRADE_TAKE_PROFIT_RATIO_STEP_DEFAULT,
  trailingMinTakeProfitRatio: DIRECT_TRADE_TRAILING_MIN_TAKE_PROFIT_RATIO_DEFAULT,
  takeProfitDefaultsVersion: 2,
  blockRange: [1, 12],
  blockVolumeRatio: 1,
  blockProfitFactorRatio: 0.8,
  maxTotalPositions: DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS,
  maxPositionsPerSymbol: DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_SYMBOL,
  maxPositionsPerDirection: DIRECT_TRADE_DEFAULT_MAX_POSITIONS_PER_DIRECTION,
  processingIntervalMs: DIRECT_TRADE_PROCESSING_INTERVAL_DEFAULT_MS,
  // Evaluation defaults
  keepEnabledPosCount: 12,
  deactivatePosCount: 16,
  minProfitFactor: DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT,
  fullHistoryPfDefaultsVersion: 2,
  positionCapacityDefaultsVersion: 1,
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
  breakEvenCount: 0,
  settledClosedCount: 0,
  accountingPending: 0,
  openPositionCount: 0,
  openingPositionCount: 0,
  profitFactor: null,
  profitFactorInfinite: false,
  maxDrawdownTimeMin: 0,
  currentDrawdownTimeMin: 0,
  lastPositionAt: null,
  pnlHistory: [],
  last12Pos: { pf: null, ddt: 0, pnl: 0 },
  last25Pos: { pf: null, ddt: 0, pnl: 0 },
  last50Pos: { pf: null, ddt: 0, pnl: 0 },
  last4h: { pf: null, ddt: 0, pnl: 0 },
  last12h: { pf: null, ddt: 0, pnl: 0 },
  last48h: { pf: null, ddt: 0, pnl: 0 },
}

async function getClient() {
  await initRedis()
  return getRedisClient()
}

async function persistDirectTradeSnapshot(context: string): Promise<void> {
  // Network Redis commits SET/MULTI before returning. Inline snapshot mode is
  // different: force its current mutation version to disk before confirming a
  // control-plane or position-lifecycle write that must survive SIGKILL.
  if (typeof getRedisBackend !== "function" || getRedisBackend() !== "inline-local") return
  if (typeof persistNow !== "function" || !(await persistNow())) {
    throw new Error(`Direct-Trade ${context} could not be persisted before acknowledgement`)
  }
}

async function ensureConnectionScope(connectionId: string | null): Promise<void> {
  if (!connectionId) return
  const client = await getClient()
  const scoped = directTradeKeyspace(connectionId)
  await client.sadd(DIRECT_TRADE_CONNECTION_INDEX_KEY, connectionId)
  if (await client.get(scoped.state)) return

  // One-time, non-destructive adoption of the former global Direct-Trade
  // state. Open positions and their exact order controls must survive the
  // namespace upgrade; historic calculation grids are deliberately rebuilt
  // inside the new connection scope.
  const migrationLock = `${scoped.namespace}:migration:legacy`
  const locked = await client.set(migrationLock, "1", { NX: true, EX: 30 }).catch(() => null)
  if (locked !== "OK") return
  try {
    if (await client.get(scoped.state)) return
    const legacy = directTradeKeyspace()
    const legacyStateRaw = await client.get(legacy.state)
    if (!legacyStateRaw) return
    const legacyState = JSON.parse(legacyStateRaw)
    if (normaliseConnectionId(legacyState?.connectionId) !== connectionId) return
    const copyPairs: Array<[string, string]> = [
      [legacy.stats, scoped.stats],
      [legacy.positions, scoped.positions],
      [legacy.configStatus, scoped.configStatus],
      [legacy.configPerformance, scoped.configPerformance],
      [legacy.openPositionStage, scoped.openPositionStage],
    ]
    const values = await Promise.all(copyPairs.map(([source]) => client.get(source)))
    const write = client.multi()
    write.set(scoped.state, JSON.stringify({
      ...legacyState,
      connectionId,
      lastRecalcAt: null,
      migratedFromLegacyAt: new Date().toISOString(),
    }))
    copyPairs.forEach(([, target], index) => {
      if (values[index] !== null) write.set(target, values[index] as string)
    })
    await write.exec()
    await persistDirectTradeSnapshot(`legacy scope migration for ${connectionId}`)
  } finally {
    await client.del(migrationLock).catch(() => 0)
  }
}

async function getState(connectionId: string | null = null): Promise<DirectTradeState> {
  try {
    await ensureConnectionScope(connectionId)
    const client = await getClient()
    const raw = await client.get(directTradeKeyspace(connectionId).state)
    if (raw) {
      const persisted = JSON.parse(raw)
      const persistedVolumeFactor = persisted?.volumeFactor ?? persisted?.minVolFactor
      // The former unversioned install used 10 as its shipped Direct-Trade
      // factor. Treat that exact legacy default as the new minimal default;
      // once versioned, an explicitly selected value up to 10 is preserved.
      const hasLegacyVolumeFactorDefault =
        (Number(persisted?.volumeFactorDefaultsVersion) || 0) < 1
        && Number(persistedVolumeFactor) === 10
      // Upgrade only the exact former default pair. Any mixed values remain
      // deliberate operator capacity choices.
      const hasLegacyCapacityDefaults = Number(persisted?.maxPositionsPerSymbol) === 3
        && Number(persisted?.maxPositionsPerDirection) === 2
      const takeProfitDefaultsVersion = Number(persisted?.takeProfitDefaultsVersion) || 0
      const hasFormerShippedTakeProfitGrid = Array.isArray(persisted?.takeProfitRatioRange)
        && Number(persisted.takeProfitRatioRange[0]) === 4
        && (Number(persisted.takeProfitRatioRange[1]) === 12
          || Number(persisted.takeProfitRatioRange[1]) === 8)
        && (persisted?.takeProfitRatioStep === undefined
          || Number(persisted.takeProfitRatioStep) === 2)
      // A short-lived pre-version transition could have written the new range
      // while retaining the old default step. Treat that exact unversioned
      // pair as one legacy default, never as an operator-selected dense grid.
      const hasUnversionedTransitionGrid = Array.isArray(persisted?.takeProfitRatioRange)
        && Number(persisted.takeProfitRatioRange[0]) === DEFAULT_STATE.takeProfitRatioRange[0]
        && Number(persisted.takeProfitRatioRange[1]) === DEFAULT_STATE.takeProfitRatioRange[1]
        && Number(persisted?.takeProfitRatioStep) === 2
      const hasLegacyTakeProfitDefaults = takeProfitDefaultsVersion < 2
        && (hasFormerShippedTakeProfitGrid || hasUnversionedTransitionGrid)
      return {
        ...DEFAULT_STATE,
        ...persisted,
        liveMode: persisted?.liveMode === true,
        connectionId: normaliseConnectionId(persisted?.connectionId),
        symbolOrder: normaliseSymbolOrder(persisted?.symbolOrder),
        minVolFactor: clampDirectTradeVolumeFactor(
          hasLegacyVolumeFactorDefault ? DIRECT_TRADE_VOLUME_FACTOR_DEFAULT : persistedVolumeFactor,
          DIRECT_TRADE_VOLUME_FACTOR_DEFAULT,
        ),
        volumeFactorEffectiveRatio: DIRECT_TRADE_EFFECTIVE_VOLUME_RATIO,
        volumeFactorDefaultsVersion: 1,
        // Migrate the former 1m/10m/15m defaults to the optimized exact
        // 5m/15m/30m coordination set.
        timeframes: normaliseDirectTradeTimeframes(persisted?.timeframes),
        strategyTypes: normaliseDirectTradeStrategyTypes(persisted?.strategyTypes),
        entryTactics: normaliseEntryTactics(persisted?.entryTactics),
        enabledIndicationTypes: Object.prototype.hasOwnProperty.call(persisted || {}, "enabledIndicationTypes")
          ? normaliseEnabledDirectTradeIndicationTypes(persisted?.enabledIndicationTypes, [])
          : normaliseEnabledDirectTradeIndicationTypes(
            persisted?.entryTactics,
            DEFAULT_STATE.enabledIndicationTypes,
          ),
        exitTactics: normaliseExitTactics(persisted?.exitTactics),
        entryTiming: persisted?.entryTiming === "last_confirmed" ? "last_confirmed" : "current",
        recalcIntervalMs: clampRecalculationInterval(persisted?.recalcIntervalMs, DEFAULT_STATE.recalcIntervalMs),
        // Migrate the former shipped 60h default to the unified 48h default;
        // any other persisted value remains an explicit operator choice.
        historyHours: Number(persisted?.historyHours) === 60
          ? DEFAULT_STATE.historyHours
          : clampDirectTradeHistoryHours(persisted?.historyHours, DEFAULT_STATE.historyHours),
        activityVolumeRatio: Math.max(0, Number(persisted?.activityVolumeRatio) || DEFAULT_STATE.activityVolumeRatio),
        positionCostPercent: normalizePositionCostPercent(persisted?.positionCostPercent ?? DEFAULT_STATE.positionCostPercent),
        maxHoldMinutes: Math.max(1, Number(persisted?.maxHoldMinutes) || DEFAULT_STATE.maxHoldMinutes),
        // Former shipped 4–12 and 4–8 grids were defaults, not deliberate
        // caps. Upgrade only those exact legacy defaults to the fresh 5–10
        // contract; any other persisted range remains the operator's choice.
        takeProfitRatioRange: hasLegacyTakeProfitDefaults
          ? DEFAULT_STATE.takeProfitRatioRange
          : normaliseDirectTradeTakeProfitRatioRange(
            persisted?.takeProfitRatioRange,
            DEFAULT_STATE.takeProfitRatioRange,
          ),
        takeProfitRatioStep: hasLegacyTakeProfitDefaults
          ? DEFAULT_STATE.takeProfitRatioStep
          : normaliseDirectTradeTakeProfitRatioStep(
            persisted?.takeProfitRatioStep,
            DEFAULT_STATE.takeProfitRatioStep,
          ),
        trailingMinTakeProfitRatio: normaliseDirectTradeTrailingMinTakeProfitRatio(
          persisted?.trailingMinTakeProfitRatio ?? persisted?.trailingMinStep,
          DEFAULT_STATE.trailingMinTakeProfitRatio,
        ),
        takeProfitDefaultsVersion: 2,
        // Upgrade exactly the former shipped 300-position default once. A
        // different persisted limit is an explicit operator choice.
        maxTotalPositions: (Number(persisted?.positionCapacityDefaultsVersion) || 0) < 1
          && Number(persisted?.maxTotalPositions) === 300
          ? DEFAULT_STATE.maxTotalPositions
          : clampOpenPositionLimit(persisted?.maxTotalPositions, DEFAULT_STATE.maxTotalPositions),
        positionCapacityDefaultsVersion: 1,
        slRatioStep: clampStopLossRatioStep(persisted?.slRatioStep, DEFAULT_STATE.slRatioStep),
        minProfitFactor: normalizeMainTradePfRatio(
          (Number(persisted?.fullHistoryPfDefaultsVersion) || 0) < 2
            && [0.8, 4].includes(Number(persisted?.minProfitFactor))
            ? DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT
            : persisted?.minProfitFactor,
          DEFAULT_STATE.minProfitFactor,
        ),
        fullHistoryPfDefaultsVersion: 2,
        minRecentProfitFactor: normalizeMainTradePfRatio(
          (Number(persisted?.fullHistoryPfDefaultsVersion) || 0) < 2
            && [10, 25].includes(Number(persisted?.minRecentProfitFactor))
            ? DIRECT_TRADE_RECENT_PF_DEFAULT
            : persisted?.minRecentProfitFactor,
          DEFAULT_STATE.minRecentProfitFactor,
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
        maxSlRatio: clampStopLossRatio(persisted?.maxSlRatio, DEFAULT_STATE.maxSlRatio),
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

async function setState(state: DirectTradeState, connectionId: string | null = state.connectionId): Promise<void> {
  const scope = connectionId || state.connectionId
  if (scope) await ensureConnectionScope(scope)
  const client = await getClient()
  if (scope) await client.sadd(DIRECT_TRADE_CONNECTION_INDEX_KEY, scope)
  await client.set(directTradeKeyspace(scope).state, JSON.stringify({ ...state, connectionId: scope }))
  await persistDirectTradeSnapshot("state")
}

function clampStopLossRatio(value: unknown, fallback = 0.75): number {
  const raw = Number(value)
  const clamped = Math.max(0.25, Math.min(1.5, Number.isFinite(raw) ? raw : fallback))
  return Number((Math.round(clamped / 0.25) * 0.25).toFixed(2))
}

function clampInverseStopLossRatio(value: unknown, fallback = 1.25): number {
  const raw = Number(value)
  const clamped = Math.max(0.25, Math.min(1.5, Number.isFinite(raw) ? raw : fallback))
  return Number((Math.round(clamped / 0.25) * 0.25).toFixed(2))
}

function clampStopLossRatioStep(value: unknown, fallback = 0.25): number {
  const raw = Number(value)
  const clamped = Math.max(0.25, Math.min(0.75, Number.isFinite(raw) ? raw : fallback))
  return Number((Math.round(clamped / 0.25) * 0.25).toFixed(2))
}

function clampOpenPositionLimit(value: unknown, fallback = DIRECT_TRADE_DEFAULT_MAX_TOTAL_POSITIONS): number {
  const raw = Number(value)
  return Math.max(1, Math.min(DIRECT_TRADE_MAX_TOTAL_POSITIONS, Math.floor(Number.isFinite(raw) ? raw : fallback)))
}

function clampProcessingInterval(value: unknown, fallback = DIRECT_TRADE_PROCESSING_INTERVAL_DEFAULT_MS): number {
  const raw = Number(value)
  return Math.max(100, Math.min(5_000, Math.round(Number.isFinite(raw) ? raw : fallback)))
}

function requestedDirectTradeVolumeFactor(body: any, fallback: unknown): number {
  const requested = body?.volumeFactor !== undefined
    ? body.volumeFactor
    : body?.minVolFactor !== undefined
      ? body.minVolFactor
      : fallback
  return clampDirectTradeVolumeFactor(requested, clampDirectTradeVolumeFactor(fallback))
}

function normaliseConnectionId(value: unknown): string | null {
  const id = normalizeDirectTradeConnectionId(value)
  return id && /^[A-Za-z0-9._:-]{1,160}$/.test(id) ? id : null
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

async function acquireProcessorLease(
  client: any,
  instanceId: string,
  connectionId: string | null,
): Promise<boolean> {
  if (!instanceId || instanceId.length > 160) return false
  const leaseKey = directTradeKeyspace(connectionId).processorLease
  return acquireOrRenewDirectTradeProcessorLease({
    client,
    key: leaseKey,
    owner: instanceId,
    ttlMs: processorLeaseMs(),
    backend: getRedisBackend(),
  })
}

async function renewOwnedProcessorLease(
  client: any,
  instanceId: string,
  connectionId: string | null,
): Promise<boolean> {
  if (!instanceId || instanceId.length > 160) return false
  const leaseKey = directTradeKeyspace(connectionId).processorLease
  return renewDirectTradeProcessorLease({
    client,
    key: leaseKey,
    owner: instanceId,
    ttlMs: processorLeaseMs(),
    backend: getRedisBackend(),
  })
}

async function getStats(connectionId: string | null = null): Promise<DirectTradeStats> {
  try {
    const client = await getClient()
    const raw = await client.get(directTradeKeyspace(connectionId).stats)
    if (raw) return { ...DEFAULT_STATS, ...JSON.parse(raw) }
  } catch {}
  return { ...DEFAULT_STATS }
}

async function getExecutionConfigs(
  options: { activeOnly?: boolean; signalKeys?: string[] } = {},
  connectionId: string | null = null,
): Promise<any[]> {
  try {
    const client = await getClient()
    const keys = directTradeKeyspace(connectionId)
    const [indexRaw, signalIndexRaw, activeSignalRaw, manifest] = await Promise.all([
      client.get(keys.executionIndex),
      client.get(keys.executionSignalIndex),
      options.activeOnly ? client.get(keys.activeSignals) : Promise.resolve(null),
      getDirectTradeConfigManifest(client, connectionId),
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
          return (await readDirectTradeConfigsAtIndexes(client, selected.map(Number), connectionId))
            .sort((left, right) => Number(right?.score || 0) - Number(left?.score || 0))
        } catch {}
      }
      // A manifest means a maximum grid is chunked. Refuse to recreate a
      // giant JSON response when no causal signal selection was supplied;
      // the processor asks with `activeOnly=1` after each pulse instead.
      if (manifest) return []
      return (await readDirectTradeConfigsAtIndexes(client, indexes.map(Number), connectionId))
        .sort((left, right) => Number(right?.score || 0) - Number(left?.score || 0))
    }
  } catch {}
  // Compatibility for existing installations until their next calculation.
  return getJsonArray(directTradeKeyspace(connectionId).executionConfigs)
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

function parseStoredJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    return parsed === null || parsed === undefined ? fallback : parsed as T
  } catch {
    return fallback
  }
}

async function getCalculation(connectionId: string | null = null): Promise<Record<string, unknown>> {
  return getJsonObject(directTradeKeyspace(connectionId).calculation)
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
    const connectionId = normaliseConnectionId(searchParams.get("connectionId"))
    if (view === "connections") {
      const client = await getClient()
      const indexed = await client.smembers(DIRECT_TRADE_CONNECTION_INDEX_KEY).catch(() => [])
      const legacyRaw = await client.get(directTradeKeyspace().state).catch(() => null)
      const legacy = parseStoredJson<any>(legacyRaw, null)
      const legacyId = normaliseConnectionId(legacy?.connectionId)
      const ids = [...new Set([
        ...indexed.map(String).map(normaliseConnectionId).filter((id): id is string => Boolean(id)),
        ...(legacyId ? [legacyId] : []),
      ])].sort()
      const connections = await Promise.all(ids.map(async (id) => {
        await ensureConnectionScope(id)
        const keys = directTradeKeyspace(id)
        const [stateRaw, positionsRaw, processorRaw] = await Promise.all([
          client.get(keys.state),
          client.get(keys.positions),
          client.get(keys.processor),
        ])
        const state = parseStoredJson<any>(stateRaw, { ...DEFAULT_STATE, connectionId: id })
        const storedPositions = parseStoredJson<unknown>(positionsRaw, [])
        const positions = Array.isArray(storedPositions) ? storedPositions : []
        const processor = parseStoredJson<any>(processorRaw, null)
        const openPositions = Array.isArray(positions)
          ? positions.filter((position: any) => {
              const status = String(position?.status || "").trim().toLowerCase()
              return status === "open" || status === "opening"
            }).length
          : 0
        const accountingPending = Array.isArray(positions)
          ? positions.filter((position: any) => (
              String(position?.status || "").trim().toLowerCase() === "closed"
              && ["live", "exchange", "real"].includes(String(position?.mode || "").trim().toLowerCase())
              && resolveDirectTradeSettledExchangePnlUsdt(position) === null
            )).length
          : 0
        return {
          connectionId: id,
          enabled: state?.enabled === true,
          liveMode: state?.liveMode === true,
          openPositions,
          accountingPending,
          processor,
        }
      }))
      return NextResponse.json({ success: true, connections })
    }
    if (view === "statistics") {
      const [calculation, index] = await Promise.all([
        getCalculation(connectionId),
        getJsonObject(directTradeKeyspace(connectionId).statisticsIndex),
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
      const normalizedRows = Array.isArray((index as any)?.rows) ? (index as any).rows : []
      const topRowIndexes = (index as any)?.topRowIndexes && typeof (index as any).topRowIndexes === "object"
        ? (index as any).topRowIndexes
        : {}
      const selectedIndexes = Array.isArray(topRowIndexes[key]) ? topRowIndexes[key] : []
      const rows = Number((index as any)?.schemaVersion) === 2
        ? selectedIndexes
            .map((rowIndex: unknown) => Number(rowIndex))
            .filter((rowIndex: number) => Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < normalizedRows.length)
            .map((rowIndex: number) => normalizedRows[rowIndex])
        : (Array.isArray(topRows[key]) ? topRows[key] : [])
      return NextResponse.json({
        success: true,
        calculation,
        selection: { timeframe, direction, state, strategyType },
        matched: Math.max(0, Number(totals[key]) || 0),
        rows,
        rowLimit: 100,
        indexVersion: typeof (index as any)?.version === "string" ? (index as any).version : null,
      })
    }

    const includeExecution = searchParams.get("includeExecution") === "1"
    const activeOnly = searchParams.get("activeOnly") === "1"
    const signalKeys = searchParams.getAll("signalKey")
    const keys = directTradeKeyspace(connectionId)
    const [state, stats, executionConfigs, positions, openPositionStage, configStatus, configPerformance, calculation, connection] = await Promise.all([
      getState(connectionId),
      getStats(connectionId),
      includeExecution ? getExecutionConfigs({ activeOnly, signalKeys }, connectionId) : Promise.resolve([]),
      getJsonArray(keys.positions),
      getJsonObject(keys.openPositionStage),
      getJsonObject(keys.configStatus),
      getJsonObject(keys.configPerformance),
      getCalculation(connectionId),
      connectionId ? getConnection(connectionId) : Promise.resolve(null),
    ])
    const exchange = String((connection as any)?.exchange || (connection as any)?.exchange_name || (connectionId ? "" : "bingx"))
      .trim()
      .toLowerCase()
    return NextResponse.json({
      success: true,
      connectionId,
      exchange: exchange || null,
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
    const requestedConnectionId = normaliseConnectionId(body?.connectionId)
    const currentState = await getState(requestedConnectionId)
    const scopeConnectionId = requestedConnectionId || currentState.connectionId

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
        ...((body.minVolFactor !== undefined || body.volumeFactor !== undefined)
          ? { minVolFactor: requestedDirectTradeVolumeFactor(body, currentState.minVolFactor) }
          : {}),
        ...(body.positionCostPercent !== undefined ? { positionCostPercent: normalizePositionCostPercent(body.positionCostPercent) } : {}),
        ...(body.maxSlRatio !== undefined ? { maxSlRatio: clampStopLossRatio(body.maxSlRatio) } : {}),
        ...(body.slRatioStep !== undefined ? { slRatioStep: clampStopLossRatioStep(body.slRatioStep) } : {}),
        ...(body.inverseMaxSlRatio !== undefined ? { inverseMaxSlRatio: clampInverseStopLossRatio(body.inverseMaxSlRatio) } : {}),
        ...(body.timeframes ? { timeframes: normaliseDirectTradeTimeframes(body.timeframes) } : {}),
        ...(body.strategyTypes !== undefined ? { strategyTypes: normaliseDirectTradeStrategyTypes(body.strategyTypes) } : {}),
        ...(body.historyHours !== undefined ? { historyHours: clampDirectTradeHistoryHours(body.historyHours, DEFAULT_STATE.historyHours) } : {}),
        ...(body.recalcIntervalMs !== undefined ? { recalcIntervalMs: clampRecalculationInterval(body.recalcIntervalMs) } : {}),
        ...(body.entryTactics !== undefined ? { entryTactics: normaliseEntryTactics(body.entryTactics) } : {}),
        ...(body.enabledIndicationTypes !== undefined ? {
          enabledIndicationTypes: normaliseEnabledDirectTradeIndicationTypes(body.enabledIndicationTypes, []),
        } : {}),
        ...(body.exitTactics !== undefined ? { exitTactics: normaliseExitTactics(body.exitTactics) } : {}),
        ...(body.entryTiming !== undefined ? { entryTiming: body.entryTiming === "last_confirmed" ? "last_confirmed" : "current" as const } : {}),
        ...(body.activityVolumeRatio !== undefined ? { activityVolumeRatio: Math.max(0, Number(body.activityVolumeRatio) || 0) } : {}),
        ...(body.maxHoldMinutes !== undefined ? { maxHoldMinutes: Math.max(1, Number(body.maxHoldMinutes) || DEFAULT_STATE.maxHoldMinutes) } : {}),
        ...(body.takeProfitRatioRange !== undefined ? { takeProfitRatioRange: normaliseDirectTradeTakeProfitRatioRange(body.takeProfitRatioRange, currentState.takeProfitRatioRange) } : {}),
        ...(body.takeProfitRatioStep !== undefined ? { takeProfitRatioStep: normaliseDirectTradeTakeProfitRatioStep(body.takeProfitRatioStep, currentState.takeProfitRatioStep) } : {}),
        ...(body.trailingMinTakeProfitRatio !== undefined ? { trailingMinTakeProfitRatio: normaliseDirectTradeTrailingMinTakeProfitRatio(body.trailingMinTakeProfitRatio, currentState.trailingMinTakeProfitRatio) } : {}),
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
        ...(body.minProfitFactor !== undefined ? { minProfitFactor: normalizeMainTradePfRatio(body.minProfitFactor, DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT) } : {}),
        ...(body.minRecentProfitFactor !== undefined ? { minRecentProfitFactor: normalizeMainTradePfRatio(body.minRecentProfitFactor, DIRECT_TRADE_RECENT_PF_DEFAULT) } : {}),
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
      await setState(newState, scopeConnectionId || newState.connectionId)
      return NextResponse.json({ success: true, state: newState, message: "Direct-Trade started" })
    }

    if (body.action === "stop") {
      const newState: DirectTradeState = { ...currentState, enabled: false }
      await setState(newState, scopeConnectionId)
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
      await setState(newState, scopeConnectionId || newState.connectionId)
      return NextResponse.json({ success: true, state: newState, message: `Live mode ${newState.liveMode ? "enabled" : "disabled"}` })
    }

    if (body.action === "update-config") {
      const newState: DirectTradeState = {
        ...currentState,
        ...(body.connectionId !== undefined ? { connectionId: normaliseConnectionId(body.connectionId) } : {}),
        ...(body.symbolCount !== undefined ? { symbolCount: clampDirectTradeSymbolCount(body.symbolCount) } : {}),
        ...(body.symbolOrder !== undefined ? { symbolOrder: normaliseSymbolOrder(body.symbolOrder) } : {}),
        ...((body.minVolFactor !== undefined || body.volumeFactor !== undefined)
          ? { minVolFactor: requestedDirectTradeVolumeFactor(body, currentState.minVolFactor) }
          : {}),
        ...(body.positionCostPercent !== undefined ? { positionCostPercent: normalizePositionCostPercent(body.positionCostPercent) } : {}),
        ...(body.maxSlRatio !== undefined ? { maxSlRatio: clampStopLossRatio(body.maxSlRatio) } : {}),
        ...(body.slRatioStep !== undefined ? { slRatioStep: clampStopLossRatioStep(body.slRatioStep) } : {}),
        ...(body.inverseMaxSlRatio !== undefined ? { inverseMaxSlRatio: clampInverseStopLossRatio(body.inverseMaxSlRatio) } : {}),
        ...(body.timeframes !== undefined ? { timeframes: normaliseDirectTradeTimeframes(body.timeframes) } : {}),
        ...(body.strategyTypes !== undefined ? { strategyTypes: normaliseDirectTradeStrategyTypes(body.strategyTypes) } : {}),
        ...(body.historyHours !== undefined ? { historyHours: clampDirectTradeHistoryHours(body.historyHours, DEFAULT_STATE.historyHours) } : {}),
        ...(body.recalcIntervalMs !== undefined ? { recalcIntervalMs: clampRecalculationInterval(body.recalcIntervalMs) } : {}),
        ...(body.entryTactics !== undefined ? { entryTactics: normaliseEntryTactics(body.entryTactics) } : {}),
        ...(body.enabledIndicationTypes !== undefined ? {
          enabledIndicationTypes: normaliseEnabledDirectTradeIndicationTypes(body.enabledIndicationTypes, []),
        } : {}),
        ...(body.exitTactics !== undefined ? { exitTactics: normaliseExitTactics(body.exitTactics) } : {}),
        ...(body.entryTiming !== undefined ? { entryTiming: body.entryTiming === "last_confirmed" ? "last_confirmed" : "current" as const } : {}),
        ...(body.activityVolumeRatio !== undefined ? { activityVolumeRatio: Math.max(0, Number(body.activityVolumeRatio) || 0) } : {}),
        ...(body.maxHoldMinutes !== undefined ? { maxHoldMinutes: Math.max(1, Number(body.maxHoldMinutes) || DEFAULT_STATE.maxHoldMinutes) } : {}),
        ...(body.takeProfitRatioRange !== undefined ? { takeProfitRatioRange: normaliseDirectTradeTakeProfitRatioRange(body.takeProfitRatioRange, currentState.takeProfitRatioRange) } : {}),
        ...(body.takeProfitRatioStep !== undefined ? { takeProfitRatioStep: normaliseDirectTradeTakeProfitRatioStep(body.takeProfitRatioStep, currentState.takeProfitRatioStep) } : {}),
        ...(body.trailingMinTakeProfitRatio !== undefined ? { trailingMinTakeProfitRatio: normaliseDirectTradeTrailingMinTakeProfitRatio(body.trailingMinTakeProfitRatio, currentState.trailingMinTakeProfitRatio) } : {}),
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
        ...(body.minProfitFactor !== undefined ? { minProfitFactor: normalizeMainTradePfRatio(body.minProfitFactor, DIRECT_TRADE_FULL_HISTORY_PF_DEFAULT) } : {}),
        ...(body.minRecentProfitFactor !== undefined ? { minRecentProfitFactor: normalizeMainTradePfRatio(body.minRecentProfitFactor, DIRECT_TRADE_RECENT_PF_DEFAULT) } : {}),
        ...(body.recentEvaluationPositions !== undefined ? { recentEvaluationPositions: Math.max(3, Math.floor(Number(body.recentEvaluationPositions) || 3)) } : {}),
        ...(body.maxDrawdownTimeMin !== undefined ? { maxDrawdownTimeMin: Math.max(1, Number(body.maxDrawdownTimeMin) || 1) } : {}),
        ...(body.prevPosWindow !== undefined ? { prevPosWindow: Math.max(5, Number(body.prevPosWindow) || 5) } : {}),
        ...(body.prevPosMinCount !== undefined ? { prevPosMinCount: Math.max(1, Number(body.prevPosMinCount) || 1) } : {}),
        ...(body.evalPosCount !== undefined ? { evalPosCount: Math.max(3, Number(body.evalPosCount) || 3) } : {}),
        ...(body.trailingEnabled !== undefined ? { trailingEnabled: body.trailingEnabled } : {}),
        ...(body.dcaProfile !== undefined ? { dcaProfile: normalizeDcaProfile(body.dcaProfile) } : {}),
        ...(body.lastRecalcAt !== undefined && typeof body.lastRecalcAt === "string" ? { lastRecalcAt: body.lastRecalcAt } : {}),
      }
      await setState(newState, scopeConnectionId || newState.connectionId)
      return NextResponse.json({ success: true, state: newState, message: "Config updated" })
    }

    if (body.action === "reset-stats") {
      const client = await getClient()
      await client.set(directTradeKeyspace(scopeConnectionId).stats, JSON.stringify(DEFAULT_STATS))
      await persistDirectTradeSnapshot("statistics reset")
      return NextResponse.json({ success: true, message: "Stats reset" })
    }

    if (body.action === "processor-heartbeat") {
      const processorToken = String(process.env.DIRECT_TRADE_PROCESSOR_TOKEN || "")
      if (processorToken.length < 24) {
        return NextResponse.json({ success: false, error: "Direct-Trade worker token is not configured" }, { status: 503 })
      }
      if (!sameProcessorSecret(request.headers.get("x-direct-trade-processor-token"), processorToken)) {
        return NextResponse.json({ success: false, error: "Direct-Trade worker authentication failed" }, { status: 401 })
      }
      const instanceId = typeof body.instanceId === "string" ? body.instanceId : ""
      const client = await getClient()
      const leaseHeld = await renewOwnedProcessorLease(client, instanceId, scopeConnectionId)
      if (!leaseHeld) {
        return NextResponse.json({ success: true, leaseHeld: false })
      }

      const keys = directTradeKeyspace(scopeConnectionId)
      const now = new Date().toISOString()
      // Heartbeat and full processor-sync run on independent loops. Updating
      // the full JSON snapshot here creates a read/modify/write race in which
      // an older heartbeat can overwrite a newer lifecycle progress marker or
      // authoritative position summary. Keep liveness on its dedicated key;
      // processor-sync remains the sole writer of the complete snapshot.
      await client.set(keys.processorHeartbeat, now, { PX: 20_000 })
      return NextResponse.json({ success: true, leaseHeld: true })
    }

    if (body.action === "processor-sync") {
      const instanceId = typeof body.instanceId === "string" ? body.instanceId : ""
      const client = await getClient()
      const leaseHeld = await acquireProcessorLease(client, instanceId, scopeConnectionId)
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
      const requestedProgressAt = Date.parse(String(body.lastProgressAt || ""))
      const lastProgressAt = Number.isFinite(requestedProgressAt) && requestedProgressAt <= Date.now() + 1_000
        ? new Date(requestedProgressAt).toISOString()
        : null
      const processor = {
        instanceId,
        lastTick: now,
        lastHeartbeatAt: now,
        lastProgressAt,
        lifecycleCycleCount: Math.max(0, Math.floor(Number(body.lifecycleCycleCount) || 0)),
        tickCount: Math.max(0, Math.floor(Number(body.tickCount) || 0)),
        errorsLast5min: Math.max(0, Math.floor(Number(body.errorsLast5min) || 0)),
        lastRecalcAt: typeof body.lastRecalcAt === "number" ? body.lastRecalcAt : null,
        positionCount: positions.length,
        openPositionCount: positions.filter((position: any) => position?.status === "open").length,
        openingPositionCount: positions.filter((position: any) => position?.status === "opening").length,
        configCount: Math.max(0, Math.floor(Number(body.configCount) || 0)),
        historyPolicy: body.historyPolicy && typeof body.historyPolicy === "object"
          ? body.historyPolicy
          : null,
      }
      const keys = directTradeKeyspace(scopeConnectionId)
      const write = client.multi()
      write.set(keys.positions, JSON.stringify(positions))
      write.set(keys.openPositionStage, JSON.stringify(openPositionStage))
      write.set(keys.stats, JSON.stringify(stats))
      write.set(keys.configStatus, JSON.stringify(configStatus))
      write.set(keys.configPerformance, JSON.stringify(configPerformance))
      write.set(keys.processor, JSON.stringify(processor))
      write.set(keys.processorHeartbeat, now, { PX: 20_000 })
      await write.exec()
      await persistDirectTradeSnapshot("processor position sync")
      // The owner receives the compact, normalized settings acknowledgement
      // with the write it already performs. This lets a running worker react
      // to an operator save on its next sync instead of waiting for a loop
      // counter to reach an arbitrary polling interval.
      return NextResponse.json({
        success: true,
        leaseHeld: true,
        processor,
        state: await getState(scopeConnectionId),
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
