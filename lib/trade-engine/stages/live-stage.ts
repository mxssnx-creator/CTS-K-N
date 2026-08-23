Warning: truncated output (original token count: 153250)
Total output lines: 13579

/**
 * Stage 5: Live Exchange Position Creation Progression
 *
 * Complete end-to-end pipeline for creating and tracking a live position on a
 * real exchange. Mirrors a qualifying Real set into an executable exchange
 * position, with:
 *
 *   1. Pre-flight validation (live_trade flag, input sanity, dedup lock)
 *   2. Current price fetch from Redis market data
 *   3. Volume calculation via VolumeCalculator (respecting balance, leverage,
 *      position cost, and exchange minimum volume)
 *   4. Leverage + margin type configuration on the exchange
 *   5. Market entry order placement with exponential-backoff retry
 *   6. Order fill confirmation polling
 *   7. Reduce-only Stop Loss and Take Profit order placement
 *   8. Position sync from exchange (liquidation price, margin type, mark price)
 *   9. Progression logging at every stage (engine_logs:{connId})
 *  10. Metrics counters in progression:{connId} hash (live orders placed,
 *      filled, failed; live positions open; total volume USD)
 *
 * When neither Main Live nor the independent Preset mode is enabled, the
 * pipeline records a simulated position without touching the exchange.
 */

import {
  getAppSettings,
  getConnection,
  getRedisClient,
  initRedis,
  moveRedisListMembershipToHead,
  setSettings,
  upsertRedisListHead,
} from "@/lib/redis-db"
import { nanoid } from "@/lib/trade-engine/pseudo-position-manager"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { emitCanonicalEvent } from "@/lib/events/emitter"
import { VolumeCalculator } from "@/lib/volume-calculator"
import { resolveExecutableQuantity } from "@/lib/order-quantity"
import { SystemLogger } from "@/lib/system-logger"
import type { RealPosition } from "./real-stage"
import { getEngineTimings } from "@/lib/engine-timings"
import { withTimeout } from "@/lib/async-safety"
import { getMaxLeverageForExchange } from "@/lib/leverage-policy"
import {
  newLiveOrderTrace,
  withLiveOrderLogging,
  logLiveOrderFinal,
  type LiveOrderTrace,
} from "@/lib/live-order-logger"
import { setupLiveOrderMarginAndLeverage } from "@/lib/live-order-service"
import {
  isConnectionLiveTradeEnabled,
  isConnectionPresetTradeEnabled,
  isConnectionSignalTradeEnabled,
  isTruthyFlag,
} from "@/lib/connection-state-utils"
import { evaluateRealTradeReadiness } from "@/lib/real-trade-gates"
import {
  advanceBlockCountPausesOnPositionClose,
  buildBlockLegState,
  calculateBlockAddQuantity,
  calculateBlockRemainingAddQuantity,
  calculateBlockTargetQuantity,
  calculateConfirmedBlockAddQuantity,
  calculateBlockVolumeIncrementRatio,
  parseBlockCount,
  syncActiveBlockCountIndex,
  type BlockLegState,
} from "@/lib/block-count-state"
import {
  buildDcaStepSetKey,
  calculateDcaAddQuantity,
  calculateDcaTakeProfitPrice,
  mergeDcaProfileSources,
  normalizeDcaProfile,
  resolveNextDcaStep,
  upsertDcaLeg,
  type DcaLegState,
  type DcaProfile,
} from "@/lib/dca-strategy"
import {
  markStrategyPositionInactive,
  recordStrategyPositionEntry,
} from "@/lib/pos-history"
import { netMovePctAfterPositionCost } from "@/lib/main-trade-profit-factor"
import {
  inferRealStrategyVariant,
  type RealStrategyVariant,
} from "@/lib/strategy-real-stats"
import { getLivePositionSetLineageKeys } from "@/lib/live-position-lineage"
import {
  resolveCombinedPosCountDelta,
  resolveCombinedPosCountTargetQuantity,
} from "@/lib/pos-count-live-target"
import {
  allocateQuantityAcrossSets,
  allocateQuantityByRatios,
  decideControlOrderBarrier,
  isActiveControlOrderStatus,
  isFilledControlOrderStatus,
  reconcileCumulativeReduction,
  upsertPartialOrderExecution,
  type PartialOrderExecution,
  type PartialOrderExecutionSource,
} from "@/lib/live-order-coordination"
import {
  loadSignalIndicationSettings,
  mergeSignalRisks,
  normalizeSignalRisk,
  recordSignalPerformanceOutcome,
  type SignalRisk,
} from "@/lib/signal-indication"
import {
  evaluateSignalPositionCapacity,
  isActiveSignalPosition,
  normalizeSignalMaxPositions,
  type SignalPositionCapacity,
} from "@/lib/signal-position-policy"
import {
  isSignalDynamicTrailingProfile,
  resolveSignalExecutionLane,
  resolveSignalExecutionSlot,
  type SignalExecutionLane,
  type TrailingProfile,
} from "@/lib/signal-trailing"
import {
  normalizePositionCostPercent,
  stopLossPositionCostRatioToPercent,
  takeProfitPositionCostRatioToPercent,
} from "@/lib/position-cost"
import { logRuntimeInfo, logRuntimeWarning } from "@/lib/runtime-log-throttle"
import { archiveClosedLivePositionAnalytics } from "@/lib/live-position-analytics-archive"
import { concurrencyFromEnv, mapWithConcurrency } from "@/lib/bounded-concurrency"
import {
  BINGX_CONTROL_ORDER_LIMIT,
  ControlOrderCapacityBudget,
  countUniqueBingXControlOrders,
  type ControlOrderCapacitySnapshot,
  type ProtectionOrderLeg,
} from "@/lib/control-order-capacity"
import {
  calculateLivePositionStatistics,
  type LivePositionStatistics,
} from "@/lib/live-position-statistics"
import {
  SPECIAL_MAX_HOLDING_SECONDS,
  sanitizeSpecialPositionPlan,
  type SpecialPositionPlan,
} from "@/lib/special-strategy"

async function loadExchangeQuantityRules(symbol: string): Promise<Record<string, unknown> | null> {
  try {
    const client = getRedisClient() as any
    if (typeof client?.hgetall !== "function") return null
    return await client.hgetall(`settings:trading_pair:${symbol}`)
  } catch {
    return null
  }
}

const LOG_PREFIX = "[v0] [LivePositionStage]"
const MIN_EXCHANGE_STOP_LOSS_PERCENT = 0.2
const SIGNAL_ADMISSION_LOCK_TTL_MS = 15_000
const SIGNAL_ADMISSION_WAIT_MS = 2_000
const SIGNAL_CAPACITY_NOTICE_INTERVAL_MS = 30_000
const SIGNAL_CAPACITY_NOTICE_MAX_CONNECTIONS = 128
type LiveExecutionIntent = "main" | "preset" | "signal"

function volumeTradeModeForIntent(intent: LiveExecutionIntent): "main" | "preset" {
  return intent === "preset" ? "preset" : "main"
}

/**
 * Signal is a normal Main indication, not a third mutually-exclusive live
 * engine.  Its dedicated switch starts the Signal-only lane only when neither
 * Main nor Preset is already live; an enabled Main/Preset connection must
 * therefore remain able to execute a Signal-originated Real position.
 */
function readinessIntentForExecution(
  settings: Record<string, any>,
  intent: LiveExecutionIntent,
): LiveExecutionIntent {
  if (intent !== "signal") return intent
  if (isConnectionLiveTradeEnabled(settings)) return "main"
  if (isConnectionPresetTradeEnabled(settings)) return "preset"
  return "signal"
}
const signalCapacityNoticeAt = new Map<string, number>()

// ── Position snapshot cache for cycle-level deduplication ──
// Per-cycle position cache keyed by {connId} to eliminate duplicate getPositions() 
// calls when processing multiple symbols. Cache expires after the cycle completes
// (~500ms) so subsequent cycles re-fetch fresh state. Reduces API calls by 30-40%.
const positionCacheByConn = new Map<string, { positions: any[]; expiresAt: number }>()
const POSITION_CACHE_TTL_MS = 500
const POSITION_CACHE_MAX_SIZE = 50  // Prevent unbounded growth with many connections
const EXCHANGE_ABSENCE_CONFIRM_MS = 2_000
const exchangeAbsenceFirstSeenAt = new Map<string, number>()

function recordExchangeAbsence(position: Pick<LivePosition, "connectionId" | "id">): boolean {
  const key = `${position.connectionId}:${position.id}`
  const now = Date.now()
  const firstSeen = exchangeAbsenceFirstSeenAt.get(key)
  if (!firstSeen) {
    exchangeAbsenceFirstSeenAt.set(key, now)
    return false
  }
  return now - firstSeen >= EXCHANGE_ABSENCE_CONFIRM_MS
}

function clearExchangeAbsence(position: Pick<LivePosition, "connectionId" | "id">): void {
  exchangeAbsenceFirstSeenAt.delete(`${position.connectionId}:${position.id}`)
}

function getCachedPositions(connId: string): any[] | null {
  const entry = positionCacheByConn.get(connId)
  if (entry && entry.expiresAt > Date.now()) {
    return entry.positions
  }
  positionCacheByConn.delete(connId)
  return null
}

function setCachedPositions(connId: string, positions: any[]): void {
  // Enforce size limit to prevent unbounded memory growth
  if (positionCacheByConn.size >= POSITION_CACHE_MAX_SIZE && !positionCacheByConn.has(connId)) {
    const firstKey = positionCacheByConn.keys().next().value
    if (firstKey) positionCacheByConn.delete(firstKey)
  }
  positionCacheByConn.set(connId, {
    positions,
    expiresAt: Date.now() + POSITION_CACHE_TTL_MS,
  })
}

function clearPositionCache(connId: string): void {
  positionCacheByConn.delete(connId)
}

// ── BingX code=110206: TP/SL order quota exceeded ──────────────────────────
// When the account's open SL/TP order count reaches the exchange limit, every
// placeStopOrder call returns 110206. Without a circuit breaker the reconcile
// loop retries every cycle (~150/min), flooding the exchange log and burning
// API rate-limit budget. This map records the earliest time the engine is
// allowed to attempt protection placement again for a given connectionId.
// The cooldown window is 60 s — long enough for the operator to see the error
// and cancel stale orders, but short enough to resume automatically once quota
// is freed (e.g. when old positions close and their SL/TP orders are removed
// by the exchange).
const protectionQuotaBackoff = new Map<string, number>()
const PROTECTION_QUOTA_BACKOFF_MS = 60_000  // 60 s per-connection cooldown

const triggerFrequencyBackoff = new Map<string, number>()
const TRIGGER_FREQUENCY_BACKOFF_MS = 30_000  // 30 s per-connection cooldown (BingX code 100410)

function isProtectionQuotaBlocked(connId: string) {
  const until = protectionQuotaBackoff.get(connId)
  if (until && until > Date.now()) return true
  if (until) {
    protectionQuotaBackoff.delete(connId)
  }
  return false
}

function markProtectionQuotaExhausted(connId: string) {
  const until = Date.now() + PROTECTION_QUOTA_BACKOFF_MS
  if (!protectionQuotaBackoff.has(connId)) {
    console.log(
      `${LOG_PREFIX} [ProtectionQuota] ${connId}: code=110206 quota exceeded — suspending SL/TP placement for ${PROTECTION_QUOTA_BACKOFF_MS / 1000}s`,
    )
  }
  protectionQuotaBackoff.set(connId, until)
}

function isTriggerFrequencyBlocked(connId: string) {
  const until = triggerFrequencyBackoff.get(connId)
  if (until && until > Date.now()) return true
  if (until) {
    triggerFrequencyBackoff.delete(connId)
  }
  return false
}

function markTriggerFrequencyThrottled(connId: string) {
  const until = Date.now() + TRIGGER_FREQUENCY_BACKOFF_MS
  if (!triggerFrequencyBackoff.has(connId)) {
    console.warn(
      `${LOG_PREFIX} [TriggerFrequency] ${connId}: code=100410 endpoint throttled — suspending cancellations for ${TRIGGER_FREQUENCY_BACKOFF_MS / 1000}s`,
    )
  }
  triggerFrequencyBackoff.set(connId, until)
}

/**
 * Compute the initial SL% for a newly-created live position using the Set's
 * own configuration. Each variant has a different protection contract:
 *
 *   trailing — The trailing machine anchors from `trailingProfile.stopRatio`
 *              (the trailing distance, e.g. 0.1 = 10%). Using the generic
 *              PF-derived SL here would conflict with the ratchet: the first
 *              tick would re-derive the SL from a different basis and either
 *              widen or tighten the live exchange order beyond the operator's
 *              trailing spec. We use `stopRatio * 100` as the initial SL%
 *              so the exchange order always starts at the trailing stop distance.
 *              This is overridden per-tick by `trailingStopPrice` once active.
 *
 *   block    — Block positions are additive add-ons at scaled size (1.5–2×).
 *              The SL must NOT widen with the size multiplier (that would
 *              multiply risk). The `derivedSl` from PF is already size-multiplier-
 *              scaled inside `deriveProtectionFromProfitFactor` (stopLossPct =
 *              baseRiskPct * sizeMultiplier). We apply a FLOOR of the standard
 *              minimum to ensure the block SL never compresses below exchange min.
 *
 *   dca      — DCA is a recovery trade (0.5× size). Tighter SL is correct —
 *              the PF-derived value (stopLossPct = baseRiskPct * 0.5) already
 *              reflects this. We apply the same floor. No override needed.
 *
 *   default/other — Use the PF-derived value as-is.
 *
 * Returns the SL% (a positive percentage, e.g. 1.2 means 1.2%).
 * Falls back to `derivedSl` for any unrecognised variant.
 */
function computeSetAwareSL(
  derivedSl: number,
  setVariant: LivePosition["setVariant"],
  trailingProfile: LivePosition["trailingProfile"] | undefined,
): number {
  if (setVariant === "trailing" && trailingProfile && trailingProfile.stopRatio > 0) {
    // For trailing-variant positions the initial exchange SL is placed at the
    // trailing stop distance from entry. The trailing machine then ratchets this
    // upward (long) or downward (short) as price moves in our favour. Using the
    // trailing stopRatio ensures the initial order and the ratchet machine are
    // in sync from the first tick.
    const trailingSl = isSignalDynamicTrailingProfile(trailingProfile)
      ? Math.max(0.8, (trailingProfile.minStopRatio ?? trailingProfile.stopRatio) * 100)
      : trailingProfile.stopRatio * 100
    return Math.max(MIN_EXCHANGE_STOP_LOSS_PERCENT, trailingSl)
  }
  // For all other variants (default, block, dca, pause) the PF-derived value
  // is already variant-adjusted (block: scaled up by sizeMultiplier, dca: 0.5×).
  // Enforce the minimum floor in all cases.
  return Math.max(MIN_EXCHANGE_STOP_LOSS_PERCENT, derivedSl)
}






async function isLiveTradeEnabledForConnection(connectionId: string): Promise<boolean> {
  const connection = (await getConnection(connectionId).catch(() => null)) || {}
  return evaluateRealTradeReadiness(connection as Record<string, any>).canPlaceRealOrders ||
    evaluateRealTradeReadiness(connection as Record<string, any>, "preset").canPlaceRealOrders ||
    evaluateRealTradeReadiness(connection as Record<string, any>, "signal").canPlaceRealOrders
}

// ── Exchange call timeouts ────────────────────────────────────────────────
// Target: syncWithExchange completes in <1 s on the hot path.
// These timeouts bound per-call worst case so the pool never hangs.
// Each value is calibrated to a ~2×p99 RTT of a typical BingX API call
// SDK-backed BingX order/control calls normally complete in sub-second to a
// few seconds. Fail fast so a hung venue call does not leave the control-order
// queue blocked; the next reconcile tick retries any missed SL/TP leg.
const EXCHANGE_TIMEOUT_CANCEL_ORDER_MS  = 8_000   // cancel; retried next tick on failure
const EXCHANGE_TIMEOUT_PLACE_STOP_MS    = 8_000   // SL/TP placement; fast-fail + retry next tick
const EXCHANGE_TIMEOUT_GET_POSITIONS_MS = 8_000   // position fetch for adoption + sync prefetch
const EXCHANGE_TIMEOUT_GET_ORDER_MS     = 6_000   // fill detection; retry via next sync tick on miss

// ── Global SL/TP placement semaphore ────────────────────────��────────────
// 4 symbols × 2 directions × 2 stops (SL+TP) = up to 16 concurrent stop calls.
// BingX rate limiter now allows 5 concurrent requests (maxConcurrent=5).
// Limit=6 lets 6 stop calls run in parallel; ceil(16/6)=3 passes at ~5s p99
// each = ~15s total flush — vs ceil(16/3)=6 passes × 5s = ~30s at the old limit.
// Raising from 3 to 6 halves SL/TP arming latency when all symbols open simultaneously.
// EXCHANGE_TIMEOUT_PLACE_STOP_MS keeps each dispatched SL/TP HTTP call bounded.
let __stopSemCount = 0
const __STOP_SEM_LIMIT = 6
const __stopSemQueue: Array<() => void> = []
function acquireStopSem(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (__stopSemCount < __STOP_SEM_LIMIT) {
      __stopSemCount++
      resolve()
    } else {
      __stopSemQueue.push(() => { __stopSemCount++; resolve() })
    }
  })
}
function releaseStopSem(): void {
  __stopSemCount = Math.max(0, __stopSemCount - 1)
  const next = __stopSemQueue.shift()
  if (next) next()
}

/**
 * Live position as it flows through the live-stage pipeline and is
 * persisted in Redis.  This is the local definition; the external
 * definition in `position-tracker.ts` uses snake_case field names and
 * is intentionally kept separate (it represents the cached exchange API
 * shape, not the stage pipeline shape).
 */
interface LivePosition {
  id: string
  connectionId: string
  symbol: string
  side?: "long" | "short"
  direction?: "long" | "short"
  entryPrice: number
  executedQuantity: number
  remainingQuantity: number
  averageExecutionPrice: number
  volumeUsd?: number
  leverage: number
  marginType: "cross" | "isolated"
  unrealized_pnl?: number
  unrealized_pnl_percent?: number
  markPrice?: number
  liquidationPrice?: number
  realizedPnL?: number
  /** PositionCost percentage captured at entry for canonical PF-ratio history. */
  positionCostPct?: number
  /** Immutable upstream Real-stage PF snapshot used for Real↔Live comparison. */
  realProfitFactorAtEntry?: number
  timestamp?: number
  fee?: number
  feeAsset?: string
  lastUpdate?: number
  last_update?: number
  stoppedAt?: number
  updatedAt?: number
  createdAt?: number
  closedAt?: number
  realPositionId?: string
  fills: FillRecord[]
  stopLoss?: number
  takeProfit?: number
  stopLossPrice?: number
  takeProfitPrice?: number
  stopLossOrderId?: string
  takeProfitOrderId?: string
  // Epoch-ms timestamps of the last successful SL/TP placement on the venue.
  // Used by the MIN_REARM_MS cooldown to prevent repeated cancel-replace
  // storms when a position's price oscillates at the 0.25% drift boundary.
  stopLossLastArmedAt?: number
  takeProfitLastArmedAt?: number
  assignedStopLoss?: number
  assignedTakeProfit?: number
  protectionArmedQuantity?: number
  // ── Trailing stop state ────────────────────────────────────────────────
  // Written by syncLiveFromPseudo when the pseudo position's trailing machine
  // is armed. These fields make the ratcheted absolute stop price available to
  // computeDesiredProtectionPrices and checkAndForceCloseOnSltpCross so that
  // the trailing level — not the original static percentage — is used for both
  // exchange order placement and proactive force-close detection.
  //
  // trailingActive: true when the pseudo's trailing machine is armed.
  // trailingStopPrice: the latest ratcheted absolute stop price. Updated every
  //   time syncLiveFromPseudo writes a new trailing level; cleared (undefined)
  //   when trailing becomes inactive so the static stopLoss % takes over again.
  trailingActive?: boolean
  trailingStopPrice?: number
  /** Durable operator override used by the Live Trading page. Absolute prices
   * are intentional: they allow a stop above entry after a profitable move,
   * which cannot be represented by the legacy positive distance percentage.
   * The canonical reconciliation loop owns cancel/replace and ratcheting. */
  manualProtectionOverride?: {
    stopLossPrice?: number | null
    takeProfitPrice?: number | null
    trailingEnabled?: boolean
    trailingDistancePct?: number
    updatedAt: number
    source: "operator"
  }
  status?: "open" | "closed" | "filled" | "partially_filled" | "placed" | "pending_fill" | "placed_unconfirmed" | "rejected" | "cancelled" | "error" | "simulated" | "pending" | "closing" | "closing_partial"
  statusReason?: string
  executionMode?: "live" | "blocked" | "simulation"
  executionIntent?: LiveExecutionIntent
  executionBlockCode?: string
  executionBlockReason?: string
  presetId?: string
  presetIndicatorType?: string
  presetRank?: number
  presetPositionCostPct?: number
  presetProfitFactor?: number
  closeReason?: string
  closePrice?: number
  // ── Race condition prevention (Redis-backed mutation lock) ──
  // version: Incremented by Redis-guarded mutation helpers. Callers that need
  // compare-and-set semantics must use mutatePositionWithVersionCheck() so the
  // stored status/version are checked atomically before the hash is updated.
  // lockedAt/lockedBy are persisted for observability only; lock ownership is
  // enforced by live_position_lock:{connectionId}:{positionId} token keys.
  version?: number
  lockedAt?: number
  lockedBy?: string
  system_tracking_id?: string
  connection_tracking_id?: string
  submissionState?: "prepared" | "unconfirmed" | "confirmed"
  submissionAbsentConfirmations?: number
  pendingAccumulation?: {
    clientOrderId: string
    setKey: string
    parentSetKey?: string
    indicationType?: string
    axisKey?: string
    accumulatedSetKeys?: string[]
    posCountsSetRatios?: Record<string, number>
    combinedPosCounts?: boolean
    requestedQuantity: number
    positionQuantityBefore: number
    /** Cumulative quantity from this submission already applied locally. */
    appliedFilledQuantity?: number
    /** Confirmed quantity already assigned to the same Block Set before this submission. */
    blockSetQuantityBefore?: number
    orderId?: string
    submittedAt: number
    variant?: "block" | "dca" | "default" | "special"
    blockCount?: number
    blockBaseQuantity?: number
    blockConfirmedAddQuantity?: number
    blockTargetAddQuantity?: number
    blockTargetQuantity?: number
    blockBaseVolumeMultiplier?: number
    blockVolumeRatio?: number
    blockVolumeIncrementRatio?: number
    blockCalculatedVolumeMultiplier?: number
    blockScope?: "long" | "short" | "overall" | "live_row"
    blockLaneKind?: "direction" | "signal_source" | "row-live"
    blockLaneKey?: string
    blockSourceId?: string
    signalRisk?: SignalRisk
    stopLoss?: number
    takeProfit?: number
    dcaStep?: number
    dcaVolumeMultiplier?: number
    dcaTriggerDistancePct?: number
    referencePrice?: number
    absenceConfirmations?: number
  }
  /** Durable reduce-order state. A partial/unknown response is reconciled on
   * later cycles before another reduce order may be submitted. */
  pendingReduction?: {
    clientOrderId: string
    orderId?: string
    requestedQuantity: number
    targetQuantity: number
    positionQuantityBefore: number
    targetMemberKeys: string[]
    targetSetRatios?: Record<string, number>
    appliedFilledQuantity?: number
    submittedAt: number
    absenceConfirmations?: number
  }
  /** Durable system action marker. Protection reconciliation observes this and
   * cannot place a new control order while close/reduce coordination is active. */
  pendingSystemAction?: {
    token: string
    reason: string
    phase: "control_wait" | "system_submit" | "system_verify" | "partial_wait"
    startedAt: number
    updatedAt: number
    controlOrderIds?: string[]
    clientOrderId?: string
    orderId?: string
    requestedQuantity?: number
    appliedFilledQuantity?: number
    absenceConfirmations?: number
  }
  /** Durable protection-to-quantity barrier. A position-size mutation cannot
   * outlive a failed authoritative snapshot and then continue from stale size. */
  pendingQuantityMutation?: {
    token: string
    reason: string
    phase: "control_cancel" | "position_verify"
    controlOrderIds: string[]
    quantityBefore: number
    startedAt: number
    updatedAt: number
  }
  pendingProtectionOrders?: Record<string, {
    clientOrderId: string
    triggerPrice: number
    quantity: number
    absenceConfirmations?: number
  }>
  initialExecutedQuantity?: number
  initialEntryPrice?: number
  blockBaseQuantity?: number
  blockBaseVolumeMultiplier?: number
  blockVolumeRatio?: number
  blockProfitFactorRatio?: number
  blockDefaultMinimumProfitFactor?: number
  blockConfiguredMinimumProfitFactor?: number
  blockNormalProfitFactor?: number
  blockMinimumProfitFactor?: number
  blockObservedProfitFactor?: number
  blockProfitFactorDifference?: number
  blockComparisonAvailable?: boolean
  blockProfitFactorWindow?: number
  blockProfitFactorSampleCount?: number
  blockCount?: number
  blockScope?: "long" | "short" | "overall" | "live_row"
  blockLaneKind?: "direction" | "signal_source" | "row-live"
  blockLaneKey?: string
  blockSourceId?: string
  blockVolumeIncrementRatio?: number
  blockCalculatedVolumeMultiplier?: number
  /** Persisted dispatch mode so Block-only restarts retain parent semantics. */
  blockOnly?: boolean
  blockLegs?: BlockLegState[]
  dcaProfile?: DcaProfile
  dcaLegs?: DcaLegState[]
  dcaTakeProfitPrice?: number
  setKey?: string
  indicationType?: string
  signalRisk?: SignalRisk
  exchangeData?: Record<string, unknown>
  orderId?: string
  // Durable marker proving the live fill counters were already recorded for
  // this entry order. Reconcile may observe the same exchange fill via both
  // position fallback and getOrder(), and across multiple ticks/restarts; this
  // marker prevents double-counting live_orders_filled_count and the per-symbol
  // filled bucket.
  fillCounterRecordedAt?: number
  liveLockToken?: string
  connection_id?: string
  entry_price?: number
  current_price?: number
  quantity: number
  axisWindows?: { prev: number; last: number; cont: number; pause: number }
  // Variant size multiplier mirrored from RealPosition (Block uses the exact
  // target factor 1 + count × ratio; DCA=0.5; others=1). Stored for audit and
  // protection coordination; Block order deltas use the immutable base.
  sizeMultiplier?: number
  /** Special-only lane plan; same-side logical legs are exchange-netted. */
  specialPositionPlan?: SpecialPositionPlan
  /** Immutable 1x quantity used to enforce Special's total <= 3x cap. */
  specialBaseQuantity?: number
  /** Hard wall-clock exit, never later than 90 minutes after confirmed entry. */
  specialExpiresAt?: number
  parentSetKey?: string
  setVariant?: "default" | "trailing" | "block" | "dca" | "pause"
  accumulatedSetKeys?: string[]
  /** Combined position-count (axis) Set: multiple same-direction pos-count
   *  Sets merged into one directional live order. Long and Short remain
   *  independent. Member keys live in accumulatedSetKeys. */
  combinedPosCounts?: boolean
  posCountsTargetFlat?: boolean
  posCountsLongSetCount?: number
  posCountsShortSetCount?: number
  posCountsNetSetCount?: number
  /** Current authoritative open quantity distributed over exact member Sets. */
  posCountsSetQuantities?: Record<string, number>
  /** Exact same-direction Strategy-Set ratio parts in this target. */
  posCountsSetRatios?: Record<string, number>
  /** Total confirmed entry quantity over the position lifetime. */
  totalExecutedQuantity?: number
  /** Quantity already reduced by control/system/target partial executions. */
  closedQuantity?: number
  /** Bounded, idempotent partial-order audit/quantity ledger. */
  partialOrderExecutions?: PartialOrderExecution[]
  protectionMode?: "exchange_control" | "hybrid_control_system" | "system_close" | "system_close_fallback"
  /** Missing venue legs that remain protected by the engine-side price cross. */
  systemProtectionLegs?: ProtectionOrderLeg[]
  /** Last authoritative BingX control-order budget used for this position. */
  controlOrderCapacity?: ControlOrderCapacitySnapshot
  // ── Set-config propagation (Set Relations → Position Protection) ──────────
  // The originating StrategySet's trailing profile and historical performance
  // snapshot are carried into the live position so that:
  //   1. Trailing-variant positions use `trailingProfile.stopRatio` as the
  //      initial SL distance anchor rather than a generic PF-derived value
  //      (the trailing machine ratchets from this anchor, not from a flat %).
  //   2. `prevPos` provides the historical success rate and PF context that
  //      the Set was scored against, available for audit and future re-scoring.
  // Both fields ride verbatim from StrategySet → RealPosition → LivePosition
  // via the dispatch payload in `createLiveSets`.
  trailingProfile?: TrailingProfile
  /** Logical execution slot. Signal trailing is independent from default. */
  executionLane?: SignalExecutionLane
  prevPos?: { count: number; successRate: number; profitFactor: number; avgDDT: number; recentPnls?: number[] }

