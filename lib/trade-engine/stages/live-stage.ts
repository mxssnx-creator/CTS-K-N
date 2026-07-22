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

import { getAppSettings, getConnection, getRedisClient, initRedis, setSettings } from "@/lib/redis-db"
import { nanoid } from "@/lib/trade-engine/pseudo-position-manager"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { emitCanonicalEvent } from "@/lib/events/emitter"
import { VolumeCalculator } from "@/lib/volume-calculator"
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
  isTruthyFlag,
} from "@/lib/connection-state-utils"
import { evaluateRealTradeReadiness } from "@/lib/real-trade-gates"
import {
  advanceBlockCountPausesOnPositionClose,
  buildBlockLegState,
  calculateBlockAddQuantity,
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

const LOG_PREFIX = "[v0] [LivePositionStage]"
const MIN_EXCHANGE_STOP_LOSS_PERCENT = 0.2

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
    const trailingSl = trailingProfile.stopRatio * 100
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
    evaluateRealTradeReadiness(connection as Record<string, any>, "preset").canPlaceRealOrders
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
  executionIntent?: "main" | "preset"
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
    orderId?: string
    submittedAt: number
    variant?: "block" | "dca" | "default"
    blockCount?: number
    blockBaseQuantity?: number
    blockBaseVolumeMultiplier?: number
    blockVolumeRatio?: number
    blockVolumeIncrementRatio?: number
    blockCalculatedVolumeMultiplier?: number
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
  blockMinimumProfitFactor?: number
  blockObservedProfitFactor?: number
  blockProfitFactorWindow?: number
  blockProfitFactorSampleCount?: number
  blockCount?: number
  blockVolumeIncrementRatio?: number
  blockCalculatedVolumeMultiplier?: number
  blockLegs?: BlockLegState[]
  dcaProfile?: DcaProfile
  dcaLegs?: DcaLegState[]
  dcaTakeProfitPrice?: number
  setKey?: string
  indicationType?: string
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
  // Variant size multiplier mirrored from RealPosition (block=1.5-2.0,
  // dca=0.5, others=1.0). Stored so accumulation can match original sizing.
  sizeMultiplier?: number
  parentSetKey?: string
  setVariant?: "default" | "trailing" | "block" | "dca" | "pause"
  accumulatedSetKeys?: string[]
  /** Combined position-count (axis) Set: multiple hedge-netted pos-count Sets
   *  merged into this ONE live exchange order. Member keys live in
   *  accumulatedSetKeys. Global stats stay aggregated (no per-Set split). */
  combinedPosCounts?: boolean
  posCountsTargetFlat?: boolean
  posCountsLongSetCount?: number
  posCountsShortSetCount?: number
  posCountsNetSetCount?: number
  /** Current authoritative open quantity distributed over exact member Sets. */
  posCountsSetQuantities?: Record<string, number>
  /** Exact surviving Strategy-Set ratio parts after the long/short hedge. */
  posCountsSetRatios?: Record<string, number>
  /** Total confirmed entry quantity over the position lifetime. */
  totalExecutedQuantity?: number
  /** Quantity already reduced by control/system/target partial executions. */
  closedQuantity?: number
  /** Bounded, idempotent partial-order audit/quantity ledger. */
  partialOrderExecutions?: PartialOrderExecution[]
  protectionMode?: "exchange_control" | "system_close" | "system_close_fallback"
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
  trailingProfile?: { startRatio: number; stopRatio: number; stepRatio: number }
  prevPos?: { count: number; successRate: number; profitFactor: number; avgDDT: number; recentPnls?: number[] }

  progression?: { step: string; timestamp: number; success: boolean; details: string }[]
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
  },
): Promise<boolean> {
  const combinedMemberKeys = !lineage && position.combinedPosCounts
    ? [...new Set((position.accumulatedSetKeys || []).map(String).filter(Boolean))]
    : []
  if (combinedMemberKeys.length > 0) {
    let inserted = false
    for (let index = 0; index < combinedMemberKeys.length; index++) {
      const memberSetKey = combinedMemberKeys[index]
      const memberInserted = await recordStrategyPositionEntry({
        connectionId,
        positionId: position.id,
        entryId: `${entryId}:member:${memberSetKey}`,
        setKey: memberSetKey,
        parentSetKey: memberSetKey.split("#")[0] || memberSetKey,
        symbol: position.symbol,
        indicationType: String(position.indicationType || memberSetKey.split(":")[1] || "unknown"),
        direction: position.direction === "short" || position.side === "short" ? "short" : "long",
        axisKey: axisKeyFromLineage(memberSetKey, position.axisWindows),
        countGlobalPosition: index === 0,
      })
      inserted = memberInserted || inserted
    }
    return inserted
  }
  const setKey = String(lineage?.setKey || position.setKey || "").trim()
  if (!setKey) return false
  const direction = position.direction === "short" || position.side === "short" ? "short" : "long"
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
  })
}

async function recordFillCountersOnce(
  connectionId: string,
  position: LivePosition,
  symbol: string,
  side: string,
): Promise<boolean> {
  // Entry accounting is independently idempotent. Run it even when the legacy
  // fill marker exists so pre-rollout positions are backfilled on reconcile.
  await recordConfirmedStrategyEntry(connectionId, position, `${position.id}:initial`)
  if (hasFillCounterRecorded(position)) return false

  // Mark first, before incrementing, so the same in-memory reconcile pass cannot
  // double-count if both exchange-position fallback and getOrder() observe the
  // fill. The caller persists the position in the same save batch/tick.
  position.fillCounterRecordedAt = Date.now()
  await incrementMetric(connectionId, "live_orders_filled_count")
  await incrementOrdersBySymbol(connectionId, symbol, side, "filled")
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

function positionHashKey(connectionId: string, positionId: string): string {
  return `live_positions:${connectionId}:${positionId}`
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

function parseRedisHashPosition(hash: Record<string, any>): LivePosition {
  return {
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
    posCountsSetQuantities: typeof hash.posCountsSetQuantities === "string"
      ? safeJsonParse<Record<string, number>>(hash.posCountsSetQuantities, {})
      : hash.posCountsSetQuantities,
    posCountsSetRatios: typeof hash.posCountsSetRatios === "string"
      ? safeJsonParse<Record<string, number>>(hash.posCountsSetRatios, {})
      : hash.posCountsSetRatios,
    partialOrderExecutions: Array.isArray(hash.partialOrderExecutions)
      ? hash.partialOrderExecutions
      : safeJsonParse<PartialOrderExecution[]>(hash.partialOrderExecutions, []),
  } as LivePosition
}

async function readLivePositionSnapshot(client: any, connectionId: string, positionId: string): Promise<LivePosition | null> {
  const [legacyRaw, hash] = await Promise.all([
    client.get(`live:position:${positionId}`).catch(() => null),
    client.hgetall(positionHashKey(connectionId, positionId)).catch(() => null),
  ])
  let legacy: LivePosition | null = null
  if (legacyRaw) {
    try { legacy = JSON.parse(legacyRaw as string) as LivePosition } catch { /* malformed legacy mirror */ }
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
  let evictedClosedIds: string[] = []
  
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
    if (terminalStatuses.has(String(position.status || "").toLowerCase())) {
      await client.lrem(openIndexKey, 0, position.id).catch(() => 0)
      const alreadyClosed = await client.lpos(closedIndexKey, position.id).catch(() => null)
      if (alreadyClosed === null || alreadyClosed === undefined) {
        await client.lpush(closedIndexKey, position.id).catch(() => 0)
      }
      evictedClosedIds = ((await client.lrange(closedIndexKey, 500, -1).catch(() => [])) || []).map(String)
      await client.ltrim(closedIndexKey, 0, 499).catch(() => {})
      await client.set(`live:positions:${position.connectionId}:moved:${position.id}`, String(Date.now())).catch(() => null)
      await client.expire(`live:positions:${position.connectionId}:moved:${position.id}`, 60 * 60).catch(() => 0)
      for (const setKey of liveSetLineageKeys) {
        await client.srem(liveSetIndexKey, setKey).catch(() => 0)
      }
      const openedAt = Number(position.createdAt || position.timestamp || 0)
      const closedAt = Number(position.closedAt || position.updatedAt || Date.now())
      await markStrategyPositionInactive(
        position.connectionId,
        position.id,
        String(position.status).toLowerCase() === "closed"
          ? {
              pnl: Number.isFinite(Number(position.realizedPnL)) ? Number(position.realizedPnL) : 0,
              drawdownMinutes: openedAt > 0 && closedAt > openedAt
                ? (closedAt - openedAt) / 60_000
                : 0,
            }
          : undefined,
      )
    } else {
      await client.lrem(openIndexKey, 0, position.id).catch(() => 0)
      await client.lpush(openIndexKey, position.id).catch(() => 0)
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
    // The closed index is a permanent bounded ring. Delete only records that
    // were actually evicted from its 500-row retention window; active and
    // retained terminal records never expire merely because time passed.
    if (evictedClosedIds.length > 0) {
      await client.del(...evictedClosedIds.flatMap((id) => [
        `live_positions:${position.connectionId}:${id}`,
        `live:position:${id}`,
      ])).catch(() => 0)
    }
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
    const dir = (sideKey.includes("short") || sideKey === "sell") ? "short" : "long"
    const symbolKey = String(symbol || "").trim().toUpperCase()
    const field = `${symbolKey}:${dir}:${metric}`
    void field
    await recordPerSymbolOrderCounter(connectionId, symbolKey, dir, metric as any)
  } catch {
    /* best-effort */
  }
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
  return undefined
}

async function recoverEntryOrderByClientId(
  connector: any,
  symbol: string,
  clientOrderId: string,
): Promise<any | null> {
  if (!connector || !clientOrderId) return null
  const normalize = (candidate: any): any | null => {
    const raw = candidate?.order ?? candidate?.data ?? candidate
    if (!raw || candidate?.success === false) return null
    const echoedClientId = raw?.clientOrderId ?? raw?.clientOrderID ?? raw?.client_oid
    if (echoedClientId && String(echoedClientId) !== clientOrderId) return null
    const orderId = raw?.orderId ?? raw?.orderID ?? raw?.id
    if (orderId == null || String(orderId).length === 0) return null
    return { ...raw, success: true, orderId: String(orderId), clientOrderId }
  }

  for (const lookup of [
    typeof connector.getOrderDetails === "function"
      ? () => connector.getOrderDetails(symbol, undefined, clientOrderId)
      : null,
    typeof connector.getOpenOrder === "function"
      ? () => connector.getOpenOrder(symbol, undefined, clientOrderId)
      : null,
  ]) {
    if (!lookup) continue
    try {
      const recovered = normalize(await withTimeout(
        lookup() as Promise<any>,
        EXCHANGE_TIMEOUT_GET_ORDER_MS,
        `recoverEntryOrderByClientId(${symbol})`,
      ))
      if (recovered) return recovered
    } catch { /* authoritative sync will retry */ }
  }

  if (typeof connector.getOpenOrders === "function") {
    try {
      const orders = await withTimeout(
        connector.getOpenOrders(symbol) as Promise<any>,
        EXCHANGE_TIMEOUT_GET_ORDER_MS,
        `recoverEntryOrderByClientId.openOrders(${symbol})`,
      )
      const match = Array.isArray(orders)
        ? orders.find((order: any) => String(order?.clientOrderId ?? order?.clientOrderID ?? order?.client_oid ?? "") === clientOrderId)
        : null
      return normalize(match)
    } catch { /* authoritative sync will retry */ }
  }
  return null
}

async function prepareProtectionSubmission(
  position: LivePosition,
  leg: "stopLoss" | "takeProfit",
  triggerPrice: number,
  quantity: number,
): Promise<string> {
  const clientOrderId = makeDurableClientOrderId(leg === "stopLoss" ? "sl" : "tp", position)
  position.pendingProtectionOrders = {
    ...(position.pendingProtectionOrders || {}),
    [leg]: { clientOrderId, triggerPrice, quantity },
  }
  appendClientOrderTracking(
    position,
    clientOrderId,
    leg === "stopLoss" ? "stop_loss" : "take_profit",
    { triggerPrice, quantity },
  )
  pushStep(position, "protection_submission_prepared", true, `${leg} clientOrderId=${clientOrderId}`)
  await savePosition(position)
  await persistCriticalLiveState(`protection:${position.id}:${leg}`)
  return clientOrderId
}
async function tryAcquireLock(connId: string, symbol: string, direction: string): Promise<string | null> {
  const { getRedisClient } = await import("@/lib/redis-db")
  const client = getRedisClient()
  const key = `live:lock:${connId}:${symbol}:${direction}`
  const token = `tok:${Date.now()}:${nanoid(8)}`
  try {
    // Atomic SET key token NX EX 300 — the ONLY correct dedup primitive.
    // `NX` guarantees exclusivity (a second concurrent entry on the same
    // symbol+direction gets `null` and falls through to the accumulate
    // path); `EX` guarantees the lock self-expires so a crashed engine
    // can never strand a slot. The previous lowercase `{ ex: 300 }` was
    // silently ignored by the client (which honours only `{ EX, NX, XX }`),
    // so the lock had neither a TTL nor exclusivity — every signal
    // "acquired" it and duplicate exchange orders were possible.
    const r = await client.set(key, token, { EX: 300, NX: true })
    return r === "OK" ? token : null
  } catch {
    return null
  }
}
async function findOpenLivePositionByDir(connId: string, symbol: string, side: string): Promise<LivePosition | null> {
  const { getLivePositions } = await import("@/lib/trade-engine/stages/live-stage")
  const positions = await getLivePositions(connId)
  const norm = String(symbol || "").toUpperCase().replace(/[-_]/g, "")
  for (const p of positions) {
    const psym = String(p.symbol || "").toUpperCase().replace(/[-_]/g, "")
    if (psym === norm && p.direction === side && (p.status === "open" || p.status === "filled" || p.status === "partially_filled" || p.status === "placed" || p.status === "pending_fill" || p.status === "placed_unconfirmed" || p.status === "simulated")) {
      return p
    }
  }
  return null
}

async function findAuthoritativeAdjustmentParent(
  connId: string,
  symbol: string,
  direction: "long" | "short",
  allowSimulated: boolean,
): Promise<LivePosition | null> {
  const positions = await getLivePositions(connId)
  const normalized = String(symbol || "").toUpperCase().replace(/[-_]/g, "")
  return positions.find((p) => {
    const sameSymbol = String(p.symbol || "").toUpperCase().replace(/[-_]/g, "") === normalized
    const parentVariant = p.setVariant !== "block" && p.setVariant !== "dca"
    const active = p.status === "open" || p.status === "filled" || p.status === "partially_filled" || (allowSimulated && p.status === "simulated")
    const venueOwned = allowSimulated || !!(p.orderId || (p.exchangeData as any)?.exchangePositionId)
    return sameSymbol && p.direction === direction && parentVariant && active && venueOwned && Number(p.executedQuantity || 0) > 0
  }) || null
}
async function fetchCurrentPrice(symbol: string, connId?: string): Promise<number> {
  const { getMarketData, getRedisClient } = await import("@/lib/redis-db")
  try {
    // Primary: OHLCV candle-series key written by historic loader / live feed.
    const data = await getMarketData(symbol, "1m")
    if (data) {
      const latest = data.latest || (Array.isArray(data) ? data[data.length - 1] : null)
      if (latest) {
        const price = parseFloat(String(latest.close ?? latest[4] ?? latest.price ?? 0)) || 0
        if (price > 0) return price
      }
    }
    // Fallback: the synthetic price generator and the cron write the current
    // close into the flat hash `market_data:{symbol}` (field "close").
    // This key is available in the sandbox even when the candle-series key is absent.
    const client = getRedisClient()
    if (client) {
      const closeRaw = await client.hget(`market_data:${symbol}`, "close").catch(() => null)
      const price = parseFloat(String(closeRaw ?? 0)) || 0
      if (price > 0) return price
    }
    return 0
  } catch {
    return 0
  }
}
interface AccumulationPlan {
  addQty: number
  variant: "block" | "dca" | "default"
  blockCount?: number
  blockBaseQuantity?: number
  dcaStep?: number
  dcaVolumeMultiplier?: number
  dcaTriggerDistancePct?: number
  dcaProfile?: DcaProfile
}

async function resolveAccumulationPlan(
  connId: string,
  existing: LivePosition,
  real: any,
  price: number,
): Promise<AccumulationPlan | null> {
  if (real?.setVariant === "block") {
    const blockCount = parseBlockCount(real?.setKey)
    const blockVolumeRatio = Number(real?.blockVolumeRatio ?? existing.blockVolumeRatio ?? 1)
    // Every Block count is derived from the immutable Base-Set leg (ratio 1),
    // never from the already-expanded aggregate. Using current executed
    // quantity here compounded Block 1 into Block 3 and was the main source of
    // runaway live volumes across cycles.
    const blockBaseQuantity = Number(
      existing.initialExecutedQuantity ?? existing.blockBaseQuantity ?? existing.executedQuantity ?? existing.quantity ?? 0,
    )
    if (!blockCount || blockBaseQuantity <= 0 || blockVolumeRatio <= 0) return null
    // Per independent Block set: addQty = baseSetQty × (blockCount × ratio).
    const addQty = calculateBlockAddQuantity(blockBaseQuantity, blockCount, blockVolumeRatio)
    return { addQty, variant: "block", blockCount, blockBaseQuantity }
  }

  if (real?.setVariant === "dca") {
    const client = getRedisClient()
    const [legacy, canonical] = await Promise.all([
      client.hgetall(`connection_settings:${connId}`).catch(() => ({})),
      client.hgetall(`settings:connection_settings:${connId}`).catch(() => ({})),
    ])
    const dcaProfile = mergeDcaProfileSources(
      // Position-local data is the last profile that actually executed and is
      // retained as a crash-recovery fallback. Current persisted settings are
      // layered afterwards so an operator save affects the very next DCA
      // decision instead of being shadowed until the position closes.
      existing.dcaProfile,
      legacy,
      canonical,
      real?.dcaProfile,
    )
    const referencePrice = Number(existing.initialEntryPrice ?? existing.averageExecutionPrice ?? existing.entryPrice ?? 0)
    const next = resolveNextDcaStep({
      direction: existing.direction || "long",
      referencePrice,
      currentPrice: price,
      profile: dcaProfile,
      legs: existing.dcaLegs,
      pendingStep: existing.pendingAccumulation?.dcaStep,
    })
    if (!next) return null
    const baseQuantity = Number(existing.initialExecutedQuantity ?? existing.executedQuantity ?? 0)
    const addQty = calculateDcaAddQuantity(baseQuantity, next.volumeMultiplier)
    return {
      addQty,
      variant: "dca",
      dcaStep: next.step,
      dcaVolumeMultiplier: next.volumeMultiplier,
      dcaTriggerDistancePct: next.triggerDistancePct,
      dcaProfile,
    }
  }

  const volumeResult = await VolumeCalculator.calculateVolumeForConnection(
    connId,
    String(real?.symbol || existing.symbol || ""),
    price,
    { tradeMode: "main", sizeMultiplier: real?.sizeMultiplier ?? existing.sizeMultiplier },
  ).catch(() => null)
  let addQty = Number(volumeResult?.finalVolume || volumeResult?.volume || 0)
  if (!Number.isFinite(addQty) || addQty <= 0) addQty = price > 0 ? 5 / price : 0
  if (real?.combinedPosCounts) {
    const delta = resolveCombinedPosCountDelta(Number(existing.executedQuantity || 0), addQty)
    if (delta.action !== "increase") return null
    addQty = delta.quantity
  }
  return Number.isFinite(addQty) && addQty > 0 ? { addQty, variant: "default" } : null
}

async function accumulateIntoSimulatedPosition(
  connId: string,
  existing: LivePosition,
  real: any,
  price: number,
): Promise<LivePosition> {
  const lockId = `accumulate-sim:${process.pid}:${Date.now()}:${nanoid(8)}`
  if (!await acquirePositionMutationLock(connId, existing.id, lockId)) return existing
  try {
    const plan = await resolveAccumulationPlan(connId, existing, real, price)
    if (!plan) {
      pushStep(existing, "accumulate_skip", false, `${real?.setVariant || "adjustment"} trigger not ready`)
      await savePosition(existing)
      return existing
    }
    const accumulationSetKey = plan.variant === "dca" && plan.dcaStep
      ? buildDcaStepSetKey(String(real?.setKey || "dca"), plan.dcaStep)
      : String(real?.setKey || "")
    if (!real?.combinedPosCounts && accumulationSetKey && existing.accumulatedSetKeys?.includes(accumulationSetKey)) return existing
    const prevExec = Number(existing.executedQuantity || 0)
    const prevAvg = Number(existing.averageExecutionPrice || existing.entryPrice || price)
    const filledQty = plan.addQty
    const newExec = prevExec + filledQty
    const mutated = await mutatePositionWithVersionCheck(existing, ["simulated"], draft => {
      draft.executedQuantity = newExec
      draft.quantity = newExec
      draft.remainingQuantity = 0
      draft.averageExecutionPrice = newExec > 0 ? ((prevAvg * prevExec) + (price * filledQty)) / newExec : prevAvg
      draft.volumeUsd = newExec * draft.averageExecutionPrice
      draft.initialExecutedQuantity ??= prevExec
      draft.totalExecutedQuantity = Math.max(
        Number(draft.totalExecutedQuantity || 0),
        newExec + Number(draft.closedQuantity || 0),
      )
      draft.initialEntryPrice ??= prevAvg
      draft.blockBaseQuantity ??= prevExec
      draft.fills = [...(draft.fills || []), { timestamp: Date.now(), quantity: filledQty, price, fee: 0, feeAsset: "" }]
      draft.accumulatedSetKeys = real?.combinedPosCounts
        ? Array.from(new Set<string>((Array.isArray(real.accumulatedSetKeys) ? real.accumulatedSetKeys : []).map((value: unknown) => String(value)).filter(Boolean)))
        : [...new Set([...(draft.accumulatedSetKeys || []), ...(accumulationSetKey ? [accumulationSetKey] : [])])]
      if (real?.combinedPosCounts) {
        draft.posCountsSetRatios = { ...(real?.posCountsSetRatios || draft.posCountsSetRatios || {}) }
        draft.posCountsSetQuantities = allocatePositionSetQuantities(draft, newExec, draft.accumulatedSetKeys)
      }
      if (plan.variant === "block") {
        const leg = buildBlockLegState(real, filledQty, undefined, undefined, {
          baseQuantity: plan.blockBaseQuantity,
          requestedQuantity: plan.addQty,
          positionQuantityAfter: newExec,
        })
        if (leg) draft.blockLegs = [...(draft.blockLegs || []).filter((item) => item.setKey !== leg.setKey), leg]
      }
      if (plan.variant === "dca" && plan.dcaStep) {
        draft.dcaProfile = plan.dcaProfile
        draft.dcaLegs = upsertDcaLeg(draft.dcaLegs, {
          setKey: accumulationSetKey || `dca#step:${plan.dcaStep}`,
          step: plan.dcaStep,
          baseQuantity: draft.initialExecutedQuantity || prevExec,
          volumeMultiplier: plan.dcaVolumeMultiplier || 1,
          triggerDistancePct: plan.dcaTriggerDistancePct || 0,
          requestedQuantity: filledQty,
          quantity: filledQty,
          referencePrice: draft.initialEntryPrice || prevAvg,
          positionQuantityAfter: newExec,
          filledPrice: price,
          filledAt: Date.now(),
        })
        draft.dcaTakeProfitPrice = calculateDcaTakeProfitPrice({
          direction: draft.direction || "long",
          profile: plan.dcaProfile!,
          initialEntryPrice: draft.initialEntryPrice || prevAvg,
          averageEntryPrice: draft.averageExecutionPrice,
          takeProfitPct: draft.takeProfit || 0,
        })
      }
      pushStep(draft, "accumulate", true, `simulated +${filledQty} @ ${price} (setKey=${accumulationSetKey || "n/a"})`)
    })
    if (mutated) {
      Object.assign(existing, mutated)
      await savePosition(existing)
      if (real?.combinedPosCounts) {
        await recordConfirmedStrategyEntry(connId, existing, `${existing.id}:combined:${Date.now()}`)
      } else if (accumulationSetKey) {
        await recordConfirmedStrategyEntry(
          connId,
          existing,
          `${existing.id}:set:${accumulationSetKey}`,
          {
            setKey: accumulationSetKey,
            parentSetKey: real.parentSetKey,
            indicationType: real.indicationType,
            axisWindows: real.axisWindows,
          },
        )
      }
      await incrementMetric(connId, "live_orders_accumulated_count")
    }
  } finally {
    await releasePositionMutationLock(connId, existing.id, lockId).catch(() => false)
  }
  return existing
}

async function accumulateIntoLivePosition(connId: string, existing: LivePosition, real: any, price: number, connector: any): Promise<LivePosition> {
  // Block and DCA are adjustment-only variants: they add an independently
  // calculated leg to an authoritative parent instead of opening competing
  // exchange positions for the same symbol/direction.
  const lockId = `accumulate:${process.pid}:${Date.now()}:${nanoid(8)}`
  const locked = await acquirePositionMutationLock(connId, existing.id, lockId)
  if (!locked) {
    pushStep(existing, "accumulate_skip", false, "position mutation lock already held — accumulation deferred")
    return existing
  }
  const stopPositionLockLeaseRefresh = startRedisLockLeaseRefresh(
    getRedisClient(),
    positionMutationLockKey(connId, existing.id),
    lockId,
    POSITION_MUTATION_LOCK_TTL_MS,
  )

  try {
    existing.accumulatedSetKeys ||= []
    if (!real?.combinedPosCounts && existing.accumulatedSetKeys.length >= MAX_ACCUMULATIONS_PER_POSITION) {
      pushStep(existing, "accumulate_skip", false, `cap reached (${MAX_ACCUMULATIONS_PER_POSITION} accumulations) — merge suppressed`)
      await savePosition(existing)
      return existing
    }
    // Block/default overlays execute once per exact Set key. DCA is repeatable
    // by configured step and is deduped after resolveAccumulationPlan derives
    // its stable `#step:N` identity below.
    if (!real?.combinedPosCounts && real?.setKey && real?.setVariant !== "dca" && existing.accumulatedSetKeys.includes(real.setKey)) {
      pushStep(existing, "accumulate_skip", false, `setKey ${real.setKey} already accumulated`)
      await savePosition(existing)
      return existing
    }
    if (!connector || typeof connector.placeOrder !== "function") {
      pushStep(existing, "accumulate_skip", false, "exchange connector unavailable — accumulation deferred")
      await savePosition(existing)
      return existing
    }

    if (existing.pendingAccumulation?.clientOrderId) {
      const pending = existing.pendingAccumulation
      const recovered = await recoverEntryOrderByClientId(connector, existing.symbol, pending.clientOrderId)
      const recoveredStatus = String(recovered?.status || "").toLowerCase()
      if (recovered && !["cancelled", "canceled", "rejected", "expired"].includes(recoveredStatus)) {
        pending.orderId = String(recovered.orderId || recovered.id)
        pending.absenceConfirmations = 0
        pushStep(existing, "accumulation_submission_recovered", true, `orderId=${pending.orderId}; exact fill deferred to reconciliation`)
        await savePosition(existing)
        return existing
      }
      const liveOrderIds = await fetchLiveOrderIdSet(connector)
      if (liveOrderIds === null || liveOrderIds.has(pending.clientOrderId)) {
        pushStep(existing, "accumulation_submission_wait", true, `tracking pending clientOrderId=${pending.clientOrderId}`)
        await savePosition(existing)
        return existing
      }
      pending.absenceConfirmations = Number(pending.absenceConfirmations || 0) + 1
      if (pending.absenceConfirmations < 2) {
        await savePosition(existing)
        return existing
      }
      pushStep(existing, "accumulation_submission_absent", false, `clientOrderId=${pending.clientOrderId} confirmed absent; retry allowed`)
      existing.pendingAccumulation = undefined
      await savePosition(existing)
    }

    if (!await settleControlOrdersBeforeQuantityMutation(connector, existing, "accumulation")) {
      await savePosition(existing)
      return existing
    }

    const plan = await resolveAccumulationPlan(connId, existing, real, price)
    if (!plan || !Number.isFinite(plan.addQty) || plan.addQty <= 0) {
      pushStep(existing, "accumulate_skip", false, `${real?.setVariant || "adjustment"} trigger/quantity not ready`)
      await savePosition(existing)
      return existing
    }
    const accumulationSetKey = plan.variant === "dca" && plan.dcaStep
      ? buildDcaStepSetKey(String(real?.setKey || "dca"), plan.dcaStep)
      : String(real?.setKey || "")
    if (!real?.combinedPosCounts && accumulationSetKey && existing.accumulatedSetKeys.includes(accumulationSetKey)) {
      pushStep(existing, "accumulate_skip", false, `setKey ${accumulationSetKey} already accumulated`)
      await savePosition(existing)
      return existing
    }

    const symbol = String(real?.symbol || existing.symbol || "")
    const direction: "long" | "short" = real?.direction === "short" || existing.direction === "short" ? "short" : "long"
    const exchangeSide: "buy" | "sell" = direction === "long" ? "buy" : "sell"
    const clientOrderId = makeDurableClientOrderId("acc", existing)
    existing.initialExecutedQuantity ??= existing.executedQuantity
    existing.initialEntryPrice ??= existing.averageExecutionPrice || existing.entryPrice
    if (plan.variant === "block") existing.blockBaseQuantity = plan.blockBaseQuantity
    else existing.blockBaseQuantity ??= existing.initialExecutedQuantity
    if (plan.dcaProfile) existing.dcaProfile = plan.dcaProfile
    existing.pendingAccumulation = {
      clientOrderId,
      setKey: accumulationSetKey,
      parentSetKey: String(real?.parentSetKey || ""),
      indicationType: String(real?.indicationType || ""),
      axisKey: axisKeyFromLineage(String(real?.setKey || ""), real?.axisWindows),
      accumulatedSetKeys: real?.combinedPosCounts
        ? Array.from(new Set<string>((Array.isArray(real.accumulatedSetKeys) ? real.accumulatedSetKeys : []).map((value: unknown) => String(value)).filter(Boolean)))
        : undefined,
      posCountsSetRatios: real?.combinedPosCounts ? { ...(real?.posCountsSetRatios || {}) } : undefined,
      combinedPosCounts: real?.combinedPosCounts === true,
      requestedQuantity: plan.addQty,
      positionQuantityBefore: Number(existing.executedQuantity || 0),
      submittedAt: Date.now(),
      variant: plan.variant,
      blockCount: plan.blockCount,
      blockBaseQuantity: plan.blockBaseQuantity,
      blockBaseVolumeMultiplier: Number(real?.blockBaseVolumeMultiplier || 1),
      blockVolumeRatio: Number(real?.blockVolumeRatio || 1),
      blockVolumeIncrementRatio: Number(
        real?.blockVolumeIncrementRatio ||
        (plan.blockCount ? calculateBlockVolumeIncrementRatio(plan.blockCount, Number(real?.blockVolumeRatio || 1)) : 1),
      ),
      blockCalculatedVolumeMultiplier: Number(real?.blockCalculatedVolumeMultiplier || real?.sizeMultiplier || 1),
      dcaStep: plan.dcaStep,
      dcaVolumeMultiplier: plan.dcaVolumeMultiplier,
      dcaTriggerDistancePct: plan.dcaTriggerDistancePct,
      referencePrice: existing.initialEntryPrice,
    }
    appendClientOrderTracking(existing, clientOrderId, "accumulation", {
      setKey: accumulationSetKey,
      requestedQuantity: plan.addQty,
      variant: plan.variant,
    })
    pushStep(existing, "accumulation_submission_prepared", true, `clientOrderId=${clientOrderId} qty=${plan.addQty}`)
    await savePosition(existing)
    await persistCriticalLiveState(`accumulation:${existing.id}`)

    let orderRes: any
    try {
      orderRes = await connector.placeOrder(
        symbol,
        exchangeSide,
        plan.addQty,
        undefined,
        "market",
        { positionSide: direction === "long" ? "LONG" : "SHORT", clientOrderId },
      )
    } catch (err) {
      orderRes = { success: false, error: err instanceof Error ? err.message : String(err) }
    }

    if (!(orderRes?.orderId || orderRes?.id)) {
      const recovered = await recoverEntryOrderByClientId(connector, symbol, clientOrderId)
      if (recovered) orderRes = recovered
    }
    const orderId = orderRes?.orderId || orderRes?.id
    if (!orderRes?.success || !orderId) {
      pushStep(existing, "accumulate_order_unconfirmed", false, `tracking by clientOrderId until authoritative recovery: ${orderRes?.error || "no order id"}`)
      await savePosition(existing)
      return existing
    }
    if (existing.pendingAccumulation) existing.pendingAccumulation.orderId = String(orderId)
    await savePosition(existing)

    let filledQty = parseFloat(String(orderRes.filledQty ?? orderRes.executedQty ?? orderRes.cumQty ?? "0")) || 0
    let filledPrice = parseFloat(String(orderRes.filledPrice ?? orderRes.avgPrice ?? orderRes.price ?? "0")) || 0
    if (filledQty <= 0) {
      const fill = await pollOrderFill(connector, symbol, String(orderId), 5_000)
      if (fill.filledQty > 0) {
        filledQty = fill.filledQty
        filledPrice = fill.filledPrice
      }
    }
    if (filledQty <= 0) {
      pushStep(existing, "accumulate_fill_pending", true, `orderId=${orderId}; exact fill deferred to reconciliation`)
      await savePosition(existing)
      return existing
    }
    if (!(filledPrice > 0)) filledPrice = price

    const prevExec = Number(existing.executedQuantity || 0)
    const prevAvg = Number(existing.averageExecutionPrice || existing.entryPrice || filledPrice)
    const newExec = prevExec + filledQty
    const pending = { ...existing.pendingAccumulation }
    const mutated = await mutatePositionWithVersionCheck(existing, ["open", "filled", "partially_filled"], draft => {
      draft.executedQuantity = newExec
      draft.quantity = Math.max(Number(draft.quantity || 0), prevExec) + filledQty
      draft.remainingQuantity = Math.max(0, draft.quantity - newExec)
      draft.averageExecutionPrice = newExec > 0 ? ((prevAvg * prevExec) + (filledPrice * filledQty)) / newExec : prevAvg
      draft.volumeUsd = newExec * draft.averageExecutionPrice
      draft.totalExecutedQuantity = Math.max(
        Number(draft.totalExecutedQuantity || 0),
        newExec + Number(draft.closedQuantity || 0),
      )
      draft.fills = [...(draft.fills || []), { timestamp: Date.now(), quantity: filledQty, price: filledPrice, fee: 0, feeAsset: "USDT" }]
      draft.accumulatedSetKeys = real?.combinedPosCounts
        ? Array.from(new Set<string>((Array.isArray(real.accumulatedSetKeys) ? real.accumulatedSetKeys : []).map((value: unknown) => String(value)).filter(Boolean)))
        : [...new Set([...(draft.accumulatedSetKeys || []), ...(accumulationSetKey ? [accumulationSetKey] : [])])]
      if (real?.combinedPosCounts) {
        draft.posCountsSetRatios = { ...(pending.posCountsSetRatios || real?.posCountsSetRatios || draft.posCountsSetRatios || {}) }
        draft.posCountsSetQuantities = allocatePositionSetQuantities(draft, newExec, draft.accumulatedSetKeys)
      }
      draft.pendingAccumulation = undefined
      if (plan.variant === "block") {
        const leg = buildBlockLegState(real, filledQty, clientOrderId, String(orderId), {
          baseQuantity: plan.blockBaseQuantity,
          requestedQuantity: plan.addQty,
          positionQuantityAfter: newExec,
        })
        if (leg) draft.blockLegs = [...(draft.blockLegs || []).filter((item) => item.setKey !== leg.setKey), leg]
      }
      if (plan.variant === "dca" && plan.dcaStep) {
        draft.dcaProfile = plan.dcaProfile
        draft.dcaLegs = upsertDcaLeg(draft.dcaLegs, {
          setKey: accumulationSetKey || `dca#step:${plan.dcaStep}`,
          step: plan.dcaStep,
          baseQuantity: draft.initialExecutedQuantity || prevExec,
          volumeMultiplier: plan.dcaVolumeMultiplier || 1,
          triggerDistancePct: plan.dcaTriggerDistancePct || 0,
          requestedQuantity: plan.addQty,
          quantity: filledQty,
          referencePrice: draft.initialEntryPrice || prevAvg,
          positionQuantityAfter: newExec,
          clientOrderId,
          orderId: String(orderId),
          filledPrice,
          filledAt: Date.now(),
        })
        draft.dcaTakeProfitPrice = calculateDcaTakeProfitPrice({
          direction,
          profile: plan.dcaProfile!,
          initialEntryPrice: draft.initialEntryPrice || prevAvg,
          averageEntryPrice: draft.averageExecutionPrice,
          takeProfitPct: draft.takeProfit || 0,
        })
      }
      pushStep(draft, "accumulate", true, `+${filledQty} @ ${filledPrice} (setKey=${pending.setKey || "n/a"}, total=${newExec})`)
    })
    if (!mutated) {
      pushStep(existing, "accumulate_fill_pending", false, "stale version; exact fill deferred to reconciliation")
      await savePosition(existing)
      return existing
    }
    Object.assign(existing, mutated)
    await incrementMetric(connId, "live_orders_accumulated_count")
    await savePosition(existing)
    if (pending.combinedPosCounts) {
      await recordConfirmedStrategyEntry(
        connId,
        existing,
        `${existing.id}:combined:${pending.clientOrderId}`,
      )
    } else if (pending.setKey) {
      await recordConfirmedStrategyEntry(
        connId,
        existing,
        `${existing.id}:set:${pending.setKey}`,
        {
          setKey: pending.setKey,
          parentSetKey: pending.parentSetKey,
          indicationType: pending.indicationType,
          axisKey: pending.axisKey,
        },
      )
    }
    existing.stopLossLastArmedAt = undefined
    existing.takeProfitLastArmedAt = undefined
    await updateProtectionOrders(connector, existing, "accumulate_rearm", null).catch((err) => {
      pushStep(existing, "accumulate_rearm_failed", false, err instanceof Error ? err.message : String(err))
    })
    await savePosition(existing)
  } catch (err) {
    pushStep(existing, "accumulate_error", false, err instanceof Error ? err.message : String(err))
    try { await savePosition(existing) } catch { /* best-effort */ }
  } finally {
    stopPositionLockLeaseRefresh()
    await releasePositionMutationLock(connId, existing.id, lockId).catch(() => false)
  }
  return existing
}

function isActiveLiveStatus(position: LivePosition): boolean {
  return ["open", "filled", "partially_filled", "placed", "pending_fill", "placed_unconfirmed", "simulated"]
    .includes(String(position.status || ""))
}

async function findOpenCombinedPosCountPositions(connId: string, symbol: string): Promise<LivePosition[]> {
  const normalized = String(symbol || "").toUpperCase().replace(/[-_]/g, "")
  const positions = await getLivePositions(connId)
  return positions.filter((position) =>
    position.combinedPosCounts === true &&
    isActiveLiveStatus(position) &&
    String(position.symbol || "").toUpperCase().replace(/[-_]/g, "") === normalized,
  )
}

async function fetchAuthoritativeOpenQuantity(
  connector: any,
  symbol: string,
  direction: "long" | "short",
): Promise<{ ok: boolean; quantity: number; position: any | null }> {
  if (!connector || typeof connector.getPosition !== "function") {
    return { ok: false, quantity: 0, position: null }
  }
  try {
    const position = await withTimeout(
      connector.getPosition(symbol, direction) as Promise<any>,
      EXCHANGE_TIMEOUT_GET_ORDER_MS,
      `getPosition(${symbol} ${direction})`,
    )
    if (position) {
      return { ok: true, quantity: extractExchangeOpenQuantity(position), position }
    }
    const snapshotStatus = typeof connector.getLastPositionsSnapshotStatus === "function"
      ? connector.getLastPositionsSnapshotStatus()
      : null
    return {
      ok: snapshotStatus?.ok === true,
      quantity: 0,
      position: null,
    }
  } catch {
    return { ok: false, quantity: 0, position: null }
  }
}

async function reduceCombinedPosCountPosition(
  connectionId: string,
  position: LivePosition,
  targetQuantity: number,
  targetMemberKeys: string[],
  targetSetRatios: Record<string, number>,
  price: number,
  connector: any,
): Promise<LivePosition> {
  const initialQuantity = Number(position.executedQuantity || 0)
  const initialDelta = resolveCombinedPosCountDelta(initialQuantity, targetQuantity)
  if (initialDelta.action !== "reduce") return position
  if (targetQuantity <= 0 || initialDelta.quantity >= initialQuantity * (1 - 1e-8)) {
    return (await closeLivePosition(
      connectionId,
      position.id,
      price,
      position.status === "simulated" ? undefined : connector,
      "poscounts_target_flat",
    )) || position
  }

  if (position.status === "simulated") {
    const mutated = await mutatePositionWithVersionCheck(position, ["simulated"], draft => {
      draft.accumulatedSetKeys = [...new Set(targetMemberKeys)]
      draft.posCountsNetSetCount = targetMemberKeys.length
      applyReductionObservation(draft, {
        executionId: `${draft.id}:poscounts-sim:${targetQuantity}`,
        source: "poscounts_reduce",
        status: "filled",
        requestedQuantity: initialDelta.quantity,
        reportedFilledQuantity: initialDelta.quantity,
        authoritativeQuantity: targetQuantity,
        price,
        setKeys: targetMemberKeys,
        setRatios: targetSetRatios,
      })
      draft.posCountsSetQuantities = allocatePositionSetQuantities(draft, targetQuantity, targetMemberKeys)
      pushStep(draft, "poscounts_target_reduce", true, `${initialQuantity} → ${targetQuantity} (simulation)`)
    })
    if (mutated) Object.assign(position, mutated)
    await savePosition(position)
    return position
  }

  if (!connector || typeof connector.placeOrder !== "function") {
    pushStep(position, "poscounts_target_reduce", false, "exchange connector unavailable")
    await savePosition(position)
    return position
  }

  const lockId = `poscounts-reduce:${process.pid}:${Date.now()}:${nanoid(8)}`
  if (!await acquirePositionMutationLock(connectionId, position.id, lockId)) {
    pushStep(position, "poscounts_target_reduce", false, "position action already in progress — reduction deferred")
    return position
  }
  const stopLease = startRedisLockLeaseRefresh(
    getRedisClient(),
    positionMutationLockKey(connectionId, position.id),
    lockId,
    POSITION_MUTATION_LOCK_TTL_MS,
  )

  try {
    const fresh = await readLivePositionSnapshot(getRedisClient(), connectionId, position.id)
    if (fresh) Object.assign(position, fresh)
    const direction: "long" | "short" = position.direction === "short" ? "short" : "long"
    const side: "buy" | "sell" = direction === "long" ? "sell" : "buy"

    // Recover/reconcile an earlier reduce submission before considering a new
    // order. This is the durable multi-cycle/idempotency barrier.
    if (position.pendingReduction) {
      const pending = position.pendingReduction
      let observed: any = null
      if (pending.orderId && typeof connector.getOrder === "function") {
        observed = await withTimeout(
          connector.getOrder(position.symbol, pending.orderId) as Promise<any>,
          EXCHANGE_TIMEOUT_GET_ORDER_MS,
          `getOrder(poscounts-reduce ${pending.orderId})`,
        ).catch(() => null)
      }
      if (!observed) {
        observed = await recoverEntryOrderByClientId(connector, position.symbol, pending.clientOrderId)
      }
      if (observed?.orderId || observed?.id) pending.orderId = String(observed.orderId || observed.id)

      const status = String(observed?.status || "pending").toLowerCase()
      const reportedFilled = Number(observed?.filledQty ?? observed?.executedQty ?? observed?.cumQty ?? 0) || 0
      const authoritative = await fetchAuthoritativeOpenQuantity(connector, position.symbol, direction)
      const applied = applyReductionObservation(position, {
        executionId: `${position.id}:poscounts:${pending.clientOrderId}`,
        source: "poscounts_reduce",
        status,
        requestedQuantity: pending.requestedQuantity,
        reportedFilledQuantity: reportedFilled,
        previouslyAppliedQuantity: pending.appliedFilledQuantity,
        authoritativeQuantity: authoritative.ok ? authoritative.quantity : null,
        price: Number(observed?.filledPrice ?? observed?.avgPrice ?? price),
        orderId: pending.orderId,
        clientOrderId: pending.clientOrderId,
        setKeys: pending.targetMemberKeys,
        setRatios: pending.targetSetRatios,
      })
      pending.appliedFilledQuantity = applied.cumulativeApplied

      if (!observed) {
        const liveOrderIds = await fetchLiveOrderIdSet(connector)
        const pendingVisible = liveOrderIds?.has(pending.orderId || "") || liveOrderIds?.has(pending.clientOrderId)
        if (pendingVisible || liveOrderIds === null || !authoritative.ok) {
          position.pendingReduction = pending
          pushStep(position, "poscounts_reduce_wait", true, `clientOrderId=${pending.clientOrderId}; authoritative order state pending`)
          await savePosition(position)
          return position
        }
        pending.absenceConfirmations = Number(pending.absenceConfirmations || 0) + 1
        const targetReached = authoritative.quantity <= pending.targetQuantity * (1 + 1e-8)
        if (!targetReached && pending.absenceConfirmations < 2) {
          position.pendingReduction = pending
          await savePosition(position)
          return position
        }
        position.pendingReduction = undefined
        await savePosition(position)
      }

      const terminal = isFilledControlOrderStatus(status) || ["cancelled", "canceled", "rejected", "expired"].includes(status)
      if (observed && (isActiveControlOrderStatus(status) || (!terminal && !authoritative.ok))) {
        position.pendingReduction = pending
        pushStep(position, "poscounts_reduce_wait", true, `order=${pending.orderId || pending.clientOrderId} status=${status}; no duplicate submitted`)
        await savePosition(position)
        return position
      }
      position.pendingReduction = undefined
      await savePosition(position)
    }

    if (!await settleControlOrdersBeforeQuantityMutation(connector, position, "poscounts_reduce")) {
      await savePosition(position)
      return position
    }

    const currentQuantity = Number(position.executedQuantity || 0)
    const delta = resolveCombinedPosCountDelta(currentQuantity, targetQuantity)
    if (delta.action !== "reduce") {
      position.accumulatedSetKeys = [...new Set(targetMemberKeys)]
      position.posCountsSetQuantities = allocatePositionSetQuantities(position, currentQuantity, targetMemberKeys)
      await savePosition(position)
      return position
    }

    const clientOrderId = makeDurableClientOrderId("pc-reduce", position)
    position.pendingReduction = {
      clientOrderId,
      requestedQuantity: delta.quantity,
      targetQuantity,
      positionQuantityBefore: currentQuantity,
      targetMemberKeys: [...new Set(targetMemberKeys)],
      targetSetRatios: { ...targetSetRatios },
      appliedFilledQuantity: 0,
      submittedAt: Date.now(),
    }
    pushStep(position, "poscounts_reduction_prepared", true, `clientOrderId=${clientOrderId} qty=${delta.quantity}`)
    await savePosition(position)
    await persistCriticalLiveState(`poscounts-reduce:${position.id}`)

    let response: any
    try {
      response = await connector.placeOrder(
        position.symbol,
        side,
        delta.quantity,
        undefined,
        "market",
        {
          positionSide: direction === "long" ? "LONG" : "SHORT",
          reduceOnly: true,
          clientOrderId,
        },
      )
    } catch (error) {
      response = { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    let orderId = response?.orderId || response?.id
    if (!orderId) {
      const recovered = await recoverEntryOrderByClientId(connector, position.symbol, clientOrderId)
      if (recovered) {
        response = { ...response, ...recovered, success: recovered.success !== false }
        orderId = recovered.orderId || recovered.id
      }
    }
    if (orderId && position.pendingReduction) position.pendingReduction.orderId = String(orderId)
    if (!response?.success || !orderId) {
      pushStep(position, "poscounts_target_reduce", false, `${response?.error || "submission unconfirmed"}; durable clientOrderId retained`)
      await savePosition(position)
      return position
    }

    let filledQuantity = Number(response.filledQty ?? response.executedQty ?? response.cumQty ?? 0) || 0
    let filledPrice = Number(response.filledPrice ?? response.avgPrice ?? response.price ?? price) || price
    let fillStatus = String(response.status || "pending").toLowerCase()
    if (!(filledQuantity > 0)) {
      const fill = await pollOrderFill(connector, position.symbol, String(orderId), 5_000)
      filledQuantity = fill.filledQty
      filledPrice = fill.filledPrice || filledPrice
      fillStatus = fill.status
    }
    const authoritative = await fetchAuthoritativeOpenQuantity(connector, position.symbol, direction)
    const pending = position.pendingReduction!
    const applied = applyReductionObservation(position, {
      executionId: `${position.id}:poscounts:${pending.clientOrderId}`,
      source: "poscounts_reduce",
      status: fillStatus,
      requestedQuantity: pending.requestedQuantity,
      reportedFilledQuantity: filledQuantity,
      previouslyAppliedQuantity: pending.appliedFilledQuantity,
      authoritativeQuantity: authoritative.ok ? authoritative.quantity : null,
      price: filledPrice,
      orderId: String(orderId),
      clientOrderId: pending.clientOrderId,
      setKeys: pending.targetMemberKeys,
      setRatios: pending.targetSetRatios,
    })
    pending.appliedFilledQuantity = applied.cumulativeApplied
    const terminal = isFilledControlOrderStatus(fillStatus) || applied.cumulativeApplied >= pending.requestedQuantity * (1 - 1e-8)
    position.pendingReduction = terminal ? undefined : pending
    position.accumulatedSetKeys = [...new Set(targetMemberKeys)]
    position.posCountsNetSetCount = targetMemberKeys.length
    position.posCountsSetQuantities = allocatePositionSetQuantities(position, position.executedQuantity, targetMemberKeys)
    await savePosition(position)

    if (!terminal) {
      pushStep(position, "poscounts_reduce_wait", true, `orderId=${orderId}; partial=${applied.cumulativeApplied}/${pending.requestedQuantity}`)
      return position
    }

    position.stopLossLastArmedAt = undefined
    position.takeProfitLastArmedAt = undefined
    await updateProtectionOrders(connector, position, "poscounts_partial_rearm", null).catch((error) => {
      pushStep(position, "poscounts_partial_rearm", false, error instanceof Error ? error.message : String(error))
    })
    await savePosition(position)
    return position
  } finally {
    stopLease()
    await releasePositionMutationLock(connectionId, position.id, lockId).catch(() => false)
  }
}

/** Reconcile the single physical pos-count order to the newest hedged target.
 * Returns null only when no target position exists yet and the caller should
 * continue through the normal fresh-entry path. */
async function reconcileCombinedPosCountTarget(
  connectionId: string,
  realPosition: RealPosition,
  connector: any,
  executionIntent: "main" | "preset",
  liveExecutionEnabled: boolean,
): Promise<LivePosition | null> {
  const existingPositions = await findOpenCombinedPosCountPositions(connectionId, realPosition.symbol)
  let price = Number(realPosition.entryPrice || 0)
  if (!(price > 0)) price = await fetchCurrentPrice(realPosition.symbol)

  if (realPosition.posCountsTargetFlat || !(Number(realPosition.sizeMultiplier) > 0)) {
    let lastClosed: LivePosition | null = null
    for (const position of existingPositions) {
      const closed = await closeLivePosition(
        connectionId,
        position.id,
        price || position.averageExecutionPrice || position.entryPrice,
        position.status === "simulated" ? undefined : connector,
        "poscounts_target_flat",
      )
      if (closed) lastClosed = closed
    }
    return lastClosed || {
      id: `live:${connectionId}:${realPosition.symbol}:poscounts:flat:${Date.now()}`,
      connectionId,
      symbol: realPosition.symbol,
      direction: realPosition.direction,
      entryPrice: price,
      quantity: 0,
      executedQuantity: 0,
      remainingQuantity: 0,
      averageExecutionPrice: 0,
      leverage: realPosition.leverage,
      marginType: "cross",
      fills: [],
      status: "closed",
      statusReason: "Position-count hedge target is flat",
      combinedPosCounts: true,
      posCountsTargetFlat: true,
      accumulatedSetKeys: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
  }

  if (!(price > 0)) return existingPositions[0] || null
  const targetVolume = await VolumeCalculator.calculateVolumeForConnection(
    connectionId,
    realPosition.symbol,
    price,
    { tradeMode: executionIntent, sizeMultiplier: realPosition.sizeMultiplier },
  ).catch(() => null)
  const targetQuantity = resolveCombinedPosCountTargetQuantity(targetVolume)
  if (!(targetQuantity > 0)) {
    let lastClosed: LivePosition | null = null
    for (const position of existingPositions) {
      const closed = await closeLivePosition(
        connectionId,
        position.id,
        price || position.averageExecutionPrice || position.entryPrice,
        position.status === "simulated" ? undefined : connector,
        "poscounts_target_below_exchange_minimum",
      )
      if (closed) lastClosed = closed
    }
    return lastClosed || {
      id: `live:${connectionId}:${realPosition.symbol}:poscounts:below-min:${Date.now()}`,
      connectionId,
      symbol: realPosition.symbol,
      direction: realPosition.direction,
      entryPrice: price,
      quantity: 0,
      executedQuantity: 0,
      remainingQuantity: 0,
      averageExecutionPrice: 0,
      leverage: realPosition.leverage,
      marginType: "cross",
      fills: [],
      status: "closed",
      statusReason: "Combined position-count ratio remains below the exchange minimum",
      combinedPosCounts: true,
      accumulatedSetKeys: [],
      posCountsLongSetCount: realPosition.posCountsLongSetCount,
      posCountsShortSetCount: realPosition.posCountsShortSetCount,
      posCountsNetSetCount: realPosition.posCountsNetSetCount,
      posCountsSetRatios: { ...(realPosition.posCountsSetRatios || {}) },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
  }

  const opposite = existingPositions.filter((position) => position.direction !== realPosition.direction)
  for (const position of opposite) {
    const closed = await closeLivePosition(
      connectionId,
      position.id,
      price,
      position.status === "simulated" ? undefined : connector,
      "poscounts_target_direction_flip",
    )
    if (!closed || closed.status !== "closed") return closed || position
  }

  const existing = existingPositions.find((position) => position.direction === realPosition.direction)
  if (!existing) return null
  const targetMemberKeys = [...new Set((realPosition.accumulatedSetKeys || []).map(String).filter(Boolean))]
  existing.combinedPosCounts = true
  existing.posCountsLongSetCount = realPosition.posCountsLongSetCount
  existing.posCountsShortSetCount = realPosition.posCountsShortSetCount
  existing.posCountsNetSetCount = realPosition.posCountsNetSetCount
  const targetSetRatios = { ...(realPosition.posCountsSetRatios || {}) }
  const delta = resolveCombinedPosCountDelta(Number(existing.executedQuantity || 0), targetQuantity)
  if (delta.action === "increase") {
    return existing.status === "simulated" || !liveExecutionEnabled
      ? accumulateIntoSimulatedPosition(connectionId, existing, realPosition, price)
      : accumulateIntoLivePosition(connectionId, existing, realPosition, price, connector)
  }
  if (delta.action === "reduce") {
    return reduceCombinedPosCountPosition(connectionId, existing, targetQuantity, targetMemberKeys, targetSetRatios, price, connector)
  }
  existing.accumulatedSetKeys = targetMemberKeys
  existing.posCountsSetRatios = targetSetRatios
  existing.posCountsSetQuantities = allocatePositionSetQuantities(existing, targetQuantity, targetMemberKeys)
  existing.updatedAt = Date.now()
  await savePosition(existing)
  return existing
}

async function reconcileAuthoritativeExchangeQuantity(
  position: LivePosition,
  exchangeQuantity: number,
  exchangeEntryPrice: number,
): Promise<boolean> {
  if (!Number.isFinite(exchangeQuantity) || exchangeQuantity < 0) return false
  const before = Number(position.executedQuantity || 0)
  const tolerance = Math.max(1e-12, Math.max(before, exchangeQuantity) * 1e-8)
  if (Math.abs(before - exchangeQuantity) <= tolerance) return false

  if (exchangeQuantity < before) {
    applyReductionObservation(position, {
      executionId: `${position.id}:exchange-qty:${exchangeQuantity}`,
      source: "exchange_reconcile",
      status: exchangeQuantity > 0 ? "partially_filled" : "filled",
      requestedQuantity: before,
      reportedFilledQuantity: before - exchangeQuantity,
      authoritativeQuantity: exchangeQuantity,
      price: exchangeEntryPrice || position.markPrice || position.averageExecutionPrice,
      setKeys: position.accumulatedSetKeys,
    })
    position.submissionState = "confirmed"
    return true
  }

  const pending = position.pendingAccumulation
  const exactAdded = Math.max(0, exchangeQuantity - Number(pending?.positionQuantityBefore ?? before))
  position.executedQuantity = exchangeQuantity
  position.quantity = Math.max(Number(position.quantity || 0), exchangeQuantity)
  position.remainingQuantity = Math.max(0, position.quantity - exchangeQuantity)
  if (exchangeEntryPrice > 0) position.averageExecutionPrice = exchangeEntryPrice
  position.initialExecutedQuantity ??= before > 0 ? before : exchangeQuantity
  position.initialEntryPrice ??= position.averageExecutionPrice || position.entryPrice
  position.blockBaseQuantity ??= position.initialExecutedQuantity
  position.totalExecutedQuantity = Math.max(
    Number(position.totalExecutedQuantity || 0),
    exchangeQuantity + Number(position.closedQuantity || 0),
  )
  position.volumeUsd = exchangeQuantity * Number(position.averageExecutionPrice || position.entryPrice || 0)
  position.submissionState = "confirmed"

  if (pending && exactAdded > 0) {
    position.accumulatedSetKeys = pending.combinedPosCounts
      ? [...new Set((pending.accumulatedSetKeys || []).map(String).filter(Boolean))]
      : [...new Set([...(position.accumulatedSetKeys || []), ...(pending.setKey ? [pending.setKey] : [])])]
    if (pending.variant === "block") {
      const leg = buildBlockLegState({
        setKey: pending.setKey,
        blockCount: pending.blockCount,
        blockBaseVolumeMultiplier: pending.blockBaseVolumeMultiplier,
        blockVolumeRatio: pending.blockVolumeRatio,
        blockVolumeIncrementRatio: pending.blockVolumeIncrementRatio,
        blockCalculatedVolumeMultiplier: pending.blockCalculatedVolumeMultiplier,
      }, exactAdded, pending.clientOrderId, pending.orderId, {
        baseQuantity: pending.blockBaseQuantity,
        requestedQuantity: pending.requestedQuantity,
        positionQuantityAfter: exchangeQuantity,
      })
      if (leg) position.blockLegs = [...(position.blockLegs || []).filter((item) => item.setKey !== leg.setKey), leg]
    }
    if (pending.variant === "dca" && pending.dcaStep) {
      const profile = position.dcaProfile || normalizeDcaProfile({})
      position.dcaLegs = upsertDcaLeg(position.dcaLegs, {
        setKey: pending.setKey || `dca:${pending.dcaStep}`,
        step: pending.dcaStep,
        baseQuantity: position.initialExecutedQuantity || before,
        volumeMultiplier: pending.dcaVolumeMultiplier || 1,
        triggerDistancePct: pending.dcaTriggerDistancePct || 0,
        requestedQuantity: pending.requestedQuantity,
        quantity: exactAdded,
        referencePrice: pending.referencePrice || position.initialEntryPrice || position.entryPrice,
        positionQuantityAfter: exchangeQuantity,
        clientOrderId: pending.clientOrderId,
        orderId: pending.orderId,
        filledPrice: position.averageExecutionPrice,
        filledAt: Date.now(),
      })
      position.dcaTakeProfitPrice = calculateDcaTakeProfitPrice({
        direction: position.direction || "long",
        profile,
        initialEntryPrice: position.initialEntryPrice || position.entryPrice,
        averageEntryPrice: position.averageExecutionPrice,
        takeProfitPct: position.takeProfit || 0,
      })
    }
    position.pendingAccumulation = undefined
  }
  if (position.combinedPosCounts) {
    position.posCountsSetQuantities = allocatePositionSetQuantities(
      position,
      exchangeQuantity,
      position.accumulatedSetKeys,
    )
  }
  pushStep(
    position,
    "exchange_quantity_reconciled",
    true,
    `authoritative exchange quantity ${before} → ${exchangeQuantity}${exactAdded > 0 ? ` (+${exactAdded})` : ""}`,
  )
  position.updatedAt = Date.now()
  if (pending && exactAdded > 0 && pending.combinedPosCounts) {
    await recordConfirmedStrategyEntry(
      position.connectionId,
      position,
      `${position.id}:combined:${pending.clientOrderId}`,
    )
  } else if (pending && exactAdded > 0 && pending.setKey) {
    await recordConfirmedStrategyEntry(
      position.connectionId,
      position,
      `${position.id}:set:${pending.setKey}`,
      {
        setKey: pending.setKey,
        parentSetKey: pending.parentSetKey,
        indicationType: pending.indicationType,
        axisKey: pending.axisKey,
      },
    )
  }
  return true
}
const REFRESH_LOCK_TTL_LUA = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  end
  return 0
`

const RELEASE_LOCK_LUA = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`

async function evalLockLua(client: any, script: string, key: string, args: string[]): Promise<number> {
  if (typeof client.eval === "function") {
    try {
      return Number(await client.eval(script, { keys: [key], arguments: args })) || 0
    } catch (err) {
      // Some Redis adapters still expose the legacy node-redis signature.
      return Number(await client.eval(script, 1, key, ...args)) || 0
    }
  }

  // Test/dummy-client fallback that preserves the same token semantics.
  const current = typeof client.get === "function" ? await client.get(key) : null
  if (current !== args[0]) return 0
  if (script === REFRESH_LOCK_TTL_LUA) {
    if (typeof client.pExpire === "function") return Number(await client.pExpire(key, Number(args[1]))) || 0
    if (typeof client.pexpire === "function") return Number(await client.pexpire(key, Number(args[1]))) || 0
    if (typeof client.expire === "function") return Number(await client.expire(key, Math.ceil(Number(args[1]) / 1000))) || 0
    return 1
  }
  return typeof client.del === "function" ? Number(await client.del(key)) || 0 : 0
}

function startRedisLockLeaseRefresh(
  client: any,
  key: string,
  token: string,
  ttlMs: number,
): () => void {
  const timer = setInterval(() => {
    void evalLockLua(client, REFRESH_LOCK_TTL_LUA, key, [token, String(ttlMs)]).catch(() => 0)
  }, Math.max(1_000, Math.floor(ttlMs / 3)))
  timer.unref?.()
  return () => clearInterval(timer)
}

function logLockCoordinationWarning(action: "refresh" | "release", connId: string, symbol: string, direction: string): void {
  console.warn(
    `${LOG_PREFIX} [lock-coordination] ${action} skipped; token no longer owns live lock ` +
      `${connId}/${symbol}/${direction}`,
  )
}

async function refreshLockTTL(
  connId: string,
  symbol: string,
  direction: string,
  token: string,
  ttlMs: number = 300000,
): Promise<boolean> {
  const { getRedisClient } = await import("@/lib/redis-db")
  const client = getRedisClient()
  const key = `live:lock:${connId}:${symbol}:${direction}`
  try {
    const refreshed = (await evalLockLua(client, REFRESH_LOCK_TTL_LUA, key, [token, String(ttlMs)])) === 1
    if (!refreshed) logLockCoordinationWarning("refresh", connId, symbol, direction)
    return refreshed
  } catch {
    // best-effort; do not assume ownership if Redis cannot verify the token.
    logLockCoordinationWarning("refresh", connId, symbol, direction)
    return false
  }
}
async function releaseLock(connId: string, symbol: string, direction: string, token: string): Promise<boolean> {
  const { getRedisClient } = await import("@/lib/redis-db")
  const client = getRedisClient()
  const key = `live:lock:${connId}:${symbol}:${direction}`
  try {
    const released = (await evalLockLua(client, RELEASE_LOCK_LUA, key, [token])) === 1
    if (!released) logLockCoordinationWarning("release", connId, symbol, direction)
    return released
  } catch {
    // best-effort; failed token verification must not delete another worker's lock.
    logLockCoordinationWarning("release", connId, symbol, direction)
    return false
  }
}
function resolveMaxHoldMs(connId: string): number {
  // DEV/SIM override: the simulated connector uses a constant price so
  // positions never hit TP/SL organically. Without a short max-hold the
  // live:positions:{connId} list fills up unboundedly (500+ entries in a
  // few minutes), making positionsOpen stat nonsensical and consuming memory.
  // Cap at 2 minutes in non-production so positions roll quickly and the
  // open-book stays small. Real production runs use the configured value.
  // Delegate to the centralised engine-timings snapshot rather than a
  // bespoke settings read. `maxPositionHoldMs` is the single source of
  // truth (Redis `settings:system`, default 4h, `0` disables). The sync
  // getter returns the last cached snapshot — refreshed off the hot path
  // by `refreshEngineTimings()` — so the six reconcile/sweep call sites
  // pay zero per-tick Redis cost. The previous `return 0` stub silently
  // disabled the max-hold safety closer everywhere.
  try {
    const ms = getEngineTimings().maxPositionHoldMs
    return Number.isFinite(ms) && ms > 0 ? ms : 0
  } catch {
    return 0
  }
}

/**
 * Hard cap on the number of accumulations per live position.
 *
 * Without a cap, unlimited merges inflate position size proportionally
 * without any drawdown gating — the operator has no visibility and the
 * exchange may reject the accumulated notional.
 *   - 300 gives generous DCA headroom (1 initial entry + 299 merges ≈ 32× the
 *     initial allocation at equal-weight increments) for high-frequency strategies.
 */
const MAX_ACCUMULATIONS_PER_POSITION = 300

/**
 * Recognise exchange errors that CANNOT be fixed by retrying. For these
 * the operator must take an out-of-band action (top up margin, fix
 * leverage, restore symbol availability). Retrying just slams the
 * exchange and burns event-loop time on hopeless attempts.
 *
 * Currently catches:
 *   • BingX 101204 — Insufficient margin (top-up required)
 *   • BingX 80012  — Symbol not available for trading
 *   • Any error containing "insufficient margin" / "insufficient balance"
 *     / "not enough" (cross-exchange variants we may encounter)
 */
function isNonRecoverableExchangeError(payload: unknown): boolean {
  if (!payload) return false
  let text = ""
  if (typeof payload === "string") text = payload
  else if (payload instanceof Error) text = payload.message
  else if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>
    text = String(obj.error ?? obj.message ?? "")
  } else {
    text = String(payload)
  }
  if (!text) return false
  const lc = text.toLowerCase()
  return (
    /\bcode\s*=?\s*101204\b/.test(text) ||
    lc.includes("insufficient margin") ||
    lc.includes("insufficient balance") ||
    lc.includes("not enough margin") ||
    lc.includes("not enough balance")
  )
}

/**
 * Retry a promise-returning function with exponential backoff.
 *
 * Short-circuits on non-recoverable exchange errors (insufficient margin,
 * symbol not tradable, etc.) — see `isNonRecoverableExchangeError`. This
 * stops the engine from making 3 hopeless API calls per signal cycle when
 * the user has no balance, which was producing ~20 failed exchange calls
 * per second under the observed cycle cadence.
 */
async function retry<T>(
  fn: () => Promise<T>,
  isSuccess: (r: T) => boolean,
  label: string,
  maxAttempts = 3
): Promise<T> {
  let lastResult: T | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn()
      lastResult = result
      if (isSuccess(result)) return result
      console.warn(`${LOG_PREFIX} ${label} attempt ${attempt}/${maxAttempts} unsuccessful`)
      // The connector returned `{ success: false, error: "…" }` — check
      // whether that error is non-recoverable and bail early if so.
      if (isNonRecoverableExchangeError(result)) {
        console.warn(
          `${LOG_PREFIX} ${label} non-recoverable error detected — skipping remaining ${maxAttempts - attempt} attempt(s)`,
        )
        return result
      }
      // Min-order-size errors (code=101400) need a quantity correction, not
      // more retries with the same qty. Short-circuit immediately so the
      // caller's correction handler can run without waiting for 2 more attempts.
      if (isMinOrderSizeError(result)) {
        console.warn(
          `${LOG_PREFIX} ${label} min-order-size error — stopping retry loop for quantity correction`,
        )
        return result
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} ${label} attempt ${attempt}/${maxAttempts} error:`, err)
      // Thrown error variant — check the same predicates.
      if (isNonRecoverableExchangeError(err)) {
        console.warn(
          `${LOG_PREFIX} ${label} non-recoverable error detected — skipping remaining ${maxAttempts - attempt} attempt(s)`,
        )
        return { success: false, error: err instanceof Error ? err.message : String(err) } as unknown as T
      }
      if (isMinOrderSizeError(err)) {
        console.warn(`${LOG_PREFIX} ${label} min-order-size error — stopping retry loop`)
        return { success: false, error: err instanceof Error ? err.message : String(err) } as unknown as T
      }
      lastResult = undefined as unknown as T
    }
    if (attempt < maxAttempts) {
      // Tight backoff: 200 ms → 400 ms → 800 ms. Transient API blips
      // (network jitter, brief rate-limit, venue side proxy reload)
      // typically clear in well under 500 ms; the old 500/1000/2000 ms
      // schedule was burning roughly 1.5 s per failing entry without
      // adding success probability.
      const backoff = Math.pow(2, attempt - 1) * 200
      await new Promise(r => setTimeout(r, backoff))
    }
  }
  return lastResult as T
}

// ── Per-connection cooldown after non-recoverable margin errors ────��─
//
// When `executeLivePosition` fails with `code=101204` (Insufficient margin)
// the operator's account literally has no funds — nothing the engine can
// do programmatically will help. Without a cooldown, every Set evaluation
// on the next cycle re-attempts the order, generating a continuous
// stream of failed exchange API calls (~20/sec at observed cadence).
//
// Exponential backoff: each consecutive failure doubles the cooldown
// (60s ��� 120s → 240s → 300s cap). This prevents the re-arm loop where
// a 60s cooldown expires, the next attempt fails again (same root cause),
// and immediately re-arms for another 60s — making recovery appear stuck.
// After the operator tops up, the next successful order resets the counter.
//
// A `clearMarginCooldown(connectionId)` export allows the /api/engine/reconnect
// endpoint to forcibly release a stuck cooldown.
//
// NOTE: Exchange circuit-breaker errors (BingX code 109400 — "API orders
// temporarily disabled due to market volatility") are NOT margin errors.
// They have their own per-symbol gate (`circuitBreakerBySymbol`) with a
// 5-minute TTL and do NOT increment the margin failure counter.
const MARGIN_COOLDOWN_STEPS_MS = [60_000, 120_000, 240_000, 300_000]
const MARGIN_COOLDOWN_MAX_MS = 300_000

interface MarginCooldownEntry {
  lastErrorAt: number
  consecutiveFailures: number
}
const marginErrorCooldownByConnection: Map<string, MarginCooldownEntry> = new Map()

function isMarginCooldownActive(connectionId: string): boolean {
  const entry = marginErrorCooldownByConnection.get(connectionId)
  if (!entry) return false
  const stepIdx = Math.min(entry.consecutiveFailures - 1, MARGIN_COOLDOWN_STEPS_MS.length - 1)
  const cooldownMs = MARGIN_COOLDOWN_STEPS_MS[stepIdx] ?? MARGIN_COOLDOWN_MAX_MS
  if (Date.now() - entry.lastErrorAt < cooldownMs) return true
  // Cooldown expired — clear so the next attempt runs fresh.
  marginErrorCooldownByConnection.delete(connectionId)
  return false
}

function recordMarginError(connectionId: string): void {
  const existing = marginErrorCooldownByConnection.get(connectionId)
  marginErrorCooldownByConnection.set(connectionId, {
    lastErrorAt: Date.now(),
    consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
  })
}

/** Exported so the /api/engine/reconnect endpoint can forcibly clear a stuck cooldown. */
export function clearMarginCooldown(connectionId: string): void {
  marginErrorCooldownByConnection.delete(connectionId)
  console.log(`${LOG_PREFIX} Margin cooldown cleared for ${connectionId}`)
}

// ── Per-symbol exchange circuit-breaker gate ──────────────────────────
// BingX code 109400 means the exchange has TEMPORARILY disabled API
// trading for that symbol due to extreme volatility. This is NOT a
// margin/balance issue — the account is fine, the exchange re-enables
// trading automatically (typically within 1–5 minutes). We skip the
// symbol for 5 minutes then resume WITHOUT touching the margin counter,
// preventing one volatile symbol from blocking all orders on the connection.
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60_000 // 5 minutes
const circuitBreakerBySymbol: Map<string, number> = new Map()

function isCircuitBreakerActive(symbol: string): boolean {
  const ts = circuitBreakerBySymbol.get(symbol)
  if (!ts) return false
  if (Date.now() - ts < CIRCUIT_BREAKER_COOLDOWN_MS) return true
  circuitBreakerBySymbol.delete(symbol)
  return false
}

function recordCircuitBreaker(symbol: string): void {
  circuitBreakerBySymbol.set(symbol, Date.now())
}

function isCircuitBreakerError(payload: unknown): boolean {
  if (!payload) return false
  let text = ""
  if (typeof payload === "string") text = payload
  else if (payload instanceof Error) text = payload.message
  else if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>
    text = String(obj.error ?? obj.message ?? "")
  } else {
    text = String(payload)
  }
  return (
    /\bcode\s*=?\s*109400\b/.test(text) ||
    /\bcode\s*=?\s*109418\b/.test(text) ||   // symbol offline / delisted
    /api orders? (?:are )?temporarily disabled/i.test(text) ||
    /large market fluctuations/i.test(text) ||
    /is offline currently/i.test(text)
  )
}

/**
 * Detect BingX code=101400 "minimum order amount" rejections.
 * These mean the requested quantity is below the exchange-required minimum for
 * the specific trading pair. The volume calculator will respect the stored
 * min_order_size on the next cycle, so this is a transient failure that
 * self-heals once the metadata is written to Redis.
 */
function isMinOrderSizeError(payload: unknown): boolean {
  if (!payload) return false
  let text = ""
  if (typeof payload === "string") text = payload
  else if (payload instanceof Error) text = payload.message
  else if (typeof payload === "object") {
    text = String((payload as Record<string, unknown>).error ?? (payload as Record<string, unknown>).message ?? "")
  } else {
    text = String(payload)
  }
  // 110424 is the opposite condition: requested reduce quantity is greater
  // than the available position amount. It must never be classified as a
  // minimum-size rejection or cause the engine to increase quantity.
  return (
    /\bcode\s*=?\s*101400\b/.test(text) ||
    /minimum order/i.test(text)
  )
}

/**
 * Parse the minimum token quantity from BingX error messages.
 * BingX formats:
 *   - "The minimum order amount is 56.974 DRIFT" (101400)
 *   - "The order size must be less than the available amount of 0.0001 BTC" (110424)
 * Returns undefined when the message does not match expected formats.
 */
function extractMinOrderQty(payload: unknown): number | undefined {
  let text = ""
  if (typeof payload === "string") text = payload
  else if (payload instanceof Error) text = payload.message
  else if (typeof payload === "object") {
    text = String((payload as Record<string, unknown>).error ?? (payload as Record<string, unknown>).message ?? "")
  }
  
  // Try "minimum order amount is X" format
  let m = /minimum order amount is ([\d.]+)/i.exec(text)
  if (m) {
    const qty = parseFloat(m[1])
    if (Number.isFinite(qty) && qty > 0) return qty
  }
  
  return undefined
}

/**
 * Poll an order until it reaches a terminal fill state or the timeout elapses.
 *
 * ── Fast-ramp polling schedule ───────────────────���───────────────────
 * Market orders on most venues acknowledge as `FILLED` within 100-300 ms;
 * a flat 800 ms poll interval therefore wastes ~600 ms on every entry
 * before we can place SL/TP. The new schedule:
 *
 *   poll 1: 100 ms
 *   poll 2: 200 ms
 *   poll 3: 350 ms
 *   poll 4+: 600 ms (steady state for stubborn limit orders)
 *
 * Total latency to detect a typical instant fill drops from ~800 ms to
 * ~100 ms, while still tolerating slow venues without flooding the API.
 */
async function pollOrderFill(
  connector: any,
  symbol: string,
  orderId: string,
  timeoutMs = 15000,
  _legacyIntervalMs = 800,
): Promise<{ filled: boolean; filledQty: number; filledPrice: number; status: string }> {
  void _legacyIntervalMs
  // Guard: a missing orderId means the exchange didn't return one (API
  // issue or order was immediately rejected). Don't call getOrder(undefined)
  // — it generates exchange API spam and never confirms a fill.
  if (!orderId) {
    return { filled: false, filledQty: 0, filledPrice: 0, status: "pending" }
  }
  const intervals = [100, 200, 350, 600]
  const deadline = Date.now() + timeoutMs
  let lastStatus = "pending"
  let pollIdx = 0
  // Track the best partial result seen so far — return it on timeout rather
  // than returning filled=false when we know some qty was actually transacted.
  let bestPartialQty = 0
  let bestPartialPrice = 0
  while (Date.now() < deadline) {
    try {
      const order = await connector.getOrder(symbol, orderId)
      if (order) {
        lastStatus = order.status || order.orderStatus || "unknown"
        const statusLower = String(lastStatus).toLowerCase().trim()
        const rawFilledQty  = parseFloat(String(order.filledQty  ?? order.executedQty ?? order.cumQty    ?? "0")) || 0
        const rawFilledPrice = parseFloat(String(order.filledPrice ?? order.avgPrice   ?? order.price     ?? "0")) || 0

        // Any of these status strings mean the exchange has fully transacted the order.
        const isFilled =
          statusLower === "filled" ||
          statusLower === "deal" ||        // BingX historical alias
          statusLower === "complete" ||
          statusLower === "completed" ||
          order.status === "FILLED"

        // Partial fills: qty > 0 even if status isn't fully "filled" yet.
        // Accept as usable — protection orders should be sized to filledQty,
        // not the requested qty. Remaining qty will be covered by reconcile.
        const isPartialFill =
          (statusLower === "partially_filled" || statusLower === "partial_fill") &&
          rawFilledQty > 0

        if (rawFilledQty > bestPartialQty) {
          bestPartialQty  = rawFilledQty
          bestPartialPrice = rawFilledPrice
        }

        if ((isFilled || isPartialFill) && rawFilledQty > 0) {
          return {
            filled: true,
            filledQty: rawFilledQty,
            filledPrice: rawFilledPrice || 0,
            status: isFilled ? "filled" : "partially_filled",
          }
        }
        if (statusLower === "cancelled" || statusLower === "canceled" || statusLower === "rejected") {
          return { filled: false, filledQty: 0, filledPrice: 0, status: statusLower }
        }
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} poll error:`, err instanceof Error ? err.message : String(err))
    }
    
    // Calculate wait time with exponential backoff
    const wait = intervals[Math.min(pollIdx, intervals.length - 1)]
    pollIdx += 1
    
    // Early return on next poll attempt if near deadline (avoid wasting final poll)
    const remainingTime = deadline - Date.now()
    if (remainingTime <= 50) break
    
    await new Promise(r => setTimeout(r, Math.min(wait, remainingTime)))
  }
  // Timeout — return whatever partial qty we managed to see rather than zero.
  // A non-zero bestPartialQty means the exchange has transacted at least some
  // volume; returning it lets the caller place SL/TP for the confirmed portion.
  if (bestPartialQty > 0) {
    return { filled: true, filledQty: bestPartialQty, filledPrice: bestPartialPrice, status: "partially_filled" }
  }
  return { filled: false, filledQty: 0, filledPrice: 0, status: lastStatus }
}


/**
 * Batch poll multiple orders for fills in parallel.
 * 
 * When multiple orders are in-flight during live trading, polling each
 * individually wastes time waiting for sequential getOrder calls. This
 * function polls all orders concurrently against the same deadline,
 * reducing total fill detection time from N*100ms to ~100ms.
 * 
 * Example: 5 orders in-flight
 *   Sequential: 5 × 100ms = 500ms minimum
 *   Batch: 1 × 100ms = 100ms minimum (50% faster)
 */
async function batchPollOrderFills(
  connector: any,
  orders: Array<{ symbol: string; orderId: string }>,
  timeoutMs = 15000,
): Promise<Record<string, { filled: boolean; filledQty: number; filledPrice: number; status: string }>> {
  if (!orders || orders.length === 0) return {}
  
  // Poll all orders in parallel instead of sequentially
  const pollPromises = orders.map(({ symbol, orderId }) =>
    pollOrderFill(connector, symbol, orderId, timeoutMs).catch(err => {
      console.warn(`${LOG_PREFIX} batch poll failed for ${orderId}:`, err instanceof Error ? err.message : String(err))
      return { filled: false, filledQty: 0, filledPrice: 0, status: "error" }
    })
  )
  
  const results = await Promise.all(pollPromises)
  const output: Record<string, any> = {}
  
  orders.forEach((order, idx) => {
    output[order.orderId] = results[idx]
  })
  
  return output
}

/**
 * Cancel an SL/TP order on the exchange. Tolerates "order not found" and
 * other recoverable errors silently — the typical reason this is called
 * is that the position is being closed or the protection order is being
 * replaced, both of which mean we don't care if it's already gone.
 *
 * Returns `true` only when we actively confirmed cancellation (or that
 * the connector accepted the request); returns `false` for any error so
 * callers can decide whether to retry or fall through to a market exit.
 */
/**
 * Cancel every leftover reduce-only order on the venue for a given
 * symbol+close-side pair. This is the safety-net used immediately AFTER
 * `closeLivePosition` finishes its by-id cancellations.
 *
 * Why we need a sweep on top of the recorded-id cancellations:
 *   1. The recorded protection ids may be stale (re-armed after a
 *      partial fill, the old id never made it to `savePosition` because
 *      the process crashed between place-success and persist).
 *   2. A by-id cancel can return failure for a transient reason (network
 *      blip, brief 429) and the engine cannot afford to keep retrying
 *      indefinitely. The sweep doubles as a retry on the next tick.
 *   3. An operator may have placed a manual reduce-only leg that the
 *      engine never knew about. Once the position is gone, that order
 *      can only ever cause "exchange control orders chaos" — it has no
 *      position to reduce, and the next entry on the same symbol would
 *      see it as an unexpected closer.
 *
 * We filter conservatively to ONLY reduce-only orders matching the
 * close direction so the sweep never touches another strategy's open
 * orders on the same symbol.
 */
async function sweepOrphanProtectionOrders(
  connector: any,
  symbol: string,
  closeSide: "buy" | "sell",
  position: LivePosition,
): Promise<{ scanned: number; cancelled: number }> {
  const result = { scanned: 0, cancelled: 0 }
  if (!connector || typeof connector.getOpenOrders !== "function") return result
  let orders: any[] = []
  try {
    const raw = (await withTimeout(
      connector.getOpenOrders(symbol) as Promise<any>,
      15_000,
      `sweepOrphan.getOpenOrders(${symbol})`,
    )) as any[] | undefined
    orders = Array.isArray(raw) ? raw : []
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} [sweep] getOpenOrders(${symbol}) failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return result
  }
  result.scanned = orders.length

  // A reduce-only order with side === closeSide is, by definition, a
  // protection leg for a position in `closeSide`'s opposite direction.
  // We accept any flavour of the reduce-only flag the connectors emit:
  // `reduceOnly`, `reduce_only`, `closePosition`, `isReduceOnly`.
  //
  // BingX HEDGE-MODE SPECIAL CASE:
  // In hedge mode (the default on BingX Perpetuals) the exchange does NOT
  // set `reduceOnly=true` on SL/TP orders — the position-reduction semantic
  // is instead conveyed by `positionSide` ("LONG" / "SHORT"). Without the
  // explicit flag, the original `isReduceOnly` check always returns false and
  // orphan protection orders are NEVER swept, leaving stale SL/TP orders on
  // the exchange indefinitely where they fire against the next entry.
  //
  // Fix: additionally treat any order as a protection candidate when its
  // `type` is a known stop/TP order type AND it is on the closing side.
  // These types are exchange-level SL/TP market trigger orders regardless of
  // the hedge/one-way mode and cannot be non-protection regular orders on the
  // closing side with these types.
  const PROTECTION_ORDER_TYPES = new Set([
    "STOP_MARKET", "TAKE_PROFIT_MARKET", "STOP", "TAKE_PROFIT",
    "stop_market", "take_profit_market", "stop", "take_profit",
  ])
  const isReduceOnly = (o: any): boolean =>
    !!(o?.reduceOnly ?? o?.reduce_only ?? o?.closePosition ?? o?.isReduceOnly)
  const isProtectionType = (o: any): boolean =>
    PROTECTION_ORDER_TYPES.has(String(o?.type ?? o?.orderType ?? ""))
  const sameSide = (o: any): boolean =>
    String(o?.side ?? o?.orderSide ?? "").toLowerCase() === closeSide

  const ownedOrderIds = new Set<string>()
  const ownedClientOrderIds = new Set<string>()
  for (const value of [position.stopLossOrderId, position.takeProfitOrderId]) {
    if (value) ownedOrderIds.add(String(value))
  }
  for (const pending of Object.values(position.pendingProtectionOrders || {})) {
    if (pending?.clientOrderId) ownedClientOrderIds.add(String(pending.clientOrderId))
  }
  const clientOrderHistory = (position.exchangeData as any)?.clientOrderIds
  if (Array.isArray(clientOrderHistory)) {
    for (const entry of clientOrderHistory) {
      if (entry?.kind === "stop_loss" || entry?.kind === "take_profit") {
        const value = entry?.clientOrderId ?? entry?.id
        if (value) ownedClientOrderIds.add(String(value))
      }
    }
  }

  // ── BingX hedge-mode direction isolation ────────────────────────────────
  // In hedge mode the exchange annotates each order with `positionSide`
  // ("LONG" or "SHORT"). A sell-side STOP_MARKET for positionSide=SHORT is
  // the SHORT position's *stop loss* — it is NOT an orphan of the LONG
  // position we are closing. Without this guard, closing a LONG would sweep
  // the SHORT's protection orders and leave the SHORT position unprotected.
  //
  // When the field is absent ("BOTH" or empty) the account is in one-way
  // mode and the original side-match is already sufficient.
  //
  // closeSide="sell" → we are closing a LONG  → keep only positionSide=LONG
  // closeSide="buy"  → we are closing a SHORT → keep only positionSide=SHORT
  const matchesPositionSide = (o: any): boolean => {
    const ps = String(o?.positionSide ?? o?.position_side ?? "").toUpperCase()
    if (!ps || ps === "BOTH" || ps === "") return true  // one-way mode or field absent
    const expectedPs = closeSide === "sell" ? "LONG" : "SHORT"
    return ps === expectedPs
  }

  for (const o of orders) {
    // Accept the order as a sweep candidate when it is on the closing side,
    // scoped to the correct position direction (hedge-mode guard above),
    // AND either carries an explicit reduce-only flag (one-way mode) OR has a
    // stop/TP order type (hedge mode where the flag is absent).
    const sideOk = sameSide(o)
    const psOk   = matchesPositionSide(o)
    const typeOk = isReduceOnly(o) || isProtectionType(o)
    const exchangeOrderId = o?.id ?? o?.orderId ?? o?.orderID
    const clientOrderId = o?.clientOrderId ?? o?.clientOrderID ?? o?.client_oid
    const ordId  = exchangeOrderId ?? clientOrderId
    const ownershipMatches =
      (exchangeOrderId != null && ownedOrderIds.has(String(exchangeOrderId))) ||
      (clientOrderId != null && ownedClientOrderIds.has(String(clientOrderId)))
    if (!sideOk) continue
    if (!psOk) continue
    if (!typeOk) continue
    // Manual/foreign orders never match the durable ownership allow-list.
    if (!ownershipMatches) continue
    if (ordId == null || String(ordId).length === 0) continue
    const ok = await cancelProtectionOrder(connector, symbol, String(ordId), "OrphanSweep", position.connectionId)
    if (ok) result.cancelled++
  }

  if (result.cancelled > 0 || result.scanned > 0) {
    console.log(
      `${LOG_PREFIX} [sweep] ${symbol} close=${closeSide}: scanned=${result.scanned} cancelled=${result.cancelled}`,
    )
  }
  return result
}

async function cancelProtectionOrder(
  connector: any,
  symbol: string,
  orderId: string | undefined,
  label: string,
  connectionId?: string,
): Promise<boolean> {
  if (!orderId) return false
  try {
    if (typeof connector?.cancelOrder !== "function") return false
    // withTimeout wraps cancelOrder; actual HTTP timeout is enforced by the
    // rate-limiter's executeTimeoutMs (dispatch-time only, not enqueue-time).
    const res = await withTimeout(
      connector.cancelOrder(symbol, orderId) as Promise<any>,
      EXCHANGE_TIMEOUT_CANCEL_ORDER_MS,
      `cancelOrder(${label} ${orderId})`,
    )
    if (res?.success) {
      console.log(`${LOG_PREFIX} ${label} cancelled: ${orderId}`)
      return true
    }
    // Treat "not found" / "already filled" / "already cancelled" as success
    // for our purposes — the exchange-side state is already what we wanted.
    const errStr = String(res?.error || "").toLowerCase()
    if (
      errStr.includes("not found") ||
      errStr.includes("not exist") ||
      errStr.includes("order does not exist") ||
      errStr.includes("already filled") ||
      errStr.includes("already cancelled") ||
      errStr.includes("already canceled") ||
      // BingX-specific already-gone codes in the error message:
      //   101400 = "Order not exist" (filled or externally cancelled SL/TP)
      //   101500 = "Order not found" (expired conditional order)
      errStr.includes("code=101400") ||
      errStr.includes("code=101500")
    ) {
      console.log(`${LOG_PREFIX} ${label} already gone: ${orderId} (${res?.error})`)
      return true
    }
    // ── BingX code 100410: trigger frequency limit throttling ──────────────────────
    // When we hit BingX's endpoint trigger frequency limit, activate the 30s backoff
    // to stop hammering this specific connector with cancellation attempts.
    if (errStr.includes("code=100410") && connectionId) {
      markTriggerFrequencyThrottled(connectionId)
      console.warn(`${LOG_PREFIX} [TriggerFrequency] ${label} cancel failed: ${orderId} — ${res?.error}`)
      return false
    }
    console.warn(`${LOG_PREFIX} ${label} cancel failed: ${orderId} — ${res?.error}`)
    return false
  } catch (err) {
    console.warn(`${LOG_PREFIX} ${label} cancel error:`, err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Place a protection order (SL or TP) as a reduce-only limit order at
 * `triggerPrice` that *closes* (never opens) a position.
 *
 * On hedge-mode perp accounts the connector needs to know the positionSide
 * of the OPEN position (LONG/SHORT), which is independent of the order's
 * close side. Passing `reduceOnly=true` + the correct `positionSide` is
 * what prevents the exchange from treating this as a new opposite-side
 * entry and hedging against the real position.
 */
async function placeProtectionOrder(
  connector: any,
  symbol: string,
  closeSide: "buy" | "sell",
  quantity: number,
  triggerPrice: number,
  orderLabel: "StopLoss" | "TakeProfit",
  positionDirection: "long" | "short",
  clientOrderId?: string,
): Promise<string | null> {
  // ── Structured trace context ──────────────────────���─────────────────
  // Every protection-order placement gets a single multi-field log line
  // before any exchange interaction, so when an operator reports "the
  // order didn't get created" we can immediately answer THREE questions
  // from one grep:
  //   1. What were the inputs the engine sent?
  //   2. Did we even reach the venue? (rejected-locally entries say so)
  //   3. What did the venue say back? (success line includes id/latency,
  //      failure line includes the venue error verbatim)
  const tag = `${LOG_PREFIX} [${orderLabel}] ${symbol}`
  const placeStart = Date.now()
  console.log(
    `${tag} placement requested: dir=${positionDirection} closeSide=${closeSide} qty=${quantity} trigger=${triggerPrice}`,
  )

  try {
    // Prefer the connector's CONDITIONAL-order path
    // (`placeStopOrder`) over a regular `placeOrder`. The legacy code
    // here used `placeOrder(..., "limit")` at the trigger price — which
    // for SL on a long is a sell-limit BELOW market and gets rejected
    // by most exchanges as an aggressive reduce-only, leaving the
    // position unprotected. `placeStopOrder` lands a real STOP_MARKET /
    // TAKE_PROFIT_MARKET (BingX) or `triggerPrice`-based market reduce
    // (Bybit), and falls back to the limit-as-trigger behaviour on
    // connectors that haven't been upgraded yet (see `BaseExchangeConnector`).
    if (typeof connector?.placeStopOrder !== "function") {
      console.warn(`${tag} REJECTED LOCALLY: connector has no placeStopOrder — protection unavailable`)
      return null
    }

    // Defensive input validation. The SL/TP test suite previously sent
    // `NaN` quantity from a venue-shape mismatch and the exchange echoed
    // back "Invalid quantity: NaN" 800 ms later — costly because by then
    // the entry position is already live and unprotected. Validate at the
    // helper boundary so a future bug upstream surfaces immediately as a
    // local log line rather than as a venue-side rejection mid-trade.
    if (!Number.isFinite(quantity) || quantity <= 0) {
      console.error(`${tag} REJECTED LOCALLY: invalid quantity=${quantity} (must be finite, >0)`)
      return null
    }
    if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
      console.error(`${tag} REJECTED LOCALLY: invalid triggerPrice=${triggerPrice} (must be finite, >0)`)
      return null
    }

    // A reduce-only protection quantity must never exceed authoritative
    // position size. Venue minimums are entry constraints; increasing a close
    // order creates 110424 and can leave the position unprotected.
    let effectiveQty = quantity

    const kind: "stop_loss" | "take_profit" =
      orderLabel === "StopLoss" ? "stop_loss" : "take_profit"

    // ── Helper: extract numeric "available amount" from a 110424 message ──
    // Error text: "The order size must be less than the available amount of 0.77 SOL"
    const extract110424Available = (errMsg: string): number | null => {
      const m = /available amount of ([\d.]+)/i.exec(errMsg)
      if (!m) return null
      const n = parseFloat(m[1])
      return Number.isFinite(n) && n > 0 ? n : null
    }

    // NOTE: We do NOT pass `hedgeMode` here. The BingX connector defaults to
    // hedgeMode=true (sends `positionSide`) and includes a built-in one-way
    // fallback retry that fires when BingX returns code=80014. Passing
    // hedgeMode:false would suppress `positionSide` entirely — which works
    // on one-way accounts but breaks hedge accounts (BingX requires
    // positionSide there, and the retry path only handles the inverse
    // hedge→one-way case). Letting the connector default to hedge-mode +
    // auto-retry covers both account types correctly.
    // Bounded — a hanging placeStopOrder would block the per-position sync
    // loop and stall every other position's heal/close work behind it. On
    // timeout we return null; the next sync tick will retry, and meanwhile
    // `checkAndForceCloseOnSltpCross` provides the safety net (it triggers
    // on price independent of whether the protection order is armed).
    // ── Normalize connector throws to result objects ──────────────────────
    // The BingX connector (and others) throw on venue rejection rather than
    // returning { success: false }.  The 109420 / 110424 retry blocks below
    // check `result?.error`, which is never set when a throw escapes directly
    // to the outer catch.  By wrapping each `placeStopOrder` call in its own
    // try-catch we guarantee all code paths reach the retry checks with a
    // well-shaped result object.
    const placeStop = async (qty: number): Promise<any> => {
      // Acquire the global semaphore before calling the exchange.
      // EXCHANGE_TIMEOUT_PLACE_STOP_MS is applied via the rate-limiter's
      // executeTimeoutMs (starts from dispatch time, not enqueue time) so the
      // timeout only covers actual HTTP time — not queue-wait time. This prevents
      // "Aborted while queued" errors from killing requests before they start.
      await acquireStopSem()
      try {
        return await withTimeout(
          connector.placeStopOrder(
            symbol,
            closeSide,
            qty,
            triggerPrice,
            kind,
            {
              reduceOnly: true,
              positionSide: positionDirection === "long" ? "LONG" : "SHORT",
              ...(clientOrderId ? { clientOrderId } : {}),
            },
          ) as Promise<any>,
          EXCHANGE_TIMEOUT_PLACE_STOP_MS,
          `placeStopOrder(${orderLabel} ${symbol})`,
        )
      } catch (e: any) {
        return { success: false, error: String(e?.message || e) }
      } finally {
        releaseStopSem()
      }
    }

    let result = await placeStop(effectiveQty)

    // ── code=110424: "order size must be less than available amount" ───
    // Triggered when the protection qty exceeds the position's remaining
    // available quantity.  Common cause: venue minimum (e.g. 1 TRB) is larger
    // than the partial fill size (e.g. 0.62 TRB), or two concurrent SL+TP
    // placements race to claim the same available pool.
    // Strategy: up to 2 retries, each time re-parsing the available qty from
    // BingX's error message and retrying with exactly that amount.  If the
    // second retry also fails with 110424, the position has likely been
    // externally closed or fully consumed by the other protection leg — treat
    // it as success (reconcile will verify).
    if (!result?.success) {
      const is110424 = (msg: string) => msg.includes("110424") || /available amount/i.test(msg)
      let attempt = 0
      while (!result?.success && is110424(String(result?.error || "")) && attempt < 2) {
        const errMsg = String(result?.error || "")
        const availableQty = extract110424Available(errMsg)
        if (availableQty === null) break
        if (availableQty <= 0) break
        console.warn(
          `${tag} 110424 retry#${attempt + 1}: qty=${effectiveQty} > available=${availableQty} — retrying`,
        )
        effectiveQty = Math.min(quantity, availableQty)
        if (effectiveQty <= 0) break
        result = await placeStop(effectiveQty)
        attempt++
      }
      // Repeated 110424 is not success; reconciliation must refresh the
      // authoritative position quantity before another protection attempt.
      if (!result?.success && is110424(String(result?.error || ""))) {
        const secondAvail = extract110424Available(String(result?.error || ""))
        console.warn(
          `${tag} 110424 exhausted after ${attempt} retries (lastAvail=${secondAvail}) — awaiting quantity reconciliation`,
        )
      }
      // Update effectiveQty on first-retry success
      if (result?.success && effectiveQty !== quantity) {
        // qty was adjusted; already updated in loop above
      }
    }

    // ── code=109420: "position not exist" ────���─────────────────────────────
    // BingX hedge-mode positions need a short settling period after a market
    // order is accepted before a STOP/TP can reference them. In the
    // unconfirmed-fill path the 2 s post-fill wait (live-stage ~line 2795)
    // is sometimes insufficient for volatile symbols (DOGE, ADA). Retry once
    // after an additional 2 s; reconcile will arm the order on the next tick
    // if the retry also fails (position will have settled by then).
    if (!result?.success) {
      const errMsg109 = String(result?.error || "")
      if (errMsg109.includes("109420") || /position not exist/i.test(errMsg109)) {
        // Exponential backoff: 1s, 2s, 4s.
        // BingX hedge-mode positions can take 2–4 s to become visible
        // under load. The old 500ms/1s/2s budget was exhausted too quickly,
        // causing the protection order to be deferred to the next reconcile
        // tick — leaving the position unprotected for up to 60 s.
        const BACKOFF_DELAYS_MS = [1000, 2000, 4000]
        let retryAttempt = 0
        while (retryAttempt < BACKOFF_DELAYS_MS.length && !result?.success) {
          const delay = BACKOFF_DELAYS_MS[retryAttempt]
          console.warn(`${tag} 109420 retry: position not yet visible on exchange — waiting ${delay}ms before retry`)
          await new Promise((r) => setTimeout(r, delay))
          result = await placeStop(effectiveQty)
          if (result?.success) {
            console.log(`${tag} 109420 retry succeeded after ${delay}ms`)
            break
          }
          retryAttempt++
        }
        if (!result?.success) {
          console.warn(`${tag} 109420 retries exhausted (tried 1s, 2s, 4s) — reconcile will retry on next tick`)
        }
      }
    }

    const latencyMs = Date.now() - placeStart
    // Coerce id to string. Some venues return numeric ids; downstream
    // code does `if (pos.stopLossOrderId)` checks that would mistake a
    // legitimately-zero (or zero-string) id for "no order placed". The
    // venues we support never issue id=0 in practice, but the coercion
    // keeps the type contract identical across connectors.
    const rawId = result?.success ? (result.orderId ?? result.id) : null
    const orderId = rawId !== null && rawId !== undefined && String(rawId).length > 0 ? String(rawId) : null
    if (orderId) {
      console.log(
        `${tag} PLACED: orderId=${orderId} @ trigger=${triggerPrice} qty=${effectiveQty}${effectiveQty !== quantity ? ` (requested=${quantity}, adjusted)` : ""} latency=${latencyMs}ms`,
      )
      return orderId
    }
    // code=110412 / 110413: "SL price must be > current price" (for long SL placed above mark)
    // or "TP price must be < current price" (for short TP placed above mark after a spike).
    // The protection price was valid at calculation time but the market moved past it between
    // calculation and placement. Return the sentinel "PRICE_CROSSED" so the caller can
    // force-close the position immediately instead of waiting for the next reconcile tick.
    const errMsg = String(result?.error || "")
    const is110412 = errMsg.includes("110412") || /SL price should (be|not be)|Stop Loss price should/i.test(errMsg)
    const is110413 = errMsg.includes("110413") || /TP price should (be|not be)|Take Profit price should/i.test(errMsg)
    if (is110412 || is110413) {
      console.warn(
        `${tag} PRICE_CROSSED (code=${is110412 ? "110412" : "110413"}): market moved past ${kind} trigger — position will be force-closed`,
      )
      return "PRICE_CROSSED"
    }
    // code=110206: "The number of your TP/SL orders has exceeded the limit."
    // The account's open protection-order quota is full. Retrying immediately
    // is pointless — the quota won't free until existing SL/TP orders close.
    // Return "QUOTA_EXCEEDED" so callers can skip re-arm and back off.
    const is110206 = errMsg.includes("110206") || /TP\/SL orders has exceeded|number of.*TP.*SL.*exceeded/i.test(errMsg)
    if (is110206) {
      // connectionId is not in scope here; the caller (updateProtectionOrders)
      // reads the sentinel and calls markProtectionQuotaExhausted(connId).
      console.warn(`${tag} QUOTA_EXCEEDED (code=110206): TP/SL order limit reached — caller will suspend placement`)
      return "QUOTA_EXCEEDED"
    }
    // result.error is the connector's normalized venue-side message.
    // Log verbatim so operators see the EXACT venue rejection.
    console.warn(
      `${tag} VENUE REJECTED: error="${result?.error || "unknown"}" code=${result?.code ?? "n/a"} latency=${latencyMs}ms`,
    )
    return null
  } catch (err) {
    const latencyMs = Date.now() - placeStart
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`${tag} EXCEPTION: ${msg} latency=${latencyMs}ms`)
    return null
  }
}

/**
 * Snapshot every order ID currently open on the venue, across all
 * symbols, as a single normalized `Set<string>`. Used by the reconcile
 * and sync loops to verify each position's recorded `stopLossOrderId`
 * and `takeProfitOrderId` are still alive on the exchange — without
 * making one `getOrder()` call per leg per position per tick.
 *
 * Returns `null` when the connector either has no `getOpenOrders` or
 * when the call fails/times out. Callers MUST treat `null` as "skip
 * liveness verification this tick" rather than "no orders exist" — the
 * latter would incorrectly wipe every protection id on a transient
 * network blip.
 *
 * Cross-venue order-id field walk matches the test harness in
 * `/api/test/live-orders-test`: BingX returns `orderId`, ccxt-style
 * adapters return `id`, some return both. We collect every non-empty
 * candidate per row so we cannot miss a leg because the connector
 * happened to name the field differently than expected.
 */
async function fetchLiveOrderIdSet(connector: any): Promise<Set<string> | null> {
  if (!connector || typeof connector.getOpenOrders !== "function") return null
  try {
    // 25 s upper bound — BingX getOpenOrders queues behind live-order calls
    // in the rate limiter. With maxConcurrent=3 and a placeOrder (market) in
    // flight, getOpenOrders may wait up to ~15 s in queue before the HTTP
    // request even starts. 25 s covers queue-wait + HTTP round-trip reliably
    // without blocking the rate limiter indefinitely.
    // On timeout we degrade gracefully to drift-only reconciliation.
    const orders = (await withTimeout(
      connector.getOpenOrders() as Promise<any>,
      25_000,
      "getOpenOrders(reconcile-tick)",
    )) as any[] | undefined
    if (!Array.isArray(orders)) return null
    const snapshotStatus = typeof connector.getLastOpenOrdersSnapshotStatus === "function"
      ? connector.getLastOpenOrdersSnapshotStatus()
      : { ok: true }
    if (snapshotStatus.ok !== true) return null
    const set = new Set<string>()
    for (const o of orders) {
      // Prefer exchange-assigned numeric IDs over operator-supplied client IDs.
      // Using `clientOrderId`/`client_oid` as a fallback is safe only when no
      // real numeric ID is present on the order — otherwise a future client-ID
      // echo from the connector could mask a genuinely-missing real orderId and
      // suppress liveness-based re-arming of a gone SL/TP order.
      const realId = o?.id ?? o?.orderId ?? o?.orderID
      if (realId != null && String(realId).length > 0) {
        set.add(String(realId))
        // Also add the secondary form so both "1234" and "orderId:1234" styles
        // that different connectors might store on the position are matched.
        if (o?.orderId != null && String(o.orderId) !== String(realId)) set.add(String(o.orderId))
        if (o?.id     != null && String(o.id)      !== String(realId)) set.add(String(o.id))
      }
      // Keep the client id alongside the venue id. Durable submissions are
      // written under this id before the HTTP request, so restart recovery can
      // resolve a response-lost order without issuing a duplicate.
      const fallback = o?.clientOrderId ?? o?.clientOrderID ?? o?.client_oid
      if (fallback != null && String(fallback).length > 0) set.add(String(fallback))
    }
    return set
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} fetchLiveOrderIdSet failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/**
 * Derive the desired SL/TP trigger prices from a live position's current
 * percentage settings and average execution price. Returns `0` for either
 * leg when the corresponding percentage is non-positive (i.e. SL/TP is
 * disabled for that side). Pure function — does NOT touch the exchange.
 */
function computeDesiredProtectionPrices(pos: LivePosition): {
  desiredSl: number
  desiredTp: number
} {
  const fillPrice = pos.averageExecutionPrice || pos.entryPrice
  // CRITICAL: Guard against undefined, NaN, negative, or zero fill prices
  // that would cause NaN or Infinity propagation in SL/TP calculations.
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return { desiredSl: 0, desiredTp: 0 }

  // ── Trailing stop: use the ratcheted absolute price directly ────────────────
  // When trailing is active syncLiveFromPseudo stamps pos.trailingStopPrice
  // with the latest ratcheted absolute stop level. Using that absolute price
  // directly avoids the percentage-anchored re-derivation below which would
  // always revert to the static origin level, fighting the ratchet every tick.
  const manual = pos.manualProtectionOverride
  const hasManualSl = !!manual && Object.prototype.hasOwnProperty.call(manual, "stopLossPrice")
  const hasManualTp = !!manual && Object.prototype.hasOwnProperty.call(manual, "takeProfitPrice")
  let desiredSl: number
  const trailingPrice = typeof pos.trailingStopPrice === "number" ? pos.trailingStopPrice : 0
  if (pos.trailingActive && Number.isFinite(trailingPrice) && trailingPrice > 0) {
    desiredSl = trailingPrice
  } else if (hasManualSl) {
    const manualSl = Number(manual?.stopLossPrice)
    desiredSl = Number.isFinite(manualSl) && manualSl > 0 ? manualSl : 0
  } else {
    // Do not apply the hard live-entry minimum here. This helper is shared by
    // exchange control-order reconciliation, system-close checks, and operator
    // recalculation flows. Control-order mode is independent from the live-entry
    // SL policy, so reconciliation must honor the position's already-stored SL
    // value. New live positions and operator overrides normalize that stored
    // value at their boundaries instead.
    const rawSlPct = pos.stopLoss || 0
    // Guard: ensure stopLoss is numeric and non-negative before percentage calc
    const slPct = Number.isFinite(rawSlPct) && rawSlPct > 0 ? (rawSlPct / 100) : 0
    desiredSl =
      slPct > 0
        ? pos.direction === "long"
          ? fillPrice * (1 - slPct)
          : fillPrice * (1 + slPct)
        : 0
    // Final NaN guard: ensure result is safe before returning
    if (!Number.isFinite(desiredSl)) desiredSl = 0
  }

  const rawTpPct = pos.takeProfit || 0
  // Guard: ensure takeProfit is numeric and non-negative before percentage calc
  const tpPct = Number.isFinite(rawTpPct) && rawTpPct > 0 ? (rawTpPct / 100) : 0
  const dcaTp = Number(pos.dcaTakeProfitPrice || 0)
  const manualTp = Number(manual?.takeProfitPrice)
  let desiredTp = hasManualTp
    ? Number.isFinite(manualTp) && manualTp > 0 ? manualTp : 0
    : Number.isFinite(dcaTp) && dcaTp > 0
      ? dcaTp
      : tpPct > 0
        ? pos.direction === "long"
          ? fillPrice * (1 + tpPct)
          : fillPrice * (1 - tpPct)
        : 0
  // Final NaN guard: ensure result is safe before returning
  if (!Number.isFinite(desiredTp)) desiredTp = 0

  return { desiredSl, desiredTp }
}

/**
 * Has the desired protection price drifted enough from the currently
 * placed one to warrant cancelling and re-placing? We use 0.25% as the
 * tolerance — tighter than that and we'd thrash the exchange API on
 * every tiny rounding diff. Looser and we'd leave stale levels in place
 * after a real strategy adjustment.
 */

function getProtectionReferencePrice(pos: LivePosition): number {
  const markRaw = pos.exchangeData?.markPrice
  const markPrice = typeof markRaw === "number" ? markRaw : parseFloat(String(markRaw ?? ""))
  if (Number.isFinite(markPrice) && markPrice > 0) return markPrice
  if (Number.isFinite(pos.averageExecutionPrice) && pos.averageExecutionPrice > 0) return pos.averageExecutionPrice
  return Number.isFinite(pos.entryPrice) && pos.entryPrice > 0 ? pos.entryPrice : 0
}

/**
 * Ratchet a manually enabled trailing stop from the latest authoritative mark.
 * The level can only move in the profitable direction. Reconciliation calls
 * this before every control-order comparison, so the override survives UI
 * reloads, process restarts, and periods without a pseudo-position tick.
 */
function ratchetManualTrailingStop(pos: LivePosition): boolean {
  const manual = pos.manualProtectionOverride
  if (!manual?.trailingEnabled) return false

  const distancePct = Number(manual.trailingDistancePct)
  const markPrice = getProtectionReferencePrice(pos)
  if (!Number.isFinite(distancePct) || distancePct <= 0 || !Number.isFinite(markPrice) || markPrice <= 0) {
    return false
  }

  const direction: "long" | "short" = pos.direction === "short" ? "short" : "long"
  const candidate = direction === "long"
    ? markPrice * (1 - distancePct / 100)
    : markPrice * (1 + distancePct / 100)
  const existing = Number(pos.trailingStopPrice)
  const manualFloor = Number(manual.stopLossPrice)
  const eligible: number[] = [candidate]
  if (Number.isFinite(existing) && existing > 0) eligible.push(existing)
  if (Number.isFinite(manualFloor) && manualFloor > 0) eligible.push(manualFloor)

  const next = direction === "long" ? Math.max(...eligible) : Math.min(...eligible)
  if (!Number.isFinite(next) || next <= 0) return false

  const changed = pos.trailingActive !== true || !Number.isFinite(existing) || Math.abs(next - existing) > 1e-12
  pos.trailingActive = true
  pos.trailingStopPrice = next
  return changed
}

function findCrossedProtectionTrigger(
  pos: LivePosition,
  desiredSl: number,
  desiredTp: number,
  referencePrice: number,
): { leg: "StopLoss" | "TakeProfit"; triggerPrice: number; expectedSide: string } | null {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return null
  const direction = pos.direction === "short" ? "short" : "long"

  if (Number.isFinite(desiredSl) && desiredSl > 0) {
    if (direction === "long" && desiredSl >= referencePrice) {
      return { leg: "StopLoss", triggerPrice: desiredSl, expectedSide: "below" }
    }
    if (direction === "short" && desiredSl <= referencePrice) {
      return { leg: "StopLoss", triggerPrice: desiredSl, expectedSide: "above" }
    }
  }

  if (Number.isFinite(desiredTp) && desiredTp > 0) {
    if (direction === "long" && desiredTp <= referencePrice) {
      return { leg: "TakeProfit", triggerPrice: desiredTp, expectedSide: "above" }
    }
    if (direction === "short" && desiredTp >= referencePrice) {
      return { leg: "TakeProfit", triggerPrice: desiredTp, expectedSide: "below" }
    }
  }

  return null
}

async function closeIfProtectionTriggerAlreadyCrossed(
  connector: any,
  pos: LivePosition,
  desiredSl: number,
  desiredTp: number,
  context: string,
): Promise<boolean> {
  const referencePrice = getProtectionReferencePrice(pos)
  const crossed = findCrossedProtectionTrigger(pos, desiredSl, desiredTp, referencePrice)
  if (!crossed) return false

  const direction = pos.direction === "short" ? "short" : "long"
  const detail =
    `${crossed.leg} trigger already crossed for ${pos.symbol} ${direction}: ` +
    `trigger=${crossed.triggerPrice} must be ${crossed.expectedSide} reference=${referencePrice}; forcing close instead of placing invalid protection order`
  console.warn(`${LOG_PREFIX} [protection-crossed] ${detail}`)
  pushStep(pos, "protection_trigger_already_crossed", true, detail)
  await logProgressionEvent(
    pos.connectionId,
    "live_trading",
    "warning",
    `Protection trigger already crossed for ${pos.symbol} — force closing`,
    {
      livePositionId: pos.id,
      symbol: pos.symbol,
      direction,
      leg: crossed.leg,
      triggerPrice: crossed.triggerPrice,
      referencePrice,
      expectedSide: crossed.expectedSide,
      context,
      reason: "protection_trigger_already_crossed",
    },
  )
  await savePosition(pos).catch(() => {})
  const closeResult = await closeLivePosition(
    pos.connectionId,
    pos.id,
    referencePrice,
    connector,
    "protection_trigger_already_crossed",
  )
  if (closeResult) Object.assign(pos, closeResult)
  return true
}

function priceDrifted(current: number | undefined, desired: number, tolerance = 0.0025): boolean {
  if (!desired || desired <= 0) return false
  if (!current || current <= 0) return true // never placed or lost
  return Math.abs(current - desired) / desired > tolerance
}

/**
 * Reconcile the SL/TP exchange orders against the live position's current
 * desired levels. Three cases per leg (SL and TP independently):
 *
 *   1. Desired = 0 (disabled) and an order is still on the exchange:
 *      cancel it. Common after an operator turns off SL or TP mid-trade.
 *   2. No order recorded (or order id stale) and desired > 0:
 *      place a fresh protection order.
 *   3. Order id present BUT price drifted (>0.25%) from desired:
 *      cancel old → place new at correct level. Cancel-first guarantees
 *      we never accidentally double-protect (which would produce two
 *      reduce-only fills against the same exchange position).
 *
 * Updates `pos.stopLossOrderId`, `pos.takeProfitOrderId`, `pos.stopLossPrice`,
 * `pos.takeProfitPrice` to reflect what's now actually live on the exchange.
 *
 * Returns a boolean indicating whether anything changed (so callers can
 * decide whether to persist the position).
 */

// ── Per-position re-arm cooldown ────────────────────────────────────────────
// The 200–300 ms reconcile loop calls `updateProtectionOrders` for every open
// position on every tick. The "drift-based" cancel-replace logic is correct, but
// at 3–5 Hz a mark price oscillating at the 0.25% boundary produces repeated
// cancel-replace storms that exhaust rate limits and generate confusing audit
// logs. The cooldown gate adds a minimum quiet period between cancel-replaces
// driven by *price or qty drift* (not missing-order re-arms — those always fire
// immediately because arming a missing order is never a no-op).
//
// MIN_REARM_MS (30 s) — for static SL/TP price drift: long enough to absorb
//   a normal oscillation window (BTC 0.5% range typically resolves in ~5-15 s).
//
// TRAILING_REARM_MS (200 ms) — trailing is an active protection contract, not
//   a static configuration edit. Once the ratchet advances, cancel/replace the
//   exchange stop on the next fast-path cycle. The trailing state machine's own
//   minimum step prevents tick-noise from generating a replace storm.
//
// Missing-order re-arms (stopLossOrderId = undefined after liveness-verify)
// bypass all cooldowns and always place immediately.
const MIN_REARM_MS = 30_000
const TRAILING_REARM_MS = 200

// ── System-close-only flag, micro-cached ─────────────────────────────
//
// Reconcile fans out across every live position; without this cache
// each position would HGETALL `app_settings:*` to read one boolean.
// 2 s TTL is short enough that operator toggles take visible effect
// within one reconcile cycle, long enough to collapse a whole burst
// of position-level calls into one Redis round-trip.
const SYSTEM_CLOSE_TTL_MS = 2000
const systemCloseCacheByConnection = new Map<string, { value: boolean; at: number; inflight?: Promise<boolean> }>()

/**
 * Settings-save fast path. The normal two-second TTL remains the
 * cross-process/read-failure fallback, but an in-process hot reload must not
 * keep arming (or suppressing) venue control orders from a stale flag.
 */
export function invalidateLiveStageSettingsCache(connectionId?: string): void {
  if (connectionId) systemCloseCacheByConnection.delete(connectionId)
  else systemCloseCacheByConnection.clear()
}

function parseSystemCloseFlag(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1
}

async function getCachedSystemCloseOnly(connectionId: string): Promise<boolean> {
  const now = Date.now()
  const cacheKey = connectionId || "global"
  const cached = systemCloseCacheByConnection.get(cacheKey)
  if (cached && now - cached.at < SYSTEM_CLOSE_TTL_MS) return cached.value
  if (cached?.inflight) return cached.inflight

  const inflight = (async () => {
    try {
      const client = getRedisClient()
      const [appSettings, prefixedConnSettings, connSettings] = await Promise.all([
        getAppSettings().catch(() => ({} as Record<string, any>)),
        connectionId
          ? client?.hgetall(`settings:connection_settings:${connectionId}`).catch(() => ({} as Record<string, string>)) ?? Promise.resolve({})
          : Promise.resolve({}),
        connectionId
          ? client?.hgetall(`connection_settings:${connectionId}`).catch(() => ({} as Record<string, string>)) ?? Promise.resolve({})
          : Promise.resolve({}),
      ])
      // Per-connection settings win over global app settings so the operator
      // can disable exchange-side SL/TP for one noisy connection without
      // forcing every other connection into system-close-only mode.
      const merged = {
        ...(appSettings || {}),
        ...(connSettings || {}),
        // Canonical per-connection settings are written under the settings:
        // mirror; keep them last so stale legacy defaults cannot re-enable
        // exchange control orders after the operator disabled them.
        ...(prefixedConnSettings || {}),
      }
      const value = parseSystemCloseFlag((merged as any).useSystemCloseOnly) ||
        parseSystemCloseFlag((merged as any).use_system_close_only)
      systemCloseCacheByConnection.set(cacheKey, { value, at: Date.now() })
      return value
    } catch {
      // Fail closed: assume venue control orders (the default) on read
      // failure rather than incorrectly arming system-close-only mode.
      systemCloseCacheByConnection.set(cacheKey, { value: false, at: Date.now() })
      return false
    }
  })()
  systemCloseCacheByConnection.set(cacheKey, { value: cached?.value ?? false, at: cached?.at ?? 0, inflight })
  return inflight
}

async function updateProtectionOrders(
  connector: any,
  pos: LivePosition,
  reason: string,
  // Once-per-tick snapshot of order IDs currently open on the venue.
  // When provided, we cross-check our recorded `stopLossOrderId` /
  // `takeProfitOrderId` against this set: any recorded id NOT present in
  // the live snapshot is treated as silently gone (filled, externally
  // cancelled, expired, account-level reduce-only sweep, etc.) and the
  // local fields are cleared so the existing "no id → place fresh"
  // branch re-arms the leg on the same tick.
  //
  // Pass `null`/omit to skip verification (legacy callers that only
  // want price/qty-drift reconciliation pay no extra REST cost).
  liveOrderIds?: Set<string> | null,
): Promise<{ changed: boolean; slPlaced: boolean; tpPlaced: boolean }> {
  const result = { changed: false, slPlaced: false, tpPlaced: false }
  if (!connector) return result
  const effectiveQty = pos.executedQuantity > 0 ? pos.executedQuantity : (pos.quantity ?? 0)
  if (effectiveQty <= 0) return result

  // ─── CRITICAL GUARD: Skip SL/TP placement if position closed externally ───
  // If the position status is "closed" or force-close reasons are set, the
  // position is no longer open on the exchange. Attempting to place SL/TP
  // on a closed position will fail and cause repeated retry spam in logs.
  // The reconciliation loop detected external close; cleanup happens next.
  // Return early so we don't waste exchange calls on already-dead orders.
  if (pos.status === "closed" || 
      (pos.closeReason && pos.closedAt) ||
      (pos.statusReason && pos.statusReason.includes("closed")) ||
      (pos.statusReason && pos.statusReason.includes("EXTERNALLY"))) {
    // Position is dead; skip SL/TP work. The position will be archived
    // by the next reconciliation step (no position found on exchange).
    console.log(
      `${LOG_PREFIX} [${reason}] SKIPPED SL/TP for ${pos.symbol} (status=${pos.status}, closeReason=${pos.closeReason})`
    )
    return result
  }

  // A control-order reconciliation, partial reduction, or system close owns
  // the position mutation until its exchange effect is authoritative. Never
  // arm/cancel another protection leg in parallel: doing so can create a
  // second reduce-only action against a stale quantity.
  if (
    pos.status === "closing" ||
    pos.status === "closing_partial" ||
    pos.pendingSystemAction ||
    pos.pendingReduction ||
    pos.pendingAccumulation ||
    pos.pendingQuantityMutation
  ) {
    pushStep(
      pos,
      "protection_deferred_for_position_action",
      true,
      `[${reason}] waiting for ${pos.pendingSystemAction?.phase ||
        (pos.pendingReduction
          ? `reduction:${pos.pendingReduction.orderId || pos.pendingReduction.clientOrderId}`
          : pos.pendingAccumulation
            ? `accumulation:${pos.pendingAccumulation.orderId || pos.pendingAccumulation.clientOrderId}`
            : pos.pendingQuantityMutation?.phase || pos.status)}`,
    )
    return result
  }

  // Keep the durable operator trailing level moving even when the venue is
  // temporarily quota/frequency blocked or configured for system-close-only.
  // Those modes still use the local trigger for fail-closed protection.
  if (ratchetManualTrailingStop(pos)) {
    result.changed = true
    pushStep(
      pos,
      "manual_trailing_ratchet",
      true,
      `operator trailing stop advanced to ${Number(pos.trailingStopPrice || 0).toFixed(8)}`,
    )
  }

  // ── code=110206 quota backoff gate ────────────────────────────────
  // When the account's TP/SL order count has hit the exchange cap, all
  // placement attempts are suspended for PROTECTION_QUOTA_BACKOFF_MS.
  // This prevents the ~150/min cycle rate from flooding BingX with
  // rejected requests that fill the log and consume rate-limit budget.
  if (isProtectionQuotaBlocked(pos.connectionId)) {
    if (pos.protectionMode !== "system_close_fallback") {
      pos.protectionMode = "system_close_fallback"
      result.changed = true
      pushStep(pos, "protection_quota_system_fallback", true, "exchange control-order quota is blocked; system close remains active")
    }
    return result
  }

  // ── code=100410 trigger frequency limit backoff gate ────────────────────────────────
  // When BingX returns "endpoint trigger frequency limit rule is currently in the disabled
  // period", we suspend ALL cancellation and placement attempts for TRIGGER_FREQUENCY_BACKOFF_MS.
  // This is a harder limit than quota and prevents the connector from hammering the endpoint.
  if (isTriggerFrequencyBlocked(pos.connectionId)) {
    return result
  }

  // ── System-close-only mode (cached) ───────────────────────────────
  // Reconcile fans out across every live position on every tick, so
  // calling `getAppSettings()` here would issue one HGETALL per
  // position per tick — at 50 positions × 1 Hz that's 50 round-trips
  // for a flag that changes only when an operator toggles it in
  // settings. Cache the boolean for `SYSTEM_CLOSE_TTL_MS` (≈2 s) so
  // every position in the same reconcile burst reuses one read; the
  // TTL is short enough that toggling the setting takes effect within
  // ~2 s of the next tick (well below the operator's perceptual
  // threshold) and long enough to collapse a whole tick's worth of
  // reads into one.
  try {
    const systemCloseOnly = await getCachedSystemCloseOnly(pos.connectionId) ||
      parseSystemCloseFlag((pos as any)?.useSystemCloseOnly) ||
      parseSystemCloseFlag((pos as any)?.use_system_close_only)
    if (systemCloseOnly) {
      const cancellations = await Promise.all([
        pos.stopLossOrderId
          ? cancelProtectionOrder(connector, pos.symbol, pos.stopLossOrderId, "SystemCloseSweep-SL", pos.connectionId).catch(() => false)
          : Promise.resolve(true),
        pos.takeProfitOrderId
          ? cancelProtectionOrder(connector, pos.symbol, pos.takeProfitOrderId, "SystemCloseSweep-TP", pos.connectionId).catch(() => false)
          : Promise.resolve(true),
      ])
      if (pos.stopLossOrderId && cancellations[0]) {
        pos.stopLossOrderId = undefined
        pos.stopLossPrice = 0
        result.changed = true
      }
      if (pos.takeProfitOrderId && cancellations[1]) {
        pos.takeProfitOrderId = undefined
        pos.takeProfitPrice = 0
        result.changed = true
      }
      if (!cancellations.every(Boolean)) {
        pushStep(pos, "system_close_control_wait", true, "control cancellation not yet authoritative")
      }
      pos.protectionMode = "system_close"
      return result
    } else if (pos.protectionMode === "system_close") {
      delete pos.protectionMode
      result.changed = true
    }
  } catch (modeErr) {
    console.warn(`${LOG_PREFIX} [system-close] toggle read failed for ${pos.symbol} — falling back to control orders:`, modeErr instanceof Error ? modeErr.message : String(modeErr))
  }

  // ── Liveness verification against the venue ────────────────���─────────
  // Without this step the engine has no way to notice a SILENTLY GONE
  // protection order. The legacy drift-only check passes (price hasn't
  // moved, qty hasn't moved, id is still set) and we leave the position
  // unprotected indefinitely. The most common silent-gone causes:
  //   • SL/TP fired for a partial qty on a venue that doesn't
  //     auto-cancel the sibling leg (we keep the now-filled id)
  //   • Account-level reduce-only sweep (Bybit / OKX during margin-mode
  //     transitions)
  //   • Venue auto-expired a triggered conditional order
  //   • Operator manually cancelled via the venue UI
  // Clearing the local id forces the placement branch below to re-arm
  // the leg in the same reconcile tick.
  if (liveOrderIds && liveOrderIds.size >= 0) {
    if (pos.stopLossOrderId && !liveOrderIds.has(String(pos.stopLossOrderId))) {
      console.log(
        `${LOG_PREFIX} [verify] StopLoss ${pos.symbol} orderId=${pos.stopLossOrderId} not found on venue — clearing & re-arming`,
      )
      pos.stopLossOrderId = undefined
      pos.stopLossPrice = 0
      result.changed = true
    }
    if (pos.takeProfitOrderId && !liveOrderIds.has(String(pos.takeProfitOrderId))) {
      console.log(
        `${LOG_PREFIX} [verify] TakeProfit ${pos.symbol} orderId=${pos.takeProfitOrderId} not found on venue — clearing & re-arming`,
      )
      pos.takeProfitOrderId = undefined
      pos.takeProfitPrice = 0
      result.changed = true
    }
  }

  const { desiredSl, desiredTp } = computeDesiredProtectionPrices(pos)
  const closeSide: "buy" | "sell" = pos.direction === "long" ? "sell" : "buy"
  const priceDriftTolerance = pos.trailingActive ? 0.0001 : 0.0025

  // A protection request can reach the venue even when its HTTP response is
  // lost. `prepareProtectionSubmission()` persists the client id before the
  // request, so recover that durable submission before considering a new
  // order. Otherwise a restart or timeout can create duplicate SL/TP legs.
  const recoverPendingProtection = async (
    leg: "stopLoss" | "takeProfit",
  ): Promise<boolean> => {
    const pending = pos.pendingProtectionOrders?.[leg]
    if (!pending?.clientOrderId) return false

    const recovered = await recoverEntryOrderByClientId(
      connector,
      pos.symbol,
      pending.clientOrderId,
    )
    const recoveredStatus = String(recovered?.status || "").toLowerCase()
    const terminalStatuses = new Set([
      "cancelled", "canceled", "rejected", "expired", "filled", "closed",
    ])
    const recoveredOrderId = recovered?.orderId ?? recovered?.id

    if (recoveredOrderId != null && !terminalStatuses.has(recoveredStatus)) {
      const orderId = String(recoveredOrderId)
      if (leg === "stopLoss") {
        pos.stopLossOrderId = orderId
        pos.stopLossPrice = pending.triggerPrice
        pos.stopLossLastArmedAt = Date.now()
      } else {
        pos.takeProfitOrderId = orderId
        pos.takeProfitPrice = pending.triggerPrice
        pos.takeProfitLastArmedAt = Date.now()
      }
      pos.protectionArmedQuantity = pending.quantity
      delete pos.pendingProtectionOrders?.[leg]
      result.changed = true
      pushStep(pos, "protection_submission_recovered", true, `${leg} orderId=${orderId}`)
      return true
    }

    if (recovered && terminalStatuses.has(recoveredStatus)) {
      delete pos.pendingProtectionOrders?.[leg]
      result.changed = true
      pushStep(pos, "protection_submission_terminal", true, `${leg} status=${recoveredStatus}`)
      // A filled/closed control order may have changed the authoritative
      // position quantity. Let position reconciliation run before re-arming.
      return recoveredStatus === "filled" || recoveredStatus === "closed"
    }

    // A failed/unavailable snapshot is never evidence of absence. If the
    // client id is visible in the authoritative open-order snapshot, keep
    // tracking it until its venue id can be recovered.
    if (liveOrderIds === null || liveOrderIds === undefined || liveOrderIds.has(pending.clientOrderId)) {
      return true
    }

    // Require two authoritative absence observations before retrying. This
    // covers the short venue-indexing window immediately after a timed-out
    // placement while still healing genuinely rejected/lost submissions.
    pending.absenceConfirmations = Number(pending.absenceConfirmations || 0) + 1
    result.changed = true
    if (pending.absenceConfirmations < 2) return true

    delete pos.pendingProtectionOrders?.[leg]
    pushStep(pos, "protection_submission_absent", false, `${leg} clientOrderId=${pending.clientOrderId}`)
    return false
  }

  const [pendingSlBlocksPlacement, pendingTpBlocksPlacement] = await Promise.all([
    recoverPendingProtection("stopLoss"),
    recoverPendingProtection("takeProfit"),
  ])

  if (await closeIfProtectionTriggerAlreadyCrossed(connector, pos, desiredSl, desiredTp, reason)) {
    result.changed = true
    return result
  }

  // ── Quantity drift detection ──────────────────────────────────��───────
  // When more volume joins the position (delayed partial fills, accumulation
  // merges, post-fill sync detection) the SL/TP order on the exchange is
  // still armed for the *original* qty, leaving the delta unprotected.
  // Compare the current executed qty against the qty that was armed at
  // last placement; >0.25% drift triggers a cancel-and-replace on each
  // leg even if the trigger price hasn't moved. This is the missing
  // fix the user reported as "TP/SL not working" after partial fills.
  // NaN-hardened drift detection. `protectionArmedQuantity` is JSON-
  // round-tripped through Redis; a corrupted persistence path could
  // resurrect it as NaN. With the original `armedQty <= 0` check NaN
  // compares false on every operator, so qtyDrifted stayed false and
  // a partial-fill increase would silently NOT re-arm. Coerce to a
  // finite number first, treating non-finite or non-positive armed
  // quantities as "never armed" (forces re-arm).
  const armedQtyRaw = pos.protectionArmedQuantity
  const armedQty =
    typeof armedQtyRaw === "number" && Number.isFinite(armedQtyRaw) && armedQtyRaw > 0
      ? armedQtyRaw
      : 0
  const qtyDrifted =
    pos.executedQuantity > 0 &&
    (armedQty <= 0 ||
      Math.abs(pos.executedQuantity - armedQty) / Math.max(armedQty, 1e-12) > 0.0025)

  // ── Stop-Loss + Take-Profit legs: parallelised cancels, then parallel places ──
  //
  // Latency contract: control orders MUST arm "instantly" — the operator
  // explicitly called this out. Original implementation: cancel-SL → place-SL →
  // cancel-TP → place-TP (sequential, 4 RTTs on critical path ≈ 400ms at 100ms RTT).
  // Previous optimization: parallel legs (2 RTTs ≈ 200ms).
  // Current optimization: parallel cancels (SL+TP together) → parallel places (SL+TP).
  // Result: 3 RTTs max ≈ 300ms (if one cancel fails → retry next tick, no place).
  // If both cancels succeed: places can overlap → still ~200ms or better.
      // Each leg only mutates its own position fields (no cross-leg contention).
  //
  // Strategy: Collect both cancel promises, await them in parallel,
  // THEN proceed to parallel places only if cancels succeeded.
  
  // First, collect cancellation promises for both legs (if needed)
  const slCancelPromise = (async () => {
    if (desiredSl > 0 && pos.stopLossOrderId && 
        (priceDrifted(pos.stopLossPrice, desiredSl, priceDriftTolerance) || qtyDrifted)) {
      // Need to re-arm SL — cancel the old one first
      return await cancelProtectionOrder(connector, pos.symbol, pos.stopLossOrderId, "StopLoss", pos.connectionId)
        .catch((err) => {
          console.warn(
            `${LOG_PREFIX} StopLoss cancel failed for ${pos.symbol}:`,
            err instanceof Error ? err.message : String(err)
          )
          return false
        })
    }
    // No cancel needed for SL, or SL is being turned off (handled in leg below)
    return true
  })()

  const tpCancelPromise = (async () => {
    if (desiredTp > 0 && pos.takeProfitOrderId && 
        (priceDrifted(pos.takeProfitPrice, desiredTp, priceDriftTolerance) || qtyDrifted)) {
      // Need to re-arm TP — cancel the old one first
      return await cancelProtectionOrder(connector, pos.symbol, pos.takeProfitOrderId, "TakeProfit", pos.connectionId)
        .catch((err) => {
          console.warn(
            `${LOG_PREFIX} TakeProfit cancel failed for ${pos.symbol}:`,
            err instanceof Error ? err.message : String(err)
          )
          return false
        })
    }
    // No cancel needed for TP, or TP is being turned off (handled in leg below)
    return true
  })()

  // Await both cancels in parallel (massive latency win if both need cancel)
  const [slCancelOk, tpCancelOk] = await Promise.all([slCancelPromise, tpCancelPromise])

  const slLeg = (async () => {
    if (desiredSl <= 0 && pos.stopLossOrderId) {
      // SL was turned off — yank the existing order. Hard cancel
      // failures intentionally keep the recorded id so the next
      // reconcile pass retries; resetting it here would orphan the
      // exchange-side order and produce a phantom unprotected position
      // from our POV.
      const cancelled = await cancelProtectionOrder(connector, pos.symbol, pos.stopLossOrderId, "StopLoss", pos.connectionId)
      if (cancelled) {
        pos.stopLossOrderId = undefined
        pos.stopLossPrice = 0
        result.changed = true
      }
    } else if (
      // Re-arm (place fresh / cancel-replace) the SL leg when a stop is
      // desired AND there is no live protection at the right level. The
      // liveness-verification block above has already cleared
      // `stopLossOrderId` if the recorded order is gone from the venue, so
      // by here `!pos.stopLossOrderId` reliably means "nothing armed".
      // Placing also fires when the trigger price or the position quantity
      // has drifted past tolerance (cancel-then-replace at the new level).
      //
      // NOTE: the previous one-liner folded the "order still alive on
      // venue" check into the SAME `||` group as `!pos.stopLossOrderId`,
      // which (because `||` binds tighter than `?:`) made the whole
      // expression evaluate to `false` whenever NO order existed — so a
      // position with no stop-loss order was never armed at all.
      //
      // ── Re-arm cooldown (MIN_REARM_MS) ────────────��───────────────────────
      // When an order IS present and we're just drift-cancel-replacing, gate
      // on the cooldown to prevent oscillation storms. Missing-order paths
      // (!pos.stopLossOrderId, already cleared by liveness-verify above)
      // always bypass the cooldown — arming a missing order is never a no-op.
      desiredSl > 0 &&
      !pendingSlBlocksPlacement &&
      (
        !pos.stopLossOrderId
          ? true  // no order at all → arm immediately regardless of cooldown
          : (priceDrifted(pos.stopLossPrice, desiredSl, priceDriftTolerance) || qtyDrifted) &&
            // Trailing ratchets use a shorter cooldown so exchange orders track
            // the ratcheted level within one strategy cycle (~5 s). Static price
            // drift uses the full 30 s cooldown to absorb oscillation noise.
            Date.now() - (pos.stopLossLastArmedAt ?? 0) >=
              (pos.trailingActive ? TRAILING_REARM_MS : MIN_REARM_MS)
      )
    ) {
      // Cancel-then-replace race: if a cancel fails we must NOT place
      // a new SL — the old one is still armed on the exchange, and
      // adding a second reduce-only at a different trigger price
      // creates a window where a price spike crossing both levels
      // fires both orders before the second's reduceOnly check
      // rejects it. Treat a definitive cancel failure as "skip this
      // tick, retry next tick" so reconcile can re-evaluate.
      // NOTE: SL and TP cancellations are parallelized at the top of this
      // block to overlap RTTs. Both cancel promises resolve before we place either leg.
      let oldGone = true
      if (pos.stopLossOrderId) {
        // Use the pre-computed slCancelOk result from parallel cancels above
        oldGone = slCancelOk
        if (!oldGone) {
          console.warn(
            `${LOG_PREFIX} StopLoss cancel failed for ${pos.symbol} — deferring re-place to avoid duplicate reduceOnly`,
          )
        }
      }
      if (oldGone) {
        const protectionClientOrderId = await prepareProtectionSubmission(
          pos,
          "stopLoss",
          desiredSl,
          effectiveQty,
        )
        const id = await placeProtectionOrder(
          connector,
          pos.symbol,
          closeSide,
          effectiveQty,
          desiredSl,
          "StopLoss",
          pos.direction!,
          protectionClientOrderId,
        )
        // Only treat the leg as "armed at desiredSl" when we actually
        // have a confirmed numeric order id (not the "PRICE_CROSSED" sentinel
        // which means market already blew past the SL and a force-close should
        // happen on the next reconcile checkAndForceCloseOnSltpCross pass).
        const slIdOk = id && id !== "PRICE_CROSSED" && id !== "position_exhausted" && id !== "QUOTA_EXCEEDED"
        if (id === "QUOTA_EXCEEDED") {
          // Account quota exhausted — suspend all protection placement for this
          // connection for PROTECTION_QUOTA_BACKOFF_MS. Do NOT clear orderId/price
          // so existing armed orders (if any) remain tracked.
          markProtectionQuotaExhausted(pos.connectionId)
          pos.protectionMode = "system_close_fallback"
          result.changed = true
          pushStep(pos, "protection_quota_system_fallback", true, "SL quota exhausted; using system-side trigger handling")
          // Leave existing stopLossOrderId / stopLossPrice unchanged.
        } else if (slIdOk) {
          pos.stopLossOrderId = id!
          pos.stopLossPrice = desiredSl
          pos.stopLossLastArmedAt = Date.now()
          result.changed = true
          result.slPlaced = true
          if (pos.pendingProtectionOrders) delete pos.pendingProtectionOrders.stopLoss
        } else {
          pos.stopLossOrderId = undefined
          pos.stopLossPrice = 0
        }
      }
    }
  })()

  const tpLeg = (async () => {
    if (desiredTp <= 0 && pos.takeProfitOrderId) {
      const cancelled = await cancelProtectionOrder(connector, pos.symbol, pos.takeProfitOrderId, "TakeProfit", pos.connectionId)
      if (cancelled) {
        pos.takeProfitOrderId = undefined
        pos.takeProfitPrice = 0
        result.changed = true
      }
    } else if (
      // Mirror of the SL leg: arm a take-profit when one is desired and
      // nothing live covers it (or the level/qty drifted). Same precedence
      // fix — the old `||`-grouped ternary collapsed to `false` when no TP
      // order existed, leaving positions without a take-profit entirely.
      //
      // ── Re-arm cooldown (MIN_REARM_MS) — mirror of SL leg ───────────────
      desiredTp > 0 &&
      !pendingTpBlocksPlacement &&
      (
        !pos.takeProfitOrderId
          ? true  // no order at all → arm immediately
          : (priceDrifted(pos.takeProfitPrice, desiredTp, priceDriftTolerance) || qtyDrifted) &&
            Date.now() - (pos.takeProfitLastArmedAt ?? 0) >=
              (pos.trailingActive ? TRAILING_REARM_MS : MIN_REARM_MS)
      )
    ) {
      let oldGone = true
      if (pos.takeProfitOrderId) {
        // Use the pre-computed tpCancelOk result from parallel cancels above
        oldGone = tpCancelOk
        if (!oldGone) {
          console.warn(
            `${LOG_PREFIX} TakeProfit cancel failed for ${pos.symbol} — deferring re-place to avoid duplicate reduceOnly`,
          )
        }
      }
      if (oldGone) {
        const protectionClientOrderId = await prepareProtectionSubmission(
          pos,
          "takeProfit",
          desiredTp,
          effectiveQty,
        )
        const id = await placeProtectionOrder(
          connector,
          pos.symbol,
          closeSide,
          effectiveQty,
          desiredTp,
          "TakeProfit",
          pos.direction!,
          protectionClientOrderId,
        )
        const tpIdOk = id && id !== "PRICE_CROSSED" && id !== "position_exhausted" && id !== "QUOTA_EXCEEDED"
        if (id === "QUOTA_EXCEEDED") {
          // Mirror of the SL leg: suspend placement, preserve existing order data.
          markProtectionQuotaExhausted(pos.connectionId)
          pos.protectionMode = "system_close_fallback"
          result.changed = true
          pushStep(pos, "protection_quota_system_fallback", true, "TP quota exhausted; using system-side trigger handling")
        } else if (tpIdOk) {
          pos.takeProfitOrderId = id!
          pos.takeProfitPrice = desiredTp
          pos.takeProfitLastArmedAt = Date.now()
          result.changed = true
          result.tpPlaced = true
          if (pos.pendingProtectionOrders) delete pos.pendingProtectionOrders.takeProfit
        } else {
          pos.takeProfitOrderId = undefined
          pos.takeProfitPrice = 0
        }
      }
    }
  })()

  // Use allSettled to prevent one failed leg from crashing both SL and TP.
  // Individually catch errors for graceful degradation instead of crashing.
  await Promise.allSettled([slLeg, tpLeg]).then((results) => {
    results.forEach((result, idx) => {
      if (result.status === "rejected") {
        const legName = idx === 0 ? "StopLoss" : "TakeProfit"
        console.warn(
          `${LOG_PREFIX} armProtection: ${legName} leg failed:`,
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        )
      }
    })
  })

  // Record the qty we armed for only when at least one leg was actually
  // (re-)placed on the exchange. A liveness-verify clear sets result.changed
  // but may not result in a successful placement (venue reject, timeout).
  // Stamping the baseline from a failed placement tells the drift-detector
  // "this qty is protected" when it is unprotected, suppressing re-arm on
  // the next tick. We keep result.changed for the pushStep / save path below.
  if (result.slPlaced || result.tpPlaced) {
    pos.protectionArmedQuantity = effectiveQty
    pos.protectionMode = "exchange_control"
  }

  if (result.changed) {
    pushStep(
      pos,
      "update_sl_tp",
      true,
      `[${reason}] SL ${pos.stopLoss}% → ${pos.stopLossPrice ? pos.stopLossPrice.toFixed(6) : "—"} (${pos.stopLossOrderId || "—"}) | ` +
      `TP ${pos.takeProfit}% → ${pos.takeProfitPrice ? pos.takeProfitPrice.toFixed(6) : "—"} (${pos.takeProfitOrderId || "—"})`,
    )
    await logProgressionEvent(
      pos.connectionId,
      "live_trading",
      "info",
      `SL/TP updated for ${pos.symbol} (${reason})`,
      {
        // Both the originally-assigned percentages (immutable contract)
        // and the currently-active percentages (mutable, override-aware).
        // On the steady state these are equal; after an operator override
        // they diverge — the assigned pair makes the override audit-trail
        // self-documenting in the dashboard's progression panel.
        assignedStopLossPct: pos.assignedStopLoss,
        assignedTakeProfitPct: pos.assignedTakeProfit,
        stopLossPct: pos.stopLoss,
        takeProfitPct: pos.takeProfit,
        slOrderId: pos.stopLossOrderId,
        slPrice: pos.stopLossPrice,
        tpOrderId: pos.takeProfitOrderId,
        tpPrice: pos.takeProfitPrice,
        fillPrice: pos.averageExecutionPrice,
      },
    )
  }

  return result
}

// ── Main Pipeline ───�����──────���───��─────────────────────────────────────────────

/**
 * Execute a real position on exchange as a live position with the full
 * progression pipeline.
 */
export async function executeLivePosition(
  connectionId: string,
  sourceRealPosition: RealPosition,
  exchangeConnector: any
): Promise<LivePosition> {
  await initRedis()
  const client = getRedisClient()
  const connectionTrackingId = makeConnectionTrackingId(connectionId)
  let realPosition = sourceRealPosition

  // ── Exchange circuit-breaker gate (per-symbol) ──────────────���────────
  // BingX code 109400 — "API orders temporarily disabled due to market
  // volatility" — affects a specific symbol for ~1-5 minutes. Skip it
  // silently rather than counting it as a margin/balance failure.
  if (isCircuitBreakerActive(realPosition.symbol)) {
    const cbSkipped: LivePosition = {
      id: `live:${connectionId}:${realPosition.symbol}:${realPosition.direction}:${Date.now()}:${nanoid(8)}`,
      connectionId,
      system_tracking_id: makeSystemTrackingId(connectionId),
      connection_tracking_id: connectionTrackingId,
      symbol: realPosition.symbol,
      direction: realPosition.direction,
      realPositionId: realPosition.id,
      quantity: realPosition.quantity,
      executedQuantity: 0,
      remainingQuantity: realPosition.quantity,
      entryPrice: realPosition.entryPrice,
      averageExecutionPrice: 0,
      volumeUsd: 0,
      leverage: realPosition.leverage,
      marginType: "cross",
      stopLoss: realPosition.stopLoss,
      takeProfit: realPosition.takeProfit,
      assignedStopLoss: realPosition.stopLoss,
      assignedTakeProfit: realPosition.takeProfit,
      status: "rejected",
      statusReason: `Skipped — exchange circuit breaker active for ${realPosition.symbol} (market volatility, resumes in <5min)`,
      fills: [],
      progression: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      setKey:         realPosition.setKey,
      parentSetKey:   realPosition.parentSetKey,
      setVariant:     realPosition.setVariant,
      axisWindows:    realPosition.axisWindows,
      sizeMultiplier: realPosition.sizeMultiplier,
      accumulatedSetKeys:
      Array.isArray(realPosition.accumulatedSetKeys) && realPosition.accumulatedSetKeys.length > 0
        ? realPosition.accumulatedSetKeys
        : (realPosition.setKey ? [realPosition.setKey] : []),
    combinedPosCounts: realPosition.combinedPosCounts ?? false,
    posCountsTargetFlat: realPosition.posCountsTargetFlat ?? false,
    posCountsLongSetCount: realPosition.posCountsLongSetCount,
    posCountsShortSetCount: realPosition.posCountsShortSetCount,
    posCountsNetSetCount: realPosition.posCountsNetSetCount,
    posCountsSetRatios: { ...(realPosition.posCountsSetRatios || {}) },
      // Set-config propagation: carry trailing profile and prevPos from the
      // originating StrategySet so the position is config-aware even when it
      // does not actually execute (for audit-trail completeness).
      trailingProfile: realPosition.trailingProfile,
      prevPos:         realPosition.prevPos,
    }
    pushStep(cbSkipped, "preflight", false, cbSkipped.statusReason!)
    logProgressionEvent(connectionId, "live_trading", "warning", cbSkipped.statusReason!, {
      symbol: realPosition.symbol,
      direction: realPosition.direction,
    }).catch(() => {})
    return cbSkipped
  }

  // ���─ Non-recoverable-error cooldown gate ──
  //
  // If we hit `code=101204` (Insufficient margin) within the exponential
  // backoff window (60s → 120s → 240s → 300s), skip this attempt and return
  // a synthetic "rejected" LivePosition. Prevents API flood on no-balance.
  //
  // The skip is silent at console level after the first occurrence so
  // logs stay readable; the progression event still records it for the
  // dashboard. Operator tops up → next successful order resets counter.
  if (isMarginCooldownActive(connectionId)) {
    const entry = marginErrorCooldownByConnection.get(connectionId)
    const failures = entry?.consecutiveFailures ?? 1
    const stepIdx = Math.min(failures - 1, MARGIN_COOLDOWN_STEPS_MS.length - 1)
    const cooldownSec = Math.round((MARGIN_COOLDOWN_STEPS_MS[stepIdx] ?? MARGIN_COOLDOWN_MAX_MS) / 1000)
    const normalizedSkippedSl = normalizeStopLossPercent(realPosition.stopLoss).value
    const normalizedSkippedTp = Math.max(0, Number(realPosition.takeProfit) || 0)
    const skipped: LivePosition = {
      id: `live:${connectionId}:${realPosition.symbol}:${realPosition.direction}:${Date.now()}:${nanoid(8)}`,
      connectionId,
      system_tracking_id: makeSystemTrackingId(connectionId),
      connection_tracking_id: connectionTrackingId,
      symbol: realPosition.symbol,
      direction: realPosition.direction,
      realPositionId: realPosition.id,
      quantity: realPosition.quantity,
      executedQuantity: 0,
      remainingQuantity: realPosition.quantity,
      entryPrice: realPosition.entryPrice,
      averageExecutionPrice: 0,
      volumeUsd: 0,
      leverage: realPosition.leverage,
      marginType: "cross",
      stopLoss: normalizedSkippedSl,
      takeProfit: normalizedSkippedTp,
      // Immutable snapshot of the originally-assigned values — survives
      // any later override via `recalculateAndApplySLTP`. See type def.
      assignedStopLoss: normalizedSkippedSl,
      assignedTakeProfit: normalizedSkippedTp,
      status: "rejected",
      statusReason:
        `Skipped — margin-error cooldown active (attempt ${failures}, cooldown=${cooldownSec}s). Top up exchange balance to resume.`,
      fills: [],
      progression: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      setKey:         realPosition.setKey,
      parentSetKey:   realPosition.parentSetKey,
      setVariant:     realPosition.setVariant,
      axisWindows:    realPosition.axisWindows,
      sizeMultiplier: realPosition.sizeMultiplier,
      accumulatedSetKeys:
        Array.isArray(realPosition.accumulatedSetKeys) && realPosition.accumulatedSetKeys.length > 0
          ? realPosition.accumulatedSetKeys
          : (realPosition.setKey ? [realPosition.setKey] : []),
      combinedPosCounts: realPosition.combinedPosCounts ?? false,
      posCountsTargetFlat: realPosition.posCountsTargetFlat ?? false,
      posCountsLongSetCount: realPosition.posCountsLongSetCount,
      posCountsShortSetCount: realPosition.posCountsShortSetCount,
      posCountsNetSetCount: realPosition.posCountsNetSetCount,
      posCountsSetRatios: { ...(realPosition.posCountsSetRatios || {}) },
      trailingProfile: realPosition.trailingProfile,
      prevPos:         realPosition.prevPos,
    }
    pushStep(skipped, "preflight", false, skipped.statusReason!)
    // Don't await — fire-and-forget is fine for the cooldown skip log.
    logProgressionEvent(connectionId, "live_trading", "warning", skipped.statusReason!, {
      symbol: realPosition.symbol,
      direction: realPosition.direction,
      consecutiveFailures: failures,
      cooldownSec,
    }).catch(() => {})
    return skipped
  }

  // Resolve the execution mode once before constructing the immutable position
  // snapshot. Preset mode is independent from Main Live, but Main wins when
  // both switches are on so enabling Presets cannot silently rewrite a Main
  // strategy order. In Preset-only mode the active optimized preset is applied
  // before SL/TP/trailing fields are copied into the LivePosition.
  const initialConnectionSettings = (await getConnection(connectionId).catch(() => null)) || {}
  const mainModeEnabled = isConnectionLiveTradeEnabled(initialConnectionSettings)
  const presetModeEnabled = isConnectionPresetTradeEnabled(initialConnectionSettings)
  const executionIntent: "main" | "preset" = presetModeEnabled && !mainModeEnabled ? "preset" : "main"
  if (executionIntent === "preset") {
    const { applySelectedPresetToRealPosition } = await import("@/lib/preset-store")
    realPosition = await applySelectedPresetToRealPosition(
      connectionId,
      realPosition,
      initialConnectionSettings as Record<string, any>,
    )
  }

  const livePosition: LivePosition = {
    id: `live:${connectionId}:${realPosition.symbol}:${realPosition.direction}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    connectionId,
    system_tracking_id: makeSystemTrackingId(connectionId),
    connection_tracking_id: connectionTrackingId,
    symbol: realPosition.symbol,
    direction: realPosition.direction,
    realPositionId: realPosition.id,
    quantity: realPosition.quantity,
    executedQuantity: 0,
    remainingQuantity: realPosition.quantity,
    entryPrice: realPosition.entryPrice,
    averageExecutionPrice: 0,
    volumeUsd: 0,
    leverage: realPosition.leverage,
    marginType: "cross",
    // ── Set-config-aware initial SL% ──────────────────────────────────────
    // Use `computeSetAwareSL` so the protection level is derived from the Set's
    // own configuration rather than a generic PF-derived percentage:
    //   • trailing variant: SL = trailingProfile.stopRatio * 100 (trail distance
    //     anchor; ratchets upward once the trailing machine activates)
    //   • block/dca/default: normalised PF-derived value (already variant-scaled
    //     by sizeMultiplier in deriveProtectionFromProfitFactor at dispatch)
    stopLoss: computeSetAwareSL(
      normalizeStopLossPercent(realPosition.stopLoss).value,
      realPosition.setVariant,
      realPosition.trailingProfile,
    ),
    takeProfit: realPosition.takeProfit,
    // Immutable assignment snapshot — preserved across overrides so the
    // progression panel and post-trade stats can always recover what the
    // upstream Set originally specified. Mirrors `stopLoss`/`takeProfit`
    // at creation; never mutated thereafter.
    assignedStopLoss: realPosition.stopLoss,
    assignedTakeProfit: realPosition.takeProfit,
    status: "pending",
    fills: [],
    progression: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // ── Set lineage propagation (Main → Real → Live) ──────────────────
    // Carry the Set Type metadata from the upstream RealPosition into
    // this LivePosition verbatim. The exchange-position storage layer
    // serialises the entire LivePosition, so these fields ride along
    // for free and become available to post-trade statistics queries.
    // `accumulatedSetKeys` is seeded with the originating setKey so
    // accumulation merges later append onto a non-empty list (rather
    // than having to special-case the first entry).
    setKey:         realPosition.setKey,
    parentSetKey:   realPosition.parentSetKey,
    indicationType: realPosition.indicationType,
    setVariant:     realPosition.setVariant,
    axisWindows:    realPosition.axisWindows,
    sizeMultiplier: realPosition.sizeMultiplier,
    blockBaseVolumeMultiplier: realPosition.blockBaseVolumeMultiplier,
    blockVolumeRatio: realPosition.blockVolumeRatio,
    blockProfitFactorRatio: realPosition.blockProfitFactorRatio,
    blockDefaultMinimumProfitFactor: realPosition.blockDefaultMinimumProfitFactor,
    blockMinimumProfitFactor: realPosition.blockMinimumProfitFactor,
    blockObservedProfitFactor: realPosition.blockObservedProfitFactor,
    blockProfitFactorWindow: realPosition.blockProfitFactorWindow,
    blockProfitFactorSampleCount: realPosition.blockProfitFactorSampleCount,
    blockCount: realPosition.blockCount,
    blockVolumeIncrementRatio: realPosition.blockVolumeIncrementRatio,
    blockCalculatedVolumeMultiplier: realPosition.blockCalculatedVolumeMultiplier,
    accumulatedSetKeys:
      Array.isArray(realPosition.accumulatedSetKeys) && realPosition.accumulatedSetKeys.length > 0
        ? realPosition.accumulatedSetKeys
        : (realPosition.setKey ? [realPosition.setKey] : []),
    combinedPosCounts: realPosition.combinedPosCounts ?? false,
    posCountsTargetFlat: realPosition.posCountsTargetFlat ?? false,
    posCountsLongSetCount: realPosition.posCountsLongSetCount,
    posCountsShortSetCount: realPosition.posCountsShortSetCount,
    posCountsNetSetCount: realPosition.posCountsNetSetCount,
    posCountsSetRatios: { ...(realPosition.posCountsSetRatios || {}) },
    // ── Set-config propagation (Relations → Live Protection) ──────────
    // The trailing profile and historical performance snapshot from the
    // originating StrategySet travel through RealPosition → LivePosition
    // so the live protection layer can (a) anchor the initial SL at the
    // correct trailing distance and (b) reference the Set's historical
    // context for audit and future re-scoring. Both fields are read-only
    // after creation — they reflect the Set's config at dispatch time.
    trailingProfile: realPosition.trailingProfile,
    prevPos:         realPosition.prevPos,
    presetId: realPosition.presetId,
    presetIndicatorType: realPosition.presetIndicatorType,
    presetRank: realPosition.presetRank,
    presetPositionCostPct: realPosition.presetPositionCostPct,
    presetProfitFactor: realPosition.presetProfitFactor,
    executionIntent,
  }

  const normalizedInitialSl = normalizeStopLossPercent(realPosition.stopLoss)
  if (normalizedInitialSl.adjusted) {
    pushStep(livePosition, "protection_sl_normalized", true, normalizedInitialSl.reason!)
    logProgressionEvent(
      connectionId,
      "live_trading",
      "warning",
      `StopLoss normalized for ${realPosition.symbol}`,
      {
        symbol: realPosition.symbol,
        direction: realPosition.direction,
        assignedStopLoss: realPosition.stopLoss,
        effectiveStopLoss: normalizedInitialSl.value,
        reason: normalizedInitialSl.reason,
      },
    ).catch(() => {})
  }

  // ── Trailing-variant SL config log ─────────────────────────────��─��────────
  // When the trailing profile overrides the initial SL% (anchor = stopRatio),
  // log it explicitly so the progression panel shows both the PF-derived value
  // and the config-anchored override side-by-side for operator visibility.
  if (
    realPosition.setVariant === "trailing" &&
    livePosition.trailingProfile &&
    livePosition.trailingProfile.stopRatio > 0
  ) {
    const trailSl = Math.max(MIN_EXCHANGE_STOP_LOSS_PERCENT, livePosition.trailingProfile.stopRatio * 100)
    if (Math.abs(trailSl - normalizedInitialSl.value) > 0.001) {
      pushStep(
        livePosition,
        "set_config_sl_override",
        true,
        `Trailing-variant SL anchored at stopRatio ${livePosition.trailingProfile.stopRatio} → ${trailSl.toFixed(3)}% ` +
        `(PF-derived was ${normalizedInitialSl.value.toFixed(3)}%)`,
      )
    }
  }

  // Hoisted before the try/catch so the catch block can release the
  // correct variant-scoped dedup lock on unhandled errors.
  const _lockDirSuffix = realPosition.setVariant === "block" ? ":block" : ""
  let liveOrderLockToken: string | null = null

  try {
    // ── Step 1: Pre-flight validation ──────────────�������──────────────────────
    if (!realPosition.direction || !realPosition.symbol) {
      livePosition.status = "rejected"
      livePosition.statusReason = `Invalid inputs: symbol=${realPosition.symbol}, direction=${realPosition.direction}`
      pushStep(livePosition, "preflight", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_rejected_count")
      await logProgressionEvent(connectionId, "live_trading", "error", "Live order rejected — invalid inputs", {
        symbol: realPosition.symbol,
        direction: realPosition.direction,
      })
      return livePosition
    }

    // CRITICAL: Upstash returns values as strings OR native types depending on adapter.
    // Use getConnection() to get the parsed hash (parseHashValue coerces "1"/"true"/true -> true).
    // Raw hgetall followed by string-only equality was silently failing when the value
    // came back as a boolean, causing every real order to become a "simulated" order
    // despite the strategy-coordinator correctly detecting live_trade=true just one
    // function call upstream.
    const connSettings = initialConnectionSettings
    // One canonical decision is shared with the Main Live toggle and status
    // APIs. Previously each path implemented a slightly different combination
    // of flags, credentials, and Redis checks, so production could display Live
    // ON while this branch silently created paper positions.
    const liveReadiness = evaluateRealTradeReadiness(connSettings, executionIntent)
    const isLiveTradeEnabled = liveReadiness.canPlaceRealOrders
    livePosition.executionMode = liveReadiness.executionMode
    livePosition.executionBlockCode = liveReadiness.blockCode || undefined
    livePosition.executionBlockReason = liveReadiness.blockReason || undefined

    // A requested live run must fail visibly when its safety prerequisites are
    // not met. Falling back to paper here made the Main engine look healthy
    // while no venue order was ever attempted. Paper simulation remains active
    // only when the operator has actually left Live Trade disabled.
    if (!isLiveTradeEnabled && liveReadiness.requested) {
      livePosition.status = "rejected"
      livePosition.statusReason =
        `Live exchange order blocked (${liveReadiness.blockCode || "unknown"}): ${liveReadiness.blockReason}`
      pushStep(livePosition, "live_readiness", false, livePosition.statusReason)
      await savePosition(livePosition)
      await Promise.all([
        incrementMetric(connectionId, "live_orders_blocked_count"),
        logProgressionEvent(
          connectionId,
          "live_trading",
          "warning",
          livePosition.statusReason,
          {
            symbol: realPosition.symbol,
            direction: realPosition.direction,
            blockCode: liveReadiness.blockCode,
            credentialsValid: liveReadiness.credentialsValid,
            durableCoordinationReady: liveReadiness.durableCoordinationReady,
          },
        ),
      ])
      console.warn(`${LOG_PREFIX} ${livePosition.statusReason}`)
      return livePosition
    }

    // Position-count Sets own one physical exchange target per symbol. Every
    // cycle reconciles the existing quantity to the newest long/short hedge:
    // increase only the positive delta, reduce only the negative delta, close
    // on flat, and close-then-open on a direction flip. Ordinary dedup/merge
    // logic is additive and therefore cannot implement this target contract.
    if (realPosition.combinedPosCounts) {
      const reconciled = await reconcileCombinedPosCountTarget(
        connectionId,
        realPosition,
        exchangeConnector,
        executionIntent,
        isLiveTradeEnabled,
      )
      if (reconciled) return reconciled
      // null means this is the first non-flat target; continue through the
      // normal fresh-entry path, which creates and protects the physical order.
    }

    // isBlockVariant and _lockDirSuffix are hoisted to function scope (before
    // the try block) so the catch handler can also release the correct key.
    const isBlockVariant = realPosition.setVariant === "block"

    // Block and DCA are adjustment-only variants. They must attach to an
    // already confirmed parent position; opening a second standalone venue
    // position would destroy the independent base/count ratio calculation and
    // make protection ownership ambiguous.
    const isAdjustmentVariant = isBlockVariant || realPosition.setVariant === "dca"
    if (isAdjustmentVariant) {
      const existing = await findAuthoritativeAdjustmentParent(
        connectionId,
        realPosition.symbol,
        realPosition.direction,
        !isLiveTradeEnabled,
      )
      if (!existing) {
        livePosition.status = "rejected"
        livePosition.statusReason = isBlockVariant
          ? `Block Set ${realPosition.setKey || "unknown"} waits for authoritative parent fill`
          : `DCA Set ${realPosition.setKey || "unknown"} waits for authoritative parent fill`
        pushStep(livePosition, "adjustment_wait", false, livePosition.statusReason)
        await savePosition(livePosition)
        return livePosition
      }
      const adjustmentPrice = realPosition.entryPrice > 0
        ? realPosition.entryPrice
        : await fetchCurrentPrice(realPosition.symbol)
      if (!(adjustmentPrice > 0)) {
        pushStep(existing, "accumulate_skip", false, "market price unavailable — adjustment deferred")
        await savePosition(existing)
        return existing
      }
      if (existing.status === "simulated") {
        return accumulateIntoSimulatedPosition(connectionId, existing, realPosition, adjustmentPrice)
      }
      return accumulateIntoLivePosition(connectionId, existing, realPosition, adjustmentPrice, exchangeConnector)
    }

    pushStep(livePosition, "preflight", true, `execution_mode=${liveReadiness.executionMode}`)
    await logProgressionEvent(
      connectionId,
      "live_trading",
      "info",
      `Live pipeline start ${realPosition.symbol} ${realPosition.direction}`,
      { liveTrade: isLiveTradeEnabled, executionMode: liveReadiness.executionMode, realPositionId: realPosition.id }
    )

    // ── Atomic dedup gate (P0-4 race fix) ──��───────────────────────────
    //
    // Spec: "Active Pseudo Position Limit for each direction Long, short
    // maximal 1." The previous implementation was a check-then-act
    // sequence:
    //
    //   if (await hasOpenLivePosition(...)) { merge-or-release-stale }
    //   ... place order ...
    //   await acquireLock(...)            // overwrites unconditionally
    //
    // — racy under any concurrency. Two ticks could both pass the
    // `hasOpenLivePosition` check, both place exchange orders, and both
    // belatedly stamp the lock. The exchange ended up with two
    // duplicate positions for the same symbol+direction; reconcile then
    // had to figure out which one to track.
    //
    // We now atomically `tryAcquireLock` at the very top of the
    // live-trade branch:
    //
    //   • acquired → we own the slot, fresh-entry path runs. No
    //                separate `acquireLock` call later in this function.
    //   • not acquired → there is either an open position to merge into
    //                    (our preferred outcome) OR an in-flight entry
    //                    from a parallel tick that hasn't yet saved its
    //                    position. We DEFER in the second case rather
    //                    than racing — the 5-minute TTL guarantees a
    //                    crashed lock self-clears, so deferred signals
    //                    will succeed on a subsequent cycle.
    //
    // This is the only writer of `live:lock:{conn}:{sym}:{dir}` on the
    // critical path, so the race window is closed at its source.
    if (isLiveTradeEnabled) {
      // ── Variant-specific lock key ─��──────────────────────────────────��───
      // Block add-on orders MUST be able to proceed even when the default/
      // trailing position's lock is held (that lock means "default slot is
      // occupied — don't open a second default", not "all orders blocked").
      //
      // We use a variant-scoped lock key for block sets:
      //   default/trailing/pause/dca: live:lock:{conn}:{sym}:{dir}
      //   block:                      live:lock:{conn}:{sym}:{dir}:block
      //
      // This allows at most 1 default + 1 block position per direction per
      // symbol simultaneously. isBlockVariant + _lockDirSuffix are hoisted
      // to function scope so every releaseLock / refreshLockTTL in this
      // function's long body uses the correct scoped key automatically.
      const acquired = await tryAcquireLock(
        connectionId,
        realPosition.symbol,
        realPosition.direction + _lockDirSuffix,
      )
      if (!acquired) {
        // Slot is held — try to merge into the existing exchange
        // position. If we can't (in-flight entry from another tick),
        // defer this signal cleanly.
        // For block variant: if the block lock is held, defer (another
        // block add-on is in-flight). Block does NOT merge into the
        // default position when its own lock is taken.
        const existing = isBlockVariant
          ? null // block defers; no merge-into-default on collision
          : await findOpenLivePositionByDir(
              connectionId,
              realPosition.symbol,
              realPosition.direction,
            )

        if (!existing) {
          // Lock present, no position visible yet → another tick is
          // mid-flight. DO NOT release the lock here (the previous
          // implementation did, which let two ticks both place exchange
          // orders). Surface a deferral and let the next cycle retry.
          livePosition.status = "rejected"
          livePosition.statusReason =
            `Dedup lock held — another entry in flight for ${realPosition.symbol} ${realPosition.direction}${isBlockVariant ? " (block)" : ""}; will retry next cycle`
          pushStep(livePosition, "preflight", false, livePosition.statusReason)
          await savePosition(livePosition)
          await incrementMetric(connectionId, "live_orders_deferred_count")
          // Normal high-frequency deferral under load — do not spam progression logs at "info".
          // The statusReason + saved position already provide visibility; only warn at low frequency.
          if (Math.random() < 0.05) {
            await logProgressionEvent(
              connectionId,
              "live_trading",
              "info",
              livePosition.statusReason,
              { symbol: realPosition.symbol, direction: realPosition.direction },
            ).catch(() => {})
          }
          return livePosition
        }

        // Need a price to compute additional volume + retain it for the
        // accumulator. Reuse fetchCurrentPrice with the realPosition
        // entry-price hint so we don't pay two fetches for the same tick.
        let accPrice = realPosition.entryPrice
        if (!accPrice || accPrice <= 0) accPrice = await fetchCurrentPrice(realPosition.symbol)

        // Skip-paths: when we can't accumulate right now (no market price
        // or no connector), we record the deferral on the EXISTING
        // position's progression rather than persisting the throw-away
        // `livePosition` placeholder into the open index. Reconcile will
        // pick up market data and a fresh signal on the next cycle.
        if (!accPrice || accPrice <= 0) {
          pushStep(
            existing,
            "accumulate_skip",
            false,
            `no market price for ${realPosition.symbol} — accumulation deferred`,
          )
          await savePosition(existing)
          return existing
        }

        if (!exchangeConnector || typeof exchangeConnector.placeOrder !== "function") {
          pushStep(
            existing,
            "accumulate_skip",
            false,
            "exchange connector unavailable — accumulation deferred",
          )
          await savePosition(existing)
          return existing
        }

        const merged = await accumulateIntoLivePosition(
          connectionId,
          existing,
          realPosition,
          accPrice,
          exchangeConnector,
        )
        // Refresh the existing slot's TTL — the position is still open
        // on the exchange and we want the safety expiry pushed forward
        // by the 300 s window. Lock value remains the original entry's
        // timestamp (intentional — debuggers see the original entry's
        // wall-clock, not the accumulation's).
        /* Do not refresh: this worker did not acquire the lock token. */
        return merged
      }
      liveOrderLockToken = acquired
      livePosition.liveLockToken = acquired
      // acquired === true: we own the slot. Continue to fresh-entry
      // path below. The historical `await acquireLock(...)` after order
      // placement is now redundant and has been removed (see Step 5).
    }

    // Short-circuit on simulation mode — still record the intent.
    //
    // CRITICAL: We populate `executedQuantity` / `averageExecutionPrice`
    // / `volumeUsd` / `remainingQuantity` / a synthetic `fills[]` entry
    // here. Previously the simulated branch left all of these at 0,
    // which silently broke EVERY downstream close path:
    //
    //   * `checkAndForceCloseOnSltpCross()` early-returns when
    //     `executedQuantity <= 0` or `averageExecutionPrice <= 0` — so
    //     simulated positions never honored their SL/TP levels.
    //   * The max-hold-time closer in `syncWithExchange` /
    //     `reconcileLivePositions` also gates on
    //     `executedQuantity > 0`, so the 4-hour safety net never
    //     force-closed simulated positions either.
    //
    // Net effect: every simulated live order sat OPEN forever in the
    // Redis open-index, growing `live_positions_created_count` without
    // ever growing `live_positions_closed_count`. This is the exact
    // "Live Positions are Still not getting closed" symptom the
    // operator reported on paper / is_live_trade=false connections.
    //
    // Now: a simulated position behaves like a fully-filled exchange
    // position at the requested entryPrice, with the (new) per-tick
    // `processSimulatedPositions` sweep walking Redis market_data
    // and force-closing on SL/TP cross or max-hold-time expiry.
    if (!isLiveTradeEnabled) {
      const existingSimulatedSlot = await findOpenLivePositionByDir(
        connectionId,
        realPosition.symbol,
        realPosition.direction,
      )
      if (existingSimulatedSlot) {
        pushStep(
          existingSimulatedSlot,
          "simulate_skip",
          false,
          `simulated slot already open for ${realPosition.symbol} ${realPosition.direction}`,
        )
        existingSimulatedSlot.statusReason =
          existingSimulatedSlot.statusReason || "live_trade disabled by operator — no exchange execution"
        existingSimulatedSlot.executionMode = "simulation"
        existingSimulatedSlot.updatedAt = Date.now()
        await savePosition(existingSimulatedSlot)
        return existingSimulatedSlot
      }

      // Fetch the current market price so simulated positions open at a
      // real price (not 0). This mirrors the live path's Step 2 but runs
      // here before the simulation early-return so SL/TP cross-checks and
      // PnL display are meaningful.
      let simEntryPrice = livePosition.entryPrice || realPosition.entryPrice || 0
      if (!simEntryPrice || simEntryPrice <= 0) {
        simEntryPrice = (await fetchCurrentPrice(realPosition.symbol).catch(() => 0)) || 0
      }
      livePosition.entryPrice = simEntryPrice

      // Compute a realistic volume using the VolumeCalculator (same as Step 3
      // on the live path). Falls back to realPosition.quantity if the
      // calculator fails (e.g. no balance data in sandbox).
      let simQty = realPosition.quantity || 1
      try {
        const { VolumeCalculator } = await import("@/lib/volume-calculator")
        const simVolResult = await VolumeCalculator.calculateVolumeForConnection(
          connectionId,
          realPosition.symbol,
          simEntryPrice,
        )
        const vol = simVolResult?.finalVolume ?? simVolResult?.calculatedVolume ?? simVolResult?.volume ?? 0
        if (vol > 0) {
          simQty = vol
          livePosition.leverage = simVolResult.leverage || livePosition.leverage
        }
      } catch { /* fallback to realPosition.quantity */ }

      // Set averageExecutionPrice before calling computeDesiredProtectionPrices
      // because that function uses it as the fill price for SL/TP calculation.
      livePosition.averageExecutionPrice = simEntryPrice
      // Compute SL/TP prices for the simulated position so reconcile and
      // checkAndForceCloseOnSltpCross have valid price targets.
      if (simEntryPrice > 0) {
        const simProtection = computeDesiredProtectionPrices(livePosition)
        if (simProtection.desiredSl > 0) livePosition.assignedStopLoss  = simProtection.desiredSl
        if (simProtection.desiredTp > 0) livePosition.assignedTakeProfit = simProtection.desiredTp
      }
      livePosition.executedQuantity = simQty
      livePosition.remainingQuantity = 0
      livePosition.averageExecutionPrice = simEntryPrice
      livePosition.volumeUsd = simQty * simEntryPrice
      livePosition.initialExecutedQuantity = simQty
      livePosition.totalExecutedQuantity = simQty
      livePosition.initialEntryPrice = simEntryPrice
      livePosition.blockBaseQuantity = simQty
      if (livePosition.combinedPosCounts) {
        livePosition.posCountsSetQuantities = allocatePositionSetQuantities(
          livePosition,
          simQty,
          livePosition.accumulatedSetKeys,
        )
      }
      livePosition.fills = [
        {
          timestamp: Date.now(),
          quantity: simQty,
          price: simEntryPrice,
          fee: 0,
          feeAsset: "",
        },
      ]
      livePosition.status = "simulated"
      livePosition.statusReason = "live_trade disabled by operator — no exchange execution"
      livePosition.executionMode = "simulation"
      pushStep(livePosition, "simulate", true, `qty=${simQty} @ ${simEntryPrice}`)
      await savePosition(livePosition)
      await recordFillCountersOnce(
        connectionId,
        livePosition,
        realPosition.symbol,
        realPosition.direction,
      )
      // Persist the durable fill marker after the idempotent entry ledger and
      // legacy fill metrics have committed.
      await savePosition(livePosition)
      // Run counters in parallel — they're independent. Simulated orders are
      // canonicalized as both placed and filled because this branch immediately
      // creates an open position with executed quantity and a synthetic fill.
      await Promise.all([
        incrementMetric(connectionId, "live_orders_simulated_count"),
        incrementMetric(connectionId, "live_orders_placed_count"),
        incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "placed"),
        // Track simulated positions in created counter as well so the
        // openPositions.live.open = created - closed math works for
        // paper trades (the close-counter is bumped by
        // closeLivePosition / reconcile when the simulated position
        // gets force-closed).
        incrementMetric(connectionId, "live_positions_created_count"),
        logProgressionEvent(
          connectionId,
          "live_trading",
          "info",
          `Simulated live order (live_trade disabled by operator) ${realPosition.symbol}`,
          { direction: realPosition.direction, quantity: simQty, entryPrice: simEntryPrice }
        ),
      ])
      console.log(`${LOG_PREFIX} SIMULATION: ${realPosition.symbol} ${realPosition.direction} qty=${simQty} @ ${simEntryPrice} (live_trade disabled by operator)`)
      return livePosition
    }

    if (!exchangeConnector || typeof exchangeConnector.placeOrder !== "function") {
      livePosition.status = "error"
      livePosition.statusReason = "Exchange connector not available or missing placeOrder"
      pushStep(livePosition, "connector_check", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_failed_count")
      await incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "failed")
      await logProgressionEvent(connectionId, "live_trading", "error", "Live order failed — no connector", {
        symbol: realPosition.symbol,
      })
      // Release the dedup lock we acquired at the top of this function so
      // the next signal isn't blocked for the full 5-min TTL on a non-
      // recoverable connector failure (operator likely didn't configure a
      // connector — they need to be able to retry once they do).
      if (liveOrderLockToken) await releaseLock(connectionId, realPosition.symbol, realPosition.direction + _lockDirSuffix, liveOrderLockToken).catch(() => {})
      return livePosition
    }

    // ── Step 2: Fetch current market price ──────�����������──────────────────────────
    let currentPrice = realPosition.entryPrice
    if (!currentPrice || currentPrice <= 0) {
      currentPrice = await fetchCurrentPrice(realPosition.symbol)
    }
    if (!currentPrice || currentPrice <= 0) {
      livePosition.status = "error"
      livePosition.statusReason = `No current price available for ${realPosition.symbol}`
      pushStep(livePosition, "price_fetch", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_failed_count")
      await incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "failed")
      await logProgressionEvent(connectionId, "live_trading", "error", "Live order failed — no market price", {
        symbol: realPosition.symbol,
      })
      // Release the dedup lock — a missing market price is a transient
      // condition (typically a fresh symbol whose ticker hasn't streamed
      // yet). Without releasing, the next cycle's signal would defer for
      // 5 minutes even though the price arrives within seconds.
      if (liveOrderLockToken) await releaseLock(connectionId, realPosition.symbol, realPosition.direction + _lockDirSuffix, liveOrderLockToken).catch(() => {})
      return livePosition
    }
    livePosition.entryPrice = currentPrice
    pushStep(livePosition, "price_fetch", true, `price=${currentPrice}`)

    // ── Operator policy: ALWAYS use venue max leverage ─────────────────
    // realPosition.leverage carries the per-variant coordination signal
    // (1, 2, 3, 5x from expandSizeLeverageVariants). That is an INTERNAL
    // ranking signal only — at order time we unconditionally override to
    // the connection's maximum supported leverage.
    //
    // The previous guard `if (venueMax > livePosition.leverage)` caused
    // silent failures: when getMaxLeverageForExchange returned the
    // SAFE_DEFAULT (10) �� which is > any coordination signal (1–5x) —
    // the position was placed at 10x rather than 150x (BingX max).
    // Fix: always assign, no comparison.
    //
    // Downstream safety nets remain armed:
    //   1. setLeverage(symbol, venueMax) — exchange clamps to per-symbol
    //      bracket (e.g. BTC 125x, SOL 75x)
    //   2. 101204 "Insufficient margin" auto-halve + lev=1 retry below
    {
      const previous = livePosition.leverage
      const { getConnection: _getConnLev } = await import("@/lib/redis-db")
      const connRecord = await _getConnLev(connectionId).catch(() => null)
      const venueMax = getMaxLeverageForExchange(connRecord?.exchange)
      livePosition.leverage = venueMax
      pushStep(
        livePosition,
        "leverage_override",
        true,
        `coordination=${previous}x → venue_max=${venueMax}x (operator policy)`,
      )
    }

    // ── Step 3: Volume calculation ──────────────��──────────────────────────
    // POLICY: minimum volume is ALWAYS enforced �� we never reject a live
    // order for "qty too small". If the calculator returns null or a
    // non-positive quantity (e.g. balance fetch failed, NaN math) we
    // synthesize a fallback at the universal $5-notional floor and
    // continue. This keeps the operator's signal flow uninterrupted
    // and matches the documented behavior of `VolumeCalculator`.
    //
    // ── Trade-mode resolution for the engine volume factor ────────
    // The live-stage IS the live-execution path by definition — it
    // MUST tell `VolumeCalculator` which engine is asking for sizing so
    // the per-engine multiplier (Main vs. Preset) is applied. We reuse
    // the already-loaded `connSettings` to derive the mode without a
    // second Redis round-trip:
    //   - Preset engine: `is_preset_trade=true` AND `is_live_trade=false`
    //   - Main   engine: otherwise (the conservative default — when
    //                    both flags happen to be true during a UI
    //                    toggle transition we don't want to silently
    //                    apply Preset's typically-more-aggressive
    //                    multiplier).
    // Strategy / pseudo-position callers (in pseudo-position-manager)
    // do NOT pass `tradeMode` — they remain ratio-only per spec.
    const liveTradeMode: "main" | "preset" =
      isTruthyFlag(connSettings.is_preset_trade) && !isTruthyFlag(connSettings.is_live_trade)
        ? "preset"
        : "main"

    const volumeResult = await VolumeCalculator.calculateVolumeForConnection(
      connectionId,
      realPosition.symbol,
      currentPrice,
      {
        tradeMode: liveTradeMode,
        // Forward the Block/DCA variant multiplier so notional is correctly
        // scaled before the exchange order is placed (absent → 1.0 identity).
        sizeMultiplier: realPosition.sizeMultiplier,
      },
    ).catch(err => {
      console.error(`${LOG_PREFIX} volume calc error:`, err)
      return null
    })

    let computedVolume = volumeResult?.finalVolume || volumeResult?.volume || 0
    let volumeNote = ""
    if (computedVolume <= 0 || !Number.isFinite(computedVolume)) {
      // Synthesize at the minimal fallback ($5 notional) when the
      // VolumeCalculator returns nothing. The per-pair exchange minimum
      // from trading-pair metadata (stored in Redis) normally takes over
      // as the hard floor inside VolumeCalculator — this path is a last-
      // resort for pairs with no metadata or calculator failures. Kept
      // at $5 to match the quickstart minimal-volume policy.
      const FALLBACK_NOTIONAL_USD = 5
      computedVolume = currentPrice > 0
        ? FALLBACK_NOTIONAL_USD / currentPrice
        : 0
      volumeNote = ` [synthesized-min: $${FALLBACK_NOTIONAL_USD} notional fallback — calculator returned ${volumeResult?.finalVolume ?? "null"}]`
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "info",
        `Live order volume synthesized to enforced minimum for ${realPosition.symbol}`,
        {
          reason: volumeResult?.adjustmentReason || "calculator returned no usable quantity",
          fallbackNotionalUsd: FALLBACK_NOTIONAL_USD,
          synthesizedQty: computedVolume,
        }
      )
    }

    // High-visibility diagnostic for the most common reason real orders never appear on the exchange
    if (computedVolume <= 0) {
      console.error(
        `${LOG_PREFIX} [NO_REAL_ORDER] ${realPosition.symbol} ${realPosition.direction} — computedVolume=0 after all fallbacks. ` +
        `This is almost always why "no positions on live exchange" after quickstart. ` +
        `volumeResult=${JSON.stringify(volumeResult)}`
      )
    }

    livePosition.quantity = computedVolume
    livePosition.remainingQuantity = computedVolume
    livePosition.volumeUsd = computedVolume * currentPrice
    livePosition.leverage = volumeResult?.leverage || livePosition.leverage

    // If the volume calculator clamped the quantity UP to the exchange
    // minimum (or we synthesized a fallback above), surface that in the
    // progression step so the UI / logs show *why* the executed qty
    // differs from the coordination-derived qty rather than just a bare
    // number. The step is always recorded as successful because the
    // order itself is valid — minimum enforcement never fails the trade.
    const clampNote = volumeResult?.volumeAdjusted && volumeResult.adjustmentReason
      ? ` [clamped-to-min: ${volumeResult.adjustmentReason}]`
      : ""
    pushStep(
      livePosition,
      "volume_calc",
      true,
      `qty=${computedVolume.toFixed(6)} usd=${livePosition.volumeUsd.toFixed(2)} lev=${livePosition.leverage}x${clampNote}${volumeNote}`
    )
    if (volumeResult) {
      await VolumeCalculator.logVolumeCalculation(connectionId, realPosition.symbol, volumeResult).catch(() => {})
    }

    // ── Step 4: Configure leverage + margin type on exchange ───────────────
    // T2.3 perf: parallelize the two pre-flight venue calls. They are
    // idempotent and independent — `setLeverage` configures the
    // per-symbol leverage bracket, `setMarginType` configures
    // cross/isolated. Running them concurrently shaves one full
    // round-trip off every live entry. Both still complete BEFORE the
    // order is placed, so the venue sees consistent margin semantics
    // for the order. Errors are captured per-call and logged
    // independently — a failure in one does NOT skip the other.
    const marginTypeSetting = (connSettings.margin_type as "cross" | "isolated") || "cross"
    livePosition.marginType = marginTypeSetting

    const setLeveragePromise: Promise<{ ok: boolean; note: string }> =
      typeof exchangeConnector.setLeverage === "function"
        ? exchangeConnector
            .setLeverage(realPosition.symbol, livePosition.leverage)
            .then((lev: any) => ({
              ok: !!lev?.success,
              note: lev?.error || `leverage=${livePosition.leverage}`,
            }))
            .catch((err: unknown) => ({ ok: false, note: String(err) }))
        : Promise.resolve({
            ok: true,
            note: "connector does not expose setLeverage ��� skipping",
          })

    const setMarginTypePromise: Promise<{ ok: boolean; note: string }> =
      typeof exchangeConnector.setMarginType === "function"
        ? exchangeConnector
            .setMarginType(realPosition.symbol, marginTypeSetting)
            .then((m: any) => ({
              ok: !!m?.success,
              note: m?.error || `margin=${marginTypeSetting}`,
            }))
            .catch((err: unknown) => ({ ok: false, note: String(err) }))
        : Promise.resolve({
            ok: true,
            note: "connector does not expose setMarginType — skipping",
          })

    const [levResult, marginResult] = await Promise.all([setLeveragePromise, setMarginTypePromise])
    pushStep(livePosition, "set_leverage", levResult.ok, levResult.note)
    pushStep(livePosition, "set_margin_type", marginResult.ok, marginResult.note)


    // ── Step 5: Place entry order with retry ─────────────────────����─────────
    const exchangeSide: "buy" | "sell" = realPosition.direction === "long" ? "buy" : "sell"

    // ── Comprehensive logging trace ──────────────────────────────────
    // One trace id spans the primary attempt, the leverage-reduced retry,
    // the min-size correction retry, the fill polling, and the final
    // outcome line. Grep `[v0] [LiveOrder]` + `trace=` to reconstruct the
    // full lifecycle of any failing order. Trace is created here (not at
    // function entry) so accumulation merges and dedup-skip paths above
    // don't pollute the log with no-op traces.
    const orderTrace: LiveOrderTrace = newLiveOrderTrace({
      connectionId,
      symbol: realPosition.symbol,
      direction: realPosition.direction,
      exchangeSide,
    })

    console.log(
      `${LOG_PREFIX} EXECUTING REAL: ${realPosition.symbol} ${realPosition.direction} → ${exchangeSide} qty=${computedVolume.toFixed(
        6
      )} @ ${currentPrice} trace=${orderTrace.traceId}`
    )

    // For perp entries we pass the explicit positionSide matching the real
    // position direction so hedge-mode accounts route correctly. Connectors
    // that don't care about the options object simply ignore the 6th arg.
    // BingX's one-way-mode accounts auto-retry without positionSide if the
    // exchange rejects it (code 80014), so this is safe for both modes.
    //
    // ── CRITICAL: Re-check is_live_trade RIGHT BEFORE order placement ──────
    // The flag is checked once at entry, but if the operator toggles Live Trade
    // off during preflight, we must catch it here before sending the order to
    // the exchange. This is a defensive second gate. Testnet is still an
    // exchange environment, so do NOT block it here; the connector routes to
    // the testnet endpoint when is_testnet is true.
    const { getConnection: reCheckConn } = await import("@/lib/redis-db")
    const {
      isConnectionLiveTradeEnabled: reCheckMainEnabled,
      isConnectionPresetTradeEnabled: reCheckPresetEnabled,
      isTruthyFlag: reCheckTruthy,
    } = await import("@/lib/connection-state-utils")
    const freshSettings = (await reCheckConn(connectionId)) || {}
    const positionMode = String((freshSettings as any).position_mode || (freshSettings as any).positionMode || "").toLowerCase()
    const hedgeMode = positionMode.includes("hedge") || positionMode.includes("dual")
    const entryOrderOptions = hedgeMode
      ? {
          hedgeMode: true,
          positionSide: (realPosition.direction === "long" ? "LONG" : "SHORT") as "LONG" | "SHORT",
          clientOrderId: orderTrace.exchangeTrackingId,
        }
      : { hedgeMode: false, clientOrderId: orderTrace.exchangeTrackingId }
    const freshMainModeEnabled = reCheckMainEnabled(freshSettings)
    const freshPresetModeEnabled = reCheckPresetEnabled(freshSettings)
    const freshExecutionIntent: "main" | "preset" = freshPresetModeEnabled && !freshMainModeEnabled ? "preset" : "main"
    const freshReadiness = evaluateRealTradeReadiness(freshSettings, freshExecutionIntent)
    const supervisedSmokeId = await client.get("live_order_smoke:active").catch(() => null)
    const isStillLive = freshReadiness.canPlaceRealOrders && !supervisedSmokeId
    
    const isTestnetConnection = reCheckTruthy(freshSettings.is_testnet)
    if (isTestnetConnection) {
      pushStep(livePosition, "entry_environment", true, "testnet connection — routing order through testnet connector endpoint")
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "info",
        "Live order proceeding on exchange testnet endpoint",
        { symbol: realPosition.symbol, direction: realPosition.direction, exchangeApi: freshSettings.exchange },
      ).catch(() => {})
    }

    if (!isStillLive) {
      livePosition.status = "rejected"
      livePosition.executionMode = "blocked"
      livePosition.executionBlockCode = freshReadiness.blockCode || undefined
      livePosition.executionBlockReason = freshReadiness.blockReason || undefined
      livePosition.statusReason = supervisedSmokeId
        ? `Exchange order blocked before placement: supervised live-order smoke ${supervisedSmokeId} owns the account gate`
        : `Exchange order blocked before placement (${freshReadiness.blockCode || "unknown"}): ${freshReadiness.blockReason}`
      pushStep(livePosition, "entry", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_blocked_count")
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "info",
        livePosition.statusReason,
        { symbol: realPosition.symbol, direction: realPosition.direction },
      ).catch(() => {})
      if (liveOrderLockToken) {
        await releaseLock(
          connectionId,
          realPosition.symbol,
          realPosition.direction + _lockDirSuffix,
          liveOrderLockToken,
        ).catch(() => {})
      }
      return livePosition
    }

    // Persist the idempotency key before the request can leave this process.
    // A crash or response timeout can therefore recover the exact venue order
    // by clientOrderId instead of submitting a duplicate entry.
    livePosition.submissionState = "prepared"
    appendClientOrderTracking(livePosition, orderTrace.exchangeTrackingId, "entry", {
      quantity: computedVolume,
      side: exchangeSide,
    })
    pushStep(livePosition, "entry_submission_prepared", true, `clientOrderId=${orderTrace.exchangeTrackingId}`)
    await savePosition(livePosition)
    await persistCriticalLiveState(`entry:${livePosition.id}`)

    // Strong diagnostic log right before real money order attempt
    console.log(
      `${LOG_PREFIX} [REAL_ORDER_ATTEMPT] conn=${connectionId} sym=${realPosition.symbol} dir=${realPosition.direction} ` +
      `computedVol=${computedVolume} price=${currentPrice} lev=${livePosition.leverage} ` +
      `setKey=${livePosition.setKey} trace=${orderTrace.traceId}`
    )

    // The `retry()` helper repeats up to 3× on transient failures; we
    // emit PRE/POST per ATTEMPT so the log shows each round-trip. The
    // attempt counter is captured by closure so leverage-reduced and
    // min-size-corrected retries below get distinct labels.
    let placeAttempt = 0
    let orderResult: any = await retry(
      async () => {
        placeAttempt += 1
        const { raw } = await withLiveOrderLogging(
          orderTrace,
          {
            quantity: computedVolume,
            price: currentPrice,
            leverage: livePosition.leverage,
            marginType: livePosition.marginType ?? "unknown",
            orderType: "market",
            options: entryOrderOptions,
            strategySetKey: livePosition.setKey,
            realPositionId: realPosition.id,
            attempt: placeAttempt,
            label: "primary",
          },
          () => exchangeConnector.placeOrder(
            realPosition.symbol,
            exchangeSide,
            computedVolume,
            undefined,
            "market",
            entryOrderOptions,
          ),
        )
        return raw
      },
      (r: any) => !!r?.success,
      "placeOrder"
    )

    // ── Volume reduction on 101204 (Insufficient margin) ────────────────
    // Leverage is kept at its maximum value — never reduced. When the
    // exchange rejects with "Insufficient margin" we instead halve the
    // position volume and retry ONCE at the same leverage. Halving volume
    // halves the required margin while keeping the leverage multiplier
    // (and therefore the per-unit notional gain) intact. If the halved
    // volume still fails, we fall back to the exchange minimum quantity at
    // the same leverage, which represents the absolute smallest notional
    // with the best leverage efficiency.
    if (!orderResult?.success && isNonRecoverableExchangeError(orderResult)) {
      const reducedVolume = computedVolume / 2
      // Ensure the halved volume is meaningfully smaller (> 0.1% diff) and positive.
      const volumeDiffPct = computedVolume > 0 ? Math.abs(reducedVolume - computedVolume) / computedVolume : 0
      if (reducedVolume > 0 && volumeDiffPct > 0.001) {
        console.warn(
          `${LOG_PREFIX} 101204 on ${realPosition.symbol} — retrying with halved volume ` +
          `${computedVolume.toFixed(6)} → ${reducedVolume.toFixed(6)} (leverage kept at ${livePosition.leverage}x)`,
        )

        const retryResult: any = await retry(
          async () => {
            placeAttempt += 1
            const { raw } = await withLiveOrderLogging(
              orderTrace,
              {
                quantity: reducedVolume,
                price: currentPrice,
                leverage: livePosition.leverage,
                marginType: livePosition.marginType ?? "unknown",
                orderType: "market",
                options: entryOrderOptions,
                strategySetKey: livePosition.setKey,
                realPositionId: realPosition.id,
                attempt: placeAttempt,
                label: "volume-halved",
              },
              () => exchangeConnector.placeOrder(
                realPosition.symbol,
                exchangeSide,
                reducedVolume,
                undefined,
                "market",
                entryOrderOptions,
              ),
            )
            return raw
          },
          (r: any) => !!r?.success && !!(r.orderId || r.id),
          "placeOrder-reducedVol",
          1 // single retry — we already tried 3× above at original volume
        )

        if (retryResult?.success && (retryResult.orderId || retryResult.id)) {
          // Succeeded with reduced volume at max leverage — update position and continue.
          computedVolume = reducedVolume
          livePosition.quantity = reducedVolume
          livePosition.remainingQuantity = reducedVolume
          livePosition.volumeUsd = reducedVolume * currentPrice
          orderResult = retryResult
          console.log(
            `${LOG_PREFIX} Entry succeeded after volume reduction to ${reducedVolume.toFixed(6)} at ${livePosition.leverage}x for ${realPosition.symbol}`,
          )
        } else if (isNonRecoverableExchangeError(retryResult)) {
          // Both the original and halved-volume attempts failed with 101204.
          // Try one last time at the exchange minimum qty — still at max leverage.
          // Prefer the stored exchange minimum from the 101400 handler
          // (`settings:trading_pair:{sym}` → `min_order_size`). Fall back to $5/price.
          let minQtyForSymbol = currentPrice > 0 ? 5 / currentPrice : 0
          try {
            const redisClient = getRedisClient()
            if (redisClient) {
              const storedMin = await redisClient.hget(
                `settings:trading_pair:${realPosition.symbol}`,
                "min_order_size",
              )
              const parsedStoredMin = storedMin ? parseFloat(storedMin) : 0
              if (parsedStoredMin > 0) {
                minQtyForSymbol = parsedStoredMin
              }
            }
          } catch { /* non-critical; fall back to $5/price */ }

          // Only attempt if the quantity is meaningfully different from what we already tried.
          const minQuantityDiffPct = reducedVolume > 0
            ? Math.abs(minQtyForSymbol - reducedVolume) / reducedVolume
            : 1
          if (minQtyForSymbol > 0 && minQuantityDiffPct > 0.001) {
            console.warn(
              `${LOG_PREFIX} 101204 at half-volume still fails on ${realPosition.symbol} — ` +
              `trying min notional qty=${minQtyForSymbol.toFixed(8)} at ${livePosition.leverage}x (max leverage kept)`,
            )
            placeAttempt += 1
            const minResult: any = await withLiveOrderLogging(
              orderTrace,
              {
                quantity: minQtyForSymbol,
                price: currentPrice,
                leverage: livePosition.leverage,
                marginType: livePosition.marginType ?? "unknown",
                orderType: "market",
                options: entryOrderOptions,
                strategySetKey: livePosition.setKey,
                realPositionId: realPosition.id,
                attempt: placeAttempt,
                label: "min-notional-max-lev",
              },
              async () => {
                const r = await exchangeConnector.placeOrder(
                  realPosition.symbol,
                  exchangeSide,
                  minQtyForSymbol,
                  undefined,
                  "market",
                  entryOrderOptions,
                )
                return r
              },
            ).then(({ raw }) => raw).catch(() => null)
            if (minResult?.success && (minResult.orderId || minResult.id)) {
              computedVolume = minQtyForSymbol
              livePosition.quantity = minQtyForSymbol
              livePosition.remainingQuantity = minQtyForSymbol
              livePosition.volumeUsd = minQtyForSymbol * currentPrice
              orderResult = minResult
              console.log(
                `${LOG_PREFIX} Entry succeeded at min-notional ${minQtyForSymbol.toFixed(8)} at ${livePosition.leverage}x for ${realPosition.symbol}`,
              )
            } else {
              console.warn(
                `${LOG_PREFIX} 101204 at min-notional also failed for ${realPosition.symbol} — recording margin error`,
              )
              recordMarginError(connectionId)
              orderResult = minResult ?? retryResult ?? orderResult
            }
          } else {
            // qty would be the same as before — no point retrying.
            recordMarginError(connectionId)
            orderResult = retryResult ?? orderResult
          }
        } else {
          // Non-margin failure after volume reduction — give up normally.
          recordMarginError(connectionId)
          orderResult = retryResult ?? orderResult
        }
      } else {
        // Volume already at minimum — cannot reduce further without going below exchange minimum.
        recordMarginError(connectionId)
      }
    }

    // ── Exchange circuit-breaker (109400) detection ────���──────────────
    // Code 109400 = exchange temporarily halted API trading for this
    // symbol due to volatility. This is NOT a margin issue — record a
    // per-symbol circuit-breaker and let the connection continue placing
    // orders on other symbols without triggering the margin cooldown.
    if (!orderResult?.success && isCircuitBreakerError(orderResult)) {
      recordCircuitBreaker(realPosition.symbol)
      livePosition.status = "error"
      livePosition.statusReason = `Exchange circuit breaker active for ${realPosition.symbol} — retrying in <5min`
      pushStep(livePosition, "place_order", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_failed_count")
      await incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "failed")
      await logProgressionEvent(connectionId, "live_trading", "warning", livePosition.statusReason, {
        symbol: realPosition.symbol,
        error: orderResult?.error,
      })
      if (liveOrderLockToken) await releaseLock(connectionId, realPosition.symbol, realPosition.direction + _lockDirSuffix, liveOrderLockToken).catch(() => {})
      await logLiveOrderFinal(orderTrace, {
        status: "rejected",
        livePositionId: livePosition.id,
        reason: livePosition.statusReason,
        extra: {
          errorCode: orderResult?.errorCode ?? orderResult?.code,
          error: orderResult?.error,
          attempts: placeAttempt,
        },
      })
      return livePosition
    }

    // ── Hard stop on failed entry placement ────────────────────────────────
    // The protection/fill pipeline below is only valid after the exchange has
    // acknowledged a real entry order. Previously a transient or venue-side
    // `{ success:false }` result that was not classified as margin/circuit
    // breaker still fell through, stamped the position as "placed" with an
    // undefined orderId, then attempted fill fallback and SL/TP placement for
    // an order that never existed. That created the exact class of live-order
    // errors operators saw: fake local positions, repeated protection-order
    // failures, and confusing "position not exist" exchange responses.
    let entryOrderId = orderResult?.orderId || orderResult?.id
    if (!entryOrderId) {
      const recovered = await recoverEntryOrderByClientId(
        exchangeConnector,
        realPosition.symbol,
        orderTrace.exchangeTrackingId,
      )
      if (recovered) {
        orderResult = recovered
        entryOrderId = recovered.orderId || recovered.id
      }
    }
    if (!orderResult?.success || !(orderResult?.orderId || orderResult?.id)) {
      const reason =
        orderResult?.error ||
        orderResult?.message ||
        (orderResult?.success ? "Exchange accepted entry but returned no orderId" : "Exchange entry order was rejected")
      
      // ── 101400 Minimum Order Amount Error Correction with Same-Cycle Retry ─
      // When BingX rejects with code=101400, extract the minimum from the error
      // message and retry IMMEDIATELY with corrected volume in THIS cycle.
      // This prevents wasting cycles on repeated sub-minimum rejections.
      let retryWasAttempted = false
      if (isMinOrderSizeError(reason) && placeAttempt < 3) {
        const minQty = extractMinOrderQty(reason)
        if (minQty && minQty > 0 && minQty > computedVolume) {
          retryWasAttempted = true
          try {
            const { setSettings } = await import("@/lib/redis-db")
            
            // Save the corrected minimum for future cycles
            await setSettings(`trading_pair:${realPosition.symbol}`, {
              min_order_size: minQty,
              updated_at: new Date().toISOString(),
              source: "101400_error_extraction",
            })
            
            console.warn(
              `${LOG_PREFIX} [101400 Correction] Detected minimum ${minQty} > current ${computedVolume.toFixed(8)} for ${realPosition.symbol}; retrying in same cycle`,
            )
            
            // Use minimum + 10% margin to ensure acceptance
            const retryQty = minQty * 1.1
            console.log(
              `${LOG_PREFIX} [101400 Retry] Sending with margin: ${retryQty.toFixed(8)} (min: ${minQty.toFixed(8)} × 1.1)`,
            )
            
            // Retry immediately with corrected quantity
            const retryOrderResult = await exchangeConnector.placeOrder(
              realPosition.symbol,
              exchangeSide,
              retryQty,
              undefined,
              "market",
              entryOrderOptions,
            )
            
            if (retryOrderResult?.success && (retryOrderResult?.orderId || retryOrderResult?.id)) {
              console.log(
                `${LOG_PREFIX} [101400 Retry] Successfully placed order with volume ${retryQty.toFixed(8)} for ${realPosition.symbol}`,
              )
              // Continue with the corrected order
              orderResult = retryOrderResult
              computedVolume = retryQty  // Update for subsequent logging
              retryWasAttempted = true  // Mark retry was attempted and succeeded
              entryOrderId = retryOrderResult?.orderId || retryOrderResult?.id
            } else {
              // Retry also failed
              console.warn(
                `${LOG_PREFIX} [101400 Retry] Retry with ${retryQty.toFixed(8)} also failed:`,
                retryOrderResult?.error || retryOrderResult?.message || "unknown",
              )
              retryWasAttempted = false  // Retry was attempted but failed
            }
          } catch (err) {
            console.warn(
              `${LOG_PREFIX} [101400 Correction] Retry attempt failed:`,
              err instanceof Error ? err.message : String(err),
            )
          }
        }
      }
      
      // If no retry was attempted, or retry failed, pre-mark as rejected so
      // the cleanup block below can run. The check below will override this
      // if the retry actually succeeded (retryOrderId is set + orderResult.success).
      if (!retryWasAttempted) {
        livePosition.status = "rejected"
        livePosition.statusReason = String(reason)
        pushStep(livePosition, "place_order", false, livePosition.statusReason)
      }
      
      // Check if we successfully retried and got an order ID
      let retryOrderId = orderResult?.orderId || orderResult?.id
      if (!retryOrderId) {
        const recovered = await recoverEntryOrderByClientId(
          exchangeConnector,
          realPosition.symbol,
          orderTrace.exchangeTrackingId,
        )
        if (recovered) {
          orderResult = recovered
          retryOrderId = recovered.orderId || recovered.id
          entryOrderId = retryOrderId
        }
      }
      if (!retryOrderId || !orderResult?.success) {
        const definitiveRejection =
          !orderResult?.success &&
          (isMinOrderSizeError(reason) || isNonRecoverableExchangeError(orderResult) || isCircuitBreakerError(orderResult))

        if (definitiveRejection) {
          livePosition.status = "rejected"
          livePosition.statusReason = String(reason)
          livePosition.submissionState = "confirmed"
          pushStep(livePosition, "place_order", false, livePosition.statusReason)
          await savePosition(livePosition)
          await incrementMetric(connectionId, "live_orders_failed_count")
          await incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "failed")
          if (liveOrderLockToken) {
            await releaseLock(connectionId, realPosition.symbol, realPosition.direction + _lockDirSuffix, liveOrderLockToken).catch(() => false)
          }
        } else {
          Object.assign(livePosition, {
            status: "placed_unconfirmed" as const,
            submissionState: "unconfirmed" as const,
          })
          livePosition.statusReason =
            `entry_submission_unconfirmed: ${String(reason)}; tracking by clientOrderId until authoritative recovery`
          pushStep(livePosition, "entry_submission_unconfirmed", false, livePosition.statusReason)
          await savePosition(livePosition)
          await incrementMetric(connectionId, "live_orders_deferred_count")
        }
        await logProgressionEvent(
          connectionId,
          "live_trading",
          definitiveRejection ? "error" : "warning",
          definitiveRejection
            ? `Entry order rejected for ${realPosition.symbol}`
            : `Entry submission unconfirmed for ${realPosition.symbol}`,
          {
            symbol: realPosition.symbol,
            direction: realPosition.direction,
            side: exchangeSide,
            quantity: computedVolume,
            price: currentPrice,
            error: livePosition.statusReason,
            clientOrderId: orderTrace.exchangeTrackingId,
            attempts: placeAttempt,
          },
        )
        await logLiveOrderFinal(orderTrace, {
          status: definitiveRejection ? "rejected" : "placed",
          livePositionId: livePosition.id,
          reason: livePosition.statusReason,
          extra: { orderResult, attempts: placeAttempt },
        })
        return livePosition
      }
    }

    livePosition.orderId = String(entryOrderId)
    livePosition.status = "placed"
    livePosition.submissionState = "confirmed"
    pushStep(livePosition, "place_order", true, `orderId=${livePosition.orderId}`)
    await incrementMetric(connectionId, "live_orders_placed_count")
    await incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "placed")
    // Successful placement — reset the margin error consecutive-failure counter
    // so the backoff resets to the shortest cooldown on the next failure.
    marginErrorCooldownByConnection.delete(connectionId)
    // ── Refresh the dedup lock TTL ──────────────────────────────────────
    // The poll-fill phase below can take up to 15s. Without a mid-pipeline
    // TTL refresh, a slow venue + SL/TP placement could push past the
    // lock's 90s window, letting another tick place a duplicate position.
    // Re-stamp the lock here so the slot stays owned through fill + protect.
    if (liveOrderLockToken) {
      const stillOwnsLock = await refreshLockTTL(
        connectionId,
        realPosition.symbol,
        realPosition.direction + _lockDirSuffix,
        liveOrderLockToken,
      ).catch(() => false)
      if (!stillOwnsLock) {
        livePosition.status = "error"
        livePosition.statusReason = "Lost live-order lock ownership before fill confirmation"
        pushStep(livePosition, "lock_refresh", false, livePosition.statusReason)
        await savePosition(livePosition)
        return livePosition
      }
    }
    await logProgressionEvent(connectionId, "live_trading", "info", `Entry order placed for ${realPosition.symbol}`, {
      orderId: livePosition.orderId,
      side: exchangeSide,
      quantity: computedVolume,
      price: currentPrice,
      leverage: livePosition.leverage,
    })

    // Persist intermediate state so UI can show "placed" even during poll.
    await savePosition(livePosition)

    // ── Step 6: Fill confirmation ──────────────────────────────────────────
    // Three-layer strategy:
    //  A) Inline: Many exchanges (BingX, Bybit) return immediate fill data in
    //     the placeOrder response itself. Extract it before polling to avoid
    //     a full 15s wait on fast-fill venues.
    //  B) Poll: Standard path — repeatedly call getOrder() until filled or
    //     timeout. Extended timeout (15s vs old 10s) to handle slow networks.
    //  C) getPosition() fallback: If poll times out with no fill data, ask the
    //     exchange for the *position* (not the order). On perp exchanges a
    //     successfully-opened position IS the proof of fill; its size and
    //     entry price are reliable even when getOrder() lags.
    //
    // After all three layers, if executedQty is still 0 we use computedVolume
    // as a last-resort quantity so SL/TP can be placed on the exchange. The
    // protection order itself being "reduce-only" ensures it can't add new
    // risk; the reconcile cycle will correct the stored qty on next tick.
    const inlineFillQty   = parseFloat(String(orderResult.filledQty  ?? orderResult.executedQty ?? orderResult.cumQty   ?? "0")) || 0
    const inlineFillPrice = parseFloat(String(orderResult.filledPrice ?? orderResult.avgPrice   ?? orderResult.price    ?? "0")) || 0
    const inlineStatus    = String(orderResult.status ?? "").toLowerCase()
    const inlineFilled    = (inlineStatus === "filled" || inlineFillQty >= computedVolume * 0.99) && inlineFillQty > 0

    let fill: { filled: boolean; filledQty: number; filledPrice: number; status: string }

    if (inlineFilled) {
      // A) placeOrder response already contains fill confirmation — skip poll.
      fill = { filled: true, filledQty: inlineFillQty, filledPrice: inlineFillPrice, status: "filled" }
      console.log(`${LOG_PREFIX} Inline fill detected for ${realPosition.symbol}: qty=${inlineFillQty} @ ${inlineFillPrice}`)
    } else if (livePosition.orderId) {
      // B) Standard poll path — only when we have a confirmed orderId.
      fill = await pollOrderFill(exchangeConnector, realPosition.symbol, livePosition.orderId)
    } else {
      // No orderId from placeOrder response — skip polling entirely and
      // fall through to the getPosition() fallback (layer C below).
      fill = { filled: false, filledQty: 0, filledPrice: 0, status: "pending" }
      console.warn(`${LOG_PREFIX} No orderId from placeOrder for ${realPosition.symbol} — skipping poll, using getPosition() fallback`)
    }

    // C) getPosition() fallback when poll timed out without fill data.
    //
    // Exchange position registries are usually a few hundred ms behind
    // order acknowledgements (orders go through the matching engine, then
    // get persisted to the position service via internal pub/sub). A
    // single getPosition() that comes back empty is therefore not
    // conclusive proof the order didn't fill — it might just be the
    // registry being slow. We try up to 3 times with 250 ms gaps before
    // giving up and dropping to the computedVolume guard, which trades
    // ~500 ms of additional confirmation latency for much higher accuracy
    // of SL/TP sizing on slow-confirming venues.
    if (!fill.filled || fill.filledQty <= 0) {
      if (typeof exchangeConnector.getPosition === "function") {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            // Pass direction so hedge-mode connectors return the correct
            // LONG vs SHORT slot rather than whichever is first in the array.
            const exPos = await exchangeConnector.getPosition(
              realPosition.symbol,
              realPosition.direction as "long" | "short",
            )
            // BingX v3 perpetual: qty is in `positionAmt`; normalised output
            // also exposes `contracts` and `size` aliases (set in getPositions).
            const exSize = parseFloat(String(exPos?.positionAmt ?? exPos?.contracts ?? exPos?.size ?? exPos?.quantity ?? "0")) || 0
            const exEntry = parseFloat(String(exPos?.entryPrice ?? exPos?.avgPrice ?? exPos?.averagePrice ?? "0")) || 0
            if (Math.abs(exSize) > 0) {
              console.log(`${LOG_PREFIX} getPosition() fallback fill for ${realPosition.symbol}: size=${exSize} entry=${exEntry} (attempt=${attempt + 1})`)
              fill = {
                filled: true,
                filledQty: Math.abs(exSize),
                filledPrice: exEntry || currentPrice,
                status: "filled_via_position",
              }
              break
            }
          } catch {
            /* transient error — counts as one attempt, fall through to retry */
          }
          // Gap before the next probe — short enough that total worst-case
          // is ~500 ms, long enough for the registry to catch up.
          if (attempt < 2) await new Promise(r => setTimeout(r, 250))
        }
      }
    }

    if (fill.filled && fill.filledQty > 0) {
      livePosition.executedQuantity = fill.filledQty
      livePosition.remainingQuantity = Math.max(0, computedVolume - fill.filledQty)
      livePosition.averageExecutionPrice = fill.filledPrice || currentPrice
      livePosition.initialExecutedQuantity ??= fill.filledQty
      livePosition.totalExecutedQuantity = Math.max(
        Number(livePosition.totalExecutedQuantity || 0),
        fill.filledQty,
      )
      livePosition.initialEntryPrice ??= fill.filledPrice || currentPrice
      livePosition.blockBaseQuantity ??= fill.filledQty
      if (livePosition.combinedPosCounts) {
        livePosition.posCountsSetQuantities = allocatePositionSetQuantities(
          livePosition,
          fill.filledQty,
          livePosition.accumulatedSetKeys,
        )
      }
      livePosition.fills!.push({
        timestamp: Date.now(),
        quantity: fill.filledQty,
        price: fill.filledPrice || currentPrice,
        fee: 0,
        feeAsset: "USDT",
      })
      livePosition.status = livePosition.remainingQuantity <= 0.000001 ? "filled" : "partially_filled"
      livePosition.statusReason = fill.status === "filled_via_position"
        ? `confirmed_position_fallback: exchange position size=${fill.filledQty} avg=${fill.filledPrice || currentPrice}`
        : `confirmed_fill: order fill status=${fill.status} qty=${fill.filledQty}`
      pushStep(livePosition, "poll_fill", true, `filled=${fill.filledQty} @ ${fill.filledPrice} via=${fill.status} reason=${livePosition.statusReason}`)
      await recordFillCountersOnce(connectionId, livePosition, realPosition.symbol, realPosition.direction)
      await logProgressionEvent(connectionId, "live_trading", "info", `Entry filled for ${realPosition.symbol}`, {
        orderId: livePosition.orderId,
        filledQty: fill.filledQty,
        filledPrice: fill.filledPrice,
        via: fill.status,
      })
      await logLiveOrderFinal(orderTrace, {
        status: "filled",
        livePositionId: livePosition.id,
        executedQuantity: fill.filledQty,
        averagePrice: fill.filledPrice || currentPrice,
        reason: `fill via=${fill.status}`,
        extra: { orderId: livePosition.orderId, attempts: placeAttempt },
      })
      // Arm SL/TP immediately after an authoritative inline/polled fill.
      // A fixed venue-settling sleep delayed every healthy order by two
      // seconds and left the freshly opened position unnecessarily
      // unprotected. BingX's eventual-consistency case is already handled
      // narrowly by the 109420 retry in placeProtectionOrder, so fast fills
      // stay on the sub-second path while lagging symbols still self-heal.
    } else {
      // D) Protection-deferred guard: if neither order polling nor direct
      // exchange-position reads confirm a position size, do NOT synthesize a
      // fill from computedVolume. Persist an unconfirmed status and let
      // reconcile arm SL/TP immediately once the venue position appears.
      const deferredStatus: LivePosition["status"] = livePosition.orderId ? "pending_fill" : "placed_unconfirmed"
      livePosition.executedQuantity = 0
      livePosition.remainingQuantity = computedVolume
      livePosition.averageExecutionPrice = 0
      livePosition.status = deferredStatus
      livePosition.statusReason =
        `protection_deferred: fill unconfirmed after pollStatus=${fill.status}; direct position lookup found no size`
      pushStep(livePosition, "poll_fill", false, livePosition.statusReason)
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "warning",
        `Entry fill unconfirmed for ${realPosition.symbol} — SL/TP deferred until exchange position appears`,
        { orderId: livePosition.orderId, status: fill.status, requestedQty: computedVolume, savedStatus: deferredStatus }
      )
      await savePosition(livePosition)
      await logLiveOrderFinal(orderTrace, {
        status: "placed",
        livePositionId: livePosition.id,
        executedQuantity: 0,
        averagePrice: 0,
        reason: livePosition.statusReason,
        extra: { orderId: livePosition.orderId, attempts: placeAttempt, requestedQty: computedVolume },
      })
    }

    // ── Step 7: Place Stop Loss and Take Profit orders ─��───────────────────
    //
    // Single source of truth for SL/TP price derivation:
    // `computeDesiredProtectionPrices()` is also what the accumulation
    // and reconcile paths use. By routing the initial placement through
    // the same helper we guarantee that an exchange-side order will
    // ALWAYS be armed at the same price the strategy assigned (rounded
    // identically), with no duplicate inline computation that could
    // drift out of sync with the rest of the file.
    if (livePosition.executedQuantity > 0) {
      if (typeof exchangeConnector.getPosition === "function") {
        try {
          // Pass direction so hedge-mode accounts return the correct slot.
          const exPos = await exchangeConnector.getPosition(
            realPosition.symbol,
            realPosition.direction as "long" | "short",
          )
          if (exPos) {
            livePosition.exchangeData = {
              ...(livePosition.exchangeData || {}),
              marginType: (exPos as any).marginType,
              markPrice: (exPos as any).markPrice,
              liquidationPrice: (exPos as any).liquidationPrice,
              unrealizedPnl: (exPos as any).unrealizedPnl,
              roi: (exPos as any).roi,
            }
          }
        } catch (err) {
          console.warn(
            `${LOG_PREFIX} pre-protection mark sync failed for ${realPosition.symbol}:`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }

      const sideClose: "buy" | "sell" = realPosition.direction === "long" ? "sell" : "buy"
      const { desiredSl: slPrice, desiredTp: tpPrice } =
        computeDesiredProtectionPrices(livePosition)

      if (await closeIfProtectionTriggerAlreadyCrossed(exchangeConnector, livePosition, slPrice, tpPrice, "initial_placement")) {
        return livePosition
      }
      // Duplicate-prevention is handled inside the Promise.all below:
      // each leg resolves to the existing orderId when an order is already
      // present (`!livePosition.stopLossOrderId` guard on the ternary),
      // so no separate guard block is needed here.

      // DO NOT pre-stamp the desired prices onto livePosition before the
      // exchange confirms placement. The original code set
      //   livePosition.stopLossPrice = slPrice
      //   livePosition.takeProfitPrice = tpPrice
      // BEFORE awaiting the placement promises. When a placement failed
      // the recorded price still equaled the desired price, so
      // `priceDrifted(stored, desired)` returned false on the next
      // reconcile tick and the loop never retried the failed leg —
      // leaving the live position exposed without protection until the
      // operator's price moved >0.25%, sometimes for the lifetime of
      // the trade.
      //
      // The new contract: stored price is the LAST CONFIRMED armed price
      // for that leg. A failed placement leaves it at 0, which
      // `priceDrifted(0, desired)` correctly classifies as "needs arming"
      // on the next reconcile pass.
      // Arm SL and TP concurrently. The BingX connector now uses the official
      // SDK for conditional orders first and keeps the venue-specific retry
      // logic inside `placeProtectionOrder`, so adding a fixed 500ms gap here
      // only leaves a fresh live position exposed longer than necessary.
      const slClientOrderId = slPrice > 0 && !livePosition.stopLossOrderId
        ? await prepareProtectionSubmission(livePosition, "stopLoss", slPrice, livePosition.executedQuantity)
        : undefined
      const tpClientOrderId = tpPrice > 0 && !livePosition.takeProfitOrderId
        ? await prepareProtectionSubmission(livePosition, "takeProfit", tpPrice, livePosition.executedQuantity)
        : undefined
      const [slOrderId, tpOrderId] = await Promise.all([
        (slPrice > 0 && !livePosition.stopLossOrderId)
          ? placeProtectionOrder(
              exchangeConnector,
              realPosition.symbol,
              sideClose,
              livePosition.executedQuantity,
              slPrice,
              "StopLoss",
              realPosition.direction,
              slClientOrderId,
            )
          : Promise.resolve(livePosition.stopLossOrderId || null),
        (tpPrice > 0 && !livePosition.takeProfitOrderId)
          ? placeProtectionOrder(
              exchangeConnector,
              realPosition.symbol,
              sideClose,
              livePosition.executedQuantity,
              tpPrice,
              "TakeProfit",
              realPosition.direction,
              tpClientOrderId,
            )
          : Promise.resolve(livePosition.takeProfitOrderId || null),
      ])

      // "PRICE_CROSSED" sentinel: market moved past the protection price between
      // calculation and placement (BingX 110412/110413). Force-close immediately
      // rather than waiting up to one full reconcile tick with no protection.
      if (slOrderId === "PRICE_CROSSED" || tpOrderId === "PRICE_CROSSED") {
        const crossedLeg = slOrderId === "PRICE_CROSSED" ? "StopLoss" : "TakeProfit"
        console.warn(
          `${LOG_PREFIX} ${crossedLeg} PRICE_CROSSED for ${realPosition.symbol} — triggering immediate force-close`,
        )
        livePosition.closeReason = "protection_price_crossed_at_placement"
        const closeResult = await closeLivePosition(
          connectionId,
          livePosition.id,
          0,
          exchangeConnector,
          `${crossedLeg} price crossed market at initial placement`,
        )
        if (closeResult) Object.assign(livePosition, closeResult)
        return livePosition
      }

      // "QUOTA_EXCEEDED" sentinel: account TP/SL order limit reached (BingX 110206).
      // Mark the connection as quota-blocked so reconcile backs off for 60 s.
      // Leave orderId/price at 0 — the position is live without protection.
      if (slOrderId === "QUOTA_EXCEEDED" || tpOrderId === "QUOTA_EXCEEDED") {
        markProtectionQuotaExhausted(connectionId)
      }

      const slIdValid = slOrderId && slOrderId !== "PRICE_CROSSED" && slOrderId !== "position_exhausted" && slOrderId !== "QUOTA_EXCEEDED"
      const tpIdValid = tpOrderId && tpOrderId !== "PRICE_CROSSED" && tpOrderId !== "position_exhausted" && tpOrderId !== "QUOTA_EXCEEDED"

      if (slIdValid) {
        livePosition.stopLossOrderId = slOrderId!
        livePosition.stopLossPrice = slPrice
        if (livePosition.pendingProtectionOrders) delete livePosition.pendingProtectionOrders.stopLoss
      } else if (slPrice > 0 && slOrderId !== "QUOTA_EXCEEDED") {
        // Surface the protection gap loudly so operators and the
        // dashboard see it; the next reconcile will retry.
        console.error(
          `${LOG_PREFIX} INITIAL StopLoss placement FAILED for ${realPosition.symbol} — position is LIVE without SL until next reconcile tick`,
        )
        await logProgressionEvent(
          connectionId,
          "live_trading",
          "error",
          `StopLoss NOT placed for ${realPosition.symbol} — reconcile will retry`,
          { livePositionId: livePosition.id, desiredSl: slPrice, executedQty: livePosition.executedQuantity },
        )
        pushStep(livePosition, "place_stop_loss", false, `initial SL placement failed @ ${slPrice}`)
      }
      if (tpIdValid) {
        livePosition.takeProfitOrderId = tpOrderId!
        livePosition.takeProfitPrice = tpPrice
        if (livePosition.pendingProtectionOrders) delete livePosition.pendingProtectionOrders.takeProfit
      } else if (tpPrice > 0 && tpOrderId !== "QUOTA_EXCEEDED") {
        console.error(
          `${LOG_PREFIX} INITIAL TakeProfit placement FAILED for ${realPosition.symbol} — position is LIVE without TP until next reconcile tick`,
        )
        await logProgressionEvent(
          connectionId,
          "live_trading",
          "error",
          `TakeProfit NOT placed for ${realPosition.symbol} — reconcile will retry`,
          { livePositionId: livePosition.id, desiredTp: tpPrice, executedQty: livePosition.executedQuantity },
        )
        pushStep(livePosition, "place_take_profit", false, `initial TP placement failed @ ${tpPrice}`)
      }
      // Record the qty SL/TP were armed for so the next reconcile
      // pass can detect quantity drift (delayed partial fills,
      // accumulation merges) and re-arm. Without this the drift
      // detector in `updateProtectionOrders` would see an undefined
      // baseline and re-arm on every cycle even when nothing changed.
      //
      // Only set when at least one leg succeeded — otherwise the next
      // reconcile would treat the position as "armed for current qty"
      // and never retry the failed legs because qtyDrifted is false.
      if (slOrderId || tpOrderId) {
        livePosition.protectionArmedQuantity = livePosition.executedQuantity
        // Prime the cooldown so the first 30 s of reconcile ticks cannot
        // drift-cancel-replace orders we just placed milliseconds ago.
        const nowMs = Date.now()
        if (slOrderId) livePosition.stopLossLastArmedAt = nowMs
        if (tpOrderId) livePosition.takeProfitLastArmedAt = nowMs
      }

      // Step record + progression log carry BOTH the assigned percent
      // and the resulting absolute trigger price, so an operator
      // reading the timeline never has to mentally reconstruct one
      // from the other. `assignedStopLoss`/`assignedTakeProfit` and
      // `stopLoss`/`takeProfit` are equal at this point (initial
      // placement); on later overrides the message will show both.
      pushStep(
        livePosition,
        "place_sl_tp",
        !!(slOrderId || tpOrderId),
        `SL ${livePosition.stopLoss}% → ${slPrice ? slPrice.toFixed(6) : "—"} (${slOrderId || "—"}) | ` +
        `TP ${livePosition.takeProfit}% → ${tpPrice ? tpPrice.toFixed(6) : "—"} (${tpOrderId || "—"})`
      )
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "info",
        `SL/TP placed for ${realPosition.symbol} at assigned values`,
        {
          // Assigned (immutable strategy contract) and current
          // (mutable, override-aware) percent pairs — equal on first
          // placement, can diverge after `recalculateAndApplySLTP`.
          assignedStopLossPct: livePosition.assignedStopLoss,
          assignedTakeProfitPct: livePosition.assignedTakeProfit,
          stopLossPct: livePosition.stopLoss,
          takeProfitPct: livePosition.takeProfit,
          slOrderId,
          slPrice,
          tpOrderId,
          tpPrice,
          fillPrice: livePosition.averageExecutionPrice,
        },
      )
    } else {
      pushStep(livePosition, "place_sl_tp", false, "skipped — no fill yet")
    }

    // ── Step 8: Sync with exchange for position data ──────────────���────────
    if (typeof exchangeConnector.getPosition === "function") {
      try {
        // Pass direction for hedge-mode accounts.
        const exPos = await exchangeConnector.getPosition(
          realPosition.symbol,
          realPosition.direction as "long" | "short",
        )
        if (exPos) {
          livePosition.exchangeData = {
            marginType: (exPos as any).marginType,
            markPrice: (exPos as any).markPrice,
            liquidationPrice: (exPos as any).liquidationPrice,
            unrealizedPnl: (exPos as any).unrealizedPnl,
            roi: (exPos as any).roi,
          }
          pushStep(
            livePosition,
            "exchange_sync",
            true,
            `liqPrice=${(exPos as any).liquidationPrice} markPrice=${(exPos as any).markPrice}`
          )
        } else {
          pushStep(livePosition, "exchange_sync", false, "no position returned")
        }
      } catch (err) {
        pushStep(livePosition, "exchange_sync", false, String(err))
      }
    }

    if (livePosition.status === "filled") livePosition.status = "open"

    // ── ENTRY SUMMARY — one log line showing the complete entry state ────────
    // Operator can grep "[ENTRY]" to see every live position that went through
    // the full pipeline and understand volume / leverage / protection in context.
    {
      const { desiredSl: sumSl, desiredTp: sumTp } = computeDesiredProtectionPrices(livePosition)
      console.log(
        `${LOG_PREFIX} [ENTRY] ${realPosition.symbol} ${realPosition.direction?.toUpperCase()} ` +
        `qty=${livePosition.executedQuantity?.toFixed(6) ?? "?"} ` +
        `@ ${livePosition.averageExecutionPrice?.toFixed(6) ?? "?"} ` +
        `notional=$${livePosition.volumeUsd?.toFixed(2) ?? "?"} ` +
        `lev=${livePosition.leverage ?? "?"}x ` +
        `orderId=${livePosition.orderId ?? "?"} ` +
        `SL=${sumSl > 0 ? sumSl.toFixed(6) : "none"} (id=${livePosition.stopLossOrderId ?? "—"}) ` +
        `TP=${sumTp > 0 ? sumTp.toFixed(6) : "none"} (id=${livePosition.takeProfitOrderId ?? "—"}) ` +
        `status=${livePosition.status}`
      )
    }

    await savePosition(livePosition)

    // Only count this as a real "position created" when the entry
    // order actually filled on the exchange. Previously we bumped this
    // counter unconditionally — including when pollOrderFill timed
    // out — which caused the dashboard to show ghost positions
    // (`Positions Created` > zero with `Orders Filled` still 0). The
    // user explicitly reported this asymmetry. Use executedQuantity as
    // the source of truth: it's only set once the fill is confirmed
    // (line 1450) or sync-confirmed (executeLivePosition exchange
    // sync block above).
    const hasRealFill = (livePosition.executedQuantity || 0) > 0
    if (hasRealFill) {
      await incrementMetric(connectionId, "live_positions_created_count")
      await incrementMetric(connectionId, "live_volume_usd_total", Math.round(livePosition.volumeUsd))
      // Used-balance (margin) cumulative counter — track in CENTS so
      // small margins (e.g. $5 notional / 125x leverage = $0.04)
      // survive integer rounding. Reader divides by 100 to display USD.
      // The legacy `live_margin_usd_total` counter is no longer
      // written: rounding any tiny margin to a whole dollar (or to 0)
      // produced a misleading number, and the stats reader now prefers
      // `live_margin_cents_total`.
      const lev = Math.max(1, Number(livePosition.leverage) || 1)
      const newMargin = (livePosition.volumeUsd || 0) / lev
      if (Number.isFinite(newMargin) && newMargin > 0) {
        await incrementMetric(connectionId, "live_margin_cents_total", Math.round(newMargin * 100))
      }
    }
    // ── CRITICAL FIX: Include full real position context in progression ──
    // This logs the complete lineage from real set → live execution,
    // allowing dashboards to trace back which strategy configuration
    // and axis window state produced this live position. Previously,
    // this context was lost after creation, breaking the "relay back to
    // original progress" link for ETH/SOL and other multi-set symbols.
    await logProgressionEvent(connectionId, "live_trading", "info", `Live position created ${realPosition.symbol}`, {
      livePositionId: livePosition.id,
      realPositionId: realPosition.id,
      status: livePosition.status,
      orderId: livePosition.orderId,
      executedQuantity: livePosition.executedQuantity,
      volumeUsd: livePosition.volumeUsd,
      // ── Real position context (critical for multi-symbol / multi-set debugging) ──
      realSetKey: realPosition.setKey,
      realParentSetKey: realPosition.parentSetKey,
      realSetVariant: realPosition.setVariant,
      realAxisWindows: realPosition.axisWindows,
      // ── Entry metrics ──
      leverage: realPosition.leverage,
      quantity: realPosition.quantity,
      direction: realPosition.direction,
    })

    return livePosition
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const errStack = err instanceof Error ? err.stack : undefined
    console.error(`${LOG_PREFIX} Unhandled error:`, errMsg, errStack || "")
    livePosition.status = "error"
    livePosition.statusReason = errMsg
    pushStep(livePosition, "unhandled_error", false, errMsg)
    await savePosition(livePosition)
    await incrementMetric(connectionId, "live_orders_failed_count")
    await incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "failed")
    await logProgressionEvent(
      connectionId,
      "live_trading",
      "error",
      `Live pipeline unhandled error for ${realPosition.symbol}`,
      { error: errMsg, stack: errStack }
    )

    // Surface unhandled live-pipeline failures into the systemwide log too,
    // not just the per-connection progression view.
    try {
      await SystemLogger.logError(
        err instanceof Error ? err : new Error(errMsg),
        connectionId,
        `live-stage.executeLivePosition[${realPosition.symbol}/${realPosition.direction}]`,
      )
    } catch {
      /* logging must never throw */
    }
    if (liveOrderLockToken) await releaseLock(connectionId, realPosition.symbol, realPosition.direction + _lockDirSuffix, liveOrderLockToken).catch(() => {})
    return livePosition
  }
}

/**
 * Update live position with order fills (used by webhooks / syncs).
 */
export async function updateLivePositionFill(
  connectionId: string,
  livePositionId: string,
  fill: LivePosition["fills"][0]
): Promise<LivePosition | null> {
  await initRedis()
  const client = getRedisClient()

  try {
    const key = `live:position:${livePositionId}`
    const data = await client.get(key)
    if (!data) return null

    const position: LivePosition = JSON.parse(data as string)
    position.fills!.push(fill)
    position.executedQuantity += fill.quantity
    position.remainingQuantity = position.quantity! - position.executedQuantity

    const totalCost = position.fills!.reduce((sum, f) => sum + f.price * f.quantity, 0)
    position.averageExecutionPrice = totalCost / position.executedQuantity

    if (position.remainingQuantity <= 0) {
      position.status = "filled"
    } else if (position.executedQuantity > 0) {
      position.status = "partially_filled"
    }
    position.updatedAt = Date.now()

    await client.setex(key, 604800, JSON.stringify(position))
    await client.lpush(`live:positions:${position.connectionId}`, position.id)
    await client.ltrim(`live:positions:${position.connectionId}`, 0, 999)
    await client.expire(`live:positions:${position.connectionId}`, 604800)
    return position
  } catch (err) {
    console.error(`${LOG_PREFIX} Error updating fill:`, err)
    return null
  }
}

type ControlBarrierOutcome = {
  decision: "wait" | "proceed_system" | "exchange_closed"
  authoritativeQuantity?: number
  detail: string
}

function controlOrderStatus(order: any): string {
  return String(order?.status ?? order?.orderStatus ?? order?.state ?? "unknown").toLowerCase()
}

function controlOrderFilledQuantity(order: any): number {
  const value = Number(
    order?.filledQty ?? order?.executedQty ?? order?.cumQty ??
    order?.filledQuantity ?? order?.executedQuantity ?? 0,
  )
  return Number.isFinite(value) && value > 0 ? value : 0
}

function controlOrderFillPrice(order: any, fallback: number): number {
  const value = Number(order?.filledPrice ?? order?.avgPrice ?? order?.averagePrice ?? order?.price ?? fallback)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Serialize venue control orders and a system close.
 *
 * A trigger order may fill between any two HTTP calls. Therefore an unknown,
 * open, partially-filled, or response-lost control order always wins the
 * current cycle. The system close is permitted only after the control order
 * has either changed the authoritative position or its cancellation is
 * confirmed absent from an authoritative open-order snapshot.
 */
async function settleControlOrdersBeforeSystemClose(
  connector: any,
  position: LivePosition,
  closeReason: string,
  fallbackPrice: number,
): Promise<ControlBarrierOutcome> {
  const action = position.pendingSystemAction || {
    token: `system-close:${position.id}:${nanoid(8)}`,
    reason: closeReason,
    phase: "control_wait" as const,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  action.reason = closeReason
  action.updatedAt = Date.now()
  position.pendingSystemAction = action

  if (position.pendingReduction || position.pendingAccumulation || position.pendingQuantityMutation) {
    return {
      decision: "wait",
      detail: `partial coordination still active (${position.pendingReduction
        ? "reduction"
        : position.pendingAccumulation
          ? "accumulation"
          : `quantity:${position.pendingQuantityMutation?.phase}`})`,
    }
  }

  const direction: "long" | "short" = position.direction === "short" ? "short" : "long"
  const initialQuantity = Math.max(0, Number(position.executedQuantity || position.quantity || 0))
  const observations: Array<{ id: string; source: PartialOrderExecutionSource; order: any }> = []
  const unresolvedClientIds = new Set<string>()

  // First recover response-lost control submissions by their durable client id.
  for (const leg of ["stopLoss", "takeProfit"] as const) {
    const pending = position.pendingProtectionOrders?.[leg]
    if (!pending?.clientOrderId) continue
    const recovered = await recoverEntryOrderByClientId(connector, position.symbol, pending.clientOrderId)
    if (recovered) {
      const orderId = String(recovered.orderId ?? recovered.id)
      if (leg === "stopLoss") position.stopLossOrderId = orderId
      else position.takeProfitOrderId = orderId
      observations.push({ id: orderId, source: "control_order", order: recovered })
      delete position.pendingProtectionOrders?.[leg]
    } else {
      unresolvedClientIds.add(pending.clientOrderId)
    }
  }

  // A prior system-close submission is part of the same barrier. Reconcile it
  // before any new close can be emitted after a restart or partial fill.
  if (action.orderId && typeof connector?.getOrder === "function") {
    const order = await withTimeout(
      connector.getOrder(position.symbol, action.orderId) as Promise<any>,
      EXCHANGE_TIMEOUT_GET_ORDER_MS,
      `getOrder(system-close ${action.orderId})`,
    ).catch(() => null)
    if (order) observations.push({ id: action.orderId, source: "system_close", order })
  } else if (action.clientOrderId && action.phase !== "control_wait") {
    const recovered = await recoverEntryOrderByClientId(connector, position.symbol, action.clientOrderId)
    if (recovered) {
      action.orderId = String(recovered.orderId ?? recovered.id)
      observations.push({ id: action.orderId, source: "system_close", order: recovered })
    } else {
      unresolvedClientIds.add(action.clientOrderId)
    }
  }

  const trackedControlIds = Array.from(new Set(
    [position.stopLossOrderId, position.takeProfitOrderId].map(String).filter((id) => id && id !== "undefined"),
  ))
  for (const orderId of trackedControlIds) {
    if (observations.some((item) => item.id === orderId)) continue
    if (typeof connector?.getOrder !== "function") continue
    const order = await withTimeout(
      connector.getOrder(position.symbol, orderId) as Promise<any>,
      EXCHANGE_TIMEOUT_GET_ORDER_MS,
      `getOrder(control ${orderId})`,
    ).catch(() => null)
    if (order) observations.push({ id: orderId, source: "control_order", order })
  }

  let authoritative = await fetchAuthoritativeOpenQuantity(connector, position.symbol, direction)
  const quantityChanged = authoritative.ok && authoritative.quantity < initialQuantity - Math.max(1e-12, initialQuantity * 1e-8)
  const filledObservation = observations
    .filter((item) => controlOrderFilledQuantity(item.order) > 0 || isFilledControlOrderStatus(controlOrderStatus(item.order)))
    .sort((a, b) => controlOrderFilledQuantity(b.order) - controlOrderFilledQuantity(a.order))[0]

  if (filledObservation || quantityChanged) {
    const executionId = filledObservation
      ? `${position.id}:${filledObservation.source}:${filledObservation.id}`
      : `${position.id}:control-authority:${action.token}`
    const existing = position.partialOrderExecutions?.find((entry) => entry.id === executionId)
    const observedOrder = filledObservation?.order
    const applied = applyReductionObservation(position, {
      executionId,
      source: filledObservation?.source || "control_order",
      status: controlOrderStatus(observedOrder || { status: authoritative.quantity <= 0 ? "filled" : "partially_filled" }),
      requestedQuantity: filledObservation?.source === "system_close"
        ? Number(action.requestedQuantity || initialQuantity)
        : initialQuantity,
      reportedFilledQuantity: controlOrderFilledQuantity(observedOrder),
      previouslyAppliedQuantity: Number(existing?.cumulativeFilledQuantity || action.appliedFilledQuantity || 0),
      authoritativeQuantity: authoritative.ok ? authoritative.quantity : null,
      price: controlOrderFillPrice(observedOrder, fallbackPrice),
      orderId: filledObservation?.id,
      clientOrderId: filledObservation?.source === "system_close" ? action.clientOrderId : undefined,
    })
    if (filledObservation?.source === "system_close") action.appliedFilledQuantity = applied.cumulativeApplied
  }

  if (authoritative.ok && authoritative.quantity <= Math.max(1e-12, initialQuantity * 1e-8)) {
    return { decision: "exchange_closed", authoritativeQuantity: 0, detail: "authoritative exchange quantity is zero" }
  }

  const activeControlIds = observations
    .filter((item) => item.source === "control_order" && isActiveControlOrderStatus(controlOrderStatus(item.order)))
    .map((item) => item.id)
  const systemObservation = observations.find((item) => item.source === "system_close")
  if (systemObservation && isActiveControlOrderStatus(controlOrderStatus(systemObservation.order))) {
    return {
      decision: "wait",
      authoritativeQuantity: authoritative.ok ? authoritative.quantity : undefined,
      detail: `system close order ${systemObservation.id} is still ${controlOrderStatus(systemObservation.order)}`,
    }
  }
  if (systemObservation && !isActiveControlOrderStatus(controlOrderStatus(systemObservation.order))) {
    action.orderId = undefined
    action.clientOrderId = undefined
    action.requestedQuantity = undefined
    action.appliedFilledQuantity = undefined
  }
  const unknownTrackedIds = trackedControlIds.filter((id) => !observations.some((item) => item.id === id))
  action.controlOrderIds = Array.from(new Set([...trackedControlIds, ...unresolvedClientIds]))

  const triggerDriven = /(^|_)(sl|tp|stop|take|trailing)|price_cross/i.test(closeReason)
  const CONTROL_EFFECT_GRACE_MS = 10_000
  if (triggerDriven && activeControlIds.length > 0 && Date.now() - action.startedAt < CONTROL_EFFECT_GRACE_MS) {
    return { decision: "wait", authoritativeQuantity: authoritative.ok ? authoritative.quantity : undefined, detail: "trigger control order still active within effect grace" }
  }

  // Cancel only system-owned, known control IDs. Cancellation is sequential
  // with the system submission and must be confirmed before proceeding.
  const idsToCancel = Array.from(new Set([...activeControlIds, ...unknownTrackedIds]))
  for (const orderId of idsToCancel) {
    const cancelled = await cancelProtectionOrder(
      connector,
      position.symbol,
      orderId,
      "SystemCloseBarrier",
      position.connectionId,
    )
    if (!cancelled) {
      return { decision: "wait", authoritativeQuantity: authoritative.ok ? authoritative.quantity : undefined, detail: `control order ${orderId} not confirmed cancelled` }
    }
  }

  const liveOrderIds = await fetchLiveOrderIdSet(connector)
  if (typeof connector?.getOpenOrders === "function" && liveOrderIds === null && (trackedControlIds.length > 0 || unresolvedClientIds.size > 0)) {
    return { decision: "wait", authoritativeQuantity: authoritative.ok ? authoritative.quantity : undefined, detail: "authoritative open-order snapshot unavailable" }
  }
  const stillVisible = action.controlOrderIds.filter((id) => liveOrderIds?.has(id))
  if (stillVisible.length > 0) {
    return { decision: "wait", authoritativeQuantity: authoritative.ok ? authoritative.quantity : undefined, detail: `control orders still visible: ${stillVisible.join(",")}` }
  }

  if (unresolvedClientIds.size > 0) {
    action.absenceConfirmations = Number(action.absenceConfirmations || 0) + 1
    if (action.absenceConfirmations < 2) {
      return { decision: "wait", authoritativeQuantity: authoritative.ok ? authoritative.quantity : undefined, detail: "response-lost control submission requires second absence confirmation" }
    }
    for (const leg of ["stopLoss", "takeProfit"] as const) {
      const pending = position.pendingProtectionOrders?.[leg]
      if (pending && unresolvedClientIds.has(pending.clientOrderId)) delete position.pendingProtectionOrders?.[leg]
    }
    if (action.clientOrderId && unresolvedClientIds.has(action.clientOrderId)) {
      // Two authoritative order-absence observations plus a still-open
      // position prove that the previous prepared submission never became an
      // exchange order. A new durable id may now be prepared safely.
      action.clientOrderId = undefined
      action.orderId = undefined
      action.requestedQuantity = undefined
      action.appliedFilledQuantity = undefined
    }
  }

  if (!liveOrderIds || !position.stopLossOrderId || !liveOrderIds.has(position.stopLossOrderId)) {
    position.stopLossOrderId = undefined
    position.stopLossPrice = 0
  }
  if (!liveOrderIds || !position.takeProfitOrderId || !liveOrderIds.has(position.takeProfitOrderId)) {
    position.takeProfitOrderId = undefined
    position.takeProfitPrice = 0
  }

  authoritative = await fetchAuthoritativeOpenQuantity(connector, position.symbol, direction)
  const decision = decideControlOrderBarrier({
    localQuantity: Number(position.executedQuantity || 0),
    authoritativeQuantity: authoritative.ok ? authoritative.quantity : null,
    authoritativeSnapshot: authoritative.ok,
    activeControlOrders: 0,
    unresolvedControlOrders: 0,
    pendingSubmissions: 0,
  })
  if (!authoritative.ok && typeof connector?.getPosition === "function") {
    return { decision: "wait", detail: "authoritative position snapshot unavailable after control settlement" }
  }
  return {
    decision,
    authoritativeQuantity: authoritative.ok ? authoritative.quantity : undefined,
    detail: decision === "exchange_closed" ? "control order closed the position" : "all control activity settled",
  }
}

/** Confirm protection settlement before an independent position-size delta. */
async function settleControlOrdersBeforeQuantityMutation(
  connector: any,
  position: LivePosition,
  reason: string,
): Promise<boolean> {
  if (!connector) return true
  if (position.pendingSystemAction) {
    pushStep(position, "quantity_change_wait", true, `${reason}: system action is still coordinated`)
    return false
  }

  const quantityBefore = Math.max(0, Number(
    position.pendingQuantityMutation?.quantityBefore ?? position.executedQuantity ?? 0,
  ))
  const action = position.pendingQuantityMutation || {
    token: `quantity:${position.id}:${nanoid(8)}`,
    reason,
    phase: "control_cancel" as const,
    controlOrderIds: [],
    quantityBefore,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  }
  action.reason = reason
  action.updatedAt = Date.now()

  const ids = new Set<string>(action.controlOrderIds || [])
  if (position.stopLossOrderId) ids.add(String(position.stopLossOrderId))
  if (position.takeProfitOrderId) ids.add(String(position.takeProfitOrderId))
  const unresolved: Array<"stopLoss" | "takeProfit"> = []
  for (const leg of ["stopLoss", "takeProfit"] as const) {
    const pending = position.pendingProtectionOrders?.[leg]
    if (!pending?.clientOrderId) continue
    const recovered = await recoverEntryOrderByClientId(connector, position.symbol, pending.clientOrderId)
    if (recovered) {
      const orderId = String(recovered.orderId ?? recovered.id)
      ids.add(orderId)
      if (leg === "stopLoss") position.stopLossOrderId = orderId
      else position.takeProfitOrderId = orderId
      delete position.pendingProtectionOrders?.[leg]
    } else {
      unresolved.push(leg)
    }
  }
  action.controlOrderIds = [...ids]
  position.pendingQuantityMutation = action

  if (action.phase === "control_cancel") {
    for (const orderId of ids) {
      const cancelled = await cancelProtectionOrder(
        connector,
        position.symbol,
        orderId,
        `QuantityMutation-${reason}`,
        position.connectionId,
      )
      if (!cancelled) {
        pushStep(position, "quantity_change_wait", true, `${reason}: control ${orderId} cancellation unconfirmed`)
        return false
      }
    }
  }

  let liveOrderIds: Set<string> | null = new Set()
  if (ids.size > 0 || unresolved.length > 0) {
    liveOrderIds = await fetchLiveOrderIdSet(connector)
    if (typeof connector.getOpenOrders === "function" && liveOrderIds === null) {
      pushStep(position, "quantity_change_wait", true, `${reason}: open-order snapshot unavailable`)
      return false
    }
    const stillVisible = [...ids].filter((id) => liveOrderIds?.has(id))
    if (stillVisible.length > 0) {
      pushStep(position, "quantity_change_wait", true, `${reason}: controls still visible ${stillVisible.join(",")}`)
      return false
    }
  }

  for (const leg of unresolved) {
    const pending = position.pendingProtectionOrders?.[leg]
    if (!pending) continue
    if (liveOrderIds?.has(pending.clientOrderId)) {
      pushStep(position, "quantity_change_wait", true, `${reason}: pending ${leg} is visible by client id`)
      return false
    }
    pending.absenceConfirmations = Number(pending.absenceConfirmations || 0) + 1
    if (pending.absenceConfirmations < 2) {
      pushStep(position, "quantity_change_wait", true, `${reason}: pending ${leg} needs second absence confirmation`)
      return false
    }
    delete position.pendingProtectionOrders?.[leg]
  }

  action.phase = "position_verify"
  action.updatedAt = Date.now()
  position.pendingQuantityMutation = action

  const direction: "long" | "short" = position.direction === "short" ? "short" : "long"
  const authoritative = await fetchAuthoritativeOpenQuantity(connector, position.symbol, direction)
  if (!authoritative.ok) {
    pushStep(position, "quantity_change_wait", true, `${reason}: authoritative position snapshot unavailable`)
    return false
  }

  // Only now is it safe to forget the prior protection identifiers. A failed
  // position snapshot retains them in pendingQuantityMutation for the next
  // cycle, preventing a stale-size delta from slipping through.
  position.stopLossOrderId = undefined
  position.takeProfitOrderId = undefined
  position.stopLossPrice = 0
  position.takeProfitPrice = 0
  position.protectionArmedQuantity = 0

  const localQuantity = Math.max(0, Number(position.executedQuantity || 0))
  const tolerance = Math.max(1e-12, localQuantity * 1e-8)
  if (authoritative.quantity < localQuantity - tolerance) {
    const executionId = `${position.id}:${ids.size > 0 ? "quantity-control" : "quantity-sync"}:${[...ids].sort().join("+") || action.token}`
    const existing = position.partialOrderExecutions?.find((entry) => entry.id === executionId)
    applyReductionObservation(position, {
      executionId,
      source: ids.size > 0 ? "control_order" : "exchange_reconcile",
      status: authoritative.quantity <= 0 ? "filled" : "partially_filled",
      requestedQuantity: localQuantity,
      reportedFilledQuantity: 0,
      previouslyAppliedQuantity: Number(existing?.cumulativeFilledQuantity || 0),
      authoritativeQuantity: authoritative.quantity,
      price: Number(position.markPrice || position.averageExecutionPrice || position.entryPrice || 0),
    })
  } else if (authoritative.quantity > localQuantity + tolerance) {
    const added = authoritative.quantity - localQuantity
    position.executedQuantity = authoritative.quantity
    position.quantity = authoritative.quantity
    position.remainingQuantity = 0
    position.totalExecutedQuantity = Math.max(
      Number(position.totalExecutedQuantity || 0) + added,
      authoritative.quantity + Number(position.closedQuantity || 0),
    )
    position.volumeUsd = authoritative.quantity * Number(position.averageExecutionPrice || position.entryPrice || 0)
    if (position.combinedPosCounts) {
      position.posCountsSetQuantities = allocatePositionSetQuantities(
        position,
        authoritative.quantity,
        position.accumulatedSetKeys || [],
      )
    }
    pushStep(position, "quantity_exchange_sync", true, `${localQuantity} → ${authoritative.quantity} before ${reason}`)
  }

  position.pendingQuantityMutation = undefined
  if (authoritative.quantity <= 1e-12) {
    position.statusReason = `${reason}: control order closed position before quantity mutation`
    pushStep(position, "quantity_change_wait", true, position.statusReason)
    return false
  }
  pushStep(position, "quantity_control_barrier", true, `${reason}: controls settled; independent quantity delta may execute`)
  return true
}

/**
 * Close a live position (market exit) and release its dedup lock.
 *
 * Order of operations is critical to avoid orphan orders & leaked indices:
 *   1. Reconcile any active/partial SL/TP or durable partial action and wait
 *      until its effect or confirmed cancellation is authoritative.
 *   2. Persist one idempotent system-close intent, issue it only after that
 *      barrier, then verify the remaining exchange quantity. A failed,
 *      partial, or unconfirmed venue
 *      close rolls the local record back to its prior open state and re-arms
 *      protection; only authoritative success/already-gone confirmation may
 *      enter the terminal archive.
 *   3. Compute realized PnL + margin-based ROI (matches exchange ROE).
 *   4. Persist via savePosition() �� that helper already handles the
 *      open-index ���� closed-archive move idempotently. We do NOT touch
 *      Redis directly any more (which previously left the position in
 *      the open index forever on manual close).
 *   5. Release the dedup lock so a subsequent signal can re-enter.
 */
export async function closeLivePosition(
  connectionId: string,
  livePositionId: string,
  closePrice: number,
  exchangeConnector?: any,
  closeReason: string = "manual",
): Promise<LivePosition | null> {
  await initRedis()
  const client = getRedisClient()
  const lockId = `close:${closeReason}:${process.pid}:${Date.now()}:${nanoid(8)}`
  let mutationLockHeld = false
  let stopPositionLockLeaseRefresh: (() => void) | null = null

  try {
    const position = await readLivePositionSnapshot(client, connectionId, livePositionId)
    if (!position) return null
    const originalStatus = position.status

    const locked = await acquirePositionMutationLock(connectionId, livePositionId, lockId)
    if (!locked) return null
    mutationLockHeld = true
    stopPositionLockLeaseRefresh = startRedisLockLeaseRefresh(
      client,
      positionMutationLockKey(connectionId, livePositionId),
      lockId,
      POSITION_MUTATION_LOCK_TTL_MS,
    )
    const transitioned = await mutatePositionWithVersionCheck(position, ["open", "filled", "partially_filled", "placed", "pending_fill", "placed_unconfirmed", "simulated", "closing", "closing_partial"], draft => {
      draft.status = "closing"
      draft.lockedAt = Date.now()
      draft.lockedBy = lockId
    })
    if (!transitioned) {
      await releasePositionMutationLock(connectionId, livePositionId, lockId).catch(() => false)
      return null
    }
    Object.assign(position, transitioned)
    // Mirror the atomic hash transition into the JSON/index snapshot and, for
    // Inline Redis, flush it to disk before cancellation/close requests leave
    // the process. A restart can now distinguish and reconcile an interrupted
    // close instead of resurrecting the prior open snapshot.
    await savePosition(position)
    await persistCriticalLiveState(`close:${position.id}`)

    // ── Ownership guard ──────────────────────────────────��─────────────
    // Derived FIRST — before building any cancellation promises — so we
    // can gate the SL/TP cancel on ownership. Without this gate, a position
    // adopted/reconciled from the exchange (no system orderId) would have
    // its operator-placed protection orders cancelled while the close call
    // itself is correctly skipped, leaving the position on the exchange
    // completely unprotected.
    //
    // Only issue exchange calls when the system has a verified orderId —
    // proof that WE placed the entry order. Without an orderId the position
    // was simulated, the entry order failed silently, or the slot was
    // allocated but never confirmed.
    //
    // Fallback: if `orderId` is missing but `exchangePositionId` exists
    // (reconciled/adopted position), use it to close via exchange-side
    // position ID. Without EITHER, skip all exchange operations.
    const hasSystemOrderId = !!(position.orderId || position.exchangeData?.exchangePositionId)

    const hadSlId = !!position.stopLossOrderId
    const hadTpId = !!position.takeProfitOrderId

    // Settle control orders before a system action. This is intentionally
    // sequential: an exchange SL/TP or partial coordination always gets an
    // authoritative cycle to take effect before any program close is sent.
    if (exchangeConnector && hasSystemOrderId) {
      const barrier = await settleControlOrdersBeforeSystemClose(
        exchangeConnector,
        position,
        closeReason,
        closePrice,
      )
      pushStep(position, "control_order_barrier", barrier.decision !== "wait", barrier.detail)
      await savePosition(position)
      await persistCriticalLiveState(`control-barrier:${position.id}`)

      if (barrier.decision === "wait") {
        const rollbackStatus: LivePosition["status"] = originalStatus && originalStatus !== "closing"
          ? originalStatus
          : "open"
        position.status = rollbackStatus
        position.statusReason = `close_deferred_control_coordination: ${barrier.detail}`
        position.lockedAt = 0
        position.lockedBy = undefined
        const rollback = await mutatePositionWithVersionCheck(position, ["closing"], draft => {
          Object.assign(draft, position)
          draft.status = rollbackStatus
          draft.lockedAt = 0
          draft.lockedBy = undefined
        })
        if (rollback) Object.assign(position, rollback)
        await savePosition(position)
        await releasePositionMutationLock(connectionId, livePositionId, lockId).catch(() => false)
        mutationLockHeld = false
        return position
      }

      if (barrier.decision === "exchange_closed") {
        position.executedQuantity = 0
        position.quantity = 0
      }
    }

    // Close-result state — set by the branches below.
    let exchangeCloseSuccess = false
    let exchangeCloseReason: "ok" | "already_closed" | "failed" | "skipped" = "skipped"

    if (exchangeConnector && hasSystemOrderId && Number(position.executedQuantity || 0) <= 0) {
      exchangeCloseSuccess = true
      exchangeCloseReason = "already_closed"
    }

    if (!hasSystemOrderId && exchangeConnector) {
      exchangeCloseReason = "skipped"
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "info",
        `closeLivePosition: skipping exchange close for ${position.symbol} ${position.direction} — no system orderId (external position protection)`,
        { positionId: position.id, symbol: position.symbol, direction: position.direction },
      ).catch(() => {})
    }

    if (
      !exchangeCloseSuccess &&
      hasSystemOrderId &&
      exchangeConnector &&
      (typeof exchangeConnector.placeOrder === "function" || typeof exchangeConnector.closePosition === "function")
    ) {
      // maxRetries=2, per-attempt timeout=35s, one 500ms backoff.
      // The outer per-position sync deadline bounds the caller; if the venue
      // remains unresponsive the local position stays open for the next
      // authoritative recovery pass.
      // A timed-out reduce-only submission may still have reached the venue.
      // Never retry it blindly in the same cycle. The durable client id and
      // pendingSystemAction are recovered on the next cycle instead.
      const maxRetries = 1
      const backoffMs = [500]
      const CLOSE_ATTEMPT_TIMEOUT_MS = 35_000

      const isAlreadyClosedError = (msg: string): boolean => {
        const m = String(msg || "").toLowerCase()
        return (
          // Generic patterns (all venues)
          m.includes("position not found") ||
          m.includes("no open position") ||
          m.includes("nothing to close") ||
          m.includes("size is zero") ||
          m.includes("already closed") ||
          m.includes("position is zero") ||
          m.includes("position does not exist") ||
          // BingX-specific already-closed codes/messages:
          //   101205 = "No position to close" (position was closed by SL/TP)
          //   101400 = "Order not exist" (also can appear if the position data
          //            was already purged from the exchange)
          m.includes("no position to close") ||
          m.includes("code=101205") ||
          m.includes("101205") ||
          // Bybit
          m.includes("no open position to close") ||
          // OKX
          m.includes("position not available") ||
          m.includes("netting quantity is not correct")
        )
      }
      // Retryable failures are bounded by a sense of "this is a transient
      // error and another attempt might succeed". Permanent rejections
      // (invalid params, auth) should NOT retry. Right now we only retry
      // on timeouts and explicit network errors — everything else falls
      // through to the failed branch after a single attempt.
      const isRetryableError = (msg: string): boolean => {
        const m = String(msg || "").toLowerCase()
        return (
          m.includes("timeout") ||
          m.includes("network") ||
          m.includes("econn") ||
          m.includes("rate limit") ||
          m.includes("429") ||
          m.includes("503") ||
          m.includes("502")
        )
      }

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        let lastErrorMsg = ""
        try {
          console.log(
            `${LOG_PREFIX} [v0] Attempting exchange close ${position.symbol} ${position.direction} (attempt ${attempt + 1}/${maxRetries})`,
          )

          // withTimeout wraps closePosition. The rate-limiter enforces the
          // HTTP timeout from dispatch time (not enqueue time) via executeTimeoutMs,
          // so this covers only actual BingX round-trip time.
          const action = position.pendingSystemAction || {
            token: `system-close:${position.id}:${nanoid(8)}`,
            reason: closeReason,
            phase: "system_submit" as const,
            startedAt: Date.now(),
            updatedAt: Date.now(),
          }
          action.phase = "system_submit"
          action.updatedAt = Date.now()
          action.requestedQuantity = Number(position.executedQuantity || position.quantity || 0)
          if (!action.clientOrderId) action.clientOrderId = makeDurableClientOrderId("sys-close", position)
          position.pendingSystemAction = action
          await savePosition(position)
          await persistCriticalLiveState(`system-close-prepared:${position.id}`)

          const closeSide: "buy" | "sell" = position.direction === "long" ? "sell" : "buy"
          const request = typeof exchangeConnector.placeOrder === "function"
            ? exchangeConnector.placeOrder(
                position.symbol,
                closeSide,
                action.requestedQuantity,
                undefined,
                "market",
                {
                  reduceOnly: true,
                  positionSide: position.direction === "long" ? "LONG" : "SHORT",
                  clientOrderId: action.clientOrderId,
                },
              )
            : exchangeConnector.closePosition(position.symbol, position.direction)
          const r = (await withTimeout(
            request,
            CLOSE_ATTEMPT_TIMEOUT_MS,
            `systemClose(${position.symbol} ${position.direction})`,
          )) as { success?: boolean; error?: string; orderId?: string; id?: string } | undefined

          if (r && typeof r === "object" && r.success === true) {
            action.orderId = r.orderId != null || r.id != null ? String(r.orderId ?? r.id) : action.orderId
            action.phase = "system_verify"
            action.updatedAt = Date.now()
            position.pendingSystemAction = action
            await savePosition(position)
            await persistCriticalLiveState(`system-close-submitted:${position.id}`)
            exchangeCloseSuccess = true
            exchangeCloseReason = "ok"
            console.log(`${LOG_PREFIX} [v0] Exchange close succeeded: ${position.symbol} ${position.direction}`)
            break
          }

          lastErrorMsg = (r && typeof r === "object" && r.error) ? String(r.error) : "invalid_response"

          // ── Already-closed reconciliation ─��─���─────────────────────────
          // If the venue says the position is gone, we treat the close as
          // successful and stop retrying. The DB-side terminal-state
          // pipeline below still runs (PnL is computed from `closePrice`,
          // which the caller passed as the trigger/mark price — which is
          // close enough to the actual SL/TP fill that the operator's
          // reported PnL is within a tick of reality).
          if (isAlreadyClosedError(lastErrorMsg)) {
            exchangeCloseSuccess = true
            exchangeCloseReason = "already_closed"
            console.log(
              `${LOG_PREFIX} [v0] Exchange position already closed (SL/TP likely fired): ${position.symbol} ${position.direction} — reason="${lastErrorMsg}"`,
            )
            break
          }

          console.warn(`${LOG_PREFIX} [v0] Exchange close failed: ${position.symbol} - ${lastErrorMsg}`)
          // Only retry on transient classes of error. Hard logic errors
          // (invalid params, auth) get a single attempt and bail.
          if (attempt < maxRetries - 1 && isRetryableError(lastErrorMsg)) {
            await new Promise(resolve => setTimeout(resolve, backoffMs[attempt]))
            continue
          }
          break
        } catch (err) {
          lastErrorMsg = err instanceof Error ? err.message : String(err)
          console.error(`${LOG_PREFIX} [v0] Exchange close threw error (attempt ${attempt + 1}): ${lastErrorMsg}`)
          // Thrown timeouts and network errors ARE retryable.
          if (attempt < maxRetries - 1 && isRetryableError(lastErrorMsg)) {
            await new Promise(resolve => setTimeout(resolve, backoffMs[attempt]))
            continue
          }
          break
        }
      }

      if (!exchangeCloseSuccess) {
        exchangeCloseReason = "failed"
        console.error(
          `${LOG_PREFIX} [v0] FAILED to close position on exchange after ${maxRetries} attempts: ${position.symbol} ${position.direction}`,
        )
      }
    }

    const slCancelled = hadSlId && !position.stopLossOrderId
    const tpCancelled = hadTpId && !position.takeProfitOrderId

    // Acceptance is not a fill. For connectors with an authoritative
    // position endpoint, terminal state is gated on a zero exchange quantity.
    // A partial or lagging snapshot remains `closing_partial` and is recovered
    // by the durable pendingSystemAction on the next cycle.
    if (exchangeCloseSuccess && exchangeCloseReason === "ok" && exchangeConnector) {
      const direction: "long" | "short" = position.direction === "short" ? "short" : "long"
      const authoritative = await fetchAuthoritativeOpenQuantity(exchangeConnector, position.symbol, direction)
      if (authoritative.ok) {
        const action = position.pendingSystemAction
        const executionId = `${position.id}:system-close:${action?.clientOrderId || action?.orderId || action?.token || "unknown"}`
        const existing = position.partialOrderExecutions?.find((entry) => entry.id === executionId)
        const observed = applyReductionObservation(position, {
          executionId,
          source: "system_close",
          status: authoritative.quantity <= 0 ? "filled" : "partially_filled",
          requestedQuantity: Number(action?.requestedQuantity || position.executedQuantity || 0),
          reportedFilledQuantity: 0,
          previouslyAppliedQuantity: Number(existing?.cumulativeFilledQuantity || action?.appliedFilledQuantity || 0),
          authoritativeQuantity: authoritative.quantity,
          price: closePrice,
          orderId: action?.orderId,
          clientOrderId: action?.clientOrderId,
        })
        if (action) action.appliedFilledQuantity = observed.cumulativeApplied
        if (authoritative.quantity > 1e-12) {
          position.status = "closing_partial"
          position.statusReason = `system_close_pending_exchange_effect: open=${authoritative.quantity}`
          if (action) {
            action.phase = "partial_wait"
            action.updatedAt = Date.now()
          }
          const partialMutation = await mutatePositionWithVersionCheck(position, ["closing"], draft => {
            Object.assign(draft, position)
            draft.status = "closing_partial"
            draft.lockedAt = 0
            draft.lockedBy = undefined
          })
          if (partialMutation) Object.assign(position, partialMutation)
          await savePosition(position)
          await persistCriticalLiveState(`system-close-partial:${position.id}`)
          await releasePositionMutationLock(connectionId, livePositionId, lockId).catch(() => false)
          mutationLockHeld = false
          return position
        }
        position.pendingSystemAction = undefined
      } else if (typeof exchangeConnector.getPosition === "function") {
        position.status = "closing_partial"
        position.statusReason = "system_close_accepted_but_exchange_effect_unconfirmed"
        if (position.pendingSystemAction) {
          position.pendingSystemAction.phase = "system_verify"
          position.pendingSystemAction.updatedAt = Date.now()
        }
        const verifyMutation = await mutatePositionWithVersionCheck(position, ["closing"], draft => {
          Object.assign(draft, position)
          draft.status = "closing_partial"
          draft.lockedAt = 0
          draft.lockedBy = undefined
        })
        if (verifyMutation) Object.assign(position, verifyMutation)
        await savePosition(position)
        await persistCriticalLiveState(`system-close-unconfirmed:${position.id}`)
        await releasePositionMutationLock(connectionId, livePositionId, lockId).catch(() => false)
        mutationLockHeld = false
        return position
      }
    }

    const localOnlyCloseAllowed =
      originalStatus === "simulated" ||
      closeReason === "exchange_externally_closed" ||
      closeReason === "exchange_reconciliation" ||
      closeReason === "duplicate_slot_pruned"
    const mayFinalizeClose = exchangeCloseSuccess || (!exchangeConnector && localOnlyCloseAllowed)
    if (!mayFinalizeClose) {
      const rollbackStatus: LivePosition["status"] = originalStatus && originalStatus !== "closing"
        ? originalStatus
        : "open"
      position.status = rollbackStatus
      position.statusReason =
        `close_failed_exchange_unconfirmed: ${closeReason}; position kept open until authoritative exchange confirmation`
      position.closeReason = undefined
      position.closedAt = undefined
      position.lockedAt = 0
      position.lockedBy = undefined
      pushStep(position, "close_failed_exchange_unconfirmed", false, position.statusReason)
      const rollback = await mutatePositionWithVersionCheck(position, ["closing"], draft => {
        Object.assign(draft, position)
        draft.status = rollbackStatus
        draft.lockedAt = 0
        draft.lockedBy = undefined
      })
      if (rollback) Object.assign(position, rollback)
      await updateProtectionOrders(exchangeConnector, position, "close_failed_rearm", null)
      await savePosition(position)
      await incrementMetric(connectionId, "live_positions_close_failed_count")
      await releasePositionMutationLock(connectionId, livePositionId, lockId).catch(() => false)
      mutationLockHeld = false
      console.warn(
        `${LOG_PREFIX} Exchange close was not confirmed for ${position.symbol}; position kept open and protection re-armed`,
      )
      return position
    }

    // ── Orphan-sweep safety net ───────────────────────────────────────��
    // After the recorded-id cancels, scan the venue for ANY reduce-only
    // order matching this symbol + close-side and cancel it. Catches:
    //   • by-id cancels that just failed transiently (we get a free retry)
    //   • protection ids that were never persisted (place-success → crash
    //     → restart finds no id in Redis)
    //   • operator-placed manual reduce-only legs the engine never knew
    //     about — which become orphans the moment the position closes.
    // Best-effort; we never let sweep failures block the close pipeline.
    if (exchangeConnector) {
      const sweepCloseSide: "buy" | "sell" =
        position.direction === "long" ? "sell" : "buy"
      try {
        const swept = await sweepOrphanProtectionOrders(
          exchangeConnector,
          position.symbol,
          sweepCloseSide,
          position,
        )
        if (swept.cancelled > 0) {
          // If the sweep cleaned up the recorded ids' leftovers, clear
          // the local fields too — at this point there is nothing on
          // the venue tied to those ids.
          if (hadSlId && !slCancelled) position.stopLossOrderId = undefined
          if (hadTpId && !tpCancelled) position.takeProfitOrderId = undefined
          pushStep(
            position,
            "orphan_sweep",
            true,
            `swept ${swept.cancelled}/${swept.scanned} orphan reduce-only orders`,
          )
        }
      } catch (sweepErr) {
        console.warn(
          `${LOG_PREFIX} [sweep] ${position.symbol} error: ${sweepErr instanceof Error ? sweepErr.message : String(sweepErr)}`,
        )
      }
    }

    // ── 3. Compute realized PnL & ROI (margin-based to match exchange ROE) ──
    const remainingQty = Math.max(0, Number(position.executedQuantity || 0))
    const qty = Math.max(
      Number(position.totalExecutedQuantity || 0),
      Number(position.closedQuantity || 0) + remainingQty,
      Number(position.initialExecutedQuantity || 0),
      remainingQty,
    )
    const avgEntry = position.averageExecutionPrice || position.entryPrice || 0
    const finalLegPnl =
      remainingQty > 0 && avgEntry > 0 && closePrice > 0
        ? remainingQty *
          (position.direction === "long"
            ? closePrice - avgEntry
            : avgEntry - closePrice)
        : 0
    const pnl = Number(position.realizedPnL || 0) + finalLegPnl
    const lev = Math.max(1, position.leverage || 1)
    const notional = avgEntry * qty
    const margin = notional > 0 ? notional / lev : 0
    const roi = margin > 0 ? (pnl / margin) * 100 : 0

    // ── 4. Persist with terminal state ────────────────────────────────
    position.status = "closed"
    position.closedAt = Date.now()
    position.updatedAt = Date.now()
    position.realizedPnL = Math.round(pnl * 100) / 100
    position.totalExecutedQuantity = qty
    position.closedQuantity = qty
    // Closed-history rows retain the complete traded quantity while open
    // allocation remains explicitly zero in each member Set.
    position.executedQuantity = qty
    position.quantity = qty
    position.remainingQuantity = 0
    if (position.combinedPosCounts) {
      position.posCountsSetQuantities = allocatePositionSetQuantities(position, 0, position.accumulatedSetKeys || [])
    }
    position.pendingReduction = undefined
    position.pendingSystemAction = undefined
    position.pendingQuantityMutation = undefined
    position.pendingAccumulation = undefined
    position.closeReason = closeReason
    // Persist the actual exit price so the stats route and trade-history
    // table can show the real close price without needing to back-derive
    // it from realizedPnL. This is the definitive source of truth for
    // the "Exit" column in trade history.
    if (closePrice > 0) position.closePrice = Math.round(closePrice * 1e8) / 1e8
    
    // Step annotation distinguishes the three real outcomes:
    //   • ok            → connector returned success
    //   • already_closed → venue said position is gone (SL/TP fired)
    //   • failed         → connector returned an error we couldn't recover
    //   • skipped        → no connector was passed (manual DB-only close)
    const exchangeNote =
      !exchangeConnector
        ? "" // no exchange leg
        : exchangeCloseReason === "ok"
          ? " [exchange-closed]"
          : exchangeCloseReason === "already_closed"
            ? " [exchange-already-closed]"
            : " [exchange-close-FAILED]"
    pushStep(
      position,
      "close",
      true,
      `close @ ${closePrice} pnl=${pnl.toFixed(2)} roi=${roi.toFixed(2)}% reason=${closeReason}${exchangeNote}`,
    )
    // savePosition() handles index move + idempotent archival.
    // CHECK the moved-marker BEFORE savePosition() runs so we know
    // whether THIS close is the first terminal write or a re-entry.
    // Without this guard `closeLivePosition` and the reconcile loop
    // could BOTH bump `live_positions_closed_count` for the same
    // position — that's exactly the "Positions Closed (6) >
    // Positions Created (4)" asymmetry the operator reported.
    const movedMarker = `live:positions:${connectionId}:moved:${position.id}`
    const wasAlreadyClosed = await client.get(movedMarker).catch(() => null)
    const closedMutation = await mutatePositionWithVersionCheck(position, ["closing"], draft => {
      Object.assign(draft, position)
      draft.status = "closed"
      draft.version = Number(position.version || 0) + 1
      draft.updatedAt = Date.now()
      draft.lockedAt = 0
      draft.lockedBy = undefined
    })
    if (!closedMutation) {
      await releasePositionMutationLock(connectionId, livePositionId, lockId).catch(() => false)
      mutationLockHeld = false
      return null
    }
    Object.assign(position, closedMutation)
    await savePosition(position)
    await advanceBlockCountPausesOnPositionClose(client, position)

    // ── 5. Release dedup lock + counters + audit log ────────────────────
    await releasePositionMutationLock(connectionId, livePositionId, lockId).catch(() => false)
    mutationLockHeld = false
    if (position.liveLockToken) {
      await releaseLock(connectionId, position.symbol, position.direction!, position.liveLockToken)
    } else {
      console.warn(`${LOG_PREFIX} [lock-coordination] close skipped live lock release for ${connectionId}/${position.symbol}/${position.direction} because no owner token is available`)
    }
    if (!wasAlreadyClosed) {
      await incrementMetric(connectionId, "live_positions_closed_count")
      if (pnl > 0) await incrementMetric(connectionId, "live_wins_count")
      // Only count as exchange-close failure when the connector actually
      // failed. `already_closed` means the exchange-side state already
      // matches our intent (SL/TP fired first), and `skipped` means we
      // never had a connector — neither is a real failure.
      if (exchangeCloseReason === "failed") {
        await incrementMetric(connectionId, "live_positions_close_failed_count")
      }
    }

    // ── Include lineage context in close logging ──
    // When a live position closes, log its original real set context
    // so dashboards can trace the complete lifecycle:
    // real set → live creation → SL/TP/manual close → final P&L
    await logProgressionEvent(connectionId, "live_trading", "info", `Closed live position ${position.symbol}`, {
      livePositionId: position.id,
      realPositionId: position.realPositionId,
      realSetKey: position.setKey,
      realParentSetKey: position.parentSetKey,
      realSetVariant: position.setVariant,
      realAxisWindows: position.axisWindows,
      pnl,
      roi,
      closePrice,
      closeReason,
      executedQuantity: qty,
      averageEntry: avgEntry,
      leverage: lev,
      marginAtRisk: margin,
      exchangeCloseSucceeded: exchangeCloseSuccess,
      exchangeCloseClassification: exchangeCloseReason,
    })

    const closeStatus =
      exchangeCloseReason === "ok"
        ? "SUCCEEDED"
        : exchangeCloseReason === "already_closed"
          ? "ALREADY-CLOSED (SL/TP fired)"
          : exchangeCloseReason === "skipped"
            ? "DB-only (no connector)"
            : "FAILED (DB-closed; exchange uncertain)"
    console.log(
      `${LOG_PREFIX} [v0] Closed ${position.symbol} ${position.direction} P&L=${pnl.toFixed(2)} ROI=${roi.toFixed(2)}% reason=${closeReason} exchange_close=${closeStatus}`,
    )

    return position
  } catch (err) {
    if (mutationLockHeld) {
      await releasePositionMutationLock(connectionId, livePositionId, lockId).catch(() => false)
    }
    console.error(`${LOG_PREFIX} Error closing live position:`, err)
    return null
  } finally {
    stopPositionLockLeaseRefresh?.()
  }
}

/**
 * Get all live positions for a connection.
 */
export async function getLivePositions(connectionId: string): Promise<LivePosition[]> {
  await initRedis()
  const client = getRedisClient()
  try {
    const ids = ((await client.lrange(`live:positions:${connectionId}`, 0, 500).catch(() => [])) || []) as string[]

    // Deduplicate while preserving order — the open index may contain stale
    // duplicates from retried writes.
    const uniqueIds: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      uniqueIds.push(id)
    }

    // Batch all GETs into a single concurrent fan-out. Previously each id
    // paid a full Redis round-trip; with 500 open positions that was ~500
    // sequential awaits. Promise.all collapses them into one RTT window.
    const positions: LivePosition[] = []
    if (uniqueIds.length > 0) {
      const values = await Promise.all(
        uniqueIds.map((id) => readLivePositionSnapshot(client, connectionId, id).catch(() => null)),
      )
      for (const pos of values) if (pos) positions.push(pos)
    }
    return positions
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error getting live positions:`, err)
    return []
  }
}

/**
 * Get live positions filtered by status.
 */
export async function getLivePositionsByStatus(
  connectionId: string,
  status: LivePosition["status"]
  ): Promise<LivePosition[]> {
  const allPositions = await getLivePositions(connectionId)
  return allPositions.filter(p => p.status === status)
  }

/**
 * Fetch the most recent closed/terminal positions from the closed archive.
 * Closed positions are stored separately so the open index stays small.
 */
export async function getClosedLivePositions(
  connectionId: string,
  limit = 200
): Promise<LivePosition[]> {
  await initRedis()
  const client = getRedisClient()
  try {
    const ids = ((await client.lrange(`live:positions:${connectionId}:closed`, 0, limit - 1).catch(() => [])) || []) as string[]

    // Deduplicate + batch GETs concurrently (same rationale as getLivePositions).
    const uniqueIds: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      uniqueIds.push(id)
    }

    const positions: LivePosition[] = []
    if (uniqueIds.length === 0) return positions

    const values = await Promise.all(
      uniqueIds.map((id) => readLivePositionSnapshot(client, connectionId, id).catch(() => null)),
    )
    for (const pos of values) if (pos) positions.push(pos)
    return positions
  } catch (err) {
    console.warn(`${LOG_PREFIX} getClosedLivePositions error:`, err)
    return []
  }
}

/**
 * Compute aggregate stats across all live positions.
 */
export async function calculateLivePositionStats(
  connectionId: string
): Promise<{
  totalFilled: number
  totalOpen: number
  totalClosed: number
  totalPnL: number
  averageROI: number
  winRate: number
}> {
  try {
    // Merge open (live) and closed (archive) indices so aggregate stats are
    // accurate across the position's full lifecycle, not just currently-open.
    const [openPositions, closedPositions] = await Promise.all([
      getLivePositions(connectionId),
      getClosedLivePositions(connectionId, 1000),
    ])
    const allPositions = [...openPositions, ...closedPositions]
    const closed = allPositions.filter(p => p.status === "closed")
    const open = allPositions.filter(
      p => p.status === "open" || p.status === "filled" || p.status === "partially_filled"
    )

    let totalPnL = 0
    let winCount = 0
    for (const pos of closed) {
      const lastStep = pos.progression?.find(s => s.step === "close")
      const exitPx = lastStep ? parseFloat(lastStep.details?.split("@ ")[1] || "0") : 0
      if (exitPx > 0 && pos.averageExecutionPrice > 0) {
        const pnl = Math.round(
          pos.executedQuantity *
          (pos.direction === "long"
            ? exitPx - pos.averageExecutionPrice
            : pos.averageExecutionPrice - exitPx) * 100
        ) / 100
        totalPnL = Math.round((totalPnL + pnl) * 100) / 100
        if (pnl > 0) winCount++
      }
    }

    return {
      totalFilled: allPositions.filter(p => p.status === "filled" || p.status === "open").length,
      totalOpen: open.length,
      totalClosed: closed.length,
      totalPnL,
      averageROI: closed.length > 0 ? Math.round((totalPnL / closed.length) * 100) / 100 : 0,
      winRate: closed.length > 0 ? Math.round((winCount / closed.length) * 100) / 100 : 0,
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Error calculating stats:`, err)
    return {
      totalFilled: 0,
      totalOpen: 0,
      totalClosed: 0,
      totalPnL: 0,
      averageROI: 0,
      winRate: 0,
    }
  }
}

/**
 * Detect whether the latest mark price has crossed the position's
 * desired SL or TP threshold and — if so — force-close the position
 * via `closeLivePosition`. Returns the cross reason only after a confirmed
 * terminal transition, `close_unconfirmed` when the exchange close failed
 * and the position remains tracked/open, otherwise `null`.
 *
 * This is the safety net the user described as "check pos if to be
 * updated or closed also independent of the control orders". Even if
 * the exchange-placed reduce-only SL/TP orders fail to fire (illiquid
 * pair gap, exchange order cancelled by the user, network race), this
 * comparison guarantees we close the position once mark price has
 * actually crossed the configured level.
 *
 * Used by:
 *   - `reconcileLivePositions` (cron, full reconcile sweep)
 *   - `syncWithExchange`        (engine loop, lighter mark-price refresh)
 *   - `recalculateAndApplySLTP` (immediate check after operator override —
 *     a tightened SL might already be breached at the new percentage)
 *
 * Pure side-effect helper: the caller decides what to do with `null`
 * (typically: persist the mark refresh and continue) or with a non-null
 * return (typically: skip further processing because the position was
 * archived by `closeLivePosition`).
 */
async function checkAndForceCloseOnSltpCross(
  connectionId: string,
  pos: LivePosition,
  markPrice: number,
  exchangeConnector: any,
): Promise<"sl_hit" | "tp_hit" | "close_unconfirmed" | null> {
  if (!Number.isFinite(markPrice) || markPrice <= 0) return null
  if (pos.executedQuantity <= 0) return null
  
  // CRITICAL GUARD: Skip positions that are already closed or have a close reason set.
  // Without this guard, multiple concurrent reconciliation paths call this function
  // on the same position, all detecting the SL/TP cross and all calling closeLivePosition(),
  // resulting in duplicate close attempts and memory overload from redundant API calls.
  if (pos.status === "closed" || pos.status === "rejected" || pos.status === "error") return null
  if (pos.closeReason || pos.closedAt) return null  // Already being closed elsewhere
  
  // closeLivePosition owns the Redis mutation lock and status/version transition.
  if (!isSystemTrackedLivePosition(pos, connectionId)) return null
  if (pos.status === "placed") {
    // Rate-limit to once-per-minute per position by using updatedAt as
    // the throttle key — prevents log spam while still surfacing the
    // skip during diagnosis.
    const since = Date.now() - (pos.updatedAt || 0)
    if (since > 60_000) {
      console.log(
        `${LOG_PREFIX} [cross-check skip] ${pos.symbol} (id=${pos.id}) status='placed' — entry order not filled yet; SL/TP cross check deferred`,
      )
    }
    return null
  }

  const fillPrice = pos.averageExecutionPrice
  // Require a confirmed fill price �� entryPrice is an estimate and can be
  // stale. If averageExecutionPrice is missing the position has not been
  // confirmed filled yet; skip until it is.
  if (!fillPrice || fillPrice <= 0) return null

  // ── Trailing stop: honour the ratcheted absolute price ─────────────────
  // When trailing is active syncLiveFromPseudo has stamped trailingStopPrice
  // onto the position. Using that absolute price means the proactive force-close
  // fires at the RATCHETED level — not the static origin level that the
  // percentage anchor would compute. Without this fix a trailing stop that
  // ratcheted from, say, 2% below entry to 0.5% below entry would NEVER
  // trigger the proactive close (the static 2% level is never reached while
  // in profit), letting the position blow through the ratcheted stop if the
  // exchange order somehow failed to fire.
  let desiredSl: number
  if (pos.trailingActive && pos.trailingStopPrice && pos.trailingStopPrice > 0) {
    desiredSl = pos.trailingStopPrice
  } else {
    const slPct = Math.max(0, pos.stopLoss || 0) / 100
    desiredSl =
      slPct > 0
        ? pos.direction === "long"
          ? fillPrice * (1 - slPct)
          : fillPrice * (1 + slPct)
        : 0
  }

  const tpPct = Math.max(0, pos.takeProfit || 0) / 100
  const desiredTp =
    tpPct > 0
      ? pos.direction === "long"
        ? fillPrice * (1 + tpPct)
        : fillPrice * (1 - tpPct)
      : 0

  // Nothing to evaluate if neither protection band is configured.
  if (desiredSl <= 0 && desiredTp <= 0) return null

  let crossReason: "sl_hit" | "tp_hit" | null = null
  if (pos.direction === "long") {
    if (desiredSl > 0 && markPrice <= desiredSl) crossReason = "sl_hit"
    else if (desiredTp > 0 && markPrice >= desiredTp) crossReason = "tp_hit"
  } else {
    if (desiredSl > 0 && markPrice >= desiredSl) crossReason = "sl_hit"
    else if (desiredTp > 0 && markPrice <= desiredTp) crossReason = "tp_hit"
  }

  if (!crossReason) return null

  console.log(
    `${LOG_PREFIX} ${crossReason.toUpperCase()} detected for ${pos.symbol} ${pos.direction} @ mark=${markPrice} (sl=${desiredSl} tp=${desiredTp}) ��� force-closing`,
  )
  await logProgressionEvent(
    connectionId,
    "live_trading",
    "warning",
    `${crossReason === "sl_hit" ? "Stop-loss" : "Take-profit"} cross detected for ${pos.symbol} — force-closing`,
    {
      positionId: pos.id,
      markPrice,
      desiredSl,
      desiredTp,
      direction: pos.direction!,
      averageEntry: pos.averageExecutionPrice,
      // Useful for the operator audit trail: was the cross because the
      // exchange-placed control order failed to fire, or because the
      // operator just tightened the band such that the position was
      // already past it?
      hadStopLossOrder: !!pos.stopLossOrderId,
      hadTakeProfitOrder: !!pos.takeProfitOrderId,
    },
  )

  try {
    const closed = await closeLivePosition(
      connectionId,
      pos.id,
      markPrice,
      exchangeConnector,
      crossReason as unknown as string,
    )
    if (closed?.status === "closed") return crossReason
    if (closed) Object.assign(pos, closed)
    return "close_unconfirmed"
  } catch (closeErr) {
    console.warn(
      `${LOG_PREFIX} force-close on ${crossReason!} failed for ${pos.id}:`,
      closeErr instanceof Error ? closeErr.message : String(closeErr),
    )
  }
  return "close_unconfirmed"
}

/**
 * Reconcile Redis-tracked live positions with the exchange.
 *
 * For every Redis-tracked open position:
 *   - If present on the exchange: refresh markPrice / liqPrice / unrealizedPnL
 *   - If NOT present on the exchange: it was closed externally (SL/TP hit,
 *     liquidated, or manually closed). Transition to "closed", compute realised
 *     PnL, move to the closed archive, increment metrics, release the lock.
 *
 * Returns a summary usable for logging / API responses.
 *
 * ── Hedge-Net Reconciliation Hook (operator spec, Position-Count axis) ─��────
 * `strategy-coordinator.evaluateRealSets` writes per-bucket net targets to
 * the Redis hash `live_net_target:{connectionId}`. Each field is keyed by
 *
 *   `${symbol}|${ind}|p${prev}|l${last}|c${cont}|o${outcome}`
 *
 * (the axis-Cartesian triple + last-axis outcome) and its value encodes the
 * dominant-direction target:
 *
 *   `long:N`   → keep N net-long axis OPEN positions in this bucket
 *   `short:N`  → keep N net-short axis OPEN positions in this bucket
 *   `flat:0`   → perfect long/short cancellation; close any open in bucket
 *
 * The `cont` component is the OPEN-position accumulation count per spec
 * ("continuous 3: add actual and next 2 positions"). Each reconcile tick
 * advances the bucket toward `N = cont` open positions in the net direction.
 * As completed positions close out under the bucket the next coordinator
 * cycle re-evaluates the prev/last PF gates (closed-only) over the now-
 * larger completed sample and either:
 *   (a) keep bucket alive at same magnitude  → no exchange op
 *   (b) flip outcome (pos ↔ neg)             → close + reopen
 *   (c) flip dominant direction (long ↔ short) → close + reopen
 *   (d) drop bucket from net targets         → close all in bucket
 *
 * Reconciliation reuses the existing `closeLivePosition` and
 * `executeLivePosition` paths — no new exchange-call surface.
 */

/**
 * Orphan-close all open positions for a connection that have exceeded the
 * max hold time, writing `orphan_no_connector` or `orphan_exchange_error`
 * as the close reason. Called when the exchange connector is unavailable or
 * `getPositions()` throws, so positions are never left open in Redis
 * indefinitely even when the exchange cannot be reached.
 *
 * @param connectionId  Redis connection ID
 * @param connector     Exchange connector (null when unavailable)
 * @param summary       Mutable reconcile summary to increment counters
 */
async function orphanCloseExpiredPositions(
  connectionId: string,
  connector: any,
  // Same shape as the reconcile summary so the function can roll up
  // sweep activity into the engine-level totals without the caller
  // having to mirror counters.
  summary: {
    reconciled: number
    closed: number
    errors: number
    updated: number
    protectionRearmed: number
    orphansSwept: number
  },
): Promise<void> {
  const MAX_HOLD_TIME_MS = resolveMaxHoldMs(connectionId)
  if (MAX_HOLD_TIME_MS <= 0) return

  try {
    const allOpen = await getLivePositions(connectionId)
    const expired = allOpen.filter((p) => {
      if (p.status !== "open" && p.status !== "filled" && p.status !== "partially_filled") return false
      if (!isSystemTrackedLivePosition(p, connectionId)) return false
      if ((p.executedQuantity ?? 0) <= 0) return false
      const openedAt = p.createdAt || p.updatedAt || 0
      return openedAt > 0 && Date.now() - openedAt > MAX_HOLD_TIME_MS
    })

    for (const pos of expired) {
      summary.reconciled++
      const heldMin = Math.round((Date.now() - (pos.createdAt || pos.updatedAt || 0)) / 60000)
      // Same exit-price resolution chain as reconcileLivePositions:
      // markPrice → averageExecutionPrice → Redis market_data → entryPrice
      let exitPrice: number = Number(pos.exchangeData?.markPrice) || pos.averageExecutionPrice || 0
      if (exitPrice <= 0) {
        try {
          const orphanRedis = getRedisClient()
          const mdHash = await orphanRedis.hgetall(`market_data:${pos.symbol}`)
          const mdPrice = parseFloat(String(mdHash?.lastPrice ?? mdHash?.price ?? mdHash?.close ?? "0"))
          if (mdPrice > 0) exitPrice = mdPrice
        } catch { /* ignore */ }
      }
      if (exitPrice <= 0) exitPrice = pos.entryPrice || 0
      const reason = connector ? "orphan_exchange_error" : "orphan_no_connector"

      console.warn(
        `${LOG_PREFIX} [orphan-close] ${pos.symbol} held ${heldMin}min, connector=${connector ? "error" : "missing"} — marking closed`,
      )
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "warning",
        `Orphan-close ${pos.symbol} (held ${heldMin}min, ${reason})`,
        { positionId: pos.id, heldMin, exitPrice, reason },
      )

      // Best-effort cancel protection orders first (connector may be partially working)
      if (connector) {
        const cancels: Promise<any>[] = []
        if (pos.stopLossOrderId) cancels.push(cancelProtectionOrder(connector, pos.symbol, pos.stopLossOrderId, "StopLoss", pos.connectionId).catch(() => {}))
        if (pos.takeProfitOrderId) cancels.push(cancelProtectionOrder(connector, pos.symbol, pos.takeProfitOrderId, "TakeProfit", pos.connectionId).catch(() => {}))
        if (cancels.length) await Promise.all(cancels).catch(() => {})
        // Same orphan-sweep used inside `closeLivePosition`. Wired here
        // too so max-hold-expired positions also get the chaos-prevention
        // pass — without it, an operator-placed reduce-only that the
        // engine never recorded would survive the orphan-close because
        // there'd be no by-id cancellation to trigger the sweep on.
        const sweepCloseSide: "buy" | "sell" = pos.direction === "long" ? "sell" : "buy"
        try {
          const swept = await sweepOrphanProtectionOrders(connector, pos.symbol, sweepCloseSide, pos)
          summary.orphansSwept += swept.cancelled
        } catch { /* sweep is best-effort */ }
      }

      const closeResult = await closeLivePosition(connectionId, pos.id, exitPrice, connector, reason).catch((err) => {
        console.warn(`${LOG_PREFIX} [orphan-close] closeLivePosition failed for ${pos.id}:`, err instanceof Error ? err.message : String(err))
        summary.errors++
        return null
      })
      if (closeResult?.status === "closed") summary.closed++
      else if (closeResult) summary.errors++
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} [orphan-close] sweep error:`, err instanceof Error ? err.message : String(err))
    summary.errors++
  }
}

/**
 * ── CANONICAL LIVE SYNC & RECONCILE ────────────────���────────────────────────
 * Single entry-point for ALL live-position + exchange sync work.
 *
 * Called by:
 *   • startRealtimeProcessor  (engine-manager.ts, 200 ms self-scheduling loop)
 *   • maybeRunLiveSync        (realtime-processor.ts, legacy throttle gate — delegates here)
 *   • /api/cron/sync-live-positions (portable external scheduler, 60 s)
 *   • syncWithExchange        (legacy shim, redirects here)
 *
 * Responsibilities (in one Redis-locked pass):
 *   1. Always-run simulated-position sweep (paper-mode close path) — runs
 *      even when connector is absent or global pause is set.
 *   2. Exchange position fetch + normalized (symbol|direction) → exchangePos map.
 *   3. Exchange-orphan adoption (exchange positions not yet tracked in Redis).
 *   4. Per-position loop (open/placed statuses):
 *       a. Mark-price / liq-price / unrealizedPnL refresh from exchange.
 *       b. Externally-closed detection (absent from exchange map).
 *       c. SL/TP protection-order healing via updateProtectionOrders.
 *       d. SL/TP cross-check → force-close on market hit.
 *       e. Max-hold-time safety close.
 *       f. savePosition (persist refreshed state).
 *   5. Redis single-flight lock + cross-caller dedup via moved-marker key.
 *
 * Options:
 *   • skipSimulatedSweep     — skip step 1 (caller already ran processSimulatedPositions)
 *   • skipOrphanAdoption     — skip step 3 (orphan run is a no-op when connector is absent)
 *   • reconcileMode          — true = cron (does not return early on no connector;
 *                              false = engine tick (early-return is fine)).
 */
export async function reconcileLivePositions(
  connectionId: string,
  exchangeConnector: any,
  options: {
    skipSimulatedSweep?: boolean
    skipOrphanAdoption?: boolean
    reconcileMode?: boolean
  } = {},
): Promise<{
  reconciled: number
  updated: number
  closed: number
  errors: number
  protectionRearmed: number
  orphansSwept: number
}> {
  await initRedis()
  const client = getRedisClient()
  const { skipSimulatedSweep, skipOrphanAdoption, reconcileMode = false } = options
  const summary = {
    reconciled: 0, updated: 0, closed: 0, errors: 0, protectionRearmed: 0, orphansSwept: 0,
  }

  // ── Cross-caller single-flight lock ───────────────────────────────────────
  // Multiple callers (engine tick + cron + resume) can hit this function in
  // parallel. The Redis lock prevents concurrent mutations of per-position
  // state. TTL 30 s is the safety net for process death mid-sync.
  const LIVE_SYNC_LOCK_KEY = `live_sync_lock:${connectionId}`
  const LIVE_SYNC_LOCK_TTL = 30
  const syncLockToken = `reconcile:${process.pid}:${Date.now()}:${nanoid(12)}`
  let lockAcquired = false
  let stopSyncLockLeaseRefresh: (() => void) | null = null
  if (client) {
    try {
      lockAcquired = await (client.set(LIVE_SYNC_LOCK_KEY, syncLockToken, { NX: true, EX: LIVE_SYNC_LOCK_TTL }) as any) === "OK"
      if (lockAcquired) {
        stopSyncLockLeaseRefresh = startRedisLockLeaseRefresh(
          client,
          LIVE_SYNC_LOCK_KEY,
          syncLockToken,
          LIVE_SYNC_LOCK_TTL * 1000,
        )
      }
    } catch { /* Redis unreachable → fail open */ }
    if (!lockAcquired) {
      console.log(`${LOG_PREFIX} [reconcile] skip — lock held for conn=${connectionId}`)
      return summary
    }
  }

  try {
    // ── Step 1: Simulated-position sweep (always runs unless caller opts out) ─
    if (!skipSimulatedSweep) {
      try {
        const simResult = await processSimulatedPositions(connectionId)
        summary.reconciled += simResult.processed
        summary.closed     += simResult.closed
        summary.errors     += simResult.errors
      } catch { /* processSimulatedPositions is self-defensive */ }
    }

    // QuickStart intentionally keeps the engine progression running when the
    // BingX connection test fails, but writes is_live_trade=0 so no private
    // exchange endpoints should be touched. The sync loop already had this
    // guard; the reconcile path also needs it because the coordinator can call
    // reconcile directly every 30s. Without this, dev mode kept polling
    // getPositions/getOpenOrders and spammed "fetch failed" after a blocked
    // quickstart.
    if (!(await isLiveTradeEnabledForConnection(connectionId))) {
      if (!skipOrphanAdoption) {
        await orphanCloseExpiredPositions(connectionId, null, summary)
      }
      return summary
    }

    // ── Step 4+ from reconcileLivePositions ───────────���────────────────────
    // Nothing to do if connector absent (sim-only is already done above)
    if (!exchangeConnector || typeof exchangeConnector.getPositions !== "function") {
      if (!reconcileMode) return summary  // cron always runs full path
      await orphanCloseExpiredPositions(connectionId, null, summary)
      return summary
    }

    // Load live-positions index (single Redis round-trip, filtered in-memory)
    const allOpen = await getLivePositions(connectionId)
    const openPositions = allOpen.filter(
      (p) => p.status === "open" || p.status === "filled" || p.status === "partially_filled" || p.status === "placed" || p.status === "pending_fill" || p.status === "placed_unconfirmed" || p.status === "closing" || p.status === "closing_partial",
    )
    if (openPositions.length === 0 && !reconcileMode) {
      await orphanCloseExpiredPositions(connectionId, exchangeConnector, summary)
      return summary
    }

    // Single batch fetch of ALL exchange positions for the position-sync loop.
    // Use cycle-level cache to eliminate duplicate getPositions() calls when
    // multiple symbols are processed. Cache TTL=500ms, expires after cycle completes.
    let exchangePositions: any[] = []
    let exchangePositionsSnapshotOk = false
    try {
      // Check cache first (50% hit rate typical, saves 30-40% API calls per cycle)
      const cached = getCachedPositions(connectionId)
      if (cached) {
        exchangePositions = cached
        exchangePositionsSnapshotOk = true
      } else {
        exchangePositions = (await exchangeConnector.getPositions()) || []
        const snapshotStatus = typeof exchangeConnector.getLastPositionsSnapshotStatus === "function"
          ? exchangeConnector.getLastPositionsSnapshotStatus()
          : { ok: true }
        exchangePositionsSnapshotOk = snapshotStatus.ok === true
        // Cache for subsequent getPositions calls this cycle
        if (exchangePositionsSnapshotOk) setCachedPositions(connectionId, exchangePositions)
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} getPositions failed:`, err instanceof Error ? err.message : String(err))
      await orphanCloseExpiredPositions(connectionId, exchangeConnector, summary)
      return summary
    }
    if (!exchangePositionsSnapshotOk) {
      console.warn(`${LOG_PREFIX} Exchange positions snapshot was not authoritative; external-close processing deferred`)
      return summary
    }

    // Normalise a raw exchange symbol for map-key comparison.
    // BingX (and several other venues) return "BTC-USDT" or "BTC_USDT"
    // while Redis stores the normalised form "BTCUSDT". Strip all
    // separators before building / querying the key so a BingX position
    // is never mistaken for "externally closed" simply because the symbol
    // format differs.
    const normSym = (raw: string) => raw.toUpperCase().replace(/[-_]/g, "")

    const exchangeMap = new Map<string, any>()
    for (const ep of exchangePositions) {
      const sym = normSym(String(ep.symbol || ep.Symbol || ""))
      if (!sym) continue
      const size = parseFloat(String(ep.size ?? ep.positionAmt ?? ep.quantity ?? "0"))
      if (!size) continue
      const sideRaw = String(ep.side ?? ep.positionSide ?? (size > 0 ? "long" : "short")).toLowerCase()
      const direction: "long" | "short" = (sideRaw.includes("short") || sideRaw === "sell") ? "short" : "long"
      exchangeMap.set(`${sym}|${direction}`, ep)
    }

    // ── Once-per-tick venue open-orders snapshot ────���─────────────────���
    // Used by `updateProtectionOrders` to detect silently-gone SL/TP
    // (filled, externally cancelled, expired, sweep). One `getOpenOrders`
    // call amortized across every position in the reconcile sweep, vs.
    // 2 × getOrder() calls per position the alternative would require.
    // `null` means "skip verification this tick"; the next tick retries.
    const liveOrderIds = await fetchLiveOrderIdSet(exchangeConnector)

    // ── Per-position worker (parallelisable) ─────────���───────────────
    // Each iteration is independent at the venue + Redis layer:
    //   • Redis writes are scoped to `live:positions:{conn}:{id}` and
    //     the per-symbol-direction lock key — no two positions share
    //     them.
    //   • Exchange calls are per-(symbol, direction) and the venue
    //     serialises its own per-symbol writes.
    //   • The idempotent `moved:{id}` marker prevents the close-counter
    //     drift the operator reported even under interleaved execution.
    // So we can fan the loop body out with bounded concurrency. Returns
    // a tiny per-position delta that the caller folds into `summary`.
    type PosDelta = {
      reconciled: number
      updated: number
      closed: number
      errors: number
      protectionRearmed: number
    }
    // ── Canonical-position-per-slot resolution (BUG 4) ────────��───────
    // The venue holds exactly ONE position per (symbol, direction). If
    // Redis tracks more than one open position for the same slot
    // (lock-expiry edge, restart mid-entry, or migrated legacy data),
    // they ALL map to the same exchange position. Reconciling each one
    // independently would (a) arm duplicate SL/TP orders against one
    // venue position and (b) when that venue position closes, count one
    // real close N times — the close-counter drift the operator reported.
    //
    // Resolve a single CANONICAL position id per slot up-front. The choice
    // is stable and order-independent (so the parallel pool below is
    // deterministic): prefer a system-owned position (has orderId), then
    // the one actually filled (largest executedQuantity), then the oldest
    // createdAt. Non-canonical duplicates are refreshed for the dashboard
    // but never drive SL/TP arming, force-close, or close counters.
    const canonicalIdBySlot = new Map<string, string>()
    {
      const bySlot = new Map<string, typeof openPositions>()
      for (const p of openPositions) {
        const slot = `${normSym(p.symbol)}|${p.direction}`
        const arr = bySlot.get(slot)
        if (arr) arr.push(p); else bySlot.set(slot, [p])
      }
      for (const [slot, group] of bySlot) {
        if (group.length === 1) { canonicalIdBySlot.set(slot, group[0].id); continue }
        const ranked = [...group].sort((a, b) => {
          const ao = a.orderId ? 1 : 0, bo = b.orderId ? 1 : 0
          if (ao !== bo) return bo - ao
          const aq = a.executedQuantity || 0, bq = b.executedQuantity || 0
          if (aq !== bq) return bq - aq
          return (a.createdAt || 0) - (b.createdAt || 0)
        })
        canonicalIdBySlot.set(slot, ranked[0].id)
        console.warn(
          `${LOG_PREFIX} [reconcile] slot ${slot} has ${group.length} open Redis positions — ` +
          `canonical=${ranked[0].id}; others pruned/refreshed without close-count.`,
        )
      }
    }

    // BATCHING: Collect positions to save instead of saving individually
    const positionsToSave: typeof openPositions = []

    const processOne = async (pos: typeof openPositions[number]): Promise<PosDelta> => {
      const delta: PosDelta = { reconciled: 1, updated: 0, closed: 0, errors: 0, protectionRearmed: 0 }
      try {
        const mapKey = `${normSym(pos.symbol)}|${pos.direction}`
        const exPos = exchangeMap.get(mapKey)

        // ── Non-canonical duplicate for this venue slot (BUG 4) ─────────
        // Never drive SL/TP, force-close, or close counters (would double-
        // count one venue position). Just keep the dashboard mark/PnL fresh
        // when the slot is live, or prune the phantom Redis record when the
        // venue slot is empty — without incrementing the close counter, so
        // the canonical record alone owns the single real close.
        if (canonicalIdBySlot.get(mapKey) !== pos.id) {
          if (exPos) {
            const mP = parseFloat(String(exPos.markPrice ?? exPos.indexPrice ?? exPos.lastPrice ?? "0"))
            const uP = parseFloat(String(exPos.unrealizedProfit ?? exPos.unrealisedPnl ?? exPos.unrealizedPnl ?? "0"))
            pos.exchangeData = {
              ...pos.exchangeData,
              markPrice: mP || pos.exchangeData?.markPrice,
              unrealizedPnL: uP || pos.exchangeData?.unrealizedPnL,
              syncedAt: Date.now(),
            }
            pos.updatedAt = Date.now()
            positionsToSave.push(pos) // BATCH: collect instead of save immediately
            delta.updated++
          } else {
            pos.status = "closed"
            pos.closedAt = Date.now()
            pos.closeReason = "duplicate_slot_pruned"
            pos.updatedAt = Date.now()
            // savePosition() moves it from the open index to the closed archive
            positionsToSave.push(pos) // BATCH: collect instead of save immediately
            delta.updated++
          }
          return delta
        }

        // Crash-recovery state: the prior worker durably transitioned this
        // position to `closing` before its venue request, then disappeared.
        // Wait only for the short token-lock lease; afterwards re-read the
        // authoritative venue snapshot and finish the same idempotent close.
        if (pos.status === "closing" || pos.status === "closing_partial") {
          const lockedAt = Number(pos.lockedAt || 0)
          if (lockedAt > 0 && Date.now() - lockedAt <= POSITION_MUTATION_LOCK_TTL_MS + 1_000) {
            return delta
          }
          if (!exPos && !recordExchangeAbsence(pos)) return delta
          const exitPrice = Number(
            (exPos as any)?.markPrice ??
            (exPos as any)?.lastPrice ??
            pos.exchangeData?.markPrice ??
            pos.averageExecutionPrice ??
            pos.entryPrice ??
            0,
          )
          const recovered = await closeLivePosition(
            connectionId,
            pos.id,
            exitPrice,
            exPos ? exchangeConnector : null,
            exPos ? "crash_recovery_pending_close" : "exchange_externally_closed",
          )
          if (recovered?.status === "closed") delta.closed++
          else if (recovered) delta.updated++
          return delta
        }

        if (exPos) {
          clearExchangeAbsence(pos)
          const markPrice = parseFloat(String(exPos.markPrice ?? exPos.indexPrice ?? exPos.lastPrice ?? "0"))
          const liqPrice  = parseFloat(String(exPos.liquidationPrice ?? exPos.liqPrice ?? "0"))
          const uPnl      = parseFloat(String(exPos.unrealizedProfit ?? exPos.unrealisedPnl ?? exPos.unrealizedPnl ?? "0"))
          const authoritativeSize = Math.abs(parseFloat(String(exPos.size ?? exPos.positionAmt ?? exPos.quantity ?? "0"))) || 0
          const authoritativeEntry = parseFloat(String(exPos.entryPrice ?? exPos.avgPrice ?? "0")) || 0

          pos.exchangeData = {
            ...pos.exchangeData,
            markPrice: markPrice || pos.exchangeData?.markPrice,
            liquidationPrice: liqPrice || pos.exchangeData?.liquidationPrice,
            unrealizedPnL: uPnl || pos.exchangeData?.unrealizedPnL,
            syncedAt: Date.now(),
          }
          pos.updatedAt = Date.now()
          await reconcileAuthoritativeExchangeQuantity(pos, authoritativeSize, authoritativeEntry)
          pos.submissionAbsentConfirmations = 0
          if (!pos.orderId && pos.submissionState === "unconfirmed") {
            const clientOrderId = getTrackedClientOrderId(pos, "entry")
            if (clientOrderId) {
              const recovered = await recoverEntryOrderByClientId(exchangeConnector, pos.symbol, clientOrderId)
              if (recovered) {
                pos.orderId = String(recovered.orderId || recovered.id)
                pos.submissionState = "confirmed"
                pushStep(pos, "entry_submission_recovered", true, `orderId=${pos.orderId} clientOrderId=${clientOrderId}`)
              }
            }
          }

          // ── Entry-order fill detection (reconcile path) ────────────���──
          let justFilled = false
          if (pos.status === "placed" || pos.status === "pending_fill" || pos.status === "placed_unconfirmed") {
            const exSize  = Math.abs(parseFloat(String(exPos.size ?? exPos.positionAmt ?? exPos.quantity ?? "0"))) || 0
            const exEntry = parseFloat(String(exPos.entryPrice ?? exPos.avgPrice ?? exPos.markPrice ?? "0")) || 0
            if (exSize > 0) {
              if (pos.executedQuantity <= 0) {
                pos.executedQuantity = exSize
                pos.remainingQuantity = 0
                pos.averageExecutionPrice = exEntry || pos.entryPrice
              }
              pos.status = "open"
              pos.statusReason = `confirmed_position_fallback: reconcile saw exchange position size=${exSize} avg=${pos.averageExecutionPrice}`
              pushStep(pos, "reconcile_fill_detected", true, pos.statusReason)
              pos.updatedAt = Date.now()
              justFilled = true
              await recordFillCountersOnce(connectionId, pos, pos.symbol, pos.direction || pos.side || "long")
            }

            if (pos.orderId) {
              try {
                const order = await exchangeConnector.getOrder(pos.symbol, pos.orderId)
                const statusLower = String(order?.status ?? "").toLowerCase()
                const orderFilledQty = parseFloat(String(order?.filledQty ?? order?.executedQty ?? "0")) || 0
                if (order && (statusLower === "filled" || statusLower === "partially_filled" || orderFilledQty > 0)) {
                  if (orderFilledQty > 0) {
                    pos.executedQuantity = orderFilledQty
                    pos.remainingQuantity = Math.max(0, pos.quantity - pos.executedQuantity)
                    pos.averageExecutionPrice = parseFloat(String(order.filledPrice ?? order.avgPrice ?? "0")) || pos.averageExecutionPrice || pos.entryPrice
                  }
                  pos.status = "open"
                  pos.statusReason = `confirmed_fill: reconcile order status=${statusLower} qty=${pos.executedQuantity}`
                  pushStep(pos, "reconcile_fill_detected", true, pos.statusReason)
                  pos.updatedAt = Date.now()
                  if (!justFilled) {
                    justFilled = true
                    await recordFillCountersOnce(connectionId, pos, pos.symbol, pos.direction || pos.side || "long")
                  }
                } else if (statusLower === "cancelled" || statusLower === "canceled" || statusLower === "rejected") {
                  pos.status = "rejected"
                  pos.closeReason = `entry_order_${statusLower}`
                  pos.closedAt = Date.now()
                  pos.updatedAt = Date.now()
                  await savePosition(pos)
                  delta.updated++
                  return delta
                }
              } catch {
                /* getOrder() may fail transiently — Layer 1 result stands */
              }
            }
          }

          if (pos.status === "placed" || pos.status === "pending_fill" || pos.status === "placed_unconfirmed") {
            await savePosition(pos)
            delta.updated++
            return delta
          }

          // ── Ownership guard ────────────────────�����─────���──────────────
          // Only arm SL/TP and issue force-closes on positions that carry
          // a system orderId ��� proof WE placed the entry order.
          // If orderId is absent, the exchange position at this
          // symbol+direction may have been opened manually by the operator
          // or by another system. We must not arm reduce-only orders or
          // close it. We still save the refreshed markPrice/PnL so the
          // dashboard reflects current unrealised PnL accurately.
          if (!pos.orderId) {
            await savePosition(pos)
            delta.updated++
            return delta
          }

          try {
            const protectionResult = await updateProtectionOrders(
              exchangeConnector,
              pos,
              justFilled ? "reconcile_fill_detected" : "reconcile",
              liveOrderIds,
            )
            if (protectionResult.changed) {
              delta.protectionRearmed++
              await savePosition(pos)
              delta.updated++
            }
          } catch (slTpErr) {
            console.warn(
              `${LOG_PREFIX} reconcile SL/TP heal error for ${pos.id}:`,
              slTpErr instanceof Error ? slTpErr.message : String(slTpErr),
            )
          }

          const crossed = await checkAndForceCloseOnSltpCross(
            connectionId,
            pos,
            markPrice,
            exchangeConnector,
          )
          if (crossed) {
            if (crossed !== "close_unconfirmed") delta.closed++
            else delta.updated++
            return delta
          }

          // ── Max-hold-time safety closer (reconcile path) ────────────
          const MAX_HOLD_TIME_MS = resolveMaxHoldMs(connectionId)
          const openedAt = pos.createdAt || pos.updatedAt || 0
          const heldMs = Date.now() - openedAt
          if (
            MAX_HOLD_TIME_MS > 0 &&
            heldMs > MAX_HOLD_TIME_MS &&
            pos.executedQuantity > 0 &&
            isSystemTrackedLivePosition(pos, connectionId) &&
            (pos.status === "open" || pos.status === "filled")
          ) {
            const exitPrice = markPrice || pos.averageExecutionPrice || pos.entryPrice
            console.warn(
              `${LOG_PREFIX} [reconcile] MAX HOLD TIME exceeded for ${pos.symbol} (held ${Math.round(heldMs / 60000)}min) — force-closing`,
            )
            await logProgressionEvent(
              connectionId,
              "live_trading",
              "warning",
              `Max hold time exceeded for ${pos.symbol} — force-closing (reconcile)`,
              { positionId: pos.id, heldMs, maxHoldMs: MAX_HOLD_TIME_MS, exitPrice },
            )
            const closeResult = await closeLivePosition(
              connectionId,
              pos.id,
              exitPrice,
              exchangeConnector,
              "max_hold_time_exceeded",
            )
            if (closeResult?.status === "closed") delta.closed++
            else delta.updated++
            return delta
          }

          await savePosition(pos)
          delta.updated++
        } else {
          if (!recordExchangeAbsence(pos)) return delta
          if (pos.status === "placed" || pos.status === "pending_fill" || pos.status === "placed_unconfirmed") {
            let terminalEntryStatus = ""
            const clientOrderId = getTrackedClientOrderId(pos, "entry")
            if (!pos.orderId && clientOrderId) {
              const recovered = await recoverEntryOrderByClientId(exchangeConnector, pos.symbol, clientOrderId)
              if (recovered) {
                pos.orderId = String(recovered.orderId || recovered.id)
                pos.submissionState = "confirmed"
                pos.submissionAbsentConfirmations = 0
                pushStep(pos, "entry_submission_recovered", true, `orderId=${pos.orderId} clientOrderId=${clientOrderId}`)
              } else if (liveOrderIds !== null && !liveOrderIds.has(clientOrderId)) {
                pos.submissionAbsentConfirmations = Number(pos.submissionAbsentConfirmations || 0) + 1
                if (pos.submissionAbsentConfirmations >= 2) {
                  pos.status = "rejected"
                  pos.submissionState = "confirmed"
                  pos.statusReason = "clientOrderId confirmed absent repeatedly; releasing durable slot"
                  pos.closeReason = pos.statusReason
                  pos.closedAt = Date.now()
                  pushStep(pos, "entry_submission_absent", false, pos.statusReason)
                  await savePosition(pos)
                  if (pos.liveLockToken) {
                    await releaseLock(connectionId, pos.symbol, pos.direction || "long", pos.liveLockToken).catch(() => false)
                  }
                  delta.updated++
                  return delta
                }
              }
            }
            if (pos.orderId && typeof exchangeConnector.getOrder === "function") {
              try {
                const order = await exchangeConnector.getOrder(pos.symbol, pos.orderId)
                terminalEntryStatus = String(order?.status ?? "").toLowerCase()
              } catch { /* transient getOrder failure — keep waiting for position visibility */ }
            }
            if (terminalEntryStatus === "cancelled" || terminalEntryStatus === "canceled" || terminalEntryStatus === "rejected") {
              pos.status = "rejected"
              pos.statusReason = `entry_order_${terminalEntryStatus}`
              pos.closeReason = pos.statusReason
              pos.closedAt = Date.now()
            } else {
              pos.statusReason = pos.statusReason || "protection_deferred: awaiting exchange position size"
            }
            pos.updatedAt = Date.now()
            await savePosition(pos)
            delta.updated++
            return delta
          }
          // Position closed externally — compute PnL, move to archive.
          let exitPrice: number = Number(pos.exchangeData?.markPrice) || pos.averageExecutionPrice || 0
          if (exitPrice <= 0) {
            try {
              const mdHash = await client.hgetall(`market_data:${pos.symbol}`)
              const mdPrice = parseFloat(
                String(mdHash?.lastPrice ?? mdHash?.price ?? mdHash?.close ?? "0")
              )
              if (mdPrice > 0) exitPrice = mdPrice
            } catch { /* ignore — fall through to entryPrice */ }
          }
          if (exitPrice <= 0) exitPrice = pos.entryPrice || 0
          const qty      = pos.executedQuantity || pos.quantity || 0
          const avgEntry = pos.averageExecutionPrice || pos.entryPrice || 0

          let realizedPnl = 0
          if (exitPrice > 0 && avgEntry > 0 && qty > 0) {
            realizedPnl = qty *
              (pos.direction === "long" ? exitPrice - avgEntry : avgEntry - exitPrice)
          }

          if (pos.stopLossOrderId || pos.takeProfitOrderId) {
            const cancellations: Promise<boolean>[] = []
            if (pos.stopLossOrderId) {
              cancellations.push(
                cancelProtectionOrder(exchangeConnector, pos.symbol, pos.stopLossOrderId, "StopLoss", pos.connectionId),
              )
            }
            if (pos.takeProfitOrderId) {
              cancellations.push(
                cancelProtectionOrder(exchangeConnector, pos.symbol, pos.takeProfitOrderId, "TakeProfit", pos.connectionId),
              )
            }
            await Promise.all(cancellations).catch(() => {})
            pos.stopLossOrderId = undefined
            pos.takeProfitOrderId = undefined
          }

          // ── Do NOT call closePosition on the exchange here ────────────
          // This branch runs when the Redis-tracked position is absent
          // from the exchange's open-positions list. That means the
          // exchange has ALREADY closed it (SL/TP filled, liquidated,
          // or the operator closed it manually). Calling closePosition
          // here would therefore target any OTHER open position at the
          // same symbol+direction — including ones the operator placed
          // manually that the system did not create. We must not touch
          // those. The Redis record is closed locally by the code below;
          // no exchange action is required or safe.
          pos.status = "closed"
          pos.closedAt = Date.now()
          pos.realizedPnL = Math.round(realizedPnl * 100) / 100
          pos.closeReason = pos.closeReason || "exchange_reconciliation"
          pos.progression!.push({
            step: "close",
            timestamp: Date.now(),
            success: true,
            details: `Reconciled @ ${exitPrice.toFixed(8)} PnL=${realizedPnl.toFixed(4)}`,
          })
          pos.updatedAt = Date.now()

          const closedIndexKey = `live:positions:${connectionId}:closed`
          const movedMarker    = `live:positions:${connectionId}:moved:${pos.id}`

          // Read the dedupe marker BEFORE savePosition(). redis-db.savePosition()
          // sets this very marker when status==="closed" and ALSO moves the id
          // from the open index to the closed archive. Reading the marker after
          // the call would therefore always be truthy, permanently skipping the
          // close-counter increment below (externally-closed positions — SL/TP
          // fills, liquidations, manual closes — were never counted). The marker
          // is what dedupes this path against closeLivePosition().
          const alreadyMoved = await client.get(movedMarker).catch(() => null)

          // Persists the JSON snapshot + moves the index + sets the marker.
          await savePosition(pos)
          await advanceBlockCountPausesOnPositionClose(client, pos)

          const progKey = `progression:${connectionId}`
          const writes: Promise<any>[] = [
            client.expire(progKey, 7 * 24 * 60 * 60).catch(() => {}),
            // Bound the closed archive + refresh its TTL (savePosition does the
            // lpush move but not these housekeeping ops). Idempotent to repeat.
            client.ltrim(closedIndexKey, 0, 499).catch(() => {}),
            client.expire(closedIndexKey, 30 * 24 * 60 * 60).catch(() => {}),
          ]
          if (pos.liveLockToken) {
            writes.push(releaseLock(connectionId, pos.symbol, pos.direction || "long", pos.liveLockToken).catch(() => false))
          }
          if (!alreadyMoved) {
            // Counter increments are the ONLY ops that must be deduped across
            // the closeLivePosition + reconcile paths — the index move inside
            // savePosition() is already idempotent, so we no longer repeat the
            // lrem/lpush here (doing so double-pushed the id into the archive).
            writes.push(
              client.hincrby(progKey, "live_positions_closed_count", 1).catch(() => {}),
            )
            if (realizedPnl > 0) {
              writes.push(client.hincrby(progKey, "live_wins_count", 1).catch(() => {}))
            }
          }
          await Promise.all(writes)

          delta.closed++
        }
      } catch (err) {
        delta.errors++
        console.warn(
          `${LOG_PREFIX} reconcile per-position error for ${pos.id}:`,
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
): Promise<{ processed: number; closed: number; errors: number }> {
  const summary = { processed: 0, closed: 0, errors: 0 }
  try {
    await initRedis()
    const allOpen = await getLivePositions(connectionId)
    const sims = allOpen.filter(
      (p) => p.status === "simulated" && (p.executedQuantity ?? 0) > 0,
    )
    if (sims.length === 0) return summary

    // Pull current prices in one parallel batch (independent Redis reads).
    const uniqueSyms = Array.from(new Set(sims.map((p) => p.symbol)))
    const priceMap = new Map<string, number>()
    await Promise.all(
      uniqueSyms.map(async (sym) => {
        const px = await fetchCurrentPrice(sym).catch(() => 0)
        if (px > 0) priceMap.set(sym, px)
      }),
    )

    const MAX_HOLD_TIME_MS = resolveMaxHoldMs(connectionId)
    for (const pos of sims) {
      summary.processed++
      try {
        const markPrice = priceMap.get(pos.symbol) || pos.averageExecutionPrice || 0
        if (markPrice > 0) {
          pos.exchangeData = {
            ...pos.exchangeData,
            markPrice,
            syncedAt: Date.now(),
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
            if (crossed !== "close_unconfirmed") summary.closed++
            continue
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
          if (closeResult?.status === "closed") summary.closed++
          else summary.errors++
          continue
        }
        // Persist refreshed mark price so the dashboard reads fresh data.
        if (markPrice > 0) {
          await savePosition(pos)
        }
      } catch (err) {
        summary.errors++
        console.warn(
          `${LOG_PREFIX} processSimulatedPositions per-pos error for ${pos.id}:`,
          err instanceof Error ? err.message : String(err),
        )
      }
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
    // Previously each status filter triggered a full getLivePositions() scan,
    // meaning we fetched the same open-positions index from Redis FOUR times
    // just to bucket by status. Load once, then filter in memory.
    const allOpenRaw = await getLivePositions(connectionId)

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
            await client.lrem(openIndexKey, 0, p.id).catch(() => 0)
            const already = await client.lpos(closedIndexKey, p.id).catch(() => null)
            if (already === null || already === undefined) {
              await client.lpush(closedIndexKey, p.id).catch(() => 0)
              newlyMoved++
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
    const allOpen = allOpenRaw.filter((p) => !TERMINAL_SYNC_STATUSES.has(String(p.status)))

    const openPositions = allOpen.filter(
      (p) => p.status === "open" || p.status === "filled" || p.status === "partially_filled" || p.status === "placed" || p.status === "pending_fill" || p.status === "placed_unconfirmed" || p.status === "closing" || p.status === "closing_partial",
    )

    // If the operator requested live trading but the transport test failed,
    // QuickStart leaves the progression running with is_live_trade=0. In that
    // state the close/sync loop must not poll private exchange endpoints for
    // positions/open orders; doing so produced continuous "fetch failed" error
    // spam in dev and could make closed legacy live records look actionable.
    // Simulated positions still get processed locally below.
    const liveTradeOn = await isLiveTradeEnabledForConnection(connectionId)
    if (!liveTradeOn) {
      const simSummary = await processSimulatedPositions(connectionId)
      const statusBreakdown = allOpen.reduce<Record<string, number>>((acc, p) => {
        const s = String(p.status || "unknown")
        acc[s] = (acc[s] || 0) + 1
        return acc
      }, {})
      console.log(
        `${LOG_PREFIX} [sync-skip] conn=${connectionId} live_trade=false; ` +
        `skipped private exchange sync, tracked=${allOpen.length}, ` +
        `simProcessed=${simSummary.processed}, simClosed=${simSummary.closed}, ` +
        `statuses=${JSON.stringify(statusBreakdown)}`,
      )
      return
    }

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
            // Within 60 s of close — exchange may still report position
            // until the close fill propagates. After that window treat
            // it as truly closed and orphan-adopt if it reappears.
            if (closedAgoMs < 60_000) {
              trackedKeys.add(`${normSym(p.symbol)}|${p.direction}`)
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
              const size = Math.abs(parseFloat(String(exPos.size ?? (exPos as any).positionAmt ?? exPos.quantity ?? "0")))
              if (!size || size <= 0) continue
              // Determine direction. BingX returns "LONG"/"SHORT" in
              // `positionSide`; some venues encode via signed size.
              const sideRaw = String(
                exPos.side ?? (exPos as any).positionSide ?? (parseFloat(String(exPos.size ?? "0")) < 0 ? "short" : "long"),
              ).toLowerCase()
              const direction: "long" | "short" =
                sideRaw.includes("short") || sideRaw === "sell" ? "short" : "long"

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
                  liquidationPrice: parseFloat(String(exPos.liquidationPrice ?? "0")) || undefined,
                  unrealizedPnL: parseFloat(String(exPos.unrealizedProfit ?? exPos.unrealizedPnl ?? "0")) || undefined,
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
      const size = Math.abs(parseFloat(String(ep.size ?? (ep as any).positionAmt ?? ep.quantity ?? "0")))
      if (!size || size <= 0) continue // skip flat / zero-size entries
      const sideRaw = String(
        ep.side ?? (ep as any).positionSide ?? (parseFloat(String(ep.size ?? "0")) < 0 ? "short" : "long"),
      ).toLowerCase()
      const direction: "long" | "short" =
        sideRaw.includes("short") || sideRaw === "sell" ? "short" : "long"
      exchangeMap.set(`${sym}|${direction}`, ep)
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
          const markPrice = parseFloat(String(exchangePos.markPrice ?? exchangePos.indexPrice ?? exchangePos.lastPrice ?? "0")) || 0
          const liqPrice  = parseFloat(String(exchangePos.liquidationPrice ?? exchangePos.liqPrice ?? "0")) || 0
          const uPnl      = parseFloat(String(exchangePos.unrealizedProfit ?? exchangePos.unrealisedPnl ?? exchangePos.unrealizedPnl ?? "0")) || 0
          position.exchangeData = {
            ...position.exchangeData,
            marginType: (exchangePos as any).marginType,
            markPrice: markPrice || position.exchangeData?.markPrice,
            liquidationPrice: liqPrice || position.exchangeData?.liquidationPrice,
            unrealizedPnL: uPnl || position.exchangeData?.unrealizedPnL,
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
          await reconcileAuthoritativeExchangeQuantity(position, authoritativeSize, exEntry)
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
                  await releaseLock(connectionId, position.symbol, position.direction || "long", position.liveLockToken).catch(() => false)
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
          if (exSize > 0) {
            position.executedQuantity = exSize
            position.remainingQuantity = Math.max(0, (position.quantity || exSize) - exSize)
            position.averageExecutionPrice = exEntry || position.entryPrice
            position.status = "open"
            position.statusReason = `confirmed_position_fallback: sync saw exchange position size=${exSize} avg=${position.averageExecutionPrice}`
            position.updatedAt = Date.now()
            justFilled = true
            await recordFillCountersOnce(connectionId, position, position.symbol, position.direction || position.side || "long")
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
              await recordFillCountersOnce(connectionId, position, position.symbol, position.direction || position.side || "long")
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
        await client.lpush(`live:positions:${position.connectionId}`, position.id)
        await client.ltrim(`live:positions:${position.connectionId}`, 0, 999)
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
 *   - `pseudoPos.stoploss_ratio` / `pseudoPos.takeprofit_factor`
 *     (ratio form, e.g. 0.02 = 2%) OR `pseudoPos.stopLoss` /
 *     `pseudoPos.takeProfit` (percent form). Auto-detected by
 *     magnitude — anything < 1 is treated as ratio and multiplied by
 *     100, anything ≥ 1 is treated as already-percent.
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
    const side: "long" | "short" = pseudoPos?.side === "short" ? "short" : "long"
    if (!symbol) return

    const rawSL = Number(pseudoPos?.stoploss_ratio ?? pseudoPos?.stopLoss ?? NaN)
    const rawTP = Number(pseudoPos?.takeprofit_factor ?? pseudoPos?.takeProfit ?? NaN)
    if (!Number.isFinite(rawSL) && !Number.isFinite(rawTP)) return

    // Ratio (< 1) → percent; already-percent (≥ 1) → keep as-is.
    let slPct = Number.isFinite(rawSL) ? (Math.abs(rawSL) < 1 ? rawSL * 100 : rawSL) : undefined
    const tpPct = Number.isFinite(rawTP) ? (Math.abs(rawTP) < 1 ? rawTP * 100 : rawTP) : undefined

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
      pseudoPos?.set_id || pseudoPos?.config_set_key || pseudoPos?.source_set_key || "",
    ).trim()

    const livePositions = await getLivePositions(connectionId)
    const slotMatches = livePositions.filter((p: any) => {
      const liveSide: "long" | "short" =
        p.direction === "short" || p.side === "short" ? "short" : "long"
      return String(p.symbol || "").toUpperCase() === symbol && liveSide === side && p.status !== "closed"
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
          let effectiveSlPct = slPct
          // CRITICAL: Guard trailing stop calculation against NaN and division errors
          if (trailingActive && Number.isFinite(trailingStopPrice) && trailingStopPrice > 0) {
            const fill = Number(livePos.averageExecutionPrice || livePos.entryPrice || 0)
            // Ensure fill price is valid and positive before using in division
            if (Number.isFinite(fill) && fill > 0) {
              const liveSide: "long" | "short" =
                livePos.direction === "short" ? "short" : "long"
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
  async refreshLockTTLWithClient(client: any, key: string, token: string, ttlMs: number) {
    return (await evalLockLua(client, REFRESH_LOCK_TTL_LUA, key, [token, String(ttlMs)])) === 1
  },
  async releaseLockWithClient(client: any, key: string, token: string) {
    return (await evalLockLua(client, RELEASE_LOCK_LUA, key, [token])) === 1
  },
  computeDesiredProtectionPrices,
  settleControlOrdersBeforeSystemClose,
  settleControlOrdersBeforeQuantityMutation,
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
