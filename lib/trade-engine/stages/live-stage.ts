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
import { assertMarginCallEntryAllowed, monitorConnectionMarginCall } from "@/lib/margin-call"
import { emitCanonicalEvent } from "@/lib/events/emitter"
import { VolumeCalculator } from "@/lib/volume-calculator"
import {
  normalizeExchangeQuantityRules,
  roundQuantityDown,
  roundQuantityUp,
  resolveExecutableQuantity,
} from "@/lib/order-quantity"
import { fetchBingXInstrumentRules } from "@/lib/bingx-instrument-rules"
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
  readOrderSettlement,
  resolveLiveOrderExposureCeiling,
  setupLiveOrderMarginAndLeverage,
} from "@/lib/live-order-service"
import {
  LIVE_CLOSED_INDEX_LIMIT,
  LIVE_TERMINAL_RETENTION_SECONDS,
  liveRetentionSecondsForStatus,
} from "@/lib/redis-retention"
import type { ExchangeOrderSettlement } from "@/lib/exchange-connectors/base-connector"
import {
  isConnectionMainProcessing,
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
  calculateBlockVolumeMultiplier,
  calculateBlockVolumeIncrementRatio,
  normalizeBlockIncrementSteps,
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
import { buildLivePositionCompatibilitySnapshot } from "@/lib/live-position-mirror"
import { isLiveOpenStatus } from "@/lib/live-position-status"
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
  calculateObservedSpread,
  effectivePositionCostPercent,
  normalizePositionCostPercent,
  stopLossPositionCostRatioToPercent,
  takeProfitPositionCostRatioToPercent,
  type PositionCostQuote,
} from "@/lib/position-cost"
import { normalizeMarketType, type MarketType } from "@/lib/market-types"
import { marketDataKey } from "@/lib/market-data-keys"
import { tradingPairKey } from "@/lib/trading-pair-keys"
import {
  DEFAULT_FOREX_LOT_SIZE,
  forexNotionalUsd,
  forexPairCurrencies,
  forexPriceMovePnlUsd,
  forexQuoteToUsdRate,
  getForexInstrumentSpec,
  isForexSymbol,
  normalizeForexSymbol,
} from "@/lib/forex-market"
import {
  MAX_STOP_LOSS_TO_TAKE_PROFIT_RATIO,
  normalizeProtectionPercentages,
} from "@/lib/trade-protection-contract"
import { logRuntimeError, logRuntimeInfo, logRuntimeWarning } from "@/lib/runtime-log-throttle"
import { archiveClosedLivePositionAnalytics } from "@/lib/live-position-analytics-archive"
import { concurrencyFromEnv, mapWithConcurrency } from "@/lib/bounded-concurrency"
import { scanRedisSetMembers } from "@/lib/redis-scan"
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
import {
  reconcileExchangeQuantityAdjustments,
  type ExchangeQuantityAdjustmentRecord,
} from "@/lib/exchange-quantity-ledger"
import {
  aggregateProtectionSlot,
  buildAggregateProtectionPlans,
  type AggregateProtectionPlan,
} from "@/lib/aggregate-protection-coordination"
import { getRuntimeMaintenanceState } from "@/lib/runtime-maintenance"
import {
  auditProtectionSlotOrders,
  isConnectionOwnedProtectionOrderForSlot,
  isProtectionControlOrderForSlot,
  normalizeProtectionSlotSymbol,
  protectionOrderIdentifiers,
  protectionOrderVenueId,
  type ProtectionSlotDirection,
  type ProtectionSlotOrderAudit,
} from "@/lib/protection-slot-order-audit"
import {
  connectionTrackingId,
  isConnectionOwnedClientOrderId,
  isExactSystemPositionOwner,
} from "@/lib/system-order-ownership"
import {
  auditLiveEntryProtectionAdmission,
  type LiveEntryProtectionAdmissionAudit,
} from "@/lib/live-entry-protection-admission"
import { recordLivePositionLifetimeContribution } from "@/lib/live-position-lifetime-summary"
import { evaluateDirectTradeLiveReadiness } from "@/lib/direct-trade-live-readiness"
import { resolveDirectTradeLifecycleConnector } from "@/lib/direct-trade-lifecycle-connector"

interface LiveInstrumentRules {
  quantityStep: number
  quantityPrecision: number
  minQuantity: number
  minNotionalUsdt: number
  pricePrecision?: number
  priceTick?: number
}

const BINGX_INSTRUMENT_RULES_CACHE_TTL_MS = 15 * 60_000
const BINGX_PERSISTED_RULES_MAX_AGE_MS = 24 * 60 * 60_000
const bingXInstrumentRulesCache = new Map<string, {
  expiresAt: number
  rules: LiveInstrumentRules
}>()

function firstFinitePositive(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

function optionalBoundedInteger(value: unknown, max = 18): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed)
    ? Math.max(0, Math.min(max, Math.floor(parsed)))
    : undefined
}

function normalizeLiveInstrumentRules(raw: Record<string, unknown> | null | undefined): LiveInstrumentRules {
  const source = raw || {}
  const quantity = normalizeExchangeQuantityRules(source)
  const pricePrecision = optionalBoundedInteger(
    source.pricePrecision ?? source.price_precision,
  )
  const priceTick = firstFinitePositive(
    source.priceTick,
    source.price_tick,
    source.tickSize,
    source.tick_size,
    source.priceStep,
    pricePrecision !== undefined ? 10 ** -pricePrecision : undefined,
  )
  return {
    ...quantity,
    ...(pricePrecision !== undefined ? { pricePrecision } : {}),
    ...(priceTick !== undefined ? { priceTick } : {}),
  }
}

function applyLiveInstrumentRules(
  position: Pick<LivePosition, "quantityStep" | "quantityPrecision" | "pricePrecision" | "priceTick">,
  raw: Record<string, unknown> | LiveInstrumentRules | null | undefined,
): LiveInstrumentRules {
  const rules = normalizeLiveInstrumentRules(raw as Record<string, unknown> | null | undefined)
  position.quantityStep = rules.quantityStep
  position.quantityPrecision = rules.quantityPrecision
  position.pricePrecision = rules.pricePrecision
  position.priceTick = rules.priceTick
  return rules
}

function bingXEnvironmentInfo(connector: any): { environment: string; baseUrl: string } | null {
  if (!connector || typeof connector.getEnvironmentInfo !== "function") return null
  try {
    const info = connector.getEnvironmentInfo()
    const environment = String(info?.environment || "")
    const baseUrl = String(info?.baseUrl || "")
    return (environment === "prod-live" || environment === "prod-vst") && baseUrl
      ? { environment, baseUrl }
      : null
  } catch {
    return null
  }
}

async function loadExchangeQuantityRules(
  symbol: string,
  connector?: any,
  connectionId?: string,
): Promise<LiveInstrumentRules> {
  const normalizedSymbol = String(symbol || "").trim().toUpperCase().replace(/[-/_:]/g, "")
  const client = getRedisClient() as any
  let stored: Record<string, unknown> = {}
  try {
    if (typeof client?.hgetall === "function") {
      stored = await client.hgetall(tradingPairKey(normalizedSymbol, connectionId)) || {}
    }
  } catch {
    stored = {}
  }

  let rules = normalizeLiveInstrumentRules(stored)
  const connectorMarketType = (() => {
    try {
      return normalizeMarketType(connector?.getEnvironmentInfo?.()?.marketType, connector?.exchange)
    } catch {
      return "crypto" as MarketType
    }
  })()
  if (connectorMarketType === "forex" || isForexSymbol(normalizedSymbol)) {
    const spec = getForexInstrumentSpec(normalizedSymbol)
    rules = normalizeLiveInstrumentRules({
      ...stored,
      quantityStep: firstFinitePositive(stored.quantityStep, stored.quantity_step, spec.minLot) || spec.minLot,
      quantityPrecision: optionalBoundedInteger(stored.quantityPrecision ?? stored.quantity_precision) ?? 2,
      minQuantity: firstFinitePositive(stored.minQuantity, stored.min_order_size, spec.minLot) || spec.minLot,
      pricePrecision: optionalBoundedInteger(stored.pricePrecision ?? stored.price_precision) ?? spec.digits,
      priceTick: firstFinitePositive(stored.priceTick, stored.price_tick, 10 ** -spec.digits) || 10 ** -spec.digits,
    })
    return rules
  }
  const environment = bingXEnvironmentInfo(connector)
  if (environment && normalizedSymbol) {
    const cacheKey = `${environment.baseUrl}|${normalizedSymbol}`
    const cached = bingXInstrumentRulesCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.rules
    try {
      const fetched = await fetchBingXInstrumentRules(normalizedSymbol, fetch, environment.baseUrl)
      const pricePrecision = optionalBoundedInteger(fetched.pricePrecision) ?? 8
      const exact = {
        ...stored,
        quantityStep: fetched.quantityStep,
        quantityPrecision: fetched.quantityPrecision,
        minQuantity: fetched.minQuantity,
        minNotionalUsdt: fetched.minNotionalUsdt,
        pricePrecision,
        priceTick: 10 ** -pricePrecision,
      }
      rules = normalizeLiveInstrumentRules(exact)
      bingXInstrumentRulesCache.set(cacheKey, {
        expiresAt: Date.now() + BINGX_INSTRUMENT_RULES_CACHE_TTL_MS,
        rules,
      })
      if (typeof client?.hset === "function") {
        await client.hset(tradingPairKey(normalizedSymbol, connectionId), {
          quantityStep: String(rules.quantityStep),
          quantityPrecision: String(rules.quantityPrecision),
          minQuantity: String(rules.minQuantity),
          minNotionalUsdt: String(rules.minNotionalUsdt),
          pricePrecision: String(rules.pricePrecision),
          priceTick: String(rules.priceTick),
          instrumentRulesSource: "bingx_contracts",
          instrumentRulesFetchedAt: String(Date.now()),
        })
      }
    } catch (error) {
      const storedSource = String(stored.instrumentRulesSource || stored.instrument_rules_source || "")
      const storedFetchedAt = Number(stored.instrumentRulesFetchedAt || stored.instrument_rules_fetched_at || 0)
      const trustedPersistedRules = storedSource === "bingx_contracts"
        && storedFetchedAt > 0
        && Date.now() - storedFetchedAt <= BINGX_PERSISTED_RULES_MAX_AGE_MS
        && Number(rules.priceTick || 0) > 0
      console.warn(
        `${LOG_PREFIX} exact BingX instrument rules unavailable for ${normalizedSymbol}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      )
      if (!trustedPersistedRules) {
        // A generic `pricePrecision` may have been written by an older import
        // or another venue. It is not sufficient evidence for a real BingX
        // trigger grid, so live entry and security-stop arming fail closed.
        return { ...rules, priceTick: undefined }
      }
      bingXInstrumentRulesCache.set(cacheKey, {
        expiresAt: Date.now() + Math.min(BINGX_INSTRUMENT_RULES_CACHE_TTL_MS, 60_000),
        rules,
      })
    }
  }
  return rules
}

const LOG_PREFIX = "[v0] [LivePositionStage]"
const MIN_EXCHANGE_STOP_LOSS_PERCENT = 0.2
const SIGNAL_ADMISSION_LOCK_TTL_MS = 15_000
const SIGNAL_ADMISSION_WAIT_MS = 2_000
const ENTRY_PROTECTION_ADMISSION_LOCK_TTL_MS = 180_000
const ENTRY_PROTECTION_ADMISSION_WAIT_MS = 3_000
const SIGNAL_CAPACITY_NOTICE_INTERVAL_MS = 30_000
const SIGNAL_CAPACITY_NOTICE_MAX_CONNECTIONS = 128
type LiveExecutionIntent = "main" | "preset" | "signal" | "direct"

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
): "main" | "preset" | "signal" {
  if (intent === "direct") return "main"
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

type VenueTickerSnapshot = {
  bid: number
  ask: number
  last: number
  marketType?: MarketType
  digits?: number
  spreadPrice?: number
  spreadPips?: number
  spreadBps?: number
  spreadPercent?: number
  spreadSource?: "exchange_tick" | "broker_tick" | "unknown"
  timestamp?: number
  positionCostPercent?: number
}
type VenueTickerCacheEntry = {
  expiresAt: number
  ticker?: VenueTickerSnapshot
  pending?: Promise<VenueTickerSnapshot | null>
}

// Live execution must size and protect orders in the venue's own price domain.
// Historic/pseudo rows intentionally use normalized prices and must never be
// accepted as the reference for a real exchange mutation. A short, bounded
// single-flight cache avoids multiplying ticker requests when many Sets for the
// same symbol reach Live in one engine cycle.
const liveTickerCache = new Map<string, VenueTickerCacheEntry>()
const LIVE_TICKER_CACHE_TTL_MS = 1_000
const LIVE_TICKER_CACHE_MAX_SIZE = 256
const LIVE_TICKER_DEADLINE_MS = 8_000

function finitePositive(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function finiteOptional(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeVenueTicker(value: any, symbol?: string): VenueTickerSnapshot | null {
  if (!value || typeof value !== "object") return null
  const bid = finitePositive(value.bid ?? value.bidPrice ?? value.bestBid)
  const ask = finitePositive(value.ask ?? value.askPrice ?? value.bestAsk)
  const last = finitePositive(value.last ?? value.lastPrice ?? value.price ?? value.close)
  if (!(bid > 0 || ask > 0 || last > 0)) return null
  const normalizedSymbol = isForexSymbol(symbol || value.symbol)
    ? normalizeForexSymbol(symbol || value.symbol)
    : String(symbol || value.symbol || "").trim().toUpperCase()
  const marketType = normalizeMarketType(
    value.marketType ?? value.market_type,
    value.exchange || (isForexSymbol(normalizedSymbol) ? "instaforex" : undefined),
  )
  const quote: PositionCostQuote = {
    bid,
    ask,
    last,
    digits: finitePositive(value.digits ?? value.pricePrecision),
    timestamp: finitePositive(value.timestamp ?? value.time),
    marketType,
  }
  const observed = calculateObservedSpread(quote, normalizedSymbol)
  return {
    bid,
    ask,
    last,
    marketType,
    digits: quote.digits || undefined,
    spreadPrice: observed?.spreadPrice ?? (finitePositive(value.spreadPrice ?? value.spread_price) || undefined),
    spreadPips: observed?.spreadPips ?? (finitePositive(value.spreadPips ?? value.spread_pips) || undefined),
    spreadBps: observed?.spreadBps ?? (finitePositive(value.spreadBps ?? value.spread_bps) || undefined),
    spreadPercent: observed ? observed.spreadBps / 100 : (finitePositive(value.spreadPercent ?? value.spread_percent) || undefined),
    spreadSource: value.spreadSource === "broker_tick" || value.spreadSource === "exchange_tick" ? value.spreadSource : marketType === "forex" ? "broker_tick" : "unknown",
    timestamp: observed?.timestamp || quote.timestamp || undefined,
    positionCostPercent: finitePositive(value.positionCostPercent ?? value.position_cost_percent) || undefined,
  }
}

function selectVenueTickerPrice(
  ticker: VenueTickerSnapshot | null | undefined,
  direction: "long" | "short",
): number {
  if (!ticker) return 0
  return direction === "long"
    ? finitePositive(ticker.ask) || finitePositive(ticker.last) || finitePositive(ticker.bid)
    : finitePositive(ticker.bid) || finitePositive(ticker.last) || finitePositive(ticker.ask)
}

async function resolveAuthoritativeLiveReferencePrice(
  connectionId: string,
  symbol: string,
  direction: "long" | "short",
  connector: any,
): Promise<number> {
  const ticker = await resolveAuthoritativeLiveTicker(connectionId, symbol, connector)
  return selectVenueTickerPrice(ticker, direction)
}

async function resolveAuthoritativeLiveTicker(
  connectionId: string,
  symbol: string,
  connector: any,
): Promise<VenueTickerSnapshot | null> {
  if (!connector || typeof connector.getTicker !== "function") return null
  const normalizedSymbol = String(symbol || "").trim().toUpperCase()
  if (!normalizedSymbol) return null
  const key = `${connectionId}:${normalizedSymbol}`
  const now = Date.now()
  const cached = liveTickerCache.get(key)
  if (cached?.ticker && cached.expiresAt > now) {
    return cached.ticker
  }

  let pending = cached?.pending
  if (!pending) {
    pending = withTimeout(
      Promise.resolve(connector.getTicker(normalizedSymbol)),
      LIVE_TICKER_DEADLINE_MS,
      `getTicker(${normalizedSymbol})`,
    )
      .then((value) => normalizeVenueTicker(value, normalizedSymbol))
      .catch(() => null)
    liveTickerCache.set(key, { expiresAt: 0, pending })
    if (liveTickerCache.size > LIVE_TICKER_CACHE_MAX_SIZE) {
      const firstKey = liveTickerCache.keys().next().value
      if (firstKey && firstKey !== key) liveTickerCache.delete(firstKey)
    }
  }

  const ticker = await pending
  const current = liveTickerCache.get(key)
  if (current?.pending === pending) {
    if (ticker) {
      liveTickerCache.set(key, {
        ticker,
        expiresAt: Date.now() + LIVE_TICKER_CACHE_TTL_MS,
      })
    } else {
      liveTickerCache.delete(key)
    }
  }
  return ticker
}

/** Read the latest persisted broker/exchange tick for simulation and recovery. */
async function resolveCachedVenueTicker(symbol: string, connectionId?: string): Promise<VenueTickerSnapshot | null> {
  const normalizedSymbol = isForexSymbol(symbol) ? normalizeForexSymbol(symbol) : String(symbol || "").trim().toUpperCase()
  if (!normalizedSymbol) return null
  try {
    const { getMarketData, getRedisClient } = await import("@/lib/redis-db")
    const data = await getMarketData(normalizedSymbol, "1s", connectionId)
    const fromEnvelope = normalizeVenueTicker(data?.ticker, normalizedSymbol)
    if (fromEnvelope) return fromEnvelope
    const client = getRedisClient()
    const flatHash = await client.hgetall(marketDataKey(normalizedSymbol, "", connectionId)).catch(() => ({} as Record<string, string>))
    return normalizeVenueTicker(
      {
        ...flatHash,
        marketType: flatHash.market_type,
        spreadPrice: flatHash.spread_price,
        spreadPips: flatHash.spread_pips,
        spreadBps: flatHash.spread_bps,
        timestamp: flatHash.timestamp,
      },
      normalizedSymbol,
    )
  } catch {
    return null
  }
}

type ForexUsdConversion = { rate: number; source: "direct_quote" | "inverse_quote" }

/**
 * Resolve the quote-currency → USD leg required for a cross Forex pair.
 * Direct and inverse legs are both accepted, but the rate is never invented.
 */
async function resolveForexUsdConversion(
  connectionId: string,
  symbol: string,
  connector?: any,
  allowCached = false,
): Promise<ForexUsdConversion | null> {
  const pair = forexPairCurrencies(symbol)
  if (!pair || pair.quote === "USD" || pair.base === "USD") return null
  const directSymbol = pair.quote + "USD"
  const inverseSymbol = "USD" + pair.quote
  const read = async (candidate: string): Promise<VenueTickerSnapshot | null> => {
    const live = connector ? await resolveAuthoritativeLiveTicker(connectionId, candidate, connector) : null
    return live || (allowCached ? await resolveCachedVenueTicker(candidate, connectionId) : null)
  }
  const direct = await read(directSymbol)
  const directMid = direct ? (finitePositive(direct.bid) + finitePositive(direct.ask)) / 2 || finitePositive(direct.last) : 0
  if (directMid > 0) return { rate: directMid, source: "direct_quote" }
  const inverse = await read(inverseSymbol)
  const inverseMid = inverse ? (finitePositive(inverse.bid) + finitePositive(inverse.ask)) / 2 || finitePositive(inverse.last) : 0
  return inverseMid > 0 ? { rate: 1 / inverseMid, source: "inverse_quote" } : null
}

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
  takeProfitPct?: unknown,
): number {
  let candidateSl: number
  if (setVariant === "trailing" && trailingProfile && trailingProfile.stopRatio > 0) {
    // For trailing-variant positions the initial exchange SL is placed at the
    // trailing stop distance from entry. The trailing machine then ratchets this
    // upward (long) or downward (short) as price moves in our favour. Using the
    // trailing stopRatio ensures the initial order and the ratchet machine are
    // in sync from the first tick.
    const trailingSl = isSignalDynamicTrailingProfile(trailingProfile)
      ? Math.max(0.8, (trailingProfile.minStopRatio ?? trailingProfile.stopRatio) * 100)
      : trailingProfile.stopRatio * 100
    candidateSl = Math.max(MIN_EXCHANGE_STOP_LOSS_PERCENT, trailingSl)
  } else {
    // For all other variants (default, block, dca, pause) the PF-derived value
    // is already variant-adjusted (block: scaled up by sizeMultiplier, dca: 0.5×).
    // Enforce the minimum floor in all cases.
    candidateSl = Math.max(MIN_EXCHANGE_STOP_LOSS_PERCENT, derivedSl)
  }
  return normalizeProtectionPercentages({
    takeProfitPct,
    fallbackTakeProfitPct: MIN_EXCHANGE_STOP_LOSS_PERCENT,
    stopLossPct: candidateSl,
    minimumTakeProfitPct: MIN_EXCHANGE_STOP_LOSS_PERCENT,
    minimumStopLossPct: MIN_EXCHANGE_STOP_LOSS_PERCENT,
    maxStopLossToTakeProfitRatio: MAX_STOP_LOSS_TO_TAKE_PROFIT_RATIO,
  }).stopLossPct
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
// few seconds. Bound the first acknowledgement window, but keep observing the
// same delivery-ambiguous write long enough to cover connector queueing and
// time synchronization; returning early cannot cancel a POST already in flight.
const EXCHANGE_TIMEOUT_CANCEL_ORDER_MS  = 8_000   // cancel; retried next tick on failure
const EXCHANGE_TIMEOUT_PLACE_STOP_MS    = 8_000   // initial response deadline; ambiguous writes are reconciled below
// Do not hold a live-sync worker for a full extra 30 seconds after the
// acknowledgement deadline.  The durable client id was persisted before the
// POST left the process, so a short observation window followed by a bounded
// lookup is enough to avoid duplicate submissions while keeping other symbols
// responsive under a slow venue.
const EXCHANGE_AMBIGUOUS_PLACE_GRACE_MS = 3_000
const EXCHANGE_AMBIGUOUS_RECOVERY_MS    = 3_000
const EXCHANGE_TIMEOUT_GET_POSITIONS_MS = 8_000   // position fetch for adoption + sync prefetch
const EXCHANGE_TIMEOUT_GET_ORDER_MS     = 6_000   // fill detection; retry via next sync tick on miss
const SYSTEM_CLOSE_RETRY_DELAYS_MS = [60_000, 120_000, 240_000, 300_000] as const

type SystemCloseFailureClass =
  | "timeout"
  | "rate_limit"
  | "network"
  | "venue_unavailable"
  | "venue_rejection"
  | "invalid_response"

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

// Quantity-changing work temporarily removes every CTS-owned row/security
// control for a physical symbol/direction. Keep the hand-off visible to the same
// sync owner so it can perform a fresh, bounded re-arm before returning.  The
// durable marker on the position remains the restart-safe source of truth;
// this queue merely avoids waiting for an unrelated later tick.
const __aggregateProtectionFinalizeQueue = new Map<string, Set<string>>()
const AGGREGATE_PROTECTION_MUTATION_ABANDONED_MS = 60_000
function queueAggregateProtectionFinalization(connectionId: string, slot: string): void {
  if (!connectionId || !slot) return
  const queued = __aggregateProtectionFinalizeQueue.get(connectionId) ?? new Set<string>()
  queued.add(slot)
  __aggregateProtectionFinalizeQueue.set(connectionId, queued)
}
function queuedAggregateProtectionFinalizations(connectionId: string): Set<string> {
  return new Set(__aggregateProtectionFinalizeQueue.get(connectionId) ?? [])
}
function settleAggregateProtectionFinalizations(connectionId: string, slots: Iterable<string>): void {
  const queued = __aggregateProtectionFinalizeQueue.get(connectionId)
  if (!queued) return
  for (const slot of slots) queued.delete(slot)
  if (queued.size === 0) __aggregateProtectionFinalizeQueue.delete(connectionId)
}

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
export interface LivePosition {
  id: string
  connectionId: string
  symbol: string
  side?: "long" | "short"
  direction?: "long" | "short"
  entryPrice: number
  /** Explicit asset-class/unit metadata carried through Redis and reporting. */
  marketType?: MarketType
  volumeKind?: "base" | "lots"
  lotSize?: number
  /** Quote-currency → USD rate used for cross-pair notional/PnL. */
  quoteToUsdRate?: number
  /** Native broker position ticket required for exact Forex protection. */
  positionTicket?: number
  /** Hard live/VST notional ceiling returned by VolumeCalculator. */
  maxExecutionNotionalUsd?: number
  liveMultiplierCapped?: boolean
  quoteBid?: number
  quoteAsk?: number
  spreadPrice?: number
  spreadPips?: number
  spreadBps?: number
  spreadPercent?: number
  spreadSource?: "exchange_tick" | "broker_tick" | "unknown"
  quoteTimestamp?: number
  executedQuantity: number
  remainingQuantity: number
  averageExecutionPrice: number
  volumeUsd?: number
  /** Pre-venue requested quantity before quantity/notional floors. */
  requestedVolume?: number
  intendedNotionalUsd?: number
  exchangeMinNotionalUsd?: number
  /** Exact venue grids captured before any live order is submitted. */
  quantityStep?: number
  quantityPrecision?: number
  pricePrecision?: number
  priceTick?: number
  systemVolumeFactor?: number
  liveEngineFactor?: number
  signalVolumeFactor?: number
  volumeAdjusted?: boolean
  volumeAdjustmentReason?: string
  leverage: number
  marginType: "cross" | "isolated"
  unrealized_pnl?: number
  unrealized_pnl_percent?: number
  markPrice?: number
  liquidationPrice?: number
  realizedPnL?: number
  /** Venue-confirmed live PnL/fee ledger. Incomplete means no estimate was substituted. */
  realizedPnlGross?: number
  tradingFees?: number
  entryTradingFee?: number
  entryTradingFeeAllocated?: number
  entryAccountingComplete?: boolean
  entrySettlementOrderIds?: string[]
  realizedPnlComplete?: boolean
  realizedPnlSource?: "exchange_settlement" | "exchange_fills_incomplete_fees" | "exchange_unresolved" | "simulation_model"
  settledOrderIds?: string[]
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
  /** One exact-aggregate-quantity safety stop per physical symbol/direction slot. */
  securityStopOrderId?: string
  securityStopPrice?: number
  securityStopLastArmedAt?: number
  securityStopArmedQuantity?: number
  securityStopAbsenceConfirmations?: number
  securityStopRequired?: boolean
  securityStopStatus?: "armed" | "pending" | "unsupported" | "ownership_mismatch" | "system_close" | "invalid_range" | "capacity_blocked" | "quantity_mismatch"
  stopLossAbsenceConfirmations?: number
  takeProfitAbsenceConfirmations?: number
  // Epoch-ms timestamps of the last successful SL/TP placement on the venue.
  // Used by the MIN_REARM_MS cooldown to prevent repeated cancel-replace
  // storms when a position's price oscillates at the 0.25% drift boundary.
  stopLossLastArmedAt?: number
  takeProfitLastArmedAt?: number
  assignedStopLoss?: number
  assignedTakeProfit?: number
  /** Venue-confirmed protected quantity for each independent control leg. */
  stopLossArmedQuantity?: number
  takeProfitArmedQuantity?: number
  /** Legacy minimum armed quantity retained for older snapshots/readers. */
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
  closeOrderId?: string
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
    blockIncrementSteps?: number
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
  /**
   * Backoff after a failed system-owned close. This is intentionally separate
   * from pendingSystemAction: the pending action keeps an ambiguous delivery
   * on the same durable client id until it is reconciled, while this marker can
   * survive after confirmed absence so venue protection may be re-armed during
   * the bounded wait before a new close id is prepared.
   */
  systemCloseRetry?: {
    reason: string
    retryCount: number
    nextRetryAt: number
    lastFailureClass: SystemCloseFailureClass
    updatedAt: number
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
  pendingProtectionOrders?: Partial<Record<"stopLoss" | "takeProfit" | "securityStop", {
    clientOrderId: string
    triggerPrice: number
    quantity: number
    absenceConfirmations?: number
  }>>
  initialExecutedQuantity?: number
  initialEntryPrice?: number
  blockBaseQuantity?: number
  blockBaseVolumeMultiplier?: number
  blockVolumeRatio?: number
  blockIncrementSteps?: number
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
  /**
   * Quantity observed from an authoritative venue position that is not
   * represented by an individual local fill row. This remains separate from
   * `fills` so an unverified order/fee settlement is never fabricated.
   */
  exchangeQuantityAdjustments?: ExchangeQuantityAdjustment[]
  protectionMode?: "exchange_control" | "hybrid_control_system" | "system_close" | "system_close_fallback"
  /** Missing venue legs that remain protected by the engine-side price cross. */
  systemProtectionLegs?: ProtectionOrderLeg[]
  /** Last authoritative BingX control-order budget used for this position. */
  controlOrderCapacity?: ControlOrderCapacitySnapshot
  /**
   * Per exact Strategy-Set protection projection. Exchange venues net physical
   * exposure by symbol/direction. Every row owns exact-quantity SL/TP orders;
   * one elected row additionally owns the slot's farther quantity-backed stop.
   */
  controlOrderSetCoverage?: Record<string, {
    protected: boolean
    protectionMode: "exchange_control" | "hybrid_control_system" | "system_close" | "system_close_fallback"
    aggregateProtectionOwner: boolean
    aggregateProtectionKey?: string
    /** Position that owns the shared aggregate-quantity security stop for this physical slot. */
    aggregateProtectionLeaderId?: string
    stopLossOrderId?: string
    takeProfitOrderId?: string
    securityStopOrderId?: string
    stopLossPrice?: number
    takeProfitPrice?: number
    securityStopPrice?: number
    securityStopRequired?: boolean
    securityStopStatus?: LivePosition["securityStopStatus"]
    systemProtectionLegs: ProtectionOrderLeg[]
    updatedAt: number
  }>
  /** One physical symbol/direction slot owns exactly one security stop. */
  aggregateProtectionOwner?: boolean
  aggregateProtectionKey?: string
  aggregateProtectionMemberCount?: number
  aggregateProtectionQuantity?: number
  /** Durable hand-off: settle every row/security control before a member changes qty. */
  aggregateProtectionMutationRequestedAt?: number
  /** The aggregate reconciler has authoritatively settled the slot controls. */
  aggregateProtectionMutationSettledAt?: number
  aggregateProtectionMutationReason?: string
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

function positionUnitMultiplier(position: Pick<LivePosition, "marketType" | "volumeKind" | "lotSize" | "symbol">): number {
  return position.marketType === "forex" || position.volumeKind === "lots" || isForexSymbol(position.symbol)
    ? Math.max(1, Number(position.lotSize) || DEFAULT_FOREX_LOT_SIZE)
    : 1
}

function positionNotionalUsd(
  position: Pick<LivePosition, "marketType" | "volumeKind" | "lotSize" | "symbol" | "quoteToUsdRate">,
  quantity: number,
  price: number,
): number {
  const safeQuantity = Math.max(0, Number(quantity) || 0)
  const safePrice = Math.max(0, Number(price) || 0)
  const forex = position.marketType === "forex" || position.volumeKind === "lots" || isForexSymbol(position.symbol)
  if (forex) {
    return forexNotionalUsd(
      safeQuantity,
      safePrice,
      position.symbol,
      positionUnitMultiplier(position),
      position.quoteToUsdRate,
    )
  }
  return safeQuantity * safePrice
}

/**
 * Round an entry/add-on down to the remaining venue exposure budget. This is
 * deliberately separate from `resolveExecutableQuantity`: that helper may
 * round UP to satisfy an entry minimum, while a live risk boundary may never
 * increase the approved notional. A zero result means the venue minimum does
 * not fit and the caller must not submit an order.
 */
function quantityWithinRemainingNotional(
  position: Pick<LivePosition, "marketType" | "volumeKind" | "lotSize" | "symbol" | "quoteToUsdRate">,
  requestedQuantity: number,
  price: number,
  rules: LiveInstrumentRules,
  remainingNotionalUsd: number,
): { quantity: number; notionalUsd: number } {
  const requested = Number(requestedQuantity)
  const remaining = Number(remainingNotionalUsd)
  const unitNotional = positionNotionalUsd(position, 1, price)
  if (!(requested > 0) || !(remaining > 0) || !(unitNotional > 0)) {
    return { quantity: 0, notionalUsd: 0 }
  }
  const maximum = roundQuantityDown(remaining / unitNotional, rules)
  if (!(maximum > 0) || maximum + 1e-12 < rules.minQuantity) {
    return { quantity: 0, notionalUsd: 0 }
  }
  const quantity = roundQuantityDown(Math.min(requested, maximum), rules)
  const notionalUsd = positionNotionalUsd(position, quantity, price)
  if (
    !(quantity > 0)
    || quantity + 1e-12 < rules.minQuantity
    || !(notionalUsd > 0)
    || notionalUsd > remaining + 1e-8
  ) {
    return { quantity: 0, notionalUsd: 0 }
  }
  return { quantity, notionalUsd }
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

function classifySystemCloseFailure(error: unknown): SystemCloseFailureClass {
  const message = String(error || "").toLowerCase()
  if (message.includes("timeout") || message.includes("timed out")) return "timeout"
  if (message.includes("rate limit") || message.includes("429")) return "rate_limit"
  if (message.includes("econn") || message.includes("network") || message.includes("socket")) return "network"
  if (message.includes("502") || message.includes("503") || message.includes("unavailable")) {
    return "venue_unavailable"
  }
  if (!message || message === "invalid_response") return "invalid_response"
  return "venue_rejection"
}

function scheduleSystemCloseRetry(
  position: LivePosition,
  failure: unknown,
  nowMs = Date.now(),
): NonNullable<LivePosition["systemCloseRetry"]> {
  const previousCount = Math.max(0, Math.floor(Number(position.systemCloseRetry?.retryCount) || 0))
  const retryCount = previousCount + 1
  const delay = SYSTEM_CLOSE_RETRY_DELAYS_MS[
    Math.min(retryCount - 1, SYSTEM_CLOSE_RETRY_DELAYS_MS.length - 1)
  ]
  const retry = {
    reason: String(position.pendingSystemAction?.reason || position.systemCloseRetry?.reason || "system_close"),
    retryCount,
    nextRetryAt: nowMs + delay,
    lastFailureClass: classifySystemCloseFailure(failure),
    updatedAt: nowMs,
  } satisfies NonNullable<LivePosition["systemCloseRetry"]>
  position.systemCloseRetry = retry
  return retry
}

function isSystemCloseRetryDeferred(position: LivePosition, nowMs = Date.now()): boolean {
  return Number(position.systemCloseRetry?.nextRetryAt || 0) > nowMs
}

function hasUnresolvedSystemCloseDelivery(position: LivePosition): boolean {
  return Boolean(
    position.pendingSystemAction?.clientOrderId ||
    position.pendingSystemAction?.orderId,
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
  if (position.status === "simulated" || position.executionMode === "simulation") {
    // Paper fills are valid strategy-history evidence, but they are not real
    // venue fills. Keep real order/position counters exchange-only.
    return false
  }
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
  return connectionTrackingId(connectionId)
}

function makeSystemTrackingId(connectionId: string): string {
  return `sys-${connectionId}-${nanoid(10)}`
}

function isSystemTrackedLivePosition(position: Partial<LivePosition> | any, connectionId: string): boolean {
  return isExactSystemPositionOwner(position, connectionId)
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
  orderId?: string
  settlementSource?: string
  price: number
  quantity: number
  timestamp?: number
  fee?: number
  feeAsset?: string
}

type ExchangeQuantityAdjustment = ExchangeQuantityAdjustmentRecord & {
  source: "exchange_reconcile" | "legacy_reconciliation"
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
    settlement?: ExchangeOrderSettlement | null
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
  position.volumeUsd = positionNotionalUsd(
    position,
    result.nextQuantity,
    Number(position.averageExecutionPrice || position.entryPrice || 0),
  )

  const settlement = input.settlement && String(input.settlement.orderId || "") === String(input.orderId || input.settlement.orderId || "")
    ? input.settlement
    : null
  const executionPrice = Number(settlement?.averageFillPrice || input.price || 0)
  const entryPrice = Number(position.averageExecutionPrice || position.entryPrice || 0)
  const isSimulation = position.status === "simulated" || position.executionMode === "simulation"
  const previouslyComplete = position.realizedPnlComplete !== false
  if (settlement) {
    const representedQuantity = Math.max(0, Number(settlement.filledQuantity) || 0)
    const settlementRatio = representedQuantity > 0
      ? Math.min(1, result.deltaApplied / representedQuantity)
      : 0
    const grossDelta = (Number(settlement.grossRealizedPnl) || 0) * settlementRatio
    let netDelta = (Number(settlement.netRealizedPnl) || 0) * settlementRatio
    let allocatedEntryFee = 0
    if (!settlement.netIncludesEntryFee) {
      const remainingEntryFee = Math.max(
        0,
        (Number(position.entryTradingFee) || 0) - (Number(position.entryTradingFeeAllocated) || 0),
      )
      allocatedEntryFee = before > 0
        ? remainingEntryFee * Math.min(1, result.deltaApplied / before)
        : remainingEntryFee
      netDelta -= allocatedEntryFee
      position.entryTradingFeeAllocated = Number(((Number(position.entryTradingFeeAllocated) || 0) + allocatedEntryFee).toFixed(12))
    }
    position.realizedPnlGross = Number(((Number(position.realizedPnlGross) || 0) + grossDelta).toFixed(12))
    position.tradingFees = Number(((Number(position.tradingFees) || 0)
      + Math.max(0, Number(settlement.tradingFee) || 0) * settlementRatio
      + allocatedEntryFee).toFixed(12))
    position.realizedPnL = Number(((Number(position.realizedPnL) || 0) + netDelta).toFixed(12))
    position.settledOrderIds = Array.from(new Set([
      ...(position.settledOrderIds || []),
      settlement.orderId,
    ])).slice(-64)
    const complete = settlement.netIncludesEntryFee || position.entryAccountingComplete === true
    position.realizedPnlComplete = previouslyComplete && complete
    position.realizedPnlSource = position.realizedPnlComplete
      ? "exchange_settlement"
      : "exchange_fills_incomplete_fees"
  } else if (executionPrice > 0 && entryPrice > 0) {
    const realizedDelta = position.marketType === "forex" || position.volumeKind === "lots"
      ? forexPriceMovePnlUsd(
          position.direction === "short" ? "short" : "long",
          result.deltaApplied,
          entryPrice,
          executionPrice,
          position.symbol,
          positionUnitMultiplier(position),
          position.quoteToUsdRate,
        )
      : result.deltaApplied * (
          position.direction === "short"
            ? entryPrice - executionPrice
            : executionPrice - entryPrice
        )
    position.realizedPnL = Number((Number(position.realizedPnL || 0) + realizedDelta).toFixed(8))
    position.realizedPnlGross = Number((Number(position.realizedPnlGross || 0) + realizedDelta).toFixed(8))
    position.realizedPnlComplete = isSimulation ? previouslyComplete : false
    position.realizedPnlSource = isSimulation ? "simulation_model" : "exchange_fills_incomplete_fees"
  } else {
    // An authoritative quantity delta proves execution, but not its price or
    // fees. Preserve the quantity ledger and explicitly leave PnL unresolved;
    // a mark/trigger/requested price is never substituted for a real fill.
    position.realizedPnlComplete = false
    position.realizedPnlSource = "exchange_unresolved"
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

/**
 * Keep the immutable Block basis tied to the original entry order's
 * cumulative fill, not to the first partial acknowledgement. Later DCA,
 * Special and Block orders never call this helper and therefore cannot
 * inflate the base. The value only moves upward while the original entry
 * settlement becomes more complete.
 */
function reconcileInitialEntryBaseQuantity(
  position: LivePosition,
  cumulativeEntryFill: unknown,
): boolean {
  const observed = Number(cumulativeEntryFill)
  if (!(Number.isFinite(observed) && observed > 0)) return false
  const previousInitial = Math.max(0, Number(position.initialExecutedQuantity || 0))
  const previousBlockBase = Math.max(0, Number(position.blockBaseQuantity || 0))
  const nextInitial = Math.max(previousInitial, observed)
  const nextBlockBase = Math.max(previousBlockBase, nextInitial)
  const changed = nextInitial !== previousInitial || nextBlockBase !== previousBlockBase
  position.initialExecutedQuantity = nextInitial
  position.blockBaseQuantity = nextBlockBase
  return changed
}

async function refreshEntryOrderAccounting(
  connector: any,
  position: LivePosition,
): Promise<boolean> {
  if (!connector) return false
  const entryOrderIds = Array.from(new Set([
    String(position.orderId || ""),
    ...(position.fills || []).map((fill) => String(fill.orderId || "")),
  ].filter(Boolean)))
  if (entryOrderIds.length === 0) {
    position.entryAccountingComplete = false
    return false
  }
  const entrySettlements = (await Promise.all(
    entryOrderIds.map((orderId) => readOrderSettlement(connector, position.symbol, orderId)),
  )).filter((value): value is ExchangeOrderSettlement => Boolean(value))
  const byOrderId = new Map(entrySettlements.map((settlement) => [settlement.orderId, settlement]))
  const originalEntrySettlement = position.orderId
    ? byOrderId.get(String(position.orderId))
    : undefined
  if (originalEntrySettlement) {
    reconcileInitialEntryBaseQuantity(position, originalEntrySettlement.filledQuantity)
  }
  position.entryTradingFee = Number(entrySettlements
    .reduce((sum, settlement) => sum + Math.max(0, Number(settlement.tradingFee) || 0), 0)
    .toFixed(12))
  position.entrySettlementOrderIds = [...byOrderId.keys()]
  position.entryAccountingComplete = entryOrderIds.every((orderId) => byOrderId.has(orderId))
  position.fills = (position.fills || []).map((fill) => {
    const settlement = fill.orderId ? byOrderId.get(String(fill.orderId)) : null
    return settlement
      ? { ...fill, fee: settlement.tradingFee, settlementSource: settlement.source }
      : fill
  })
  return position.entryAccountingComplete
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

/**
 * Normalize the durable percentage pair immediately before an exchange or
 * paper protection calculation.  This is the last common boundary shared by
 * initial placement, accumulation, restart recovery and operator re-arm, so
 * an imported/stale position cannot reintroduce a missing stop or widen SL
 * beyond the systemwide 1.5×TP contract.
 */
function normalizeLivePositionProtection(
  position: Pick<LivePosition, "takeProfit" | "stopLoss">,
): { takeProfitPct: number; stopLossPct: number } {
  const protection = normalizeProtectionPercentages({
    takeProfitPct: position.takeProfit,
    fallbackTakeProfitPct: MIN_EXCHANGE_STOP_LOSS_PERCENT,
    stopLossPct: position.stopLoss,
    fallbackStopLossPct: MIN_EXCHANGE_STOP_LOSS_PERCENT,
    minimumTakeProfitPct: MIN_EXCHANGE_STOP_LOSS_PERCENT,
    minimumStopLossPct: MIN_EXCHANGE_STOP_LOSS_PERCENT,
    maxStopLossToTakeProfitRatio: MAX_STOP_LOSS_TO_TAKE_PROFIT_RATIO,
  })
  position.takeProfit = protection.takeProfitPct
  position.stopLoss = protection.stopLossPct
  return {
    takeProfitPct: protection.takeProfitPct,
    stopLossPct: protection.stopLossPct,
  }
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
  const terminal = liveRetentionSecondsForStatus(position.status) !== null
  const index = stage.positions.findIndex((candidate: LivePosition) => candidate.id === position.id)
  if (terminal) {
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
  return isLiveOpenStatus(status)
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
    position.systemCloseRetry ? JSON.stringify(position.systemCloseRetry) : "",
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
    marketType: normalizeMarketType(
      hash.marketType ?? hash.market_type,
      hash.exchange || (isForexSymbol(hash.symbol) ? "instaforex" : undefined),
    ),
    volumeKind: String(hash.volumeKind ?? hash.volume_kind).trim().toLowerCase() === "lots"
      ? "lots"
      : "base",
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
    ...(parseRedisBoolean(hash.trailingActive) !== undefined && {
      trailingActive: parseRedisBoolean(hash.trailingActive),
    }),
    ...(parseRedisBoolean(hash.volumeAdjusted) !== undefined && {
      volumeAdjusted: parseRedisBoolean(hash.volumeAdjusted),
    }),
    ...(parseRedisBoolean(hash.aggregateProtectionOwner) !== undefined && {
      aggregateProtectionOwner: parseRedisBoolean(hash.aggregateProtectionOwner),
    }),
    ...(parseRedisBoolean(hash.securityStopRequired) !== undefined && {
      securityStopRequired: parseRedisBoolean(hash.securityStopRequired),
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
    systemCloseRetry: typeof hash.systemCloseRetry === "string"
      ? safeJsonParse<LivePosition["systemCloseRetry"]>(hash.systemCloseRetry, undefined)
      : hash.systemCloseRetry,
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
    exchangeQuantityAdjustments: Array.isArray(hash.exchangeQuantityAdjustments)
      ? hash.exchangeQuantityAdjustments
      : safeJsonParse<ExchangeQuantityAdjustment[]>(hash.exchangeQuantityAdjustments, []),
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
    "requestedVolume",
    "intendedNotionalUsd",
    "exchangeMinNotionalUsd",
    "quantityStep",
    "quantityPrecision",
    "pricePrecision",
    "priceTick",
    "systemVolumeFactor",
    "liveEngineFactor",
    "signalVolumeFactor",
    "leverage",
    "unrealized_pnl",
    "unrealized_pnl_percent",
    "markPrice",
    "current_price",
    "liquidationPrice",
    "realizedPnL",
    "realized_pnl",
    "positionCostPct",
    "lotSize",
    "quoteToUsdRate",
    "quoteBid",
    "quoteAsk",
    "spreadPrice",
    "spreadPips",
    "spreadBps",
    "spreadPercent",
    "quoteTimestamp",
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
    "securityStopPrice",
    "stopLossLastArmedAt",
    "takeProfitLastArmedAt",
    "securityStopLastArmedAt",
    "assignedStopLoss",
    "assignedTakeProfit",
    "stopLossArmedQuantity",
    "takeProfitArmedQuantity",
    "protectionArmedQuantity",
    "securityStopArmedQuantity",
    "securityStopAbsenceConfirmations",
    "stopLossAbsenceConfirmations",
    "takeProfitAbsenceConfirmations",
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
    "blockIncrementSteps",
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
    "aggregateProtectionMemberCount",
    "aggregateProtectionQuantity",
    "aggregateProtectionMutationRequestedAt",
    "aggregateProtectionMutationSettledAt",
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
  const hashVersion = Number(hashPosition.version || 0)
  const legacyVersion = Number(legacy.version || 0)
  const hashUpdatedAt = Number(hashPosition.updatedAt || 0)
  const legacyUpdatedAt = Number(legacy.updatedAt || 0)
  const hashIsAtLeastAsRecent =
    hashVersion > legacyVersion ||
    (hashVersion === legacyVersion && hashUpdatedAt >= legacyUpdatedAt)
  return hashIsAtLeastAsRecent
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

export async function getLivePositionSnapshot(
  connectionId: string,
  positionId: string,
): Promise<LivePosition | null> {
  await initRedis()
  return readLivePositionSnapshot(getRedisClient(), connectionId, positionId)
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
    scanRedisSetMembers(client, indexKey, { count: 250 }).catch(() => []),
    scanRedisSetMembers(client, longKey, { count: 250 }).catch(() => []),
    scanRedisSetMembers(client, shortKey, { count: 250 }).catch(() => []),
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
    const terminalRetentionSeconds = liveRetentionSecondsForStatus(position.status)
    const incomingTerminal = terminalRetentionSeconds !== null
  try {
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
    await client.set(
      jsonKey,
      JSON.stringify(buildLivePositionCompatibilitySnapshot(position as unknown as Record<string, unknown>)),
      incomingTerminal
        ? { EX: terminalRetentionSeconds || LIVE_TERMINAL_RETENTION_SECONDS }
        : undefined,
    ).catch(() => null)
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
    if (incomingTerminal) {
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
      await client.ltrim(closedIndexKey, 0, LIVE_CLOSED_INDEX_LIMIT - 1).catch(() => undefined)
      await recordLivePositionLifetimeContribution(
        client,
        position.connectionId,
        position as unknown as Record<string, any>,
      ).catch((error) => {
        logRuntimeWarning(
          `live-lifetime-summary:${position.connectionId}`,
          60_000,
          `${LOG_PREFIX} lifetime summary contribution failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      })
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
      const notional = entryPrice > 0 && totalQuantity > 0
        ? positionNotionalUsd(position, totalQuantity, entryPrice)
        : 0
      const realizedPnl = Number.isFinite(Number(position.realizedPnL))
        ? Number(position.realizedPnL)
        : 0
      const positionCostPct = Number(position.positionCostPct) > 0
        ? Number(position.positionCostPct)
        : 0.1
      const grossPnlPct = notional > 0 ? (realizedPnl / notional) * 100 : 0
      const verifiedOutcome = position.realizedPnlComplete === true
      const simulatedOutcome = position.realizedPnlSource === "simulation_model"
      await markStrategyPositionInactive(
        position.connectionId,
        position.id,
        String(position.status).toLowerCase() === "closed" && verifiedOutcome
          ? {
              pnl: realizedPnl,
              // Live PnL is already venue-net and must not receive a second
              // configured-cost deduction. Simulation retains its explicit
              // deterministic PositionCost model.
              pnlPct: simulatedOutcome
                ? netMovePctAfterPositionCost(grossPnlPct, positionCostPct)
                : grossPnlPct,
              positionCostPct,
              drawdownMinutes: openedAt > 0 && closedAt > openedAt
                ? (closedAt - openedAt) / 60_000
                : 0,
              strategyVariant: inferRealStrategyVariant(position.setKey || "", position.setVariant),
              accountingSource: position.realizedPnlSource,
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
    if (incomingTerminal) {
      await client.expire(
        posKey,
        terminalRetentionSeconds || LIVE_TERMINAL_RETENTION_SECONDS,
      ).catch(() => 0)
      await client.expire(
        jsonKey,
        terminalRetentionSeconds || LIVE_TERMINAL_RETENTION_SECONDS,
      ).catch(() => 0)
    } else {
      await keepDurable(posKey)
      await keepDurable(jsonKey)
    }
    await syncActiveBlockCountIndex(client, position)
    // The connection index is durable and capped; terminal snapshots are
    // retained for the bounded audit window above while aggregate history is
    // written to the lifetime/analytics archives before expiry.
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

  try {
    // Keep the canonical save path for every row. The previous shortcut only
    // wrote an un-serialised hash: it skipped the compact mirror, TTL policy,
    // open/closed indexes, tracking pointers and lifetime analytics. That
    // produced split-brain stats and could leave terminal rows in the active
    // book. Bound concurrency so a large close batch does not create a Redis
    // request burst.
    const batchSize = 16
    for (let offset = 0; offset < positions.length; offset += batchSize) {
      await Promise.all(positions.slice(offset, offset + batchSize).map((position) =>
        savePosition(position),
      ))
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} batchSavePositions failed:`, err instanceof Error ? err.message : String(err))
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
    if (metric === "live_orders_placed_count" || metric === "live_orders_failed_count") {
      await hincrbyProgression(connectionId, "live_orders_attempted_count", delta, {
        connectionId,
        epoch: currentEpoch,
        logStaleRejects: false,
      })
    }
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

function makeDurableClientOrderId(prefix: string, position: Pick<LivePosition, "id" | "symbol" | "connectionId">): string {
  const connection = String(position.connectionId || "x").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)
  const kind = String(prefix || "x").replace(/[^a-zA-Z0-9]/g, "").slice(0, 6)
  const symbol = String(position.symbol || "x").replace(/[^a-zA-Z0-9]/g, "").slice(0, 6)
  const suffix = nanoid(8).replace(/[^a-zA-Z0-9]/g, "")
  return `cts${connection}${kind}${symbol}${Date.now().toString(36)}${suffix}`.slice(0, 32)
}

function firstNonEmptyIdentifier(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (value === null || value === undefined) continue
    const normalized = String(value).trim()
    if (normalized) return normalized
  }
  return undefined
}

function appendClientOrderTracking(
  position: LivePosition,
  clientOrderId: string,
  kind: "entry" | "accumulation" | "stop_loss" | "take_profit" | "security_stop",
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
  kind: "entry" | "accumulation" | "stop_loss" | "take_profit" | "security_stop",
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
  options: {
    /** Per-request cap. Existing callers retain the normal order-read limit. */
    timeoutMs?: number
    /** Total budget across every connector lookup in this recovery attempt. */
    totalTimeoutMs?: number
  } = {},
): Promise<any | null> {
  if (!connector || !clientOrderId) return null
  const startedAt = Date.now()
  const totalTimeoutMs = Math.max(1, Number(options.totalTimeoutMs || 0) || Number.POSITIVE_INFINITY)
  const timeoutForLookup = (): number | null => {
    const remaining = totalTimeoutMs - (Date.now() - startedAt)
    if (!(remaining > 0)) return null
    const requested = Math.max(1, Number(options.timeoutMs || EXCHANGE_TIMEOUT_GET_ORDER_MS))
    return Math.max(1, Math.min(requested, remaining))
  }
  const normalize = (candidate: any): any | null => {
    const raw = candidate?.order ?? candidate?.data ?? candidate
    if (!raw || candidate?.success === false) return null
    const echoedClientId = firstNonEmptyIdentifier(raw?.clientOrderId, raw?.clientOrderID, raw?.client_oid)
    if (echoedClientId && echoedClientId !== clientOrderId) return null
    const orderId = firstNonEmptyIdentifier(raw?.orderId, raw?.orderID, raw?.id, raw?.ordId)
    if (!orderId) return null
    return { ...raw, success: true, orderId, clientOrderId }
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
    const timeoutMs = timeoutForLookup()
    if (timeoutMs === null) return null
    try {
      const recovered = normalize(await withTimeout(
        lookup() as Promise<any>,
        timeoutMs,
        `recoverEntryOrderByClientId(${symbol})`,
      ))
      if (recovered) return recovered
    } catch { /* authoritative sync will retry */ }
  }

  if (typeof connector.getOpenOrders === "function") {
    const timeoutMs = timeoutForLookup()
    if (timeoutMs === null) return null
    try {
      const orders = await withTimeout(
        connector.getOpenOrders(symbol) as Promise<any>,
        timeoutMs,
        `recoverEntryOrderByClientId.openOrders(${symbol})`,
      )
      const match = Array.isArray(orders)
        ? orders.find((order: any) => firstNonEmptyIdentifier(
            order?.clientOrderId,
            order?.clientOrderID,
            order?.client_oid,
            order?.clOrdId,
          ) === clientOrderId)
        : null
      return normalize(match)
    } catch { /* authoritative sync will retry */ }
  }
  return null
}

function isAmbiguousControlOrderDelivery(error: unknown): boolean {
  return /timeout|timed out|aborted|socket|network|fetch failed|econnreset|ack_without_order_id|ambiguous/i.test(
    String(error || ""),
  )
}

/**
 * A control-order POST can reach the venue even when its acknowledgement
 * crosses the local response deadline. Keep observing the exact same promise
 * for a short grace window, then reconcile by the already-persisted client ID.
 * This function never submits another order.
 */
async function reconcileAmbiguousProtectionWrite(input: {
  connector: any
  symbol: string
  clientOrderId?: string
  placementPromise: Promise<any>
  initialError: unknown
  graceMs?: number
  recoveryMs?: number
}): Promise<any | null> {
  const clientOrderId = String(input.clientOrderId || "").trim()
  if (!clientOrderId || !isAmbiguousControlOrderDelivery(input.initialError)) return null

  try {
    const lateResult = await withTimeout(
      input.placementPromise,
      Math.max(1, input.graceMs ?? EXCHANGE_AMBIGUOUS_PLACE_GRACE_MS),
      `awaitAmbiguousProtectionWrite(${input.symbol})`,
    )
    const lateOrderId = firstNonEmptyIdentifier(lateResult?.orderId, lateResult?.orderID, lateResult?.id, lateResult?.ordId)
    if (lateResult?.success && lateOrderId) {
      return {
        ...lateResult,
        orderId: lateOrderId,
        recoveredFromAmbiguousWrite: "late_acknowledgement",
      }
    }
  } catch {
    // The original write is still delivery-ambiguous. Resolve it by the exact
    // client ID below; do not replay the POST.
  }

  const recovered = await recoverEntryOrderByClientId(
    input.connector,
    input.symbol,
    clientOrderId,
    {
      timeoutMs: Math.max(1, input.recoveryMs ?? EXCHANGE_AMBIGUOUS_RECOVERY_MS),
      totalTimeoutMs: Math.max(1, input.recoveryMs ?? EXCHANGE_AMBIGUOUS_RECOVERY_MS),
    },
  )
  const recoveredOrderId = firstNonEmptyIdentifier(recovered?.orderId, recovered?.orderID, recovered?.id, recovered?.ordId)
  if (!recoveredOrderId) return null
  const status = String(recovered?.status || "").trim().toLowerCase()
  if (["cancelled", "canceled", "rejected", "expired"].includes(status)) return null
  return {
    ...recovered,
    success: true,
    orderId: recoveredOrderId,
    clientOrderId,
    recoveredFromAmbiguousWrite: "client_order_id",
  }
}

async function prepareProtectionSubmission(
  position: LivePosition,
  leg: "stopLoss" | "takeProfit" | "securityStop",
  triggerPrice: number,
  quantity: number,
): Promise<string> {
  const clientOrderId = makeDurableClientOrderId(
    leg === "stopLoss" ? "sl" : leg === "takeProfit" ? "tp" : "sec",
    position,
  )
  position.pendingProtectionOrders = {
    ...(position.pendingProtectionOrders || {}),
    [leg]: { clientOrderId, triggerPrice, quantity },
  }
  appendClientOrderTracking(
    position,
    clientOrderId,
    leg === "stopLoss" ? "stop_loss" : leg === "takeProfit" ? "take_profit" : "security_stop",
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
function liveExecutionLane(
  position: Pick<LivePosition, "executionLane" | "indicationType" | "trailingProfile"> |
    Pick<RealPosition, "executionLane" | "indicationType" | "trailingProfile">,
): SignalExecutionLane {
  return resolveSignalExecutionLane(position)
}

function liveExecutionSlot(
  position: Pick<
    LivePosition,
    "executionLane" | "indicationType" | "trailingProfile" | "signalRisk" | "setKey" |
    "parentSetKey" | "combinedPosCounts"
  > |
    Pick<
      RealPosition,
      "executionLane" | "indicationType" | "trailingProfile" | "signalRisk" | "setKey" |
      "parentSetKey" | "combinedPosCounts"
    >,
): string {
  if (String(position.indicationType || "").trim().toLowerCase() === "direct-trade") {
    const identity = String(position.parentSetKey || position.setKey || "unknown")
    return `direct-${stableExecutionIdentityHash(identity)}`
  }
  if (position.combinedPosCounts) {
    const identity = String(
      position.parentSetKey ||
      position.setKey?.split("#poscounts:combined:")[0] ||
      position.setKey ||
      "unknown",
    )
    let hash = 0x811c9dc5
    for (let index = 0; index < identity.length; index++) {
      hash ^= identity.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    return `poscounts-${(hash >>> 0).toString(36).padStart(7, "0")}`
  }
  return resolveSignalExecutionSlot(position)
}

function stableExecutionIdentityHash(identity: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < identity.length; index++) {
    hash ^= identity.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, "0")
}

/** Deterministic crash-recovery identity for one Direct-Trade ownership row. */
export function directTradeCanonicalPositionId(
  connectionId: string,
  symbol: string,
  direction: "long" | "short",
  directPositionId: string,
): string {
  const normalizedSymbol = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "") || "UNKNOWN"
  const identity = `${connectionId}\u0000${normalizedSymbol}\u0000${direction}\u0000${directPositionId}`
  return `live:${connectionId}:${normalizedSymbol}:${direction}:direct:${stableExecutionIdentityHash(identity)}`
}

function liveLockDirection(
  position: Pick<
    LivePosition,
    "direction" | "setVariant" | "executionLane" | "indicationType" | "trailingProfile" |
    "signalRisk" | "setKey" | "parentSetKey" | "combinedPosCounts"
  > |
    Pick<
      RealPosition,
      "direction" | "setVariant" | "executionLane" | "indicationType" | "trailingProfile" |
      "signalRisk" | "setKey" | "parentSetKey" | "combinedPosCounts"
    >,
): string {
  const slot = liveExecutionSlot(position)
  const laneSuffix = slot === "default" ? "" : `:${slot}`
  const variantSuffix = position.setVariant === "block" ? ":block" : ""
  return `${position.direction}${laneSuffix}${variantSuffix}`
}

function initializeIndependentBlockSeed(
  position: LivePosition,
  source: RealPosition,
  filledQuantity: number,
  clientOrderId?: string,
  orderId?: string,
): void {
  // Block is an independent execution family. It can be the first physical
  // row when Normal is disabled, but it must also retain its exact additional
  // quantity when a Normal parent already exists.
  if (source.setVariant !== "block" || !(filledQuantity > 0)) return
  const blockCount = parseBlockCount(source.setKey) ?? Math.floor(Number(source.blockCount || 0))
  const volumeRatio = Number(source.blockVolumeRatio || 0)
  const incrementSteps = normalizeBlockIncrementSteps(source.blockIncrementSteps)
  const canonicalMultiplier = blockCount > 0 && volumeRatio > 0
    ? calculateBlockVolumeMultiplier(blockCount, volumeRatio, incrementSteps)
    : 0
  const multiplier = Math.max(
    1,
    canonicalMultiplier || Number(source.blockCalculatedVolumeMultiplier ?? source.sizeMultiplier ?? 1),
  )
  const baseQuantity = filledQuantity / multiplier
  const addedQuantity = Math.max(0, filledQuantity - baseQuantity)
  position.blockBaseQuantity = baseQuantity
  const leg = buildBlockLegState(
    source as unknown as Record<string, any>,
    addedQuantity,
    clientOrderId,
    orderId,
    {
      baseQuantity,
      targetAdditionalQuantity: addedQuantity,
      confirmedAdditionalQuantityBefore: 0,
      targetBlockQuantity: filledQuantity,
      targetSatisfied: true,
      requestedQuantity: addedQuantity,
      positionQuantityAfter: filledQuantity,
    },
  )
  if (leg) position.blockLegs = [leg]
}

async function findOpenLivePositionByDir(
  connId: string,
  symbol: string,
  side: string,
  executionSlot = "default",
): Promise<LivePosition | null> {
  const client = getRedisClient()
  const slotKey = livePositionSlotIndexKey(connId, symbol, side, executionSlot)
  const indexedId = await client.get(slotKey).catch(() => null)
  if (indexedId) {
    const indexed = await readLivePositionSnapshot(client, connId, String(indexedId)).catch(() => null)
    if (indexed && matchesLiveSlot(indexed, symbol, side, executionSlot)) return indexed
    // The index is a performance hint. Clear only the stale ID, preserving a
    // concurrent replacement that has already claimed this physical slot.
    await evalLockLua(client, RELEASE_LOCK_LUA, slotKey, [String(indexedId)]).catch(() => 0)
  }

  // Legacy/recovery fallback: an older snapshot may not have slot indexes.
  // Repair it after the first bounded full scan so subsequent dispatches are
  // constant-time without changing the existing matching semantics.
  const positions = await getLivePositions(connId)
  for (const p of positions) {
    if (matchesLiveSlot(p, symbol, side, executionSlot)) {
      await client.set(slotKey, p.id).catch(() => null)
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
  executionSlot = "default",
  allowBlockParent = false,
  fallbackExecutionSlot?: string,
): Promise<LivePosition | null> {
  const matchesParent = (p: LivePosition, slot: string): boolean => {
    const parentVariant =
      p.setVariant !== "dca" &&
      (p.setVariant !== "block" || allowBlockParent)
    const active =
      p.status === "open" ||
      p.status === "filled" ||
      p.status === "partially_filled" ||
      (allowSimulated && p.status === "simulated")
    const venueOwned = allowSimulated || !!(p.orderId || (p.exchangeData as any)?.exchangePositionId)
    return matchesLiveSlot(p, symbol, direction, slot) &&
      liveExecutionSlot(p) === slot &&
      parentVariant &&
      active &&
      venueOwned &&
      Number(p.executedQuantity || 0) > 0
  }
  const slots = [executionSlot]
  if (fallbackExecutionSlot && fallbackExecutionSlot !== executionSlot) slots.push(fallbackExecutionSlot)
  for (const slot of slots) {
    const indexed = await findOpenLivePositionByDir(connId, symbol, direction, slot)
    if (indexed && matchesParent(indexed, slot)) return indexed
  }
  return null
}
async function fetchCurrentPrice(symbol: string, connId?: string): Promise<number> {
  const { getMarketData, getRedisClient } = await import("@/lib/redis-db")
  try {
    // Primary: OHLCV candle-series key written by historic loader / live feed.
    const data = await getMarketData(symbol, "1m", connId)
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
      const flatHash = await client.hgetall(marketDataKey(symbol, "", connId)).catch(() => ({} as Record<string, string>))
      const cachedTicker = normalizeVenueTicker(flatHash, symbol)
      const tickerPrice = cachedTicker
        ? (finitePositive(cachedTicker.bid) + finitePositive(cachedTicker.ask)) / 2 || finitePositive(cachedTicker.last)
        : 0
      if (tickerPrice > 0) return tickerPrice
      const closeRaw = flatHash?.close
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
  variant: "block" | "dca" | "default" | "special"
  /** Static per-position USD ceiling carried into every later add-on. */
  maxExecutionNotionalUsd?: number
  liveMultiplierCapped?: boolean
  specialPositionPlan?: SpecialPositionPlan
  specialBaseQuantity?: number
  specialTargetQuantity?: number
  blockCount?: number
  blockBaseQuantity?: number
  blockConfirmedAddQuantity?: number
  blockTargetAddQuantity?: number
  blockTargetQuantity?: number
  blockIncrementSteps?: number
  dcaStep?: number
  dcaVolumeMultiplier?: number
  dcaTriggerDistancePct?: number
  dcaProfile?: DcaProfile
}

function applySpecialPlanToPosition(
  position: LivePosition,
  plan: SpecialPositionPlan,
): void {
  const direction = resolveLivePositionDirection(position)
  const sanitized = direction ? sanitizeSpecialPositionPlan(plan, direction) : null
  if (!sanitized) return
  position.specialPositionPlan = sanitized
  position.sizeMultiplier = sanitized.totalVolumeRatio
  position.stopLoss = sanitized.protection.stopLossPct
  position.takeProfit = sanitized.protection.takeProfitPct
  position.trailingProfile = sanitized.protection.trailingEnabled
    ? {
        startRatio: sanitized.protection.trailingActivationPct / 100,
        stopRatio: sanitized.protection.trailingDistancePct / 100,
        stepRatio: sanitized.protection.trailingStepPct / 100,
        mode: "fixed",
      }
    : undefined
  const firstFillAt = Number(position.fills?.[0]?.timestamp || position.createdAt || Date.now())
  const boundedHoldingSeconds = Math.min(
    SPECIAL_MAX_HOLDING_SECONDS,
    Math.max(1, sanitized.maximumHoldingSeconds),
  )
  position.specialExpiresAt = firstFillAt + boundedHoldingSeconds * 1_000
}

function calculateConfirmedDcaAddQuantity(dcaLegs: unknown): number {
  if (!Array.isArray(dcaLegs)) return 0
  return dcaLegs.reduce((total: number, leg: unknown) => {
    if (!leg || typeof leg !== "object") return total
    const quantity = Number((leg as Record<string, unknown>).quantity || 0)
    return total + (Number.isFinite(quantity) && quantity > 0 ? quantity : 0)
  }, 0)
}

async function resolveAccumulationPlan(
  connId: string,
  existing: LivePosition,
  real: any,
  price: number,
  connector?: any,
): Promise<AccumulationPlan | null> {
  if (String(real?.indicationType || "").trim().toLowerCase() === "special") {
    const direction = resolveLivePositionDirection(existing)
    if (!direction) return null
    const specialPositionPlan = sanitizeSpecialPositionPlan(real?.specialPositionPlan, direction)
    if (!specialPositionPlan) return null
    const existingPlan = sanitizeSpecialPositionPlan(existing.specialPositionPlan, direction)
    const currentQuantity = Number(existing.executedQuantity || existing.quantity || 0)
    const initialQuantity = Number(existing.initialExecutedQuantity || currentQuantity)
    const previousRatio = Math.max(
      1,
      Math.min(3, Number(existingPlan?.totalVolumeRatio ?? existing.sizeMultiplier ?? 1) || 1),
    )
    const specialBaseQuantity = Number(existing.specialBaseQuantity || 0) > 0
      ? Number(existing.specialBaseQuantity)
      : initialQuantity / previousRatio
    if (!(specialBaseQuantity > 0) || !(currentQuantity > 0)) return null
    const specialTargetQuantity = Math.min(
      specialBaseQuantity * 3,
      specialBaseQuantity * specialPositionPlan.totalVolumeRatio,
    )
    return {
      addQty: Math.max(0, specialTargetQuantity - currentQuantity),
      variant: "special",
      maxExecutionNotionalUsd: Number(existing.maxExecutionNotionalUsd) > 0
        ? Number(existing.maxExecutionNotionalUsd)
        : undefined,
      specialPositionPlan,
      specialBaseQuantity,
      specialTargetQuantity,
    }
  }

  if (real?.setVariant === "block") {
    const blockCount = parseBlockCount(real?.setKey)
    const blockVolumeRatio = Number(real?.blockVolumeRatio ?? existing.blockVolumeRatio ?? 1)
    const blockIncrementSteps = normalizeBlockIncrementSteps(
      real?.blockIncrementSteps ?? existing.blockIncrementSteps,
    )
    const recordedBlockAddQuantity = calculateConfirmedBlockAddQuantity(existing.blockLegs)
    // Every Block count is an absolute additive target derived from the
    // immutable general/Base quantity. Only confirmed Block legs consume that
    // target. DCA, Special, or any other quantity increase is independent and
    // must never suppress a later Block Count.
    const explicitBaseQuantity = Number(existing.blockBaseQuantity ?? existing.initialExecutedQuantity ?? 0)
    const currentQuantity = Number(existing.executedQuantity ?? existing.quantity ?? 0)
    const blockBaseQuantity = explicitBaseQuantity > 0
      ? explicitBaseQuantity
      : currentQuantity
    const blockConfirmedAddQuantity = recordedBlockAddQuantity
    if (!blockCount || blockBaseQuantity <= 0 || blockVolumeRatio <= 0) return null
    const blockTargetAddQuantity = calculateBlockAddQuantity(
      blockBaseQuantity,
      blockCount,
      blockVolumeRatio,
      blockIncrementSteps,
    )
    const blockTargetQuantity = calculateBlockTargetQuantity(
      blockBaseQuantity,
      blockCount,
      blockVolumeRatio,
      blockIncrementSteps,
    )
    const addQty = calculateBlockRemainingAddQuantity(
      blockBaseQuantity,
      blockCount,
      blockVolumeRatio,
      blockConfirmedAddQuantity,
      blockIncrementSteps,
    )
    return {
      addQty,
      variant: "block",
      maxExecutionNotionalUsd: Number(existing.maxExecutionNotionalUsd) > 0
        ? Number(existing.maxExecutionNotionalUsd)
        : undefined,
      blockCount,
      blockBaseQuantity,
      blockConfirmedAddQuantity,
      blockTargetAddQuantity,
      blockTargetQuantity,
      blockIncrementSteps,
    }
  }

  if (real?.setVariant === "dca") {
    const direction = resolveLivePositionDirection(existing)
    if (!direction) return null
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
    const requestedDcaStep = Math.floor(Number(real?.requestedDcaStep) || 0)
    const isDirectDca = String(real?.indicationType || "").trim().toLowerCase() === "direct-trade"
    if (
      isDirectDca
      && (
        requestedDcaStep <= 0
        || requestedDcaStep > dcaProfile.maxSteps
        || (existing.dcaLegs || []).some((leg) => Number(leg?.step) === requestedDcaStep)
      )
    ) return null
    const next = isDirectDca
      ? {
          step: requestedDcaStep,
          volumeMultiplier: Number(dcaProfile.stepVolumeMultipliers[requestedDcaStep - 1] || 0),
          triggerDistancePct: Number(dcaProfile.stepDistancesPct[requestedDcaStep - 1] || 0),
        }
      : resolveNextDcaStep({
          direction,
          referencePrice,
          currentPrice: price,
          profile: dcaProfile,
          legs: existing.dcaLegs,
          pendingStep: existing.pendingAccumulation?.dcaStep,
        })
    if (!next) return null
    const baseQuantity = Number(existing.initialExecutedQuantity ?? existing.executedQuantity ?? 0)
    // DCA owns an independent lane budget. Confirmed Block/Special/other Set
    // fills share the physical venue position but must not consume a DCA
    // step or its configured max-position ratio. The absolute execution-
    // notional ceiling below remains the final system-wide exposure guard.
    const dcaLaneCurrentQuantity = baseQuantity + calculateConfirmedDcaAddQuantity(existing.dcaLegs)
    const addQty = calculateDcaAddQuantity(
      baseQuantity,
      next.volumeMultiplier,
      dcaLaneCurrentQuantity,
      dcaProfile.maxPositionVolumeRatio,
    )
    if (!(addQty > 0)) return null
    return {
      addQty,
      variant: "dca",
      maxExecutionNotionalUsd: Number(existing.maxExecutionNotionalUsd) > 0
        ? Number(existing.maxExecutionNotionalUsd)
        : undefined,
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
    {
      tradeMode: "main",
      sizeMultiplier: real?.sizeMultiplier ?? existing.sizeMultiplier,
      allowUnboundedVariantMultiplier: Boolean(real?.combinedPosCounts || existing.combinedPosCounts),
      indicationType: real?.indicationType ?? existing.indicationType,
      marketType: existing.marketType,
      lotSize: existing.lotSize,
      quoteToUsdRate: existing.quoteToUsdRate || (
        existing.marketType === "forex"
          ? (await resolveForexUsdConversion(
              connId,
              String(real?.symbol || existing.symbol || ""),
              connector,
              existing.executionMode === "simulation",
            ))?.rate
          : undefined
      ),
    },
  ).catch(() => null)
  let addQty = Number(volumeResult?.finalVolume || volumeResult?.volume || 0)
  if (!Number.isFinite(addQty) || addQty <= 0) {
    if (existing.marketType === "forex" || volumeResult?.conversionAvailable === false) return null
    addQty = price > 0 ? 5 / price : 0
  }
  if (real?.combinedPosCounts) {
    const delta = resolveCombinedPosCountDelta(Number(existing.executedQuantity || 0), addQty)
    if (delta.action !== "increase") return null
    addQty = delta.quantity
  }
  return Number.isFinite(addQty) && addQty > 0
    ? {
        addQty,
        variant: "default",
        maxExecutionNotionalUsd: Number(volumeResult?.maxExecutionNotionalUsd) > 0
          ? Number(volumeResult?.maxExecutionNotionalUsd)
          : undefined,
        liveMultiplierCapped: volumeResult?.liveMultiplierCapped === true,
      }
    : null
}

type AccumulationQuantityAdmission = {
  quantity: number
  requestedQuantity: number
  currentNotionalUsd: number
  maxNotionalUsd: number
  capped: boolean
  reason?: string
}

/**
 * Apply the same PositionCost ceiling to every physical add-on, not only to
 * the first entry.  Block/DCA/combined targets are strategy ratios and can be
 * much larger than one exchange position; the exchange boundary must still
 * admit only the remaining notional budget.  This helper deliberately rounds
 * down after venue normalization so a minimum/step rule can never enlarge the
 * approved ceiling.
 */
function admitAccumulationQuantity(
  position: LivePosition,
  requestedQuantity: number,
  price: number,
  rules: LiveInstrumentRules,
  maxNotionalUsd: number,
): AccumulationQuantityAdmission {
  const requested = Number.isFinite(Number(requestedQuantity))
    ? Math.max(0, Number(requestedQuantity))
    : 0
  const currentNotionalUsd = positionNotionalUsd(
    position,
    Number(position.executedQuantity || 0),
    price,
  )
  const ceiling = Number.isFinite(maxNotionalUsd) && maxNotionalUsd > 0
    ? maxNotionalUsd
    : 0
  const unitNotionalUsd = positionNotionalUsd(position, 1, price)
  if (!(ceiling > 0) || !(unitNotionalUsd > 0)) {
    return {
      quantity: 0,
      requestedQuantity: requested,
      currentNotionalUsd,
      maxNotionalUsd: ceiling,
      capped: true,
      reason: "live/VST PositionCost exposure ceiling is unavailable",
    }
  }
  if (currentNotionalUsd >= ceiling - 1e-8) {
    return {
      quantity: 0,
      requestedQuantity: requested,
      currentNotionalUsd,
      maxNotionalUsd: ceiling,
      capped: true,
      reason: `live/VST PositionCost exposure is already at ${ceiling.toFixed(2)} USD`,
    }
  }

  const remainingNotionalUsd = ceiling - currentNotionalUsd
  const maximumQuantity = roundQuantityDown(remainingNotionalUsd / unitNotionalUsd, rules)
  if (!(maximumQuantity > 0) || maximumQuantity < rules.minQuantity - 1e-12) {
    return {
      quantity: 0,
      requestedQuantity: requested,
      currentNotionalUsd,
      maxNotionalUsd: ceiling,
      capped: true,
      reason: `remaining PositionCost budget ${remainingNotionalUsd.toFixed(2)} USD is below the executable minimum`,
    }
  }

  const cappedRequested = Math.min(requested, maximumQuantity)
  let quantity = resolveExecutableQuantity(
    cappedRequested,
    price,
    rules,
    { universalMinNotionalUsdt: 0 },
  ).quantity
  // resolveExecutableQuantity intentionally rounds up to a venue minimum. At
  // this safety boundary, round back down if that upward normalization would
  // cross the remaining budget.
  if (!(quantity > 0) || quantity > maximumQuantity + 1e-12 ||
      positionNotionalUsd(position, Number(position.executedQuantity || 0) + quantity, price) > ceiling + 1e-8) {
    quantity = roundQuantityDown(cappedRequested, rules)
  }
  const totalNotionalUsd = positionNotionalUsd(
    position,
    Number(position.executedQuantity || 0) + Math.max(0, quantity),
    price,
  )
  if (!(quantity > 0) || quantity < rules.minQuantity - 1e-12 || totalNotionalUsd > ceiling + 1e-8) {
    return {
      quantity: 0,
      requestedQuantity: requested,
      currentNotionalUsd,
      maxNotionalUsd: ceiling,
      capped: true,
      reason: `requested accumulation cannot fit within the ${ceiling.toFixed(2)} USD PositionCost ceiling after venue rounding`,
    }
  }
  return {
    quantity,
    requestedQuantity: requested,
    currentNotionalUsd,
    maxNotionalUsd: ceiling,
    capped: quantity + 1e-12 < requested,
    reason: quantity + 1e-12 < requested
      ? `accumulation capped at ${totalNotionalUsd.toFixed(2)} USD total (${ceiling.toFixed(2)} USD PositionCost ceiling)`
      : undefined,
  }
}

function markSatisfiedBlockTarget(
  position: LivePosition,
  real: Record<string, any>,
  plan: AccumulationPlan,
): string {
  const setKey = String(real?.setKey || "")
  if (
    plan.variant !== "block" ||
    !setKey ||
    !plan.blockCount ||
    !plan.blockBaseQuantity ||
    plan.blockTargetAddQuantity === undefined ||
    plan.blockTargetQuantity === undefined
  ) return ""

  const previous = position.blockLegs?.find((leg) => leg.setKey === setKey)
  const leg = buildBlockLegState(
    real,
    Number(previous?.quantity || 0),
    previous?.clientOrderId,
    previous?.orderId,
    {
      baseQuantity: plan.blockBaseQuantity,
      targetAdditionalQuantity: plan.blockTargetAddQuantity,
      confirmedAdditionalQuantityBefore: plan.blockConfirmedAddQuantity,
      targetBlockQuantity: plan.blockTargetQuantity,
      targetSatisfied: true,
      requestedQuantity: 0,
      positionQuantityAfter: Number(position.executedQuantity || position.quantity || 0),
    },
  )
  if (leg) {
    position.blockLegs = [
      ...(position.blockLegs || []).filter((item) => item.setKey !== leg.setKey),
      leg,
    ]
  }
  position.accumulatedSetKeys = [...new Set([
    ...(position.accumulatedSetKeys || []),
    ...strategyLineageKeysForAdjustment(real, setKey),
  ])]
  pushStep(
    position,
    "block_target_covered",
    true,
    `setKey=${setKey}; targetAdd=${plan.blockTargetAddQuantity}; ` +
      `confirmedBlockAdd=${plan.blockConfirmedAddQuantity || 0}; orderDelta=0`,
  )
  return setKey
}

function strategyLineageKeysForAdjustment(
  real: Record<string, any> | null | undefined,
  primarySetKey?: string,
): string[] {
  const primary = String(primarySetKey || real?.setKey || "").trim()
  if (real?.combinedPosCounts) {
    return [...new Set(
      (Array.isArray(real?.accumulatedSetKeys) ? real.accumulatedSetKeys : [])
        .map((value: unknown) => String(value).trim())
        .filter(Boolean),
    )]
  }
  if (String(real?.setVariant || real?.variant || "") !== "block") {
    return primary ? [primary] : []
  }
  return [...new Set([
    primary,
    ...(Array.isArray(real?.accumulatedSetKeys) ? real.accumulatedSetKeys : []),
    real?.blockLaneKey,
  ].map((value: unknown) => String(value || "").trim()).filter(Boolean))]
}

/**
 * Seed the durable Live lineage from the exact Real dispatch identity.
 *
 * A non-combined Real row can carry both its executable row key (for example
 * `#row_real#row_live`) and broader accumulation aliases. Dropping the exact
 * key at the Real -> Live boundary makes relation statistics report a false
 * mismatch and can merge otherwise independent execution lanes. Combined
 * position-count rows are the intentional exception: their accumulated keys
 * already are the authoritative constituent Set identities and the synthetic
 * combined row must not be counted as an additional Set.
 */
function initialLivePositionSetLineage(real: Pick<
  RealPosition,
  "setKey" | "accumulatedSetKeys" | "combinedPosCounts"
>): string[] {
  const inherited = Array.isArray(real.accumulatedSetKeys)
    ? real.accumulatedSetKeys
        .map(String)
        .map((value) => value.trim())
        .filter(Boolean)
    : []
  if (real.combinedPosCounts && inherited.length > 0) {
    return [...new Set(inherited)]
  }
  return [...new Set([
    String(real.setKey || "").trim(),
    ...inherited,
  ].filter(Boolean))]
}

/**
 * Preserve Signal attribution and its low-stop protection when a Signal leg
 * is accumulated into an existing position owned by another indication.
 * Manual absolute protection overrides remain authoritative in
 * computeDesiredProtectionPrices; these fields update only the automatic
 * percentage contract used for the next control-order re-arm.
 */
function applyAccumulatedSignalRisk(
  position: Pick<LivePosition, "signalRisk" | "stopLoss" | "takeProfit">,
  source: Record<string, any> | null | undefined,
): void {
  const incoming = normalizeSignalRisk(source?.signalRisk)
  if (!incoming) return
  position.signalRisk = mergeSignalRisks(position.signalRisk, incoming)

  const positiveMinimum = (left: unknown, right: unknown): number | undefined => {
    const values = [Number(left), Number(right)]
      .filter((value) => Number.isFinite(value) && value > 0)
    return values.length > 0 ? Math.min(...values) : undefined
  }
  const stopLoss = positiveMinimum(
    position.stopLoss,
    source?.stopLoss ?? incoming.stopLossPct,
  )
  const takeProfit = positiveMinimum(
    position.takeProfit,
    source?.takeProfit ?? incoming.takeProfitPct,
  )
  if (stopLoss !== undefined) position.stopLoss = stopLoss
  if (takeProfit !== undefined) position.takeProfit = takeProfit
  normalizeLivePositionProtection(position)
}

function isVirtualBlockLaneKey(setKey: unknown): boolean {
  return String(setKey || "").startsWith("block_lane:")
}

function physicalAccumulationCount(setKeys: unknown, blockLegs?: unknown): number {
  if (!Array.isArray(setKeys)) return 0
  const coveredBlockKeys = new Set(
    (Array.isArray(blockLegs) ? blockLegs : [])
      .filter((leg: unknown) => {
        if (!leg || typeof leg !== "object") return false
        const item = leg as Record<string, unknown>
        return Number(item.quantity || 0) <= 0 && Number(item.requestedQuantity || 0) <= 0
      })
      .map((leg: unknown) => String((leg as Record<string, unknown>).setKey || "").trim())
      .filter(Boolean),
  )
  return new Set(
    setKeys
      .map((value: unknown) => String(value || "").trim())
      .filter((setKey: string) =>
        setKey &&
        !isVirtualBlockLaneKey(setKey) &&
        !coveredBlockKeys.has(setKey)
      ),
  ).size
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
    const storedDirection = resolveLivePositionDirection(existing)
    const requestedDirection = normalizeLiveTradeDirection(real?.direction, real?.side)
    if (!storedDirection || !requestedDirection || storedDirection !== requestedDirection) {
      pushStep(
        existing,
        "accumulate_direction_guard",
        false,
        `stored=${storedDirection || "invalid"}; requested=${requestedDirection || "invalid"}`,
      )
      await savePosition(existing)
      return existing
    }
    const plan = await resolveAccumulationPlan(connId, existing, real, price)
    if (!plan) {
      pushStep(existing, "accumulate_skip", false, `${real?.setVariant || "adjustment"} trigger not ready`)
      await savePosition(existing)
      return existing
    }
    if (plan.variant === "special" && plan.specialPositionPlan) {
      existing.specialBaseQuantity = plan.specialBaseQuantity
      applySpecialPlanToPosition(existing, plan.specialPositionPlan)
      if (!(plan.addQty > 0)) {
        const protection = computeDesiredProtectionPrices(existing)
        existing.stopLossPrice = protection.desiredSl > 0 ? protection.desiredSl : undefined
        existing.takeProfitPrice = protection.desiredTp > 0 ? protection.desiredTp : undefined
        refreshProtectionHandlingMode(existing, protection.desiredSl, protection.desiredTp, true)
        pushStep(existing, "special_plan_refresh", true, "target quantity already satisfied; protection/time contract refreshed")
        await savePosition(existing)
        return existing
      }
    }
    const accumulationSetKey = plan.variant === "dca" && plan.dcaStep
      ? buildDcaStepSetKey(String(real?.setKey || "dca"), plan.dcaStep)
      : String(real?.setKey || "")
    if (
      plan.variant !== "special" &&
      !real?.combinedPosCounts &&
      accumulationSetKey &&
      existing.accumulatedSetKeys?.includes(accumulationSetKey)
    ) return existing
    if (plan.variant === "block" && plan.addQty <= 0) {
      const coveredSetKey = markSatisfiedBlockTarget(existing, real, plan)
      await savePosition(existing)
      if (coveredSetKey) {
        await recordConfirmedStrategyEntry(
          connId,
          existing,
          `${existing.id}:set:${coveredSetKey}:covered`,
          {
            setKey: coveredSetKey,
            parentSetKey: real.parentSetKey,
            indicationType: real.indicationType,
            axisWindows: real.axisWindows,
            setKeys: strategyLineageKeysForAdjustment(real, coveredSetKey),
          },
        )
      }
      return existing
    }
    const prevExec = Number(existing.executedQuantity || 0)
    const prevAvg = Number(existing.averageExecutionPrice || existing.entryPrice || price)
    const filledQty = plan.addQty
    const newExec = prevExec + filledQty
    const progressionIdentity = [
      plan.variant,
      accumulationSetKey || (real?.combinedPosCounts ? "combined-pos-counts" : "unkeyed"),
      prevExec,
      newExec,
    ].join(":")
    const mutated = await mutatePositionWithVersionCheck(existing, ["simulated"], draft => {
      draft.executedQuantity = newExec
      draft.quantity = newExec
      draft.remainingQuantity = 0
      draft.averageExecutionPrice = newExec > 0 ? ((prevAvg * prevExec) + (price * filledQty)) / newExec : prevAvg
      draft.volumeUsd = positionNotionalUsd(draft, newExec, draft.averageExecutionPrice)
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
        : [...new Set([
            ...(draft.accumulatedSetKeys || []),
            ...strategyLineageKeysForAdjustment(real, accumulationSetKey),
          ])]
      applyAccumulatedSignalRisk(draft, real)
      if (plan.variant === "special" && plan.specialPositionPlan) {
        draft.specialBaseQuantity = plan.specialBaseQuantity
        applySpecialPlanToPosition(draft, plan.specialPositionPlan)
      }
      if (real?.combinedPosCounts) {
        draft.posCountsSetRatios = { ...(real?.posCountsSetRatios || draft.posCountsSetRatios || {}) }
        draft.posCountsSetQuantities = allocatePositionSetQuantities(draft, newExec, draft.accumulatedSetKeys)
      }
      if (plan.variant === "block") {
        const leg = buildBlockLegState(real, filledQty, undefined, undefined, {
          baseQuantity: plan.blockBaseQuantity,
          targetAdditionalQuantity: plan.blockTargetAddQuantity,
          confirmedAdditionalQuantityBefore: plan.blockConfirmedAddQuantity,
          targetBlockQuantity: plan.blockTargetQuantity,
          targetSatisfied: true,
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
          direction: storedDirection,
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
      const protection = computeDesiredProtectionPrices(existing)
      // assignedStopLoss/assignedTakeProfit are immutable percentages from
      // the originating strategy. Store the derived absolute trigger prices
      // in their dedicated fields and retain the explicit Paper lifecycle
      // ownership for every configured leg.
      existing.stopLossPrice = protection.desiredSl > 0 ? protection.desiredSl : undefined
      existing.takeProfitPrice = protection.desiredTp > 0 ? protection.desiredTp : undefined
      refreshProtectionHandlingMode(existing, protection.desiredSl, protection.desiredTp, true)
      await recordPositionAdjustmentProgression(
        connId,
        existing,
        "simulated",
        progressionIdentity,
        filledQty * price,
      )
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
            setKeys: strategyLineageKeysForAdjustment(real, accumulationSetKey),
          },
        )
      }
    }
  } finally {
    await releasePositionMutationLock(connId, existing.id, lockId).catch(() => false)
  }
  return existing
}

async function accumulateIntoLivePosition(
  connId: string,
  existing: LivePosition,
  real: any,
  price: number,
  connector: any,
  allowNewExchangeMutation = true,
  shouldContinue?: () => boolean | Promise<boolean>,
): Promise<LivePosition> {
  if (allowNewExchangeMutation) await assertMarginCallEntryAllowed(connId, connector)
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
  let entryProtectionAdmissionLease: EntryProtectionAdmissionLease | null = null

  const verifyProtection = async (reason: string): Promise<boolean> => {
    const direction = resolveLivePositionDirection(existing)
    if (!direction) return false
    const decision = await verifyConnectionProtectionAndPersistHalt({
      connectionId: connId,
      symbol: existing.symbol,
      direction,
      connector,
      reason,
    })
    if (decision.safe) {
      pushStep(
        existing,
        "quantity_protection_verified",
        true,
        `${reason}: exact row TP/SL and slot security controls are authoritative`,
      )
    } else {
      const violations = decision.violations.slice(0, 8).join(",") || "unknown"
      existing.statusReason =
        `${reason}: protection is not authoritative; new exposure halted (${violations})`
      pushStep(existing, "quantity_protection_halt", false, existing.statusReason)
    }
    await savePosition(existing).catch(() => undefined)
    return decision.safe
  }

  try {
    const storedDirection = resolveLivePositionDirection(existing)
    const requestedDirection = normalizeLiveTradeDirection(real?.direction, real?.side)
    if (!storedDirection || !requestedDirection || storedDirection !== requestedDirection) {
      pushStep(
        existing,
        "accumulate_direction_guard",
        false,
        `stored=${storedDirection || "invalid"}; requested=${requestedDirection || "invalid"}`,
      )
      await savePosition(existing)
      return existing
    }
    existing.accumulatedSetKeys ||= []
    if (!connector || typeof connector.placeOrder !== "function") {
      pushStep(existing, "accumulate_skip", false, "exchange connector unavailable — accumulation deferred")
      await savePosition(existing)
      return existing
    }

    entryProtectionAdmissionLease = await acquireEntryProtectionAdmissionLease(
      connId,
      `accumulation:${existing.id}`,
    )
    if (!entryProtectionAdmissionLease) {
      pushStep(
        existing,
        "accumulate_deferred",
        false,
        "connection-wide protection admission is busy — accumulation deferred",
      )
      await savePosition(existing)
      return existing
    }

    const hadPendingAccumulation = !!existing.pendingAccumulation?.clientOrderId
    if (existing.pendingAccumulation?.clientOrderId) {
      const pending = existing.pendingAccumulation
      const recovered = await recoverEntryOrderByClientId(connector, existing.symbol, pending.clientOrderId)
      const recoveredStatus = String(recovered?.status || "").toLowerCase()
      const recoveredOrderId = recovered?.orderId || recovered?.id
      if (recovered && recoveredOrderId && !["cancelled", "canceled", "rejected", "expired"].includes(recoveredStatus)) {
        pending.orderId = String(recoveredOrderId)
        pending.absenceConfirmations = 0
        await recordPositionAdjustmentProgression(
          connId,
          existing,
          "placed",
          pending.clientOrderId,
        )
        pushStep(existing, "accumulation_submission_recovered", true, `orderId=${pending.orderId}; exact fill deferred to reconciliation`)
        await savePosition(existing)
        await reconcilePendingAccumulationAndRearm(connector, existing, "accumulation_recovered")
        const recoveredTerminal = ["filled", "deal", "complete", "completed"].includes(recoveredStatus)
        const retained = existing.pendingAccumulation
        const appliedFilledQuantity = Number(retained?.appliedFilledQuantity || 0)
        if (
          recoveredTerminal &&
          retained?.clientOrderId === pending.clientOrderId &&
          appliedFilledQuantity > 0
        ) {
          await recordPositionAdjustmentProgression(
            connId,
            existing,
            "filled",
            retained.clientOrderId,
            appliedFilledQuantity * Number(existing.averageExecutionPrice || existing.entryPrice || price || 0),
          )
          pushStep(
            existing,
            "accumulation_terminal_partial",
            true,
            `orderId=${pending.orderId}; confirmed partial=${appliedFilledQuantity}; residual retry allowed`,
          )
          existing.pendingAccumulation = undefined
          await savePosition(existing)
        }
        await verifyProtection("accumulation_recovered")
        return existing
      }
      const liveOrderIds = await fetchLiveOrderIdSet(connector)
      if (
        liveOrderIds === null ||
        liveOrderIds.has(pending.clientOrderId) ||
        (pending.orderId ? liveOrderIds.has(pending.orderId) : false)
      ) {
        if (pending.orderId) {
          await recordPositionAdjustmentProgression(
            connId,
            existing,
            "placed",
            pending.clientOrderId,
          )
        }
        pushStep(existing, "accumulation_submission_wait", true, `tracking pending clientOrderId=${pending.clientOrderId}`)
        await savePosition(existing)
        await reconcilePendingAccumulationAndRearm(connector, existing, "accumulation_tracking_wait")
        await verifyProtection("accumulation_tracking_wait")
        return existing
      }
      pending.absenceConfirmations = Number(pending.absenceConfirmations || 0) + 1
      if (pending.absenceConfirmations < 2) {
        await savePosition(existing)
        await reconcilePendingAccumulationAndRearm(connector, existing, "accumulation_absence_wait")
        await verifyProtection("accumulation_absence_wait")
        return existing
      }
      pushStep(existing, "accumulation_submission_absent", false, `clientOrderId=${pending.clientOrderId} confirmed absent; retry allowed`)
      const appliedFilledQuantity = Number(pending.appliedFilledQuantity || 0)
      if (appliedFilledQuantity > 0) {
        await recordPositionAdjustmentProgression(
          connId,
          existing,
          "filled",
          pending.clientOrderId,
          appliedFilledQuantity * Number(existing.averageExecutionPrice || existing.entryPrice || price || 0),
        )
      } else {
        await recordPositionAdjustmentProgression(
          connId,
          existing,
          "failed",
          pending.clientOrderId,
        )
      }
      existing.pendingAccumulation = undefined
      await savePosition(existing)
    }

    // A clean authoritative snapshot is required before any risk increase.
    // This also safely clears a stale halt after a previous ambiguous action
    // has been fully reconciled; time alone never clears it.
    if (!await verifyProtection("pre_accumulation_admission")) return existing

    // Live OFF is an entry/mutation gate, not a license to reinterpret an
    // already confirmed venue position as paper. A pending accumulation is
    // still recovered above (and its protection is re-armed), but after that
    // boundary no new quantity may be submitted until the operator enables
    // the corresponding live intent again.
    const continuationAuthorised = shouldContinue
      ? await Promise.resolve(shouldContinue()).catch(() => false)
      : true
    if (!allowNewExchangeMutation || !continuationAuthorised) {
      pushStep(
        existing,
        "accumulate_blocked_live_off",
        false,
        "Live execution is disabled or its owner lease stopped; existing exchange quantity remains tracked and no new adjustment order is sent",
      )
      existing.statusReason = "Live Trade disabled — exchange position tracked; adjustment deferred"
      await savePosition(existing)
      return existing
    }

    const authoritativeAdjustmentPrice = await resolveAuthoritativeLiveReferencePrice(
      connId,
      String(real?.symbol || existing.symbol || ""),
      storedDirection,
      connector,
    )
    if (!(authoritativeAdjustmentPrice > 0)) {
      pushStep(
        existing,
        "accumulate_skip",
        false,
        `No authoritative exchange ticker available for ${String(real?.symbol || existing.symbol || "unknown")}`,
      )
      await savePosition(existing)
      return existing
    }
    price = authoritativeAdjustmentPrice
    repairLiveEntryPriceDomain(existing, authoritativeAdjustmentPrice)

    // Before calculating an add-on, reconcile the physical quantity from the
    // venue. A stale local fill ledger must never make the remaining budget
    // look larger than it really is. If the venue cannot provide an
    // authoritative snapshot, fail closed and keep the existing protected
    // quantity unchanged.
    const authoritativeBeforeAccumulation = await fetchAuthoritativeOpenQuantity(
      connector,
      existing.symbol,
      storedDirection,
    )
    if (!authoritativeBeforeAccumulation.ok) {
      pushStep(
        existing,
        "accumulate_quantity_snapshot",
        false,
        "authoritative venue quantity unavailable — no exposure increase submitted",
      )
      existing.statusReason = "Accumulation halted: authoritative venue quantity unavailable"
      await savePosition(existing)
      return existing
    }
    const authoritativeEntryPrice = Number(
      authoritativeBeforeAccumulation.position?.entryPrice ??
      authoritativeBeforeAccumulation.position?.avgPrice ??
      authoritativeBeforeAccumulation.position?.averagePrice ??
      existing.averageExecutionPrice ??
      existing.entryPrice ??
      price,
    ) || price
    const authoritativeTicket = Number(
      authoritativeBeforeAccumulation.position?.positionTicket ??
      authoritativeBeforeAccumulation.position?.ticket ??
      authoritativeBeforeAccumulation.position?.exchangePositionId,
    )
    if (Number.isInteger(authoritativeTicket) && authoritativeTicket > 0) {
      existing.positionTicket = authoritativeTicket
    }
    const quantityBeforeReconcile = Number(existing.executedQuantity || 0)
    await reconcileAuthoritativeExchangeQuantity(
      existing,
      authoritativeBeforeAccumulation.quantity,
      authoritativeEntryPrice,
    )
    if (!isActiveLiveStatus(existing) || Number(existing.executedQuantity || 0) <= 0) {
      pushStep(existing, "accumulate_skip", false, "venue position is flat or no longer active")
      await savePosition(existing)
      return existing
    }
    if (Math.abs(quantityBeforeReconcile - Number(existing.executedQuantity || 0)) > 1e-12) {
      if (!await verifyProtection("pre_accumulation_quantity_reconcile")) return existing
    }

    // Admission checks run only after a durable pending order was recovered
    // or conclusively cleared. Every exact Set membership remains eligible;
    // exchange/API rate limits are enforced by the dispatch queue and position
    // mutation lock, never by dropping later configurations.
    // Block/default overlays execute once per exact Set key. DCA is repeatable
    // by configured step and is deduped after resolveAccumulationPlan derives
    // its stable `#step:N` identity below.
    if (
      String(real?.indicationType || "").trim().toLowerCase() !== "special" &&
      !real?.combinedPosCounts &&
      real?.setKey &&
      real?.setVariant !== "dca" &&
      existing.accumulatedSetKeys.includes(real.setKey)
    ) {
      pushStep(existing, "accumulate_skip", false, `setKey ${real.setKey} already accumulated`)
      await savePosition(existing)
      if (hadPendingAccumulation) {
        await reconcilePendingAccumulationAndRearm(connector, existing, "accumulation_duplicate_after_recovery")
      }
      return existing
    }

    let plan = await resolveAccumulationPlan(connId, existing, real, price, connector)
    if (!plan) {
      pushStep(existing, "accumulate_skip", false, `${real?.setVariant || "adjustment"} trigger/quantity not ready`)
      await savePosition(existing)
      if (hadPendingAccumulation) {
        await reconcilePendingAccumulationAndRearm(connector, existing, "accumulation_retry_not_ready")
      }
      return existing
    }
    const directRequestedQuantity = Number(real?.requestedQuantityCap)
    if (
      String(real?.indicationType || "").trim().toLowerCase() === "direct-trade" &&
      directRequestedQuantity > 0 &&
      plan.addQty > directRequestedQuantity
    ) {
      plan = { ...plan, addQty: directRequestedQuantity }
      pushStep(
        existing,
        "direct_quantity_cap",
        true,
        `canonical add-on capped to leased Direct-Trade request ${directRequestedQuantity}`,
      )
    }
    if (plan.variant === "special" && plan.specialPositionPlan) {
      existing.specialBaseQuantity = plan.specialBaseQuantity
      applySpecialPlanToPosition(existing, plan.specialPositionPlan)
      if (!(plan.addQty > 0)) {
        pushStep(existing, "special_plan_refresh", true, "target quantity already satisfied; protection/time contract refreshed")
        await rearmProtectionAfterQuantityMutation(connector, existing, "special_plan_refresh")
        await verifyProtection("special_plan_refresh")
        return existing
      }
    }
    if (plan.variant === "block" && plan.addQty <= 0) {
      const coveredSetKey = markSatisfiedBlockTarget(existing, real, plan)
      await savePosition(existing)
      if (coveredSetKey) {
        await recordConfirmedStrategyEntry(
          connId,
          existing,
          `${existing.id}:set:${coveredSetKey}:covered`,
          {
            setKey: coveredSetKey,
            parentSetKey: real.parentSetKey,
            indicationType: real.indicationType,
            axisWindows: real.axisWindows,
            setKeys: strategyLineageKeysForAdjustment(real, coveredSetKey),
          },
        )
      }
      return existing
    }
    if (!Number.isFinite(plan.addQty) || plan.addQty <= 0) {
      pushStep(existing, "accumulate_skip", false, `${real?.setVariant || "adjustment"} trigger/quantity not ready`)
      await savePosition(existing)
      return existing
    }
    let remainingExposureNotionalUsd: number | undefined

    // Accumulation targets are ratio deltas, but the venue still owns the
    // quantity grid. First apply the persisted PositionCost ceiling to the
    // *total* physical position, then normalize the surviving delta. This is
    // the guard that prevents a high Block/DCA/combined target from becoming
    // a high-volume exchange order.
    const accumulationRules = await loadExchangeQuantityRules(
      String(real?.symbol || existing.symbol || ""),
      connector,
      connId,
    )
    let maxExecutionNotionalUsd = Number(
      plan.maxExecutionNotionalUsd ?? existing.maxExecutionNotionalUsd ?? 0,
    )
    if (!(maxExecutionNotionalUsd > 0)) {
      const recoveryVolumeResult = await VolumeCalculator.calculateVolumeForConnection(
        connId,
        String(real?.symbol || existing.symbol || ""),
        price,
        {
          tradeMode: volumeTradeModeForIntent(existing.executionIntent || "main"),
          sizeMultiplier: 1,
          indicationType: existing.indicationType,
          marketType: existing.marketType,
          lotSize: existing.lotSize,
          quoteToUsdRate: existing.quoteToUsdRate,
        },
      ).catch(() => null)
      maxExecutionNotionalUsd = Number(recoveryVolumeResult?.maxExecutionNotionalUsd || 0)
      if (maxExecutionNotionalUsd > 0) {
        existing.maxExecutionNotionalUsd = maxExecutionNotionalUsd
      }
    }
    if (!(maxExecutionNotionalUsd > 0)) {
      // Legacy rows and lightweight connector adapters may predate the
      // persisted ceiling field. The already-confirmed physical exposure is
      // useful for reconciliation, but it is not an authorization to create
      // more exposure: multiplying it here would let an old/high-volume row
      // manufacture a new risk budget when the authoritative PositionCost
      // calculation is unavailable. Keep the existing position protected and
      // fail closed until the canonical ceiling can be restored.
      const observedNotional = positionNotionalUsd(
        existing,
        Number(existing.executedQuantity || 0),
        price,
      )
      pushStep(
        existing,
        "accumulation_volume_cap_unavailable",
        false,
        observedNotional > 0
          ? `canonical PositionCost ceiling unavailable; existing ${observedNotional.toFixed(2)} USD exposure remains protected and no add-on is sent`
          : "canonical PositionCost ceiling unavailable; no add-on is sent",
      )
      existing.liveMultiplierCapped = true
      existing.statusReason = "Accumulation halted: canonical PositionCost exposure ceiling unavailable"
      await savePosition(existing)
      return existing
    }
    const accumulationAdmission = admitAccumulationQuantity(
      existing,
      plan.addQty,
      price,
      accumulationRules,
      maxExecutionNotionalUsd,
    )
    if (!(accumulationAdmission.quantity > 0)) {
      pushStep(
        existing,
        "accumulation_volume_cap",
        false,
        accumulationAdmission.reason || "no executable quantity remains within the PositionCost ceiling",
      )
      existing.statusReason = accumulationAdmission.reason || "Accumulation halted by PositionCost exposure ceiling"
      existing.liveMultiplierCapped = true
      await savePosition(existing)
      return existing
    }
    if (accumulationAdmission.capped) {
      plan = {
        ...plan,
        addQty: accumulationAdmission.quantity,
        maxExecutionNotionalUsd: accumulationAdmission.maxNotionalUsd,
        liveMultiplierCapped: true,
      }
      existing.liveMultiplierCapped = true
      pushStep(existing, "accumulation_volume_cap", true, accumulationAdmission.reason || "add-on reduced to PositionCost ceiling")
    }

    const accumulationExecutable = resolveExecutableQuantity(
      plan.addQty,
      price,
      accumulationRules,
      { universalMinNotionalUsdt: 0 },
    )
    const boundedExecutable = remainingExposureNotionalUsd !== undefined
      ? quantityWithinRemainingNotional(
          existing,
          accumulationExecutable.quantity,
          price,
          accumulationRules,
          remainingExposureNotionalUsd,
        )
      : { quantity: accumulationExecutable.quantity, notionalUsd: 0 }
    if (remainingExposureNotionalUsd !== undefined) {
      if (!(boundedExecutable.quantity > 0)) {
        pushStep(
          existing,
          "accumulation_venue_exposure_cap",
          false,
          "venue quantity normalization would exceed the remaining PositionCost budget",
        )
        existing.statusReason = "Accumulation halted: venue quantity normalization exceeded the PositionCost ceiling"
        existing.liveMultiplierCapped = true
        await rearmProtectionAfterQuantityMutation(connector, existing, "accumulation_venue_exposure_rounding")
        await verifyProtection("accumulation_venue_exposure_rounding")
        return existing
      }
    }
    const executableQuantity = remainingExposureNotionalUsd !== undefined
      ? boundedExecutable.quantity
      : accumulationExecutable.quantity
    const executableTotalNotional = positionNotionalUsd(
      existing,
      Number(existing.executedQuantity || 0) + Number(executableQuantity || 0),
      price,
    )
    if (
      !(executableQuantity > 0) ||
      (remainingExposureNotionalUsd !== undefined && boundedExecutable.notionalUsd > remainingExposureNotionalUsd + 1e-8) ||
      executableTotalNotional > maxExecutionNotionalUsd + 1e-8
    ) {
      pushStep(existing, "accumulate_skip", false, "ratio delta does not produce an executable exchange quantity")
      await savePosition(existing)
      return existing
    }
    if (accumulationExecutable.adjusted || executableQuantity !== accumulationExecutable.quantity) {
      plan = {
        ...plan,
        addQty: executableQuantity,
      }
      pushStep(existing, "accumulation_quantity_normalized", true, `${accumulationExecutable.requestedQuantity} → ${plan.addQty} (${accumulationExecutable.reason || "exchange quantity rules"})`)
    }
    if (
      plan.variant === "special" &&
      plan.specialBaseQuantity &&
      Number(existing.executedQuantity || 0) + plan.addQty > plan.specialBaseQuantity * 3 + 1e-12
    ) {
      pushStep(existing, "special_volume_cap", false, "exchange quantity rounding would exceed the hard 3x Special cap")
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

    // Resolve and validate the independent quantity delta before cancelling
    // any existing SL/TP. A non-ready Block/DCA/default overlay must leave
    // the currently protected position completely untouched.
    if (!await settleControlOrdersBeforeQuantityMutation(connector, existing, "accumulation")) {
      await savePosition(existing)
      await verifyProtection("accumulation_control_settlement")
      return existing
    }

    const symbol = String(real?.symbol || existing.symbol || "")
    const direction = storedDirection
    const exchangeSide: "buy" | "sell" = direction === "long" ? "buy" : "sell"

    // Re-read the venue's physical slot after the control-order barrier. The
    // earlier quantity reconciliation is a prerequisite, not a reservation:
    // another worker or a delayed fill may have changed the slot while SL/TP
    // controls were being settled. Subtract the confirmed venue notional one
    // more time and round the add-on down; never use the local row quantity as
    // a proxy for account state.
    if (process.env.NODE_ENV !== "test") {
      try {
        const exposureConnection = { ...(await getConnection(connId).catch(() => ({}))), id: connId }
        const venueExposure = await resolveLiveOrderExposureCeiling(
          {
            connectionId: connId,
            symbol,
            side: direction,
            positionDirection: direction,
            quantity: plan.addQty,
            connection: exposureConnection,
            marketType: existing.marketType,
            lotSize: existing.lotSize,
            quoteToUsdRate: existing.quoteToUsdRate,
            positionCostPercentOverride: existing.positionCostPct,
            maxExecutionNotionalUsd,
            source: existing.executionIntent === "direct"
              ? "direct-trade"
              : existing.executionIntent === "preset"
                ? "preset-trade"
                : existing.executionIntent === "signal"
                  ? "signal-trade"
                  : "main-trade",
            liveTradeIntent: existing.executionIntent,
          } as any,
          exposureConnection,
          connector,
          symbol,
          price,
        )
        remainingExposureNotionalUsd = venueExposure.maxNotionalUsd
        const bounded = quantityWithinRemainingNotional(
          existing,
          plan.addQty,
          price,
          accumulationRules,
          venueExposure.maxNotionalUsd,
        )
        if (!(bounded.quantity > 0)) {
          pushStep(
            existing,
            "accumulation_venue_exposure_cap",
            false,
            `venue PositionCost budget remaining ${venueExposure.maxNotionalUsd.toFixed(2)} USD is below the executable add-on minimum`,
          )
          existing.statusReason = "Accumulation halted: venue PositionCost exposure ceiling reached"
          existing.liveMultiplierCapped = true
          await rearmProtectionAfterQuantityMutation(connector, existing, "accumulation_venue_exposure_cap")
          await verifyProtection("accumulation_venue_exposure_cap")
          return existing
        }
        if (bounded.quantity + 1e-12 < plan.addQty) {
          plan = {
            ...plan,
            addQty: bounded.quantity,
            maxExecutionNotionalUsd,
            liveMultiplierCapped: true,
          }
          existing.liveMultiplierCapped = true
          pushStep(
            existing,
            "accumulation_venue_exposure_cap",
            true,
            `venue-confirmed add-on reduced to ${bounded.quantity} (${bounded.notionalUsd.toFixed(2)} USD remaining budget)`,
          )
        }
      } catch (error) {
        pushStep(
          existing,
          "accumulation_venue_exposure_snapshot",
          false,
          error instanceof Error ? error.message : String(error),
        )
        existing.statusReason = "Accumulation halted: authoritative venue exposure snapshot unavailable"
        existing.liveMultiplierCapped = true
        await rearmProtectionAfterQuantityMutation(connector, existing, "accumulation_venue_exposure_snapshot")
        await verifyProtection("accumulation_venue_exposure_snapshot")
        return existing
      }
    }

    const clientOrderId = makeDurableClientOrderId("acc", existing)
    const nativeForexProtection = (() => {
      if (existing.marketType !== "forex" || typeof connector?.getCapabilities !== "function") return {}
      try {
        const capabilities = connector.getCapabilities()
        if (!Array.isArray(capabilities) || !capabilities.includes("native_position_sl_tp")) return {}
        const desired = computeDesiredProtectionPrices(existing)
        const sl = normalizeProtectionTriggerPrice(
          desired.desiredSl,
          Number(existing.priceTick || 0),
          direction,
          "stop_loss",
        )
        const tp = normalizeProtectionTriggerPrice(
          desired.desiredTp,
          Number(existing.priceTick || 0),
          direction,
          "take_profit",
        )
        return {
          ...(sl > 0 ? { stopLossPrice: sl } : {}),
          ...(tp > 0 ? { takeProfitPrice: tp } : {}),
        }
      } catch {
        return {}
      }
    })()
    existing.initialExecutedQuantity ??= existing.executedQuantity
    existing.initialEntryPrice ??= existing.averageExecutionPrice || existing.entryPrice
    if (plan.variant === "block") {
      existing.blockBaseQuantity = plan.blockBaseQuantity
      existing.blockIncrementSteps = plan.blockIncrementSteps
    }
    else existing.blockBaseQuantity ??= existing.initialExecutedQuantity
    if (plan.dcaProfile) existing.dcaProfile = plan.dcaProfile
    const blockSetQuantityBefore = plan.variant === "block"
      ? Number(existing.blockLegs?.find((leg) => leg.setKey === accumulationSetKey)?.quantity || 0)
      : undefined
    existing.pendingAccumulation = {
      clientOrderId,
      setKey: accumulationSetKey,
      parentSetKey: String(real?.parentSetKey || ""),
      indicationType: String(real?.indicationType || ""),
      axisKey: axisKeyFromLineage(String(real?.setKey || ""), real?.axisWindows),
      accumulatedSetKeys: (
        real?.combinedPosCounts ||
        String(real?.setVariant || real?.variant || "") === "block"
      )
        ? strategyLineageKeysForAdjustment(real, accumulationSetKey)
        : undefined,
      posCountsSetRatios: real?.combinedPosCounts ? { ...(real?.posCountsSetRatios || {}) } : undefined,
      combinedPosCounts: real?.combinedPosCounts === true,
      requestedQuantity: plan.addQty,
      positionQuantityBefore: Number(existing.executedQuantity || 0),
      appliedFilledQuantity: 0,
      blockSetQuantityBefore,
      submittedAt: Date.now(),
      variant: plan.variant,
      blockCount: plan.blockCount,
      blockBaseQuantity: plan.blockBaseQuantity,
      blockConfirmedAddQuantity: plan.blockConfirmedAddQuantity,
      blockTargetAddQuantity: plan.blockTargetAddQuantity,
      blockTargetQuantity: plan.blockTargetQuantity,
      blockBaseVolumeMultiplier: plan.variant === "block"
        ? 1
        : Number(real?.blockBaseVolumeMultiplier || 1),
      blockVolumeRatio: Number(real?.blockVolumeRatio || 1),
      blockIncrementSteps: normalizeBlockIncrementSteps(
        plan.blockIncrementSteps ?? real?.blockIncrementSteps,
      ),
      blockVolumeIncrementRatio: Number(
        real?.blockVolumeIncrementRatio ||
        (plan.blockCount
          ? calculateBlockVolumeIncrementRatio(
              plan.blockCount,
              Number(real?.blockVolumeRatio || 1),
              plan.blockIncrementSteps,
            )
          : 1),
      ),
      blockCalculatedVolumeMultiplier: plan.variant === "block" && plan.blockCount
        ? 1 + calculateBlockVolumeIncrementRatio(
            plan.blockCount,
            Number(real?.blockVolumeRatio || 1),
            plan.blockIncrementSteps,
          )
        : Number(real?.blockCalculatedVolumeMultiplier || real?.sizeMultiplier || 1),
      blockScope: real?.blockScope,
      blockLaneKind: real?.blockLaneKind,
      blockLaneKey: real?.blockLaneKey,
      blockSourceId: real?.blockSourceId,
      signalRisk: normalizeSignalRisk(real?.signalRisk),
      stopLoss: Number(real?.stopLoss) > 0 ? Number(real.stopLoss) : undefined,
      takeProfit: Number(real?.takeProfit) > 0 ? Number(real.takeProfit) : undefined,
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

    // The pending marker and control-order barrier are durable, but neither is
    // a venue reservation. Re-read the exact physical slot immediately before
    // the only risk-increasing mutation and round the final add-on down again.
    // This closes the last direct-connector bypass for Block/DCA/combined
    // accumulation when an external fill or another worker changes the slot
    // between admission and submission.
    if (process.env.NODE_ENV !== "test") {
      try {
        const exposureConnection = { ...(await getConnection(connId).catch(() => ({}))), id: connId }
        const venueExposure = await resolveLiveOrderExposureCeiling(
          {
            connectionId: connId,
            symbol,
            side: direction,
            positionDirection: direction,
            quantity: plan.addQty,
            connection: exposureConnection,
            marketType: existing.marketType,
            lotSize: existing.lotSize,
            quoteToUsdRate: existing.quoteToUsdRate,
            positionCostPercentOverride: existing.positionCostPct,
            maxExecutionNotionalUsd,
            source: existing.executionIntent === "direct"
              ? "direct-trade"
              : existing.executionIntent === "preset"
                ? "preset-trade"
                : existing.executionIntent === "signal"
                  ? "signal-trade"
                  : "main-trade",
            liveTradeIntent: existing.executionIntent,
          } as any,
          exposureConnection,
          connector,
          symbol,
          price,
        )
        const finalAdmission = quantityWithinRemainingNotional(
          existing,
          plan.addQty,
          price,
          accumulationRules,
          venueExposure.maxNotionalUsd,
        )
        if (!(finalAdmission.quantity > 0)) {
          existing.pendingAccumulation = undefined
          existing.liveMultiplierCapped = true
          existing.statusReason = "Accumulation halted: final venue PositionCost recheck left no executable add-on"
          pushStep(existing, "accumulation_submission_blocked", false, existing.statusReason)
          await savePosition(existing)
          await rearmProtectionAfterQuantityMutation(connector, existing, "accumulation_final_exposure_recheck")
          await verifyProtection("accumulation_final_exposure_recheck")
          return existing
        }
        if (finalAdmission.quantity + 1e-12 < plan.addQty) {
          plan = {
            ...plan,
            addQty: finalAdmission.quantity,
            maxExecutionNotionalUsd: venueExposure.maxNotionalUsd,
            liveMultiplierCapped: true,
          }
          existing.liveMultiplierCapped = true
          if (existing.pendingAccumulation) existing.pendingAccumulation.requestedQuantity = finalAdmission.quantity
          pushStep(
            existing,
            "accumulation_submission_cap",
            true,
            `final venue-confirmed add-on reduced to ${finalAdmission.quantity} (${finalAdmission.notionalUsd.toFixed(2)} USD remaining budget)`,
          )
          await savePosition(existing)
          await persistCriticalLiveState(`accumulation-final-quantity:${existing.id}`)
        }
      } catch (error) {
        existing.pendingAccumulation = undefined
        existing.liveMultiplierCapped = true
        existing.statusReason = "Accumulation halted: final authoritative venue exposure snapshot unavailable"
        pushStep(
          existing,
          "accumulation_submission_snapshot",
          false,
          error instanceof Error ? error.message : String(error),
        )
        await savePosition(existing)
        await rearmProtectionAfterQuantityMutation(connector, existing, "accumulation_final_exposure_snapshot")
        await verifyProtection("accumulation_final_exposure_snapshot")
        return existing
      }
    }

    if (shouldContinue && !await Promise.resolve(shouldContinue()).catch(() => false)) {
      existing.pendingAccumulation = undefined
      existing.statusReason = "Accumulation stopped before venue submission because its execution owner lease ended"
      pushStep(existing, "accumulation_owner_stopped", false, existing.statusReason)
      await savePosition(existing)
      await rearmProtectionAfterQuantityMutation(connector, existing, "accumulation_owner_stopped")
      await verifyProtection("accumulation_owner_stopped")
      return existing
    }

    let orderRes: any
    try {
      orderRes = await connector.placeOrder(
        symbol,
        exchangeSide,
        plan.addQty,
        undefined,
        "market",
        {
          positionSide: direction === "long" ? "LONG" : "SHORT",
          clientOrderId,
          ...(existing.positionTicket ? { positionTicket: existing.positionTicket } : {}),
          ...nativeForexProtection,
        },
      )
    } catch (err) {
      orderRes = { success: false, error: err instanceof Error ? err.message : String(err) }
    }

    if (!(orderRes?.orderId || orderRes?.id)) {
      const recovered = await recoverEntryOrderByClientId(connector, symbol, clientOrderId)
      if (recovered) orderRes = recovered
    }
    const orderId = orderRes?.orderId || orderRes?.id
    if (orderRes?.success === false || !orderId) {
      pushStep(existing, "accumulate_order_unconfirmed", false, `tracking by clientOrderId until authoritative recovery: ${orderRes?.error || "no order id"}`)
      await savePosition(existing)
      await reconcilePendingAccumulationAndRearm(connector, existing, "accumulation_unconfirmed")
      await verifyProtection("accumulation_unconfirmed")
      return existing
    }
    if (existing.pendingAccumulation) existing.pendingAccumulation.orderId = String(orderId)
    await recordPositionAdjustmentProgression(
      connId,
      existing,
      "placed",
      clientOrderId,
    )
    await savePosition(existing)

    let fillStatus = String(orderRes.status ?? orderRes.orderStatus ?? "").toLowerCase().trim()
    let filledQty = parseFloat(String(orderRes.filledQty ?? orderRes.executedQty ?? orderRes.cumQty ?? "0")) || 0
    let filledPrice = parseFloat(String(orderRes.filledPrice ?? orderRes.avgPrice ?? "0")) || 0
    if (filledQty <= 0) {
      const fill = await pollOrderFill(connector, symbol, String(orderId), 5_000)
      fillStatus = String(fill.status || fillStatus).toLowerCase().trim()
      if (fill.filledQty > 0) {
        filledQty = fill.filledQty
        filledPrice = fill.filledPrice
      }
    }
    const entrySettlement = await readOrderSettlement(connector, symbol, String(orderId))
    if (entrySettlement) {
      filledQty = entrySettlement.filledQuantity
      filledPrice = entrySettlement.averageFillPrice
      fillStatus = "filled_via_settlement"
    }
    if (filledQty <= 0 || !(filledPrice > 0)) {
      pushStep(existing, "accumulate_fill_pending", true, `orderId=${orderId}; exact fill deferred to reconciliation`)
      await savePosition(existing)
      await reconcilePendingAccumulationAndRearm(connector, existing, "accumulation_fill_pending")
      await verifyProtection("accumulation_fill_pending")
      return existing
    }

    const prevExec = Number(existing.executedQuantity || 0)
    const prevAvg = Number(existing.averageExecutionPrice || existing.entryPrice || filledPrice)
    const newExec = prevExec + filledQty
    const pending = { ...existing.pendingAccumulation }
    const requestedTolerance = Math.max(1e-12, plan.addQty * 1e-8)
    const blockTargetSatisfied = plan.variant !== "block" ||
      filledQty >= plan.addQty - requestedTolerance
    const terminalFillStatus = [
      "filled",
      "deal",
      "complete",
      "completed",
      "cancelled",
      "canceled",
      "rejected",
      "expired",
    ].includes(fillStatus)
    const retainPartialPending = plan.variant === "block" && !blockTargetSatisfied
    const blockSetQuantity = Number(pending.blockSetQuantityBefore || 0) + filledQty
    const mutated = await mutatePositionWithVersionCheck(existing, ["open", "filled", "partially_filled"], draft => {
      draft.executedQuantity = newExec
      draft.quantity = Math.max(Number(draft.quantity || 0), prevExec) + filledQty
      draft.remainingQuantity = Math.max(0, draft.quantity - newExec)
      draft.averageExecutionPrice = newExec > 0 ? ((prevAvg * prevExec) + (filledPrice * filledQty)) / newExec : prevAvg
      draft.volumeUsd = positionNotionalUsd(draft, newExec, draft.averageExecutionPrice)
      draft.totalExecutedQuantity = Math.max(
        Number(draft.totalExecutedQuantity || 0),
        newExec + Number(draft.closedQuantity || 0),
      )
      draft.fills = [...(draft.fills || []), {
        orderId: String(orderId),
        settlementSource: entrySettlement?.source,
        timestamp: Date.now(),
        quantity: filledQty,
        price: filledPrice,
        fee: Math.max(0, Number(entrySettlement?.tradingFee) || 0),
        feeAsset: "USDT",
      }]
      draft.entryTradingFee = Number(((Number(draft.entryTradingFee) || 0)
        + Math.max(0, Number(entrySettlement?.tradingFee) || 0)).toFixed(12))
      draft.entryAccountingComplete = draft.entryAccountingComplete === true && Boolean(entrySettlement)
      if (entrySettlement) {
        draft.entrySettlementOrderIds = Array.from(new Set([
          ...(draft.entrySettlementOrderIds || []),
          entrySettlement.orderId,
        ])).slice(-64)
      }
      draft.accumulatedSetKeys = real?.combinedPosCounts
        ? Array.from(new Set<string>((Array.isArray(real.accumulatedSetKeys) ? real.accumulatedSetKeys : []).map((value: unknown) => String(value)).filter(Boolean)))
        : plan.variant === "block" && !blockTargetSatisfied
          ? [...(draft.accumulatedSetKeys || [])]
          : [...new Set([
              ...(draft.accumulatedSetKeys || []),
              ...strategyLineageKeysForAdjustment(real, accumulationSetKey),
            ])]
      applyAccumulatedSignalRisk(draft, real)
      if (real?.combinedPosCounts) {
        draft.posCountsSetRatios = { ...(pending.posCountsSetRatios || real?.posCountsSetRatios || draft.posCountsSetRatios || {}) }
        draft.posCountsSetQuantities = allocatePositionSetQuantities(draft, newExec, draft.accumulatedSetKeys)
      }
      draft.pendingAccumulation = retainPartialPending
        ? {
            ...pending,
            orderId: String(orderId),
            appliedFilledQuantity: filledQty,
          } as LivePosition["pendingAccumulation"]
        : undefined
      if (plan.variant === "block") {
        const leg = buildBlockLegState(real, blockSetQuantity, clientOrderId, String(orderId), {
          baseQuantity: plan.blockBaseQuantity,
          targetAdditionalQuantity: plan.blockTargetAddQuantity,
          confirmedAdditionalQuantityBefore: plan.blockConfirmedAddQuantity,
          targetBlockQuantity: plan.blockTargetQuantity,
          targetSatisfied: blockTargetSatisfied,
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
      pushStep(
        draft,
        blockTargetSatisfied ? "accumulate" : "accumulate_partial",
        true,
        `+${filledQty} @ ${filledPrice} (setKey=${pending.setKey || "n/a"}, ` +
          `total=${newExec}, requested=${plan.addQty}, pending=${retainPartialPending})`,
      )
    })
    if (!mutated) {
      pushStep(existing, "accumulate_fill_pending", false, "stale version; exact fill deferred to reconciliation")
      await savePosition(existing)
      await reconcilePendingAccumulationAndRearm(
        connector,
        existing,
        "accumulation_stale_version",
      )
      await verifyProtection("accumulation_stale_version")
      return existing
    }
    Object.assign(existing, mutated)
    if (retainPartialPending) {
      await savePosition(existing)
      await reconcilePendingAccumulationAndRearm(
        connector,
        existing,
        terminalFillStatus
          ? "accumulation_terminal_partial"
          : "accumulation_partial_fill",
      )
      const retained = existing.pendingAccumulation
      const appliedFilledQuantity = Number(retained?.appliedFilledQuantity || 0)
      if (
        terminalFillStatus &&
        retained?.clientOrderId === clientOrderId &&
        appliedFilledQuantity > 0
      ) {
        await recordPositionAdjustmentProgression(
          connId,
          existing,
          "filled",
          clientOrderId,
          appliedFilledQuantity * Number(existing.averageExecutionPrice || existing.entryPrice || filledPrice),
        )
        pushStep(
          existing,
          "accumulation_terminal_partial",
          true,
          `orderId=${orderId}; confirmed partial=${appliedFilledQuantity}; residual retry allowed`,
        )
        existing.pendingAccumulation = undefined
        await savePosition(existing)
      }
      await verifyProtection("accumulation_partial_fill")
      return existing
    }
    await recordPositionAdjustmentProgression(
      connId,
      existing,
      "filled",
      clientOrderId,
      filledQty * filledPrice,
    )
    await savePosition(existing)
    if (blockTargetSatisfied && pending.combinedPosCounts) {
      await recordConfirmedStrategyEntry(
        connId,
        existing,
        `${existing.id}:combined:${pending.clientOrderId}`,
      )
    } else if (blockTargetSatisfied && pending.setKey) {
      await recordConfirmedStrategyEntry(
        connId,
        existing,
        `${existing.id}:set:${pending.setKey}`,
        {
          setKey: pending.setKey,
          parentSetKey: pending.parentSetKey,
          indicationType: pending.indicationType,
          axisKey: pending.axisKey,
          setKeys: pending.accumulatedSetKeys,
        },
      )
    }
    await rearmProtectionAfterQuantityMutation(connector, existing, "accumulate_rearm")
    await verifyProtection("accumulation_complete")
  } catch (err) {
    pushStep(existing, "accumulate_error", false, err instanceof Error ? err.message : String(err))
    try {
      await savePosition(existing)
      await reconcilePendingAccumulationAndRearm(connector, existing, "accumulation_error_rearm")
      await verifyProtection("accumulation_error_rearm")
    } catch {
      /* best-effort; canonical reconcile retries the durable pending action */
    }
  } finally {
    await entryProtectionAdmissionLease?.release().catch(() => undefined)
    stopPositionLockLeaseRefresh()
    await releasePositionMutationLock(connId, existing.id, lockId).catch(() => false)
  }
  return existing
}

function isActiveLiveStatus(position: LivePosition): boolean {
  return ["open", "filled", "partially_filled", "placed", "pending", "pending_fill", "placed_unconfirmed", "simulated"]
    .includes(String(position.status || ""))
}

async function findOpenCombinedPosCountPositions(
  connId: string,
  symbol: string,
  parentSetKey: string | undefined,
  direction: "long" | "short",
): Promise<LivePosition[]> {
  const normalized = String(symbol || "").toUpperCase().replace(/[-_]/g, "")
  const exactParent = String(parentSetKey || "")
  const positions = await getLivePositions(connId)
  return positions.filter((position) =>
    position.combinedPosCounts === true &&
    isActiveLiveStatus(position) &&
    position.direction === direction &&
    String(position.parentSetKey || "") === exactParent &&
    String(position.symbol || "").toUpperCase().replace(/[-_]/g, "") === normalized,
  )
}

async function fetchAuthoritativeOpenQuantity(
  connector: any,
  symbol: string,
  direction: "long" | "short",
): Promise<{ ok: boolean; quantity: number; position: any | null }> {
  if (!connector || (typeof connector.getPositions !== "function" && typeof connector.getPosition !== "function")) {
    return { ok: false, quantity: 0, position: null }
  }
  try {
    if (typeof connector.getPositions === "function") {
      const snapshot = await withTimeout(
        connector.getPositions(symbol) as Promise<any>,
        EXCHANGE_TIMEOUT_GET_ORDER_MS,
        `getPositions(${symbol} ${direction})`,
      )
      const snapshotStatus = typeof connector.getLastPositionsSnapshotStatus === "function"
        ? connector.getLastPositionsSnapshotStatus()
        : null
      if (snapshotStatus && snapshotStatus.ok !== true) {
        return { ok: false, quantity: 0, position: null }
      }
      if (!Array.isArray(snapshot)) return { ok: false, quantity: 0, position: null }
      const requestedSymbol = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "")
      const rows = snapshot.filter((row: any) => {
        const rowSymbol = String(row?.symbol ?? row?.instrument ?? row?.contract ?? "")
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "")
        return !rowSymbol || rowSymbol === requestedSymbol
      })
      const activeRows = rows.filter((row: any) => extractExchangeOpenQuantity(row) > 0)
      const symbollessActiveRows = activeRows.filter((row: any) => !String(
        row?.symbol ?? row?.instrument ?? row?.contract ?? "",
      ).trim())
      if (symbollessActiveRows.length > 0 && activeRows.length > 1) {
        return { ok: false, quantity: 0, position: null }
      }
      const matchingRows = activeRows.filter((row: any) => normalizeExchangePositionDirection(
        row?.direction ?? row?.positionSide ?? row?.position_side,
        row?.side,
        row?.positionAmt ?? row?.position_amount ?? row?.positionSizeSigned,
      ) === direction)
      if (activeRows.some((row: any) => !normalizeExchangePositionDirection(
        row?.direction ?? row?.positionSide ?? row?.position_side,
        row?.side,
        row?.positionAmt ?? row?.position_amount ?? row?.positionSizeSigned,
      ))) {
        return { ok: false, quantity: 0, position: null }
      }
      const quantity = matchingRows.reduce((sum: number, row: any) => (
        sum + extractExchangeOpenQuantity(row)
      ), 0)
      return {
        ok: true,
        quantity,
        // A ticket from one row must never be reused when several venue rows
        // make up the aggregate slot. Callers may use this only when exact.
        position: matchingRows.length === 1 ? matchingRows[0] : null,
      }
    }

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

async function reconcilePendingReductionAndRearm(
  connector: any,
  position: LivePosition,
  reason: string,
): Promise<void> {
  if (!connector || Number(position.executedQuantity || 0) <= 0) return
  const direction = resolveLivePositionDirection(position)
  if (!direction) {
    pushStep(position, "reduction_rearm_direction_guard", false, `${reason}: invalid long/short direction`)
    await savePosition(position)
    return
  }

  const pending = position.pendingReduction
  if (pending) {
    const authoritative = await fetchAuthoritativeOpenQuantity(connector, position.symbol, direction)
    if (authoritative.ok) {
      const tolerance = Math.max(1e-12, pending.targetQuantity * 1e-8)
      const targetReached = authoritative.quantity <= pending.targetQuantity + tolerance
      const settlement = pending.orderId
        ? await readOrderSettlement(connector, position.symbol, pending.orderId)
        : null
      const applied = applyReductionObservation(position, {
        executionId: `${position.id}:poscounts:${pending.clientOrderId}`,
        source: "poscounts_reduce",
        status: targetReached ? "filled" : "partially_filled",
        requestedQuantity: pending.requestedQuantity,
        reportedFilledQuantity: 0,
        previouslyAppliedQuantity: pending.appliedFilledQuantity,
        authoritativeQuantity: authoritative.quantity,
        price: settlement?.averageFillPrice,
        settlement,
        orderId: pending.orderId,
        clientOrderId: pending.clientOrderId,
        setKeys: pending.targetMemberKeys,
        setRatios: pending.targetSetRatios,
      })
      pending.appliedFilledQuantity = applied.cumulativeApplied
      if (
        targetReached ||
        applied.cumulativeApplied >= pending.requestedQuantity * (1 - 1e-8)
      ) {
        position.pendingReduction = undefined
      } else {
        position.pendingReduction = pending
      }
    } else {
      pushStep(
        position,
        "reduction_rearm_snapshot_unavailable",
        false,
        `${reason}: protecting intended remainder ${pending.targetQuantity}`,
      )
    }
  }

  const retainedQuantity = position.pendingReduction
    ? Math.min(
        Number(position.executedQuantity || 0),
        Math.max(0, Number(position.pendingReduction.targetQuantity || 0)),
      )
    : Number(position.executedQuantity || 0)
  await rearmProtectionAfterQuantityMutation(
    connector,
    position,
    reason,
    {
      allowPendingReduction: true,
      quantityOverride: retainedQuantity,
    },
  )
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
  const direction = resolveLivePositionDirection(position)
  if (!direction) {
    pushStep(position, "poscounts_direction_guard", false, "No explicit long/short direction; reduction blocked")
    await savePosition(position)
    return position
  }
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
  let entryProtectionAdmissionLease: EntryProtectionAdmissionLease | null = null

  const verifyReductionProtection = async (reason: string): Promise<boolean> => {
    const decision = await verifyConnectionProtectionAndPersistHalt({
      connectionId,
      symbol: position.symbol,
      direction,
      connector,
      reason,
    })
    if (!decision.safe) {
      const violations = decision.violations.slice(0, 8).join(",") || "unknown"
      position.statusReason =
        `${reason}: protection is not authoritative; new exposure halted (${violations})`
      pushStep(position, "quantity_protection_halt", false, position.statusReason)
    } else {
      pushStep(
        position,
        "quantity_protection_verified",
        true,
        `${reason}: reduced quantity and all exact controls are authoritative`,
      )
    }
    await savePosition(position).catch(() => undefined)
    return decision.safe
  }

  try {
    const fresh = await readLivePositionSnapshot(getRedisClient(), connectionId, position.id)
    if (fresh) Object.assign(position, fresh)
    entryProtectionAdmissionLease = await acquireEntryProtectionAdmissionLease(
      connectionId,
      `poscounts-reduce:${position.id}`,
    )
    if (!entryProtectionAdmissionLease) {
      pushStep(
        position,
        "poscounts_reduce_deferred",
        false,
        "connection-wide protection admission is busy — reduction deferred",
      )
      await savePosition(position)
      return position
    }
    const side: "buy" | "sell" = direction === "long" ? "sell" : "buy"
    const hadPendingReduction = !!position.pendingReduction

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
      const settlement = pending.orderId
        ? await readOrderSettlement(connector, position.symbol, pending.orderId)
        : null
      const applied = applyReductionObservation(position, {
        executionId: `${position.id}:poscounts:${pending.clientOrderId}`,
        source: "poscounts_reduce",
        status,
        requestedQuantity: pending.requestedQuantity,
        reportedFilledQuantity: reportedFilled,
        previouslyAppliedQuantity: pending.appliedFilledQuantity,
        authoritativeQuantity: authoritative.ok ? authoritative.quantity : null,
        price: Number(observed?.filledPrice ?? observed?.avgPrice ?? 0) || undefined,
        settlement,
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
          await reconcilePendingReductionAndRearm(connector, position, "poscounts_reduce_tracking_wait")
          await verifyReductionProtection("poscounts_reduce_tracking_wait")
          return position
        }
        pending.absenceConfirmations = Number(pending.absenceConfirmations || 0) + 1
        const targetReached = authoritative.quantity <= pending.targetQuantity * (1 + 1e-8)
        if (!targetReached && pending.absenceConfirmations < 2) {
          position.pendingReduction = pending
          await savePosition(position)
          await reconcilePendingReductionAndRearm(connector, position, "poscounts_reduce_absence_wait")
          await verifyReductionProtection("poscounts_reduce_absence_wait")
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
        await reconcilePendingReductionAndRearm(connector, position, "poscounts_reduce_active_wait")
        await verifyReductionProtection("poscounts_reduce_active_wait")
        return position
      }
      position.pendingReduction = undefined
      await savePosition(position)
    }

    const beforeBarrierDelta = resolveCombinedPosCountDelta(
      Number(position.executedQuantity || 0),
      targetQuantity,
    )
    if (beforeBarrierDelta.action !== "reduce") {
      position.accumulatedSetKeys = [...new Set(targetMemberKeys)]
      position.posCountsSetQuantities = allocatePositionSetQuantities(
        position,
        Number(position.executedQuantity || 0),
        targetMemberKeys,
      )
      await savePosition(position)
      if (hadPendingReduction) {
        await reconcilePendingReductionAndRearm(connector, position, "poscounts_reduce_already_reconciled")
      }
      await verifyReductionProtection("poscounts_reduce_already_reconciled")
      return position
    }

    if (!await settleControlOrdersBeforeQuantityMutation(connector, position, "poscounts_reduce")) {
      await savePosition(position)
      await verifyReductionProtection("poscounts_reduce_control_settlement")
      return position
    }

    const currentQuantity = Number(position.executedQuantity || 0)
    const delta = resolveCombinedPosCountDelta(currentQuantity, targetQuantity)
    if (delta.action !== "reduce") {
      position.accumulatedSetKeys = [...new Set(targetMemberKeys)]
      position.posCountsSetQuantities = allocatePositionSetQuantities(position, currentQuantity, targetMemberKeys)
      await savePosition(position)
      await reconcilePendingReductionAndRearm(connector, position, "poscounts_reduce_changed_during_barrier")
      await verifyReductionProtection("poscounts_reduce_changed_during_barrier")
      return position
    }

    const reductionExecutable = resolveExecutableQuantity(
      delta.quantity,
      price,
      await loadExchangeQuantityRules(position.symbol, connector, connectionId),
      { reduceOnly: true },
    )
    if (!(reductionExecutable.quantity > 0)) {
      pushStep(position, "poscounts_reduce_wait", true, "ratio reduction is below the exchange quantity step")
      await savePosition(position)
      // The control barrier may already have cancelled row TP/SL before the
      // rounded reduce-only delta became non-executable. Restore protection
      // immediately; returning here without re-arm left a real position bare.
      await rearmProtectionAfterQuantityMutation(
        connector,
        position,
        "poscounts_reduce_below_step_rearm",
      )
      await verifyReductionProtection("poscounts_reduce_below_step_rearm")
      return position
    }
    const reductionQuantity = reductionExecutable.quantity

    const clientOrderId = makeDurableClientOrderId("pc-reduce", position)
    position.pendingReduction = {
      clientOrderId,
      requestedQuantity: reductionQuantity,
      targetQuantity,
      positionQuantityBefore: currentQuantity,
      targetMemberKeys: [...new Set(targetMemberKeys)],
      targetSetRatios: { ...targetSetRatios },
      appliedFilledQuantity: 0,
      submittedAt: Date.now(),
    }
    pushStep(position, "poscounts_reduction_prepared", true, `clientOrderId=${clientOrderId} qty=${reductionQuantity}`)
    await savePosition(position)
    await persistCriticalLiveState(`poscounts-reduce:${position.id}`)

    let response: any
    try {
      response = await connector.placeOrder(
        position.symbol,
        side,
        reductionQuantity,
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
    if (response?.success === false || !orderId) {
      pushStep(position, "poscounts_target_reduce", false, `${response?.error || "submission unconfirmed"}; durable clientOrderId retained`)
      await savePosition(position)
      await reconcilePendingReductionAndRearm(connector, position, "poscounts_reduce_unconfirmed")
      await verifyReductionProtection("poscounts_reduce_unconfirmed")
      return position
    }

    let filledQuantity = Number(response.filledQty ?? response.executedQty ?? response.cumQty ?? 0) || 0
    let filledPrice = Number(response.filledPrice ?? response.avgPrice ?? 0) || 0
    let fillStatus = String(response.status || "pending").toLowerCase()
    if (!(filledQuantity > 0)) {
      const fill = await pollOrderFill(connector, position.symbol, String(orderId), 5_000)
      filledQuantity = fill.filledQty
      filledPrice = fill.filledPrice || filledPrice
      fillStatus = fill.status
    }
    const authoritative = await fetchAuthoritativeOpenQuantity(connector, position.symbol, direction)
    const pending = position.pendingReduction!
    const settlement = await readOrderSettlement(connector, position.symbol, String(orderId))
    const applied = applyReductionObservation(position, {
      executionId: `${position.id}:poscounts:${pending.clientOrderId}`,
      source: "poscounts_reduce",
      status: fillStatus,
      requestedQuantity: pending.requestedQuantity,
      reportedFilledQuantity: filledQuantity,
      previouslyAppliedQuantity: pending.appliedFilledQuantity,
      authoritativeQuantity: authoritative.ok ? authoritative.quantity : null,
      price: filledPrice,
      settlement,
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
      await reconcilePendingReductionAndRearm(connector, position, "poscounts_reduce_partial_wait")
      await verifyReductionProtection("poscounts_reduce_partial_wait")
      return position
    }

    await rearmProtectionAfterQuantityMutation(connector, position, "poscounts_partial_rearm")
    await verifyReductionProtection("poscounts_reduce_complete")
    return position
  } catch (error) {
    pushStep(
      position,
      "poscounts_reduce_error",
      false,
      error instanceof Error ? error.message : String(error),
    )
    try {
      await reconcilePendingReductionAndRearm(connector, position, "poscounts_reduce_error_rearm")
      await verifyReductionProtection("poscounts_reduce_error_rearm")
    } catch {
      await savePosition(position).catch(() => undefined)
    }
    return position
  } finally {
    await entryProtectionAdmissionLease?.release().catch(() => undefined)
    stopLease()
    await releasePositionMutationLock(connectionId, position.id, lockId).catch(() => false)
  }
}

/** Reconcile one exact Base-parent × direction Pos-Count target.
 * Returns null only when no target position exists yet and the caller should
 * continue through the normal fresh-entry path. */
async function reconcileCombinedPosCountTarget(
  connectionId: string,
  realPosition: RealPosition,
  connector: any,
  executionIntent: LiveExecutionIntent,
  liveExecutionEnabled: boolean,
): Promise<LivePosition | null> {
  const existingPositions = await findOpenCombinedPosCountPositions(
    connectionId,
    realPosition.symbol,
    realPosition.parentSetKey,
    realPosition.direction,
  )
  let price = Number(realPosition.entryPrice || 0)
  if (!(price > 0)) price = await fetchCurrentPrice(realPosition.symbol, connectionId)

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
    {
      tradeMode: volumeTradeModeForIntent(executionIntent),
      sizeMultiplier: realPosition.sizeMultiplier,
      allowUnboundedVariantMultiplier: realPosition.combinedPosCounts === true,
      indicationType: realPosition.indicationType,
    },
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

  // Long and Short targets are independent. Never close the opposite side
  // while reconciling this exact Base-parent lane.
  const existing = existingPositions[0]
  if (!existing) return null
  const targetMemberKeys = [...new Set((realPosition.accumulatedSetKeys || []).map(String).filter(Boolean))]
  existing.combinedPosCounts = true
  existing.posCountsLongSetCount = realPosition.posCountsLongSetCount
  existing.posCountsShortSetCount = realPosition.posCountsShortSetCount
  existing.posCountsNetSetCount = realPosition.posCountsNetSetCount
  const targetSetRatios = { ...(realPosition.posCountsSetRatios || {}) }
  const delta = resolveCombinedPosCountDelta(Number(existing.executedQuantity || 0), targetQuantity)
  if (delta.action === "increase") {
    if (existing.status === "simulated") {
      return accumulateIntoSimulatedPosition(connectionId, existing, realPosition, price)
    }
    // A real venue position must never be converted into a simulated one
    // merely because the operator switched new Live entries off. Let the
    // live accumulator recover any durable pending submission, then defer
    // only the new quantity mutation.
    return accumulateIntoLivePosition(
      connectionId,
      existing,
      realPosition,
      price,
      connector,
      liveExecutionEnabled,
    )
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

async function rearmProtectionAfterQuantityMutation(
  connector: any,
  position: LivePosition,
  reason: string,
  options: {
    allowPendingAccumulation?: boolean
    allowPendingReduction?: boolean
    quantityOverride?: number
  } = {},
): Promise<void> {
  position.aggregateProtectionMutationRequestedAt = undefined
  position.aggregateProtectionMutationSettledAt = undefined
  position.aggregateProtectionMutationReason = undefined
  position.stopLossLastArmedAt = undefined
  position.takeProfitLastArmedAt = undefined
  if (
    Boolean(position.aggregateProtectionKey)
    || Number(position.aggregateProtectionMemberCount || 0) > 1
    || position.securityStopRequired === true
    || Boolean(position.securityStopOrderId)
  ) {
    // Restore this exact logical row immediately from the authoritative
    // post-mutation quantity. The aggregate finalizer then restores the other
    // rows and elects the one dynamic aggregate-quantity security stop for the slot.
    // This keeps an accepted-but-unconfirmed accumulation from removing venue
    // protection from the quantity that is already known to be open.
    await updateProtectionOrders(connector, position, reason, null, options).catch((error) => {
      pushStep(
        position,
        "quantity_protection_rearm_failed",
        false,
        error instanceof Error ? error.message : String(error),
      )
    })
    const direction = resolveLivePositionDirection(position)
    if (direction) {
      queueAggregateProtectionFinalization(
        position.connectionId,
        position.aggregateProtectionKey || aggregateProtectionSlot(position.symbol, direction),
      )
    }
    refreshProtectionHandlingMode(
      position,
      computeDesiredProtectionPrices(position).desiredSl,
      computeDesiredProtectionPrices(position).desiredTp,
    )
    pushStep(
      position,
      "aggregate_protection_rearm_queued",
      true,
      `${position.aggregateProtectionKey || position.symbol} quantity settled; aggregate venue re-arm queued`,
    )
    await savePosition(position)
    // A quantity mutation must not return with only the logical row controls
    // restored while the slot-level security stop is still absent or sized to
    // the pre-mutation quantity.  Run one bounded, authoritative aggregate
    // pass immediately; the normal sync queue remains as the retry path when
    // a venue snapshot or order acknowledgement is temporarily unavailable.
    const slotDirection = resolveLivePositionDirection(position)
    const slot = slotDirection
      ? aggregateProtectionSlot(position.symbol, slotDirection)
      : undefined
    if (slot && await rearmAggregateProtectionImmediately(position.connectionId, connector, position, slot)) {
      settleAggregateProtectionFinalizations(position.connectionId, [slot])
    }
    return
  }

  await updateProtectionOrders(connector, position, reason, null, options).catch((error) => {
    pushStep(
      position,
      "quantity_protection_rearm_failed",
      false,
      error instanceof Error ? error.message : String(error),
    )
  })
  await savePosition(position)
}

/**
 * Rebuild one physical slot's complete control-order set after a quantity
 * mutation.  This is deliberately read-before-write and bounded: if either
 * authoritative venue snapshot cannot be obtained, it leaves the durable
 * aggregate-finalization queue intact and returns false so the next sync can
 * retry without inventing a quantity or order id.
 */
async function rearmAggregateProtectionImmediately(
  connectionId: string,
  connector: any,
  position: LivePosition,
  slot: string,
): Promise<boolean> {
  if (!connector || typeof connector.getPositions !== "function") return false
  try {
    const [allRows, venueRows] = await Promise.all([
      getLivePositions(connectionId),
      withTimeout(
        connector.getPositions() as Promise<any>,
        EXCHANGE_TIMEOUT_GET_POSITIONS_MS,
        "getPositions(quantity-protection-rearm)",
      ),
    ])
    const venueStatus = typeof connector.getLastPositionsSnapshotStatus === "function"
      ? connector.getLastPositionsSnapshotStatus()
      : { ok: Array.isArray(venueRows) }
    if (venueStatus?.ok !== true || !Array.isArray(venueRows)) return false

    const liveOrderIds = await fetchLiveOrderIdSet(connector)
    if (typeof connector.getOpenOrders === "function" && liveOrderIds === null) return false

    const rowsById = new Map(allRows.map((row) => [row.id, row]))
    rowsById.set(position.id, position)
    const rows = [...rowsById.values()].filter((row) => {
      const direction = resolveLivePositionDirection(row)
      return direction && aggregateProtectionSlot(row.symbol, direction) === slot
    })
    if (rows.length === 0) return false

    await reconcileAggregateProtectionBook(
      connectionId,
      connector,
      rows,
      venueRows,
      liveOrderIds,
    )
    const refreshed = await getLivePositions(connectionId)
    const owner = refreshed.find((row) =>
      aggregateProtectionSlot(row.symbol, resolveLivePositionDirection(row)) === slot
      && Number(row.executedQuantity || 0) > 0
      && Boolean(row.securityStopOrderId),
    )
    if (owner && owner.id === position.id) {
      Object.assign(position, owner)
    } else {
      const current = refreshed.find((row) => row.id === position.id)
      if (current) Object.assign(position, current)
    }
    return Boolean(owner?.securityStopOrderId)
  } catch (error) {
    pushStep(
      position,
      "quantity_security_rearm_deferred",
      false,
      error instanceof Error ? error.message : String(error),
    )
    await savePosition(position).catch(() => undefined)
    return false
  }
}

/**
 * An accepted/unconfirmed market accumulation must never leave the already
 * open quantity without protection. Refresh the venue quantity first, apply
 * any exact fill that is already visible, then arm SL/TP for that canonical
 * quantity while retaining the durable pending order when its final state is
 * still unknown. The normal reconcile loop repeats this after a later fill.
 */
async function reconcilePendingAccumulationAndRearm(
  connector: any,
  position: LivePosition,
  reason: string,
): Promise<void> {
  if (!connector || Number(position.executedQuantity || 0) <= 0) return
  const direction = resolveLivePositionDirection(position)
  if (!direction) {
    pushStep(position, "accumulation_rearm_direction_guard", false, `${reason}: invalid long/short direction`)
    await savePosition(position)
    return
  }

  const authoritative = await fetchAuthoritativeOpenQuantity(connector, position.symbol, direction)
  if (authoritative.ok) {
    const entryPrice = Number(
      authoritative.position?.entryPrice ??
      authoritative.position?.avgPrice ??
      authoritative.position?.averagePrice ??
      position.averageExecutionPrice ??
      position.entryPrice ??
      0,
    ) || 0
    await reconcileAuthoritativeExchangeQuantity(position, authoritative.quantity, entryPrice)
  } else {
    // The last pre-submit snapshot was authoritative and the persisted local
    // quantity is therefore the minimum quantity known to exist. Protect it
    // immediately; the pending order remains durable and the next canonical
    // sync expands protection if the exchange later confirms an added fill.
    pushStep(
      position,
      "accumulation_rearm_snapshot_unavailable",
      false,
      `${reason}: protecting last confirmed quantity ${Number(position.executedQuantity || 0)}`,
    )
  }

  await rearmProtectionAfterQuantityMutation(
    connector,
    position,
    reason,
    { allowPendingAccumulation: true },
  )
}

function reconcileExchangeQuantityLedger(
  position: LivePosition,
  targetQuantity: number,
  entryPrice: number,
  source: ExchangeQuantityAdjustment["source"] = "exchange_reconcile",
): boolean {
  const target = Math.max(0, Number(targetQuantity) || 0)
  const price = Math.max(0, Number(entryPrice) || 0)
  if (!(target > 0) || !(price > 0)) return false

  const fills = Array.isArray(position.fills) ? position.fills : []
  const adjustments = Array.isArray(position.exchangeQuantityAdjustments)
    ? position.exchangeQuantityAdjustments
    : []
  const reconciled = reconcileExchangeQuantityAdjustments({
    positionId: position.id,
    orderId: position.orderId,
    targetQuantity: target,
    entryPrice: price,
    fills,
    adjustments,
    source,
  })
  if (!reconciled.changed) return false
  position.exchangeQuantityAdjustments = reconciled.adjustments as ExchangeQuantityAdjustment[]
  // The quantity is venue-authoritative, but the adjustment has no proven
  // order-level fee settlement. Keep PnL/history consumers from presenting it
  // as a fully settled entry until the venue ledger supplies that evidence.
  if (reconciled.expectedManagedAdjustmentQuantity > 0) position.entryAccountingComplete = false
  pushStep(
    position,
    "exchange_quantity_ledger_reconciled",
    true,
    reconciled.expectedManagedAdjustmentQuantity > 0
      ? `venue quantity gap set to ${reconciled.expectedManagedAdjustmentQuantity} at ${price} without synthetic fill/order settlement`
      : `removed ${reconciled.previousManagedAdjustmentQuantity} provisional venue quantity after exact fills arrived`,
  )
  return true
}

async function reconcileAuthoritativeExchangeQuantity(
  position: LivePosition,
  exchangeQuantity: number,
  exchangeEntryPrice: number,
): Promise<boolean> {
  if (!Number.isFinite(exchangeQuantity) || exchangeQuantity < 0) return false
  const repairedPriceDomain = repairLiveEntryPriceDomain(position, exchangeEntryPrice)
  const direction = resolveLivePositionDirection(position)
  if (!direction) {
    pushStep(position, "exchange_quantity_direction_guard", false, "Authoritative quantity ignored: direction is invalid")
    return false
  }
  const before = Number(position.executedQuantity || 0)
  const tolerance = Math.max(1e-12, Math.max(before, exchangeQuantity) * 1e-8)
  const ledgerTarget = Math.max(
    exchangeQuantity + Math.max(0, Number(position.closedQuantity || 0)),
    Number(position.totalExecutedQuantity || 0),
    exchangeQuantity,
  )
  const ledgerRepaired = reconcileExchangeQuantityLedger(
    position,
    ledgerTarget,
    exchangeEntryPrice || Number(position.averageExecutionPrice || position.entryPrice || 0),
  )
  if (Math.abs(before - exchangeQuantity) <= tolerance) {
    return repairedPriceDomain || ledgerRepaired
  }

  if (exchangeQuantity < before) {
    applyReductionObservation(position, {
      executionId: `${position.id}:exchange-qty:${exchangeQuantity}`,
      source: "exchange_reconcile",
      status: exchangeQuantity > 0 ? "partially_filled" : "filled",
      requestedQuantity: before,
      reportedFilledQuantity: before - exchangeQuantity,
      authoritativeQuantity: exchangeQuantity,
      setKeys: position.accumulatedSetKeys,
    })
    position.submissionState = "confirmed"
    return true
  }

  const pending = position.pendingAccumulation
  const entryRemainingBefore = Math.max(0, Number(position.remainingQuantity || 0))
  const exactAdded = Math.max(0, exchangeQuantity - Number(pending?.positionQuantityBefore ?? before))
  position.executedQuantity = exchangeQuantity
  position.quantity = Math.max(Number(position.quantity || 0), exchangeQuantity)
  position.remainingQuantity = Math.max(0, position.quantity - exchangeQuantity)
  if (exchangeEntryPrice > 0) position.averageExecutionPrice = exchangeEntryPrice
  if (!pending && entryRemainingBefore > 0) {
    const requestedEntryQuantity = Math.max(0, Number(position.quantity || 0))
    reconcileInitialEntryBaseQuantity(
      position,
      requestedEntryQuantity > 0
        ? Math.min(exchangeQuantity, requestedEntryQuantity)
        : exchangeQuantity,
    )
  }
  position.initialExecutedQuantity ??= before > 0 ? before : exchangeQuantity
  position.initialEntryPrice ??= position.averageExecutionPrice || position.entryPrice
  position.blockBaseQuantity ??= position.initialExecutedQuantity
  position.totalExecutedQuantity = Math.max(
    Number(position.totalExecutedQuantity || 0),
    exchangeQuantity + Number(position.closedQuantity || 0),
  )
  position.volumeUsd = positionNotionalUsd(
    position,
    exchangeQuantity,
    Number(position.averageExecutionPrice || position.entryPrice || 0),
  )
  position.submissionState = "confirmed"

  let pendingAccumulationCompleted = false
  if (pending && exactAdded > 0) {
    applyAccumulatedSignalRisk(position, pending)
    // A venue quantity increase is authoritative proof that the durable
    // accumulation was accepted and at least partially filled. Block orders
    // remain pending until their entire requested delta is authoritative;
    // partial observations update the exact Block leg without prematurely
    // completing the independent Count Set.
    const requestedTolerance = Math.max(1e-12, Number(pending.requestedQuantity || 0) * 1e-8)
    const blockTargetSatisfied = pending.variant !== "block" ||
      exactAdded >= Number(pending.requestedQuantity || 0) - requestedTolerance
    await recordPositionAdjustmentProgression(
      position.connectionId,
      position,
      "placed",
      pending.clientOrderId,
    )
    if (blockTargetSatisfied) {
      await recordPositionAdjustmentProgression(
        position.connectionId,
        position,
        "filled",
        pending.clientOrderId,
        exactAdded * Number(exchangeEntryPrice || position.averageExecutionPrice || position.entryPrice || 0),
      )
      position.accumulatedSetKeys = pending.combinedPosCounts
        ? [...new Set((pending.accumulatedSetKeys || []).map(String).filter(Boolean))]
        : [...new Set([
            ...(position.accumulatedSetKeys || []),
            ...((pending.accumulatedSetKeys && pending.accumulatedSetKeys.length > 0)
              ? pending.accumulatedSetKeys
              : (pending.setKey ? [pending.setKey] : [])),
          ])]
    }
    if (pending.variant === "block") {
      const leg = buildBlockLegState({
        setKey: pending.setKey,
        blockCount: pending.blockCount,
        blockBaseVolumeMultiplier: pending.blockBaseVolumeMultiplier,
        blockVolumeRatio: pending.blockVolumeRatio,
        blockIncrementSteps: pending.blockIncrementSteps,
        blockVolumeIncrementRatio: pending.blockVolumeIncrementRatio,
        blockCalculatedVolumeMultiplier: pending.blockCalculatedVolumeMultiplier,
        blockScope: pending.blockScope,
        blockLaneKind: pending.blockLaneKind,
        blockLaneKey: pending.blockLaneKey,
        blockSourceId: pending.blockSourceId,
      }, Number(pending.blockSetQuantityBefore || 0) + exactAdded, pending.clientOrderId, pending.orderId, {
        baseQuantity: pending.blockBaseQuantity,
        targetAdditionalQuantity: pending.blockTargetAddQuantity,
        confirmedAdditionalQuantityBefore: pending.blockConfirmedAddQuantity,
        targetBlockQuantity: pending.blockTargetQuantity,
        targetSatisfied: blockTargetSatisfied,
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
        direction,
        profile,
        initialEntryPrice: position.initialEntryPrice || position.entryPrice,
        averageEntryPrice: position.averageExecutionPrice,
        takeProfitPct: position.takeProfit || 0,
      })
    }
    if (blockTargetSatisfied) {
      position.pendingAccumulation = undefined
      pendingAccumulationCompleted = true
    } else {
      position.pendingAccumulation = {
        ...pending,
        appliedFilledQuantity: exactAdded,
      }
    }
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
  if (pendingAccumulationCompleted && pending?.combinedPosCounts) {
    await recordConfirmedStrategyEntry(
      position.connectionId,
      position,
      `${position.id}:combined:${pending.clientOrderId}`,
    )
  } else if (pendingAccumulationCompleted && pending?.setKey) {
    await recordConfirmedStrategyEntry(
      position.connectionId,
      position,
      `${position.id}:set:${pending.setKey}`,
      {
        setKey: pending.setKey,
        parentSetKey: pending.parentSetKey,
        indicationType: pending.indicationType,
        axisKey: pending.axisKey,
        setKeys: pending.accumulatedSetKeys,
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
    if (String(obj.errorCode ?? obj.code ?? obj.mode ?? "").toUpperCase().includes("LIVE_EXPOSURE")) return true
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
    lc.includes("not enough balance") ||
    lc.includes("live_exposure")
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
  maxAttempts = 3,
  shouldContinue?: () => boolean | Promise<boolean>,
): Promise<T> {
  let lastResult: T | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if ((await shouldContinue?.()) === false) {
      return {
        success: false,
        error: "Execution generation superseded before exchange submission",
        errorCode: "EXECUTION_SUPERSEDED",
      } as unknown as T
    }
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
      if ((await shouldContinue?.()) === false) {
        return {
          success: false,
          error: "Execution generation superseded during retry backoff",
          errorCode: "EXECUTION_SUPERSEDED",
        } as unknown as T
      }
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
 *   3. A response-lost CTS placement can be recovered by its exact durable
 *      connection-scoped client id even when the venue id was not persisted.
 *
 * Direction/type filters are necessary but never sufficient ownership.
 * Cancellation requires an exact venue id already persisted on this row or
 * an exact connection-watermarked client id from this row's durable history.
 * Manual and third-party orders are always preserved.
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
    if (
      pending?.clientOrderId &&
      isConnectionOwnedClientOrderId(pending.clientOrderId, position.connectionId)
    ) {
      ownedClientOrderIds.add(String(pending.clientOrderId))
    }
  }
  const clientOrderHistory = (position.exchangeData as any)?.clientOrderIds
  if (Array.isArray(clientOrderHistory)) {
    for (const entry of clientOrderHistory) {
      if (entry?.kind === "stop_loss" || entry?.kind === "take_profit") {
        const value = entry?.clientOrderId ?? entry?.id
        if (value && isConnectionOwnedClientOrderId(value, position.connectionId)) {
          ownedClientOrderIds.add(String(value))
        }
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
    const exchangeOrderId = firstNonEmptyIdentifier(o?.id, o?.orderId, o?.orderID, o?.ordId)
    const clientOrderId = firstNonEmptyIdentifier(o?.clientOrderId, o?.clientOrderID, o?.client_oid, o?.clOrdId)
    const ordId = exchangeOrderId || clientOrderId
    const ownershipMatches =
      (exchangeOrderId != null && ownedOrderIds.has(exchangeOrderId)) ||
      (clientOrderId != null && ownedClientOrderIds.has(clientOrderId))
    if (!sideOk) continue
    if (!psOk) continue
    if (!typeOk) continue
    // Manual/foreign orders never match the durable ownership allow-list.
    if (!ownershipMatches) continue
    if (!ordId) continue
    const ok = await cancelProtectionOrder(connector, symbol, ordId, "OrphanSweep", position.connectionId)
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
interface ProtectionOrderPlacementResult {
  orderId: string | null
  armedQuantity: number
}

async function resolveNativePositionTicket(
  connector: any,
  symbol: string,
  direction: "long" | "short",
): Promise<number | undefined> {
  try {
    if (typeof connector?.getPosition !== "function") return undefined
    const position = await connector.getPosition(symbol, direction)
    const ticket = Number(position?.positionTicket ?? position?.ticket ?? position?.exchangePositionId)
    return Number.isInteger(ticket) && ticket > 0 ? ticket : undefined
  } catch {
    return undefined
  }
}

function isRetryableProtectionRejection(message: string, expectedCode: string, fallback: RegExp): boolean {
  // Lockout messages quote the business error that caused the rolling ban.
  // Only the primary response code describes this request's rejection.
  const primaryCode = message.match(/(?:code\s*[=:]\s*|^\s*)(\d{5,6})(?=\D|$)/i)?.[1]
  if (primaryCode) return primaryCode === expectedCode
  if (/109429|100410|rate.limit|cooldown|can retry after time/i.test(message)) return false
  return message.includes(expectedCode) || fallback.test(message)
}

async function placeProtectionOrder(
  connector: any,
  symbol: string,
  closeSide: "buy" | "sell",
  quantity: number,
  triggerPrice: number,
  orderLabel: "StopLoss" | "TakeProfit" | "SecurityStop",
  positionDirection: "long" | "short",
  clientOrderId?: string,
): Promise<ProtectionOrderPlacementResult> {
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
      return { orderId: null, armedQuantity: 0 }
    }

    // Defensive input validation. The SL/TP test suite previously sent
    // `NaN` quantity from a venue-shape mismatch and the exchange echoed
    // back "Invalid quantity: NaN" 800 ms later — costly because by then
    // the entry position is already live and unprotected. Validate at the
    // helper boundary so a future bug upstream surfaces immediately as a
    // local log line rather than as a venue-side rejection mid-trade.
    if (!Number.isFinite(quantity) || quantity <= 0) {
      console.error(`${tag} REJECTED LOCALLY: invalid quantity=${quantity} (must be finite, >0)`)
      return { orderId: null, armedQuantity: 0 }
    }
    if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
      console.error(`${tag} REJECTED LOCALLY: invalid triggerPrice=${triggerPrice} (must be finite, >0)`)
      return { orderId: null, armedQuantity: 0 }
    }

    // A reduce-only protection quantity must never exceed authoritative
    // position size. Venue minimums are entry constraints; increasing a close
    // order creates 110424 and can leave the position unprotected.
    let effectiveQty = quantity

    const kind: "stop_loss" | "take_profit" =
      orderLabel === "TakeProfit" ? "take_profit" : "stop_loss"

    // ── Helper: extract numeric "available amount" from a 110424 message ──
    // Error text: "The order size must be less than the available amount of 0.77 SOL"
    const extract110424Available = (errMsg: string): number | null => {
      const m = /available amount of ([\d.]+)/i.exec(errMsg)
      if (!m) return null
      const n = parseFloat(m[1])
      return Number.isFinite(n) && n > 0 ? n : null
    }

    // Persist the exact hedge-side contract on every control. Row SL/TP owns
    // one logical row quantity; SecurityStop owns the complete authoritative
    // venue slot quantity. BingX hedge mode makes reduce-only implicit through
    // the opposite close side plus LONG/SHORT positionSide.
    // Bounded — a hanging placeStopOrder would block the per-position sync
    // loop and stall every other position's heal/close work behind it. A
    // timeout is delivery-ambiguous, however: retain the exact promise and
    // durable client ID for acknowledgement/reconciliation instead of
    // classifying it as a venue rejection or submitting a duplicate.
    // ── Normalize connector throws to result objects ──────────────────────
    // The BingX connector (and others) throw on venue rejection rather than
    // returning { success: false }.  The 109420 / 110424 retry blocks below
    // check `result?.error`, which is never set when a throw escapes directly
    // to the outer catch.  By wrapping each `placeStopOrder` call in its own
    // try-catch we guarantee all code paths reach the retry checks with a
    // well-shaped result object.
    const placeStop = async (qty: number): Promise<any> => {
      // Acquire the global semaphore before calling the exchange.
      // The connector owns its queue and HTTP abort deadlines. This outer
      // deadline can still expire while the connector is synchronizing time or
      // waiting in that queue, so the ambiguous-write branch below must retain
      // the same promise rather than interpreting the deadline as rejection.
      await acquireStopSem()
      try {
        const resolvedPositionTicket = await resolveNativePositionTicket(connector, symbol, positionDirection)
        const placementPromise = connector.placeStopOrder(
          symbol,
          closeSide,
          qty,
          triggerPrice,
          kind,
          {
            reduceOnly: true,
            hedgeMode: true,
            positionSide: positionDirection === "long" ? "LONG" : "SHORT",
            ...(resolvedPositionTicket ? { positionTicket: resolvedPositionTicket } : {}),
            ...(clientOrderId ? { clientOrderId } : {}),
          },
        ) as Promise<any>
        let result: any
        try {
          result = await withTimeout(
            placementPromise,
            EXCHANGE_TIMEOUT_PLACE_STOP_MS,
            `placeStopOrder(${orderLabel} ${symbol})`,
          )
        } catch (error) {
          result = { success: false, error: String((error as any)?.message || error) }
        }

        if (!result?.success && clientOrderId && isAmbiguousControlOrderDelivery(result?.error)) {
          const recovered = await reconcileAmbiguousProtectionWrite({
            connector,
            symbol,
            clientOrderId,
            placementPromise,
            initialError: result.error,
          })
          if (recovered?.success) {
            console.warn(
              `${tag} ambiguous acknowledgement recovered without resubmission: ` +
              `orderId=${recovered.orderId} via=${recovered.recoveredFromAmbiguousWrite}`,
            )
            return recovered
          }
        }
        return result
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
      const is110424 = (msg: string) => isRetryableProtectionRejection(msg, "110424", /available amount/i)
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
      const isPositionSettling = (message: string) =>
        isRetryableProtectionRejection(message, "109420", /position not exist/i)
      if (isPositionSettling(errMsg109)) {
        // Exponential backoff: 1s, 2s, 4s.
        // BingX hedge-mode positions can take 2–4 s to become visible
        // under load. The old 500ms/1s/2s budget was exhausted too quickly,
        // causing the protection order to be deferred to the next reconcile
        // tick — leaving the position unprotected for up to 60 s.
        const BACKOFF_DELAYS_MS = [1000, 2000, 4000]
        let retryAttempt = 0
        while (retryAttempt < BACKOFF_DELAYS_MS.length && !result?.success && isPositionSettling(String(result?.error || ""))) {
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
    const orderId = result?.success
      ? firstNonEmptyIdentifier(result?.orderId, result?.orderID, result?.id, result?.ordId) || null
      : null
    if (orderId) {
      console.log(
        `${tag} PLACED: orderId=${orderId} @ trigger=${triggerPrice} qty=${effectiveQty}${effectiveQty !== quantity ? ` (requested=${quantity}, adjusted)` : ""} latency=${latencyMs}ms`,
      )
      return { orderId, armedQuantity: effectiveQty }
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
      return { orderId: "PRICE_CROSSED", armedQuantity: 0 }
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
      return { orderId: "QUOTA_EXCEEDED", armedQuantity: 0 }
    }
    // result.error is the connector's normalized venue-side message.
    // Log verbatim so operators see the EXACT venue rejection.
    console.warn(
      `${tag} VENUE REJECTED: error="${result?.error || "unknown"}" code=${result?.code ?? "n/a"} latency=${latencyMs}ms`,
    )
    return { orderId: null, armedQuantity: 0 }
  } catch (err) {
    const latencyMs = Date.now() - placeStart
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`${tag} EXCEPTION: ${msg} latency=${latencyMs}ms`)
    return { orderId: null, armedQuantity: 0 }
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
type LiveOrderIdSet = Set<string> & {
  observedOrderCount?: number
  observedControlOrderCount?: number
  protectionCapacityBudget?: ControlOrderCapacityBudget
}

function isBingXCapacityConnector(connector: any): boolean {
  const identity = String(
    connector?.exchange
    ?? connector?.exchangeId
    ?? connector?.id
    ?? connector?.constructor?.name
    ?? "",
  ).toLowerCase()
  return identity.includes("bingx") || typeof connector?.getEnvironmentInfo === "function"
}

function protectionCapacityBudgetOf(liveOrderIds?: Set<string> | null): ControlOrderCapacityBudget | null {
  return (liveOrderIds as LiveOrderIdSet | null | undefined)?.protectionCapacityBudget || null
}

async function fetchLiveOrderIdSet(
  connector: any,
  options: { timeoutMs?: number; forceRefresh?: boolean } = {},
): Promise<LiveOrderIdSet | null> {
  if (!connector || typeof connector.getOpenOrders !== "function") return null
  try {
    // 25 s upper bound — BingX getOpenOrders queues behind live-order calls
    // in the rate limiter. With maxConcurrent=3 and a placeOrder (market) in
    // flight, getOpenOrders may wait up to ~15 s in queue before the HTTP
    // request even starts. 25 s covers queue-wait + HTTP round-trip reliably
    // without blocking the rate limiter indefinitely.
    // On timeout we degrade gracefully to drift-only reconciliation.
    const timeoutMs = Math.max(1, Math.min(25_000, Number(options.timeoutMs || 25_000)))
    const orders = (await withTimeout(
      connector.getOpenOrders(undefined, { forceRefresh: options.forceRefresh === true }) as Promise<any>,
      timeoutMs,
      "getOpenOrders(reconcile-tick)",
    )) as any[] | undefined
    if (!Array.isArray(orders)) return null
    const snapshotStatus = typeof connector.getLastOpenOrdersSnapshotStatus === "function"
      ? connector.getLastOpenOrdersSnapshotStatus()
      : { ok: true }
    if (snapshotStatus.ok !== true) return null
    const set = new Set<string>() as LiveOrderIdSet
    for (const o of orders) {
      // Prefer exchange-assigned numeric IDs over operator-supplied client IDs.
      // Using `clientOrderId`/`client_oid` as a fallback is safe only when no
      // real numeric ID is present on the order — otherwise a future client-ID
      // echo from the connector could mask a genuinely-missing real orderId and
      // suppress liveness-based re-arming of a gone SL/TP order.
      for (const candidate of [o?.id, o?.orderId, o?.orderID, o?.ordId]) {
        const identifier = firstNonEmptyIdentifier(candidate)
        if (identifier) set.add(identifier)
      }
      // Keep the client id alongside the venue id. Durable submissions are
      // written under this id before the HTTP request, so restart recovery can
      // resolve a response-lost order without issuing a duplicate.
      for (const candidate of [o?.clientOrderId, o?.clientOrderID, o?.client_oid, o?.clOrdId]) {
        const identifier = firstNonEmptyIdentifier(candidate)
        if (identifier) set.add(identifier)
      }
    }
    set.observedOrderCount = orders.length
    if (isBingXCapacityConnector(connector)) {
      const observedControlOrderCount = countUniqueBingXControlOrders(orders)
      set.observedControlOrderCount = observedControlOrderCount
      set.protectionCapacityBudget = new ControlOrderCapacityBudget(
        observedControlOrderCount,
        BINGX_CONTROL_ORDER_LIMIT,
      )
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
/**
 * A trailing stop may be propagated by several asynchronous hot-path calls.
 * Reject a delayed update that would loosen the already persisted exchange
 * protection: long stops can only rise; short stops can only fall. This check
 * is repeated inside the lock-owning recalculation path below, where it is the
 * final authority against out-of-order network completion.
 */
function translatePseudoTrailingStopPrice(
  pseudoStopValue: unknown,
  pseudoEntryValue: unknown,
  liveFillValue: unknown,
): number | undefined {
  const pseudoStop = finitePositive(pseudoStopValue)
  const pseudoEntry = finitePositive(pseudoEntryValue)
  const liveFill = finitePositive(liveFillValue)
  if (!(pseudoStop > 0) || !(liveFill > 0)) return undefined

  if (pseudoEntry > 0) {
    const ratio = pseudoStop / pseudoEntry
    // A stop more than one order of magnitude away from its own entry is not
    // a usable protection coordinate. Refuse it instead of projecting corrupt
    // historic state into a venue order.
    if (!(ratio > 0.1 && ratio < 10)) return undefined
    const translated = liveFill * ratio
    return finitePositive(translated) || undefined
  }

  // Legacy pseudo rows can omit entry_price. Accept their absolute value only
  // when it is already plausibly in the live venue's price domain.
  const legacyRatio = pseudoStop / liveFill
  return legacyRatio > 0.1 && legacyRatio < 10 ? pseudoStop : undefined
}

function priceDomainDistance(leftValue: unknown, rightValue: unknown): number {
  const left = finitePositive(leftValue)
  const right = finitePositive(rightValue)
  if (!(left > 0) || !(right > 0)) return Number.POSITIVE_INFINITY
  return Math.max(left / right, right / left)
}

/**
 * Repair legacy positions that mixed the normalized historic (~100) domain
 * with the venue fill domain. Ordinary DCA averages are intentionally left
 * untouched: we repair only an unmistakable >=10x mismatch, or a stale entry
 * that disagrees with an initial entry already matching the authoritative
 * venue snapshot.
 */
function repairLiveEntryPriceDomain(
  position: LivePosition,
  authoritativeEntryValue: unknown,
): boolean {
  const authoritativeEntry = finitePositive(authoritativeEntryValue)
  if (!(authoritativeEntry > 0)) return false

  const previousEntry = finitePositive(position.entryPrice)
  const previousInitialEntry = finitePositive(position.initialEntryPrice)
  if (!(previousEntry > 0)) {
    position.entryPrice = authoritativeEntry
    if (!(previousInitialEntry > 0)) position.initialEntryPrice = authoritativeEntry
    return true
  }

  const entryToAuthorityRatio = priceDomainDistance(previousEntry, authoritativeEntry)
  const initialToAuthorityRatio = priceDomainDistance(previousInitialEntry, authoritativeEntry)
  const entryToInitialRatio = priceDomainDistance(previousEntry, previousInitialEntry)
  const unmistakableCrossDomain = entryToAuthorityRatio >= 10
  const initialMatchesAuthority = previousInitialEntry > 0 && initialToAuthorityRatio < 1.25
  const staleEntryAgainstInitial = initialMatchesAuthority && entryToInitialRatio >= 1.25
  if (!unmistakableCrossDomain && !staleEntryAgainstInitial) return false

  const repairedEntry = initialMatchesAuthority ? previousInitialEntry : authoritativeEntry
  position.entryPrice = repairedEntry
  if (!(previousInitialEntry > 0)) position.initialEntryPrice = repairedEntry

  const previousAverage = finitePositive(position.averageExecutionPrice)
  if (
    !(previousAverage > 0) ||
    priceDomainDistance(previousAverage, authoritativeEntry) >= 10 ||
    (initialMatchesAuthority && priceDomainDistance(previousAverage, previousInitialEntry) >= 1.25)
  ) {
    position.averageExecutionPrice = repairedEntry
  }

  // Only automatic trailing state is rebased. Absolute operator overrides are
  // explicit venue-price contracts and must never be silently rewritten.
  const previousTrailing = finitePositive(position.trailingStopPrice)
  if (!position.manualProtectionOverride && previousTrailing > 0) {
    const trailingToOldEntry = previousTrailing / previousEntry
    const trailingToAuthority = previousTrailing / authoritativeEntry
    if (
      trailingToOldEntry > 0.1 &&
      trailingToOldEntry < 10 &&
      (trailingToAuthority <= 0.1 || trailingToAuthority >= 10)
    ) {
      position.trailingStopPrice = repairedEntry * trailingToOldEntry
    }
  }

  return true
}

function isTrailingStopTightening(
  pos: Pick<LivePosition, "direction" | "side" | "trailingStopPrice">,
  candidateValue: unknown,
): boolean {
  const candidate = Number(candidateValue)
  if (!Number.isFinite(candidate) || candidate <= 0) return true
  const existing = Number(pos.trailingStopPrice)
  if (!Number.isFinite(existing) || existing <= 0) return true
  const direction = resolveLivePositionDirection(pos as LivePosition)
  if (!direction) return false
  return direction === "long" ? candidate >= existing : candidate <= existing
}

function computeDesiredProtectionPrices(pos: LivePosition): {
  desiredSl: number
  desiredTp: number
} {
  const fillPrice = pos.averageExecutionPrice || pos.entryPrice
  // CRITICAL: Guard against undefined, NaN, negative, or zero fill prices
  // that would cause NaN or Infinity propagation in SL/TP calculations.
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return { desiredSl: 0, desiredTp: 0 }

  // Protection is a side-sensitive exchange mutation. Never let an unknown or
  // malformed direction fall through the ternaries below as an implicit short.
  // A redundant valid side/positionSide may still recover a legacy row through
  // the canonical resolver; otherwise reconciliation must repair the row first.
  const direction = resolveLivePositionDirection(pos)
  if (!direction) return { desiredSl: 0, desiredTp: 0 }

  normalizeLivePositionProtection(pos)

  // ── Trailing stop: use the ratcheted absolute price directly ────────────────
  // When trailing is active syncLiveFromPseudo stamps pos.trailingStopPrice
  // with the latest ratcheted absolute stop level. Using that absolute price
  // directly avoids the percentage-anchored re-derivation below which would
  // always revert to the static origin level, fighting the ratchet every tick.
  const manual = pos.manualProtectionOverride
  const hasManualSl = Number(manual?.stopLossPrice) > 0
  const hasManualTp = Number(manual?.takeProfitPrice) > 0
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
        ? direction === "long"
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
        ? direction === "long"
          ? fillPrice * (1 + tpPct)
          : fillPrice * (1 - tpPct)
        : 0
  // Final NaN guard: ensure result is safe before returning
  if (!Number.isFinite(desiredTp)) desiredTp = 0

  return { desiredSl, desiredTp }
}

function normalizeProtectionTriggerPrice(
  value: number,
  priceTick: number,
  direction: "long" | "short" | null,
  leg: ProtectionOrderLeg,
): number {
  if (!(Number.isFinite(value) && value > 0)) return 0
  if (!(Number.isFinite(priceTick) && priceTick > 0) || !direction) return value
  const units = value / priceTick
  const roundUp = (direction === "long" && leg === "stop_loss")
    || (direction === "short" && leg === "take_profit")
  const roundedUnits = roundUp
    ? Math.ceil(units - 1e-9)
    : Math.floor(units + 1e-9)
  const normalized = Number((roundedUnits * priceTick).toPrecision(15))
  return normalized > 0 ? normalized : 0
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

  const direction = resolveLivePositionDirection(pos)
  if (!direction) return false
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
  const direction = resolveLivePositionDirection(pos)
  if (!direction) return null

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

  const direction = resolveLivePositionDirection(pos)
  if (!direction) return false
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
// BingX rejects a second mutation of the same security-stop order inside one
// second (code 109201). Keep the still-live, wider security stop in place for
// a small margin beyond that venue window, then let the next authoritative
// reconcile cancel-confirm-replace it. Quantity drift bypasses this delay.
const SECURITY_STOP_PRICE_REARM_MS = 1_250

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

function setSystemProtectionLeg(pos: LivePosition, leg: ProtectionOrderLeg, enabled: boolean): void {
  const legs = new Set(pos.systemProtectionLegs || [])
  if (enabled) legs.add(leg)
  else legs.delete(leg)
  pos.systemProtectionLegs = [...legs]
}

function refreshProtectionHandlingMode(
  pos: LivePosition,
  desiredSl: number,
  desiredTp: number,
  explicitSystemClose = false,
): void {
  const missing: ProtectionOrderLeg[] = []
  if (desiredSl > 0 && !pos.stopLossOrderId) missing.push("stop_loss")
  if (desiredTp > 0 && !pos.takeProfitOrderId) missing.push("take_profit")
  pos.systemProtectionLegs = missing
  if (explicitSystemClose) {
    pos.protectionMode = "system_close"
  } else if (missing.length === 0) {
    pos.protectionMode = "exchange_control"
  } else if (pos.stopLossOrderId || pos.takeProfitOrderId) {
    pos.protectionMode = "hybrid_control_system"
  } else {
    pos.protectionMode = "system_close_fallback"
  }
  refreshControlOrderSetCoverage(pos)
}

function exactProtectionSetKeys(pos: LivePosition): string[] {
  return [...new Set([
    String(pos.setKey || "").trim(),
    ...(pos.accumulatedSetKeys || []).map((value) => String(value || "").trim()),
  ].filter(Boolean))]
}

function refreshControlOrderSetCoverage(
  pos: LivePosition,
  sharedVenueProtection?: {
    leaderId: string
    /** Legacy fields accepted only so old snapshots/helpers remain readable. */
    stopLossOrderId?: string
    takeProfitOrderId?: string
    stopLossPrice?: number
    takeProfitPrice?: number
    securityStopOrderId?: string
    securityStopPrice?: number
    securityStopRequired?: boolean
    securityStopStatus?: LivePosition["securityStopStatus"]
  },
): void {
  const desired = computeDesiredProtectionPrices(pos)
  const systemLegs = new Set(pos.systemProtectionLegs || [])
  const stopLossCovered = !(desired.desiredSl > 0) || Boolean(pos.stopLossOrderId) || systemLegs.has("stop_loss")
  const takeProfitCovered = !(desired.desiredTp > 0) || Boolean(pos.takeProfitOrderId) || systemLegs.has("take_profit")
  const securityStopOrderId = sharedVenueProtection?.securityStopOrderId || pos.securityStopOrderId
  const securityStopPrice = Number(sharedVenueProtection?.securityStopPrice || pos.securityStopPrice || 0)
  const securityStopRequired = sharedVenueProtection?.securityStopRequired ?? pos.securityStopRequired ?? false
  const securityStopStatus = sharedVenueProtection?.securityStopStatus || pos.securityStopStatus
  const coverage: NonNullable<LivePosition["controlOrderSetCoverage"]> = {}
  const updatedAt = Date.now()
  for (const setKey of exactProtectionSetKeys(pos)) {
    coverage[setKey] = {
      protected: stopLossCovered && takeProfitCovered,
      protectionMode: pos.protectionMode || "system_close_fallback",
      aggregateProtectionOwner: pos.aggregateProtectionOwner === true,
      ...(pos.aggregateProtectionKey ? { aggregateProtectionKey: pos.aggregateProtectionKey } : {}),
      ...(sharedVenueProtection?.leaderId
        ? { aggregateProtectionLeaderId: sharedVenueProtection.leaderId }
        : {}),
      ...(pos.stopLossOrderId ? { stopLossOrderId: pos.stopLossOrderId } : {}),
      ...(pos.takeProfitOrderId ? { takeProfitOrderId: pos.takeProfitOrderId } : {}),
      ...(Number(pos.stopLossPrice || 0) > 0 ? { stopLossPrice: Number(pos.stopLossPrice) } : {}),
      ...(Number(pos.takeProfitPrice || 0) > 0 ? { takeProfitPrice: Number(pos.takeProfitPrice) } : {}),
      ...(securityStopOrderId ? { securityStopOrderId } : {}),
      ...(securityStopPrice > 0 ? { securityStopPrice } : {}),
      securityStopRequired,
      ...(securityStopStatus ? { securityStopStatus } : {}),
      systemProtectionLegs: [...systemLegs],
      updatedAt,
    }
  }
  pos.controlOrderSetCoverage = coverage
}

function inheritedAggregateVenueProtection(pos: LivePosition): {
  leaderId: string
  securityStopOrderId?: string
  securityStopPrice?: number
  securityStopRequired?: boolean
  securityStopStatus?: LivePosition["securityStopStatus"]
} | undefined {
  if (pos.aggregateProtectionOwner !== false || !pos.aggregateProtectionKey) return undefined
  const entry = Object.values(pos.controlOrderSetCoverage || {}).find((coverage) =>
    coverage.aggregateProtectionOwner === false
    && coverage.aggregateProtectionKey === pos.aggregateProtectionKey
    && Boolean(coverage.aggregateProtectionLeaderId),
  )
  if (!entry?.aggregateProtectionLeaderId) return undefined
  return {
    leaderId: entry.aggregateProtectionLeaderId,
    ...(entry.securityStopOrderId ? { securityStopOrderId: entry.securityStopOrderId } : {}),
    ...(Number(entry.securityStopPrice || 0) > 0 ? { securityStopPrice: Number(entry.securityStopPrice) } : {}),
    securityStopRequired: entry.securityStopRequired,
    ...(entry.securityStopStatus ? { securityStopStatus: entry.securityStopStatus } : {}),
  }
}

function projectAggregateMemberCoverage(
  position: LivePosition,
  leader: LivePosition,
  plan: AggregateProtectionPlan,
): boolean {
  const comparableCoverage = (coverage: LivePosition["controlOrderSetCoverage"]) =>
    Object.fromEntries(Object.entries(coverage || {}).map(([setKey, value]) => [setKey, {
      ...value,
      updatedAt: 0,
    }]))
  const before = JSON.stringify({
    aggregateProtectionOwner: position.aggregateProtectionOwner,
    aggregateProtectionKey: position.aggregateProtectionKey,
    aggregateProtectionMemberCount: position.aggregateProtectionMemberCount,
    aggregateProtectionQuantity: position.aggregateProtectionQuantity,
    protectionMode: position.protectionMode,
    systemProtectionLegs: position.systemProtectionLegs,
    controlOrderSetCoverage: comparableCoverage(position.controlOrderSetCoverage),
  })
  position.aggregateProtectionOwner = false
  position.aggregateProtectionKey = plan.key
  position.aggregateProtectionMemberCount = plan.memberIds.length
  position.aggregateProtectionQuantity = plan.venueQuantity
  position.securityStopRequired = leader.securityStopRequired
  position.securityStopStatus = leader.securityStopStatus
  position.securityStopPrice = leader.securityStopPrice
  position.systemProtectionLegs = configuredSystemProtectionLegs(position).filter((leg) =>
    leg === "stop_loss" ? !position.stopLossOrderId : !position.takeProfitOrderId,
  )
  position.protectionMode = position.systemProtectionLegs.length === 0
    ? "exchange_control"
    : position.stopLossOrderId || position.takeProfitOrderId
      ? "hybrid_control_system"
      : "system_close_fallback"
  refreshControlOrderSetCoverage(position, {
    leaderId: leader.id,
    ...(leader.securityStopOrderId ? { securityStopOrderId: leader.securityStopOrderId } : {}),
    ...(Number(leader.securityStopPrice || 0) > 0 ? { securityStopPrice: Number(leader.securityStopPrice) } : {}),
    securityStopRequired: leader.securityStopRequired,
    securityStopStatus: leader.securityStopStatus,
  })
  const after = JSON.stringify({
    aggregateProtectionOwner: position.aggregateProtectionOwner,
    aggregateProtectionKey: position.aggregateProtectionKey,
    aggregateProtectionMemberCount: position.aggregateProtectionMemberCount,
    aggregateProtectionQuantity: position.aggregateProtectionQuantity,
    protectionMode: position.protectionMode,
    systemProtectionLegs: position.systemProtectionLegs,
    controlOrderSetCoverage: comparableCoverage(position.controlOrderSetCoverage),
  })
  return before !== after
}

function reserveProtectionCapacity(
  budget: ControlOrderCapacityBudget | null,
  pos: LivePosition,
  leg: ProtectionOrderLeg,
): { allowed: boolean; reservationId: string } {
  const reservationId = `${pos.connectionId}:${pos.id}:${leg}`
  if (!budget) return { allowed: true, reservationId }
  const allowed = budget.reserve(reservationId)
  pos.controlOrderCapacity = budget.snapshot()
  if (!allowed) {
    setSystemProtectionLeg(pos, leg, true)
    pos.protectionMode = pos.stopLossOrderId || pos.takeProfitOrderId
      ? "hybrid_control_system"
      : "system_close_fallback"
    pushStep(
      pos,
      "protection_capacity_system_fallback",
      true,
      `${leg} kept engine-side because BingX control-order capacity is ${pos.controlOrderCapacity.observedOpen + pos.controlOrderCapacity.reserved}/${pos.controlOrderCapacity.limit}`,
    )
  }
  return { allowed, reservationId }
}

function releaseProtectionCapacityReservation(
  budget: ControlOrderCapacityBudget | null,
  pos: LivePosition,
  reservationId: string,
): void {
  if (!budget) return
  budget.releaseReservation(reservationId)
  pos.controlOrderCapacity = budget.snapshot()
}

function protectionLegArmedQuantity(pos: LivePosition, leg: ProtectionOrderLeg): number {
  const rawSpecific = leg === "stop_loss"
    ? pos.stopLossArmedQuantity
    : pos.takeProfitArmedQuantity
  if (rawSpecific !== undefined && rawSpecific !== null) {
    const specific = Number(rawSpecific)
    if (Number.isFinite(specific)) return specific > 0 ? specific : 0
  }
  const legacy = Number(pos.protectionArmedQuantity)
  return Number.isFinite(legacy) && legacy > 0 ? legacy : 0
}

function refreshLegacyProtectionArmedQuantity(pos: LivePosition): void {
  const quantities: number[] = []
  if (pos.stopLossOrderId) {
    quantities.push(protectionLegArmedQuantity(pos, "stop_loss"))
  }
  if (pos.takeProfitOrderId) {
    quantities.push(protectionLegArmedQuantity(pos, "take_profit"))
  }
  pos.protectionArmedQuantity = quantities.length > 0 ? Math.min(...quantities) : 0
}

function setProtectionLegArmedQuantity(
  pos: LivePosition,
  leg: ProtectionOrderLeg,
  quantity: number,
): void {
  const normalized = Number.isFinite(Number(quantity)) && Number(quantity) > 0
    ? Number(quantity)
    : 0
  if (leg === "stop_loss") pos.stopLossArmedQuantity = normalized
  else pos.takeProfitArmedQuantity = normalized
  refreshLegacyProtectionArmedQuantity(pos)
}

function controlOrderRequestedQuantity(order: any, fallback: number): number {
  const quantity = Number(
    order?.quantity
    ?? order?.origQty
    ?? order?.orderQty
    ?? order?.qty
    ?? order?.size
    ?? order?.amount
    ?? 0,
  )
  return Number.isFinite(quantity) && quantity > 0 ? quantity : fallback
}

function clearMissingProtectionOrderIds(
  pos: LivePosition,
  liveOrderIds: Set<string> | null | undefined,
  result: { changed: boolean },
): void {
  if (!liveOrderIds) return
  if (pos.stopLossOrderId && liveOrderIds.has(String(pos.stopLossOrderId))) {
    if (pos.stopLossAbsenceConfirmations) result.changed = true
    pos.stopLossAbsenceConfirmations = 0
  } else if (pos.stopLossOrderId) {
    pos.stopLossAbsenceConfirmations = Number(pos.stopLossAbsenceConfirmations || 0) + 1
    result.changed = true
  }
  if (pos.stopLossOrderId && Number(pos.stopLossAbsenceConfirmations || 0) >= 2) {
    console.log(
      `${LOG_PREFIX} [verify] StopLoss ${pos.symbol} orderId=${pos.stopLossOrderId} not found on venue — clearing & re-arming`,
    )
    pos.stopLossOrderId = undefined
    pos.stopLossPrice = 0
    setProtectionLegArmedQuantity(pos, "stop_loss", 0)
    pos.stopLossAbsenceConfirmations = 0
    result.changed = true
  }
  if (pos.takeProfitOrderId && liveOrderIds.has(String(pos.takeProfitOrderId))) {
    if (pos.takeProfitAbsenceConfirmations) result.changed = true
    pos.takeProfitAbsenceConfirmations = 0
  } else if (pos.takeProfitOrderId) {
    pos.takeProfitAbsenceConfirmations = Number(pos.takeProfitAbsenceConfirmations || 0) + 1
    result.changed = true
  }
  if (pos.takeProfitOrderId && Number(pos.takeProfitAbsenceConfirmations || 0) >= 2) {
    console.log(
      `${LOG_PREFIX} [verify] TakeProfit ${pos.symbol} orderId=${pos.takeProfitOrderId} not found on venue — clearing & re-arming`,
    )
    pos.takeProfitOrderId = undefined
    pos.takeProfitPrice = 0
    setProtectionLegArmedQuantity(pos, "take_profit", 0)
    pos.takeProfitAbsenceConfirmations = 0
    result.changed = true
  }
}

async function updateProtectionOrders(
  connector: any,
  pos: LivePosition,
  reason: string,
  // Once-per-tick snapshot of order IDs currently open on the venue.
  // When provided, we cross-check our recorded `stopLossOrderId` /
  // `takeProfitOrderId` against this set. A first absence is retained as an
  // unresolved possible fill; only two authoritative absences clear the ID.
  // The replacement path is blocked while that observation is unresolved so
  // a delayed fill can never race a duplicate control order.
  //
  // Pass `null`/omit to skip verification (legacy callers that only
  // want price/qty-drift reconciliation pay no extra REST cost).
  liveOrderIds?: Set<string> | null,
  options: {
    allowPendingAccumulation?: boolean
    allowPendingReduction?: boolean
    quantityOverride?: number
    allowQuantityOverrideAbovePosition?: boolean
    desiredPricesOverride?: { desiredSl: number; desiredTp: number }
  } = {},
): Promise<{ changed: boolean; slPlaced: boolean; tpPlaced: boolean }> {
  const result = { changed: false, slPlaced: false, tpPlaced: false }
  if (!connector) return result
  const direction = resolveLivePositionDirection(pos)
  if (!direction) {
    pos.statusReason = "protection_blocked_invalid_direction"
    pushStep(pos, "protection_direction_guard", false, "No explicit long/short direction; no control order was changed")
    return result
  }
  pos.direction = direction
  pos.side ??= direction
  const rawEffectiveQty = pos.executedQuantity > 0 ? pos.executedQuantity : (pos.quantity ?? 0)
  const requestedOverride = Number(options.quantityOverride)
  const effectiveQty = Number.isFinite(requestedOverride) && requestedOverride > 0
    ? options.allowQuantityOverrideAbovePosition === true
      ? requestedOverride
      : Math.min(rawEffectiveQty, requestedOverride)
    : rawEffectiveQty
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
    (pos.pendingReduction && options.allowPendingReduction !== true) ||
    (pos.pendingAccumulation && options.allowPendingAccumulation !== true) ||
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

  const computedProtectionPrices = computeDesiredProtectionPrices(pos)
  const rawDesiredSl = Number.isFinite(Number(options.desiredPricesOverride?.desiredSl))
    ? Math.max(0, Number(options.desiredPricesOverride?.desiredSl))
    : computedProtectionPrices.desiredSl
  const rawDesiredTp = Number.isFinite(Number(options.desiredPricesOverride?.desiredTp))
    ? Math.max(0, Number(options.desiredPricesOverride?.desiredTp))
    : computedProtectionPrices.desiredTp
  const normalizedDirection = resolveLivePositionDirection(pos)
  const desiredSl = normalizeProtectionTriggerPrice(
    rawDesiredSl,
    Number(pos.priceTick || 0),
    normalizedDirection,
    "stop_loss",
  )
  const desiredTp = normalizeProtectionTriggerPrice(
    rawDesiredTp,
    Number(pos.priceTick || 0),
    normalizedDirection,
    "take_profit",
  )

  // Every logical Set row owns exact-quantity SL and TP orders. Aggregate
  // ownership applies only to the separate slot-level security stop and must
  // never suppress or replace a row's own protection lifecycle.

  let capacityBudget = protectionCapacityBudgetOf(liveOrderIds)
  if (!capacityBudget && isBingXCapacityConnector(connector)) {
    const capacitySnapshot = await fetchLiveOrderIdSet(connector)
    if (capacitySnapshot) {
      if (liveOrderIds === null || liveOrderIds === undefined) liveOrderIds = capacitySnapshot
      capacityBudget = protectionCapacityBudgetOf(capacitySnapshot)
    }
  }
  if (capacityBudget) pos.controlOrderCapacity = capacityBudget.snapshot()

  // Liveness is an observation, not a venue mutation. Apply it before quota
  // and trigger-frequency backoff gates so a silently filled/cancelled leg is
  // immediately represented as system-side protection during the backoff.
  clearMissingProtectionOrderIds(pos, liveOrderIds, result)
  const stopLossLivenessUnresolved = Boolean(
    pos.stopLossOrderId && Number(pos.stopLossAbsenceConfirmations || 0) > 0,
  )
  const takeProfitLivenessUnresolved = Boolean(
    pos.takeProfitOrderId && Number(pos.takeProfitAbsenceConfirmations || 0) > 0,
  )

  // ── code=110206 quota backoff gate ────────────────────────────────
  // When the account's TP/SL order count has hit the exchange cap, all
  // placement attempts are suspended for PROTECTION_QUOTA_BACKOFF_MS.
  // This prevents the ~150/min cycle rate from flooding BingX with
  // rejected requests that fill the log and consume rate-limit budget.
  if (isProtectionQuotaBlocked(pos.connectionId)) {
    refreshProtectionHandlingMode(pos, desiredSl, desiredTp)
    if (pos.protectionMode !== "exchange_control") {
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
    refreshProtectionHandlingMode(pos, desiredSl, desiredTp)
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
        pos.stopLossOrderId && !stopLossLivenessUnresolved
          ? cancelProtectionOrder(connector, pos.symbol, pos.stopLossOrderId, "SystemCloseSweep-SL", pos.connectionId).catch(() => false)
          : Promise.resolve(!pos.stopLossOrderId),
        pos.takeProfitOrderId && !takeProfitLivenessUnresolved
          ? cancelProtectionOrder(connector, pos.symbol, pos.takeProfitOrderId, "SystemCloseSweep-TP", pos.connectionId).catch(() => false)
          : Promise.resolve(!pos.takeProfitOrderId),
      ])
      if (pos.stopLossOrderId && cancellations[0]) {
        capacityBudget?.noteCancellation(pos.stopLossOrderId)
        pos.stopLossOrderId = undefined
        pos.stopLossPrice = 0
        setProtectionLegArmedQuantity(pos, "stop_loss", 0)
        result.changed = true
      }
      if (pos.takeProfitOrderId && cancellations[1]) {
        capacityBudget?.noteCancellation(pos.takeProfitOrderId)
        pos.takeProfitOrderId = undefined
        pos.takeProfitPrice = 0
        setProtectionLegArmedQuantity(pos, "take_profit", 0)
        result.changed = true
      }
      if (!cancellations.every(Boolean)) {
        pushStep(pos, "system_close_control_wait", true, "control cancellation not yet authoritative")
      }
      refreshProtectionHandlingMode(pos, desiredSl, desiredTp, true)
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
    const recoveredOrderId = firstNonEmptyIdentifier(
      recovered?.orderId,
      recovered?.orderID,
      recovered?.id,
      recovered?.ordId,
    )

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
      setProtectionLegArmedQuantity(
        pos,
        leg === "stopLoss" ? "stop_loss" : "take_profit",
        controlOrderRequestedQuantity(recovered, pending.quantity),
      )
      delete pos.pendingProtectionOrders?.[leg]
      result.changed = true
      pushStep(pos, "protection_submission_recovered", true, `${leg} orderId=${orderId}`)
      return true
    }

    if (recovered && terminalStatuses.has(recoveredStatus)) {
      delete pos.pendingProtectionOrders?.[leg]
      setProtectionLegArmedQuantity(
        pos,
        leg === "stopLoss" ? "stop_loss" : "take_profit",
        0,
      )
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
  const quantityDriftedForLeg = (leg: ProtectionOrderLeg): boolean => {
    const armedQty = protectionLegArmedQuantity(pos, leg)
    const quantityTolerance = Math.max(1e-12, Number(pos.quantityStep || 0) / 2)
    return effectiveQty > 0 && (
      armedQty <= 0
      || Math.abs(effectiveQty - armedQty) > quantityTolerance
    )
  }
  const stopLossQuantityDrifted = quantityDriftedForLeg("stop_loss")
  const takeProfitQuantityDrifted = quantityDriftedForLeg("take_profit")

  // A replacement is a two-step exchange operation: cancel first, then place.
  // Evaluate the cooldown *before* either cancellation starts. Previously the
  // cancellation promises ignored the cooldown while the placement branches
  // honoured it, which could remove a freshly armed trailing stop and then
  // decline to replace it for up to 200 ms. The durable record still pointed at
  // the cancelled order during that gap, so the next no-op sync could also miss
  // the repair. Both legs share this single predicate to keep venue protection
  // continuous while a ratchet is rate-limited.
  const rearmCooldownMs = pos.trailingActive ? TRAILING_REARM_MS : MIN_REARM_MS
  const needsStopLossReplacement = Boolean(
    desiredSl > 0 &&
    !pendingSlBlocksPlacement &&
    !stopLossLivenessUnresolved &&
    pos.stopLossOrderId &&
    (priceDrifted(pos.stopLossPrice, desiredSl, priceDriftTolerance) || stopLossQuantityDrifted) &&
    Date.now() - (pos.stopLossLastArmedAt ?? 0) >= rearmCooldownMs,
  )
  const needsTakeProfitReplacement = Boolean(
    desiredTp > 0 &&
    !pendingTpBlocksPlacement &&
    !takeProfitLivenessUnresolved &&
    pos.takeProfitOrderId &&
    (priceDrifted(pos.takeProfitPrice, desiredTp, priceDriftTolerance) || takeProfitQuantityDrifted) &&
    Date.now() - (pos.takeProfitLastArmedAt ?? 0) >= rearmCooldownMs,
  )

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
    if (needsStopLossReplacement) {
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
    if (needsTakeProfitReplacement) {
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
    if (desiredSl <= 0 && pos.stopLossOrderId && !stopLossLivenessUnresolved) {
      // SL was turned off — yank the existing order. Hard cancel
      // failures intentionally keep the recorded id so the next
      // reconcile pass retries; resetting it here would orphan the
      // exchange-side order and produce a phantom unprotected position
      // from our POV.
      const cancelledOrderId = pos.stopLossOrderId
      const cancelled = await cancelProtectionOrder(connector, pos.symbol, cancelledOrderId, "StopLoss", pos.connectionId)
      if (cancelled) {
        capacityBudget?.noteCancellation(cancelledOrderId)
        pos.stopLossOrderId = undefined
        pos.stopLossPrice = 0
        setProtectionLegArmedQuantity(pos, "stop_loss", 0)
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
          : needsStopLossReplacement
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
      const replacingExistingStop = needsStopLossReplacement && Boolean(pos.stopLossOrderId)
      if (replacingExistingStop && !slCancelOk) {
        // Use the pre-computed slCancelOk result from parallel cancels above
        // and retain the currently recorded order. It is still the safest
        // available protection until the venue confirms cancellation.
        console.warn(
          `${LOG_PREFIX} StopLoss cancel failed for ${pos.symbol} — deferring re-place to avoid duplicate reduceOnly`,
        )
        return
      }
      if (replacingExistingStop) {
        const replacedOrderId = pos.stopLossOrderId
        if (replacedOrderId) capacityBudget?.noteCancellation(replacedOrderId)
        // The venue confirmed this old order is gone. Clear the durable
        // reference before attempting the replacement so a quota/timeout
        // failure cannot leave a phantom "armed" stop in Redis.
        pos.stopLossOrderId = undefined
        pos.stopLossPrice = 0
        setProtectionLegArmedQuantity(pos, "stop_loss", 0)
        result.changed = true
      }
      const reservation = reserveProtectionCapacity(capacityBudget, pos, "stop_loss")
      if (!reservation.allowed) {
        result.changed = true
        return
      }
      const protectionClientOrderId = await prepareProtectionSubmission(
        pos,
        "stopLoss",
        desiredSl,
        effectiveQty,
      )
      const placement = await placeProtectionOrder(
        connector,
        pos.symbol,
        closeSide,
        effectiveQty,
        desiredSl,
        "StopLoss",
        pos.direction!,
        protectionClientOrderId,
      )
      const id = placement.orderId
      // Only treat the leg as "armed at desiredSl" when we actually
      // have a confirmed numeric order id (not the "PRICE_CROSSED" sentinel
      // which means market already blew past the SL and a force-close should
      // happen on the next reconcile checkAndForceCloseOnSltpCross pass).
      const slIdOk = id && id !== "PRICE_CROSSED" && id !== "position_exhausted" && id !== "QUOTA_EXCEEDED"
      if (id === "QUOTA_EXCEEDED") {
        // Account quota exhausted — the old stop was either absent or has just
        // been confirmed cancelled, so persist the system-close fallback rather
        // than retaining a stale exchange order id.
        markProtectionQuotaExhausted(pos.connectionId)
        capacityBudget?.markExhausted()
        releaseProtectionCapacityReservation(capacityBudget, pos, reservation.reservationId)
        pos.protectionMode = "system_close_fallback"
        setSystemProtectionLeg(pos, "stop_loss", true)
        setProtectionLegArmedQuantity(pos, "stop_loss", 0)
        if (pos.pendingProtectionOrders) delete pos.pendingProtectionOrders.stopLoss
        result.changed = true
        pushStep(pos, "protection_quota_system_fallback", true, "SL quota exhausted; using system-side trigger handling")
      } else if (slIdOk) {
        pos.stopLossOrderId = id!
        pos.stopLossPrice = desiredSl
        pos.stopLossLastArmedAt = Date.now()
        setProtectionLegArmedQuantity(pos, "stop_loss", placement.armedQuantity)
        result.changed = true
        result.slPlaced = true
        setSystemProtectionLeg(pos, "stop_loss", false)
        if (capacityBudget) pos.controlOrderCapacity = capacityBudget.snapshot()
        if (pos.pendingProtectionOrders) delete pos.pendingProtectionOrders.stopLoss
      } else {
        releaseProtectionCapacityReservation(capacityBudget, pos, reservation.reservationId)
        pos.stopLossOrderId = undefined
        pos.stopLossPrice = 0
        setProtectionLegArmedQuantity(pos, "stop_loss", 0)
      }
    }
  })()

  const tpLeg = (async () => {
    if (desiredTp <= 0 && pos.takeProfitOrderId && !takeProfitLivenessUnresolved) {
      const cancelledOrderId = pos.takeProfitOrderId
      const cancelled = await cancelProtectionOrder(connector, pos.symbol, cancelledOrderId, "TakeProfit", pos.connectionId)
      if (cancelled) {
        capacityBudget?.noteCancellation(cancelledOrderId)
        pos.takeProfitOrderId = undefined
        pos.takeProfitPrice = 0
        setProtectionLegArmedQuantity(pos, "take_profit", 0)
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
          : needsTakeProfitReplacement
      )
    ) {
      const replacingExistingTakeProfit = needsTakeProfitReplacement && Boolean(pos.takeProfitOrderId)
      if (replacingExistingTakeProfit && !tpCancelOk) {
        // Use the pre-computed tpCancelOk result from parallel cancels above
        // and retain the currently recorded order until the venue confirms
        // it has been removed.
        console.warn(
          `${LOG_PREFIX} TakeProfit cancel failed for ${pos.symbol} — deferring re-place to avoid duplicate reduceOnly`,
        )
        return
      }
      if (replacingExistingTakeProfit) {
        const replacedOrderId = pos.takeProfitOrderId
        if (replacedOrderId) capacityBudget?.noteCancellation(replacedOrderId)
        pos.takeProfitOrderId = undefined
        pos.takeProfitPrice = 0
        setProtectionLegArmedQuantity(pos, "take_profit", 0)
        result.changed = true
      }
      const reservation = reserveProtectionCapacity(capacityBudget, pos, "take_profit")
      if (!reservation.allowed) {
        result.changed = true
        return
      }
      const protectionClientOrderId = await prepareProtectionSubmission(
        pos,
        "takeProfit",
        desiredTp,
        effectiveQty,
      )
      const placement = await placeProtectionOrder(
        connector,
        pos.symbol,
        closeSide,
        effectiveQty,
        desiredTp,
        "TakeProfit",
        pos.direction!,
        protectionClientOrderId,
      )
      const id = placement.orderId
      const tpIdOk = id && id !== "PRICE_CROSSED" && id !== "position_exhausted" && id !== "QUOTA_EXCEEDED"
      if (id === "QUOTA_EXCEEDED") {
        // Mirror of the SL leg: preserve the fact that the venue order is
        // absent and enable the durable system-close fallback.
        markProtectionQuotaExhausted(pos.connectionId)
        capacityBudget?.markExhausted()
        releaseProtectionCapacityReservation(capacityBudget, pos, reservation.reservationId)
        pos.protectionMode = "system_close_fallback"
        setSystemProtectionLeg(pos, "take_profit", true)
        setProtectionLegArmedQuantity(pos, "take_profit", 0)
        if (pos.pendingProtectionOrders) delete pos.pendingProtectionOrders.takeProfit
        result.changed = true
        pushStep(pos, "protection_quota_system_fallback", true, "TP quota exhausted; using system-side trigger handling")
      } else if (tpIdOk) {
        pos.takeProfitOrderId = id!
        pos.takeProfitPrice = desiredTp
        pos.takeProfitLastArmedAt = Date.now()
        setProtectionLegArmedQuantity(pos, "take_profit", placement.armedQuantity)
        result.changed = true
        result.tpPlaced = true
        setSystemProtectionLeg(pos, "take_profit", false)
        if (capacityBudget) pos.controlOrderCapacity = capacityBudget.snapshot()
        if (pos.pendingProtectionOrders) delete pos.pendingProtectionOrders.takeProfit
      } else {
        releaseProtectionCapacityReservation(capacityBudget, pos, reservation.reservationId)
        pos.takeProfitOrderId = undefined
        pos.takeProfitPrice = 0
        setProtectionLegArmedQuantity(pos, "take_profit", 0)
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

  // Each successful leg records the exact quantity accepted by the venue.
  // Keep the legacy aggregate as the smaller active leg so old readers remain
  // conservative and can never mistake a quantity-adjusted order for full
  // coverage. Failed/missing legs do not contribute a protected baseline.
  refreshLegacyProtectionArmedQuantity(pos)
  refreshProtectionHandlingMode(pos, desiredSl, desiredTp)
  if (capacityBudget) pos.controlOrderCapacity = capacityBudget.snapshot()

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

interface AggregateProtectionBookResult {
  plans: AggregateProtectionPlan[]
  changedPositions: number
  rearmedLeaders: number
  ownershipMismatches: number
  closedMemberIds: Set<string>
}

function configuredSystemProtectionLegs(position: LivePosition): ProtectionOrderLeg[] {
  const { desiredSl, desiredTp } = computeDesiredProtectionPrices(position)
  const legs: ProtectionOrderLeg[] = []
  if (desiredSl > 0) legs.push("stop_loss")
  if (desiredTp > 0) legs.push("take_profit")
  return legs
}

function initialAggregateProtectionCoordination(
  position: LivePosition,
  currentPositions: readonly LivePosition[],
): { deferred: boolean; slot: string; memberCount: number } {
  const direction = resolveLivePositionDirection(position)
  const slot = direction ? aggregateProtectionSlot(position.symbol, direction) : ""
  if (!direction || !slot) return { deferred: false, slot, memberCount: 0 }
  const activeStatuses = new Set(["open", "filled", "partially_filled"])
  const byId = new Map<string, LivePosition>()
  for (const candidate of [position, ...currentPositions]) {
    const candidateDirection = resolveLivePositionDirection(candidate)
    if (!candidateDirection) continue
    if (aggregateProtectionSlot(candidate.symbol, candidateDirection) !== slot) continue
    if (!activeStatuses.has(String(candidate.status || "").toLowerCase())) continue
    if (Number(candidate.executedQuantity || 0) <= 0) continue
    if (!isExchangeLifecyclePosition(candidate, position.connectionId)) continue
    byId.set(candidate.id, candidate)
  }
  // Row controls are never delegated. `deferred` is retained for snapshot
  // compatibility and is now always false; only the security stop is shared.
  return { deferred: false, slot, memberCount: byId.size }
}

async function demoteAggregateProtectionMember(
  connector: any,
  position: LivePosition,
  plan: AggregateProtectionPlan,
  detail = `${plan.key} security stop owned by ${plan.leaderId}; row SL/TP ownership is unchanged`,
  liveOrderIds: Set<string> | null = null,
): Promise<boolean> {
  let changed = position.aggregateProtectionOwner !== false
    || position.aggregateProtectionKey !== plan.key
    || position.aggregateProtectionMemberCount !== plan.memberIds.length
    || Math.abs(Number(position.aggregateProtectionQuantity || 0) - plan.venueQuantity) > plan.quantityTolerance
  const pending = position.pendingProtectionOrders?.securityStop
  if (pending?.clientOrderId) {
    const recovered = await recoverEntryOrderByClientId(connector, position.symbol, pending.clientOrderId)
    if (recovered?.orderId != null || recovered?.id != null) {
      const orderId = String(recovered.orderId ?? recovered.id)
      position.securityStopOrderId = orderId
      delete position.pendingProtectionOrders?.securityStop
      changed = true
    }
  }
  if (position.pendingProtectionOrders?.securityStop?.clientOrderId) {
    position.securityStopStatus = "pending"
    position.updatedAt = Date.now()
    pushStep(position, "aggregate_security_handoff_wait", false, `${detail}; prior security submission is unresolved`)
    await savePosition(position)
    return true
  }
  if (position.securityStopOrderId) {
    // A missing order-list row is not cancellation authority. The aggregate
    // pre-pass point-queries it for a fill and advances repeated-absence state;
    // retain ownership until that process clears the ID.
    if (liveOrderIds === null || !liveOrderIds.has(position.securityStopOrderId)) {
      position.securityStopStatus = "pending"
      position.updatedAt = Date.now()
      pushStep(position, "aggregate_security_handoff_wait", false, `${detail}; prior security stop state is unresolved`)
      await savePosition(position)
      return true
    }
    const cancelled = await cancelProtectionOrder(
      connector,
      position.symbol,
      position.securityStopOrderId,
      "AggregateDemote-Security",
      position.connectionId,
    )
    if (!cancelled) {
      position.securityStopStatus = "pending"
      position.updatedAt = Date.now()
      pushStep(position, "aggregate_security_handoff_wait", false, `${detail}; prior security stop cancellation is unconfirmed`)
      await savePosition(position)
      return true
    }
    position.securityStopOrderId = undefined
    position.securityStopPrice = 0
    position.securityStopArmedQuantity = 0
    position.securityStopLastArmedAt = undefined
    position.securityStopAbsenceConfirmations = 0
    changed = true
  }
  position.aggregateProtectionOwner = false
  position.aggregateProtectionKey = plan.key
  position.aggregateProtectionMemberCount = plan.memberIds.length
  position.aggregateProtectionQuantity = plan.venueQuantity
  refreshProtectionHandlingMode(
    position,
    computeDesiredProtectionPrices(position).desiredSl,
    computeDesiredProtectionPrices(position).desiredTp,
  )
  refreshControlOrderSetCoverage(position)
  if (changed) {
    pushStep(
      position,
      "aggregate_protection_member",
      true,
      detail,
    )
    position.updatedAt = Date.now()
    await savePosition(position)
  }
  return changed
}

function supportsPositionSecurityStop(connector: any): boolean {
  if (!connector || typeof connector.placeStopOrder !== "function") return false
  try {
    const capabilities = typeof connector.getCapabilities === "function"
      ? connector.getCapabilities()
      : []
    return Array.isArray(capabilities) && capabilities.includes("position_close_all_stop")
  } catch {
    return false
  }
}

function securityStopPriceDrifted(current: unknown, desired: number, tick: number): boolean {
  const existing = Number(current)
  if (!(desired > 0) || !(tick > 0)) return true
  if (!(existing > 0)) return true
  return Math.abs(existing - desired) >= tick / 2
}

function securityStopQuantityDrifted(current: unknown, desired: number, tolerance: number): boolean {
  const existing = Number(current)
  const normalizedTolerance = Math.max(1e-12, Number(tolerance) || 0)
  if (!(desired > 0) || !Number.isFinite(existing) || !(existing > 0)) return true
  return Math.abs(existing - desired) > normalizedTolerance
}

function securityStopPriceRearmDeferred(
  position: Pick<LivePosition, "securityStopOrderId" | "securityStopLastArmedAt">,
  priceDrifted: boolean,
  quantityDrifted: boolean,
  now = Date.now(),
): boolean {
  if (!position.securityStopOrderId || !priceDrifted || quantityDrifted) return false
  const armedAt = Number(position.securityStopLastArmedAt)
  if (!(armedAt > 0) || !Number.isFinite(now)) return false
  return now - armedAt < SECURITY_STOP_PRICE_REARM_MS
}

async function cancelSlotOwnedControls(
  connector: any,
  position: LivePosition,
  includeRowControls: boolean,
  label: string,
): Promise<boolean> {
  const pendingLegs = includeRowControls
    ? (["stopLoss", "takeProfit", "securityStop"] as const)
    : (["securityStop"] as const)
  for (const leg of pendingLegs) {
    const pending = position.pendingProtectionOrders?.[leg]
    if (!pending?.clientOrderId) continue
    const recovered = await recoverEntryOrderByClientId(connector, position.symbol, pending.clientOrderId)
    const recoveredId = firstNonEmptyIdentifier(recovered?.orderId, recovered?.id)
    if (recoveredId) {
      if (leg === "stopLoss") position.stopLossOrderId = recoveredId
      else if (leg === "takeProfit") position.takeProfitOrderId = recoveredId
      else position.securityStopOrderId = recoveredId
      delete position.pendingProtectionOrders?.[leg]
    } else {
      // A response-lost write cannot be declared absent by a failed point
      // lookup. Its durable client id remains a mutation barrier.
      return false
    }
  }

  const controls = [
    ...(includeRowControls
      ? [
          { leg: "stop_loss" as const, id: position.stopLossOrderId, tag: `${label}-SL` },
          { leg: "take_profit" as const, id: position.takeProfitOrderId, tag: `${label}-TP` },
        ]
      : []),
    { leg: "security_stop" as const, id: position.securityStopOrderId, tag: `${label}-Security` },
  ]
  for (const control of controls) {
    if (!control.id) continue
    const cancelled = await cancelProtectionOrder(
      connector,
      position.symbol,
      control.id,
      control.tag,
      position.connectionId,
    )
    if (!cancelled) return false
    if (control.leg === "stop_loss") {
      position.stopLossOrderId = undefined
      position.stopLossPrice = 0
      position.stopLossAbsenceConfirmations = 0
      setProtectionLegArmedQuantity(position, "stop_loss", 0)
    } else if (control.leg === "take_profit") {
      position.takeProfitOrderId = undefined
      position.takeProfitPrice = 0
      position.takeProfitAbsenceConfirmations = 0
      setProtectionLegArmedQuantity(position, "take_profit", 0)
    } else {
      position.securityStopOrderId = undefined
      position.securityStopPrice = 0
      position.securityStopArmedQuantity = 0
      position.securityStopAbsenceConfirmations = 0
      position.securityStopLastArmedAt = undefined
    }
  }
  if (includeRowControls) {
    refreshProtectionHandlingMode(
      position,
      computeDesiredProtectionPrices(position).desiredSl,
      computeDesiredProtectionPrices(position).desiredTp,
    )
  }
  return true
}

/**
 * Settle controls during an ownership mismatch or queued quantity mutation
 * without interpreting one missing open-order snapshot as proof of absence.
 * Point fill reconciliation runs immediately before this helper.
 */
async function settleSlotControlsWithoutGuess(
  connector: any,
  position: LivePosition,
  includeRowControls: boolean,
  liveOrderIds: Set<string> | null,
  label: string,
): Promise<boolean> {
  if (liveOrderIds === null) return false
  let settled = true
  const pendingLegs = includeRowControls
    ? (["stopLoss", "takeProfit", "securityStop"] as const)
    : (["securityStop"] as const)
  for (const leg of pendingLegs) {
    const pending = position.pendingProtectionOrders?.[leg]
    if (!pending?.clientOrderId) continue
    const recovered = await recoverEntryOrderByClientId(connector, position.symbol, pending.clientOrderId)
    const recoveredId = firstNonEmptyIdentifier(recovered?.orderId, recovered?.id)
    if (recoveredId) {
      if (leg === "stopLoss") position.stopLossOrderId = recoveredId
      else if (leg === "takeProfit") position.takeProfitOrderId = recoveredId
      else position.securityStopOrderId = recoveredId
      delete position.pendingProtectionOrders?.[leg]
      settled = false
      continue
    }
    if (liveOrderIds.has(pending.clientOrderId)) {
      settled = false
      continue
    }
    pending.absenceConfirmations = Number(pending.absenceConfirmations || 0) + 1
    if (pending.absenceConfirmations >= 2) delete position.pendingProtectionOrders?.[leg]
    else settled = false
  }

  const controls = [
    ...(includeRowControls
      ? [
          { leg: "stop_loss" as const, id: position.stopLossOrderId, tag: `${label}-SL` },
          { leg: "take_profit" as const, id: position.takeProfitOrderId, tag: `${label}-TP` },
        ]
      : []),
    { leg: "security_stop" as const, id: position.securityStopOrderId, tag: `${label}-Security` },
  ]
  for (const control of controls) {
    if (!control.id) continue
    if (!liveOrderIds.has(control.id)) {
      if (control.leg === "stop_loss") {
        position.stopLossAbsenceConfirmations = Number(position.stopLossAbsenceConfirmations || 0) + 1
        if (position.stopLossAbsenceConfirmations >= 2) {
          position.stopLossOrderId = undefined
          position.stopLossPrice = 0
          position.stopLossAbsenceConfirmations = 0
          setProtectionLegArmedQuantity(position, "stop_loss", 0)
        } else settled = false
      } else if (control.leg === "take_profit") {
        position.takeProfitAbsenceConfirmations = Number(position.takeProfitAbsenceConfirmations || 0) + 1
        if (position.takeProfitAbsenceConfirmations >= 2) {
          position.takeProfitOrderId = undefined
          position.takeProfitPrice = 0
          position.takeProfitAbsenceConfirmations = 0
          setProtectionLegArmedQuantity(position, "take_profit", 0)
        } else settled = false
      } else {
        // Security absence is advanced by the point-query pre-pass once per
        // reconciliation cycle; never double-count it here.
        settled = false
      }
      continue
    }
    const cancelled = await cancelProtectionOrder(
      connector,
      position.symbol,
      control.id,
      control.tag,
      position.connectionId,
    )
    if (!cancelled) {
      settled = false
      continue
    }
    if (control.leg === "stop_loss") {
      position.stopLossOrderId = undefined
      position.stopLossPrice = 0
      position.stopLossAbsenceConfirmations = 0
      setProtectionLegArmedQuantity(position, "stop_loss", 0)
    } else if (control.leg === "take_profit") {
      position.takeProfitOrderId = undefined
      position.takeProfitPrice = 0
      position.takeProfitAbsenceConfirmations = 0
      setProtectionLegArmedQuantity(position, "take_profit", 0)
    } else {
      position.securityStopOrderId = undefined
      position.securityStopPrice = 0
      position.securityStopArmedQuantity = 0
      position.securityStopAbsenceConfirmations = 0
      position.securityStopLastArmedAt = undefined
    }
  }
  if (includeRowControls) {
    refreshProtectionHandlingMode(
      position,
      computeDesiredProtectionPrices(position).desiredSl,
      computeDesiredProtectionPrices(position).desiredTp,
    )
  }
  return settled
}

function apportionedSettlement(
  settlement: ExchangeOrderSettlement | null,
  quantity: number,
  ratio: number,
): ExchangeOrderSettlement | null {
  if (!settlement || !(quantity > 0) || !(ratio > 0)) return null
  return {
    ...settlement,
    filledQuantity: quantity,
    grossRealizedPnl: Number(settlement.grossRealizedPnl || 0) * ratio,
    tradingFee: Number(settlement.tradingFee || 0) * ratio,
    netRealizedPnl: Number(settlement.netRealizedPnl || 0) * ratio,
    fills: (settlement.fills || []).map((fill) => ({
      ...fill,
      quantity: Number(fill.quantity || 0) * ratio,
      realizedPnl: Number(fill.realizedPnl || 0) * ratio,
      fee: Number(fill.fee || 0) * ratio,
      feeCost: Number(fill.feeCost || 0) * ratio,
    })),
  }
}

async function settleSecurityStopAcrossMembers(
  connectionId: string,
  connector: any,
  members: LivePosition[],
  securityOwner: LivePosition,
  securityOrder: any,
  securityOrderId: string,
  result: AggregateProtectionBookResult,
): Promise<void> {
  // Exact row controls can trigger in the same venue matching cycle as the
  // farther close-all order. Account every row fill first; the security fill
  // then owns only the still-open remainder.
  for (const member of members) {
    for (const leg of ["stopLoss", "takeProfit"] as const) {
      const orderId = leg === "stopLoss" ? member.stopLossOrderId : member.takeProfitOrderId
      if (!orderId || typeof connector?.getOrder !== "function") continue
      const order = await withTimeout(
        connector.getOrder(member.symbol, orderId) as Promise<any>,
        EXCHANGE_TIMEOUT_GET_ORDER_MS,
        `getOrder(simultaneous-${leg} ${orderId})`,
      ).catch(() => null)
      if (!order) continue
      const status = controlOrderStatus(order)
      const filledQuantity = controlOrderFilledQuantity(order)
      if (!(filledQuantity > 0) && !isFilledControlOrderStatus(status)) continue
      const before = Number(member.executedQuantity || 0)
      const quantity = Math.min(before, filledQuantity > 0 ? filledQuantity : before)
      const settlement = await readOrderSettlement(connector, member.symbol, orderId)
      const existing = member.partialOrderExecutions?.find((entry) => entry.id === `${member.id}:control_order:${orderId}`)
      applyReductionObservation(member, {
        executionId: `${member.id}:control_order:${orderId}`,
        source: "control_order",
        status,
        requestedQuantity: before,
        reportedFilledQuantity: quantity,
        previouslyAppliedQuantity: Number(existing?.cumulativeFilledQuantity || 0),
        authoritativeQuantity: null,
        price: controlOrderFillPrice(order),
        settlement,
        orderId,
      })
      if (leg === "stopLoss") {
        member.stopLossOrderId = undefined
        member.stopLossPrice = 0
        setProtectionLegArmedQuantity(member, "stop_loss", 0)
      } else {
        member.takeProfitOrderId = undefined
        member.takeProfitPrice = 0
        setProtectionLegArmedQuantity(member, "take_profit", 0)
      }
    }
  }

  const remainingMembers = members.filter((member) => Number(member.executedQuantity || 0) > 0)
  const totalRemaining = remainingMembers.reduce((sum, member) => sum + Number(member.executedQuantity || 0), 0)
  const securitySettlement = await readOrderSettlement(connector, securityOwner.symbol, securityOrderId)
  const reportedSecurityFill = Math.max(
    controlOrderFilledQuantity(securityOrder),
    Number(securitySettlement?.filledQuantity || 0),
    totalRemaining,
  )
  const securityFillPrice = Number(
    securitySettlement?.averageFillPrice || controlOrderFillPrice(securityOrder) || 0,
  )
  for (const member of remainingMembers) {
    const before = Number(member.executedQuantity || 0)
    const ratio = totalRemaining > 0 ? before / totalRemaining : 0
    const quantity = Math.min(before, reportedSecurityFill * ratio)
    const existing = member.partialOrderExecutions?.find((entry) => entry.id === `${member.id}:security_stop:${securityOrderId}`)
    applyReductionObservation(member, {
      executionId: `${member.id}:security_stop:${securityOrderId}`,
      source: "control_order",
      status: controlOrderStatus(securityOrder) || "filled",
      requestedQuantity: before,
      reportedFilledQuantity: quantity,
      previouslyAppliedQuantity: Number(existing?.cumulativeFilledQuantity || 0),
      authoritativeQuantity: 0,
      price: securityFillPrice,
      settlement: apportionedSettlement(securitySettlement, quantity, ratio),
      orderId: securityOrderId,
    })
  }

  for (const member of members) {
    await cancelSlotOwnedControls(connector, member, true, "SecurityFillCleanup")
    member.securityStopOrderId = undefined
    member.securityStopPrice = 0
    member.securityStopArmedQuantity = 0
    member.securityStopRequired = supportsPositionSecurityStop(connector)
    member.securityStopStatus = "system_close"
    member.updatedAt = Date.now()
    await savePosition(member)
  }
  for (const member of members) {
    const terminal = await closeLivePosition(
      connectionId,
      member.id,
      securityFillPrice,
      connector,
      "security_stop_filled",
    )
    if (terminal?.status === "closed") {
      Object.assign(member, terminal)
      result.closedMemberIds.add(member.id)
      result.changedPositions++
    }
  }
}

/**
 * Reconcile an exact row SL/TP fill before aggregate quantity-generation
 * inference. BingX exposes one net venue quantity for a symbol/direction, so a
 * bare aggregate reduction cannot identify which Set closed. The filled row
 * order ID can, and is therefore authoritative for member attribution.
 */
async function settleFilledRowControlsAcrossMembers(
  connectionId: string,
  connector: any,
  members: LivePosition[],
  liveOrderIds: Set<string> | null,
  result: AggregateProtectionBookResult,
  persistPosition: (position: LivePosition) => Promise<void> = savePosition,
): Promise<boolean> {
  if (liveOrderIds === null || typeof connector?.getOrder !== "function") return false
  let observedFill = false
  for (const member of members) {
    for (const leg of ["stopLoss", "takeProfit"] as const) {
      const orderId = leg === "stopLoss" ? member.stopLossOrderId : member.takeProfitOrderId
      if (!orderId || liveOrderIds.has(orderId)) continue
      const order = await withTimeout(
        connector.getOrder(member.symbol, orderId) as Promise<any>,
        EXCHANGE_TIMEOUT_GET_ORDER_MS,
        `getOrder(row-${leg} ${orderId})`,
      ).catch(() => null)
      if (!order) continue
      const status = controlOrderStatus(order)
      const reportedFill = controlOrderFilledQuantity(order)
      if (!(reportedFill > 0) && !isFilledControlOrderStatus(status)) continue

      observedFill = true
      const before = Math.max(0, Number(member.executedQuantity || 0))
      const settlement = await readOrderSettlement(connector, member.symbol, orderId)
      const settledFill = Math.max(reportedFill, Number(settlement?.filledQuantity || 0))
      const quantity = Math.min(before, settledFill > 0 ? settledFill : before)
      const executionId = `${member.id}:control_order:${orderId}`
      const existing = member.partialOrderExecutions?.find((entry) => entry.id === executionId)
      applyReductionObservation(member, {
        executionId,
        source: "control_order",
        status: status || "filled",
        requestedQuantity: before,
        reportedFilledQuantity: quantity,
        previouslyAppliedQuantity: Number(existing?.cumulativeFilledQuantity || 0),
        authoritativeQuantity: null,
        price: controlOrderFillPrice(order),
        settlement,
        orderId,
      })
      if (leg === "stopLoss") {
        member.stopLossOrderId = undefined
        member.stopLossPrice = 0
        member.stopLossAbsenceConfirmations = 0
        setProtectionLegArmedQuantity(member, "stop_loss", 0)
      } else {
        member.takeProfitOrderId = undefined
        member.takeProfitPrice = 0
        member.takeProfitAbsenceConfirmations = 0
        setProtectionLegArmedQuantity(member, "take_profit", 0)
      }

      const tolerance = Math.max(1e-12, Number(member.quantityStep || 0) / 2)
      let terminalCleanupConfirmed = true
      if (Number(member.executedQuantity || 0) <= tolerance) {
        // The sibling row control can no longer execute legitimately. If this
        // row owned the slot security order, cancel it too so the next fresh
        // plan can elect a still-open member without transferring ownership.
        const siblingId = leg === "stopLoss" ? member.takeProfitOrderId : member.stopLossOrderId
        if (siblingId) {
          const cancelled = await cancelProtectionOrder(
            connector,
            member.symbol,
            siblingId,
            "RowFill-Sibling",
            member.connectionId,
          )
          terminalCleanupConfirmed = terminalCleanupConfirmed && cancelled
          if (cancelled) {
            if (leg === "stopLoss") {
              member.takeProfitOrderId = undefined
              member.takeProfitPrice = 0
              setProtectionLegArmedQuantity(member, "take_profit", 0)
            } else {
              member.stopLossOrderId = undefined
              member.stopLossPrice = 0
              setProtectionLegArmedQuantity(member, "stop_loss", 0)
            }
          }
        }
        if (member.securityStopOrderId) {
          const cancelled = await cancelProtectionOrder(
            connector,
            member.symbol,
            member.securityStopOrderId,
            "RowFill-SecurityHandoff",
            member.connectionId,
          )
          terminalCleanupConfirmed = terminalCleanupConfirmed && cancelled
          if (cancelled) {
            member.securityStopOrderId = undefined
            member.securityStopPrice = 0
            member.securityStopArmedQuantity = 0
            member.securityStopAbsenceConfirmations = 0
          }
        }
        member.status = "closing_partial"
        member.statusReason = terminalCleanupConfirmed
          ? "row_control_fill_cleanup_complete"
          : "row_control_fill_cleanup_pending"
      }
      refreshProtectionHandlingMode(
        member,
        computeDesiredProtectionPrices(member).desiredSl,
        computeDesiredProtectionPrices(member).desiredTp,
      )
      member.updatedAt = Date.now()
      await persistPosition(member)
      result.changedPositions++

      if (Number(member.executedQuantity || 0) <= tolerance && terminalCleanupConfirmed) {
        const terminal = await closeLivePosition(
          connectionId,
          member.id,
          Number(settlement?.averageFillPrice || controlOrderFillPrice(order) || 0),
          undefined,
          "exchange_reconciliation",
        )
        if (terminal?.status === "closed") {
          Object.assign(member, terminal)
          result.closedMemberIds.add(member.id)
        }
      }
      // One exact-quantity row fill consumes this member's current exposure;
      // never apply a second sibling observation against the same quantity.
      break
    }
  }
  return observedFill
}

/**
 * Reconcile exact row SL/TP orders, then one farther aggregate-quantity security stop
 * per system-owned physical symbol/direction slot.
 */
async function reconcileAggregateProtectionBook(
  connectionId: string,
  connector: any,
  positions: LivePosition[],
  exchangePositions: any[],
  liveOrderIds: Set<string> | null,
  mutationGuard?: () => void | Promise<void>,
): Promise<AggregateProtectionBookResult> {
  const result: AggregateProtectionBookResult = {
    plans: [],
    changedPositions: 0,
    rearmedLeaders: 0,
    ownershipMismatches: 0,
    closedMemberIds: new Set<string>(),
  }
  if (!connector) return result

  // Resume a crash/interruption between exact row-fill accounting and sibling
  // control cleanup. Zero-quantity rows remain in the open index until every
  // potentially netting venue control is authoritatively cancelled.
  for (const position of positions) {
    const tolerance = Math.max(1e-12, Number(position.quantityStep || 0) / 2)
    const terminalRowCleanup = Number(position.executedQuantity || 0) <= tolerance
      && (
        String(position.statusReason || "").startsWith("row_control_fill_cleanup_")
        || Boolean(position.stopLossOrderId)
        || Boolean(position.takeProfitOrderId)
        || Boolean(position.securityStopOrderId)
        || Boolean(position.pendingProtectionOrders?.stopLoss?.clientOrderId)
        || Boolean(position.pendingProtectionOrders?.takeProfit?.clientOrderId)
        || Boolean(position.pendingProtectionOrders?.securityStop?.clientOrderId)
    )
    if (!terminalRowCleanup) continue
    await mutationGuard?.()
    const settled = await cancelSlotOwnedControls(connector, position, true, "RowFillResume")
    position.status = "closing_partial"
    position.statusReason = settled
      ? "row_control_fill_cleanup_complete"
      : "row_control_fill_cleanup_pending"
    position.updatedAt = Date.now()
    await savePosition(position)
    result.changedPositions++
    if (!settled) continue
    const terminal = await closeLivePosition(
      connectionId,
      position.id,
      Number(position.exchangeData?.markPrice || position.averageExecutionPrice || position.entryPrice || 0),
      undefined,
      "exchange_reconciliation",
    )
    if (terminal?.status === "closed") {
      Object.assign(position, terminal)
      result.closedMemberIds.add(position.id)
    }
  }

  const activeStatuses = new Set(["open", "filled", "partially_filled"])
  const candidates = positions.filter((position) =>
    activeStatuses.has(String(position.status || "").toLowerCase())
    && Number(position.executedQuantity || 0) > 0
    && isExchangeLifecyclePosition(position, connectionId),
  )
  const bySymbol = new Map<string, LivePosition[]>()
  for (const position of candidates) {
    const symbol = String(position.symbol || "").toUpperCase().replace(/[-/_:]/g, "")
    const rows = bySymbol.get(symbol) || []
    rows.push(position)
    bySymbol.set(symbol, rows)
  }
  await mapWithConcurrency([...bySymbol.entries()], 4, async ([symbol, rows]) => {
    const rules = await loadExchangeQuantityRules(symbol, connector, connectionId)
    for (const row of rows) {
      const before = `${row.quantityStep}|${row.quantityPrecision}|${row.pricePrecision}|${row.priceTick}`
      applyLiveInstrumentRules(row, rules)
      const after = `${row.quantityStep}|${row.quantityPrecision}|${row.pricePrecision}|${row.priceTick}`
      if (before !== after) {
        row.updatedAt = Date.now()
        await savePosition(row)
        result.changedPositions++
      }
    }
  })

  const venueBySlot = new Map<string, { quantity: number; entryPrice: number; liquidationPrice: number; markPrice: number }>()
  const venueCandidates = exchangePositions.flatMap((position) => {
    const rawQuantity = Number(position?.size ?? position?.positionAmt ?? position?.quantity ?? 0)
    const quantity = Math.abs(rawQuantity)
    const direction = normalizeExchangePositionDirection(position?.positionSide, position?.side, rawQuantity)
    if (!direction || !(quantity > 0)) return []
    const symbol = String(position?.symbol || "")
    venueBySlot.set(aggregateProtectionSlot(symbol, direction), {
      quantity,
      entryPrice: Number(position?.entryPrice ?? position?.avgPrice ?? 0) || 0,
      liquidationPrice: Number(position?.liquidationPrice ?? position?.liqPrice ?? 0) || 0,
      markPrice: Number(position?.markPrice ?? position?.indexPrice ?? position?.lastPrice ?? 0) || 0,
    })
    return [{ symbol, direction, quantity }]
  })
  const planCandidates = candidates.map((position) => {
    const direction = resolveLivePositionDirection(position)!
    const desired = computeDesiredProtectionPrices(position)
    const priceTick = Number(position.priceTick || 0)
    const venue = venueBySlot.get(aggregateProtectionSlot(position.symbol, direction))
    return {
      id: position.id,
      symbol: position.symbol,
      direction,
      quantity: Number(position.executedQuantity || 0),
      entryPrice: Number(position.averageExecutionPrice || position.entryPrice || venue?.entryPrice || 0),
      liquidationPrice: Number(position.liquidationPrice || position.exchangeData?.liquidationPrice || venue?.liquidationPrice || 0),
      priceTick,
      desiredStopLoss: normalizeProtectionTriggerPrice(desired.desiredSl, priceTick, direction, "stop_loss"),
      desiredTakeProfit: normalizeProtectionTriggerPrice(desired.desiredTp, priceTick, direction, "take_profit"),
      createdAt: Number(position.createdAt || 0),
      quantityStep: Number(position.quantityStep || 0),
      hasSecurityStopOrder: Boolean(position.securityStopOrderId),
      hasPendingSecurityStop: Boolean(position.pendingProtectionOrders?.securityStop),
    }
  })
  result.plans = buildAggregateProtectionPlans(planCandidates, venueCandidates)
  const positionsById = new Map(candidates.map((position) => [position.id, position]))
  const securitySupported = supportsPositionSecurityStop(connector)

  for (const plan of result.plans) {
    await mutationGuard?.()
    const members = plan.memberIds.map((id) => positionsById.get(id)).filter((value): value is LivePosition => Boolean(value))
    const allSlotMembers = members

    // Security liveness/fill is reconciled before child rows. Unknown status
    // retains ownership and blocks a duplicate; a confirmed fill is settled
    // row-first by settleSecurityStopAcrossMembers.
    const existingSecurityOwner = allSlotMembers.find((member) => member.securityStopOrderId)
    let securityLivenessUnresolved = false
    if (existingSecurityOwner?.securityStopOrderId && !liveOrderIds?.has(existingSecurityOwner.securityStopOrderId)) {
      const order = typeof connector.getOrder === "function"
        ? await withTimeout(
            connector.getOrder(existingSecurityOwner.symbol, existingSecurityOwner.securityStopOrderId) as Promise<any>,
            EXCHANGE_TIMEOUT_GET_ORDER_MS,
            `getOrder(security ${existingSecurityOwner.securityStopOrderId})`,
          ).catch(() => null)
        : null
      const status = controlOrderStatus(order)
      if (order && (isFilledControlOrderStatus(status) || controlOrderFilledQuantity(order) > 0)) {
        await settleSecurityStopAcrossMembers(
          connectionId,
          connector,
          allSlotMembers,
          existingSecurityOwner,
          order,
          existingSecurityOwner.securityStopOrderId,
          result,
        )
        continue
      }
      // Some BingX control fills leave trade/settlement history before the
      // point-order endpoint exposes a terminal status. Settlement is still
      // authoritative and must be apportioned across every logical row here,
      // never independently as one full-slot PnL on the elected owner.
      const securitySettlement = await readOrderSettlement(
        connector,
        existingSecurityOwner.symbol,
        existingSecurityOwner.securityStopOrderId,
      )
      if (Number(securitySettlement?.filledQuantity || 0) > 0) {
        await settleSecurityStopAcrossMembers(
          connectionId,
          connector,
          allSlotMembers,
          existingSecurityOwner,
          {
            ...(order || {}),
            status: "filled",
            filledQty: securitySettlement!.filledQuantity,
            filledPrice: securitySettlement!.averageFillPrice,
          },
          existingSecurityOwner.securityStopOrderId,
          result,
        )
        continue
      }
      if (order && !["cancelled", "canceled", "rejected", "expired"].includes(status)) {
        existingSecurityOwner.securityStopAbsenceConfirmations = 0
        securityLivenessUnresolved = true
      } else if (liveOrderIds !== null) {
        existingSecurityOwner.securityStopAbsenceConfirmations = Number(existingSecurityOwner.securityStopAbsenceConfirmations || 0) + 1
        if (existingSecurityOwner.securityStopAbsenceConfirmations >= 2) {
          existingSecurityOwner.securityStopOrderId = undefined
          existingSecurityOwner.securityStopPrice = 0
          existingSecurityOwner.securityStopArmedQuantity = 0
          existingSecurityOwner.securityStopAbsenceConfirmations = 0
        }
        existingSecurityOwner.updatedAt = Date.now()
        await savePosition(existingSecurityOwner)
        result.changedPositions++
        securityLivenessUnresolved = Boolean(existingSecurityOwner.securityStopOrderId)
      } else {
        securityLivenessUnresolved = true
      }
    } else if (existingSecurityOwner?.securityStopOrderId) {
      existingSecurityOwner.securityStopAbsenceConfirmations = 0
    }

    // Attribute exact SL/TP fills before interpreting a lower aggregate venue
    // quantity as a stale slot generation. A handled fill intentionally ends
    // this plan pass; the next fresh snapshot rebuilds membership/ownership
    // from the updated row quantities.
    if (await settleFilledRowControlsAcrossMembers(
      connectionId,
      connector,
      allSlotMembers,
      liveOrderIds,
      result,
    )) continue

    if (!plan.ownershipMatches) {
      result.ownershipMismatches++
      const safelyScopedRows = plan.systemQuantity <= plan.venueQuantity + plan.quantityTolerance
      for (const member of members) {
        await demoteAggregateProtectionMember(
          connector,
          member,
          plan,
          `${plan.key} system=${plan.systemQuantity} venue=${plan.venueQuantity}; security stop withheld until exact ownership`,
          liveOrderIds,
        )
        member.securityStopRequired = securitySupported
        member.securityStopStatus = "ownership_mismatch"
        if (safelyScopedRows) {
          const row = await updateProtectionOrders(connector, member, "row_guard_ownership_mismatch", liveOrderIds)
          if (row.slPlaced || row.tpPlaced) result.rearmedLeaders++
        } else {
          const settled = await settleSlotControlsWithoutGuess(
            connector,
            member,
            true,
            liveOrderIds,
            "OwnershipMismatch",
          )
          member.systemProtectionLegs = configuredSystemProtectionLegs(member)
          member.protectionMode = settled ? "system_close_fallback" : "hybrid_control_system"
        }
        refreshControlOrderSetCoverage(member)
        member.updatedAt = Date.now()
        await savePosition(member)
        result.changedPositions++
      }
      continue
    }

    const mutationRequested = members.some((member) =>
      Number(member.aggregateProtectionMutationRequestedAt || 0) > 0,
    )
    if (mutationRequested) {
      queueAggregateProtectionFinalization(connectionId, plan.key)
      const settledById = new Map<string, boolean>()
      for (const member of members) {
        const settled = await settleSlotControlsWithoutGuess(
          connector,
          member,
          true,
          liveOrderIds,
          "QuantityMutation",
        )
        settledById.set(member.id, settled)
      }
      const allControlsSettled = members.every((member) => settledById.get(member.id) === true)
      const settledAt = Date.now()
      for (const member of members) {
        const memberSettled = settledById.get(member.id) === true
        member.securityStopRequired = securitySupported
        member.securityStopStatus = memberSettled && allControlsSettled ? "pending" : "system_close"
        if (Number(member.aggregateProtectionMutationRequestedAt || 0) > 0) {
          if (allControlsSettled) {
            if (!(Number(member.aggregateProtectionMutationSettledAt || 0) > 0)) {
              member.aggregateProtectionMutationSettledAt = settledAt
              pushStep(
                member,
                "aggregate_protection_mutation_ready",
                true,
                `${plan.key} row/security controls are authoritatively settled; quantity mutation may resume`,
              )
            }
          } else {
            member.aggregateProtectionMutationSettledAt = undefined
          }
        }
        member.updatedAt = Date.now()
        await savePosition(member)
        result.changedPositions++
      }
      continue
    }

    // Each row keeps its own exact quantity and desired trigger pair.
    let rowClosed = false
    for (const member of members) {
      await mutationGuard?.()
      const row = await updateProtectionOrders(
        connector,
        member,
        "row_exact_guard",
        liveOrderIds,
        { allowPendingAccumulation: true },
      )
      if (row.slPlaced || row.tpPlaced) result.rearmedLeaders++
      if (member.status === "closed" || Number(member.executedQuantity || 0) <= 0) rowClosed = true
      if (row.changed) {
        member.updatedAt = Date.now()
        await savePosition(member)
        result.changedPositions++
      }
    }
    if (rowClosed) continue

    const leader = positionsById.get(plan.leaderId)
    if (!leader) continue
    let securityHandoffBlocked = false
    for (const member of members) {
      if (member.id === leader.id) continue
      await mutationGuard?.()
      await settleSlotControlsWithoutGuess(
        connector,
        member,
        false,
        liveOrderIds,
        "AggregateHandoff",
      )
      if (await demoteAggregateProtectionMember(connector, member, plan, undefined, liveOrderIds)) {
        result.changedPositions++
      }
      if (member.securityStopOrderId || member.pendingProtectionOrders?.securityStop?.clientOrderId) {
        securityHandoffBlocked = true
      }
    }
    if (securityHandoffBlocked) {
      leader.securityStopRequired = securitySupported
      leader.securityStopStatus = "pending"
      leader.updatedAt = Date.now()
      refreshControlOrderSetCoverage(leader)
      await savePosition(leader)
      result.changedPositions++
      continue
    }
    leader.aggregateProtectionOwner = true
    leader.aggregateProtectionKey = plan.key
    leader.aggregateProtectionMemberCount = plan.memberIds.length
    leader.aggregateProtectionQuantity = plan.venueQuantity
    leader.securityStopRequired = securitySupported

    if (!securitySupported) {
      await cancelSlotOwnedControls(connector, leader, false, "SecurityUnsupported")
      leader.securityStopStatus = "unsupported"
    } else if (!(plan.securityStopPrice > 0)) {
      await cancelSlotOwnedControls(connector, leader, false, "SecurityInvalidRange")
      leader.securityStopStatus = "invalid_range"
    } else {
      const pending = leader.pendingProtectionOrders?.securityStop
      let pendingBlocksPlacement = securityLivenessUnresolved
        && existingSecurityOwner?.id === leader.id
      if (pendingBlocksPlacement) leader.securityStopStatus = "pending"
      if (pending?.clientOrderId) {
        const recovered = await recoverEntryOrderByClientId(connector, leader.symbol, pending.clientOrderId)
        const recoveredId = firstNonEmptyIdentifier(recovered?.orderId, recovered?.id)
        if (recoveredId) {
          const recoveredQuantity = controlOrderRequestedQuantity(recovered, 0)
          leader.securityStopOrderId = recoveredId
          leader.securityStopPrice = pending.triggerPrice
          leader.securityStopArmedQuantity = recoveredQuantity
          leader.securityStopLastArmedAt = Date.now()
          leader.securityStopStatus = securityStopQuantityDrifted(
            recoveredQuantity,
            plan.venueQuantity,
            plan.quantityTolerance,
          ) ? "quantity_mismatch" : "armed"
          delete leader.pendingProtectionOrders?.securityStop
        } else if (liveOrderIds === null || liveOrderIds.has(pending.clientOrderId)) {
          pendingBlocksPlacement = true
          leader.securityStopStatus = "pending"
        } else {
          pending.absenceConfirmations = Number(pending.absenceConfirmations || 0) + 1
          if (pending.absenceConfirmations < 2) {
            pendingBlocksPlacement = true
            leader.securityStopStatus = "pending"
          } else {
            delete leader.pendingProtectionOrders?.securityStop
          }
        }
      }

      const securityPriceNeedsRearm = securityStopPriceDrifted(
        leader.securityStopPrice,
        plan.securityStopPrice,
        Number(leader.priceTick || 0),
      )
      const securityQuantityNeedsRearm = securityStopQuantityDrifted(
        leader.securityStopArmedQuantity,
        plan.venueQuantity,
        plan.quantityTolerance,
      )
      if (
        leader.securityStopOrderId
        && !pendingBlocksPlacement
        && (securityPriceNeedsRearm || securityQuantityNeedsRearm)
      ) {
        if (!securityStopPriceRearmDeferred(
          leader,
          securityPriceNeedsRearm,
          securityQuantityNeedsRearm,
        )) {
          await mutationGuard?.()
          const cancelled = await cancelProtectionOrder(
            connector,
            leader.symbol,
            leader.securityStopOrderId,
            "SecurityRearm",
            leader.connectionId,
          )
          if (cancelled) {
            leader.securityStopOrderId = undefined
            leader.securityStopPrice = 0
            leader.securityStopArmedQuantity = 0
            leader.securityStopLastArmedAt = undefined
          } else {
            pendingBlocksPlacement = true
            leader.securityStopStatus = "pending"
          }
        }
      }

      if (!leader.securityStopOrderId && !pendingBlocksPlacement) {
        const capacityBudget = protectionCapacityBudgetOf(liveOrderIds)
        const reservationId = `${leader.connectionId}:${leader.id}:security_stop`
        const capacityAllowed = !capacityBudget || capacityBudget.reserve(reservationId)
        if (!capacityAllowed) {
          leader.securityStopStatus = "capacity_blocked"
          leader.controlOrderCapacity = capacityBudget?.snapshot()
        } else {
          await mutationGuard?.()
          const clientOrderId = await prepareProtectionSubmission(
            leader,
            "securityStop",
            plan.securityStopPrice,
            plan.venueQuantity,
          )
          const placement = await placeProtectionOrder(
            connector,
            leader.symbol,
            plan.direction === "long" ? "sell" : "buy",
            plan.venueQuantity,
            plan.securityStopPrice,
            "SecurityStop",
            plan.direction,
            clientOrderId,
          )
          if (placement.orderId && !["PRICE_CROSSED", "QUOTA_EXCEEDED", "position_exhausted"].includes(placement.orderId)) {
            leader.securityStopOrderId = placement.orderId
            leader.securityStopPrice = plan.securityStopPrice
            leader.securityStopArmedQuantity = placement.armedQuantity
            leader.securityStopLastArmedAt = Date.now()
            leader.securityStopAbsenceConfirmations = 0
            leader.securityStopStatus = securityStopQuantityDrifted(
              placement.armedQuantity,
              plan.venueQuantity,
              plan.quantityTolerance,
            ) ? "quantity_mismatch" : "armed"
            delete leader.pendingProtectionOrders?.securityStop
            result.rearmedLeaders++
          } else if (placement.orderId === "QUOTA_EXCEEDED") {
            leader.securityStopStatus = "capacity_blocked"
            delete leader.pendingProtectionOrders?.securityStop
            capacityBudget?.markExhausted()
          } else if (placement.orderId === "PRICE_CROSSED") {
            leader.securityStopStatus = "system_close"
            delete leader.pendingProtectionOrders?.securityStop
            for (const member of members) {
              await mutationGuard?.()
              await closeLivePosition(
                connectionId,
                member.id,
                venueBySlot.get(plan.key)?.markPrice || 0,
                connector,
                "security_stop_price_crossed",
              )
            }
          } else {
            leader.securityStopStatus = "pending"
          }
          if (capacityBudget) leader.controlOrderCapacity = capacityBudget.snapshot()
        }
      } else if (leader.securityStopOrderId && !pendingBlocksPlacement) {
        leader.securityStopStatus = securityStopQuantityDrifted(
          leader.securityStopArmedQuantity,
          plan.venueQuantity,
          plan.quantityTolerance,
        ) ? "quantity_mismatch" : "armed"
      } else if (pendingBlocksPlacement) {
        leader.securityStopStatus = "pending"
      }
    }

    refreshControlOrderSetCoverage(leader, {
      leaderId: leader.id,
      ...(leader.securityStopOrderId ? { securityStopOrderId: leader.securityStopOrderId } : {}),
      ...(Number(leader.securityStopPrice || 0) > 0 ? { securityStopPrice: Number(leader.securityStopPrice) } : {}),
      securityStopRequired: leader.securityStopRequired,
      securityStopStatus: leader.securityStopStatus,
    })
    leader.updatedAt = Date.now()
    await savePosition(leader)
    result.changedPositions++

    for (const member of members) {
      if (member.id === leader.id) continue
      if (!projectAggregateMemberCoverage(member, leader, plan)) continue
      member.updatedAt = Date.now()
      pushStep(
        member,
        "aggregate_security_coverage",
        leader.securityStopStatus === "armed",
        `${plan.key} security=${leader.securityStopOrderId || leader.securityStopStatus || "missing"} owner=${leader.id}; row SL/TP remain independent`,
      )
      await savePosition(member)
      result.changedPositions++
    }
  }
  return result
}

type SanitizedProtectionSlotOrderAudit = Omit<
  ProtectionSlotOrderAudit,
  "orphanOrders" | "expectedOrderIds"
> & {
  orphanOrderCount: number
}

export interface LiveProtectionSlotReconciliationReport {
  schemaVersion: 1
  connectionId: string
  symbol: string
  direction: ProtectionSlotDirection
  environment: string
  dryRun: boolean
  localRows: number
  localQuantity: number
  venueQuantity: number
  quantityTolerance: number
  ownershipMatches: boolean
  before: SanitizedProtectionSlotOrderAudit
  actions: {
    aggregateChangedPositions: number
    aggregateRearmedOrders: number
    aggregateOwnershipMismatches: number
    orphanCancelAttempts: number
    orphanCancelsSucceeded: number
    blockedReason: string | null
  }
  after: SanitizedProtectionSlotOrderAudit | null
  success: boolean
}

export interface LiveProtectionSlotReconciliationRequest {
  symbol: string
  direction: ProtectionSlotDirection
  apply?: boolean
  expectedEnvironment?: "prod-vst" | "prod-live"
  maxOrphanCancellations?: number
  /** Host-level guard, used by the X02 operator to recheck inactive units. */
  assertMutationAllowed?: () => void | Promise<void>
}

function sanitizeProtectionSlotAudit(audit: ProtectionSlotOrderAudit): SanitizedProtectionSlotOrderAudit {
  return {
    expectedComplete: audit.expectedComplete,
    complete: audit.complete,
    rowCount: audit.rowCount,
    expectedControlOrderCount: audit.expectedControlOrderCount,
    observedExpectedControlOrderCount: audit.observedExpectedControlOrderCount,
    exactStopLossOrders: audit.exactStopLossOrders,
    exactTakeProfitOrders: audit.exactTakeProfitOrders,
    exactSecurityOrders: audit.exactSecurityOrders,
    connectionOwnedSlotControlOrders: audit.connectionOwnedSlotControlOrders,
    externalOrUnknownSlotControlOrdersPreserved: audit.externalOrUnknownSlotControlOrdersPreserved,
    orphanOrderCount: audit.orphanOrders.length,
    violations: [...audit.violations],
  }
}

function exactProtectionSlotRows(
  positions: readonly LivePosition[],
  connectionId: string,
  symbol: string,
  direction: ProtectionSlotDirection,
): LivePosition[] {
  const normalizedSymbol = normalizeProtectionSlotSymbol(symbol)
  return positions.filter((position) =>
    isSystemTrackedLivePosition(position, connectionId)
    && String(position.status || "").toLowerCase() !== "simulated"
    && normalizeProtectionSlotSymbol(position.symbol) === normalizedSymbol
    && resolveLivePositionDirection(position) === direction,
  )
}

function exactProtectionVenueRows(
  positions: readonly Record<string, any>[],
  symbol: string,
  direction: ProtectionSlotDirection,
): Record<string, any>[] {
  const normalizedSymbol = normalizeProtectionSlotSymbol(symbol)
  return positions.filter((position) => {
    const rawQuantity = Number(
      position?.size
      ?? position?.positionAmt
      ?? position?.quantity
      ?? position?.contracts
      ?? position?.positionSize
      ?? position?.lots
      ?? position?.volume
      ?? 0,
    )
    return Math.abs(rawQuantity) > 0
      && normalizeProtectionSlotSymbol(position?.symbol) === normalizedSymbol
      && normalizeExchangePositionDirection(position?.positionSide, position?.side, rawQuantity) === direction
  })
}

function exactProtectionVenueQuantity(position: Record<string, any>): number {
  return Math.abs(Number(
    position?.size
    ?? position?.positionAmt
    ?? position?.quantity
    ?? position?.contracts
    ?? position?.positionSize
    ?? position?.lots
    ?? position?.volume
    ?? 0,
  ))
}

function buildExactProtectionSlotPlan(
  members: readonly LivePosition[],
  venuePosition: Record<string, any>,
): AggregateProtectionPlan | null {
  if (members.length === 0) return null
  const direction = resolveLivePositionDirection(members[0])
  if (!direction) return null
  const venueQuantity = exactProtectionVenueQuantity(venuePosition)
  const venueEntryPrice = Number(venuePosition?.entryPrice ?? venuePosition?.avgPrice ?? 0) || 0
  const venueLiquidationPrice = Number(venuePosition?.liquidationPrice ?? venuePosition?.liqPrice ?? 0) || 0
  const plans = buildAggregateProtectionPlans(
    members.map((position) => {
      const desired = computeDesiredProtectionPrices(position)
      const priceTick = Number(position.priceTick || 0)
      return {
        id: position.id,
        symbol: position.symbol,
        direction,
        quantity: Number(position.executedQuantity || 0),
        entryPrice: Number(position.averageExecutionPrice || position.entryPrice || venueEntryPrice || 0),
        liquidationPrice: Number(
          position.liquidationPrice
          || position.exchangeData?.liquidationPrice
          || venueLiquidationPrice
          || 0,
        ),
        priceTick,
        desiredStopLoss: normalizeProtectionTriggerPrice(
          desired.desiredSl,
          priceTick,
          direction,
          "stop_loss",
        ),
        desiredTakeProfit: normalizeProtectionTriggerPrice(
          desired.desiredTp,
          priceTick,
          direction,
          "take_profit",
        ),
        createdAt: Number(position.createdAt || 0),
        quantityStep: Number(position.quantityStep || 0),
        hasSecurityStopOrder: Boolean(position.securityStopOrderId),
        hasPendingSecurityStop: Boolean(position.pendingProtectionOrders?.securityStop),
      }
    }),
    [{
      symbol: String(venuePosition?.symbol || members[0].symbol),
      direction,
      quantity: venueQuantity,
    }],
  )
  return plans.length === 1 ? plans[0] : null
}

async function readAuthoritativeProtectionPositions(connector: any): Promise<Record<string, any>[]> {
  if (!connector || typeof connector.getPositions !== "function") {
    throw new Error("Exact-slot reconciliation requires a venue position snapshot")
  }
  const positions = await withTimeout(
    connector.getPositions() as Promise<any>,
    EXCHANGE_TIMEOUT_GET_POSITIONS_MS,
    "getPositions(exact-protection-slot)",
  )
  const status = typeof connector.getLastPositionsSnapshotStatus === "function"
    ? connector.getLastPositionsSnapshotStatus()
    : { ok: Array.isArray(positions) }
  if (!Array.isArray(positions) || status?.ok !== true) {
    throw new Error("Exact-slot reconciliation requires an authoritative venue position snapshot")
  }
  return positions
}

async function readAuthoritativeProtectionOrders(
  connector: any,
  symbol?: string,
): Promise<Record<string, any>[]> {
  if (!connector || typeof connector.getOpenOrders !== "function") {
    throw new Error("Exact-slot reconciliation requires a venue open-order snapshot")
  }
  const orders = await withTimeout(
    connector.getOpenOrders(symbol, { forceRefresh: true }) as Promise<any>,
    25_000,
    "getOpenOrders(exact-protection-slot)",
  )
  const status = typeof connector.getLastOpenOrdersSnapshotStatus === "function"
    ? connector.getLastOpenOrdersSnapshotStatus()
    : { ok: Array.isArray(orders) }
  if (!Array.isArray(orders) || status?.ok !== true) {
    throw new Error("Exact-slot reconciliation requires an authoritative venue open-order snapshot")
  }
  return orders
}

function protectionSlotMemberIds(members: readonly LivePosition[]): string[] {
  return members.map((member) => member.id).sort()
}

function protectionSlotExpectedOrderIds(members: readonly LivePosition[]): Set<string> {
  return new Set(members.flatMap((member) => [
    member.stopLossOrderId,
    member.takeProfitOrderId,
    member.securityStopOrderId,
  ].map((value) => String(value || "").trim()).filter(Boolean)))
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

function assertStableProtectionSlotRows(
  before: readonly LivePosition[],
  after: readonly LivePosition[],
  quantityTolerance: number,
): void {
  if (protectionSlotMemberIds(before).join("|") !== protectionSlotMemberIds(after).join("|")) {
    throw new Error("Exact-slot membership changed during reconciliation")
  }
  const beforeQuantity = before.reduce((sum, member) => sum + Number(member.executedQuantity || 0), 0)
  const afterQuantity = after.reduce((sum, member) => sum + Number(member.executedQuantity || 0), 0)
  if (Math.abs(beforeQuantity - afterQuantity) > quantityTolerance) {
    throw new Error("Exact-slot local quantity changed during reconciliation")
  }
}

function assertEligibleProtectionSlotRows(members: readonly LivePosition[]): void {
  const activeStatuses = new Set(["open", "filled", "partially_filled"])
  if (members.length === 0) throw new Error("No CTS-owned live rows exist for the exact slot")
  for (const member of members) {
    if (!activeStatuses.has(String(member.status || "").toLowerCase())) {
      throw new Error("Exact-slot reconciliation blocked by a non-active local lifecycle row")
    }
    if (!(Number(member.executedQuantity || 0) > 0)) {
      throw new Error("Exact-slot reconciliation blocked by a non-positive local row quantity")
    }
    if (
      member.pendingSystemAction
      || member.pendingQuantityMutation
      || member.pendingReduction
      || member.pendingAccumulation
      || Number(member.aggregateProtectionMutationRequestedAt || 0) > 0
    ) {
      throw new Error("Exact-slot reconciliation blocked by an in-flight quantity mutation")
    }
  }
}

interface EntryProtectionAdmissionDecision {
  safe: boolean
  violations: string[]
  audit: LiveEntryProtectionAdmissionAudit
  observedControlOrders: number
  availableControlOrders: number
}

interface EntryProtectionAdmissionLease {
  key: string
  token: string
  release: () => Promise<void>
}

function entryProtectionAdmissionLockKeyOf(connectionId: string): string {
  return `live:entry-protection-admission:${connectionId}`
}

function entryProtectionHaltKeyOf(connectionId: string): string {
  return `live:entry-protection-halt:${connectionId}`
}

/**
 * Serialize every risk-increasing quantity mutation with fresh entries. The
 * lease is connection-wide because venue TP/SL capacity and physical hedge
 * slots are account resources, not independent per-position resources.
 */
async function acquireEntryProtectionAdmissionLease(
  connectionId: string,
  purpose: string,
  waitMs: number = ENTRY_PROTECTION_ADMISSION_WAIT_MS,
): Promise<EntryProtectionAdmissionLease | null> {
  const client = getRedisClient() as any
  const key = entryProtectionAdmissionLockKeyOf(connectionId)
  const token = `${purpose}:${process.pid}:${Date.now()}:${nanoid(10)}`
  const deadline = Date.now() + Math.max(0, waitMs)
  do {
    const acquired = await client.set(
      key,
      token,
      { NX: true, PX: ENTRY_PROTECTION_ADMISSION_LOCK_TTL_MS } as any,
    ).catch(() => null)
    if (acquired === "OK" || acquired === true) {
      const stopLease = startRedisLockLeaseRefresh(
        client,
        key,
        token,
        ENTRY_PROTECTION_ADMISSION_LOCK_TTL_MS,
      )
      let released = false
      return {
        key,
        token,
        release: async () => {
          if (released) return
          released = true
          stopLease()
          await evalLockLua(client, RELEASE_LOCK_LUA, key, [token]).catch(() => 0)
        },
      }
    }
    if (Date.now() >= deadline) break
    await new Promise<void>((resolve) => setTimeout(resolve, 75))
  } while (Date.now() < deadline)
  return null
}

/**
 * One authoritative, connection-wide gate immediately before any venue
 * mutation. Independent Set evaluation remains untouched; execution is
 * admitted only when every already-open CTS row has its own exact SL/TP,
 * every net symbol/direction slot has one exact full-quantity security stop,
 * and the venue position quantity is fully explained by exact CTS ownership.
 * Foreign orders are never adopted or cancelled.
 */
async function auditEntryProtectionBeforeVenueMutation(input: {
  connectionId: string
  candidateId?: string
  symbol: string
  direction: ProtectionSlotDirection
  connector: any
  requireCapacity?: boolean
}): Promise<EntryProtectionAdmissionDecision> {
  const [positions, venuePositions, openOrders] = await Promise.all([
    getLivePositions(input.connectionId),
    readAuthoritativeProtectionPositions(input.connector),
    readAuthoritativeProtectionOrders(input.connector),
  ])
  const liveOrderIds = new Set<string>()
  for (const order of openOrders) {
    for (const identifier of protectionOrderIdentifiers(order)) {
      if (identifier) liveOrderIds.add(identifier)
    }
  }

  const audit = auditLiveEntryProtectionAdmission({
    connectionId: input.connectionId,
    candidateId: input.candidateId,
    symbol: input.symbol,
    direction: input.direction,
    positions,
    venuePositions,
    liveOrderIds,
  })
  const violations = [...audit.violations]
  const activeOwnedRows = positions.filter((position) =>
    String(position.id || "") !== String(input.candidateId || "")
    && isExchangeLifecyclePosition(position, input.connectionId)
    && Number(position.executedQuantity || 0) > 0,
  )
  const slots = new Map<string, LivePosition[]>()
  for (const position of activeOwnedRows) {
    const direction = resolveLivePositionDirection(position)
    if (!direction) {
      violations.push("owned_row_direction_missing")
      continue
    }
    const key = aggregateProtectionSlot(position.symbol, direction)
    const members = slots.get(key) || []
    members.push(position)
    slots.set(key, members)
  }

  for (const members of slots.values()) {
    const direction = resolveLivePositionDirection(members[0])
    if (!direction) {
      violations.push("owned_slot_direction_missing")
      continue
    }
    const venueRows = exactProtectionVenueRows(
      venuePositions,
      members[0].symbol,
      direction,
    )
    if (venueRows.length !== 1) {
      violations.push("owned_slot_venue_cardinality_mismatch")
      continue
    }
    const plan = buildExactProtectionSlotPlan(members, venueRows[0])
    if (!plan || !plan.ownershipMatches || !(plan.securityStopPrice > 0)) {
      violations.push("owned_slot_aggregate_plan_invalid")
      continue
    }
    const slotAudit = auditProtectionSlotOrders({
      connectionId: input.connectionId,
      symbol: members[0].symbol,
      direction,
      members,
      plan,
      openOrders,
    })
    if (!slotAudit.complete) {
      violations.push("owned_slot_controls_incomplete")
      violations.push(...slotAudit.violations.map((violation) => `owned_slot_${violation}`))
      if (slotAudit.orphanOrders.length > 0) violations.push("owned_slot_orphan_controls_present")
    }
    if (slotAudit.externalOrUnknownSlotControlOrdersPreserved > 0) {
      violations.push("owned_slot_external_controls_present")
    }
  }

  if (
    !audit.physicalSlotAlreadyExists
    && openOrders.some((order) => isProtectionControlOrderForSlot(
      order,
      input.symbol,
      input.direction,
    ))
  ) {
    violations.push("candidate_slot_open_controls_present")
  }

  const observedControlOrders = isBingXCapacityConnector(input.connector)
    ? countUniqueBingXControlOrders(openOrders)
    : 0
  const availableControlOrders = isBingXCapacityConnector(input.connector)
    ? Math.max(0, BINGX_CONTROL_ORDER_LIMIT - observedControlOrders)
    : Number.MAX_SAFE_INTEGER
  if (
    input.requireCapacity !== false
    && availableControlOrders < audit.requiredNewControlOrders
  ) {
    violations.push("control_order_capacity_reserve_insufficient")
  }

  return {
    safe: violations.length === 0,
    violations: [...new Set(violations)],
    audit,
    observedControlOrders,
    availableControlOrders,
  }
}

/**
 * Persist the connection-wide exposure halt whenever an authoritative audit
 * cannot prove the complete row-TP/SL + slot-security contract. A later
 * recovery cycle may clear the halt only by producing a fully clean audit;
 * elapsed time or a process restart is never treated as proof of safety.
 */
async function verifyConnectionProtectionAndPersistHalt(input: {
  connectionId: string
  symbol: string
  direction: ProtectionSlotDirection
  connector: any
  reason: string
}): Promise<EntryProtectionAdmissionDecision> {
  const client = getRedisClient() as any
  let decision: EntryProtectionAdmissionDecision
  try {
    decision = await auditEntryProtectionBeforeVenueMutation({
      connectionId: input.connectionId,
      symbol: input.symbol,
      direction: input.direction,
      connector: input.connector,
      requireCapacity: false,
    })
  } catch (error) {
    decision = {
      safe: false,
      violations: ["authoritative_protection_snapshot_unavailable"],
      audit: {
        safe: false,
        violations: ["authoritative_protection_snapshot_unavailable"],
        ownedActiveRows: 0,
        ownedExecutedRows: 0,
        physicalSlotRows: 0,
        systemSlotQuantity: 0,
        venueSlotQuantity: 0,
        physicalSlotAlreadyExists: false,
        requiredNewControlOrders: 0,
      },
      observedControlOrders: 0,
      availableControlOrders: 0,
    }
    console.warn(
      `${LOG_PREFIX} ${input.reason} protection verification failed: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const haltKey = entryProtectionHaltKeyOf(input.connectionId)
  if (decision.safe) {
    await client.del(haltKey).catch(() => 0)
  } else {
    await client.setex(
      haltKey,
      24 * 60 * 60,
      JSON.stringify({
        at: Date.now(),
        reason: input.reason,
        violations: decision.violations.slice(0, 24),
      }),
    ).catch(() => {})
  }
  return decision
}

/**
 * Reconcile one CTS-owned physical symbol/direction slot only. The caller must
 * keep the runtime in maintenance. Account-wide rows and every foreign order
 * are excluded before the aggregate coordinator runs; orphan cancellation is
 * allowed only after all expected row SL/TP pairs and the one full-slot
 * security stop are authoritatively open.
 */
export async function reconcileLiveProtectionSlot(
  connectionId: string,
  connector: any,
  request: LiveProtectionSlotReconciliationRequest,
): Promise<LiveProtectionSlotReconciliationReport> {
  const symbol = normalizeProtectionSlotSymbol(request.symbol)
  const direction = request.direction
  const apply = request.apply === true
  if (!connectionId || !symbol || !["long", "short"].includes(direction)) {
    throw new Error("Exact-slot reconciliation requires connection, symbol, and long/short direction")
  }
  const environment = bingXEnvironmentInfo(connector)?.environment || "unknown"
  if (request.expectedEnvironment && environment !== request.expectedEnvironment) {
    throw new Error(`Exact-slot reconciliation expected ${request.expectedEnvironment}, received ${environment}`)
  }

  await initRedis()
  const client = getRedisClient() as any
  const lockKey = `live_sync_lock:${connectionId}`
  const lockToken = `slot-reconcile:${process.pid}:${Date.now()}:${nanoid(12)}`
  const lockTtlMs = 180_000
  const acquired = await client.set(lockKey, lockToken, { NX: true, PX: lockTtlMs } as any)
  if (acquired !== "OK" && acquired !== true) {
    throw new Error("Exact-slot reconciliation blocked because the live-sync lock is busy")
  }
  const stopLockRefresh = startRedisLockLeaseRefresh(client, lockKey, lockToken, lockTtlMs)

  const assertMutationAllowed = async (): Promise<void> => {
    const maintenance = getRuntimeMaintenanceState()
    if (maintenance.reason !== "marker_present") {
      throw new Error("Exact-slot reconciliation requires the runtime maintenance marker")
    }
    await request.assertMutationAllowed?.()
    const currentToken = await client.get(lockKey)
    if (String(currentToken || "") !== lockToken) {
      throw new Error("Exact-slot reconciliation lost its live-sync lock")
    }
  }

  try {
    await assertMutationAllowed()
    const allPositions = await getLivePositions(connectionId)
    const slotRows = exactProtectionSlotRows(allPositions, connectionId, symbol, direction)
    assertEligibleProtectionSlotRows(slotRows)
    for (const member of slotRows) {
      if (await client.get(positionMutationLockKey(connectionId, member.id))) {
        throw new Error("Exact-slot reconciliation blocked by a live-position mutation lock")
      }
    }

    const venuePositions = await readAuthoritativeProtectionPositions(connector)
    const slotVenuePositions = exactProtectionVenueRows(venuePositions, symbol, direction)
    if (slotVenuePositions.length !== 1) {
      throw new Error("Exact-slot reconciliation requires exactly one authoritative venue slot")
    }
    const venuePosition = slotVenuePositions[0]
    const venueQuantity = exactProtectionVenueQuantity(venuePosition)
    const localQuantity = slotRows.reduce((sum, member) => sum + Number(member.executedQuantity || 0), 0)
    const quantityTolerance = Math.max(
      1e-10,
      venueQuantity * 1e-8,
      ...slotRows.map((member) => Number(member.quantityStep || 0) / 2),
    )
    const ownershipMatches = venueQuantity > 0
      && Math.abs(localQuantity - venueQuantity) <= quantityTolerance
    if (!ownershipMatches) {
      throw new Error("Exact-slot reconciliation refused ambiguous local/venue quantity ownership")
    }

    const liveOrderIds = await fetchLiveOrderIdSet(connector)
    if (liveOrderIds === null) {
      throw new Error("Exact-slot reconciliation requires authoritative venue order identifiers")
    }
    const openOrders = await readAuthoritativeProtectionOrders(connector)
    const beforePlan = buildExactProtectionSlotPlan(slotRows, venuePosition)
    if (!beforePlan || !beforePlan.ownershipMatches) {
      throw new Error("Exact-slot reconciliation could not build an owned aggregate plan")
    }
    const beforeAudit = auditProtectionSlotOrders({
      connectionId,
      symbol,
      direction,
      members: slotRows,
      plan: beforePlan,
      openOrders,
    })
    const report: LiveProtectionSlotReconciliationReport = {
      schemaVersion: 1,
      connectionId,
      symbol,
      direction,
      environment,
      dryRun: !apply,
      localRows: slotRows.length,
      localQuantity,
      venueQuantity,
      quantityTolerance,
      ownershipMatches,
      before: sanitizeProtectionSlotAudit(beforeAudit),
      actions: {
        aggregateChangedPositions: 0,
        aggregateRearmedOrders: 0,
        aggregateOwnershipMismatches: 0,
        orphanCancelAttempts: 0,
        orphanCancelsSucceeded: 0,
        blockedReason: null,
      },
      after: null,
      success: beforeAudit.complete,
    }
    if (!apply) return report

    await assertMutationAllowed()
    const aggregateResult = await reconcileAggregateProtectionBook(
      connectionId,
      connector,
      slotRows,
      slotVenuePositions,
      liveOrderIds,
      assertMutationAllowed,
    )
    report.actions.aggregateChangedPositions = aggregateResult.changedPositions
    report.actions.aggregateRearmedOrders = aggregateResult.rearmedLeaders
    report.actions.aggregateOwnershipMismatches = aggregateResult.ownershipMismatches

    const afterAggregateRows = exactProtectionSlotRows(
      await getLivePositions(connectionId),
      connectionId,
      symbol,
      direction,
    )
    assertEligibleProtectionSlotRows(afterAggregateRows)
    assertStableProtectionSlotRows(slotRows, afterAggregateRows, quantityTolerance)
    const afterAggregateVenueRows = exactProtectionVenueRows(
      await readAuthoritativeProtectionPositions(connector),
      symbol,
      direction,
    )
    if (afterAggregateVenueRows.length !== 1) {
      throw new Error("Exact venue slot changed during aggregate reconciliation")
    }
    const afterAggregateVenueQuantity = exactProtectionVenueQuantity(afterAggregateVenueRows[0])
    if (Math.abs(afterAggregateVenueQuantity - venueQuantity) > quantityTolerance) {
      throw new Error("Exact venue quantity changed during aggregate reconciliation")
    }
    const afterAggregatePlan = buildExactProtectionSlotPlan(
      afterAggregateRows,
      afterAggregateVenueRows[0],
    )
    if (
      !afterAggregatePlan
      || !afterAggregatePlan.ownershipMatches
      || !(afterAggregatePlan.securityStopPrice > 0)
    ) {
      throw new Error("Exact-slot aggregate security plan is not safely armable")
    }
    const afterAggregateOrders = await readAuthoritativeProtectionOrders(connector, symbol)
    let afterAudit = auditProtectionSlotOrders({
      connectionId,
      symbol,
      direction,
      members: afterAggregateRows,
      plan: afterAggregatePlan,
      openOrders: afterAggregateOrders,
    })
    report.after = sanitizeProtectionSlotAudit(afterAudit)
    if (!afterAudit.expectedComplete) {
      report.actions.blockedReason = "expected_controls_incomplete"
      report.success = false
      return report
    }

    const maxOrphanCancellations = Math.max(
      0,
      Math.min(8, Math.floor(Number(request.maxOrphanCancellations ?? 4))),
    )
    if (afterAudit.orphanOrders.length > maxOrphanCancellations) {
      report.actions.blockedReason = "orphan_limit_exceeded"
      report.success = false
      return report
    }

    if (afterAudit.orphanOrders.length > 0) {
      await assertMutationAllowed()
      const cleanupRows = exactProtectionSlotRows(
        await getLivePositions(connectionId),
        connectionId,
        symbol,
        direction,
      )
      assertStableProtectionSlotRows(afterAggregateRows, cleanupRows, quantityTolerance)
      if (!sameStringSet(
        afterAudit.expectedOrderIds,
        protectionSlotExpectedOrderIds(cleanupRows),
      )) {
        throw new Error("Exact-slot expected control ownership changed before orphan cleanup")
      }
      const cleanupVenueRows = exactProtectionVenueRows(
        await readAuthoritativeProtectionPositions(connector),
        symbol,
        direction,
      )
      if (
        cleanupVenueRows.length !== 1
        || Math.abs(exactProtectionVenueQuantity(cleanupVenueRows[0]) - venueQuantity) > quantityTolerance
      ) {
        throw new Error("Exact venue ownership changed before orphan cleanup")
      }

      // The symbol-scoped snapshot uses a separate connector cache key and is
      // therefore a fresh race check after the aggregate placement snapshot.
      const cleanupOrders = await readAuthoritativeProtectionOrders(connector, symbol)
      afterAudit = auditProtectionSlotOrders({
        connectionId,
        symbol,
        direction,
        members: cleanupRows,
        plan: afterAggregatePlan,
        openOrders: cleanupOrders,
      })
      if (!afterAudit.expectedComplete || afterAudit.orphanOrders.length > maxOrphanCancellations) {
        throw new Error("Exact-slot control ownership changed before orphan cleanup")
      }

      for (const orphan of afterAudit.orphanOrders) {
        await assertMutationAllowed()
        if (
          !isConnectionOwnedProtectionOrderForSlot(
            orphan.order,
            connectionId,
            symbol,
            direction,
          )
          || protectionOrderVenueId(orphan.order) !== orphan.orderId
          || [...protectionOrderIdentifiers(orphan.order)].some((id) => afterAudit.expectedOrderIds.has(id))
        ) {
          throw new Error("Orphan cancellation allow-list changed during exact-slot cleanup")
        }
        report.actions.orphanCancelAttempts++
        if (await cancelProtectionOrder(
          connector,
          symbol,
          orphan.orderId,
          "ExactSlotOrphan",
          connectionId,
        )) {
          report.actions.orphanCancelsSucceeded++
        }
      }
    }

    await assertMutationAllowed()
    const finalRows = exactProtectionSlotRows(
      await getLivePositions(connectionId),
      connectionId,
      symbol,
      direction,
    )
    assertStableProtectionSlotRows(afterAggregateRows, finalRows, quantityTolerance)
    const finalVenueRows = exactProtectionVenueRows(
      await readAuthoritativeProtectionPositions(connector),
      symbol,
      direction,
    )
    if (
      finalVenueRows.length !== 1
      || Math.abs(exactProtectionVenueQuantity(finalVenueRows[0]) - venueQuantity) > quantityTolerance
    ) {
      throw new Error("Exact venue ownership changed during final protection audit")
    }
    const finalPlan = buildExactProtectionSlotPlan(finalRows, finalVenueRows[0])
    if (!finalPlan || !finalPlan.ownershipMatches || !(finalPlan.securityStopPrice > 0)) {
      throw new Error("Final exact-slot security plan is invalid")
    }
    const finalAudit = auditProtectionSlotOrders({
      connectionId,
      symbol,
      direction,
      members: finalRows,
      plan: finalPlan,
      openOrders: await readAuthoritativeProtectionOrders(connector, symbol),
    })
    report.after = sanitizeProtectionSlotAudit(finalAudit)
    report.success = finalAudit.complete
    if (!report.success && !report.actions.blockedReason) {
      report.actions.blockedReason = "final_control_audit_failed"
    }
    return report
  } finally {
    stopLockRefresh()
    await evalLockLua(client, RELEASE_LOCK_LUA, lockKey, [lockToken]).catch(() => 0)
  }
}

function aggregateProtectionPhysicalMutationIsInFlight(position: LivePosition): boolean {
  const status = String(position.status || "").toLowerCase()
  return (
    status === "closing" ||
    status === "closing_partial" ||
    Boolean(position.pendingSystemAction) ||
    Boolean(position.pendingQuantityMutation) ||
    Boolean(position.pendingReduction) ||
    Boolean(position.pendingAccumulation)
  )
}

function aggregateProtectionMutationIsInFlight(position: LivePosition): boolean {
  return Number(position.aggregateProtectionMutationRequestedAt || 0) > 0
    || aggregateProtectionPhysicalMutationIsInFlight(position)
}

function aggregateProtectionMutationIsAbandoned(
  position: LivePosition,
  now = Date.now(),
): boolean {
  const requestedAt = Number(position.aggregateProtectionMutationRequestedAt || 0)
  const settledAt = Number(position.aggregateProtectionMutationSettledAt || 0)
  return requestedAt > 0
    && settledAt > 0
    && now - settledAt >= AGGREGATE_PROTECTION_MUTATION_ABANDONED_MS
    && !aggregateProtectionPhysicalMutationIsInFlight(position)
}

type AggregateProtectionFinalizationResult = {
  completedSlots: Set<string>
  deferredSlots: Set<string>
  rearmedLeaders: number
  changedPositions: number
}

/**
 * Finish a quantity-mutation hand-off before the current sync owner returns.
 *
 * The first aggregate pass deliberately settles every CTS-owned row/security
 * control so a reduce/accumulate/close cannot race stale-size protection.
 * This second, bounded pass sees the post-mutation venue quantity and re-arms
 * the exact same physical slot as soon as the mutating action is settled. It is
 * scoped to queued hand-offs, so normal hot-path syncs pay no extra exchange
 * round trip.
 */
async function finalizeQueuedAggregateProtection(
  connectionId: string,
  connector: any,
  requestedSlots: Iterable<string>,
): Promise<AggregateProtectionFinalizationResult> {
  const result: AggregateProtectionFinalizationResult = {
    completedSlots: new Set<string>(),
    deferredSlots: new Set<string>(),
    rearmedLeaders: 0,
    changedPositions: 0,
  }
  const slots = new Set(Array.from(requestedSlots).filter(Boolean))
  if (slots.size === 0 || !connector || typeof connector.getPositions !== "function") return result

  let allPositions: LivePosition[] = []
  try {
    allPositions = await getLivePositions(connectionId)
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} aggregate finalization could not load positions for ${connectionId}:`,
      error instanceof Error ? error.message : String(error),
    )
    return result
  }

  const activeStatuses = new Set(["open", "filled", "partially_filled"])
  const membersBySlot = new Map<string, LivePosition[]>()
  for (const position of allPositions) {
    const direction = resolveLivePositionDirection(position)
    if (!direction || !activeStatuses.has(String(position.status || "").toLowerCase())) continue
    if (!isExchangeLifecyclePosition(position, connectionId)) continue
    const slot = aggregateProtectionSlot(position.symbol, direction)
    if (!slots.has(slot)) continue
    const members = membersBySlot.get(slot) ?? []
    members.push(position)
    membersBySlot.set(slot, members)
  }

  const eligible: LivePosition[] = []
  const eligibleSlots = new Set<string>()
  const now = Date.now()
  for (const slot of slots) {
    const members = membersBySlot.get(slot) ?? []
    if (members.length === 0) {
      // The physical slot is flat/terminal now. No row/security controls remain to arm.
      result.completedSlots.add(slot)
      continue
    }
    for (const member of members) {
      if (!aggregateProtectionMutationIsAbandoned(member, now)) continue
      member.aggregateProtectionMutationRequestedAt = undefined
      member.aggregateProtectionMutationSettledAt = undefined
      member.aggregateProtectionMutationReason = undefined
      member.updatedAt = now
      pushStep(
        member,
        "aggregate_protection_mutation_recovered",
        false,
        "settled quantity hand-off was not resumed within 60 seconds; restoring venue controls",
      )
      await savePosition(member)
      result.changedPositions++
    }
    if (members.some(aggregateProtectionMutationIsInFlight)) {
      result.deferredSlots.add(slot)
      continue
    }
    eligible.push(...members)
    eligibleSlots.add(slot)
  }
  if (eligible.length === 0) return result

  let exchangePositions: any[] = []
  try {
    const snapshot = await withTimeout(
      connector.getPositions() as Promise<any[]>,
      EXCHANGE_TIMEOUT_GET_POSITIONS_MS,
      "getPositions(aggregate-finalize)",
    )
    const snapshotStatus = typeof connector.getLastPositionsSnapshotStatus === "function"
      ? connector.getLastPositionsSnapshotStatus()
      : { ok: Array.isArray(snapshot) }
    if (snapshotStatus.ok !== true || !Array.isArray(snapshot)) {
      console.warn(`${LOG_PREFIX} aggregate finalization deferred: venue position snapshot is not authoritative`)
      for (const slot of eligibleSlots) result.deferredSlots.add(slot)
      return result
    }
    exchangePositions = snapshot
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} aggregate finalization getPositions failed:`,
      error instanceof Error ? error.message : String(error),
    )
    for (const slot of eligibleSlots) result.deferredSlots.add(slot)
    return result
  }

  // Bound the final liveness read tightly. If it is unavailable, the
  // aggregate book preserves durable IDs and retries on the next sync.
  const liveOrderIds = await fetchLiveOrderIdSet(connector, { timeoutMs: EXCHANGE_TIMEOUT_GET_ORDER_MS })

  for (const position of eligible) {
    if (!position.aggregateProtectionMutationRequestedAt && !position.aggregateProtectionMutationReason) continue
    position.aggregateProtectionMutationRequestedAt = undefined
    position.aggregateProtectionMutationSettledAt = undefined
    position.aggregateProtectionMutationReason = undefined
    position.updatedAt = Date.now()
    pushStep(
      position,
      "aggregate_protection_mutation_finalized",
      true,
      "quantity mutation settled; re-arming aggregate venue protection from a fresh snapshot",
    )
    await savePosition(position)
  }

  const applied = await reconcileAggregateProtectionBook(
    connectionId,
    connector,
    eligible,
    exchangePositions,
    liveOrderIds,
  )
  result.rearmedLeaders = applied.rearmedLeaders
  result.changedPositions = applied.changedPositions
  for (const slot of eligibleSlots) result.completedSlots.add(slot)
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
  exchangeConnector: any,
  shouldContinue?: () => boolean | Promise<boolean>,
): Promise<LivePosition> {
  const isCurrent = async (): Promise<boolean> => {
    try {
      return (await shouldContinue?.()) !== false
    } catch {
      return false
    }
  }
  await initRedis()
  const client = getRedisClient()
  const connectionTrackingId = makeConnectionTrackingId(connectionId)
  let realPosition = sourceRealPosition
  if (sourceRealPosition.setVariant === "block") {
    const blockCount = parseBlockCount(sourceRealPosition.setKey) ?? Math.floor(Number(sourceRealPosition.blockCount || 0))
    const blockVolumeRatio = Number(sourceRealPosition.blockVolumeRatio || 0)
    const blockIncrementSteps = normalizeBlockIncrementSteps(sourceRealPosition.blockIncrementSteps)
    if (blockCount > 0 && blockVolumeRatio > 0) {
      const blockCalculatedVolumeMultiplier = calculateBlockVolumeMultiplier(
        blockCount,
        blockVolumeRatio,
        blockIncrementSteps,
      )
      realPosition = {
        ...sourceRealPosition,
        blockCount,
        blockIncrementSteps,
        blockVolumeIncrementRatio: blockCalculatedVolumeMultiplier - 1,
        blockCalculatedVolumeMultiplier,
        sizeMultiplier: blockCalculatedVolumeMultiplier,
      }
    }
  }

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
      indicationType: realPosition.indicationType,
      signalRisk:     realPosition.signalRisk,
      setVariant:     realPosition.setVariant,
      executionLane:  liveExecutionLane(realPosition),
      axisWindows:    realPosition.axisWindows,
      sizeMultiplier: realPosition.sizeMultiplier,
      blockScope:     realPosition.blockScope,
      blockLaneKind:  realPosition.blockLaneKind,
      blockLaneKey:   realPosition.blockLaneKey,
      blockSourceId:  realPosition.blockSourceId,
      accumulatedSetKeys: initialLivePositionSetLineage(realPosition),
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
      indicationType: realPosition.indicationType,
      signalRisk:     realPosition.signalRisk,
      setVariant:     realPosition.setVariant,
      executionLane:  liveExecutionLane(realPosition),
      axisWindows:    realPosition.axisWindows,
      sizeMultiplier: realPosition.sizeMultiplier,
      blockScope:     realPosition.blockScope,
      blockLaneKind:  realPosition.blockLaneKind,
      blockLaneKey:   realPosition.blockLaneKey,
      blockSourceId:  realPosition.blockSourceId,
      accumulatedSetKeys: initialLivePositionSetLineage(realPosition),
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
  const initialAppSettings = (await getAppSettings().catch(() => null)) || {}
  const configuredPositionCostPct = Number(
    realPosition.positionCostPctOverride ??
    (initialConnectionSettings as any).positionCost ??
    (initialConnectionSettings as any).exchangePositionCost ??
    (initialConnectionSettings as any).exchange_position_cost ??
    (initialConnectionSettings as any).position_cost_percent ??
    (initialConnectionSettings as any).positionCostPercent ??
    initialAppSettings.positionCost ??
    initialAppSettings.exchangePositionCost ??
    initialAppSettings.exchange_position_cost ??
    initialAppSettings.position_cost_percent ??
    initialAppSettings.positionCostPercent ??
    0.1,
  )
  const positionCostPct =
    Number.isFinite(configuredPositionCostPct) && configuredPositionCostPct > 0
      ? configuredPositionCostPct
      : 0.1
  const marketType = normalizeMarketType(
    (initialConnectionSettings as any).market_type ?? (initialConnectionSettings as any).asset_class,
    (initialConnectionSettings as any).exchange,
  )
  const lotSize = marketType === "forex"
    ? Math.max(1, Number(
        (initialConnectionSettings as any).lot_size ??
        (initialConnectionSettings as any).lotSize,
      ) || DEFAULT_FOREX_LOT_SIZE)
    : undefined
  const mainModeEnabled = isConnectionLiveTradeEnabled(initialConnectionSettings)
  const presetModeEnabled = isConnectionPresetTradeEnabled(initialConnectionSettings)
  const isSignalPosition =
    String(realPosition.indicationType || "").trim().toLowerCase() === "signal" ||
    Boolean(realPosition.signalRisk?.sourceIds?.length)
  const isDirectPosition =
    String(realPosition.indicationType || "").trim().toLowerCase() === "direct-trade"
  const executionIntent: LiveExecutionIntent = isDirectPosition
    ? "direct"
    : isSignalPosition
    ? "signal"
    : presetModeEnabled && !mainModeEnabled
      ? "preset"
      : "main"
  if (executionIntent === "preset") {
    const { applySelectedPresetToRealPosition } = await import("@/lib/preset-store")
    realPosition = await applySelectedPresetToRealPosition(
      connectionId,
      realPosition,
      initialConnectionSettings as Record<string, any>,
    )
  }
  const isSpecialPosition = String(realPosition.indicationType || "").trim().toLowerCase() === "special"
  const specialPositionPlan = isSpecialPosition
    ? sanitizeSpecialPositionPlan(realPosition.specialPositionPlan, realPosition.direction)
    : null
  if (specialPositionPlan) {
    realPosition = {
      ...realPosition,
      specialPositionPlan,
      sizeMultiplier: specialPositionPlan.totalVolumeRatio,
      stopLoss: specialPositionPlan.protection.stopLossPct,
      takeProfit: specialPositionPlan.protection.takeProfitPct,
      trailingProfile: specialPositionPlan.protection.trailingEnabled
        ? {
            startRatio: specialPositionPlan.protection.trailingActivationPct / 100,
            stopRatio: specialPositionPlan.protection.trailingDistancePct / 100,
            stepRatio: specialPositionPlan.protection.trailingStepPct / 100,
            mode: "fixed",
          }
        : undefined,
    }
  }

  const livePosition: LivePosition = {
    id: isDirectPosition
      ? directTradeCanonicalPositionId(
          connectionId,
          realPosition.symbol,
          realPosition.direction,
          String(realPosition.parentSetKey || realPosition.setKey || realPosition.id),
        )
      : `live:${connectionId}:${realPosition.symbol}:${realPosition.direction}:${liveExecutionLane(realPosition)}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    connectionId,
    system_tracking_id: makeSystemTrackingId(connectionId),
    connection_tracking_id: connectionTrackingId,
    symbol: realPosition.symbol,
    direction: realPosition.direction,
    realPositionId: realPosition.id,
    marketType,
    volumeKind: marketType === "forex" ? "lots" : "base",
    lotSize,
    quantity: realPosition.quantity,
    executedQuantity: 0,
    remainingQuantity: realPosition.quantity,
    entryPrice: realPosition.entryPrice,
    averageExecutionPrice: 0,
    volumeUsd: 0,
    leverage: realPosition.leverage,
    positionCostPct,
    realProfitFactorAtEntry: (() => {
      const candidates = [
        realPosition.netEffectivePF,
        realPosition.blockObservedProfitFactor,
        realPosition.presetProfitFactor,
        realPosition.prevPos?.profitFactor,
      ]
      for (const candidate of candidates) {
        const value = Number(candidate)
        if (Number.isFinite(value) && value > 0) return value
      }
      return undefined
    })(),
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
      realPosition.takeProfit,
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
    signalRisk:     realPosition.signalRisk,
    setVariant:     realPosition.setVariant,
    executionLane:  liveExecutionLane(realPosition),
    axisWindows:    realPosition.axisWindows,
    sizeMultiplier: realPosition.sizeMultiplier,
    specialPositionPlan: specialPositionPlan || undefined,
    blockBaseVolumeMultiplier: realPosition.blockBaseVolumeMultiplier,
    blockVolumeRatio: realPosition.blockVolumeRatio,
    blockIncrementSteps: realPosition.blockIncrementSteps,
    blockProfitFactorRatio: realPosition.blockProfitFactorRatio,
    blockDefaultMinimumProfitFactor: realPosition.blockDefaultMinimumProfitFactor,
    blockConfiguredMinimumProfitFactor: realPosition.blockConfiguredMinimumProfitFactor,
    blockNormalProfitFactor: realPosition.blockNormalProfitFactor,
    blockMinimumProfitFactor: realPosition.blockMinimumProfitFactor,
    blockObservedProfitFactor: realPosition.blockObservedProfitFactor,
    blockProfitFactorDifference: realPosition.blockProfitFactorDifference,
    blockComparisonAvailable: realPosition.blockComparisonAvailable,
    blockProfitFactorWindow: realPosition.blockProfitFactorWindow,
    blockProfitFactorSampleCount: realPosition.blockProfitFactorSampleCount,
    blockCount: realPosition.blockCount,
    blockScope: realPosition.blockScope,
    blockLaneKind: realPosition.blockLaneKind,
    blockLaneKey: realPosition.blockLaneKey,
    blockSourceId: realPosition.blockSourceId,
    blockVolumeIncrementRatio: realPosition.blockVolumeIncrementRatio,
    blockCalculatedVolumeMultiplier: realPosition.blockCalculatedVolumeMultiplier,
    accumulatedSetKeys: initialLivePositionSetLineage(realPosition),
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
  normalizeLivePositionProtection(livePosition)
  if (specialPositionPlan) applySpecialPlanToPosition(livePosition, specialPositionPlan)
  normalizeLivePositionProtection(livePosition)

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
  const executionSlot = liveExecutionSlot(realPosition)
  const _lockDirSuffix = liveLockDirection(realPosition).slice(realPosition.direction.length)
  let liveOrderLockToken: string | null = null
  let signalCapacityReserved = false
  let exchangeSubmissionStarted = false
  const entryProtectionAdmissionLockKey = `live:entry-protection-admission:${connectionId}`
  const entryProtectionHaltKey = `live:entry-protection-halt:${connectionId}`
  let entryProtectionAdmissionLockToken: string | null = null
  let stopEntryProtectionAdmissionLeaseRefresh: (() => void) | null = null
  const releaseEntryProtectionAdmissionLock = async (): Promise<void> => {
    stopEntryProtectionAdmissionLeaseRefresh?.()
    stopEntryProtectionAdmissionLeaseRefresh = null
    const token = entryProtectionAdmissionLockToken
    entryProtectionAdmissionLockToken = null
    if (!token) return
    await evalLockLua(
      client,
      RELEASE_LOCK_LUA,
      entryProtectionAdmissionLockKey,
      [token],
    ).catch(() => 0)
  }
  const acquireEntryProtectionAdmissionLock = async (): Promise<boolean> => {
    if (entryProtectionAdmissionLockToken) return true
    const deadline = Date.now() + ENTRY_PROTECTION_ADMISSION_WAIT_MS
    const token = `entry-admission:${process.pid}:${Date.now()}:${nanoid(10)}`
    do {
      const acquired = await client.set(
        entryProtectionAdmissionLockKey,
        token,
        { NX: true, PX: ENTRY_PROTECTION_ADMISSION_LOCK_TTL_MS } as any,
      ).catch(() => null)
      if (acquired === "OK") {
        entryProtectionAdmissionLockToken = token
        stopEntryProtectionAdmissionLeaseRefresh = startRedisLockLeaseRefresh(
          client,
          entryProtectionAdmissionLockKey,
          token,
          ENTRY_PROTECTION_ADMISSION_LOCK_TTL_MS,
        )
        return true
      }
      if (Date.now() >= deadline) break
      await new Promise<void>((resolve) => setTimeout(resolve, 75))
    } while (Date.now() < deadline)
    return false
  }
  const rollbackEntryWithoutCompleteProtection = async (
    reason: string,
    violations: readonly string[],
  ): Promise<void> => {
    livePosition.statusReason = reason
    pushStep(
      livePosition,
      "entry_protection_rollback",
      false,
      `${reason}; codes=${violations.slice(0, 8).join(",") || "unknown"}`,
    )
    await savePosition(livePosition).catch(() => {})
    const closed = await closeLivePosition(
      connectionId,
      livePosition.id,
      0,
      exchangeConnector,
      "entry_protection_contract_incomplete",
    ).catch(() => null)
    if (closed && String(closed.status || "") === "closed") {
      Object.assign(livePosition, closed)
      await client.del(entryProtectionHaltKey).catch(() => 0)
      return
    }

    // Do not permit another entry after an exact-owned rollback could not be
    // confirmed. Existing reconciliation/close processing remains active;
    // only new exposure is halted until an operator audit clears this key.
    await client.setex(
      entryProtectionHaltKey,
      24 * 60 * 60,
      JSON.stringify({ at: Date.now(), reason: "entry_protection_rollback_unconfirmed" }),
    ).catch(() => {})
    livePosition.statusReason =
      "Entry protection rollback could not be confirmed; new entries halted for reconciliation"
    await savePosition(livePosition).catch(() => {})
    await logProgressionEvent(
      connectionId,
      "live_trading",
      "error",
      livePosition.statusReason,
      {
        symbol: realPosition.symbol,
        direction: realPosition.direction,
        violations: [...violations].slice(0, 16),
      },
    ).catch(() => {})
  }
  const abortSuperseded = async (): Promise<boolean> => {
    // Once a venue request may have left this process, cancellation would be
    // unsafe: the response can race the settings event. Continue durable
    // recovery, fill reconciliation, and protection for that exact
    // clientOrderId, but suppress every not-yet-started retry below.
    if (await isCurrent() || exchangeSubmissionStarted) return false
    livePosition.status = "rejected"
    livePosition.statusReason =
      "Execution generation changed before submission; no new order was sent"
    livePosition.submissionState = undefined
    pushStep(livePosition, "generation_guard", false, livePosition.statusReason)
    if (signalCapacityReserved) {
      await savePosition(livePosition).catch(() => {})
      signalCapacityReserved = false
    }
    if (liveOrderLockToken) {
      await releaseLock(
        connectionId,
        realPosition.symbol,
        realPosition.direction + _lockDirSuffix,
        liveOrderLockToken,
      ).catch(() => {})
      liveOrderLockToken = null
    }
    return true
  }

  try {
    if (await abortSuperseded()) return livePosition
    // ── Step 1: Pre-flight validation ──────────────�������──────────────────────
    const requestedDirection = String(realPosition.direction || "").trim().toLowerCase()
    if (
      !String(realPosition.symbol || "").trim() ||
      (requestedDirection !== "long" && requestedDirection !== "short") ||
      (isSpecialPosition && !specialPositionPlan)
    ) {
      livePosition.status = "rejected"
      livePosition.statusReason = isSpecialPosition && !specialPositionPlan
        ? "Invalid Special position plan: direction/caps/protection contract rejected"
        : `Invalid inputs: symbol=${realPosition.symbol}, direction=${realPosition.direction}`
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
    const readinessIntent = readinessIntentForExecution(connSettings, executionIntent)
    const liveReadiness = executionIntent === "direct"
      ? evaluateDirectTradeLiveReadiness(connSettings, connectionId)
      : evaluateRealTradeReadiness(connSettings, readinessIntent)
    const isLiveTradeEnabled = liveReadiness.canPlaceRealOrders
    livePosition.executionMode = liveReadiness.executionMode
    livePosition.executionBlockCode = liveReadiness.blockCode || undefined
    livePosition.executionBlockReason = liveReadiness.blockReason || undefined
    if (await abortSuperseded()) return livePosition

    // A requested live run must fail visibly when its safety prerequisites are
    // not met. Falling back to paper here made the Main engine look healthy
    // while no venue order was ever attempted. Paper simulation remains active
    // only when the operator has actually left Live Trade disabled.
    if (!isLiveTradeEnabled && liveReadiness.requested && liveReadiness.executionMode !== "simulation") {
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

    // Position-count Sets own one physical target per exact Base parent and
    // direction. Every cycle reconciles that lane's quantity to the sum of its
    // independently validated member ratios. The opposite direction is a
    // separate lane and is never hedged or closed here.
    if (realPosition.combinedPosCounts) {
      if (await abortSuperseded()) return livePosition
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

    // DCA attaches to an already confirmed parent. Block is independent: it
    // normally accumulates into the authoritative Normal lane, but when no
    // Normal parent exists it seeds its own physical parent and later counts
    // reconcile into that parent.
    const isAdjustmentVariant = isBlockVariant || realPosition.setVariant === "dca"
    if (isAdjustmentVariant) {
      if (await abortSuperseded()) return livePosition
      const existing = await findAuthoritativeAdjustmentParent(
        connectionId,
        realPosition.symbol,
        realPosition.direction,
        !isLiveTradeEnabled,
        executionSlot,
        isBlockVariant,
        // Source-specific Signal Blocks retain their own bookkeeping lane. If
        // no exact source parent exists, they may fall back to the ordinary
        // direction parent; otherwise the independent Block seed below owns
        // the lane.
        isBlockVariant && executionSlot !== "default"
          ? "default"
          : undefined,
      )
      if (!existing) {
        if (isBlockVariant) {
          // A fresh independent Block lane has no confirmed parent. Continue
          // into the ordinary entry pipeline with the already calculated
          // absolute Block multiplier; the persisted Block position becomes
          // the authoritative parent for later counts.
          pushStep(
            livePosition,
            "block_independent_parent_seed",
            true,
            `opening adjusted Block parent for ${realPosition.setKey || "unknown"}`,
          )
        } else {
          livePosition.status = "rejected"
          livePosition.statusReason = isBlockVariant
            ? `Block Set ${realPosition.setKey || "unknown"} waits for authoritative parent fill`
            : `DCA Set ${realPosition.setKey || "unknown"} waits for authoritative parent fill`
          pushStep(livePosition, "adjustment_wait", false, livePosition.statusReason)
          await savePosition(livePosition)
          return livePosition
        }
      } else {
        const adjustmentPrice = realPosition.entryPrice > 0
          ? realPosition.entryPrice
          : await fetchCurrentPrice(realPosition.symbol, connectionId)
        if (await abortSuperseded()) return livePosition
        if (!(adjustmentPrice > 0)) {
          pushStep(existing, "accumulate_skip", false, "market price unavailable — adjustment deferred")
          await savePosition(existing)
          return existing
        }
        if (existing.status === "simulated") {
          if (await abortSuperseded()) return livePosition
          return accumulateIntoSimulatedPosition(connectionId, existing, realPosition, adjustmentPrice)
        }
        if (await abortSuperseded()) return livePosition
        return accumulateIntoLivePosition(
          connectionId,
          existing,
          realPosition,
          adjustmentPrice,
          exchangeConnector,
          isLiveTradeEnabled,
          executionIntent === "direct" ? shouldContinue : undefined,
        )
      }
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
      if (acquired) {
        liveOrderLockToken = acquired
        livePosition.liveLockToken = acquired
      }
      if (await abortSuperseded()) return livePosition
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
              executionSlot,
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
        if (!accPrice || accPrice <= 0) accPrice = await fetchCurrentPrice(realPosition.symbol, connectionId)

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
          true,
          executionIntent === "direct" ? shouldContinue : undefined,
        )
        // Refresh the existing slot's TTL — the position is still open
        // on the exchange and we want the safety expiry pushed forward
        // by the 300 s window. Lock value remains the original entry's
        // timestamp (intentional — debuggers see the original entry's
        // wall-clock, not the accumulation's).
        /* Do not refresh: this worker did not acquire the lock token. */
        return merged
      }
      // acquired === true: we own the slot. Continue to fresh-entry
      // path below. The historical `await acquireLock(...)` after order
      // placement is now redundant and has been removed (see Step 5).
    }

    // Simulation has no symbol-scoped Redis lock, so perform the cheap existing
    // lane check before taking the connection-wide Signal admission lease. The
    // authoritative re-check inside reserveSignalPositionCapacity closes the
    // remaining cross-worker race.
    if (!isLiveTradeEnabled) {
      const existingSimulatedSlot = await findOpenLivePositionByDir(
        connectionId,
        realPosition.symbol,
        realPosition.direction,
        executionSlot,
      )
      if (existingSimulatedSlot) {
        if (isSpecialPosition) {
          const accumulationPrice = realPosition.entryPrice > 0
            ? realPosition.entryPrice
            : await fetchCurrentPrice(realPosition.symbol, connectionId)
          if (accumulationPrice > 0) {
            return accumulateIntoSimulatedPosition(
              connectionId,
              existingSimulatedSlot,
              realPosition,
              accumulationPrice,
            )
          }
        }
        return existingSimulatedSlot
      }
    }

    const isSignalPositionCandidate = isActiveSignalPosition(
      livePosition as unknown as Record<string, unknown>,
    )
    if (isSignalPositionCandidate) {
      if (await abortSuperseded()) return livePosition
      const signalSettings = await loadSignalIndicationSettings()
      const admission = await reserveSignalPositionCapacity(
        connectionId,
        livePosition,
        signalSettings.maxPositionsTotal,
        signalSettings.positionSelectionMode,
      )

      if (admission.state === "existing") {
        // A live lock can legitimately expire while its venue position remains
        // open. Transfer the newly-acquired token to that canonical position
        // instead of releasing it and reopening the duplicate window.
        if (liveOrderLockToken) {
          admission.existing.liveLockToken = liveOrderLockToken
          await savePosition(admission.existing)
        }
        return admission.existing
      }

      if (admission.state === "limit" || admission.state === "busy") {
        livePosition.status = "rejected"
        livePosition.statusReason = admission.state === "limit"
          ? `Signal position capacity reached (${admission.capacity.total}/${admission.capacity.limit} Long + Short); lower-ranked candidate deferred`
          : "Signal position admission is coordinating another candidate; deferred to the next cycle"
        pushStep(livePosition, "signal_position_admission", false, livePosition.statusReason)
        if (liveOrderLockToken) {
          await releaseLock(
            connectionId,
            realPosition.symbol,
            realPosition.direction + _lockDirSuffix,
            liveOrderLockToken,
          ).catch(() => {})
          liveOrderLockToken = null
        }
        if (shouldEmitSignalCapacityNotice(connectionId)) {
          await Promise.all([
            logProgressionEvent(
              connectionId,
              "signal_capacity",
              admission.state === "limit" ? "warning" : "info",
              livePosition.statusReason,
              {
                symbol: realPosition.symbol,
                direction: realPosition.direction,
                total: admission.capacity.total,
                long: admission.capacity.long,
                short: admission.capacity.short,
                limit: admission.capacity.limit,
                selectionMode: signalSettings.positionSelectionMode,
              },
            ),
            SystemLogger.logTradeEngine(
              livePosition.statusReason,
              admission.state === "limit" ? "warn" : "info",
              {
                connectionId,
                symbol: realPosition.symbol,
                direction: realPosition.direction,
                capacity: admission.capacity,
                selectionMode: signalSettings.positionSelectionMode,
              },
            ),
          ]).catch(() => {})
        }
        return livePosition
      }

      signalCapacityReserved = true
      pushStep(
        livePosition,
        "signal_position_admission",
        true,
        `reserved ${admission.capacity.total}/${admission.capacity.limit}; best-quality-first`,
      )
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
      if (await abortSuperseded()) return livePosition
      const simTicker = marketType === "forex"
        ? await resolveCachedVenueTicker(realPosition.symbol, connectionId)
        : null
      if (simTicker) {
        livePosition.quoteBid = finitePositive(simTicker.bid) || undefined
        livePosition.quoteAsk = finitePositive(simTicker.ask) || undefined
        livePosition.spreadPrice = simTicker.spreadPrice
        livePosition.spreadPips = simTicker.spreadPips
        livePosition.spreadBps = simTicker.spreadBps
        livePosition.spreadPercent = simTicker.spreadPercent
        livePosition.spreadSource = simTicker.spreadSource
        livePosition.quoteTimestamp = simTicker.timestamp
        livePosition.positionCostPct = effectivePositionCostPercent(
          positionCostPct,
          simTicker,
          realPosition.symbol,
          {
            marketType,
            spreadBufferPips: finiteOptional(
              (initialConnectionSettings as any).spread_buffer_pips ??
              (initialConnectionSettings as any).spreadBufferPips,
            ),
            spreadMultiplier: finiteOptional(
              (initialConnectionSettings as any).spread_multiplier ??
              (initialConnectionSettings as any).spreadMultiplier,
            ),
          },
        )
      }
      const simConversion = marketType === "forex"
        ? await resolveForexUsdConversion(connectionId, realPosition.symbol, undefined, true)
        : null
      if (simConversion) livePosition.quoteToUsdRate = simConversion.rate
      // Fetch the current market price so simulated positions open at a
      // real price (not 0). This mirrors the live path's Step 2 but runs
      // here before the simulation early-return so SL/TP cross-checks and
      // PnL display are meaningful.
      let simEntryPrice = simTicker
        ? selectVenueTickerPrice(simTicker, realPosition.direction)
        : livePosition.entryPrice || realPosition.entryPrice || 0
      if (!simEntryPrice || simEntryPrice <= 0) {
        simEntryPrice = (await fetchCurrentPrice(realPosition.symbol, connectionId).catch(() => 0)) || 0
      }
      livePosition.entryPrice = simEntryPrice

      // Compute a realistic volume using the VolumeCalculator (same as Step 3
      // on the live path). Falls back to realPosition.quantity if the
      // calculator fails (e.g. no balance data in sandbox).
      let simQty = marketType === "forex" ? 0 : (realPosition.quantity || 1)
      try {
        const { VolumeCalculator } = await import("@/lib/volume-calculator")
        const simVolResult = await VolumeCalculator.calculateVolumeForConnection(
          connectionId,
          realPosition.symbol,
          simEntryPrice,
          {
            tradeMode: volumeTradeModeForIntent(executionIntent),
            sizeMultiplier: realPosition.sizeMultiplier,
            allowUnboundedVariantMultiplier: realPosition.combinedPosCounts === true,
            indicationType: realPosition.indicationType,
            marketType: livePosition.marketType,
            lotSize: livePosition.lotSize,
            positionCostPercentOverride: livePosition.positionCostPct,
            quoteToUsdRate: livePosition.quoteToUsdRate,
          },
        )
        const vol = simVolResult?.finalVolume ?? simVolResult?.calculatedVolume ?? simVolResult?.volume ?? 0
        if (vol > 0) {
          simQty = vol
          livePosition.leverage = simVolResult.leverage || livePosition.leverage
          livePosition.requestedVolume = Number(simVolResult.calculatedVolume) || 0
          livePosition.intendedNotionalUsd = Number(simVolResult.intendedNotionalUsd) || 0
          livePosition.exchangeMinNotionalUsd = Number(simVolResult.exchangeMinNotionalUsd) || 0
          livePosition.systemVolumeFactor = Number(simVolResult.systemVolumeFactor) || 1
          livePosition.liveEngineFactor = Number(simVolResult.liveEngineFactor) || 1
          livePosition.signalVolumeFactor = Number(simVolResult.signalVolumeFactor) || 1
          livePosition.volumeAdjusted = simVolResult.volumeAdjusted === true
          livePosition.volumeAdjustmentReason = simVolResult.adjustmentReason || undefined
        }
        if (marketType === "forex" && simVolResult?.conversionAvailable === false) {
          simQty = 0
          livePosition.status = "rejected"
          livePosition.statusReason = simVolResult.adjustmentReason || "Forex USD conversion rate unavailable; simulation refused"
          pushStep(livePosition, "volume_calc", false, livePosition.statusReason)
          await savePosition(livePosition)
          return livePosition
        }
      } catch {
        if (marketType === "forex") simQty = 0
      }
      if (!(simQty > 0)) {
        livePosition.status = "rejected"
        livePosition.statusReason = marketType === "forex"
          ? "Forex simulation refused: no executable lot size or USD conversion"
          : "Simulation refused: no executable quantity"
        pushStep(livePosition, "volume_calc", false, livePosition.statusReason)
        await savePosition(livePosition)
        return livePosition
      }
      if (marketType === "forex") {
        const spec = getForexInstrumentSpec(realPosition.symbol)
        livePosition.quantityStep = spec.minLot
        livePosition.quantityPrecision = 2
        livePosition.pricePrecision = spec.digits
        livePosition.priceTick = 10 ** -spec.digits
      }
      if (await abortSuperseded()) return livePosition

      // Set averageExecutionPrice before calling computeDesiredProtectionPrices
      // because that function uses it as the fill price for SL/TP calculation.
      livePosition.averageExecutionPrice = simEntryPrice
      // Compute SL/TP prices for the simulated position so reconcile and
      // checkAndForceCloseOnSltpCross have valid price targets.
      if (simEntryPrice > 0) {
        const simProtection = computeDesiredProtectionPrices(livePosition)
        // Keep the strategy-assigned percentages immutable. Paper positions
        // have no venue control order, so persist both the absolute targets
        // and their explicit engine-side lifecycle ownership.
        livePosition.stopLossPrice = simProtection.desiredSl > 0 ? simProtection.desiredSl : undefined
        livePosition.takeProfitPrice = simProtection.desiredTp > 0 ? simProtection.desiredTp : undefined
        refreshProtectionHandlingMode(
          livePosition,
          simProtection.desiredSl,
          simProtection.desiredTp,
          true,
        )
      }
      livePosition.executedQuantity = simQty
      livePosition.remainingQuantity = 0
      livePosition.averageExecutionPrice = simEntryPrice
      livePosition.volumeUsd = positionNotionalUsd(livePosition, simQty, simEntryPrice)
      livePosition.initialExecutedQuantity = simQty
      if (specialPositionPlan) {
        livePosition.specialBaseQuantity = simQty / specialPositionPlan.totalVolumeRatio
        applySpecialPlanToPosition(livePosition, specialPositionPlan)
      }
      livePosition.totalExecutedQuantity = simQty
      livePosition.initialEntryPrice = simEntryPrice
      livePosition.blockBaseQuantity = simQty
      initializeIndependentBlockSeed(livePosition, realPosition, simQty)
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
      if (await abortSuperseded()) return livePosition
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
      // Run paper counters independently. Real placed/filled/position-created
      // counters remain exchange-only so UI/PF/PnL never present pseudo fills
      // as venue executions.
      await Promise.all([
        incrementMetric(connectionId, "live_orders_simulated_count"),
        incrementMetric(connectionId, "live_simulated_positions_created_count"),
        incrementMetric(connectionId, "live_simulated_volume_microusd_total", Math.round(livePosition.volumeUsd * 1e6)),
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

    await assertMarginCallEntryAllowed(connectionId, exchangeConnector)

    // ── Step 2: Fetch the authoritative venue price ─────────────────────
    // Historical strategy rows can use a normalized price domain (for
    // example ~100) while the actual venue instrument trades at a fraction of
    // that value. Using the pseudo price here corrupts quantity sizing and
    // trailing/control-order prices. Real exchange mutations therefore fail
    // closed unless the connector itself supplies a current ticker.
    const venueTicker = await resolveAuthoritativeLiveTicker(
      connectionId,
      realPosition.symbol,
      exchangeConnector,
    )
    const currentPrice = selectVenueTickerPrice(venueTicker, realPosition.direction)
    if (!currentPrice || currentPrice <= 0) {
      livePosition.status = "error"
      livePosition.statusReason = `No authoritative exchange ticker available for ${realPosition.symbol}`
      pushStep(livePosition, "price_fetch", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_failed_count")
      await incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "failed")
      await logProgressionEvent(connectionId, "live_trading", "error", "Live order failed — no authoritative venue ticker", {
        symbol: realPosition.symbol,
      })
      // Release the dedup lock — a missing market price is a transient
      // condition (typically a fresh symbol whose ticker hasn't streamed
      // yet). Without releasing, the next cycle's signal would defer for
      // 5 minutes even though the price arrives within seconds.
      if (liveOrderLockToken) await releaseLock(connectionId, realPosition.symbol, realPosition.direction + _lockDirSuffix, liveOrderLockToken).catch(() => {})
      return livePosition
    }
    if (venueTicker) {
      livePosition.quoteBid = finitePositive(venueTicker.bid) || undefined
      livePosition.quoteAsk = finitePositive(venueTicker.ask) || undefined
      livePosition.spreadPrice = venueTicker.spreadPrice
      livePosition.spreadPips = venueTicker.spreadPips
      livePosition.spreadBps = venueTicker.spreadBps
      livePosition.spreadPercent = venueTicker.spreadPercent
      livePosition.spreadSource = venueTicker.spreadSource
      livePosition.quoteTimestamp = venueTicker.timestamp
      livePosition.marketType = venueTicker.marketType || marketType
      livePosition.volumeKind = livePosition.marketType === "forex" ? "lots" : "base"
      livePosition.positionCostPct = effectivePositionCostPercent(
        positionCostPct,
        venueTicker,
        realPosition.symbol,
        {
          marketType: livePosition.marketType,
          spreadBufferPips: finiteOptional(
            (initialConnectionSettings as any).spread_buffer_pips ??
            (initialConnectionSettings as any).spreadBufferPips,
          ),
          spreadMultiplier: finiteOptional(
            (initialConnectionSettings as any).spread_multiplier ??
            (initialConnectionSettings as any).spreadMultiplier,
          ),
        },
      )
    }
    if (livePosition.marketType === "forex") {
      const pair = forexPairCurrencies(realPosition.symbol)
      if (pair && pair.quote !== "USD" && pair.base !== "USD") {
        const conversion = await resolveForexUsdConversion(
          connectionId,
          realPosition.symbol,
          exchangeConnector,
        )
        if (!conversion) {
          livePosition.status = "error"
          livePosition.statusReason = "No authoritative USD conversion quote available for Forex pair " +
            realPosition.symbol + " (" + pair.quote + ")"
          pushStep(livePosition, "forex_conversion", false, livePosition.statusReason)
          await savePosition(livePosition)
          await Promise.all([
            incrementMetric(connectionId, "live_orders_failed_count"),
            incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "failed"),
            logProgressionEvent(connectionId, "live_trading", "error", livePosition.statusReason, {
              symbol: realPosition.symbol,
              direction: realPosition.direction,
            }),
          ])
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
        livePosition.quoteToUsdRate = conversion.rate
        pushStep(
          livePosition,
          "forex_conversion",
          true,
          pair.quote + "→USD=" + conversion.rate + " (" + conversion.source + ")",
        )
      }
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
    // The calculator must return a finite risk-budgeted quantity. A missing
    // balance/conversion/ceiling is a safety failure, not a reason to invent a
    // universal-minimum order. Venue minimums are honored only when they fit
    // inside the approved PositionCost ceiling.
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
    const liveTradeMode = volumeTradeModeForIntent(executionIntent)

    // Load the exact venue grids before a real order can leave the process.
    // Quantity precision alone is insufficient for a security trigger: the
    // slot-level full-quantity stop must be representable on the exact price tick.
    const liveInstrumentRules = await loadExchangeQuantityRules(
      realPosition.symbol,
      exchangeConnector,
      connectionId,
    )
    applyLiveInstrumentRules(livePosition, liveInstrumentRules)
    if (bingXEnvironmentInfo(exchangeConnector) && !(livePosition.priceTick && livePosition.priceTick > 0)) {
      livePosition.status = "error"
      livePosition.statusReason = `Exchange entry preflight failed: exact BingX price tick unavailable for ${realPosition.symbol}`
      pushStep(livePosition, "instrument_rules", false, livePosition.statusReason)
      await savePosition(livePosition)
      await Promise.all([
        incrementMetric(connectionId, "live_orders_failed_count"),
        incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "failed"),
        logProgressionEvent(connectionId, "live_trading", "error", livePosition.statusReason, {
          symbol: realPosition.symbol,
          direction: realPosition.direction,
        }),
      ])
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
    pushStep(
      livePosition,
      "instrument_rules",
      true,
      `qtyStep=${livePosition.quantityStep} priceTick=${livePosition.priceTick || "unsupported"}`,
    )

    const volumeResult = await VolumeCalculator.calculateVolumeForConnection(
      connectionId,
      realPosition.symbol,
      currentPrice,
      {
        tradeMode: liveTradeMode,
        // Forward the Block/DCA variant multiplier so notional is correctly
        // scaled before the exchange order is placed (absent → 1.0 identity).
        sizeMultiplier: realPosition.sizeMultiplier,
        // Only a combined Position-Count target represents the sum of every
        // valid Set. Ordinary Block/DCA variants remain safely bounded.
        allowUnboundedVariantMultiplier: realPosition.combinedPosCounts === true,
        indicationType: realPosition.indicationType,
        positionCostPercentOverride: livePosition.positionCostPct,
        marketType: livePosition.marketType,
        lotSize: livePosition.lotSize,
        quoteToUsdRate: livePosition.quoteToUsdRate,
      },
    ).catch(err => {
      console.error(`${LOG_PREFIX} volume calc error:`, err)
      return null
    })

    let computedVolume = volumeResult?.finalVolume || volumeResult?.volume || 0
    let volumeNote = ""
    if (computedVolume <= 0 || !Number.isFinite(computedVolume)) {
      livePosition.status = "error"
      livePosition.statusReason = volumeResult?.adjustmentReason ||
        "Live entry refused: no finite risk-budgeted executable quantity was calculated"
      pushStep(livePosition, "volume_calc", false, livePosition.statusReason)
      await savePosition(livePosition)
      await Promise.all([
        incrementMetric(connectionId, "live_orders_failed_count"),
        incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "failed"),
        logProgressionEvent(connectionId, "live_trading", "error", livePosition.statusReason, {
          symbol: realPosition.symbol,
          direction: realPosition.direction,
        }),
      ])
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

    // A fallback balance keeps paper calculations useful, but it is not a
    // safe basis for a real/VST order. Using a synthetic 10,000-USD balance
    // after a broker/API outage can turn a small account into an oversized
    // order. Stop before the first venue submission and let the next cycle
    // retry after an authoritative balance is available.
    if (liveReadiness.canPlaceRealOrders && volumeResult?.balanceIsFallback === true) {
      livePosition.status = "error"
      livePosition.statusReason = "Live entry refused: authoritative exchange balance unavailable; no fallback balance may size a live/VST order"
      pushStep(livePosition, "balance_preflight", false, livePosition.statusReason)
      await savePosition(livePosition)
      await Promise.all([
        incrementMetric(connectionId, "live_orders_failed_count"),
        incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "failed"),
        logProgressionEvent(connectionId, "live_trading", "error", livePosition.statusReason, {
          symbol: realPosition.symbol,
          direction: realPosition.direction,
        }),
      ])
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

    // Direct-Trade supplies one minimum-volume economic intent from its leased
    // worker. The canonical calculator remains the hard risk ceiling; this
    // branch can only reduce that quantity (or raise the caller's sub-minimum
    // request to the venue minimum when the same PositionCost ceiling permits
    // it). It can never turn a Direct request into a larger risk allocation.
    const directRequestedQuantity = Number(realPosition.requestedQuantityCap)
    if (executionIntent === "direct" && directRequestedQuantity > 0) {
      const normalizedDirect = resolveExecutableQuantity(
        directRequestedQuantity,
        currentPrice,
        liveInstrumentRules,
        { universalMinNotionalUsdt: VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD },
      )
      const directCeiling = Number(normalizedDirect.quantity || 0)
      let boundedDirectQuantity = roundQuantityDown(
        Math.min(computedVolume, directCeiling),
        liveInstrumentRules,
      )
      if (
        boundedDirectQuantity < liveInstrumentRules.minQuantity - 1e-12 &&
        directCeiling <= computedVolume + 1e-12
      ) {
        boundedDirectQuantity = directCeiling
      }
      if (!(boundedDirectQuantity > 0)) {
        livePosition.status = "error"
        livePosition.statusReason =
          "Direct-Trade minimum-volume request does not fit inside the canonical PositionCost ceiling"
        pushStep(livePosition, "direct_quantity_cap", false, livePosition.statusReason)
        await savePosition(livePosition)
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
      computedVolume = boundedDirectQuantity
      volumeNote = ` [direct-request: ${directRequestedQuantity} → ${computedVolume}]`
    }

    // Re-apply the calculator's hard notional ceiling after instrument
    // metadata has been loaded. This protects the exchange boundary if a
    // stale cache or future calculator change rounds an entry upward.
    const maxExecutionNotionalUsd = Number(volumeResult?.maxExecutionNotionalUsd)
    const currentNotional = positionNotionalUsd(livePosition, computedVolume, currentPrice)
    if (liveReadiness.canPlaceRealOrders && (!(maxExecutionNotionalUsd > 0) || currentNotional > maxExecutionNotionalUsd + 1e-8)) {
      const unitNotional = positionNotionalUsd(livePosition, 1, currentPrice)
      const cappedQuantity = unitNotional > 0 && maxExecutionNotionalUsd > 0
        ? roundQuantityDown(maxExecutionNotionalUsd / unitNotional, liveInstrumentRules)
        : 0
      const cappedNotional = positionNotionalUsd(livePosition, cappedQuantity, currentPrice)
      if (!(cappedQuantity > 0) || cappedNotional > maxExecutionNotionalUsd + 1e-8 || cappedQuantity < liveInstrumentRules.minQuantity) {
        livePosition.status = "error"
        livePosition.statusReason = `Live entry refused: executable quantity exceeds the ${maxExecutionNotionalUsd > 0 ? maxExecutionNotionalUsd.toFixed(2) : "configured"} USD exposure ceiling`
        pushStep(livePosition, "volume_cap", false, livePosition.statusReason)
        await savePosition(livePosition)
        if (liveOrderLockToken) await releaseLock(connectionId, realPosition.symbol, realPosition.direction + _lockDirSuffix, liveOrderLockToken).catch(() => {})
        return livePosition
      }
      computedVolume = cappedQuantity
      volumeNote = ` [hard-cap: ${cappedNotional.toFixed(2)} USD]`
    }

    // Every entry retry is a new venue submission. Keep minimum-order and
    // margin fallbacks on the same quantity grid and hard PositionCost cap as
    // the primary order; a correction must never become a volume escape hatch.
    let liveSubmissionNotionalCeiling = maxExecutionNotionalUsd
    const normalizeRetryEntryQuantity = (requested: number, enforceMinimum: boolean): number => {
      const raw = Number(requested)
      if (!Number.isFinite(raw) || raw <= 0) return 0
      let quantity = enforceMinimum
        ? livePosition.marketType === "forex"
          ? roundQuantityUp(Math.max(raw, liveInstrumentRules.minQuantity), liveInstrumentRules)
          : resolveExecutableQuantity(
              raw,
              currentPrice,
              liveInstrumentRules,
              { universalMinNotionalUsdt: VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD },
            ).quantity
        : roundQuantityDown(raw, liveInstrumentRules)
      if (!(quantity > 0)) return 0

      const unitNotional = positionNotionalUsd(livePosition, 1, currentPrice)
      if (liveSubmissionNotionalCeiling > 0 && unitNotional > 0) {
        const maximum = roundQuantityDown(liveSubmissionNotionalCeiling / unitNotional, liveInstrumentRules)
        if (!(maximum > 0)) return 0
        quantity = Math.min(quantity, maximum)
      }
      if (!enforceMinimum && quantity < liveInstrumentRules.minQuantity - 1e-12) return 0
      const totalNotional = positionNotionalUsd(livePosition, quantity, currentPrice)
      if (!(totalNotional > 0) || (liveSubmissionNotionalCeiling > 0 && totalNotional > liveSubmissionNotionalCeiling + 1e-8)) return 0
      if (enforceMinimum && livePosition.marketType !== "forex") {
        const minimum = resolveExecutableQuantity(
          Math.max(liveInstrumentRules.minQuantity, currentPrice > 0 ? VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD / currentPrice : 0),
          currentPrice,
          liveInstrumentRules,
          { universalMinNotionalUsdt: VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD },
        ).quantity
        if (minimum > 0 && quantity + 1e-12 < minimum) return 0
      }
      return quantity
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
    livePosition.volumeUsd = positionNotionalUsd(livePosition, computedVolume, currentPrice)
    livePosition.leverage = volumeResult?.leverage || livePosition.leverage
    livePosition.requestedVolume = Number(volumeResult?.calculatedVolume) || 0
    livePosition.intendedNotionalUsd = Number(volumeResult?.intendedNotionalUsd) || 0
    livePosition.exchangeMinNotionalUsd = Number(volumeResult?.exchangeMinNotionalUsd) || 0
    livePosition.maxExecutionNotionalUsd = maxExecutionNotionalUsd > 0 ? maxExecutionNotionalUsd : undefined
    livePosition.liveMultiplierCapped = volumeResult?.liveMultiplierCapped === true
    livePosition.systemVolumeFactor = Number(volumeResult?.systemVolumeFactor) || 1
    livePosition.liveEngineFactor = Number(volumeResult?.liveEngineFactor) || 1
    livePosition.signalVolumeFactor = Number(volumeResult?.signalVolumeFactor) || 1
    livePosition.sizeMultiplier = Number(volumeResult?.sizeMultiplier) || 1
    livePosition.volumeAdjusted = volumeResult?.volumeAdjusted === true
    livePosition.volumeAdjustmentReason = volumeResult?.adjustmentReason || undefined
    // Volume calculation may refresh pair metadata; re-apply the canonical
    // normalized snapshot so every persisted row is self-describing.
    applyLiveInstrumentRules(livePosition, liveInstrumentRules)

    // If the volume calculator clamped the quantity UP to an exchange
    // minimum, surface that in the
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
    const freshMainModeEnabled = reCheckMainEnabled(freshSettings)
    const freshPresetModeEnabled = reCheckPresetEnabled(freshSettings)
    const freshExecutionIntent: LiveExecutionIntent = isDirectPosition
      ? "direct"
      : isSignalPosition
      ? "signal"
      : freshPresetModeEnabled && !freshMainModeEnabled
        ? "preset"
        : "main"
    const freshReadinessIntent = readinessIntentForExecution(freshSettings, freshExecutionIntent)
    const freshReadiness = freshExecutionIntent === "direct"
      ? evaluateDirectTradeLiveReadiness(freshSettings, connectionId)
      : evaluateRealTradeReadiness(freshSettings, freshReadinessIntent)
    const supervisedSmokeId = await client.get("live_order_smoke:active").catch(() => null)
    const engineProcessing = freshExecutionIntent === "direct"
      ? await isCurrent()
      : isConnectionMainProcessing(freshSettings)
    const isStillLive = freshReadiness.canPlaceRealOrders && engineProcessing && !supervisedSmokeId
    if (await abortSuperseded()) return livePosition
    
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
      livePosition.executionBlockCode = !engineProcessing
        ? "engine_processing_stopped"
        : freshReadiness.blockCode || undefined
      livePosition.executionBlockReason = !engineProcessing
        ? freshExecutionIntent === "direct"
          ? "Direct-Trade processor lease or live state is no longer active"
          : "Connection processing is stopped"
        : freshReadiness.blockReason || undefined
      livePosition.statusReason = supervisedSmokeId
        ? `Exchange order blocked before placement: supervised live-order smoke ${supervisedSmokeId} owns the account gate`
        : !engineProcessing
          ? freshExecutionIntent === "direct"
            ? "Exchange order blocked before placement: Direct-Trade processor lease or live state stopped"
            : "Exchange order blocked before placement: connection processing is stopped"
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

    const existingEntryProtectionHalt = await client.get(entryProtectionHaltKey).catch(() => null)
    if (existingEntryProtectionHalt) {
      livePosition.status = "rejected"
      livePosition.executionMode = "blocked"
      livePosition.executionBlockCode = "entry_protection_halted"
      livePosition.executionBlockReason = "A prior entry could not prove complete venue protection"
      livePosition.statusReason =
        "Exchange order blocked before placement: entry protection halt requires reconciliation"
      pushStep(livePosition, "entry_protection_admission", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_blocked_count")
      return livePosition
    }

    if (!await acquireEntryProtectionAdmissionLock()) {
      livePosition.status = "rejected"
      livePosition.executionMode = "blocked"
      livePosition.executionBlockCode = "entry_protection_admission_busy"
      livePosition.executionBlockReason = "Another entry is completing its venue protection contract"
      livePosition.statusReason =
        "Exchange order deferred: connection-wide protection admission is busy"
      pushStep(livePosition, "entry_protection_admission", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_deferred_count")
      return livePosition
    }

    // Re-read the durable switches after acquiring the account-wide lease.
    // This closes the stop/start race while the caller waited behind another
    // entry and ensures Signal cannot continue after the engine is stopped.
    const lockedSettings = (await reCheckConn(connectionId)) || {}
    const lockedMainModeEnabled = reCheckMainEnabled(lockedSettings)
    const lockedPresetModeEnabled = reCheckPresetEnabled(lockedSettings)
    const lockedExecutionIntent: LiveExecutionIntent = isDirectPosition
      ? "direct"
      : isSignalPosition
      ? "signal"
      : lockedPresetModeEnabled && !lockedMainModeEnabled
        ? "preset"
        : "main"
    const lockedReadiness = lockedExecutionIntent === "direct"
      ? evaluateDirectTradeLiveReadiness(lockedSettings, connectionId)
      : evaluateRealTradeReadiness(
          lockedSettings,
          readinessIntentForExecution(lockedSettings, lockedExecutionIntent),
        )
    const lockedProcessing = lockedExecutionIntent === "direct"
      ? await isCurrent()
      : isConnectionMainProcessing(lockedSettings)
    if (!lockedProcessing || !lockedReadiness.canPlaceRealOrders) {
      livePosition.status = "rejected"
      livePosition.executionMode = "blocked"
      livePosition.executionBlockCode = !lockedProcessing
        ? "engine_processing_stopped"
        : lockedReadiness.blockCode || "live_readiness_changed"
      livePosition.executionBlockReason = !lockedProcessing
        ? lockedExecutionIntent === "direct"
          ? "Direct-Trade processor lease or live state stopped while entry waited for admission"
          : "Connection processing stopped while entry waited for admission"
        : lockedReadiness.blockReason
      livePosition.statusReason =
        `Exchange order blocked after admission lock: ${livePosition.executionBlockReason}`
      pushStep(livePosition, "entry_protection_admission", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_blocked_count")
      return livePosition
    }

    let entryAdmission: EntryProtectionAdmissionDecision
    try {
      entryAdmission = await auditEntryProtectionBeforeVenueMutation({
        connectionId,
        candidateId: livePosition.id,
        symbol: realPosition.symbol,
        direction: realPosition.direction,
        connector: exchangeConnector,
      })
    } catch (error) {
      entryAdmission = {
        safe: false,
        violations: ["authoritative_admission_snapshot_unavailable"],
        audit: {
          safe: false,
          violations: ["authoritative_admission_snapshot_unavailable"],
          ownedActiveRows: 0,
          ownedExecutedRows: 0,
          physicalSlotRows: 0,
          systemSlotQuantity: 0,
          venueSlotQuantity: 0,
          physicalSlotAlreadyExists: false,
          requiredNewControlOrders: 3,
        },
        observedControlOrders: 0,
        availableControlOrders: 0,
      }
      console.warn(
        `${LOG_PREFIX} entry protection admission snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!entryAdmission.safe) {
      const codes = entryAdmission.violations.slice(0, 8).join(",")
      livePosition.status = "rejected"
      livePosition.executionMode = "blocked"
      livePosition.executionBlockCode = "entry_protection_admission_failed"
      livePosition.executionBlockReason = codes || "protection_contract_incomplete"
      livePosition.statusReason =
        `Exchange order blocked before any venue mutation: protection admission failed (${codes || "unknown"})`
      livePosition.controlOrderCapacity = {
        limit: isBingXCapacityConnector(exchangeConnector)
          ? BINGX_CONTROL_ORDER_LIMIT
          : Number.MAX_SAFE_INTEGER,
        observedOpen: entryAdmission.observedControlOrders,
        reserved: entryAdmission.audit.requiredNewControlOrders,
        available: entryAdmission.availableControlOrders,
        exhausted: entryAdmission.availableControlOrders < entryAdmission.audit.requiredNewControlOrders,
      }
      pushStep(livePosition, "entry_protection_admission", false, livePosition.statusReason)
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
            violations: entryAdmission.violations,
            ownedRows: entryAdmission.audit.ownedExecutedRows,
            requiredControls: entryAdmission.audit.requiredNewControlOrders,
            availableControls: entryAdmission.availableControlOrders,
          },
        ),
      ])
      return livePosition
    }
    pushStep(
      livePosition,
      "entry_protection_admission",
      true,
      `ownedRows=${entryAdmission.audit.ownedExecutedRows}; controlsAvailable=${entryAdmission.availableControlOrders}; controlsReserved=${entryAdmission.audit.requiredNewControlOrders}`,
    )

    // The admission audit proves protection ownership, but it does not reserve
    // notional. A different worker may have filled the same symbol/direction
    // while the audit was running. Refresh the authoritative venue position
    // under the connection-wide lease immediately before margin/leverage or
    // entry submission, then round down on the exact venue quantity grid.
    // This is the final boundary against the high-volume X02 failure mode.
    if (process.env.NODE_ENV !== "test") {
      try {
        const exposureConnection = { ...lockedSettings, id: connectionId }
        const venueExposure = await resolveLiveOrderExposureCeiling(
          {
            connectionId,
            symbol: realPosition.symbol,
            side: realPosition.direction,
            positionDirection: realPosition.direction,
            quantity: computedVolume,
            connection: exposureConnection,
            marketType: livePosition.marketType,
            lotSize: livePosition.lotSize,
            quoteToUsdRate: livePosition.quoteToUsdRate,
            positionCostPercentOverride: livePosition.positionCostPct,
            maxExecutionNotionalUsd,
            source: executionIntent === "direct"
              ? "direct-trade"
              : executionIntent === "preset"
                ? "preset-trade"
                : executionIntent === "signal"
                  ? "signal-trade"
                  : "main-trade",
            liveTradeIntent: executionIntent,
          } as any,
          exposureConnection,
          exchangeConnector,
          realPosition.symbol,
          currentPrice,
        )
        const bounded = quantityWithinRemainingNotional(
          livePosition,
          computedVolume,
          currentPrice,
          liveInstrumentRules,
          venueExposure.maxNotionalUsd,
        )
        if (!(bounded.quantity > 0)) {
          livePosition.status = "rejected"
          livePosition.executionMode = "blocked"
          livePosition.executionBlockCode = "live_exposure_ceiling_reached"
          livePosition.executionBlockReason = "Remaining venue PositionCost budget is below the executable quantity minimum"
          livePosition.statusReason = livePosition.executionBlockReason
          pushStep(livePosition, "live_exposure_admission", false, livePosition.statusReason)
          await savePosition(livePosition)
          await incrementMetric(connectionId, "live_orders_blocked_count")
          return livePosition
        }
        liveSubmissionNotionalCeiling = venueExposure.maxNotionalUsd
        if (bounded.quantity + 1e-12 < computedVolume) {
          computedVolume = bounded.quantity
          volumeNote = ` [venue-headroom: ${bounded.notionalUsd.toFixed(2)} USD]`
          pushStep(
            livePosition,
            "live_exposure_admission",
            true,
            `venue-confirmed remaining=${venueExposure.maxNotionalUsd.toFixed(2)} USD; qty reduced to ${computedVolume}`,
          )
        } else {
          pushStep(
            livePosition,
            "live_exposure_admission",
            true,
            `venue-confirmed remaining=${venueExposure.maxNotionalUsd.toFixed(2)} USD; qty=${computedVolume}`,
          )
        }
        livePosition.quantity = computedVolume
        livePosition.remainingQuantity = computedVolume
        livePosition.volumeUsd = positionNotionalUsd(livePosition, computedVolume, currentPrice)
      } catch (error) {
        livePosition.status = "rejected"
        livePosition.executionMode = "blocked"
        livePosition.executionBlockCode = "live_exposure_snapshot_unavailable"
        livePosition.executionBlockReason = error instanceof Error
          ? error.message
          : "Authoritative venue exposure snapshot unavailable"
        livePosition.statusReason = livePosition.executionBlockReason
        pushStep(livePosition, "live_exposure_admission", false, livePosition.statusReason)
        await savePosition(livePosition)
        await incrementMetric(connectionId, "live_orders_blocked_count")
        return livePosition
      }
    }

    const positionMode = String(
      (lockedSettings as any).position_mode
      || (lockedSettings as any).positionMode
      || "",
    ).toLowerCase()
    const hedgeMode = positionMode.includes("hedge") || positionMode.includes("dual")
    const nativeForexProtection = (() => {
      if (livePosition.marketType !== "forex" || typeof exchangeConnector?.getCapabilities !== "function") return {}
      try {
        const capabilities = exchangeConnector.getCapabilities()
        if (!Array.isArray(capabilities) || !capabilities.includes("native_position_sl_tp")) return {}
        const initial = computeDesiredProtectionPrices(livePosition)
        const direction = resolveLivePositionDirection(livePosition)
        const sl = normalizeProtectionTriggerPrice(
          initial.desiredSl,
          Number(livePosition.priceTick || 0),
          direction,
          "stop_loss",
        )
        const tp = normalizeProtectionTriggerPrice(
          initial.desiredTp,
          Number(livePosition.priceTick || 0),
          direction,
          "take_profit",
        )
        return {
          ...(sl > 0 ? { stopLossPrice: sl } : {}),
          ...(tp > 0 ? { takeProfitPrice: tp } : {}),
        }
      } catch {
        return {}
      }
    })()
    const entryOrderOptions = hedgeMode
      ? {
          hedgeMode: true,
          positionSide: (realPosition.direction === "long" ? "LONG" : "SHORT") as "LONG" | "SHORT",
          clientOrderId: orderTrace.exchangeTrackingId,
          ...nativeForexProtection,
        }
      : {
          hedgeMode: false,
          clientOrderId: orderTrace.exchangeTrackingId,
          ...nativeForexProtection,
        }

    // Margin/leverage are physical-slot venue mutations. They belong after
    // exact ownership, control coverage, capacity, and stopped-engine gates.
    const marginTypeSetting = (
      (lockedSettings as any).margin_type as "cross" | "isolated"
    ) || "cross"
    livePosition.marginType = marginTypeSetting
    try {
      const configured = await setupLiveOrderMarginAndLeverage(
        exchangeConnector,
        realPosition.symbol,
        { marginType: marginTypeSetting, leverage: livePosition.leverage },
      )
      pushStep(
        livePosition,
        "set_margin_type",
        true,
        configured.marginConfigured ? `margin=${configured.marginType}` : "connector has no margin-mode endpoint",
      )
      pushStep(
        livePosition,
        "set_leverage",
        true,
        configured.leverageConfigured ? `leverage=${livePosition.leverage}` : "leverage=1 or connector has no leverage endpoint",
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      livePosition.status = "error"
      livePosition.statusReason = `Exchange entry preflight failed before placement: ${reason}`
      pushStep(livePosition, "set_margin_type", false, livePosition.statusReason)
      pushStep(livePosition, "set_leverage", false, livePosition.statusReason)
      await savePosition(livePosition)
      await Promise.all([
        incrementMetric(connectionId, "live_orders_failed_count"),
        incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "failed"),
        logProgressionEvent(connectionId, "live_trading", "error", livePosition.statusReason, {
          symbol: realPosition.symbol,
          direction: realPosition.direction,
          marginType: marginTypeSetting,
          leverage: livePosition.leverage,
        }),
      ])
      return livePosition
    }
    if (await abortSuperseded()) return livePosition

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
    if (await abortSuperseded()) {
      await savePosition(livePosition).catch(() => {})
      return livePosition
    }

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
    let lastSubmittedEntryQuantity = computedVolume
    const submitEntryQuantity = async (requestedQuantity: number, label: string): Promise<any> => {
      if (!await isCurrent()) {
        return {
          success: false,
          error: "Execution generation superseded before exchange submission",
          errorCode: "EXECUTION_SUPERSEDED",
        }
      }
      let safeQuantity = Number(requestedQuantity)
      if (process.env.NODE_ENV !== "test") {
        const exposureConnection = { ...lockedSettings, id: connectionId }
        const venueExposure = await resolveLiveOrderExposureCeiling(
          {
            connectionId,
            symbol: realPosition.symbol,
            side: realPosition.direction,
            positionDirection: realPosition.direction,
            quantity: requestedQuantity,
            connection: exposureConnection,
            marketType: livePosition.marketType,
            lotSize: livePosition.lotSize,
            quoteToUsdRate: livePosition.quoteToUsdRate,
            positionCostPercentOverride: livePosition.positionCostPct,
            maxExecutionNotionalUsd,
            source: executionIntent === "direct"
              ? "direct-trade"
              : executionIntent === "preset"
                ? "preset-trade"
                : executionIntent === "signal"
                  ? "signal-trade"
                  : "main-trade",
            liveTradeIntent: executionIntent,
          } as any,
          exposureConnection,
          exchangeConnector,
          realPosition.symbol,
          currentPrice,
        )
        const bounded = quantityWithinRemainingNotional(
          livePosition,
          requestedQuantity,
          currentPrice,
          liveInstrumentRules,
          venueExposure.maxNotionalUsd,
        )
        if (!(bounded.quantity > 0)) {
          throw new Error(
            `LIVE_EXPOSURE: requested entry quantity no longer fits the venue PositionCost budget (remaining=${venueExposure.maxNotionalUsd.toFixed(2)} USD)`,
          )
        }
        safeQuantity = bounded.quantity
        liveSubmissionNotionalCeiling = venueExposure.maxNotionalUsd
      }
      if (!(safeQuantity > 0) || !Number.isFinite(safeQuantity)) {
        throw new Error("LIVE_EXPOSURE: no finite executable entry quantity remains")
      }
      lastSubmittedEntryQuantity = safeQuantity
      if (safeQuantity !== requestedQuantity) {
        livePosition.quantity = safeQuantity
        livePosition.remainingQuantity = safeQuantity
        livePosition.volumeUsd = positionNotionalUsd(livePosition, safeQuantity, currentPrice)
        pushStep(
          livePosition,
          "live_exposure_retry_cap",
          true,
          `${label}: venue-confirmed quantity ${requestedQuantity} → ${safeQuantity}`,
        )
        await savePosition(livePosition)
        await persistCriticalLiveState(`entry-quantity:${livePosition.id}`)
      }
      placeAttempt += 1
      const { raw } = await withLiveOrderLogging(
        orderTrace,
        {
          quantity: safeQuantity,
          price: currentPrice,
          leverage: livePosition.leverage,
          marginType: livePosition.marginType ?? "unknown",
          orderType: "market",
          options: entryOrderOptions,
          strategySetKey: livePosition.setKey,
          realPositionId: realPosition.id,
          attempt: placeAttempt,
          label,
        },
        async () => {
          if (!await isCurrent()) {
            return {
              success: false,
              error: "Execution generation superseded before exchange submission",
              errorCode: "EXECUTION_SUPERSEDED",
            }
          }
          await assertMarginCallEntryAllowed(connectionId, exchangeConnector)
          exchangeSubmissionStarted = true
          return exchangeConnector.placeOrder(
            realPosition.symbol,
            exchangeSide,
            safeQuantity,
            undefined,
            "market",
            entryOrderOptions,
          )
        },
      )
      return raw
    }
    let orderResult: any = await retry(
      () => submitEntryQuantity(computedVolume, "primary"),
      (r: any) => !!r?.success,
      "placeOrder",
      3,
      isCurrent,
    )
    if (await abortSuperseded()) {
      await savePosition(livePosition).catch(() => {})
      return livePosition
    }

    // ── Volume reduction on 101204 (Insufficient margin) ────────────────
    // Leverage is kept at its maximum value — never reduced. When the
    // exchange rejects with "Insufficient margin" we instead halve the
    // position volume and retry ONCE at the same leverage. Halving volume
    // halves the required margin while keeping the leverage multiplier
    // (and therefore the per-unit notional gain) intact. If the halved
    // volume still fails, we fall back to the exchange minimum quantity at
    // the same leverage, which represents the absolute smallest notional
    // with the best leverage efficiency.
    if (await isCurrent() && !orderResult?.success && isNonRecoverableExchangeError(orderResult)) {
      const reducedVolumeRaw = computedVolume / 2
      const reducedVolume = normalizeRetryEntryQuantity(reducedVolumeRaw, false)
      // Ensure the halved volume is meaningfully smaller (> 0.1% diff) and positive.
      const volumeDiffPct = computedVolume > 0 ? Math.abs(reducedVolume - computedVolume) / computedVolume : 0
      if (reducedVolume > 0 && volumeDiffPct > 0.001) {
        console.warn(
          `${LOG_PREFIX} 101204 on ${realPosition.symbol} — retrying with halved volume ` +
          `${computedVolume.toFixed(6)} → ${reducedVolume.toFixed(6)} (leverage kept at ${livePosition.leverage}x)`,
        )

        const retryResult: any = await retry(
          () => submitEntryQuantity(reducedVolume, "volume-halved"),
          (r: any) => !!r?.success && !!(r.orderId || r.id),
          "placeOrder-reducedVol",
          1, // single retry — we already tried 3× above at original volume
          isCurrent,
        )
        if (await abortSuperseded()) {
          await savePosition(livePosition).catch(() => {})
          return livePosition
        }

        if (retryResult?.success && (retryResult.orderId || retryResult.id)) {
          // Succeeded with reduced volume at max leverage — update position and continue.
          computedVolume = lastSubmittedEntryQuantity
          livePosition.quantity = lastSubmittedEntryQuantity
          livePosition.remainingQuantity = lastSubmittedEntryQuantity
          livePosition.volumeUsd = positionNotionalUsd(livePosition, lastSubmittedEntryQuantity, currentPrice)
          orderResult = retryResult
          console.log(
            `${LOG_PREFIX} Entry succeeded after volume reduction to ${lastSubmittedEntryQuantity.toFixed(6)} at ${livePosition.leverage}x for ${realPosition.symbol}`,
          )
        } else if (isNonRecoverableExchangeError(retryResult)) {
          // Both the original and halved-volume attempts failed with 101204.
          // Try one last time at the exchange minimum qty — still at max leverage.
          // Prefer the stored exchange minimum from the 101400 handler
          // (`settings:trading_pair:{sym}` → `min_order_size`). Fall back to $5/price.
          let minQtyForSymbol = livePosition.marketType === "forex"
            ? roundQuantityUp(
                Math.max(liveInstrumentRules.minQuantity, liveInstrumentRules.quantityStep),
                liveInstrumentRules,
              )
            : currentPrice > 0
              ? 5 / currentPrice
              : 0
          try {
            const redisClient = getRedisClient()
            if (redisClient) {
              const storedMin = await redisClient.hget(
                tradingPairKey(realPosition.symbol, connectionId),
                "min_order_size",
              )
              const parsedStoredMin = storedMin ? parseFloat(storedMin) : 0
              if (parsedStoredMin > 0) {
                minQtyForSymbol = livePosition.marketType === "forex"
                  ? roundQuantityUp(parsedStoredMin, liveInstrumentRules)
                  : parsedStoredMin
              }
            }
          } catch { /* non-critical; fall back to $5/price */ }

          // An exchange minimum must not be used as an upward override of the
          // approved live/VST notional ceiling after a margin rejection.
          minQtyForSymbol = normalizeRetryEntryQuantity(minQtyForSymbol, true)

          // Only attempt if the quantity is meaningfully different from what we already tried.
          const minQuantityDiffPct = reducedVolume > 0
            ? Math.abs(minQtyForSymbol - reducedVolume) / reducedVolume
            : 1
          if (await isCurrent() && minQtyForSymbol > 0 && minQuantityDiffPct > 0.001) {
            if (await abortSuperseded()) {
              await savePosition(livePosition).catch(() => {})
              return livePosition
            }
            console.warn(
              `${LOG_PREFIX} 101204 at half-volume still fails on ${realPosition.symbol} — ` +
              `trying min notional qty=${minQtyForSymbol.toFixed(8)} at ${livePosition.leverage}x (max leverage kept)`,
            )
            let minResult: any
            try {
              minResult = await submitEntryQuantity(minQtyForSymbol, "min-notional-max-lev")
            } catch (error) {
              minResult = {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                errorCode: "LIVE_EXPOSURE_RECHECK_FAILED",
              }
            }
            if (minResult?.success && (minResult.orderId || minResult.id)) {
              computedVolume = lastSubmittedEntryQuantity
              livePosition.quantity = lastSubmittedEntryQuantity
              livePosition.remainingQuantity = lastSubmittedEntryQuantity
              livePosition.volumeUsd = positionNotionalUsd(livePosition, lastSubmittedEntryQuantity, currentPrice)
              orderResult = minResult
              console.log(
                `${LOG_PREFIX} Entry succeeded at min-notional ${lastSubmittedEntryQuantity.toFixed(8)} at ${livePosition.leverage}x for ${realPosition.symbol}`,
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
      if (await isCurrent() && isMinOrderSizeError(reason) && placeAttempt < 3) {
        const minQty = extractMinOrderQty(reason)
        if (minQty && minQty > 0 && minQty > computedVolume) {
          retryWasAttempted = true
          try {
            if (await abortSuperseded()) {
              await savePosition(livePosition).catch(() => {})
              return livePosition
            }
            const { setSettings } = await import("@/lib/redis-db")
            
            // Save the corrected minimum for future cycles
            await setSettings(tradingPairKey(realPosition.symbol, connectionId), {
              min_order_size: minQty,
              updated_at: new Date().toISOString(),
              source: "101400_error_extraction",
            })
            
            console.warn(
              `${LOG_PREFIX} [101400 Correction] Detected minimum ${minQty} > current ${computedVolume.toFixed(8)} for ${realPosition.symbol}; retrying in same cycle`,
            )
            
            // Use minimum + 10% margin to ensure acceptance, but never above
            // the hard live/VST notional ceiling.
            const retryQty = normalizeRetryEntryQuantity(minQty * 1.1, true)
            if (!(retryQty > 0)) {
              retryWasAttempted = false
              throw new Error("minimum order quantity cannot fit the live/VST exposure ceiling after venue rounding")
            }
            console.log(
              `${LOG_PREFIX} [101400 Retry] Sending with margin: ${retryQty.toFixed(8)} (min: ${minQty.toFixed(8)} × 1.1)`,
            )

            // Retry immediately with corrected quantity
            if (await abortSuperseded()) {
              await savePosition(livePosition).catch(() => {})
              return livePosition
            }
            let retryOrderResult: any
            try {
              retryOrderResult = await submitEntryQuantity(retryQty, "min-order-correction")
            } catch (error) {
              retryOrderResult = {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                errorCode: "LIVE_EXPOSURE_RECHECK_FAILED",
              }
            }
            
            if (retryOrderResult?.success && (retryOrderResult?.orderId || retryOrderResult?.id)) {
              console.log(
                `${LOG_PREFIX} [101400 Retry] Successfully placed order with volume ${retryQty.toFixed(8)} for ${realPosition.symbol}`,
              )
              // Continue with the corrected order
              orderResult = retryOrderResult
              computedVolume = lastSubmittedEntryQuantity  // Use the quantity actually admitted and submitted
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
            retryWasAttempted = false
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
    // After all three layers, an unconfirmed quantity remains pending. Never
    // synthesize a fill from the requested quantity: doing so can over-size
    // protection and can make the UI report a position the venue never filled.
    const inlineFillQty   = parseFloat(String(orderResult.filledQty  ?? orderResult.executedQty ?? orderResult.cumQty   ?? "0")) || 0
    const inlineFillPrice = parseFloat(String(orderResult.filledPrice ?? orderResult.avgPrice ?? "0")) || 0
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
            if (Math.abs(exSize) > 0 && exEntry > 0) {
              console.log(`${LOG_PREFIX} getPosition() fallback fill for ${realPosition.symbol}: size=${exSize} entry=${exEntry} (attempt=${attempt + 1})`)
              fill = {
                filled: true,
                filledQty: Math.abs(exSize),
                filledPrice: exEntry,
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

    const entrySettlement = livePosition.orderId
      ? await readOrderSettlement(exchangeConnector, realPosition.symbol, livePosition.orderId)
      : null
    if (entrySettlement) {
      const settlementPrice = finitePositive(entrySettlement.averageFillPrice)
      const observedFillPrice = finitePositive(fill.filledPrice)
      const marketReferencePrice = finitePositive(currentPrice)
      const contemporaneousPrice =
        observedFillPrice > 0 &&
        marketReferencePrice > 0 &&
        priceDomainDistance(observedFillPrice, marketReferencePrice) >= 1.25
          ? marketReferencePrice
          : observedFillPrice || marketReferencePrice
      const settlementPriceRejected =
        contemporaneousPrice > 0 &&
        (!(settlementPrice > 0) || priceDomainDistance(settlementPrice, contemporaneousPrice) >= 1.25)
      const acceptedSettlementPrice = settlementPriceRejected
        ? contemporaneousPrice
        : settlementPrice
      if (settlementPriceRejected) {
        console.warn(
          `${LOG_PREFIX} Rejected cross-domain entry settlement price for ${realPosition.symbol}: ` +
          `settlement=${settlementPrice} reference=${contemporaneousPrice}`,
        )
      }
      fill = {
        filled: true,
        filledQty: entrySettlement.filledQuantity,
        filledPrice: acceptedSettlementPrice,
        status: settlementPriceRejected
          ? "filled_via_settlement_price_guard"
          : "filled_via_settlement",
      }
    }

    if (fill.filled && fill.filledQty > 0 && fill.filledPrice > 0) {
      const authoritativeFillPrice = finitePositive(fill.filledPrice)
      livePosition.executedQuantity = fill.filledQty
      livePosition.remainingQuantity = Math.max(0, computedVolume - fill.filledQty)
      livePosition.entryPrice = authoritativeFillPrice
      livePosition.averageExecutionPrice = authoritativeFillPrice
      reconcileInitialEntryBaseQuantity(livePosition, fill.filledQty)
      if (specialPositionPlan) {
        livePosition.specialBaseQuantity = fill.filledQty / specialPositionPlan.totalVolumeRatio
        applySpecialPlanToPosition(livePosition, specialPositionPlan)
      }
      livePosition.totalExecutedQuantity = Math.max(
        Number(livePosition.totalExecutedQuantity || 0),
        fill.filledQty,
      )
      livePosition.initialEntryPrice ??= authoritativeFillPrice
      initializeIndependentBlockSeed(
        livePosition,
        realPosition,
        fill.filledQty,
        orderTrace.exchangeTrackingId,
        livePosition.orderId,
      )
      if (livePosition.combinedPosCounts) {
        livePosition.posCountsSetQuantities = allocatePositionSetQuantities(
          livePosition,
          fill.filledQty,
          livePosition.accumulatedSetKeys,
        )
      }
      livePosition.fills!.push({
        orderId: livePosition.orderId,
        settlementSource: entrySettlement?.source,
        timestamp: Date.now(),
        quantity: fill.filledQty,
        price: authoritativeFillPrice,
        fee: Math.max(0, Number(entrySettlement?.tradingFee) || 0),
        feeAsset: "USDT",
      })
      livePosition.entryTradingFee = Math.max(0, Number(entrySettlement?.tradingFee) || 0)
      livePosition.entryTradingFeeAllocated = 0
      livePosition.entryAccountingComplete = Boolean(entrySettlement)
      livePosition.entrySettlementOrderIds = entrySettlement ? [entrySettlement.orderId] : []
      livePosition.realizedPnlComplete = true
      livePosition.realizedPnlSource = entrySettlement
        ? "exchange_settlement"
        : "exchange_fills_incomplete_fees"
      livePosition.status = livePosition.remainingQuantity <= 0.000001 ? "filled" : "partially_filled"
      livePosition.statusReason = fill.status === "filled_via_position"
        ? `confirmed_position_fallback: exchange position size=${fill.filledQty} avg=${authoritativeFillPrice}`
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
        averagePrice: authoritativeFillPrice,
        reason: `fill via=${fill.status}`,
        extra: { orderId: livePosition.orderId, attempts: placeAttempt },
      })
      // Persist the authoritative fill before protection coordination. Parallel
      // Set entries for the same symbol/direction can now see one another.
      // Every row still arms exact-quantity SL/TP; aggregate reconciliation
      // only elects the separate aggregate-quantity security-stop owner.
      await savePosition(livePosition)
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
            const nativeTicket = Number(
              (exPos as any).positionTicket ??
              (exPos as any).ticket ??
              (exPos as any).exchangePositionId,
            )
            if (Number.isInteger(nativeTicket) && nativeTicket > 0) {
              livePosition.positionTicket = nativeTicket
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
      const initialProtection = computeDesiredProtectionPrices(livePosition)
      const protectionDirection = resolveLivePositionDirection(livePosition)
      const priceTick = Number(livePosition.priceTick || 0)
      const slPrice = normalizeProtectionTriggerPrice(
        initialProtection.desiredSl,
        priceTick,
        protectionDirection,
        "stop_loss",
      )
      const tpPrice = normalizeProtectionTriggerPrice(
        initialProtection.desiredTp,
        priceTick,
        protectionDirection,
        "take_profit",
      )

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
      const initialLiveOrderIds = await fetchLiveOrderIdSet(exchangeConnector)
      const initialCapacityBudget = protectionCapacityBudgetOf(initialLiveOrderIds)
      const slCapacity = slPrice > 0 && !livePosition.stopLossOrderId
        ? reserveProtectionCapacity(initialCapacityBudget, livePosition, "stop_loss")
        : { allowed: false, reservationId: "" }
      const tpCapacity = tpPrice > 0 && !livePosition.takeProfitOrderId
        ? reserveProtectionCapacity(initialCapacityBudget, livePosition, "take_profit")
        : { allowed: false, reservationId: "" }
      const slClientOrderId = slPrice > 0 && !livePosition.stopLossOrderId && slCapacity.allowed
        ? await prepareProtectionSubmission(livePosition, "stopLoss", slPrice, livePosition.executedQuantity)
        : undefined
      const tpClientOrderId = tpPrice > 0 && !livePosition.takeProfitOrderId && tpCapacity.allowed
        ? await prepareProtectionSubmission(livePosition, "takeProfit", tpPrice, livePosition.executedQuantity)
        : undefined
      const [slPlacement, tpPlacement] = await Promise.all([
        (slPrice > 0 && !livePosition.stopLossOrderId && slCapacity.allowed)
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
          : Promise.resolve({
              orderId: livePosition.stopLossOrderId || (slPrice > 0 ? "SYSTEM_FALLBACK" : null),
              armedQuantity: livePosition.stopLossOrderId
                ? protectionLegArmedQuantity(livePosition, "stop_loss")
                : 0,
            }),
        (tpPrice > 0 && !livePosition.takeProfitOrderId && tpCapacity.allowed)
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
          : Promise.resolve({
              orderId: livePosition.takeProfitOrderId || (tpPrice > 0 ? "SYSTEM_FALLBACK" : null),
              armedQuantity: livePosition.takeProfitOrderId
                ? protectionLegArmedQuantity(livePosition, "take_profit")
                : 0,
            }),
      ])
      const slOrderId = slPlacement.orderId
      const tpOrderId = tpPlacement.orderId

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
        initialCapacityBudget?.markExhausted()
        livePosition.protectionMode = "system_close_fallback"
        if (slOrderId === "QUOTA_EXCEEDED" && livePosition.pendingProtectionOrders) {
          delete livePosition.pendingProtectionOrders.stopLoss
        }
        if (tpOrderId === "QUOTA_EXCEEDED" && livePosition.pendingProtectionOrders) {
          delete livePosition.pendingProtectionOrders.takeProfit
        }
      }

      const slIdValid = slOrderId && slOrderId !== "PRICE_CROSSED" && slOrderId !== "position_exhausted" && slOrderId !== "QUOTA_EXCEEDED" && slOrderId !== "SYSTEM_FALLBACK"
      const tpIdValid = tpOrderId && tpOrderId !== "PRICE_CROSSED" && tpOrderId !== "position_exhausted" && tpOrderId !== "QUOTA_EXCEEDED" && tpOrderId !== "SYSTEM_FALLBACK"

      if (slIdValid) {
        livePosition.stopLossOrderId = slOrderId!
        livePosition.stopLossPrice = slPrice
        setProtectionLegArmedQuantity(livePosition, "stop_loss", slPlacement.armedQuantity)
        if (livePosition.pendingProtectionOrders) delete livePosition.pendingProtectionOrders.stopLoss
        setSystemProtectionLeg(livePosition, "stop_loss", false)
      } else {
        releaseProtectionCapacityReservation(initialCapacityBudget, livePosition, slCapacity.reservationId)
        setProtectionLegArmedQuantity(livePosition, "stop_loss", 0)
      }
      if (slPrice > 0 && slOrderId !== "QUOTA_EXCEEDED" && slOrderId !== "SYSTEM_FALLBACK" && !slIdValid) {
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
        setProtectionLegArmedQuantity(livePosition, "take_profit", tpPlacement.armedQuantity)
        if (livePosition.pendingProtectionOrders) delete livePosition.pendingProtectionOrders.takeProfit
        setSystemProtectionLeg(livePosition, "take_profit", false)
      } else {
        releaseProtectionCapacityReservation(initialCapacityBudget, livePosition, tpCapacity.reservationId)
        setProtectionLegArmedQuantity(livePosition, "take_profit", 0)
      }
      if (tpPrice > 0 && tpOrderId !== "QUOTA_EXCEEDED" && tpOrderId !== "SYSTEM_FALLBACK" && !tpIdValid) {
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
      if (slIdValid || tpIdValid) {
        refreshLegacyProtectionArmedQuantity(livePosition)
        // Prime the cooldown so the first 30 s of reconcile ticks cannot
        // drift-cancel-replace orders we just placed milliseconds ago.
        const nowMs = Date.now()
        if (slIdValid) livePosition.stopLossLastArmedAt = nowMs
        if (tpIdValid) livePosition.takeProfitLastArmedAt = nowMs
      }
      refreshProtectionHandlingMode(livePosition, slPrice, tpPrice)
      if (initialCapacityBudget) livePosition.controlOrderCapacity = initialCapacityBudget.snapshot()
      const slVenueOrderId = slIdValid ? String(slOrderId) : null
      const tpVenueOrderId = tpIdValid ? String(tpOrderId) : null

      // Step record + progression log carry BOTH the assigned percent
      // and the resulting absolute trigger price, so an operator
      // reading the timeline never has to mentally reconstruct one
      // from the other. `assignedStopLoss`/`assignedTakeProfit` and
      // `stopLoss`/`takeProfit` are equal at this point (initial
      // placement); on later overrides the message will show both.
      pushStep(
        livePosition,
        "place_sl_tp",
        Boolean(slVenueOrderId || tpVenueOrderId || livePosition.systemProtectionLegs?.length),
        `SL ${livePosition.stopLoss}% → ${slPrice ? slPrice.toFixed(6) : "—"} (${slVenueOrderId || (slPrice > 0 ? "system" : "—")}) | ` +
        `TP ${livePosition.takeProfit}% → ${tpPrice ? tpPrice.toFixed(6) : "—"} (${tpVenueOrderId || (tpPrice > 0 ? "system" : "—")})`
      )
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "info",
        `SL/TP handling coordinated for ${realPosition.symbol} at assigned values`,
        {
          // Assigned (immutable strategy contract) and current
          // (mutable, override-aware) percent pairs — equal on first
          // placement, can diverge after `recalculateAndApplySLTP`.
          assignedStopLossPct: livePosition.assignedStopLoss,
          assignedTakeProfitPct: livePosition.assignedTakeProfit,
          stopLossPct: livePosition.stopLoss,
          takeProfitPct: livePosition.takeProfit,
          slOrderId: slVenueOrderId,
          slPrice,
          tpOrderId: tpVenueOrderId,
          tpPrice,
          fillPrice: livePosition.averageExecutionPrice,
          protectionMode: livePosition.protectionMode,
          systemProtectionLegs: livePosition.systemProtectionLegs,
          controlOrderCapacity: livePosition.controlOrderCapacity,
        },
      )

      const rowQuantityTolerance = Math.max(
        1e-10,
        Number(livePosition.quantityStep || 0) / 2,
        Number(livePosition.executedQuantity || 0) * 1e-8,
      )
      const rowProtectionComplete = Boolean(slVenueOrderId && tpVenueOrderId)
        && Math.abs(
          protectionLegArmedQuantity(livePosition, "stop_loss")
          - Number(livePosition.executedQuantity || 0)
        ) <= rowQuantityTolerance
        && Math.abs(
          protectionLegArmedQuantity(livePosition, "take_profit")
          - Number(livePosition.executedQuantity || 0)
        ) <= rowQuantityTolerance
      if (!rowProtectionComplete) {
        await rollbackEntryWithoutCompleteProtection(
          "Initial entry did not receive its exact-quantity venue Stop Loss and Take Profit",
          [
            ...(!slVenueOrderId ? ["entry_stop_loss_missing"] : []),
            ...(!tpVenueOrderId ? ["entry_take_profit_missing"] : []),
            "entry_row_protection_quantity_unverified",
          ],
        )
        return livePosition
      }
    } else {
      pushStep(livePosition, "place_sl_tp", false, "skipped — no fill yet")
      // A response-ambiguous market entry may already have reached the venue.
      // Never open another row behind it. Reconciliation keeps recovering this
      // exact client/order id and will arm protection as soon as quantity is
      // authoritative; the halt expires only as a last-resort operator guard.
      await client.setex(
        entryProtectionHaltKey,
        24 * 60 * 60,
        JSON.stringify({ at: Date.now(), reason: "entry_fill_unconfirmed" }),
      ).catch(() => {})
      livePosition.statusReason =
        "Entry fill is unconfirmed; new entries halted until exact recovery and protection reconciliation"
      await savePosition(livePosition)
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "error",
        livePosition.statusReason,
        { symbol: realPosition.symbol, direction: realPosition.direction },
      ).catch(() => {})
      return livePosition
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
            ...(livePosition.exchangeData || {}),
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

    // Persist the confirmed row controls, then immediately reconcile the
    // physical slot so its single aggregate-quantity security stop is not deferred to
    // a later scheduler tick.
    let initialSecurityReconcileFailed = false
    if (livePosition.executedQuantity > 0 && typeof exchangeConnector.getPositions === "function") {
      await savePosition(livePosition)
      try {
        const [allRows, venueRows, orderIds] = await Promise.all([
          getLivePositions(connectionId),
          exchangeConnector.getPositions(),
          fetchLiveOrderIdSet(exchangeConnector),
        ])
        const venueSnapshotOk = typeof exchangeConnector.getLastPositionsSnapshotStatus === "function"
          ? exchangeConnector.getLastPositionsSnapshotStatus()?.ok === true
          : Array.isArray(venueRows)
        if (!venueSnapshotOk || !Array.isArray(venueRows) || orderIds === null) {
          throw new Error("authoritative position/order snapshot unavailable for initial security stop")
        }
        const rowsById = new Map(allRows.map((row) => [row.id, row]))
        rowsById.set(livePosition.id, livePosition)
        await reconcileAggregateProtectionBook(
          connectionId,
          exchangeConnector,
          [...rowsById.values()],
          venueRows,
          orderIds,
        )
        const refreshed = await readLivePositionSnapshot(client, connectionId, livePosition.id)
        if (refreshed) Object.assign(livePosition, refreshed)
      } catch (error) {
        initialSecurityReconcileFailed = true
        pushStep(
          livePosition,
          "initial_security_reconcile",
          false,
          error instanceof Error ? error.message : String(error),
        )
      }
    }

    if (livePosition.executedQuantity > 0) {
      let finalAdmission: EntryProtectionAdmissionDecision | null = null
      try {
        finalAdmission = await auditEntryProtectionBeforeVenueMutation({
          connectionId,
          symbol: realPosition.symbol,
          direction: realPosition.direction,
          connector: exchangeConnector,
          requireCapacity: false,
        })
      } catch (error) {
        console.warn(
          `${LOG_PREFIX} post-entry protection verification failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (initialSecurityReconcileFailed || !finalAdmission?.safe) {
        await rollbackEntryWithoutCompleteProtection(
          "Post-entry venue audit could not prove row TP/SL plus full-slot security protection",
          [
            ...(initialSecurityReconcileFailed ? ["entry_security_reconcile_failed"] : []),
            ...(finalAdmission?.violations || ["post_entry_authoritative_audit_unavailable"]),
          ],
        )
        return livePosition
      }
      await client.del(entryProtectionHaltKey).catch(() => 0)
      pushStep(
        livePosition,
        "entry_protection_verified",
        true,
        `rowControls=2; securityControls=1; ownedRows=${finalAdmission.audit.ownedExecutedRows}`,
      )
    }

    // ── ENTRY SUMMARY — one log line showing the complete entry state ────────
    // Operator can grep "[ENTRY]" to see every live position that went through
    // the full pipeline and understand volume / leverage / protection in context.
    {
      const summaryProtection = computeDesiredProtectionPrices(livePosition)
      const summaryDirection = resolveLivePositionDirection(livePosition)
      const summaryTick = Number(livePosition.priceTick || 0)
      const sumSl = normalizeProtectionTriggerPrice(
        summaryProtection.desiredSl,
        summaryTick,
        summaryDirection,
        "stop_loss",
      )
      const sumTp = normalizeProtectionTriggerPrice(
        summaryProtection.desiredTp,
        summaryTick,
        summaryDirection,
        "take_profit",
      )
      console.log(
        `${LOG_PREFIX} [ENTRY] ${realPosition.symbol} ${realPosition.direction?.toUpperCase()} ` +
        `qty=${livePosition.executedQuantity?.toFixed(6) ?? "?"} ` +
        `@ ${livePosition.averageExecutionPrice?.toFixed(6) ?? "?"} ` +
        `notional=$${livePosition.volumeUsd?.toFixed(2) ?? "?"} ` +
        `lev=${livePosition.leverage ?? "?"}x ` +
        `orderId=${livePosition.orderId ?? "?"} ` +
        `SL=${sumSl > 0 ? sumSl.toFixed(6) : "none"} (id=${livePosition.stopLossOrderId ?? "—"}) ` +
        `TP=${sumTp > 0 ? sumTp.toFixed(6) : "none"} (id=${livePosition.takeProfitOrderId ?? "—"}) ` +
        `SEC=${Number(livePosition.securityStopPrice || 0) > 0 ? Number(livePosition.securityStopPrice).toFixed(6) : "pending"} ` +
        `(id=${livePosition.securityStopOrderId ?? "—"}) ` +
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
  } finally {
    await releaseEntryProtectionAdmissionLock()
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
  const lockId = `fill:${process.pid}:${Date.now()}:${nanoid(8)}`
  let mutationLockHeld = false
  let stopLockLeaseRefresh: (() => void) | null = null

  try {
    // Fill webhooks and exchange reconciliation can arrive concurrently. The
    // same position lock used by close/quantity coordination makes the
    // read→dedupe→aggregate→persist transition one owner at a time.
    if (!await acquirePositionMutationLock(connectionId, livePositionId, lockId)) return null
    mutationLockHeld = true
    stopLockLeaseRefresh = startRedisLockLeaseRefresh(
      client,
      positionMutationLockKey(connectionId, livePositionId),
      lockId,
      POSITION_MUTATION_LOCK_TTL_MS,
    )

    const position = await readLivePositionSnapshot(client, connectionId, livePositionId)
    if (!position) return null
    if (position.connectionId && position.connectionId !== connectionId) return null
    position.connectionId ||= connectionId

    const fillQuantity = Number(fill?.quantity)
    const fillPrice = Number(fill?.price)
    if (!Number.isFinite(fillQuantity) || fillQuantity <= 0 || !Number.isFinite(fillPrice) || fillPrice <= 0) {
      return null
    }

    const fills = Array.isArray(position.fills) ? position.fills : []
    const normalizedFill = {
      ...fill,
      quantity: fillQuantity,
      price: fillPrice,
    }
    const fillPriceKey = (value: unknown): string => {
      const number = Number(value)
      return Number.isFinite(number) ? number.toPrecision(15) : String(value ?? "")
    }
    const fillQuantityKey = fillPriceKey
    const fillIdentity = (value: typeof normalizedFill): string => {
      const explicit = String(
        (value as any).id ?? (value as any).fillId ?? (value as any).tradeId ?? "",
      ).trim()
      if (explicit) return `id:${explicit}`
      return [
        String(value.orderId || "").trim(),
        fillPriceKey(value.price),
        fillQuantityKey(value.quantity),
        String(value.timestamp ?? ""),
        fillPriceKey(value.fee ?? 0),
      ].join("|")
    }
    const identity = fillIdentity(normalizedFill)
    if (fills.some((existing) => fillIdentity(existing as typeof normalizedFill) === identity)) {
      // Idempotent webhook retry: return the canonical current state without
      // incrementing executed quantity, fills, version, or Redis write load.
      return position
    }

    const currentStatus = String(position.status || "").trim().toLowerCase()
    if (
      ["closed", "rejected", "cancelled", "canceled", "expired", "error"].includes(currentStatus) ||
      (currentStatus === "filled" && Number(position.remainingQuantity || 0) <= 0)
    ) {
      return position
    }

    const previousExecuted = Math.max(0, Number(position.executedQuantity) || 0)
    const previousAverage = Math.max(
      0,
      Number(position.averageExecutionPrice) || Number(position.entryPrice) || 0,
    )
    const priorFillQuantity = fills.reduce((sum, item) => sum + Math.max(0, Number(item.quantity) || 0), 0)
    const priorFillCost = fills.reduce(
      (sum, item) => sum + Math.max(0, Number(item.price) || 0) * Math.max(0, Number(item.quantity) || 0),
      0,
    )
    const accountedQuantity = previousExecuted > 0 ? previousExecuted : priorFillQuantity
    const accountedCost = previousExecuted > 0
      ? previousExecuted * previousAverage
      : priorFillCost
    const executedQuantity = accountedQuantity + fillQuantity

    position.fills = [...fills, normalizedFill]
    position.executedQuantity = executedQuantity
    position.remainingQuantity = Math.max(0, Number(position.quantity || 0) - executedQuantity)
    position.averageExecutionPrice = executedQuantity > 0
      ? (accountedCost + fillPrice * fillQuantity) / executedQuantity
      : fillPrice

    if (position.remainingQuantity <= 0) {
      position.status = "filled"
    } else if (position.executedQuantity > 0) {
      position.status = "partially_filled"
    }
    position.updatedAt = Date.now()

    // savePosition writes both the canonical hash and compatibility mirror,
    // refreshes lifecycle/tracking indexes, and applies the position-specific
    // retention policy. The old path only updated the JSON key, which made
    // restart stats and control-order reconciliation diverge from the webhook.
    await savePosition(position)
    return position
  } catch (err) {
    console.error(`${LOG_PREFIX} Error updating fill:`, err)
    return null
  } finally {
    stopLockLeaseRefresh?.()
    if (mutationLockHeld) {
      await releasePositionMutationLock(connectionId, livePositionId, lockId).catch(() => false)
    }
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

function controlOrderFillPrice(order: any): number {
  const value = Number(order?.filledPrice ?? order?.avgPrice ?? order?.averagePrice ?? 0)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function isTerminalSystemCloseOrder(order: any): boolean {
  if (!order) return false
  const status = controlOrderStatus(order)
  return isFilledControlOrderStatus(status) || ["cancelled", "canceled", "rejected", "expired"].includes(status)
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
  _fallbackPrice: number,
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

  const direction = resolveLivePositionDirection(position)
  if (!direction) {
    pushStep(position, "system_close_direction_guard", false, "No explicit long/short direction; control and close orders blocked")
    return { decision: "wait", detail: "invalid position direction" }
  }
  const initialQuantity = Math.max(0, Number(position.executedQuantity || position.quantity || 0))
  const observations: Array<{ id: string; source: PartialOrderExecutionSource; order: any }> = []
  const unresolvedClientIds = new Set<string>()

  // First recover response-lost control submissions by their durable client id.
  for (const leg of ["stopLoss", "takeProfit", "securityStop"] as const) {
    const pending = position.pendingProtectionOrders?.[leg]
    if (!pending?.clientOrderId) continue
    const recovered = await recoverEntryOrderByClientId(connector, position.symbol, pending.clientOrderId)
    if (recovered) {
      const orderId = String(recovered.orderId ?? recovered.id)
      if (leg === "stopLoss") position.stopLossOrderId = orderId
      else if (leg === "takeProfit") position.takeProfitOrderId = orderId
      else position.securityStopOrderId = orderId
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
    [position.stopLossOrderId, position.takeProfitOrderId, position.securityStopOrderId]
      .map(String)
      .filter((id) => id && id !== "undefined"),
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
    const settlement = filledObservation?.id
      ? await readOrderSettlement(connector, position.symbol, filledObservation.id)
      : null
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
      price: controlOrderFillPrice(observedOrder),
      settlement,
      orderId: filledObservation?.id,
      clientOrderId: filledObservation?.source === "system_close" ? action.clientOrderId : undefined,
    })
    if (filledObservation?.source === "system_close") action.appliedFilledQuantity = applied.cumulativeApplied
  }

  // A flat position does not by itself prove response-lost control writes are
  // settled. Continue through owned-order cancellation and authoritative
  // open-order absence below before allowing terminal archival; otherwise a
  // stale reduce-only trigger can survive and close the next CTS entry.

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
    for (const leg of ["stopLoss", "takeProfit", "securityStop"] as const) {
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
    setProtectionLegArmedQuantity(position, "stop_loss", 0)
  }
  if (!liveOrderIds || !position.takeProfitOrderId || !liveOrderIds.has(position.takeProfitOrderId)) {
    position.takeProfitOrderId = undefined
    position.takeProfitPrice = 0
    setProtectionLegArmedQuantity(position, "take_profit", 0)
  }
  if (!liveOrderIds || !position.securityStopOrderId || !liveOrderIds.has(position.securityStopOrderId)) {
    position.securityStopOrderId = undefined
    position.securityStopPrice = 0
    position.securityStopArmedQuantity = 0
    position.securityStopAbsenceConfirmations = 0
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

/**
 * Hand a physical symbol/direction slot from row/security protection to a
 * quantity-mutating worker without racing any still-live control order.
 * The caller persists a short-lived request and defers. The canonical
 * reconcile pass removes only control IDs recorded on CTS positions, keeps
 * every logical SL/TP active system-side, and suppresses aggregate re-arming
 * until the requesting worker has had a chance to finish.
 */
async function requestAggregateProtectionSlotMutation(
  connector: any,
  position: LivePosition,
  reason: string,
): Promise<boolean> {
  if (!connector) return true
  const direction = resolveLivePositionDirection(position)
  if (!direction) return false
  const slot = aggregateProtectionSlot(position.symbol, direction)
  const allPositions = await getLivePositions(position.connectionId)
  const related = allPositions.filter((candidate) =>
    aggregateProtectionSlot(candidate.symbol, resolveLivePositionDirection(candidate)) === slot
    && isExchangeLifecyclePosition(candidate, position.connectionId),
  )
  // A single logical row still owns a physical slot-level security stop, but
  // it does not need the multi-row hand-off round trip.  The quantity worker
  // can cancel/re-arm that row's security stop in the same bounded mutation
  // while multi-row slots continue through the queued aggregate finalizer.
  const aggregateCoordinated = related.length > 1 || related.some((candidate) =>
    Number(candidate.aggregateProtectionMemberCount || 0) > 1,
  )
  if (!aggregateCoordinated) {
    position.aggregateProtectionMutationRequestedAt = undefined
    position.aggregateProtectionMutationSettledAt = undefined
    position.aggregateProtectionMutationReason = undefined
    return true
  }

  // One row owns the slot hand-off at a time. This prevents two independent
  // Set workers from observing the same settled controls and mutating the net
  // venue quantity concurrently.
  const requesters = related
    .filter((candidate) => Number(candidate.aggregateProtectionMutationRequestedAt || 0) > 0)
    .sort((a, b) =>
      Number(a.aggregateProtectionMutationRequestedAt || 0)
      - Number(b.aggregateProtectionMutationRequestedAt || 0)
      || a.id.localeCompare(b.id),
    )
  const activeRequester = requesters[0]
  if (activeRequester && activeRequester.id !== position.id) {
    queueAggregateProtectionFinalization(position.connectionId, slot)
    position.systemProtectionLegs = configuredSystemProtectionLegs(position)
    position.protectionMode = position.stopLossOrderId || position.takeProfitOrderId
      ? "hybrid_control_system"
      : "system_close_fallback"
    pushStep(
      position,
      "aggregate_protection_mutation_wait",
      true,
      `${slot} quantity hand-off is owned by ${activeRequester.id}; ${reason} remains queued`,
    )
    await savePosition(position)
    return false
  }

  const aggregateControlsPresent = related.some((candidate) =>
    Boolean(candidate.stopLossOrderId)
    || Boolean(candidate.takeProfitOrderId)
    || Boolean(candidate.securityStopOrderId)
    || Boolean(candidate.pendingProtectionOrders?.stopLoss?.clientOrderId)
    || Boolean(candidate.pendingProtectionOrders?.takeProfit?.clientOrderId)
    || Boolean(candidate.pendingProtectionOrders?.securityStop?.clientOrderId),
  )

  if (activeRequester?.id === position.id) {
    position.aggregateProtectionKey = slot
    position.aggregateProtectionMemberCount = related.length
    position.aggregateProtectionMutationRequestedAt = activeRequester.aggregateProtectionMutationRequestedAt
    position.aggregateProtectionMutationSettledAt = activeRequester.aggregateProtectionMutationSettledAt
    position.aggregateProtectionMutationReason = activeRequester.aggregateProtectionMutationReason || reason
    queueAggregateProtectionFinalization(position.connectionId, slot)
    if (
      !aggregateControlsPresent
      && Number(activeRequester.aggregateProtectionMutationSettledAt || 0) > 0
    ) {
      // Adopt the authoritative post-settlement control snapshot before the
      // caller creates its durable quantity action.
      const current = related.find((candidate) => candidate.id === position.id) || activeRequester
      position.stopLossOrderId = current.stopLossOrderId
      position.takeProfitOrderId = current.takeProfitOrderId
      position.securityStopOrderId = current.securityStopOrderId
      position.pendingProtectionOrders = current.pendingProtectionOrders
      position.stopLossPrice = Number(current.stopLossPrice || 0)
      position.takeProfitPrice = Number(current.takeProfitPrice || 0)
      position.securityStopPrice = Number(current.securityStopPrice || 0)
      setProtectionLegArmedQuantity(position, "stop_loss", protectionLegArmedQuantity(current, "stop_loss"))
      setProtectionLegArmedQuantity(position, "take_profit", protectionLegArmedQuantity(current, "take_profit"))
      position.securityStopArmedQuantity = Number(current.securityStopArmedQuantity || 0)
      pushStep(
        position,
        "aggregate_protection_mutation_resume",
        true,
        `${slot} controls settled at ${activeRequester.aggregateProtectionMutationSettledAt}; resuming ${reason}`,
      )
      return true
    }

    position.systemProtectionLegs = configuredSystemProtectionLegs(position)
    position.protectionMode = position.stopLossOrderId || position.takeProfitOrderId
      ? "hybrid_control_system"
      : "system_close_fallback"
    pushStep(
      position,
      "aggregate_protection_mutation_wait",
      true,
      `${slot} row/security controls are still settling before ${reason}`,
    )
    await savePosition(position)
    return false
  }

  if (!aggregateControlsPresent) return true

  position.aggregateProtectionKey = slot
  position.aggregateProtectionMemberCount = related.length
  position.aggregateProtectionMutationRequestedAt = Date.now()
  position.aggregateProtectionMutationSettledAt = undefined
  position.aggregateProtectionMutationReason = reason
  queueAggregateProtectionFinalization(position.connectionId, slot)
  position.systemProtectionLegs = configuredSystemProtectionLegs(position)
  position.protectionMode = position.stopLossOrderId || position.takeProfitOrderId
    ? "hybrid_control_system"
    : "system_close_fallback"
  pushStep(
    position,
    "aggregate_protection_mutation_wait",
    true,
    `${slot} aggregate controls must settle before ${reason}; retrying on the next cycle`,
  )
  await savePosition(position)
  return false
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
  const direction = resolveLivePositionDirection(position)
  if (!direction) {
    pushStep(position, "quantity_change_direction_guard", false, `${reason}: invalid position direction`)
    return false
  }
  if (!await requestAggregateProtectionSlotMutation(connector, position, reason)) return false

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
  // The aggregate security stop is also sized to the pre-mutation venue
  // quantity. Leaving it live while an add/reduce is in flight either leaves
  // the new quantity unprotected or lets a stale full-slot stop close more
  // than the intended retained quantity. It must cross the same cancellation
  // and authoritative-position barrier as the row SL/TP pair.
  if (position.securityStopOrderId) ids.add(String(position.securityStopOrderId))
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
  position.securityStopOrderId = undefined
  position.securityStopPrice = 0
  position.stopLossArmedQuantity = 0
  position.takeProfitArmedQuantity = 0
  position.securityStopArmedQuantity = 0
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
    position.volumeUsd = positionNotionalUsd(
      position,
      authoritative.quantity,
      Number(position.averageExecutionPrice || position.entryPrice || 0),
    )
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
    // A symbol/direction or exchange-position id is not ownership on a shared
    // account.  Refuse before taking a mutation lock, changing local status,
    // cancelling controls, or sending a reduce-only order.
    if (!isSystemTrackedLivePosition(position, connectionId)) {
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "warning",
        `Blocked close for unowned lifecycle row ${position.symbol || "unknown"}`,
        {
          positionId: position.id,
          requestedConnectionId: connectionId,
          persistedConnectionId: position.connectionId,
          reason: "exact_system_connection_ownership_required",
        },
      ).catch(() => {})
      return position
    }
    const resolvedDirection = resolveLivePositionDirection(position)
    if (!resolvedDirection) {
      position.statusReason = "exchange_close_blocked_invalid_direction"
      pushStep(position, "close_direction_guard", false, "No explicit long/short direction; no exchange close or control cancellation was sent")
      await savePosition(position)
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "error",
        `Blocked exchange close for ${position.symbol}: missing explicit long/short direction`,
        { positionId: position.id, symbol: position.symbol },
      ).catch(() => {})
      return position
    }
    position.direction = resolvedDirection
    position.side ??= resolvedDirection
    const originalStatus = position.status
    let confirmedCloseOrderId = String(
      position.closeOrderId || position.pendingSystemAction?.orderId || "",
    ).trim()

    // Once an ambiguous close delivery has been proved absent, keep the
    // position protected and avoid entering the mutation/cancellation path at
    // all until its durable retry window opens. An unresolved client/order id
    // is never short-circuited here: it must first pass the authoritative
    // recovery barrier below so the same delivery cannot be submitted twice.
    if (
      exchangeConnector &&
      originalStatus !== "simulated" &&
      isSystemCloseRetryDeferred(position) &&
      !hasUnresolvedSystemCloseDelivery(position)
    ) {
      logRuntimeInfo(
        `system-close-backoff:${connectionId}:${position.id}`,
        30_000,
        `${LOG_PREFIX} System close retry deferred for ${position.symbol} ${position.direction}; ` +
          `attempt=${position.systemCloseRetry?.retryCount || 0} ` +
          `class=${position.systemCloseRetry?.lastFailureClass || "unknown"}`,
      )
      return position
    }

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

    // Refresh every known entry order before the first reduction is applied.
    // This repairs restarts and the normal fill-history propagation delay, and
    // gives BingX (whose close settlement excludes entry fees) the exact fee
    // amount needed for net PnL. Unknown entry fees stay explicitly incomplete.
    if (exchangeConnector && originalStatus !== "simulated") {
      await refreshEntryOrderAccounting(exchangeConnector, position)
    }

    // Settle control orders before a system action. This is intentionally
    // sequential: an exchange SL/TP or partial coordination always gets an
    // authoritative cycle to take effect before any program close is sent.
    if (exchangeConnector && hasSystemOrderId) {
      const aggregateReady = await requestAggregateProtectionSlotMutation(
        exchangeConnector,
        position,
        `system_close:${closeReason}`,
      )
      const barrier: ControlBarrierOutcome = aggregateReady
        ? await settleControlOrdersBeforeSystemClose(
            exchangeConnector,
            position,
            closeReason,
            closePrice,
          )
        : {
            decision: "wait",
            detail: "aggregate CTS controls are settling before the physical quantity changes",
          }
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

      if (barrier.decision === "proceed_system" && isSystemCloseRetryDeferred(position)) {
        // The previous durable client/order id has now been authoritatively
        // reconciled absent. Retire only that action marker, retain the retry
        // backoff, restore the open lifecycle and re-arm venue protection.
        // The future retry will prepare a new id only after nextRetryAt.
        position.pendingSystemAction = undefined
        const rollbackStatus: LivePosition["status"] = originalStatus && originalStatus !== "closing"
          ? originalStatus
          : "open"
        position.status = rollbackStatus
        position.statusReason =
          `system_close_retry_backoff: attempt=${position.systemCloseRetry?.retryCount || 0}; ` +
          `class=${position.systemCloseRetry?.lastFailureClass || "unknown"}; ` +
          `retry_at=${position.systemCloseRetry?.nextRetryAt || 0}`
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
        await persistCriticalLiveState(`system-close-backoff:${position.id}`)
        await rearmProtectionAfterQuantityMutation(
          exchangeConnector,
          position,
          "system_close_retry_backoff_rearm",
        )
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
      let terminalCloseError = "invalid_response"

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
            if (action.orderId) confirmedCloseOrderId = String(action.orderId)
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
          terminalCloseError = lastErrorMsg

          // ── Already-closed reconciliation ─��─���─────────────────────────
          // If the venue says the position is gone, we treat the close as
          // successful and stop retrying. The DB-side terminal-state
          // pipeline below still runs, but live accounting remains unresolved
          // until the exact control/system order fill is available. The
          // caller's trigger/mark price is never accepted as realised PnL.
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
          terminalCloseError = lastErrorMsg
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
        const retry = scheduleSystemCloseRetry(position, terminalCloseError)
        if (position.pendingSystemAction) {
          position.pendingSystemAction.phase = "system_verify"
          position.pendingSystemAction.updatedAt = retry.updatedAt
        }
        console.error(
          `${LOG_PREFIX} [v0] FAILED to close position on exchange after ${maxRetries} attempts: ` +
            `${position.symbol} ${position.direction}; retry=${retry.retryCount} class=${retry.lastFailureClass}`,
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
      const authoritative = await fetchAuthoritativeOpenQuantity(exchangeConnector, position.symbol, resolvedDirection)
      if (authoritative.ok) {
        const action = position.pendingSystemAction
        const executionId = `${position.id}:system-close:${action?.clientOrderId || action?.orderId || action?.token || "unknown"}`
        const existing = position.partialOrderExecutions?.find((entry) => entry.id === executionId)
        const settlement = action?.orderId
          ? await readOrderSettlement(exchangeConnector, position.symbol, action.orderId)
          : null
        const orderDetail = action?.orderId && typeof exchangeConnector.getOrder === "function"
          ? await withTimeout(
              exchangeConnector.getOrder(position.symbol, action.orderId) as Promise<any>,
              EXCHANGE_TIMEOUT_GET_ORDER_MS,
              `getOrder(system-close-accounting ${action.orderId})`,
            ).catch(() => null)
          : null
        const observed = applyReductionObservation(position, {
          executionId,
          source: "system_close",
          status: authoritative.quantity <= 0 ? "filled" : "partially_filled",
          requestedQuantity: Number(action?.requestedQuantity || position.executedQuantity || 0),
          reportedFilledQuantity: 0,
          previouslyAppliedQuantity: Number(existing?.cumulativeFilledQuantity || action?.appliedFilledQuantity || 0),
          authoritativeQuantity: authoritative.quantity,
          price: controlOrderFillPrice(orderDetail),
          settlement,
          orderId: action?.orderId,
          clientOrderId: action?.clientOrderId,
        })
        if (action?.orderId) confirmedCloseOrderId = String(action.orderId)
        if (action) action.appliedFilledQuantity = observed.cumulativeApplied
        if (authoritative.quantity > 1e-12) {
          // A terminal partial market close leaves a real residual exposure.
          // Do not wait for a later cron/engine tick to make it safe again:
          // once the submitted close is confirmed terminal, restore the row to
          // an open lifecycle state and queue an aggregate re-arm against the
          // fresh authoritative quantity.  If the close is still active or
          // cannot be proved terminal, preserve the durable pending action and
          // let the next reconcile observe it instead of placing overlapping
          // reduce-only controls.
          if (isTerminalSystemCloseOrder(orderDetail)) {
            position.pendingSystemAction = undefined
            position.systemCloseRetry = undefined
            position.status = "open"
            position.statusReason =
              `system_close_partial_settled: open=${authoritative.quantity}; protection re-arm queued from terminal close order`
            const partialSettledMutation = await mutatePositionWithVersionCheck(position, ["closing"], draft => {
              Object.assign(draft, position)
              draft.status = "open"
              draft.lockedAt = 0
              draft.lockedBy = undefined
            })
            if (partialSettledMutation) Object.assign(position, partialSettledMutation)
            await savePosition(position)
            await persistCriticalLiveState(`system-close-partial-settled:${position.id}`)
            await rearmProtectionAfterQuantityMutation(
              exchangeConnector,
              position,
              "system_close_partial_rearm",
              { quantityOverride: authoritative.quantity },
            )
            await releasePositionMutationLock(connectionId, livePositionId, lockId).catch(() => false)
            mutationLockHeld = false
            return position
          }
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
        position.systemCloseRetry = undefined
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

    // A pre-fill row without any venue handle represents only a reserved
    // local slot. There is no exchange order or filled quantity that could be
    // closed authoritatively, so keeping it in the open ledger creates a
    // permanent placed_unconfirmed zombie. The stuck-placement sweeper calls
    // this path without a connector after it has proven that no venue handle
    // exists; every row with an order/position handle still remains subject to
    // the normal exchange-confirmation barrier above.
    const preFillWithoutExchangeHandle = isPreFillWithoutExchangeHandle(
      position,
      originalStatus,
      hasSystemOrderId,
    )
    const localOnlyCloseAllowed =
      originalStatus === "simulated" ||
      closeReason === "exchange_externally_closed" ||
      closeReason === "exchange_reconciliation" ||
      closeReason === "duplicate_slot_pruned" ||
      preFillWithoutExchangeHandle
    const mayFinalizeClose = exchangeCloseSuccess || (!exchangeConnector && localOnlyCloseAllowed)
    if (!mayFinalizeClose) {
      const rollbackStatus: LivePosition["status"] = originalStatus && originalStatus !== "closing"
        ? originalStatus
        : "open"
      position.status = rollbackStatus
      position.statusReason =
        `close_failed_exchange_unconfirmed: ${closeReason}; position kept open; ` +
        `retry_at=${position.systemCloseRetry?.nextRetryAt || 0}; ` +
        `class=${position.systemCloseRetry?.lastFailureClass || "unknown"}`
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
      position.systemProtectionLegs = configuredSystemProtectionLegs(position)
      position.protectionMode = "system_close_fallback"
      await savePosition(position)
      await persistCriticalLiveState(`system-close-failed:${position.id}`)
      await incrementMetric(connectionId, "live_positions_close_failed_count")
      await releasePositionMutationLock(connectionId, livePositionId, lockId).catch(() => false)
      mutationLockHeld = false
      console.warn(
        `${LOG_PREFIX} Exchange close was not confirmed for ${position.symbol}; ` +
          `the durable delivery will be reconciled before the bounded retry`,
      )
      return position
    }

    // ── Exact-owned orphan-sweep safety net ────────────────────────────
    // After the recorded-id cancels, scan the venue for CTS-watermarked
    // reduce-only orders matching this row and close side. Catches:
    //   • by-id cancels that just failed transiently (we get a free retry)
    //   • protection ids that were never persisted (place-success → crash
    //     → restart finds no id in Redis)
    //   • response-lost CTS protection placements recovered by the durable
    //     connection-scoped client id.
    // Manual/foreign orders never enter the cancellation allow-list.
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
          if (hadSlId && !slCancelled) {
            position.stopLossOrderId = undefined
            setProtectionLegArmedQuantity(position, "stop_loss", 0)
          }
          if (hadTpId && !tpCancelled) {
            position.takeProfitOrderId = undefined
            setProtectionLegArmedQuantity(position, "take_profit", 0)
          }
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
    const isSimulationClose = originalStatus === "simulated"
    const finalLegPnl =
      isSimulationClose && remainingQty > 0 && avgEntry > 0 && closePrice > 0
        ? position.marketType === "forex" || position.volumeKind === "lots"
          ? forexPriceMovePnlUsd(
              position.direction === "short" ? "short" : "long",
              remainingQty,
              avgEntry,
              closePrice,
              position.symbol,
              positionUnitMultiplier(position),
              position.quoteToUsdRate,
            )
          : remainingQty * (
              position.direction === "long"
                ? closePrice - avgEntry
                : avgEntry - closePrice
            )
        : 0
    const pnl = Number(position.realizedPnL || 0) + finalLegPnl
    const lev = Math.max(1, position.leverage || 1)
    const notional = positionNotionalUsd(position, qty, avgEntry)
    const margin = notional > 0 ? notional / lev : 0
    const roi = margin > 0 ? (pnl / margin) * 100 : 0
    const accountedClosedQuantity = Math.max(0, Number(position.closedQuantity || 0))
    const accountingQuantityComplete = qty <= 1e-12
      || accountedClosedQuantity >= qty - Math.max(1e-12, qty * 1e-8)
    position.realizedPnlComplete = isSimulationClose
      ? true
      : position.realizedPnlComplete !== false && accountingQuantityComplete
    position.realizedPnlSource = isSimulationClose
      ? "simulation_model"
      : position.realizedPnlComplete
        ? "exchange_settlement"
        : position.realizedPnlSource || "exchange_unresolved"

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
    const ledgerCloseOrderId = [...(position.partialOrderExecutions || [])]
      .reverse()
      .find((execution) =>
        ["system_close", "control_order"].includes(execution.source)
        && Number(execution.cumulativeFilledQuantity || execution.appliedQuantity || 0) > 0
        && String(execution.orderId || "").trim().length > 0,
      )?.orderId
    position.closeOrderId = String(
      confirmedCloseOrderId || ledgerCloseOrderId || position.closeOrderId || "",
    ).trim() || undefined
    position.pendingSystemAction = undefined
    position.systemCloseRetry = undefined
    position.pendingQuantityMutation = undefined
    position.pendingAccumulation = undefined
    position.pendingProtectionOrders = undefined
    position.stopLossOrderId = undefined
    position.takeProfitOrderId = undefined
    position.securityStopOrderId = undefined
    position.stopLossPrice = 0
    position.takeProfitPrice = 0
    position.securityStopPrice = 0
    position.stopLossArmedQuantity = 0
    position.takeProfitArmedQuantity = 0
    position.protectionArmedQuantity = 0
    position.securityStopArmedQuantity = 0
    position.securityStopAbsenceConfirmations = 0
    position.securityStopRequired = false
    position.securityStopStatus = undefined
    position.systemProtectionLegs = []
    position.protectionMode = undefined
    position.controlOrderSetCoverage = undefined
    position.aggregateProtectionMutationRequestedAt = undefined
    position.aggregateProtectionMutationSettledAt = undefined
    position.aggregateProtectionMutationReason = undefined
    position.aggregateProtectionOwner = false
    position.aggregateProtectionQuantity = 0
    position.closeReason = closeReason
    // Persist the actual exit price so the stats route and trade-history
    // table can show the real close price without needing to back-derive
    // it from realizedPnL. This is the definitive source of truth for
    // the "Exit" column in trade history.
    const lastActualExecutionPrice = [...(position.partialOrderExecutions || [])]
      .reverse()
      .map((execution) => Number(execution.price) || 0)
      .find((price) => price > 0) || 0
    const accountedClosePrice = isSimulationClose ? closePrice : lastActualExecutionPrice
    if (accountedClosePrice > 0) position.closePrice = Math.round(accountedClosePrice * 1e8) / 1e8
    
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
      `close @ ${accountedClosePrice > 0 ? accountedClosePrice : "unresolved"} pnl=${pnl.toFixed(2)} roi=${roi.toFixed(2)}% accounting=${position.realizedPnlSource}/${position.realizedPnlComplete ? "complete" : "incomplete"} reason=${closeReason}${exchangeNote}`,
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
      await releaseLock(connectionId, position.symbol, liveLockDirection(position), position.liveLockToken)
    } else if (originalStatus !== "simulated") {
      // Simulated/recovered rows can legitimately predate a live admission
      // lock. Paper rows never acquire that lock at all, so warning for every
      // normal simulated close is false-positive noise. For a real/recovered
      // venue row, releasing a lock we do not own would still be unsafe; retain
      // the rate-limited diagnostic for that actual recovery anomaly.
      logRuntimeWarning(
        `live-lock-release-missing:${connectionId}:${position.symbol}:${position.direction}`,
        30_000,
        `${LOG_PREFIX} [lock-coordination] close skipped live lock release for ${connectionId}/${position.symbol}/${position.direction} because no owner token is available`,
      )
    }
    if (!wasAlreadyClosed) {
      if (isSimulationClose) {
        await incrementMetric(connectionId, "live_simulated_positions_closed_count")
        if (pnl > 0) await incrementMetric(connectionId, "live_simulated_wins_count")
      } else {
        await incrementMetric(connectionId, "live_positions_closed_count")
        if (position.realizedPnlComplete && pnl > 0) await incrementMetric(connectionId, "live_wins_count")
      }
      const closedDirection = resolveLivePositionDirection(position)
      // A Signal/default or Signal/Block leg may have joined a position whose
      // primary owner is another indication type. Attribution follows the
      // durable Signal risk/source lineage, not the first leg's label.
      if (position.realizedPnlComplete && closedDirection && position.signalRisk?.sourceIds?.length) {
        const signalAppSettings = await getAppSettings().catch(() => ({} as any))
        const positionCostPct = Math.max(
          0.000001,
          Number(
            signalAppSettings?.positionCost ??
            signalAppSettings?.exchangePositionCost ??
            signalAppSettings?.exchange_position_cost,
          ) || 0.1,
        )
        await recordSignalPerformanceOutcome({
          connectionId,
          positionId: position.id,
          symbol: position.symbol,
          direction: closedDirection,
          pnl,
          pnlPct: notional > 0 ? (pnl / notional) * 100 : 0,
          positionCostPct,
          sourceIds: position.signalRisk.sourceIds,
          signalLanes: position.signalRisk.signalLanes,
          liveExchange: originalStatus !== "simulated" && Boolean(exchangeConnector),
          closedAt: position.closedAt || Date.now(),
        }).catch((error) => {
          console.warn(
            `${LOG_PREFIX} Signal outcome attribution failed for ${position.id}:`,
            error instanceof Error ? error.message : error,
          )
        })
      }
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
      signalSourceIds: position.signalRisk?.sourceIds,
      signalStopLossPct: position.signalRisk?.stopLossPct,
      signalTakeProfitPct: position.signalRisk?.takeProfitPct,
      pnl,
      roi,
      closePrice: accountedClosePrice || null,
      pnlAccountingComplete: position.realizedPnlComplete,
      pnlAccountingSource: position.realizedPnlSource,
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

function isPreFillWithoutExchangeHandle(
  position: Pick<LivePosition, "executedQuantity">,
  originalStatus: LivePosition["status"] | undefined,
  hasSystemOrderId: boolean,
): boolean {
  return !hasSystemOrderId &&
    Number(position.executedQuantity || 0) <= 0 &&
    (originalStatus === "placed" ||
      originalStatus === "pending" ||
      originalStatus === "pending_fill" ||
      originalStatus === "placed_unconfirmed")
}

/**
 * Get all live positions for a connection.
 */
export async function getLivePositions(connectionId: string): Promise<LivePosition[]> {
  await initRedis()
  const client = getRedisClient()
  try {
    const ids = ((await client.lrange(`live:positions:${connectionId}`, 0, -1).catch(() => [])) || []) as string[]

    // Deduplicate while preserving order — the open index may contain stale
    // duplicates from retried writes.
    const uniqueIds: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      uniqueIds.push(id)
    }

    // Read the complete authoritative open index. Batches bound concurrency,
    // not cardinality: a Main book larger than 501 rows must still reconcile,
    // close, and appear in current statistics after a restart.
    const positions: LivePosition[] = []
    const READ_BATCH_SIZE = 32
    for (let offset = 0; offset < uniqueIds.length; offset += READ_BATCH_SIZE) {
      const values = await Promise.all(
        uniqueIds
          .slice(offset, offset + READ_BATCH_SIZE)
          .map((id) => readLivePositionSnapshot(client, connectionId, id).catch(() => null)),
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

    const READ_BATCH_SIZE = 32
    for (let offset = 0; offset < uniqueIds.length; offset += READ_BATCH_SIZE) {
      const values = await Promise.all(
        uniqueIds
          .slice(offset, offset + READ_BATCH_SIZE)
          .map((id) => readLivePositionSnapshot(client, connectionId, id).catch(() => null)),
      )
      for (const pos of values) if (pos) positions.push(pos)
    }
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
  statistics: LivePositionStatistics
}> {
  try {
    // Merge open (live) and closed (archive) indices so aggregate stats are
    // accurate across the position's full lifecycle, not just currently-open.
    const [openPositions, closedPositions] = await Promise.all([
      getLivePositions(connectionId),
      getClosedLivePositions(connectionId, 1000),
    ])
    const allPositions = [...openPositions, ...closedPositions]
    const statistics = calculateLivePositionStatistics(allPositions as unknown as Record<string, any>[])

    return {
      totalFilled: statistics.filled,
      totalOpen: statistics.open,
      totalClosed: statistics.closed,
      totalPnL: statistics.realizedPnl,
      averageROI: statistics.averageRealizedRoi,
      winRate: statistics.winRate,
      statistics,
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Error calculating stats:`, err)
    const statistics = calculateLivePositionStatistics([])
    return {
      totalFilled: 0,
      totalOpen: 0,
      totalClosed: 0,
      totalPnL: 0,
      averageROI: 0,
      winRate: 0,
      statistics,
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
): Promise<"sl_hit" | "tp_hit" | "special_time_exit" | "close_unconfirmed" | null> {
  if (!Number.isFinite(markPrice) || markPrice <= 0) return null
  if (pos.executedQuantity <= 0) return null
  const direction = resolveLivePositionDirection(pos)
  if (!direction) return null
  pos.direction = direction
  pos.side ??= direction
  
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

  // Special positions are deliberately short-lived. The target time closes a
  // lane that has not developed meaningful favourable movement; the absolute
  // expiry always closes it and is independently clamped to 90 minutes.
  if (String(pos.indicationType || "").trim().toLowerCase() === "special") {
    const plan = sanitizeSpecialPositionPlan(pos.specialPositionPlan, direction)
    if (plan) {
      const entryTime = Number(pos.fills?.[0]?.timestamp || pos.createdAt || Date.now())
      const hardExpiry = entryTime + Math.min(
        SPECIAL_MAX_HOLDING_SECONDS,
        plan.maximumHoldingSeconds,
      ) * 1_000
      const persistedExpiry = Number(pos.specialExpiresAt || hardExpiry)
      const expiry = Math.min(hardExpiry, persistedExpiry > entryTime ? persistedExpiry : hardExpiry)
      const targetExitAt = entryTime + Math.min(
        plan.targetHoldingSeconds,
        plan.maximumHoldingSeconds,
        SPECIAL_MAX_HOLDING_SECONDS,
      ) * 1_000
      const signedMovePct = ((markPrice - fillPrice) / fillPrice) * 100 *
        (direction === "long" ? 1 : -1)
      const insufficientMomentum = signedMovePct < Math.max(
        0.01,
        plan.protection.trailingActivationPct * 0.25,
      )
      const maxExpired = Date.now() >= expiry
      const targetExpired = Date.now() >= targetExitAt && insufficientMomentum
      if (maxExpired || targetExpired) {
        const reason = maxExpired
          ? "special_max_duration"
          : "special_target_duration_no_momentum"
        await logProgressionEvent(
          connectionId,
          "live_trading",
          "info",
          `Special time exit for ${pos.symbol} ${direction}`,
          {
            positionId: pos.id,
            direction,
            reason,
            holdingSeconds: Math.max(0, Math.floor((Date.now() - entryTime) / 1_000)),
            targetHoldingSeconds: plan.targetHoldingSeconds,
            maximumHoldingSeconds: plan.maximumHoldingSeconds,
            signedMovePct,
          },
        ).catch(() => {})
        const closed = await closeLivePosition(
          connectionId,
          pos.id,
          markPrice,
          exchangeConnector,
          reason,
        )
        if (closed?.status === "closed") return "special_time_exit"
        if (closed) Object.assign(pos, closed)
        return "close_unconfirmed"
      }
    }
  }

  // Use the same canonical resolver as venue control-order reconciliation.
  // This keeps engine-side fallback exactly coordinated with trailing,
  // operator absolute-price overrides and DCA take-profit recalculation.
  const { desiredSl, desiredTp } = computeDesiredProtectionPrices(pos)

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
          const mdHash = await orphanRedis.hgetall(marketDataKey(pos.symbol, "", pos.connectionId || connectionId))
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

    // Load the authoritative book before accepting a connector. Direct Trade
    // has an independently authorised X02 Prod-VST lane while the normal
    // process cache remains globally simulated; an owned Direct row therefore
    // has to re-select and verify its scoped lifecycle connector here.
    const allOpen = await getLivePositions(connectionId)
    exchangeConnector = await resolveDirectTradeLifecycleConnector(
      connectionId,
      allOpen,
      exchangeConnector,
    )

    // Entry permission and lifecycle ownership are independent. Turning every
    // live-entry toggle off must prevent new orders, but it must not stop the
    // exchange reconciliation of positions this process already owns. Those
    // rows still need mark/PnL updates, protection healing and authoritative
    // terminal-close detection. Only skip private polling when there is no
    // connector capable of doing it.
    const liveTradeOn = await isLiveTradeEnabledForConnection(connectionId)
    if (!liveTradeOn && (!exchangeConnector || typeof exchangeConnector.getPositions !== "function")) {
      if (!skipOrphanAdoption) await orphanCloseExpiredPositions(connectionId, null, summary)
      return summary
    }
    if (!liveTradeOn) {
      console.log(`${LOG_PREFIX} [reconcile] entry permission is off; continuing lifecycle sync for system-owned positions only`)
    }

    // ── Step 4+ from reconcileLivePositions ───────────���────────────────────
    // Nothing to do if connector absent (sim-only is already done above)
    if (!exchangeConnector || typeof exchangeConnector.getPositions !== "function") {
      if (!reconcileMode) return summary  // cron always runs full path
      await orphanCloseExpiredPositions(connectionId, null, summary)
      return summary
    }

    // The live-positions index was loaded once above for connector selection.
    const invalidDirectionPositions: LivePosition[] = []
    const openPositions = allOpen.filter((p) => {
      const isOpen =
        p.status === "open" ||
        p.status === "filled" ||
        p.status === "partially_filled" ||
        p.status === "placed" ||
        p.status === "pending" ||
        p.status === "pending_fill" ||
        p.status === "placed_unconfirmed" ||
        p.status === "closing" ||
        p.status === "closing_partial"
      if (!isOpen) return false
      const direction = resolveLivePositionDirection(p)
      if (!direction) {
        p.statusReason = "reconcile_blocked_invalid_direction"
        pushStep(p, "reconcile_direction_guard", false, "No explicit long/short direction; venue mutations are blocked")
        invalidDirectionPositions.push(p)
        return false
      }
      p.direction = direction
      p.side ??= direction
      return true
    })
    if (invalidDirectionPositions.length > 0) {
      await Promise.all(invalidDirectionPositions.map((position) => savePosition(position).catch(() => {})))
      summary.errors += invalidDirectionPositions.length
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "error",
        `${invalidDirectionPositions.length} live position(s) quarantined: missing explicit long/short direction`,
        { positionIds: invalidDirectionPositions.map((position) => position.id) },
      ).catch(() => {})
    }
    if (openPositions.length === 0 && !reconcileMode) {
      await orphanCloseExpiredPositions(connectionId, exchangeConnector, summary)
      return summary
    }

    if (liveTradeOn || openPositions.length > 0) {
      await monitorConnectionMarginCall(connectionId, exchangeConnector, { startSession: true })
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
      const direction = normalizeExchangePositionDirection(ep.positionSide, ep.side, size)
      if (!direction) {
        console.warn(`${LOG_PREFIX} [reconcile] skipped exchange position ${sym}: direction is not authoritative`)
        summary.errors++
        continue
      }
      exchangeMap.set(`${sym}|${direction}`, ep)
    }
    // ── Once-per-tick venue open-orders snapshot ────���─────────────────���
    // Used by `updateProtectionOrders` to detect silently-gone SL/TP
    // (filled, externally cancelled, expired, sweep). One `getOpenOrders`
    // call amortized across every position in the reconcile sweep, vs.
    // 2 × getOrder() calls per position the alternative would require.
    // `null` means "skip verification this tick"; the next tick retries.
    const liveOrderIds = await fetchLiveOrderIdSet(exchangeConnector)
    const aggregateProtection = await reconcileAggregateProtectionBook(
      connectionId,
      exchangeConnector,
      openPositions,
      exchangePositions,
      liveOrderIds,
    )
    summary.protectionRearmed += aggregateProtection.rearmedLeaders
    summary.closed += aggregateProtection.closedMemberIds.size

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
    const executionSlotsByPhysicalSlot = new Map<string, Set<string>>()
    {
      const bySlot = new Map<string, typeof openPositions>()
      for (const p of openPositions) {
        const physicalSlot = `${normSym(p.symbol)}|${p.direction}`
        const executionSlot = liveExecutionSlot(p)
        const slot = `${physicalSlot}|${executionSlot}`
        const slots = executionSlotsByPhysicalSlot.get(physicalSlot) ?? new Set<string>()
        slots.add(executionSlot)
        executionSlotsByPhysicalSlot.set(physicalSlot, slots)
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
      if (aggregateProtection.closedMemberIds.has(pos.id)) {
        // The aggregate pass already moved this superseded Set row to the
        // terminal archive. Never let the stale in-memory snapshot reinsert it
        // into the open index later in this same sync cycle.
        delta.reconciled = 0
        return delta
      }
      try {
        const mapKey = `${normSym(pos.symbol)}|${pos.direction}`
        const logicalSlotKey = `${mapKey}|${liveExecutionSlot(pos)}`
        const exPos = exchangeMap.get(mapKey)

        // ── Non-canonical duplicate for this venue slot (BUG 4) ─────────
        // Never drive SL/TP, force-close, or close counters (would double-
        // count one venue position). Just keep the dashboard mark/PnL fresh
        // when the slot is live, or prune the phantom Redis record when the
        // venue slot is empty — without incrementing the close counter, so
        // the canonical record alone owns the single real close.
        if (canonicalIdBySlot.get(logicalSlotKey) !== pos.id) {
          if (exPos) {
            const mP = parseRedisFiniteNumber(exPos.markPrice ?? exPos.indexPrice ?? exPos.lastPrice)
            const uP = parseRedisFiniteNumber(exPos.unrealizedProfit ?? exPos.unrealisedPnl ?? exPos.unrealizedPnl)
            pos.exchangeData = {
              ...pos.exchangeData,
              markPrice: mP && mP > 0 ? mP : pos.exchangeData?.markPrice,
              unrealizedPnL: uP ?? pos.exchangeData?.unrealizedPnL,
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
          const markPrice = parseRedisFiniteNumber(exPos.markPrice ?? exPos.indexPrice ?? exPos.lastPrice)
          const liqPrice  = parseRedisFiniteNumber(exPos.liquidationPrice ?? exPos.liqPrice)
          const uPnl      = parseRedisFiniteNumber(exPos.unrealizedProfit ?? exPos.unrealisedPnl ?? exPos.unrealizedPnl)
          const authoritativeSize = Math.abs(parseFloat(String(exPos.size ?? exPos.positionAmt ?? exPos.quantity ?? "0"))) || 0
          const authoritativeEntry = parseFloat(String(exPos.entryPrice ?? exPos.avgPrice ?? "0")) || 0

          repairLiveEntryPriceDomain(pos, authoritativeEntry)

          pos.exchangeData = {
            ...pos.exchangeData,
            markPrice: markPrice && markPrice > 0 ? markPrice : pos.exchangeData?.markPrice,
            liquidationPrice: liqPrice && liqPrice > 0 ? liqPrice : pos.exchangeData?.liquidationPrice,
            unrealizedPnL: uPnl ?? pos.exchangeData?.unrealizedPnL,
            syncedAt: Date.now(),
          }
          pos.updatedAt = Date.now()
          const parallelExecutionLanes = (executionSlotsByPhysicalSlot.get(mapKey)?.size || 0) > 1
          if (!parallelExecutionLanes) {
            await reconcileAuthoritativeExchangeQuantity(pos, authoritativeSize, authoritativeEntry)
          }
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
            const exEntry = parseFloat(String(exPos.entryPrice ?? exPos.avgPrice ?? "0")) || 0
            if (exSize > 0 && exEntry > 0 && !parallelExecutionLanes) {
              if (pos.executedQuantity <= 0) {
                pos.executedQuantity = exSize
                pos.remainingQuantity = Math.max(0, Number(pos.quantity || exSize) - exSize)
                pos.averageExecutionPrice = exEntry
              }
              reconcileInitialEntryBaseQuantity(pos, exSize)
              pos.status = "open"
              pos.statusReason = `confirmed_position_fallback: reconcile saw exchange position size=${exSize} avg=${pos.averageExecutionPrice}`
              pushStep(pos, "reconcile_fill_detected", true, pos.statusReason)
              pos.updatedAt = Date.now()
              justFilled = true
              await recordFillCountersOnce(connectionId, pos, pos.symbol, pos.direction!)
            }

            if (pos.orderId) {
              try {
                const order = await exchangeConnector.getOrder(pos.symbol, pos.orderId)
                const statusLower = String(order?.status ?? "").toLowerCase()
                const orderFilledQty = parseFloat(String(order?.filledQty ?? order?.executedQty ?? "0")) || 0
                const orderFilledPrice = parseFloat(String(order?.filledPrice ?? order?.avgPrice ?? "0")) || 0
                if (order && orderFilledQty > 0 && orderFilledPrice > 0 && (statusLower === "filled" || statusLower === "partially_filled" || orderFilledQty > 0)) {
                  if (orderFilledQty > 0) {
                    pos.executedQuantity = orderFilledQty
                    pos.remainingQuantity = Math.max(0, pos.quantity - pos.executedQuantity)
                    pos.averageExecutionPrice = orderFilledPrice
                    reconcileInitialEntryBaseQuantity(pos, orderFilledQty)
                  }
                  pos.status = "open"
                  pos.statusReason = `confirmed_fill: reconcile order status=${statusLower} qty=${pos.executedQuantity}`
                  pushStep(pos, "reconcile_fill_detected", true, pos.statusReason)
                  pos.updatedAt = Date.now()
                  if (!justFilled) {
                    justFilled = true
                    await recordFillCountersOnce(connectionId, pos, pos.symbol, pos.direction!)
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

          // Each row's exact-quantity venue SL/TP and the slot's separate
          // full-slot security stop were coordinated above. Per-position
          // lifecycle checks remain independent and may still issue a system close.

          const crossed = await checkAndForceCloseOnSltpCross(
            connectionId,
            pos,
            markPrice ?? 0,
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
                    await releaseLock(connectionId, pos.symbol, liveLockDirection(pos), pos.liveLockToken).catch(() => false)
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
          // Position closed externally. Resolve the exact system control order
          // that flattened it; a mark/ticker/entry fallback is not a fill and
          // must never become realised PnL.
          await refreshEntryOrderAccounting(exchangeConnector, pos)
          const qty = Math.max(0, Number(pos.executedQuantity || pos.quantity || 0))
          const inheritedSecurity = inheritedAggregateVenueProtection(pos)
          const sharedSecurityOrderId = firstNonEmptyIdentifier(
            pos.securityStopOrderId,
            inheritedSecurity?.securityStopOrderId,
          )
          const closeOrderIds = Array.from(new Set([
            String(pos.stopLossOrderId || ""),
            String(pos.takeProfitOrderId || ""),
            String(sharedSecurityOrderId || ""),
            String(pos.pendingSystemAction?.orderId || ""),
            String(pos.pendingReduction?.orderId || ""),
          ].filter(Boolean)))
          const settlements = (await Promise.all(
            closeOrderIds.map((orderId) => readOrderSettlement(exchangeConnector, pos.symbol, orderId)),
          )).filter((value): value is ExchangeOrderSettlement => Boolean(value))
          const bestSettlement = settlements
            .sort((a, b) => b.filledQuantity - a.filledQuantity)[0] || null
          let actualOrder: any = null
          if (!bestSettlement && typeof exchangeConnector.getOrder === "function") {
            const orders = await Promise.all(closeOrderIds.map((orderId) => withTimeout(
              exchangeConnector.getOrder(pos.symbol, orderId) as Promise<any>,
              EXCHANGE_TIMEOUT_GET_ORDER_MS,
              `getOrder(external-close ${orderId})`,
            ).catch(() => null)))
            actualOrder = orders.find((order) =>
              controlOrderFilledQuantity(order) > 0 && controlOrderFillPrice(order) > 0,
            ) || null
          }
          const actualOrderId = bestSettlement?.orderId
            || String(actualOrder?.orderId ?? actualOrder?.id ?? "")
          const rawActualFilledQuantity = bestSettlement?.filledQuantity
            || controlOrderFilledQuantity(actualOrder)
          const actualFillPrice = bestSettlement?.averageFillPrice
            || controlOrderFillPrice(actualOrder)
          const isSharedSecurityFill = Boolean(
            actualOrderId
            && sharedSecurityOrderId
            && actualOrderId === sharedSecurityOrderId,
          )
          const aggregateQuantity = Math.max(
            qty,
            Number(pos.aggregateProtectionQuantity || 0),
          )
          const securityAllocationRatio = isSharedSecurityFill && aggregateQuantity > 0
            ? Math.min(1, qty / aggregateQuantity)
            : 1
          const actualFilledQuantity = isSharedSecurityFill
            ? Math.min(qty, rawActualFilledQuantity * securityAllocationRatio)
            : rawActualFilledQuantity
          if (actualOrderId && actualFilledQuantity > 0) {
            pos.closeOrderId = actualOrderId
          }
          const appliedSettlement = isSharedSecurityFill && bestSettlement
            ? apportionedSettlement(bestSettlement, actualFilledQuantity, securityAllocationRatio)
            : bestSettlement
          if (actualOrderId && actualFilledQuantity > 0) {
            const executionId = `${pos.id}:exchange-external:${actualOrderId}`
            const existingExecution = pos.partialOrderExecutions?.find((entry) => entry.id === executionId)
            applyReductionObservation(pos, {
              executionId,
              source: "exchange_reconcile",
              status: "filled",
              requestedQuantity: qty,
              reportedFilledQuantity: actualFilledQuantity,
              previouslyAppliedQuantity: Number(existingExecution?.cumulativeFilledQuantity || 0),
              authoritativeQuantity: 0,
              price: actualFillPrice,
              settlement: appliedSettlement,
              orderId: actualOrderId,
            })
            if (actualFilledQuantity < qty - Math.max(1e-12, qty * 1e-8)) {
              pos.realizedPnlComplete = false
              pos.realizedPnlSource = "exchange_unresolved"
            }
          } else {
            pos.realizedPnlComplete = false
            pos.realizedPnlSource = "exchange_unresolved"
          }
          const exitPrice = actualFillPrice > 0 ? actualFillPrice : 0
          const realizedPnl = Number(pos.realizedPnL || 0)

          let controlsSettled = await settleSlotControlsWithoutGuess(
            exchangeConnector,
            pos,
            true,
            liveOrderIds,
            "ExternalClose",
          )
          if (!controlsSettled) {
            controlsSettled = await cancelSlotOwnedControls(
              exchangeConnector,
              pos,
              true,
              "ExternalClose",
            )
          }
          const inheritedSecuritySettled = !sharedSecurityOrderId
            || sharedSecurityOrderId === pos.securityStopOrderId
            || await cancelProtectionOrder(
              exchangeConnector,
              pos.symbol,
              sharedSecurityOrderId,
              "ExternalClose-SharedSecurity",
              pos.connectionId,
            )
          if (!controlsSettled || !inheritedSecuritySettled) {
            pos.statusReason = "external_close_control_cleanup_pending"
            pos.updatedAt = Date.now()
            pushStep(
              pos,
              "external_close_control_cleanup",
              false,
              "venue position is flat, but at least one CTS control order is not authoritatively settled",
            )
            await savePosition(pos)
            delta.updated++
            return delta
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
          const remainingQuantityAtClose = Math.max(
            0,
            Number(pos.executedQuantity || pos.quantity || 0),
          )
          const lifetimeQuantityAtClose = Math.max(
            Number(pos.totalExecutedQuantity || 0),
            Math.max(0, Number(pos.closedQuantity || 0)) + remainingQuantityAtClose,
            Number(pos.initialExecutedQuantity || 0),
            remainingQuantityAtClose,
          )
          reconcileExchangeQuantityLedger(
            pos,
            lifetimeQuantityAtClose,
            Number(pos.averageExecutionPrice || pos.entryPrice || 0),
          )
          pos.status = "closed"
          pos.closedAt = Date.now()
          pos.totalExecutedQuantity = lifetimeQuantityAtClose
          pos.closedQuantity = lifetimeQuantityAtClose
          pos.executedQuantity = lifetimeQuantityAtClose
          pos.quantity = lifetimeQuantityAtClose
          pos.remainingQuantity = 0
          pos.realizedPnL = Math.round(realizedPnl * 1e8) / 1e8
          pos.pendingProtectionOrders = undefined
          pos.stopLossOrderId = undefined
          pos.takeProfitOrderId = undefined
          pos.securityStopOrderId = undefined
          pos.stopLossPrice = 0
          pos.takeProfitPrice = 0
          pos.securityStopPrice = 0
          setProtectionLegArmedQuantity(pos, "stop_loss", 0)
          setProtectionLegArmedQuantity(pos, "take_profit", 0)
          pos.securityStopArmedQuantity = 0
          pos.securityStopAbsenceConfirmations = 0
          pos.securityStopRequired = false
          pos.securityStopStatus = undefined
          pos.systemProtectionLegs = []
          pos.protectionMode = undefined
          pos.controlOrderSetCoverage = undefined
          pos.aggregateProtectionMutationRequestedAt = undefined
          pos.aggregateProtectionMutationSettledAt = undefined
          pos.aggregateProtectionMutationReason = undefined
          pos.aggregateProtectionOwner = false
          pos.aggregateProtectionQuantity = 0
          if (exitPrice > 0) pos.closePrice = Math.round(exitPrice * 1e8) / 1e8
          pos.closeReason = pos.closeReason || "exchange_reconciliation"
          pos.progression!.push({
            step: "close",
            timestamp: Date.now(),
            success: true,
            details: `Reconciled @ ${exitPrice > 0 ? exitPrice.toFixed(8) : "unresolved"} PnL=${realizedPnl.toFixed(4)} accounting=${pos.realizedPnlSource}/${pos.realizedPnlComplete ? "complete" : "incomplete"}`,
          })
          pos.updatedAt = Date.now()

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
          ]
          if (pos.liveLockToken) {
            writes.push(releaseLock(connectionId, pos.symbol, liveLockDirection(pos), pos.liveLockToken).catch(() => false))
          }
          if (!alreadyMoved) {
            // Counter increments are the ONLY ops that must be deduped across
            // the closeLivePosition + reconcile paths — the index move inside
            // savePosition() is already idempotent, so we no longer repeat the
            // lrem/lpush here (doing so double-pushed the id into the archive).
            writes.push(
              client.hincrby(progKey, "live_positions_closed_count", 1).catch(() => {}),
            )
            if (pos.realizedPnlComplete && realizedPnl > 0) {
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

    // A worker may have just completed an aggregate quantity hand-off (or
    // restored a terminal partial close). Re-arm that exact physical slot from
    // a fresh venue snapshot before returning, rather than leaving it until a
    // future cron tick. Deferred slots retain their durable marker and remain
    // queued for the next authoritative pass.
    const queuedAggregateSlots = queuedAggregateProtectionFinalizations(connectionId)
    if (queuedAggregateSlots.size > 0) {
      try {
        const finalization = await finalizeQueuedAggregateProtection(
          connectionId,
          exchangeConnector,
          queuedAggregateSlots,
        )
        summary.protectionRearmed += finalization.rearmedLeaders
        settleAggregateProtectionFinalizations(connectionId, finalization.completedSlots)
      } catch (error) {
        console.warn(
          `${LOG_PREFIX} aggregate protection finalization failed; retaining durable retry queue:`,
          error instanceof Error ? error.message : String(error),
        )
      }
    }

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
        const px = await fetchCurrentPrice(sym, connectionId).catch(() => 0)
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
      // Cross-process ownership is unknown while Redis is unavailable. Never
      // reconcile exchange positions or submit lifecycle mutations without
      // that ownership proof; the next healthy tick will retry.
      logRuntimeError(
        `live-sync:${connectionId}:lock-acquire-failed`,
        60_000,
        `${LOG_PREFIX} [sync-lock] acquire failed for ${connectionId} — reconciliation skipped (fail closed):`,
        lockErr instanceof Error ? lockErr.message : String(lockErr),
      )
      return
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

    // Never trust the connector supplied by a generic engine/cron caller for
    // an owned Direct lifecycle. Global paper mode intentionally caches a
    // SimulatedConnector under the normal connection key; replace it with the
    // separately cached and environment-proved X02 Prod-VST connector before
    // any exchange snapshot, protection, cancellation, or close operation.
    exchangeConnector = await resolveDirectTradeLifecycleConnector(
      connectionId,
      allOpenRaw,
      exchangeConnector,
    )
    if (exchangeConnector && typeof exchangeConnector.getBalance === "function") {
      await monitorConnectionMarginCall(connectionId, exchangeConnector, { startSession: true })
    }

    // ── Self-heal: purge terminal positions stuck in the open index ─────
    // A historical bug in redis-db savePosition() re-added rejected/cancelled/
    // error positions to the open index on every save, so stale terminal
    // entries can persist indefinitely (observed: 16 "rejected" re-synced
    // every tick). Move them to the closed archive here so the sync loop
    // only ever processes genuinely live positions.
    const TERMINAL_SYNC_STATUSES = new Set(["closed", "rejected", "cancelled", "canceled", "expired", "error"])
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
      (p) => p.status === "open" || p.status === "filled" || p.status === "partially_filled" || p.status === "placed" || p.status === "pending" || p.status === "pending_fill" || p.status === "placed_unconfirmed" || p.status === "closing" || p.status === "closing_partial",
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
    const placedCount = (statusBreakdown.placed || 0) + (statusBreakdown.pending || 0) + (statusBreakdown.pending_fill || 0) + (statusBreakdown.placed_unconfirmed || 0)
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
            const px = await fetchCurrentPrice(sym, connectionId).catch(() => 0)
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
    await reconcileAggregateProtectionBook(
      connectionId,
      exchangeConnector,
      openPositions,
      exchangePositions,
      liveOrderIdsSync,
    )
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
        // Foreign/manual rows are observation-only.  They cannot participate
        // in fill recovery, protection placement, cancellation, or system
        // close merely because they share a symbol and direction.
        if (!isSystemTrackedLivePosition(position, connectionId)) return
        
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
          repairLiveEntryPriceDomain(position, exEntry)
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
              const mdHash = await client.hgetall(marketDataKey(position.symbol, "", position.connectionId || connectionId))
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

        // Exchange controls were reconciled once for the complete physical
        // slot before the per-position worker pool. Each logical row still
        // runs its own trigger/max-hold checks below.

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
        const terminalRetentionSeconds = liveRetentionSecondsForStatus(position.status)
        await client.set(
          key,
          JSON.stringify(buildLivePositionCompatibilitySnapshot(position as unknown as Record<string, unknown>)),
          terminalRetentionSeconds !== null
            ? { EX: terminalRetentionSeconds || LIVE_TERMINAL_RETENTION_SECONDS }
            : undefined,
        ).catch(() => null)
        if (terminalRetentionSeconds === null) {
          await client.persist(key).catch(() => 0)
        }
        emitCanonicalEvent({
          type: "live.stageChanged",
          connectionId: position.connectionId || connectionId,
          symbol: position.symbol,
          stage: "live",
          data: { positionId: position.id, status: position.status, action: "synced" },
        })
        if (terminalRetentionSeconds === null) {
          await upsertRedisListHead(client, `live:positions:${position.connectionId}`, position.id)
          await client.persist(`live:positions:${position.connectionId}`).catch(() => 0)
        }
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

    // Complete any aggregate quantity hand-off produced by the parallel
    // workers before reporting this sync as done. This is deliberately after
    // stuck-entry cleanup as that path can also release a physical slot.
    const queuedAggregateSlots = queuedAggregateProtectionFinalizations(connectionId)
    if (queuedAggregateSlots.size > 0) {
      try {
        const finalization = await finalizeQueuedAggregateProtection(
          connectionId,
          exchangeConnector,
          queuedAggregateSlots,
        )
        settleAggregateProtectionFinalizations(connectionId, finalization.completedSlots)
        if (finalization.rearmedLeaders > 0 || finalization.changedPositions > 0) {
          console.log(
            `${LOG_PREFIX} [aggregate-finalize] conn=${connectionId} ` +
            `rearmed=${finalization.rearmedLeaders} changed=${finalization.changedPositions}`,
          )
        }
      } catch (error) {
        console.warn(
          `${LOG_PREFIX} [aggregate-finalize] failed; retaining durable retry queue:`,
          error instanceof Error ? error.message : String(error),
        )
      }
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
    // Re-read both canonical sources AFTER acquiring the lock so we see any
    // writes the previous lock-holder (reconcile / sync) just committed. The
    // JSON key is intentionally compact and cannot be used on its own for a
    // protection recalculation.
    const position = await readLivePositionSnapshot(client, connectionId, livePositionId)
    if (!position) return null
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

    normalizeLivePositionProtection(position)

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
    // The 280 ms canonical sync independently performs full liveness healing.
    ratchetManualTrailingStop(position)
    position.updatedAt = Date.now()
    await rearmProtectionAfterQuantityMutation(exchangeConnector, position, "manual_recalc")

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
    const pseudoEntryPrice = finitePositive(
      pseudoPos?.entry_price ??
      pseudoPos?.entryPrice ??
      pseudoPos?.average_entry_price ??
      pseudoPos?.averageEntryPrice,
    )

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
          const localAuthoritativeEntry =
            finitePositive(livePos.initialEntryPrice) ||
            finitePositive(livePos.averageExecutionPrice) ||
            finitePositive(livePos.entryPrice)
          repairLiveEntryPriceDomain(livePos, localAuthoritativeEntry)
          const fill =
            finitePositive(livePos.averageExecutionPrice) ||
            finitePositive(livePos.initialEntryPrice) ||
            finitePositive(livePos.entryPrice)
          const translatedTrailingStopPrice = trailingActive
            ? translatePseudoTrailingStopPrice(trailingStopPrice, pseudoEntryPrice, fill)
            : undefined
          // Never copy an absolute pseudo/historic price directly into a live
          // venue position. If it cannot be projected through the pseudo entry
          // ratio, leave the currently armed live protection untouched.
          if (trailingActive && trailingStopPrice > 0 && !(translatedTrailingStopPrice && translatedTrailingStopPrice > 0)) {
            continue
          }
          // Fast-path stale guard. The locked recalculation path performs the
          // same check again against a fresh Redis read; this early skip avoids
          // unnecessary venue work when an older fire-and-forget ratchet
          // arrives after a tighter one has already been persisted.
          if (
            trailingActive &&
            !!translatedTrailingStopPrice &&
            !isTrailingStopTightening(livePos, translatedTrailingStopPrice)
          ) continue
          let effectiveSlPct = slPct
          // CRITICAL: Guard trailing stop calculation against NaN and division errors
          if (trailingActive && Number.isFinite(Number(translatedTrailingStopPrice)) && Number(translatedTrailingStopPrice) > 0) {
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
                distPct = ((fill - Number(translatedTrailingStopPrice)) / fill) * 100
              } else {
                distPct = ((Number(translatedTrailingStopPrice) - fill) / fill) * 100
              }
              // Guard against NaN from division or calculation errors, and
              // ensure distPct is positive (should always be for valid trailing levels)
              if (Number.isFinite(distPct) && distPct > 0) {
                effectiveSlPct = distPct
              } else if (!Number.isFinite(distPct)) {
                // If distPct is NaN or Infinity, log it but keep current SL percentage
                console.warn(
                  `${LOG_PREFIX} distPct is ${distPct} for ${livePos.symbol} (fill=${fill}, trailing=${translatedTrailingStopPrice}, side=${liveSide})`
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
            trailingActive && Number(translatedTrailingStopPrice) > 0
              ? Number(translatedTrailingStopPrice)
              : undefined
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
          const aggregateMember =
            livePos.aggregateProtectionOwner === false && Boolean(livePos.aggregateProtectionKey)
          // Aggregate members intentionally do not own top-level venue IDs.
          // Their Set coverage points at the leader pair and their exact
          // triggers remain system-side, so missing local IDs are not a heal
          // signal. Treating them as one caused per-tick re-arm/demote churn.
          const ordersMissing = !aggregateMember && (!livePos.stopLossOrderId || !livePos.takeProfitOrderId)
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
            (trailingActive && Number(translatedTrailingStopPrice) > 0 && prevTrailingStopPrice !== translatedTrailingStopPrice)
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
  isActiveLiveSlotStatus,
  resolveConfirmedStrategyVariant,
  clearLiveTickerCache() {
    liveTickerCache.clear()
  },
  normalizeVenueTicker,
  selectVenueTickerPrice,
  translatePseudoTrailingStopPrice,
  repairLiveEntryPriceDomain,
  async refreshLockTTLWithClient(client: any, key: string, token: string, ttlMs: number) {
    return (await evalLockLua(client, REFRESH_LOCK_TTL_LUA, key, [token, String(ttlMs)])) === 1
  },
  async releaseLockWithClient(client: any, key: string, token: string) {
    return (await evalLockLua(client, RELEASE_LOCK_LUA, key, [token])) === 1
  },
  computeDesiredProtectionPrices,
  normalizeProtectionTriggerPrice,
  initialAggregateProtectionCoordination,
  projectAggregateMemberCoverage,
  refreshControlOrderSetCoverage,
  aggregateProtectionMutationIsInFlight,
  aggregateProtectionMutationIsAbandoned,
  isTerminalSystemCloseOrder,
  classifySystemCloseFailure,
  scheduleSystemCloseRetry,
  isSystemCloseRetryDeferred,
  hasUnresolvedSystemCloseDelivery,
  settleControlOrdersBeforeSystemClose,
  settleControlOrdersBeforeQuantityMutation,
  settleFilledRowControlsAcrossMembers,
  reconcilePendingAccumulationAndRearm,
  reconcileAuthoritativeExchangeQuantity,
  reconcileInitialEntryBaseQuantity,
  admitAccumulationQuantity,
  physicalAccumulationCount,
  resolveAccumulationPlan,
  sweepOrphanProtectionOrders,
  fetchLiveOrderIdSet,
  placeProtectionOrder,
  securityStopQuantityDrifted,
  securityStopPriceRearmDeferred,
  updateProtectionOrders,
  protectionLegArmedQuantity,
  setProtectionLegArmedQuantity,
  clearMissingProtectionOrderIds,
  resolvePseudoProtectionPercents,
  isTrailingStopTightening,
  isPreFillWithoutExchangeHandle,
  readAbsoluteProtectionPrices(pos: LivePosition) {
    return computeDesiredProtectionPrices(pos)
  },
  isAmbiguousControlOrderDelivery,
  reconcileAmbiguousProtectionWrite,
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