  progression?: { step: string; timestamp: number; success: boolean; details: string }[]
}

export function normalizeLiveTradeDirection(...values: unknown[]): "long" | "short" | null {
  for (const value of values) {
    const normalized = String(value ?? "").trim().toLowerCase()
    if (normalized === "long" || normalized === "buy") return "long"
    if (normalized === "short" || normalized === "sell") return "short"
  }
  return null
}

export function normalizeExchangePositionDirection(
  positionSide: unknown,
  side: unknown,
  signedQuantity: unknown,
): "long" | "short" | null {
  const explicit = normalizeLiveTradeDirection(positionSide, side)
  if (explicit) return explicit
  const quantity = Number(signedQuantity)
  if (!Number.isFinite(quantity) || quantity === 0) return null
  return quantity > 0 ? "long" : "short"
}

function resolveLivePositionDirection(position: Pick<LivePosition, "direction" | "side" | "exchangeData">): "long" | "short" | null {
  return normalizeLiveTradeDirection(
    position.direction,
    position.side,
    (position.exchangeData as any)?.positionSide,
    (position.exchangeData as any)?.side,
  )
}


function hasFillCounterRecorded(position: Pick<LivePosition, "fillCounterRecordedAt">): boolean {
  return Number(position.fillCounterRecordedAt || 0) > 0
}

function axisKeyFromLineage(
  setKey: string,
  axisWindows?: LivePosition["axisWindows"],
): string {
  const embedded = setKey.match(/#axis:([^#]+)/)?.[1]
  if (embedded) return embedded
  if (!axisWindows) return ""
  const outcome = String((axisWindows as any).outcome || "pos")
  const direction = String((axisWindows as any).dir || "")
  return `p${axisWindows.prev || 0}_l${axisWindows.last || 0}_c${axisWindows.cont || 0}_u${axisWindows.pause || 0}_${outcome}${direction ? `_${direction}` : ""}`
}

/**
 * Preserve the Real-stage variant on the confirmed-position ledger.
 *
 * Exact adjustment Set keys remain authoritative because a Block/DCA fill can
 * be added to a position that originally carried a trailing Base profile. For
 * the originating fill, prefer the persisted position variant and use the
 * trailing profile as a backwards-compatible recovery signal for rows written
 * before `setVariant` was durable.
 */
function resolveConfirmedStrategyVariant(
  position: Pick<LivePosition, "setVariant" | "trailingProfile">,
  setKey: string,
): RealStrategyVariant {
  const keyedVariant = inferRealStrategyVariant(setKey)
  if (keyedVariant !== "default") return keyedVariant

  const explicit = String(position.setVariant || "").trim().toLowerCase()
  if (explicit === "block" || explicit === "dca" || explicit === "trailing") {
    return explicit
  }
  if (position.trailingProfile) return "trailing"
  return "default"
}

async function recordConfirmedStrategyEntry(
  connectionId: string,
  position: LivePosition,
  entryId: string,
  lineage?: {
    setKey?: string
    parentSetKey?: string
    indicationType?: string
    axisKey?: string
    axisWindows?: LivePosition["axisWindows"]
    setKeys?: string[]
  },
): Promise<boolean> {
  const direction = resolveLivePositionDirection(position)
  if (!direction) return false
  const primarySetKey = String(lineage?.setKey || position.setKey || "").trim()
  const memberKeys = lineage
    ? [...new Set([
        primarySetKey,
        ...(lineage.setKeys || []),
      ].map(String).filter(Boolean))]
    : position.combinedPosCounts
      ? [...new Set((position.accumulatedSetKeys || []).map(String).filter(Boolean))]
      : [...new Set([
          primarySetKey,
          ...(position.accumulatedSetKeys || []),
        ].map(String).filter(Boolean))]
  if (memberKeys.length > 1 || (position.combinedPosCounts && memberKeys.length > 0)) {
    let inserted = false
    for (let index = 0; index < memberKeys.length; index++) {
      const memberSetKey = memberKeys[index]
      const isPrimary = memberSetKey === primarySetKey
      const memberInserted = await recordStrategyPositionEntry({
        connectionId,
        positionId: position.id,
        entryId: `${entryId}:member:${memberSetKey}`,
        setKey: memberSetKey,
        parentSetKey: isPrimary
          ? String(lineage?.parentSetKey || position.parentSetKey || memberSetKey.split("#")[0] || memberSetKey)
          : memberSetKey,
        symbol: position.symbol,
        indicationType: String(lineage?.indicationType || position.indicationType || memberSetKey.split(":")[1] || "unknown"),
        direction,
        axisKey: isPrimary
          ? String(lineage?.axisKey || axisKeyFromLineage(memberSetKey, lineage?.axisWindows || position.axisWindows))
          : "",
        strategyVariant: resolveConfirmedStrategyVariant(position, memberSetKey),
        countGlobalPosition: index === 0,
      })
      inserted = memberInserted || inserted
    }
    return inserted
  }
  const setKey = primarySetKey
  if (!setKey) return false
  const parentSetKey = String(
    lineage?.parentSetKey || position.parentSetKey || setKey.split("#")[0] || setKey,
  )
  const keyParts = setKey.split(":")
  const inferredType = keyParts.length >= 3 && keyParts[0] === position.symbol
    ? keyParts[1]
    : keyParts[0]
  return recordStrategyPositionEntry({
    connectionId,
    positionId: position.id,
    entryId,
    setKey,
    parentSetKey,
    symbol: position.symbol,
    indicationType: String(lineage?.indicationType || position.indicationType || inferredType || "unknown"),
    direction,
    axisKey: String(lineage?.axisKey || axisKeyFromLineage(setKey, lineage?.axisWindows || position.axisWindows)),
    strategyVariant: resolveConfirmedStrategyVariant(position, setKey),
  })
}

async function recordFillCountersOnce(
  connectionId: string,
  position: LivePosition,
  symbol: string,
  side: string,
): Promise<boolean> {
  const storedDirection = resolveLivePositionDirection(position)
  const observedDirection = normalizeLiveTradeDirection(side)
  if (
    storedDirection &&
    observedDirection &&
    storedDirection !== observedDirection
  ) {
    pushStep(
      position,
      "fill_counter_direction_guard",
      false,
      `stored=${storedDirection}; observed=${observedDirection}; counter write blocked`,
    )
    return false
  }
  const direction = storedDirection ?? observedDirection
  if (!direction) return false
  position.direction = direction
  // Entry accounting is independently idempotent. Run it even when the legacy
  // fill marker exists so pre-rollout positions are backfilled on reconcile.
  await recordConfirmedStrategyEntry(connectionId, position, `${position.id}:initial`)
  if (hasFillCounterRecorded(position)) return false

  // Mark first, before incrementing, so the same in-memory reconcile pass cannot
  // double-count if both exchange-position fallback and getOrder() observe the
  // fill. The caller persists the position in the same save batch/tick.
  position.fillCounterRecordedAt = Date.now()
  await incrementMetric(connectionId, "live_orders_filled_count")
  await incrementOrdersBySymbol(connectionId, symbol, direction, "filled")
  return true
}

function makeConnectionTrackingId(connectionId: string): string {
  return `conn-${connectionId}`
}

function makeSystemTrackingId(connectionId: string): string {
  return `sys-${connectionId}-${nanoid(10)}`
}

function isSystemTrackedLivePosition(position: Partial<LivePosition> | any, connectionId: string): boolean {
  const systemTrackingId = String(position?.system_tracking_id ?? position?.systemTrackingId ?? "").trim()
  const connectionTrackingId = String(position?.connection_tracking_id ?? position?.connectionTrackingId ?? "").trim()
  return (
    systemTrackingId.startsWith(`sys-${connectionId}-`) &&
    systemTrackingId.length > `sys-${connectionId}-`.length &&
    connectionTrackingId === makeConnectionTrackingId(connectionId)
  )
}

function isExchangeLifecyclePosition(position: Partial<LivePosition> | any, connectionId: string): boolean {
  if (!isSystemTrackedLivePosition(position, connectionId)) return false
  if (String(position?.status || "").toLowerCase() === "simulated") return false
  const status = String(position?.status || "").toLowerCase()
  const openStatus = new Set([
    "open",
    "filled",
    "partially_filled",
    "placed",
    "pending_fill",
    "placed_unconfirmed",
    "closing",
    "closing_partial",
  ])
  return openStatus.has(status) && (
    Number(position?.executedQuantity ?? position?.quantity ?? 0) > 0 ||
    status === "placed" ||
    status === "pending_fill" ||
    status === "placed_unconfirmed"
  )
}

interface FillRecord {
  id?: string
  price: number
  quantity: number
  timestamp?: number
  fee?: number
  feeAsset?: string
}

// ── Helper function stubs (defined in adjacent modules) ──────────────
// live-stage.ts calls a set of helpers that live in the trade-engine
// package.  They are declared here so TypeScript can type-check call sites
// even when the defining modules are not yet wired up.
function pushStep(position: LivePosition, step: string, ok: boolean, detail: string): void {
  try {
    if (!position.progression) position.progression = []
    position.progression.push({ step, timestamp: Date.now(), success: ok, details: detail })
    // cap progression per-position to 200 entries to avoid unbounded growth
    if (position.progression.length > 200) position.progression = position.progression.slice(-200)
  } catch {
    // non-critical
  }
}

function extractExchangeOpenQuantity(position: any): number {
  if (!position) return 0
  const raw = Number(
    position.contracts ??
    position.positionAmt ??
    position.position_amount ??
    position.quantity ??
    position.size ??
    0,
  )
  return Number.isFinite(raw) ? Math.abs(raw) : 0
}

function allocatePositionSetQuantities(
  position: Pick<LivePosition, "combinedPosCounts" | "posCountsSetRatios" | "accumulatedSetKeys" | "setKey">,
  quantity: number,
  setKeys?: string[],
): Record<string, number> {
  const keys = setKeys || position.accumulatedSetKeys || (position.setKey ? [position.setKey] : [])
  return position.combinedPosCounts
    ? allocateQuantityByRatios(quantity, position.posCountsSetRatios, keys)
    : allocateQuantityAcrossSets(quantity, keys)
}

function applyReductionObservation(
  position: LivePosition,
  input: {
    executionId: string
    source: PartialOrderExecutionSource
    status: string
    requestedQuantity: number
    reportedFilledQuantity: number
    previouslyAppliedQuantity?: number
    authoritativeQuantity?: number | null
    price?: number
    orderId?: string
    clientOrderId?: string
    setKeys?: string[]
    setRatios?: Record<string, number>
  },
): ReturnType<typeof reconcileCumulativeReduction> {
  const before = Math.max(0, Number(position.executedQuantity || 0))
  const result = reconcileCumulativeReduction(
    before,
    input.reportedFilledQuantity,
    Number(input.previouslyAppliedQuantity || 0),
    input.authoritativeQuantity,
  )
  if (!(result.deltaApplied > 0)) return result

  const closedBefore = Math.max(0, Number(position.closedQuantity || 0))
  position.totalExecutedQuantity = Math.max(
    Number(position.totalExecutedQuantity || 0),
    before + closedBefore,
    Number(position.initialExecutedQuantity || 0),
  )
  position.closedQuantity = Number((closedBefore + result.deltaApplied).toFixed(12))
  position.executedQuantity = result.nextQuantity
  position.quantity = result.nextQuantity
  position.remainingQuantity = 0
  position.volumeUsd = result.nextQuantity * Number(position.averageExecutionPrice || position.entryPrice || 0)

  const executionPrice = Number(input.price || position.markPrice || position.averageExecutionPrice || position.entryPrice || 0)
  const entryPrice = Number(position.averageExecutionPrice || position.entryPrice || 0)
  if (executionPrice > 0 && entryPrice > 0) {
    const realizedDelta = result.deltaApplied * (
      position.direction === "short"
        ? entryPrice - executionPrice
        : executionPrice - entryPrice
    )
    position.realizedPnL = Number((Number(position.realizedPnL || 0) + realizedDelta).toFixed(8))
  }

  const setKeys = Array.from(new Set(
    (input.setKeys || position.accumulatedSetKeys || (position.setKey ? [position.setKey] : []))
      .map(String)
      .filter(Boolean),
  ))
  const beforeSetKeys = Array.from(new Set([
    ...Object.keys(position.posCountsSetQuantities || {}),
    ...(position.accumulatedSetKeys || []),
    ...(position.setKey ? [position.setKey] : []),
  ].map(String).filter(Boolean)))
  const setQuantitiesBefore = position.combinedPosCounts
    ? (Object.keys(position.posCountsSetQuantities || {}).length > 0
        ? { ...(position.posCountsSetQuantities || {}) }
        : allocatePositionSetQuantities(position, before, beforeSetKeys))
    : allocateQuantityAcrossSets(before, beforeSetKeys)
  const setQuantitiesAfter = position.combinedPosCounts
    ? allocateQuantityByRatios(result.nextQuantity, input.setRatios || position.posCountsSetRatios, setKeys)
    : allocateQuantityAcrossSets(result.nextQuantity, setKeys)
  const setQuantityDeltas = Object.fromEntries(
    Array.from(new Set([...Object.keys(setQuantitiesBefore), ...Object.keys(setQuantitiesAfter)]))
      .map((setKey) => [
        setKey,
        Number(((setQuantitiesAfter[setKey] || 0) - (setQuantitiesBefore[setKey] || 0)).toFixed(12)),
      ]),
  )
  if (position.combinedPosCounts) {
    if (input.setRatios) position.posCountsSetRatios = { ...input.setRatios }
    position.posCountsSetQuantities = setQuantitiesAfter
  }
  position.partialOrderExecutions = upsertPartialOrderExecution(position.partialOrderExecutions, {
    id: input.executionId,
    source: input.source,
    orderId: input.orderId,
    clientOrderId: input.clientOrderId,
    status: input.status,
    requestedQuantity: input.requestedQuantity,
    cumulativeFilledQuantity: result.cumulativeApplied,
    appliedQuantity: result.cumulativeApplied,
    positionQuantityBefore: before + Number(input.previouslyAppliedQuantity || 0),
    positionQuantityAfter: result.nextQuantity,
    price: executionPrice,
    setKeys,
    setQuantitiesBefore,
    setQuantities: setQuantitiesAfter,
    setQuantityDeltas,
    updatedAt: Date.now(),
  })
  position.updatedAt = Date.now()
  pushStep(
    position,
    "partial_order_reconciled",
    true,
    `${input.source} ${input.orderId || input.clientOrderId || input.executionId}: ` +
      `-${result.deltaApplied} open=${result.nextQuantity}`,
  )
  return result
}

function normalizeStopLossPercent(rawStopLoss: unknown): { value: number; adjusted: boolean; reason?: string } {
  const n = Number(rawStopLoss)
  if (!Number.isFinite(n) || n <= 0) {
    return {
      value: MIN_EXCHANGE_STOP_LOSS_PERCENT,
      adjusted: true,
      reason: `missing/disabled SL normalized to minimum ${MIN_EXCHANGE_STOP_LOSS_PERCENT}%`,
    }
  }
  if (n < MIN_EXCHANGE_STOP_LOSS_PERCENT) {
    return {
      value: MIN_EXCHANGE_STOP_LOSS_PERCENT,
      adjusted: true,
      reason: `SL ${n}% below minimum ${MIN_EXCHANGE_STOP_LOSS_PERCENT}% — using minimum`,
    }
  }
  return { value: n, adjusted: false }
}

// Short crash-recovery TTL plus token-owned lease renewal: healthy long venue
// calls keep exclusivity, while a SIGKILL releases a stranded mutation slot in
// at most ten seconds instead of the previous ninety-second blind interval.
const POSITION_MUTATION_LOCK_TTL_MS = 10_000

const livePositionDurabilityGlobal = globalThis as typeof globalThis & {
  __livePositionDurabilityFingerprints?: Map<string, string>
}
const livePositionDurabilityFingerprints =
  livePositionDurabilityGlobal.__livePositionDurabilityFingerprints ??
  (livePositionDurabilityGlobal.__livePositionDurabilityFingerprints = new Map<string, string>())
const LIVE_POSITION_DURABILITY_FINGERPRINT_LIMIT = 2_048

// Paper positions can be numerous because every independent strategy set is
// allowed to remain open until its own terminal condition. Persisting their
// mark price on every 200ms LivePositions tick used to turn one unchanged
// lifecycle into hundreds of complete Redis/index writes per second. Keep the
// close path synchronous and durable, but coalesce display-only mark snapshots
// to one write per second per position. The current price is still read on
// every sweep, so TP/SL and max-hold decisions never wait for this cadence.
const SIMULATED_MARK_PERSIST_INTERVAL_MS = 1_000
const SIMULATED_POSITION_PROCESS_CONCURRENCY = 12
// A large Paper book can contain hundreds of independently managed rows.
// Reading and closing every row on each 200–280 ms LivePositions tick makes
// an otherwise healthy server spend its entire event loop in lifecycle scans.
// Keep the positions in their own short-lived Stage read model and rotate a
// bounded, fair row slice on every tick. A row can therefore never disappear
// from management: it is revisited within one bounded sweep, while new/closed
// rows update the Stage cache immediately through savePosition().
const SIMULATED_POSITION_STAGE_BATCH_SIZE = 96
const SIMULATED_POSITION_STAGE_BATCH_MAX = 256
const SIMULATED_POSITION_STAGE_CACHE_MS = 1_000
const SIMULATED_POSITION_STAGE_CACHE_MAX_CONNECTIONS = 64
const SIMULATED_MARK_PERSISTENCE_LIMIT = 8_192
const livePositionRuntimeGlobal = globalThis as typeof globalThis & {
  __simulatedPositionMarkPersistedAt?: Map<string, number>
  __simulatedPositionStages?: Map<string, {
    positions: LivePosition[]
    cursor: number
    expiresAt: number
  }>
}
const simulatedPositionMarkPersistedAt =
  livePositionRuntimeGlobal.__simulatedPositionMarkPersistedAt ??
  (livePositionRuntimeGlobal.__simulatedPositionMarkPersistedAt = new Map<string, number>())
const simulatedPositionStages =
  livePositionRuntimeGlobal.__simulatedPositionStages ??
  (livePositionRuntimeGlobal.__simulatedPositionStages = new Map())

function trimSimulatedPositionStages(): void {
  while (simulatedPositionStages.size > SIMULATED_POSITION_STAGE_CACHE_MAX_CONNECTIONS) {
    const oldest = simulatedPositionStages.keys().next().value
    if (!oldest) return
    simulatedPositionStages.delete(oldest)
  }
}

async function getSimulatedPositionStageRows(connectionId: string): Promise<LivePosition[]> {
  const cached = simulatedPositionStages.get(connectionId)
  if (cached && cached.expiresAt > Date.now()) return cached.positions

  const positions = await getLivePositions(connectionId)
  simulatedPositionStages.set(connectionId, {
    positions,
    cursor: cached?.cursor || 0,
    expiresAt: Date.now() + SIMULATED_POSITION_STAGE_CACHE_MS,
  })
  trimSimulatedPositionStages()
  return positions
}

function updateSimulatedPositionStageRow(position: LivePosition): void {
  const stage = simulatedPositionStages.get(position.connectionId)
  if (!stage) return
  const terminal = new Set(["closed", "rejected", "cancelled", "canceled", "error"])
  const index = stage.positions.findIndex((candidate: LivePosition) => candidate.id === position.id)
  if (terminal.has(String(position.status || "").toLowerCase())) {
    if (index >= 0) stage.positions.splice(index, 1)
  } else if (index >= 0) {
    stage.positions[index] = position
  } else {
    stage.positions.unshift(position)
  }
  stage.cursor = stage.positions.length > 0 ? stage.cursor % stage.positions.length : 0
  stage.expiresAt = Date.now() + SIMULATED_POSITION_STAGE_CACHE_MS
}

function selectSimulatedPositionStageRows(
  connectionId: string,
  positions: readonly LivePosition[],
): LivePosition[] {
  if (positions.length <= SIMULATED_POSITION_STAGE_BATCH_SIZE) return [...positions]

  const limit = concurrencyFromEnv(
    ["SIMULATED_POSITION_STAGE_BATCH_SIZE"],
    SIMULATED_POSITION_STAGE_BATCH_SIZE,
    SIMULATED_POSITION_STAGE_BATCH_MAX,
    positions.length,
  )
  const stage = simulatedPositionStages.get(connectionId)
  const cursor = Math.max(0, Number(stage?.cursor || 0)) % positions.length
  const rows = Array.from({ length: limit }, (_, offset) => positions[(cursor + offset) % positions.length])
  if (stage) stage.cursor = (cursor + rows.length) % positions.length
  return rows
}

function simulatedPositionPersistenceKey(position: Pick<LivePosition, "connectionId" | "id">): string {
  return `${position.connectionId}:${position.id}`
}

function shouldPersistSimulatedMark(
  position: Pick<LivePosition, "connectionId" | "id">,
  previousMark: number,
  currentMark: number,
  now: number,
): boolean {
  if (!Number.isFinite(currentMark) || currentMark <= 0) return false
  const epsilon = previousMark > 0 ? Math.max(previousMark * 1e-6, 1e-9) : 0
  if (previousMark > 0 && Math.abs(currentMark - previousMark) <= epsilon) return false
  const key = simulatedPositionPersistenceKey(position)
  const lastPersistedAt = simulatedPositionMarkPersistedAt.get(key) || 0
  return now - lastPersistedAt >= SIMULATED_MARK_PERSIST_INTERVAL_MS
}

function markSimulatedMarkPersisted(position: Pick<LivePosition, "connectionId" | "id">, now: number): void {
  const key = simulatedPositionPersistenceKey(position)
  if (
    simulatedPositionMarkPersistedAt.size >= SIMULATED_MARK_PERSISTENCE_LIMIT &&
    !simulatedPositionMarkPersistedAt.has(key)
  ) {
    const oldest = simulatedPositionMarkPersistedAt.keys().next().value
    if (oldest) simulatedPositionMarkPersistedAt.delete(oldest)
  }
  simulatedPositionMarkPersistedAt.set(key, now)
}

function clearSimulatedMarkPersistence(position: Pick<LivePosition, "connectionId" | "id">): void {
  simulatedPositionMarkPersistedAt.delete(simulatedPositionPersistenceKey(position))
}

function positionHashKey(connectionId: string, positionId: string): string {
  return `live_positions:${connectionId}:${positionId}`
}

function livePositionSlotIndexKey(
  connectionId: string,
  symbol: string,
  direction: string,
  executionSlot: string,
): string {
  const normalizedSymbol = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
  const normalizedDirection = String(direction || "").toLowerCase()
  const normalizedSlot = String(executionSlot || "default").replace(/[^A-Za-z0-9._-]/g, "_") || "default"
  return `live:position-slot:${connectionId}:${normalizedSymbol}:${normalizedDirection}:${normalizedSlot}`
}

function isActiveLiveSlotStatus(status: unknown): boolean {
  return [
    "pending",
    "open",
    "filled",
    "partially_filled",
    "placed",
    "pending_fill",
    "placed_unconfirmed",
    "simulated",
  ].includes(String(status || "").toLowerCase())
}

function matchesLiveSlot(
  position: LivePosition,
  symbol: string,
  direction: string,
  executionSlot: string,
): boolean {
  const normalizedSymbol = String(symbol || "").toUpperCase().replace(/[-_]/g, "")
  return (
    String(position.symbol || "").toUpperCase().replace(/[-_]/g, "") === normalizedSymbol &&
    position.direction === direction &&
    liveExecutionSlot(position) === executionSlot &&
    isActiveLiveSlotStatus(position.status)
  )
}

function livePositionDurabilityFingerprint(position: LivePosition): string {
  const accumulated = position.accumulatedSetKeys || []
  const fills = position.fills || []
  const blockLegs = position.blockLegs || []
  const dcaLegs = position.dcaLegs || []
  const partials = position.partialOrderExecutions || []
  const latestBlock = blockLegs[blockLegs.length - 1]
  const latestDca = dcaLegs[dcaLegs.length - 1]
  const latestPartial = partials[partials.length - 1]
  return [
    String(position.status || ""),
    Number(position.quantity || 0),
    Number(position.executedQuantity || 0),
    Number(position.totalExecutedQuantity || 0),
    Number(position.closedQuantity || 0),
    Number(position.remainingQuantity || 0),
    accumulated.length,
    String(accumulated[accumulated.length - 1] || ""),
    fills.length,
    blockLegs.length,
    latestBlock ? JSON.stringify(latestBlock) : "",
    dcaLegs.length,
    latestDca ? JSON.stringify(latestDca) : "",
    partials.length,
    latestPartial ? JSON.stringify(latestPartial) : "",
    position.pendingAccumulation ? JSON.stringify(position.pendingAccumulation) : "",
    position.pendingReduction ? JSON.stringify(position.pendingReduction) : "",
    position.pendingSystemAction ? JSON.stringify(position.pendingSystemAction) : "",
    position.pendingQuantityMutation ? JSON.stringify(position.pendingQuantityMutation) : "",
  ].join("|")
}

async function persistLivePositionCheckpointIfChanged(position: LivePosition): Promise<void> {
  const fingerprint = livePositionDurabilityFingerprint(position)
  const key = `${position.connectionId}:${position.id}`
  if (livePositionDurabilityFingerprints.get(key) === fingerprint) return

  livePositionDurabilityFingerprints.set(key, fingerprint)
  if (livePositionDurabilityFingerprints.size > LIVE_POSITION_DURABILITY_FINGERPRINT_LIMIT) {
    const oldest = livePositionDurabilityFingerprints.keys().next().value
    if (oldest) livePositionDurabilityFingerprints.delete(oldest)
  }

  const { persistLivePositionCheckpoint } = await import("@/lib/redis-db")
  const persisted = await persistLivePositionCheckpoint(position as unknown as Record<string, unknown>)
  if (persisted) return

  if (livePositionDurabilityFingerprints.get(key) === fingerprint) {
    livePositionDurabilityFingerprints.delete(key)
  }
  logRuntimeWarning(
    `live-position:${position.connectionId}:wal-failed`,
    60_000,
    `${LOG_PREFIX} Could not persist the live-position recovery checkpoint for ${position.id}`,
  )
  throw new Error(`Live-position recovery checkpoint failed for ${position.id}`)
}

function positionMutationLockKey(connectionId: string, positionId: string): string {
  return `live_position_lock:${connectionId}:${positionId}`
}

function redisHashValue(value: unknown): string {
  if (value === undefined) return ""
  if (value === null) return ""
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function positionToRedisHash(position: LivePosition): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const [key, value] of Object.entries(position)) {
    if (value !== undefined) fields[key] = redisHashValue(value)
  }
  return fields
}

