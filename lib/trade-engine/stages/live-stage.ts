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
    realizedPnL: Number(hash.realizedPnL ?? hash.realized_pnl ?? 0) || undefined,
    unrealized_pnl: Number(hash.unrealized_pnl ?? 0) || undefined,
    unrealized_pnl_percent: Number(hash.unrealized_pnl_percent ?? 0) || undefined,
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
      return await client