function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

function parseRedisBoolean(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  if (typeof raw === "boolean") return raw
  const normalized = String(raw).trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return undefined
}

function parseRedisFiniteNumber(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function parseRedisHashPosition(hash: Record<string, any>): LivePosition {
  const position = {
    ...hash,
    entryPrice: Number(hash.entryPrice || hash.entry_price || 0),
    executedQuantity: Number(hash.executedQuantity || 0),
    remainingQuantity: Number(hash.remainingQuantity || 0),
    averageExecutionPrice: Number(hash.averageExecutionPrice || hash.entryPrice || hash.entry_price || 0),
    quantity: Number(hash.quantity || hash.executedQuantity || 0),
    leverage: Number(hash.leverage || 1),
    version: Number(hash.version || 0),
    createdAt: Number(hash.createdAt || 0),
    updatedAt: Number(hash.updatedAt || 0),
    closedAt: Number(hash.closedAt || 0) || undefined,
    // Zero is an authoritative exchange result, not an absent value. Keeping
    // it through a Redis restart prevents reporting routes from recomputing a
    // synthetic mark-to-market PnL over the venue's settled zero.
    realizedPnL: parseRedisFiniteNumber(hash.realizedPnL ?? hash.realized_pnl),
    unrealized_pnl: parseRedisFiniteNumber(hash.unrealized_pnl),
    unrealized_pnl_percent: parseRedisFiniteNumber(hash.unrealized_pnl_percent),
    fills: Array.isArray(hash.fills) ? hash.fills : safeJsonParse<FillRecord[]>(hash.fills, []),
    progression: Array.isArray(hash.progression) ? hash.progression : safeJsonParse<any[]>(hash.progression, []),
    exchangeData: typeof hash.exchangeData === "string" ? safeJsonParse<Record<string, unknown>>(hash.exchangeData, {}) : hash.exchangeData,
    ...(hash.signalRisk !== undefined && {
      signalRisk: typeof hash.signalRisk === "string"
        ? normalizeSignalRisk(safeJsonParse<unknown>(hash.signalRisk, undefined))
        : normalizeSignalRisk(hash.signalRisk),
    }),
    ...(hash.blockLegs !== undefined && {
      blockLegs: Array.isArray(hash.blockLegs)
        ? hash.blockLegs
        : safeJsonParse<BlockLegState[]>(hash.blockLegs, []),
    }),
    ...(hash.dcaProfile !== undefined && {
      dcaProfile: typeof hash.dcaProfile === "string"
        ? safeJsonParse<DcaProfile | undefined>(hash.dcaProfile, undefined)
        : hash.dcaProfile,
    }),
    ...(hash.dcaLegs !== undefined && {
      dcaLegs: Array.isArray(hash.dcaLegs)
        ? hash.dcaLegs
        : safeJsonParse<DcaLegState[]>(hash.dcaLegs, []),
    }),
    ...(hash.axisWindows !== undefined && {
      axisWindows: typeof hash.axisWindows === "string"
        ? safeJsonParse<LivePosition["axisWindows"]>(hash.axisWindows, undefined)
        : hash.axisWindows,
    }),
    ...(hash.trailingProfile !== undefined && {
      trailingProfile: typeof hash.trailingProfile === "string"
        ? safeJsonParse<LivePosition["trailingProfile"]>(hash.trailingProfile, undefined)
        : hash.trailingProfile,
    }),
    ...(hash.specialPositionPlan !== undefined && {
      specialPositionPlan: typeof hash.specialPositionPlan === "string"
        ? safeJsonParse<LivePosition["specialPositionPlan"]>(hash.specialPositionPlan, undefined)
        : hash.specialPositionPlan,
    }),
    ...(hash.prevPos !== undefined && {
      prevPos: typeof hash.prevPos === "string"
        ? safeJsonParse<LivePosition["prevPos"]>(hash.prevPos, undefined)
        : hash.prevPos,
    }),
    ...(parseRedisBoolean(hash.combinedPosCounts) !== undefined && {
      combinedPosCounts: parseRedisBoolean(hash.combinedPosCounts),
    }),
    ...(parseRedisBoolean(hash.posCountsTargetFlat) !== undefined && {
      posCountsTargetFlat: parseRedisBoolean(hash.posCountsTargetFlat),
    }),
    ...(parseRedisBoolean(hash.blockComparisonAvailable) !== undefined && {
      blockComparisonAvailable: parseRedisBoolean(hash.blockComparisonAvailable),
    }),
    ...(parseRedisBoolean(hash.blockOnly) !== undefined && {
      blockOnly: parseRedisBoolean(hash.blockOnly),
    }),
    ...(parseRedisBoolean(hash.trailingActive) !== undefined && {
      trailingActive: parseRedisBoolean(hash.trailingActive),
    }),
    accumulatedSetKeys: Array.isArray(hash.accumulatedSetKeys)
      ? hash.accumulatedSetKeys
      : safeJsonParse<string[]>(hash.accumulatedSetKeys, []),
    pendingAccumulation: typeof hash.pendingAccumulation === "string"
      ? safeJsonParse<LivePosition["pendingAccumulation"]>(hash.pendingAccumulation, undefined)
      : hash.pendingAccumulation,
    pendingReduction: typeof hash.pendingReduction === "string"
      ? safeJsonParse<LivePosition["pendingReduction"]>(hash.pendingReduction, undefined)
      : hash.pendingReduction,
    pendingSystemAction: typeof hash.pendingSystemAction === "string"
      ? safeJsonParse<LivePosition["pendingSystemAction"]>(hash.pendingSystemAction, undefined)
      : hash.pendingSystemAction,
    pendingQuantityMutation: typeof hash.pendingQuantityMutation === "string"
      ? safeJsonParse<LivePosition["pendingQuantityMutation"]>(hash.pendingQuantityMutation, undefined)
      : hash.pendingQuantityMutation,
    pendingProtectionOrders: typeof hash.pendingProtectionOrders === "string"
      ? safeJsonParse<LivePosition["pendingProtectionOrders"]>(hash.pendingProtectionOrders, undefined)
      : hash.pendingProtectionOrders,
    manualProtectionOverride: typeof hash.manualProtectionOverride === "string"
      ? safeJsonParse<LivePosition["manualProtectionOverride"]>(hash.manualProtectionOverride, undefined)
      : hash.manualProtectionOverride,
    systemProtectionLegs: Array.isArray(hash.systemProtectionLegs)
      ? hash.systemProtectionLegs
      : safeJsonParse<ProtectionOrderLeg[]>(hash.systemProtectionLegs, []),
    controlOrderCapacity: typeof hash.controlOrderCapacity === "string"
      ? safeJsonParse<ControlOrderCapacitySnapshot | undefined>(hash.controlOrderCapacity, undefined)
      : hash.controlOrderCapacity,
    posCountsSetQuantities: typeof hash.posCountsSetQuantities === "string"
      ? safeJsonParse<Record<string, number>>(hash.posCountsSetQuantities, {})
      : hash.posCountsSetQuantities,
    posCountsSetRatios: typeof hash.posCountsSetRatios === "string"
      ? safeJsonParse<Record<string, number>>(hash.posCountsSetRatios, {})
      : hash.posCountsSetRatios,
    partialOrderExecutions: Array.isArray(hash.partialOrderExecutions)
      ? hash.partialOrderExecutions
      : safeJsonParse<PartialOrderExecution[]>(hash.partialOrderExecutions, []),
  } as Record<string, any>

  // node-redis returns every hash scalar as a string. Keep the canonical hash
  // usable without its JSON mirror after SIGKILL by restoring every numeric
  // LivePosition field at this single hydration boundary. Leaving even one of
  // the percentage/quantity/PF fields as a string makes arithmetic and strict
  // comparison dependent on JavaScript coercion after restart.
  for (const field of [
    "entryPrice",
    "entry_price",
    "executedQuantity",
    "remainingQuantity",
    "averageExecutionPrice",
    "quantity",
    "volumeUsd",
    "leverage",
    "unrealized_pnl",
    "unrealized_pnl_percent",
    "markPrice",
    "current_price",
    "liquidationPrice",
    "realizedPnL",
    "realized_pnl",
    "positionCostPct",
    "specialBaseQuantity",
    "specialExpiresAt",
    "timestamp",
    "fee",
    "lastUpdate",
    "last_update",
    "stoppedAt",
    "updatedAt",
    "createdAt",
    "closedAt",
    "stopLoss",
    "takeProfit",
    "stopLossPrice",
    "takeProfitPrice",
    "stopLossLastArmedAt",
    "takeProfitLastArmedAt",
    "assignedStopLoss",
    "assignedTakeProfit",
    "protectionArmedQuantity",
    "trailingStopPrice",
    "presetRank",
    "presetPositionCostPct",
    "presetProfitFactor",
    "closePrice",
    "version",
    "lockedAt",
    "submissionAbsentConfirmations",
    "initialExecutedQuantity",
    "initialEntryPrice",
    "blockBaseQuantity",
    "blockBaseVolumeMultiplier",
    "blockVolumeRatio",
    "blockProfitFactorRatio",
    "blockDefaultMinimumProfitFactor",
    "blockConfiguredMinimumProfitFactor",
    "blockNormalProfitFactor",
    "blockMinimumProfitFactor",
    "blockObservedProfitFactor",
    "blockProfitFactorDifference",
    "blockProfitFactorWindow",
    "blockProfitFactorSampleCount",
    "blockCount",
    "blockVolumeIncrementRatio",
    "blockCalculatedVolumeMultiplier",
    "dcaTakeProfitPrice",
    "fillCounterRecordedAt",
    "sizeMultiplier",
    "posCountsLongSetCount",
    "posCountsShortSetCount",
    "posCountsNetSetCount",
    "totalExecutedQuantity",
    "closedQuantity",
  ]) {
    const value = parseRedisFiniteNumber(hash[field])
    if (value !== undefined) position[field] = value
    else if (hash[field] !== undefined && hash[field] !== null && hash[field] !== "") {
      delete position[field]
    }
  }

  return position as LivePosition
}

function mergeLivePositionSnapshotSources(
  legacyRaw: unknown,
  hash: Record<string, unknown> | null | undefined,
): LivePosition | null {
  let legacy: LivePosition | null = null
  if (legacyRaw) {
    try {
      legacy = typeof legacyRaw === "string"
        ? JSON.parse(legacyRaw) as LivePosition
        : legacyRaw as LivePosition
    } catch { /* malformed legacy mirror */ }
  }
  const hashPosition = hash && Object.keys(hash).length > 0
    ? parseRedisHashPosition(hash)
    : null
  if (!legacy) return hashPosition
  if (!hashPosition) return legacy

  // Atomic status/version transitions land in the hash first. A crash between
  // that transition and the JSON mirror used to make readers return the stale
  // JSON snapshot (often `open`) and ignore a newer hash (`closing`/`closed`).
  // Merge the newer source over the older so auxiliary fields survive while
  // the authoritative lifecycle/version can never regress after restart.
  const hashIsNewer =
    Number(hashPosition.version || 0) > Number(legacy.version || 0) ||
    Number(hashPosition.updatedAt || 0) > Number(legacy.updatedAt || 0)
  return hashIsNewer
    ? { ...legacy, ...hashPosition }
    : { ...hashPosition, ...legacy }
}

async function readLivePositionSnapshot(client: any, connectionId: string, positionId: string): Promise<LivePosition | null> {
  const [legacyRaw, hash] = await Promise.all([
    client.get(`live:position:${positionId}`).catch(() => null),
    client.hgetall(positionHashKey(connectionId, positionId)).catch(() => null),
  ])
  return mergeLivePositionSnapshotSources(legacyRaw, hash)
}

async function evalRedis(client: any, script: string, keys: string[], args: string[]): Promise<any> {
  if (typeof client.eval === "function") {
    try {
      return await client.eval(script, { keys, arguments: args })
    } catch {
      return await client.eval(script, keys.length, ...keys, ...args)
    }
  }

  // InlineLocalRedis / minimal test clients may not expose EVAL. Preserve the
  // two token/version semantics this file needs so production fallback audits
  // do not crash while still failing closed on mismatched ownership/state.
  if (script.includes('redis.call("GET", KEYS[1])') && script.includes('redis.call("DEL", KEYS[1])')) {
    const current = typeof client.get === "function" ? await client.get(keys[0]) : null
    if (current !== args[0]) return 0
    return typeof client.del === "function" ? await client.del(keys[0]) : 0
  }

  if (script.includes('redis.call("HGET", KEYS[1], "version")') && script.includes('redis.call("HSET", KEYS[1]')) {
    const hash = typeof client.hgetall === "function" ? await client.hgetall(keys[0]).catch(() => null) : null
    if (!hash || Object.keys(hash).length === 0) return 0
    const currentVersion = String(hash.version ?? "0")
    const currentStatus = String(hash.status ?? "")
    if (currentVersion !== args[0]) return 0
    let allowed: string[] = []
    try { allowed = JSON.parse(args[1]) } catch { allowed = [] }
    if (!allowed.includes(currentStatus)) return 0
    const fields: Record<string, string> = {}
    for (let i = 3; i < args.length; i += 2) {
      const field = args[i]
      const value = args[i + 1]
      if (field !== undefined && value !== undefined) fields[field] = value
    }
    if (Object.keys(fields).length === 0) return 0
    await client.hset(keys[0], fields)
    return 1
  }

  throw new Error("Redis client does not support EVAL")
}

type SignalCapacityReservation =
  | { state: "reserved"; capacity: SignalPositionCapacity }
  | { state: "existing"; capacity: SignalPositionCapacity; existing: LivePosition }
  | { state: "limit"; capacity: SignalPositionCapacity }
  | { state: "busy"; capacity: SignalPositionCapacity }

function signalCapacityKey(connectionId: string): string {
  return `signal:position_capacity:${connectionId}`
}

// The admission path runs for every independently coordinated Signal source,
// TP/SL profile and trailing lane. Reading and hydrating the complete shared
// live-position book for every candidate made a 350-position Paper book grow
// quadratically. Keep a compact authoritative membership index instead. It is
// rebuilt once from the complete canonical book after an upgrade or legacy
// snapshot restore.
const SIGNAL_POSITION_ADMISSION_INDEX_VERSION = "1"

function signalPositionAdmissionIndexKey(connectionId: string): string {
  return `signal:positions:${connectionId}`
}

function signalPositionAdmissionDirectionIndexKey(
  connectionId: string,
  direction: "long" | "short",
): string {
  return `${signalPositionAdmissionIndexKey(connectionId)}:${direction}`
}

function signalPositionAdmissionIndexReadyKey(connectionId: string): string {
  return `signal:positions:${connectionId}:index-version`
}

function signalAdmissionLockKey(connectionId: string): string {
  return `signal:position_admission:${connectionId}`
}

function shouldEmitSignalCapacityNotice(connectionId: string, now = Date.now()): boolean {
  const previous = signalCapacityNoticeAt.get(connectionId) || 0
  if (now - previous < SIGNAL_CAPACITY_NOTICE_INTERVAL_MS) return false
  if (
    signalCapacityNoticeAt.size >= SIGNAL_CAPACITY_NOTICE_MAX_CONNECTIONS &&
    !signalCapacityNoticeAt.has(connectionId)
  ) {
    const oldest = signalCapacityNoticeAt.keys().next().value
    if (oldest) signalCapacityNoticeAt.delete(oldest)
  }
  signalCapacityNoticeAt.set(connectionId, now)
  return true
}

function parseSignalCapacitySnapshot(
  raw: Record<string, unknown> | null | undefined,
  fallbackLimit: number,
): SignalPositionCapacity {
  const total = Math.max(0, Number(raw?.total) || 0)
  const long = Math.max(0, Number(raw?.long) || 0)
  const short = Math.max(0, Number(raw?.short) || 0)
  const limit = normalizeSignalMaxPositions(Number(raw?.limit) || fallbackLimit)
  return {
    allowed: total < limit,
    reason: total < limit ? "available" : "total_limit",
    total,
    long,
    short,
    limit,
  }
}

async function readPositionsForSignalAdmission(
  client: any,
  connectionId: string,
): Promise<LivePosition[]> {
  // Upgrade/recovery fallback only: capacity is connection-wide and this
  // initial rebuild must read the complete canonical book, never a sampled
  // prefix. The normal admission hot path uses the membership index below.
  const rawIds = (await client.lrange(`live:positions:${connectionId}`, 0, -1)) || []
  const ids = [...new Set((rawIds as unknown[]).map(String).filter(Boolean))]
  if (ids.length === 0) return []

  let rows: unknown[] = []
  const READ_BATCH_SIZE = 250
  if (typeof client.pipeline === "function") {
    for (let offset = 0; offset < ids.length; offset += READ_BATCH_SIZE) {
      const pipeline = client.pipeline()
      for (const id of ids.slice(offset, offset + READ_BATCH_SIZE)) {
        pipeline.get(`live:position:${id}`)
        pipeline.hgetall(positionHashKey(connectionId, id))
      }
      rows.push(...((await pipeline.exec()) || []))
    }
  } else {
    // Some supported adapters expose the Redis primitives without a pipeline
    // builder. Keep their fallback bounded so one large open-position index
    // cannot allocate thousands of simultaneous promises.
    const FALLBACK_BATCH_SIZE = 32
    for (let offset = 0; offset < ids.length; offset += FALLBACK_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + FALLBACK_BATCH_SIZE)
      const batchRows = await Promise.all(
        batch.flatMap((id) => [
          client.get(`live:position:${id}`).catch(() => null),
          client.hgetall(positionHashKey(connectionId, id)).catch(() => null),
        ]),
      )
      rows.push(...batchRows)
    }
  }

  const positions: LivePosition[] = []
  for (let index = 0; index < ids.length; index++) {
    const normalize = (value: unknown) => {
      if (value instanceof Error) return null
      return Array.isArray(value) ? value[1] : value
    }
    const legacyRaw = normalize(rows?.[index * 2])
    const hash = normalize(rows?.[index * 2 + 1])
    const position = mergeLivePositionSnapshotSources(
      legacyRaw,
      hash && typeof hash === "object"
        ? hash as Record<string, unknown>
        : null,
    )
    if (position) positions.push(position)
  }
  return positions
}

async function keepSignalAdmissionIndexesDurable(client: any, connectionId: string): Promise<void> {
  const keys = [
    signalPositionAdmissionIndexKey(connectionId),
    signalPositionAdmissionDirectionIndexKey(connectionId, "long"),
    signalPositionAdmissionDirectionIndexKey(connectionId, "short"),
    signalPositionAdmissionIndexReadyKey(connectionId),
  ]
  await Promise.all(keys.map(async (key) => {
    if (typeof client.persist === "function") {
      await client.persist(key).catch(() => 0)
    } else {
      await client.expire(key, 30 * 24 * 60 * 60).catch(() => 0)
    }
  }))
}

async function updateSignalAdmissionIndexes(client: any, position: LivePosition): Promise<void> {
  const indexKey = signalPositionAdmissionIndexKey(position.connectionId)
  const longKey = signalPositionAdmissionDirectionIndexKey(position.connectionId, "long")
  const shortKey = signalPositionAdmissionDirectionIndexKey(position.connectionId, "short")
  const activeSignal = isActiveSignalPosition(position as unknown as Record<string, unknown>)
  const direction = resolveLivePositionDirection(position)

  if (!activeSignal || !direction) {
    await Promise.all([
      client.srem(indexKey, position.id).catch(() => 0),
      client.srem(longKey, position.id).catch(() => 0),
      client.srem(shortKey, position.id).catch(() => 0),
    ])
    return
  }

  const ownDirectionKey = signalPositionAdmissionDirectionIndexKey(position.connectionId, direction)
  const otherDirectionKey = signalPositionAdmissionDirectionIndexKey(
    position.connectionId,
    direction === "long" ? "short" : "long",
  )
  await Promise.all([
    client.sadd(indexKey, position.id),
    client.sadd(ownDirectionKey, position.id),
    client.srem(otherDirectionKey, position.id).catch(() => 0),
  ])
  await keepSignalAdmissionIndexesDurable(client, position.connectionId)
}

async function rebuildSignalAdmissionIndexes(
  client: any,
  connectionId: string,
): Promise<SignalPositionCapacity> {
  const positions = await readPositionsForSignalAdmission(client, connectionId)
  const active = positions.filter((position) =>
    isActiveSignalPosition(position as unknown as Record<string, unknown>) &&
    (position.direction === "long" || position.direction === "short"),
  )
  const indexKey = signalPositionAdmissionIndexKey(connectionId)
  const longKey = signalPositionAdmissionDirectionIndexKey(connectionId, "long")
  const shortKey = signalPositionAdmissionDirectionIndexKey(connectionId, "short")
  const activeIds = new Set(active.map((position) => position.id))
  const [indexedIds, indexedLongIds, indexedShortIds] = await Promise.all([
    client.smembers(indexKey).catch(() => [] as string[]),
    client.smembers(longKey).catch(() => [] as string[]),
    client.smembers(shortKey).catch(() => [] as string[]),
  ])
  const staleIds = Array.from(new Set([
    ...indexedIds,
    ...indexedLongIds,
    ...indexedShortIds,
  ].map(String).filter((id) => !activeIds.has(id))))
  if (staleIds.length > 0) {
    await Promise.all([
      client.srem(indexKey, ...staleIds).catch(() => 0),
      client.srem(longKey, ...staleIds).catch(() => 0),
      client.srem(shortKey, ...staleIds).catch(() => 0),
    ])
  }
  const longIds = active.filter((position) => position.direction === "long").map((position) => position.id)
  const shortIds = active.filter((position) => position.direction === "short").map((position) => position.id)
  if (activeIds.size > 0) await client.sadd(indexKey, ...activeIds)
  if (longIds.length > 0) await client.sadd(longKey, ...longIds)
  if (shortIds.length > 0) await client.sadd(shortKey, ...shortIds)
  await client.set(
    signalPositionAdmissionIndexReadyKey(connectionId),
    SIGNAL_POSITION_ADMISSION_INDEX_VERSION,
  )
  await keepSignalAdmissionIndexesDurable(client, connectionId)
  return evaluateSignalPositionCapacity(
    active as unknown as ReadonlyArray<Record<string, unknown>>,
    "long",
    Number.MAX_SAFE_INTEGER,
  )
}

async function readSignalAdmissionCapacity(
  client: any,
  connectionId: string,
  configuredLimit: number,
): Promise<SignalPositionCapacity> {
  const ready = await client.get(signalPositionAdmissionIndexReadyKey(connectionId)).catch(() => null)
  if (ready !== SIGNAL_POSITION_ADMISSION_INDEX_VERSION) {
    const rebuilt = await rebuildSignalAdmissionIndexes(client, connectionId)
    const limit = normalizeSignalMaxPositions(configuredLimit)
    return {
      ...rebuilt,
      limit,
      allowed: rebuilt.total < limit,
      reason: rebuilt.total < limit ? "available" : "total_limit",
    }
  }

  const [total, long, short] = await Promise.all([
    client.scard(signalPositionAdmissionIndexKey(connectionId)).catch(() => 0),
    client.scard(signalPositionAdmissionDirectionIndexKey(connectionId, "long")).catch(() => 0),
    client.scard(signalPositionAdmissionDirectionIndexKey(connectionId, "short")).catch(() => 0),
  ])
  const limit = normalizeSignalMaxPositions(configuredLimit)
  const normalizedTotal = Math.max(0, Number(total) || 0)
  return {
    allowed: normalizedTotal < limit,
    reason: normalizedTotal < limit ? "available" : "total_limit",
    total: normalizedTotal,
    long: Math.max(0, Number(long) || 0),
    short: Math.max(0, Number(short) || 0),
    limit,
  }
}

async function persistSignalCapacitySnapshot(
  client: any,
  connectionId: string,
  capacity: SignalPositionCapacity,
  selectionMode: string,
  state: SignalCapacityReservation["state"],
): Promise<void> {
  const key = signalCapacityKey(connectionId)
  await client.hset(key, {
    total: String(capacity.total),
    long: String(capacity.long),
    short: String(capacity.short),
    limit: String(capacity.limit),
    remaining: String(Math.max(0, capacity.limit - capacity.total)),
    selection_mode: selectionMode,
    state,
    updated_at: new Date().toISOString(),
  })
  await client.expire(key, 24 * 60 * 60).catch(() => 0)
}

/**
 * Reserve one physical Signal position under a short connection-wide lease.
 *
 * The pending LivePosition is inserted into the canonical open index before
 * the lease is released, so another worker sees it in its authoritative count.
 * The lease expires automatically after a crash; later terminal writes remove
 * the reservation through savePosition's normal open→closed transition.
 */
async function reserveSignalPositionCapacity(
  connectionId: string,
  candidate: LivePosition,
  configuredLimit: number,
  selectionMode: string,
): Promise<SignalCapacityReservation> {
  const client = getRedisClient()
  const candidateDirection = candidate.direction
  if (candidateDirection !== "long" && candidateDirection !== "short") {
    return {
      state: "limit",
      capacity: {
        allowed: false,
        reason: "invalid_direction",
        total: 0,
        long: 0,
        short: 0,
        limit: normalizeSignalMaxPositions(configuredLimit),
      },
    }
  }
  const lockKey = signalAdmissionLockKey(connectionId)
  const token = `signal-admission:${Date.now()}:${nanoid(8)}`
  const deadline = Date.now() + SIGNAL_ADMISSION_WAIT_MS
  let acquired = false

  while (!acquired && Date.now() < deadline) {
    const result = await client.set(lockKey, token, {
      NX: true,
      PX: SIGNAL_ADMISSION_LOCK_TTL_MS,
    } as any)
    acquired = result === "OK" || (result as any) === true
    if (!acquired) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 40)
        timer.unref?.()
      })
    }
  }

  if (!acquired) {
    const raw = await client.hgetall(signalCapacityKey(connectionId)).catch(() => ({}))
    return {
      state: "busy",
      capacity: parseSignalCapacitySnapshot(raw, configuredLimit),
    }
  }

  try {
    // A full canonical scan is performed only once when the durable index is
    // missing (upgrade/restart repair). Thereafter the capacity counters are
    // O(1), and the exact lane lookup is O(1) via live:position-slot.
    const capacity = await readSignalAdmissionCapacity(client, connectionId, configuredLimit)
    const existing = await findOpenLivePositionByDir(
      connectionId,
      candidate.symbol,
      candidateDirection,
      liveExecutionSlot(candidate),
    )

    if (existing && isActiveSignalPosition(existing as unknown as Record<string, unknown>)) {
      await persistSignalCapacitySnapshot(
        client,
        connectionId,
        capacity,
        selectionMode,
        "existing",
      )
      return { state: "existing", capacity, existing }
    }
    if (!capacity.allowed) {
      await persistSignalCapacitySnapshot(
        client,
        connectionId,
        capacity,
        selectionMode,
        "limit",
      )
      return { state: "limit", capacity }
    }

    // Write the compact membership first. If this process crashes before the
    // position snapshot is visible, the next admission only sees a stale
    // conservative reservation, which it removes during index repair; it can
    // never over-admit a second physical Signal order in that window.
    await updateSignalAdmissionIndexes(client, candidate)
    await savePosition(candidate)
    clearPositionCache(connectionId)
    const reservedCapacity: SignalPositionCapacity = {
      ...capacity,
      total: capacity.total + 1,
      long: capacity.long + (candidateDirection === "long" ? 1 : 0),
      short: capacity.short + (candidateDirection === "short" ? 1 : 0),
      allowed: capacity.total + 1 < capacity.limit,
      reason: capacity.total + 1 < capacity.limit ? "available" : "total_limit",
    }
    await persistSignalCapacitySnapshot(
      client,
      connectionId,
      reservedCapacity,
      selectionMode,
      "reserved",
    )
    signalCapacityNoticeAt.delete(connectionId)
    return { state: "reserved", capacity: reservedCapacity }
  } finally {
    await evalRedis(
      client,
      `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          return redis.call("DEL", KEYS[1])
        end
        return 0
      `,
      [lockKey],
      [token],
    ).catch(() => 0)
  }
}

export async function acquirePositionMutationLock(
  connectionId: string,
  positionId: string,
  lockId: string,
  ttlMs: number = POSITION_MUTATION_LOCK_TTL_MS,
): Promise<boolean> {
  const client = getRedisClient()
  const result = await client.set(positionMutationLockKey(connectionId, positionId), lockId, {
    NX: true,
    PX: ttlMs,
  } as any)
  return result === "OK" || (result as any) === true
}

export async function releasePositionMutationLock(
  connectionId: string,
  positionId: string,
  lockId: string,
): Promise<boolean> {
  const client = getRedisClient()
  const result = await evalRedis(
    client,
    `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      end
      return 0
    `,
    [positionMutationLockKey(connectionId, positionId)],
    [lockId],
  )
  return Number(result) === 1
}

export async function mutatePositionWithVersionCheck(
  position: LivePosition,
  allowedStatuses: string[],
  mutation: (draft: LivePosition) => void,
): Promise<LivePosition | null> {
  const currentVersion = Number(position.version || 0)
  const next: LivePosition = { ...position, version: currentVersion + 1, updatedAt: Date.now() }
  mutation(next)

  const fields = positionToRedisHash(next)
  const argv = [
    String(currentVersion),
    JSON.stringify(allowedStatuses),
    String(fields.version ?? next.version ?? currentVersion + 1),
    ...Object.entries(fields).flat(),
  ]
  const client = getRedisClient()
  const result = await evalRedis(
    client,
    `
      local currentVersion = redis.call("HGET", KEYS[1], "version")
      local currentStatus = redis.call("HGET", KEYS[1], "status")
      if currentVersion ~= ARGV[1] then return 0 end
      local allowed = cjson.decode(ARGV[2])
      local ok = false
      for _, status in ipairs(allowed) do
        if status == currentStatus then ok = true break end
      end
      if not ok then return 0 end
      redis.call("HSET", KEYS[1], unpack(ARGV, 4))
      return 1
    `,
    [positionHashKey(position.connectionId, position.id)],
    argv,
  )
  return Number(result) === 1 ? next : null
}

async function savePosition(position: LivePosition, retries: number = 0): Promise<void> {
  // Persist a position snapshot. This helper is intentionally a plain write;
  // status-sensitive callers must use mutatePositionWithVersionCheck() before
  // saving so Redis checks the stored status/version atomically.
  const { getRedisClient } = await import("@/lib/redis-db")
  const client = getRedisClient()
  const keepDurable = async (key: string): Promise<void> => {
    const durableClient = client as any
    if (typeof durableClient.persist === "function") await durableClient.persist(key).catch(() => 0)
    else await client.expire(key, 30 * 24 * 60 * 60).catch(() => 0)
  }
  const posKey = `live_positions:${position.connectionId}:${position.id}`
  const jsonKey = `live:position:${position.id}`
    const openIndexKey = `live:positions:${position.connectionId}`
    const closedIndexKey = `live:positions:${position.connectionId}:closed`
    const terminalStatuses = new Set(["closed", "rejected", "cancelled", "canceled", "error"])
  try {
    const incomingTerminal = terminalStatuses.has(String(position.status || "").toLowerCase())
    if (!incomingTerminal) {
      // A close path can finish while an older mark/protection snapshot is
      // still awaiting Redis I/O. Never let that stale non-terminal writer
      // resurrect the archived position or reinsert it into the open index.
      const moved = await client
        .get(`live:positions:${position.connectionId}:moved:${position.id}`)
        .catch(() => null)
      if (moved) return
    }
    if (!position.version) position.version = 0
    position.version++
    position.updatedAt = Date.now()
    await client.hset(posKey, {
      ...position,
    } as any)
    await client.set(jsonKey, JSON.stringify(position)).catch(() => null)
    // Keep the in-process Paper Stage coherent without rereading hundreds of
    // unrelated rows on the next 280 ms lifecycle tick. The durable hash above
    // remains authoritative; this is only a short-lived read projection.
    updateSimulatedPositionStageRow(position)

    // Maintain explicit reconciliation indexes from the live-stage hot path, not
    // only from the generic Redis DB helper. Production exchange sync, crash
    // recovery, and operator audits need to resolve a venue/client/system id
    // back to the exact connection-scoped live position without ambiguous
    // symbol+direction scans after restarts or accumulation.
    const exchangeData: any = position.exchangeData || {}
    const trackingIds = new Set<string>()
    for (const candidate of [
      position.id,
      position.orderId,
      position.system_tracking_id,
      position.connection_tracking_id,
      (position as any).trackingId,
      (position as any).clientOrderId,
      (position as any).exchangeOrderId,
      exchangeData.orderId,
      exchangeData.clientOrderId,
      exchangeData.exchangeOrderId,
      exchangeData.positionId,
      exchangeData.exchangePositionId,
      exchangeData.system_tracking_id,
      exchangeData.connection_tracking_id,
    ]) {
      if (candidate != null && String(candidate).trim().length > 0) trackingIds.add(String(candidate).trim())
    }
    if (Array.isArray(exchangeData.clientOrderIds)) {
      for (const entry of exchangeData.clientOrderIds) {
        const clientOrderId = entry?.clientOrderId ?? entry?.id
        if (clientOrderId != null && String(clientOrderId).trim().length > 0) trackingIds.add(String(clientOrderId).trim())
      }
    }
    for (const trackingId of trackingIds) {
      const trackingKey = `live:position:tracking:${position.connectionId}:${trackingId}`
      await client.set(trackingKey, position.id).catch(() => null)
      await client.expire(trackingKey, 7 * 24 * 60 * 60).catch(() => 0)
    }

    const liveSetIndexKey = `live_set_keys:${position.connectionId}`
    const liveSetLineageKeys = getLivePositionSetLineageKeys(position)
    const direction = resolveLivePositionDirection(position)
    const slotIndexKey = direction
      ? livePositionSlotIndexKey(position.connectionId, position.symbol, direction, liveExecutionSlot(position))
      : null
    // Keep Signal capacity independent from the much larger mixed Main book.
    // This runs after the canonical snapshot write, so an index member always
    // points at a durable position state; reserveSignalPositionCapacity writes
    // a conservative pre-reservation before its first save to cover crashes.
    await updateSignalAdmissionIndexes(client, position)
    if (terminalStatuses.has(String(position.status || "").toLowerCase())) {
      // Remove only our own slot mapping. A replacement position may have
      // acquired the same slot after this one moved to terminal state; a plain
      // DEL would then erase the newer owner's O(1) index.
      if (slotIndexKey) {
        await evalLockLua(client, RELEASE_LOCK_LUA, slotIndexKey, [position.id]).catch(() => 0)
      }
      await moveRedisListMembershipToHead(
        client,
        openIndexKey,
        closedIndexKey,
        position.id,
      )
      await client.set(`live:positions:${position.connectionId}:moved:${position.id}`, String(Date.now())).catch(() => null)
      await client.expire(`live:positions:${position.connectionId}:moved:${position.id}`, 60 * 60).catch(() => 0)
      for (const setKey of liveSetLineageKeys) {
        await client.srem(liveSetIndexKey, setKey).catch(() => 0)
      }
      const openedAt = Number(position.createdAt || position.timestamp || 0)
      const closedAt = Number(position.closedAt || position.updatedAt || Date.now())
      await archiveClosedLivePositionAnalytics(
        client,
        position as unknown as Record<string, unknown>,
      ).catch((error) => {
        logRuntimeWarning(
          `live-analytics-archive:${position.connectionId}`,
          60_000,
          `${LOG_PREFIX} analytics archive write failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      })
      const entryPrice = Number(position.averageExecutionPrice || position.entryPrice || 0)
      const totalQuantity = Math.max(
        Number(position.totalExecutedQuantity || 0),
        Number(position.closedQuantity || 0),
        Number(position.executedQuantity || 0),
        Number(position.quantity || 0),
      )
      const notional = entryPrice > 0 && totalQuantity > 0 ? entryPrice * totalQuantity : 0
      const realizedPnl = Number.isFinite(Number(position.realizedPnL))
        ? Number(position.realizedPnL)
        : 0
      const positionCostPct = Number(position.positionCostPct) > 0
        ? Number(position.positionCostPct)
        : 0.1
      const grossPnlPct = notional > 0 ? (realizedPnl / notional) * 100 : 0
      await markStrategyPositionInactive(
        position.connectionId,
        position.id,
        String(position.status).toLowerCase() === "closed"
          ? {
              pnl: realizedPnl,
              // Strategy-set history uses the canonical net percentage. The
              // raw exchange PnL above is intentionally preserved for API/UI
              // reporting and accounting.
              pnlPct: netMovePctAfterPositionCost(grossPnlPct, positionCostPct),
              positionCostPct,
              drawdownMinutes: openedAt > 0 && closedAt > openedAt
                ? (closedAt - openedAt) / 60_000
                : 0,
            }
          : undefined,
      )
    } else {
      await upsertRedisListHead(client, openIndexKey, position.id)
      if (slotIndexKey) {
        await client.set(slotIndexKey, position.id).catch(() => null)
        await keepDurable(slotIndexKey)
      }
      for (const setKey of liveSetLineageKeys) {
        await client.sadd(liveSetIndexKey, setKey).catch(() => 0)
      }
      await client.expire(liveSetIndexKey, 24 * 60 * 60).catch(() => 0)
    }
    await keepDurable(liveSetIndexKey)
    await keepDurable(openIndexKey)
    await keepDurable(closedIndexKey)
    await keepDurable(posKey)
    await keepDurable(jsonKey)
    await syncActiveBlockCountIndex(client, position)
    // Closed snapshots and their connection index are durable. APIs page the
    // index in bounded batches, so retaining the complete audit trail does not
    // increase one request's memory footprint.
    // The full InlineLocalRedis checkpoint is intentionally minute-batched to
    // avoid multi-megabyte disk writes in hot engine cycles. Journal only
    // lifecycle/quantity changes here, so any position state already exposed
    // by the API remains monotonic after a hard process crash.
    await persistLivePositionCheckpointIfChanged(position)
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} [RC2] savePosition failed for ${position.symbol}/${position.id}:`,
      err instanceof Error ? err.message : String(err),
    )
    // Retry once on transient errors
    if (retries < 1 && err instanceof Error && err.message.includes("REDIS")) {
      await new Promise(r => setTimeout(r, 100))
      return savePosition(position, retries + 1)
    }
    throw err
  }
}

/**
 * Inline Redis is process memory backed by a snapshot file. Before any real
 * exchange mutation leaves the process, force a snapshot barrier so a SIGKILL
 * cannot erase the client-order id or lifecycle state needed for idempotent
 * restart recovery. Shared network Redis is already durable at write return.
 */
async function persistCriticalLiveState(reason: string): Promise<void> {
  const { getRedisBackend, persistNow } = await import("@/lib/redis-db")
  if (getRedisBackend() !== "inline-local") return
  const persisted = await persistNow()
  if (!persisted) {
    throw new Error(
      `Refusing exchange mutation: Inline Redis could not persist critical state (${reason})`,
    )
  }
}

/**
 * Batch save multiple positions in a single transaction.
 * Reduces Redis round-trips from N × savePosition() to 1 batch operation.
 * Critical for cycle-end updates when many positions need simultaneous persistence.
 *
 * Example: 5 positions closing per cycle
 *   Before: 5 separate savePosition() calls = 5 Redis RTTs
 *   After: 1 batchSavePositions([p1, p2, p3, p4, p5]) = 1 Redis RTT
 * 
 * Typical impact: 20-30% reduction in Redis ops at cycle boundaries
 */
async function batchSavePositions(positions: LivePosition[]): Promise<void> {
  if (!positions || positions.length === 0) return

  const { getRedisClient } = await import("@/lib/redis-db")
  const client = getRedisClient()

  try {
    // Use Redis pipeline for atomic multi-save
    const pipeline = (client as any).pipeline?.()
    if (!pipeline) {
      // Fallback: individual saves if pipeline not available
      await Promise.all(positions.map(p => savePosition(p)))
      return
    }

    // Queue all saves in pipeline
    for (const position of positions) {
      const key = `live_positions:${position.connectionId}:${position.id}`
      pipeline.hset(key, position as any)
    }

    // Execute all queued operations atomically
    await pipeline.exec()
  } catch (err) {
    console.warn(`${LOG_PREFIX} batchSavePositions failed:`, err instanceof Error ? err.message : String(err))
    // Fallback to individual saves on error
    await Promise.all(positions.map(p => savePosition(p).catch(() => {})))
  }
}
async function incrementMetric(connectionId: string, metric: string, delta: number = 1): Promise<void> {
  try {
    // Use validated wrapper to prevent stale metric writes
    const { getCurrentEpoch } = await import("@/lib/trade-engine/progression-lock")
    const { hincrbyProgression } = await import("@/lib/trade-engine/progression-writes")
    
    const currentEpoch = await getCurrentEpoch(connectionId)
    if (!currentEpoch) return // No active lock, skip write (stale instance)
    
    // Use validated wrapper for epoch-safe increments
    await hincrbyProgression(connectionId, metric, delta, {
      connectionId,
      epoch: currentEpoch,
      logStaleRejects: false,
    })
  } catch (err) {
    // metric failures should not throw the live pipeline
  }
}
async function incrementOrdersBySymbol(connectionId: string, symbol: string, side: string, metric: string): Promise<void> {
  try {
    const { recordPerSymbolOrderCounter } = await import("@/lib/live-order-service")
    const sideKey = String(side || "").trim().toLowerCase()
    const dir =
      sideKey === "long" || sideKey === "buy"
        ? "long"
        : sideKey === "short" || sideKey === "sell"
          ? "short"
          : null
    if (!dir || !["placed", "filled", "failed"].includes(metric)) return
    const symbolKey = String(symbol || "").trim().toUpperCase()
    await recordPerSymbolOrderCounter(connectionId, symbolKey, dir, metric as any)
  } catch {
    /* best-effort */
  }
}

async function recordPositionAdjustmentProgression(
  connectionId: string,
  position: Pick<LivePosition, "id" | "symbol" | "direction" | "side">,
  event: "placed" | "filled" | "failed" | "simulated",
  eventIdentity: string,
  volumeUsd = 0,
): Promise<boolean> {
  const direction = normalizeLiveTradeDirection(position.direction, position.side)
  if (!direction) {
    throw new Error(`Cannot account position adjustment ${position.id}: invalid long/short direction`)
  }
  const normalizedIdentity = String(eventIdentity || "").trim()
  if (!normalizedIdentity) {
    throw new Error(`Cannot account position adjustment ${position.id}: durable event identity is missing`)
  }
  const { recordLiveOrderProgression } = await import("@/lib/live-order-service")
  return recordLiveOrderProgression(
    connectionId,
    position.symbol,
    direction,
    event,
    volumeUsd,
    `${position.id}:adjustment:${normalizedIdentity}:${event}`,
    {
      countPositionCreated: false,
      countAccumulated: event === "filled" || event === "simulated",
    },
  )
}

function makeDurableClientOrderId(prefix: string, position: Pick<LivePosition, "id" | "symbol">): string {
  const symbol = String(position.symbol || "x").replace(/[^a-zA-Z0-9]/g, "").slice(0, 7)
  const suffix = nanoid(8).replace(/[^a-zA-Z0-9]/g, "")
  return `cts${prefix}${symbol}${Date.now().toString(36)}${suffix}`.slice(0, 32)
}

function appendClientOrderTracking(
  position: LivePosition,
  clientOrderId: string,
  kind: "entry" | "accumulation" | "stop_loss" | "take_profit",
  extra: Record<string, unknown> = {},
): void {
  const exchangeData = { ...(position.exchangeData || {}) } as Record<string, any>
  const existing = Array.isArray(exchangeData.clientOrderIds) ? exchangeData.clientOrderIds : []
  const withoutDuplicate = existing.filter((entry: any) => String(entry?.clientOrderId ?? entry?.id ?? "") !== clientOrderId)
  exchangeData.clientOrderIds = [
    ...withoutDuplicate,
    { clientOrderId, kind, preparedAt: Date.now(), ...extra },
  ].slice(-100)
  position.exchangeData = exchangeData
}

function getTrackedClientOrderId(
  position: LivePosition,
  kind: "entry" | "accumulation" | "stop_loss" | "take_profit",
): string | undefined {
  const entries = (position.exchangeData as any)?.clientOrderIds
  if (!Array.isArray(entries)) return undefined
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry?.kind !== kind) continue
    const value = entry?.clientOrderId ?? entry?.id
    if (value) return String(value)
  }
  re…103250 tokens truncated…:`,
          err instanceof Error ? err.message : String(err),
        )
      }
      return delta
    }

    // ── Bounded-concurrency streaming pool ───────────��───────────────
    // Streaming (not batch) pool so a slow exchange call on one
    // position never blocks the next 7 from starting. Concurrency 8
    // is well below the 50/min order-rate ceiling on every venue we
    // support and well above the typical sweep size, so the limit
    // virtually never bites in practice — it exists purely as a
    // backstop against a pathological burst.
    const LIVE_RECONCILE_CONCURRENCY = 8
    const queue = openPositions.slice()
    const runners: Promise<void>[] = []
    const aggregate = (d: PosDelta) => {
      summary.reconciled       += d.reconciled
      summary.updated          += d.updated
      summary.closed           += d.closed
      summary.errors           += d.errors
      summary.protectionRearmed += d.protectionRearmed
    }
    summary.reconciled = 0 // re-counted by aggregate
    for (let i = 0; i < Math.min(LIVE_RECONCILE_CONCURRENCY, queue.length); i++) {
      runners.push((async () => {
        while (true) {
          const p = queue.shift()
          if (!p) return
          aggregate(await processOne(p))
        }
      })())
    }
    await Promise.all(runners)

    // BATCHING: Save all collected positions in one operation instead of N sequential calls
    if (positionsToSave.length > 0) {
      try {
        await Promise.all(positionsToSave.map(p => savePosition(p)))
      } catch (batchErr) {
        console.warn(
          `${LOG_PREFIX} batch savePosition failed (attempted ${positionsToSave.length} positions):`,
          batchErr instanceof Error ? batchErr.message : String(batchErr),
        )
      }
    }

    if (summary.closed > 0 || summary.updated > 0) {
      console.log(
        `${LOG_PREFIX} ${connectionId} reconciled=${summary.reconciled} updated=${summary.updated} closed=${summary.closed}`
      )
    }

    return summary
  } catch (err) {
    console.error(`${LOG_PREFIX} reconcileLivePositions fatal:`, err)
    return summary
  } finally {
    stopSyncLockLeaseRefresh?.()
    if (lockAcquired && client) {
      await evalLockLua(client, RELEASE_LOCK_LUA, LIVE_SYNC_LOCK_KEY, [syncLockToken]).catch(() => 0)
    }
  }
}

/**
 * Standalone simulated-position processor.
 *
 * Walks every `status === "simulated"` live position and applies the
 * same SL/TP-cross / max-hold-time close logic the real-position
 * paths use, but without any exchange-side calls. Closes via
 * `closeLivePosition(connectionId, posId, exitPrice, null, reason)`
 * which already gracefully no-ops the exchange branches when the
 * connector is `null`.
 *
 * This MUST be callable independently of the exchange connector
 * because:
 *   1. Paper-only connections (no API keys) never enter
 *      `syncWithExchange` — `maybeRunLiveSync` returns at the
 *      API-key gate.
 *   2. The cron `reconcileLivePositions` early-returns when the
 *      connector has no `getPositions`, again bypassing the
 *      simulated sweep that lives inside `syncWithExchange`.
 *
 * Without this helper, simulated positions sat open forever on any
 * paper connection — the user-visible "Live Positions are Still not
 * getting closed" complaint.
 *
 * Returns a summary for logging.
 */
export async function processSimulatedPositions(
  connectionId: string,
  preloadedPositions?: readonly LivePosition[],
): Promise<{ processed: number; closed: number; errors: number }> {
  const summary = { processed: 0, closed: 0, errors: 0 }
  try {
    await initRedis()
    // syncWithExchange has already read the authoritative open index. Reuse
    // that snapshot for paper mode instead of immediately reading every hash
    // and JSON mirror for a second time on the same 200ms tick. The standalone
    // path keeps a one-second Stage projection so a dense Paper book does not
    // deserialize its complete row set five times per second.
    const allOpen = preloadedPositions
      ? [...preloadedPositions]
      : await getSimulatedPositionStageRows(connectionId)
    if (preloadedPositions) {
      const previous = simulatedPositionStages.get(connectionId)
      simulatedPositionStages.set(connectionId, {
        positions: allOpen,
        cursor: previous?.cursor || 0,
        expiresAt: Date.now() + SIMULATED_POSITION_STAGE_CACHE_MS,
      })
      trimSimulatedPositionStages()
    }
    const allSimulated = allOpen.filter(
      (p) => p.status === "simulated" && (p.executedQuantity ?? 0) > 0,
    )
    if (allSimulated.length === 0) return summary
    const sims = selectSimulatedPositionStageRows(connectionId, allSimulated)

    // Pull current prices only for this fair Stage slice. Each open row remains
    // eligible for TP/SL, trailing and max-hold handling; large books simply
    // rotate through bounded rows instead of starving HTTP/recovery work.
    const uniqueSyms = Array.from(new Set(sims.map((p) => p.symbol)))
    const priceMap = new Map<string, number>()
    await Promise.all(
      uniqueSyms.map(async (sym) => {
        const px = await fetchCurrentPrice(sym).catch(() => 0)
        if (px > 0) priceMap.set(sym, px)
      }),
    )

    const MAX_HOLD_TIME_MS = resolveMaxHoldMs(connectionId)
    type SimulatedDelta = { processed: number; closed: number; errors: number }
    const processOne = async (pos: LivePosition): Promise<SimulatedDelta> => {
      const delta: SimulatedDelta = { processed: 1, closed: 0, errors: 0 }
      try {
        const markPrice = priceMap.get(pos.symbol) || pos.averageExecutionPrice || 0
        const previousMark = Number(pos.exchangeData?.markPrice || 0)
        const now = Date.now()
        if (markPrice > 0) {
          pos.exchangeData = {
            ...pos.exchangeData,
            markPrice,
            syncedAt: now,
          }
          // SL/TP cross check (passes connector=null so close skips
          // the exchange-side cancel + closePosition calls).
          const crossed = await checkAndForceCloseOnSltpCross(
            connectionId,
            pos,
            markPrice,
            null,
          )
          if (crossed) {
            if (crossed !== "close_unconfirmed") {
              delta.closed++
              clearSimulatedMarkPersistence(pos)
            }
            return delta
          }
        }
        // Max-hold safety closer.
        const openedAt = pos.createdAt || pos.updatedAt || 0
        const heldMs = Date.now() - openedAt
        if (
          MAX_HOLD_TIME_MS > 0 &&
          heldMs > MAX_HOLD_TIME_MS &&
          isSystemTrackedLivePosition(pos, connectionId) &&
          (pos.executedQuantity ?? 0) > 0
        ) {
          const exitPrice = markPrice || pos.averageExecutionPrice || pos.entryPrice
          await logProgressionEvent(
            connectionId,
            "live_trading",
            "warning",
            `Max hold time exceeded for simulated ${pos.symbol} — force-closing`,
            { positionId: pos.id, heldMs, maxHoldMs: MAX_HOLD_TIME_MS, exitPrice },
          )
          const closeResult = await closeLivePosition(connectionId, pos.id, exitPrice, null, "max_hold_time_exceeded")
          if (closeResult?.status === "closed") {
            delta.closed++
            clearSimulatedMarkPersistence(pos)
          } else delta.errors++
          return delta
        }
        // Keep the dashboard fresh without writing the complete lifecycle,
        // indexes and JSON mirror on every sub-second paper tick. This is
        // intentionally after the close checks: lifecycle changes still use
        // closeLivePosition immediately and never wait for this throttle.
        if (shouldPersistSimulatedMark(pos, previousMark, markPrice, now)) {
          await savePosition(pos)
          markSimulatedMarkPersisted(pos, now)
        }
      } catch (err) {
        delta.errors++
        console.warn(
          `${LOG_PREFIX} processSimulatedPositions per-pos error for ${pos.id}:`,
          err instanceof Error ? err.message : String(err),
        )
      }
      return delta
    }

    // Redis-backed paper lifecycle work can resolve through microtasks without
    // yielding to the HTTP server.  Use the shared cooperative worker pool so
    // a large open-position book cannot starve health, cron or control-order
    // requests while every position still receives an independent lifecycle
    // evaluation in the same sweep.
    const deltas = await mapWithConcurrency(
      sims,
      concurrencyFromEnv(
        ["SIMULATED_POSITION_CONCURRENCY"],
        SIMULATED_POSITION_PROCESS_CONCURRENCY,
        16,
        sims.length,
      ),
      processOne,
      { yieldEvery: 1 },
    )
    for (const delta of deltas) {
      summary.processed += delta.processed
      summary.closed += delta.closed
      summary.errors += delta.errors
    }
    if (summary.closed > 0) {
      console.log(
        `${LOG_PREFIX} processSimulatedPositions ${connectionId} processed=${summary.processed} closed=${summary.closed}`,
      )
    }
    return summary
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} processSimulatedPositions fatal:`,
      err instanceof Error ? err.message : String(err),
    )
    return summary
  }
}

/**
 * Sync live positions with exchange data (mark price, liq price, unrealized PnL).
 * Called periodically by the engine monitoring loop.
 */
export async function syncWithExchange(connectionId: string, exchangeConnector: any): Promise<void> {
  await initRedis()
  const client = getRedisClient()
  const syncStartMs = Date.now()

  // ── Cross-caller single-flight gate ��────────────────────────────────
  // `syncWithExchange` has three independent callers in production:
  //   1. RealtimeProcessor.maybeRunLiveSync() — every 200 ms (in-process
  //      gate `liveSyncInFlight` covers same-process collisions only)
  //   2. /api/cron/sync-live-positions — portable scheduler, 60 s
  //   3. /api/trade-engine/resume      — one-shot on resume
  //
  // Without a Redis-backed lock the cron+realtime can run in parallel
  // against the same per-position state (status flips, protection-
  // order placement, externally-closed adoption — all racy when
  // doubled). The in-process flag is process-local and useless across
  // a serverless cron invocation hitting the same Redis as a long-
  // running engine.
  //
  // Lock semantics:
  //   • Key:    live_sync_lock:{connectionId}
  //   • TTL:    30 s — generous headroom over the sync's p99 runtime
  //             while still releasing within one heartbeat window if
  //             the holder process dies mid-sync.
  //   • NX:     atomic acquire; if already held we early-return as a
  //             no-op (the existing holder will finish the work).
  //   • Release: best-effort `del` in the finally block. On crash the
  //             TTL is the safety net.
  //
  // This is intentionally LESS strict than the progression-lock
  // (which uses ownerToken+epoch) because syncWithExchange is
  // idempotent — losing a lock release just costs one skipped sync
  // tick, not corrupted state.
  const LIVE_SYNC_LOCK_KEY = `live_sync_lock:${connectionId}`
  // TTL reduced from 30 s → 5 s.
  // Rationale: syncWithExchange p99 completes in ~600-900 ms (one fetchPositions +
  // one fetchOpenOrders round-trip). A 30 s TTL meant callers accumulated "skip"
  // messages at ~400 ms cadence (×15 symbols = 37.5 skip logs/s) filling the log
  // file and stalling stdout. 5 s gives 4× headroom over p99 while limiting lock
  // starvation to at most 5 s rather than 30 s on crash-without-release.
  const LIVE_SYNC_LOCK_TTL_SEC = 5
  // Throttle the skip-log to once per 20 s per connection to prevent log flooding.
  // The skip itself is still idempotent-correct; the operator sees the message at
  // a human-readable rate instead of hundreds per second across 15 symbols.
  const SKIP_LOG_KEY = `live_sync_skip_logged:${connectionId}`
  const syncLockToken = `sync:${process.pid}:${syncStartMs}:${nanoid(12)}`
  let lockAcquired = false
  let stopSyncLockLeaseRefresh: (() => void) | null = null
  if (client) {
    try {
      const acquireResult = await client.set(LIVE_SYNC_LOCK_KEY, syncLockToken, {
        NX: true,
        EX: LIVE_SYNC_LOCK_TTL_SEC,
      })
      lockAcquired = acquireResult === "OK"
      if (lockAcquired) {
        stopSyncLockLeaseRefresh = startRedisLockLeaseRefresh(
          client,
          LIVE_SYNC_LOCK_KEY,
          syncLockToken,
          LIVE_SYNC_LOCK_TTL_SEC * 1000,
        )
      }
    } catch (lockErr) {
      // Redis unreachable — fail open (proceed without the lock).
      // The in-process flag in RealtimeProcessor still prevents
      // same-process duplicate runs; the only path that loses
      // dedup is cron-vs-realtime, which is rare and idempotent.
      console.warn(
        `${LOG_PREFIX} [sync-lock] acquire failed for ${connectionId} — proceeding without cross-caller lock:`,
        lockErr instanceof Error ? lockErr.message : String(lockErr),
      )
      lockAcquired = true // treat as acquired so the finally block doesn't try to release
    }
    if (!lockAcquired) {
      // Throttled skip log: emit at most once per 20 s to avoid flooding stdout.
      try {
        const lastLogged = await client.get(SKIP_LOG_KEY)
        if (!lastLogged) {
          console.log(
            `${LOG_PREFIX} [sync-lock] skip — another caller is mid-sync for conn=${connectionId} (likely cron+realtime overlap, idempotent skip)`,
          )
          await client.set(SKIP_LOG_KEY, "1", { EX: 20 })
        }
      } catch { /* best-effort */ }
      return
    }
  }

  try {
    // Paper mode never needs an exchange reconciliation.  More importantly,
    // repeatedly hydrating every complete live-position hash before the
    // bounded simulated Stage is selected defeats that Stage's purpose: with
    // a few hundred independent Paper rows, a 280 ms tick spent most of its
    // time JSON-parsing the whole book, even though it only managed one fair
    // slice.  Resolve the execution mode first, then let the Stage cache load
    // and rotate the book at its one-second cadence.  Close/TP/SL/hold checks
    // remain independent for every row and terminal saves update the cached
    // stage immediately.
    const liveTradeOn = await isLiveTradeEnabledForConnection(connectionId)
    const lifecycleRows = liveTradeOn
      ? []
      : await getLivePositions(connectionId).catch(() => [] as LivePosition[])
    const hasOwnedExchangeLifecycle = lifecycleRows.some((position) =>
      isExchangeLifecyclePosition(position, connectionId),
    )
    if (!liveTradeOn && !hasOwnedExchangeLifecycle) {
      const simSummary = await processSimulatedPositions(connectionId)
      logRuntimeInfo(
        `live:${connectionId}:sync-skip`,
        30_000,
        () => {
          const stagedRows = (simulatedPositionStages.get(connectionId)?.positions || []) as LivePosition[]
          const statusBreakdown = stagedRows.reduce((acc: Record<string, number>, p: LivePosition) => {
            const status = String(p.status || "unknown")
            acc[status] = (acc[status] || 0) + 1
            return acc
          }, {} as Record<string, number>)
          return (
            `${LOG_PREFIX} [sync-skip] conn=${connectionId} live_trade=false; ` +
            `skipped private exchange sync, tracked=${stagedRows.length}, ` +
            `simProcessed=${simSummary.processed}, simClosed=${simSummary.closed}, ` +
            `statuses=${JSON.stringify(statusBreakdown)}`
          )
        },
      )
      return
    }
    if (!liveTradeOn) {
      console.log(
        `${LOG_PREFIX} [sync] entry permission is off; continuing exchange lifecycle sync for ` +
        `${lifecycleRows.filter((position) => isExchangeLifecyclePosition(position, connectionId)).length} system-owned position(s)`,
      )
    }

    // Previously each status filter triggered a full getLivePositions() scan,
    // meaning we fetched the same open-positions index from Redis FOUR times
    // just to bucket by status. Load once, then filter in memory.
    const loadedOpenRows = liveTradeOn ? await getLivePositions(connectionId) : lifecycleRows
    // Storage adapters and older snapshots may surface a missing list as
    // undefined even though the typed contract is an array. Reconciliation is
    // fail-closed and idempotent: an absent book means zero rows, never an
    // exception loop that can starve the engine monitor.
    const allOpenRaw = (Array.isArray(loadedOpenRows) ? loadedOpenRows : []) as LivePosition[]

    // ── Self-heal: purge terminal positions stuck in the open index ─────
    // A historical bug in redis-db savePosition() re-added rejected/cancelled/
    // error positions to the open index on every save, so stale terminal
    // entries can persist indefinitely (observed: 16 "rejected" re-synced
    // every tick). Move them to the closed archive here so the sync loop
    // only ever processes genuinely live positions.
    const TERMINAL_SYNC_STATUSES = new Set(["closed", "rejected", "cancelled", "canceled", "error"])
    const stuckTerminal = allOpenRaw.filter((p) => TERMINAL_SYNC_STATUSES.has(String(p.status)))
    if (stuckTerminal.length > 0) {
      try {
        const openIndexKey = `live:positions:${connectionId}`
        const closedIndexKey = `live:positions:${connectionId}:closed`
        let newlyMoved = 0
        await Promise.all(
          stuckTerminal.map(async (p) => {
            const already = await client.lpos(closedIndexKey, p.id).catch(() => null)
            if (already === null || already === undefined) {
              await moveRedisListMembershipToHead(
                client,
                openIndexKey,
                closedIndexKey,
                p.id,
              )
              newlyMoved++
            } else {
              await client.lrem(openIndexKey, 0, p.id).catch(() => 0)
            }
          }),
        )
        // Only log when positions are newly moved — suppress repetitive noise when
        // the same terminal positions appear in the open index every cycle
        // (e.g. Redis snapshot restored stale open-index entries that are already
        // in the closed list; they are safe to silently discard).
        if (newlyMoved > 0) {
          console.log(
            `${LOG_PREFIX} [sync-tick] purged ${newlyMoved} terminal position(s) stuck in open index for ${connectionId}`,
          )
        }
      } catch { /* best-effort self-heal */ }
    }
    const invalidDirectionPositions: LivePosition[] = []
    const allOpen = allOpenRaw.filter((p) => {
      if (TERMINAL_SYNC_STATUSES.has(String(p.status))) return false
      const direction = resolveLivePositionDirection(p)
      if (!direction) {
        p.statusReason = "sync_blocked_invalid_direction"
        pushStep(p, "sync_direction_guard", false, "No explicit long/short direction; venue mutations are blocked")
        invalidDirectionPositions.push(p)
        return false
      }
      p.direction = direction
      p.side ??= direction
      return true
    })
    if (invalidDirectionPositions.length > 0) {
      await Promise.all(invalidDirectionPositions.map((position) => savePosition(position).catch(() => {})))
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "error",
        `${invalidDirectionPositions.length} live position(s) quarantined during sync: invalid direction`,
        { positionIds: invalidDirectionPositions.map((position) => position.id) },
      ).catch(() => {})
    }

    const openPositions = allOpen.filter(
      (p) => p.status === "open" || p.status === "filled" || p.status === "partially_filled" || p.status === "placed" || p.status === "pending_fill" || p.status === "placed_unconfirmed" || p.status === "closing" || p.status === "closing_partial",
    )

    // ── Batch pre-loop fetches in parallel ─────────────────────────────��─
    // Three independent I/O calls are needed before the per-position loop:
    //   1. getPositions()    — exchange position list (adoption + map)
    //   2. getOpenOrders()   — live order id set for liveness verification
    //   3. getClosedLivePositions(50) — recent closes for orphan guard
    //
    // Previously these ran serially adding ~3× RTT to every tick.
    // Running them in a single Promise.all collapses to 1× RTT.
    // getPositions is also deduplicated — it was previously called TWICE
    // (once for adoption, once for the exchange map).
    let exchangePositionsForAdoption: any[] = []
    let exchangePositionsSnapshotOk = false
    let liveOrderIdsSync: Set<string> | null = null
    let recentlyClosedForOrphanGuard: LivePosition[] = []

    await Promise.allSettled([
      // 1. Exchange positions (reused for adoption AND per-position map).
      (async () => {
        if (exchangeConnector && typeof exchangeConnector.getPositions === "function") {
          try {
            const snapshot = await withTimeout(
              exchangeConnector.getPositions() as Promise<any[]>,
              EXCHANGE_TIMEOUT_GET_POSITIONS_MS,
              "getPositions(sync-prefetch)",
            )
            exchangePositionsForAdoption = Array.isArray(snapshot) ? snapshot : []
            const snapshotStatus = typeof exchangeConnector.getLastPositionsSnapshotStatus === "function"
              ? exchangeConnector.getLastPositionsSnapshotStatus()
              : { ok: Array.isArray(snapshot) }
            exchangePositionsSnapshotOk = snapshotStatus.ok === true
          } catch {
            exchangePositionsSnapshotOk = false
          }
        }
      })(),
      // 2. Open orders snapshot for liveness verification.
      (async () => {
        liveOrderIdsSync = await fetchLiveOrderIdSet(exchangeConnector)
      })(),
      // 3. Recently-closed positions for orphan-adoption guard.
      (async () => {
        try {
          recentlyClosedForOrphanGuard = await getClosedLivePositions(connectionId, 50).catch(() => [] as LivePosition[])
        } catch { /* best-effort */ }
      })(),
    ])

    // ── Observability heartbeat ───────���────────────────────────���──────
    // Previously this function ran silently when there were zero
    // tracked positions OR when every position was in a "do nothing"
    // state — producing the operator's "orders not closing, no logs"
    // symptom. Always emit a one-line breakdown of what the close-side
    // pipeline is seeing so the operator can distinguish:
    //   (a) sync isn't running at all (no log = caller throttled / paused)
    //   (b) sync is running but finds nothing to act on
    //   (c) sync is running and processing positions in known status
    // Throttled to ~10s of useful detail so we don't flood logs at
    // steady state; the per-position branches below still log their
    // individual decisions.
    const statusBreakdown = allOpen.reduce<Record<string, number>>((acc, p) => {
      const s = String(p.status || "unknown")
      acc[s] = (acc[s] || 0) + 1
      return acc
    }, {})
    const placedCount = (statusBreakdown.placed || 0) + (statusBreakdown.pending_fill || 0) + (statusBreakdown.placed_unconfirmed || 0)
    const simCount = statusBreakdown.simulated || 0
    const totalLive = openPositions.filter((p) => p.status !== "placed" && p.status !== "pending_fill" && p.status !== "placed_unconfirmed").length
    console.log(
      `${LOG_PREFIX} [sync-tick] conn=${connectionId} tracked=${allOpen.length} open=${totalLive} placed=${placedCount} simulated=${simCount} statuses=${JSON.stringify(statusBreakdown)}`,
    )

    // ── Simulated-position sweep (paper-mode + is_live_trade=false) ─────
    // Simulated positions don't touch the exchange, so we cannot use the
    // exchange-position map or any exchangeConnector calls to close
    // them. Process them inline using Redis market_data ticks — this
    // is the path that previously left simulated orders open forever
    // because every other close branch in this function gates on
    // exchange-side data.
    //
    // We do it BEFORE the API-key gate inside maybeRunLiveSync (the
    // caller) by also exposing a standalone `processSimulatedPositions`
    // helper. Keeping a lightweight copy here makes the engine's
    // exchange-side sync self-contained for connections that DO have
    // API keys — simulated positions on those connections (paused
    // live-trade, mixed mode) still get a close path on the same tick.
    {
      const sims = allOpen.filter(
        (p) => p.status === "simulated" && (p.executedQuantity ?? 0) > 0,
      )
      if (sims.length > 0) {
        // Pull all current prices in one parallel fan-out — independent
        // Redis reads (one per unique symbol). 60s stale fallback to
        // averageExecutionPrice keeps a missing tick from blocking close.
        const uniqueSyms = Array.from(new Set(sims.map((p) => p.symbol)))
        const priceMap = new Map<string, number>()
        await Promise.all(
          uniqueSyms.map(async (sym) => {
            const px = await fetchCurrentPrice(sym).catch(() => 0)
            if (px > 0) priceMap.set(sym, px)
          }),
        )
        for (const pos of sims) {
          try {
            const markPrice = priceMap.get(pos.symbol) || pos.averageExecutionPrice || 0
            if (markPrice > 0) {
              pos.exchangeData = {
                ...pos.exchangeData,
                markPrice,
                syncedAt: Date.now(),
              }
              const crossed = await checkAndForceCloseOnSltpCross(
                connectionId,
                pos,
                markPrice,
                null, // simulated: skip exchange ops in close
              )
              if (crossed) continue
            }
            // Max-hold safety closer (parallel to the real-position path).
            const MAX_HOLD_TIME_MS = resolveMaxHoldMs(connectionId)
            const openedAt = pos.createdAt || pos.updatedAt || 0
            const heldMs = Date.now() - openedAt
            if (
              MAX_HOLD_TIME_MS > 0 &&
              heldMs > MAX_HOLD_TIME_MS &&
              isSystemTrackedLivePosition(pos, connectionId) &&
              (pos.executedQuantity ?? 0) > 0
            ) {
              const exitPrice = markPrice || pos.averageExecutionPrice || pos.entryPrice
              await logProgressionEvent(
                connectionId,
                "live_trading",
                "warning",
                `Max hold time exceeded for simulated ${pos.symbol} — force-closing`,
                { positionId: pos.id, heldMs, maxHoldMs: MAX_HOLD_TIME_MS, exitPrice },
              )
              await closeLivePosition(connectionId, pos.id, exitPrice, null, "max_hold_time_exceeded")
              continue
            }
            // Persist refreshed mark price so the dashboard reads it.
            if (markPrice > 0) {
              await savePosition(pos)
            }
          } catch (simErr) {
            console.warn(
              `${LOG_PREFIX} simulated-tick error for ${pos.id}:`,
              simErr instanceof Error ? simErr.message : String(simErr),
            )
          }
        }
      }
    }

    if (!exchangePositionsSnapshotOk) {
      console.warn(
        `${LOG_PREFIX} Exchange positions snapshot was not authoritative for ${connectionId}; skipping adoption, external-close, and quantity mutation`,
      )
      return
    }

    // ��─ Exchange-orphan adoption ────────────────────────────────���────────
    // `exchangePositionsForAdoption` was already fetched in the parallel
    // prefetch above — no second getPositions() call needed here.
    // Alias it so the adoption block's variable names are unchanged.
    const exchangePositions = exchangePositionsForAdoption
    let adoptedCount = 0
    if (exchangeConnector && Array.isArray(exchangePositionsForAdoption) && exchangePositionsForAdoption.length > 0) {
      if (true) { // guard already applied above
          // Build a set of (symbol|direction) keys we already track in any
          // status — including terminal ones — so we don't re-adopt a
          // position that was just closed but the exchange hasn't yet
          // reflected the close (a few-second lag is normal).
          const normSym = (raw: string) => String(raw || "").toUpperCase().replace(/[-_]/g, "")
          const trackedKeys = new Set<string>()
          for (const p of allOpen) {
            trackedKeys.add(`${normSym(p.symbol)}|${p.direction}`)
          }
          // Use the pre-fetched recent-closes list (fetched in parallel
          // above) so we don't issue another Redis round-trip here.
          for (const p of recentlyClosedForOrphanGuard) {
            const closedAgoMs = Date.now() - (p.closedAt || 0)
            const direction = resolveLivePositionDirection(p)
            // Within 60 s of close — exchange may still report position
            // until the close fill propagates. After that window treat
            // it as truly closed and orphan-adopt if it reappears.
            if (closedAgoMs < 60_000 && direction) {
              trackedKeys.add(`${normSym(p.symbol)}|${direction}`)
            }
          }

          // Load default SL/TP percentages once for all adoptions.
          let defaultSlPct = 1
          let defaultTpPct = 2
          try {
            const tradingSettings = (await client.hgetall("settings:trading")) || {}
            const slRaw = parseFloat(String((tradingSettings as any).default_stop_loss_percent ?? "1"))
            const tpRaw = parseFloat(String((tradingSettings as any).default_take_profit_percent ?? "2"))
            if (Number.isFinite(slRaw) && slRaw > 0) defaultSlPct = normalizeStopLossPercent(slRaw).value
            if (Number.isFinite(tpRaw) && tpRaw > 0) defaultTpPct = tpRaw
          } catch { /* use defaults */ }

          for (const exPos of exchangePositionsForAdoption) {
            try {
              // Do not adopt or mutate manual/foreign exchange positions.
              // Adoption is only safe for positions carrying this app's
              // system id AND the matching connection id.
              if (!isSystemTrackedLivePosition(exPos, connectionId)) continue

              const rawSym = String(exPos.symbol || (exPos as any).Symbol || "")
              const sym = normSym(rawSym)
              if (!sym) continue
              const signedSize = parseFloat(String(exPos.size ?? (exPos as any).positionAmt ?? exPos.quantity ?? "0"))
              const size = Math.abs(signedSize)
              if (!size || size <= 0) continue
              // Determine direction. BingX returns "LONG"/"SHORT" in
              // `positionSide`; some venues encode via signed size.
              const direction = normalizeExchangePositionDirection(
                (exPos as any).positionSide,
                exPos.side,
                signedSize,
              )
              if (!direction) continue

              const mapKey = `${sym}|${direction}`
              if (trackedKeys.has(mapKey)) continue // already tracked
              // ORPHAN — adopt it.
              const entryPrice = parseFloat(
                String(exPos.entryPrice ?? (exPos as any).avgPrice ?? exPos.markPrice ?? "0"),
              ) || parseFloat(String(exPos.markPrice ?? "0")) || 0
              if (!entryPrice || entryPrice <= 0) continue
              const markPrice = parseFloat(String(exPos.markPrice ?? entryPrice)) || entryPrice
              const leverage = Math.max(1, parseFloat(String(exPos.leverage ?? "1")) || 1)
              const notional = size * entryPrice
              const marginType: "cross" | "isolated" =
                String(exPos.marginType ?? "isolated").toLowerCase().includes("cross") ? "cross" : "isolated"

              const adoptedId = `live:${connectionId}:adopted:${sym}:${direction}:${Date.now()}:${nanoid(8)}`
              const adopted: LivePosition = {
                id: adoptedId,
                connectionId,
                system_tracking_id: String(exPos.system_tracking_id ?? (exPos as any).systemTrackingId ?? ""),
                connection_tracking_id: String(exPos.connection_tracking_id ?? (exPos as any).connectionTrackingId ?? ""),
                symbol: sym,
                direction,
                realPositionId: adoptedId, // self-reference — no Real-stage parent
                quantity: size,
                executedQuantity: size,
                remainingQuantity: 0,
                entryPrice,
                averageExecutionPrice: entryPrice,
                volumeUsd: notional,
                leverage,
                marginType,
                stopLoss: defaultSlPct,
                takeProfit: defaultTpPct,
                assignedStopLoss: defaultSlPct,
                assignedTakeProfit: defaultTpPct,
                status: "open", // exchange confirms the fill — start in "open"
                statusReason: "adopted_from_exchange",
                fills: [
                  {
                    timestamp: Date.now(),
                    quantity: size,
                    price: entryPrice,
                    fee: 0,
                    feeAsset: "",
                  },
                ],
                exchangeData: {
                  markPrice,
                  liquidationPrice: parseRedisFiniteNumber(exPos.liquidationPrice),
                  unrealizedPnL: parseRedisFiniteNumber(exPos.unrealizedProfit ?? exPos.unrealizedPnl),
                  syncedAt: Date.now(),
                },
                progression: [
                  {
                    step: "adopt",
                    timestamp: Date.now(),
                    success: true,
                    details: `Adopted system-tracked exchange position size=${size} @ ${entryPrice} (default SL=${defaultSlPct}% TP=${defaultTpPct}%)`,
                  },
                ],
                createdAt: Date.now(),
                updatedAt: Date.now(),
              } as LivePosition

              await savePosition(adopted)
              adoptedCount++
              await incrementMetric(connectionId, "live_positions_adopted_count")
              await logProgressionEvent(
                connectionId,
                "live_trading",
                "warning",
                `Adopted system-tracked exchange position ${sym} ${direction} — applying default SL=${defaultSlPct}% TP=${defaultTpPct}%`,
                { positionId: adoptedId, size, entryPrice, markPrice, leverage },
              )
              // Push adopted position into openPositions so the per-position
              // loop below arms SL/TP on it RIGHT NOW (don't wait for the
              // next 5 s sync tick — the operator's stranded position
              // needs protection immediately).
              openPositions.push(adopted)
            } catch (orphanErr) {
              console.warn(
                `${LOG_PREFIX} Orphan adoption failed:`,
                orphanErr instanceof Error ? orphanErr.message : String(orphanErr),
              )
            }
          }
          if (adoptedCount > 0) {
            console.log(`${LOG_PREFIX} Adopted ${adoptedCount} untracked exchange position(s) for ${connectionId}`)
          }
        }
      }
    // ─�� end orphan adoption ────────────────────��──────────────────────

    if (openPositions.length === 0) {
      // Nothing to sync after adoption — fire-and-forget the TTL expiry
      // sweep so we return immediately (no exchange call latency on idle path).
      orphanCloseExpiredPositions(connectionId, exchangeConnector, undefined as any).catch(() => {})
      return
    }

    console.log(`${LOG_PREFIX} Syncing ${openPositions.length} open/placed positions with exchange (adopted=${adoptedCount})`)

    // ── Build a direction-keyed exchange-position map (P0 fix) ────────
    // Previously the per-position loop called `getPosition(position.symbol)`
    // which on hedge-mode accounts returns `positions[0]` for the symbol
    // — regardless of whether the caller wanted LONG or SHORT. That meant:
    //   * If user had LONG only, `positions[0]` was LONG → fine.
    //   * If user had SHORT only, `positions[0]` was SHORT → fine.
    //   * If user had BOTH (hedge), `positions[0]` was always the one
    //     BingX returned first → markPrice cross-contamination between
    //     the two legs AND no way to detect when one leg externally
    //     closed (the other leg's data masked the close).
    //   * If user had NONE (closed externally), `getPositions(symbol)`
    //     could still return a flat zero-size entry, making
    //     `if (exchangePos)` truthy and silently keeping the Redis record
    //     "open" forever — the operator's repeated "Live Positions are
    //     still not getting closed" complaint.
    //
    // Now: we already fetched the full positions array up top for orphan
    // adoption. Reuse it to build a `(symbol|direction) → exchangePos` map
    // with size>0 filter applied, same shape `reconcileLivePositions`
    // uses. One batch fetch covers both adoption AND per-position sync.
    const normSym = (raw: string) => String(raw || "").toUpperCase().replace(/[-_]/g, "")
    const exchangeMap = new Map<string, any>()
    for (const ep of exchangePositions) {
      const sym = normSym(String(ep.symbol || (ep as any).Symbol || ""))
      if (!sym) continue
      const signedSize = parseFloat(String(ep.size ?? (ep as any).positionAmt ?? ep.quantity ?? "0"))
      const size = Math.abs(signedSize)
      if (!size || size <= 0) continue // skip flat / zero-size entries
      const direction = normalizeExchangePositionDirection(
        (ep as any).positionSide,
        ep.side,
        signedSize,
      )
      if (!direction) continue
      exchangeMap.set(`${sym}|${direction}`, ep)
    }
    const executionSlotsByPhysicalSlot = new Map<string, Set<string>>()
    for (const position of openPositions) {
      const physicalSlot = `${normSym(position.symbol)}|${position.direction}`
      const slots = executionSlotsByPhysicalSlot.get(physicalSlot) ?? new Set<string>()
      slots.add(liveExecutionSlot(position))
      executionSlotsByPhysicalSlot.set(physicalSlot, slots)
    }

    // liveOrderIdsSync was fetched in the parallel prefetch above.
    // No separate serial call needed here.

    // Positions tagged as stuck-in-placed are collected here and
    // processed in a parallel batch AFTER the main loop so they don't
    // block protection-order updates for healthy positions.
    const stuckPositions: Array<{ position: LivePosition; placedAgeMs: number; STUCK_PLACED_MAX_MS: number }> = []

    // ── Parallelised per-position sync (bounded concurrency) ────────────
    // Target: all positions complete in <1 s total.
    //
    // SYNC_CONCURRENCY: Max concurrent positions to sync in parallel.
    // Reduced from 12 to 5: with 13 positions each making 1–3 API calls
    // (getOrder, placeStop, getPositions), 12-wide concurrency fires 30+
    // simultaneous requests which saturates BingX's per-IP bucket and causes
    // cascading timeouts.  5 concurrent × ~3 s/pos = ~8 s total for 13 pos.
    const SYNC_CONCURRENCY = 5
    
    // SYNC_PER_POS_TIMEOUT_MS: Per-position sync timeout.
    // Individual operation timeouts: getOrder=12s, placeStop=60s.
    // exchange-close (35s×2=70s) is now skipped for stuck_in_placed and
    // exchange_externally_closed paths, so the worst case is a single
    // placeStop(60s) + getPositions(~3s) = 63s. Use 45s as the cap:
    // placeStop already has executeTimeoutMs inside the rate-limiter slot
    // (starts at dispatch, not at enqueue), so the effective cap is higher
    // than it appears. Positions that need a full close still use the
    // closeLivePosition path with its own 35s internal timeout.
    const SYNC_PER_POS_TIMEOUT_MS = 45_000

    const processOneSync = async (position: LivePosition): Promise<void> => {
      try {
        // RC3: Re-check position exists after async context switch
        // Another thread might have deleted it during our awaits
        if (!position || !position.id) return
        
        // RC1: Skip if already closed or locked
        if (
          position.status === "closed" ||
          (position.lockedAt && position.lockedAt > Date.now() - (POSITION_MUTATION_LOCK_TTL_MS + 1_000))
        ) {
          return
        }
        
        const mapKey = `${normSym(position.symbol)}|${position.direction}`
        const parallelExecutionLanes = (executionSlotsByPhysicalSlot.get(mapKey)?.size || 0) > 1
        const exchangePos = exchangeMap.get(mapKey)
        if (!exchangePos) {
          if (!recordExchangeAbsence(position)) return
        } else {
          clearExchangeAbsence(position)
        }
        if (position.status === "closing" || position.status === "closing_partial") {
          const lockedAt = Number(position.lockedAt || 0)
          if (lockedAt > 0 && Date.now() - lockedAt <= POSITION_MUTATION_LOCK_TTL_MS + 1_000) return
          const exitPrice = Number(
            exchangePos?.markPrice ??
            exchangePos?.lastPrice ??
            position.exchangeData?.markPrice ??
            position.averageExecutionPrice ??
            position.entryPrice ??
            0,
          )
          await closeLivePosition(
            connectionId,
            position.id,
            exitPrice,
            exchangePos ? exchangeConnector : null,
            exchangePos ? "crash_recovery_pending_close" : "exchange_externally_closed",
          )
          return
        }
        if (exchangePos) {
          // Mirror reconcileLivePositions' field extraction so both paths
          // produce structurally identical exchangeData. Previously this
          // path stored raw strings under `markPrice` (no parseFloat) so
          // downstream `Number(position.exchangeData?.markPrice ?? 0)` —
          // while correct for plain numeric strings — silently coerced
          // BingX's occasional null/empty-string returns to 0, gating
          // the SL/TP cross check.
          const markPrice = parseRedisFiniteNumber(exchangePos.markPrice ?? exchangePos.indexPrice ?? exchangePos.lastPrice)
          const liqPrice  = parseRedisFiniteNumber(exchangePos.liquidationPrice ?? exchangePos.liqPrice)
          const uPnl      = parseRedisFiniteNumber(exchangePos.unrealizedProfit ?? exchangePos.unrealisedPnl ?? exchangePos.unrealizedPnl)
          position.exchangeData = {
            ...position.exchangeData,
            marginType: (exchangePos as any).marginType,
            markPrice: markPrice && markPrice > 0 ? markPrice : position.exchangeData?.markPrice,
            liquidationPrice: liqPrice && liqPrice > 0 ? liqPrice : position.exchangeData?.liquidationPrice,
            unrealizedPnL: uPnl ?? position.exchangeData?.unrealizedPnL,
            syncedAt: Date.now(),
          }
          // Recover averageExecutionPrice / entryPrice from exchange if the
          // stored value is 0 (happens after a restart where the Redis hash
          // had averageExecutionPrice=0 from an earlier partial write). Without
          // this, computeDesiredProtectionPrices returns desiredSl=0 and no
          // SL/TP orders are ever placed for those positions.
          const exEntry = parseFloat(
            String(exchangePos.entryPrice ?? (exchangePos as any).avgPrice ?? exchangePos.markPrice ?? "0"),
          ) || 0
          const authoritativeSize = Math.abs(parseFloat(String(
            exchangePos.size ?? (exchangePos as any).positionAmt ?? exchangePos.quantity ?? "0",
          ))) || 0
          if (exEntry > 0) {
            if (!(position.averageExecutionPrice > 0)) position.averageExecutionPrice = exEntry
            if (!(position.entryPrice > 0)) position.entryPrice = exEntry
          }
          if (!parallelExecutionLanes) {
            await reconcileAuthoritativeExchangeQuantity(position, authoritativeSize, exEntry)
          }
          position.submissionAbsentConfirmations = 0
          position.updatedAt = Date.now()
        } else if (
          // ── Externally-closed branch (THE missing close path) ──────
          // Exchange no longer reports the (symbol|direction) we have
          // tracked — the position closed externally (SL/TP fired, manual
          // close on the BingX UI, liquidation, etc.). Previously this
          // branch did not exist in `syncWithExchange`, so the realtime
          // tick path never detected external closures — only the 30 s-
          // throttled coordinator reconcile did. Operators on a healthy
          // engine therefore saw positions sit as "open" in Redis for up
          // to a full reconcile window after they were actually closed,
          // and on engines where the 30 s reconcile got skipped (rate-
          // limit drift, strategy flow error, coordinator pause) the
          // positions sat OPEN indefinitely.
          //
          // We only act when the entry definitely existed on the
          // exchange at SOME point — i.e. status is anything past
          // "placed" (open / filled / partially_filled with executed qty).
          // Positions still in "placed" status with no fill yet might
          // legitimately not show up on the exchange (the entry order is
          // still resting on the book, not a position). Those continue
          // to be promoted via the "Delayed-fill" block above when the
          // entry order does fill.
          position.executedQuantity > 0 &&
          (position.status === "open" ||
            position.status === "filled" ||
            position.status === "partially_filled")
        ) {
          // Resolve exit price using the same 4-step fallback chain
          // reconcileLivePositions uses, so PnL is honest whether the
          // exchange returned markPrice in the closing batch, we kept a
          // markPrice from the previous tick, the symbol's market_data
          // hash has fresh ticks, or we fall back to entryPrice.
          let exitPrice: number = Number(position.exchangeData?.markPrice) || position.averageExecutionPrice || 0
          if (exitPrice <= 0) {
            try {
              const mdHash = await client.hgetall(`market_data:${position.symbol}`)
              const mdPrice = parseFloat(String(mdHash?.lastPrice ?? mdHash?.price ?? mdHash?.close ?? "0"))
              if (mdPrice > 0) exitPrice = mdPrice
            } catch { /* fall through */ }
          }
          if (exitPrice <= 0) exitPrice = position.entryPrice || 0

          console.log(
            `${LOG_PREFIX} EXTERNALLY-CLOSED detected for ${position.symbol} ${position.direction} (id=${position.id}) — finalising in Redis`,
          )
          // Fire-and-forget ��� don't block the close path on a log write.
          logProgressionEvent(
            connectionId,
            "live_trading",
            "info",
            `Position ${position.symbol} no longer on exchange — closing in Redis (sync)`,
            {
              positionId: position.id,
              exitPrice,
              executedQuantity: position.executedQuantity,
              direction: position.direction,
            },
          ).catch(() => {})
          // closeLivePosition does the full terminal-state pipeline:
          // cancel orphan SL/TP, compute PnL/ROI, archive, release lock,
          // increment counters. Reason "exchange_externally_closed"
          // distinguishes it in the audit trail from cross-fires.
          //
          // Pass null connector: the position is already closed on the
          // exchange (SL/TP triggered), so the 2×35s exchange-close retry
          // inside closeLivePosition is guaranteed to either fail or be a
          // no-op. Skipping it keeps sync-done latency under 30s vs 70s+.
          try {
            await closeLivePosition(
              connectionId,
              position.id,
              exitPrice,
              null, // exchange already closed it — skip exchange-close leg
              "exchange_externally_closed",
            )
          } catch (closeErr) {
            console.warn(
              `${LOG_PREFIX} externally-closed close error for ${position.id}:`,
              closeErr instanceof Error ? closeErr.message : String(closeErr),
            )
          }
          return // closeLivePosition persisted terminal state — skip per-position setex
        }

        if (
          (position.status === "placed" || position.status === "pending_fill" || position.status === "placed_unconfirmed") &&
          !position.orderId
        ) {
          const clientOrderId = getTrackedClientOrderId(position, "entry")
          if (clientOrderId) {
            const recovered = await recoverEntryOrderByClientId(exchangeConnector, position.symbol, clientOrderId)
            if (recovered) {
              position.orderId = String(recovered.orderId || recovered.id)
              position.submissionState = "confirmed"
              position.submissionAbsentConfirmations = 0
              pushStep(position, "entry_submission_recovered", true, `orderId=${position.orderId} clientOrderId=${clientOrderId}`)
            } else if (!exchangePos && liveOrderIdsSync !== null && !liveOrderIdsSync.has(clientOrderId)) {
              position.submissionAbsentConfirmations = Number(position.submissionAbsentConfirmations || 0) + 1
              if (position.submissionAbsentConfirmations >= 2) {
                position.status = "rejected"
                position.submissionState = "confirmed"
                position.statusReason = "clientOrderId confirmed absent repeatedly; releasing durable slot"
                position.closeReason = position.statusReason
                position.closedAt = Date.now()
                pushStep(position, "entry_submission_absent", false, position.statusReason)
                await savePosition(position)
                if (position.liveLockToken) {
                  const direction = resolveLivePositionDirection(position)
                  if (direction) {
                    await releaseLock(connectionId, position.symbol, liveLockDirection(position), position.liveLockToken).catch(() => false)
                  }
                }
                return
              }
            }
          }
        }

        let justFilled = false
        if (
          exchangePos &&
          (position.status === "placed" || position.status === "pending_fill" || position.status === "placed_unconfirmed")
        ) {
          const exSize = Math.abs(parseFloat(String(exchangePos.size ?? (exchangePos as any).positionAmt ?? exchangePos.quantity ?? "0"))) || 0
          const exEntry = parseFloat(String(exchangePos.entryPrice ?? (exchangePos as any).avgPrice ?? exchangePos.markPrice ?? "0")) || 0
          if (exSize > 0 && !parallelExecutionLanes) {
            position.executedQuantity = exSize
            position.remainingQuantity = Math.max(0, (position.quantity || exSize) - exSize)
            position.averageExecutionPrice = exEntry || position.entryPrice
            position.status = "open"
            position.statusReason = `confirmed_position_fallback: sync saw exchange position size=${exSize} avg=${position.averageExecutionPrice}`
            position.updatedAt = Date.now()
            justFilled = true
            await recordFillCountersOnce(connectionId, position, position.symbol, position.direction || position.side || "")
            pushStep(position, "sync_fill_detected", true, position.statusReason)
          }
        }

        // ── Delayed-fill SL/TP arming ────����────────────────────���──��────
        // If the entry order was still pending when `executeLivePosition`
        // tried to place SL/TP, that step pushed `place_sl_tp = skipped`
        // and the position ended up `placed` with no protection orders.
        // When this loop now detects the order has filled, we transition
        // to `open` AND must arm SL/TP — otherwise the operator gets
        // an open exchange position with zero stop-loss / take-profit
        // protection. This was a real bug the user reported as
        // "TP/SL control orders are not working".
        if ((position.status === "placed" || position.status === "pending_fill" || position.status === "placed_unconfirmed") && position.orderId) {
          // Guard: connector may be null/uninitialised on the very first sync
          // tick after a restart (factory not yet called for this connectionId).
          // Skip fill-detection silently — the next tick will retry once the
          // connector is ready. Previously this threw "Cannot read properties of
          // null (reading 'getOrder')" which flooded the log on every sync tick
          // until the connector was initialised.
          if (!exchangeConnector || typeof exchangeConnector.getOrder !== "function") {
            // Connector not ready yet — skip, retry next sync tick.
          } else
          try {
            // Bounded — a hanging getOrder would block this position's
            // entire sync slot and delay every downstream close/heal step.
            // On timeout we just skip the fill detection for this tick;
            // the next sync will retry.
            const order = await withTimeout(
              exchangeConnector.getOrder(position.symbol, position.orderId) as Promise<any>,
              EXCHANGE_TIMEOUT_GET_ORDER_MS,
              `getOrder(${position.symbol} ${position.orderId})`,
            )
            const statusLower = String(order?.status ?? "").toLowerCase()
            const orderFilledQty = parseFloat(String(order?.filledQty ?? order?.executedQty ?? "0")) || 0
            if (order && (statusLower === "filled" || statusLower === "partially_filled" || orderFilledQty > 0)) {
              position.executedQuantity = orderFilledQty || order.filledQty || position.quantity
              position.remainingQuantity = Math.max(0, position.quantity! - position.executedQuantity)
              position.averageExecutionPrice = order.filledPrice || position.entryPrice
              position.status = "open"
              position.statusReason = `confirmed_fill: sync order status=${statusLower} qty=${position.executedQuantity}`
              pushStep(position, "sync_fill_detected", true, position.statusReason)
              position.updatedAt = Date.now()
              justFilled = true
              await recordFillCountersOnce(connectionId, position, position.symbol, position.direction || position.side || "")
              logProgressionEvent(
                connectionId,
                "live_trading",
                "info",
                `Sync detected fill for ${position.symbol}`,
                {
                  orderId: position.orderId,
                  filledQty: position.executedQuantity,
                }
              ).catch(() => {})
            } else if (order) {
              // Order exists but not filled (placed/partial/cancelled/rejected) —
              // log so the operator can see WHY the position stays in
              // "placed" status. Previously the only signal was the
              // position never progressing, which was indistinguishable
              // from a bug.
              console.log(
                `${LOG_PREFIX} [fill-detect] ${position.symbol} order ${position.orderId} status=${order.status} filledQty=${order.filledQty ?? 0} — staying in 'placed'`,
              )
            }
          } catch (fillErr) {
            // PREVIOUSLY SWALLOWED — this was the root cause of "orders
            // never closing": every getOrder failure left the position
            // stuck in `placed` forever, and the SL/TP cross check skips
            // `placed` positions silently (see checkAndForceCloseOnSltpCross
            // line "if (pos.status === 'placed') return null").
            // We now log so the failure is visible. The retry on next
            // sync tick still happens — no behaviour change, just
            // observability.
            console.warn(
              `${LOG_PREFIX} [fill-detect] getOrder failed for ${position.symbol} orderId=${position.orderId}:`,
              fillErr instanceof Error ? fillErr.message : String(fillErr),
            )
          }
        }

        // ── Stuck-in-placed detection ���────────────────────────────────
        // A position in `placed` status with no executed qty has its
        // entry order resting on the exchange book unfilled. The SL/TP
        // cross check skips `placed` positions silently, so without
        // this branch a stuck order could sit forever:
        //   - Never closes via SL/TP cross (status gate)
        //   - Never closes via max-hold-time (executedQty=0 gate)
        //   - Never adopted as orphan (it IS in Redis)
        //   - Never finalised as externally-closed (gate requires
        //     executedQty>0 + status≠placed)
        // Cancel the dangling entry order after STUCK_PLACED_MAX_MS and
        // mark the position rejected so it leaves the open index.
        // ── Stuck-in-placed: tag candidate, process in parallel batch below ──
        // Only TAG here and `continue`. The actual cancel+close runs in a
        // Promise.allSettled batch after the for loop so that N stuck
        // positions don't serialize for EXCHANGE_TIMEOUT_CANCEL_ORDER_MS × N
        // and block protection-order updates for all healthy positions.
        if ((position.status === "placed" || position.status === "pending_fill" || position.status === "placed_unconfirmed") && (position.executedQuantity ?? 0) === 0) {
          const STUCK_PLACED_MAX_MS = 5 * 60_000 // 5 minutes
          const placedAgeMs = Date.now() - (position.createdAt || position.updatedAt || Date.now())
          if (placedAgeMs > STUCK_PLACED_MAX_MS) {
            stuckPositions.push({ position, placedAgeMs, STUCK_PLACED_MAX_MS })
            return
          }
        }

        // Arm or refresh protection orders. `updateProtectionOrders` is
        // a no-op when nothing has drifted (price + qty stable, both
        // legs already armed at correct levels) so this is cheap on the
        // steady state. After a delayed fill (`justFilled`) it's a real
        // place; after accumulation it re-arms for the new total qty;
        // after an operator-cancelled SL on the exchange it re-places.
        if (position.executedQuantity > 0) {
          try {
            const protectionResult = await updateProtectionOrders(
              exchangeConnector,
              position,
              justFilled ? "sync_fill_detected" : "sync_heal",
              liveOrderIdsSync,
            )
            // Fire-and-forget persist — protection state (order IDs,
            // lastArmedAt) must be durable but the save does not need to
            // complete before we proceed to the SL/TP cross check. On a
            // crash the 7-day setex TTL means we lose at most one tick's
            // worth of protection metadata, which the next sync heals.
            if (protectionResult.changed) {
              savePosition(position).catch(() => {})
            }
          } catch (slTpErr) {
            console.warn(
              `${LOG_PREFIX} sync SL/TP heal error for ${position.id}:`,
              slTpErr instanceof Error ? slTpErr.message : String(slTpErr),
            )
          }
        }

        // ── Proactive close-in-time SL/TP check ────���──────────────────
        // Same safety net `reconcileLivePositions` runs, applied here
        // so the engine loop catches crosses between cron ticks. If a
        // cross fires we skip the per-position setex below — the close
        // helper already persisted the terminal state and moved the
        // index entry to the closed archive.
        const markPrice = Number(position.exchangeData?.markPrice ?? 0)
        if (markPrice > 0) {
          const crossed = await checkAndForceCloseOnSltpCross(
            connectionId,
            position,
            markPrice,
            exchangeConnector,
          )
          if (crossed) return
        }

        // ── Max-hold-time safety closer ────────────────────────────────
        // If the position has been open longer than MAX_HOLD_TIME_MS,
        // force-close it regardless of whether SL/TP levels were
        // crossed. This is the "orders not closing in time" safety net —
        // even if the exchange-placed SL/TP orders fail to fire (e.g.
        // network issue, illiquid gap, operator manual cancel), the
        // position will not be held indefinitely.
        //
        // Default: 4 hours. Live override via /settings → System →
        // Engine Timings → max_position_hold_ms (or deploy-time
        // MAX_POSITION_HOLD_MS env var). 0 = disabled.
        const MAX_HOLD_TIME_MS = resolveMaxHoldMs(connectionId)
        const openedAt = position.createdAt || position.updatedAt || 0
        const heldMs = Date.now() - openedAt
        if (
          MAX_HOLD_TIME_MS > 0 &&
          heldMs > MAX_HOLD_TIME_MS &&
          position.executedQuantity > 0 &&
          isSystemTrackedLivePosition(position, connectionId) &&
          (position.status === "open" || position.status === "filled")
        ) {
          const exitPrice = markPrice || position.averageExecutionPrice || position.entryPrice
          console.warn(
            `${LOG_PREFIX} MAX HOLD TIME exceeded for ${position.symbol} (held ${Math.round(heldMs / 60000)}min > ${Math.round(MAX_HOLD_TIME_MS / 60000)}min) — force-closing`,
          )
          // Fire-and-forget — close should not be gated on log write.
          logProgressionEvent(
            connectionId,
            "live_trading",
            "warning",
            `Max hold time exceeded for ${position.symbol} — force-closing`,
            { positionId: position.id, heldMs, maxHoldMs: MAX_HOLD_TIME_MS, exitPrice },
          ).catch(() => {})
          await closeLivePosition(connectionId, position.id, exitPrice, exchangeConnector, "max_hold_time_exceeded")
          return
        }

        const key = `live:position:${position.id}`
        await client.setex(key, 604800, JSON.stringify(position))
        emitCanonicalEvent({
          type: "live.stageChanged",
          connectionId: position.connectionId || connectionId,
          symbol: position.symbol,
          stage: "live",
          data: { positionId: position.id, status: position.status, action: "synced" },
        })
        await upsertRedisListHead(client, `live:positions:${position.connectionId}`, position.id)
        await client.expire(`live:positions:${position.connectionId}`, 604800)
      } catch (err) {
        console.warn(`${LOG_PREFIX} Error syncing ${position.id}:`, err)
      }
    }

    // ── Bounded parallel pool for processOneSync ─────────────────────────
    // Each worker picks the next unprocessed position by index; stops when
    // all positions are claimed. allSettled ensures one slow/failing
    // position never prevents the rest from completing.
    {
      let nextSyncIdx = 0
      const syncWorker = async (): Promise<void> => {
        while (true) {
          const i = nextSyncIdx++
          if (i >= openPositions.length) return
          await withTimeout(
            processOneSync(openPositions[i]),
            SYNC_PER_POS_TIMEOUT_MS,
            `syncWithExchange.processOneSync(${openPositions[i].symbol})`,
          ).catch((err: unknown) => {
            console.warn(
              `${LOG_PREFIX} [sync-pool] position ${openPositions[i]?.id} timed out or errored:`,
              err instanceof Error ? err.message : String(err),
            )
          })
        }
      }
      const poolSize = Math.min(SYNC_CONCURRENCY, openPositions.length)
      if (poolSize > 0) {
        await Promise.allSettled(Array.from({ length: poolSize }, () => syncWorker()))
      }
    }

    // Sync completion heartbeat. Pairs with the `[sync-tick]` entry log
    // so the operator can see the loop ran to completion (not silently
    // aborted by an uncaught throw) and how long it took. If [sync-tick]
    // appears but [sync-done] does not for the same tick, something
    // mid-loop is rejecting before the closing brace — which used to be
    // invisible.
    // ── Parallel stuck-placed cleanup ──────────��─────────────────────
    // Run all cancel+close operations concurrently so 6+ stuck positions
    // complete in ~one RTT window instead of EXCHANGE_TIMEOUT_CANCEL_ORDER_MS × N.
    if (stuckPositions.length > 0) {
      console.warn(
        `${LOG_PREFIX} [stuck-placed] Processing ${stuckPositions.length} stuck-in-placed position(s) in parallel`,
      )
      await Promise.allSettled(
        stuckPositions.map(async ({ position, placedAgeMs, STUCK_PLACED_MAX_MS }) => {
          console.warn(
            `${LOG_PREFIX} [stuck-placed] ${position.symbol} (id=${position.id}) has been 'placed' for ${Math.round(placedAgeMs / 1000)}s — cancelling entry order and rejecting position`,
          )
          // Fire-and-forget — log should not delay cancel + close.
          logProgressionEvent(
            connectionId,
            "live_trading",
            "warning",
            `Entry order stuck in 'placed' state for ${position.symbol} — cancelling`,
            {
              positionId: position.id,
              orderId: position.orderId,
              placedAgeMs,
              stuckLimitMs: STUCK_PLACED_MAX_MS,
            },
          ).catch(() => {})
          // Best-effort cancel of the entry order (bounded timeout).
          // Track whether the cancel succeeded — if it timed out we skip
          // the exchange-close leg to avoid blocking another 70 s (2 × 35 s)
          // on an already-unresponsive exchange.
          let cancelSucceeded = false
          if (position.orderId && exchangeConnector?.cancelOrder) {
            try {
              await withTimeout(
                exchangeConnector.cancelOrder(position.symbol, position.orderId) as Promise<any>,
                EXCHANGE_TIMEOUT_CANCEL_ORDER_MS,
                `stuck-placed cancelOrder(${position.symbol} ${position.orderId})`,
              )
              cancelSucceeded = true
            } catch (cancelErr) {
              console.warn(
                `${LOG_PREFIX} [stuck-placed] cancel entry order failed for ${position.id}:`,
                cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
              )
            }
          }
          // Mark position rejected and remove from open index.
          // If cancelOrder timed out the exchange is unresponsive — skip
          // the exchange-close (pass null connector) to avoid another 70 s
          // wait. The position is DB-closed immediately; the exchange side
          // will self-heal when the order expires or the next sync detects it.
          const closeConnector = cancelSucceeded ? exchangeConnector : null
          try {
            await closeLivePosition(
              connectionId,
              position.id,
              position.entryPrice || 0,
              closeConnector,
              "stuck_in_placed",
            )
          } catch (closeErr) {
            console.warn(
              `${LOG_PREFIX} [stuck-placed] closeLivePosition failed for ${position.id}:`,
              closeErr instanceof Error ? closeErr.message : String(closeErr),
            )
          }
        }),
      )
    }

    const syncMs = Date.now() - syncStartMs
    console.log(
      `${LOG_PREFIX} [sync-done] conn=${connectionId} took=${syncMs}ms processed=${openPositions.length} adopted=${adoptedCount}`,
    )
  } catch (err) {
    console.error(`${LOG_PREFIX} Error syncing with exchange:`, err)
  } finally {
    stopSyncLockLeaseRefresh?.()
    if (lockAcquired && client) {
      try {
        await evalLockLua(client, RELEASE_LOCK_LUA, LIVE_SYNC_LOCK_KEY, [syncLockToken])
      } catch (releaseErr) {
        // Lock will expire via TTL — log but don't surface.
        console.warn(
          `${LOG_PREFIX} [sync-lock] release failed for ${connectionId}; TTL will reap:`,
          releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        )
      }
    }
  }
}

/**
 * Recalculate the desired SL/TP for a single live position and apply
 * the change to the exchange. Used by the strategy coordinator when an
 * operator edits SL/TP percentages on an active connection — without
 * this, the exchange-side levels stay glued to the original fill and
 * the change only affects newly-opened positions.
 *
 * Pass updated `stopLossPct` / `takeProfitPct` to override the values
 * stored on the live position; omit them to recompute from whatever
 * is currently on the LivePosition record (useful as a "force-heal"
 * after a missed reconcile).
 *
 * Returns `null` if the position doesn't exist or is already closed.
 */
export async function recalculateAndApplySLTP(
  connectionId: string,
  livePositionId: string,
  exchangeConnector: any,
  overrides?: {
    stopLossPct?: number
    takeProfitPct?: number
    trailingActive?: boolean
    trailingStopPrice?: number
    manualProtection?: {
      stopLossPrice?: number | null
      takeProfitPrice?: number | null
      trailingEnabled?: boolean
      trailingDistancePct?: number
    }
    clearManualProtection?: boolean
  },
): Promise<LivePosition | null> {
  await initRedis()
  const client = getRedisClient()

  // ── Bug-1 fix: acquire live_sync_lock BEFORE the read-modify-write ────────
  // Without this lock, `recalculateAndApplySLTP` (called from
  // `syncLiveFromPseudo` in the 200 ms engine loop) races against
  // `reconcileLivePositions` / `syncWithExchange`, both of which also hold
  // this lock while calling `updateProtectionOrders` for the same position.
  // The race produces two concurrent `placeStopOrder` calls → two SL or two
  // TP reduce-only orders on the exchange. The later `savePosition` then
  // overwrites the in-memory position, losing the order-IDs written by the
  // other caller. Holding the lock here serialises all three callers.
  //
  // If the lock is already held (main loop is mid-reconcile), we retry once
  // after 100 ms so operator-triggered overrides still apply promptly in the
  // gap between ticks rather than silently no-opping.
  const LOCK_KEY = `live_sync_lock:${connectionId}`
  const LOCK_TTL = 30
  const lockToken = `recalc:${process.pid}:${Date.now()}:${nanoid(10)}`
  let lockAcquired = false
  let stopLockLeaseRefresh: (() => void) | null = null
  // Fast bounded contention wait: most sync passes complete inside one
  // 200–300 ms cadence. Never overlap a still-running reconcile; if it remains
  // busy, the next pseudo ratchet/sync pass retries from durable state.
  for (let attempt = 0; attempt < 5; attempt++) {
    const setResult = await (client.set(LOCK_KEY, lockToken, { NX: true, EX: LOCK_TTL }) as any)
    if (setResult === "OK") { lockAcquired = true; break }
    if (attempt < 4) await new Promise(r => setTimeout(r, 50))
  }
  if (!lockAcquired) {
    // Lock still held after one retry — skip this tick; the main sync loop
    // will re-arm orders correctly on its next pass.
    console.warn(`${LOG_PREFIX} recalculateAndApplySLTP: lock busy for ${connectionId}, skipping tick`)
    return null
  }
  stopLockLeaseRefresh = startRedisLockLeaseRefresh(
    client,
    LOCK_KEY,
    lockToken,
    LOCK_TTL * 1000,
  )

  try {
    const key = `live:position:${livePositionId}`
    // Re-read the position AFTER acquiring the lock so we see any writes the
    // previous lock-holder (reconcile / sync) just committed to Redis.
    const data = await client.get(key)
    if (!data) return null

    const position: LivePosition = JSON.parse(data as string)
    if (
      position.status === "closed" ||
      position.status === "rejected" ||
      position.status === "error" ||
      position.executedQuantity <= 0
    ) {
      return position
    }

    // `syncLiveFromPseudo` is intentionally fire-and-forget so it never
    // blocks the realtime tick. Two ratchets can therefore reach this locked
    // read-modify-write path out of order. Reject an older absolute level here
    // (after rereading Redis under the lock) rather than allowing it to loosen
    // an already tightened long/short stop on the exchange.
    const isAutomatedTrailingSync =
      !overrides?.manualProtection &&
      !overrides?.clearManualProtection &&
      overrides?.trailingActive === true &&
      Object.prototype.hasOwnProperty.call(overrides || {}, "trailingStopPrice")
    if (isAutomatedTrailingSync && !isTrailingStopTightening(position, overrides?.trailingStopPrice)) {
      return position
    }

    // Capture pre-override values so we can audit the diff in progression.
    // Note: we deliberately do NOT touch `assignedStopLoss` /
    // `assignedTakeProfit` — those are the immutable strategy-contract
    // snapshot. After this call they remain equal to their creation-time
    // values while `stopLoss` / `takeProfit` carry the operator override.
    const prevStopLossPct = position.stopLoss
    const prevTakeProfitPct = position.takeProfit
    const previousManualProtection = position.manualProtectionOverride
      ? { ...position.manualProtectionOverride }
      : undefined
    if (overrides?.clearManualProtection) {
      position.manualProtectionOverride = undefined
      position.trailingActive = false
      position.trailingStopPrice = undefined
    }
    if (overrides?.manualProtection) {
      const incoming = overrides.manualProtection
      const previous = position.manualProtectionOverride
      const next: NonNullable<LivePosition["manualProtectionOverride"]> = {
        ...(previous || { updatedAt: Date.now(), source: "operator" as const }),
        updatedAt: Date.now(),
        source: "operator",
      }
      if (Object.prototype.hasOwnProperty.call(incoming, "stopLossPrice")) {
        const value = incoming.stopLossPrice
        next.stopLossPrice = value === null ? null : Number(value)
      }
      if (Object.prototype.hasOwnProperty.call(incoming, "takeProfitPrice")) {
        const value = incoming.takeProfitPrice
        next.takeProfitPrice = value === null ? null : Number(value)
      }
      if (Object.prototype.hasOwnProperty.call(incoming, "trailingEnabled")) {
        next.trailingEnabled = incoming.trailingEnabled === true
      }
      if (Object.prototype.hasOwnProperty.call(incoming, "trailingDistancePct")) {
        next.trailingDistancePct = Number(incoming.trailingDistancePct)
      }
      position.manualProtectionOverride = next
      position.trailingActive = next.trailingEnabled === true
      if (!position.trailingActive) position.trailingStopPrice = undefined
    }
    const normalizedOverrideSl = overrides?.stopLossPct !== undefined
      ? normalizeStopLossPercent(overrides.stopLossPct)
      : null
    if (normalizedOverrideSl) position.stopLoss = normalizedOverrideSl.value
    if (overrides?.takeProfitPct !== undefined) position.takeProfit = overrides.takeProfitPct
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, "trailingActive")) {
      position.trailingActive = overrides.trailingActive === true
    }
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, "trailingStopPrice")) {
      const nextTrailingStop = Number(overrides.trailingStopPrice)
      position.trailingStopPrice = Number.isFinite(nextTrailingStop) && nextTrailingStop > 0
        ? nextTrailingStop
        : undefined
    }

    const slChanged = position.stopLoss !== prevStopLossPct
    const tpChanged = position.takeProfit !== prevTakeProfitPct
    const manualProtectionChanged = JSON.stringify(previousManualProtection) !== JSON.stringify(position.manualProtectionOverride)
    if (slChanged || tpChanged || manualProtectionChanged) {
      // Single audit-trail event per override. The progression panel
      // shows it as a `live_trading info` row alongside the subsequent
      // `update_sl_tp` step pushed by `updateProtectionOrders`. Together
      // they tell the full story: "operator changed SL from X% to Y%,
      // exchange order re-armed at price Z".
      await logProgressionEvent(
        position.connectionId,
        "live_trading",
        "info",
        `SL/TP override applied to ${position.symbol}`,
        {
          assignedStopLossPct: position.assignedStopLoss,
          assignedTakeProfitPct: position.assignedTakeProfit,
          previousStopLossPct: prevStopLossPct,
          previousTakeProfitPct: prevTakeProfitPct,
          newStopLossPct: position.stopLoss,
          newTakeProfitPct: position.takeProfit,
          stopLossNormalized: normalizedOverrideSl?.adjusted || false,
          stopLossNormalizationReason: normalizedOverrideSl?.reason,
          slChanged,
          tpChanged,
          manualProtectionChanged,
          manualProtectionOverride: position.manualProtectionOverride,
        },
      )
    }

    // Direct override/trailing updates already know the recorded order IDs and
    // intentionally avoid an extra open-orders snapshot RTT on the critical
    // path. cancelProtectionOrder treats already-gone IDs as success; the
    // 200 ms canonical sync independently performs full liveness healing.
    ratchetManualTrailingStop(position)
    await updateProtectionOrders(exchangeConnector, position, "manual_recalc", null)
    position.updatedAt = Date.now()
    await savePosition(position)

    // ── Immediate post-override cross check ────────────────────────────
    // If the operator just tightened SL or TP to a level the position
    // is already past, the exchange-placed reduce-only order may take
    // a moment to fire (or be rejected outright as "trigger price
    // already breached"). Run the same proactive close helper used by
    // the engine loop so the position is reconciled to closed within
    // the same call rather than waiting for the next cron tick.
    try {
      const markPrice = Number(position.exchangeData?.markPrice ?? 0)
      if (markPrice > 0) {
        await checkAndForceCloseOnSltpCross(
          position.connectionId,
          position,
          markPrice,
          exchangeConnector,
        )
      }
    } catch (crossErr) {
      console.warn(
        `${LOG_PREFIX} post-override cross check error for ${position.id}:`,
        crossErr instanceof Error ? crossErr.message : String(crossErr),
      )
    }
    return position
  } catch (err) {
    console.error(`${LOG_PREFIX} recalculateAndApplySLTP error:`, err)
    return null
  } finally {
    stopLockLeaseRefresh?.()
    // Token-checked release: an old slow call must never delete a newer
    // reconcile owner's lock after its own lease changed hands.
    if (lockAcquired) {
      await evalLockLua(client, RELEASE_LOCK_LUA, LOCK_KEY, [lockToken]).catch(() => 0)
    }
  }
}

/**
 * Decode a pseudo-position protection contract into market-price percents.
 *
 * Current pseudo positions persist explicit `*_pct` fields alongside the
 * legacy factor/ratio fields. Those explicit values are authoritative even
 * below one percent: a 0.8% Signal stop must never be misread as the decimal
 * ratio 0.8 (= 80%). Older rows without explicit fields retain the documented
 * ratio-or-percent compatibility fallback.
 */
function resolvePseudoProtectionPercents(pseudoPos: any): {
  slPct: number | undefined
  tpPct: number | undefined
} {
  const explicitSlPct = Number(pseudoPos?.stoploss_pct ?? pseudoPos?.stopLossPct)
  const explicitTpPct = Number(pseudoPos?.takeprofit_pct ?? pseudoPos?.takeProfitPct)
  const rawSL = Number(pseudoPos?.stoploss_ratio ?? pseudoPos?.stopLoss ?? NaN)
  const rawTP = Number(pseudoPos?.takeprofit_factor ?? pseudoPos?.takeProfit ?? NaN)
  const coordinate = String(
    pseudoPos?.protection_coordinate ?? pseudoPos?.takeprofit_coordinate ?? "",
  ).trim().toLowerCase()
  const asNonNegativePct = (value: number): number | undefined =>
    Number.isFinite(value) ? Math.max(0, value) : undefined

  if (Number.isFinite(explicitSlPct) || Number.isFinite(explicitTpPct)) {
    return {
      slPct: asNonNegativePct(explicitSlPct),
      tpPct: asNonNegativePct(explicitTpPct),
    }
  }

  if (coordinate === "position_cost_ratio") {
    const positionCostPct = normalizePositionCostPercent(
      pseudoPos?.position_cost_pct ?? pseudoPos?.positionCostPct,
    )
    return {
      slPct: asNonNegativePct(
        stopLossPositionCostRatioToPercent(positionCostPct, rawTP, rawSL),
      ),
      tpPct: asNonNegativePct(
        takeProfitPositionCostRatioToPercent(positionCostPct, rawTP),
      ),
    }
  }

  const legacyPercent = (value: number): number | undefined => {
    if (!Number.isFinite(value)) return undefined
    // Legacy ratio form used `0.02` for 2%; literal percent values were
    // stored as 1, 2, … . Prefer the explicit fields above whenever present.
    return Math.max(0, Math.abs(value) < 1 ? value * 100 : value)
  }
  return {
    slPct: legacyPercent(rawSL),
    tpPct: legacyPercent(rawTP),
  }
}

/**
 * ── syncLiveFromPseudo (spec §6) ───────────────────────────────���─────
 *
 * Copy SL/TP percentages from a pseudo (strategy-side virtual) position
 * onto matching live (exchange-side real) positions on the same
 * symbol + direction, then re-arm the exchange protection orders so
 * the new levels are actually enforced.
 *
 * Operator: "pseudo pos updates with trailing, steps etc is working
 * completely correct and live pos are correctly synchron". That's the
 * target — this helper closes the gap between strategy-side trailing
 * and exchange-side SL/TP by piping percent updates through to
 * `recalculateAndApplySLTP`, which already does
 * cancel-old → place-new → persist + audit.
 *
 * Inputs:
 *   - `pseudoPos.symbol` (string, required) and `pseudoPos.side`
 *     ("long" | "short") — match key against live positions.
 *   - Current pseudo rows use `stoploss_pct` / `takeprofit_pct` as the
 *     unambiguous market-price percentage contract (including values below
 *     one percent). Legacy factor/ratio rows are decoded only when those
 *     explicit fields are absent.
 *
 * Idempotent: if percentages unchanged `recalculateAndApplySLTP`
 * no-ops on the diff. Per-position errors are swallowed.
 *
 * Caller contract: fire-and-forget. Returns `Promise<void>` and never
 * throws past this boundary — the realtime hot path must NEVER await
 * on exchange round-trips.
 */
export async function syncLiveFromPseudo(
  connectionId: string,
  pseudoPos: any,
  exchangeConnector: any,
): Promise<void> {
  try {
    // ─��� System tracking validation ──
    // Only sync positions created by this system. Skip foreign/manual orders.
    const trackingId = String(pseudoPos?.system_tracking_id || "").trim()
    if (!trackingId.startsWith("sys-") || trackingId.length <= 10) {
      // Silent skip - don't log every foreign position on every tick
      return
    }

    const symbol = String(pseudoPos?.symbol || "").toUpperCase()
    const side = normalizeLiveTradeDirection(pseudoPos?.direction, pseudoPos?.side)
    if (!symbol || !side) return

    const { slPct, tpPct } = resolvePseudoProtectionPercents(pseudoPos)
    if (slPct === undefined && tpPct === undefined) return

    // ── Trailing-aware SL pull-through ���───────���─────────────────────
    // When the pseudo's trailing-stop machine is ARMED (multi-step
    // `trailing_active=1` or legacy `trailing_stop_price>0`), the
    // effective stop level is no longer `stoploss_ratio × fillPrice`
    // — it's the ratcheted `trailing_stop_price`. Pulling the static
    // ratio through here would cause every trailing tick to fight
    // against itself, repeatedly resetting the live SL back to the
    // origin level. Convert the active trailing stop price into a
    // live-position-relative percentage by anchoring it to the LIVE
    // position's actual fill price (entry-side). The percent space
    // is what `recalculateAndApplySLTP` consumes.
    const trailingActive =
      pseudoPos?.trailing_active === "1" ||
      pseudoPos?.trailing_active === true ||
      (() => {
        const ts = parseFloat(String(pseudoPos?.trailing_stop_price || "0"))
        return Number.isFinite(ts) && ts > 0
      })()
    const trailingStopPrice = parseFloat(String(pseudoPos?.trailing_stop_price || "0"))

    // ── Set-scoped match (BUG 6) ───────────���──────────────────────────
    // Identify the Real Set that owns THIS pseudo position. Several pseudo
    // positions (distinct Sets) can target the same symbol+side slot; the
    // dedup lock collapses them onto ONE live position. Matching by
    // symbol+side alone would let every Set's trailing tick rewrite that
    // single live position's SL/TP with its own level, making the stop
    // flap between unrelated Sets. Scope the match to the owning Set's key
    // so each pseudo only steers the live position it actually backs.
    const pseudoSetKey = String(
      pseudoPos?.strategy_set_key ||
      pseudoPos?.strategySetKey ||
      pseudoPos?.set_id ||
      pseudoPos?.config_set_key ||
      pseudoPos?.source_set_key ||
      "",
    ).trim()
    const pseudoExecutionLane = resolveSignalExecutionLane({
      executionLane: pseudoPos?.execution_lane ?? pseudoPos?.executionLane,
      indicationType: pseudoPos?.indication_type ?? pseudoPos?.indicationType,
      trailingProfile: pseudoPos?.trailing_mode === "signal_dynamic"
        ? {
            mode: "signal_dynamic",
            startRatio: Number(pseudoPos?.trailing_start_ratio || 0),
            stopRatio: Number(pseudoPos?.trailing_stop_ratio || 0),
            stepRatio: Number(pseudoPos?.trailing_step_ratio || 0),
          }
        : undefined,
    })

    const livePositions = await getLivePositions(connectionId)
    const slotMatches = livePositions.filter((p: any) => {
      const liveSide = resolveLivePositionDirection(p)
      return String(p.symbol || "").toUpperCase() === symbol &&
        liveSide === side &&
        liveExecutionLane(p) === pseudoExecutionLane &&
        p.status !== "closed"
    })
    if (slotMatches.length === 0) return

    // Prefer live positions whose setKey/parentSetKey/accumulatedSetKeys
    // match this pseudo's owning Set. Accumulated live positions can carry
    // multiple Base/trailing/axis Sets; every owning Set must be allowed to
    // advance its trailing ratchet and rebuild the correct control orders.
    // Only fall back to the unscoped slot matches when NONE of them carry a
    // set key we can compare against (legacy positions written
    // before setKey propagation) or when the pseudo itself has no set id —
    // in those cases symbol+side is the best signal available, preserving
    // backward-compatible behaviour without silently dropping the sync.
    let matches = slotMatches
    if (pseudoSetKey) {
      const scoped = slotMatches.filter((p: any) => {
        const liveKeys = new Set<string>()
        for (const key of [p.setKey, p.parentSetKey]) {
          const normalized = String(key || "").trim()
          if (normalized) liveKeys.add(normalized)
        }
        const accumulated = Array.isArray(p.accumulatedSetKeys) ? p.accumulatedSetKeys : []
        for (const key of accumulated) {
          const normalized = String(key || "").trim()
          if (normalized) liveKeys.add(normalized)
        }
        return liveKeys.has(pseudoSetKey)
      })
      const anyLiveKeyed = slotMatches.some((p: any) => {
        if (String(p.setKey || p.parentSetKey || "").trim().length > 0) return true
        return Array.isArray(p.accumulatedSetKeys) && p.accumulatedSetKeys.some((key: any) => String(key || "").trim().length > 0)
      })
      if (scoped.length > 0) {
        matches = scoped
      } else if (anyLiveKeyed) {
        // Live positions ARE keyed, but none belong to this Set → this
        // pseudo does not own the slot's live exposure. Do not touch it.
        return
      }
      // else: no live position is keyed → fall back to slot matches.
    }
    if (matches.length === 0) return

    // Parallelize across matching live positions — each position's
    // SL/TP recalculation is independent. The previous serial for-loop
    // caused 200–1200ms blocking per trailing stop update (200ms +
    // exchange RTTs per position). Cap at 4 concurrent so we don't
    // hammer the exchange API in a single tick.
    const MAX_CONCURRENT_SLTP = 4
    let nextIdx = 0
    const worker = async (): Promise<void> => {
      while (true) {
        const i = nextIdx++
        if (i >= matches.length) return
        const livePos = matches[i]
        try {
          // An operator override is a durable control contract. The normal
          // pseudo-position sync must not overwrite it on the next 200 ms tick;
          // updateProtectionOrders owns its absolute SL/TP and trailing ratchet
          // until the operator explicitly restores strategy defaults.
          if (livePos.manualProtectionOverride) continue
          // Fast-path stale guard. The locked recalculation path performs the
          // same check again against a fresh Redis read; this early skip avoids
          // unnecessary venue work when an older fire-and-forget ratchet
          // arrives after a tighter one has already been persisted.
          if (
            trailingActive &&
            trailingStopPrice > 0 &&
            !isTrailingStopTightening(livePos, trailingStopPrice)
          ) continue
          let effectiveSlPct = slPct
          // CRITICAL: Guard trailing stop calculation against NaN and division errors
          if (trailingActive && Number.isFinite(trailingStopPrice) && trailingStopPrice > 0) {
            const fill = Number(livePos.averageExecutionPrice || livePos.entryPrice || 0)
            // Ensure fill price is valid and positive before using in division
            if (Number.isFinite(fill) && fill > 0) {
              const liveSide = resolveLivePositionDirection(livePos)
              if (!liveSide) continue
              // Distance from fill to the trailing stop expressed as a
              // percentage of the fill price (always positive regardless of
              // direction — the trailing machine ensures trailingStopPrice
              // is below fill for longs and above fill for shorts).
              let distPct: number
              if (liveSide === "long") {
                distPct = ((fill - trailingStopPrice) / fill) * 100
              } else {
                distPct = ((trailingStopPrice - fill) / fill) * 100
              }
              // Guard against NaN from division or calculation errors, and
              // ensure distPct is positive (should always be for valid trailing levels)
              if (Number.isFinite(distPct) && distPct > 0) {
                effectiveSlPct = distPct
              } else if (!Number.isFinite(distPct)) {
                // If distPct is NaN or Infinity, log it but keep current SL percentage
                console.warn(
                  `${LOG_PREFIX} distPct is ${distPct} for ${livePos.symbol} (fill=${fill}, trailing=${trailingStopPrice}, side=${liveSide})`
                )
              }
            }
          }

          // ── Stamp trailing state onto the live position ───────────────────
          // Write trailingActive + trailingStopPrice from the pseudo position
          // so that computeDesiredProtectionPrices and checkAndForceCloseOnSltpCross
          // can use the ratcheted absolute price instead of re-computing from
          // the stale static percentage. This ensures both the exchange order
          // placement path and the proactive force-close path reflect the latest
          // trailing ratchet on every tick, not only on recalc ticks.
          const prevTrailingActive = livePos.trailingActive
          const prevTrailingStopPrice = livePos.trailingStopPrice
          const nextTrailingStopPrice =
            trailingActive && trailingStopPrice > 0 ? trailingStopPrice : undefined
          const trailingStateChanged =
            prevTrailingActive !== trailingActive ||
            prevTrailingStopPrice !== nextTrailingStopPrice

          // ── Per-tick no-op guard ──────────────────────────────────────────
          // syncLiveFromPseudo fires on EVERY realtime cycle (200–300 ms) but
          // the trailing stop price only ratchets once per strategy cycle
          // (~5 s). Calling recalculateAndApplySLTP on no-change ticks
          // acquires the live_sync_lock, fetches open orders, and calls
          // updateProtectionOrders — all no-ops at the exchange layer, but
          // still ~50–150 ms of lock contention per position per tick.
          //
          // Skip the call when BOTH:
          //   • the computed slPct is within ±0.25% of the currently stored
          //     stopLoss pct (same 0.25% tolerance as priceDrifted �� a
          //     change smaller than this cannot affect the exchange order)
          //   • the tpPct is within ±0.25% of the currently stored takeProfit
          //     pct (or both are undefined/NaN)
          // Always call when the live position has a missing order (id = undefined)
          // even if percentages are unchanged — the order may have been silently
          // filled or cancelled on the venue and needs re-arming.
          const currentSlPct = typeof livePos.stopLoss === "number" ? livePos.stopLoss : undefined
          const currentTpPct = typeof livePos.takeProfit === "number" ? livePos.takeProfit : undefined
          const ordersMissing = !livePos.stopLossOrderId || !livePos.takeProfitOrderId
          // CRITICAL: Guard against division by zero and NaN propagation.
          // currentSlPct/tpPct could be 0, negative, or NaN. Use safe division with
          // explicit isFinite checks to prevent crashes on trailing stop updates.
          const slDeltaPct = (() => {
            if (currentSlPct === undefined || effectiveSlPct === undefined) return 1 // treat as changed
            if (!Number.isFinite(currentSlPct) || !Number.isFinite(effectiveSlPct)) return 1
            if (currentSlPct <= 0) return 1 // undefined SL → treat as changed
            const delta = Math.abs(effectiveSlPct - currentSlPct) / Math.abs(currentSlPct)
            return Number.isFinite(delta) ? delta : 1
          })()
          
          const tpDeltaPct = (() => {
            if (currentTpPct === undefined && tpPct === undefined) return 0 // both undefined → no change
            if (currentTpPct === undefined || tpPct === undefined) return 1 // one newly defined → changed
            if (!Number.isFinite(currentTpPct) || !Number.isFinite(tpPct)) return 1
            if (currentTpPct <= 0) return 1 // undefined TP → treat as changed
            const delta = Math.abs(tpPct - currentTpPct) / Math.abs(currentTpPct)
            return Number.isFinite(delta) ? delta : 1
          })()
          // When trailing is active the ratchet can advance even when the
          // derived slPct (from distPct calculation above) looks stable within
          // 0.25%.  The absolute stop price advancing is always significant —
          // skip the no-op guard if the trailing stop price itself changed.
          const trailingPriceAdvanced =
            trailingStateChanged ||
            (trailingActive && trailingStopPrice > 0 && prevTrailingStopPrice !== trailingStopPrice)
          const nothingChanged =
            !ordersMissing && slDeltaPct < 0.0025 && tpDeltaPct < 0.0025 && !trailingPriceAdvanced
          if (nothingChanged) continue

          await recalculateAndApplySLTP(connectionId, livePos.id, exchangeConnector, {
            stopLossPct: effectiveSlPct,
            takeProfitPct: tpPct,
            trailingActive,
            trailingStopPrice: nextTrailingStopPrice,
          })
        } catch (err) {
          console.warn(
            `${LOG_PREFIX} syncLiveFromPseudo: failed for ${livePos.id} (${symbol}/${side}):`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    }
    const poolSize = Math.min(MAX_CONCURRENT_SLTP, matches.length)
    await Promise.all(Array.from({ length: poolSize }, () => worker()))
  } catch (err) {
    console.warn(`${LOG_PREFIX} syncLiveFromPseudo top-level error:`, err instanceof Error ? err.message : String(err))
  }
}

export const __liveStageTest = {
  liveExecutionSlot,
  resolveConfirmedStrategyVariant,
  async refreshLockTTLWithClient(client: any, key: string, token: string, ttlMs: number) {
    return (await evalLockLua(client, REFRESH_LOCK_TTL_LUA, key, [token, String(ttlMs)])) === 1
  },
  async releaseLockWithClient(client: any, key: string, token: string) {
    return (await evalLockLua(client, RELEASE_LOCK_LUA, key, [token])) === 1
  },
  computeDesiredProtectionPrices,
  settleControlOrdersBeforeSystemClose,
  settleControlOrdersBeforeQuantityMutation,
  reconcilePendingAccumulationAndRearm,
  reconcileAuthoritativeExchangeQuantity,
  physicalAccumulationCount,
  sweepOrphanProtectionOrders,
  updateProtectionOrders,
  resolvePseudoProtectionPercents,
  isTrailingStopTightening,
  isPreFillWithoutExchangeHandle,
  readAbsoluteProtectionPrices(pos: LivePosition) {
    return computeDesiredProtectionPrices(pos)
  },
  detectSltpCross(pos: LivePosition, price: number, stopLossPrice?: number, takeProfitPrice?: number): "sl_hit" | "tp_hit" | null {
    if (pos.direction === "short") {
      if (stopLossPrice && price >= stopLossPrice) return "sl_hit"
      if (takeProfitPrice && price <= takeProfitPrice) return "tp_hit"
      return null
    }
    if (stopLossPrice && price <= stopLossPrice) return "sl_hit"
    if (takeProfitPrice && price >= takeProfitPrice) return "tp_hit"
    return null
  },
}

export default {
  executeLivePosition,
  updateLivePositionFill,
  closeLivePosition,
  getLivePositions,
  getLivePositionsByStatus,
  calculateLivePositionStats,
  syncWithExchange,
  reconcileLivePositions,
  recalculateAndApplySLTP,
  syncLiveFromPseudo,
  getClosedLivePositions,
  processSimulatedPositions,
}
