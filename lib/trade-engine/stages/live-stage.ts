import { overallControlOrdersOnly, type ControlOrderScope } from "@/lib/overall-control-orders"
import { allocateAggregateControlFill } from "@/lib/aggregate-control-fill"
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
import { LiveSlotLookupCache } from "@/lib/live-slot-lookup-cache"
import { createHash } from "node:crypto"
import { LiveEntryBudgetBlockCache } from "@/lib/live-entry-budget-block-cache"
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
import { readFreshPositionSnapshot } from "@/lib/fresh-position-snapshot"
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
  getBlockCountLifecycleState,
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
import { findDeactivatedLiveConfig, recordLiveConfigOutcome } from "@/lib/live-config-performance"
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

// â”€â”€ Position snapshot cache for cycle-level deduplication â”€â”€
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
 * Resolve the quote-currency â†’ USD leg required for a cross Forex pair.
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

  const LIVE_ENTRY_HALT_DEFAULT_MS = 30_000
  const LIVE_ENTRY_HALT_MAX_MS = 10 * 60_000

  function liveEntryHaltKey(connectionId: string): string {
    return `live:entry-halt:${connectionId}`
  }

  function retryAtFromSnapshotStatus(connector: any): number | undefined {
    try {
      const status = connector?.getLastPositionsSnapshotStatus?.()
      const retryAt = Number(status?.retryAt)
      return Number.isFinite(retryAt) && retryAt > Date.now() ? retryAt : undefined
    } catch {
      return undefined
    }
  }

  async function haltLiveEntriesForSnapshotFailure(
    connectionId: string,
    connector: any,
    fallbackReason: string,
  ): Promise<void> {
    if (!connectionId) return
    const client = getRedisClient()
    const retryAt = retryAtFromSnapshotStatus(connector)
    const ttlMs = Math.min(
      LIVE_ENTRY_HALT_MAX_MS,
      Math.max(LIVE_ENTRY_HALT_DEFAULT_MS, (retryAt || 0) - Date.now()),
    )
    const reason = String(connector?.getLastPositionsSnapshotStatus?.()?.error || fallbackReason)
    const key = liveEntryHaltKey(connectionId)
    const value = JSON.stringify({ at: Date.now(), retryAt: retryAt || Date.now() + ttlMs, reason })
    if (typeof client?.setex === "function") {
      await client.setex(key, Math.ceil(ttlMs / 1000), value).catch(() => 0)
    } else if (typeof client?.set === "function") {
      await client.set(key, value, { EX: Math.ceil(ttlMs / 1000) }).catch(() => 0)
    }
  }

  async function clearLiveEntryHalt(connectionId: string): Promise<void> {
    if (!connectionId) return
    const client = getRedisClient() as any
    if (typeof client?.del === "function") await client.del(liveEntryHaltKey(connectionId)).catch(() => 0)
  }

  // A protection halt is deliberately sticky after an ambiguous venue write.
  // It must not disappear merely because a process restarted or because one
  // transient snapshot happened to be empty.  Once the connector has supplied
  // two fresh, identical *authoritative* empty-book observations, however,
  // there is no owned exposure left that could be unprotected and the stale
  // halt can be retired safely.  The observation is kept in Redis so the
  // proof survives worker hand-off and is never inferred from process memory.
  const EMPTY_BOOK_HALT_OBSERVATION_TTL_SECONDS = 120
  const EMPTY_BOOK_HALT_CONFIRMATION_MIN_AGE_MS = 1_500
  const EMPTY_BOOK_HALT_OBSERVATION_KEY = (connectionId: string) =>
    `live:entry-protection-halt-observation:${connectionId}`

  function venuePositionQuantityForEmptyBook(row: Record<string, any>): number | null {
    const candidates = [
      row?.contracts,
      row?.positionAmt,
      row?.position_amount,
      row?.quantity,
      row?.size,
    ].filter((value) => value !== undefined && value !== null && value !== "")
    if (candidates.length === 0) return null
    const parsed = candidates.map((value) => Number(value))
    if (parsed.some((value) => !Number.isFinite(value))) return null
    return Math.max(...parsed.map((value) => Math.abs(value)))
  }

  function isAuthoritativeVenueBookFlat(
    venuePositions: readonly Record<string, any>[],
  ): boolean {
    return Array.isArray(venuePositions) && venuePositions.every((row) => {
      const quantity = venuePositionQuantityForEmptyBook(row)
      return quantity !== null && quantity <= 1e-10
    })
  }

  function isEmptyBookProtectionSafe(input: {
    connectionId: string
    localOpenPositionCount: number
    venuePositions: readonly Record<string, any>[]
    liveOrderIds: LiveOrderIdSet | null
  }): boolean {
    const observed = input.liveOrderIds?.observedOrdersById
    let systemOrderCount = 0
    if (observed instanceof Map) {
      for (const order of observed.values()) {
        const clientOrderId = order?.clientOrderId
          ?? order?.clientOrderID
          ?? order?.client_oid
          ?? order?.clOrdId
        if (isConnectionOwnedClientOrderId(clientOrderId, input.connectionId)) {
          systemOrderCount++
        }
      }
    } else if (input.liveOrderIds instanceof Set) {
      // Without venue order objects, numeric ids cannot be classified safely.
      systemOrderCount = input.liveOrderIds.size
    }
    return input.localOpenPositionCount === 0
      && input.liveOrderIds instanceof Set
      && Array.isArray(input.venuePositions)
      && systemOrderCount === 0
  }

  function emptyBookProtectionFingerprint(
    connectionId: string,
    venuePositions: readonly Record<string, any>[],
    liveOrderIds: Set<string>,
  ): string {
    const venue = venuePositions.map((row) => ({
      symbol: String(row?.symbol || row?.Symbol || "").toUpperCase().replace(/[-_]/g, ""),
      direction: String(row?.positionSide || row?.position_side || row?.side || "").toLowerCase(),
      quantity: venuePositionQuantityForEmptyBook(row),
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    return createHash("sha256")
      .update(JSON.stringify({
        connectionId,
        venue,
        orderIds: [...liveOrderIds].map(String).sort(),
      }))
      .digest("hex")
  }

  async function reconcileEmptyBookProtectionHalt(input: {
    connectionId: string
    localOpenPositions: readonly LivePosition[]
    venuePositions: readonly Record<string, any>[]
    liveOrderIds: Set<string> | null
  }): Promise<"not_halted" | "observed" | "cleared" | "unsafe"> {
    const { connectionId, localOpenPositions, venuePositions, liveOrderIds } = input
    if (!connectionId) return "unsafe"
    const client = getRedisClient() as any
    const haltKey = entryProtectionHaltKeyOf(connectionId)
    const observationKey = EMPTY_BOOK_HALT_OBSERVATION_KEY(connectionId)
    const halt = typeof client?.get === "function"
      ? await client.get(haltKey).catch(() => null)
      : null
    if (!halt) {
      if (typeof client?.del === "function") await client.del(observationKey).catch(() => 0)
      return "not_halted"
    }

    const safe = isEmptyBookProtectionSafe({
      connectionId,
      localOpenPositionCount: localOpenPositions.length,
      venuePositions,
      liveOrderIds,
    })
    if (!safe) {
      if (typeof client?.del === "function") await client.del(observationKey).catch(() => 0)
      return "unsafe"
    }

    const fingerprint = emptyBookProtectionFingerprint(connectionId, venuePositions, liveOrderIds!)
    const now = Date.now()
    let previous: { fingerprint?: string; observedAt?: number } | null = null
    if (typeof client?.get === "function") {
      const raw = await client.get(observationKey).catch(() => null)
      if (raw) {
        try {
          const parsed = JSON.parse(String(raw))
          if (parsed && typeof parsed === "object") previous = parsed
        } catch {
          previous = null
        }
      }
    }

    const previousAt = Number(previous?.observedAt || 0)
    const sameFreshSnapshot = previous?.fingerprint === fingerprint
      && previousAt > 0
      && now - previousAt >= EMPTY_BOOK_HALT_CONFIRMATION_MIN_AGE_MS
      && now - previousAt <= EMPTY_BOOK_HALT_OBSERVATION_TTL_SECONDS * 1000
    if (sameFreshSnapshot) {
      // reconcileLivePositions already owns the connection-wide live-sync
      // lease. Delete only after both snapshots passed the empty-book proof.
      await client.del(haltKey).catch(() => 0)
      await client.del(observationKey).catch(() => 0)
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "info",
        "Cleared stale entry-protection halt after two authoritative empty-book snapshots",
        { localOpenPositions: 0, venuePositions: venuePositions.length, openOrderIds: 0 },
      ).catch(() => {})
      return "cleared"
    }

    const observation = JSON.stringify({ fingerprint, observedAt: now })
    if (typeof client?.setex === "function") {
      await client.setex(observationKey, EMPTY_BOOK_HALT_OBSERVATION_TTL_SECONDS, observation).catch(() => 0)
    } else if (typeof client?.set === "function") {
      await client.set(observationKey, observation, { EX: EMPTY_BOOK_HALT_OBSERVATION_TTL_SECONDS }).catch(() => 0)
    }
    return "observed"
  }

  async function readLiveEntryHalt(connectionId: string): Promise<string | null> {
    if (!connectionId) return null
    const client = getRedisClient() as any
    if (typeof client?.get !== "function") return null
    const raw = await client.get(liveEntryHaltKey(connectionId)).catch(() => null)
    if (!raw) return null
    try {
      const parsed = JSON.parse(String(raw))
      return String(parsed?.reason || "authoritative venue position snapshot unavailable")
    } catch {
      return String(raw)
    }
  }

  function parseExchangeData(value: unknown): Record<string, any> {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>
    if (typeof value !== "string") return {}
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  function hasLiveExchangeHandle(position: Record<string, any>): boolean {
    const exchangeData = parseExchangeData(position.exchangeData)
    const handles = [
      position.orderId,
      position.exchangeOrderId,
      position.clientOrderId,
      position.exchangePositionId,
      position.positionId,
      position.closeOrderId,
      exchangeData.orderId,
      exchangeData.exchangeOrderId,
      exchangeData.clientOrderId,
      exchangeData.exchangePositionId,
      exchangeData.positionId,
    ]
    if (handles.some((value) => String(value ?? "").trim().length > 0)) return true
    return Array.isArray(exchangeData.clientOrderIds) && exchangeData.clientOrderIds.length > 0
  }

  function shouldPersistCanonicalLivePosition(position: Record<string, any>): boolean {
    const status = String(position.status || "").trim().toLowerCase()
    if (status !== "rejected" && status !== "error") return true
    const executedQuantity = Math.max(
      Number(position.executedQuantity || 0),
      Number(position.totalExecutedQuantity || 0),
      Number(position.closedQuantity || 0),
    )
    if (executedQuantity > 0 || hasLiveExchangeHandle(position)) return true
    if (
      ["placed", "pending_fill", "placed_unconfirmed"].includes(status) ||
      position.submissionState === "unconfirmed" ||
      position.pendingAccumulation ||
      position.pendingReduction ||
      position.pendingSystemAction ||
      position.pendingQuantityMutation ||
      position.pendingProtectionOrders
    ) return true
    return false
  }

  async function discardTransientLivePosition(client: any, position: LivePosition): Promise<void> {
    const positionId = String(position.id || "")
    if (!positionId) return
    const posKey = `live_positions:${position.connectionId}:${positionId}`
    const jsonKey = `live:position:${positionId}`
    const openIndexKey = `live:positions:${position.connectionId}`
    const closedIndexKey = `live:positions:${position.connectionId}:closed`
    const stored = typeof client?.hgetall === "function"
      ? await client.hgetall(posKey).catch(() => ({}))
      : {}
    const storedRecord = stored && typeof stored === "object" ? stored : {}
    const storedStatus = String(storedRecord.status || "").trim().toLowerCase()
    const storedExecutedQuantity = Math.max(
      Number(storedRecord.executedQuantity || 0),
      Number(storedRecord.totalExecutedQuantity || 0),
      Number(storedRecord.closedQuantity || 0),
    )
    if (
      Object.keys(storedRecord).length > 0 &&
      (storedExecutedQuantity > 0 || hasLiveExchangeHandle(storedRecord) || !["pending", "placed", "pending_fill", "placed_unconfirmed"].includes(storedStatus))
    ) return

    const deleteKey = (key: string) => typeof client?.del === "function" ? client.del(key).catch(() => 0) : Promise.resolve(0)
    const removeFromList = (key: string) => typeof client?.lrem === "function"
      ? client.lrem(key, 0, positionId).catch(() => 0)
      : Promise.resolve(0)
    await Promise.all([
      deleteKey(posKey),
      deleteKey(jsonKey),
      removeFromList(openIndexKey),
      removeFromList(closedIndexKey),
      updateSignalAdmissionIndexes(client, { ...position, status: "rejected" }).catch(() => 0),
    ])
    const direction = resolveLivePositionDirection(position)
    if (direction) {
      const slotKey = livePositionSlotIndexKey(
        position.connectionId,
        position.symbol,
        direction,
        liveExecutionSlot(position),
      )
      await evalLockLua(client, RELEASE_LOCK_LUA, slotKey, [positionId]).catch(() => 0)
    }
    const trackingIds = new Set<string>([
      positionId,
      position.orderId,
      position.system_tracking_id,
      position.connection_tracking_id,
    ].map((value) => String(value || "").trim()).filter(Boolean))
    await Promise.all(Array.from(trackingIds).map((trackingId) =>
      client.del(`live:position:tracking:${position.connectionId}:${trackingId}`).catch(() => 0),
    ))
    updateSimulatedPositionStageRow({ ...position, status: "rejected" })
  }

  // â”€â”€ BingX code=110206: TP/SL order quota exceeded â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// When the account's open SL/TP order count reaches the exchange limit, every
// placeStopOrder call returns 110206. Without a circuit breaker the reconcile
// loop retries every cycle (~150/min), flooding the exchange log and burning
// API rate-limit budget. This map records the earliest time the engine is
// allowed to attempt protection placement again for a given connectionId.
// The cooldown window is 60 s â€” long enough for the operator to see the error
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
      `${LOG_PREFIX} [ProtectionQuota] ${connId}: code=110206 quota exceeded â€” suspending SL/TP placement for ${PROTECTION_QUOTA_BACKOFF_MS / 1000}s`,
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
      `${LOG_PREFIX} [TriggerFrequency] ${connId}: code=100410 endpoint throttled â€” suspending cancellations for ${TRIGGER_FREQUENCY_BACKOFF_MS / 1000}s`,
    )
  }
  triggerFrequencyBackoff.set(connId, until)
}

/**
 * Compute the initial SL% for a newly-created live position using the Set's
 * own configuration. Each variant has a different protection contract:
 *
 *   trailing â€” The trailing machine anchors from `trailingProfile.stopRatio`
 *              (the trailing distance, e.g. 0.1 = 10%). Using the generic
 *              PF-derived SL here would conflict with the ratchet: the first
 *              tick would re-derive the SL from a different basis and either
 *              widen or tighten the live exchange order beyond the operator's
 *              trailing spec. We use `stopRatio * 100` as the initial SL%
 *              so the exchange order always starts at the trailing stop distance.
 *              This is overridden per-tick by `trailingStopPrice` once active.
 *
 *   block    â€” Block positions are additive add-ons at scaled size (1.5â€“2Ã—).
 *              The SL must NOT widen with the size multiplier (that would
 *              multiply risk). The `derivedSl` from PF is already size-multiplier-
 *              scaled inside `deriveProtectionFromProfitFactor` (stopLossPct =
 *              baseRiskPct * sizeMultiplier). We apply a FLOOR of the standard
 *              minimum to ensure the block SL never compresses below exchange min.
 *
 *   dca      â€” DCA is a recovery trade (0.5Ã— size). Tighter SL is correct â€”
 *              the PF-derived value (stopLossPct = baseRiskPct * 0.5) already
 *              reflects this. We apply the same floor. No override needed.
 *
 *   default/other â€” Use the PF-derived value as-is.
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
    // is already variant-adjusted (block: scaled up by sizeMultiplier, dca: 0.5Ã—).
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

// â”€â”€ Exchange call timeouts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Target: syncWithExchange completes in <1 s on the hot path.
// These timeouts bound per-call worst case so the pool never hangs.
// Each value is calibrated to a ~2Ã—p99 RTT of a typical BingX API call
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

// â”€â”€ Global SL/TP placement semaphore â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ï¿½ï¿½â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 4 symbols Ã— 2 directions Ã— 2 stops (SL+TP) = up to 16 concurrent stop calls.
// BingX rate limiter now allows 5 concurrent requests (maxConcurrent=5).
// Limit=6 lets 6 stop calls run in parallel; ceil(16/6)=3 passes at ~5s p99
// each = ~15s total flush â€” vs ceil(16/3)=6 passes Ã— 5s = ~30s at the old limit.
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
  /** Quote-currency â†’ USD rate used for cross-pair notional/PnL. */
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
  /** Immutable upstream Real-stage PF snapshot used for Realâ†”Live comparison. */
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
  // â”€â”€ Trailing stop state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Written by syncLiveFromPseudo when the pseudo position's trailing machine
  // is armed. These fields make the ratcheted absolute stop price available to
  // computeDesiredProtectionPrices and checkAndForceCloseOnSltpCross so that
  // the trailing level â€” not the original static percentage â€” is used for both
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
  // â”€â”€ Race condition prevention (Redis-backed mutation lock) â”€â”€
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
  blockEffectiveIncrementStep?: number
  blockLifecycleKey?: string
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
    dcaSetQuantityBefore?: number
    dcaTargetQuantity?: number
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
  blockEffectiveIncrementStep?: number
  blockLifecycleKey?: string
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
  // target factor 1 + count Ã— ratio; DCA=0.5; others=1). Stored for audit and
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
  /** Cumulative contributions allow late price/fee corrections without quantity replay. */
  reductionAccounting?: Record<string, {
    quantity: number; baseQuantity: number; gross: number; net: number; fees: number;
    entryFee: number; entryFeeComplete: boolean; complete: boolean;
  }>
  /**
   * Quantity observed from an authoritative venue position that is not
   * represented by an individual local fill row. This remains separate from
   * `fills` so an unverified order/fee settlement is never fabricated.
   */
  exchangeQuantityAdjustments?: ExchangeQuantityAdjustment[]
  controlOrderScope?: ControlOrderScope
  /** Immutable allocations persisted before applying any cumulative shared fill. */
  aggregateControlFills?: Record<string, { members: Record<string, number>; leg: "stopLoss" | "takeProfit" | "securityStop" }>
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
    controlOrderScope?: ControlOrderScope
    protectionMode: "exchange_control" | "hybrid_control_system" | "system_close" | "system_close_fallback"
    aggregateProtectionOwner: boolean
    aggregateProtectionKey?: string
    /** Position that owns the shared aggregate-quantity security stop for this physical slot. */
    aggregateProtectionLeaderId?: string
    stopLossOrderId?: string
    takeProfitOrderId?: string
    stopLossArmedQuantity?: number
    takeProfitArmedQuantity?: number
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
  // â”€â”€ Set-config propagation (Set Relations â†’ Position Protection) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The originating StrategySet's trailing profile and historical performance
  // snapshot are carried into the live position so that:
  //   1. Trailing-variant positions use `trailingProfile.stopRatio` as the
  //      initial SL distance anchor rather than a generic PF-derived value
  //      (the trailing machine ratchets from this anchor, not from a flat %).
  //   2. `prevPos` provides the historical success rate and PF context that
  //      the Set was scored against, available for audit and future re-scoring.
  // Both fields ride verbatim from StrategySet â†’ RealPosition â†’ LivePosition
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

function livePositionAccountingClass(
  position: Pick<LivePosition, "setVariant" | "setKey">,
): LiveMetricAccountingClass {
  const variant = String(position.setVariant || "").trim().toLowerCase()
  if (variant === "block" || variant === "dca") return "control"
  const setKey = String(position.setKey || "").trim().toLowerCase()
  // Older rows may have been written before setVariant was persisted. Keep
  // those rows out of the entry denominator when their durable key still
  // identifies a Block/DCA lane.
  return /(?:^|[#:_-])(?:block|dca)(?:[:#_-]|$)/.test(setKey)
    ? "control"
    : "entry"
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
  const accountingClass = livePositionAccountingClass(position)
  await incrementMetric(connectionId, "live_orders_filled_count", 1, accountingClass)
  await incrementOrdersBySymbol(connectionId, symbol, direction, "filled", accountingClass)
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

// â”€â”€ Helper function stubs (defined in adjacent modules) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  const previousContribution = position.reductionAccounting?.[input.executionId]
  if (!(result.deltaApplied > 0) && !(input.settlement && previousContribution)) return result

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
  const priorContributions = Object.values(position.reductionAccounting || {})
  const priorAccountedQuantity = priorContributions.reduce((sum, value) => sum + value.quantity, 0)
  const untrackedClosedQuantity = Math.max(0, closedBefore - priorAccountedQuantity)
  const baseQuantity = previousContribution?.baseQuantity ?? Math.max(0, Number(input.previouslyAppliedQuantity || 0))
  const representedQuantity = Math.max(0, result.cumulativeApplied - baseQuantity)
  let gross = previousContribution?.gross || 0
  let net = previousContribution?.net || 0
  let fees = previousContribution?.fees || 0
  let entryFee = previousContribution?.entryFee || 0
  const entryFeeComplete = settlement?.netIncludesEntryFee === true || (
    position.entryAccountingComplete === true && (previousContribution?.entryFeeComplete ?? true)
  )
  if (settlement?.netIncludesEntryFee) {
    position.entryTradingFeeAllocated = Math.max(0, Number(position.entryTradingFeeAllocated || 0) - entryFee)
    entryFee = 0
  } else if (result.deltaApplied > 0) {
    const remainingEntryFee = Math.max(0, Number(position.entryTradingFee || 0) - Number(position.entryTradingFeeAllocated || 0))
    const additionalEntryFee = before > 0 ? remainingEntryFee * Math.min(1, result.deltaApplied / before) : 0
    entryFee += additionalEntryFee
    position.entryTradingFeeAllocated = Number((Number(position.entryTradingFeeAllocated || 0) + additionalEntryFee).toFixed(12))
  }
  let complete = false
  if (settlement && Number(settlement.filledQuantity) > 0) {
    const ratio = Math.min(1, representedQuantity / Number(settlement.filledQuantity))
    gross = Number(settlement.grossRealizedPnl || 0) * ratio
    net = Number(settlement.netRealizedPnl || 0) * ratio - entryFee
    fees = Math.max(0, Number(settlement.tradingFee || 0)) * ratio + entryFee
    complete = baseQuantity === 0 && entryFeeComplete
    position.settledOrderIds = Array.from(new Set([...(position.settledOrderIds || []), settlement.orderId])).slice(-64)
  } else if (executionPrice > 0 && entryPrice > 0) {
    gross = position.marketType === "forex" || position.volumeKind === "lots"
      ? forexPriceMovePnlUsd(position.direction === "short" ? "short" : "long", representedQuantity,
          entryPrice, executionPrice, position.symbol, positionUnitMultiplier(position), position.quoteToUsdRate)
      : representedQuantity * (position.direction === "short" ? entryPrice - executionPrice : executionPrice - entryPrice)
    net = gross - entryFee
    fees = entryFee
    complete = isSimulation && baseQuantity === 0
  }
  position.realizedPnlGross = Number((Number(position.realizedPnlGross || 0) + gross - Number(previousContribution?.gross || 0)).toFixed(12))
  position.realizedPnL = Number((Number(position.realizedPnL || 0) + net - Number(previousContribution?.net || 0)).toFixed(12))
  position.tradingFees = Number((Number(position.tradingFees || 0) + fees - Number(previousContribution?.fees || 0)).toFixed(12))
  position.reductionAccounting = {
    ...position.reductionAccounting,
    [input.executionId]: { quantity: result.cumulativeApplied, baseQuantity, gross, net, fees, entryFee, entryFeeComplete, complete },
  }
  position.realizedPnlComplete = untrackedClosedQuantity <= Math.max(1e-10, before * 1e-10)
    && Object.values(position.reductionAccounting).every((value) => value.complete)
  position.realizedPnlSource = isSimulation ? "simulation_model"
    : position.realizedPnlComplete ? "exchange_settlement"
      : executionPrice > 0 ? "exchange_fills_incomplete_fees" : "exchange_unresolved"
  position.updatedAt = Date.now()
  if (!(result.deltaApplied > 0)) {
    const execution = position.partialOrderExecutions?.find((value) => value.id === input.executionId)
    if (execution && executionPrice > 0) execution.price = executionPrice
    return result
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
      reason: `SL ${n}% below minimum ${MIN_EXCHANGE_STOP_LOSS_PERCENT}% â€” using minimum`,
    }
  }
  return { value: n, adjusted: false }
}

/**
 * Normalize the durable percentage pair immediately before an exchange or
 * paper protection calculation.  This is the last common boundary shared by
 * initial placement, accumulation, restart recovery and operator re-arm, so
 * an imported/stale position cannot reintroduce a missing stop or widen SL
 * beyond the systemwide 1.5Ã—TP contract.
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
// Reading and closing every row on each 200â€“280 ms LivePositions tick makes
// an otherwise healthy server spend its entire event loop in lifecycle scans.
// Keep the positions in their own short-lived Stage read model and rotate a
// bounded, fair row slice on every tick. A row can therefore never disappear
// from management: it is revisited within one bounded sweep, while new/closed
// rows update the Stage cache immediately through savePosition().
const SIMULATED_POSITION_STAGE_BATCH_SIZE = 96
const liveEntryBudgetBlocks = new LiveEntryBudgetBlockCache()
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
    reductionAccounting: typeof hash.reductionAccounting === "string"
      ? safeJsonParse(hash.reductionAccounting, undefined) : hash.reductionAccounting,
    aggregateControlFills: typeof hash.aggregateControlFills === "string"
      ? safeJsonParse(hash.aggregateControlFills, undefined)
      : hash.aggregateControlFills,
    controlOrderSetCoverage: typeof hash.controlOrderSetCoverage === "string"
      ? safeJsonParse(hash.controlOrderSetCoverage, undefined)
      : hash.controlOrderSetCoverage,
    aggregateProtectionOwner: hash.aggregateProtectionOwner === undefined
      ? undefined : parseRedisBoolean(hash.aggregateProtectionOwner),
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
 * the reservation through savePosition's normal openâ†’closed transition.
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
  if (!shouldPersistCanonicalLivePosition(position as unknown as Record<string, any>)) {
    await discardTransientLivePosition(client, position)
    return
  }
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
      // Only settled exchange outcomes feed the permanent per-Set loss gate.
      // Accounting corrections/replayed closes are idempotent in the ledger.
      await recordLiveConfigOutcome(position)
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
 * Reduces Redis round-trips from N Ã— savePosition() to 1 batch operation.
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
type LiveMetricAccountingClass = "entry" | "control"

function metricForAccountingClass(
  metric: string,
  accountingClass: LiveMetricAccountingClass,
): string {
  if (accountingClass !== "control") return metric
  const controlMetrics: Record<string, string> = {
    live_orders_attempted_count: "live_control_orders_attempted_count",
    live_orders_placed_count: "live_control_orders_placed_count",
    live_orders_filled_count: "live_control_orders_filled_count",
    live_orders_failed_count: "live_control_orders_failed_count",
    live_orders_preflight_failed_count: "live_control_orders_preflight_failed_count",
    live_orders_simulated_count: "live_control_orders_simulated_count",
    live_simulated_positions_created_count: "live_control_simulated_positions_created_count",
    live_simulated_volume_usd_total: "live_control_simulated_volume_usd_total",
    live_simulated_volume_microusd_total: "live_control_simulated_volume_microusd_total",
    live_simulated_orders_accumulated_count: "live_control_orders_accumulated_count",
    live_orders_accumulated_count: "live_control_orders_accumulated_count",
    live_positions_created_count: "live_control_positions_created_count",
    live_volume_usd_total: "live_control_volume_usd_total",
    live_margin_cents_total: "live_control_margin_cents_total",
  }
  return controlMetrics[metric] || metric
}

async function incrementMetric(
  connectionId: string,
  metric: string,
  delta: number = 1,
  accountingClass: LiveMetricAccountingClass = "entry",
): Promise<void> {
  try {
    // Use validated wrapper to prevent stale metric writes
    const { getCurrentEpoch } = await import("@/lib/trade-engine/progression-lock")
    const { hincrbyProgression, hincrbyProgressionBatch } = await import("@/lib/trade-engine/progression-writes")
    
    const currentEpoch = await getCurrentEpoch(connectionId)
    if (!currentEpoch) return // No active lock, skip write (stale instance)
    
    const effectiveMetric = metricForAccountingClass(metric, accountingClass)

    // Placement and failure are terminal outcomes of one attempted dispatch.
    // Update the outcome and attempted counters in one validated batch so an
    // epoch hand-off cannot leave `attempted` one behind `placed + failed`.
    if (
      effectiveMetric === "live_orders_placed_count"
      || effectiveMetric === "live_orders_failed_count"
      || effectiveMetric === "live_control_orders_placed_count"
      || effectiveMetric === "live_control_orders_failed_count"
    ) {
      const attemptedMetric = accountingClass === "control"
        ? "live_control_orders_attempted_count"
        : "live_orders_attempted_count"
      await hincrbyProgressionBatch(connectionId, {
        [effectiveMetric]: delta,
        [attemptedMetric]: delta,
      }, {
        connectionId,
        epoch: currentEpoch,
        logStaleRejects: false,
      })
      return
    }

    // Use the single-field validated wrapper for all non-terminal metrics.
    await hincrbyProgression(connectionId, effectiveMetric, delta, {
      connectionId,
      epoch: currentEpoch,
      logStaleRejects: false,
    })
  } catch (err) {
    // metric failures should not throw the live pipeline
  }
}
async function incrementOrdersBySymbol(
  connectionId: string,
  symbol: string,
  side: string,
  metric: string,
  accountingClass: LiveMetricAccountingClass = "entry",
): Promise<void> {
  try {
    const { getCurrentEpoch } = await import("@/lib/trade-engine/progression-lock")
    const { recordPerSymbolOrderCounter } = await import("@/lib/live-order-service")
    const sideKey = String(side || "").trim().toLowerCase()
    const dir =
      sideKey === "long" || sideKey === "buy"
        ? "long"
        : sideKey === "short" || sideKey === "sell"
          ? "short"
          : null
    if (!dir || !["placed", "filled", "failed"].includes(metric)) return
    // The v2 hash is intentionally an entry-order forensic view. Control and
    // DCA events have their own progression lane and must not make an entry
    // symbol look like it is failing repeatedly.
    if (accountingClass === "control") return
    const symbolKey = String(symbol || "").trim().toUpperCase()
    const currentEpoch = await getCurrentEpoch(connectionId)
    if (!currentEpoch) return // Do not leave an unowned per-symbol stale row.
    await recordPerSymbolOrderCounter(connectionId, symbolKey, dir, metric as any, {
      epoch: currentEpoch,
      requireEpoch: true,
    })
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
      // Block/DCA fills and failures mutate an existing physical slot (or a
      // control lane), never a new entry order. Keep them out of the global
      // entry attempted/failed counters so the overview reflects venue-entry
      // health rather than adjustment traffic.
      countEntryOrder: false,
      source: "control-adjustment",
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
    // Atomic SET key token NX EX 300 â€” the ONLY correct dedup primitive.
    // `NX` guarantees exclusivity (a second concurrent entry on the same
    // symbol+direction gets `null` and falls through to the accumulate
    // path); `EX` guarantees the lock self-expires so a crashed engine
    // can never strand a slot. The previous lowercase `{ ex: 300 }` was
    // silently ignored by the client (which honours only `{ EX, NX, XX }`),
    // so the lock had neither a TTL nor exclusivity â€” every signal
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
    ? calculateBlockVolumeMultiplier(blockCount, volumeRatio, incrementSteps, source.blockEffectiveIncrementStep)
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
      entryPrice: Number(source.entryPrice || 0),
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

const liveSlotLookupCache = new LiveSlotLookupCache()

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

  // Every missing candidate formerly reloaded the entire open book. Thousands
  // of distinct Signal lanes at capacity then deserialized the same 350 rows
  // twice per candidate. Compare complete durable membership and retain only
  // slot -> IDs; a matching position is always read fresh before it is used.
  const ids = await client.lrange(`live:positions:${connId}`, 0, -1)
  const matches = await liveSlotLookupCache.lookup(connId, ids.map(String), slotKey, async (members) => {
    const rows: Array<{ id: string; slot: string }> = []
    for (let offset = 0; offset < members.length; offset += 32) {
      const positions = await Promise.all(members.slice(offset, offset + 32)
        .map((id) => readLivePositionSnapshot(client, connId, id).catch(() => null)))
      for (const position of positions) {
        if (!position || !position.direction || !isActiveLiveSlotStatus(position.status)) continue
        rows.push({ id: position.id, slot: livePositionSlotIndexKey(connId, position.symbol, position.direction, liveExecutionSlot(position)) })
      }
    }
    return rows
  })
  for (const id of matches) {
    const position = await readLivePositionSnapshot(client, connId, id).catch(() => null)
    if (position && matchesLiveSlot(position, symbol, side, executionSlot)) {
      await client.set(slotKey, position.id, { NX: true }).catch(() => null)
      return position
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
  blockEffectiveIncrementStep?: number
  blockLifecycleKey?: string
  dcaStep?: number
  dcaSetQuantityBefore?: number
  dcaTargetQuantity?: number
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
    const blockEffectiveIncrementStep = real?.blockEffectiveIncrementStep || 1
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
      blockEffectiveIncrementStep,
    )
    const blockTargetQuantity = calculateBlockTargetQuantity(
      blockBaseQuantity,
      blockCount,
      blockVolumeRatio,
      blockIncrementSteps,
      blockEffectiveIncrementStep,
    )
    const addQty = calculateBlockRemainingAddQuantity(
      blockBaseQuantity,
      blockCount,
      blockVolumeRatio,
      blockConfirmedAddQuantity,
      blockIncrementSteps,
      blockEffectiveIncrementStep,
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
      blockEffectiveIncrementStep,
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
        || (existing.dcaLegs || []).some((leg) => Number(leg?.step) === requestedDcaStep && leg.targetSatisfied !== false)
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
    const dcaSetQuantityBefore = Number(existing.dcaLegs?.find((leg) => leg.step === next.step)?.quantity || 0)
    const dcaTargetQuantity = baseQuantity * next.volumeMultiplier
    const remainingStepQuantity = Math.max(0, dcaTargetQuantity - dcaSetQuantityBefore)
    const addQty = calculateDcaAddQuantity(
      baseQuantity,
      baseQuantity > 0 ? remainingStepQuantity / baseQuantity : 0,
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
      dcaSetQuantityBefore,
      dcaTargetQuantity,
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
      entryPrice: Number(position.averageExecutionPrice || position.entryPrice || 0),
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
    const current = await readLivePositionSnapshot(getRedisClient(), connId, existing.id)
    if (!current || !isActiveLiveSlotStatus(current.status)) return current || existing
    existing = current
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
          entryPrice: price,
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
          quantity: Number(plan.dcaSetQuantityBefore || 0) + filledQty,
          targetQuantity: plan.dcaTargetQuantity,
          targetSatisfied: true,
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
  if (allowNewExchangeMutation) {
    const disabled = await findDeactivatedLiveConfig(connId,
      { ...real, executionIntent: existing.executionIntent || "main" }, await getAppSettings())
    if (disabled) {
      // Recover an already submitted adjustment and its protection below,
      // but never send a new add-on for a deactivated Set.
      allowNewExchangeMutation = false
      pushStep(existing, "live_config_performance", false, `Set deactivated: last ${disabled.window} settled positions net ${disabled.netPnl}`)
    }
  }
  if (allowNewExchangeMutation) await assertMarginCallEntryAllowed(connId, connector)
  // Block and DCA are adjustment-only variants: they add an independently
  // calculated leg to an authoritative parent instead of opening competing
  // exchange positions for the same symbol/direction.
  const lockId = `accumulate:${process.pid}:${Date.now()}:${nanoid(8)}`
  const locked = await acquirePositionMutationLock(connId, existing.id, lockId)
  if (!locked) {
    pushStep(existing, "accumulate_skip", false, "position mutation lock already held â€” accumulation deferred")
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
    const current = await readLivePositionSnapshot(getRedisClient(), connId, existing.id)
    if (!current || !isActiveLiveSlotStatus(current.status)) return current || existing
    existing = current
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
      pushStep(existing, "accumulate_skip", false, "exchange connector unavailable â€” accumulation deferred")
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
        "connection-wide protection admission is busy â€” accumulation deferred",
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
      existing.statusReason = "Live Trade disabled â€” exchange position tracked; adjustment deferred"
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
    connId,
  )

    if (!authoritativeBeforeAccumulation.ok) {
      pushStep(
        existing,
        "accumulate_quantity_snapshot",
        false,
        "authoritative venue quantity unavailable â€” no exposure increase submitted",
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
      pushStep(existing, "accumulation_quantity_normalized", true, `${accumulationExecutable.requestedQuantity} â†’ ${plan.addQty} (${accumulationExecutable.reason || "exchange quantity rules"})`)
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
      blockEffectiveIncrementStep: plan.blockEffectiveIncrementStep ?? real?.blockEffectiveIncrementStep,
      blockLifecycleKey: real?.blockLifecycleKey,
      blockVolumeIncrementRatio: Number(
        real?.blockVolumeIncrementRatio ||
        (plan.blockCount
          ? calculateBlockVolumeIncrementRatio(
              plan.blockCount,
              Number(real?.blockVolumeRatio || 1),
              plan.blockIncrementSteps,
              plan.blockEffectiveIncrementStep,
            )
          : 1),
      ),
      blockCalculatedVolumeMultiplier: plan.variant === "block" && plan.blockCount
        ? 1 + calculateBlockVolumeIncrementRatio(
            plan.blockCount,
            Number(real?.blockVolumeRatio || 1),
            plan.blockIncrementSteps,
            plan.blockEffectiveIncrementStep,
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
      dcaSetQuantityBefore: plan.dcaSetQuantityBefore,
      dcaTargetQuantity: plan.dcaTargetQuantity,
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
    const orderFillComplete = filledQty >= plan.addQty - requestedTolerance
    const dcaSetQuantity = Number(pending.dcaSetQuantityBefore || 0) + filledQty
    const accumulationTargetSatisfied = plan.variant === "dca"
      ? dcaSetQuantity >= Number(plan.dcaTargetQuantity || plan.addQty) - requestedTolerance
      : orderFillComplete
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
    const retainPartialPending = !orderFillComplete && !terminalFillStatus
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
        : !accumulationTargetSatisfied
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
          entryPrice: filledPrice,
          targetAdditionalQuantity: plan.blockTargetAddQuantity,
          confirmedAdditionalQuantityBefore: plan.blockConfirmedAddQuantity,
          targetBlockQuantity: plan.blockTargetQuantity,
          targetSatisfied: accumulationTargetSatisfied,
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
          quantity: dcaSetQuantity,
          targetQuantity: plan.dcaTargetQuantity,
          targetSatisfied: accumulationTargetSatisfied,
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
        accumulationTargetSatisfied ? "accumulate" : "accumulate_partial",
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
    if (accumulationTargetSatisfied && pending.combinedPosCounts) {
      await recordConfirmedStrategyEntry(
        connId,
        existing,
        `${existing.id}:combined:${pending.clientOrderId}`,
      )
    } else if (accumulationTargetSatisfied && pending.setKey) {
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
  connectionId?: string,
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
        if (connectionId) {
          await haltLiveEntriesForSnapshotFailure(
            connectionId,
            connector,
            "authoritative venue position snapshot unavailable",
          )
        }
        return { ok: false, quantity: 0, position: null }
      }
      if (!Array.isArray(snapshot)) {
        if (connectionId) {
          await haltLiveEntriesForSnapshotFailure(connectionId, connector, "invalid venue position snapshot")
        }
        return { ok: false, quantity: 0, position: null }
      }
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
        if (connectionId) {
          await haltLiveEntriesForSnapshotFailure(connectionId, connector, "ambiguous venue position snapshot")
        }
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
        if (connectionId) {
          await haltLiveEntriesForSnapshotFailure(connectionId, connector, "venue position direction is not authoritative")
        }
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
    if (snapshotStatus?.ok !== true && connectionId) {
      await haltLiveEntriesForSnapshotFailure(
        connectionId,
        connector,
        "authoritative venue position snapshot unavailable",
      )
    }
    return {
      ok: snapshotStatus?.ok === true,
      quantity: 0,
      position: null,
    }
  } catch {
    if (connectionId) {
      await haltLiveEntriesForSnapshotFailure(
        connectionId,
        connector,
        "authoritative venue position snapshot request failed",
      )
    }
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
    const authoritative = await fetchAuthoritativeOpenQuantity(connector, position.symbol, direction, position.connectionId)
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
      pushStep(draft, "poscounts_target_reduce", true, `${initialQuantity} â†’ ${targetQuantity} (simulation)`)
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
    pushStep(position, "poscounts_target_reduce", false, "position action already in progress â€” reduction deferred")
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
        "connection-wide protection admission is busy â€” reduction deferred",
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
      const authoritative = await fetchAuthoritativeOpenQuantity(connector, position.symbol, direction, position.connectionId)
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
    const authoritative = await fetchAuthoritativeOpenQuantity(connector, position.symbol, direction, position.connectionId)
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

/** Reconcile one exact Base-parent Ã— direction Pos-Count target.
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

  const authoritative = await fetchAuthoritativeOpenQuantity(connector, position.symbol, direction, position.connectionId)
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
    // accumulation was accepted and at least partially filled. Every variant
    // keeps its delivery identity until the full requested delta is confirmed;
    // a partial DCA fill must not permit the next step to overlap this order.
    const requestedTolerance = Math.max(1e-12, Number(pending.requestedQuantity || 0) * 1e-8)
    const orderFillComplete = exactAdded >= Number(pending.requestedQuantity || 0) - requestedTolerance
    const dcaSetQuantity = Number(pending.dcaSetQuantityBefore || 0) + exactAdded
    const accumulationTargetSatisfied = pending.variant === "dca"
      ? dcaSetQuantity >= Number(pending.dcaTargetQuantity || pending.requestedQuantity || 0) - requestedTolerance
      : orderFillComplete
    await recordPositionAdjustmentProgression(
      position.connectionId,
      position,
      "placed",
      pending.clientOrderId,
    )
    if (accumulationTargetSatisfied) {
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
        blockEffectiveIncrementStep: pending.blockEffectiveIncrementStep,
        blockLifecycleKey: pending.blockLifecycleKey,
        blockVolumeIncrementRatio: pending.blockVolumeIncrementRatio,
        blockCalculatedVolumeMultiplier: pending.blockCalculatedVolumeMultiplier,
        blockScope: pending.blockScope,
        blockLaneKind: pending.blockLaneKind,
        blockLaneKey: pending.blockLaneKey,
        blockSourceId: pending.blockSourceId,
      }, Number(pending.blockSetQuantityBefore || 0) + exactAdded, pending.clientOrderId, pending.orderId, {
        baseQuantity: pending.blockBaseQuantity,
        entryPrice: Number(exchangeEntryPrice || position.averageExecutionPrice || position.entryPrice || 0),
        targetAdditionalQuantity: pending.blockTargetAddQuantity,
        confirmedAdditionalQuantityBefore: pending.blockConfirmedAddQuantity,
        targetBlockQuantity: pending.blockTargetQuantity,
        targetSatisfied: accumulationTargetSatisfied,
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
        quantity: dcaSetQuantity,
        targetQuantity: pending.dcaTargetQuantity,
        targetSatisfied: accumulationTargetSatisfied,
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
    if (orderFillComplete) {
      position.pendingAccumulation = undefined
      pendingAccumulationCompleted = accumulationTargetSatisfied
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
    `authoritative exchange quantity ${before} â†’ ${exchangeQuantity}${exactAdded > 0 ? ` (+${exactAdded})` : ""}`,
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
  // getter returns the last cached snapshot â€” refreshed off the hot path
  // by `refreshEngineTimings()` â€” so the six reconcile/sweep call sites
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
 *   â€¢ BingX 101204 â€” Insufficient margin (top-up required)
 *   â€¢ BingX 80012  â€” Symbol not available for trading
 *   â€¢ Any error containing "insufficient margin" / "insufficient balance"
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
 * symbol not tradable, etc.) â€” see `isNonRecoverableExchangeError`. This
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
      // The connector returned `{ success: false, error: "â€¦" }` â€” check
      // whether that error is non-recoverable and bail early if so.
      if (isNonRecoverableExchangeError(result)) {
        console.warn(
          `${LOG_PREFIX} ${label} non-recoverable error detected â€” skipping remaining ${maxAttempts - attempt} attempt(s)`,
        )
        return result
      }
      // Min-order-size errors (code=101400) need a quantity correction, not
      // more retries with the same qty. Short-circuit immediately so the
      // caller's correction handler can run without waiting for 2 more attempts.
      if (isMinOrderSizeError(result)) {
        console.warn(
          `${LOG_PREFIX} ${label} min-order-size error â€” stopping retry loop for quantity correction`,
        )
        return result
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} ${label} attempt ${attempt}/${maxAttempts} error:`, err)
      // Thrown error variant â€” check the same predicates.
      if (isNonRecoverableExchangeError(err)) {
        console.warn(
          `${LOG_PREFIX} ${label} non-recoverable error detected â€” skipping remaining ${maxAttempts - attempt} attempt(s)`,
        )
        return { success: false, error: err instanceof Error ? err.message : String(err) } as unknown as T
      }
      if (isMinOrderSizeError(err)) {
        console.warn(`${LOG_PREFIX} ${label} min-order-size error â€” stopping retry loop`)
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
      // Tight backoff: 200 ms â†’ 400 ms â†’ 800 ms. Transient API blips
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

// â”€â”€ Per-connection cooldown after non-recoverable margin errors â”€â”€â”€â”€ï¿½ï¿½â”€
//
// When `executeLivePosition` fails with `code=101204` (Insufficient margin)
// the operator's account literally has no funds â€” nothing the engine can
// do programmatically will help. Without a cooldown, every Set evaluation
// on the next cycle re-attempts the order, generating a continuous
// stream of failed exchange API calls (~20/sec at observed cadence).
//
// Exponential backoff: each consecutive failure doubles the cooldown
// (60s ï¿½ï¿½ï¿½ 120s â†’ 240s â†’ 300s cap). This prevents the re-arm loop where
// a 60s cooldown expires, the next attempt fails again (same root cause),
// and immediately re-arms for another 60s â€” making recovery appear stuck.
// After the operator tops up, the next successful order resets the counter.
//
// A `clearMarginCooldown(connectionId)` export allows the /api/engine/reconnect
// endpoint to forcibly release a stuck cooldown.
//
// NOTE: Exchange circuit-breaker errors (BingX code 109400 â€” "API orders
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
  // Cooldown expired â€” clear so the next attempt runs fresh.
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

// â”€â”€ Per-symbol exchange circuit-breaker gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// BingX code 109400 means the exchange has TEMPORARILY disabled API
// trading for that symbol due to extreme volatility. This is NOT a
// margin/balance issue â€” the account is fine, the exchange re-enables
// trading automatically (typically within 1â€“5 minutes). We skip the
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
 * â”€â”€ Fast-ramp polling schedule â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ï¿½ï¿½ï¿½â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  // â€” it generates exchange API spam and never confirms a fill.
  if (!orderId) {
    return { filled: false, filledQty: 0, filledPrice: 0, status: "pending" }
  }
  const intervals = [100, 200, 350, 600]
  const deadline = Date.now() + timeoutMs
  let lastStatus = "pending"
  let pollIdx = 0
  // Track the best partial result seen so far â€” return it on timeout rather
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
        // Accept as usable â€” protection orders should be sized to filledQty,
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
  // Timeout â€” return whatever partial qty we managed to see rather than zero.
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
 *   Sequential: 5 Ã— 100ms = 500ms minimum
 *   Batch: 1 Ã— 100ms = 100ms minimum (50% faster)
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
 * other recoverable errors silently â€” the typical reason this is called
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
  // set `reduceOnly=true` on SL/TP orders â€” the position-reduction semantic
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

  // â”€â”€ BingX hedge-mode direction isolation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // In hedge mode the exchange annotates each order with `positionSide`
  // ("LONG" or "SHORT"). A sell-side STOP_MARKET for positionSide=SHORT is
  // the SHORT position's *stop loss* â€” it is NOT an orphan of the LONG
  // position we are closing. Without this guard, closing a LONG would sweep
  // the SHORT's protection orders and leave the SHORT position unprotected.
  //
  // When the field is absent ("BOTH" or empty) the account is in one-way
  // mode and the original side-match is already sufficient.
  //
  // closeSide="sell" â†’ we are closing a LONG  â†’ keep only positionSide=LONG
  // closeSide="buy"  â†’ we are closing a SHORT â†’ keep only positionSide=SHORT
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
    // for our purposes â€” the exchange-side state is already what we wanted.
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
    // â”€â”€ BingX code 100410: trigger frequency limit throttling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // When we hit BingX's endpoint trigger frequency limit, activate the 30s backoff
    // to stop hammering this specific connector with cancellation attempts.
    if (errStr.includes("code=100410") && connectionId) {
      markTriggerFrequencyThrottled(connectionId)
      console.warn(`${LOG_PREFIX} [TriggerFrequency] ${label} cancel failed: ${orderId} â€” ${res?.error}`)
      return false
    }
    console.warn(`${LOG_PREFIX} ${label} cancel failed: ${orderId} â€” ${res?.error}`)
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
  // â”€â”€ Structured trace context â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ï¿½ï¿½ï¿½â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    // here used `placeOrder(..., "limit")` at the trigger price â€” which
    // for SL on a long is a sell-limit BELOW market and gets rejected
    // by most exchanges as an aggressive reduce-only, leaving the
    // position unprotected. `placeStopOrder` lands a real STOP_MARKET /
    // TAKE_PROFIT_MARKET (BingX) or `triggerPrice`-based market reduce
    // (Bybit), and falls back to the limit-as-trigger behaviour on
    // connectors that haven't been upgraded yet (see `BaseExchangeConnector`).
    if (typeof connector?.placeStopOrder !== "function") {
      console.warn(`${tag} REJECTED LOCALLY: connector has no placeStopOrder â€” protection unavailable`)
      return { orderId: null, armedQuantity: 0 }
    }

    // Defensive input validation. The SL/TP test suite previously sent
    // `NaN` quantity from a venue-shape mismatch and the exchange echoed
    // back "Invalid quantity: NaN" 800 ms later â€” costly because by then
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

    // â”€â”€ Helper: extract numeric "available amount" from a 110424 message â”€â”€
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
    // Bounded â€” a hanging placeStopOrder would block the per-position sync
    // loop and stall every other position's heal/close work behind it. A
    // timeout is delivery-ambiguous, however: retain the exact promise and
    // durable client ID for acknowledgement/reconciliation instead of
    // classifying it as a venue rejection or submitting a duplicate.
    // â”€â”€ Normalize connector throws to result objects â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // â”€â”€ code=110424: "order size must be less than available amount" â”€â”€â”€
    // Triggered when the protection qty exceeds the position's remaining
    // available quantity.  Common cause: venue minimum (e.g. 1 TRB) is larger
    // than the partial fill size (e.g. 0.62 TRB), or two concurrent SL+TP
    // placements race to claim the same available pool.
    // Strategy: up to 2 retries, each time re-parsing the available qty from
    // BingX's error message and retrying with exactly that amount.  If the
    // second retry also fails with 110424, the position has likely been
    // externally closed or fully consumed by the other protection leg â€” treat
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
          `${tag} 110424 retry#${attempt + 1}: qty=${effectiveQty} > available=${availableQty} â€” retrying`,
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
          `${tag} 110424 exhausted after ${attempt} retries (lastAvail=${secondAvail}) â€” awaiting quantity reconciliation`,
        )
      }
      // Update effectiveQty on first-retry success
      if (result?.success && effectiveQty !== quantity) {
        // qty was adjusted; already updated in loop above
      }
    }

    // â”€â”€ code=109420: "position not exist" â”€â”€â”€â”€ï¿½ï¿½ï¿½â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        // BingX hedge-mode positions can take 2â€“4 s to become visible
        // under load. The old 500ms/1s/2s budget was exhausted too quickly,
        // causing the protection order to be deferred to the next reconcile
        // tick â€” leaving the position unprotected for up to 60 s.
        const BACKOFF_DELAYS_MS = [1000, 2000, 4000]
        let retryAttempt = 0
        while (retryAttempt < BACKOFF_DELAYS_MS.length && !result?.success && isPositionSettling(String(result?.error || ""))) {
          const delay = BACKOFF_DELAYS_MS[retryAttempt]
          console.warn(`${tag} 109420 retry: position not yet visible on exchange â€” waiting ${delay}ms before retry`)
          await new Promise((r) => setTimeout(r, delay))
          result = await placeStop(effectiveQty)
          if (result?.success) {
            console.log(`${tag} 109420 retry succeeded after ${delay}ms`)
            break
          }
          retryAttempt++
        }
        if (!result?.success) {
          console.warn(`${tag} 109420 retries exhausted (tried 1s, 2s, 4s) â€” reconcile will retry on next tick`)
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
        `${tag} PRICE_CROSSED (code=${is110412 ? "110412" : "110413"}): market moved past ${kind} trigger â€” position will be force-closed`,
      )
      return { orderId: "PRICE_CROSSED", armedQuantity: 0 }
    }
    // code=110206: "The number of your TP/SL orders has exceeded the limit."
    // The account's open protection-order quota is full. Retrying immediately
    // is pointless â€” the quota won't free until existing SL/TP orders close.
    // Return "QUOTA_EXCEEDED" so callers can skip re-arm and back off.
    const is110206 = errMsg.includes("110206") || /TP\/SL orders has exceeded|number of.*TP.*SL.*exceeded/i.test(errMsg)
    if (is110206) {
      // connectionId is not in scope here; the caller (updateProtectionOrders)
      // reads the sentinel and calls markProtectionQuotaExhausted(connId).
      console.warn(`${tag} QUOTA_EXCEEDED (code=110206): TP/SL order limit reached â€” caller will suspend placement`)
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
 * and `takeProfitOrderId` are still alive on the exchange â€” without
 * making one `getOrder()` call per leg per position per tick.
 *
 * Returns `null` when the connector either has no `getOpenOrders` or
 * when the call fails/times out. Callers MUST treat `null` as "skip
 * liveness verification this tick" rather than "no orders exist" â€” the
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
  observedOrdersById?: Map<string, any>
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
    // 25 s upper bound â€” BingX getOpenOrders queues behind live-order calls
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
    set.observedOrdersById = new Map()
    for (const o of orders) {
      // Prefer exchange-assigned numeric IDs over operator-supplied client IDs.
      // Using `clientOrderId`/`client_oid` as a fallback is safe only when no
      // real numeric ID is present on the order â€” otherwise a future client-ID
      // echo from the connector could mask a genuinely-missing real orderId and
      // suppress liveness-based re-arming of a gone SL/TP order.
      for (const candidate of [o?.id, o?.orderId, o?.orderID, o?.ordId]) {
        const identifier = firstNonEmptyIdentifier(candidate)
        if (identifier) { set.add(identifier); set.observedOrdersById.set(identifier, o) }
      }
      // Keep the client id alongside the venue id. Durable submissions are
      // written under this id before the HTTP request, so restart recovery can
      // resolve a response-lost order without issuing a duplicate.
      for (const candidate of [o?.clientOrderId, o?.clientOrderID, o?.client_oid, o?.clOrdId]) {
        const identifier = firstNonEmptyIdentifier(candidate)
        if (identifier) { set.add(identifier); set.observedOrdersById.set(identifier, o) }
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
 * disabled for that side). Pure function â€” does NOT touch the exchange.
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

  // â”€â”€ Trailing stop: use the ratcheted absolute price directly â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
 * tolerance â€” tighter than that and we'd thrash the exchange API on
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
    `Protection trigger already crossed for ${pos.symbol} â€” force closing`,
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
 *      cancel old â†’ place new at correct level. Cancel-first guarantees
 *      we never accidentally double-protect (which would produce two
 *      reduce-only fills against the same exchange position).
 *
 * Updates `pos.stopLossOrderId`, `pos.takeProfitOrderId`, `pos.stopLossPrice`,
 * `pos.takeProfitPrice` to reflect what's now actually live on the exchange.
 *
 * Returns a boolean indicating whether anything changed (so callers can
 * decide whether to persist the position).
 */

// â”€â”€ Per-position re-arm cooldown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The 200â€“300 ms reconcile loop calls `updateProtectionOrders` for every open
// position on every tick. The "drift-based" cancel-replace logic is correct, but
// at 3â€“5 Hz a mark price oscillating at the 0.25% boundary produces repeated
// cancel-replace storms that exhaust rate limits and generate confusing audit
// logs. The cooldown gate adds a minimum quiet period between cancel-replaces
// driven by *price or qty drift* (not missing-order re-arms â€” those always fire
// immediately because arming a missing order is never a no-op).
//
// MIN_REARM_MS (30 s) â€” for static SL/TP price drift: long enough to absorb
//   a normal oscillation window (BTC 0.5% range typically resolves in ~5-15 s).
//
// TRAILING_REARM_MS (200 ms) â€” trailing is an active protection contract, not
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

// â”€â”€ System-close-only flag, micro-cached â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Reconcile fans out across every live position; without this cache
// each position would HGETALL `app_settings:*` to read one boolean.
// 2 s TTL is short enough that operator toggles take visible effect
// within one reconcile cycle, long enough to collapse a whole burst
// of position-level calls into one Redis round-trip.
const SYSTEM_CLOSE_TTL_MS = 2000
type ProtectionPolicy = { systemCloseOnly: boolean; overallControlOrdersOnly: boolean; available: boolean }
const protectionPolicyCache = new Map<string, { value: ProtectionPolicy; at: number; inflight?: Promise<ProtectionPolicy> }>()

export function invalidateLiveStageSettingsCache(connectionId?: string): void {
  if (connectionId) protectionPolicyCache.delete(connectionId)
  else protectionPolicyCache.clear()
}

function parseSystemCloseFlag(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1
}

async function getCachedProtectionPolicy(connectionId: string): Promise<ProtectionPolicy> {
  const cacheKey = connectionId || "global"
  const cached = protectionPolicyCache.get(cacheKey)
  if (cached?.inflight) return cached.inflight
  if (cached && Date.now() - cached.at < SYSTEM_CLOSE_TTL_MS) return cached.value
  const fallback: ProtectionPolicy = { systemCloseOnly: false, overallControlOrdersOnly: false, available: false }
  const inflight = (async () => {
    try {
      const client = getRedisClient()
      const [appSettings, legacy, canonical] = await Promise.all([
        getAppSettings(),
        connectionId ? client.hgetall(`connection_settings:${connectionId}`) : {},
        connectionId ? client.hgetall(`settings:connection_settings:${connectionId}`) : {},
      ])
      const scopes = [appSettings, legacy, canonical] as Record<string, any>[]
      const closeScope = [...scopes].reverse().find((scope) =>
        scope?.useSystemCloseOnly != null || scope?.use_system_close_only != null,
      )
      const value = {
        systemCloseOnly: parseSystemCloseFlag(closeScope?.useSystemCloseOnly ?? closeScope?.use_system_close_only),
        overallControlOrdersOnly: overallControlOrdersOnly(...scopes),
        available: true,
      }
      protectionPolicyCache.set(cacheKey, { value, at: Date.now() })
      return value
    } catch {
      // Preserve a known policy on a transient read failure. The coordinator
      // cannot switch existing control scope until all settings are readable.
      const value = { ...(cached?.value || fallback), available: false }
      protectionPolicyCache.set(cacheKey, { value, at: Date.now() })
      return value
    }
  })()
  protectionPolicyCache.set(cacheKey, { value: cached?.value || fallback, at: cached?.at || 0, inflight })
  return inflight
}

async function getCachedSystemCloseOnly(connectionId: string): Promise<boolean> {
  return (await getCachedProtectionPolicy(connectionId)).systemCloseOnly
}

async function getCachedOverallControlOrdersOnly(connectionId: string): Promise<boolean> {
  return (await getCachedProtectionPolicy(connectionId)).overallControlOrdersOnly
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
  const shared = inheritedAggregateVenueProtection(pos)
  const missing: ProtectionOrderLeg[] = []
  if (desiredSl > 0 && (pos.controlOrderScope === "symbol_direction" || !pos.stopLossOrderId)) missing.push("stop_loss")
  if (desiredTp > 0 && (pos.controlOrderScope === "symbol_direction" || !pos.takeProfitOrderId)) missing.push("take_profit")
  pos.systemProtectionLegs = missing
  if (explicitSystemClose) {
    pos.protectionMode = "system_close"
  } else if (missing.length === 0) {
    pos.protectionMode = "exchange_control"
  } else if (pos.stopLossOrderId || pos.takeProfitOrderId || shared?.stopLossOrderId || shared?.takeProfitOrderId) {
    pos.protectionMode = "hybrid_control_system"
  } else {
    pos.protectionMode = "system_close_fallback"
  }
  refreshControlOrderSetCoverage(pos, shared)
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
    controlOrderScope?: ControlOrderScope
    stopLossOrderId?: string
    takeProfitOrderId?: string
    stopLossPrice?: number
    takeProfitPrice?: number
    stopLossArmedQuantity?: number
    takeProfitArmedQuantity?: number
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
  const shared = pos.controlOrderScope === "symbol_direction" ? sharedVenueProtection : undefined
  const stopLossOrderId = pos.stopLossOrderId || shared?.stopLossOrderId
  const takeProfitOrderId = pos.takeProfitOrderId || shared?.takeProfitOrderId
  const securityStopOrderId = sharedVenueProtection?.securityStopOrderId || pos.securityStopOrderId
  const securityStopPrice = Number(sharedVenueProtection?.securityStopPrice || pos.securityStopPrice || 0)
  const securityStopRequired = sharedVenueProtection?.securityStopRequired ?? pos.securityStopRequired ?? false
  const securityStopStatus = sharedVenueProtection?.securityStopStatus || pos.securityStopStatus
  const coverage: NonNullable<LivePosition["controlOrderSetCoverage"]> = {}
  const updatedAt = Date.now()
  for (const setKey of exactProtectionSetKeys(pos)) {
    coverage[setKey] = {
      protected: stopLossCovered && takeProfitCovered,
      controlOrderScope: pos.controlOrderScope || "per_order",
      protectionMode: pos.protectionMode || "system_close_fallback",
      aggregateProtectionOwner: pos.aggregateProtectionOwner === true,
      ...(pos.aggregateProtectionKey ? { aggregateProtectionKey: pos.aggregateProtectionKey } : {}),
      ...(sharedVenueProtection?.leaderId
        ? { aggregateProtectionLeaderId: sharedVenueProtection.leaderId }
        : {}),
      ...(stopLossOrderId ? { stopLossOrderId } : {}),
      ...(takeProfitOrderId ? { takeProfitOrderId } : {}),
      stopLossArmedQuantity: shared?.stopLossArmedQuantity ?? pos.stopLossArmedQuantity,
      takeProfitArmedQuantity: shared?.takeProfitArmedQuantity ?? pos.takeProfitArmedQuantity,
      ...(Number(shared?.stopLossPrice || pos.stopLossPrice || 0) > 0 ? { stopLossPrice: Number(shared?.stopLossPrice || pos.stopLossPrice) } : {}),
      ...(Number(shared?.takeProfitPrice || pos.takeProfitPrice || 0) > 0 ? { takeProfitPrice: Number(shared?.takeProfitPrice || pos.takeProfitPrice) } : {}),
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
  controlOrderScope?: ControlOrderScope
  stopLossOrderId?: string
  takeProfitOrderId?: string
  stopLossPrice?: number
  takeProfitPrice?: number
  stopLossArmedQuantity?: number
  takeProfitArmedQuantity?: number
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
    ...(entry.controlOrderScope === "symbol_direction" ? {
      controlOrderScope: entry.controlOrderScope,
      stopLossOrderId: entry.stopLossOrderId, takeProfitOrderId: entry.takeProfitOrderId,
      stopLossPrice: entry.stopLossPrice, takeProfitPrice: entry.takeProfitPrice,
      stopLossArmedQuantity: entry.stopLossArmedQuantity, takeProfitArmedQuantity: entry.takeProfitArmedQuantity,
    } : {}),
    ...(entry.securityStopOrderId ? { securityStopOrderId: entry.securityStopOrderId } : {}),
    ...(Number(entry.securityStopPrice || 0) > 0 ? { securityStopPrice: Number(entry.securityStopPrice) } : {}),
    securityStopRequired: entry.securityStopRequired,
    ...(entry.securityStopStatus ? { securityStopStatus: entry.securityStopStatus } : {}),
  }
}

function protectionStateSignature(position: LivePosition): string {
  const fields = ["controlOrderScope", "aggregateProtectionOwner", "aggregateProtectionKey", "aggregateProtectionMemberCount",
    "aggregateProtectionQuantity", "stopLossOrderId", "takeProfitOrderId", "securityStopOrderId", "stopLossPrice", "takeProfitPrice",
    "securityStopPrice", "stopLossArmedQuantity", "takeProfitArmedQuantity", "securityStopArmedQuantity", "securityStopRequired",
    "securityStopStatus", "securityStopLastArmedAt", "securityStopAbsenceConfirmations", "pendingProtectionOrders",
    "protectionMode", "systemProtectionLegs", "controlOrderCapacity"] as const
  return JSON.stringify({
    ...Object.fromEntries(fields.map((field) => [field, position[field]])),
    coverage: Object.fromEntries(Object.entries(position.controlOrderSetCoverage || {}).map(([key, value]) => [key, { ...value, updatedAt: 0 }])),
  })
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
  position.controlOrderScope = leader.controlOrderScope || "per_order"
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
    : position.stopLossOrderId || position.takeProfitOrderId || (position.controlOrderScope === "symbol_direction" && (leader.stopLossOrderId || leader.takeProfitOrderId))
      ? "hybrid_control_system"
      : "system_close_fallback"
  refreshControlOrderSetCoverage(position, {
    leaderId: leader.id,
    ...(leader.controlOrderScope === "symbol_direction" ? {
      controlOrderScope: leader.controlOrderScope,
      stopLossOrderId: leader.stopLossOrderId, takeProfitOrderId: leader.takeProfitOrderId,
      stopLossPrice: leader.stopLossPrice, takeProfitPrice: leader.takeProfitPrice,
      stopLossArmedQuantity: leader.stopLossArmedQuantity, takeProfitArmedQuantity: leader.takeProfitArmedQuantity,
    } : {}),
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
      `${LOG_PREFIX} [verify] StopLoss ${pos.symbol} orderId=${pos.stopLossOrderId} not found on venue â€” clearing & re-arming`,
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
      `${LOG_PREFIX} [verify] TakeProfit ${pos.symbol} orderId=${pos.takeProfitOrderId} not found on venue â€” clearing & re-arming`,
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
    slotCoordinator?: boolean
  } = {},
): Promise<{ changed: boolean; slPlaced: boolean; tpPlaced: boolean }> {
  const result = { changed: false, slPlaced: false, tpPlaced: false }
  if (!connector) return result
  if (!options.slotCoordinator && (
    pos.controlOrderScope === "symbol_direction" || await getCachedOverallControlOrdersOnly(pos.connectionId)
  )) {
    result.changed = ratchetManualTrailingStop(pos)
    const desired = computeDesiredProtectionPrices(pos)
    refreshProtectionHandlingMode(pos, desired.desiredSl, desired.desiredTp)
    // Only the physical-slot coordinator can cancel/rearm a shared quantity.
    return result
  }
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
    ? options.allowQuantityOverride×Þ½ï¦òµë(š+my×F–öâ’æ6F6‚‚‚’Óâ·Ò¢6öç7B6Æ÷6VBÒv—B6Æ÷6TÆ—fU÷6—F–öâ€¢6öææV7F–öä–BÀ¢Æ—fU÷6—F–öâæ–BÀ¢À¢W†6†ævT6öææV7F÷"À¢&VçG'•÷&÷FV7F–öåö6öçG&7Eö–æ6ö×ÆWFR"À¢’æ6F6‚‚‚’ÓâçVÆÂ¢–b†6Æ÷6VBbb7G&–ær†6Æ÷6VBç7FGW2ÇÂ""’ÓÓÒ&6Æ÷6VB"’°¢ö&¦V7Bæ76–vâ†Æ—fU÷6—F–öâÂ6Æ÷6VB¢v—B6Æ–VçBæFVÂ†VçG'•&÷FV7F–öä†ÇD¶W’’æ6F6‚‚‚’Óâ¢&WGW&à¢Ð ¢òòFòæ÷BW&Ö—Bæ÷F†W"VçG'’gFW"âW†7BÖ÷væVB&öÆÆ&6²6÷VÆBæ÷B&P¢òò6öæf—&ÖVBâW†—7F–ær&V6öæ6–Æ–F–öâö6Æ÷6R&ö6W76–ær&VÖ–ç27F—fS°¢òòöæÇ’æWrW‡÷7W&R—2†ÇFVBVçF–Ââ÷W&F÷"VF—B6ÆV'2F†—2¶W’à¢v—B6Æ–VçBç6WFW‚€¢VçG'•&÷FV7F–öä†ÇD¶W’À¢#B¢c¢cÀ¢¥4ôâç7G&–æv–g’‡²C¢FFRææ÷r‚’Â&V6öã¢&VçG'•÷&÷FV7F–öå÷&öÆÆ&6µ÷Væ6öæf—&ÖVB"Ò’À¢’æ6F6‚‚‚’Óâ·Ò¢Æ—fU÷6—F–öâç7FGW5&V6öâÐ¢$VçG'’&÷FV7F–öâ&öÆÆ&6²6÷VÆBæ÷B&R6öæf—&ÖVC²æWrVçG&–W2†ÇFVBf÷"&V6öæ6–Æ–F–öâ ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ’æ6F6‚‚‚’Óâ·Ò¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&W'&÷""À¢Æ—fU÷6—F–öâç7FGW5&V6öâÀ¢°¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢f–öÆF–öç3¢²ââçf–öÆF–öç5Òç6Æ–6RƒÂb’À¢ÒÀ¢’æ6F6‚‚‚’Óâ·Ò¢Ð¢6öç7B&÷'E7WW'6VFVBÒ7–æ2‚“¢&öÖ—6SÆ&ööÆVãâÓâ°¢òòöæ6RfVçVR&WVW7BÖ’†fRÆVgBF†—2&ö6W72Â6æ6VÆÆF–öâv÷VÆB&P¢òòVç6fS¢F†R&W7öç6R6â&6RF†R6WGF–æw2WfVçBâ6öçF–çVRGW&&ÆP¢òò&V6÷fW'’Âf–ÆÂ&V6öæ6–Æ–F–öâÂæB&÷FV7F–öâf÷"F†BW†7@¢òò6Æ–VçD÷&FW$–BÂ'WB7W&W72WfW'’æ÷B×–WB×7F'FVB&WG'’&VÆ÷rà¢–b†v—B—47W'&VçB‚’ÇÂW†6†ævU7V&Ö—76–öå7F'FVB’&WGW&âfÇ6P¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ&&Æö6¶VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒ&W†V7WF–öåövVæW&F–öå÷7WW'6VFVB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒ$W†V7WF–öâvVæW&F–öâ6†ævVB&Vf÷&R7V&Ö—76–öâ ¢Æ—fU÷6—F–öâç7FGW5&V6öâÐ¢$W†V7WF–öâvVæW&F–öâ6†ævVB&Vf÷&R7V&Ö—76–öã²æòæWr÷&FW"v26VçB ¢Æ—fU÷6—F–öâç7V&Ö—76–öå7FFRÒVæFVf–æV@¢W6…7FW†Æ—fU÷6—F–öâÂ&vVæW&F–öåöwV&B"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢–b‡6–væÄ66—G•&W6W'fVB’°¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ’æ6F6‚‚‚’Óâ·Ò¢6–væÄ66—G•&W6W'fVBÒfÇ6P¢Ð¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’°¢v—B&VÆV6TÆö6²€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚À¢Æ—fT÷&FW$Æö6µFö¶VâÀ¢’æ6F6‚‚‚’Óâ·Ò¢Æ—fT÷&FW$Æö6µFö¶VâÒçVÆÀ¢Ð¢&WGW&âG'VP¢Ð ¢G'’°¢–b†v—B&÷'E7WW'6VFVB‚’’&WGW&âÆ—fU÷6—F–öà¢òò)H)H7FW¢&RÖfÆ–v‡BfÆ–FF–öâ)H)H)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞûûÞûûÞûûÞûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢6öç7B&WVW7FVDF—&V7F–öâÒ7G&–ær‡&VÅ÷6—F–öâæF—&V7F–öâÇÂ""’çG&–Ò‚’çFôÆ÷vW$66R‚¢–b€¢7G&–ær‡&VÅ÷6—F–öâç7–Ö&öÂÇÂ""’çG&–Ò‚’ÇÀ¢‡&WVW7FVDF—&V7F–öâÓÒ&Æöær"bb&WVW7FVDF—&V7F–öâÓÒ'6†÷'B"’ÇÀ¢†—57V6–Å÷6—F–öâbb7V6–Å÷6—F–öåÆâ¢’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ&&Æö6¶VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒ&–çfÆ–EöÆ—fU÷÷6—F–öåö–çWB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒ'7–Ö&öÂÂF—&V7F–öâÂ÷"7V6–Â×÷6—F–öâ6öçG&7B—2–çfÆ–B ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒ—57V6–Å÷6—F–öâbb7V6–Å÷6—F–öåÆà¢ò$–çfÆ–B7V6–Â÷6—F–öâÆã¢F—&V7F–öâö62÷&÷FV7F–öâ6öçG&7B&V¦V7FVB ¢¢–çfÆ–B–çWG3¢7–Ö&öÃÒG·&VÅ÷6—F–öâç7–Ö&öÇÒÂF—&V7F–öãÒG·&VÅ÷6—F–öâæF—&V7F–öçÖ ¢W6…7FW†Æ—fU÷6—F–öâÂ'&VfÆ–v‡B"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5÷&V¦V7FVEö6÷VçB"¢v—BÆöu&öw&W76–öäWfVçB†6öææV7F–öä–BÂ&Æ—fU÷G&F–ær"Â&W'&÷""Â$Æ—fR÷&FW"&V¦V7FVB(	B–çfÆ–B–çWG2"Â°¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢Ò¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢òò5$•D”4Ã¢W7F6‚&WGW&ç2fÇVW227G&–æw2õ"æF—fRG—W2FWVæF–æröâFFW"à¢òòW6RvWD6öææV7F–öâ‚’FòvWBF†R'6VB†6‚‡'6T†6…fÇVR6öW&6W2#"ò'G'VR"÷G'VRÓâG'VR’à¢òò&r†vWFÆÂföÆÆ÷vVB'’7G&–ærÖöæÇ’WVÆ—G’v26–ÆVçFÇ’f–Æ–ærv†VâF†RfÇVP¢òò6ÖR&6²2&ööÆVâÂ6W6–ærWfW'’&VÂ÷&FW"Fò&V6öÖR'6–×VÆFVB"÷&FW ¢òòFW7—FRF†R7G&FVw’Ö6ö÷&F–æF÷"6÷'&V7FÇ’FWFV7F–ærÆ—fU÷G&FS×G'VR§W7BöæP¢òògVæ7F–öâ6ÆÂW7G&VÒà¢6öç7B6öæå6WGF–æw2Ò–æ—F–Ä6öææV7F–öå6WGF–æw0¢òòöæR6æöæ–6ÂFV6—6–öâ—26†&VBv—F‚F†RÖ–âÆ—fRFövvÆRæB7FGW0¢òò—2â&Wf–÷W6Ç’V6‚F‚–×ÆVÖVçFVB6Æ–v‡FÇ’F–ffW&VçB6öÖ&–æF–öà¢òòöbfÆw2Â7&VFVçF–Ç2ÂæB&VF—26†V6·2Â6ò&öGV7F–öâ6÷VÆBF—7Æ’Æ—fP¢òòôâv†–ÆRF†—2'&æ6‚6–ÆVçFÇ’7&VFVBW"÷6—F–öç2à¢6öç7B&VF–æW74–çFVçBÒ&VF–æW74–çFVçDf÷$W†V7WF–öâ†6öæå6WGF–æw2ÂW†V7WF–öä–çFVçB¢6öç7BÆ—fU&VF–æW72ÒW†V7WF–öä–çFVçBÓÓÒ&F—&V7B ¢òWfÇVFTF—&V7EG&FTÆ—fU&VF–æW72†6öæå6WGF–æw2Â6öææV7F–öä–B¢¢WfÇVFU&VÅG&FU&VF–æW72†6öæå6WGF–æw2Â&VF–æW74–çFVçB¢6öç7B—4Æ—fUG&FTVæ&ÆVBÒÆ—fU&VF–æW72æ6åÆ6U&VÄ÷&FW'0¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒÆ—fU&VF–æW72æW†V7WF–öäÖöFP¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒÆ—fU&VF–æW72æ&Æö6´6öFRÇÂVæFVf–æV@¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒÆ—fU&VF–æW72æ&Æö6µ&V6öâÇÂVæFVf–æV@¢–b†v—B&÷'E7WW'6VFVB‚’’&WGW&âÆ—fU÷6—F–öà ¢òò&WVW7FVBÆ—fR'Vâ×W7Bf–Âf—6–&Ç’v†Vâ—G26fWG’&W&WV—6—FW2&P¢òòæ÷BÖWBâfÆÆ–ær&6²FòW"†W&RÖFRF†RÖ–âVæv–æRÆöö²†VÇF‡¢òòv†–ÆRæòfVçVR÷&FW"v2WfW"GFV×FVBâW"6–×VÆF–öâ&VÖ–ç27F—fP¢òòöæÇ’v†VâF†R÷W&F÷"†27GVÆÇ’ÆVgBÆ—fRG&FRF—6&ÆVBà¢–b‚—4Æ—fUG&FTVæ&ÆVBbbÆ—fU&VF–æW72ç&WVW7FVBbbÆ—fU&VF–æW72æW†V7WF–öäÖöFRÓÒ'6–×VÆF–öâ"’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâç7FGW5&V6öâÐ¢Æ—fRW†6†ævR÷&FW"&Æö6¶VB‚G¶Æ—fU&VF–æW72æ&Æö6´6öFRÇÂ'Væ¶æ÷vâ'Ò“¢G¶Æ—fU&VF–æW72æ&Æö6µ&V6öçÖ ¢W6…7FW†Æ—fU÷6—F–öâÂ&Æ—fU÷&VF–æW72"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B&öÖ—6RæÆÂ…°¢–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5ö&Æö6¶VEö6÷VçB"’À¢Æöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢'v&æ–ær"À¢Æ—fU÷6—F–öâç7FGW5&V6öâÀ¢°¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢&Æö6´6öFS¢Æ—fU&VF–æW72æ&Æö6´6öFRÀ¢7&VFVçF–Ç5fÆ–C¢Æ—fU&VF–æW72æ7&VFVçF–Ç5fÆ–BÀ¢GW&&ÆT6ö÷&F–æF–öå&VG“¢Æ—fU&VF–æW72æGW&&ÆT6ö÷&F–æF–öå&VG’À¢ÒÀ¢’À¢Ò¢6öç6öÆRçv&â†G´Äôuõ$Td•‡ÒG¶Æ—fU÷6—F–öâç7FGW5&V6öçÖ¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢òò÷6—F–öâÖ6÷VçB6WG2÷vâöæR‡—6–6ÂF&vWBW"W†7B&6R&VçBæ@¢òòF—&V7F–öââWfW'’7–6ÆR&V6öæ6–ÆW2F†BÆæRw2VçF—G’FòF†R7VÒöb—G0¢òò–æFWVæFVçFÇ’fÆ–FFVBÖVÖ&W"&F–÷2âF†R÷÷6—FRF—&V7F–öâ—2¢òò6W&FRÆæRæB—2æWfW"†VFvVB÷"6Æ÷6VB†W&Rà¢–b‡&VÅ÷6—F–öâæ6öÖ&–æVE÷46÷VçG2’°¢–b†v—B&÷'E7WW'6VFVB‚’’&WGW&âÆ—fU÷6—F–öà¢6öç7B&V6öæ6–ÆVBÒv—B&V6öæ6–ÆT6öÖ&–æVE÷46÷VçEF&vWB€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâÀ¢W†6†ævT6öææV7F÷"À¢W†V7WF–öä–çFVçBÀ¢—4Æ—fUG&FTVæ&ÆVBÀ¢¢–b‡&V6öæ6–ÆVB’&WGW&â&V6öæ6–ÆV@¢òòçVÆÂÖVç2F†—2—2F†Rf—'7BæöâÖfÆBF&vWC²6öçF–çVRF‡&÷Vv‚F†P¢òòæ÷&ÖÂg&W6‚ÖVçG'’F‚Âv†–6‚7&VFW2æB&÷FV7G2F†R‡—6–6Â÷&FW"à¢Ð ¢–b†—4Æ—fUG&FTVæ&ÆVB’°¢6öç7BF—6&ÆVBÒv—Bf–æDFV7F—fFVDÆ—fT6öæf–r†6öææV7F–öä–BÂÆ—fU÷6—F–öâÂ–æ—F–Ä6WGF–æw2¢–b†F—6&ÆVB’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ&&Æö6¶VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒ&æVvF—fUöÆ—fUö6öæf–u÷v–æF÷r ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒ6WBFV7F—fFVC¢Æ7BG¶F—6&ÆVBçv–æF÷wÒ6WGFÆVBÆ—fR÷6—F–öç2æWBG¶F—6&ÆVBææWEæÇÖ ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒÆ—fU÷6—F–öâç7FGW5&V6öà¢W6…7FW†Æ—fU÷6—F–öâÂ&Æ—fUö6öæf–u÷W&f÷&Öæ6R"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5ö&Æö6¶VEö6÷VçB"¢&WGW&âÆ—fU÷6—F–öà¢Ð¢Ð ¢òò—4&Æö6µf&–çBæBöÆö6´F—%7Vff—‚&R†ö—7FVBFògVæ7F–öâ66÷R†&Vf÷&P¢òòF†RG'’&Æö6²’6òF†R6F6‚†æFÆW"6âÇ6ò&VÆV6RF†R6÷'&V7B¶W’à¢6öç7B—4&Æö6µf&–çBÒ&VÅ÷6—F–öâç6WEf&–çBÓÓÒ&&Æö6²  ¢òòD4GF6†W2FòâÇ&VG’6öæf—&ÖVB&VçBâ&Æö6²—2–æFWVæFVçC¢—@¢òòæ÷&ÖÆÇ’67V×VÆFW2–çFòF†RWF†÷&—FF—fRæ÷&ÖÂÆæRÂ'WBv†Vâæð¢òòæ÷&ÖÂ&VçBW†—7G2—B6VVG2—G2÷vâ‡—6–6Â&VçBæBÆFW"6÷VçG0¢òò&V6öæ6–ÆR–çFòF†B&VçBà¢6öç7B—4F§W7FÖVçEf&–çBÒ—4&Æö6µf&–çBÇÂ&VÅ÷6—F–öâç6WEf&–çBÓÓÒ&F6 ¢–b†—4F§W7FÖVçEf&–çB’°¢–b†v—B&÷'E7WW'6VFVB‚’’&WGW&âÆ—fU÷6—F–öà¢6öç7BW†—7F–ærÒv—Bf–æDWF†÷&—FF—fTF§W7FÖVçE&VçB€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢—4Æ—fUG&FTVæ&ÆVBÀ¢W†V7WF–öå6Æ÷BÀ¢—4&Æö6µf&–çBÀ¢òò6÷W&6R×7V6–f–26–væÂ&Æö6·2&WF–âF†V—"÷vâ&öö¶¶VW–ærÆæRâ–`¢òòæòW†7B6÷W&6R&VçBW†—7G2ÂF†W’Ö’fÆÂ&6²FòF†R÷&F–æ'¢òòF—&V7F–öâ&VçC²÷F†W'v—6RF†R–æFWVæFVçB&Æö6²6VVB&VÆ÷r÷vç0¢òòF†RÆæRà¢—4&Æö6µf&–çBbbW†V7WF–öå6Æ÷BÓÒ&FVfVÇB ¢ò&FVfVÇB ¢¢VæFVf–æVBÀ¢¢–b‚W†—7F–ær’°¢–b†—4&Æö6µf&–çB’°¢òòg&W6‚–æFWVæFVçB&Æö6²ÆæR†2æò6öæf—&ÖVB&VçBâ6öçF–çVP¢òò–çFòF†R÷&F–æ'’VçG'’—VÆ–æRv—F‚F†RÇ&VG’6Æ7VÆFV@¢òò'6öÇWFR&Æö6²×VÇF—Æ–W#²F†RW'6—7FVB&Æö6²÷6—F–öâ&V6öÖW0¢òòF†RWF†÷&—FF—fR&VçBf÷"ÆFW"6÷VçG2à¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢&&Æö6µö–æFWVæFVçE÷&VçE÷6VVB"À¢G'VRÀ¢÷Væ–ærF§W7FVB&Æö6²&VçBf÷"G·&VÅ÷6—F–öâç6WD¶W’ÇÂ'Væ¶æ÷vâ'ÖÀ¢¢ÒVÇ6R°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒ—4&Æö6µf&–ç@¢ò&Æö6²6WBG·&VÅ÷6—F–öâç6WD¶W’ÇÂ'Væ¶æ÷vâ'Òv—G2f÷"WF†÷&—FF—fR&VçBf–ÆÆ ¢¢D46WBG·&VÅ÷6—F–öâç6WD¶W’ÇÂ'Væ¶æ÷vâ'Òv—G2f÷"WF†÷&—FF—fR&VçBf–ÆÆ ¢W6…7FW†Æ—fU÷6—F–öâÂ&F§W7FÖVçE÷v—B"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢&WGW&âÆ—fU÷6—F–öà¢Ð¢ÒVÇ6R°¢6öç7BF§W7FÖVçE&–6RÒ&VÅ÷6—F–öâæVçG'•&–6Râ ¢ò&VÅ÷6—F–öâæVçG'•&–6P¢¢v—BfWF6„7W'&VçE&–6R‡&VÅ÷6—F–öâç7–Ö&öÂÂ6öææV7F–öä–B¢–b†v—B&÷'E7WW'6VFVB‚’’&WGW&âÆ—fU÷6—F–öà¢–b‚†F§W7FÖVçE&–6Râ’’°¢W6…7FW†W†—7F–ærÂ&67V×VÆFU÷6¶—"ÂfÇ6RÂ&Ö&¶WB&–6RVæf–Æ&ÆR(	BF§W7FÖVçBFVfW'&VB"¢v—B6fU÷6—F–öâ†W†—7F–ær¢&WGW&âW†—7F–æp¢Ð¢–b†W†—7F–ærç7FGW2ÓÓÒ'6–×VÆFVB"’°¢–b†v—B&÷'E7WW'6VFVB‚’’&WGW&âÆ—fU÷6—F–öà¢&WGW&â67V×VÆFT–çFõ6–×VÆFVE÷6—F–öâ†6öææV7F–öä–BÂW†—7F–ærÂ&VÅ÷6—F–öâÂF§W7FÖVçE&–6R¢Ð¢–b†v—B&÷'E7WW'6VFVB‚’’&WGW&âÆ—fU÷6—F–öà¢&WGW&â67V×VÆFT–çFôÆ—fU÷6—F–öâ€¢6öææV7F–öä–BÀ¢W†—7F–ærÀ¢&VÅ÷6—F–öâÀ¢F§W7FÖVçE&–6RÀ¢W†6†ævT6öææV7F÷"À¢—4Æ—fUG&FTVæ&ÆVBÀ¢W†V7WF–öä–çFVçBÓÓÒ&F—&V7B"ò6†÷VÆD6öçF–çVR¢VæFVf–æVBÀ¢¢Ð¢Ð ¢òòF†R6öææV7F–öâ×v–FR&÷FV7F–öâ†ÇB—2†&BæòÖVçG'’&÷VæF'’â'Vâ—@¢òògFW"&Æö6²ôD4&V6÷fW'’†2†B6†æ6RFò&V6öæ6–ÆRâ–âÖfÆ–v‡@¢òò6öçG&öÂ÷&FW#²F†R†ÇB&÷FV7G2g&W6‚W‡÷7W&RæB×W7BæWfW"&WfVçB¢òò6öçG&öÂ×WFF–öâg&öÒ&V6÷fW&–ærâÇ&VG’Ö÷væVB6Æ÷Bà¢–b†—4Æ—fUG&FTVæ&ÆVBbbv—B6Æ–VçBævWB†VçG'•&÷FV7F–öä†ÇD¶W’’æ6F6‚‚‚’ÓâçVÆÂ’’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ&&Æö6¶VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒ&VçG'•÷&÷FV7F–öåö†ÇFVB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒ$&–÷"VçG'’6÷VÆBæ÷B&÷fR6ö×ÆWFRfVçVR&÷FV7F–öâ ¢Æ—fU÷6—F–öâç7FGW5&V6öâÐ¢$W†6†ævR÷&FW"&Æö6¶VB&Vf÷&R&VfÆ–v‡C¢VçG'’&÷FV7F–öâ†ÇB&WV—&W2&V6öæ6–Æ–F–öâ ¢W6…7FW†Æ—fU÷6—F–öâÂ&VçG'•÷&÷FV7F–öåöFÖ—76–öâ"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5ö&Æö6¶VEö6÷VçB"¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢W6…7FW†Æ—fU÷6—F–öâÂ'&VfÆ–v‡B"ÂG'VRÂW†V7WF–öåöÖöFSÒG¶Æ—fU&VF–æW72æW†V7WF–öäÖöFWÖ¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&–æfò"À¢Æ—fR—VÆ–æR7F'BG·&VÅ÷6—F–öâç7–Ö&öÇÒG·&VÅ÷6—F–öâæF—&V7F–öçÖÀ¢²Æ—fUG&FS¢—4Æ—fUG&FTVæ&ÆVBÂW†V7WF–öäÖöFS¢Æ—fU&VF–æW72æW†V7WF–öäÖöFRÂ&VÅ÷6—F–öä–C¢&VÅ÷6—F–öâæ–BÐ¢ ¢òò)H)HFöÖ–2FVGWvFR…ÓB&6Rf—‚’)H)HûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òð¢òò7V3¢$7F—fR6WVFò÷6—F–öâÆ–Ö—Bf÷"V6‚F—&V7F–öâÆöærÂ6†÷'@¢òòÖ†–ÖÂâ"F†R&Wf–÷W2–×ÆVÖVçFF–öâv26†V6²×F†VâÖ7@¢òò6WVVæ6S ¢òð¢òò–b†v—B†4÷VäÆ—fU÷6—F–öâ‚âââ’’²ÖW&vRÖ÷"×&VÆV6R×7FÆRÐ¢òòâââÆ6R÷&FW"ââà¢òòv—B7V—&TÆö6²‚âââ’òò÷fW'w&—FW2Væ6öæF—F–öæÆÇ¢òð¢òò(	B&7’VæFW"ç’6öæ7W'&Væ7’âGvòF–6·26÷VÆB&÷F‚72F†P¢òò†4÷VäÆ—fU÷6—F–öæ6†V6²Â&÷F‚Æ6RW†6†ævR÷&FW'2ÂæB&÷F€¢òò&VÆFVFÇ’7F×F†RÆö6²âF†RW†6†ævRVæFVBWv—F‚Gvð¢òòGWÆ–6FR÷6—F–öç2f÷"F†R6ÖR7–Ö&öÂ¶F—&V7F–öã²&V6öæ6–ÆRF†Và¢òò†BFòf–wW&R÷WBv†–6‚öæRFòG&6²à¢òð¢òòvRæ÷rFöÖ–6ÆÇ’G'”7V—&TÆö6¶BF†RfW'’F÷öbF†P¢òòÆ—fR×G&FR'&æ6ƒ ¢òð¢òò(
"7V—&VB(i"vR÷vâF†R6Æ÷BÂg&W6‚ÖVçG'’F‚'Vç2âæð¢òò6W&FR7V—&TÆö6¶6ÆÂÆFW"–âF†—2gVæ7F–öâà¢òò(
"æ÷B7V—&VB(i"F†W&R—2V—F†W"â÷Vâ÷6—F–öâFòÖW&vR–çFð¢òò†÷W"&VfW'&VB÷WF6öÖR’õ"â–âÖfÆ–v‡BVçG'¢òòg&öÒ&ÆÆVÂF–6²F†B†6âwB–WB6fVB—G0¢òò÷6—F–öââvRDTdU"–âF†R6V6öæB66R&F†W ¢òòF†â&6–ær(	BF†RRÖÖ–çWFREDÂwV&çFVW2¢òò7&6†VBÆö6²6VÆbÖ6ÆV'2Â6òFVfW'&VB6–væÇ0¢òòv–ÆÂ7V66VVBöâ7V'6WVVçB7–6ÆRà¢òð¢òòF†—2—2F†RöæÇ’w&—FW"öbÆ—fS¦Æö6³§¶6öæçÓ§·7–×Ó§¶F—'ÖöâF†P¢òò7&—F–6ÂF‚Â6òF†R&6Rv–æF÷r—26Æ÷6VBB—G26÷W&6Rà¢–b†—4Æ—fUG&FTVæ&ÆVB’°¢òò)H)Hf&–çB×7V6–f–2Æö6²¶W’)HûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞ)H)H)H ¢òò&Æö6²FBÖöâ÷&FW'2ÕU5B&R&ÆRFò&ö6VVBWfVâv†VâF†RFVfVÇBð¢òòG&–Æ–ær÷6—F–öâw2Æö6²—2†VÆB‡F†BÆö6²ÖVç2&FVfVÇB6Æ÷B—0¢òòö67W–VB(	BFöâwB÷Vâ6V6öæBFVfVÇB"Âæ÷B&ÆÂ÷&FW'2&Æö6¶VB"’à¢òð¢òòvRW6Rf&–çB×66÷VBÆö6²¶W’f÷"&Æö6²6WG3 ¢òòFVfVÇB÷G&–Æ–ær÷W6RöF6¢Æ—fS¦Æö6³§¶6öæçÓ§·7–×Ó§¶F—'Ð¢òò&Æö6³¢Æ—fS¦Æö6³§¶6öæçÓ§·7–×Ó§¶F—'Ó¦&Æö6°¢òð¢òòF†—2ÆÆ÷w2BÖ÷7BFVfVÇB²&Æö6²÷6—F–öâW"F—&V7F–öâW ¢òò7–Ö&öÂ6–×VÇFæV÷W6Ç’â—4&Æö6µf&–çB²öÆö6´F—%7Vff—‚&R†ö—7FV@¢òòFògVæ7F–öâ66÷R6òWfW'’&VÆV6TÆö6²ò&Vg&W6„Æö6µEDÂ–âF†—0¢òògVæ7F–öâw2Æöær&öG’W6W2F†R6÷'&V7B66÷VB¶W’WFöÖF–6ÆÇ’à¢6öç7B7V—&VBÒv—BG'”7V—&TÆö6²€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚À¢¢–b†7V—&VB’°¢Æ—fT÷&FW$Æö6µFö¶VâÒ7V—&V@¢Æ—fU÷6—F–öâæÆ—fTÆö6µFö¶VâÒ7V—&V@¢Ð¢–b†v—B&÷'E7WW'6VFVB‚’’&WGW&âÆ—fU÷6—F–öà¢–b‚7V—&VB’°¢òò6Æ÷B—2†VÆB(	BG'’FòÖW&vR–çFòF†RW†—7F–ærW†6†ævP¢òò÷6—F–öââ–bvR6âwB†–âÖfÆ–v‡BVçG'’g&öÒæ÷F†W"F–6²’À¢òòFVfW"F†—26–væÂ6ÆVæÇ’à¢òòf÷"&Æö6²f&–çC¢–bF†R&Æö6²Æö6²—2†VÆBÂFVfW"†æ÷F†W ¢òò&Æö6²FBÖöâ—2–âÖfÆ–v‡B’â&Æö6²FöW2äõBÖW&vR–çFòF†P¢òòFVfVÇB÷6—F–öâv†Vâ—G2÷vâÆö6²—2F¶Vâà¢6öç7BW†—7F–ærÒ—4&Æö6µf&–ç@¢òçVÆÂòò&Æö6²FVfW'3²æòÖW&vRÖ–çFòÖFVfVÇBöâ6öÆÆ—6–öà¢¢v—Bf–æD÷VäÆ—fU÷6—F–öä'”F—"€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢W†V7WF–öå6Æ÷BÀ¢ ¢–b‚W†—7F–ær’°¢òòÆö6²&W6VçBÂæò÷6—F–öâf—6–&ÆR–WB(i"æ÷F†W"F–6²—0¢òòÖ–BÖfÆ–v‡BâDòäõB&VÆV6RF†RÆö6²†W&R‡F†R&Wf–÷W0¢òò–×ÆVÖVçFF–öâF–BÂv†–6‚ÆWBGvòF–6·2&÷F‚Æ6RW†6†ævP¢òò÷&FW'2’â7W&f6RFVfW'&ÂæBÆWBF†RæW‡B7–6ÆR&WG'’à¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâç7FGW5&V6öâÐ¢FVGWÆö6²†VÆB(	Bæ÷F†W"VçG'’–âfÆ–v‡Bf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÒG·&VÅ÷6—F–öâæF—&V7F–öçÒG¶—4&Æö6µf&–çBò"†&Æö6²’"¢"'Ó²v–ÆÂ&WG'’æW‡B7–6ÆV ¢W6…7FW†Æ—fU÷6—F–öâÂ'&VfÆ–v‡B"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5öFVfW'&VEö6÷VçB"¢òòæ÷&ÖÂ†–v‚Ög&WVVæ7’FVfW'&ÂVæFW"ÆöB(	BFòæ÷B7Ò&öw&W76–öâÆöw2B&–æfò"à¢òòF†R7FGW5&V6öâ²6fVB÷6—F–öâÇ&VG’&÷f–FRf—6–&–Æ—G“²öæÇ’v&âBÆ÷rg&WVVæ7’à¢–b„ÖF‚ç&æFöÒ‚’ÂãR’°¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&–æfò"À¢Æ—fU÷6—F–öâç7FGW5&V6öâÀ¢²7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÂF—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÒÀ¢’æ6F6‚‚‚’Óâ·Ò¢Ð¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢òòæVVB&–6RFò6ö×WFRFF—F–öæÂföÇVÖR²&WF–â—Bf÷"F†P¢òò67V×VÆF÷"â&WW6RfWF6„7W'&VçE&–6Rv—F‚F†R&VÅ÷6—F–öà¢òòVçG'’×&–6R†–çB6òvRFöâwB’GvòfWF6†W2f÷"F†R6ÖRF–6²à¢ÆWB65&–6RÒ&VÅ÷6—F–öâæVçG'•&–6P¢–b‚65&–6RÇÂ65&–6RÃÒ’65&–6RÒv—BfWF6„7W'&VçE&–6R‡&VÅ÷6—F–öâç7–Ö&öÂÂ6öææV7F–öä–B ¢òò6¶—×F‡3¢v†VâvR6âwB67V×VÆFR&–v‡Bæ÷r†æòÖ&¶WB&–6P¢òò÷"æò6öææV7F÷"’ÂvR&V6÷&BF†RFVfW'&ÂöâF†RU„•5D”äp¢òò÷6—F–öâw2&öw&W76–öâ&F†W"F†âW'6—7F–ærF†RF‡&÷rÖv¢òòÆ—fU÷6—F–öæÆ6V†öÆFW"–çFòF†R÷Vâ–æFW‚â&V6öæ6–ÆRv–ÆÀ¢òò–6²WÖ&¶WBFFæBg&W6‚6–væÂöâF†RæW‡B7–6ÆRà¢–b‚65&–6RÇÂ65&–6RÃÒ’°¢W6…7FW€¢W†—7F–ærÀ¢&67V×VÆFU÷6¶—"À¢fÇ6RÀ¢æòÖ&¶WB&–6Rf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÒ(	B67V×VÆF–öâFVfW'&VFÀ¢¢v—B6fU÷6—F–öâ†W†—7F–ær¢&WGW&âW†—7F–æp¢Ð ¢–b‚W†6†ævT6öææV7F÷"ÇÂG—VöbW†6†ævT6öææV7F÷"çÆ6T÷&FW"ÓÒ&gVæ7F–öâ"’°¢W6…7FW€¢W†—7F–ærÀ¢&67V×VÆFU÷6¶—"À¢fÇ6RÀ¢&W†6†ævR6öææV7F÷"Væf–Æ&ÆR(	B67V×VÆF–öâFVfW'&VB"À¢¢v—B6fU÷6—F–öâ†W†—7F–ær¢&WGW&âW†—7F–æp¢Ð ¢6öç7BÖW&vVBÒv—B67V×VÆFT–çFôÆ—fU÷6—F–öâ€¢6öææV7F–öä–BÀ¢W†—7F–ærÀ¢&VÅ÷6—F–öâÀ¢65&–6RÀ¢W†6†ævT6öææV7F÷"À¢G'VRÀ¢W†V7WF–öä–çFVçBÓÓÒ&F—&V7B"ò6†÷VÆD6öçF–çVR¢VæFVf–æVBÀ¢¢òò&Vg&W6‚F†RW†—7F–ær6Æ÷Bw2EDÂ(	BF†R÷6—F–öâ—27F–ÆÂ÷Và¢òòöâF†RW†6†ævRæBvRvçBF†R6fWG’W‡—'’W6†VBf÷'v&@¢òò'’F†R32v–æF÷râÆö6²fÇVR&VÖ–ç2F†R÷&–v–æÂVçG'’w0¢òòF–ÖW7F×†–çFVçF–öæÂ(	BFV'VvvW'26VRF†R÷&–v–æÂVçG'’w0¢òòvÆÂÖ6Æö6²Âæ÷BF†R67V×VÆF–öâw2’à¢ò¢Fòæ÷B&Vg&W6ƒ¢F†—2v÷&¶W"F–Bæ÷B7V—&RF†RÆö6²Fö¶Vââ¢ð¢&WGW&âÖW&vV@¢Ð ¢6öç7BVçG'”†ÇE&V6öâÒv—B&VDÆ—fTVçG'”†ÇB†6öææV7F–öä–B¢–b†VçG'”†ÇE&V6öâ’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâç7FGW5&V6öâÐ¢g&W6‚VçG'’FVfW'&VC¢fVçVR÷6—F–öâ6æ6†÷B—2æ÷BWF†÷&—FF—fR‚G¶VçG'”†ÇE&V6öçÒ– ¢W6…7FW†Æ—fU÷6—F–öâÂ&VçG'•÷6æ6†÷Eö†ÇB"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’°¢v—B&VÆV6TÆö6²€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚À¢Æ—fT÷&FW$Æö6µFö¶VâÀ¢’æ6F6‚‚‚’Óâ·Ò¢Æ—fT÷&FW$Æö6µFö¶VâÒçVÆÀ¢Ð¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5öFVfW'&VEö6÷VçB"¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢òò7V—&VBÓÓÒG'VS¢vR÷vâF†R6Æ÷Bâ6öçF–çVRFòg&W6‚ÖVçG'¢òòF‚&VÆ÷râF†R†—7F÷&–6Âv—B7V—&TÆö6²‚âââ–gFW"÷&FW ¢òòÆ6VÖVçB—2æ÷r&VGVæFçBæB†2&VVâ&VÖ÷fVB‡6VR7FWR’à¢Ð ¢òò6–×VÆF–öâ†2æò7–Ö&öÂ×66÷VB&VF—2Æö6²Â6òW&f÷&ÒF†R6†VW†—7F–æp¢òòÆæR6†V6²&Vf÷&RF¶–ærF†R6öææV7F–öâ×v–FR6–væÂFÖ—76–öâÆV6RâF†P¢òòWF†÷&—FF—fR&RÖ6†V6²–ç6–FR&W6W'fU6–væÅ÷6—F–öä66—G’6Æ÷6W2F†P¢òò&VÖ–æ–ær7&÷72×v÷&¶W"&6Rà¢–b‚—4Æ—fUG&FTVæ&ÆVB’°¢6öç7BW†—7F–æu6–×VÆFVE6Æ÷BÒv—Bf–æD÷VäÆ—fU÷6—F–öä'”F—"€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢W†V7WF–öå6Æ÷BÀ¢¢–b†W†—7F–æu6–×VÆFVE6Æ÷B’°¢–b†—57V6–Å÷6—F–öâ’°¢6öç7B67V×VÆF–öå&–6RÒ&VÅ÷6—F–öâæVçG'•&–6Râ ¢ò&VÅ÷6—F–öâæVçG'•&–6P¢¢v—BfWF6„7W'&VçE&–6R‡&VÅ÷6—F–öâç7–Ö&öÂÂ6öææV7F–öä–B¢–b†67V×VÆF–öå&–6Râ’°¢&WGW&â67V×VÆFT–çFõ6–×VÆFVE÷6—F–öâ€¢6öææV7F–öä–BÀ¢W†—7F–æu6–×VÆFVE6Æ÷BÀ¢&VÅ÷6—F–öâÀ¢67V×VÆF–öå&–6RÀ¢¢Ð¢Ð¢&WGW&âW†—7F–æu6–×VÆFVE6Æ÷@¢Ð¢Ð ¢òòW†—7F–ærF&vWG2Â&VGV7F–öç2æBF§W7FÖVçG2†fRÇ&VG’&VVâ†æFÆVBà¢òòöæR×6V6öæBæVvF—fR&ööbfö–G2&WVFVFÇ’&–6–æræBW'6—7F–æp¢òòF†÷W6æG2öb–×÷76–&ÆRg&W6‚VçG&–W2âWfW'’6æF–FFR7F–ÆÂ&WGW&ç2¢òò&Æö6¶VB&W7VÇBFòF—7F6‚66÷VçF–ærâç’6WGF–æw2ö6öææV7F–öâ6†ævP¢òò7&VFW2æWr¶W“²æò7&VFVçF–ÂfÇVW2&R&WF–æVB–âF†—266†Rà¢6öç7B'VFvWD&Æö6´¶W’Ò—4Æ—fUG&FTVæ&ÆVBbbÖ&¶WEG—RÓÓÒ&7'—Fò ¢ò7&VFT†6‚‚'6†#Sb"’çWFFR„¥4ôâç7G&–æv–g’…°¢6öææV7F–öä–BÂ&VÅ÷6—F–öâç7–Ö&öÂÂ&VÅ÷6—F–öâæF—&V7F–öâÂW†V7WF–öä–çFVçBÀ¢Æ—fU÷6—F–öâç÷6—F–öä6÷7E7BÂ–æ—F–Ä6öææV7F–öå6WGF–æw2Â–æ—F–Ä6WGF–æw2À¢Ò’’æF–vW7B‚&†W‚"¢¢çVÆÀ¢6öç7B'VFvWD&Æö6²Ò'VFvWD&Æö6´¶W’òÆ—fTVçG'”'VFvWD&Æö6·2ævWB†'VFvWD&Æö6´¶W’’¢çVÆÀ¢–b†'VFvWD&Æö6²’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ&&Æö6¶VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒ&Æ—fUöW‡÷7W&Uö&VÆ÷uöÖ–æ–×VÒ ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒ'VFvWD&Æö6²ç&V6öà¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒ'VFvWD&Æö6²ç&V6öà¢Æ—fU÷6—F–öâæÖ„W†V7WF–öäæ÷F–öæÅW6BÒ'VFvWD&Æö6²æ6V–Æ–æp¢W6…7FW†Æ—fU÷6—F–öâÂ'föÇVÖUöFÖ—76–öâ"ÂfÇ6RÂ'VFvWD&Æö6²ç&V6öâ¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’°¢v—B&VÆV6TÆö6²†6öææV7F–öä–BÂ&VÅ÷6—F–öâç7–Ö&öÂÂ&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚ÂÆ—fT÷&FW$Æö6µFö¶Vâ¢Æ—fT÷&FW$Æö6µFö¶VâÒçVÆÀ¢Ð¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5ö&Æö6¶VEö6÷VçB"¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢6öç7B—56–væÅ÷6—F–öä6æF–FFRÒ—47F—fU6–væÅ÷6—F–öâ€¢Æ—fU÷6—F–öâ2Væ¶æ÷vâ2&V6÷&CÇ7G&–ærÂVæ¶æ÷vãâÀ¢¢–b†—56–væÅ÷6—F–öä6æF–FFR’°¢–b†v—B&÷'E7WW'6VFVB‚’’&WGW&âÆ—fU÷6—F–öà¢6öç7B6–væÅ6WGF–æw2Òv—BÆöE6–væÄ–æF–6F–öå6WGF–æw2‚¢6öç7BFÖ—76–öâÒv—B&W6W'fU6–væÅ÷6—F–öä66—G’€¢6öææV7F–öä–BÀ¢Æ—fU÷6—F–öâÀ¢6–væÅ6WGF–æw2æÖ…÷6—F–öç5F÷FÂÀ¢6–væÅ6WGF–æw2ç÷6—F–öå6VÆV7F–öäÖöFRÀ¢ ¢–b†FÖ—76–öâç7FFRÓÓÒ&W†—7F–ær"’°¢òòÆ—fRÆö6²6âÆVv—F–ÖFVÇ’W‡—&Rv†–ÆR—G2fVçVR÷6—F–öâ&VÖ–ç0¢òò÷VââG&ç6fW"F†RæWvÇ’Ö7V—&VBFö¶VâFòF†B6æöæ–6Â÷6—F–öà¢òò–ç7FVBöb&VÆV6–ær—BæB&V÷Væ–ærF†RGWÆ–6FRv–æF÷rà¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’°¢FÖ—76–öâæW†—7F–æræÆ—fTÆö6µFö¶VâÒÆ—fT÷&FW$Æö6µFö¶Và¢v—B6fU÷6—F–öâ†FÖ—76–öâæW†—7F–ær¢Ð¢&WGW&âFÖ—76–öâæW†—7F–æp¢Ð ¢–b†FÖ—76–öâç7FFRÓÓÒ&Æ–Ö—B"ÇÂFÖ—76–öâç7FFRÓÓÒ&'W7’"’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒFÖ—76–öâç7FFRÓÓÒ&Æ–Ö—B ¢ò6–væÂ÷6—F–öâ66—G’&V6†VB‚G¶FÖ—76–öâæ66—G’çF÷FÇÒòG¶FÖ—76–öâæ66—G’æÆ–Ö—GÒÆöær²6†÷'B“²Æ÷vW"×&æ¶VB6æF–FFRFVfW'&VF ¢¢%6–væÂ÷6—F–öâFÖ—76–öâ—26ö÷&F–æF–æræ÷F†W"6æF–FFS²FVfW'&VBFòF†RæW‡B7–6ÆR ¢W6…7FW†Æ—fU÷6—F–öâÂ'6–væÅ÷÷6—F–öåöFÖ—76–öâ"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’°¢v—B&VÆV6TÆö6²€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚À¢Æ—fT÷&FW$Æö6µFö¶VâÀ¢’æ6F6‚‚‚’Óâ·Ò¢Æ—fT÷&FW$Æö6µFö¶VâÒçVÆÀ¢Ð¢–b‡6†÷VÆDVÖ—E6–væÄ66—G”æ÷F–6R†6öææV7F–öä–B’’°¢v—B&öÖ—6RæÆÂ…°¢Æöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢'6–væÅö66—G’"À¢FÖ—76–öâç7FFRÓÓÒ&Æ–Ö—B"ò'v&æ–ær"¢&–æfò"À¢Æ—fU÷6—F–öâç7FGW5&V6öâÀ¢°¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢F÷FÃ¢FÖ—76–öâæ66—G’çF÷FÂÀ¢Æöæs¢FÖ—76–öâæ66—G’æÆöærÀ¢6†÷'C¢FÖ—76–öâæ66—G’ç6†÷'BÀ¢Æ–Ö—C¢FÖ—76–öâæ66—G’æÆ–Ö—BÀ¢6VÆV7F–öäÖöFS¢6–væÅ6WGF–æw2ç÷6—F–öå6VÆV7F–öäÖöFRÀ¢ÒÀ¢’À¢7—7FVÔÆövvW"æÆöuG&FTVæv–æR€¢Æ—fU÷6—F–öâç7FGW5&V6öâÀ¢FÖ—76–öâç7FFRÓÓÒ&Æ–Ö—B"ò'v&â"¢&–æfò"À¢°¢6öææV7F–öä–BÀ¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢66—G“¢FÖ—76–öâæ66—G’À¢6VÆV7F–öäÖöFS¢6–væÅ6WGF–æw2ç÷6—F–öå6VÆV7F–öäÖöFRÀ¢ÒÀ¢’À¢Ò’æ6F6‚‚‚’Óâ·Ò¢Ð¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢6–væÄ66—G•&W6W'fVBÒG'VP¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢'6–væÅ÷÷6—F–öåöFÖ—76–öâ"À¢G'VRÀ¢&W6W'fVBG¶FÖ—76–öâæ66—G’çF÷FÇÒòG¶FÖ—76–öâæ66—G’æÆ–Ö—GÓ²&W7B×VÆ—G’Öf—'7FÀ¢¢Ð ¢òò6†÷'BÖ6—&7V—Böâ6–×VÆF–öâÖöFR(	B7F–ÆÂ&V6÷&BF†R–çFVçBà¢òð¢òò5$•D”4Ã¢vR÷VÆFRW†V7WFVEVçF—G–òfW&vTW†V7WF–öå&–6V ¢òòòföÇVÖUW6Fò&VÖ–æ–æuVçF—G–ò7–çF†WF–2f–ÆÇ5µÖVçG'¢òò†W&Râ&Wf–÷W6Ç’F†R6–×VÆFVB'&æ6‚ÆVgBÆÂöbF†W6RBÀ¢òòv†–6‚6–ÆVçFÇ’'&ö¶RUdU%’F÷vç7G&VÒ6Æ÷6RFƒ ¢òð¢òò¢6†V6´æDf÷&6T6Æ÷6Töå6ÇG7&÷72‚–V&Ç’×&WGW&ç2v†Và¢òòW†V7WFVEVçF—G’ÃÒ÷"fW&vTW†V7WF–öå&–6RÃÒ(	B6ð¢òò6–×VÆFVB÷6—F–öç2æWfW"†öæ÷&VBF†V—"4ÂõEÆWfVÇ2à¢òò¢F†RÖ‚Ö†öÆB×F–ÖR6Æ÷6W"–â7–æ5v—F„W†6†ævVð¢òò&V6öæ6–ÆTÆ—fU÷6—F–öç6Ç6òvFW2öà¢òòW†V7WFVEVçF—G’âÂ6òF†RBÖ†÷W"6fWG’æWBæWfW ¢òòf÷&6RÖ6Æ÷6VB6–×VÆFVB÷6—F–öç2V—F†W"à¢òð¢òòæWBVffV7C¢WfW'’6–×VÆFVBÆ—fR÷&FW"6BõTâf÷&WfW"–âF†P¢òò&VF—2÷VâÖ–æFW‚Âw&÷v–ærÆ—fU÷÷6—F–öç5ö7&VFVEö6÷VçFv—F†÷W@¢òòWfW"w&÷v–ærÆ—fU÷÷6—F–öç5ö6Æ÷6VEö6÷VçFâF†—2—2F†RW†7@¢òò$Æ—fR÷6—F–öç2&R7F–ÆÂæ÷BvWGF–ær6Æ÷6VB"7–×FöÒF†P¢òò÷W&F÷"&W÷'FVBöâW"ò—5öÆ—fU÷G&FSÖfÇ6R6öææV7F–öç2à¢òð¢òòæ÷s¢6–×VÆFVB÷6—F–öâ&V†fW2Æ–¶RgVÆÇ’Öf–ÆÆVBW†6†ævP¢òò÷6—F–öâBF†R&WVW7FVBVçG'•&–6RÂv—F‚F†R†æWr’W"×F–6°¢òò&ö6W756–×VÆFVE÷6—F–öç67vVWvÆ¶–ær&VF—2Ö&¶WEöFF¢òòæBf÷&6RÖ6Æ÷6–æröâ4ÂõE7&÷72÷"Ö‚Ö†öÆB×F–ÖRW‡—'’à¢–b‚—4Æ—fUG&FTVæ&ÆVB’°¢–b†v—B&÷'E7WW'6VFVB‚’’&WGW&âÆ—fU÷6—F–öà¢6öç7B6–ÕF–6¶W"ÒÖ&¶WEG—RÓÓÒ&f÷&W‚ ¢òv—B&W6öÇfT66†VEfVçVUF–6¶W"‡&VÅ÷6—F–öâç7–Ö&öÂÂ6öææV7F–öä–B¢¢çVÆÀ¢–b‡6–ÕF–6¶W"’°¢Æ—fU÷6—F–öâçV÷FT&–BÒf–æ—FU÷6—F—fR‡6–ÕF–6¶W"æ&–B’ÇÂVæFVf–æV@¢Æ—fU÷6—F–öâçV÷FT6²Òf–æ—FU÷6—F—fR‡6–ÕF–6¶W"æ6²’ÇÂVæFVf–æV@¢Æ—fU÷6—F–öâç7&VE&–6RÒ6–ÕF–6¶W"ç7&VE&–6P¢Æ—fU÷6—F–öâç7&VE—2Ò6–ÕF–6¶W"ç7&VE—0¢Æ—fU÷6—F–öâç7&VD'2Ò6–ÕF–6¶W"ç7&VD'0¢Æ—fU÷6—F–öâç7&VEW&6VçBÒ6–ÕF–6¶W"ç7&VEW&6Vç@¢Æ—fU÷6—F–öâç7&VE6÷W&6RÒ6–ÕF–6¶W"ç7&VE6÷W&6P¢Æ—fU÷6—F–öâçV÷FUF–ÖW7F×Ò6–ÕF–6¶W"çF–ÖW7F× ¢Æ—fU÷6—F–öâç÷6—F–öä6÷7E7BÒVffV7F—fU÷6—F–öä6÷7EW&6VçB€¢÷6—F–öä6÷7E7BÀ¢6–ÕF–6¶W"À¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢°¢Ö&¶WEG—RÀ¢7&VD'VffW%—3¢f–æ—FT÷F–öæÂ€¢†–æ—F–Ä6öææV7F–öå6WGF–æw22ç’’ç7&VEö'VffW%÷—2óð¢†–æ—F–Ä6öææV7F–öå6WGF–æw22ç’’ç7&VD'VffW%—2À¢’À¢7&VD×VÇF—Æ–W#¢f–æ—FT÷F–öæÂ€¢†–æ—F–Ä6öææV7F–öå6WGF–æw22ç’’ç7&VEö×VÇF—Æ–W"óð¢†–æ—F–Ä6öææV7F–öå6WGF–æw22ç’’ç7&VD×VÇF—Æ–W"À¢’À¢ÒÀ¢¢Ð¢6öç7B6–Ô6öçfW'6–öâÒÖ&¶WEG—RÓÓÒ&f÷&W‚ ¢òv—B&W6öÇfTf÷&W…W6D6öçfW'6–öâ†6öææV7F–öä–BÂ&VÅ÷6—F–öâç7–Ö&öÂÂVæFVf–æVBÂG'VR¢¢çVÆÀ¢–b‡6–Ô6öçfW'6–öâ’Æ—fU÷6—F–öâçV÷FUFõW6E&FRÒ6–Ô6öçfW'6–öâç&FP¢òòfWF6‚F†R7W'&VçBÖ&¶WB&–6R6ò6–×VÆFVB÷6—F–öç2÷VâB¢òò&VÂ&–6R†æ÷B’âF†—2Ö—'&÷'2F†RÆ—fRF‚w27FW"'WB'Vç0¢òò†W&R&Vf÷&RF†R6–×VÆF–öâV&Ç’×&WGW&â6ò4ÂõE7&÷72Ö6†V6·2æ@¢òòäÂF—7Æ’&RÖVæ–ævgVÂà¢ÆWB6–ÔVçG'•&–6RÒ6–ÕF–6¶W ¢ò6VÆV7EfVçVUF–6¶W%&–6R‡6–ÕF–6¶W"Â&VÅ÷6—F–öâæF—&V7F–öâ¢¢Æ—fU÷6—F–öâæVçG'•&–6RÇÂ&VÅ÷6—F–öâæVçG'•&–6RÇÂ ¢–b‚6–ÔVçG'•&–6RÇÂ6–ÔVçG'•&–6RÃÒ’°¢6–ÔVçG'•&–6RÒ†v—BfWF6„7W'&VçE&–6R‡&VÅ÷6—F–öâç7–Ö&öÂÂ6öææV7F–öä–B’æ6F6‚‚‚’Óâ’’ÇÂ ¢Ð¢Æ—fU÷6—F–öâæVçG'•&–6RÒ6–ÔVçG'•&–6P ¢òò6ö×WFR&VÆ—7F–2föÇVÖRW6–ærF†RföÇVÖT6Æ7VÆF÷"‡6ÖR27FW0¢òòöâF†RÆ—fRF‚’âfÆÇ2&6²Fò&VÅ÷6—F–öâçVçF—G’–bF†P¢òò6Æ7VÆF÷"f–Ç2†Rærâæò&Ææ6RFF–â6æF&÷‚’à¢ÆWB6–ÕG’ÒÖ&¶WEG—RÓÓÒ&f÷&W‚"ò¢‡&VÅ÷6—F–öâçVçF—G’ÇÂ¢G'’°¢6öç7B²föÇVÖT6Æ7VÆF÷"ÒÒv—B–×÷'B‚$öÆ–"÷föÇVÖRÖ6Æ7VÆF÷""¢6öç7B6–ÕföÅ&W7VÇBÒv—BföÇVÖT6Æ7VÆF÷"æ6Æ7VÆFUföÇVÖTf÷$6öææV7F–öâ€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢6–ÔVçG'•&–6RÀ¢°¢G&FTÖöFS¢föÇVÖUG&FTÖöFTf÷$–çFVçB†W†V7WF–öä–çFVçB’À¢6—¦T×VÇF—Æ–W#¢&VÅ÷6—F–öâç6—¦T×VÇF—Æ–W"À¢ÆÆ÷uVæ&÷VæFVEf&–çD×VÇF—Æ–W#¢&VÅ÷6—F–öâæ6öÖ&–æVE÷46÷VçG2ÓÓÒG'VRÀ¢–æF–6F–öåG—S¢&VÅ÷6—F–öâæ–æF–6F–öåG—RÀ¢Ö&¶WEG—S¢Æ—fU÷6—F–öâæÖ&¶WEG—RÀ¢Æ÷E6—¦S¢Æ—fU÷6—F–öâæÆ÷E6—¦RÀ¢÷6—F–öä6÷7EW&6VçD÷fW'&–FS¢Æ—fU÷6—F–öâç÷6—F–öä6÷7E7BÀ¢V÷FUFõW6E&FS¢Æ—fU÷6—F–öâçV÷FUFõW6E&FRÀ¢ÒÀ¢¢6öç7BföÂÒ6–ÕföÅ&W7VÇCòæf–æÅföÇVÖRóò6–ÕföÅ&W7VÇCòæ6Æ7VÆFVEföÇVÖRóò6–ÕföÅ&W7VÇCòçföÇVÖRóò ¢–b‡föÂâ’°¢6–ÕG’ÒföÀ¢Æ—fU÷6—F–öâæÆWfW&vRÒ6–ÕföÅ&W7VÇBæÆWfW&vRÇÂÆ—fU÷6—F–öâæÆWfW&vP¢Æ—fU÷6—F–öâç&WVW7FVEföÇVÖRÒçVÖ&W"‡6–ÕföÅ&W7VÇBæ6Æ7VÆFVEföÇVÖR’ÇÂ ¢Æ—fU÷6—F–öâæ–çFVæFVDæ÷F–öæÅW6BÒçVÖ&W"‡6–ÕföÅ&W7VÇBæ–çFVæFVDæ÷F–öæÅW6B’ÇÂ ¢Æ—fU÷6—F–öâæW†6†ævTÖ–äæ÷F–öæÅW6BÒçVÖ&W"‡6–ÕföÅ&W7VÇBæW†6†ævTÖ–äæ÷F–öæÅW6B’ÇÂ ¢Æ—fU÷6—F–öâç7—7FVÕföÇVÖTf7F÷"ÒçVÖ&W"‡6–ÕföÅ&W7VÇBç7—7FVÕföÇVÖTf7F÷"’ÇÂ¢Æ—fU÷6—F–öâæÆ—fTVæv–æTf7F÷"ÒçVÖ&W"‡6–ÕföÅ&W7VÇBæÆ—fTVæv–æTf7F÷"’ÇÂ¢Æ—fU÷6—F–öâç6–væÅföÇVÖTf7F÷"ÒçVÖ&W"‡6–ÕföÅ&W7VÇBç6–væÅföÇVÖTf7F÷"’ÇÂ¢Æ—fU÷6—F–öâçföÇVÖTF§W7FVBÒ6–ÕföÅ&W7VÇBçföÇVÖTF§W7FVBÓÓÒG'VP¢Æ—fU÷6—F–öâçföÇVÖTF§W7FÖVçE&V6öâÒ6–ÕföÅ&W7VÇBæF§W7FÖVçE&V6öâÇÂVæFVf–æV@¢Ð¢–b†Ö&¶WEG—RÓÓÒ&f÷&W‚"bb6–ÕföÅ&W7VÇCòæ6öçfW'6–öäf–Æ&ÆRÓÓÒfÇ6R’°¢6–ÕG’Ò ¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ&&Æö6¶VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒ'6–×VÆF–öå÷&VfÆ–v‡Eöf–ÆVB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒ6–ÕföÅ&W7VÇBæF§W7FÖVçE&V6öâÇÂ%U4B6öçfW'6–öâVæf–Æ&ÆR ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒ6–ÕföÅ&W7VÇBæF§W7FÖVçE&V6öâÇÂ$f÷&W‚U4B6öçfW'6–öâ&FRVæf–Æ&ÆS²6–×VÆF–öâ&VgW6VB ¢W6…7FW†Æ—fU÷6—F–öâÂ'föÇVÖUö6Æ2"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5ö&Æö6¶VEö6÷VçB"¢&WGW&âÆ—fU÷6—F–öà¢Ð¢Ò6F6‚°¢–b†Ö&¶WEG—RÓÓÒ&f÷&W‚"’6–ÕG’Ò ¢Ð¢–b‚‡6–ÕG’â’’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ&&Æö6¶VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒ'6–×VÆF–öå÷&VfÆ–v‡Eöf–ÆVB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒÖ&¶WEG—RÓÓÒ&f÷&W‚ ¢ò$æòW†V7WF&ÆRÆ÷B6—¦R÷"U4B6öçfW'6–öâ ¢¢$æòW†V7WF&ÆRVçF—G’ ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒÖ&¶WEG—RÓÓÒ&f÷&W‚ ¢ò$f÷&W‚6–×VÆF–öâ&VgW6VC¢æòW†V7WF&ÆRÆ÷B6—¦R÷"U4B6öçfW'6–öâ ¢¢%6–×VÆF–öâ&VgW6VC¢æòW†V7WF&ÆRVçF—G’ ¢W6…7FW†Æ—fU÷6—F–öâÂ'föÇVÖUö6Æ2"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5ö&Æö6¶VEö6÷VçB"¢&WGW&âÆ—fU÷6—F–öà¢Ð¢–b†Ö&¶WEG—RÓÓÒ&f÷&W‚"’°¢6öç7B7V2ÒvWDf÷&W„–ç7G'VÖVçE7V2‡&VÅ÷6—F–öâç7–Ö&öÂ¢Æ—fU÷6—F–öâçVçF—G•7FWÒ7V2æÖ–äÆ÷@¢Æ—fU÷6—F–öâçVçF—G•&V6—6–öâÒ ¢Æ—fU÷6—F–öâç&–6U&V6—6–öâÒ7V2æF–v—G0¢Æ—fU÷6—F–öâç&–6UF–6²Ò¢¢×7V2æF–v—G0¢Ð¢–b†v—B&÷'E7WW'6VFVB‚’’&WGW&âÆ—fU÷6—F–öà ¢òò6WBfW&vTW†V7WF–öå&–6R&Vf÷&R6ÆÆ–ær6ö×WFTFW6—&VE&÷FV7F–öå&–6W0¢òò&V6W6RF†BgVæ7F–öâW6W2—B2F†Rf–ÆÂ&–6Rf÷"4ÂõE6Æ7VÆF–öâà¢Æ—fU÷6—F–öâæfW&vTW†V7WF–öå&–6RÒ6–ÔVçG'•&–6P¢òò6ö×WFR4ÂõE&–6W2f÷"F†R6–×VÆFVB÷6—F–öâ6ò&V6öæ6–ÆRæ@¢òò6†V6´æDf÷&6T6Æ÷6Töå6ÇG7&÷72†fRfÆ–B&–6RF&vWG2à¢–b‡6–ÔVçG'•&–6Râ’°¢6öç7B6–Õ&÷FV7F–öâÒ6ö×WFTFW6—&VE&÷FV7F–öå&–6W2†Æ—fU÷6—F–öâ¢òò¶VWF†R7G&FVw’Ö76–væVBW&6VçFvW2–Ö×WF&ÆRâW"÷6—F–öç0¢òò†fRæòfVçVR6öçG&öÂ÷&FW"Â6òW'6—7B&÷F‚F†R'6öÇWFRF&vWG0¢òòæBF†V—"W‡Æ–6—BVæv–æR×6–FRÆ–fV7–6ÆR÷væW'6†—à¢Æ—fU÷6—F–öâç7F÷Æ÷75&–6RÒ6–Õ&÷FV7F–öâæFW6—&VE6Ââò6–Õ&÷FV7F–öâæFW6—&VE6Â¢VæFVf–æV@¢Æ—fU÷6—F–öâçF¶U&öf—E&–6RÒ6–Õ&÷FV7F–öâæFW6—&VEGâò6–Õ&÷FV7F–öâæFW6—&VEG¢VæFVf–æV@¢&Vg&W6…&÷FV7F–öä†æFÆ–ætÖöFR€¢Æ—fU÷6—F–öâÀ¢6–Õ&÷FV7F–öâæFW6—&VE6ÂÀ¢6–Õ&÷FV7F–öâæFW6—&VEGÀ¢G'VRÀ¢¢Ð¢Æ—fU÷6—F–öâæW†V7WFVEVçF—G’Ò6–ÕG¢Æ—fU÷6—F–öâç&VÖ–æ–æuVçF—G’Ò ¢Æ—fU÷6—F–öâæfW&vTW†V7WF–öå&–6RÒ6–ÔVçG'•&–6P¢Æ—fU÷6—F–öâçföÇVÖUW6BÒ÷6—F–öäæ÷F–öæÅW6B†Æ—fU÷6—F–öâÂ6–ÕG’Â6–ÔVçG'•&–6R¢Æ—fU÷6—F–öâæ–æ—F–ÄW†V7WFVEVçF—G’Ò6–ÕG¢–b‡7V6–Å÷6—F–öåÆâ’°¢Æ—fU÷6—F–öâç7V6–Ä&6UVçF—G’Ò6–ÕG’ò7V6–Å÷6—F–öåÆâçF÷FÅföÇVÖU&F–ð¢Ç•7V6–ÅÆåFõ÷6—F–öâ†Æ—fU÷6—F–öâÂ7V6–Å÷6—F–öåÆâ¢Ð¢Æ—fU÷6—F–öâçF÷FÄW†V7WFVEVçF—G’Ò6–ÕG¢Æ—fU÷6—F–öâæ–æ—F–ÄVçG'•&–6RÒ6–ÔVçG'•&–6P¢Æ—fU÷6—F–öâæ&Æö6´&6UVçF—G’Ò6–ÕG¢–æ—F–Æ—¦T–æFWVæFVçD&Æö6µ6VVB†Æ—fU÷6—F–öâÂ&VÅ÷6—F–öâÂ6–ÕG’¢–b†Æ—fU÷6—F–öâæ6öÖ&–æVE÷46÷VçG2’°¢Æ—fU÷6—F–öâç÷46÷VçG56WEVçF—F–W2ÒÆÆö6FU÷6—F–öå6WEVçF—F–W2€¢Æ—fU÷6—F–öâÀ¢6–ÕG’À¢Æ—fU÷6—F–öâæ67V×VÆFVE6WD¶W—2À¢¢Ð¢Æ—fU÷6—F–öâæf–ÆÇ2Ò°¢°¢F–ÖW7F×¢FFRææ÷r‚’À¢VçF—G“¢6–ÕG’À¢&–6S¢6–ÔVçG'•&–6RÀ¢fVS¢À¢fVT76WC¢""À¢ÒÀ¢Ð¢Æ—fU÷6—F–öâç7FGW2Ò'6–×VÆFVB ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒ&Æ—fU÷G&FRF—6&ÆVB'’÷W&F÷"(	BæòW†6†ævRW†V7WF–öâ ¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ'6–×VÆF–öâ ¢W6…7FW†Æ—fU÷6—F–öâÂ'6–×VÆFR"ÂG'VRÂG“ÒG·6–ÕG—ÒG·6–ÔVçG'•&–6WÖ¢–b†v—B&÷'E7WW'6VFVB‚’’&WGW&âÆ—fU÷6—F–öà¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B&V6÷&Df–ÆÄ6÷VçFW'4öæ6R€¢6öææV7F–öä–BÀ¢Æ—fU÷6—F–öâÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢¢òòW'6—7BF†RGW&&ÆRf–ÆÂÖ&¶W"gFW"F†R–FV×÷FVçBVçG'’ÆVFvW"æ@¢òòÆVv7’f–ÆÂÖWG&–72†fR6öÖÖ—GFVBà¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢òò'VâW"6÷VçFW'2–æFWVæFVçFÇ’â&VÂÆ6VBöf–ÆÆVB÷÷6—F–öâÖ7&VFV@¢òò6÷VçFW'2&VÖ–âW†6†ævRÖöæÇ’6òT’õbõäÂæWfW"&W6VçB6WVFòf–ÆÇ0¢òò2fVçVRW†V7WF–öç2à¢v—B&öÖ—6RæÆÂ…°¢–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5÷6–×VÆFVEö6÷VçB"’À¢–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fU÷6–×VÆFVE÷÷6—F–öç5ö7&VFVEö6÷VçB"’À¢–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fU÷6–×VÆFVE÷föÇVÖUöÖ–7&÷W6E÷F÷FÂ"ÂÖF‚ç&÷VæB†Æ—fU÷6—F–öâçföÇVÖUW6B¢Sb’’À¢Æöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&–æfò"À¢6–×VÆFVBÆ—fR÷&FW"†Æ—fU÷G&FRF—6&ÆVB'’÷W&F÷"’G·&VÅ÷6—F–öâç7–Ö&öÇÖÀ¢²F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÂVçF—G“¢6–ÕG’ÂVçG'•&–6S¢6–ÔVçG'•&–6RÐ¢’À¢Ò¢6öç6öÆRæÆör†G´Äôuõ$Td•‡Ò4”ÕTÄD”ôã¢G·&VÅ÷6—F–öâç7–Ö&öÇÒG·&VÅ÷6—F–öâæF—&V7F–öçÒG“ÒG·6–ÕG—ÒG·6–ÔVçG'•&–6WÒ†Æ—fU÷G&FRF—6&ÆVB'’÷W&F÷"–¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢–b‚W†6†ævT6öææV7F÷"ÇÂG—VöbW†6†ævT6öææV7F÷"çÆ6T÷&FW"ÓÒ&gVæ7F–öâ"’°¢Æ—fU÷6—F–öâç7FGW2Ò&W'&÷" ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒ$W†6†ævR6öææV7F÷"æ÷Bf–Æ&ÆR÷"Ö—76–ærÆ6T÷&FW" ¢W6…7FW†Æ—fU÷6—F–öâÂ&6öææV7F÷%ö6†V6²"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B&V6÷&DW†V7WF–öå&VfÆ–v‡Df–ÇW&R‚¢v—BÆöu&öw&W76–öäWfVçB†6öææV7F–öä–BÂ&Æ—fU÷G&F–ær"Â&W'&÷""Â$Æ—fR÷&FW"f–ÆVB(	Bæò6öææV7F÷""Â°¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢Ò¢òò&VÆV6RF†RFVGWÆö6²vR7V—&VBBF†RF÷öbF†—2gVæ7F–öâ6ð¢òòF†RæW‡B6–væÂ—6âwB&Æö6¶VBf÷"F†RgVÆÂRÖÖ–âEDÂöâæöâÐ¢òò&V6÷fW&&ÆR6öææV7F÷"f–ÇW&R†÷W&F÷"Æ–¶VÇ’F–FâwB6öæf–wW&R¢òò6öææV7F÷"(	BF†W’æVVBFò&R&ÆRFò&WG'’öæ6RF†W’Fò’à¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’v—B&VÆV6TÆö6²†6öææV7F–öä–BÂ&VÅ÷6—F–öâç7–Ö&öÂÂ&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚ÂÆ—fT÷&FW$Æö6µFö¶Vâ’æ6F6‚‚‚’Óâ·Ò¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢v—B76W'DÖ&v–ä6ÆÄVçG'”ÆÆ÷vVB†6öææV7F–öä–BÂW†6†ævT6öææV7F÷" ¢òò)H)H7FW#¢fWF6‚F†RWF†÷&—FF—fRfVçVR&–6R)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òò†—7F÷&–6Â7G&FVw’&÷w26âW6Ræ÷&ÖÆ—¦VB&–6RFöÖ–â†f÷ ¢òòW†×ÆRã’v†–ÆRF†R7GVÂfVçVR–ç7G'VÖVçBG&FW2Bg&7F–öâö`¢òòF†BfÇVRâW6–ærF†R6WVFò&–6R†W&R6÷''WG2VçF—G’6—¦–æræ@¢òòG&–Æ–ærö6öçG&öÂÖ÷&FW"&–6W2â&VÂW†6†ævR×WFF–öç2F†W&Vf÷&Rf–À¢òò6Æ÷6VBVæÆW72F†R6öææV7F÷"—G6VÆb7WÆ–W27W'&VçBF–6¶W"à¢6öç7BfVçVUF–6¶W"Òv—B&W6öÇfTWF†÷&—FF—fTÆ—fUF–6¶W"€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢W†6†ævT6öææV7F÷"À¢¢6öç7B7W'&VçE&–6RÒ6VÆV7EfVçVUF–6¶W%&–6R‡fVçVUF–6¶W"Â&VÅ÷6—F–öâæF—&V7F–öâ¢–b‚7W'&VçE&–6RÇÂ7W'&VçE&–6RÃÒ’°¢Æ—fU÷6—F–öâç7FGW2Ò&W'&÷" ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒæòWF†÷&—FF—fRW†6†ævRF–6¶W"f–Æ&ÆRf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÖ ¢W6…7FW†Æ—fU÷6—F–öâÂ'&–6UöfWF6‚"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B&V6÷&DW†V7WF–öå&VfÆ–v‡Df–ÇW&R‚¢v—BÆöu&öw&W76–öäWfVçB†6öææV7F–öä–BÂ&Æ—fU÷G&F–ær"Â&W'&÷""Â$Æ—fR÷&FW"f–ÆVB(	BæòWF†÷&—FF—fRfVçVRF–6¶W""Â°¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢Ò¢òò&VÆV6RF†RFVGWÆö6²(	BÖ—76–ærÖ&¶WB&–6R—2G&ç6–Vç@¢òò6öæF—F–öâ‡G—–6ÆÇ’g&W6‚7–Ö&öÂv†÷6RF–6¶W"†6âwB7G&VÖV@¢òò–WB’âv—F†÷WB&VÆV6–ærÂF†RæW‡B7–6ÆRw26–væÂv÷VÆBFVfW"f÷ ¢òòRÖ–çWFW2WfVâF†÷Vv‚F†R&–6R'&—fW2v—F†–â6V6öæG2à¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’v—B&VÆV6TÆö6²†6öææV7F–öä–BÂ&VÅ÷6—F–öâç7–Ö&öÂÂ&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚ÂÆ—fT÷&FW$Æö6µFö¶Vâ’æ6F6‚‚‚’Óâ·Ò¢&WGW&âÆ—fU÷6—F–öà¢Ð¢–b‡fVçVUF–6¶W"’°¢Æ—fU÷6—F–öâçV÷FT&–BÒf–æ—FU÷6—F—fR‡fVçVUF–6¶W"æ&–B’ÇÂVæFVf–æV@¢Æ—fU÷6—F–öâçV÷FT6²Òf–æ—FU÷6—F—fR‡fVçVUF–6¶W"æ6²’ÇÂVæFVf–æV@¢Æ—fU÷6—F–öâç7&VE&–6RÒfVçVUF–6¶W"ç7&VE&–6P¢Æ—fU÷6—F–öâç7&VE—2ÒfVçVUF–6¶W"ç7&VE—0¢Æ—fU÷6—F–öâç7&VD'2ÒfVçVUF–6¶W"ç7&VD'0¢Æ—fU÷6—F–öâç7&VEW&6VçBÒfVçVUF–6¶W"ç7&VEW&6Vç@¢Æ—fU÷6—F–öâç7&VE6÷W&6RÒfVçVUF–6¶W"ç7&VE6÷W&6P¢Æ—fU÷6—F–öâçV÷FUF–ÖW7F×ÒfVçVUF–6¶W"çF–ÖW7F× ¢Æ—fU÷6—F–öâæÖ&¶WEG—RÒfVçVUF–6¶W"æÖ&¶WEG—RÇÂÖ&¶WEG—P¢Æ—fU÷6—F–öâçföÇVÖT¶–æBÒÆ—fU÷6—F–öâæÖ&¶WEG—RÓÓÒ&f÷&W‚"ò&Æ÷G2"¢&&6R ¢Æ—fU÷6—F–öâç÷6—F–öä6÷7E7BÒVffV7F—fU÷6—F–öä6÷7EW&6VçB€¢÷6—F–öä6÷7E7BÀ¢fVçVUF–6¶W"À¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢°¢Ö&¶WEG—S¢Æ—fU÷6—F–öâæÖ&¶WEG—RÀ¢7&VD'VffW%—3¢f–æ—FT÷F–öæÂ€¢†–æ—F–Ä6öææV7F–öå6WGF–æw22ç’’ç7&VEö'VffW%÷—2óð¢†–æ—F–Ä6öææV7F–öå6WGF–æw22ç’’ç7&VD'VffW%—2À¢’À¢7&VD×VÇF—Æ–W#¢f–æ—FT÷F–öæÂ€¢†–æ—F–Ä6öææV7F–öå6WGF–æw22ç’’ç7&VEö×VÇF—Æ–W"óð¢†–æ—F–Ä6öææV7F–öå6WGF–æw22ç’’ç7&VD×VÇF—Æ–W"À¢’À¢ÒÀ¢¢Ð¢–b†Æ—fU÷6—F–öâæÖ&¶WEG—RÓÓÒ&f÷&W‚"’°¢6öç7B—"Òf÷&W…—$7W'&Væ6–W2‡&VÅ÷6—F–öâç7–Ö&öÂ¢–b‡—"bb—"çV÷FRÓÒ%U4B"bb—"æ&6RÓÒ%U4B"’°¢6öç7B6öçfW'6–öâÒv—B&W6öÇfTf÷&W…W6D6öçfW'6–öâ€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢W†6†ævT6öææV7F÷"À¢¢–b‚6öçfW'6–öâ’°¢Æ—fU÷6—F–öâç7FGW2Ò&W'&÷" ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒ$æòWF†÷&—FF—fRU4B6öçfW'6–öâV÷FRf–Æ&ÆRf÷"f÷&W‚—""°¢&VÅ÷6—F–öâç7–Ö&öÂ²"‚"²—"çV÷FR²"’ ¢W6…7FW†Æ—fU÷6—F–öâÂ&f÷&W…ö6öçfW'6–öâ"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B&öÖ—6RæÆÂ…°¢&V6÷&DW†V7WF–öå&VfÆ–v‡Df–ÇW&R‚’À¢Æöu&öw&W76–öäWfVçB†6öææV7F–öä–BÂ&Æ—fU÷G&F–ær"Â&W'&÷""ÂÆ—fU÷6—F–öâç7FGW5&V6öâÂ°¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢Ò’À¢Ò¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’°¢v—B&VÆV6TÆö6²€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚À¢Æ—fT÷&FW$Æö6µFö¶VâÀ¢’æ6F6‚‚‚’Óâ·Ò¢Ð¢&WGW&âÆ—fU÷6—F–öà¢Ð¢Æ—fU÷6—F–öâçV÷FUFõW6E&FRÒ6öçfW'6–öâç&FP¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢&f÷&W…ö6öçfW'6–öâ"À¢G'VRÀ¢—"çV÷FR².(i%U4CÒ"²6öçfW'6–öâç&FR²"‚"²6öçfW'6–öâç6÷W&6R²"’"À¢¢Ð¢Ð¢Æ—fU÷6—F–öâæVçG'•&–6RÒ7W'&VçE&–6P¢W6…7FW†Æ—fU÷6—F–öâÂ'&–6UöfWF6‚"ÂG'VRÂ&–6SÒG¶7W'&VçE&–6WÖ ¢òò)H)H÷W&F÷"öÆ–7“¢Åt•2W6RfVçVRÖ‚ÆWfW&vR)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òò&VÅ÷6—F–öâæÆWfW&vR6'&–W2F†RW"×f&–çB6ö÷&F–æF–öâ6–væÀ¢òòƒÂ"Â2ÂW‚g&öÒW‡æE6—¦TÆWfW&vUf&–çG2’âF†B—2â”åDU$äÀ¢òò&æ¶–ær6–væÂöæÇ’(	BB÷&FW"F–ÖRvRVæ6öæF—F–öæÆÇ’÷fW'&–FRFð¢òòF†R6öææV7F–öâw2Ö†–×VÒ7W÷'FVBÆWfW&vRà¢òð¢òòF†R&Wf–÷W2wV&B–b‡fVçVTÖ‚âÆ—fU÷6—F–öâæÆWfW&vR–6W6V@¢òò6–ÆVçBf–ÇW&W3¢v†VâvWDÖ„ÆWfW&vTf÷$W†6†ævR&WGW&æVBF†P¢òò4dUôDTdTÅBƒ’ûûÞûûÒv†–6‚—2âç’6ö÷&F–æF–öâ6–væÂƒ(	3W‚’(	@¢òòF†R÷6—F–öâv2Æ6VBB‚&F†W"F†âS‚„&–æu‚Ö‚’à¢òòf—ƒ¢Çv—276–vâÂæò6ö×&—6öâà¢òð¢òòF÷vç7G&VÒ6fWG’æWG2&VÖ–â&ÖVC ¢òòâ6WDÆWfW&vR‡7–Ö&öÂÂfVçVTÖ‚’(	BW†6†ævR6Æ×2FòW"×7–Ö&öÀ¢òò'&6¶WB†Rærâ%D2#W‚Â4ôÂsW‚¢òò"â#B$–ç7Vff–6–VçBÖ&v–â"WFòÖ†ÇfR²ÆWcÓ&WG'’&VÆ÷p¢°¢6öç7B&Wf–÷W2ÒÆ—fU÷6—F–öâæÆWfW&vP¢6öç7B²vWD6öææV7F–öã¢övWD6öæäÆWbÒÒv—B–×÷'B‚$öÆ–"÷&VF—2ÖF""¢6öç7B6öæå&V6÷&BÒv—BövWD6öæäÆWb†6öææV7F–öä–B’æ6F6‚‚‚’ÓâçVÆÂ¢6öç7BfVçVTÖ‚ÒvWDÖ„ÆWfW&vTf÷$W†6†ævR†6öæå&V6÷&CòæW†6†ævR¢Æ—fU÷6—F–öâæÆWfW&vRÒfVçVTÖ€¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢&ÆWfW&vUö÷fW'&–FR"À¢G'VRÀ¢6ö÷&F–æF–öãÒG·&Wf–÷W7×‚(i"fVçVUöÖƒÒG·fVçVTÖ‡×‚†÷W&F÷"öÆ–7’–À¢¢Ð ¢òò)H)H7FW3¢föÇVÖR6Æ7VÆF–öâ)H)H)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òòF†R6Æ7VÆF÷"×W7B&WGW&âf–æ—FR&—6²Ö'VFvWFVBVçF—G’âÖ—76–æp¢òò&Ææ6Rö6öçfW'6–öâö6V–Æ–ær—26fWG’f–ÇW&RÂæ÷B&V6öâFò–çfVçB¢òòVæ—fW'6ÂÖÖ–æ–×VÒ÷&FW"âfVçVRÖ–æ–×V×2&R†öæ÷&VBöæÇ’v†VâF†W’f—@¢òò–ç6–FRF†R&÷fVB÷6—F–öä6÷7B6V–Æ–ærà¢òð¢òò)H)HG&FRÖÖöFR&W6öÇWF–öâf÷"F†RVæv–æRföÇVÖRf7F÷")H)H)H)H)H)H)H)H ¢òòF†RÆ—fR×7FvR•2F†RÆ—fRÖW†V7WF–öâF‚'’FVf–æ—F–öâ(	B—@¢òòÕU5BFVÆÂföÇVÖT6Æ7VÆF÷&v†–6‚Væv–æR—26¶–ærf÷"6—¦–ær6ð¢òòF†RW"ÖVæv–æR×VÇF—Æ–W"„Ö–âg2â&W6WB’—2Æ–VBâvR&WW6P¢òòF†RÇ&VG’ÖÆöFVB6öæå6WGF–æw6FòFW&—fRF†RÖöFRv—F†÷WB¢òò6V6öæB&VF—2&÷VæB×G&— ¢òòÒ&W6WBVæv–æS¢—5÷&W6WE÷G&FS×G'VVäB—5öÆ—fU÷G&FSÖfÇ6V ¢òòÒÖ–âVæv–æS¢÷F†W'v—6R‡F†R6öç6W'fF—fRFVfVÇB(	Bv†Và¢òò&÷F‚fÆw2†VâFò&RG'VRGW&–ærT¢òòFövvÆRG&ç6—F–öâvRFöâwBvçBFò6–ÆVçFÇ¢òòÇ’&W6WBw2G—–6ÆÇ’ÖÖ÷&RÖvw&W76—fP¢òò×VÇF—Æ–W"’à¢òò7G&FVw’ò6WVFò×÷6—F–öâ6ÆÆW'2†–â6WVFò×÷6—F–öâÖÖævW"¢òòFòäõB72G&FTÖöFV(	BF†W’&VÖ–â&F–òÖöæÇ’W"7V2à¢6öç7BÆ—fUG&FTÖöFRÒföÇVÖUG&FTÖöFTf÷$–çFVçB†W†V7WF–öä–çFVçB ¢òòÆöBF†RW†7BfVçVRw&–G2&Vf÷&R&VÂ÷&FW"6âÆVfRF†R&ö6W72à¢òòVçF—G’&V6—6–öâÆöæR—2–ç7Vff–6–VçBf÷"6V7W&—G’G&–vvW#¢F†P¢òò6Æ÷BÖÆWfVÂgVÆÂ×VçF—G’7F÷×W7B&R&W&W6VçF&ÆRöâF†RW†7B&–6RF–6²à¢6öç7BÆ—fT–ç7G'VÖVçE'VÆW2Òv—BÆöDW†6†ævUVçF—G•'VÆW2€¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢W†6†ævT6öææV7F÷"À¢6öææV7F–öä–BÀ¢¢Ç”Æ—fT–ç7G'VÖVçE'VÆW2†Æ—fU÷6—F–öâÂÆ—fT–ç7G'VÖVçE'VÆW2¢–b†&–æu„Vçf—&öæÖVçD–æfò†W†6†ævT6öææV7F÷"’bb†Æ—fU÷6—F–öâç&–6UF–6²bbÆ—fU÷6—F–öâç&–6UF–6²â’’°¢Æ—fU÷6—F–öâç7FGW2Ò&W'&÷" ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒW†6†ævRVçG'’&VfÆ–v‡Bf–ÆVC¢W†7B&–æu‚&–6RF–6²Væf–Æ&ÆRf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÖ ¢W6…7FW†Æ—fU÷6—F–öâÂ&–ç7G'VÖVçE÷'VÆW2"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B&öÖ—6RæÆÂ…°¢&V6÷&DW†V7WF–öå&VfÆ–v‡Df–ÇW&R‚’À¢Æöu&öw&W76–öäWfVçB†6öææV7F–öä–BÂ&Æ—fU÷G&F–ær"Â&W'&÷""ÂÆ—fU÷6—F–öâç7FGW5&V6öâÂ°¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢Ò’À¢Ò¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’°¢v—B&VÆV6TÆö6²€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚À¢Æ—fT÷&FW$Æö6µFö¶VâÀ¢’æ6F6‚‚‚’Óâ·Ò¢Ð¢&WGW&âÆ—fU÷6—F–öà¢Ð¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢&–ç7G'VÖVçE÷'VÆW2"À¢G'VRÀ¢G•7FWÒG¶Æ—fU÷6—F–öâçVçF—G•7FWÒ&–6UF–6³ÒG¶Æ—fU÷6—F–öâç&–6UF–6²ÇÂ'Vç7W÷'FVB'ÖÀ¢ ¢6öç7BföÇVÖU&W7VÇBÒv—BföÇVÖT6Æ7VÆF÷"æ6Æ7VÆFUföÇVÖTf÷$6öææV7F–öâ€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢7W'&VçE&–6RÀ¢°¢G&FTÖöFS¢Æ—fUG&FTÖöFRÀ¢òòf÷'v&BF†R&Æö6²ôD4f&–çB×VÇF—Æ–W"6òæ÷F–öæÂ—26÷'&V7FÇ¢òò66ÆVB&Vf÷&RF†RW†6†ævR÷&FW"—2Æ6VB†'6VçB(i"ã–FVçF—G’’à¢6—¦T×VÇF—Æ–W#¢&VÅ÷6—F–öâç6—¦T×VÇF—Æ–W"À¢òòöæÇ’6öÖ&–æVB÷6—F–öâÔ6÷VçBF&vWB&W&W6VçG2F†R7VÒöbWfW'¢òòfÆ–B6WBâ÷&F–æ'’&Æö6²ôD4f&–çG2&VÖ–â6fVÇ’&÷VæFVBà¢ÆÆ÷uVæ&÷VæFVEf&–çD×VÇF—Æ–W#¢&VÅ÷6—F–öâæ6öÖ&–æVE÷46÷VçG2ÓÓÒG'VRÀ¢–æF–6F–öåG—S¢&VÅ÷6—F–öâæ–æF–6F–öåG—RÀ¢÷6—F–öä6÷7EW&6VçD÷fW'&–FS¢Æ—fU÷6—F–öâç÷6—F–öä6÷7E7BÀ¢Ö&¶WEG—S¢Æ—fU÷6—F–öâæÖ&¶WEG—RÀ¢Æ÷E6—¦S¢Æ—fU÷6—F–öâæÆ÷E6—¦RÀ¢V÷FUFõW6E&FS¢Æ—fU÷6—F–öâçV÷FUFõW6E&FRÀ¢ÒÀ¢’æ6F6‚†W'"Óâ°¢6öç6öÆRæW'&÷"†G´Äôuõ$Td•‡ÒföÇVÖR6Æ2W'&÷#¦ÂW'"¢&WGW&âçVÆÀ¢Ò ¢ÆWB6ö×WFVEföÇVÖRÒföÇVÖU&W7VÇCòæf–æÅföÇVÖRÇÂföÇVÖU&W7VÇCòçföÇVÖRÇÂ ¢ÆWBföÇVÖTæ÷FRÒ" ¢–b†6ö×WFVEföÇVÖRÃÒÇÂçVÖ&W"æ—4f–æ—FR†6ö×WFVEföÇVÖR’’°¢6öç7B6V–Æ–ærÒçVÖ&W"‡föÇVÖU&W7VÇCòæÖ„W†V7WF–öäæ÷F–öæÅW6B¢6öç7B'VFvWD&VÆ÷tÖ–æ–×VÒÒ6V–Æ–ærâb`¢6V–Æ–ærÂçVÖ&W"‡föÇVÖU&W7VÇCòæW†6†ævTÖ–äæ÷F–öæÅW6B’b`¢föÇVÖU&W7VÇCòæ&Ææ6T—4fÆÆ&6²ÓÒG'VP¢Æ—fU÷6—F–öâç7FGW2Ò'VFvWD&VÆ÷tÖ–æ–×VÒò'&V¦V7FVB"¢&W'&÷" ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒföÇVÖU&W7VÇCòæF§W7FÖVçE&V6öâÇÀ¢$Æ—fRVçG'’&VgW6VC¢æòf–æ—FR&—6²Ö'VFvWFVBW†V7WF&ÆRVçF—G’v26Æ7VÆFVB ¢–b†'VFvWD&VÆ÷tÖ–æ–×VÒ’°¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ&&Æö6¶VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒ&Æ—fUöW‡÷7W&Uö&VÆ÷uöÖ–æ–×VÒ ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒÆ—fU÷6—F–öâç7FGW5&V6öà¢Æ—fU÷6—F–öâæÖ„W†V7WF–öäæ÷F–öæÅW6BÒ6V–Æ–æp¢–b†'VFvWD&Æö6´¶W’’Æ—fTVçG'”'VFvWD&Æö6·2ç&VÖVÖ&W"†'VFvWD&Æö6´¶W’Â°¢Ö&¶WEG—RÀ¢f–æÅVçF—G“¢6ö×WFVEföÇVÖRÀ¢6V–Æ–ærÀ¢Væ—fW'6ÄÖ–æ–×VÓ¢föÇVÖT6Æ7VÆF÷"åTä•dU%4ÅôÔ”åôäõD”ôäÅõU4BÀ¢&Ææ6T—4fÆÆ&6³¢föÇVÖU&W7VÇCòæ&Ææ6T—4fÆÆ&6²ÓÓÒG'VRÀ¢&V6öã¢Æ—fU÷6—F–öâç7FGW5&V6öâÀ¢Ò¢Ð¢W6…7FW†Æ—fU÷6—F–öâÂ'föÇVÖUö6Æ2"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B&öÖ—6RæÆÂ…°¢'VFvWD&VÆ÷tÖ–æ–×VÐ¢ò–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5ö&Æö6¶VEö6÷VçB"¢¢&V6÷&DW†V7WF–öå&VfÆ–v‡Df–ÇW&R‚’À¢Æöu&öw&W76–öäWfVçB†6öææV7F–öä–BÂ&Æ—fU÷G&F–ær"Â'VFvWD&VÆ÷tÖ–æ–×VÒò'v&æ–ær"¢&W'&÷""ÂÆ—fU÷6—F–öâç7FGW5&V6öâÂ°¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢Ò’À¢Ò¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’°¢v—B&VÆV6TÆö6²€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚À¢Æ—fT÷&FW$Æö6µFö¶VâÀ¢’æ6F6‚‚‚’Óâ·Ò¢Ð¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢òòfÆÆ&6²&Ææ6R¶VW2W"6Æ7VÆF–öç2W6VgVÂÂ'WB—B—2æ÷B¢òò6fR&6—2f÷"&VÂõe5B÷&FW"âW6–ær7–çF†WF–2ÃÕU4B&Ææ6P¢òògFW"'&ö¶W"ô’÷WFvR6âGW&â6ÖÆÂ66÷VçB–çFòâ÷fW'6—¦V@¢òò÷&FW"â7F÷&Vf÷&RF†Rf—'7BfVçVR7V&Ö—76–öâæBÆWBF†RæW‡B7–6ÆP¢òò&WG'’gFW"âWF†÷&—FF—fR&Ææ6R—2f–Æ&ÆRà¢–b†Æ—fU&VF–æW72æ6åÆ6U&VÄ÷&FW'2bbföÇVÖU&W7VÇCòæ&Ææ6T—4fÆÆ&6²ÓÓÒG'VR’°¢Æ—fU÷6—F–öâç7FGW2Ò&W'&÷" ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒ$Æ—fRVçG'’&VgW6VC¢WF†÷&—FF—fRW†6†ævR&Ææ6RVæf–Æ&ÆS²æòfÆÆ&6²&Ææ6RÖ’6—¦RÆ—fRõe5B÷&FW" ¢W6…7FW†Æ—fU÷6—F–öâÂ&&Ææ6U÷&VfÆ–v‡B"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B&öÖ—6RæÆÂ…°¢&V6÷&DW†V7WF–öå&VfÆ–v‡Df–ÇW&R‚’À¢Æöu&öw&W76–öäWfVçB†6öææV7F–öä–BÂ&Æ—fU÷G&F–ær"Â&W'&÷""ÂÆ—fU÷6—F–öâç7FGW5&V6öâÂ°¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢Ò’À¢Ò¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’°¢v—B&VÆV6TÆö6²€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚À¢Æ—fT÷&FW$Æö6µFö¶VâÀ¢’æ6F6‚‚‚’Óâ·Ò¢Ð¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢òòF—&V7BÕG&FR7WÆ–W2öæRÖ–æ–×VÒ×föÇVÖRV6öæöÖ–2–çFVçBg&öÒ—G2ÆV6V@¢òòv÷&¶W"âF†R6æöæ–6Â6Æ7VÆF÷"&VÖ–ç2F†R†&B&—6²6V–Æ–æs²F†—0¢òò'&æ6‚6âöæÇ’&VGV6RF†BVçF—G’†÷"&—6RF†R6ÆÆW"w27V"ÖÖ–æ–×VÐ¢òò&WVW7BFòF†RfVçVRÖ–æ–×VÒv†VâF†R6ÖR÷6—F–öä6÷7B6V–Æ–ærW&Ö—G0¢òò—B’â—B6âæWfW"GW&âF—&V7B&WVW7B–çFòÆ&vW"&—6²ÆÆö6F–öâà¢6öç7BF—&V7E&WVW7FVEVçF—G’ÒçVÖ&W"‡&VÅ÷6—F–öâç&WVW7FVEVçF—G”6¢–b†W†V7WF–öä–çFVçBÓÓÒ&F—&V7B"bbF—&V7E&WVW7FVEVçF—G’â’°¢6öç7Bæ÷&ÖÆ—¦VDF—&V7BÒ&W6öÇfTW†V7WF&ÆUVçF—G’€¢F—&V7E&WVW7FVEVçF—G’À¢7W'&VçE&–6RÀ¢Æ—fT–ç7G'VÖVçE'VÆW2À¢²Væ—fW'6ÄÖ–äæ÷F–öæÅW6GC¢föÇVÖT6Æ7VÆF÷"åTä•dU%4ÅôÔ”åôäõD”ôäÅõU4BÒÀ¢¢6öç7BF—&V7D6V–Æ–ærÒçVÖ&W"†æ÷&ÖÆ—¦VDF—&V7BçVçF—G’ÇÂ¢ÆWB&÷VæFVDF—&V7EVçF—G’Ò&÷VæEVçF—G”F÷vâ€¢ÖF‚æÖ–â†6ö×WFVEföÇVÖRÂF—&V7D6V–Æ–ær’À¢Æ—fT–ç7G'VÖVçE'VÆW2À¢¢–b€¢&÷VæFVDF—&V7EVçF—G’ÂÆ—fT–ç7G'VÖVçE'VÆW2æÖ–åVçF—G’ÒRÓ"b`¢F—&V7D6V–Æ–ærÃÒ6ö×WFVEföÇVÖR²RÓ ¢’°¢&÷VæFVDF—&V7EVçF—G’ÒF—&V7D6V–Æ–æp¢Ð¢–b‚†&÷VæFVDF—&V7EVçF—G’â’’°¢Æ—fU÷6—F–öâç7FGW2Ò&W'&÷" ¢Æ—fU÷6—F–öâç7FGW5&V6öâÐ¢$F—&V7BÕG&FRÖ–æ–×VÒ×föÇVÖR&WVW7BFöW2æ÷Bf—B–ç6–FRF†R6æöæ–6Â÷6—F–öä6÷7B6V–Æ–ær ¢W6…7FW†Æ—fU÷6—F–öâÂ&F—&V7E÷VçF—G•ö6"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B&V6÷&DW†V7WF–öå&VfÆ–v‡Df–ÇW&R‚¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’°¢v—B&VÆV6TÆö6²€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚À¢Æ—fT÷&FW$Æö6µFö¶VâÀ¢’æ6F6‚‚‚’Óâ·Ò¢Ð¢&WGW&âÆ—fU÷6—F–öà¢Ð¢6ö×WFVEföÇVÖRÒ&÷VæFVDF—&V7EVçF—G¢föÇVÖTæ÷FRÒ¶F—&V7B×&WVW7C¢G¶F—&V7E&WVW7FVEVçF—G—Ò(i"G¶6ö×WFVEföÇVÖWÕÖ ¢Ð ¢òò&RÖÇ’F†R6Æ7VÆF÷"w2†&Bæ÷F–öæÂ6V–Æ–ærgFW"–ç7G'VÖVç@¢òòÖWFFF†2&VVâÆöFVBâF†—2&÷FV7G2F†RW†6†ævR&÷VæF'’–b¢òò7FÆR66†R÷"gWGW&R6Æ7VÆF÷"6†ævR&÷VæG2âVçG'’Wv&Bà¢6öç7BÖ„W†V7WF–öäæ÷F–öæÅW6BÒçVÖ&W"‡föÇVÖU&W7VÇCòæÖ„W†V7WF–öäæ÷F–öæÅW6B¢6öç7B7W'&VçDæ÷F–öæÂÒ÷6—F–öäæ÷F–öæÅW6B†Æ—fU÷6—F–öâÂ6ö×WFVEföÇVÖRÂ7W'&VçE&–6R¢–b†Æ—fU&VF–æW72æ6åÆ6U&VÄ÷&FW'2bb‚†Ö„W†V7WF–öäæ÷F–öæÅW6Bâ’ÇÂ7W'&VçDæ÷F–öæÂâÖ„W†V7WF–öäæ÷F–öæÅW6B²RÓ‚’’°¢6öç7BVæ—Dæ÷F–öæÂÒ÷6—F–öäæ÷F–öæÅW6B†Æ—fU÷6—F–öâÂÂ7W'&VçE&–6R¢6öç7B6VEVçF—G’ÒVæ—Dæ÷F–öæÂâbbÖ„W†V7WF–öäæ÷F–öæÅW6Bâ ¢ò&÷VæEVçF—G”F÷vâ†Ö„W†V7WF–öäæ÷F–öæÅW6BòVæ—Dæ÷F–öæÂÂÆ—fT–ç7G'VÖVçE'VÆW2¢¢ ¢6öç7B6VDæ÷F–öæÂÒ÷6—F–öäæ÷F–öæÅW6B†Æ—fU÷6—F–öâÂ6VEVçF—G’Â7W'&VçE&–6R¢–b‚†6VEVçF—G’â’ÇÂ6VDæ÷F–öæÂâÖ„W†V7WF–öäæ÷F–öæÅW6B²RÓ‚ÇÂ6VEVçF—G’ÂÆ—fT–ç7G'VÖVçE'VÆW2æÖ–åVçF—G’’°¢Æ—fU÷6—F–öâç7FGW2Ò&W'&÷" ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒÆ—fRVçG'’&VgW6VC¢W†V7WF&ÆRVçF—G’W†6VVG2F†RG¶Ö„W†V7WF–öäæ÷F–öæÅW6BâòÖ„W†V7WF–öäæ÷F–öæÅW6BçFôf—†VBƒ"’¢&6öæf–wW&VB'ÒU4BW‡÷7W&R6V–Æ–æv ¢W6…7FW†Æ—fU÷6—F–öâÂ'föÇVÖUö6"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B&V6÷&DW†V7WF–öå&VfÆ–v‡Df–ÇW&R‚¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’v—B&VÆV6TÆö6²†6öææV7F–öä–BÂ&VÅ÷6—F–öâç7–Ö&öÂÂ&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚ÂÆ—fT÷&FW$Æö6µFö¶Vâ’æ6F6‚‚‚’Óâ·Ò¢&WGW&âÆ—fU÷6—F–öà¢Ð¢6ö×WFVEföÇVÖRÒ6VEVçF—G¢föÇVÖTæ÷FRÒ¶†&BÖ6¢G¶6VDæ÷F–öæÂçFôf—†VBƒ"—ÒU4EÖ ¢Ð ¢òòWfW'’VçG'’&WG'’—2æWrfVçVR7V&Ö—76–öââ¶VWÖ–æ–×VÒÖ÷&FW"æ@¢òòÖ&v–âfÆÆ&6·2öâF†R6ÖRVçF—G’w&–BæB†&B÷6—F–öä6÷7B60¢òòF†R&–Ö'’÷&FW#²6÷'&V7F–öâ×W7BæWfW"&V6öÖRföÇVÖRW66R†F6‚à¢ÆWBÆ—fU7V&Ö—76–öäæ÷F–öæÄ6V–Æ–ærÒÖ„W†V7WF–öäæ÷F–öæÅW6@¢6öç7Bæ÷&ÖÆ—¦U&WG'”VçG'•VçF—G’Ò‡&WVW7FVC¢çVÖ&W"ÂVæf÷&6TÖ–æ–×VÓ¢&ööÆVâ“¢çVÖ&W"Óâ°¢6öç7B&rÒçVÖ&W"‡&WVW7FVB¢–b‚çVÖ&W"æ—4f–æ—FR‡&r’ÇÂ&rÃÒ’&WGW&â ¢ÆWBVçF—G’ÒVæf÷&6TÖ–æ–×VÐ¢òÆ—fU÷6—F–öâæÖ&¶WEG—RÓÓÒ&f÷&W‚ ¢ò&÷VæEVçF—G•W„ÖF‚æÖ‚‡&rÂÆ—fT–ç7G'VÖVçE'VÆW2æÖ–åVçF—G’’ÂÆ—fT–ç7G'VÖVçE'VÆW2¢¢&W6öÇfTW†V7WF&ÆUVçF—G’€¢&rÀ¢7W'&VçE&–6RÀ¢Æ—fT–ç7G'VÖVçE'VÆW2À¢²Væ—fW'6ÄÖ–äæ÷F–öæÅW6GC¢föÇVÖT6Æ7VÆF÷"åTä•dU%4ÅôÔ”åôäõD”ôäÅõU4BÒÀ¢’çVçF—G¢¢&÷VæEVçF—G”F÷vâ‡&rÂÆ—fT–ç7G'VÖVçE'VÆW2¢–b‚‡VçF—G’â’’&WGW&â  ¢6öç7BVæ—Dæ÷F–öæÂÒ÷6—F–öäæ÷F–öæÅW6B†Æ—fU÷6—F–öâÂÂ7W'&VçE&–6R¢–b†Æ—fU7V&Ö—76–öäæ÷F–öæÄ6V–Æ–ærâbbVæ—Dæ÷F–öæÂâ’°¢6öç7BÖ†–×VÒÒ&÷VæEVçF—G”F÷vâ†Æ—fU7V&Ö—76–öäæ÷F–öæÄ6V–Æ–æròVæ—Dæ÷F–öæÂÂÆ—fT–ç7G'VÖVçE'VÆW2¢–b‚†Ö†–×VÒâ’’&WGW&â ¢VçF—G’ÒÖF‚æÖ–â‡VçF—G’ÂÖ†–×VÒ¢Ð¢–b‚Væf÷&6TÖ–æ–×VÒbbVçF—G’ÂÆ—fT–ç7G'VÖVçE'VÆW2æÖ–åVçF—G’ÒRÓ"’&WGW&â ¢6öç7BF÷FÄæ÷F–öæÂÒ÷6—F–öäæ÷F–öæÅW6B†Æ—fU÷6—F–öâÂVçF—G’Â7W'&VçE&–6R¢–b‚‡F÷FÄæ÷F–öæÂâ’ÇÂ†Æ—fU7V&Ö—76–öäæ÷F–öæÄ6V–Æ–ærâbbF÷FÄæ÷F–öæÂâÆ—fU7V&Ö—76–öäæ÷F–öæÄ6V–Æ–ær²RÓ‚’’&WGW&â ¢–b†Væf÷&6TÖ–æ–×VÒbbÆ—fU÷6—F–öâæÖ&¶WEG—RÓÒ&f÷&W‚"’°¢6öç7BÖ–æ–×VÒÒ&W6öÇfTW†V7WF&ÆUVçF—G’€¢ÖF‚æÖ‚†Æ—fT–ç7G'VÖVçE'VÆW2æÖ–åVçF—G’Â7W'&VçE&–6RâòföÇVÖT6Æ7VÆF÷"åTä•dU%4ÅôÔ”åôäõD”ôäÅõU4Bò7W'&VçE&–6R¢’À¢7W'&VçE&–6RÀ¢Æ—fT–ç7G'VÖVçE'VÆW2À¢²Væ—fW'6ÄÖ–äæ÷F–öæÅW6GC¢föÇVÖT6Æ7VÆF÷"åTä•dU%4ÅôÔ”åôäõD”ôäÅõU4BÒÀ¢’çVçF—G¢–b†Ö–æ–×VÒâbbVçF—G’²RÓ"ÂÖ–æ–×VÒ’&WGW&â ¢Ð¢&WGW&âVçF—G¢Ð ¢òò†–v‚×f—6–&–Æ—G’F–væ÷7F–2f÷"F†RÖ÷7B6öÖÖöâ&V6öâ&VÂ÷&FW'2æWfW"V"öâF†RW†6†ævP¢–b†6ö×WFVEföÇVÖRÃÒ’°¢6öç6öÆRæW'&÷"€¢G´Äôuõ$Td•‡Ò´äõõ$TÅôõ$DU%ÒG·&VÅ÷6—F–öâç7–Ö&öÇÒG·&VÅ÷6—F–öâæF—&V7F–öçÒ(	B6ö×WFVEföÇVÖSÓgFW"ÆÂfÆÆ&6·2â°¢F†—2—2ÆÖ÷7BÇv—2v‡’&æò÷6—F–öç2öâÆ—fRW†6†ævR"gFW"V–6·7F'Bâ°¢föÇVÖU&W7VÇCÒG´¥4ôâç7G&–æv–g’‡föÇVÖU&W7VÇB—Ö ¢¢Ð ¢Æ—fU÷6—F–öâçVçF—G’Ò6ö×WFVEföÇVÖP¢Æ—fU÷6—F–öâç&VÖ–æ–æuVçF—G’Ò6ö×WFVEföÇVÖP¢Æ—fU÷6—F–öâçföÇVÖUW6BÒ÷6—F–öäæ÷F–öæÅW6B†Æ—fU÷6—F–öâÂ6ö×WFVEföÇVÖRÂ7W'&VçE&–6R¢Æ—fU÷6—F–öâæÆWfW&vRÒföÇVÖU&W7VÇCòæÆWfW&vRÇÂÆ—fU÷6—F–öâæÆWfW&vP¢Æ—fU÷6—F–öâç&WVW7FVEföÇVÖRÒçVÖ&W"‡föÇVÖU&W7VÇCòæ6Æ7VÆFVEföÇVÖR’ÇÂ ¢Æ—fU÷6—F–öâæ–çFVæFVDæ÷F–öæÅW6BÒçVÖ&W"‡föÇVÖU&W7VÇCòæ–çFVæFVDæ÷F–öæÅW6B’ÇÂ ¢Æ—fU÷6—F–öâæW†6†ævTÖ–äæ÷F–öæÅW6BÒçVÖ&W"‡föÇVÖU&W7VÇCòæW†6†ævTÖ–äæ÷F–öæÅW6B’ÇÂ ¢Æ—fU÷6—F–öâæÖ„W†V7WF–öäæ÷F–öæÅW6BÒÖ„W†V7WF–öäæ÷F–öæÅW6BâòÖ„W†V7WF–öäæ÷F–öæÅW6B¢VæFVf–æV@¢Æ—fU÷6—F–öâæÆ—fT×VÇF—Æ–W$6VBÒföÇVÖU&W7VÇCòæÆ—fT×VÇF—Æ–W$6VBÓÓÒG'VP¢Æ—fU÷6—F–öâç7—7FVÕföÇVÖTf7F÷"ÒçVÖ&W"‡föÇVÖU&W7VÇCòç7—7FVÕföÇVÖTf7F÷"’ÇÂ¢Æ—fU÷6—F–öâæÆ—fTVæv–æTf7F÷"ÒçVÖ&W"‡föÇVÖU&W7VÇCòæÆ—fTVæv–æTf7F÷"’ÇÂ¢Æ—fU÷6—F–öâç6–væÅföÇVÖTf7F÷"ÒçVÖ&W"‡föÇVÖU&W7VÇCòç6–væÅföÇVÖTf7F÷"’ÇÂ¢Æ—fU÷6—F–öâç6—¦T×VÇF—Æ–W"ÒçVÖ&W"‡föÇVÖU&W7VÇCòç6—¦T×VÇF—Æ–W"’ÇÂ¢Æ—fU÷6—F–öâçföÇVÖTF§W7FVBÒföÇVÖU&W7VÇCòçföÇVÖTF§W7FVBÓÓÒG'VP¢Æ—fU÷6—F–öâçföÇVÖTF§W7FÖVçE&V6öâÒföÇVÖU&W7VÇCòæF§W7FÖVçE&V6öâÇÂVæFVf–æV@¢òòföÇVÖR6Æ7VÆF–öâÖ’&Vg&W6‚—"ÖWFFF²&RÖÇ’F†R6æöæ–6À¢òòæ÷&ÖÆ—¦VB6æ6†÷B6òWfW'’W'6—7FVB&÷r—26VÆbÖFW67&–&–ærà¢Ç”Æ—fT–ç7G'VÖVçE'VÆW2†Æ—fU÷6—F–öâÂÆ—fT–ç7G'VÖVçE'VÆW2 ¢òò–bF†RföÇVÖR6Æ7VÆF÷"6Æ×VBF†RVçF—G’UFòâW†6†ævP¢òòÖ–æ–×VÒÂ7W&f6RF†B–âF†P¢òò&öw&W76–öâ7FW6òF†RT’òÆöw26†÷r§v‡’¢F†RW†V7WFVBG¢òòF–ffW'2g&öÒF†R6ö÷&F–æF–öâÖFW&—fVBG’&F†W"F†â§W7B&&P¢òòçVÖ&W"âF†R7FW—2Çv—2&V6÷&FVB27V66W76gVÂ&V6W6RF†P¢òò÷&FW"—G6VÆb—2fÆ–B(	BÖ–æ–×VÒVæf÷&6VÖVçBæWfW"f–Ç2F†RG&FRà¢6öç7B6Æ×æ÷FRÒföÇVÖU&W7VÇCòçföÇVÖTF§W7FVBbbföÇVÖU&W7VÇBæF§W7FÖVçE&V6öà¢ò¶6Æ×VB×FòÖÖ–ã¢G·föÇVÖU&W7VÇBæF§W7FÖVçE&V6öçÕÖ ¢¢" ¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢'föÇVÖUö6Æ2"À¢G'VRÀ¢G“ÒG¶6ö×WFVEföÇVÖRçFôf—†VBƒb—ÒW6CÒG¶Æ—fU÷6—F–öâçföÇVÖUW6BçFôf—†VBƒ"—ÒÆWcÒG¶Æ—fU÷6—F–öâæÆWfW&vW×‚G¶6Æ×æ÷FWÒG·föÇVÖTæ÷FWÖ ¢¢–b‡föÇVÖU&W7VÇB’°¢v—BföÇVÖT6Æ7VÆF÷"æÆöuföÇVÖT6Æ7VÆF–öâ†6öææV7F–öä–BÂ&VÅ÷6—F–öâç7–Ö&öÂÂföÇVÖU&W7VÇB’æ6F6‚‚‚’Óâ·Ò¢Ð ¢òò)H)H7FWS¢Æ6RVçG'’÷&FW"v—F‚&WG'’)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞûûÞûûÞ)H)H)H)H)H)H)H)H)H ¢6öç7BW†6†ævU6–FS¢&'W’"Â'6VÆÂ"Ò&VÅ÷6—F–öâæF—&V7F–öâÓÓÒ&Æöær"ò&'W’"¢'6VÆÂ  ¢òò)H)H6ö×&V†Vç6—fRÆövv–ærG&6R)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òòöæRG&6R–B7ç2F†R&–Ö'’GFV×BÂF†RÆWfW&vR×&VGV6VB&WG'’À¢òòF†RÖ–â×6—¦R6÷'&V7F–öâ&WG'’ÂF†Rf–ÆÂöÆÆ–ærÂæBF†Rf–æÀ¢òò÷WF6öÖRÆ–æRâw&W·cÒ´Æ—fT÷&FW%Ö²G&6SÖFò&V6öç7G'V7BF†P¢òògVÆÂÆ–fV7–6ÆRöbç’f–Æ–ær÷&FW"âG&6R—27&VFVB†W&R†æ÷B@¢òògVæ7F–öâVçG'’’6ò67V×VÆF–öâÖW&vW2æBFVGW×6¶—F‡2&÷fP¢òòFöâwBöÆÇWFRF†RÆörv—F‚æòÖ÷G&6W2à¢6öç7B÷&FW%G&6S¢Æ—fT÷&FW%G&6RÒæWtÆ—fT÷&FW%G&6R‡°¢6öææV7F–öä–BÀ¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢W†6†ævU6–FRÀ¢Ò ¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡ÒU„T5UD”är$TÃ¢G·&VÅ÷6—F–öâç7–Ö&öÇÒG·&VÅ÷6—F–öâæF—&V7F–öçÒ(i"G¶W†6†ævU6–FWÒG“ÒG¶6ö×WFVEföÇVÖRçFôf—†VB€¢`¢—ÒG¶7W'&VçE&–6WÒG&6SÒG¶÷&FW%G&6RçG&6T–GÖ ¢ ¢òòf÷"W'VçG&–W2vR72F†RW‡Æ–6—B÷6—F–öå6–FRÖF6†–ærF†R&VÀ¢òò÷6—F–öâF—&V7F–öâ6ò†VFvRÖÖöFR66÷VçG2&÷WFR6÷'&V7FÇ’â6öææV7F÷'0¢òòF†BFöâwB6&R&÷WBF†R÷F–öç2ö&¦V7B6–×Ç’–væ÷&RF†RgF‚&rà¢òò&–æu‚w2öæR×v’ÖÖöFR66÷VçG2WFò×&WG'’v—F†÷WB÷6—F–öå6–FR–bF†P¢òòW†6†ævR&V¦V7G2—B†6öFRƒB’Â6òF†—2—26fRf÷"&÷F‚ÖöFW2à¢òð¢òò)H)H5$•D”4Ã¢&RÖ6†V6²—5öÆ—fU÷G&FR$”t…B$Tdõ$R÷&FW"Æ6VÖVçB)H)H)H)H)H)H ¢òòF†RfÆr—26†V6¶VBöæ6RBVçG'’Â'WB–bF†R÷W&F÷"FövvÆW2Æ—fRG&FP¢òòöfbGW&–ær&VfÆ–v‡BÂvR×W7B6F6‚—B†W&R&Vf÷&R6VæF–ærF†R÷&FW"Fð¢òòF†RW†6†ævRâF†—2—2FVfVç6—fR6V6öæBvFRâFW7FæWB—27F–ÆÂà¢òòW†6†ævRVçf—&öæÖVçBÂ6òFòäõB&Æö6²—B†W&S²F†R6öææV7F÷"&÷WFW2Fð¢òòF†RFW7FæWBVæGö–çBv†Vâ—5÷FW7FæWB—2G'VRà¢6öç7B²vWD6öææV7F–öã¢&T6†V6´6öæâÒÒv—B–×÷'B‚$öÆ–"÷&VF—2ÖF""¢6öç7B°¢—46öææV7F–öäÆ—fUG&FTVæ&ÆVC¢&T6†V6´Ö–äVæ&ÆVBÀ¢—46öææV7F–öå&W6WEG&FTVæ&ÆVC¢&T6†V6µ&W6WDVæ&ÆVBÀ¢—5G'WF‡”fÆs¢&T6†V6µG'WF‡’À¢ÒÒv—B–×÷'B‚$öÆ–"ö6öææV7F–öâ×7FFR×WF–Ç2"¢6öç7Bg&W6…6WGF–æw2Ò†v—B&T6†V6´6öæâ†6öææV7F–öä–B’’ÇÂ·Ð¢6öç7Bg&W6„Ö–äÖöFTVæ&ÆVBÒ&T6†V6´Ö–äVæ&ÆVB†g&W6…6WGF–æw2¢6öç7Bg&W6…&W6WDÖöFTVæ&ÆVBÒ&T6†V6µ&W6WDVæ&ÆVB†g&W6…6WGF–æw2¢6öç7Bg&W6„W†V7WF–öä–çFVçC¢Æ—fTW†V7WF–öä–çFVçBÒ—4F—&V7E÷6—F–öà¢ò&F—&V7B ¢¢—56–væÅ÷6—F–öà¢ò'6–væÂ ¢¢g&W6…&W6WDÖöFTVæ&ÆVBbbg&W6„Ö–äÖöFTVæ&ÆV@¢ò'&W6WB ¢¢&Ö–â ¢6öç7Bg&W6…&VF–æW74–çFVçBÒ&VF–æW74–çFVçDf÷$W†V7WF–öâ†g&W6…6WGF–æw2Âg&W6„W†V7WF–öä–çFVçB¢6öç7Bg&W6…&VF–æW72Òg&W6„W†V7WF–öä–çFVçBÓÓÒ&F—&V7B ¢òWfÇVFTF—&V7EG&FTÆ—fU&VF–æW72†g&W6…6WGF–æw2Â6öææV7F–öä–B¢¢WfÇVFU&VÅG&FU&VF–æW72†g&W6…6WGF–æw2Âg&W6…&VF–æW74–çFVçB¢6öç7B7WW'f—6VE6Öö¶T–BÒv—B6Æ–VçBævWB‚&Æ—fUö÷&FW%÷6Öö¶S¦7F—fR"’æ6F6‚‚‚’ÓâçVÆÂ¢6öç7BVæv–æU&ö6W76–ærÒg&W6„W†V7WF–öä–çFVçBÓÓÒ&F—&V7B ¢òv—B—47W'&VçB‚¢¢—46öææV7F–öäÖ–å&ö6W76–ær†g&W6…6WGF–æw2¢6öç7B—57F–ÆÄÆ—fRÒg&W6…&VF–æW72æ6åÆ6U&VÄ÷&FW'2bbVæv–æU&ö6W76–ærbb7WW'f—6VE6Öö¶T–@¢–b†v—B&÷'E7WW'6VFVB‚’’&WGW&âÆ—fU÷6—F–öà¢ ¢6öç7B—5FW7FæWD6öææV7F–öâÒ&T6†V6µG'WF‡’†g&W6…6WGF–æw2æ—5÷FW7FæWB¢–b†—5FW7FæWD6öææV7F–öâ’°¢W6…7FW†Æ—fU÷6—F–öâÂ&VçG'•öVçf—&öæÖVçB"ÂG'VRÂ'FW7FæWB6öææV7F–öâ(	B&÷WF–ær÷&FW"F‡&÷Vv‚FW7FæWB6öææV7F÷"VæGö–çB"¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&–æfò"À¢$Æ—fR÷&FW"&ö6VVF–æröâW†6†ævRFW7FæWBVæGö–çB"À¢²7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÂF—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÂW†6†ævT“¢g&W6…6WGF–æw2æW†6†ævRÒÀ¢’æ6F6‚‚‚’Óâ·Ò¢Ð ¢–b‚—57F–ÆÄÆ—fR’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ&&Æö6¶VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒVæv–æU&ö6W76–æp¢ò&Væv–æU÷&ö6W76–æu÷7F÷VB ¢¢g&W6…&VF–æW72æ&Æö6´6öFRÇÂVæFVf–æV@¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒVæv–æU&ö6W76–æp¢òg&W6„W†V7WF–öä–çFVçBÓÓÒ&F—&V7B ¢ò$F—&V7BÕG&FR&ö6W76÷"ÆV6R÷"Æ—fR7FFR—2æòÆöævW"7F—fR ¢¢$6öææV7F–öâ&ö6W76–ær—27F÷VB ¢¢g&W6…&VF–æW72æ&Æö6µ&V6öâÇÂVæFVf–æV@¢Æ—fU÷6—F–öâç7FGW5&V6öâÒ7WW'f—6VE6Öö¶T–@¢òW†6†ævR÷&FW"&Æö6¶VB&Vf÷&RÆ6VÖVçC¢7WW'f—6VBÆ—fRÖ÷&FW"6Öö¶RG·7WW'f—6VE6Öö¶T–GÒ÷vç2F†R66÷VçBvFV ¢¢Væv–æU&ö6W76–æp¢òg&W6„W†V7WF–öä–çFVçBÓÓÒ&F—&V7B ¢ò$W†6†ævR÷&FW"&Æö6¶VB&Vf÷&RÆ6VÖVçC¢F—&V7BÕG&FR&ö6W76÷"ÆV6R÷"Æ—fR7FFR7F÷VB ¢¢$W†6†ævR÷&FW"&Æö6¶VB&Vf÷&RÆ6VÖVçC¢6öææV7F–öâ&ö6W76–ær—27F÷VB ¢¢W†6†ævR÷&FW"&Æö6¶VB&Vf÷&RÆ6VÖVçB‚G¶g&W6…&VF–æW72æ&Æö6´6öFRÇÂ'Væ¶æ÷vâ'Ò“¢G¶g&W6…&VF–æW72æ&Æö6µ&V6öçÖ ¢W6…7FW†Æ—fU÷6—F–öâÂ&VçG'’"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5ö&Æö6¶VEö6÷VçB"¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&–æfò"À¢Æ—fU÷6—F–öâç7FGW5&V6öâÀ¢²7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÂF—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÒÀ¢’æ6F6‚‚‚’Óâ·Ò¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’°¢v—B&VÆV6TÆö6²€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚À¢Æ—fT÷&FW$Æö6µFö¶VâÀ¢’æ6F6‚‚‚’Óâ·Ò¢Ð¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢6öç7BW†—7F–ætVçG'•&÷FV7F–öä†ÇBÒv—B6Æ–VçBævWB†VçG'•&÷FV7F–öä†ÇD¶W’’æ6F6‚‚‚’ÓâçVÆÂ¢–b†W†—7F–ætVçG'•&÷FV7F–öä†ÇB’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ&&Æö6¶VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒ&VçG'•÷&÷FV7F–öåö†ÇFVB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒ$&–÷"VçG'’6÷VÆBæ÷B&÷fR6ö×ÆWFRfVçVR&÷FV7F–öâ ¢Æ—fU÷6—F–öâç7FGW5&V6öâÐ¢$W†6†ævR÷&FW"&Æö6¶VB&Vf÷&RÆ6VÖVçC¢VçG'’&÷FV7F–öâ†ÇB&WV—&W2&V6öæ6–Æ–F–öâ ¢W6…7FW†Æ—fU÷6—F–öâÂ&VçG'•÷&÷FV7F–öåöFÖ—76–öâ"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5ö&Æö6¶VEö6÷VçB"¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢–b‚v—B7V—&TVçG'•&÷FV7F–öäFÖ—76–öäÆö6²‚’’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ&&Æö6¶VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒ&VçG'•÷&÷FV7F–öåöFÖ—76–öåö'W7’ ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒ$æ÷F†W"VçG'’—26ö×ÆWF–ær—G2fVçVR&÷FV7F–öâ6öçG&7B ¢Æ—fU÷6—F–öâç7FGW5&V6öâÐ¢$W†6†ævR÷&FW"FVfW'&VC¢6öææV7F–öâ×v–FR&÷FV7F–öâFÖ—76–öâ—2'W7’ ¢W6…7FW†Æ—fU÷6—F–öâÂ&VçG'•÷&÷FV7F–öåöFÖ—76–öâ"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5öFVfW'&VEö6÷VçB"¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢òò&R×&VBF†RGW&&ÆR7v—F6†W2gFW"7V—&–ærF†R66÷VçB×v–FRÆV6Rà¢òòF†—26Æ÷6W2F†R7F÷÷7F'B&6Rv†–ÆRF†R6ÆÆW"v—FVB&V†–æBæ÷F†W ¢òòVçG'’æBVç7W&W26–væÂ6ææ÷B6öçF–çVRgFW"F†RVæv–æR—27F÷VBà¢6öç7BÆö6¶VE6WGF–æw2Ò†v—B&T6†V6´6öæâ†6öææV7F–öä–B’’ÇÂ·Ð¢6öç7BÆö6¶VDÖ–äÖöFTVæ&ÆVBÒ&T6†V6´Ö–äVæ&ÆVB†Æö6¶VE6WGF–æw2¢6öç7BÆö6¶VE&W6WDÖöFTVæ&ÆVBÒ&T6†V6µ&W6WDVæ&ÆVB†Æö6¶VE6WGF–æw2¢6öç7BÆö6¶VDW†V7WF–öä–çFVçC¢Æ—fTW†V7WF–öä–çFVçBÒ—4F—&V7E÷6—F–öà¢ò&F—&V7B ¢¢—56–væÅ÷6—F–öà¢ò'6–væÂ ¢¢Æö6¶VE&W6WDÖöFTVæ&ÆVBbbÆö6¶VDÖ–äÖöFTVæ&ÆV@¢ò'&W6WB ¢¢&Ö–â ¢6öç7BÆö6¶VE&VF–æW72ÒÆö6¶VDW†V7WF–öä–çFVçBÓÓÒ&F—&V7B ¢òWfÇVFTF—&V7EG&FTÆ—fU&VF–æW72†Æö6¶VE6WGF–æw2Â6öææV7F–öä–B¢¢WfÇVFU&VÅG&FU&VF–æW72€¢Æö6¶VE6WGF–æw2À¢&VF–æW74–çFVçDf÷$W†V7WF–öâ†Æö6¶VE6WGF–æw2ÂÆö6¶VDW†V7WF–öä–çFVçB’À¢¢6öç7BÆö6¶VE&ö6W76–ærÒÆö6¶VDW†V7WF–öä–çFVçBÓÓÒ&F—&V7B ¢òv—B—47W'&VçB‚¢¢—46öææV7F–öäÖ–å&ö6W76–ær†Æö6¶VE6WGF–æw2¢–b‚Æö6¶VE&ö6W76–ærÇÂÆö6¶VE&VF–æW72æ6åÆ6U&VÄ÷&FW'2’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ&&Æö6¶VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒÆö6¶VE&ö6W76–æp¢ò&Væv–æU÷&ö6W76–æu÷7F÷VB ¢¢Æö6¶VE&VF–æW72æ&Æö6´6öFRÇÂ&Æ—fU÷&VF–æW75ö6†ævVB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒÆö6¶VE&ö6W76–æp¢òÆö6¶VDW†V7WF–öä–çFVçBÓÓÒ&F—&V7B ¢ò$F—&V7BÕG&FR&ö6W76÷"ÆV6R÷"Æ—fR7FFR7F÷VBv†–ÆRVçG'’v—FVBf÷"FÖ—76–öâ ¢¢$6öææV7F–öâ&ö6W76–ær7F÷VBv†–ÆRVçG'’v—FVBf÷"FÖ—76–öâ ¢¢Æö6¶VE&VF–æW72æ&Æö6µ&V6öà¢Æ—fU÷6—F–öâç7FGW5&V6öâÐ¢W†6†ævR÷&FW"&Æö6¶VBgFW"FÖ—76–öâÆö6³¢G¶Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öçÖ ¢W6…7FW†Æ—fU÷6—F–öâÂ&VçG'•÷&÷FV7F–öåöFÖ—76–öâ"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5ö&Æö6¶VEö6÷VçB"¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢ÆWBVçG'”FÖ—76–öã¢VçG'•&÷FV7F–öäFÖ—76–öäFV6—6–öà¢G'’°¢VçG'”FÖ—76–öâÒv—BVF—DVçG'•&÷FV7F–öä&Vf÷&UfVçVT×WFF–öâ‡°¢6öææV7F–öä–BÀ¢6æF–FFT–C¢Æ—fU÷6—F–öâæ–BÀ¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢6öææV7F÷#¢W†6†ævT6öææV7F÷"À¢Ò¢Ò6F6‚†W'&÷"’°¢VçG'”FÖ—76–öâÒ°¢6fS¢fÇ6RÀ¢f–öÆF–öç3¢²&WF†÷&—FF—fUöFÖ—76–öå÷6æ6†÷E÷Væf–Æ&ÆR%ÒÀ¢VF—C¢°¢6fS¢fÇ6RÀ¢f–öÆF–öç3¢²&WF†÷&—FF—fUöFÖ—76–öå÷6æ6†÷E÷Væf–Æ&ÆR%ÒÀ¢÷væVD7F—fU&÷w3¢À¢÷væVDW†V7WFVE&÷w3¢À¢‡—6–6Å6Æ÷E&÷w3¢À¢7—7FVÕ6Æ÷EVçF—G“¢À¢fVçVU6Æ÷EVçF—G“¢À¢‡—6–6Å6Æ÷DÇ&VG”W†—7G3¢fÇ6RÀ¢&WV—&VDæWt6öçG&öÄ÷&FW'3¢2À¢ÒÀ¢ö'6W'fVD6öçG&öÄ÷&FW'3¢À¢f–Æ&ÆT6öçG&öÄ÷&FW'3¢À¢Ð¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡ÒVçG'’&÷FV7F–öâFÖ—76–öâ6æ6†÷Bf–ÆVC¢G¶W'&÷"–ç7Fæ6VöbW'&÷"òW'&÷"æÖW76vR¢7G&–ær†W'&÷"—ÖÀ¢¢Ð¢–b‚VçG'”FÖ—76–öâç6fR’°¢6öç7B6öFW2ÒVçG'”FÖ—76–öâçf–öÆF–öç2ç6Æ–6RƒÂ‚’æ¦ö–â‚"Â"¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ&&Æö6¶VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒ&VçG'•÷&÷FV7F–öåöFÖ—76–öåöf–ÆVB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒ6öFW2ÇÂ'&÷FV7F–öåö6öçG&7Eö–æ6ö×ÆWFR ¢Æ—fU÷6—F–öâç7FGW5&V6öâÐ¢W†6†ævR÷&FW"&Æö6¶VB&Vf÷&Rç’fVçVR×WFF–öã¢&÷FV7F–öâFÖ—76–öâf–ÆVB‚G¶6öFW2ÇÂ'Væ¶æ÷vâ'Ò– ¢Æ—fU÷6—F–öâæ6öçG&öÄ÷&FW$66—G’Ò°¢Æ–Ö—C¢—4&–æu„66—G”6öææV7F÷"†W†6†ævT6öææV7F÷"¢ò$”äu…ô4ôåE$ôÅôõ$DU%ôÄ”Ô•@¢¢çVÖ&W"äÔ…õ4dUô”åDTtU"À¢ö'6W'fVD÷Vã¢VçG'”FÖ—76–öâæö'6W'fVD6öçG&öÄ÷&FW'2À¢&W6W'fVC¢VçG'”FÖ—76–öâæVF—Bç&WV—&VDæWt6öçG&öÄ÷&FW'2À¢f–Æ&ÆS¢VçG'”FÖ—76–öâæf–Æ&ÆT6öçG&öÄ÷&FW'2À¢W††W7FVC¢VçG'”FÖ—76–öâæf–Æ&ÆT6öçG&öÄ÷&FW'2ÂVçG'”FÖ—76–öâæVF—Bç&WV—&VDæWt6öçG&öÄ÷&FW'2À¢Ð¢W6…7FW†Æ—fU÷6—F–öâÂ&VçG'•÷&÷FV7F–öåöFÖ—76–öâ"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B&öÖ—6RæÆÂ…°¢–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5ö&Æö6¶VEö6÷VçB"’À¢Æöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢'v&æ–ær"À¢Æ—fU÷6—F–öâç7FGW5&V6öâÀ¢°¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢f–öÆF–öç3¢VçG'”FÖ—76–öâçf–öÆF–öç2À¢÷væVE&÷w3¢VçG'”FÖ—76–öâæVF—Bæ÷væVDW†V7WFVE&÷w2À¢&WV—&VD6öçG&öÇ3¢VçG'”FÖ—76–öâæVF—Bç&WV—&VDæWt6öçG&öÄ÷&FW'2À¢f–Æ&ÆT6öçG&öÇ3¢VçG'”FÖ—76–öâæf–Æ&ÆT6öçG&öÄ÷&FW'2À¢ÒÀ¢’À¢Ò¢&WGW&âÆ—fU÷6—F–öà¢Ð¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢&VçG'•÷&÷FV7F–öåöFÖ—76–öâ"À¢G'VRÀ¢÷væVE&÷w3ÒG¶VçG'”FÖ—76–öâæVF—Bæ÷væVDW†V7WFVE&÷w7Ó²6öçG&öÇ4f–Æ&ÆSÒG¶VçG'”FÖ—76–öâæf–Æ&ÆT6öçG&öÄ÷&FW'7Ó²6öçG&öÇ5&W6W'fVCÒG¶VçG'”FÖ—76–öâæVF—Bç&WV—&VDæWt6öçG&öÄ÷&FW'7ÖÀ¢ ¢òòF†RFÖ—76–öâVF—B&÷fW2&÷FV7F–öâ÷væW'6†—Â'WB—BFöW2æ÷B&W6W'fP¢òòæ÷F–öæÂâF–ffW&VçBv÷&¶W"Ö’†fRf–ÆÆVBF†R6ÖR7–Ö&öÂöF—&V7F–öà¢òòv†–ÆRF†RVF—Bv2'Vææ–ærâ&Vg&W6‚F†RWF†÷&—FF—fRfVçVR÷6—F–öà¢òòVæFW"F†R6öææV7F–öâ×v–FRÆV6R–ÖÖVF–FVÇ’&Vf÷&RÖ&v–âöÆWfW&vR÷ ¢òòVçG'’7V&Ö—76–öâÂF†Vâ&÷VæBF÷vâöâF†RW†7BfVçVRVçF—G’w&–Bà¢òòF†—2—2F†Rf–æÂ&÷VæF'’v–ç7BF†R†–v‚×föÇVÖRƒ"f–ÇW&RÖöFRà¢–b‡&ö6W72æVçbääôDUôTåbÓÒ'FW7B"’°¢G'’°¢6öç7BW‡÷7W&T6öææV7F–öâÒ²ââæÆö6¶VE6WGF–æw2Â–C¢6öææV7F–öä–BÐ¢6öç7BfVçVTW‡÷7W&RÒv—B&W6öÇfTÆ—fT÷&FW$W‡÷7W&T6V–Æ–ær€¢°¢6öææV7F–öä–BÀ¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢6–FS¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢÷6—F–öäF—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢VçF—G“¢6ö×WFVEföÇVÖRÀ¢6öææV7F–öã¢W‡÷7W&T6öææV7F–öâÀ¢Ö&¶WEG—S¢Æ—fU÷6—F–öâæÖ&¶WEG—RÀ¢Æ÷E6—¦S¢Æ—fU÷6—F–öâæÆ÷E6—¦RÀ¢V÷FUFõW6E&FS¢Æ—fU÷6—F–öâçV÷FUFõW6E&FRÀ¢÷6—F–öä6÷7EW&6VçD÷fW'&–FS¢Æ—fU÷6—F–öâç÷6—F–öä6÷7E7BÀ¢Ö„W†V7WF–öäæ÷F–öæÅW6BÀ¢6÷W&6S¢W†V7WF–öä–çFVçBÓÓÒ&F—&V7B ¢ò&F—&V7B×G&FR ¢¢W†V7WF–öä–çFVçBÓÓÒ'&W6WB ¢ò'&W6WB×G&FR ¢¢W†V7WF–öä–çFVçBÓÓÒ'6–væÂ ¢ò'6–væÂ×G&FR ¢¢&Ö–â×G&FR"À¢Æ—fUG&FT–çFVçC¢W†V7WF–öä–çFVçBÀ¢Ò2ç’À¢W‡÷7W&T6öææV7F–öâÀ¢W†6†ævT6öææV7F÷"À¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢7W'&VçE&–6RÀ¢¢6öç7B&÷VæFVBÒVçF—G•v—F†–å&VÖ–æ–ætæ÷F–öæÂ€¢Æ—fU÷6—F–öâÀ¢6ö×WFVEföÇVÖRÀ¢7W'&VçE&–6RÀ¢Æ—fT–ç7G'VÖVçE'VÆW2À¢fVçVTW‡÷7W&RæÖ„æ÷F–öæÅW6BÀ¢¢–b‚†&÷VæFVBçVçF—G’â’’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ&&Æö6¶VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒ&Æ—fUöW‡÷7W&Uö6V–Æ–æu÷&V6†VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒ%&VÖ–æ–ærfVçVR÷6—F–öä6÷7B'VFvWB—2&VÆ÷rF†RW†V7WF&ÆRVçF—G’Ö–æ–×VÒ ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒÆ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öà¢W6…7FW†Æ—fU÷6—F–öâÂ&Æ—fUöW‡÷7W&UöFÖ—76–öâ"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5ö&Æö6¶VEö6÷VçB"¢&WGW&âÆ—fU÷6—F–öà¢Ð¢Æ—fU7V&Ö—76–öäæ÷F–öæÄ6V–Æ–ærÒfVçVTW‡÷7W&RæÖ„æ÷F–öæÅW6@¢–b†&÷VæFVBçVçF—G’²RÓ"Â6ö×WFVEföÇVÖR’°¢6ö×WFVEföÇVÖRÒ&÷VæFVBçVçF—G¢föÇVÖTæ÷FRÒ·fVçVRÖ†VG&ööÓ¢G¶&÷VæFVBææ÷F–öæÅW6BçFôf—†VBƒ"—ÒU4EÖ ¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢&Æ—fUöW‡÷7W&UöFÖ—76–öâ"À¢G'VRÀ¢fVçVRÖ6öæf—&ÖVB&VÖ–æ–æsÒG·fVçVTW‡÷7W&RæÖ„æ÷F–öæÅW6BçFôf—†VBƒ"—ÒU4C²G’&VGV6VBFòG¶6ö×WFVEföÇVÖWÖÀ¢¢ÒVÇ6R°¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢&Æ—fUöW‡÷7W&UöFÖ—76–öâ"À¢G'VRÀ¢fVçVRÖ6öæf—&ÖVB&VÖ–æ–æsÒG·fVçVTW‡÷7W&RæÖ„æ÷F–öæÅW6BçFôf—†VBƒ"—ÒU4C²G“ÒG¶6ö×WFVEföÇVÖWÖÀ¢¢Ð¢Æ—fU÷6—F–öâçVçF—G’Ò6ö×WFVEföÇVÖP¢Æ—fU÷6—F–öâç&VÖ–æ–æuVçF—G’Ò6ö×WFVEföÇVÖP¢Æ—fU÷6—F–öâçföÇVÖUW6BÒ÷6—F–öäæ÷F–öæÅW6B†Æ—fU÷6—F–öâÂ6ö×WFVEföÇVÖRÂ7W'&VçE&–6R¢Ò6F6‚†W'&÷"’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâæW†V7WF–öäÖöFRÒ&&Æö6¶VB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒ&Æ—fUöW‡÷7W&U÷6æ6†÷E÷Væf–Æ&ÆR ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒW'&÷"–ç7Fæ6VöbW'&÷ ¢òW'&÷"æÖW76vP¢¢$WF†÷&—FF—fRfVçVRW‡÷7W&R6æ6†÷BVæf–Æ&ÆR ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒÆ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öà¢W6…7FW†Æ—fU÷6—F–öâÂ&Æ—fUöW‡÷7W&UöFÖ—76–öâ"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5ö&Æö6¶VEö6÷VçB"¢&WGW&âÆ—fU÷6—F–öà¢Ð¢Ð ¢6öç7B÷6—F–öäÖöFRÒ7G&–ær€¢†Æö6¶VE6WGF–æw22ç’’ç÷6—F–öåöÖöFP¢ÇÂ†Æö6¶VE6WGF–æw22ç’’ç÷6—F–öäÖöFP¢ÇÂ""À¢’çFôÆ÷vW$66R‚¢6öç7B†VFvTÖöFRÒ÷6—F–öäÖöFRæ–æ6ÇVFW2‚&†VFvR"’ÇÂ÷6—F–öäÖöFRæ–æ6ÇVFW2‚&GVÂ"¢6öç7BæF—fTf÷&W…&÷FV7F–öâÒ‚‚’Óâ°¢–b†Æ—fU÷6—F–öâæÖ&¶WEG—RÓÒ&f÷&W‚"ÇÂG—VöbW†6†ævT6öææV7F÷#òævWD6&–Æ—F–W2ÓÒ&gVæ7F–öâ"’&WGW&â·Ð¢G'’°¢6öç7B6&–Æ—F–W2ÒW†6†ævT6öææV7F÷"ævWD6&–Æ—F–W2‚¢–b‚'&’æ—4'&’†6&–Æ—F–W2’ÇÂ6&–Æ—F–W2æ–æ6ÇVFW2‚&æF—fU÷÷6—F–öå÷6Å÷G"’’&WGW&â·Ð¢6öç7B–æ—F–ÂÒ6ö×WFTFW6—&VE&÷FV7F–öå&–6W2†Æ—fU÷6—F–öâ¢6öç7BF—&V7F–öâÒ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ†Æ—fU÷6—F–öâ¢6öç7B6ÂÒæ÷&ÖÆ—¦U&÷FV7F–öåG&–vvW%&–6R€¢–æ—F–ÂæFW6—&VE6ÂÀ¢çVÖ&W"†Æ—fU÷6—F–öâç&–6UF–6²ÇÂ’À¢F—&V7F–öâÀ¢'7F÷öÆ÷72"À¢¢6öç7BGÒæ÷&ÖÆ—¦U&÷FV7F–öåG&–vvW%&–6R€¢–æ—F–ÂæFW6—&VEGÀ¢çVÖ&W"†Æ—fU÷6—F–öâç&–6UF–6²ÇÂ’À¢F—&V7F–öâÀ¢'F¶U÷&öf—B"À¢¢&WGW&â°¢âââ‡6Ââò²7F÷Æ÷75&–6S¢6ÂÒ¢·Ò’À¢âââ‡Gâò²F¶U&öf—E&–6S¢GÒ¢·Ò’À¢Ð¢Ò6F6‚°¢&WGW&â·Ð¢Ð¢Ò’‚¢6öç7BVçG'”÷&FW$÷F–öç2Ò†VFvTÖöFP¢ò°¢†VFvTÖöFS¢G'VRÀ¢÷6—F–öå6–FS¢‡&VÅ÷6—F–öâæF—&V7F–öâÓÓÒ&Æöær"ò$Äôär"¢%4„õ%B"’2$Äôär"Â%4„õ%B"À¢6Æ–VçD÷&FW$–C¢÷&FW%G&6RæW†6†ævUG&6¶–æt–BÀ¢ââææF—fTf÷&W…&÷FV7F–öâÀ¢Ð¢¢°¢†VFvTÖöFS¢fÇ6RÀ¢6Æ–VçD÷&FW$–C¢÷&FW%G&6RæW†6†ævUG&6¶–æt–BÀ¢ââææF—fTf÷&W…&÷FV7F–öâÀ¢Ð ¢òòÖ&v–âöÆWfW&vR&R‡—6–6Â×6Æ÷BfVçVR×WFF–öç2âF†W’&VÆöærgFW ¢òòW†7B÷væW'6†—Â6öçG&öÂ6÷fW&vRÂ66—G’ÂæB7F÷VBÖVæv–æRvFW2à¢6öç7BÖ&v–åG—U6WGF–ærÒ€¢†Æö6¶VE6WGF–æw22ç’’æÖ&v–å÷G—R2&7&÷72"Â&—6öÆFVB ¢’ÇÂ&7&÷72 ¢Æ—fU÷6—F–öâæÖ&v–åG—RÒÖ&v–åG—U6WGF–æp¢G'’°¢6öç7B6öæf–wW&VBÒv—B6WGWÆ—fT÷&FW$Ö&v–äæDÆWfW&vR€¢W†6†ævT6öææV7F÷"À¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢²Ö&v–åG—S¢Ö&v–åG—U6WGF–ærÂÆWfW&vS¢Æ—fU÷6—F–öâæÆWfW&vRÒÀ¢¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢'6WEöÖ&v–å÷G—R"À¢G'VRÀ¢6öæf–wW&VBæÖ&v–ä6öæf–wW&VBòÖ&v–ãÒG¶6öæf–wW&VBæÖ&v–åG—WÖ¢&6öææV7F÷"†2æòÖ&v–âÖÖöFRVæGö–çB"À¢¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢'6WEöÆWfW&vR"À¢G'VRÀ¢6öæf–wW&VBæÆWfW&vT6öæf–wW&VBòÆWfW&vSÒG¶Æ—fU÷6—F–öâæÆWfW&vWÖ¢&ÆWfW&vSÓ÷"6öææV7F÷"†2æòÆWfW&vRVæGö–çB"À¢¢Ò6F6‚†W'&÷"’°¢6öç7B&V6öâÒW'&÷"–ç7Fæ6VöbW'&÷"òW'&÷"æÖW76vR¢7G&–ær†W'&÷"¢Æ—fU÷6—F–öâç7FGW2Ò&W'&÷" ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒW†6†ævRVçG'’&VfÆ–v‡Bf–ÆVB&Vf÷&RÆ6VÖVçC¢G·&V6öçÖ ¢W6…7FW†Æ—fU÷6—F–öâÂ'6WEöÖ&v–å÷G—R"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢W6…7FW†Æ—fU÷6—F–öâÂ'6WEöÆWfW&vR"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B&öÖ—6RæÆÂ…°¢&V6÷&DW†V7WF–öå&VfÆ–v‡Df–ÇW&R‚’À¢Æöu&öw&W76–öäWfVçB†6öææV7F–öä–BÂ&Æ—fU÷G&F–ær"Â&W'&÷""ÂÆ—fU÷6—F–öâç7FGW5&V6öâÂ°¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢Ö&v–åG—S¢Ö&v–åG—U6WGF–ærÀ¢ÆWfW&vS¢Æ—fU÷6—F–öâæÆWfW&vRÀ¢Ò’À¢Ò¢&WGW&âÆ—fU÷6—F–öà¢Ð¢–b†v—B&÷'E7WW'6VFVB‚’’&WGW&âÆ—fU÷6—F–öà ¢òòW'6—7BF†R–FV×÷FVæ7’¶W’&Vf÷&RF†R&WVW7B6âÆVfRF†—2&ö6W72à¢òò7&6‚÷"&W7öç6RF–ÖV÷WB6âF†W&Vf÷&R&V6÷fW"F†RW†7BfVçVR÷&FW ¢òò'’6Æ–VçD÷&FW$–B–ç7FVBöb7V&Ö—GF–ærGWÆ–6FRVçG'’à¢Æ—fU÷6—F–öâç7V&Ö—76–öå7FFRÒ'&W&VB ¢VæD6Æ–VçD÷&FW%G&6¶–ær†Æ—fU÷6—F–öâÂ÷&FW%G&6RæW†6†ævUG&6¶–æt–BÂ&VçG'’"Â°¢VçF—G“¢6ö×WFVEföÇVÖRÀ¢6–FS¢W†6†ævU6–FRÀ¢Ò¢W6…7FW†Æ—fU÷6—F–öâÂ&VçG'•÷7V&Ö—76–öå÷&W&VB"ÂG'VRÂ6Æ–VçD÷&FW$–CÒG¶÷&FW%G&6RæW†6†ævUG&6¶–æt–GÖ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—BW'6—7D7&—F–6ÄÆ—fU7FFR†VçG'“¢G¶Æ—fU÷6—F–öâæ–GÖ¢–b†v—B&÷'E7WW'6VFVB‚’’°¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ’æ6F6‚‚‚’Óâ·Ò¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢òò7G&öærF–væ÷7F–2Æör&–v‡B&Vf÷&R&VÂÖöæW’÷&FW"GFV×@¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Òµ$TÅôõ$DU%ôEDTÕEÒ6öæãÒG¶6öææV7F–öä–GÒ7–ÓÒG·&VÅ÷6—F–öâç7–Ö&öÇÒF—#ÒG·&VÅ÷6—F–öâæF—&V7F–öçÒ°¢6ö×WFVEföÃÒG¶6ö×WFVEföÇVÖWÒ&–6SÒG¶7W'&VçE&–6WÒÆWcÒG¶Æ—fU÷6—F–öâæÆWfW&vWÒ°¢6WD¶W“ÒG¶Æ—fU÷6—F–öâç6WD¶W—ÒG&6SÒG¶÷&FW%G&6RçG&6T–GÖ ¢ ¢òòF†R&WG'’‚–†VÇW"&WVG2WFò<9röâG&ç6–VçBf–ÇW&W3²vP¢òòVÖ—B$Rõõ5BW"EDTÕB6òF†RÆör6†÷w2V6‚&÷VæB×G&—âF†P¢òòGFV×B6÷VçFW"—26GW&VB'’6Æ÷7W&R6òÆWfW&vR×&VGV6VBæ@¢òòÖ–â×6—¦RÖ6÷'&V7FVB&WG&–W2&VÆ÷rvWBF—7F–æ7BÆ&VÇ2à¢ÆWBÆ7E7V&Ö—GFVDVçG'•VçF—G’Ò6ö×WFVEföÇVÖP¢6öç7B7V&Ö—DVçG'•VçF—G’Ò7–æ2‡&WVW7FVEVçF—G“¢çVÖ&W"ÂÆ&VÃ¢7G&–ær“¢&öÖ—6SÆç“âÓâ°¢–b‚v—B—47W'&VçB‚’’°¢&WGW&â°¢7V66W73¢fÇ6RÀ¢W'&÷#¢$W†V7WF–öâvVæW&F–öâ7WW'6VFVB&Vf÷&RW†6†ævR7V&Ö—76–öâ"À¢W'&÷$6öFS¢$U„T5UD”ôåõ5UU%4TDTB"À¢Ð¢Ð¢ÆWB6fUVçF—G’ÒçVÖ&W"‡&WVW7FVEVçF—G’¢–b‡&ö6W72æVçbääôDUôTåbÓÒ'FW7B"’°¢6öç7BW‡÷7W&T6öææV7F–öâÒ²ââæÆö6¶VE6WGF–æw2Â–C¢6öææV7F–öä–BÐ¢6öç7BfVçVTW‡÷7W&RÒv—B&W6öÇfTÆ—fT÷&FW$W‡÷7W&T6V–Æ–ær€¢°¢6öææV7F–öä–BÀ¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢6–FS¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢÷6—F–öäF—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢VçF—G“¢&WVW7FVEVçF—G’À¢6öææV7F–öã¢W‡÷7W&T6öææV7F–öâÀ¢Ö&¶WEG—S¢Æ—fU÷6—F–öâæÖ&¶WEG—RÀ¢Æ÷E6—¦S¢Æ—fU÷6—F–öâæÆ÷E6—¦RÀ¢V÷FUFõW6E&FS¢Æ—fU÷6—F–öâçV÷FUFõW6E&FRÀ¢÷6—F–öä6÷7EW&6VçD÷fW'&–FS¢Æ—fU÷6—F–öâç÷6—F–öä6÷7E7BÀ¢Ö„W†V7WF–öäæ÷F–öæÅW6BÀ¢6÷W&6S¢W†V7WF–öä–çFVçBÓÓÒ&F—&V7B ¢ò&F—&V7B×G&FR ¢¢W†V7WF–öä–çFVçBÓÓÒ'&W6WB ¢ò'&W6WB×G&FR ¢¢W†V7WF–öä–çFVçBÓÓÒ'6–væÂ ¢ò'6–væÂ×G&FR ¢¢&Ö–â×G&FR"À¢Æ—fUG&FT–çFVçC¢W†V7WF–öä–çFVçBÀ¢Ò2ç’À¢W‡÷7W&T6öææV7F–öâÀ¢W†6†ævT6öææV7F÷"À¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢7W'&VçE&–6RÀ¢¢6öç7B&÷VæFVBÒVçF—G•v—F†–å&VÖ–æ–ætæ÷F–öæÂ€¢Æ—fU÷6—F–öâÀ¢&WVW7FVEVçF—G’À¢7W'&VçE&–6RÀ¢Æ—fT–ç7G'VÖVçE'VÆW2À¢fVçVTW‡÷7W&RæÖ„æ÷F–öæÅW6BÀ¢¢–b‚†&÷VæFVBçVçF—G’â’’°¢F‡&÷ræWrW'&÷"€¢Ä•dUôU…õ5U$S¢&WVW7FVBVçG'’VçF—G’æòÆöævW"f—G2F†RfVçVR÷6—F–öä6÷7B'VFvWB‡&VÖ–æ–æsÒG·fVçVTW‡÷7W&RæÖ„æ÷F–öæÅW6BçFôf—†VBƒ"—ÒU4B–À¢¢Ð¢6fUVçF—G’Ò&÷VæFVBçVçF—G¢Æ—fU7V&Ö—76–öäæ÷F–öæÄ6V–Æ–ærÒfVçVTW‡÷7W&RæÖ„æ÷F–öæÅW6@¢Ð¢–b‚‡6fUVçF—G’â’ÇÂçVÖ&W"æ—4f–æ—FR‡6fUVçF—G’’’°¢F‡&÷ræWrW'&÷"‚$Ä•dUôU…õ5U$S¢æòf–æ—FRW†V7WF&ÆRVçG'’VçF—G’&VÖ–ç2"¢Ð¢Æ7E7V&Ö—GFVDVçG'•VçF—G’Ò6fUVçF—G¢–b‡6fUVçF—G’ÓÒ&WVW7FVEVçF—G’’°¢Æ—fU÷6—F–öâçVçF—G’Ò6fUVçF—G¢Æ—fU÷6—F–öâç&VÖ–æ–æuVçF—G’Ò6fUVçF—G¢Æ—fU÷6—F–öâçföÇVÖUW6BÒ÷6—F–öäæ÷F–öæÅW6B†Æ—fU÷6—F–öâÂ6fUVçF—G’Â7W'&VçE&–6R¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢&Æ—fUöW‡÷7W&U÷&WG'•ö6"À¢G'VRÀ¢G¶Æ&VÇÓ¢fVçVRÖ6öæf—&ÖVBVçF—G’G·&WVW7FVEVçF—G—Ò(i"G·6fUVçF—G—ÖÀ¢¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—BW'6—7D7&—F–6ÄÆ—fU7FFR†VçG'’×VçF—G“¢G¶Æ—fU÷6—F–öâæ–GÖ¢Ð¢Æ6TGFV×B³Ò¢6öç7B²&rÒÒv—Bv—F„Æ—fT÷&FW$Æövv–ær€¢÷&FW%G&6RÀ¢°¢VçF—G“¢6fUVçF—G’À¢&–6S¢7W'&VçE&–6RÀ¢ÆWfW&vS¢Æ—fU÷6—F–öâæÆWfW&vRÀ¢Ö&v–åG—S¢Æ—fU÷6—F–öâæÖ&v–åG—Róò'Væ¶æ÷vâ"À¢÷&FW%G—S¢&Ö&¶WB"À¢÷F–öç3¢VçG'”÷&FW$÷F–öç2À¢7G&FVw•6WD¶W“¢Æ—fU÷6—F–öâç6WD¶W’À¢&VÅ÷6—F–öä–C¢&VÅ÷6—F–öâæ–BÀ¢GFV×C¢Æ6TGFV×BÀ¢Æ&VÂÀ¢ÒÀ¢7–æ2‚’Óâ°¢–b‚v—B—47W'&VçB‚’’°¢&WGW&â°¢7V66W73¢fÇ6RÀ¢W'&÷#¢$W†V7WF–öâvVæW&F–öâ7WW'6VFVB&Vf÷&RW†6†ævR7V&Ö—76–öâ"À¢W'&÷$6öFS¢$U„T5UD”ôåõ5UU%4TDTB"À¢Ð¢Ð¢v—B76W'DÖ&v–ä6ÆÄVçG'”ÆÆ÷vVB†6öææV7F–öä–BÂW†6†ævT6öææV7F÷"¢W†6†ævU7V&Ö—76–öå7F'FVBÒG'VP¢&WGW&âW†6†ævT6öææV7F÷"çÆ6T÷&FW"€¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢W†6†ævU6–FRÀ¢6fUVçF—G’À¢VæFVf–æVBÀ¢&Ö&¶WB"À¢VçG'”÷&FW$÷F–öç2À¢¢ÒÀ¢¢&WGW&â&p¢Ð¢ÆWB÷&FW%&W7VÇC¢ç’Òv—B&WG'’€¢‚’Óâ7V&Ö—DVçG'•VçF—G’†6ö×WFVEföÇVÖRÂ'&–Ö'’"’À¢‡#¢ç’’Óâ#òç7V66W72À¢'Æ6T÷&FW""À¢2À¢—47W'&VçBÀ¢¢–b†v—B&÷'E7WW'6VFVB‚’’°¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ’æ6F6‚‚‚’Óâ·Ò¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢òò)H)HföÇVÖR&VGV7F–öâöâ#B„–ç7Vff–6–VçBÖ&v–â’)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òòÆWfW&vR—2¶WBB—G2Ö†–×VÒfÇVR(	BæWfW"&VGV6VBâv†VâF†P¢òòW†6†ævR&V¦V7G2v—F‚$–ç7Vff–6–VçBÖ&v–â"vR–ç7FVB†ÇfRF†P¢òò÷6—F–öâföÇVÖRæB&WG'’ôä4RBF†R6ÖRÆWfW&vRâ†Çf–ærföÇVÖP¢òò†ÇfW2F†R&WV—&VBÖ&v–âv†–ÆR¶VW–ærF†RÆWfW&vR×VÇF—Æ–W ¢òò†æBF†W&Vf÷&RF†RW"×Væ—Bæ÷F–öæÂv–â’–çF7Bâ–bF†R†ÇfV@¢òòföÇVÖR7F–ÆÂf–Ç2ÂvRfÆÂ&6²FòF†RW†6†ævRÖ–æ–×VÒVçF—G’@¢òòF†R6ÖRÆWfW&vRÂv†–6‚&W&W6VçG2F†R'6öÇWFR6ÖÆÆW7Bæ÷F–öæÀ¢òòv—F‚F†R&W7BÆWfW&vRVff–6–Væ7’à¢–b†v—B—47W'&VçB‚’bb÷&FW%&W7VÇCòç7V66W72bb—4æöå&V6÷fW&&ÆTW†6†ævTW'&÷"†÷&FW%&W7VÇB’’°¢6öç7B&VGV6VEföÇVÖU&rÒ6ö×WFVEföÇVÖRò ¢6öç7B&VGV6VEföÇVÖRÒæ÷&ÖÆ—¦U&WG'”VçG'•VçF—G’‡&VGV6VEföÇVÖU&rÂfÇ6R¢òòVç7W&RF†R†ÇfVBföÇVÖR—2ÖVæ–ævgVÆÇ’6ÖÆÆW"ƒâãRF–fb’æB÷6—F—fRà¢6öç7BföÇVÖTF–fe7BÒ6ö×WFVEföÇVÖRâòÖF‚æ'2‡&VGV6VEföÇVÖRÒ6ö×WFVEföÇVÖR’ò6ö×WFVEföÇVÖR¢ ¢–b‡&VGV6VEföÇVÖRâbbföÇVÖTF–fe7Bâã’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò#BöâG·&VÅ÷6—F–öâç7–Ö&öÇÒ(	B&WG'––ærv—F‚†ÇfVBföÇVÖR°¢G¶6ö×WFVEföÇVÖRçFôf—†VBƒb—Ò(i"G·&VGV6VEföÇVÖRçFôf—†VBƒb—Ò†ÆWfW&vR¶WBBG¶Æ—fU÷6—F–öâæÆWfW&vW×‚–À¢ ¢6öç7B&WG'•&W7VÇC¢ç’Òv—B&WG'’€¢‚’Óâ7V&Ö—DVçG'•VçF—G’‡&VGV6VEföÇVÖRÂ'föÇVÖRÖ†ÇfVB"’À¢‡#¢ç’’Óâ#òç7V66W72bb‡"æ÷&FW$–BÇÂ"æ–B’À¢'Æ6T÷&FW"×&VGV6VEföÂ"À¢Âòò6–ævÆR&WG'’(	BvRÇ&VG’G&–VB<9r&÷fRB÷&–v–æÂföÇVÖP¢—47W'&VçBÀ¢¢–b†v—B&÷'E7WW'6VFVB‚’’°¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ’æ6F6‚‚‚’Óâ·Ò¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢–b‡&WG'•&W7VÇCòç7V66W72bb‡&WG'•&W7VÇBæ÷&FW$–BÇÂ&WG'•&W7VÇBæ–B’’°¢òò7V66VVFVBv—F‚&VGV6VBföÇVÖRBÖ‚ÆWfW&vR(	BWFFR÷6—F–öâæB6öçF–çVRà¢6ö×WFVEföÇVÖRÒÆ7E7V&Ö—GFVDVçG'•VçF—G¢Æ—fU÷6—F–öâçVçF—G’ÒÆ7E7V&Ö—GFVDVçG'•VçF—G¢Æ—fU÷6—F–öâç&VÖ–æ–æuVçF—G’ÒÆ7E7V&Ö—GFVDVçG'•VçF—G¢Æ—fU÷6—F–öâçföÇVÖUW6BÒ÷6—F–öäæ÷F–öæÅW6B†Æ—fU÷6—F–öâÂÆ7E7V&Ö—GFVDVçG'•VçF—G’Â7W'&VçE&–6R¢÷&FW%&W7VÇBÒ&WG'•&W7VÇ@¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡ÒVçG'’7V66VVFVBgFW"föÇVÖR&VGV7F–öâFòG¶Æ7E7V&Ö—GFVDVçG'•VçF—G’çFôf—†VBƒb—ÒBG¶Æ—fU÷6—F–öâæÆWfW&vW×‚f÷"G·&VÅ÷6—F–öâç7–Ö&öÇÖÀ¢¢ÒVÇ6R–b†—4æöå&V6÷fW&&ÆTW†6†ævTW'&÷"‡&WG'•&W7VÇB’’°¢òò&÷F‚F†R÷&–v–æÂæB†ÇfVB×föÇVÖRGFV×G2f–ÆVBv—F‚#Bà¢òòG'’öæRÆ7BF–ÖRBF†RW†6†ævRÖ–æ–×VÒG’(	B7F–ÆÂBÖ‚ÆWfW&vRà¢òò&VfW"F†R7F÷&VBW†6†ævRÖ–æ–×VÒg&öÒF†RC†æFÆW ¢òò†6WGF–æw3§G&F–æu÷—#§·7–×Ö(i"Ö–åö÷&FW%÷6—¦V’âfÆÂ&6²FòCR÷&–6Rà¢ÆWBÖ–åG”f÷%7–Ö&öÂÒÆ—fU÷6—F–öâæÖ&¶WEG—RÓÓÒ&f÷&W‚ ¢ò&÷VæEVçF—G•W€¢ÖF‚æÖ‚†Æ—fT–ç7G'VÖVçE'VÆW2æÖ–åVçF—G’ÂÆ—fT–ç7G'VÖVçE'VÆW2çVçF—G•7FW’À¢Æ—fT–ç7G'VÖVçE'VÆW2À¢¢¢7W'&VçE&–6Râ ¢òRò7W'&VçE&–6P¢¢ ¢G'’°¢6öç7B&VF—46Æ–VçBÒvWE&VF—46Æ–VçB‚¢–b‡&VF—46Æ–VçB’°¢6öç7B7F÷&VDÖ–âÒv—B&VF—46Æ–VçBæ†vWB€¢G&F–æu—$¶W’‡&VÅ÷6—F–öâç7–Ö&öÂÂ6öææV7F–öä–B’À¢&Ö–åö÷&FW%÷6—¦R"À¢¢6öç7B'6VE7F÷&VDÖ–âÒ7F÷&VDÖ–âò'6TfÆöB‡7F÷&VDÖ–â’¢ ¢–b‡'6VE7F÷&VDÖ–ââ’°¢Ö–åG”f÷%7–Ö&öÂÒÆ—fU÷6—F–öâæÖ&¶WEG—RÓÓÒ&f÷&W‚ ¢ò&÷VæEVçF—G•W‡'6VE7F÷&VDÖ–âÂÆ—fT–ç7G'VÖVçE'VÆW2¢¢'6VE7F÷&VDÖ–à¢Ð¢Ð¢Ò6F6‚²ò¢æöâÖ7&—F–6Ã²fÆÂ&6²FòCR÷&–6R¢òÐ ¢òòâW†6†ævRÖ–æ–×VÒ×W7Bæ÷B&RW6VB2âWv&B÷fW'&–FRöbF†P¢òò&÷fVBÆ—fRõe5Bæ÷F–öæÂ6V–Æ–ærgFW"Ö&v–â&V¦V7F–öâà¢Ö–åG”f÷%7–Ö&öÂÒæ÷&ÖÆ—¦U&WG'”VçG'•VçF—G’†Ö–åG”f÷%7–Ö&öÂÂG'VR ¢òòöæÇ’GFV×B–bF†RVçF—G’—2ÖVæ–ævgVÆÇ’F–ffW&VçBg&öÒv†BvRÇ&VG’G&–VBà¢6öç7BÖ–åVçF—G”F–fe7BÒ&VGV6VEföÇVÖRâ ¢òÖF‚æ'2†Ö–åG”f÷%7–Ö&öÂÒ&VGV6VEföÇVÖR’ò&VGV6VEföÇVÖP¢¢¢–b†v—B—47W'&VçB‚’bbÖ–åG”f÷%7–Ö&öÂâbbÖ–åVçF—G”F–fe7Bâã’°¢–b†v—B&÷'E7WW'6VFVB‚’’°¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ’æ6F6‚‚‚’Óâ·Ò¢&WGW&âÆ—fU÷6—F–öà¢Ð¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò#BB†Æb×föÇVÖR7F–ÆÂf–Ç2öâG·&VÅ÷6—F–öâç7–Ö&öÇÒ(	B°¢G'––ærÖ–âæ÷F–öæÂG“ÒG¶Ö–åG”f÷%7–Ö&öÂçFôf—†VBƒ‚—ÒBG¶Æ—fU÷6—F–öâæÆWfW&vW×‚†Ö‚ÆWfW&vR¶WB–À¢¢ÆWBÖ–å&W7VÇC¢ç¢G'’°¢Ö–å&W7VÇBÒv—B7V&Ö—DVçG'•VçF—G’†Ö–åG”f÷%7–Ö&öÂÂ&Ö–âÖæ÷F–öæÂÖÖ‚ÖÆWb"¢Ò6F6‚†W'&÷"’°¢Ö–å&W7VÇBÒ°¢7V66W73¢fÇ6RÀ¢W'&÷#¢W'&÷"–ç7Fæ6VöbW'&÷"òW'&÷"æÖW76vR¢7G&–ær†W'&÷"’À¢W'&÷$6öFS¢$Ä•dUôU…õ5U$Uõ$T4„T4µôd”ÄTB"À¢Ð¢Ð¢–b†Ö–å&W7VÇCòç7V66W72bb†Ö–å&W7VÇBæ÷&FW$–BÇÂÖ–å&W7VÇBæ–B’’°¢6ö×WFVEföÇVÖRÒÆ7E7V&Ö—GFVDVçG'•VçF—G¢Æ—fU÷6—F–öâçVçF—G’ÒÆ7E7V&Ö—GFVDVçG'•VçF—G¢Æ—fU÷6—F–öâç&VÖ–æ–æuVçF—G’ÒÆ7E7V&Ö—GFVDVçG'•VçF—G¢Æ—fU÷6—F–öâçföÇVÖUW6BÒ÷6—F–öäæ÷F–öæÅW6B†Æ—fU÷6—F–öâÂÆ7E7V&Ö—GFVDVçG'•VçF—G’Â7W'&VçE&–6R¢÷&FW%&W7VÇBÒÖ–å&W7VÇ@¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡ÒVçG'’7V66VVFVBBÖ–âÖæ÷F–öæÂG¶Æ7E7V&Ö—GFVDVçG'•VçF—G’çFôf—†VBƒ‚—ÒBG¶Æ—fU÷6—F–öâæÆWfW&vW×‚f÷"G·&VÅ÷6—F–öâç7–Ö&öÇÖÀ¢¢ÒVÇ6R°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò#BBÖ–âÖæ÷F–öæÂÇ6òf–ÆVBf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÒ(	B&V6÷&F–ærÖ&v–âW'&÷&À¢¢&V6÷&DÖ&v–äW'&÷"†6öææV7F–öä–B¢÷&FW%&W7VÇBÒÖ–å&W7VÇBóò&WG'•&W7VÇBóò÷&FW%&W7VÇ@¢Ð¢ÒVÇ6R°¢òòG’v÷VÆB&RF†R6ÖR2&Vf÷&R(	Bæòö–çB&WG'––ærà¢&V6÷&DÖ&v–äW'&÷"†6öææV7F–öä–B¢÷&FW%&W7VÇBÒ&WG'•&W7VÇBóò÷&FW%&W7VÇ@¢Ð¢ÒVÇ6R°¢òòæöâÖÖ&v–âf–ÇW&RgFW"föÇVÖR&VGV7F–öâ(	Bv—fRWæ÷&ÖÆÇ’à¢&V6÷&DÖ&v–äW'&÷"†6öææV7F–öä–B¢÷&FW%&W7VÇBÒ&WG'•&W7VÇBóò÷&FW%&W7VÇ@¢Ð¢ÒVÇ6R°¢òòföÇVÖRÇ&VG’BÖ–æ–×VÒ(	B6ææ÷B&VGV6RgW'F†W"v—F†÷WBvö–ær&VÆ÷rW†6†ævRÖ–æ–×VÒà¢&V6÷&DÖ&v–äW'&÷"†6öææV7F–öä–B¢Ð¢Ð ¢òò)H)HW†6†ævR6—&7V—BÖ'&V¶W"ƒ“C’FWFV7F–öâ)H)H)H)HûûÞûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òò6öFR“CÒW†6†ævRFV×÷&&–Ç’†ÇFVB’G&F–ærf÷"F†—0¢òò7–Ö&öÂGVRFòföÆF–Æ—G’âF†—2—2äõBÖ&v–â—77VR(	B&V6÷&B¢òòW"×7–Ö&öÂ6—&7V—BÖ'&V¶W"æBÆWBF†R6öææV7F–öâ6öçF–çVRÆ6–æp¢òò÷&FW'2öâ÷F†W"7–Ö&öÇ2v—F†÷WBG&–vvW&–ærF†RÖ&v–â6ööÆF÷vâà¢–b‚÷&FW%&W7VÇCòç7V66W72bb—46—&7V—D'&V¶W$W'&÷"†÷&FW%&W7VÇB’’°¢&V6÷&D6—&7V—D'&V¶W"‡&VÅ÷6—F–öâç7–Ö&öÂ¢Æ—fU÷6—F–öâç7FGW2Ò&W'&÷" ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒW†6†ævR6—&7V—B'&V¶W"7F—fRf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÒ(	B&WG'––ær–âÃVÖ–æ ¢W6…7FW†Æ—fU÷6—F–öâÂ'Æ6Uö÷&FW""ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5öf–ÆVEö6÷VçB"¢v—B–æ7&VÖVçDW†V7WF–öä÷&FW'4'•7–Ö&öÂ‚&VÅ÷6—F–öâç7–Ö&öÂÂ&VÅ÷6—F–öâæF—&V7F–öâÂ&f–ÆVB"¢v—BÆöu&öw&W76–öäWfVçB†6öææV7F–öä–BÂ&Æ—fU÷G&F–ær"Â'v&æ–ær"ÂÆ—fU÷6—F–öâç7FGW5&V6öâÂ°¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢W'&÷#¢÷&FW%&W7VÇCòæW'&÷"À¢Ò¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’v—B&VÆV6TÆö6²†6öææV7F–öä–BÂ&VÅ÷6—F–öâç7–Ö&öÂÂ&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚ÂÆ—fT÷&FW$Æö6µFö¶Vâ’æ6F6‚‚‚’Óâ·Ò¢v—BÆötÆ—fT÷&FW$f–æÂ†÷&FW%G&6RÂ°¢7FGW3¢'&V¦V7FVB"À¢Æ—fU÷6—F–öä–C¢Æ—fU÷6—F–öâæ–BÀ¢&V6öã¢Æ—fU÷6—F–öâç7FGW5&V6öâÀ¢W‡G&¢°¢W'&÷$6öFS¢÷&FW%&W7VÇCòæW'&÷$6öFRóò÷&FW%&W7VÇCòæ6öFRÀ¢W'&÷#¢÷&FW%&W7VÇCòæW'&÷"À¢GFV×G3¢Æ6TGFV×BÀ¢ÒÀ¢Ò¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢òò)H)H†&B7F÷öâf–ÆVBVçG'’Æ6VÖVçB)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òòF†R&÷FV7F–öâöf–ÆÂ—VÆ–æR&VÆ÷r—2öæÇ’fÆ–BgFW"F†RW†6†ævR†0¢òò6¶æ÷vÆVFvVB&VÂVçG'’÷&FW"â&Wf–÷W6Ç’G&ç6–VçB÷"fVçVR×6–FP¢òò²7V66W73¦fÇ6RÖ&W7VÇBF†Bv2æ÷B6Æ76–f–VB2Ö&v–âö6—&7V—@¢òò'&V¶W"7F–ÆÂfVÆÂF‡&÷Vv‚Â7F×VBF†R÷6—F–öâ2'Æ6VB"v—F‚à¢òòVæFVf–æVB÷&FW$–BÂF†VâGFV×FVBf–ÆÂfÆÆ&6²æB4ÂõEÆ6VÖVçBf÷ ¢òòâ÷&FW"F†BæWfW"W†—7FVBâF†B7&VFVBF†RW†7B6Æ72öbÆ—fRÖ÷&FW ¢òòW'&÷'2÷W&F÷'26s¢f¶RÆö6Â÷6—F–öç2Â&WVFVB&÷FV7F–öâÖ÷&FW ¢òòf–ÇW&W2ÂæB6öægW6–ær'÷6—F–öâæ÷BW†—7B"W†6†ævR&W7öç6W2à¢ÆWBVçG'”÷&FW$–BÒ÷&FW%&W7VÇCòæ÷&FW$–BÇÂ÷&FW%&W7VÇCòæ–@¢–b‚VçG'”÷&FW$–B’°¢6öç7B&V6÷fW&VBÒv—B&V6÷fW$VçG'”÷&FW$'”6Æ–VçD–B€¢W†6†ævT6öææV7F÷"À¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢÷&FW%G&6RæW†6†ævUG&6¶–æt–BÀ¢¢–b‡&V6÷fW&VB’°¢÷&FW%&W7VÇBÒ&V6÷fW&V@¢VçG'”÷&FW$–BÒ&V6÷fW&VBæ÷&FW$–BÇÂ&V6÷fW&VBæ–@¢Ð¢Ð¢–b‚÷&FW%&W7VÇCòç7V66W72ÇÂ†÷&FW%&W7VÇCòæ÷&FW$–BÇÂ÷&FW%&W7VÇCòæ–B’’°¢6öç7B&V6öâÐ¢÷&FW%&W7VÇCòæW'&÷"ÇÀ¢÷&FW%&W7VÇCòæÖW76vRÇÀ¢†÷&FW%&W7VÇCòç7V66W72ò$W†6†ævR66WFVBVçG'’'WB&WGW&æVBæò÷&FW$–B"¢$W†6†ævRVçG'’÷&FW"v2&V¦V7FVB"¢ ¢òò)H)HCÖ–æ–×VÒ÷&FW"Ö÷VçBW'&÷"6÷'&V7F–öâv—F‚6ÖRÔ7–6ÆR&WG'’)H ¢òòv†Vâ&–æu‚&V¦V7G2v—F‚6öFSÓCÂW‡G&7BF†RÖ–æ–×VÒg&öÒF†RW'&÷ ¢òòÖW76vRæB&WG'’”ÔÔTD”DTÅ’v—F‚6÷'&V7FVBföÇVÖR–âD„•27–6ÆRà¢òòF†—2&WfVçG2v7F–ær7–6ÆW2öâ&WVFVB7V"ÖÖ–æ–×VÒ&V¦V7F–öç2à¢ÆWB&WG'•v4GFV×FVBÒfÇ6P¢–b†v—B—47W'&VçB‚’bb—4Ö–ä÷&FW%6—¦TW'&÷"‡&V6öâ’bbÆ6TGFV×BÂ2’°¢6öç7BÖ–åG’ÒW‡G&7DÖ–ä÷&FW%G’‡&V6öâ¢–b†Ö–åG’bbÖ–åG’âbbÖ–åG’â6ö×WFVEföÇVÖR’°¢&WG'•v4GFV×FVBÒG'VP¢G'’°¢–b†v—B&÷'E7WW'6VFVB‚’’°¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ’æ6F6‚‚‚’Óâ·Ò¢&WGW&âÆ—fU÷6—F–öà¢Ð¢6öç7B²6WE6WGF–æw2ÒÒv—B–×÷'B‚$öÆ–"÷&VF—2ÖF""¢ ¢òò6fRF†R6÷'&V7FVBÖ–æ–×VÒf÷"gWGW&R7–6ÆW0¢v—B6WE6WGF–æw2‡G&F–æu—$¶W’‡&VÅ÷6—F–öâç7–Ö&öÂÂ6öææV7F–öä–B’Â°¢Ö–åö÷&FW%÷6—¦S¢Ö–åG’À¢WFFVEöC¢æWrFFR‚’çFô•4õ7G&–ær‚’À¢6÷W&6S¢#CöW'&÷%öW‡G&7F–öâ"À¢Ò¢ ¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò³C6÷'&V7F–öåÒFWFV7FVBÖ–æ–×VÒG¶Ö–åG—Òâ7W'&VçBG¶6ö×WFVEföÇVÖRçFôf—†VBƒ‚—Òf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÓ²&WG'––ær–â6ÖR7–6ÆVÀ¢¢ ¢òòW6RÖ–æ–×VÒ²RÖ&v–âFòVç7W&R66WFæ6RÂ'WBæWfW"&÷fP¢òòF†R†&BÆ—fRõe5Bæ÷F–öæÂ6V–Æ–ærà¢6öç7B&WG'•G’Òæ÷&ÖÆ—¦U&WG'”VçG'•VçF—G’†Ö–åG’¢ãÂG'VR¢–b‚‡&WG'•G’â’’°¢&WG'•v4GFV×FVBÒfÇ6P¢F‡&÷ræWrW'&÷"‚&Ö–æ–×VÒ÷&FW"VçF—G’6ææ÷Bf—BF†RÆ—fRõe5BW‡÷7W&R6V–Æ–ærgFW"fVçVR&÷VæF–ær"¢Ð¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Ò³C&WG'•Ò6VæF–ærv—F‚Ö&v–ã¢G·&WG'•G’çFôf—†VBƒ‚—Ò†Ö–ã¢G¶Ö–åG’çFôf—†VBƒ‚—Ò9rã–À¢ ¢òò&WG'’–ÖÖVF–FVÇ’v—F‚6÷'&V7FVBVçF—G¢–b†v—B&÷'E7WW'6VFVB‚’’°¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ’æ6F6‚‚‚’Óâ·Ò¢&WGW&âÆ—fU÷6—F–öà¢Ð¢ÆWB&WG'”÷&FW%&W7VÇC¢ç¢G'’°¢&WG'”÷&FW%&W7VÇBÒv—B7V&Ö—DVçG'•VçF—G’‡&WG'•G’Â&Ö–âÖ÷&FW"Ö6÷'&V7F–öâ"¢Ò6F6‚†W'&÷"’°¢&WG'”÷&FW%&W7VÇBÒ°¢7V66W73¢fÇ6RÀ¢W'&÷#¢W'&÷"–ç7Fæ6VöbW'&÷"òW'&÷"æÖW76vR¢7G&–ær†W'&÷"’À¢W'&÷$6öFS¢$Ä•dUôU…õ5U$Uõ$T4„T4µôd”ÄTB"À¢Ð¢Ð¢ ¢–b‡&WG'”÷&FW%&W7VÇCòç7V66W72bb‡&WG'”÷&FW%&W7VÇCòæ÷&FW$–BÇÂ&WG'”÷&FW%&W7VÇCòæ–B’’°¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Ò³C&WG'•Ò7V66W76gVÆÇ’Æ6VB÷&FW"v—F‚föÇVÖRG·&WG'•G’çFôf—†VBƒ‚—Òf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÖÀ¢¢òò6öçF–çVRv—F‚F†R6÷'&V7FVB÷&FW ¢÷&FW%&W7VÇBÒ&WG'”÷&FW%&W7VÇ@¢6ö×WFVEföÇVÖRÒÆ7E7V&Ö—GFVDVçG'•VçF—G’òòW6RF†RVçF—G’7GVÆÇ’FÖ—GFVBæB7V&Ö—GFV@¢&WG'•v4GFV×FVBÒG'VRòòÖ&²&WG'’v2GFV×FVBæB7V66VVFV@¢VçG'”÷&FW$–BÒ&WG'”÷&FW%&W7VÇCòæ÷&FW$–BÇÂ&WG'”÷&FW%&W7VÇCòæ–@¢ÒVÇ6R°¢òò&WG'’Ç6òf–ÆV@¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò³C&WG'•Ò&WG'’v—F‚G·&WG'•G’çFôf—†VBƒ‚—ÒÇ6òf–ÆVC¦À¢&WG'”÷&FW%&W7VÇCòæW'&÷"ÇÂ&WG'”÷&FW%&W7VÇCòæÖW76vRÇÂ'Væ¶æ÷vâ"À¢¢&WG'•v4GFV×FVBÒfÇ6Ròò&WG'’v2GFV×FVB'WBf–ÆV@¢Ð¢Ò6F6‚†W'"’°¢&WG'•v4GFV×FVBÒfÇ6P¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò³C6÷'&V7F–öåÒ&WG'’GFV×Bf–ÆVC¦À¢W'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"’À¢¢Ð¢Ð¢Ð¢ ¢òò–bæò&WG'’v2GFV×FVBÂ÷"&WG'’f–ÆVBÂ&RÖÖ&²2&V¦V7FVB6ð¢òòF†R6ÆVçW&Æö6²&VÆ÷r6â'VââF†R6†V6²&VÆ÷rv–ÆÂ÷fW'&–FRF†—0¢òò–bF†R&WG'’7GVÆÇ’7V66VVFVB‡&WG'”÷&FW$–B—26WB²÷&FW%&W7VÇBç7V66W72’à¢–b‚&WG'•v4GFV×FVB’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒ7G&–ær‡&V6öâ¢W6…7FW†Æ—fU÷6—F–öâÂ'Æ6Uö÷&FW""ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢Ð¢ ¢òò6†V6²–bvR7V66W76gVÆÇ’&WG&–VBæBv÷Bâ÷&FW"”@¢ÆWB&WG'”÷&FW$–BÒ÷&FW%&W7VÇCòæ÷&FW$–BÇÂ÷&FW%&W7VÇCòæ–@¢–b‚&WG'”÷&FW$–B’°¢6öç7B&V6÷fW&VBÒv—B&V6÷fW$VçG'”÷&FW$'”6Æ–VçD–B€¢W†6†ævT6öææV7F÷"À¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢÷&FW%G&6RæW†6†ævUG&6¶–æt–BÀ¢¢–b‡&V6÷fW&VB’°¢÷&FW%&W7VÇBÒ&V6÷fW&V@¢&WG'”÷&FW$–BÒ&V6÷fW&VBæ÷&FW$–BÇÂ&V6÷fW&VBæ–@¢VçG'”÷&FW$–BÒ&WG'”÷&FW$–@¢Ð¢Ð¢–b‚&WG'”÷&FW$–BÇÂ÷&FW%&W7VÇCòç7V66W72’°¢6öç7BFVf–æ—F—fU&V¦V7F–öâÐ¢÷&FW%&W7VÇCòç7V66W72b`¢†—4Ö–ä÷&FW%6—¦TW'&÷"‡&V6öâ’ÇÂ—4æöå&V6÷fW&&ÆTW†6†ævTW'&÷"†÷&FW%&W7VÇB’ÇÂ—46—&7V—D'&V¶W$W'&÷"†÷&FW%&W7VÇB’ ¢–b†FVf–æ—F—fU&V¦V7F–öâ’°¢Æ—fU÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒ7G&–ær‡&V6öâ¢Æ—fU÷6—F–öâç7V&Ö—76–öå7FFRÒ&6öæf—&ÖVB ¢W6…7FW†Æ—fU÷6—F–öâÂ'Æ6Uö÷&FW""ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5öf–ÆVEö6÷VçB"¢v—B–æ7&VÖVçDW†V7WF–öä÷&FW'4'•7–Ö&öÂ‚&VÅ÷6—F–öâç7–Ö&öÂÂ&VÅ÷6—F–öâæF—&V7F–öâÂ&f–ÆVB"¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’°¢v—B&VÆV6TÆö6²†6öææV7F–öä–BÂ&VÅ÷6—F–öâç7–Ö&öÂÂ&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚ÂÆ—fT÷&FW$Æö6µFö¶Vâ’æ6F6‚‚‚’ÓâfÇ6R¢Ð¢ÒVÇ6R°¢ö&¦V7Bæ76–vâ†Æ—fU÷6—F–öâÂ°¢7FGW3¢'Æ6VE÷Væ6öæf—&ÖVB"26öç7BÀ¢7V&Ö—76–öå7FFS¢'Væ6öæf—&ÖVB"26öç7BÀ¢Ò¢Æ—fU÷6—F–öâç7FGW5&V6öâÐ¢VçG'•÷7V&Ö—76–öå÷Væ6öæf—&ÖVC¢Gµ7G&–ær‡&V6öâ—Ó²G&6¶–ær'’6Æ–VçD÷&FW$–BVçF–ÂWF†÷&—FF—fR&V6÷fW'– ¢W6…7FW†Æ—fU÷6—F–öâÂ&VçG'•÷7V&Ö—76–öå÷Væ6öæf—&ÖVB"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5öFVfW'&VEö6÷VçB"¢Ð¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢FVf–æ—F—fU&V¦V7F–öâò&W'&÷""¢'v&æ–ær"À¢FVf–æ—F—fU&V¦V7F–öà¢òVçG'’÷&FW"&V¦V7FVBf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÖ ¢¢VçG'’7V&Ö—76–öâVæ6öæf—&ÖVBf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÖÀ¢°¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢6–FS¢W†6†ævU6–FRÀ¢VçF—G“¢6ö×WFVEföÇVÖRÀ¢&–6S¢7W'&VçE&–6RÀ¢W'&÷#¢Æ—fU÷6—F–öâç7FGW5&V6öâÀ¢6Æ–VçD÷&FW$–C¢÷&FW%G&6RæW†6†ævUG&6¶–æt–BÀ¢GFV×G3¢Æ6TGFV×BÀ¢ÒÀ¢¢v—BÆötÆ—fT÷&FW$f–æÂ†÷&FW%G&6RÂ°¢7FGW3¢FVf–æ—F—fU&V¦V7F–öâò'&V¦V7FVB"¢'Æ6VB"À¢Æ—fU÷6—F–öä–C¢Æ—fU÷6—F–öâæ–BÀ¢&V6öã¢Æ—fU÷6—F–öâç7FGW5&V6öâÀ¢W‡G&¢²÷&FW%&W7VÇBÂGFV×G3¢Æ6TGFV×BÒÀ¢Ò¢&WGW&âÆ—fU÷6—F–öà¢Ð¢Ð ¢Æ—fU÷6—F–öâæ÷&FW$–BÒ7G&–ær†VçG'”÷&FW$–B¢Æ—fU÷6—F–öâç7FGW2Ò'Æ6VB ¢Æ—fU÷6—F–öâç7V&Ö—76–öå7FFRÒ&6öæf—&ÖVB ¢W6…7FW†Æ—fU÷6—F–öâÂ'Æ6Uö÷&FW""ÂG'VRÂ÷&FW$–CÒG¶Æ—fU÷6—F–öâæ÷&FW$–GÖ¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5÷Æ6VEö6÷VçB"¢v—B–æ7&VÖVçDW†V7WF–öä÷&FW'4'•7–Ö&öÂ‚&VÅ÷6—F–öâç7–Ö&öÂÂ&VÅ÷6—F–öâæF—&V7F–öâÂ'Æ6VB"¢òò7V66W76gVÂÆ6VÖVçB(	B&W6WBF†RÖ&v–âW'&÷"6öç6V7WF—fRÖf–ÇW&R6÷VçFW ¢òò6òF†R&6¶öfb&W6WG2FòF†R6†÷'FW7B6ööÆF÷vâöâF†RæW‡Bf–ÇW&Rà¢Ö&v–äW'&÷$6ööÆF÷vä'”6öææV7F–öâæFVÆWFR†6öææV7F–öä–B¢òò)H)H&Vg&W6‚F†RFVGWÆö6²EDÂ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òòF†RöÆÂÖf–ÆÂ†6R&VÆ÷r6âF¶RWFòW2âv—F†÷WBÖ–B×—VÆ–æP¢òòEDÂ&Vg&W6‚Â6Æ÷rfVçVR²4ÂõEÆ6VÖVçB6÷VÆBW6‚7BF†P¢òòÆö6²w2“2v–æF÷rÂÆWGF–æræ÷F†W"F–6²Æ6RGWÆ–6FR÷6—F–öâà¢òò&R×7F×F†RÆö6²†W&R6òF†R6Æ÷B7F—2÷væVBF‡&÷Vv‚f–ÆÂ²&÷FV7Bà¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’°¢6öç7B7F–ÆÄ÷vç4Æö6²Òv—B&Vg&W6„Æö6µEDÂ€¢6öææV7F–öä–BÀ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚À¢Æ—fT÷&FW$Æö6µFö¶VâÀ¢’æ6F6‚‚‚’ÓâfÇ6R¢–b‚7F–ÆÄ÷vç4Æö6²’°¢Æ—fU÷6—F–öâç7FGW2Ò&W'&÷" ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒ$Æ÷7BÆ—fRÖ÷&FW"Æö6²÷væW'6†—&Vf÷&Rf–ÆÂ6öæf—&ÖF–öâ ¢W6…7FW†Æ—fU÷6—F–öâÂ&Æö6µ÷&Vg&W6‚"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢&WGW&âÆ—fU÷6—F–öà¢Ð¢Ð¢v—BÆöu&öw&W76–öäWfVçB†6öææV7F–öä–BÂ&Æ—fU÷G&F–ær"Â&–æfò"ÂVçG'’÷&FW"Æ6VBf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÖÂ°¢÷&FW$–C¢Æ—fU÷6—F–öâæ÷&FW$–BÀ¢6–FS¢W†6†ævU6–FRÀ¢VçF—G“¢6ö×WFVEföÇVÖRÀ¢&–6S¢7W'&VçE&–6RÀ¢ÆWfW&vS¢Æ—fU÷6—F–öâæÆWfW&vRÀ¢Ò ¢òòW'6—7B–çFW&ÖVF–FR7FFR6òT’6â6†÷r'Æ6VB"WfVâGW&–æröÆÂà¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ ¢òò)H)H7FWc¢f–ÆÂ6öæf—&ÖF–öâ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òòF‡&VRÖÆ–W"7G&FVw“ ¢òò’–æÆ–æS¢Öç’W†6†ævW2„&–æu‚Â'–&—B’&WGW&â–ÖÖVF–FRf–ÆÂFF–à¢òòF†RÆ6T÷&FW"&W7öç6R—G6VÆbâW‡G&7B—B&Vf÷&RöÆÆ–ærFòfö–@¢òògVÆÂW2v—Böâf7BÖf–ÆÂfVçVW2à¢òò"’öÆÃ¢7FæF&BF‚(	B&WVFVFÇ’6ÆÂvWD÷&FW"‚’VçF–Âf–ÆÆVB÷ ¢òòF–ÖV÷WBâW‡FVæFVBF–ÖV÷WBƒW2g2öÆB2’Fò†æFÆR6Æ÷ræWGv÷&·2à¢òò2’vWE÷6—F–öâ‚’fÆÆ&6³¢–böÆÂF–ÖW2÷WBv—F‚æòf–ÆÂFFÂ6²F†P¢òòW†6†ævRf÷"F†R§÷6—F–öâ¢†æ÷BF†R÷&FW"’âöâW'W†6†ævW2¢òò7V66W76gVÆÇ’Ö÷VæVB÷6—F–öâ•2F†R&ööböbf–ÆÃ²—G26—¦Ræ@¢òòVçG'’&–6R&R&VÆ–&ÆRWfVâv†VâvWD÷&FW"‚’Æw2à¢òð¢òògFW"ÆÂF‡&VRÆ–W'2ÂâVæ6öæf—&ÖVBVçF—G’&VÖ–ç2VæF–ærâæWfW ¢òò7–çF†W6—¦Rf–ÆÂg&öÒF†R&WVW7FVBVçF—G“¢Fö–ær6ò6â÷fW"×6—¦P¢òò&÷FV7F–öâæB6âÖ¶RF†RT’&W÷'B÷6—F–öâF†RfVçVRæWfW"f–ÆÆVBà¢6öç7B–æÆ–æTf–ÆÅG’Ò'6TfÆöB…7G&–ær†÷&FW%&W7VÇBæf–ÆÆVEG’óò÷&FW%&W7VÇBæW†V7WFVEG’óò÷&FW%&W7VÇBæ7VÕG’óò#"’’ÇÂ ¢6öç7B–æÆ–æTf–ÆÅ&–6RÒ'6TfÆöB…7G&–ær†÷&FW%&W7VÇBæf–ÆÆVE&–6Róò÷&FW%&W7VÇBæfu&–6Róò#"’’ÇÂ ¢6öç7B–æÆ–æU7FGW2Ò7G&–ær†÷&FW%&W7VÇBç7FGW2óò""’çFôÆ÷vW$66R‚¢6öç7B–æÆ–æTf–ÆÆVBÒ†–æÆ–æU7FGW2ÓÓÒ&f–ÆÆVB"ÇÂ–æÆ–æTf–ÆÅG’ãÒ6ö×WFVEföÇVÖR¢ã“’’bb–æÆ–æTf–ÆÅG’â  ¢ÆWBf–ÆÃ¢²f–ÆÆVC¢&ööÆVã²f–ÆÆVEG“¢çVÖ&W#²f–ÆÆVE&–6S¢çVÖ&W#²7FGW3¢7G&–ærÐ ¢–b†–æÆ–æTf–ÆÆVB’°¢òò’Æ6T÷&FW"&W7öç6RÇ&VG’6öçF–ç2f–ÆÂ6öæf—&ÖF–öâ(	B6¶—öÆÂà¢f–ÆÂÒ²f–ÆÆVC¢G'VRÂf–ÆÆVEG“¢–æÆ–æTf–ÆÅG’Âf–ÆÆVE&–6S¢–æÆ–æTf–ÆÅ&–6RÂ7FGW3¢&f–ÆÆVB"Ð¢6öç6öÆRæÆör†G´Äôuõ$Td•‡Ò–æÆ–æRf–ÆÂFWFV7FVBf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÓ¢G“ÒG¶–æÆ–æTf–ÆÅG—ÒG¶–æÆ–æTf–ÆÅ&–6WÖ¢ÒVÇ6R–b†Æ—fU÷6—F–öâæ÷&FW$–B’°¢òò"’7FæF&BöÆÂF‚(	BöæÇ’v†VâvR†fR6öæf—&ÖVB÷&FW$–Bà¢f–ÆÂÒv—BöÆÄ÷&FW$f–ÆÂ†W†6†ævT6öææV7F÷"Â&VÅ÷6—F–öâç7–Ö&öÂÂÆ—fU÷6—F–öâæ÷&FW$–B¢ÒVÇ6R°¢òòæò÷&FW$–Bg&öÒÆ6T÷&FW"&W7öç6R(	B6¶—öÆÆ–ærVçF—&VÇ’æ@¢òòfÆÂF‡&÷Vv‚FòF†RvWE÷6—F–öâ‚’fÆÆ&6²†Æ–W"2&VÆ÷r’à¢f–ÆÂÒ²f–ÆÆVC¢fÇ6RÂf–ÆÆVEG“¢Âf–ÆÆVE&–6S¢Â7FGW3¢'VæF–ær"Ð¢6öç6öÆRçv&â†G´Äôuõ$Td•‡Òæò÷&FW$–Bg&öÒÆ6T÷&FW"f÷"G·&VÅ÷6—F–öâç7–Ö&öÇÒ(	B6¶—–æröÆÂÂW6–ærvWE÷6—F–öâ‚’fÆÆ&6¶¢Ð ¢òò2’vWE÷6—F–öâ‚’fÆÆ&6²v†VâöÆÂF–ÖVB÷WBv—F†÷WBf–ÆÂFFà¢òð¢òòW†6†ævR÷6—F–öâ&Vv—7G&–W2&RW7VÆÇ’fWr‡VæG&VB×2&V†–æ@¢òò÷&FW"6¶æ÷vÆVFvVÖVçG2†÷&FW'2vòF‡&÷Vv‚F†RÖF6†–ærVæv–æRÂF†Và¢òòvWBW'6—7FVBFòF†R÷6—F–öâ6W'f–6Rf––çFW&æÂV"÷7V"’â¢òò6–ævÆRvWE÷6—F–öâ‚’F†B6öÖW2&6²V×G’—2F†W&Vf÷&Ræ÷@¢òò6öæ6ÇW6—fR&ööbF†R÷&FW"F–FâwBf–ÆÂ(	B—BÖ–v‡B§W7B&RF†P¢òò&Vv—7G'’&V–ær6Æ÷râvRG'’WFò2F–ÖW2v—F‚#S×2v2&Vf÷&P¢òòv—f–ærWæBG&÷–ærFòF†R6ö×WFVEföÇVÖRwV&BÂv†–6‚G&FW0¢òòãS×2öbFF—F–öæÂ6öæf—&ÖF–öâÆFVæ7’f÷"×V6‚†–v†W"67W&7¢òòöb4ÂõE6—¦–æröâ6Æ÷rÖ6öæf—&Ö–ærfVçVW2à¢–b‚f–ÆÂæf–ÆÆVBÇÂf–ÆÂæf–ÆÆVEG’ÃÒ’°¢–b‡G—VöbW†6†ævT6öææV7F÷"ævWE÷6—F–öâÓÓÒ&gVæ7F–öâ"’°¢f÷"†ÆWBGFV×BÒ²GFV×BÂ3²GFV×B³Ò’°¢G'’°¢òò72F—&V7F–öâ6ò†VFvRÖÖöFR6öææV7F÷'2&WGW&âF†R6÷'&V7@¢òòÄôärg24„õ%B6Æ÷B&F†W"F†âv†–6†WfW"—2f—'7B–âF†R'&’à¢6öç7BW…÷2Òv—BW†6†ævT6öææV7F÷"ævWE÷6—F–öâ€¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâ2&Æöær"Â'6†÷'B"À¢¢òò&–æu‚c2W'WGVÃ¢G’—2–â÷6—F–öä×F²æ÷&ÖÆ—6VB÷WGW@¢òòÇ6òW‡÷6W26öçG&7G6æB6—¦VÆ–6W2‡6WB–âvWE÷6—F–öç2’à¢6öç7BW…6—¦RÒ'6TfÆöB…7G&–ær†W…÷3òç÷6—F–öä×BóòW…÷3òæ6öçG&7G2óòW…÷3òç6—¦RóòW…÷3òçVçF—G’óò#"’’ÇÂ ¢6öç7BW„VçG'’Ò'6TfÆöB…7G&–ær†W…÷3òæVçG'•&–6RóòW…÷3òæfu&–6RóòW…÷3òæfW&vU&–6Róò#"’’ÇÂ ¢–b„ÖF‚æ'2†W…6—¦R’âbbW„VçG'’â’°¢6öç6öÆRæÆör†G´Äôuõ$Td•‡ÒvWE÷6—F–öâ‚’fÆÆ&6²f–ÆÂf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÓ¢6—¦SÒG¶W…6—¦WÒVçG'“ÒG¶W„VçG'—Ò†GFV×CÒG¶GFV×B²Ò–¢f–ÆÂÒ°¢f–ÆÆVC¢G'VRÀ¢f–ÆÆVEG“¢ÖF‚æ'2†W…6—¦R’À¢f–ÆÆVE&–6S¢W„VçG'’À¢7FGW3¢&f–ÆÆVE÷f–÷÷6—F–öâ"À¢Ð¢'&V°¢Ð¢Ò6F6‚°¢ò¢G&ç6–VçBW'&÷"(	B6÷VçG22öæRGFV×BÂfÆÂF‡&÷Vv‚Fò&WG'’¢ð¢Ð¢òòv&Vf÷&RF†RæW‡B&ö&R(	B6†÷'BVæ÷Vv‚F†BF÷FÂv÷'7BÖ66P¢òò—2ãS×2ÂÆöærVæ÷Vv‚f÷"F†R&Vv—7G'’Fò6F6‚Wà¢–b†GFV×BÂ"’v—BæWr&öÖ—6R‡"Óâ6WEF–ÖV÷WB‡"Â#S’¢Ð¢Ð¢Ð ¢6öç7BVçG'•6WGFÆVÖVçBÒÆ—fU÷6—F–öâæ÷&FW$–@¢òv—B&VD÷&FW%6WGFÆVÖVçB†W†6†ævT6öææV7F÷"Â&VÅ÷6—F–öâç7–Ö&öÂÂÆ—fU÷6—F–öâæ÷&FW$–B¢¢çVÆÀ¢–b†VçG'•6WGFÆVÖVçB’°¢6öç7B6WGFÆVÖVçE&–6RÒf–æ—FU÷6—F—fR†VçG'•6WGFÆVÖVçBæfW&vTf–ÆÅ&–6R¢6öç7Bö'6W'fVDf–ÆÅ&–6RÒf–æ—FU÷6—F—fR†f–ÆÂæf–ÆÆVE&–6R¢6öç7BÖ&¶WE&VfW&Væ6U&–6RÒf–æ—FU÷6—F—fR†7W'&VçE&–6R¢6öç7B6öçFV×÷&æV÷W5&–6RÐ¢ö'6W'fVDf–ÆÅ&–6Râb`¢Ö&¶WE&VfW&Væ6U&–6Râb`¢&–6TFöÖ–äF—7Fæ6R†ö'6W'fVDf–ÆÅ&–6RÂÖ&¶WE&VfW&Væ6U&–6R’ãÒã#P¢òÖ&¶WE&VfW&Væ6U&–6P¢¢ö'6W'fVDf–ÆÅ&–6RÇÂÖ&¶WE&VfW&Væ6U&–6P¢6öç7B6WGFÆVÖVçE&–6U&V¦V7FVBÐ¢6öçFV×÷&æV÷W5&–6Râb`¢‚‡6WGFÆVÖVçE&–6Râ’ÇÂ&–6TFöÖ–äF—7Fæ6R‡6WGFÆVÖVçE&–6RÂ6öçFV×÷&æV÷W5&–6R’ãÒã#R¢6öç7B66WFVE6WGFÆVÖVçE&–6RÒ6WGFÆVÖVçE&–6U&V¦V7FV@¢ò6öçFV×÷&æV÷W5&–6P¢¢6WGFÆVÖVçE&–6P¢–b‡6WGFÆVÖVçE&–6U&V¦V7FVB’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò&V¦V7FVB7&÷72ÖFöÖ–âVçG'’6WGFÆVÖVçB&–6Rf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÓ¢°¢6WGFÆVÖVçCÒG·6WGFÆVÖVçE&–6WÒ&VfW&Væ6SÒG¶6öçFV×÷&æV÷W5&–6WÖÀ¢¢Ð¢f–ÆÂÒ°¢f–ÆÆVC¢G'VRÀ¢f–ÆÆVEG“¢VçG'•6WGFÆVÖVçBæf–ÆÆVEVçF—G’À¢f–ÆÆVE&–6S¢66WFVE6WGFÆVÖVçE&–6RÀ¢7FGW3¢6WGFÆVÖVçE&–6U&V¦V7FV@¢ò&f–ÆÆVE÷f–÷6WGFÆVÖVçE÷&–6UöwV&B ¢¢&f–ÆÆVE÷f–÷6WGFÆVÖVçB"À¢Ð¢Ð ¢–b†f–ÆÂæf–ÆÆVBbbf–ÆÂæf–ÆÆVEG’âbbf–ÆÂæf–ÆÆVE&–6Râ’°¢6öç7BWF†÷&—FF—fTf–ÆÅ&–6RÒf–æ—FU÷6—F—fR†f–ÆÂæf–ÆÆVE&–6R¢Æ—fU÷6—F–öâæW†V7WFVEVçF—G’Òf–ÆÂæf–ÆÆVEG¢Æ—fU÷6—F–öâç&VÖ–æ–æuVçF—G’ÒÖF‚æÖ‚ƒÂ6ö×WFVEföÇVÖRÒf–ÆÂæf–ÆÆVEG’¢Æ—fU÷6—F–öâæVçG'•&–6RÒWF†÷&—FF—fTf–ÆÅ&–6P¢Æ—fU÷6—F–öâæfW&vTW†V7WF–öå&–6RÒWF†÷&—FF—fTf–ÆÅ&–6P¢&V6öæ6–ÆT–æ—F–ÄVçG'”&6UVçF—G’†Æ—fU÷6—F–öâÂf–ÆÂæf–ÆÆVEG’¢–b‡7V6–Å÷6—F–öåÆâ’°¢Æ—fU÷6—F–öâç7V6–Ä&6UVçF—G’Òf–ÆÂæf–ÆÆVEG’ò7V6–Å÷6—F–öåÆâçF÷FÅföÇVÖU&F–ð¢Ç•7V6–ÅÆåFõ÷6—F–öâ†Æ—fU÷6—F–öâÂ7V6–Å÷6—F–öåÆâ¢Ð¢Æ—fU÷6—F–öâçF÷FÄW†V7WFVEVçF—G’ÒÖF‚æÖ‚€¢çVÖ&W"†Æ—fU÷6—F–öâçF÷FÄW†V7WFVEVçF—G’ÇÂ’À¢f–ÆÂæf–ÆÆVEG’À¢¢Æ—fU÷6—F–öâæ–æ—F–ÄVçG'•&–6RóóÒWF†÷&—FF—fTf–ÆÅ&–6P¢–æ—F–Æ—¦T–æFWVæFVçD&Æö6µ6VVB€¢Æ—fU÷6—F–öâÀ¢&VÅ÷6—F–öâÀ¢f–ÆÂæf–ÆÆVEG’À¢÷&FW%G&6RæW†6†ævUG&6¶–æt–BÀ¢Æ—fU÷6—F–öâæ÷&FW$–BÀ¢¢–b†Æ—fU÷6—F–öâæ6öÖ&–æVE÷46÷VçG2’°¢Æ—fU÷6—F–öâç÷46÷VçG56WEVçF—F–W2ÒÆÆö6FU÷6—F–öå6WEVçF—F–W2€¢Æ—fU÷6—F–öâÀ¢f–ÆÂæf–ÆÆVEG’À¢Æ—fU÷6—F–öâæ67V×VÆFVE6WD¶W—2À¢¢Ð¢Æ—fU÷6—F–öâæf–ÆÇ2çW6‚‡°¢÷&FW$–C¢Æ—fU÷6—F–öâæ÷&FW$–BÀ¢6WGFÆVÖVçE6÷W&6S¢VçG'•6WGFÆVÖVçCòç6÷W&6RÀ¢F–ÖW7F×¢FFRææ÷r‚’À¢VçF—G“¢f–ÆÂæf–ÆÆVEG’À¢&–6S¢WF†÷&—FF—fTf–ÆÅ&–6RÀ¢fVS¢ÖF‚æÖ‚ƒÂçVÖ&W"†VçG'•6WGFÆVÖVçCòçG&F–ætfVR’ÇÂ’À¢fVT76WC¢%U4EB"À¢Ò¢Æ—fU÷6—F–öâæVçG'•G&F–ætfVRÒÖF‚æÖ‚ƒÂçVÖ&W"†VçG'•6WGFÆVÖVçCòçG&F–ætfVR’ÇÂ¢Æ—fU÷6—F–öâæVçG'•G&F–ætfVTÆÆö6FVBÒ ¢Æ—fU÷6—F–öâæVçG'”66÷VçF–æt6ö×ÆWFRÒ&ööÆVâ†VçG'•6WGFÆVÖVçB¢Æ—fU÷6—F–öâæVçG'•6WGFÆVÖVçD÷&FW$–G2ÒVçG'•6WGFÆVÖVçBò¶VçG'•6WGFÆVÖVçBæ÷&FW$–EÒ¢µÐ¢Æ—fU÷6—F–öâç&VÆ—¦VEæÄ6ö×ÆWFRÒG'VP¢Æ—fU÷6—F–öâç&VÆ—¦VEæÅ6÷W&6RÒVçG'•6WGFÆVÖVç@¢ò&W†6†ævU÷6WGFÆVÖVçB ¢¢&W†6†ævUöf–ÆÇ5ö–æ6ö×ÆWFUöfVW2 ¢Æ—fU÷6—F–öâç7FGW2ÒÆ—fU÷6—F–öâç&VÖ–æ–æuVçF—G’ÃÒãò&f–ÆÆVB"¢''F–ÆÇ•öf–ÆÆVB ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒf–ÆÂç7FGW2ÓÓÒ&f–ÆÆVE÷f–÷÷6—F–öâ ¢ò6öæf—&ÖVE÷÷6—F–öåöfÆÆ&6³¢W†6†ævR÷6—F–öâ6—¦SÒG¶f–ÆÂæf–ÆÆVEG—ÒfsÒG¶WF†÷&—FF—fTf–ÆÅ&–6WÖ ¢¢6öæf—&ÖVEöf–ÆÃ¢÷&FW"f–ÆÂ7FGW3ÒG¶f–ÆÂç7FGW7ÒG“ÒG¶f–ÆÂæf–ÆÆVEG—Ö ¢W6…7FW†Æ—fU÷6—F–öâÂ'öÆÅöf–ÆÂ"ÂG'VRÂf–ÆÆVCÒG¶f–ÆÂæf–ÆÆVEG—ÒG¶f–ÆÂæf–ÆÆVE&–6WÒf–ÒG¶f–ÆÂç7FGW7Ò&V6öãÒG¶Æ—fU÷6—F–öâç7FGW5&V6öçÖ¢v—B&V6÷&Df–ÆÄ6÷VçFW'4öæ6R†6öææV7F–öä–BÂÆ—fU÷6—F–öâÂ&VÅ÷6—F–öâç7–Ö&öÂÂ&VÅ÷6—F–öâæF—&V7F–öâ¢v—BÆöu&öw&W76–öäWfVçB†6öææV7F–öä–BÂ&Æ—fU÷G&F–ær"Â&–æfò"ÂVçG'’f–ÆÆVBf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÖÂ°¢÷&FW$–C¢Æ—fU÷6—F–öâæ÷&FW$–BÀ¢f–ÆÆVEG“¢f–ÆÂæf–ÆÆVEG’À¢f–ÆÆVE&–6S¢f–ÆÂæf–ÆÆVE&–6RÀ¢f–¢f–ÆÂç7FGW2À¢Ò¢v—BÆötÆ—fT÷&FW$f–æÂ†÷&FW%G&6RÂ°¢7FGW3¢&f–ÆÆVB"À¢Æ—fU÷6—F–öä–C¢Æ—fU÷6—F–öâæ–BÀ¢W†V7WFVEVçF—G“¢f–ÆÂæf–ÆÆVEG’À¢fW&vU&–6S¢WF†÷&—FF—fTf–ÆÅ&–6RÀ¢&V6öã¢f–ÆÂf–ÒG¶f–ÆÂç7FGW7ÖÀ¢W‡G&¢²÷&FW$–C¢Æ—fU÷6—F–öâæ÷&FW$–BÂGFV×G3¢Æ6TGFV×BÒÀ¢Ò¢òòW'6—7BF†RWF†÷&—FF—fRf–ÆÂ&Vf÷&R&÷FV7F–öâ6ö÷&F–æF–öââ&ÆÆVÀ¢òò6WBVçG&–W2f÷"F†R6ÖR7–Ö&öÂöF—&V7F–öâ6âæ÷r6VRöæRæ÷F†W"à¢òòWfW'’&÷r7F–ÆÂ&×2W†7B×VçF—G’4ÂõE²vw&VvFR&V6öæ6–Æ–F–öà¢òòöæÇ’VÆV7G2F†R6W&FRvw&VvFR×VçF—G’6V7W&—G’×7F÷÷væW"à¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢òò&Ò4ÂõE–ÖÖVF–FVÇ’gFW"âWF†÷&—FF—fR–æÆ–æR÷öÆÆVBf–ÆÂà¢òòf—†VBfVçVR×6WGFÆ–ær6ÆVWFVÆ–VBWfW'’†VÇF‡’÷&FW"'’Gvð¢òò6V6öæG2æBÆVgBF†Rg&W6†Ç’÷VæVB÷6—F–öâVææV6W76&–Ç¢òòVç&÷FV7FVBâ&–æu‚w2WfVçGVÂÖ6öç6—7FVæ7’66R—2Ç&VG’†æFÆV@¢òòæ'&÷vÇ’'’F†R“C#&WG'’–âÆ6U&÷FV7F–öä÷&FW"Â6òf7Bf–ÆÇ0¢òò7F’öâF†R7V"×6V6öæBF‚v†–ÆRÆvv–ær7–Ö&öÇ27F–ÆÂ6VÆbÖ†VÂà¢ÒVÇ6R°¢òòB’&÷FV7F–öâÖFVfW'&VBwV&C¢–bæV—F†W"÷&FW"öÆÆ–æræ÷"F—&V7@¢òòW†6†ævR×÷6—F–öâ&VG26öæf—&Ò÷6—F–öâ6—¦RÂFòäõB7–çF†W6—¦R¢òòf–ÆÂg&öÒ6ö×WFVEföÇVÖRâW'6—7BâVæ6öæf—&ÖVB7FGW2æBÆW@¢òò&V6öæ6–ÆR&Ò4ÂõE–ÖÖVF–FVÇ’öæ6RF†RfVçVR÷6—F–öâV'2à¢6öç7BFVfW'&VE7FGW3¢Æ—fU÷6—F–öå²'7FGW2%ÒÒÆ—fU÷6—F–öâæ÷&FW$–Bò'VæF–æuöf–ÆÂ"¢'Æ6VE÷Væ6öæf—&ÖVB ¢Æ—fU÷6—F–öâæW†V7WFVEVçF—G’Ò ¢Æ—fU÷6—F–öâç&VÖ–æ–æuVçF—G’Ò6ö×WFVEföÇVÖP¢Æ—fU÷6—F–öâæfW&vTW†V7WF–öå&–6RÒ ¢Æ—fU÷6—F–öâç7FGW2ÒFVfW'&VE7FGW0¢Æ—fU÷6—F–öâç7FGW5&V6öâÐ¢&÷FV7F–öåöFVfW'&VC¢f–ÆÂVæ6öæf—&ÖVBgFW"öÆÅ7FGW3ÒG¶f–ÆÂç7FGW7Ó²F—&V7B÷6—F–öâÆöö·Wf÷VæBæò6—¦V ¢W6…7FW†Æ—fU÷6—F–öâÂ'öÆÅöf–ÆÂ"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢'v&æ–ær"À¢VçG'’f–ÆÂVæ6öæf—&ÖVBf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÒ(	B4ÂõEFVfW'&VBVçF–ÂW†6†ævR÷6—F–öâV'6À¢²÷&FW$–C¢Æ—fU÷6—F–öâæ÷&FW$–BÂ7FGW3¢f–ÆÂç7FGW2Â&WVW7FVEG“¢6ö×WFVEföÇVÖRÂ6fVE7FGW3¢FVfW'&VE7FGW2Ð¢¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—BÆötÆ—fT÷&FW$f–æÂ†÷&FW%G&6RÂ°¢7FGW3¢'Æ6VB"À¢Æ—fU÷6—F–öä–C¢Æ—fU÷6—F–öâæ–BÀ¢W†V7WFVEVçF—G“¢À¢fW&vU&–6S¢À¢&V6öã¢Æ—fU÷6—F–öâç7FGW5&V6öâÀ¢W‡G&¢²÷&FW$–C¢Æ—fU÷6—F–öâæ÷&FW$–BÂGFV×G3¢Æ6TGFV×BÂ&WVW7FVEG“¢6ö×WFVEföÇVÖRÒÀ¢Ò¢Ð ¢òò)H)H7FWs¢Æ6R7F÷Æ÷72æBF¶R&öf—B÷&FW'2)HûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òð¢òò6–ævÆR6÷W&6RöbG'WF‚f÷"4ÂõE&–6RFW&—fF–öã ¢òò6ö×WFTFW6—&VE&÷FV7F–öå&–6W2‚–—2Ç6òv†BF†R67V×VÆF–öà¢òòæB&V6öæ6–ÆRF‡2W6Râ'’&÷WF–ærF†R–æ—F–ÂÆ6VÖVçBF‡&÷Vv€¢òòF†R6ÖR†VÇW"vRwV&çFVRF†BâW†6†ævR×6–FR÷&FW"v–ÆÀ¢òòÅt•2&R&ÖVBBF†R6ÖR&–6RF†R7G&FVw’76–væVB‡&÷VæFV@¢òò–FVçF–6ÆÇ’’Âv—F‚æòGWÆ–6FR–æÆ–æR6ö×WFF–öâF†B6÷VÆ@¢òòG&–gB÷WBöb7–æ2v—F‚F†R&W7BöbF†Rf–ÆRà¢–b†Æ—fU÷6—F–öâæW†V7WFVEVçF—G’â’°¢–b‡G—VöbW†6†ævT6öææV7F÷"ævWE÷6—F–öâÓÓÒ&gVæ7F–öâ"’°¢G'’°¢òò72F—&V7F–öâ6ò†VFvRÖÖöFR66÷VçG2&WGW&âF†R6÷'&V7B6Æ÷Bà¢6öç7BW…÷2Òv—BW†6†ævT6öææV7F÷"ævWE÷6—F–öâ€¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâ2&Æöær"Â'6†÷'B"À¢¢–b†W…÷2’°¢Æ—fU÷6—F–öâæW†6†ævTFFÒ°¢âââ†Æ—fU÷6—F–öâæW†6†ævTFFÇÂ·Ò’À¢Ö&v–åG—S¢†W…÷22ç’’æÖ&v–åG—RÀ¢Ö&µ&–6S¢†W…÷22ç’’æÖ&µ&–6RÀ¢Æ—V–FF–öå&–6S¢†W…÷22ç’’æÆ—V–FF–öå&–6RÀ¢Vç&VÆ—¦VEæÃ¢†W…÷22ç’’çVç&VÆ—¦VEæÂÀ¢&ö“¢†W…÷22ç’’ç&ö’À¢Ð¢6öç7BæF—fUF–6¶WBÒçVÖ&W"€¢†W…÷22ç’’ç÷6—F–öåF–6¶WBóð¢†W…÷22ç’’çF–6¶WBóð¢†W…÷22ç’’æW†6†ævU÷6—F–öä–BÀ¢¢–b„çVÖ&W"æ—4–çFVvW"†æF—fUF–6¶WB’bbæF—fUF–6¶WBâ’°¢Æ—fU÷6—F–öâç÷6—F–öåF–6¶WBÒæF—fUF–6¶W@¢Ð¢Ð¢Ò6F6‚†W'"’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò&R×&÷FV7F–öâÖ&²7–æ2f–ÆVBf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÓ¦À¢W'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"’À¢¢Ð¢Ð ¢6öç7B6–FT6Æ÷6S¢&'W’"Â'6VÆÂ"Ò&VÅ÷6—F–öâæF—&V7F–öâÓÓÒ&Æöær"ò'6VÆÂ"¢&'W’ ¢6öç7B–æ—F–Å&÷FV7F–öâÒ6ö×WFTFW6—&VE&÷FV7F–öå&–6W2†Æ—fU÷6—F–öâ¢6öç7B&÷FV7F–öäF—&V7F–öâÒ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ†Æ—fU÷6—F–öâ¢6öç7B&–6UF–6²ÒçVÖ&W"†Æ—fU÷6—F–öâç&–6UF–6²ÇÂ¢6öç7B6Å&–6RÒæ÷&ÖÆ—¦U&÷FV7F–öåG&–vvW%&–6R€¢–æ—F–Å&÷FV7F–öâæFW6—&VE6ÂÀ¢&–6UF–6²À¢&÷FV7F–öäF—&V7F–öâÀ¢'7F÷öÆ÷72"À¢¢6öç7BG&–6RÒæ÷&ÖÆ—¦U&÷FV7F–öåG&–vvW%&–6R€¢–æ—F–Å&÷FV7F–öâæFW6—&VEGÀ¢&–6UF–6²À¢&÷FV7F–öäF—&V7F–öâÀ¢'F¶U÷&öf—B"À¢ ¢–b†v—B6Æ÷6T–e&÷FV7F–öåG&–vvW$Ç&VG”7&÷76VB†W†6†ævT6öææV7F÷"ÂÆ—fU÷6—F–öâÂ6Å&–6RÂG&–6RÂ&–æ—F–Å÷Æ6VÖVçB"’’°¢&WGW&âÆ—fU÷6—F–öà¢Ð¢òòGWÆ–6FR×&WfVçF–öâ—2†æFÆVB–ç6–FRF†R&öÖ—6RæÆÂ&VÆ÷s ¢òòV6‚ÆVr&W6öÇfW2FòF†RW†—7F–ær÷&FW$–Bv†Vââ÷&FW"—2Ç&VG¢òò&W6VçB†Æ—fU÷6—F–öâç7F÷Æ÷74÷&FW$–FwV&BöâF†RFW&æ'’’À¢òò6òæò6W&FRwV&B&Æö6²—2æVVFVB†W&Rà ¢òòDòäõB&R×7F×F†RFW6—&VB&–6W2öçFòÆ—fU÷6—F–öâ&Vf÷&RF†P¢òòW†6†ævR6öæf—&×2Æ6VÖVçBâF†R÷&–v–æÂ6öFR6W@¢òòÆ—fU÷6—F–öâç7F÷Æ÷75&–6RÒ6Å&–6P¢òòÆ—fU÷6—F–öâçF¶U&öf—E&–6RÒG&–6P¢òò$Tdõ$Rv—F–ærF†RÆ6VÖVçB&öÖ—6W2âv†VâÆ6VÖVçBf–ÆV@¢òòF†R&V6÷&FVB&–6R7F–ÆÂWVÆVBF†RFW6—&VB&–6RÂ6ð¢òò&–6TG&–gFVB‡7F÷&VBÂFW6—&VB–&WGW&æVBfÇ6RöâF†RæW‡@¢òò&V6öæ6–ÆRF–6²æBF†RÆö÷æWfW"&WG&–VBF†Rf–ÆVBÆVr(	@¢òòÆVf–ærF†RÆ—fR÷6—F–öâW‡÷6VBv—F†÷WB&÷FV7F–öâVçF–ÂF†P¢òò÷W&F÷"w2&–6RÖ÷fVBãã#RRÂ6öÖWF–ÖW2f÷"F†RÆ–fWF–ÖRö`¢òòF†RG&FRà¢òð¢òòF†RæWr6öçG&7C¢7F÷&VB&–6R—2F†RÄ5B4ôäd•$ÔTB&ÖVB&–6P¢òòf÷"F†BÆVrâf–ÆVBÆ6VÖVçBÆVfW2—BBÂv†–6€¢òò&–6TG&–gFVBƒÂFW6—&VB–6÷'&V7FÇ’6Æ76–f–W22&æVVG2&Ö–ær ¢òòöâF†RæW‡B&V6öæ6–ÆR72à¢òò&Ò4ÂæBE6öæ7W'&VçFÇ’âF†R&–æu‚6öææV7F÷"æ÷rW6W2F†Röff–6–À¢òò4D²f÷"6öæF—F–öæÂ÷&FW'2f—'7BæB¶VW2F†RfVçVR×7V6–f–2&WG'¢òòÆöv–2–ç6–FRÆ6U&÷FV7F–öä÷&FW&Â6òFF–ærf—†VBS×2v†W&P¢òòöæÇ’ÆVfW2g&W6‚Æ—fR÷6—F–öâW‡÷6VBÆöævW"F†âæV6W76'’à¢6öç7B–æ—F–ÄÆ—fT÷&FW$–G2Òv—BfWF6„Æ—fT÷&FW$–E6WB†W†6†ævT6öææV7F÷"¢6öç7B–æ—F–Ä66—G”'VFvWBÒ&÷FV7F–öä66—G”'VFvWDöb†–æ—F–ÄÆ—fT÷&FW$–G2¢6öç7B–æ—F–ÅöÆ–7’Òv—BvWD66†VE&÷FV7F–öåöÆ–7’†6öææV7F–öä–B¢6öç7BÆ6U&÷t6öçG&öÇ2Ò–æ—F–ÅöÆ–7’æ÷fW&ÆÄ6öçG&öÄ÷&FW'4öæÇ’bb–æ—F–ÅöÆ–7’ç7—7FVÔ6Æ÷6TöæÇ¢6öç7B6Ä66—G’ÒÆ6U&÷t6öçG&öÇ2bb6Å&–6RâbbÆ—fU÷6—F–öâç7F÷Æ÷74÷&FW$–@¢ò&W6W'fU&÷FV7F–öä66—G’†–æ—F–Ä66—G”'VFvWBÂÆ—fU÷6—F–öâÂ'7F÷öÆ÷72"¢¢²ÆÆ÷vVC¢fÇ6RÂ&W6W'fF–öä–C¢""Ð¢6öç7BG66—G’ÒÆ6U&÷t6öçG&öÇ2bbG&–6RâbbÆ—fU÷6—F–öâçF¶U&öf—D÷&FW$–@¢ò&W6W'fU&÷FV7F–öä66—G’†–æ—F–Ä66—G”'VFvWBÂÆ—fU÷6—F–öâÂ'F¶U÷&öf—B"¢¢²ÆÆ÷vVC¢fÇ6RÂ&W6W'fF–öä–C¢""Ð¢6öç7B6Ä6Æ–VçD÷&FW$–BÒ6Å&–6RâbbÆ—fU÷6—F–öâç7F÷Æ÷74÷&FW$–Bbb6Ä66—G’æÆÆ÷vV@¢òv—B&W&U&÷FV7F–öå7V&Ö—76–öâ†Æ—fU÷6—F–öâÂ'7F÷Æ÷72"Â6Å&–6RÂÆ—fU÷6—F–öâæW†V7WFVEVçF—G’¢¢VæFVf–æV@¢6öç7BG6Æ–VçD÷&FW$–BÒG&–6RâbbÆ—fU÷6—F–öâçF¶U&öf—D÷&FW$–BbbG66—G’æÆÆ÷vV@¢òv—B&W&U&÷FV7F–öå7V&Ö—76–öâ†Æ—fU÷6—F–öâÂ'F¶U&öf—B"ÂG&–6RÂÆ—fU÷6—F–öâæW†V7WFVEVçF—G’¢¢VæFVf–æV@¢6öç7B·6ÅÆ6VÖVçBÂGÆ6VÖVçEÒÒv—B&öÖ—6RæÆÂ…°¢‡6Å&–6RâbbÆ—fU÷6—F–öâç7F÷Æ÷74÷&FW$–Bbb6Ä66—G’æÆÆ÷vVB¢òÆ6U&÷FV7F–öä÷&FW"€¢W†6†ævT6öææV7F÷"À¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢6–FT6Æ÷6RÀ¢Æ—fU÷6—F–öâæW†V7WFVEVçF—G’À¢6Å&–6RÀ¢%7F÷Æ÷72"À¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢6Ä6Æ–VçD÷&FW$–BÀ¢¢¢&öÖ—6Rç&W6öÇfR‡°¢÷&FW$–C¢Æ—fU÷6—F–öâç7F÷Æ÷74÷&FW$–BÇÂ‡6Å&–6Râò%5•5DTÕôdÄÄ$4²"¢çVÆÂ’À¢&ÖVEVçF—G“¢Æ—fU÷6—F–öâç7F÷Æ÷74÷&FW$–@¢ò&÷FV7F–öäÆVt&ÖVEVçF—G’†Æ—fU÷6—F–öâÂ'7F÷öÆ÷72"¢¢À¢Ò’À¢‡G&–6RâbbÆ—fU÷6—F–öâçF¶U&öf—D÷&FW$–BbbG66—G’æÆÆ÷vVB¢òÆ6U&÷FV7F–öä÷&FW"€¢W†6†ævT6öææV7F÷"À¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢6–FT6Æ÷6RÀ¢Æ—fU÷6—F–öâæW†V7WFVEVçF—G’À¢G&–6RÀ¢%F¶U&öf—B"À¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢G6Æ–VçD÷&FW$–BÀ¢¢¢&öÖ—6Rç&W6öÇfR‡°¢÷&FW$–C¢Æ—fU÷6—F–öâçF¶U&öf—D÷&FW$–BÇÂ‡G&–6Râò%5•5DTÕôdÄÄ$4²"¢çVÆÂ’À¢&ÖVEVçF—G“¢Æ—fU÷6—F–öâçF¶U&öf—D÷&FW$–@¢ò&÷FV7F–öäÆVt&ÖVEVçF—G’†Æ—fU÷6—F–öâÂ'F¶U÷&öf—B"¢¢À¢Ò’À¢Ò¢6öç7B6Ä÷&FW$–BÒ6ÅÆ6VÖVçBæ÷&FW$–@¢6öç7BG÷&FW$–BÒGÆ6VÖVçBæ÷&FW$–@ ¢òò%$”4Uô5$õ54TB"6VçF–æVÃ¢Ö&¶WBÖ÷fVB7BF†R&÷FV7F–öâ&–6R&WGvVVà¢òò6Æ7VÆF–öâæBÆ6VÖVçB„&–æu‚C"óC2’âf÷&6RÖ6Æ÷6R–ÖÖVF–FVÇ¢òò&F†W"F†âv—F–ærWFòöæRgVÆÂ&V6öæ6–ÆRF–6²v—F‚æò&÷FV7F–öâà¢–b‡6Ä÷&FW$–BÓÓÒ%$”4Uô5$õ54TB"ÇÂG÷&FW$–BÓÓÒ%$”4Uô5$õ54TB"’°¢6öç7B7&÷76VDÆVrÒ6Ä÷&FW$–BÓÓÒ%$”4Uô5$õ54TB"ò%7F÷Æ÷72"¢%F¶U&öf—B ¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡ÒG¶7&÷76VDÆVwÒ$”4Uô5$õ54TBf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÒ(	BG&–vvW&–ær–ÖÖVF–FRf÷&6RÖ6Æ÷6VÀ¢¢Æ—fU÷6—F–öâæ6Æ÷6U&V6öâÒ'&÷FV7F–öå÷&–6Uö7&÷76VEöE÷Æ6VÖVçB ¢6öç7B6Æ÷6U&W7VÇBÒv—B6Æ÷6TÆ—fU÷6—F–öâ€¢6öææV7F–öä–BÀ¢Æ—fU÷6—F–öâæ–BÀ¢À¢W†6†ævT6öææV7F÷"À¢G¶7&÷76VDÆVwÒ&–6R7&÷76VBÖ&¶WBB–æ—F–ÂÆ6VÖVçFÀ¢¢–b†6Æ÷6U&W7VÇB’ö&¦V7Bæ76–vâ†Æ—fU÷6—F–öâÂ6Æ÷6U&W7VÇB¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢òò%TõDôU„4TTDTB"6VçF–æVÃ¢66÷VçBEõ4Â÷&FW"Æ–Ö—B&V6†VB„&–æu‚#b’à¢òòÖ&²F†R6öææV7F–öâ2V÷FÖ&Æö6¶VB6ò&V6öæ6–ÆR&6·2öfbf÷"c2à¢òòÆVfR÷&FW$–B÷&–6RB(	BF†R÷6—F–öâ—2Æ—fRv—F†÷WB&÷FV7F–öâà¢–b‡6Ä÷&FW$–BÓÓÒ%TõDôU„4TTDTB"ÇÂG÷&FW$–BÓÓÒ%TõDôU„4TTDTB"’°¢Ö&µ&÷FV7F–öåV÷FW††W7FVB†6öææV7F–öä–B¢–æ—F–Ä66—G”'VFvWCòæÖ&´W††W7FVB‚¢Æ—fU÷6—F–öâç&÷FV7F–öäÖöFRÒ'7—7FVÕö6Æ÷6UöfÆÆ&6² ¢–b‡6Ä÷&FW$–BÓÓÒ%TõDôU„4TTDTB"bbÆ—fU÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'2’°¢FVÆWFRÆ—fU÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'2ç7F÷Æ÷70¢Ð¢–b‡G÷&FW$–BÓÓÒ%TõDôU„4TTDTB"bbÆ—fU÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'2’°¢FVÆWFRÆ—fU÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'2çF¶U&öf—@¢Ð¢Ð ¢6öç7B6Ä–EfÆ–BÒ6Ä÷&FW$–Bbb6Ä÷&FW$–BÓÒ%$”4Uô5$õ54TB"bb6Ä÷&FW$–BÓÒ'÷6—F–öåöW††W7FVB"bb6Ä÷&FW$–BÓÒ%TõDôU„4TTDTB"bb6Ä÷&FW$–BÓÒ%5•5DTÕôdÄÄ$4² ¢6öç7BG–EfÆ–BÒG÷&FW$–BbbG÷&FW$–BÓÒ%$”4Uô5$õ54TB"bbG÷&FW$–BÓÒ'÷6—F–öåöW††W7FVB"bbG÷&FW$–BÓÒ%TõDôU„4TTDTB"bbG÷&FW$–BÓÒ%5•5DTÕôdÄÄ$4²  ¢–b‡6Ä–EfÆ–B’°¢Æ—fU÷6—F–öâç7F÷Æ÷74÷&FW$–BÒ6Ä÷&FW$–B¢Æ—fU÷6—F–öâç7F÷Æ÷75&–6RÒ6Å&–6P¢6WE&÷FV7F–öäÆVt&ÖVEVçF—G’†Æ—fU÷6—F–öâÂ'7F÷öÆ÷72"Â6ÅÆ6VÖVçBæ&ÖVEVçF—G’¢–b†Æ—fU÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'2’FVÆWFRÆ—fU÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'2ç7F÷Æ÷70¢6WE7—7FVÕ&÷FV7F–öäÆVr†Æ—fU÷6—F–öâÂ'7F÷öÆ÷72"ÂfÇ6R¢ÒVÇ6R°¢&VÆV6U&÷FV7F–öä66—G•&W6W'fF–öâ†–æ—F–Ä66—G”'VFvWBÂÆ—fU÷6—F–öâÂ6Ä66—G’ç&W6W'fF–öä–B¢6WE&÷FV7F–öäÆVt&ÖVEVçF—G’†Æ—fU÷6—F–öâÂ'7F÷öÆ÷72"Â¢Ð¢–b‡6Å&–6Râbb6Ä÷&FW$–BÓÒ%TõDôU„4TTDTB"bb6Ä÷&FW$–BÓÒ%5•5DTÕôdÄÄ$4²"bb6Ä–EfÆ–B’°¢òò7W&f6RF†R&÷FV7F–öâvÆ÷VFÇ’6ò÷W&F÷'2æBF†P¢òòF6†&ö&B6VR—C²F†RæW‡B&V6öæ6–ÆRv–ÆÂ&WG'’à¢6öç6öÆRæW'&÷"€¢G´Äôuõ$Td•‡Ò”ä•D”Â7F÷Æ÷72Æ6VÖVçBd”ÄTBf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÒ(	B÷6—F–öâ—2Ä•dRv—F†÷WB4ÂVçF–ÂæW‡B&V6öæ6–ÆRF–6¶À¢¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&W'&÷""À¢7F÷Æ÷72äõBÆ6VBf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÒ(	B&V6öæ6–ÆRv–ÆÂ&WG'–À¢²Æ—fU÷6—F–öä–C¢Æ—fU÷6—F–öâæ–BÂFW6—&VE6Ã¢6Å&–6RÂW†V7WFVEG“¢Æ—fU÷6—F–öâæW†V7WFVEVçF—G’ÒÀ¢¢W6…7FW†Æ—fU÷6—F–öâÂ'Æ6U÷7F÷öÆ÷72"ÂfÇ6RÂ–æ—F–Â4ÂÆ6VÖVçBf–ÆVBG·6Å&–6WÖ¢Ð¢–b‡G–EfÆ–B’°¢Æ—fU÷6—F–öâçF¶U&öf—D÷&FW$–BÒG÷&FW$–B¢Æ—fU÷6—F–öâçF¶U&öf—E&–6RÒG&–6P¢6WE&÷FV7F–öäÆVt&ÖVEVçF—G’†Æ—fU÷6—F–öâÂ'F¶U÷&öf—B"ÂGÆ6VÖVçBæ&ÖVEVçF—G’¢–b†Æ—fU÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'2’FVÆWFRÆ—fU÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'2çF¶U&öf—@¢6WE7—7FVÕ&÷FV7F–öäÆVr†Æ—fU÷6—F–öâÂ'F¶U÷&öf—B"ÂfÇ6R¢ÒVÇ6R°¢&VÆV6U&÷FV7F–öä66—G•&W6W'fF–öâ†–æ—F–Ä66—G”'VFvWBÂÆ—fU÷6—F–öâÂG66—G’ç&W6W'fF–öä–B¢6WE&÷FV7F–öäÆVt&ÖVEVçF—G’†Æ—fU÷6—F–öâÂ'F¶U÷&öf—B"Â¢Ð¢–b‡G&–6RâbbG÷&FW$–BÓÒ%TõDôU„4TTDTB"bbG÷&FW$–BÓÒ%5•5DTÕôdÄÄ$4²"bbG–EfÆ–B’°¢6öç6öÆRæW'&÷"€¢G´Äôuõ$Td•‡Ò”ä•D”ÂF¶U&öf—BÆ6VÖVçBd”ÄTBf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÒ(	B÷6—F–öâ—2Ä•dRv—F†÷WBEVçF–ÂæW‡B&V6öæ6–ÆRF–6¶À¢¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&W'&÷""À¢F¶U&öf—BäõBÆ6VBf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÒ(	B&V6öæ6–ÆRv–ÆÂ&WG'–À¢²Æ—fU÷6—F–öä–C¢Æ—fU÷6—F–öâæ–BÂFW6—&VEG¢G&–6RÂW†V7WFVEG“¢Æ—fU÷6—F–öâæW†V7WFVEVçF—G’ÒÀ¢¢W6…7FW†Æ—fU÷6—F–öâÂ'Æ6U÷F¶U÷&öf—B"ÂfÇ6RÂ–æ—F–ÂEÆ6VÖVçBf–ÆVBG·G&–6WÖ¢Ð¢òò&V6÷&BF†RG’4ÂõEvW&R&ÖVBf÷"6òF†RæW‡B&V6öæ6–ÆP¢òò726âFWFV7BVçF—G’G&–gB†FVÆ–VB'F–Âf–ÆÇ2À¢òò67V×VÆF–öâÖW&vW2’æB&RÖ&Òâv—F†÷WBF†—2F†RG&–g@¢òòFWFV7F÷"–âWFFU&÷FV7F–öä÷&FW'6v÷VÆB6VRâVæFVf–æV@¢òò&6VÆ–æRæB&RÖ&ÒöâWfW'’7–6ÆRWfVâv†Vâæ÷F†–ær6†ævVBà¢òð¢òòöæÇ’6WBv†VâBÆV7BöæRÆVr7V66VVFVB(	B÷F†W'v—6RF†RæW‡@¢òò&V6öæ6–ÆRv÷VÆBG&VBF†R÷6—F–öâ2&&ÖVBf÷"7W'&VçBG’ ¢òòæBæWfW"&WG'’F†Rf–ÆVBÆVw2&V6W6RG”G&–gFVB—2fÇ6Rà¢–b‡6Ä–EfÆ–BÇÂG–EfÆ–B’°¢&Vg&W6„ÆVv7•&÷FV7F–öä&ÖVEVçF—G’†Æ—fU÷6—F–öâ¢òò&–ÖRF†R6ööÆF÷vâ6òF†Rf—'7B32öb&V6öæ6–ÆRF–6·26ææ÷@¢òòG&–gBÖ6æ6VÂ×&WÆ6R÷&FW'2vR§W7BÆ6VBÖ–ÆÆ—6V6öæG2vòà¢6öç7Bæ÷t×2ÒFFRææ÷r‚¢–b‡6Ä–EfÆ–B’Æ—fU÷6—F–öâç7F÷Æ÷74Æ7D&ÖVDBÒæ÷t×0¢–b‡G–EfÆ–B’Æ—fU÷6—F–öâçF¶U&öf—DÆ7D&ÖVDBÒæ÷t×0¢Ð¢&Vg&W6…&÷FV7F–öä†æFÆ–ætÖöFR†Æ—fU÷6—F–öâÂ6Å&–6RÂG&–6R¢–b†–æ—F–Ä66—G”'VFvWB’Æ—fU÷6—F–öâæ6öçG&öÄ÷&FW$66—G’Ò–æ—F–Ä66—G”'VFvWBç6æ6†÷B‚¢6öç7B6ÅfVçVT÷&FW$–BÒ6Ä–EfÆ–Bò7G&–ær‡6Ä÷&FW$–B’¢çVÆÀ¢6öç7BGfVçVT÷&FW$–BÒG–EfÆ–Bò7G&–ær‡G÷&FW$–B’¢çVÆÀ ¢òò7FW&V6÷&B²&öw&W76–öâÆör6''’$õD‚F†R76–væVBW&6Vç@¢òòæBF†R&W7VÇF–ær'6öÇWFRG&–vvW"&–6RÂ6òâ÷W&F÷ ¢òò&VF–ærF†RF–ÖVÆ–æRæWfW"†2FòÖVçFÆÇ’&V6öç7G'V7BöæP¢òòg&öÒF†R÷F†W"â76–væVE7F÷Æ÷76ö76–væVEF¶U&öf—Fæ@¢òò7F÷Æ÷76öF¶U&öf—F&RWVÂBF†—2ö–çB†–æ—F–À¢òòÆ6VÖVçB“²öâÆFW"÷fW'&–FW2F†RÖW76vRv–ÆÂ6†÷r&÷F‚à¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢'Æ6U÷6Å÷G"À¢&ööÆVâ‡6ÅfVçVT÷&FW$–BÇÂGfVçVT÷&FW$–BÇÂÆ—fU÷6—F–öâç7—7FVÕ&÷FV7F–öäÆVw3òæÆVæwF‚’À¢4ÂG¶Æ—fU÷6—F–öâç7F÷Æ÷77ÒR(i"G·6Å&–6Rò6Å&–6RçFôf—†VBƒb’¢.(	B'Ò‚G·6ÅfVçVT÷&FW$–BÇÂ‡6Å&–6Râò'7—7FVÒ"¢.(	B"—Ò’Â°¢EG¶Æ—fU÷6—F–öâçF¶U&öf—GÒR(i"G·G&–6RòG&–6RçFôf—†VBƒb’¢.(	B'Ò‚G·GfVçVT÷&FW$–BÇÂ‡G&–6Râò'7—7FVÒ"¢.(	B"—Ò– ¢¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&–æfò"À¢4ÂõE†æFÆ–ær6ö÷&F–æFVBf÷"G·&VÅ÷6—F–öâç7–Ö&öÇÒB76–væVBfÇVW6À¢°¢òò76–væVB†–Ö×WF&ÆR7G&FVw’6öçG&7B’æB7W'&Vç@¢òò†×WF&ÆRÂ÷fW'&–FRÖv&R’W&6VçB—'2(	BWVÂöâf—'7@¢òòÆ6VÖVçBÂ6âF—fW&vRgFW"&V6Æ7VÆFTæDÇ•4ÅEà¢76–væVE7F÷Æ÷757C¢Æ—fU÷6—F–öâæ76–væVE7F÷Æ÷72À¢76–væVEF¶U&öf—E7C¢Æ—fU÷6—F–öâæ76–væVEF¶U&öf—BÀ¢7F÷Æ÷757C¢Æ—fU÷6—F–öâç7F÷Æ÷72À¢F¶U&öf—E7C¢Æ—fU÷6—F–öâçF¶U&öf—BÀ¢6Ä÷&FW$–C¢6ÅfVçVT÷&FW$–BÀ¢6Å&–6RÀ¢G÷&FW$–C¢GfVçVT÷&FW$–BÀ¢G&–6RÀ¢f–ÆÅ&–6S¢Æ—fU÷6—F–öâæfW&vTW†V7WF–öå&–6RÀ¢&÷FV7F–öäÖöFS¢Æ—fU÷6—F–öâç&÷FV7F–öäÖöFRÀ¢7—7FVÕ&÷FV7F–öäÆVw3¢Æ—fU÷6—F–öâç7—7FVÕ&÷FV7F–öäÆVw2À¢6öçG&öÄ÷&FW$66—G“¢Æ—fU÷6—F–öâæ6öçG&öÄ÷&FW$66—G’À¢ÒÀ¢ ¢6öç7B&÷uVçF—G•FöÆW&æ6RÒÖF‚æÖ‚€¢RÓÀ¢çVÖ&W"†Æ—fU÷6—F–öâçVçF—G•7FWÇÂ’ò"À¢çVÖ&W"†Æ—fU÷6—F–öâæW†V7WFVEVçF—G’ÇÂ’¢RÓ‚À¢¢6öç7B&÷u&÷FV7F–öä6ö×ÆWFRÒ&ööÆVâ‡6ÅfVçVT÷&FW$–BbbGfVçVT÷&FW$–B¢bbÖF‚æ'2€¢&÷FV7F–öäÆVt&ÖVEVçF—G’†Æ—fU÷6—F–öâÂ'7F÷öÆ÷72"¢ÒçVÖ&W"†Æ—fU÷6—F–öâæW†V7WFVEVçF—G’ÇÂ¢’ÃÒ&÷uVçF—G•FöÆW&æ6P¢bbÖF‚æ'2€¢&÷FV7F–öäÆVt&ÖVEVçF—G’†Æ—fU÷6—F–öâÂ'F¶U÷&öf—B"¢ÒçVÖ&W"†Æ—fU÷6—F–öâæW†V7WFVEVçF—G’ÇÂ¢’ÃÒ&÷uVçF—G•FöÆW&æ6P¢–b‚&÷u&÷FV7F–öä6ö×ÆWFR’°¢v—B&öÆÆ&6´VçG'•v—F†÷WD6ö×ÆWFU&÷FV7F–öâ€¢$–æ—F–ÂVçG'’F–Bæ÷B&V6V—fR—G2W†7B×VçF—G’fVçVR7F÷Æ÷72æBF¶R&öf—B"À¢°¢âââ‚6ÅfVçVT÷&FW$–Bò²&VçG'•÷7F÷öÆ÷75öÖ—76–ær%Ò¢µÒ’À¢âââ‚GfVçVT÷&FW$–Bò²&VçG'•÷F¶U÷&öf—EöÖ—76–ær%Ò¢µÒ’À¢&VçG'•÷&÷u÷&÷FV7F–öå÷VçF—G•÷VçfW&–f–VB"À¢ÒÀ¢¢&WGW&âÆ—fU÷6—F–öà¢Ð¢ÒVÇ6R°¢W6…7FW†Æ—fU÷6—F–öâÂ'Æ6U÷6Å÷G"ÂfÇ6RÂ'6¶—VB(	Bæòf–ÆÂ–WB"¢òò&W7öç6RÖÖ&–wV÷W2Ö&¶WBVçG'’Ö’Ç&VG’†fR&V6†VBF†RfVçVRà¢òòæWfW"÷Vâæ÷F†W"&÷r&V†–æB—Bâ&V6öæ6–Æ–F–öâ¶VW2&V6÷fW&–ærF†—0¢òòW†7B6Æ–VçBö÷&FW"–BæBv–ÆÂ&Ò&÷FV7F–öâ26ööâ2VçF—G’—0¢òòWF†÷&—FF—fS²F†R†ÇBW‡—&W2öæÇ’2Æ7B×&W6÷'B÷W&F÷"wV&Bà¢v—B6Æ–VçBç6WFW‚€¢VçG'•&÷FV7F–öä†ÇD¶W’À¢#B¢c¢cÀ¢¥4ôâç7G&–æv–g’‡²C¢FFRææ÷r‚’Â&V6öã¢&VçG'•öf–ÆÅ÷Væ6öæf—&ÖVB"Ò’À¢’æ6F6‚‚‚’Óâ·Ò¢Æ—fU÷6—F–öâç7FGW5&V6öâÐ¢$VçG'’f–ÆÂ—2Væ6öæf—&ÖVC²æWrVçG&–W2†ÇFVBVçF–ÂW†7B&V6÷fW'’æB&÷FV7F–öâ&V6öæ6–Æ–F–öâ ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&W'&÷""À¢Æ—fU÷6—F–öâç7FGW5&V6öâÀ¢²7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÂF—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÒÀ¢’æ6F6‚‚‚’Óâ·Ò¢&WGW&âÆ—fU÷6—F–öà¢Ð ¢òò)H)H7FWƒ¢7–æ2v—F‚W†6†ævRf÷"÷6—F–öâFF)H)H)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞûûÞ)H)H)H)H)H)H)H)H ¢–b‡G—VöbW†6†ævT6öææV7F÷"ævWE÷6—F–öâÓÓÒ&gVæ7F–öâ"’°¢G'’°¢òò72F—&V7F–öâf÷"†VFvRÖÖöFR66÷VçG2à¢6öç7BW…÷2Òv—BW†6†ævT6öææV7F÷"ævWE÷6—F–öâ€¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢&VÅ÷6—F–öâæF—&V7F–öâ2&Æöær"Â'6†÷'B"À¢¢–b†W…÷2’°¢Æ—fU÷6—F–öâæW†6†ævTFFÒ°¢âââ†Æ—fU÷6—F–öâæW†6†ævTFFÇÂ·Ò’À¢Ö&v–åG—S¢†W…÷22ç’’æÖ&v–åG—RÀ¢Ö&µ&–6S¢†W…÷22ç’’æÖ&µ&–6RÀ¢Æ—V–FF–öå&–6S¢†W…÷22ç’’æÆ—V–FF–öå&–6RÀ¢Vç&VÆ—¦VEæÃ¢†W…÷22ç’’çVç&VÆ—¦VEæÂÀ¢&ö“¢†W…÷22ç’’ç&ö’À¢Ð¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢&W†6†ævU÷7–æ2"À¢G'VRÀ¢Æ—&–6SÒG²†W…÷22ç’’æÆ—V–FF–öå&–6WÒÖ&µ&–6SÒG²†W…÷22ç’’æÖ&µ&–6WÖ ¢¢ÒVÇ6R°¢W6…7FW†Æ—fU÷6—F–öâÂ&W†6†ævU÷7–æ2"ÂfÇ6RÂ&æò÷6—F–öâ&WGW&æVB"¢Ð¢Ò6F6‚†W'"’°¢W6…7FW†Æ—fU÷6—F–öâÂ&W†6†ævU÷7–æ2"ÂfÇ6RÂ7G&–ær†W'"’¢Ð¢Ð ¢–b†Æ—fU÷6—F–öâç7FGW2ÓÓÒ&f–ÆÆVB"’Æ—fU÷6—F–öâç7FGW2Ò&÷Vâ  ¢òòW'6—7BF†R6öæf—&ÖVB&÷r6öçG&öÇ2ÂF†Vâ–ÖÖVF–FVÇ’&V6öæ6–ÆRF†P¢òò‡—6–6Â6Æ÷B6ò—G26–ævÆRvw&VvFR×VçF—G’6V7W&—G’7F÷—2æ÷BFVfW'&VBFð¢òòÆFW"66†VGVÆW"F–6²à¢ÆWB–æ—F–Å6V7W&—G•&V6öæ6–ÆTf–ÆVBÒfÇ6P¢–b†Æ—fU÷6—F–öâæW†V7WFVEVçF—G’âbbG—VöbW†6†ævT6öææV7F÷"ævWE÷6—F–öç2ÓÓÒ&gVæ7F–öâ"’°¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢G'’°¢6öç7B¶ÆÅ&÷w2ÂfVçVU&÷w2Â÷&FW$–G5ÒÒv—B&öÖ—6RæÆÂ…°¢vWDÆ—fU÷6—F–öç2†6öææV7F–öä–B’À¢W†6†ævT6öææV7F÷"ævWE÷6—F–öç2‚’À¢fWF6„Æ—fT÷&FW$–E6WB†W†6†ævT6öææV7F÷"’À¢Ò¢6öç7BfVçVU6æ6†÷Dö²ÒG—VöbW†6†ævT6öææV7F÷"ævWDÆ7E÷6—F–öç56æ6†÷E7FGW2ÓÓÒ&gVæ7F–öâ ¢òW†6†ævT6öææV7F÷"ævWDÆ7E÷6—F–öç56æ6†÷E7FGW2‚“òæö²ÓÓÒG'VP¢¢'&’æ—4'&’‡fVçVU&÷w2¢–b‚fVçVU6æ6†÷Dö²ÇÂ'&’æ—4'&’‡fVçVU&÷w2’ÇÂ÷&FW$–G2ÓÓÒçVÆÂ’°¢F‡&÷ræWrW'&÷"‚&WF†÷&—FF—fR÷6—F–öâö÷&FW"6æ6†÷BVæf–Æ&ÆRf÷"–æ—F–Â6V7W&—G’7F÷"¢Ð¢6öç7B&÷w4'”–BÒæWrÖ†ÆÅ&÷w2æÖ‚‡&÷r’Óâ·&÷ræ–BÂ&÷uÒ’¢&÷w4'”–Bç6WB†Æ—fU÷6—F–öâæ–BÂÆ—fU÷6—F–öâ¢v—B&V6öæ6–ÆTvw&VvFU&÷FV7F–öä&öö²€¢6öææV7F–öä–BÀ¢W†6†ævT6öææV7F÷"À¢²ââç&÷w4'”–BçfÇVW2‚•ÒÀ¢fVçVU&÷w2À¢÷&FW$–G2À¢¢6öç7B&Vg&W6†VBÒv—B&VDÆ—fU÷6—F–öå6æ6†÷B†6Æ–VçBÂ6öææV7F–öä–BÂÆ—fU÷6—F–öâæ–B¢–b‡&Vg&W6†VB’ö&¦V7Bæ76–vâ†Æ—fU÷6—F–öâÂ&Vg&W6†VB¢Ò6F6‚†W'&÷"’°¢–æ—F–Å6V7W&—G•&V6öæ6–ÆTf–ÆVBÒG'VP¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢&–æ—F–Å÷6V7W&—G•÷&V6öæ6–ÆR"À¢fÇ6RÀ¢W'&÷"–ç7Fæ6VöbW'&÷"òW'&÷"æÖW76vR¢7G&–ær†W'&÷"’À¢¢Ð¢Ð ¢–b†Æ—fU÷6—F–öâæW†V7WFVEVçF—G’â’°¢ÆWBf–æÄFÖ—76–öã¢VçG'•&÷FV7F–öäFÖ—76–öäFV6—6–öâÂçVÆÂÒçVÆÀ¢G'’°¢f–æÄFÖ—76–öâÒv—BVF—DVçG'•&÷FV7F–öä&Vf÷&UfVçVT×WFF–öâ‡°¢6öææV7F–öä–BÀ¢7–Ö&öÃ¢&VÅ÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢6öææV7F÷#¢W†6†ævT6öææV7F÷"À¢&WV—&T66—G“¢fÇ6RÀ¢Ò¢Ò6F6‚†W'&÷"’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò÷7BÖVçG'’&÷FV7F–öâfW&–f–6F–öâf–ÆVC¢G¶W'&÷"–ç7Fæ6VöbW'&÷"òW'&÷"æÖW76vR¢7G&–ær†W'&÷"—ÖÀ¢¢Ð¢–b†–æ—F–Å6V7W&—G•&V6öæ6–ÆTf–ÆVBÇÂf–æÄFÖ—76–öãòç6fR’°¢v—B&öÆÆ&6´VçG'•v—F†÷WD6ö×ÆWFU&÷FV7F–öâ€¢%÷7BÖVçG'’fVçVRVF—B6÷VÆBæ÷B&÷fR&÷rEõ4ÂÇW2gVÆÂ×6Æ÷B6V7W&—G’&÷FV7F–öâ"À¢°¢âââ†–æ—F–Å6V7W&—G•&V6öæ6–ÆTf–ÆVBò²&VçG'•÷6V7W&—G•÷&V6öæ6–ÆUöf–ÆVB%Ò¢µÒ’À¢âââ†f–æÄFÖ—76–öãòçf–öÆF–öç2ÇÂ²'÷7EöVçG'•öWF†÷&—FF—fUöVF—E÷Væf–Æ&ÆR%Ò’À¢ÒÀ¢¢&WGW&âÆ—fU÷6—F–öà¢Ð¢v—B6Æ–VçBæFVÂ†VçG'•&÷FV7F–öä†ÇD¶W’’æ6F6‚‚‚’Óâ¢W6…7FW€¢Æ—fU÷6—F–öâÀ¢&VçG'•÷&÷FV7F–öå÷fW&–f–VB"À¢G'VRÀ¢&÷t6öçG&öÇ3Ó#²6V7W&—G”6öçG&öÇ3Ó²÷væVE&÷w3ÒG¶f–æÄFÖ—76–öâæVF—Bæ÷væVDW†V7WFVE&÷w7ÖÀ¢¢Ð ¢òò)H)HTåE%’5TÔÔ%’(	BöæRÆörÆ–æR6†÷v–ærF†R6ö×ÆWFRVçG'’7FFR)H)H)H)H)H)H)H)H ¢òò÷W&F÷"6âw&W%´TåE%•Ò"Fò6VRWfW'’Æ—fR÷6—F–öâF†BvVçBF‡&÷Vv€¢òòF†RgVÆÂ—VÆ–æRæBVæFW'7FæBföÇVÖRòÆWfW&vRò&÷FV7F–öâ–â6öçFW‡Bà¢°¢6öç7B7VÖÖ'•&÷FV7F–öâÒ6ö×WFTFW6—&VE&÷FV7F–öå&–6W2†Æ—fU÷6—F–öâ¢6öç7B7VÖÖ'”F—&V7F–öâÒ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ†Æ—fU÷6—F–öâ¢6öç7B7VÖÖ'•F–6²ÒçVÖ&W"†Æ—fU÷6—F–öâç&–6UF–6²ÇÂ¢6öç7B7VÕ6ÂÒæ÷&ÖÆ—¦U&÷FV7F–öåG&–vvW%&–6R€¢7VÖÖ'•&÷FV7F–öâæFW6—&VE6ÂÀ¢7VÖÖ'•F–6²À¢7VÖÖ'”F—&V7F–öâÀ¢'7F÷öÆ÷72"À¢¢6öç7B7VÕGÒæ÷&ÖÆ—¦U&÷FV7F–öåG&–vvW%&–6R€¢7VÖÖ'•&÷FV7F–öâæFW6—&VEGÀ¢7VÖÖ'•F–6²À¢7VÖÖ'”F—&V7F–öâÀ¢'F¶U÷&öf—B"À¢¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Ò´TåE%•ÒG·&VÅ÷6—F–öâç7–Ö&öÇÒG·&VÅ÷6—F–öâæF—&V7F–öãòçFõWW$66R‚—Ò°¢G“ÒG¶Æ—fU÷6—F–öâæW†V7WFVEVçF—G“òçFôf—†VBƒb’óò#ò'Ò°¢G¶Æ—fU÷6—F–öâæfW&vTW†V7WF–öå&–6SòçFôf—†VBƒb’óò#ò'Ò°¢æ÷F–öæÃÒBG¶Æ—fU÷6—F–öâçföÇVÖUW6CòçFôf—†VBƒ"’óò#ò'Ò°¢ÆWcÒG¶Æ—fU÷6—F–öâæÆWfW&vRóò#ò'×‚°¢÷&FW$–CÒG¶Æ—fU÷6—F–öâæ÷&FW$–Bóò#ò'Ò°¢4ÃÒG·7VÕ6Ââò7VÕ6ÂçFôf—†VBƒb’¢&æöæR'Ò†–CÒG¶Æ—fU÷6—F–öâç7F÷Æ÷74÷&FW$–Bóò.(	B'Ò’°¢EÒG·7VÕGâò7VÕGçFôf—†VBƒb’¢&æöæR'Ò†–CÒG¶Æ—fU÷6—F–öâçF¶U&öf—D÷&FW$–Bóò.(	B'Ò’°¢4T3ÒG´çVÖ&W"†Æ—fU÷6—F–öâç6V7W&—G•7F÷&–6RÇÂ’âòçVÖ&W"†Æ—fU÷6—F–öâç6V7W&—G•7F÷&–6R’çFôf—†VBƒb’¢'VæF–ær'Ò°¢†–CÒG¶Æ—fU÷6—F–öâç6V7W&—G•7F÷÷&FW$–Bóò.(	B'Ò’°¢7FGW3ÒG¶Æ—fU÷6—F–öâç7FGW7Ö ¢¢Ð ¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ ¢òòöæÇ’6÷VçBF†—22&VÂ'÷6—F–öâ7&VFVB"v†VâF†RVçG'¢òò÷&FW"7GVÆÇ’f–ÆÆVBöâF†RW†6†ævRâ&Wf–÷W6Ç’vR'V×VBF†—0¢òò6÷VçFW"Væ6öæF—F–öæÆÇ’(	B–æ6ÇVF–ærv†VâöÆÄ÷&FW$f–ÆÂF–ÖV@¢òò÷WB(	Bv†–6‚6W6VBF†RF6†&ö&BFò6†÷rv†÷7B÷6—F–öç0¢òò†÷6—F–öç27&VFVFâ¦W&òv—F‚÷&FW'2f–ÆÆVF7F–ÆÂ’âF†P¢òòW6W"W‡Æ–6—FÇ’&W÷'FVBF†—27–ÖÖWG'’âW6RW†V7WFVEVçF—G’0¢òòF†R6÷W&6RöbG'WFƒ¢—Bw2öæÇ’6WBöæ6RF†Rf–ÆÂ—26öæf—&ÖV@¢òò†Æ–æRCS’÷"7–æ2Ö6öæf—&ÖVB†W†V7WFTÆ—fU÷6—F–öâW†6†ævP¢òò7–æ2&Æö6²&÷fR’à¢6öç7B†5&VÄf–ÆÂÒ†Æ—fU÷6—F–öâæW†V7WFVEVçF—G’ÇÂ’â ¢–b††5&VÄf–ÆÂ’°¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fU÷÷6—F–öç5ö7&VFVEö6÷VçB"¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fU÷föÇVÖU÷W6E÷F÷FÂ"ÂÖF‚ç&÷VæB†Æ—fU÷6—F–öâçföÇVÖUW6B’¢òòW6VBÖ&Ææ6R†Ö&v–â’7V×VÆF—fR6÷VçFW"(	BG&6²–â4TåE26ð¢òò6ÖÆÂÖ&v–ç2†RærâCRæ÷F–öæÂò#W‚ÆWfW&vRÒCãB¢òò7W'f—fR–çFVvW"&÷VæF–ærâ&VFW"F—f–FW2'’FòF—7Æ’U4Bà¢òòF†RÆVv7’Æ—fUöÖ&v–å÷W6E÷F÷FÆ6÷VçFW"—2æòÆöævW ¢òòw&—GFVã¢&÷VæF–ærç’F–ç’Ö&v–âFòv†öÆRFöÆÆ"†÷"Fò¢òò&öGV6VBÖ—6ÆVF–ærçVÖ&W"ÂæBF†R7FG2&VFW"æ÷r&VfW'0¢òòÆ—fUöÖ&v–åö6VçG5÷F÷FÆà¢6öç7BÆWbÒÖF‚æÖ‚ƒÂçVÖ&W"†Æ—fU÷6—F–öâæÆWfW&vR’ÇÂ¢6öç7BæWtÖ&v–âÒ†Æ—fU÷6—F–öâçföÇVÖUW6BÇÂ’òÆW`¢–b„çVÖ&W"æ—4f–æ—FR†æWtÖ&v–â’bbæWtÖ&v–ââ’°¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUöÖ&v–åö6VçG5÷F÷FÂ"ÂÖF‚ç&÷VæB†æWtÖ&v–â¢’¢Ð¢Ð¢òò)H)H5$•D”4Âd•ƒ¢–æ6ÇVFRgVÆÂ&VÂ÷6—F–öâ6öçFW‡B–â&öw&W76–öâ)H)H ¢òòF†—2Æöw2F†R6ö×ÆWFRÆ–æVvRg&öÒ&VÂ6WB(i"Æ—fRW†V7WF–öâÀ¢òòÆÆ÷v–ærF6†&ö&G2FòG&6R&6²v†–6‚7G&FVw’6öæf–wW&F–öà¢òòæB†—2v–æF÷r7FFR&öGV6VBF†—2Æ—fR÷6—F–öââ&Wf–÷W6Ç’À¢òòF†—26öçFW‡Bv2Æ÷7BgFW"7&VF–öâÂ'&V¶–ærF†R'&VÆ’&6²Fð¢òò÷&–v–æÂ&öw&W72"Æ–æ²f÷"UD‚õ4ôÂæB÷F†W"×VÇF’×6WB7–Ö&öÇ2à¢v—BÆöu&öw&W76–öäWfVçB†6öææV7F–öä–BÂ&Æ—fU÷G&F–ær"Â&–æfò"ÂÆ—fR÷6—F–öâ7&VFVBG·&VÅ÷6—F–öâç7–Ö&öÇÖÂ°¢Æ—fU÷6—F–öä–C¢Æ—fU÷6—F–öâæ–BÀ¢&VÅ÷6—F–öä–C¢&VÅ÷6—F–öâæ–BÀ¢7FGW3¢Æ—fU÷6—F–öâç7FGW2À¢÷&FW$–C¢Æ—fU÷6—F–öâæ÷&FW$–BÀ¢W†V7WFVEVçF—G“¢Æ—fU÷6—F–öâæW†V7WFVEVçF—G’À¢föÇVÖUW6C¢Æ—fU÷6—F–öâçföÇVÖUW6BÀ¢òò)H)H&VÂ÷6—F–öâ6öçFW‡B†7&—F–6Âf÷"×VÇF’×7–Ö&öÂò×VÇF’×6WBFV'Vvv–ær’)H)H ¢&VÅ6WD¶W“¢&VÅ÷6—F–öâç6WD¶W’À¢&VÅ&VçE6WD¶W“¢&VÅ÷6—F–öâç&VçE6WD¶W’À¢&VÅ6WEf&–çC¢&VÅ÷6—F–öâç6WEf&–çBÀ¢&VÄ†—5v–æF÷w3¢&VÅ÷6—F–öâæ†—5v–æF÷w2À¢òò)H)HVçG'’ÖWG&–72ûûÞûûÞ)H ¢ÆWfW&vS¢&VÅ÷6—F–öâæÆWfW&vRÀ¢VçF—G“¢&VÅ÷6—F–öâçVçF—G’À¢F—&V7F–öã¢&VÅ÷6—F–öâæF—&V7F–öâÀ¢Ò ¢&WGW&âÆ—fU÷6—F–öà¢Ò6F6‚†W'"’°¢6öç7BW'$×6rÒW'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"¢6öç7BW'%7F6²ÒW'"–ç7Fæ6VöbW'&÷"òW'"ç7F6²¢VæFVf–æV@¢6öç6öÆRæW'&÷"†G´Äôuõ$Td•‡ÒVæ†æFÆVBW'&÷#¦ÂW'$×6rÂW'%7F6²ÇÂ""¢òòöæ6RfVçVR&WVW7BÖ’†fRÆVgBF†R&ö6W72ÂF†RÆö6Â&÷r—2à¢òòVç&W6öÇfVBFVÆ—fW'’ÂæWfW"6öæf—&ÖVBf–ÆVBVçG'’â¶VW—BVæF–ær6ð¢òò&V6öæ6–Æ–F–öâ6â&V6÷fW"âW†6†ævR÷&FW"÷÷6—F–öâ'’6Æ–VçB–Bæ@¢òò†ÇBFF—F–öæÂVçG&–W2VçF–ÂF†R&÷FV7F–öâ6öçG&7B—2&RÖW7F&Æ—6†VBà¢òòöæÇ’W'&÷'2&—6VB&Vf÷&Rç’7V&Ö—76–öâ&VÆöær–âF†RF–væ÷7F–0¢òò&VfÆ–v‡B'V6¶WBà¢6öç7BfVçVU&WVW7E7F'FVBÒW†6†ævU7V&Ö—76–öå7F'FVBÇÂÆ6TGFV×Bâ ¢6öç7B66WFVD÷&FW$¶æ÷vâÒ&ööÆVâ€¢Æ—fU÷6—F–öâæ÷&FW$–@¢ÇÂÆ—fU÷6—F–öâç7V&Ö—76–öå7FFRÓÓÒ&6öæf—&ÖVB ¢ÇÂÆ—fU÷6—F–öâç7V&Ö—76–öå7FFRÓÓÒ'Væ6öæf—&ÖVB"À¢¢–b‡fVçVU&WVW7E7F'FVBÇÂ66WFVD÷&FW$¶æ÷vâ’°¢Æ—fU÷6—F–öâç7FGW2ÒÆ—fU÷6—F–öâæW†V7WFVEVçF—G’âò&÷Vâ"¢'Æ6VE÷Væ6öæf—&ÖVB ¢Æ—fU÷6—F–öâç7V&Ö—76–öå7FFRÒÆ—fU÷6—F–öâç7V&Ö—76–öå7FFRÓÓÒ&6öæf—&ÖVB ¢ò&6öæf—&ÖVB ¢¢'Væ6öæf—&ÖVB ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6´6öFRÒ&Æ—fU÷÷7E÷7V&Ö—E÷&V6öæ6–Æ–F–öâ ¢Æ—fU÷6—F–öâæW†V7WF–öä&Æö6µ&V6öâÒ%fVçVR7V&Ö—76–öâ&WV—&W2WF†÷&—FF—fR&V6÷fW'’ ¢Æ—fU÷6—F–öâç7FGW5&V6öâÐ¢VçG'•÷7V&Ö—76–öå÷Væ6öæf—&ÖVC¢G¶W'$×6wÓ²G&6¶–ær'’6Æ–VçD÷&FW$–BVçF–ÂWF†÷&—FF—fR&V6÷fW'– ¢W6…7FW†Æ—fU÷6—F–öâÂ&VçG'•÷7V&Ö—76–öå÷Væ6öæf—&ÖVB"ÂfÇ6RÂÆ—fU÷6—F–öâç7FGW5&V6öâ¢v—B6Æ–VçBç6WFW‚€¢VçG'•&÷FV7F–öä†ÇD¶W’À¢#B¢c¢cÀ¢¥4ôâç7G&–æv–g’‡²C¢FFRææ÷r‚’Â&V6öã¢&VçG'•÷—VÆ–æUöW'&÷%ögFW%÷7V&Ö—76–öâ"Ò’À¢’æ6F6‚‚‚’Óâ·Ò¢v—B–æ7&VÖVçDW†V7WF–öäÖWG&–2‚&Æ—fUö÷&FW'5öFVfW'&VEö6÷VçB"¢ÒVÇ6R°¢Æ—fU÷6—F–öâç7FGW2Ò&W'&÷" ¢Æ—fU÷6—F–öâç7FGW5&V6öâÒW'$×6p¢v—B&V6÷&DW†V7WF–öå&VfÆ–v‡Df–ÇW&R‚¢Ð¢W6…7FW†Æ—fU÷6—F–öâÂ'Væ†æFÆVEöW'&÷""ÂfÇ6RÂW'$×6r¢v—B6fU÷6—F–öâ†Æ—fU÷6—F–öâ¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&W'&÷""À¢Æ—fR—VÆ–æRVæ†æFÆVBW'&÷"f÷"G·&VÅ÷6—F–öâç7–Ö&öÇÖÀ¢²W'&÷#¢W'$×6rÂ7F6³¢W'%7F6²Ð¢ ¢òò7W&f6RVæ†æFÆVBÆ—fR×—VÆ–æRf–ÇW&W2–çFòF†R7—7FV×v–FRÆörFöòÀ¢òòæ÷B§W7BF†RW"Ö6öææV7F–öâ&öw&W76–öâf–Wrà¢G'’°¢v—B7—7FVÔÆövvW"æÆötW'&÷"€¢W'"–ç7Fæ6VöbW'&÷"òW'"¢æWrW'&÷"†W'$×6r’À¢6öææV7F–öä–BÀ¢Æ—fR×7FvRæW†V7WFTÆ—fU÷6—F–öå²G·&VÅ÷6—F–öâç7–Ö&öÇÒòG·&VÅ÷6—F–öâæF—&V7F–öçÕÖÀ¢¢Ò6F6‚°¢ò¢Æövv–ær×W7BæWfW"F‡&÷r¢ð¢Ð¢–b†Æ—fT÷&FW$Æö6µFö¶Vâ’v—B&VÆV6TÆö6²†6öææV7F–öä–BÂ&VÅ÷6—F–öâç7–Ö&öÂÂ&VÅ÷6—F–öâæF—&V7F–öâ²öÆö6´F—%7Vff—‚ÂÆ—fT÷&FW$Æö6µFö¶Vâ’æ6F6‚‚‚’Óâ·Ò¢&WGW&âÆ—fU÷6—F–öà¢Òf–æÆÇ’°¢v—B&VÆV6TVçG'•&÷FV7F–öäFÖ—76–öäÆö6²‚¢Ð§Ð ¢ò¢ ¢¢WFFRÆ—fR÷6—F–öâv—F‚÷&FW"f–ÆÇ2‡W6VB'’vV&†öö·2ò7–æ72’à¢¢ð¦W‡÷'B7–æ2gVæ7F–öâWFFTÆ—fU÷6—F–öäf–ÆÂ€¢6öææV7F–öä–C¢7G&–ærÀ¢Æ—fU÷6—F–öä–C¢7G&–ærÀ¢f–ÆÃ¢Æ—fU÷6—F–öå²&f–ÆÇ2%Õ³Ð¢“¢&öÖ—6SÄÆ—fU÷6—F–öâÂçVÆÃâ°¢v—B–æ—E&VF—2‚¢6öç7B6Æ–VçBÒvWE&VF—46Æ–VçB‚¢6öç7BÆö6´–BÒf–ÆÃ¢G·&ö6W72ç–GÓ¢G´FFRææ÷r‚—Ó¢G¶ææö–Bƒ‚—Ö ¢ÆWB×WFF–öäÆö6´†VÆBÒfÇ6P¢ÆWB7F÷Æö6´ÆV6U&Vg&W6ƒ¢‚‚’Óâfö–B’ÂçVÆÂÒçVÆÀ ¢G'’°¢òòf–ÆÂvV&†öö·2æBW†6†ævR&V6öæ6–Æ–F–öâ6â'&—fR6öæ7W'&VçFÇ’âF†P¢òò6ÖR÷6—F–öâÆö6²W6VB'’6Æ÷6R÷VçF—G’6ö÷&F–æF–öâÖ¶W2F†P¢òò&VN(i&FVGW^(i&vw&VvF^(i'W'6—7BG&ç6—F–öâöæR÷væW"BF–ÖRà¢–b‚v—B7V—&U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6´–B’’&WGW&âçVÆÀ¢×WFF–öäÆö6´†VÆBÒG'VP¢7F÷Æö6´ÆV6U&Vg&W6‚Ò7F'E&VF—4Æö6´ÆV6U&Vg&W6‚€¢6Æ–VçBÀ¢÷6—F–öä×WFF–öäÆö6´¶W’†6öææV7F–öä–BÂÆ—fU÷6—F–öä–B’À¢Æö6´–BÀ¢õ4•D”ôåôÕUDD”ôåôÄô4µõEDÅôÕ2À¢ ¢6öç7B÷6—F–öâÒv—B&VDÆ—fU÷6—F–öå6æ6†÷B†6Æ–VçBÂ6öææV7F–öä–BÂÆ—fU÷6—F–öä–B¢–b‚÷6—F–öâ’&WGW&âçVÆÀ¢–b‡÷6—F–öâæ6öææV7F–öä–Bbb÷6—F–öâæ6öææV7F–öä–BÓÒ6öææV7F–öä–B’&WGW&âçVÆÀ¢÷6—F–öâæ6öææV7F–öä–BÇÃÒ6öææV7F–öä–@ ¢6öç7Bf–ÆÅVçF—G’ÒçVÖ&W"†f–ÆÃòçVçF—G’¢6öç7Bf–ÆÅ&–6RÒçVÖ&W"†f–ÆÃòç&–6R¢–b‚çVÖ&W"æ—4f–æ—FR†f–ÆÅVçF—G’’ÇÂf–ÆÅVçF—G’ÃÒÇÂçVÖ&W"æ—4f–æ—FR†f–ÆÅ&–6R’ÇÂf–ÆÅ&–6RÃÒ’°¢&WGW&âçVÆÀ¢Ð ¢6öç7Bf–ÆÇ2Ò'&’æ—4'&’‡÷6—F–öâæf–ÆÇ2’ò÷6—F–öâæf–ÆÇ2¢µÐ¢6öç7Bæ÷&ÖÆ—¦VDf–ÆÂÒ°¢ââæf–ÆÂÀ¢VçF—G“¢f–ÆÅVçF—G’À¢&–6S¢f–ÆÅ&–6RÀ¢Ð¢6öç7Bf–ÆÅ&–6T¶W’Ò‡fÇVS¢Væ¶æ÷vâ“¢7G&–ærÓâ°¢6öç7BçVÖ&W"ÒçVÖ&W"‡fÇVR¢&WGW&âçVÖ&W"æ—4f–æ—FR†çVÖ&W"’òçVÖ&W"çFõ&V6—6–öâƒR’¢7G&–ær‡fÇVRóò""¢Ð¢6öç7Bf–ÆÅVçF—G”¶W’Òf–ÆÅ&–6T¶W¢6öç7Bf–ÆÄ–FVçF—G’Ò‡fÇVS¢G—Vöbæ÷&ÖÆ—¦VDf–ÆÂ“¢7G&–ærÓâ°¢6öç7BW‡Æ–6—BÒ7G&–ær€¢‡fÇVR2ç’’æ–Bóò‡fÇVR2ç’’æf–ÆÄ–Bóò‡fÇVR2ç’’çG&FT–Bóò""À¢’çG&–Ò‚¢–b†W‡Æ–6—B’&WGW&â–C¢G¶W‡Æ–6—GÖ ¢&WGW&â°¢7G&–ær‡fÇVRæ÷&FW$–BÇÂ""’çG&–Ò‚’À¢f–ÆÅ&–6T¶W’‡fÇVRç&–6R’À¢f–ÆÅVçF—G”¶W’‡fÇVRçVçF—G’’À¢7G&–ær‡fÇVRçF–ÖW7F×óò""’À¢f–ÆÅ&–6T¶W’‡fÇVRæfVRóò’À¢Òæ¦ö–â‚'Â"¢Ð¢6öç7B–FVçF—G’Òf–ÆÄ–FVçF—G’†æ÷&ÖÆ—¦VDf–ÆÂ¢–b†f–ÆÇ2ç6öÖR‚†W†—7F–ær’Óâf–ÆÄ–FVçF—G’†W†—7F–ær2G—Vöbæ÷&ÖÆ—¦VDf–ÆÂ’ÓÓÒ–FVçF—G’’’°¢òò–FV×÷FVçBvV&†öö²&WG'“¢&WGW&âF†R6æöæ–6Â7W'&VçB7FFRv—F†÷W@¢òò–æ7&VÖVçF–ærW†V7WFVBVçF—G’Âf–ÆÇ2ÂfW'6–öâÂ÷"&VF—2w&—FRÆöBà¢&WGW&â÷6—F–öà¢Ð ¢6öç7B7W'&VçE7FGW2Ò7G&–ær‡÷6—F–öâç7FGW2ÇÂ""’çG&–Ò‚’çFôÆ÷vW$66R‚¢–b€¢²&6Æ÷6VB"Â'&V¦V7FVB"Â&6æ6VÆÆVB"Â&6æ6VÆVB"Â&W‡—&VB"Â&W'&÷"%Òæ–æ6ÇVFW2†7W'&VçE7FGW2’ÇÀ¢†7W'&VçE7FGW2ÓÓÒ&f–ÆÆVB"bbçVÖ&W"‡÷6—F–öâç&VÖ–æ–æuVçF—G’ÇÂ’ÃÒ¢’°¢&WGW&â÷6—F–öà¢Ð ¢6öç7B&Wf–÷W4W†V7WFVBÒÖF‚æÖ‚ƒÂçVÖ&W"‡÷6—F–öâæW†V7WFVEVçF—G’’ÇÂ¢6öç7B&Wf–÷W4fW&vRÒÖF‚æÖ‚€¢À¢çVÖ&W"‡÷6—F–öâæfW&vTW†V7WF–öå&–6R’ÇÂçVÖ&W"‡÷6—F–öâæVçG'•&–6R’ÇÂÀ¢¢6öç7B&–÷$f–ÆÅVçF—G’Òf–ÆÇ2ç&VGV6R‚‡7VÒÂ—FVÒ’Óâ7VÒ²ÖF‚æÖ‚ƒÂçVÖ&W"†—FVÒçVçF—G’’ÇÂ’Â¢6öç7B&–÷$f–ÆÄ6÷7BÒf–ÆÇ2ç&VGV6R€¢‡7VÒÂ—FVÒ’Óâ7VÒ²ÖF‚æÖ‚ƒÂçVÖ&W"†—FVÒç&–6R’ÇÂ’¢ÖF‚æÖ‚ƒÂçVÖ&W"†—FVÒçVçF—G’’ÇÂ’À¢À¢¢6öç7B66÷VçFVEVçF—G’Ò&Wf–÷W4W†V7WFVBâò&Wf–÷W4W†V7WFVB¢&–÷$f–ÆÅVçF—G¢6öç7B66÷VçFVD6÷7BÒ&Wf–÷W4W†V7WFVBâ ¢ò&Wf–÷W4W†V7WFVB¢&Wf–÷W4fW&vP¢¢&–÷$f–ÆÄ6÷7@¢6öç7BW†V7WFVEVçF—G’Ò66÷VçFVEVçF—G’²f–ÆÅVçF—G ¢÷6—F–öâæf–ÆÇ2Ò²ââæf–ÆÇ2Âæ÷&ÖÆ—¦VDf–ÆÅÐ¢÷6—F–öâæW†V7WFVEVçF—G’ÒW†V7WFVEVçF—G¢÷6—F–öâç&VÖ–æ–æuVçF—G’ÒÖF‚æÖ‚ƒÂçVÖ&W"‡÷6—F–öâçVçF—G’ÇÂ’ÒW†V7WFVEVçF—G’¢÷6—F–öâæfW&vTW†V7WF–öå&–6RÒW†V7WFVEVçF—G’â ¢ò†66÷VçFVD6÷7B²f–ÆÅ&–6R¢f–ÆÅVçF—G’’òW†V7WFVEVçF—G¢¢f–ÆÅ&–6P ¢–b‡÷6—F–öâç&VÖ–æ–æuVçF—G’ÃÒ’°¢÷6—F–öâç7FGW2Ò&f–ÆÆVB ¢ÒVÇ6R–b‡÷6—F–öâæW†V7WFVEVçF—G’â’°¢÷6—F–öâç7FGW2Ò''F–ÆÇ•öf–ÆÆVB ¢Ð¢÷6—F–öâçWFFVDBÒFFRææ÷r‚ ¢òò6fU÷6—F–öâw&—FW2&÷F‚F†R6æöæ–6Â†6‚æB6ö×F–&–Æ—G’Ö—'&÷"À¢òò&Vg&W6†W2Æ–fV7–6ÆR÷G&6¶–ær–æFW†W2ÂæBÆ–W2F†R÷6—F–öâ×7V6–f–0¢òò&WFVçF–öâöÆ–7’âF†RöÆBF‚öæÇ’WFFVBF†R¥4ôâ¶W’Âv†–6‚ÖFP¢òò&W7F'B7FG2æB6öçG&öÂÖ÷&FW"&V6öæ6–Æ–F–öâF—fW&vRg&öÒF†RvV&†öö²à¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢&WGW&â÷6—F–öà¢Ò6F6‚†W'"’°¢6öç6öÆRæW'&÷"†G´Äôuõ$Td•‡ÒW'&÷"WFF–ærf–ÆÃ¦ÂW'"¢&WGW&âçVÆÀ¢Òf–æÆÇ’°¢7F÷Æö6´ÆV6U&Vg&W6ƒòâ‚¢–b†×WFF–öäÆö6´†VÆB’°¢v—B&VÆV6U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6´–B’æ6F6‚‚‚’ÓâfÇ6R¢Ð¢Ð§Ð §G—R6öçG&öÄ&'&–W$÷WF6öÖRÒ°¢FV6—6–öã¢'v—B"Â'&ö6VVE÷7—7FVÒ"Â&W†6†ævUö6Æ÷6VB ¢WF†÷&—FF—fUVçF—G“ó¢çVÖ&W ¢FWF–Ã¢7G&–æp§Ð ¦gVæ7F–öâ6öçG&öÄ÷&FW%7FGW2†÷&FW#¢ç’“¢7G&–ær°¢&WGW&â7G&–ær†÷&FW#òç7FGW2óò÷&FW#òæ÷&FW%7FGW2óò÷&FW#òç7FFRóò'Væ¶æ÷vâ"’çFôÆ÷vW$66R‚§Ð ¦gVæ7F–öâ6öçG&öÄ÷&FW$f–ÆÆVEVçF—G’†÷&FW#¢ç’“¢çVÖ&W"°¢6öç7BfÇVRÒçVÖ&W"€¢÷&FW#òæf–ÆÆVEG’óò÷&FW#òæW†V7WFVEG’óò÷&FW#òæ7VÕG’óð¢÷&FW#òæf–ÆÆVEVçF—G’óò÷&FW#òæW†V7WFVEVçF—G’óòÀ¢¢&WGW&âçVÖ&W"æ—4f–æ—FR‡fÇVR’bbfÇVRâòfÇVR¢ §Ð ¦gVæ7F–öâ6öçG&öÄ÷&FW$f–ÆÅ&–6R†÷&FW#¢ç’“¢çVÖ&W"°¢6öç7BfÇVRÒçVÖ&W"†÷&FW#òæf–ÆÆVE&–6Róò÷&FW#òæfu&–6Róò÷&FW#òæfW&vU&–6Róò¢&WGW&âçVÖ&W"æ—4f–æ—FR‡fÇVR’bbfÇVRâòfÇVR¢ §Ð ¦gVæ7F–öâ—5FW&Ö–æÅ7—7FVÔ6Æ÷6T÷&FW"†÷&FW#¢ç’“¢&ööÆVâ°¢–b‚÷&FW"’&WGW&âfÇ6P¢6öç7B7FGW2Ò6öçG&öÄ÷&FW%7FGW2†÷&FW"¢&WGW&â—4f–ÆÆVD6öçG&öÄ÷&FW%7FGW2‡7FGW2’ÇÂ²&6æ6VÆÆVB"Â&6æ6VÆVB"Â'&V¦V7FVB"Â&W‡—&VB%Òæ–æ6ÇVFW2‡7FGW2§Ð ¢ò¢ ¢¢6W&–Æ—¦RfVçVR6öçG&öÂ÷&FW'2æB7—7FVÒ6Æ÷6Rà¢ ¢¢G&–vvW"÷&FW"Ö’f–ÆÂ&WGvVVâç’Gvò…EE6ÆÇ2âF†W&Vf÷&RâVæ¶æ÷vâÀ¢¢÷VâÂ'F–ÆÇ’Öf–ÆÆVBÂ÷"&W7öç6RÖÆ÷7B6öçG&öÂ÷&FW"Çv—2v–ç2F†P¢¢7W'&VçB7–6ÆRâF†R7—7FVÒ6Æ÷6R—2W&Ö—GFVBöæÇ’gFW"F†R6öçG&öÂ÷&FW ¢¢†2V—F†W"6†ævVBF†RWF†÷&—FF—fR÷6—F–öâ÷"—G26æ6VÆÆF–öâ—0¢¢6öæf—&ÖVB'6VçBg&öÒâWF†÷&—FF—fR÷VâÖ÷&FW"6æ6†÷Bà¢¢ð¦7–æ2gVæ7F–öâ6WGFÆT6öçG&öÄ÷&FW'4&Vf÷&U7—7FVÔ6Æ÷6R€¢6öææV7F÷#¢ç’À¢÷6—F–öã¢Æ—fU÷6—F–öâÀ¢6Æ÷6U&V6öã¢7G&–ærÀ¢öfÆÆ&6µ&–6S¢çVÖ&W"À¢“¢&öÖ—6SÄ6öçG&öÄ&'&–W$÷WF6öÖSâ°¢6öç7B7F–öâÒ÷6—F–öâçVæF–æu7—7FVÔ7F–öâÇÂ°¢Fö¶Vã¢7—7FVÒÖ6Æ÷6S¢G·÷6—F–öâæ–GÓ¢G¶ææö–Bƒ‚—ÖÀ¢&V6öã¢6Æ÷6U&V6öâÀ¢†6S¢&6öçG&öÅ÷v—B"26öç7BÀ¢7F'FVDC¢FFRææ÷r‚’À¢WFFVDC¢FFRææ÷r‚’À¢Ð¢7F–öâç&V6öâÒ6Æ÷6U&V6öà¢7F–öâçWFFVDBÒFFRææ÷r‚¢÷6—F–öâçVæF–æu7—7FVÔ7F–öâÒ7F–öà ¢–b‡÷6—F–öâçVæF–æu&VGV7F–öâÇÂ÷6—F–öâçVæF–æt67V×VÆF–öâÇÂ÷6—F–öâçVæF–æuVçF—G”×WFF–öâ’°¢&WGW&â°¢FV6—6–öã¢'v—B"À¢FWF–Ã¢'F–Â6ö÷&F–æF–öâ7F–ÆÂ7F—fR‚G·÷6—F–öâçVæF–æu&VGV7F–öà¢ò'&VGV7F–öâ ¢¢÷6—F–öâçVæF–æt67V×VÆF–öà¢ò&67V×VÆF–öâ ¢¢VçF—G“¢G·÷6—F–öâçVæF–æuVçF—G”×WFF–öãòç†6WÖÒ–À¢Ð¢Ð ¢6öç7BF—&V7F–öâÒ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ‡÷6—F–öâ¢–b‚F—&V7F–öâ’°¢W6…7FW‡÷6—F–öâÂ'7—7FVÕö6Æ÷6UöF—&V7F–öåöwV&B"ÂfÇ6RÂ$æòW‡Æ–6—BÆöær÷6†÷'BF—&V7F–öã²6öçG&öÂæB6Æ÷6R÷&FW'2&Æö6¶VB"¢&WGW&â²FV6—6–öã¢'v—B"ÂFWF–Ã¢&–çfÆ–B÷6—F–öâF—&V7F–öâ"Ð¢Ð¢6öç7B–æ—F–ÅVçF—G’ÒÖF‚æÖ‚ƒÂçVÖ&W"‡÷6—F–öâæW†V7WFVEVçF—G’ÇÂ÷6—F–öâçVçF—G’ÇÂ’¢6öç7Bö'6W'fF–öç3¢'&“Ç²–C¢7G&–æs²6÷W&6S¢'F–Ä÷&FW$W†V7WF–öå6÷W&6S²÷&FW#¢ç’ÓâÒµÐ¢6öç7BVç&W6öÇfVD6Æ–VçD–G2ÒæWr6WCÇ7G&–æsâ‚ ¢òòf—'7B&V6÷fW"&W7öç6RÖÆ÷7B6öçG&öÂ7V&Ö—76–öç2'’F†V—"GW&&ÆR6Æ–VçB–Bà¢f÷"†6öç7BÆVröb²'7F÷Æ÷72"Â'F¶U&öf—B"Â'6V7W&—G•7F÷%Ò26öç7B’°¢6öç7BVæF–ærÒ÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'3òå¶ÆVuÐ¢–b‚VæF–æsòæ6Æ–VçD÷&FW$–B’6öçF–çVP¢6öç7B&V6÷fW&VBÒv—B&V6÷fW$VçG'”÷&FW$'”6Æ–VçD–B†6öææV7F÷"Â÷6—F–öâç7–Ö&öÂÂVæF–æræ6Æ–VçD÷&FW$–B¢–b‡&V6÷fW&VB’°¢6öç7B÷&FW$–BÒ7G&–ær‡&V6÷fW&VBæ÷&FW$–Bóò&V6÷fW&VBæ–B¢–b†ÆVrÓÓÒ'7F÷Æ÷72"’÷6—F–öâç7F÷Æ÷74÷&FW$–BÒ÷&FW$–@¢VÇ6R–b†ÆVrÓÓÒ'F¶U&öf—B"’÷6—F–öâçF¶U&öf—D÷&FW$–BÒ÷&FW$–@¢VÇ6R÷6—F–öâç6V7W&—G•7F÷÷&FW$–BÒ÷&FW$–@¢ö'6W'fF–öç2çW6‚‡²–C¢÷&FW$–BÂ6÷W&6S¢&6öçG&öÅö÷&FW""Â÷&FW#¢&V6÷fW&VBÒ¢FVÆWFR÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'3òå¶ÆVuÐ¢ÒVÇ6R°¢Vç&W6öÇfVD6Æ–VçD–G2æFB‡VæF–æræ6Æ–VçD÷&FW$–B¢Ð¢Ð ¢òò&–÷"7—7FVÒÖ6Æ÷6R7V&Ö—76–öâ—2'BöbF†R6ÖR&'&–W"â&V6öæ6–ÆR—@¢òò&Vf÷&Rç’æWr6Æ÷6R6â&RVÖ—GFVBgFW"&W7F'B÷"'F–Âf–ÆÂà¢–b†7F–öâæ÷&FW$–BbbG—Vöb6öææV7F÷#òævWD÷&FW"ÓÓÒ&gVæ7F–öâ"’°¢6öç7B÷&FW"Òv—Bv—F…F–ÖV÷WB€¢6öææV7F÷"ævWD÷&FW"‡÷6—F–öâç7–Ö&öÂÂ7F–öâæ÷&FW$–B’2&öÖ—6SÆç“âÀ¢U„4„ätUõD”ÔTõUEôtUEôõ$DU%ôÕ2À¢vWD÷&FW"‡7—7FVÒÖ6Æ÷6RG¶7F–öâæ÷&FW$–GÒ–À¢’æ6F6‚‚‚’ÓâçVÆÂ¢–b†÷&FW"’ö'6W'fF–öç2çW6‚‡²–C¢7F–öâæ÷&FW$–BÂ6÷W&6S¢'7—7FVÕö6Æ÷6R"Â÷&FW"Ò¢ÒVÇ6R–b†7F–öâæ6Æ–VçD÷&FW$–Bbb7F–öâç†6RÓÒ&6öçG&öÅ÷v—B"’°¢6öç7B&V6÷fW&VBÒv—B&V6÷fW$VçG'”÷&FW$'”6Æ–VçD–B†6öææV7F÷"Â÷6—F–öâç7–Ö&öÂÂ7F–öâæ6Æ–VçD÷&FW$–B¢–b‡&V6÷fW&VB’°¢7F–öâæ÷&FW$–BÒ7G&–ær‡&V6÷fW&VBæ÷&FW$–Bóò&V6÷fW&VBæ–B¢ö'6W'fF–öç2çW6‚‡²–C¢7F–öâæ÷&FW$–BÂ6÷W&6S¢'7—7FVÕö6Æ÷6R"Â÷&FW#¢&V6÷fW&VBÒ¢ÒVÇ6R°¢Vç&W6öÇfVD6Æ–VçD–G2æFB†7F–öâæ6Æ–VçD÷&FW$–B¢Ð¢Ð ¢6öç7BG&6¶VD6öçG&öÄ–G2Ò'&’æg&öÒ†æWr6WB€¢·÷6—F–öâç7F÷Æ÷74÷&FW$–BÂ÷6—F–öâçF¶U&öf—D÷&FW$–BÂ÷6—F–öâç6V7W&—G•7F÷÷&FW$–EÐ¢æÖ…7G&–ær¢æf–ÇFW"‚†–B’Óâ–Bbb–BÓÒ'VæFVf–æVB"’À¢’¢f÷"†6öç7B÷&FW$–BöbG&6¶VD6öçG&öÄ–G2’°¢–b†ö'6W'fF–öç2ç6öÖR‚†—FVÒ’Óâ—FVÒæ–BÓÓÒ÷&FW$–B’’6öçF–çVP¢–b‡G—Vöb6öææV7F÷#òævWD÷&FW"ÓÒ&gVæ7F–öâ"’6öçF–çVP¢6öç7B÷&FW"Òv—Bv—F…F–ÖV÷WB€¢6öææV7F÷"ævWD÷&FW"‡÷6—F–öâç7–Ö&öÂÂ÷&FW$–B’2&öÖ—6SÆç“âÀ¢U„4„ätUõD”ÔTõUEôtUEôõ$DU%ôÕ2À¢vWD÷&FW"†6öçG&öÂG¶÷&FW$–GÒ–À¢’æ6F6‚‚‚’ÓâçVÆÂ¢–b†÷&FW"’ö'6W'fF–öç2çW6‚‡²–C¢÷&FW$–BÂ6÷W&6S¢&6öçG&öÅö÷&FW""Â÷&FW"Ò¢Ð ¢ÆWBWF†÷&—FF—fRÒv—BfWF6„WF†÷&—FF—fT÷VåVçF—G’†6öææV7F÷"Â÷6—F–öâç7–Ö&öÂÂF—&V7F–öâÂ÷6—F–öâæ6öææV7F–öä–B¢6öç7BVçF—G”6†ævVBÒWF†÷&—FF—fRæö²bbWF†÷&—FF—fRçVçF—G’Â–æ—F–ÅVçF—G’ÒÖF‚æÖ‚ƒRÓ"Â–æ—F–ÅVçF—G’¢RÓ‚¢6öç7Bf–ÆÆVDö'6W'fF–öâÒö'6W'fF–öç0¢æf–ÇFW"‚†—FVÒ’Óâ6öçG&öÄ÷&FW$f–ÆÆVEVçF—G’†—FVÒæ÷&FW"’âÇÂ—4f–ÆÆVD6öçG&öÄ÷&FW%7FGW2†6öçG&öÄ÷&FW%7FGW2†—FVÒæ÷&FW"’’¢ç6÷'B‚†Â"’Óâ6öçG&öÄ÷&FW$f–ÆÆVEVçF—G’†"æ÷&FW"’Ò6öçG&öÄ÷&FW$f–ÆÆVEVçF—G’†æ÷&FW"’•³Ð ¢–b†f–ÆÆVDö'6W'fF–öâÇÂVçF—G”6†ævVB’°¢6öç7BW†V7WF–öä–BÒf–ÆÆVDö'6W'fF–öà¢òG·÷6—F–öâæ–GÓ¢G¶f–ÆÆVDö'6W'fF–öâç6÷W&6WÓ¢G¶f–ÆÆVDö'6W'fF–öâæ–GÖ ¢¢G·÷6—F–öâæ–GÓ¦6öçG&öÂÖWF†÷&—G“¢G¶7F–öâçFö¶VçÖ ¢6öç7BW†—7F–ærÒ÷6—F–öâç'F–Ä÷&FW$W†V7WF–öç3òæf–æB‚†VçG'’’ÓâVçG'’æ–BÓÓÒW†V7WF–öä–B¢6öç7Bö'6W'fVD÷&FW"Òf–ÆÆVDö'6W'fF–öãòæ÷&FW ¢6öç7B6WGFÆVÖVçBÒf–ÆÆVDö'6W'fF–öãòæ–@¢òv—B&VD÷&FW%6WGFÆVÖVçB†6öææV7F÷"Â÷6—F–öâç7–Ö&öÂÂf–ÆÆVDö'6W'fF–öâæ–B¢¢çVÆÀ¢6öç7BÆ–VBÒÇ•&VGV7F–öäö'6W'fF–öâ‡÷6—F–öâÂ°¢W†V7WF–öä–BÀ¢6÷W&6S¢f–ÆÆVDö'6W'fF–öãòç6÷W&6RÇÂ&6öçG&öÅö÷&FW""À¢7FGW3¢6öçG&öÄ÷&FW%7FGW2†ö'6W'fVD÷&FW"ÇÂ²7FGW3¢WF†÷&—FF—fRçVçF—G’ÃÒò&f–ÆÆVB"¢''F–ÆÇ•öf–ÆÆVB"Ò’À¢&WVW7FVEVçF—G“¢f–ÆÆVDö'6W'fF–öãòç6÷W&6RÓÓÒ'7—7FVÕö6Æ÷6R ¢òçVÖ&W"†7F–öâç&WVW7FVEVçF—G’ÇÂ–æ—F–ÅVçF—G’¢¢–æ—F–ÅVçF—G’À¢&W÷'FVDf–ÆÆVEVçF—G“¢6öçG&öÄ÷&FW$f–ÆÆVEVçF—G’†ö'6W'fVD÷&FW"’À¢&Wf–÷W6Ç”Æ–VEVçF—G“¢çVÖ&W"†W†—7F–æsòæ7V×VÆF—fTf–ÆÆVEVçF—G’ÇÂ7F–öâæÆ–VDf–ÆÆVEVçF—G’ÇÂ’À¢WF†÷&—FF—fUVçF—G“¢WF†÷&—FF—fRæö²òWF†÷&—FF—fRçVçF—G’¢çVÆÂÀ¢&–6S¢6öçG&öÄ÷&FW$f–ÆÅ&–6R†ö'6W'fVD÷&FW"’À¢6WGFÆVÖVçBÀ¢÷&FW$–C¢f–ÆÆVDö'6W'fF–öãòæ–BÀ¢6Æ–VçD÷&FW$–C¢f–ÆÆVDö'6W'fF–öãòç6÷W&6RÓÓÒ'7—7FVÕö6Æ÷6R"ò7F–öâæ6Æ–VçD÷&FW$–B¢VæFVf–æVBÀ¢Ò¢–b†f–ÆÆVDö'6W'fF–öãòç6÷W&6RÓÓÒ'7—7FVÕö6Æ÷6R"’7F–öâæÆ–VDf–ÆÆVEVçF—G’ÒÆ–VBæ7V×VÆF—fTÆ–V@¢Ð ¢òòfÆB÷6—F–öâFöW2æ÷B'’—G6VÆb&÷fR&W7öç6RÖÆ÷7B6öçG&öÂw&—FW2&P¢òò6WGFÆVBâ6öçF–çVRF‡&÷Vv‚÷væVBÖ÷&FW"6æ6VÆÆF–öâæBWF†÷&—FF—fP¢òò÷VâÖ÷&FW"'6Væ6R&VÆ÷r&Vf÷&RÆÆ÷v–ærFW&Ö–æÂ&6†—fÃ²÷F†W'v—6R¢òò7FÆR&VGV6RÖöæÇ’G&–vvW"6â7W'f—fRæB6Æ÷6RF†RæW‡B5E2VçG'’à ¢6öç7B7F—fT6öçG&öÄ–G2Òö'6W'fF–öç0¢æf–ÇFW"‚†—FVÒ’Óâ—FVÒç6÷W&6RÓÓÒ&6öçG&öÅö÷&FW""bb—47F—fT6öçG&öÄ÷&FW%7FGW2†6öçG&öÄ÷&FW%7FGW2†—FVÒæ÷&FW"’’¢æÖ‚†—FVÒ’Óâ—FVÒæ–B¢6öç7B7—7FVÔö'6W'fF–öâÒö'6W'fF–öç2æf–æB‚†—FVÒ’Óâ—FVÒç6÷W&6RÓÓÒ'7—7FVÕö6Æ÷6R"¢–b‡7—7FVÔö'6W'fF–öâbb—47F—fT6öçG&öÄ÷&FW%7FGW2†6öçG&öÄ÷&FW%7FGW2‡7—7FVÔö'6W'fF–öâæ÷&FW"’’’°¢&WGW&â°¢FV6—6–öã¢'v—B"À¢WF†÷&—FF—fUVçF—G“¢WF†÷&—FF—fRæö²òWF†÷&—FF—fRçVçF—G’¢VæFVf–æVBÀ¢FWF–Ã¢7—7FVÒ6Æ÷6R÷&FW"G·7—7FVÔö'6W'fF–öâæ–GÒ—27F–ÆÂG¶6öçG&öÄ÷&FW%7FGW2‡7—7FVÔö'6W'fF–öâæ÷&FW"—ÖÀ¢Ð¢Ð¢–b‡7—7FVÔö'6W'fF–öâbb—47F—fT6öçG&öÄ÷&FW%7FGW2†6öçG&öÄ÷&FW%7FGW2‡7—7FVÔö'6W'fF–öâæ÷&FW"’’’°¢7F–öâæ÷&FW$–BÒVæFVf–æV@¢7F–öâæ6Æ–VçD÷&FW$–BÒVæFVf–æV@¢7F–öâç&WVW7FVEVçF—G’ÒVæFVf–æV@¢7F–öâæÆ–VDf–ÆÆVEVçF—G’ÒVæFVf–æV@¢Ð¢6öç7BVæ¶æ÷våG&6¶VD–G2ÒG&6¶VD6öçG&öÄ–G2æf–ÇFW"‚†–B’Óâö'6W'fF–öç2ç6öÖR‚†—FVÒ’Óâ—FVÒæ–BÓÓÒ–B’¢7F–öâæ6öçG&öÄ÷&FW$–G2Ò'&’æg&öÒ†æWr6WB…²ââçG&6¶VD6öçG&öÄ–G2ÂââçVç&W6öÇfVD6Æ–VçD–G5Ò’ ¢6öç7BG&–vvW$G&—fVâÒò…çÅò’‡6ÇÇGÇ7F÷ÇF¶WÇG&–Æ–ær—Ç&–6Uö7&÷72ö’çFW7B†6Æ÷6U&V6öâ¢6öç7B4ôåE$ôÅôTddT5Eôu$4UôÕ2Òó ¢–b‡G&–vvW$G&—fVâbb7F—fT6öçG&öÄ–G2æÆVæwF‚âbbFFRææ÷r‚’Ò7F–öâç7F'FVDBÂ4ôåE$ôÅôTddT5Eôu$4UôÕ2’°¢&WGW&â²FV6—6–öã¢'v—B"ÂWF†÷&—FF—fUVçF—G“¢WF†÷&—FF—fRæö²òWF†÷&—FF—fRçVçF—G’¢VæFVf–æVBÂFWF–Ã¢'G&–vvW"6öçG&öÂ÷&FW"7F–ÆÂ7F—fRv—F†–âVffV7Bw&6R"Ð¢Ð ¢òò6æ6VÂöæÇ’7—7FVÒÖ÷væVBÂ¶æ÷vâ6öçG&öÂ”G2â6æ6VÆÆF–öâ—26WVVçF–À¢òòv—F‚F†R7—7FVÒ7V&Ö—76–öâæB×W7B&R6öæf—&ÖVB&Vf÷&R&ö6VVF–ærà¢6öç7B–G5Fô6æ6VÂÒ'&’æg&öÒ†æWr6WB…²ââæ7F—fT6öçG&öÄ–G2ÂââçVæ¶æ÷våG&6¶VD–G5Ò’¢f÷"†6öç7B÷&FW$–Böb–G5Fô6æ6VÂ’°¢6öç7B6æ6VÆÆVBÒv—B6æ6VÅ&÷FV7F–öä÷&FW"€¢6öææV7F÷"À¢÷6—F–öâç7–Ö&öÂÀ¢÷&FW$–BÀ¢%7—7FVÔ6Æ÷6T&'&–W""À¢÷6—F–öâæ6öææV7F–öä–BÀ¢¢–b‚6æ6VÆÆVB’°¢&WGW&â²FV6—6–öã¢'v—B"ÂWF†÷&—FF—fUVçF—G“¢WF†÷&—FF—fRæö²òWF†÷&—FF—fRçVçF—G’¢VæFVf–æVBÂFWF–Ã¢6öçG&öÂ÷&FW"G¶÷&FW$–GÒæ÷B6öæf—&ÖVB6æ6VÆÆVFÐ¢Ð¢Ð ¢6öç7BÆ—fT÷&FW$–G2Òv—BfWF6„Æ—fT÷&FW$–E6WB†6öææV7F÷"¢–b‡G—Vöb6öææV7F÷#òævWD÷Vä÷&FW'2ÓÓÒ&gVæ7F–öâ"bbÆ—fT÷&FW$–G2ÓÓÒçVÆÂbb‡G&6¶VD6öçG&öÄ–G2æÆVæwF‚âÇÂVç&W6öÇfVD6Æ–VçD–G2ç6—¦Râ’’°¢&WGW&â²FV6—6–öã¢'v—B"ÂWF†÷&—FF—fUVçF—G“¢WF†÷&—FF—fRæö²òWF†÷&—FF—fRçVçF—G’¢VæFVf–æVBÂFWF–Ã¢&WF†÷&—FF—fR÷VâÖ÷&FW"6æ6†÷BVæf–Æ&ÆR"Ð¢Ð¢6öç7B7F–ÆÅf—6–&ÆRÒ7F–öâæ6öçG&öÄ÷&FW$–G2æf–ÇFW"‚†–B’ÓâÆ—fT÷&FW$–G3òæ†2†–B’¢–b‡7F–ÆÅf—6–&ÆRæÆVæwF‚â’°¢&WGW&â²FV6—6–öã¢'v—B"ÂWF†÷&—FF—fUVçF—G“¢WF†÷&—FF—fRæö²òWF†÷&—FF—fRçVçF—G’¢VæFVf–æVBÂFWF–Ã¢6öçG&öÂ÷&FW'27F–ÆÂf—6–&ÆS¢G·7F–ÆÅf—6–&ÆRæ¦ö–â‚"Â"—ÖÐ¢Ð ¢–b‡Vç&W6öÇfVD6Æ–VçD–G2ç6—¦Râ’°¢7F–öâæ'6Væ6T6öæf—&ÖF–öç2ÒçVÖ&W"†7F–öâæ'6Væ6T6öæf—&ÖF–öç2ÇÂ’²¢–b†7F–öâæ'6Væ6T6öæf—&ÖF–öç2Â"’°¢&WGW&â²FV6—6–öã¢'v—B"ÂWF†÷&—FF—fUVçF—G“¢WF†÷&—FF—fRæö²òWF†÷&—FF—fRçVçF—G’¢VæFVf–æVBÂFWF–Ã¢'&W7öç6RÖÆ÷7B6öçG&öÂ7V&Ö—76–öâ&WV—&W26V6öæB'6Væ6R6öæf—&ÖF–öâ"Ð¢Ð¢f÷"†6öç7BÆVröb²'7F÷Æ÷72"Â'F¶U&öf—B"Â'6V7W&—G•7F÷%Ò26öç7B’°¢6öç7BVæF–ærÒ÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'3òå¶ÆVuÐ¢–b‡VæF–ærbbVç&W6öÇfVD6Æ–VçD–G2æ†2‡VæF–æræ6Æ–VçD÷&FW$–B’’FVÆWFR÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'3òå¶ÆVuÐ¢Ð¢–b†7F–öâæ6Æ–VçD÷&FW$–BbbVç&W6öÇfVD6Æ–VçD–G2æ†2†7F–öâæ6Æ–VçD÷&FW$–B’’°¢òòGvòWF†÷&—FF—fR÷&FW"Ö'6Væ6Rö'6W'fF–öç2ÇW27F–ÆÂÖ÷Và¢òò÷6—F–öâ&÷fRF†BF†R&Wf–÷W2&W&VB7V&Ö—76–öâæWfW"&V6ÖRà¢òòW†6†ævR÷&FW"âæWrGW&&ÆR–BÖ’æ÷r&R&W&VB6fVÇ’à¢7F–öâæ6Æ–VçD÷&FW$–BÒVæFVf–æV@¢7F–öâæ÷&FW$–BÒVæFVf–æV@¢7F–öâç&WVW7FVEVçF—G’ÒVæFVf–æV@¢7F–öâæÆ–VDf–ÆÆVEVçF—G’ÒVæFVf–æV@¢Ð¢Ð ¢–b‚Æ—fT÷&FW$–G2ÇÂ÷6—F–öâç7F÷Æ÷74÷&FW$–BÇÂÆ—fT÷&FW$–G2æ†2‡÷6—F–öâç7F÷Æ÷74÷&FW$–B’’°¢÷6—F–öâç7F÷Æ÷74÷&FW$–BÒVæFVf–æV@¢÷6—F–öâç7F÷Æ÷75&–6RÒ ¢6WE&÷FV7F–öäÆVt&ÖVEVçF—G’‡÷6—F–öâÂ'7F÷öÆ÷72"Â¢Ð¢–b‚Æ—fT÷&FW$–G2ÇÂ÷6—F–öâçF¶U&öf—D÷&FW$–BÇÂÆ—fT÷&FW$–G2æ†2‡÷6—F–öâçF¶U&öf—D÷&FW$–B’’°¢÷6—F–öâçF¶U&öf—D÷&FW$–BÒVæFVf–æV@¢÷6—F–öâçF¶U&öf—E&–6RÒ ¢6WE&÷FV7F–öäÆVt&ÖVEVçF—G’‡÷6—F–öâÂ'F¶U÷&öf—B"Â¢Ð¢–b‚Æ—fT÷&FW$–G2ÇÂ÷6—F–öâç6V7W&—G•7F÷÷&FW$–BÇÂÆ—fT÷&FW$–G2æ†2‡÷6—F–öâç6V7W&—G•7F÷÷&FW$–B’’°¢÷6—F–öâç6V7W&—G•7F÷÷&FW$–BÒVæFVf–æV@¢÷6—F–öâç6V7W&—G•7F÷&–6RÒ ¢÷6—F–öâç6V7W&—G•7F÷&ÖVEVçF—G’Ò ¢÷6—F–öâç6V7W&—G•7F÷'6Væ6T6öæf—&ÖF–öç2Ò ¢Ð ¢WF†÷&—FF—fRÒv—BfWF6„WF†÷&—FF—fT÷VåVçF—G’†6öææV7F÷"Â÷6—F–öâç7–Ö&öÂÂF—&V7F–öâÂ÷6—F–öâæ6öææV7F–öä–B¢6öç7BFV6—6–öâÒFV6–FT6öçG&öÄ÷&FW$&'&–W"‡°¢Æö6ÅVçF—G“¢çVÖ&W"‡÷6—F–öâæW†V7WFVEVçF—G’ÇÂ’À¢WF†÷&—FF—fUVçF—G“¢WF†÷&—FF—fRæö²òWF†÷&—FF—fRçVçF—G’¢çVÆÂÀ¢WF†÷&—FF—fU6æ6†÷C¢WF†÷&—FF—fRæö²À¢7F—fT6öçG&öÄ÷&FW'3¢À¢Vç&W6öÇfVD6öçG&öÄ÷&FW'3¢À¢VæF–æu7V&Ö—76–öç3¢À¢Ò¢–b‚WF†÷&—FF—fRæö²bbG—Vöb6öææV7F÷#òævWE÷6—F–öâÓÓÒ&gVæ7F–öâ"’°¢&WGW&â²FV6—6–öã¢'v—B"ÂFWF–Ã¢&WF†÷&—FF—fR÷6—F–öâ6æ6†÷BVæf–Æ&ÆRgFW"6öçG&öÂ6WGFÆVÖVçB"Ð¢Ð¢&WGW&â°¢FV6—6–öâÀ¢WF†÷&—FF—fUVçF—G“¢WF†÷&—FF—fRæö²òWF†÷&—FF—fRçVçF—G’¢VæFVf–æVBÀ¢FWF–Ã¢FV6—6–öâÓÓÒ&W†6†ævUö6Æ÷6VB"ò&6öçG&öÂ÷&FW"6Æ÷6VBF†R÷6—F–öâ"¢&ÆÂ6öçG&öÂ7F—f—G’6WGFÆVB"À¢Ð§Ð ¢ò¢ ¢¢†æB‡—6–6Â7–Ö&öÂöF—&V7F–öâ6Æ÷Bg&öÒ&÷r÷6V7W&—G’&÷FV7F–öâFò¢¢VçF—G’Ö×WFF–ærv÷&¶W"v—F†÷WB&6–ærç’7F–ÆÂÖÆ—fR6öçG&öÂ÷&FW"à¢¢F†R6ÆÆW"W'6—7G26†÷'BÖÆ—fVB&WVW7BæBFVfW'2âF†R6æöæ–6À¢¢&V6öæ6–ÆR72&VÖ÷fW2öæÇ’6öçG&öÂ”G2&V6÷&FVBöâ5E2÷6—F–öç2Â¶VW0¢¢WfW'’Æöv–6Â4ÂõE7F—fR7—7FVÒ×6–FRÂæB7W&W76W2vw&VvFR&RÖ&Ö–æp¢¢VçF–ÂF†R&WVW7F–ærv÷&¶W"†2†B6†æ6RFòf–æ—6‚à¢¢ð¦7–æ2gVæ7F–öâ&WVW7Dvw&VvFU&÷FV7F–öå6Æ÷D×WFF–öâ€¢6öææV7F÷#¢ç’À¢÷6—F–öã¢Æ—fU÷6—F–öâÀ¢&V6öã¢7G&–ærÀ¢“¢&öÖ—6SÆ&ööÆVãâ°¢–b‚6öææV7F÷"’&WGW&âG'VP¢6öç7BF—&V7F–öâÒ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ‡÷6—F–öâ¢–b‚F—&V7F–öâ’&WGW&âfÇ6P¢6öç7B6Æ÷BÒvw&VvFU&÷FV7F–öå6Æ÷B‡÷6—F–öâç7–Ö&öÂÂF—&V7F–öâ¢6öç7BÆÅ÷6—F–öç2Òv—BvWDÆ—fU÷6—F–öç2‡÷6—F–öâæ6öææV7F–öä–B¢6öç7B&VÆFVBÒÆÅ÷6—F–öç2æf–ÇFW"‚†6æF–FFR’Óà¢vw&VvFU&÷FV7F–öå6Æ÷B†6æF–FFRç7–Ö&öÂÂ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ†6æF–FFR’’ÓÓÒ6Æ÷@¢bb—4W†6†ævTÆ–fV7–6ÆU÷6—F–öâ†6æF–FFRÂ÷6—F–öâæ6öææV7F–öä–B’À¢¢òò6–ævÆRÆöv–6Â&÷r7F–ÆÂ÷vç2‡—6–6Â6Æ÷BÖÆWfVÂ6V7W&—G’7F÷Â'W@¢òò—BFöW2æ÷BæVVBF†R×VÇF’×&÷r†æBÖöfb&÷VæBG&—âF†RVçF—G’v÷&¶W ¢òò6â6æ6VÂ÷&RÖ&ÒF†B&÷rw26V7W&—G’7F÷–âF†R6ÖR&÷VæFVB×WFF–öà¢òòv†–ÆR×VÇF’×&÷r6Æ÷G26öçF–çVRF‡&÷Vv‚F†RVWVVBvw&VvFRf–æÆ—¦W"à¢6öç7Bvw&VvFT6ö÷&F–æFVBÒ&VÆFVBæÆVæwF‚âÇÂ&VÆFVBç6öÖR‚†6æF–FFR’Óà¢çVÖ&W"†6æF–FFRævw&VvFU&÷FV7F–öäÖVÖ&W$6÷VçBÇÂ’â¢ÇÂ6æF–FFRæ6öçG&öÄ÷&FW%66÷RÓÓÒ'7–Ö&öÅöF—&V7F–öâ ¢ÇÂö&¦V7Bæ¶W—2†6æF–FFRævw&VvFT6öçG&öÄf–ÆÇ2ÇÂ·Ò’æÆVæwF‚âÀ¢¢–b‚vw&VvFT6ö÷&F–æFVB’°¢÷6—F–öâævw&VvFU&÷FV7F–öä×WFF–öå&WVW7FVDBÒVæFVf–æV@¢÷6—F–öâævw&VvFU&÷FV7F–öä×WFF–öå6WGFÆVDBÒVæFVf–æV@¢÷6—F–öâævw&VvFU&÷FV7F–öä×WFF–öå&V6öâÒVæFVf–æV@¢&WGW&âG'VP¢Ð ¢òòöæR&÷r÷vç2F†R6Æ÷B†æBÖöfbBF–ÖRâF†—2&WfVçG2Gvò–æFWVæFVç@¢òò6WBv÷&¶W'2g&öÒö'6W'f–ærF†R6ÖR6WGFÆVB6öçG&öÇ2æB×WFF–ærF†RæW@¢òòfVçVRVçF—G’6öæ7W'&VçFÇ’à¢6öç7B&WVW7FW'2Ò&VÆFV@¢æf–ÇFW"‚†6æF–FFR’ÓâçVÖ&W"†6æF–FFRævw&VvFU&÷FV7F–öä×WFF–öå&WVW7FVDBÇÂ’â¢ç6÷'B‚†Â"’Óà¢çVÖ&W"†ævw&VvFU&÷FV7F–öä×WFF–öå&WVW7FVDBÇÂ¢ÒçVÖ&W"†"ævw&VvFU&÷FV7F–öä×WFF–öå&WVW7FVDBÇÂ¢ÇÂæ–BæÆö6ÆT6ö×&R†"æ–B’À¢¢6öç7B7F—fU&WVW7FW"Ò&WVW7FW'5³Ð¢–b†7F—fU&WVW7FW"bb7F—fU&WVW7FW"æ–BÓÒ÷6—F–öâæ–B’°¢VWVTvw&VvFU&÷FV7F–öäf–æÆ—¦F–öâ‡÷6—F–öâæ6öææV7F–öä–BÂ6Æ÷B¢÷6—F–öâç7—7FVÕ&÷FV7F–öäÆVw2Ò6öæf–wW&VE7—7FVÕ&÷FV7F–öäÆVw2‡÷6—F–öâ¢÷6—F–öâç&÷FV7F–öäÖöFRÒ÷6—F–öâç7F÷Æ÷74÷&FW$–BÇÂ÷6—F–öâçF¶U&öf—D÷&FW$–@¢ò&‡–'&–Eö6öçG&öÅ÷7—7FVÒ ¢¢'7—7FVÕö6Æ÷6UöfÆÆ&6² ¢W6…7FW€¢÷6—F–öâÀ¢&vw&VvFU÷&÷FV7F–öåö×WFF–öå÷v—B"À¢G'VRÀ¢G·6Æ÷GÒVçF—G’†æBÖöfb—2÷væVB'’G¶7F—fU&WVW7FW"æ–GÓ²G·&V6öçÒ&VÖ–ç2VWVVFÀ¢¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢&WGW&âfÇ6P¢Ð ¢6öç7Bvw&VvFT6öçG&öÇ5&W6VçBÒ&VÆFVBç6öÖR‚†6æF–FFR’Óà¢&ööÆVâ†6æF–FFRç7F÷Æ÷74÷&FW$–B¢ÇÂ&ööÆVâ†6æF–FFRçF¶U&öf—D÷&FW$–B¢ÇÂ&ööÆVâ†6æF–FFRç6V7W&—G•7F÷÷&FW$–B¢ÇÂ&ööÆVâ†6æF–FFRçVæF–æu&÷FV7F–öä÷&FW'3òç7F÷Æ÷73òæ6Æ–VçD÷&FW$–B¢ÇÂ&ööÆVâ†6æF–FFRçVæF–æu&÷FV7F–öä÷&FW'3òçF¶U&öf—Còæ6Æ–VçD÷&FW$–B¢ÇÂ&ööÆVâ†6æF–FFRçVæF–æu&÷FV7F–öä÷&FW'3òç6V7W&—G•7F÷òæ6Æ–VçD÷&FW$–B’À¢ ¢–b†7F—fU&WVW7FW#òæ–BÓÓÒ÷6—F–öâæ–B’°¢÷6—F–öâævw&VvFU&÷FV7F–öä¶W’Ò6Æ÷@¢÷6—F–öâævw&VvFU&÷FV7F–öäÖVÖ&W$6÷VçBÒ&VÆFVBæÆVæwF€¢÷6—F–öâævw&VvFU&÷FV7F–öä×WFF–öå&WVW7FVDBÒ7F—fU&WVW7FW"ævw&VvFU&÷FV7F–öä×WFF–öå&WVW7FVD@¢÷6—F–öâævw&VvFU&÷FV7F–öä×WFF–öå6WGFÆVDBÒ7F—fU&WVW7FW"ævw&VvFU&÷FV7F–öä×WFF–öå6WGFÆVD@¢÷6—F–öâævw&VvFU&÷FV7F–öä×WFF–öå&V6öâÒ7F—fU&WVW7FW"ævw&VvFU&÷FV7F–öä×WFF–öå&V6öâÇÂ&V6öà¢VWVTvw&VvFU&÷FV7F–öäf–æÆ—¦F–öâ‡÷6—F–öâæ6öææV7F–öä–BÂ6Æ÷B¢–b€¢vw&VvFT6öçG&öÇ5&W6Vç@¢bbçVÖ&W"†7F—fU&WVW7FW"ævw&VvFU&÷FV7F–öä×WFF–öå6WGFÆVDBÇÂ’â ¢’°¢òòF÷BF†RWF†÷&—FF—fR÷7B×6WGFÆVÖVçB6öçG&öÂ6æ6†÷B&Vf÷&RF†P¢òò6ÆÆW"7&VFW2—G2GW&&ÆRVçF—G’7F–öâà¢6öç7B7W'&VçBÒ&VÆFVBæf–æB‚†6æF–FFR’Óâ6æF–FFRæ–BÓÓÒ÷6—F–öâæ–B’ÇÂ7F—fU&WVW7FW ¢÷6—F–öâç7F÷Æ÷74÷&FW$–BÒ7W'&VçBç7F÷Æ÷74÷&FW$–@¢÷6—F–öâçF¶U&öf—D÷&FW$–BÒ7W'&VçBçF¶U&öf—D÷&FW$–@¢÷6—F–öâç6V7W&—G•7F÷÷&FW$–BÒ7W'&VçBç6V7W&—G•7F÷÷&FW$–@¢÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'2Ò7W'&VçBçVæF–æu&÷FV7F–öä÷&FW'0¢÷6—F–öâç7F÷Æ÷75&–6RÒçVÖ&W"†7W'&VçBç7F÷Æ÷75&–6RÇÂ¢÷6—F–öâçF¶U&öf—E&–6RÒçVÖ&W"†7W'&VçBçF¶U&öf—E&–6RÇÂ¢÷6—F–öâç6V7W&—G•7F÷&–6RÒçVÖ&W"†7W'&VçBç6V7W&—G•7F÷&–6RÇÂ¢6WE&÷FV7F–öäÆVt&ÖVEVçF—G’‡÷6—F–öâÂ'7F÷öÆ÷72"Â&÷FV7F–öäÆVt&ÖVEVçF—G’†7W'&VçBÂ'7F÷öÆ÷72"’¢6WE&÷FV7F–öäÆVt&ÖVEVçF—G’‡÷6—F–öâÂ'F¶U÷&öf—B"Â&÷FV7F–öäÆVt&ÖVEVçF—G’†7W'&VçBÂ'F¶U÷&öf—B"’¢÷6—F–öâç6V7W&—G•7F÷&ÖVEVçF—G’ÒçVÖ&W"†7W'&VçBç6V7W&—G•7F÷&ÖVEVçF—G’ÇÂ¢W6…7FW€¢÷6—F–öâÀ¢&vw&VvFU÷&÷FV7F–öåö×WFF–öå÷&W7VÖR"À¢G'VRÀ¢G·6Æ÷GÒ6öçG&öÇ26WGFÆVBBG¶7F—fU&WVW7FW"ævw&VvFU&÷FV7F–öä×WFF–öå6WGFÆVDGÓ²&W7VÖ–ærG·&V6öçÖÀ¢¢&WGW&âG'VP¢Ð ¢÷6—F–öâç7—7FVÕ&÷FV7F–öäÆVw2Ò6öæf–wW&VE7—7FVÕ&÷FV7F–öäÆVw2‡÷6—F–öâ¢÷6—F–öâç&÷FV7F–öäÖöFRÒ÷6—F–öâç7F÷Æ÷74÷&FW$–BÇÂ÷6—F–öâçF¶U&öf—D÷&FW$–@¢ò&‡–'&–Eö6öçG&öÅ÷7—7FVÒ ¢¢'7—7FVÕö6Æ÷6UöfÆÆ&6² ¢W6…7FW€¢÷6—F–öâÀ¢&vw&VvFU÷&÷FV7F–öåö×WFF–öå÷v—B"À¢G'VRÀ¢G·6Æ÷GÒ&÷r÷6V7W&—G’6öçG&öÇ2&R7F–ÆÂ6WGFÆ–ær&Vf÷&RG·&V6öçÖÀ¢¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢&WGW&âfÇ6P¢Ð ¢–b‚vw&VvFT6öçG&öÇ5&W6VçB’&WGW&âG'VP ¢÷6—F–öâævw&VvFU&÷FV7F–öä¶W’Ò6Æ÷@¢÷6—F–öâævw&VvFU&÷FV7F–öäÖVÖ&W$6÷VçBÒ&VÆFVBæÆVæwF€¢÷6—F–öâævw&VvFU&÷FV7F–öä×WFF–öå&WVW7FVDBÒFFRææ÷r‚¢÷6—F–öâævw&VvFU&÷FV7F–öä×WFF–öå6WGFÆVDBÒVæFVf–æV@¢÷6—F–öâævw&VvFU&÷FV7F–öä×WFF–öå&V6öâÒ&V6öà¢VWVTvw&VvFU&÷FV7F–öäf–æÆ—¦F–öâ‡÷6—F–öâæ6öææV7F–öä–BÂ6Æ÷B¢÷6—F–öâç7—7FVÕ&÷FV7F–öäÆVw2Ò6öæf–wW&VE7—7FVÕ&÷FV7F–öäÆVw2‡÷6—F–öâ¢÷6—F–öâç&÷FV7F–öäÖöFRÒ÷6—F–öâç7F÷Æ÷74÷&FW$–BÇÂ÷6—F–öâçF¶U&öf—D÷&FW$–@¢ò&‡–'&–Eö6öçG&öÅ÷7—7FVÒ ¢¢'7—7FVÕö6Æ÷6UöfÆÆ&6² ¢W6…7FW€¢÷6—F–öâÀ¢&vw&VvFU÷&÷FV7F–öåö×WFF–öå÷v—B"À¢G'VRÀ¢G·6Æ÷GÒvw&VvFR6öçG&öÇ2×W7B6WGFÆR&Vf÷&RG·&V6öçÓ²&WG'––æröâF†RæW‡B7–6ÆVÀ¢¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢&WGW&âfÇ6P§Ð ¢ò¢¢6öæf—&Ò&÷FV7F–öâ6WGFÆVÖVçB&Vf÷&Râ–æFWVæFVçB÷6—F–öâ×6—¦RFVÇFâ¢ð¦7–æ2gVæ7F–öâ6WGFÆT6öçG&öÄ÷&FW'4&Vf÷&UVçF—G”×WFF–öâ€¢6öææV7F÷#¢ç’À¢÷6—F–öã¢Æ—fU÷6—F–öâÀ¢&V6öã¢7G&–ærÀ¢“¢&öÖ—6SÆ&ööÆVãâ°¢–b‚6öææV7F÷"’&WGW&âG'VP¢–b‡÷6—F–öâçVæF–æu7—7FVÔ7F–öâ’°¢W6…7FW‡÷6—F–öâÂ'VçF—G•ö6†ævU÷v—B"ÂG'VRÂG·&V6öçÓ¢7—7FVÒ7F–öâ—27F–ÆÂ6ö÷&F–æFVF¢&WGW&âfÇ6P¢Ð¢6öç7BF—&V7F–öâÒ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ‡÷6—F–öâ¢–b‚F—&V7F–öâ’°¢W6…7FW‡÷6—F–öâÂ'VçF—G•ö6†ævUöF—&V7F–öåöwV&B"ÂfÇ6RÂG·&V6öçÓ¢–çfÆ–B÷6—F–öâF—&V7F–öæ¢&WGW&âfÇ6P¢Ð¢–b‚v—B&WVW7Dvw&VvFU&÷FV7F–öå6Æ÷D×WFF–öâ†6öææV7F÷"Â÷6—F–öâÂ&V6öâ’’&WGW&âfÇ6P ¢6öç7BVçF—G”&Vf÷&RÒÖF‚æÖ‚ƒÂçVÖ&W"€¢÷6—F–öâçVæF–æuVçF—G”×WFF–öãòçVçF—G”&Vf÷&Róò÷6—F–öâæW†V7WFVEVçF—G’óòÀ¢’¢6öç7B7F–öâÒ÷6—F–öâçVæF–æuVçF—G”×WFF–öâÇÂ°¢Fö¶Vã¢VçF—G“¢G·÷6—F–öâæ–GÓ¢G¶ææö–Bƒ‚—ÖÀ¢&V6öâÀ¢†6S¢&6öçG&öÅö6æ6VÂ"26öç7BÀ¢6öçG&öÄ÷&FW$–G3¢µÒÀ¢VçF—G”&Vf÷&RÀ¢7F'FVDC¢FFRææ÷r‚’À¢WFFVDC¢FFRææ÷r‚’À¢Ð¢7F–öâç&V6öâÒ&V6öà¢7F–öâçWFFVDBÒFFRææ÷r‚ ¢6öç7B–G2ÒæWr6WCÇ7G&–æsâ†7F–öâæ6öçG&öÄ÷&FW$–G2ÇÂµÒ¢–b‡÷6—F–öâç7F÷Æ÷74÷&FW$–B’–G2æFB…7G&–ær‡÷6—F–öâç7F÷Æ÷74÷&FW$–B’¢–b‡÷6—F–öâçF¶U&öf—D÷&FW$–B’–G2æFB…7G&–ær‡÷6—F–öâçF¶U&öf—D÷&FW$–B’¢òòF†Rvw&VvFR6V7W&—G’7F÷—2Ç6ò6—¦VBFòF†R&RÖ×WFF–öâfVçVP¢òòVçF—G’âÆVf–ær—BÆ—fRv†–ÆRâFB÷&VGV6R—2–âfÆ–v‡BV—F†W"ÆVfW0¢òòF†RæWrVçF—G’Vç&÷FV7FVB÷"ÆWG27FÆRgVÆÂ×6Æ÷B7F÷6Æ÷6RÖ÷&P¢òòF†âF†R–çFVæFVB&WF–æVBVçF—G’â—B×W7B7&÷72F†R6ÖR6æ6VÆÆF–öà¢òòæBWF†÷&—FF—fR×÷6—F–öâ&'&–W"2F†R&÷r4ÂõE—"à¢–b‡÷6—F–öâç6V7W&—G•7F÷÷&FW$–B’–G2æFB…7G&–ær‡÷6—F–öâç6V7W&—G•7F÷÷&FW$–B’¢6öç7BVç&W6öÇfVC¢'&“Â'7F÷Æ÷72"Â'F¶U&öf—B#âÒµÐ¢f÷"†6öç7BÆVröb²'7F÷Æ÷72"Â'F¶U&öf—B%Ò26öç7B’°¢6öç7BVæF–ærÒ÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'3òå¶ÆVuÐ¢–b‚VæF–æsòæ6Æ–VçD÷&FW$–B’6öçF–çVP¢6öç7B&V6÷fW&VBÒv—B&V6÷fW$VçG'”÷&FW$'”6Æ–VçD–B†6öææV7F÷"Â÷6—F–öâç7–Ö&öÂÂVæF–æræ6Æ–VçD÷&FW$–B¢–b‡&V6÷fW&VB’°¢6öç7B÷&FW$–BÒ7G&–ær‡&V6÷fW&VBæ÷&FW$–Bóò&V6÷fW&VBæ–B¢–G2æFB†÷&FW$–B¢–b†ÆVrÓÓÒ'7F÷Æ÷72"’÷6—F–öâç7F÷Æ÷74÷&FW$–BÒ÷&FW$–@¢VÇ6R÷6—F–öâçF¶U&öf—D÷&FW$–BÒ÷&FW$–@¢FVÆWFR÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'3òå¶ÆVuÐ¢ÒVÇ6R°¢Vç&W6öÇfVBçW6‚†ÆVr¢Ð¢Ð¢7F–öâæ6öçG&öÄ÷&FW$–G2Ò²ââæ–G5Ð¢÷6—F–öâçVæF–æuVçF—G”×WFF–öâÒ7F–öà ¢–b†7F–öâç†6RÓÓÒ&6öçG&öÅö6æ6VÂ"’°¢f÷"†6öç7B÷&FW$–Böb–G2’°¢6öç7B6æ6VÆÆVBÒv—B6æ6VÅ&÷FV7F–öä÷&FW"€¢6öææV7F÷"À¢÷6—F–öâç7–Ö&öÂÀ¢÷&FW$–BÀ¢VçF—G”×WFF–öâÒG·&V6öçÖÀ¢÷6—F–öâæ6öææV7F–öä–BÀ¢¢–b‚6æ6VÆÆVB’°¢W6…7FW‡÷6—F–öâÂ'VçF—G•ö6†ævU÷v—B"ÂG'VRÂG·&V6öçÓ¢6öçG&öÂG¶÷&FW$–GÒ6æ6VÆÆF–öâVæ6öæf—&ÖVF¢&WGW&âfÇ6P¢Ð¢Ð¢Ð ¢ÆWBÆ—fT÷&FW$–G3¢6WCÇ7G&–æsâÂçVÆÂÒæWr6WB‚¢–b†–G2ç6—¦RâÇÂVç&W6öÇfVBæÆVæwF‚â’°¢Æ—fT÷&FW$–G2Òv—BfWF6„Æ—fT÷&FW$–E6WB†6öææV7F÷"¢–b‡G—Vöb6öææV7F÷"ævWD÷Vä÷&FW'2ÓÓÒ&gVæ7F–öâ"bbÆ—fT÷&FW$–G2ÓÓÒçVÆÂ’°¢W6…7FW‡÷6—F–öâÂ'VçF—G•ö6†ævU÷v—B"ÂG'VRÂG·&V6öçÓ¢÷VâÖ÷&FW"6æ6†÷BVæf–Æ&ÆV¢&WGW&âfÇ6P¢Ð¢6öç7B7F–ÆÅf—6–&ÆRÒ²ââæ–G5Òæf–ÇFW"‚†–B’ÓâÆ—fT÷&FW$–G3òæ†2†–B’¢–b‡7F–ÆÅf—6–&ÆRæÆVæwF‚â’°¢W6…7FW‡÷6—F–öâÂ'VçF—G•ö6†ævU÷v—B"ÂG'VRÂG·&V6öçÓ¢6öçG&öÇ27F–ÆÂf—6–&ÆRG·7F–ÆÅf—6–&ÆRæ¦ö–â‚"Â"—Ö¢&WGW&âfÇ6P¢Ð¢Ð ¢f÷"†6öç7BÆVröbVç&W6öÇfVB’°¢6öç7BVæF–ærÒ÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'3òå¶ÆVuÐ¢–b‚VæF–ær’6öçF–çVP¢–b†Æ—fT÷&FW$–G3òæ†2‡VæF–æræ6Æ–VçD÷&FW$–B’’°¢W6…7FW‡÷6—F–öâÂ'VçF—G•ö6†ævU÷v—B"ÂG'VRÂG·&V6öçÓ¢VæF–ærG¶ÆVwÒ—2f—6–&ÆR'’6Æ–VçB–F¢&WGW&âfÇ6P¢Ð¢VæF–æræ'6Væ6T6öæf—&ÖF–öç2ÒçVÖ&W"‡VæF–æræ'6Væ6T6öæf—&ÖF–öç2ÇÂ’²¢–b‡VæF–æræ'6Væ6T6öæf—&ÖF–öç2Â"’°¢W6…7FW‡÷6—F–öâÂ'VçF—G•ö6†ævU÷v—B"ÂG'VRÂG·&V6öçÓ¢VæF–ærG¶ÆVwÒæVVG26V6öæB'6Væ6R6öæf—&ÖF–öæ¢&WGW&âfÇ6P¢Ð¢FVÆWFR÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'3òå¶ÆVuÐ¢Ð ¢7F–öâç†6RÒ'÷6—F–öå÷fW&–g’ ¢7F–öâçWFFVDBÒFFRææ÷r‚¢÷6—F–öâçVæF–æuVçF—G”×WFF–öâÒ7F–öà ¢6öç7BWF†÷&—FF—fRÒv—BfWF6„WF†÷&—FF—fT÷VåVçF—G’†6öææV7F÷"Â÷6—F–öâç7–Ö&öÂÂF—&V7F–öâÂ÷6—F–öâæ6öææV7F–öä–B¢–b‚WF†÷&—FF—fRæö²’°¢W6…7FW‡÷6—F–öâÂ'VçF—G•ö6†ævU÷v—B"ÂG'VRÂG·&V6öçÓ¢WF†÷&—FF—fR÷6—F–öâ6æ6†÷BVæf–Æ&ÆV¢&WGW&âfÇ6P¢Ð ¢òòöæÇ’æ÷r—2—B6fRFòf÷&vWBF†R&–÷"&÷FV7F–öâ–FVçF–f–W'2âf–ÆV@¢òò÷6—F–öâ6æ6†÷B&WF–ç2F†VÒ–âVæF–æuVçF—G”×WFF–öâf÷"F†RæW‡@¢òò7–6ÆRÂ&WfVçF–ær7FÆR×6—¦RFVÇFg&öÒ6Æ—–ærF‡&÷Vv‚à¢÷6—F–öâç7F÷Æ÷74÷&FW$–BÒVæFVf–æV@¢÷6—F–öâçF¶U&öf—D÷&FW$–BÒVæFVf–æV@¢÷6—F–öâç7F÷Æ÷75&–6RÒ ¢÷6—F–öâçF¶U&öf—E&–6RÒ ¢÷6—F–öâç6V7W&—G•7F÷÷&FW$–BÒVæFVf–æV@¢÷6—F–öâç6V7W&—G•7F÷&–6RÒ ¢÷6—F–öâç7F÷Æ÷74&ÖVEVçF—G’Ò ¢÷6—F–öâçF¶U&öf—D&ÖVEVçF—G’Ò ¢÷6—F–öâç6V7W&—G•7F÷&ÖVEVçF—G’Ò ¢÷6—F–öâç&÷FV7F–öä&ÖVEVçF—G’Ò  ¢6öç7BÆö6ÅVçF—G’ÒÖF‚æÖ‚ƒÂçVÖ&W"‡÷6—F–öâæW†V7WFVEVçF—G’ÇÂ’¢6öç7BFöÆW&æ6RÒÖF‚æÖ‚ƒRÓ"ÂÆö6ÅVçF—G’¢RÓ‚¢–b†WF†÷&—FF—fRçVçF—G’ÂÆö6ÅVçF—G’ÒFöÆW&æ6R’°¢6öç7BW†V7WF–öä–BÒG·÷6—F–öâæ–GÓ¢G¶–G2ç6—¦Râò'VçF—G’Ö6öçG&öÂ"¢'VçF—G’×7–æ2'Ó¢Gµ²ââæ–G5Òç6÷'B‚’æ¦ö–â‚"²"’ÇÂ7F–öâçFö¶VçÖ ¢6öç7BW†—7F–ærÒ÷6—F–öâç'F–Ä÷&FW$W†V7WF–öç3òæf–æB‚†VçG'’’ÓâVçG'’æ–BÓÓÒW†V7WF–öä–B¢Ç•&VGV7F–öäö'6W'fF–öâ‡÷6—F–öâÂ°¢W†V7WF–öä–BÀ¢6÷W&6S¢–G2ç6—¦Râò&6öçG&öÅö÷&FW""¢&W†6†ævU÷&V6öæ6–ÆR"À¢7FGW3¢WF†÷&—FF—fRçVçF—G’ÃÒò&f–ÆÆVB"¢''F–ÆÇ•öf–ÆÆVB"À¢&WVW7FVEVçF—G“¢Æö6ÅVçF—G’À¢&W÷'FVDf–ÆÆVEVçF—G“¢À¢&Wf–÷W6Ç”Æ–VEVçF—G“¢çVÖ&W"†W†—7F–æsòæ7V×VÆF—fTf–ÆÆVEVçF—G’ÇÂ’À¢WF†÷&—FF—fUVçF—G“¢WF†÷&—FF—fRçVçF—G’À¢Ò¢ÒVÇ6R–b†WF†÷&—FF—fRçVçF—G’âÆö6ÅVçF—G’²FöÆW&æ6R’°¢6öç7BFFVBÒWF†÷&—FF—fRçVçF—G’ÒÆö6ÅVçF—G¢÷6—F–öâæW†V7WFVEVçF—G’ÒWF†÷&—FF—fRçVçF—G¢÷6—F–öâçVçF—G’ÒWF†÷&—FF—fRçVçF—G¢÷6—F–öâç&VÖ–æ–æuVçF—G’Ò ¢÷6—F–öâçF÷FÄW†V7WFVEVçF—G’ÒÖF‚æÖ‚€¢çVÖ&W"‡÷6—F–öâçF÷FÄW†V7WFVEVçF—G’ÇÂ’²FFVBÀ¢WF†÷&—FF—fRçVçF—G’²çVÖ&W"‡÷6—F–öâæ6Æ÷6VEVçF—G’ÇÂ’À¢¢÷6—F–öâçföÇVÖUW6BÒ÷6—F–öäæ÷F–öæÅW6B€¢÷6—F–öâÀ¢WF†÷&—FF—fRçVçF—G’À¢çVÖ&W"‡÷6—F–öâæfW&vTW†V7WF–öå&–6RÇÂ÷6—F–öâæVçG'•&–6RÇÂ’À¢¢–b‡÷6—F–öâæ6öÖ&–æVE÷46÷VçG2’°¢÷6—F–öâç÷46÷VçG56WEVçF—F–W2ÒÆÆö6FU÷6—F–öå6WEVçF—F–W2€¢÷6—F–öâÀ¢WF†÷&—FF—fRçVçF—G’À¢÷6—F–öâæ67V×VÆFVE6WD¶W—2ÇÂµÒÀ¢¢Ð¢W6…7FW‡÷6—F–öâÂ'VçF—G•öW†6†ævU÷7–æ2"ÂG'VRÂG¶Æö6ÅVçF—G—Ò(i"G¶WF†÷&—FF—fRçVçF—G—Ò&Vf÷&RG·&V6öçÖ¢Ð ¢÷6—F–öâçVæF–æuVçF—G”×WFF–öâÒVæFVf–æV@¢–b†WF†÷&—FF—fRçVçF—G’ÃÒRÓ"’°¢÷6—F–öâç7FGW5&V6öâÒG·&V6öçÓ¢6öçG&öÂ÷&FW"6Æ÷6VB÷6—F–öâ&Vf÷&RVçF—G’×WFF–öæ ¢W6…7FW‡÷6—F–öâÂ'VçF—G•ö6†ævU÷v—B"ÂG'VRÂ÷6—F–öâç7FGW5&V6öâ¢&WGW&âfÇ6P¢Ð¢W6…7FW‡÷6—F–öâÂ'VçF—G•ö6öçG&öÅö&'&–W""ÂG'VRÂG·&V6öçÓ¢6öçG&öÇ26WGFÆVC²–æFWVæFVçBVçF—G’FVÇFÖ’W†V7WFV¢&WGW&âG'VP§Ð ¢ò¢ ¢¢6Æ÷6RÆ—fR÷6—F–öâ†Ö&¶WBW†—B’æB&VÆV6R—G2FVGWÆö6²à¢ ¢¢÷&FW"öb÷W&F–öç2—27&—F–6ÂFòfö–B÷'†â÷&FW'2bÆV¶VB–æF–6W3 ¢¢â&V6öæ6–ÆRç’7F—fR÷'F–Â4ÂõE÷"GW&&ÆR'F–Â7F–öâæBv—@¢¢VçF–Â—G2VffV7B÷"6öæf—&ÖVB6æ6VÆÆF–öâ—2WF†÷&—FF—fRà¢¢"âW'6—7BöæR–FV×÷FVçB7—7FVÒÖ6Æ÷6R–çFVçBÂ—77VR—BöæÇ’gFW"F†@¢¢&'&–W"ÂF†VâfW&–g’F†R&VÖ–æ–ærW†6†ævRVçF—G’âf–ÆVBÀ¢¢'F–ÂÂ÷"Væ6öæf—&ÖVBfVçVP¢¢6Æ÷6R&öÆÇ2F†RÆö6Â&V6÷&B&6²Fò—G2&–÷"÷Vâ7FFRæB&RÖ&×0¢¢&÷FV7F–öã²öæÇ’WF†÷&—FF—fR7V66W72öÇ&VG’ÖvöæR6öæf—&ÖF–öâÖ¢¢VçFW"F†RFW&Ö–æÂ&6†—fRà¢¢2â6ö×WFR&VÆ—¦VBäÂ²Ö&v–âÖ&6VB$ô’†ÖF6†W2W†6†ævR$ôR’à¢¢BâW'6—7Bf–6fU÷6—F–öâ‚’ûûÞûûÒF†B†VÇW"Ç&VG’†æFÆW2F†P¢¢÷VâÖ–æFW‚ûûÞûûÞûûÞûûÒ6Æ÷6VBÖ&6†—fRÖ÷fR–FV×÷FVçFÇ’âvRFòäõBF÷V6€¢¢&VF—2F—&V7FÇ’ç’Ö÷&R‡v†–6‚&Wf–÷W6Ç’ÆVgBF†R÷6—F–öâ–à¢¢F†R÷Vâ–æFW‚f÷&WfW"öâÖçVÂ6Æ÷6R’à¢¢Râ&VÆV6RF†RFVGWÆö6²6ò7V'6WVVçB6–væÂ6â&RÖVçFW"à¢¢ð¦W‡÷'B7–æ2gVæ7F–öâ6Æ÷6TÆ—fU÷6—F–öâ€¢6öææV7F–öä–C¢7G&–ærÀ¢Æ—fU÷6—F–öä–C¢7G&–ærÀ¢6Æ÷6U&–6S¢çVÖ&W"À¢W†6†ævT6öææV7F÷#ó¢ç’À¢6Æ÷6U&V6öã¢7G&–ærÒ&ÖçVÂ"À¢“¢&öÖ—6SÄÆ—fU÷6—F–öâÂçVÆÃâ°¢v—B–æ—E&VF—2‚¢6öç7B6Æ–VçBÒvWE&VF—46Æ–VçB‚¢6öç7BÆö6´–BÒ6Æ÷6S¢G¶6Æ÷6U&V6öçÓ¢G·&ö6W72ç–GÓ¢G´FFRææ÷r‚—Ó¢G¶ææö–Bƒ‚—Ö ¢ÆWB×WFF–öäÆö6´†VÆBÒfÇ6P¢ÆWB7F÷÷6—F–öäÆö6´ÆV6U&Vg&W6ƒ¢‚‚’Óâfö–B’ÂçVÆÂÒçVÆÀ ¢G'’°¢6öç7B÷6—F–öâÒv—B&VDÆ—fU÷6—F–öå6æ6†÷B†6Æ–VçBÂ6öææV7F–öä–BÂÆ—fU÷6—F–öä–B¢–b‚÷6—F–öâ’&WGW&âçVÆÀ¢òò7–Ö&öÂöF—&V7F–öâ÷"W†6†ævR×÷6—F–öâ–B—2æ÷B÷væW'6†—öâ6†&V@¢òò66÷VçBâ&VgW6R&Vf÷&RF¶–ær×WFF–öâÆö6²Â6†æv–ærÆö6Â7FGW2À¢òò6æ6VÆÆ–ær6öçG&öÇ2Â÷"6VæF–ær&VGV6RÖöæÇ’÷&FW"à¢–b‚—57—7FVÕG&6¶VDÆ—fU÷6—F–öâ‡÷6—F–öâÂ6öææV7F–öä–B’’°¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢'v&æ–ær"À¢&Æö6¶VB6Æ÷6Rf÷"Væ÷væVBÆ–fV7–6ÆR&÷rG·÷6—F–öâç7–Ö&öÂÇÂ'Væ¶æ÷vâ'ÖÀ¢°¢÷6—F–öä–C¢÷6—F–öâæ–BÀ¢&WVW7FVD6öææV7F–öä–C¢6öææV7F–öä–BÀ¢W'6—7FVD6öææV7F–öä–C¢÷6—F–öâæ6öææV7F–öä–BÀ¢&V6öã¢&W†7E÷7—7FVÕö6öææV7F–öåö÷væW'6†—÷&WV—&VB"À¢ÒÀ¢’æ6F6‚‚‚’Óâ·Ò¢&WGW&â÷6—F–öà¢Ð¢6öç7B&W6öÇfVDF—&V7F–öâÒ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ‡÷6—F–öâ¢–b‚&W6öÇfVDF—&V7F–öâ’°¢÷6—F–öâç7FGW5&V6öâÒ&W†6†ævUö6Æ÷6Uö&Æö6¶VEö–çfÆ–EöF—&V7F–öâ ¢W6…7FW‡÷6—F–öâÂ&6Æ÷6UöF—&V7F–öåöwV&B"ÂfÇ6RÂ$æòW‡Æ–6—BÆöær÷6†÷'BF—&V7F–öã²æòW†6†ævR6Æ÷6R÷"6öçG&öÂ6æ6VÆÆF–öâv26VçB"¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&W'&÷""À¢&Æö6¶VBW†6†ævR6Æ÷6Rf÷"G·÷6—F–öâç7–Ö&öÇÓ¢Ö—76–ærW‡Æ–6—BÆöær÷6†÷'BF—&V7F–öæÀ¢²÷6—F–öä–C¢÷6—F–öâæ–BÂ7–Ö&öÃ¢÷6—F–öâç7–Ö&öÂÒÀ¢’æ6F6‚‚‚’Óâ·Ò¢&WGW&â÷6—F–öà¢Ð¢÷6—F–öâæF—&V7F–öâÒ&W6öÇfVDF—&V7F–öà¢÷6—F–öâç6–FRóóÒ&W6öÇfVDF—&V7F–öà¢6öç7B÷&–v–æÅ7FGW2Ò÷6—F–öâç7FGW0¢ÆWB6öæf—&ÖVD6Æ÷6T÷&FW$–BÒ7G&–ær€¢÷6—F–öâæ6Æ÷6T÷&FW$–BÇÂ÷6—F–öâçVæF–æu7—7FVÔ7F–öãòæ÷&FW$–BÇÂ""À¢’çG&–Ò‚ ¢òòöæ6RâÖ&–wV÷W26Æ÷6RFVÆ—fW'’†2&VVâ&÷fVB'6VçBÂ¶VWF†P¢òò÷6—F–öâ&÷FV7FVBæBfö–BVçFW&–ærF†R×WFF–öâö6æ6VÆÆF–öâF‚@¢òòÆÂVçF–Â—G2GW&&ÆR&WG'’v–æF÷r÷Vç2ââVç&W6öÇfVB6Æ–VçBö÷&FW"–@¢òò—2æWfW"6†÷'BÖ6—&7V—FVB†W&S¢—B×W7Bf—'7B72F†RWF†÷&—FF—fP¢òò&V6÷fW'’&'&–W"&VÆ÷r6òF†R6ÖRFVÆ—fW'’6ææ÷B&R7V&Ö—GFVBGv–6Rà¢–b€¢W†6†ævT6öææV7F÷"b`¢÷&–v–æÅ7FGW2ÓÒ'6–×VÆFVB"b`¢—57—7FVÔ6Æ÷6U&WG'”FVfW'&VB‡÷6—F–öâ’b`¢†5Vç&W6öÇfVE7—7FVÔ6Æ÷6TFVÆ—fW'’‡÷6—F–öâ¢’°¢Æöu'VçF–ÖT–æfò€¢7—7FVÒÖ6Æ÷6RÖ&6¶öfc¢G¶6öææV7F–öä–GÓ¢G·÷6—F–öâæ–GÖÀ¢3óÀ¢G´Äôuõ$Td•‡Ò7—7FVÒ6Æ÷6R&WG'’FVfW'&VBf÷"G·÷6—F–öâç7–Ö&öÇÒG·÷6—F–öâæF—&V7F–öçÓ²°¢GFV×CÒG·÷6—F–öâç7—7FVÔ6Æ÷6U&WG'“òç&WG'”6÷VçBÇÂÒ°¢6Æ73ÒG·÷6—F–öâç7—7FVÔ6Æ÷6U&WG'“òæÆ7Df–ÇW&T6Æ72ÇÂ'Væ¶æ÷vâ'ÖÀ¢¢&WGW&â÷6—F–öà¢Ð ¢6öç7BÆö6¶VBÒv—B7V—&U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6´–B¢–b‚Æö6¶VB’&WGW&âçVÆÀ¢×WFF–öäÆö6´†VÆBÒG'VP¢7F÷÷6—F–öäÆö6´ÆV6U&Vg&W6‚Ò7F'E&VF—4Æö6´ÆV6U&Vg&W6‚€¢6Æ–VçBÀ¢÷6—F–öä×WFF–öäÆö6´¶W’†6öææV7F–öä–BÂÆ—fU÷6—F–öä–B’À¢Æö6´–BÀ¢õ4•D”ôåôÕUDD”ôåôÄô4µõEDÅôÕ2À¢¢6öç7BG&ç6—F–öæVBÒv—B×WFFU÷6—F–öåv—F…fW'6–öä6†V6²‡÷6—F–öâÂ²&÷Vâ"Â&f–ÆÆVB"Â''F–ÆÇ•öf–ÆÆVB"Â'Æ6VB"Â'VæF–æuöf–ÆÂ"Â'Æ6VE÷Væ6öæf—&ÖVB"Â'6–×VÆFVB"Â&6Æ÷6–ær"Â&6Æ÷6–æu÷'F–Â%ÒÂG&gBÓâ°¢G&gBç7FGW2Ò&6Æ÷6–ær ¢G&gBæÆö6¶VDBÒFFRææ÷r‚¢G&gBæÆö6¶VD'’ÒÆö6´–@¢Ò¢–b‚G&ç6—F–öæVB’°¢v—B&VÆV6U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6´–B’æ6F6‚‚‚’ÓâfÇ6R¢&WGW&âçVÆÀ¢Ð¢ö&¦V7Bæ76–vâ‡÷6—F–öâÂG&ç6—F–öæVB¢òòÖ—'&÷"F†RFöÖ–2†6‚G&ç6—F–öâ–çFòF†R¥4ôâö–æFW‚6æ6†÷BæBÂf÷ ¢òò–æÆ–æR&VF—2ÂfÇW6‚—BFòF—6²&Vf÷&R6æ6VÆÆF–öâö6Æ÷6R&WVW7G2ÆVfP¢òòF†R&ö6W72â&W7F'B6âæ÷rF—7F–æwV—6‚æB&V6öæ6–ÆRâ–çFW''WFV@¢òò6Æ÷6R–ç7FVBöb&W7W'&V7F–ærF†R&–÷"÷Vâ6æ6†÷Bà¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢v—BW'6—7D7&—F–6ÄÆ—fU7FFR†6Æ÷6S¢G·÷6—F–öâæ–GÖ ¢òò)H)H÷væW'6†—wV&B)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òòFW&—fVBd•%5B(	B&Vf÷&R'V–ÆF–ærç’6æ6VÆÆF–öâ&öÖ—6W2(	B6òvP¢òò6âvFRF†R4ÂõE6æ6VÂöâ÷væW'6†—âv—F†÷WBF†—2vFRÂ÷6—F–öà¢òòF÷FVB÷&V6öæ6–ÆVBg&öÒF†RW†6†ævR†æò7—7FVÒ÷&FW$–B’v÷VÆB†fP¢òò—G2÷W&F÷"×Æ6VB&÷FV7F–öâ÷&FW'26æ6VÆÆVBv†–ÆRF†R6Æ÷6R6ÆÀ¢òò—G6VÆb—26÷'&V7FÇ’6¶—VBÂÆVf–ærF†R÷6—F–öâöâF†RW†6†ævP¢òò6ö×ÆWFVÇ’Vç&÷FV7FVBà¢òð¢òòöæÇ’—77VRW†6†ævR6ÆÇ2v†VâF†R7—7FVÒ†2fW&–f–VB÷&FW$–B(	@¢òò&ööbF†BtRÆ6VBF†RVçG'’÷&FW"âv—F†÷WBâ÷&FW$–BF†R÷6—F–öà¢òòv26–×VÆFVBÂF†RVçG'’÷&FW"f–ÆVB6–ÆVçFÇ’Â÷"F†R6Æ÷Bv0¢òòÆÆö6FVB'WBæWfW"6öæf—&ÖVBà¢òð¢òòfÆÆ&6³¢–b÷&FW$–F—2Ö—76–ær'WBW†6†ævU÷6—F–öä–FW†—7G0¢òò‡&V6öæ6–ÆVBöF÷FVB÷6—F–öâ’ÂW6R—BFò6Æ÷6Rf–W†6†ævR×6–FP¢òò÷6—F–öâ”Bâv—F†÷WBT•D„U"Â6¶—ÆÂW†6†ævR÷W&F–öç2à¢6öç7B†57—7FVÔ÷&FW$–BÒ‡÷6—F–öâæ÷&FW$–BÇÂ÷6—F–öâæW†6†ævTFFòæW†6†ævU÷6—F–öä–B ¢6öç7B†E6Ä–BÒ÷6—F–öâç7F÷Æ÷74÷&FW$–@¢6öç7B†EG–BÒ÷6—F–öâçF¶U&öf—D÷&FW$–@ ¢òò&Vg&W6‚WfW'’¶æ÷vâVçG'’÷&FW"&Vf÷&RF†Rf—'7B&VGV7F–öâ—2Æ–VBà¢òòF†—2&W—'2&W7F'G2æBF†Ræ÷&ÖÂf–ÆÂÖ†—7F÷'’&÷vF–öâFVÆ’Âæ@¢òòv—fW2&–æu‚‡v†÷6R6Æ÷6R6WGFÆVÖVçBW†6ÇVFW2VçG'’fVW2’F†RW†7BfVP¢òòÖ÷VçBæVVFVBf÷"æWBäÂâVæ¶æ÷vâVçG'’fVW27F’W‡Æ–6—FÇ’–æ6ö×ÆWFRà¢–b†W†6†ævT6öææV7F÷"bb÷&–v–æÅ7FGW2ÓÒ'6–×VÆFVB"’°¢v—B&Vg&W6„VçG'”÷&FW$66÷VçF–ær†W†6†ævT6öææV7F÷"Â÷6—F–öâ¢Ð ¢òò6WGFÆR6öçG&öÂ÷&FW'2&Vf÷&R7—7FVÒ7F–öââF†—2—2–çFVçF–öæÆÇ¢òò6WVVçF–Ã¢âW†6†ævR4ÂõE÷"'F–Â6ö÷&F–æF–öâÇv—2vWG2à¢òòWF†÷&—FF—fR7–6ÆRFòF¶RVffV7B&Vf÷&Rç’&öw&Ò6Æ÷6R—26VçBà¢–b†W†6†ævT6öææV7F÷"bb†57—7FVÔ÷&FW$–B’°¢6öç7Bvw&VvFU&VG’Òv—B&WVW7Dvw&VvFU&÷FV7F–öå6Æ÷D×WFF–öâ€¢W†6†ævT6öææV7F÷"À¢÷6—F–öâÀ¢7—7FVÕö6Æ÷6S¢G¶6Æ÷6U&V6öçÖÀ¢¢6öç7B&'&–W#¢6öçG&öÄ&'&–W$÷WF6öÖRÒvw&VvFU&VG¢òv—B6WGFÆT6öçG&öÄ÷&FW'4&Vf÷&U7—7FVÔ6Æ÷6R€¢W†6†ævT6öææV7F÷"À¢÷6—F–öâÀ¢6Æ÷6U&V6öâÀ¢6Æ÷6U&–6RÀ¢¢¢°¢FV6—6–öã¢'v—B"À¢FWF–Ã¢&vw&VvFR5E26öçG&öÇ2&R6WGFÆ–ær&Vf÷&RF†R‡—6–6ÂVçF—G’6†ævW2"À¢Ð¢W6…7FW‡÷6—F–öâÂ&6öçG&öÅö÷&FW%ö&'&–W""Â&'&–W"æFV6—6–öâÓÒ'v—B"Â&'&–W"æFWF–Â¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢v—BW'6—7D7&—F–6ÄÆ—fU7FFR†6öçG&öÂÖ&'&–W#¢G·÷6—F–öâæ–GÖ ¢–b†&'&–W"æFV6—6–öâÓÓÒ'v—B"’°¢6öç7B&öÆÆ&6µ7FGW3¢Æ—fU÷6—F–öå²'7FGW2%ÒÒ÷&–v–æÅ7FGW2bb÷&–v–æÅ7FGW2ÓÒ&6Æ÷6–ær ¢ò÷&–v–æÅ7FGW0¢¢&÷Vâ ¢÷6—F–öâç7FGW2Ò&öÆÆ&6µ7FGW0¢÷6—F–öâç7FGW5&V6öâÒ6Æ÷6UöFVfW'&VEö6öçG&öÅö6ö÷&F–æF–öã¢G¶&'&–W"æFWF–ÇÖ ¢÷6—F–öâæÆö6¶VDBÒ ¢÷6—F–öâæÆö6¶VD'’ÒVæFVf–æV@¢6öç7B&öÆÆ&6²Òv—B×WFFU÷6—F–öåv—F…fW'6–öä6†V6²‡÷6—F–öâÂ²&6Æ÷6–ær%ÒÂG&gBÓâ°¢ö&¦V7Bæ76–vâ†G&gBÂ÷6—F–öâ¢G&gBç7FGW2Ò&öÆÆ&6µ7FGW0¢G&gBæÆö6¶VDBÒ ¢G&gBæÆö6¶VD'’ÒVæFVf–æV@¢Ò¢–b‡&öÆÆ&6²’ö&¦V7Bæ76–vâ‡÷6—F–öâÂ&öÆÆ&6²¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢v—B&VÆV6U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6´–B’æ6F6‚‚‚’ÓâfÇ6R¢×WFF–öäÆö6´†VÆBÒfÇ6P¢&WGW&â÷6—F–öà¢Ð ¢–b†&'&–W"æFV6—6–öâÓÓÒ'&ö6VVE÷7—7FVÒ"bb—57—7FVÔ6Æ÷6U&WG'”FVfW'&VB‡÷6—F–öâ’’°¢òòF†R&Wf–÷W2GW&&ÆR6Æ–VçBö÷&FW"–B†2æ÷r&VVâWF†÷&—FF—fVÇ¢òò&V6öæ6–ÆVB'6VçBâ&WF—&RöæÇ’F†B7F–öâÖ&¶W"Â&WF–âF†R&WG'¢òò&6¶öfbÂ&W7F÷&RF†R÷VâÆ–fV7–6ÆRæB&RÖ&ÒfVçVR&÷FV7F–öâà¢òòF†RgWGW&R&WG'’v–ÆÂ&W&RæWr–BöæÇ’gFW"æW‡E&WG'”Bà¢÷6—F–öâçVæF–æu7—7FVÔ7F–öâÒVæFVf–æV@¢6öç7B&öÆÆ&6µ7FGW3¢Æ—fU÷6—F–öå²'7FGW2%ÒÒ÷&–v–æÅ7FGW2bb÷&–v–æÅ7FGW2ÓÒ&6Æ÷6–ær ¢ò÷&–v–æÅ7FGW0¢¢&÷Vâ ¢÷6—F–öâç7FGW2Ò&öÆÆ&6µ7FGW0¢÷6—F–öâç7FGW5&V6öâÐ¢7—7FVÕö6Æ÷6U÷&WG'•ö&6¶öfc¢GFV×CÒG·÷6—F–öâç7—7FVÔ6Æ÷6U&WG'“òç&WG'”6÷VçBÇÂÓ²°¢6Æ73ÒG·÷6—F–öâç7—7FVÔ6Æ÷6U&WG'“òæÆ7Df–ÇW&T6Æ72ÇÂ'Væ¶æ÷vâ'Ó²°¢&WG'•öCÒG·÷6—F–öâç7—7FVÔ6Æ÷6U&WG'“òææW‡E&WG'”BÇÂÖ ¢÷6—F–öâæÆö6¶VDBÒ ¢÷6—F–öâæÆö6¶VD'’ÒVæFVf–æV@¢6öç7B&öÆÆ&6²Òv—B×WFFU÷6—F–öåv—F…fW'6–öä6†V6²‡÷6—F–öâÂ²&6Æ÷6–ær%ÒÂG&gBÓâ°¢ö&¦V7Bæ76–vâ†G&gBÂ÷6—F–öâ¢G&gBç7FGW2Ò&öÆÆ&6µ7FGW0¢G&gBæÆö6¶VDBÒ ¢G&gBæÆö6¶VD'’ÒVæFVf–æV@¢Ò¢–b‡&öÆÆ&6²’ö&¦V7Bæ76–vâ‡÷6—F–öâÂ&öÆÆ&6²¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢v—BW'6—7D7&—F–6ÄÆ—fU7FFR†7—7FVÒÖ6Æ÷6RÖ&6¶öfc¢G·÷6—F–öâæ–GÖ¢v—B&V&Õ&÷FV7F–öägFW%VçF—G”×WFF–öâ€¢W†6†ævT6öææV7F÷"À¢÷6—F–öâÀ¢'7—7FVÕö6Æ÷6U÷&WG'•ö&6¶öfe÷&V&Ò"À¢¢v—B&VÆV6U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6´–B’æ6F6‚‚‚’ÓâfÇ6R¢×WFF–öäÆö6´†VÆBÒfÇ6P¢&WGW&â÷6—F–öà¢Ð ¢–b†&'&–W"æFV6—6–öâÓÓÒ&W†6†ævUö6Æ÷6VB"’°¢÷6—F–öâæW†V7WFVEVçF—G’Ò ¢÷6—F–öâçVçF—G’Ò ¢Ð¢Ð ¢òò6Æ÷6R×&W7VÇB7FFR(	B6WB'’F†R'&æ6†W2&VÆ÷rà¢ÆWBW†6†ævT6Æ÷6U7V66W72ÒfÇ6P¢ÆWBW†6†ævT6Æ÷6U&V6öã¢&ö²"Â&Ç&VG•ö6Æ÷6VB"Â&f–ÆVB"Â'6¶—VB"Ò'6¶—VB  ¢–b†W†6†ævT6öææV7F÷"bb†57—7FVÔ÷&FW$–BbbçVÖ&W"‡÷6—F–öâæW†V7WFVEVçF—G’ÇÂ’ÃÒ’°¢W†6†ævT6Æ÷6U7V66W72ÒG'VP¢W†6†ævT6Æ÷6U&V6öâÒ&Ç&VG•ö6Æ÷6VB ¢Ð ¢–b‚†57—7FVÔ÷&FW$–BbbW†6†ævT6öææV7F÷"’°¢W†6†ævT6Æ÷6U&V6öâÒ'6¶—VB ¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&–æfò"À¢6Æ÷6TÆ—fU÷6—F–öã¢6¶—–ærW†6†ævR6Æ÷6Rf÷"G·÷6—F–öâç7–Ö&öÇÒG·÷6—F–öâæF—&V7F–öçÒ(	Bæò7—7FVÒ÷&FW$–B†W‡FW&æÂ÷6—F–öâ&÷FV7F–öâ–À¢²÷6—F–öä–C¢÷6—F–öâæ–BÂ7–Ö&öÃ¢÷6—F–öâç7–Ö&öÂÂF—&V7F–öã¢÷6—F–öâæF—&V7F–öâÒÀ¢’æ6F6‚‚‚’Óâ·Ò¢Ð ¢–b€¢W†6†ævT6Æ÷6U7V66W72b`¢†57—7FVÔ÷&FW$–Bb`¢W†6†ævT6öææV7F÷"b`¢‡G—VöbW†6†ævT6öææV7F÷"çÆ6T÷&FW"ÓÓÒ&gVæ7F–öâ"ÇÂG—VöbW†6†ævT6öææV7F÷"æ6Æ÷6U÷6—F–öâÓÓÒ&gVæ7F–öâ"¢’°¢òòÖ…&WG&–W3Ó"ÂW"ÖGFV×BF–ÖV÷WCÓ3W2ÂöæRS×2&6¶öfbà¢òòF†R÷WFW"W"×÷6—F–öâ7–æ2FVFÆ–æR&÷VæG2F†R6ÆÆW#²–bF†RfVçVP¢òò&VÖ–ç2Vç&W7öç6—fRF†RÆö6Â÷6—F–öâ7F—2÷Vâf÷"F†RæW‡@¢òòWF†÷&—FF—fR&V6÷fW'’72à¢òòF–ÖVBÖ÷WB&VGV6RÖöæÇ’7V&Ö—76–öâÖ’7F–ÆÂ†fR&V6†VBF†RfVçVRà¢òòæWfW"&WG'’—B&Æ–æFÇ’–âF†R6ÖR7–6ÆRâF†RGW&&ÆR6Æ–VçB–Bæ@¢òòVæF–æu7—7FVÔ7F–öâ&R&V6÷fW&VBöâF†RæW‡B7–6ÆR–ç7FVBà¢6öç7BÖ…&WG&–W2Ò¢6öç7B&6¶öfd×2Ò³SÐ¢6öç7B4Äõ4UôEDTÕEõD”ÔTõUEôÕ2Ò3Uó ¢ÆWBFW&Ö–æÄ6Æ÷6TW'&÷"Ò&–çfÆ–E÷&W7öç6R  ¢6öç7B—4Ç&VG”6Æ÷6VDW'&÷"Ò†×6s¢7G&–ær“¢&ööÆVâÓâ°¢6öç7BÒÒ7G&–ær†×6rÇÂ""’çFôÆ÷vW$66R‚¢&WGW&â€¢òòvVæW&–2GFW&ç2†ÆÂfVçVW2¢Òæ–æ6ÇVFW2‚'÷6—F–öâæ÷Bf÷VæB"’ÇÀ¢Òæ–æ6ÇVFW2‚&æò÷Vâ÷6—F–öâ"’ÇÀ¢Òæ–æ6ÇVFW2‚&æ÷F†–ærFò6Æ÷6R"’ÇÀ¢Òæ–æ6ÇVFW2‚'6—¦R—2¦W&ò"’ÇÀ¢Òæ–æ6ÇVFW2‚&Ç&VG’6Æ÷6VB"’ÇÀ¢Òæ–æ6ÇVFW2‚'÷6—F–öâ—2¦W&ò"’ÇÀ¢Òæ–æ6ÇVFW2‚'÷6—F–öâFöW2æ÷BW†—7B"’ÇÀ¢òò&–æu‚×7V6–f–2Ç&VG’Ö6Æ÷6VB6öFW2öÖW76vW3 ¢òò#RÒ$æò÷6—F–öâFò6Æ÷6R"‡÷6—F–öâv26Æ÷6VB'’4ÂõE¢òòCÒ$÷&FW"æ÷BW†—7B"†Ç6ò6âV"–bF†R÷6—F–öâFF¢òòv2Ç&VG’W&vVBg&öÒF†RW†6†ævR¢Òæ–æ6ÇVFW2‚&æò÷6—F–öâFò6Æ÷6R"’ÇÀ¢Òæ–æ6ÇVFW2‚&6öFSÓ#R"’ÇÀ¢Òæ–æ6ÇVFW2‚##R"’ÇÀ¢òò'–&—@¢Òæ–æ6ÇVFW2‚&æò÷Vâ÷6—F–öâFò6Æ÷6R"’ÇÀ¢òòôµ€¢Òæ–æ6ÇVFW2‚'÷6—F–öâæ÷Bf–Æ&ÆR"’ÇÀ¢Òæ–æ6ÇVFW2‚&æWGF–ærVçF—G’—2æ÷B6÷'&V7B"¢¢Ð¢òò&WG'–&ÆRf–ÇW&W2&R&÷VæFVB'’6Vç6Röb'F†—2—2G&ç6–Vç@¢òòW'&÷"æBæ÷F†W"GFV×BÖ–v‡B7V66VVB"âW&ÖæVçB&V¦V7F–öç0¢òò†–çfÆ–B&×2ÂWF‚’6†÷VÆBäõB&WG'’â&–v‡Bæ÷rvRöæÇ’&WG'¢òòöâF–ÖV÷WG2æBW‡Æ–6—BæWGv÷&²W'&÷'2(	BWfW'—F†–ærVÇ6RfÆÇ0¢òòF‡&÷Vv‚FòF†Rf–ÆVB'&æ6‚gFW"6–ævÆRGFV×Bà¢6öç7B—5&WG'–&ÆTW'&÷"Ò†×6s¢7G&–ær“¢&ööÆVâÓâ°¢6öç7BÒÒ7G&–ær†×6rÇÂ""’çFôÆ÷vW$66R‚¢&WGW&â€¢Òæ–æ6ÇVFW2‚'F–ÖV÷WB"’ÇÀ¢Òæ–æ6ÇVFW2‚&æWGv÷&²"’ÇÀ¢Òæ–æ6ÇVFW2‚&V6öæâ"’ÇÀ¢Òæ–æ6ÇVFW2‚'&FRÆ–Ö—B"’ÇÀ¢Òæ–æ6ÇVFW2‚#C#’"’ÇÀ¢Òæ–æ6ÇVFW2‚#S2"’ÇÀ¢Òæ–æ6ÇVFW2‚#S""¢¢Ð ¢f÷"†ÆWBGFV×BÒ²GFV×BÂÖ…&WG&–W3²GFV×B²²’°¢ÆWBÆ7DW'&÷$×6rÒ" ¢G'’°¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Ò·cÒGFV×F–ærW†6†ævR6Æ÷6RG·÷6—F–öâç7–Ö&öÇÒG·÷6—F–öâæF—&V7F–öçÒ†GFV×BG¶GFV×B²ÒòG¶Ö…&WG&–W7Ò–À¢ ¢òòv—F…F–ÖV÷WBw&26Æ÷6U÷6—F–öââF†R&FRÖÆ–Ö—FW"Væf÷&6W2F†P¢òò…EEF–ÖV÷WBg&öÒF—7F6‚F–ÖR†æ÷BVçVWVRF–ÖR’f–W†V7WFUF–ÖV÷WD×2À¢òò6òF†—26÷fW'2öæÇ’7GVÂ&–æu‚&÷VæB×G&—F–ÖRà¢6öç7B7F–öâÒ÷6—F–öâçVæF–æu7—7FVÔ7F–öâÇÂ°¢Fö¶Vã¢7—7FVÒÖ6Æ÷6S¢G·÷6—F–öâæ–GÓ¢G¶ææö–Bƒ‚—ÖÀ¢&V6öã¢6Æ÷6U&V6öâÀ¢†6S¢'7—7FVÕ÷7V&Ö—B"26öç7BÀ¢7F'FVDC¢FFRææ÷r‚’À¢WFFVDC¢FFRææ÷r‚’À¢Ð¢7F–öâç†6RÒ'7—7FVÕ÷7V&Ö—B ¢7F–öâçWFFVDBÒFFRææ÷r‚¢7F–öâç&WVW7FVEVçF—G’ÒçVÖ&W"‡÷6—F–öâæW†V7WFVEVçF—G’ÇÂ÷6—F–öâçVçF—G’ÇÂ¢–b‚7F–öâæ6Æ–VçD÷&FW$–B’7F–öâæ6Æ–VçD÷&FW$–BÒÖ¶TGW&&ÆT6Æ–VçD÷&FW$–B‚'7—2Ö6Æ÷6R"Â÷6—F–öâ¢÷6—F–öâçVæF–æu7—7FVÔ7F–öâÒ7F–öà¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢v—BW'6—7D7&—F–6ÄÆ—fU7FFR†7—7FVÒÖ6Æ÷6R×&W&VC¢G·÷6—F–öâæ–GÖ ¢6öç7B6Æ÷6U6–FS¢&'W’"Â'6VÆÂ"Ò÷6—F–öâæF—&V7F–öâÓÓÒ&Æöær"ò'6VÆÂ"¢&'W’ ¢6öç7B&WVW7BÒG—VöbW†6†ævT6öææV7F÷"çÆ6T÷&FW"ÓÓÒ&gVæ7F–öâ ¢òW†6†ævT6öææV7F÷"çÆ6T÷&FW"€¢÷6—F–öâç7–Ö&öÂÀ¢6Æ÷6U6–FRÀ¢7F–öâç&WVW7FVEVçF—G’À¢VæFVf–æVBÀ¢&Ö&¶WB"À¢°¢&VGV6TöæÇ“¢G'VRÀ¢÷6—F–öå6–FS¢÷6—F–öâæF—&V7F–öâÓÓÒ&Æöær"ò$Äôär"¢%4„õ%B"À¢6Æ–VçD÷&FW$–C¢7F–öâæ6Æ–VçD÷&FW$–BÀ¢ÒÀ¢¢¢W†6†ævT6öææV7F÷"æ6Æ÷6U÷6—F–öâ‡÷6—F–öâç7–Ö&öÂÂ÷6—F–öâæF—&V7F–öâ¢6öç7B"Ò†v—Bv—F…F–ÖV÷WB€¢&WVW7BÀ¢4Äõ4UôEDTÕEõD”ÔTõUEôÕ2À¢7—7FVÔ6Æ÷6R‚G·÷6—F–öâç7–Ö&öÇÒG·÷6—F–öâæF—&V7F–öçÒ–À¢’’2²7V66W73ó¢&ööÆVã²W'&÷#ó¢7G&–æs²÷&FW$–Có¢7G&–æs²–Có¢7G&–ærÒÂVæFVf–æV@ ¢–b‡"bbG—Vöb"ÓÓÒ&ö&¦V7B"bb"ç7V66W72ÓÓÒG'VR’°¢7F–öâæ÷&FW$–BÒ"æ÷&FW$–BÒçVÆÂÇÂ"æ–BÒçVÆÂò7G&–ær‡"æ÷&FW$–Bóò"æ–B’¢7F–öâæ÷&FW$–@¢–b†7F–öâæ÷&FW$–B’6öæf—&ÖVD6Æ÷6T÷&FW$–BÒ7G&–ær†7F–öâæ÷&FW$–B¢7F–öâç†6RÒ'7—7FVÕ÷fW&–g’ ¢7F–öâçWFFVDBÒFFRææ÷r‚¢÷6—F–öâçVæF–æu7—7FVÔ7F–öâÒ7F–öà¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢v—BW'6—7D7&—F–6ÄÆ—fU7FFR†7—7FVÒÖ6Æ÷6R×7V&Ö—GFVC¢G·÷6—F–öâæ–GÖ¢W†6†ævT6Æ÷6U7V66W72ÒG'VP¢W†6†ævT6Æ÷6U&V6öâÒ&ö² ¢6öç6öÆRæÆör†G´Äôuõ$Td•‡Ò·cÒW†6†ævR6Æ÷6R7V66VVFVC¢G·÷6—F–öâç7–Ö&öÇÒG·÷6—F–öâæF—&V7F–öçÖ¢'&V°¢Ð ¢Æ7DW'&÷$×6rÒ‡"bbG—Vöb"ÓÓÒ&ö&¦V7B"bb"æW'&÷"’ò7G&–ær‡"æW'&÷"’¢&–çfÆ–E÷&W7öç6R ¢FW&Ö–æÄ6Æ÷6TW'&÷"ÒÆ7DW'&÷$×6p ¢òò)H)HÇ&VG’Ö6Æ÷6VB&V6öæ6–Æ–F–öâ)HûûÞûûÞ)HûûÞûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òò–bF†RfVçVR6—2F†R÷6—F–öâ—2vöæRÂvRG&VBF†R6Æ÷6R0¢òò7V66W76gVÂæB7F÷&WG'––ærâF†RD"×6–FRFW&Ö–æÂ×7FFP¢òò—VÆ–æR&VÆ÷r7F–ÆÂ'Vç2Â'WBÆ—fR66÷VçF–ær&VÖ–ç2Vç&W6öÇfV@¢òòVçF–ÂF†RW†7B6öçG&öÂ÷7—7FVÒ÷&FW"f–ÆÂ—2f–Æ&ÆRâF†P¢òò6ÆÆW"w2G&–vvW"öÖ&²&–6R—2æWfW"66WFVB2&VÆ—6VBäÂà¢–b†—4Ç&VG”6Æ÷6VDW'&÷"†Æ7DW'&÷$×6r’’°¢W†6†ævT6Æ÷6U7V66W72ÒG'VP¢W†6†ævT6Æ÷6U&V6öâÒ&Ç&VG•ö6Æ÷6VB ¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Ò·cÒW†6†ævR÷6—F–öâÇ&VG’6Æ÷6VB…4ÂõEÆ–¶VÇ’f—&VB“¢G·÷6—F–öâç7–Ö&öÇÒG·÷6—F–öâæF—&V7F–öçÒ(	B&V6öãÒ"G¶Æ7DW'&÷$×6wÒ&À¢¢'&V°¢Ð ¢6öç6öÆRçv&â†G´Äôuõ$Td•‡Ò·cÒW†6†ævR6Æ÷6Rf–ÆVC¢G·÷6—F–öâç7–Ö&öÇÒÒG¶Æ7DW'&÷$×6wÖ¢òòöæÇ’&WG'’öâG&ç6–VçB6Æ76W2öbW'&÷"â†&BÆöv–2W'&÷'0¢òò†–çfÆ–B&×2ÂWF‚’vWB6–ævÆRGFV×BæB&–Âà¢–b†GFV×BÂÖ…&WG&–W2Òbb—5&WG'–&ÆTW'&÷"†Æ7DW'&÷$×6r’’°¢v—BæWr&öÖ—6R‡&W6öÇfRÓâ6WEF–ÖV÷WB‡&W6öÇfRÂ&6¶öfd×5¶GFV×EÒ’¢6öçF–çVP¢Ð¢'&V°¢Ò6F6‚†W'"’°¢Æ7DW'&÷$×6rÒW'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"¢FW&Ö–æÄ6Æ÷6TW'&÷"ÒÆ7DW'&÷$×6p¢6öç6öÆRæW'&÷"†G´Äôuõ$Td•‡Ò·cÒW†6†ævR6Æ÷6RF‡&WrW'&÷"†GFV×BG¶GFV×B²Ò“¢G¶Æ7DW'&÷$×6wÖ¢òòF‡&÷vâF–ÖV÷WG2æBæWGv÷&²W'&÷'2$R&WG'–&ÆRà¢–b†GFV×BÂÖ…&WG&–W2Òbb—5&WG'–&ÆTW'&÷"†Æ7DW'&÷$×6r’’°¢v—BæWr&öÖ—6R‡&W6öÇfRÓâ6WEF–ÖV÷WB‡&W6öÇfRÂ&6¶öfd×5¶GFV×EÒ’¢6öçF–çVP¢Ð¢'&V°¢Ð¢Ð ¢–b‚W†6†ævT6Æ÷6U7V66W72’°¢W†6†ævT6Æ÷6U&V6öâÒ&f–ÆVB ¢6öç7B&WG'’Ò66†VGVÆU7—7FVÔ6Æ÷6U&WG'’‡÷6—F–öâÂFW&Ö–æÄ6Æ÷6TW'&÷"¢–b‡÷6—F–öâçVæF–æu7—7FVÔ7F–öâ’°¢÷6—F–öâçVæF–æu7—7FVÔ7F–öâç†6RÒ'7—7FVÕ÷fW&–g’ ¢÷6—F–öâçVæF–æu7—7FVÔ7F–öâçWFFVDBÒ&WG'’çWFFVD@¢Ð¢6öç6öÆRæW'&÷"€¢G´Äôuõ$Td•‡Ò·cÒd”ÄTBFò6Æ÷6R÷6—F–öâöâW†6†ævRgFW"G¶Ö…&WG&–W7ÒGFV×G3¢°¢G·÷6—F–öâç7–Ö&öÇÒG·÷6—F–öâæF—&V7F–öçÓ²&WG'“ÒG·&WG'’ç&WG'”6÷VçGÒ6Æ73ÒG·&WG'’æÆ7Df–ÇW&T6Æ77ÖÀ¢¢Ð¢Ð ¢6öç7B6Ä6æ6VÆÆVBÒ†E6Ä–Bbb÷6—F–öâç7F÷Æ÷74÷&FW$–@¢6öç7BG6æ6VÆÆVBÒ†EG–Bbb÷6—F–öâçF¶U&öf—D÷&FW$–@ ¢òò66WFæ6R—2æ÷Bf–ÆÂâf÷"6öææV7F÷'2v—F‚âWF†÷&—FF—fP¢òò÷6—F–öâVæGö–çBÂFW&Ö–æÂ7FFR—2vFVBöâ¦W&òW†6†ævRVçF—G’à¢òò'F–Â÷"Ævv–ær6æ6†÷B&VÖ–ç26Æ÷6–æu÷'F–ÆæB—2&V6÷fW&V@¢òò'’F†RGW&&ÆRVæF–æu7—7FVÔ7F–öâöâF†RæW‡B7–6ÆRà¢–b†W†6†ævT6Æ÷6U7V66W72bbW†6†ævT6Æ÷6U&V6öâÓÓÒ&ö²"bbW†6†ævT6öææV7F÷"’°¢6öç7BWF†÷&—FF—fRÒv—BfWF6„WF†÷&—FF—fT÷VåVçF—G’†W†6†ævT6öææV7F÷"Â÷6—F–öâç7–Ö&öÂÂ&W6öÇfVDF—&V7F–öâÂ÷6—F–öâæ6öææV7F–öä–B¢–b†WF†÷&—FF—fRæö²’°¢6öç7B7F–öâÒ÷6—F–öâçVæF–æu7—7FVÔ7F–öà¢6öç7BW†V7WF–öä–BÒG·÷6—F–öâæ–GÓ§7—7FVÒÖ6Æ÷6S¢G¶7F–öãòæ6Æ–VçD÷&FW$–BÇÂ7F–öãòæ÷&FW$–BÇÂ7F–öãòçFö¶VâÇÂ'Væ¶æ÷vâ'Ö ¢6öç7BW†—7F–ærÒ÷6—F–öâç'F–Ä÷&FW$W†V7WF–öç3òæf–æB‚†VçG'’’ÓâVçG'’æ–BÓÓÒW†V7WF–öä–B¢6öç7B6WGFÆVÖVçBÒ7F–öãòæ÷&FW$–@¢òv—B&VD÷&FW%6WGFÆVÖVçB†W†6†ævT6öææV7F÷"Â÷6—F–öâç7–Ö&öÂÂ7F–öâæ÷&FW$–B¢¢çVÆÀ¢6öç7B÷&FW$FWF–ÂÒ7F–öãòæ÷&FW$–BbbG—VöbW†6†ævT6öææV7F÷"ævWD÷&FW"ÓÓÒ&gVæ7F–öâ ¢òv—Bv—F…F–ÖV÷WB€¢W†6†ævT6öææV7F÷"ævWD÷&FW"‡÷6—F–öâç7–Ö&öÂÂ7F–öâæ÷&FW$–B’2&öÖ—6SÆç“âÀ¢U„4„ätUõD”ÔTõUEôtUEôõ$DU%ôÕ2À¢vWD÷&FW"‡7—7FVÒÖ6Æ÷6RÖ66÷VçF–ærG¶7F–öâæ÷&FW$–GÒ–À¢’æ6F6‚‚‚’ÓâçVÆÂ¢¢çVÆÀ¢6öç7Bö'6W'fVBÒÇ•&VGV7F–öäö'6W'fF–öâ‡÷6—F–öâÂ°¢W†V7WF–öä–BÀ¢6÷W&6S¢'7—7FVÕö6Æ÷6R"À¢7FGW3¢WF†÷&—FF—fRçVçF—G’ÃÒò&f–ÆÆVB"¢''F–ÆÇ•öf–ÆÆVB"À¢&WVW7FVEVçF—G“¢çVÖ&W"†7F–öãòç&WVW7FVEVçF—G’ÇÂ÷6—F–öâæW†V7WFVEVçF—G’ÇÂ’À¢&W÷'FVDf–ÆÆVEVçF—G“¢À¢&Wf–÷W6Ç”Æ–VEVçF—G“¢çVÖ&W"†W†—7F–æsòæ7V×VÆF—fTf–ÆÆVEVçF—G’ÇÂ7F–öãòæÆ–VDf–ÆÆVEVçF—G’ÇÂ’À¢WF†÷&—FF—fUVçF—G“¢WF†÷&—FF—fRçVçF—G’À¢&–6S¢6öçG&öÄ÷&FW$f–ÆÅ&–6R†÷&FW$FWF–Â’À¢6WGFÆVÖVçBÀ¢÷&FW$–C¢7F–öãòæ÷&FW$–BÀ¢6Æ–VçD÷&FW$–C¢7F–öãòæ6Æ–VçD÷&FW$–BÀ¢Ò¢–b†7F–öãòæ÷&FW$–B’6öæf—&ÖVD6Æ÷6T÷&FW$–BÒ7G&–ær†7F–öâæ÷&FW$–B¢–b†7F–öâ’7F–öâæÆ–VDf–ÆÆVEVçF—G’Òö'6W'fVBæ7V×VÆF—fTÆ–V@¢–b†WF†÷&—FF—fRçVçF—G’âRÓ"’°¢òòFW&Ö–æÂ'F–ÂÖ&¶WB6Æ÷6RÆVfW2&VÂ&W6–GVÂW‡÷7W&Rà¢òòFòæ÷Bv—Bf÷"ÆFW"7&öâöVæv–æRF–6²FòÖ¶R—B6fRv–ã ¢òòöæ6RF†R7V&Ö—GFVB6Æ÷6R—26öæf—&ÖVBFW&Ö–æÂÂ&W7F÷&RF†R&÷rFð¢òòâ÷VâÆ–fV7–6ÆR7FFRæBVWVRâvw&VvFR&RÖ&Òv–ç7BF†P¢òòg&W6‚WF†÷&—FF—fRVçF—G’â–bF†R6Æ÷6R—27F–ÆÂ7F—fR÷ ¢òò6ææ÷B&R&÷fVBFW&Ö–æÂÂ&W6W'fRF†RGW&&ÆRVæF–ær7F–öâæ@¢òòÆWBF†RæW‡B&V6öæ6–ÆRö'6W'fR—B–ç7FVBöbÆ6–ær÷fW&Æ–æp¢òò&VGV6RÖöæÇ’6öçG&öÇ2à¢–b†—5FW&Ö–æÅ7—7FVÔ6Æ÷6T÷&FW"†÷&FW$FWF–Â’’°¢÷6—F–öâçVæF–æu7—7FVÔ7F–öâÒVæFVf–æV@¢÷6—F–öâç7—7FVÔ6Æ÷6U&WG'’ÒVæFVf–æV@¢÷6—F–öâç7FGW2Ò&÷Vâ ¢÷6—F–öâç7FGW5&V6öâÐ¢7—7FVÕö6Æ÷6U÷'F–Å÷6WGFÆVC¢÷VãÒG¶WF†÷&—FF—fRçVçF—G—Ó²&÷FV7F–öâ&RÖ&ÒVWVVBg&öÒFW&Ö–æÂ6Æ÷6R÷&FW& ¢6öç7B'F–Å6WGFÆVD×WFF–öâÒv—B×WFFU÷6—F–öåv—F…fW'6–öä6†V6²‡÷6—F–öâÂ²&6Æ÷6–ær%ÒÂG&gBÓâ°¢ö&¦V7Bæ76–vâ†G&gBÂ÷6—F–öâ¢G&gBç7FGW2Ò&÷Vâ ¢G&gBæÆö6¶VDBÒ ¢G&gBæÆö6¶VD'’ÒVæFVf–æV@¢Ò¢–b‡'F–Å6WGFÆVD×WFF–öâ’ö&¦V7Bæ76–vâ‡÷6—F–öâÂ'F–Å6WGFÆVD×WFF–öâ¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢v—BW'6—7D7&—F–6ÄÆ—fU7FFR†7—7FVÒÖ6Æ÷6R×'F–Â×6WGFÆVC¢G·÷6—F–öâæ–GÖ¢v—B&V&Õ&÷FV7F–öägFW%VçF—G”×WFF–öâ€¢W†6†ævT6öææV7F÷"À¢÷6—F–öâÀ¢'7—7FVÕö6Æ÷6U÷'F–Å÷&V&Ò"À¢²VçF—G”÷fW'&–FS¢WF†÷&—FF—fRçVçF—G’ÒÀ¢¢v—B&VÆV6U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6´–B’æ6F6‚‚‚’ÓâfÇ6R¢×WFF–öäÆö6´†VÆBÒfÇ6P¢&WGW&â÷6—F–öà¢Ð¢÷6—F–öâç7FGW2Ò&6Æ÷6–æu÷'F–Â ¢÷6—F–öâç7FGW5&V6öâÒ7—7FVÕö6Æ÷6U÷VæF–æuöW†6†ævUöVffV7C¢÷VãÒG¶WF†÷&—FF—fRçVçF—G—Ö ¢–b†7F–öâ’°¢7F–öâç†6RÒ''F–Å÷v—B ¢7F–öâçWFFVDBÒFFRææ÷r‚¢Ð¢6öç7B'F–Ä×WFF–öâÒv—B×WFFU÷6—F–öåv—F…fW'6–öä6†V6²‡÷6—F–öâÂ²&6Æ÷6–ær%ÒÂG&gBÓâ°¢ö&¦V7Bæ76–vâ†G&gBÂ÷6—F–öâ¢G&gBç7FGW2Ò&6Æ÷6–æu÷'F–Â ¢G&gBæÆö6¶VDBÒ ¢G&gBæÆö6¶VD'’ÒVæFVf–æV@¢Ò¢–b‡'F–Ä×WFF–öâ’ö&¦V7Bæ76–vâ‡÷6—F–öâÂ'F–Ä×WFF–öâ¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢v—BW'6—7D7&—F–6ÄÆ—fU7FFR†7—7FVÒÖ6Æ÷6R×'F–Ã¢G·÷6—F–öâæ–GÖ¢v—B&VÆV6U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6´–B’æ6F6‚‚‚’ÓâfÇ6R¢×WFF–öäÆö6´†VÆBÒfÇ6P¢&WGW&â÷6—F–öà¢Ð¢÷6—F–öâçVæF–æu7—7FVÔ7F–öâÒVæFVf–æV@¢÷6—F–öâç7—7FVÔ6Æ÷6U&WG'’ÒVæFVf–æV@¢ÒVÇ6R–b‡G—VöbW†6†ævT6öææV7F÷"ævWE÷6—F–öâÓÓÒ&gVæ7F–öâ"’°¢÷6—F–öâç7FGW2Ò&6Æ÷6–æu÷'F–Â ¢÷6—F–öâç7FGW5&V6öâÒ'7—7FVÕö6Æ÷6Uö66WFVEö'WEöW†6†ævUöVffV7E÷Væ6öæf—&ÖVB ¢–b‡÷6—F–öâçVæF–æu7—7FVÔ7F–öâ’°¢÷6—F–öâçVæF–æu7—7FVÔ7F–öâç†6RÒ'7—7FVÕ÷fW&–g’ ¢÷6—F–öâçVæF–æu7—7FVÔ7F–öâçWFFVDBÒFFRææ÷r‚¢Ð¢6öç7BfW&–g”×WFF–öâÒv—B×WFFU÷6—F–öåv—F…fW'6–öä6†V6²‡÷6—F–öâÂ²&6Æ÷6–ær%ÒÂG&gBÓâ°¢ö&¦V7Bæ76–vâ†G&gBÂ÷6—F–öâ¢G&gBç7FGW2Ò&6Æ÷6–æu÷'F–Â ¢G&gBæÆö6¶VDBÒ ¢G&gBæÆö6¶VD'’ÒVæFVf–æV@¢Ò¢–b‡fW&–g”×WFF–öâ’ö&¦V7Bæ76–vâ‡÷6—F–öâÂfW&–g”×WFF–öâ¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢v—BW'6—7D7&—F–6ÄÆ—fU7FFR†7—7FVÒÖ6Æ÷6R×Væ6öæf—&ÖVC¢G·÷6—F–öâæ–GÖ¢v—B&VÆV6U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6´–B’æ6F6‚‚‚’ÓâfÇ6R¢×WFF–öäÆö6´†VÆBÒfÇ6P¢&WGW&â÷6—F–öà¢Ð¢Ð ¢òò&RÖf–ÆÂ&÷rv—F†÷WBç’fVçVR†æFÆR&W&W6VçG2öæÇ’&W6W'fV@¢òòÆö6Â6Æ÷BâF†W&R—2æòW†6†ævR÷&FW"÷"f–ÆÆVBVçF—G’F†B6÷VÆB&P¢òò6Æ÷6VBWF†÷&—FF—fVÇ’Â6ò¶VW–ær—B–âF†R÷VâÆVFvW"7&VFW2¢òòW&ÖæVçBÆ6VE÷Væ6öæf—&ÖVB¦öÖ&–RâF†R7GV6²×Æ6VÖVçB7vVWW"6ÆÇ0¢òòF†—2F‚v—F†÷WB6öææV7F÷"gFW"—B†2&÷fVâF†BæòfVçVR†æFÆP¢òòW†—7G3²WfW'’&÷rv—F‚â÷&FW"÷÷6—F–öâ†æFÆR7F–ÆÂ&VÖ–ç27V&¦V7BFð¢òòF†Ræ÷&ÖÂW†6†ævRÖ6öæf—&ÖF–öâ&'&–W"&÷fRà¢6öç7B&Tf–ÆÅv—F†÷WDW†6†ævT†æFÆRÒ—5&Tf–ÆÅv—F†÷WDW†6†ævT†æFÆR€¢÷6—F–öâÀ¢÷&–v–æÅ7FGW2À¢†57—7FVÔ÷&FW$–BÀ¢¢6öç7BÆö6ÄöæÇ”6Æ÷6TÆÆ÷vVBÐ¢÷&–v–æÅ7FGW2ÓÓÒ'6–×VÆFVB"ÇÀ¢6Æ÷6U&V6öâÓÓÒ&W†6†ævUöW‡FW&æÆÇ•ö6Æ÷6VB"ÇÀ¢6Æ÷6U&V6öâÓÓÒ&W†6†ævU÷&V6öæ6–Æ–F–öâ"ÇÀ¢6Æ÷6U&V6öâÓÓÒ&GWÆ–6FU÷6Æ÷E÷'VæVB"ÇÀ¢&Tf–ÆÅv—F†÷WDW†6†ævT†æFÆP¢6öç7BÖ”f–æÆ—¦T6Æ÷6RÒW†6†ævT6Æ÷6U7V66W72ÇÂ‚W†6†ævT6öææV7F÷"bbÆö6ÄöæÇ”6Æ÷6TÆÆ÷vVB¢–b‚Ö”f–æÆ—¦T6Æ÷6R’°¢6öç7B&öÆÆ&6µ7FGW3¢Æ—fU÷6—F–öå²'7FGW2%ÒÒ÷&–v–æÅ7FGW2bb÷&–v–æÅ7FGW2ÓÒ&6Æ÷6–ær ¢ò÷&–v–æÅ7FGW0¢¢&÷Vâ ¢÷6—F–öâç7FGW2Ò&öÆÆ&6µ7FGW0¢÷6—F–öâç7FGW5&V6öâÐ¢6Æ÷6Uöf–ÆVEöW†6†ævU÷Væ6öæf—&ÖVC¢G¶6Æ÷6U&V6öçÓ²÷6—F–öâ¶WB÷Vã²°¢&WG'•öCÒG·÷6—F–öâç7—7FVÔ6Æ÷6U&WG'“òææW‡E&WG'”BÇÂÓ²°¢6Æ73ÒG·÷6—F–öâç7—7FVÔ6Æ÷6U&WG'“òæÆ7Df–ÇW&T6Æ72ÇÂ'Væ¶æ÷vâ'Ö ¢÷6—F–öâæ6Æ÷6U&V6öâÒVæFVf–æV@¢÷6—F–öâæ6Æ÷6VDBÒVæFVf–æV@¢÷6—F–öâæÆö6¶VDBÒ ¢÷6—F–öâæÆö6¶VD'’ÒVæFVf–æV@¢W6…7FW‡÷6—F–öâÂ&6Æ÷6Uöf–ÆVEöW†6†ævU÷Væ6öæf—&ÖVB"ÂfÇ6RÂ÷6—F–öâç7FGW5&V6öâ¢6öç7B&öÆÆ&6²Òv—B×WFFU÷6—F–öåv—F…fW'6–öä6†V6²‡÷6—F–öâÂ²&6Æ÷6–ær%ÒÂG&gBÓâ°¢ö&¦V7Bæ76–vâ†G&gBÂ÷6—F–öâ¢G&gBç7FGW2Ò&öÆÆ&6µ7FGW0¢G&gBæÆö6¶VDBÒ ¢G&gBæÆö6¶VD'’ÒVæFVf–æV@¢Ò¢–b‡&öÆÆ&6²’ö&¦V7Bæ76–vâ‡÷6—F–öâÂ&öÆÆ&6²¢÷6—F–öâç7—7FVÕ&÷FV7F–öäÆVw2Ò6öæf–wW&VE7—7FVÕ&÷FV7F–öäÆVw2‡÷6—F–öâ¢÷6—F–öâç&÷FV7F–öäÖöFRÒ'7—7FVÕö6Æ÷6UöfÆÆ&6² ¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢v—BW'6—7D7&—F–6ÄÆ—fU7FFR†7—7FVÒÖ6Æ÷6RÖf–ÆVC¢G·÷6—F–öâæ–GÖ¢v—B–æ7&VÖVçDÖWG&–2†6öææV7F–öä–BÂ&Æ—fU÷÷6—F–öç5ö6Æ÷6Uöf–ÆVEö6÷VçB"¢v—B&VÆV6U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6´–B’æ6F6‚‚‚’ÓâfÇ6R¢×WFF–öäÆö6´†VÆBÒfÇ6P¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡ÒW†6†ævR6Æ÷6Rv2æ÷B6öæf—&ÖVBf÷"G·÷6—F–öâç7–Ö&öÇÓ²°¢F†RGW&&ÆRFVÆ—fW'’v–ÆÂ&R&V6öæ6–ÆVB&Vf÷&RF†R&÷VæFVB&WG'–À¢¢&WGW&â÷6—F–öà¢Ð ¢òò)H)HW†7BÖ÷væVB÷'†â×7vVW6fWG’æWB)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òògFW"F†R&V6÷&FVBÖ–B6æ6VÇ2Â66âF†RfVçVRf÷"5E2×vFW&Ö&¶V@¢òò&VGV6RÖöæÇ’÷&FW'2ÖF6†–ærF†—2&÷ræB6Æ÷6R6–FRâ6F6†W3 ¢òò(
"'’Ö–B6æ6VÇ2F†B§W7Bf–ÆVBG&ç6–VçFÇ’‡vRvWBg&VR&WG'’¢òò(
"&÷FV7F–öâ–G2F†BvW&RæWfW"W'6—7FVB‡Æ6R×7V66W72(i"7&6€¢òò(i"&W7F'Bf–æG2æò–B–â&VF—2¢òò(
"&W7öç6RÖÆ÷7B5E2&÷FV7F–öâÆ6VÖVçG2&V6÷fW&VB'’F†RGW&&ÆP¢òò6öææV7F–öâ×66÷VB6Æ–VçB–Bà¢òòÖçVÂöf÷&V–vâ÷&FW'2æWfW"VçFW"F†R6æ6VÆÆF–öâÆÆ÷rÖÆ—7Bà¢òò&W7BÖVff÷'C²vRæWfW"ÆWB7vVWf–ÇW&W2&Æö6²F†R6Æ÷6R—VÆ–æRà¢–b†W†6†ævT6öææV7F÷"’°¢6öç7B7vVW6Æ÷6U6–FS¢&'W’"Â'6VÆÂ"Ð¢÷6—F–öâæF—&V7F–öâÓÓÒ&Æöær"ò'6VÆÂ"¢&'W’ ¢G'’°¢6öç7B7vWBÒv—B7vVW÷'†å&÷FV7F–öä÷&FW'2€¢W†6†ævT6öææV7F÷"À¢÷6—F–öâç7–Ö&öÂÀ¢7vVW6Æ÷6U6–FRÀ¢÷6—F–öâÀ¢¢–b‡7vWBæ6æ6VÆÆVBâ’°¢òò–bF†R7vVW6ÆVæVBWF†R&V6÷&FVB–G2rÆVgF÷fW'2Â6ÆV ¢òòF†RÆö6Âf–VÆG2Föò(	BBF†—2ö–çBF†W&R—2æ÷F†–æröà¢òòF†RfVçVRF–VBFòF†÷6R–G2à¢–b††E6Ä–Bbb6Ä6æ6VÆÆVB’°¢÷6—F–öâç7F÷Æ÷74÷&FW$–BÒVæFVf–æV@¢6WE&÷FV7F–öäÆVt&ÖVEVçF—G’‡÷6—F–öâÂ'7F÷öÆ÷72"Â¢Ð¢–b††EG–BbbG6æ6VÆÆVB’°¢÷6—F–öâçF¶U&öf—D÷&FW$–BÒVæFVf–æV@¢6WE&÷FV7F–öäÆVt&ÖVEVçF—G’‡÷6—F–öâÂ'F¶U÷&öf—B"Â¢Ð¢W6…7FW€¢÷6—F–öâÀ¢&÷'†å÷7vVW"À¢G'VRÀ¢7vWBG·7vWBæ6æ6VÆÆVGÒòG·7vWBç66ææVGÒ÷'†â&VGV6RÖöæÇ’÷&FW'6À¢¢Ð¢Ò6F6‚‡7vVWW'"’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò·7vVWÒG·÷6—F–öâç7–Ö&öÇÒW'&÷#¢G·7vVWW'"–ç7Fæ6VöbW'&÷"ò7vVWW'"æÖW76vR¢7G&–ær‡7vVWW'"—ÖÀ¢¢Ð¢Ð ¢òò)H)H2â6ö×WFR&VÆ—¦VBäÂb$ô’†Ö&v–âÖ&6VBFòÖF6‚W†6†ævR$ôR’)H)H ¢6öç7B&VÖ–æ–æuG’ÒÖF‚æÖ‚ƒÂçVÖ&W"‡÷6—F–öâæW†V7WFVEVçF—G’ÇÂ’¢6öç7BG’ÒÖF‚æÖ‚€¢çVÖ&W"‡÷6—F–öâçF÷FÄW†V7WFVEVçF—G’ÇÂ’À¢çVÖ&W"‡÷6—F–öâæ6Æ÷6VEVçF—G’ÇÂ’²&VÖ–æ–æuG’À¢çVÖ&W"‡÷6—F–öâæ–æ—F–ÄW†V7WFVEVçF—G’ÇÂ’À¢&VÖ–æ–æuG’À¢¢6öç7BftVçG'’Ò÷6—F–öâæfW&vTW†V7WF–öå&–6RÇÂ÷6—F–öâæVçG'•&–6RÇÂ ¢6öç7B—56–×VÆF–öä6Æ÷6RÒ÷&–v–æÅ7FGW2ÓÓÒ'6–×VÆFVB ¢6öç7Bf–æÄÆVuæÂÐ¢—56–×VÆF–öä6Æ÷6Rbb&VÖ–æ–æuG’âbbftVçG'’âbb6Æ÷6U&–6Râ ¢ò÷6—F–öâæÖ&¶WEG—RÓÓÒ&f÷&W‚"ÇÂ÷6—F–öâçföÇVÖT¶–æBÓÓÒ&Æ÷G2 ¢òf÷&W…&–6TÖ÷fUæÅW6B€¢÷6—F–öâæF—&V7F–öâÓÓÒ'6†÷'B"ò'6†÷'B"¢&Æöær"À¢&VÖ–æ–æuG’À¢ftVçG'’À¢6Æ÷6U&–6RÀ¢÷6—F–öâç7–Ö&öÂÀ¢÷6—F–öåVæ—D×VÇF—Æ–W"‡÷6—F–öâ’À¢÷6—F–öâçV÷FUFõW6E&FRÀ¢¢¢&VÖ–æ–æuG’¢€¢÷6—F–öâæF—&V7F–öâÓÓÒ&Æöær ¢ò6Æ÷6U&–6RÒftVçG'¢¢ftVçG'’Ò6Æ÷6U&–6P¢¢¢ ¢6öç7BæÂÒçVÖ&W"‡÷6—F–öâç&VÆ—¦VEäÂÇÂ’²f–æÄÆVuæÀ¢6öç7BÆWbÒÖF‚æÖ‚ƒÂ÷6—F–öâæÆWfW&vRÇÂ¢6öç7Bæ÷F–öæÂÒ÷6—F–öäæ÷F–öæÅW6B‡÷6—F–öâÂG’ÂftVçG'’¢6öç7BÖ&v–âÒæ÷F–öæÂâòæ÷F–öæÂòÆWb¢ ¢6öç7B&ö’ÒÖ&v–ââò‡æÂòÖ&v–â’¢¢ ¢6öç7B66÷VçFVD6Æ÷6VEVçF—G’ÒÖF‚æÖ‚ƒÂçVÖ&W"‡÷6—F–öâæ6Æ÷6VEVçF—G’ÇÂ’¢6öç7B66÷VçF–æuVçF—G”6ö×ÆWFRÒG’ÃÒRÓ ¢ÇÂ66÷VçFVD6Æ÷6VEVçF—G’ãÒG’ÒÖF‚æÖ‚ƒRÓ"ÂG’¢RÓ‚¢÷6—F–öâç&VÆ—¦VEæÄ6ö×ÆWFRÒ—56–×VÆF–öä6Æ÷6P¢òG'VP¢¢÷6—F–öâç&VÆ—¦VEæÄ6ö×ÆWFRÓÒfÇ6Rbb66÷VçF–æuVçF—G”6ö×ÆWFP¢÷6—F–öâç&VÆ—¦VEæÅ6÷W&6RÒ—56–×VÆF–öä6Æ÷6P¢ò'6–×VÆF–öåöÖöFVÂ ¢¢÷6—F–öâç&VÆ—¦VEæÄ6ö×ÆWFP¢ò&W†6†ævU÷6WGFÆVÖVçB ¢¢÷6—F–öâç&VÆ—¦VEæÅ6÷W&6RÇÂ&W†6†ævU÷Vç&W6öÇfVB  ¢òò)H)HBâW'6—7Bv—F‚FW&Ö–æÂ7FFR)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢÷6—F–öâç7FGW2Ò&6Æ÷6VB ¢÷6—F–öâæ6Æ÷6VDBÒFFRææ÷r‚¢÷6—F–öâçWFFVDBÒFFRææ÷r‚¢÷6—F–öâç&VÆ—¦VEäÂÒÖF‚ç&÷VæB‡æÂ¢’ò ¢÷6—F–öâçF÷FÄW†V7WFVEVçF—G’ÒG¢÷6—F–öâæ6Æ÷6VEVçF—G’ÒG¢òò6Æ÷6VBÖ†—7F÷'’&÷w2&WF–âF†R6ö×ÆWFRG&FVBVçF—G’v†–ÆR÷Và¢òòÆÆö6F–öâ&VÖ–ç2W‡Æ–6—FÇ’¦W&ò–âV6‚ÖVÖ&W"6WBà¢÷6—F–öâæW†V7WFVEVçF—G’ÒG¢÷6—F–öâçVçF—G’ÒG¢÷6—F–öâç&VÖ–æ–æuVçF—G’Ò ¢–b‡÷6—F–öâæ6öÖ&–æVE÷46÷VçG2’°¢÷6—F–öâç÷46÷VçG56WEVçF—F–W2ÒÆÆö6FU÷6—F–öå6WEVçF—F–W2‡÷6—F–öâÂÂ÷6—F–öâæ67V×VÆFVE6WD¶W—2ÇÂµÒ¢Ð¢÷6—F–öâçVæF–æu&VGV7F–öâÒVæFVf–æV@¢6öç7BÆVFvW$6Æ÷6T÷&FW$–BÒ²âââ‡÷6—F–öâç'F–Ä÷&FW$W†V7WF–öç2ÇÂµÒ•Ð¢ç&WfW'6R‚¢æf–æB‚†W†V7WF–öâ’Óà¢²'7—7FVÕö6Æ÷6R"Â&6öçG&öÅö÷&FW"%Òæ–æ6ÇVFW2†W†V7WF–öâç6÷W&6R¢bbçVÖ&W"†W†V7WF–öâæ7V×VÆF—fTf–ÆÆVEVçF—G’ÇÂW†V7WF–öâæÆ–VEVçF—G’ÇÂ’â ¢bb7G&–ær†W†V7WF–öâæ÷&FW$–BÇÂ""’çG&–Ò‚’æÆVæwF‚âÀ¢“òæ÷&FW$–@¢÷6—F–öâæ6Æ÷6T÷&FW$–BÒ7G&–ær€¢6öæf—&ÖVD6Æ÷6T÷&FW$–BÇÂÆVFvW$6Æ÷6T÷&FW$–BÇÂ÷6—F–öâæ6Æ÷6T÷&FW$–BÇÂ""À¢’çG&–Ò‚’ÇÂVæFVf–æV@¢÷6—F–öâçVæF–æu7—7FVÔ7F–öâÒVæFVf–æV@¢÷6—F–öâç7—7FVÔ6Æ÷6U&WG'’ÒVæFVf–æV@¢÷6—F–öâçVæF–æuVçF—G”×WFF–öâÒVæFVf–æV@¢÷6—F–öâçVæF–æt67V×VÆF–öâÒVæFVf–æV@¢÷6—F–öâçVæF–æu&÷FV7F–öä÷&FW'2ÒVæFVf–æV@¢÷6—F–öâç7F÷Æ÷74÷&FW$–BÒVæFVf–æV@¢÷6—F–öâçF¶U&öf—D÷&FW$–BÒVæFVf–æV@¢÷6—F–öâç6V7W&—G•7F÷÷&FW$–BÒVæFVf–æV@¢÷6—F–öâç7F÷Æ÷75&–6RÒ ¢÷6—F–öâçF¶U&öf—E&–6RÒ ¢÷6—F–öâç6V7W&—G•7F÷&–6RÒ ¢÷6—F–öâç7F÷Æ÷74&ÖVEVçF—G’Ò ¢÷6—F–öâçF¶U&öf—D&ÖVEVçF—G’Ò ¢÷6—F–öâç&÷FV7F–öä&ÖVEVçF—G’Ò ¢÷6—F–öâç6V7W&—G•7F÷&ÖVEVçF—G’Ò ¢÷6—F–öâç6V7W&—G•7F÷'6Væ6T6öæf—&ÖF–öç2Ò ¢÷6—F–öâç6V7W&—G•7F÷&WV—&VBÒfÇ6P¢÷6—F–öâç6V7W&—G•7F÷7FGW2ÒVæFVf–æV@¢÷6—F–öâç7—7FVÕ&÷FV7F–öäÆVw2ÒµÐ¢÷6—F–öâç&÷FV7F–öäÖöFRÒVæFVf–æV@¢÷6—F–öâæ6öçG&öÄ÷&FW%6WD6÷fW&vRÒVæFVf–æV@¢÷6—F–öâævw&VvFU&÷FV7F–öä×WFF–öå&WVW7FVDBÒVæFVf–æV@¢÷6—F–öâævw&VvFU&÷FV7F–öä×WFF–öå6WGFÆVDBÒVæFVf–æV@¢÷6—F–öâævw&VvFU&÷FV7F–öä×WFF–öå&V6öâÒVæFVf–æV@¢÷6—F–öâævw&VvFU&÷FV7F–öä÷væW"ÒfÇ6P¢÷6—F–öâævw&VvFU&÷FV7F–öåVçF—G’Ò ¢÷6—F–öâæ6Æ÷6U&V6öâÒ6Æ÷6U&V6öà¢òòW'6—7BF†R7GVÂW†—B&–6R6òF†R7FG2&÷WFRæBG&FRÖ†—7F÷'¢òòF&ÆR6â6†÷rF†R&VÂ6Æ÷6R&–6Rv—F†÷WBæVVF–ærFò&6²ÖFW&—fP¢òò—Bg&öÒ&VÆ—¦VEäÂâF†—2—2F†RFVf–æ—F—fR6÷W&6RöbG'WF‚f÷ ¢òòF†R$W†—B"6öÇVÖâ–âG&FR†—7F÷'’à¢6öç7BÆ7D7GVÄW†V7WF–öå&–6RÒ²âââ‡÷6—F–öâç'F–Ä÷&FW$W†V7WF–öç2ÇÂµÒ•Ð¢ç&WfW'6R‚¢æÖ‚†W†V7WF–öâ’ÓâçVÖ&W"†W†V7WF–öâç&–6R’ÇÂ¢æf–æB‚‡&–6R’Óâ&–6Râ’ÇÂ ¢6öç7B66÷VçFVD6Æ÷6U&–6RÒ—56–×VÆF–öä6Æ÷6Rò6Æ÷6U&–6R¢Æ7D7GVÄW†V7WF–öå&–6P¢–b†66÷VçFVD6Æ÷6U&–6Râ’÷6—F–öâæ6Æ÷6U&–6RÒÖF‚ç&÷VæB†66÷VçFVD6Æ÷6U&–6R¢S‚’òS€¢ ¢òò7FWææ÷FF–öâF—7F–æwV—6†W2F†RF‡&VR&VÂ÷WF6öÖW3 ¢òò(
"ö²(i"6öææV7F÷"&WGW&æVB7V66W70¢òò(
"Ç&VG•ö6Æ÷6VB(i"fVçVR6–B÷6—F–öâ—2vöæR…4ÂõEf—&VB¢òò(
"f–ÆVB(i"6öææV7F÷"&WGW&æVBâW'&÷"vR6÷VÆFâwB&V6÷fW ¢òò(
"6¶—VB(i"æò6öææV7F÷"v276VB†ÖçVÂD"ÖöæÇ’6Æ÷6R¢6öç7BW†6†ævTæ÷FRÐ¢W†6†ævT6öææV7F÷ ¢ò""òòæòW†6†ævRÆVp¢¢W†6†ævT6Æ÷6U&V6öâÓÓÒ&ö² ¢ò"¶W†6†ævRÖ6Æ÷6VEÒ ¢¢W†6†ævT6Æ÷6U&V6öâÓÓÒ&Ç&VG•ö6Æ÷6VB ¢ò"¶W†6†ævRÖÇ&VG’Ö6Æ÷6VEÒ ¢¢"¶W†6†ævRÖ6Æ÷6RÔd”ÄTEÒ ¢W6…7FW€¢÷6—F–öâÀ¢&6Æ÷6R"À¢G'VRÀ¢6Æ÷6RG¶66÷VçFVD6Æ÷6U&–6Râò66÷VçFVD6Æ÷6U&–6R¢'Vç&W6öÇfVB'ÒæÃÒG·æÂçFôf—†VBƒ"—Ò&ö“ÒG·&ö’çFôf—†VBƒ"—ÒR66÷VçF–æsÒG·÷6—F–öâç&VÆ—¦VEæÅ6÷W&6WÒòG·÷6—F–öâç&VÆ—¦VEæÄ6ö×ÆWFRò&6ö×ÆWFR"¢&–æ6ö×ÆWFR'Ò&V6öãÒG¶6Æ÷6U&V6öçÒG¶W†6†ævTæ÷FWÖÀ¢¢òò6fU÷6—F–öâ‚’†æFÆW2–æFW‚Ö÷fR²–FV×÷FVçB&6†—fÂà¢òò4„T4²F†RÖ÷fVBÖÖ&¶W"$Tdõ$R6fU÷6—F–öâ‚’'Vç26òvR¶æ÷p¢òòv†WF†W"D„•26Æ÷6R—2F†Rf—'7BFW&Ö–æÂw&—FR÷"&RÖVçG'’à¢òòv—F†÷WBF†—2wV&B6Æ÷6TÆ—fU÷6—F–öææBF†R&V6öæ6–ÆRÆö÷ ¢òò6÷VÆB$õD‚'V×Æ—fU÷÷6—F–öç5ö6Æ÷6VEö6÷VçFf÷"F†R6ÖP¢òò÷6—F–öâ(	BF†Bw2W†7FÇ’F†R%÷6—F–öç26Æ÷6VBƒb’à¢òò÷6—F–öç27&VFVBƒB’"7–ÖÖWG'’F†R÷W&F÷"&W÷'FVBà¢6öç7BÖ÷fVDÖ&¶W"ÒÆ—fS§÷6—F–öç3¢G¶6öææV7F–öä–GÓ¦Ö÷fVC¢G·÷6—F–öâæ–GÖ ¢6öç7Bv4Ç&VG”6Æ÷6VBÒv—B6Æ–VçBævWB†Ö÷fVDÖ&¶W"’æ6F6‚‚‚’ÓâçVÆÂ¢6öç7B6Æ÷6VD×WFF–öâÒv—B×WFFU÷6—F–öåv—F…fW'6–öä6†V6²‡÷6—F–öâÂ²&6Æ÷6–ær%ÒÂG&gBÓâ°¢ö&¦V7Bæ76–vâ†G&gBÂ÷6—F–öâ¢G&gBç7FGW2Ò&6Æ÷6VB ¢G&gBçfW'6–öâÒçVÖ&W"‡÷6—F–öâçfW'6–öâÇÂ’²¢G&gBçWFFVDBÒFFRææ÷r‚¢G&gBæÆö6¶VDBÒ ¢G&gBæÆö6¶VD'’ÒVæFVf–æV@¢Ò¢–b‚6Æ÷6VD×WFF–öâ’°¢v—B&VÆV6U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6´–B’æ6F6‚‚‚’ÓâfÇ6R¢×WFF–öäÆö6´†VÆBÒfÇ6P¢&WGW&âçVÆÀ¢Ð¢ö&¦V7Bæ76–vâ‡÷6—F–öâÂ6Æ÷6VD×WFF–öâ¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢v—BGfæ6T&Æö6´6÷VçEW6W4öå÷6—F–öä6Æ÷6R†6Æ–VçBÂ÷6—F–öâ ¢òò)H)HRâ&VÆV6RFVGWÆö6²²6÷VçFW'2²VF—BÆör)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢v—B&VÆV6U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6´–B’æ6F6‚‚‚’ÓâfÇ6R¢×WFF–öäÆö6´†VÆBÒfÇ6P¢–b‡÷6—F–öâæÆ—fTÆö6µFö¶Vâ’°¢v—B&VÆV6TÆö6²†6öææV7F–öä–BÂ÷6—F–öâç7–Ö&öÂÂÆ—fTÆö6´F—&V7F–öâ‡÷6—F–öâ’Â÷6—F–öâæÆ—fTÆö6µFö¶Vâ¢ÒVÇ6R–b†÷&–v–æÅ7FGW2ÓÒ'6–×VÆFVB"’°¢òò6–×VÆFVB÷&V6÷fW&VB&÷w26âÆVv—F–ÖFVÇ’&VFFRÆ—fRFÖ—76–öà¢òòÆö6²âW"&÷w2æWfW"7V—&RF†BÆö6²BÆÂÂ6òv&æ–ærf÷"WfW'¢òòæ÷&ÖÂ6–×VÆFVB6Æ÷6R—2fÇ6R×÷6—F—fRæö—6Râf÷"&VÂ÷&V6÷fW&V@¢òòfVçVR&÷rÂ&VÆV6–ærÆö6²vRFòæ÷B÷vâv÷VÆB7F–ÆÂ&RVç6fS²&WF–à¢òòF†R&FRÖÆ–Ö—FVBF–væ÷7F–2f÷"F†B7GVÂ&V6÷fW'’æöÖÇ’à¢Æöu'VçF–ÖUv&æ–ær€¢Æ—fRÖÆö6²×&VÆV6RÖÖ—76–æs¢G¶6öææV7F–öä–GÓ¢G·÷6—F–öâç7–Ö&öÇÓ¢G·÷6—F–öâæF—&V7F–öçÖÀ¢3óÀ¢G´Äôuõ$Td•‡Ò¶Æö6²Ö6ö÷&F–æF–öåÒ6Æ÷6R6¶—VBÆ—fRÆö6²&VÆV6Rf÷"G¶6öææV7F–öä–GÒòG·÷6—F–öâç7–Ö&öÇÒòG·÷6—F–öâæF—&V7F–öçÒ&V6W6Ræò÷væW"Fö¶Vâ—2f–Æ&ÆVÀ¢¢Ð¢–b‚v4Ç&VG”6Æ÷6VB’°¢–b†—56–×VÆF–öä6Æ÷6R’°¢v—B–æ7&VÖVçDÖWG&–2†6öææV7F–öä–BÂ&Æ—fU÷6–×VÆFVE÷÷6—F–öç5ö6Æ÷6VEö6÷VçB"¢–b‡æÂâ’v—B–æ7&VÖVçDÖWG&–2†6öææV7F–öä–BÂ&Æ—fU÷6–×VÆFVE÷v–ç5ö6÷VçB"¢ÒVÇ6R°¢v—B–æ7&VÖVçDÖWG&–2†6öææV7F–öä–BÂ&Æ—fU÷÷6—F–öç5ö6Æ÷6VEö6÷VçB"¢–b‡÷6—F–öâç&VÆ—¦VEæÄ6ö×ÆWFRbbæÂâ’v—B–æ7&VÖVçDÖWG&–2†6öææV7F–öä–BÂ&Æ—fU÷v–ç5ö6÷VçB"¢Ð¢6öç7B6Æ÷6VDF—&V7F–öâÒ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ‡÷6—F–öâ¢òò6–væÂöFVfVÇB÷"6–væÂô&Æö6²ÆVrÖ’†fR¦ö–æVB÷6—F–öâv†÷6P¢òò&–Ö'’÷væW"—2æ÷F†W"–æF–6F–öâG—RâGG&–'WF–öâföÆÆ÷w2F†P¢òòGW&&ÆR6–væÂ&—6²÷6÷W&6RÆ–æVvRÂæ÷BF†Rf—'7BÆVrw2Æ&VÂà¢–b‡÷6—F–öâç&VÆ—¦VEæÄ6ö×ÆWFRbb6Æ÷6VDF—&V7F–öâbb÷6—F–öâç6–væÅ&—6³òç6÷W&6T–G3òæÆVæwF‚’°¢6öç7B6–væÄ6WGF–æw2Òv—BvWD6WGF–æw2‚’æ6F6‚‚‚’Óâ‡·Ò2ç’’¢6öç7B÷6—F–öä6÷7E7BÒÖF‚æÖ‚€¢ãÀ¢çVÖ&W"€¢6–væÄ6WGF–æw3òç÷6—F–öä6÷7Bóð¢6–væÄ6WGF–æw3òæW†6†ævU÷6—F–öä6÷7Bóð¢6–væÄ6WGF–æw3òæW†6†ævU÷÷6—F–öåö6÷7BÀ¢’ÇÂãÀ¢¢v—B&V6÷&E6–væÅW&f÷&Öæ6T÷WF6öÖR‡°¢6öææV7F–öä–BÀ¢÷6—F–öä–C¢÷6—F–öâæ–BÀ¢7–Ö&öÃ¢÷6—F–öâç7–Ö&öÂÀ¢F—&V7F–öã¢6Æ÷6VDF—&V7F–öâÀ¢æÂÀ¢æÅ7C¢æ÷F–öæÂâò‡æÂòæ÷F–öæÂ’¢¢À¢÷6—F–öä6÷7E7BÀ¢6÷W&6T–G3¢÷6—F–öâç6–væÅ&—6²ç6÷W&6T–G2À¢6–væÄÆæW3¢÷6—F–öâç6–væÅ&—6²ç6–væÄÆæW2À¢Æ—fTW†6†ævS¢÷&–v–æÅ7FGW2ÓÒ'6–×VÆFVB"bb&ööÆVâ†W†6†ævT6öææV7F÷"’À¢6Æ÷6VDC¢÷6—F–öâæ6Æ÷6VDBÇÂFFRææ÷r‚’À¢Ò’æ6F6‚‚†W'&÷"’Óâ°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò6–væÂ÷WF6öÖRGG&–'WF–öâf–ÆVBf÷"G·÷6—F–öâæ–GÓ¦À¢W'&÷"–ç7Fæ6VöbW'&÷"òW'&÷"æÖW76vR¢W'&÷"À¢¢Ò¢Ð¢òòöæÇ’6÷VçB2W†6†ævRÖ6Æ÷6Rf–ÇW&Rv†VâF†R6öææV7F÷"7GVÆÇ¢òòf–ÆVBâÇ&VG•ö6Æ÷6VFÖVç2F†RW†6†ævR×6–FR7FFRÇ&VG¢òòÖF6†W2÷W"–çFVçB…4ÂõEf—&VBf—'7B’ÂæB6¶—VFÖVç2vP¢òòæWfW"†B6öææV7F÷"(	BæV—F†W"—2&VÂf–ÇW&Rà¢–b†W†6†ævT6Æ÷6U&V6öâÓÓÒ&f–ÆVB"’°¢v—B–æ7&VÖVçDÖWG&–2†6öææV7F–öä–BÂ&Æ—fU÷÷6—F–öç5ö6Æ÷6Uöf–ÆVEö6÷VçB"¢Ð¢Ð ¢òò)H)H–æ6ÇVFRÆ–æVvR6öçFW‡B–â6Æ÷6RÆövv–ær)H)H ¢òòv†VâÆ—fR÷6—F–öâ6Æ÷6W2ÂÆör—G2÷&–v–æÂ&VÂ6WB6öçFW‡@¢òò6òF6†&ö&G26âG&6RF†R6ö×ÆWFRÆ–fV7–6ÆS ¢òò&VÂ6WB(i"Æ—fR7&VF–öâ(i"4ÂõEöÖçVÂ6Æ÷6R(i"f–æÂdÀ¢v—BÆöu&öw&W76–öäWfVçB†6öææV7F–öä–BÂ&Æ—fU÷G&F–ær"Â&–æfò"Â6Æ÷6VBÆ—fR÷6—F–öâG·÷6—F–öâç7–Ö&öÇÖÂ°¢Æ—fU÷6—F–öä–C¢÷6—F–öâæ–BÀ¢&VÅ÷6—F–öä–C¢÷6—F–öâç&VÅ÷6—F–öä–BÀ¢&VÅ6WD¶W“¢÷6—F–öâç6WD¶W’À¢&VÅ&VçE6WD¶W“¢÷6—F–öâç&VçE6WD¶W’À¢&VÅ6WEf&–çC¢÷6—F–öâç6WEf&–çBÀ¢&VÄ†—5v–æF÷w3¢÷6—F–öâæ†—5v–æF÷w2À¢6–væÅ6÷W&6T–G3¢÷6—F–öâç6–væÅ&—6³òç6÷W&6T–G2À¢6–væÅ7F÷Æ÷757C¢÷6—F–öâç6–væÅ&—6³òç7F÷Æ÷757BÀ¢6–væÅF¶U&öf—E7C¢÷6—F–öâç6–væÅ&—6³òçF¶U&öf—E7BÀ¢æÂÀ¢&ö’À¢6Æ÷6U&–6S¢66÷VçFVD6Æ÷6U&–6RÇÂçVÆÂÀ¢æÄ66÷VçF–æt6ö×ÆWFS¢÷6—F–öâç&VÆ—¦VEæÄ6ö×ÆWFRÀ¢æÄ66÷VçF–æu6÷W&6S¢÷6—F–öâç&VÆ—¦VEæÅ6÷W&6RÀ¢6Æ÷6U&V6öâÀ¢W†V7WFVEVçF—G“¢G’À¢fW&vTVçG'“¢ftVçG'’À¢ÆWfW&vS¢ÆWbÀ¢Ö&v–äE&—6³¢Ö&v–âÀ¢W†6†ævT6Æ÷6U7V66VVFVC¢W†6†ævT6Æ÷6U7V66W72À¢W†6†ævT6Æ÷6T6Æ76–f–6F–öã¢W†6†ævT6Æ÷6U&V6öâÀ¢Ò ¢6öç7B6Æ÷6U7FGW2Ð¢W†6†ævT6Æ÷6U&V6öâÓÓÒ&ö² ¢ò%5T44TTDTB ¢¢W†6†ævT6Æ÷6U&V6öâÓÓÒ&Ç&VG•ö6Æ÷6VB ¢ò$Å$TE’Ô4Äõ4TB…4ÂõEf—&VB’ ¢¢W†6†ævT6Æ÷6U&V6öâÓÓÒ'6¶—VB ¢ò$D"ÖöæÇ’†æò6öææV7F÷"’ ¢¢$d”ÄTB„D"Ö6Æ÷6VC²W†6†ævRVæ6W'F–â’ ¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Ò·cÒ6Æ÷6VBG·÷6—F–öâç7–Ö&öÇÒG·÷6—F–öâæF—&V7F–öçÒdÃÒG·æÂçFôf—†VBƒ"—Ò$ô“ÒG·&ö’çFôf—†VBƒ"—ÒR&V6öãÒG¶6Æ÷6U&V6öçÒW†6†ævUö6Æ÷6SÒG¶6Æ÷6U7FGW7ÖÀ¢ ¢&WGW&â÷6—F–öà¢Ò6F6‚†W'"’°¢–b†×WFF–öäÆö6´†VÆB’°¢v—B&VÆV6U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6´–B’æ6F6‚‚‚’ÓâfÇ6R¢Ð¢6öç6öÆRæW'&÷"†G´Äôuõ$Td•‡ÒW'&÷"6Æ÷6–ærÆ—fR÷6—F–öã¦ÂW'"¢&WGW&âçVÆÀ¢Òf–æÆÇ’°¢7F÷÷6—F–öäÆö6´ÆV6U&Vg&W6ƒòâ‚¢Ð§Ð ¦gVæ7F–öâ—5&Tf–ÆÅv—F†÷WDW†6†ævT†æFÆR€¢÷6—F–öã¢–6³ÄÆ—fU÷6—F–öâÂ&W†V7WFVEVçF—G’#âÀ¢÷&–v–æÅ7FGW3¢Æ—fU÷6—F–öå²'7FGW2%ÒÂVæFVf–æVBÀ¢†57—7FVÔ÷&FW$–C¢&ööÆVâÀ¢“¢&ööÆVâ°¢&WGW&â†57—7FVÔ÷&FW$–Bb`¢çVÖ&W"‡÷6—F–öâæW†V7WFVEVçF—G’ÇÂ’ÃÒb`¢†÷&–v–æÅ7FGW2ÓÓÒ'Æ6VB"ÇÀ¢÷&–v–æÅ7FGW2ÓÓÒ'VæF–ær"ÇÀ¢÷&–v–æÅ7FGW2ÓÓÒ'VæF–æuöf–ÆÂ"ÇÀ¢÷&–v–æÅ7FGW2ÓÓÒ'Æ6VE÷Væ6öæf—&ÖVB"§Ð ¢ò¢ ¢¢vWBÆÂÆ—fR÷6—F–öç2f÷"6öææV7F–öâà¢¢ð¦W‡÷'B7–æ2gVæ7F–öâvWDÆ—fU÷6—F–öç2†6öææV7F–öä–C¢7G&–ær“¢&öÖ—6SÄÆ—fU÷6—F–öåµÓâ°¢v—B–æ—E&VF—2‚¢6öç7B6Æ–VçBÒvWE&VF—46Æ–VçB‚¢G'’°¢6öç7B–G2Ò‚†v—B6Æ–VçBæÇ&ævR†Æ—fS§÷6—F–öç3¢G¶6öææV7F–öä–GÖÂÂÓ’æ6F6‚‚‚’ÓâµÒ’’ÇÂµÒ’27G&–æuµÐ ¢òòFVGWÆ–6FRv†–ÆR&W6W'f–ær÷&FW"(	BF†R÷Vâ–æFW‚Ö’6öçF–â7FÆP¢òòGWÆ–6FW2g&öÒ&WG&–VBw&—FW2à¢6öç7BVæ—VT–G3¢7G&–æuµÒÒµÐ¢6öç7B6VVâÒæWr6WCÇ7G&–æsâ‚¢f÷"†6öç7B–Böb–G2’°¢–b‡6VVâæ†2†–B’’6öçF–çVP¢6VVâæFB†–B¢Væ—VT–G2çW6‚†–B¢Ð ¢òò&VBF†R6ö×ÆWFRWF†÷&—FF—fR÷Vâ–æFW‚â&F6†W2&÷VæB6öæ7W'&Væ7’À¢òòæ÷B6&F–æÆ—G“¢Ö–â&öö²Æ&vW"F†âS&÷w2×W7B7F–ÆÂ&V6öæ6–ÆRÀ¢òò6Æ÷6RÂæBV"–â7W'&VçB7FF—7F–72gFW"&W7F'Bà¢6öç7B÷6—F–öç3¢Æ—fU÷6—F–öåµÒÒµÐ¢6öç7B$TEô$D4…õ4•¤RÒ3 ¢f÷"†ÆWBöfg6WBÒ²öfg6WBÂVæ—VT–G2æÆVæwFƒ²öfg6WB³Ò$TEô$D4…õ4•¤R’°¢6öç7BfÇVW2Òv—B&öÖ—6RæÆÂ€¢Væ—VT–G0¢ç6Æ–6R†öfg6WBÂöfg6WB²$TEô$D4…õ4•¤R¢æÖ‚†–B’Óâ&VDÆ—fU÷6—F–öå6æ6†÷B†6Æ–VçBÂ6öææV7F–öä–BÂ–B’æ6F6‚‚‚’ÓâçVÆÂ’’À¢¢f÷"†6öç7B÷2öbfÇVW2’–b‡÷2’÷6—F–öç2çW6‚‡÷2¢Ð¢&WGW&â÷6—F–öç0¢Ò6F6‚†W'"’°¢6öç6öÆRçv&â†G´Äôuõ$Td•‡ÒW'&÷"vWGF–ærÆ—fR÷6—F–öç3¦ÂW'"¢&WGW&âµÐ¢Ð§Ð ¢ò¢ ¢¢vWBÆ—fR÷6—F–öç2f–ÇFW&VB'’7FGW2à¢¢ð¦W‡÷'B7–æ2gVæ7F–öâvWDÆ—fU÷6—F–öç4'•7FGW2€¢6öææV7F–öä–C¢7G&–ærÀ¢7FGW3¢Æ—fU÷6—F–öå²'7FGW2%Ð¢“¢&öÖ—6SÄÆ—fU÷6—F–öåµÓâ°¢6öç7BÆÅ÷6—F–öç2Òv—BvWDÆ—fU÷6—F–öç2†6öææV7F–öä–B¢&WGW&âÆÅ÷6—F–öç2æf–ÇFW"‡Óâç7FGW2ÓÓÒ7FGW2¢Ð ¢ò¢ ¢¢fWF6‚F†RÖ÷7B&V6VçB6Æ÷6VB÷FW&Ö–æÂ÷6—F–öç2g&öÒF†R6Æ÷6VB&6†—fRà¢¢6Æ÷6VB÷6—F–öç2&R7F÷&VB6W&FVÇ’6òF†R÷Vâ–æFW‚7F—26ÖÆÂà¢¢ð¦W‡÷'B7–æ2gVæ7F–öâvWD6Æ÷6VDÆ—fU÷6—F–öç2€¢6öææV7F–öä–C¢7G&–ærÀ¢Æ–Ö—BÒ# ¢“¢&öÖ—6SÄÆ—fU÷6—F–öåµÓâ°¢v—B–æ—E&VF—2‚¢6öç7B6Æ–VçBÒvWE&VF—46Æ–VçB‚¢G'’°¢6öç7B–G2Ò‚†v—B6Æ–VçBæÇ&ævR†Æ—fS§÷6—F–öç3¢G¶6öææV7F–öä–GÓ¦6Æ÷6VFÂÂÆ–Ö—BÒ’æ6F6‚‚‚’ÓâµÒ’’ÇÂµÒ’27G&–æuµÐ ¢òòFVGWÆ–6FR²&F6‚tUG26öæ7W'&VçFÇ’‡6ÖR&F–öæÆR2vWDÆ—fU÷6—F–öç2’à¢6öç7BVæ—VT–G3¢7G&–æuµÒÒµÐ¢6öç7B6VVâÒæWr6WCÇ7G&–æsâ‚¢f÷"†6öç7B–Böb–G2’°¢–b‡6VVâæ†2†–B’’6öçF–çVP¢6VVâæFB†–B¢Væ—VT–G2çW6‚†–B¢Ð ¢6öç7B÷6—F–öç3¢Æ—fU÷6—F–öåµÒÒµÐ¢–b‡Væ—VT–G2æÆVæwF‚ÓÓÒ’&WGW&â÷6—F–öç0 ¢6öç7B$TEô$D4…õ4•¤RÒ3 ¢f÷"†ÆWBöfg6WBÒ²öfg6WBÂVæ—VT–G2æÆVæwFƒ²öfg6WB³Ò$TEô$D4…õ4•¤R’°¢6öç7BfÇVW2Òv—B&öÖ—6RæÆÂ€¢Væ—VT–G0¢ç6Æ–6R†öfg6WBÂöfg6WB²$TEô$D4…õ4•¤R¢æÖ‚†–B’Óâ&VDÆ—fU÷6—F–öå6æ6†÷B†6Æ–VçBÂ6öææV7F–öä–BÂ–B’æ6F6‚‚‚’ÓâçVÆÂ’’À¢¢f÷"†6öç7B÷2öbfÇVW2’–b‡÷2’÷6—F–öç2çW6‚‡÷2¢Ð¢&WGW&â÷6—F–öç0¢Ò6F6‚†W'"’°¢6öç6öÆRçv&â†G´Äôuõ$Td•‡ÒvWD6Æ÷6VDÆ—fU÷6—F–öç2W'&÷#¦ÂW'"¢&WGW&âµÐ¢Ð§Ð ¢ò¢ ¢¢6ö×WFRvw&VvFR7FG27&÷72ÆÂÆ—fR÷6—F–öç2à¢¢ð¦W‡÷'B7–æ2gVæ7F–öâ6Æ7VÆFTÆ—fU÷6—F–öå7FG2€¢6öææV7F–öä–C¢7G&–æp¢“¢&öÖ—6SÇ°¢F÷FÄf–ÆÆVC¢çVÖ&W ¢F÷FÄ÷Vã¢çVÖ&W ¢F÷FÄ6Æ÷6VC¢çVÖ&W ¢F÷FÅäÃ¢çVÖ&W ¢fW&vU$ô“¢çVÖ&W ¢v–å&FS¢çVÖ&W ¢7FF—7F–73¢Æ—fU÷6—F–öå7FF—7F–70§Óâ°¢G'’°¢òòÖW&vR÷Vâ†Æ—fR’æB6Æ÷6VB†&6†—fR’–æF–6W26òvw&VvFR7FG2&P¢òò67W&FR7&÷72F†R÷6—F–öâw2gVÆÂÆ–fV7–6ÆRÂæ÷B§W7B7W'&VçFÇ’Ö÷Vâà¢6öç7B¶÷Vå÷6—F–öç2Â6Æ÷6VE÷6—F–öç5ÒÒv—B&öÖ—6RæÆÂ…°¢vWDÆ—fU÷6—F–öç2†6öææV7F–öä–B’À¢vWD6Æ÷6VDÆ—fU÷6—F–öç2†6öææV7F–öä–BÂ’À¢Ò¢6öç7BÆÅ÷6—F–öç2Ò²ââæ÷Vå÷6—F–öç2Âââæ6Æ÷6VE÷6—F–öç5Ð¢6öç7B7FF—7F–72Ò6Æ7VÆFTÆ—fU÷6—F–öå7FF—7F–72†ÆÅ÷6—F–öç22Væ¶æ÷vâ2&V6÷&CÇ7G&–ærÂç“åµÒ ¢&WGW&â°¢F÷FÄf–ÆÆVC¢7FF—7F–72æf–ÆÆVBÀ¢F÷FÄ÷Vã¢7FF—7F–72æ÷VâÀ¢F÷FÄ6Æ÷6VC¢7FF—7F–72æ6Æ÷6VBÀ¢F÷FÅäÃ¢7FF—7F–72ç&VÆ—¦VEæÂÀ¢fW&vU$ô“¢7FF—7F–72æfW&vU&VÆ—¦VE&ö’À¢v–å&FS¢7FF—7F–72çv–å&FRÀ¢7FF—7F–72À¢Ð¢Ò6F6‚†W'"’°¢6öç6öÆRæW'&÷"†G´Äôuõ$Td•‡ÒW'&÷"6Æ7VÆF–ær7FG3¦ÂW'"¢6öç7B7FF—7F–72Ò6Æ7VÆFTÆ—fU÷6—F–öå7FF—7F–72…µÒ¢&WGW&â°¢F÷FÄf–ÆÆVC¢À¢F÷FÄ÷Vã¢À¢F÷FÄ6Æ÷6VC¢À¢F÷FÅäÃ¢À¢fW&vU$ô“¢À¢v–å&FS¢À¢7FF—7F–72À¢Ð¢Ð§Ð ¢ò¢ ¢¢FWFV7Bv†WF†W"F†RÆFW7BÖ&²&–6R†27&÷76VBF†R÷6—F–öâw0¢¢FW6—&VB4Â÷"EF‡&W6†öÆBæB(	B–b6ò(	Bf÷&6RÖ6Æ÷6RF†R÷6—F–öà¢¢f–6Æ÷6TÆ—fU÷6—F–öæâ&WGW&ç2F†R7&÷72&V6öâöæÇ’gFW"6öæf—&ÖV@¢¢FW&Ö–æÂG&ç6—F–öâÂ6Æ÷6U÷Væ6öæf—&ÖVFv†VâF†RW†6†ævR6Æ÷6Rf–ÆV@¢¢æBF†R÷6—F–öâ&VÖ–ç2G&6¶VBö÷VâÂ÷F†W'v—6RçVÆÆà¢ ¢¢F†—2—2F†R6fWG’æWBF†RW6W"FW67&–&VB2&6†V6²÷2–bFò&P¢¢WFFVB÷"6Æ÷6VBÇ6ò–æFWVæFVçBöbF†R6öçG&öÂ÷&FW'2"âWfVâ–`¢¢F†RW†6†ævR×Æ6VB&VGV6RÖöæÇ’4ÂõE÷&FW'2f–ÂFòf—&R†–ÆÆ—V–@¢¢—"vÂW†6†ævR÷&FW"6æ6VÆÆVB'’F†RW6W"ÂæWGv÷&²&6R’ÂF†—0¢¢6ö×&—6öâwV&çFVW2vR6Æ÷6RF†R÷6—F–öâöæ6RÖ&²&–6R†0¢¢7GVÆÇ’7&÷76VBF†R6öæf–wW&VBÆWfVÂà¢ ¢¢W6VB'“ ¢¢Ò&V6öæ6–ÆTÆ—fU÷6—F–öç6†7&öâÂgVÆÂ&V6öæ6–ÆR7vVW¢¢Ò7–æ5v—F„W†6†ævV†Væv–æRÆö÷ÂÆ–v‡FW"Ö&²×&–6R&Vg&W6‚¢¢Ò&V6Æ7VÆFTæDÇ•4ÅE†–ÖÖVF–FR6†V6²gFW"÷W&F÷"÷fW'&–FR(	@¢¢F–v‡FVæVB4ÂÖ–v‡BÇ&VG’&R'&V6†VBBF†RæWrW&6VçFvR¢ ¢¢W&R6–FRÖVffV7B†VÇW#¢F†R6ÆÆW"FV6–FW2v†BFòFòv—F‚çVÆÆ ¢¢‡G—–6ÆÇ“¢W'6—7BF†RÖ&²&Vg&W6‚æB6öçF–çVR’÷"v—F‚æöâÖçVÆÀ¢¢&WGW&â‡G—–6ÆÇ“¢6¶—gW'F†W"&ö6W76–ær&V6W6RF†R÷6—F–öâv0¢¢&6†—fVB'’6Æ÷6TÆ—fU÷6—F–öæ’à¢¢ð¦7–æ2gVæ7F–öâ6†V6´æDf÷&6T6Æ÷6Töå6ÇG7&÷72€¢6öææV7F–öä–C¢7G&–ærÀ¢÷3¢Æ—fU÷6—F–öâÀ¢Ö&µ&–6S¢çVÖ&W"À¢W†6†ævT6öææV7F÷#¢ç’À¢“¢&öÖ—6SÂ'6Åö†—B"Â'Gö†—B"Â'7V6–Å÷F–ÖUöW†—B"Â&6Æ÷6U÷Væ6öæf—&ÖVB"ÂçVÆÃâ°¢–b‚çVÖ&W"æ—4f–æ—FR†Ö&µ&–6R’ÇÂÖ&µ&–6RÃÒ’&WGW&âçVÆÀ¢–b‡÷2æW†V7WFVEVçF—G’ÃÒ’&WGW&âçVÆÀ¢6öç7BF—&V7F–öâÒ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ‡÷2¢–b‚F—&V7F–öâ’&WGW&âçVÆÀ¢÷2æF—&V7F–öâÒF—&V7F–öà¢÷2ç6–FRóóÒF—&V7F–öà¢ ¢òò5$•D”4ÂuT$C¢6¶—÷6—F–öç2F†B&RÇ&VG’6Æ÷6VB÷"†fR6Æ÷6R&V6öâ6WBà¢òòv—F†÷WBF†—2wV&BÂ×VÇF—ÆR6öæ7W'&VçB&V6öæ6–Æ–F–öâF‡26ÆÂF†—2gVæ7F–öà¢òòöâF†R6ÖR÷6—F–öâÂÆÂFWFV7F–ærF†R4ÂõE7&÷72æBÆÂ6ÆÆ–ær6Æ÷6TÆ—fU÷6—F–öâ‚’À¢òò&W7VÇF–ær–âGWÆ–6FR6Æ÷6RGFV×G2æBÖVÖ÷'’÷fW&ÆöBg&öÒ&VGVæFçB’6ÆÇ2à¢–b‡÷2ç7FGW2ÓÓÒ&6Æ÷6VB"ÇÂ÷2ç7FGW2ÓÓÒ'&V¦V7FVB"ÇÂ÷2ç7FGW2ÓÓÒ&W'&÷""’&WGW&âçVÆÀ¢–b‡÷2æ6Æ÷6U&V6öâÇÂ÷2æ6Æ÷6VDB’&WGW&âçVÆÂòòÇ&VG’&V–ær6Æ÷6VBVÇ6Wv†W&P¢ ¢òò6Æ÷6TÆ—fU÷6—F–öâ÷vç2F†R&VF—2×WFF–öâÆö6²æB7FGW2÷fW'6–öâG&ç6—F–öâà¢–b‚—57—7FVÕG&6¶VDÆ—fU÷6—F–öâ‡÷2Â6öææV7F–öä–B’’&WGW&âçVÆÀ¢–b‡÷2ç7FGW2ÓÓÒ'Æ6VB"’°¢òò&FRÖÆ–Ö—BFòöæ6R×W"ÖÖ–çWFRW"÷6—F–öâ'’W6–ærWFFVDB0¢òòF†RF‡&÷GFÆR¶W’(	B&WfVçG2Æör7Òv†–ÆR7F–ÆÂ7W&f6–ærF†P¢òò6¶—GW&–ærF–væ÷6—2à¢6öç7B6–æ6RÒFFRææ÷r‚’Ò‡÷2çWFFVDBÇÂ¢–b‡6–æ6Râcó’°¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Ò¶7&÷72Ö6†V6²6¶—ÒG·÷2ç7–Ö&öÇÒ†–CÒG·÷2æ–GÒ’7FGW3ÒwÆ6VBr(	BVçG'’÷&FW"æ÷Bf–ÆÆVB–WC²4ÂõE7&÷726†V6²FVfW'&VFÀ¢¢Ð¢&WGW&âçVÆÀ¢Ð ¢6öç7Bf–ÆÅ&–6RÒ÷2æfW&vTW†V7WF–öå&–6P¢òò&WV—&R6öæf—&ÖVBf–ÆÂ&–6RûûÞûûÒVçG'•&–6R—2âW7F–ÖFRæB6â&P¢òò7FÆRâ–bfW&vTW†V7WF–öå&–6R—2Ö—76–ærF†R÷6—F–öâ†2æ÷B&VVà¢òò6öæf—&ÖVBf–ÆÆVB–WC²6¶—VçF–Â—B—2à¢–b‚f–ÆÅ&–6RÇÂf–ÆÅ&–6RÃÒ’&WGW&âçVÆÀ ¢òò7V6–Â÷6—F–öç2&RFVÆ–&W&FVÇ’6†÷'BÖÆ—fVBâF†RF&vWBF–ÖR6Æ÷6W2¢òòÆæRF†B†2æ÷BFWfVÆ÷VBÖVæ–ævgVÂff÷W&&ÆRÖ÷fVÖVçC²F†R'6öÇWFP¢òòW‡—'’Çv—26Æ÷6W2—BæB—2–æFWVæFVçFÇ’6Æ×VBFò“Ö–çWFW2à¢–b…7G&–ær‡÷2æ–æF–6F–öåG—RÇÂ""’çG&–Ò‚’çFôÆ÷vW$66R‚’ÓÓÒ'7V6–Â"’°¢6öç7BÆâÒ6æ—F—¦U7V6–Å÷6—F–öåÆâ‡÷2ç7V6–Å÷6—F–öåÆâÂF—&V7F–öâ¢–b‡Æâ’°¢6öç7BVçG'•F–ÖRÒçVÖ&W"‡÷2æf–ÆÇ3òå³ÓòçF–ÖW7F×ÇÂ÷2æ7&VFVDBÇÂFFRææ÷r‚’¢6öç7B†&DW‡—'’ÒVçG'•F–ÖR²ÖF‚æÖ–â€¢5T4”ÅôÔ…ô„ôÄD”äuõ4T4ôäE2À¢ÆâæÖ†–×VÔ†öÆF–æu6V6öæG2À¢’¢ó ¢6öç7BW'6—7FVDW‡—'’ÒçVÖ&W"‡÷2ç7V6–ÄW‡—&W4BÇÂ†&DW‡—'’¢6öç7BW‡—'’ÒÖF‚æÖ–â††&DW‡—'’ÂW'6—7FVDW‡—'’âVçG'•F–ÖRòW'6—7FVDW‡—'’¢†&DW‡—'’¢6öç7BF&vWDW†—DBÒVçG'•F–ÖR²ÖF‚æÖ–â€¢ÆâçF&vWD†öÆF–æu6V6öæG2À¢ÆâæÖ†–×VÔ†öÆF–æu6V6öæG2À¢5T4”ÅôÔ…ô„ôÄD”äuõ4T4ôäE2À¢’¢ó ¢6öç7B6–væVDÖ÷fU7BÒ‚†Ö&µ&–6RÒf–ÆÅ&–6R’òf–ÆÅ&–6R’¢ ¢†F—&V7F–öâÓÓÒ&Æöær"ò¢Ó¢6öç7B–ç7Vff–6–VçDÖöÖVçGVÒÒ6–væVDÖ÷fU7BÂÖF‚æÖ‚€¢ãÀ¢Æâç&÷FV7F–öâçG&–Æ–æt7F—fF–öå7B¢ã#RÀ¢¢6öç7BÖ„W‡—&VBÒFFRææ÷r‚’ãÒW‡—'¢6öç7BF&vWDW‡—&VBÒFFRææ÷r‚’ãÒF&vWDW†—DBbb–ç7Vff–6–VçDÖöÖVçGVÐ¢–b†Ö„W‡—&VBÇÂF&vWDW‡—&VB’°¢6öç7B&V6öâÒÖ„W‡—&V@¢ò'7V6–ÅöÖ…öGW&F–öâ ¢¢'7V6–Å÷F&vWEöGW&F–öåöæõöÖöÖVçGVÒ ¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&–æfò"À¢7V6–ÂF–ÖRW†—Bf÷"G·÷2ç7–Ö&öÇÒG¶F—&V7F–öçÖÀ¢°¢÷6—F–öä–C¢÷2æ–BÀ¢F—&V7F–öâÀ¢&V6öâÀ¢†öÆF–æu6V6öæG3¢ÖF‚æÖ‚ƒÂÖF‚æfÆö÷"‚„FFRææ÷r‚’ÒVçG'•F–ÖR’òó’’À¢F&vWD†öÆF–æu6V6öæG3¢ÆâçF&vWD†öÆF–æu6V6öæG2À¢Ö†–×VÔ†öÆF–æu6V6öæG3¢ÆâæÖ†–×VÔ†öÆF–æu6V6öæG2À¢6–væVDÖ÷fU7BÀ¢ÒÀ¢’æ6F6‚‚‚’Óâ·Ò¢6öç7B6Æ÷6VBÒv—B6Æ÷6TÆ—fU÷6—F–öâ€¢6öææV7F–öä–BÀ¢÷2æ–BÀ¢Ö&µ&–6RÀ¢W†6†ævT6öææV7F÷"À¢&V6öâÀ¢¢–b†6Æ÷6VCòç7FGW2ÓÓÒ&6Æ÷6VB"’&WGW&â'7V6–Å÷F–ÖUöW†—B ¢–b†6Æ÷6VB’ö&¦V7Bæ76–vâ‡÷2Â6Æ÷6VB¢&WGW&â&6Æ÷6U÷Væ6öæf—&ÖVB ¢Ð¢Ð¢Ð ¢òòW6RF†R6ÖR6æöæ–6Â&W6öÇfW"2fVçVR6öçG&öÂÖ÷&FW"&V6öæ6–Æ–F–öâà¢òòF†—2¶VW2Væv–æR×6–FRfÆÆ&6²W†7FÇ’6ö÷&F–æFVBv—F‚G&–Æ–ærÀ¢òò÷W&F÷"'6öÇWFR×&–6R÷fW'&–FW2æBD4F¶R×&öf—B&V6Æ7VÆF–öâà¢6öç7B²FW6—&VE6ÂÂFW6—&VEGÒÒ6ö×WFTFW6—&VE&÷FV7F–öå&–6W2‡÷2 ¢òòæ÷F†–ærFòWfÇVFR–bæV—F†W"&÷FV7F–öâ&æB—26öæf–wW&VBà¢–b†FW6—&VE6ÂÃÒbbFW6—&VEGÃÒ’&WGW&âçVÆÀ ¢ÆWB7&÷75&V6öã¢'6Åö†—B"Â'Gö†—B"ÂçVÆÂÒçVÆÀ¢–b‡÷2æF—&V7F–öâÓÓÒ&Æöær"’°¢–b†FW6—&VE6ÂâbbÖ&µ&–6RÃÒFW6—&VE6Â’7&÷75&V6öâÒ'6Åö†—B ¢VÇ6R–b†FW6—&VEGâbbÖ&µ&–6RãÒFW6—&VEG’7&÷75&V6öâÒ'Gö†—B ¢ÒVÇ6R°¢–b†FW6—&VE6ÂâbbÖ&µ&–6RãÒFW6—&VE6Â’7&÷75&V6öâÒ'6Åö†—B ¢VÇ6R–b†FW6—&VEGâbbÖ&µ&–6RÃÒFW6—&VEG’7&÷75&V6öâÒ'Gö†—B ¢Ð ¢–b‚7&÷75&V6öâ’&WGW&âçVÆÀ ¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡ÒG¶7&÷75&V6öâçFõWW$66R‚—ÒFWFV7FVBf÷"G·÷2ç7–Ö&öÇÒG·÷2æF—&V7F–öçÒÖ&³ÒG¶Ö&µ&–6WÒ‡6ÃÒG¶FW6—&VE6ÇÒGÒG¶FW6—&VEGÒ’ûûÞûûÞûûÒf÷&6RÖ6Æ÷6–ævÀ¢¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢'v&æ–ær"À¢G¶7&÷75&V6öâÓÓÒ'6Åö†—B"ò%7F÷ÖÆ÷72"¢%F¶R×&öf—B'Ò7&÷72FWFV7FVBf÷"G·÷2ç7–Ö&öÇÒ(	Bf÷&6RÖ6Æ÷6–ævÀ¢°¢÷6—F–öä–C¢÷2æ–BÀ¢Ö&µ&–6RÀ¢FW6—&VE6ÂÀ¢FW6—&VEGÀ¢F—&V7F–öã¢÷2æF—&V7F–öâÀ¢fW&vTVçG'“¢÷2æfW&vTW†V7WF–öå&–6RÀ¢òòW6VgVÂf÷"F†R÷W&F÷"VF—BG&–Ã¢v2F†R7&÷72&V6W6RF†P¢òòW†6†ævR×Æ6VB6öçG&öÂ÷&FW"f–ÆVBFòf—&RÂ÷"&V6W6RF†P¢òò÷W&F÷"§W7BF–v‡FVæVBF†R&æB7V6‚F†BF†R÷6—F–öâv0¢òòÇ&VG’7B—Cð¢†E7F÷Æ÷74÷&FW#¢÷2ç7F÷Æ÷74÷&FW$–BÀ¢†EF¶U&öf—D÷&FW#¢÷2çF¶U&öf—D÷&FW$–BÀ¢ÒÀ¢ ¢G'’°¢6öç7B6Æ÷6VBÒv—B6Æ÷6TÆ—fU÷6—F–öâ€¢6öææV7F–öä–BÀ¢÷2æ–BÀ¢Ö&µ&–6RÀ¢W†6†ævT6öææV7F÷"À¢7&÷75&V6öâ2Væ¶æ÷vâ27G&–ærÀ¢¢–b†6Æ÷6VCòç7FGW2ÓÓÒ&6Æ÷6VB"’&WGW&â7&÷75&V6öà¢–b†6Æ÷6VB’ö&¦V7Bæ76–vâ‡÷2Â6Æ÷6VB¢&WGW&â&6Æ÷6U÷Væ6öæf—&ÖVB ¢Ò6F6‚†6Æ÷6TW'"’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Òf÷&6RÖ6Æ÷6RöâG¶7&÷75&V6öâÒf–ÆVBf÷"G·÷2æ–GÓ¦À¢6Æ÷6TW'"–ç7Fæ6VöbW'&÷"ò6Æ÷6TW'"æÖW76vR¢7G&–ær†6Æ÷6TW'"’À¢¢Ð¢&WGW&â&6Æ÷6U÷Væ6öæf—&ÖVB §Ð ¢ò¢ ¢¢&V6öæ6–ÆR&VF—2×G&6¶VBÆ—fR÷6—F–öç2v—F‚F†RW†6†ævRà¢ ¢¢f÷"WfW'’&VF—2×G&6¶VB÷Vâ÷6—F–öã ¢¢Ò–b&W6VçBöâF†RW†6†ævS¢&Vg&W6‚Ö&µ&–6RòÆ—&–6RòVç&VÆ—¦VEäÀ¢¢Ò–bäõB&W6VçBöâF†RW†6†ævS¢—Bv26Æ÷6VBW‡FW&æÆÇ’…4ÂõE†—BÀ¢¢Æ—V–FFVBÂ÷"ÖçVÆÇ’6Æ÷6VB’âG&ç6—F–öâFò&6Æ÷6VB"Â6ö×WFR&VÆ—6V@¢¢äÂÂÖ÷fRFòF†R6Æ÷6VB&6†—fRÂ–æ7&VÖVçBÖWG&–72Â&VÆV6RF†RÆö6²à¢ ¢¢&WGW&ç27VÖÖ'’W6&ÆRf÷"Æövv–ærò’&W7öç6W2à¢ ¢¢)H)H†VFvRÔæWB&V6öæ6–Æ–F–öâ†öö²†÷W&F÷"7V2Â÷6—F–öâÔ6÷VçB†—2’)HûûÞûûÞ)H)H)H)H ¢¢7G&FVw’Ö6ö÷&F–æF÷"æWfÇVFU&VÅ6WG6w&—FW2W"Ö'V6¶WBæWBF&vWG2Fð¢¢F†R&VF—2†6‚Æ—fUöæWE÷F&vWC§¶6öææV7F–öä–GÖâV6‚f–VÆB—2¶W–VB'¢ ¢¢G·7–Ö&öÇ×ÂG¶–æG×ÇG·&Wg×ÆÂG¶Æ7G×Æ2G¶6öçG×ÆòG¶÷WF6öÖWÖ ¢ ¢¢‡F†R†—2Ô6'FW6–âG&—ÆR²Æ7BÖ†—2÷WF6öÖR’æB—G2fÇVRVæ6öFW2F†P¢¢FöÖ–æçBÖF—&V7F–öâF&vWC ¢ ¢¢Æöæs¤æ(i"¶VWâæWBÖÆöær†—2õTâ÷6—F–öç2–âF†—2'V6¶W@¢¢6†÷'C¤æ(i"¶VWâæWB×6†÷'B†—2õTâ÷6—F–öç2–âF†—2'V6¶W@¢¢fÆC£(i"W&fV7BÆöær÷6†÷'B6æ6VÆÆF–öã²6Æ÷6Rç’÷Vâ–â'V6¶W@¢ ¢¢F†R6öçF6ö×öæVçB—2F†RõTâ×÷6—F–öâ67V×VÆF–öâ6÷VçBW"7V0¢¢‚&6öçF–çV÷W23¢FB7GVÂæBæW‡B"÷6—F–öç2"’âV6‚&V6öæ6–ÆRF–6°¢¢Gfæ6W2F†R'V6¶WBF÷v&BâÒ6öçF÷Vâ÷6—F–öç2–âF†RæWBF—&V7F–öâà¢¢26ö×ÆWFVB÷6—F–öç26Æ÷6R÷WBVæFW"F†R'V6¶WBF†RæW‡B6ö÷&F–æF÷ ¢¢7–6ÆR&RÖWfÇVFW2F†R&WböÆ7BbvFW2†6Æ÷6VBÖöæÇ’’÷fW"F†Ræ÷rÐ¢¢Æ&vW"6ö×ÆWFVB6×ÆRæBV—F†W# ¢¢†’¶VW'V6¶WBÆ—fRB6ÖRÖvæ—GVFR(i"æòW†6†ævR÷ ¢¢†"’fÆ—÷WF6öÖR‡÷2(iBæVr’(i"6Æ÷6R²&V÷Và¢¢†2’fÆ—FöÖ–æçBF—&V7F–öâ†Æöær(iB6†÷'B’(i"6Æ÷6R²&V÷Và¢¢†B’G&÷'V6¶WBg&öÒæWBF&vWG2(i"6Æ÷6RÆÂ–â'V6¶W@¢ ¢¢&V6öæ6–Æ–F–öâ&WW6W2F†RW†—7F–ær6Æ÷6TÆ—fU÷6—F–öææ@¢¢W†V7WFTÆ—fU÷6—F–öæF‡2(	BæòæWrW†6†ævRÖ6ÆÂ7W&f6Rà¢¢ð ¢ò¢ ¢¢÷'†âÖ6Æ÷6RÆÂ÷Vâ÷6—F–öç2f÷"6öææV7F–öâF†B†fRW†6VVFVBF†P¢¢Ö‚†öÆBF–ÖRÂw&—F–ær÷'†åöæõö6öææV7F÷&÷"÷'†åöW†6†ævUöW'&÷& ¢¢2F†R6Æ÷6R&V6öââ6ÆÆVBv†VâF†RW†6†ævR6öææV7F÷"—2Væf–Æ&ÆR÷ ¢¢vWE÷6—F–öç2‚–F‡&÷w2Â6ò÷6—F–öç2&RæWfW"ÆVgB÷Vâ–â&VF—0¢¢–æFVf–æ—FVÇ’WfVâv†VâF†RW†6†ævR6ææ÷B&R&V6†VBà¢ ¢¢&Ò6öææV7F–öä–B&VF—26öææV7F–öâ”@¢¢&Ò6öææV7F÷"W†6†ævR6öææV7F÷"†çVÆÂv†VâVæf–Æ&ÆR¢¢&Ò7VÖÖ'’×WF&ÆR&V6öæ6–ÆR7VÖÖ'’Fò–æ7&VÖVçB6÷VçFW'0¢¢ð¦7–æ2gVæ7F–öâ÷'†ä6Æ÷6TW‡—&VE÷6—F–öç2€¢6öææV7F–öä–C¢7G&–ærÀ¢6öææV7F÷#¢ç’À¢òò6ÖR6†R2F†R&V6öæ6–ÆR7VÖÖ'’6òF†RgVæ7F–öâ6â&öÆÂW ¢òò7vVW7F—f—G’–çFòF†RVæv–æRÖÆWfVÂF÷FÇ2v—F†÷WBF†R6ÆÆW ¢òò†f–ærFòÖ—'&÷"6÷VçFW'2à¢7VÖÖ'“¢°¢&V6öæ6–ÆVC¢çVÖ&W ¢6Æ÷6VC¢çVÖ&W ¢W'&÷'3¢çVÖ&W ¢WFFVC¢çVÖ&W ¢&÷FV7F–öå&V&ÖVC¢çVÖ&W ¢÷'†ç57vWC¢çVÖ&W ¢ÒÀ¢“¢&öÖ—6SÇfö–Câ°¢6öç7BÔ…ô„ôÄEõD”ÔUôÕ2Ò&W6öÇfTÖ„†öÆD×2†6öææV7F–öä–B¢–b„Ô…ô„ôÄEõD”ÔUôÕ2ÃÒ’&WGW&à ¢G'’°¢6öç7BÆÄ÷VâÒv—BvWDÆ—fU÷6—F–öç2†6öææV7F–öä–B¢6öç7BW‡—&VBÒÆÄ÷Vâæf–ÇFW"‚‡’Óâ°¢–b‡ç7FGW2ÓÒ&÷Vâ"bbç7FGW2ÓÒ&f–ÆÆVB"bbç7FGW2ÓÒ''F–ÆÇ•öf–ÆÆVB"’&WGW&âfÇ6P¢–b‚—57—7FVÕG&6¶VDÆ—fU÷6—F–öâ‡Â6öææV7F–öä–B’’&WGW&âfÇ6P¢–b‚‡æW†V7WFVEVçF—G’óò’ÃÒ’&WGW&âfÇ6P¢6öç7B÷VæVDBÒæ7&VFVDBÇÂçWFFVDBÇÂ ¢&WGW&â÷VæVDBâbbFFRææ÷r‚’Ò÷VæVDBâÔ…ô„ôÄEõD”ÔUôÕ0¢Ò ¢f÷"†6öç7B÷2öbW‡—&VB’°¢7VÖÖ'’ç&V6öæ6–ÆVB²°¢6öç7B†VÆDÖ–âÒÖF‚ç&÷VæB‚„FFRææ÷r‚’Ò‡÷2æ7&VFVDBÇÂ÷2çWFFVDBÇÂ’’òc¢òò6ÖRW†—B×&–6R&W6öÇWF–öâ6†–â2&V6öæ6–ÆTÆ—fU÷6—F–öç3 ¢òòÖ&µ&–6R(i"fW&vTW†V7WF–öå&–6R(i"&VF—2Ö&¶WEöFF(i"VçG'•&–6P¢ÆWBW†—E&–6S¢çVÖ&W"ÒçVÖ&W"‡÷2æW†6†ævTFFòæÖ&µ&–6R’ÇÂ÷2æfW&vTW†V7WF–öå&–6RÇÂ ¢–b†W†—E&–6RÃÒ’°¢G'’°¢6öç7B÷'†å&VF—2ÒvWE&VF—46Æ–VçB‚¢6öç7BÖD†6‚Òv—B÷'†å&VF—2æ†vWFÆÂ†Ö&¶WDFF¶W’‡÷2ç7–Ö&öÂÂ""Â÷2æ6öææV7F–öä–BÇÂ6öææV7F–öä–B’¢6öç7BÖE&–6RÒ'6TfÆöB…7G&–ær†ÖD†6ƒòæÆ7E&–6RóòÖD†6ƒòç&–6RóòÖD†6ƒòæ6Æ÷6Róò#"’¢–b†ÖE&–6Râ’W†—E&–6RÒÖE&–6P¢Ò6F6‚²ò¢–væ÷&R¢òÐ¢Ð¢–b†W†—E&–6RÃÒ’W†—E&–6RÒ÷2æVçG'•&–6RÇÂ ¢6öç7B&V6öâÒ6öææV7F÷"ò&÷'†åöW†6†ævUöW'&÷""¢&÷'†åöæõö6öææV7F÷"  ¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò¶÷'†âÖ6Æ÷6UÒG·÷2ç7–Ö&öÇÒ†VÆBG¶†VÆDÖ–çÖÖ–âÂ6öææV7F÷#ÒG¶6öææV7F÷"ò&W'&÷""¢&Ö—76–ær'Ò(	BÖ&¶–ær6Æ÷6VFÀ¢¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢'v&æ–ær"À¢÷'†âÖ6Æ÷6RG·÷2ç7–Ö&öÇÒ††VÆBG¶†VÆDÖ–çÖÖ–âÂG·&V6öçÒ–À¢²÷6—F–öä–C¢÷2æ–BÂ†VÆDÖ–âÂW†—E&–6RÂ&V6öâÒÀ¢ ¢òò&W7BÖVff÷'B6æ6VÂ&÷FV7F–öâ÷&FW'2f—'7B†6öææV7F÷"Ö’&R'F–ÆÇ’v÷&¶–ær¢–b†6öææV7F÷"’°¢6öç7B6æ6VÇ3¢&öÖ—6SÆç“åµÒÒµÐ¢–b‡÷2ç7F÷Æ÷74÷&FW$–B’6æ6VÇ2çW6‚†6æ6VÅ&÷FV7F–öä÷&FW"†6öææV7F÷"Â÷2ç7–Ö&öÂÂ÷2ç7F÷Æ÷74÷&FW$–BÂ%7F÷Æ÷72"Â÷2æ6öææV7F–öä–B’æ6F6‚‚‚’Óâ·Ò’¢–b‡÷2çF¶U&öf—D÷&FW$–B’6æ6VÇ2çW6‚†6æ6VÅ&÷FV7F–öä÷&FW"†6öææV7F÷"Â÷2ç7–Ö&öÂÂ÷2çF¶U&öf—D÷&FW$–BÂ%F¶U&öf—B"Â÷2æ6öææV7F–öä–B’æ6F6‚‚‚’Óâ·Ò’¢–b†6æ6VÇ2æÆVæwF‚’v—B&öÖ—6RæÆÂ†6æ6VÇ2’æ6F6‚‚‚’Óâ·Ò¢òò6ÖR÷'†â×7vVWW6VB–ç6–FR6Æ÷6TÆ—fU÷6—F–öæâv—&VB†W&P¢òòFöò6òÖ‚Ö†öÆBÖW‡—&VB÷6—F–öç2Ç6òvWBF†R6†÷2×&WfVçF–öà¢òò72(	Bv—F†÷WB—BÂâ÷W&F÷"×Æ6VB&VGV6RÖöæÇ’F†BF†P¢òòVæv–æRæWfW"&V6÷&FVBv÷VÆB7W'f—fRF†R÷'†âÖ6Æ÷6R&V6W6P¢òòF†W&RvB&Ræò'’Ö–B6æ6VÆÆF–öâFòG&–vvW"F†R7vVWöâà¢6öç7B7vVW6Æ÷6U6–FS¢&'W’"Â'6VÆÂ"Ò÷2æF—&V7F–öâÓÓÒ&Æöær"ò'6VÆÂ"¢&'W’ ¢G'’°¢6öç7B7vWBÒv—B7vVW÷'†å&÷FV7F–öä÷&FW'2†6öææV7F÷"Â÷2ç7–Ö&öÂÂ7vVW6Æ÷6U6–FRÂ÷2¢7VÖÖ'’æ÷'†ç57vWB³Ò7vWBæ6æ6VÆÆV@¢Ò6F6‚²ò¢7vVW—2&W7BÖVff÷'B¢òÐ¢Ð ¢6öç7B6Æ÷6U&W7VÇBÒv—B6Æ÷6TÆ—fU÷6—F–öâ†6öææV7F–öä–BÂ÷2æ–BÂW†—E&–6RÂ6öææV7F÷"Â&V6öâ’æ6F6‚‚†W'"’Óâ°¢6öç6öÆRçv&â†G´Äôuõ$Td•‡Ò¶÷'†âÖ6Æ÷6UÒ6Æ÷6TÆ—fU÷6—F–öâf–ÆVBf÷"G·÷2æ–GÓ¦ÂW'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"’¢7VÖÖ'’æW'&÷'2²°¢&WGW&âçVÆÀ¢Ò¢–b†6Æ÷6U&W7VÇCòç7FGW2ÓÓÒ&6Æ÷6VB"’7VÖÖ'’æ6Æ÷6VB²°¢VÇ6R–b†6Æ÷6U&W7VÇB’7VÖÖ'’æW'&÷'2²°¢Ð¢Ò6F6‚†W'"’°¢6öç6öÆRçv&â†G´Äôuõ$Td•‡Ò¶÷'†âÖ6Æ÷6UÒ7vVWW'&÷#¦ÂW'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"’¢7VÖÖ'’æW'&÷'2²°¢Ð§Ð ¢ò¢ ¢¢)H)H4äôä”4ÂÄ•dR5”ä2b$T4ôä4”ÄR)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢¢6–ævÆRVçG'’×ö–çBf÷"ÄÂÆ—fR×÷6—F–öâ²W†6†ævR7–æ2v÷&²à¢ ¢¢6ÆÆVB'“ ¢¢(
"7F'E&VÇF–ÖU&ö6W76÷"†Væv–æRÖÖævW"çG2Â#×26VÆb×66†VGVÆ–ærÆö÷¢¢(
"Ö–&U'VäÆ—fU7–æ2‡&VÇF–ÖR×&ö6W76÷"çG2ÂÆVv7’F‡&÷GFÆRvFR(	BFVÆVvFW2†W&R¢¢(
"ö’ö7&öâ÷7–æ2ÖÆ—fR×÷6—F–öç2‡÷'F&ÆRW‡FW&æÂ66†VGVÆW"Âc2¢¢(
"7–æ5v—F„W†6†ævR†ÆVv7’6†–ÒÂ&VF—&V7G2†W&R¢ ¢¢&W7öç6–&–Æ—F–W2†–âöæR&VF—2ÖÆö6¶VB72“ ¢¢âÇv—2×'Vâ6–×VÆFVB×÷6—F–öâ7vVW‡W"ÖÖöFR6Æ÷6RF‚’(	B'Vç0¢¢WfVâv†Vâ6öææV7F÷"—2'6VçB÷"vÆö&ÂW6R—26WBà¢¢"âW†6†ævR÷6—F–öâfWF6‚²æ÷&ÖÆ—¦VB‡7–Ö&öÇÆF—&V7F–öâ’(i"W†6†ævU÷2Öà¢¢2âW†6†ævRÖ÷'†âF÷F–öâ†W†6†ævR÷6—F–öç2æ÷B–WBG&6¶VB–â&VF—2’à¢¢BâW"×÷6—F–öâÆö÷†÷Vâ÷Æ6VB7FGW6W2“ ¢¢âÖ&²×&–6RòÆ—×&–6RòVç&VÆ—¦VEäÂ&Vg&W6‚g&öÒW†6†ævRà¢¢"âW‡FW&æÆÇ’Ö6Æ÷6VBFWFV7F–öâ†'6VçBg&öÒW†6†ævRÖ’à¢¢2â4ÂõE&÷FV7F–öâÖ÷&FW"†VÆ–ærf–WFFU&÷FV7F–öä÷&FW'2à¢¢Bâ4ÂõE7&÷72Ö6†V6²(i"f÷&6RÖ6Æ÷6RöâÖ&¶WB†—Bà¢¢RâÖ‚Ö†öÆB×F–ÖR6fWG’6Æ÷6Rà¢¢bâ6fU÷6—F–öâ‡W'6—7B&Vg&W6†VB7FFR’à¢¢Râ&VF—26–ævÆRÖfÆ–v‡BÆö6²²7&÷72Ö6ÆÆW"FVGWf–Ö÷fVBÖÖ&¶W"¶W’à¢ ¢¢÷F–öç3 ¢¢(
"6¶—6–×VÆFVE7vVW(	B6¶—7FW†6ÆÆW"Ç&VG’&â&ö6W756–×VÆFVE÷6—F–öç2¢¢(
"6¶—÷'†äF÷F–öâ(	B6¶—7FW2†÷'†â'Vâ—2æòÖ÷v†Vâ6öææV7F÷"—2'6VçB¢¢(
"&V6öæ6–ÆTÖöFR(	BG'VRÒ7&öâ†FöW2æ÷B&WGW&âV&Ç’öâæò6öææV7F÷#°¢¢fÇ6RÒVæv–æRF–6²†V&Ç’×&WGW&â—2f–æR’’à¢¢ð¦W‡÷'B7–æ2gVæ7F–öâ&V6öæ6–ÆTÆ—fU÷6—F–öç2€¢6öææV7F–öä–C¢7G&–ærÀ¢W†6†ævT6öææV7F÷#¢ç’À¢÷F–öç3¢°¢6¶—6–×VÆFVE7vVWó¢&ööÆVà¢6¶—÷'†äF÷F–öãó¢&ööÆVà¢&V6öæ6–ÆTÖöFSó¢&ööÆVà¢ÒÒ·ÒÀ¢“¢&öÖ—6SÇ°¢&V6öæ6–ÆVC¢çVÖ&W ¢WFFVC¢çVÖ&W ¢6Æ÷6VC¢çVÖ&W ¢W'&÷'3¢çVÖ&W ¢&÷FV7F–öå&V&ÖVC¢çVÖ&W ¢÷'†ç57vWC¢çVÖ&W §Óâ°¢v—B–æ—E&VF—2‚¢6öç7B6Æ–VçBÒvWE&VF—46Æ–VçB‚¢6öç7B²6¶—6–×VÆFVE7vVWÂ6¶—÷'†äF÷F–öâÂ&V6öæ6–ÆTÖöFRÒfÇ6RÒÒ÷F–öç0¢6öç7B7VÖÖ'’Ò°¢&V6öæ6–ÆVC¢ÂWFFVC¢Â6Æ÷6VC¢ÂW'&÷'3¢Â&÷FV7F–öå&V&ÖVC¢Â÷'†ç57vWC¢À¢Ð ¢òò)H)H7&÷72Ö6ÆÆW"6–ævÆRÖfÆ–v‡BÆö6²)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òò×VÇF—ÆR6ÆÆW'2†Væv–æRF–6²²7&öâ²&W7VÖR’6â†—BF†—2gVæ7F–öâ–à¢òò&ÆÆVÂâF†R&VF—2Æö6²&WfVçG26öæ7W'&VçB×WFF–öç2öbW"×÷6—F–öà¢òò7FFRâEDÂ32—2F†R6fWG’æWBf÷"&ö6W72FVF‚Ö–B×7–æ2à¢6öç7BÄ•dUõ5”ä5ôÄô4µô´U’ÒÆ—fU÷7–æ5öÆö6³¢G¶6öææV7F–öä–GÖ ¢6öç7BÄ•dUõ5”ä5ôÄô4µõEDÂÒ3 ¢6öç7B7–æ4Æö6µFö¶VâÒ&V6öæ6–ÆS¢G·&ö6W72ç–GÓ¢G´FFRææ÷r‚—Ó¢G¶ææö–Bƒ"—Ö ¢ÆWBÆö6´7V—&VBÒfÇ6P¢ÆWB7F÷7–æ4Æö6´ÆV6U&Vg&W6ƒ¢‚‚’Óâfö–B’ÂçVÆÂÒçVÆÀ¢–b†6Æ–VçB’°¢G'’°¢Æö6´7V—&VBÒv—B†6Æ–VçBç6WB„Ä•dUõ5”ä5ôÄô4µô´U’Â7–æ4Æö6µFö¶VâÂ²åƒ¢G'VRÂUƒ¢Ä•dUõ5”ä5ôÄô4µõEDÂÒ’2ç’’ÓÓÒ$ô² ¢–b†Æö6´7V—&VB’°¢7F÷7–æ4Æö6´ÆV6U&Vg&W6‚Ò7F'E&VF—4Æö6´ÆV6U&Vg&W6‚€¢6Æ–VçBÀ¢Ä•dUõ5”ä5ôÄô4µô´U’À¢7–æ4Æö6µFö¶VâÀ¢Ä•dUõ5”ä5ôÄô4µõEDÂ¢À¢¢Ð¢Ò6F6‚²ò¢&VF—2Vç&V6†&ÆR(i"f–Â÷Vâ¢òÐ¢–b‚Æö6´7V—&VB’°¢6öç6öÆRæÆör†G´Äôuõ$Td•‡Ò·&V6öæ6–ÆUÒ6¶—(	BÆö6²†VÆBf÷"6öæãÒG¶6öææV7F–öä–GÖ¢&WGW&â7VÖÖ'¢Ð¢Ð ¢G'’°¢òò)H)H7FW¢6–×VÆFVB×÷6—F–öâ7vVW†Çv—2'Vç2VæÆW726ÆÆW"÷G2÷WB’)H ¢–b‚6¶—6–×VÆFVE7vVW’°¢G'’°¢6öç7B6–Õ&W7VÇBÒv—B&ö6W756–×VÆFVE÷6—F–öç2†6öææV7F–öä–B¢7VÖÖ'’ç&V6öæ6–ÆVB³Ò6–Õ&W7VÇBç&ö6W76V@¢7VÖÖ'’æ6Æ÷6VB³Ò6–Õ&W7VÇBæ6Æ÷6V@¢7VÖÖ'’æW'&÷'2³Ò6–Õ&W7VÇBæW'&÷'0¢Ò6F6‚²ò¢&ö6W756–×VÆFVE÷6—F–öç2—26VÆbÖFVfVç6—fR¢òÐ¢Ð ¢òòÆöBF†RWF†÷&—FF—fR&öö²&Vf÷&R66WF–ær6öææV7F÷"âF—&V7BG&FP¢òò†2â–æFWVæFVçFÇ’WF†÷&—6VBƒ"&öBÕe5BÆæRv†–ÆRF†Ræ÷&ÖÀ¢òò&ö6W7266†R&VÖ–ç2vÆö&ÆÇ’6–×VÆFVC²â÷væVBF—&V7B&÷rF†W&Vf÷&P¢òò†2Fò&R×6VÆV7BæBfW&–g’—G266÷VBÆ–fV7–6ÆR6öææV7F÷"†W&Rà¢6öç7BÆÄ÷VâÒv—BvWDÆ—fU÷6—F–öç2†6öææV7F–öä–B¢W†6†ævT6öææV7F÷"Òv—B&W6öÇfTF—&V7EG&FTÆ–fV7–6ÆT6öææV7F÷"€¢6öææV7F–öä–BÀ¢ÆÄ÷VâÀ¢W†6†ævT6öææV7F÷"À¢ ¢òòVçG'’W&Ö—76–öâæBÆ–fV7–6ÆR÷væW'6†—&R–æFWVæFVçBâGW&æ–ærWfW'¢òòÆ—fRÖVçG'’FövvÆRöfb×W7B&WfVçBæWr÷&FW'2Â'WB—B×W7Bæ÷B7F÷F†P¢òòW†6†ævR&V6öæ6–Æ–F–öâöb÷6—F–öç2F†—2&ö6W72Ç&VG’÷vç2âF†÷6P¢òò&÷w27F–ÆÂæVVBÖ&²õäÂWFFW2Â&÷FV7F–öâ†VÆ–æræBWF†÷&—FF—fP¢òòFW&Ö–æÂÖ6Æ÷6RFWFV7F–öââöæÇ’6¶—&—fFRöÆÆ–ærv†VâF†W&R—2æð¢òò6öææV7F÷"6&ÆRöbFö–ær—Bà¢6öç7BÆ—fUG&FTöâÒv—B—4Æ—fUG&FTVæ&ÆVDf÷$6öææV7F–öâ†6öææV7F–öä–B¢–b‚Æ—fUG&FTöâbb‚W†6†ævT6öææV7F÷"ÇÂG—VöbW†6†ævT6öææV7F÷"ævWE÷6—F–öç2ÓÒ&gVæ7F–öâ"’’°¢–b‚6¶—÷'†äF÷F–öâ’v—B÷'†ä6Æ÷6TW‡—&VE÷6—F–öç2†6öææV7F–öä–BÂçVÆÂÂ7VÖÖ'’¢&WGW&â7VÖÖ'¢Ð¢–b‚Æ—fUG&FTöâ’°¢6öç6öÆRæÆör†G´Äôuõ$Td•‡Ò·&V6öæ6–ÆUÒVçG'’W&Ö—76–öâ—2öfc²6öçF–çV–ærÆ–fV7–6ÆR7–æ2f÷"7—7FVÒÖ÷væVB÷6—F–öç2öæÇ–¢Ð ¢òò)H)H7FWB²g&öÒ&V6öæ6–ÆTÆ—fU÷6—F–öç2)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òòæ÷F†–ærFòFò–b6öææV7F÷"'6VçB‡6–ÒÖöæÇ’—2Ç&VG’FöæR&÷fR¢–b‚W†6†ævT6öææV7F÷"ÇÂG—VöbW†6†ævT6öææV7F÷"ævWE÷6—F–öç2ÓÒ&gVæ7F–öâ"’°¢–b‚&V6öæ6–ÆTÖöFR’&WGW&â7VÖÖ'’òò7&öâÇv—2'Vç2gVÆÂF€¢v—B÷'†ä6Æ÷6TW‡—&VE÷6—F–öç2†6öææV7F–öä–BÂçVÆÂÂ7VÖÖ'’¢&WGW&â7VÖÖ'¢Ð ¢òòF†RÆ—fR×÷6—F–öç2–æFW‚v2ÆöFVBöæ6R&÷fRf÷"6öææV7F÷"6VÆV7F–öâà¢6öç7B–çfÆ–DF—&V7F–öå÷6—F–öç3¢Æ—fU÷6—F–öåµÒÒµÐ¢6öç7B÷Vå÷6—F–öç2ÒÆÄ÷Vâæf–ÇFW"‚‡’Óâ°¢6öç7B—4÷VâÐ¢ç7FGW2ÓÓÒ&÷Vâ"ÇÀ¢ç7FGW2ÓÓÒ&f–ÆÆVB"ÇÀ¢ç7FGW2ÓÓÒ''F–ÆÇ•öf–ÆÆVB"ÇÀ¢ç7FGW2ÓÓÒ'Æ6VB"ÇÀ¢ç7FGW2ÓÓÒ'VæF–ær"ÇÀ¢ç7FGW2ÓÓÒ'VæF–æuöf–ÆÂ"ÇÀ¢ç7FGW2ÓÓÒ'Æ6VE÷Væ6öæf—&ÖVB"ÇÀ¢ç7FGW2ÓÓÒ&6Æ÷6–ær"ÇÀ¢ç7FGW2ÓÓÒ&6Æ÷6–æu÷'F–Â ¢–b‚—4÷Vâ’&WGW&âfÇ6P¢6öç7BF—&V7F–öâÒ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ‡¢–b‚F—&V7F–öâ’°¢ç7FGW5&V6öâÒ'&V6öæ6–ÆUö&Æö6¶VEö–çfÆ–EöF—&V7F–öâ ¢W6…7FW‡Â'&V6öæ6–ÆUöF—&V7F–öåöwV&B"ÂfÇ6RÂ$æòW‡Æ–6—BÆöær÷6†÷'BF—&V7F–öã²fVçVR×WFF–öç2&R&Æö6¶VB"¢–çfÆ–DF—&V7F–öå÷6—F–öç2çW6‚‡¢&WGW&âfÇ6P¢Ð¢æF—&V7F–öâÒF—&V7F–öà¢ç6–FRóóÒF—&V7F–öà¢&WGW&âG'VP¢Ò¢–b†–çfÆ–DF—&V7F–öå÷6—F–öç2æÆVæwF‚â’°¢v—B&öÖ—6RæÆÂ†–çfÆ–DF—&V7F–öå÷6—F–öç2æÖ‚‡÷6—F–öâ’Óâ6fU÷6—F–öâ‡÷6—F–öâ’æ6F6‚‚‚’Óâ·Ò’’¢7VÖÖ'’æW'&÷'2³Ò–çfÆ–DF—&V7F–öå÷6—F–öç2æÆVæwF€¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&W'&÷""À¢G¶–çfÆ–DF—&V7F–öå÷6—F–öç2æÆVæwF‡ÒÆ—fR÷6—F–öâ‡2’V&çF–æVC¢Ö—76–ærW‡Æ–6—BÆöær÷6†÷'BF—&V7F–öæÀ¢²÷6—F–öä–G3¢–çfÆ–DF—&V7F–öå÷6—F–öç2æÖ‚‡÷6—F–öâ’Óâ÷6—F–öâæ–B’ÒÀ¢’æ6F6‚‚‚’Óâ·Ò¢Ð¢–b†÷Vå÷6—F–öç2æÆVæwF‚ÓÓÒbb&V6öæ6–ÆTÖöFR’°¢6öç7B&÷FV7F–öä†ÇFVBÒv—B6Æ–VçBævWB†VçG'•&÷FV7F–öä†ÇD¶W”öb†6öææV7F–öä–B’¢–b‚&÷FV7F–öä†ÇFVB’°¢v—B÷'†ä6Æ÷6TW‡—&VE÷6—F–öç2†6öææV7F–öä–BÂW†6†ævT6öææV7F÷"Â7VÖÖ'’¢&WGW&â7VÖÖ'¢Ð¢òòâV×G’Æö6Â–æFW‚—2W†7FÇ’v†Vâ&öÆÆ&6²&V6÷fW'’æVVG2Gvð¢òòWF†÷&—FF—fRfVçVR6æ6†÷G2â&WGW&æ–ær†W&Rv÷VÆB7G&æBF†R†ÇBà¢òò6–×VÆFVBöÆVv7’6öææV7F÷'2v—F†÷WBW‡Æ–6—B6æ6†÷BWf–FVæ6R6ææ÷@¢òò&÷fRF†R&VÂ66÷VçB—2V×G’æB×W7B&WF–â—G2&÷FV7F–öâ†ÇBà¢–b‡G—VöbW†6†ævT6öææV7F÷"ævWDÆ7E÷6—F–öç56æ6†÷E7FGW2ÓÒ&gVæ7F–öâ ¢ÇÂG—VöbW†6†ævT6öææV7F÷"ævWDÆ7D÷Vä÷&FW'56æ6†÷E7FGW2ÓÒ&gVæ7F–öâ"’&WGW&â7VÖÖ'¢Ð ¢–b†Æ—fUG&FTöâÇÂ÷Vå÷6—F–öç2æÆVæwF‚â’°¢v—BÖöæ—F÷$6öææV7F–öäÖ&v–ä6ÆÂ†6öææV7F–öä–BÂW†6†ævT6öææV7F÷"Â²7F'E6W76–öã¢G'VRÒ¢Ð ¢òò6–ævÆR&F6‚fWF6‚öbÄÂW†6†ævR÷6—F–öç2f÷"F†R÷6—F–öâ×7–æ2Æö÷à¢òòW6R7–6ÆRÖÆWfVÂ66†RFòVÆ–Ö–æFRGWÆ–6FRvWE÷6—F–öç2‚’6ÆÇ2v†Và¢òò×VÇF—ÆR7–Ö&öÇ2&R&ö6W76VBâ66†REDÃÓS×2ÂW‡—&W2gFW"7–6ÆR6ö×ÆWFW2à¢ÆWBW†6†ævU÷6—F–öç3¢ç•µÒÒµÐ¢ÆWBW†6†ævU÷6—F–öç56æ6†÷Dö²ÒfÇ6P¢G'’°¢òò6†V6²66†Rf—'7BƒSR†—B&FRG—–6ÂÂ6fW23ÓCR’6ÆÇ2W"7–6ÆR¢6öç7B66†VBÒvWD66†VE÷6—F–öç2†6öææV7F–öä–B¢–b†66†VB’°¢W†6†ævU÷6—F–öç2Ò66†V@¢W†6†ævU÷6—F–öç56æ6†÷Dö²ÒG'VP¢ÒVÇ6R°¢W†6†ævU÷6—F–öç2Ò†v—BW†6†ævT6öææV7F÷"ævWE÷6—F–öç2‚’’ÇÂµÐ¢6öç7B6æ6†÷E7FGW2ÒG—VöbW†6†ævT6öææV7F÷"ævWDÆ7E÷6—F–öç56æ6†÷E7FGW2ÓÓÒ&gVæ7F–öâ ¢òW†6†ævT6öææV7F÷"ævWDÆ7E÷6—F–öç56æ6†÷E7FGW2‚¢¢²ö³¢G'VRÐ¢W†6†ævU÷6—F–öç56æ6†÷Dö²Ò6æ6†÷E7FGW2æö²ÓÓÒG'VP¢òò66†Rf÷"7V'6WVVçBvWE÷6—F–öç26ÆÇ2F†—27–6ÆP¢–b†W†6†ævU÷6—F–öç56æ6†÷Dö²’6WD66†VE÷6—F–öç2†6öææV7F–öä–BÂW†6†ævU÷6—F–öç2¢Ð¢Ò6F6‚†W'"’°¢6öç6öÆRçv&â†G´Äôuõ$Td•‡ÒvWE÷6—F–öç2f–ÆVC¦ÂW'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"’¢–b†Æ—fUG&FTöâ’°¢v—B†ÇDÆ—fTVçG&–W4f÷%6æ6†÷Df–ÇW&R€¢6öææV7F–öä–BÀ¢W†6†ævT6öææV7F÷"À¢&WF†÷&—FF—fRfVçVR÷6—F–öâ6æ6†÷B&WVW7Bf–ÆVB"À¢¢Ð¢v—B÷'†ä6Æ÷6TW‡—&VE÷6—F–öç2†6öææV7F–öä–BÂW†6†ævT6öææV7F÷"Â7VÖÖ'’¢&WGW&â7VÖÖ'¢Ð¢–b‚W†6†ævU÷6—F–öç56æ6†÷Dö²’°¢6öç6öÆRçv&â†G´Äôuõ$Td•‡ÒW†6†ævR÷6—F–öç26æ6†÷Bv2æ÷BWF†÷&—FF—fS²W‡FW&æÂÖ6Æ÷6R&ö6W76–ærFVfW'&VF¢–b†Æ—fUG&FTöâ’°¢v—B†ÇDÆ—fTVçG&–W4f÷%6æ6†÷Df–ÇW&R€¢6öææV7F–öä–BÀ¢W†6†ævT6öææV7F÷"À¢&WF†÷&—FF—fRfVçVR÷6—F–öâ6æ6†÷BVæf–Æ&ÆR"À¢¢Ð¢&WGW&â7VÖÖ'¢Ð¢–b†Æ—fUG&FTöâ’v—B6ÆV$Æ—fTVçG'”†ÇB†6öææV7F–öä–B ¢òòæ÷&ÖÆ—6R&rW†6†ævR7–Ö&öÂf÷"ÖÖ¶W’6ö×&—6öâà¢òò&–æu‚†æB6WfW&Â÷F†W"fVçVW2’&WGW&â$%D2ÕU4EB"÷"$%D5õU4EB ¢òòv†–ÆR&VF—27F÷&W2F†Ræ÷&ÖÆ—6VBf÷&Ò$%D5U4EB"â7G&—ÆÀ¢òò6W&F÷'2&Vf÷&R'V–ÆF–æròVW'––ærF†R¶W’6ò&–æu‚÷6—F–öà¢òò—2æWfW"Ö—7F¶Vâf÷"&W‡FW&æÆÇ’6Æ÷6VB"6–×Ç’&V6W6RF†R7–Ö&öÀ¢òòf÷&ÖBF–ffW'2à¢6öç7Bæ÷&Õ7–ÒÒ‡&s¢7G&–ær’Óâ&rçFõWW$66R‚’ç&WÆ6R‚õ²ÕõÒörÂ"" ¢6öç7BW†6†ævTÖÒæWrÖÇ7G&–ærÂç“â‚¢f÷"†6öç7BWöbW†6†ævU÷6—F–öç2’°¢6öç7B7–ÒÒæ÷&Õ7–Ò…7G&–ær†Wç7–Ö&öÂÇÂWå7–Ö&öÂÇÂ""’¢–b‚7–Ò’6öçF–çVP¢6öç7B6—¦RÒ'6TfÆöB…7G&–ær†Wç6—¦RóòWç÷6—F–öä×BóòWçVçF—G’óò#"’¢–b‚6—¦R’6öçF–çVP¢6öç7BF—&V7F–öâÒæ÷&ÖÆ—¦TW†6†ævU÷6—F–öäF—&V7F–öâ†Wç÷6—F–öå6–FRÂWç6–FRÂ6—¦R¢–b‚F—&V7F–öâ’°¢6öç6öÆRçv&â†G´Äôuõ$Td•‡Ò·&V6öæ6–ÆUÒ6¶—VBW†6†ævR÷6—F–öâG·7–×Ó¢F—&V7F–öâ—2æ÷BWF†÷&—FF—fV¢7VÖÖ'’æW'&÷'2²°¢6öçF–çVP¢Ð¢W†6†ævTÖç6WB†G·7–××ÂG¶F—&V7F–öçÖÂW¢Ð¢òò)H)Höæ6R×W"×F–6²fVçVR÷VâÖ÷&FW'26æ6†÷B)H)H)H)HûûÞûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞûûÐ¢òòW6VB'’WFFU&÷FV7F–öä÷&FW'6FòFWFV7B6–ÆVçFÇ’ÖvöæR4ÂõE ¢òò†f–ÆÆVBÂW‡FW&æÆÇ’6æ6VÆÆVBÂW‡—&VBÂ7vVW’âöæRvWD÷Vä÷&FW'6 ¢òò6ÆÂÖ÷'F—¦VB7&÷72WfW'’÷6—F–öâ–âF†R&V6öæ6–ÆR7vVWÂg2à¢òò"9rvWD÷&FW"‚’6ÆÇ2W"÷6—F–öâF†RÇFW&æF—fRv÷VÆB&WV—&Rà¢òòçVÆÆÖVç2'6¶—fW&–f–6F–öâF†—2F–6²#²F†RæW‡BF–6²&WG&–W2à¢6öç7BÆ—fT÷&FW$–G2Òv—BfWF6„Æ—fT÷&FW$–E6WB†W†6†ævT6öææV7F÷"¢òò&Wf–÷W2&W7öç6RÖÆ÷7BVçG'’6âÆVfRF†R6öææV7F–öâ×v–FP¢òòVçG'’×&÷FV7F–öâ†ÇB7F–6·’WfVâgFW"—G2&÷rv26fVÇ’&WF—&VBâFð¢òòæ÷B6ÆV"—BöâöæR&W7öç6S¢&WV—&RGvòg&W6‚Â–FVçF–6ÂÀ¢òòWF†÷&—FF—fR÷6—F–öâ²÷VâÖ÷&FW"6æ6†÷G2v—F‚æò5E2Ö÷væVBÆö6À¢òò&÷w2÷"6Æ–VçBÖ÷&FW"–G2âf÷&V–vâ66÷VçBW‡÷7W&R—2FVÆ–&W&FVÇ’æ÷@¢òòG&VFVB25E2÷væW'6†—æB—2æWfW"×WFFVB'’F†—2&V6÷fW'’F‚à¢v—B&V6öæ6–ÆTV×G”&ööµ&÷FV7F–öä†ÇB‡°¢6öææV7F–öä–BÀ¢Æö6Ä÷Vå÷6—F–öç3¢²ââæ÷Vå÷6—F–öç2Âââæ–çfÆ–DF—&V7F–öå÷6—F–öç5Òæf–ÇFW"‚‡÷6—F–öâ’Óà¢—4W†6†ævTÆ–fV7–6ÆU÷6—F–öâ‡÷6—F–öâÂ6öææV7F–öä–B’À¢’À¢fVçVU÷6—F–öç3¢W†6†ævU÷6—F–öç2À¢Æ—fT÷&FW$–G2À¢Ò’æ6F6‚‚†W'&÷"’Óâ°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡ÒV×G’Ö&öö²&÷FV7F–öâÖ†ÇB&V6öæ6–Æ–F–öâFVfW'&VC¦À¢W'&÷"–ç7Fæ6VöbW'&÷"òW'&÷"æÖW76vR¢7G&–ær†W'&÷"’À¢¢Ò¢6öç7Bvw&VvFU&÷FV7F–öâÒv—B&V6öæ6–ÆTvw&VvFU&÷FV7F–öä&öö²€¢6öææV7F–öä–BÀ¢W†6†ævT6öææV7F÷"À¢÷Vå÷6—F–öç2À¢W†6†ævU÷6—F–öç2À¢Æ—fT÷&FW$–G2À¢¢7VÖÖ'’ç&÷FV7F–öå&V&ÖVB³Òvw&VvFU&÷FV7F–öâç&V&ÖVDÆVFW'0¢7VÖÖ'’æ6Æ÷6VB³Òvw&VvFU&÷FV7F–öâæ6Æ÷6VDÖVÖ&W$–G2ç6—¦P ¢òò)H)HW"×÷6—F–öâv÷&¶W"‡&ÆÆVÆ—6&ÆR’)H)H)H)H)H)H)H)H)HûûÞûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òòV6‚—FW&F–öâ—2–æFWVæFVçBBF†RfVçVR²&VF—2Æ–W# ¢òò(
"&VF—2w&—FW2&R66÷VBFòÆ—fS§÷6—F–öç3§¶6öæçÓ§¶–GÖæ@¢òòF†RW"×7–Ö&öÂÖF—&V7F–öâÆö6²¶W’(	BæòGvò÷6—F–öç26†&P¢òòF†VÒà¢òò(
"W†6†ævR6ÆÇ2&RW"Ò‡7–Ö&öÂÂF—&V7F–öâ’æBF†RfVçVP¢òò6W&–Æ—6W2—G2÷vâW"×7–Ö&öÂw&—FW2à¢òò(
"F†R–FV×÷FVçBÖ÷fVC§¶–GÖÖ&¶W"&WfVçG2F†R6Æ÷6RÖ6÷VçFW ¢òòG&–gBF†R÷W&F÷"&W÷'FVBWfVâVæFW"–çFW&ÆVfVBW†V7WF–öâà¢òò6òvR6âfâF†RÆö÷&öG’÷WBv—F‚&÷VæFVB6öæ7W'&Væ7’â&WGW&ç0¢òòF–ç’W"×÷6—F–öâFVÇFF†BF†R6ÆÆW"föÆG2–çFò7VÖÖ'–à¢G—R÷4FVÇFÒ°¢&V6öæ6–ÆVC¢çVÖ&W ¢WFFVC¢çVÖ&W ¢6Æ÷6VC¢çVÖ&W ¢W'&÷'3¢çVÖ&W ¢&÷FV7F–öå&V&ÖVC¢çVÖ&W ¢Ð¢òò)H)H6æöæ–6Â×÷6—F–öâ×W"×6Æ÷B&W6öÇWF–öâ„%TrB’)H)H)H)H)H)H)H)HûûÞûûÞ)H)H)H)H)H)H)H ¢òòF†RfVçVR†öÆG2W†7FÇ’ôäR÷6—F–öâW"‡7–Ö&öÂÂF—&V7F–öâ’â–`¢òò&VF—2G&6·2Ö÷&RF†âöæR÷Vâ÷6—F–öâf÷"F†R6ÖR6Æ÷@¢òò†Æö6²ÖW‡—'’VFvRÂ&W7F'BÖ–BÖVçG'’Â÷"Ö–w&FVBÆVv7’FF’À¢òòF†W’ÄÂÖFòF†R6ÖRW†6†ævR÷6—F–öââ&V6öæ6–Æ–ærV6‚öæP¢òò–æFWVæFVçFÇ’v÷VÆB†’&ÒGWÆ–6FR4ÂõE÷&FW'2v–ç7BöæP¢òòfVçVR÷6—F–öâæB†"’v†VâF†BfVçVR÷6—F–öâ6Æ÷6W2Â6÷VçBöæP¢òò&VÂ6Æ÷6RâF–ÖW2(	BF†R6Æ÷6RÖ6÷VçFW"G&–gBF†R÷W&F÷"&W÷'FVBà¢òð¢òò&W6öÇfR6–ævÆR4äôä”4Â÷6—F–öâ–BW"6Æ÷BWÖg&öçBâF†R6†ö–6P¢òò—27F&ÆRæB÷&FW"Ö–æFWVæFVçB‡6òF†R&ÆÆVÂööÂ&VÆ÷r—0¢òòFWFW&Ö–æ—7F–2“¢&VfW"7—7FVÒÖ÷væVB÷6—F–öâ††2÷&FW$–B’ÂF†Và¢òòF†RöæR7GVÆÇ’f–ÆÆVB†Æ&vW7BW†V7WFVEVçF—G’’ÂF†VâF†RöÆFW7@¢òò7&VFVDBâæöâÖ6æöæ–6ÂGWÆ–6FW2&R&Vg&W6†VBf÷"F†RF6†&ö&@¢òò'WBæWfW"G&—fR4ÂõE&Ö–ærÂf÷&6RÖ6Æ÷6RÂ÷"6Æ÷6R6÷VçFW'2à¢6öç7B6æöæ–6Ä–D'•6Æ÷BÒæWrÖÇ7G&–ærÂ7G&–æsâ‚¢6öç7BW†V7WF–öå6Æ÷G4'•‡—6–6Å6Æ÷BÒæWrÖÇ7G&–ærÂ6WCÇ7G&–æsãâ‚¢°¢6öç7B'•6Æ÷BÒæWrÖÇ7G&–ærÂG—Vöb÷Vå÷6—F–öç3â‚¢f÷"†6öç7Böb÷Vå÷6—F–öç2’°¢6öç7B‡—6–6Å6Æ÷BÒG¶æ÷&Õ7–Ò‡ç7–Ö&öÂ—×ÂG·æF—&V7F–öçÖ ¢6öç7BW†V7WF–öå6Æ÷BÒÆ—fTW†V7WF–öå6Æ÷B‡¢6öç7B6Æ÷BÒG·‡—6–6Å6Æ÷G×ÂG¶W†V7WF–öå6Æ÷GÖ ¢6öç7B6Æ÷G2ÒW†V7WF–öå6Æ÷G4'•‡—6–6Å6Æ÷BævWB‡‡—6–6Å6Æ÷B’óòæWr6WCÇ7G&–æsâ‚¢6Æ÷G2æFB†W†V7WF–öå6Æ÷B¢W†V7WF–öå6Æ÷G4'•‡—6–6Å6Æ÷Bç6WB‡‡—6–6Å6Æ÷BÂ6Æ÷G2¢6öç7B'"Ò'•6Æ÷BævWB‡6Æ÷B¢–b†'"’'"çW6‚‡“²VÇ6R'•6Æ÷Bç6WB‡6Æ÷BÂ·Ò¢Ð¢f÷"†6öç7B·6Æ÷BÂw&÷WÒöb'•6Æ÷B’°¢–b†w&÷WæÆVæwF‚ÓÓÒ’²6æöæ–6Ä–D'•6Æ÷Bç6WB‡6Æ÷BÂw&÷W³Òæ–B“²6öçF–çVRÐ¢6öç7B&æ¶VBÒ²ââæw&÷WÒç6÷'B‚†Â"’Óâ°¢6öç7BòÒæ÷&FW$–Bò¢Â&òÒ"æ÷&FW$–Bò¢ ¢–b†òÓÒ&ò’&WGW&â&òÒð¢6öç7BÒæW†V7WFVEVçF—G’ÇÂÂ'Ò"æW†V7WFVEVçF—G’ÇÂ ¢–b†ÓÒ'’&WGW&â'Ò¢&WGW&â†æ7&VFVDBÇÂ’Ò†"æ7&VFVDBÇÂ¢Ò¢6æöæ–6Ä–D'•6Æ÷Bç6WB‡6Æ÷BÂ&æ¶VE³Òæ–B¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò·&V6öæ6–ÆUÒ6Æ÷BG·6Æ÷GÒ†2G¶w&÷WæÆVæwF‡Ò÷Vâ&VF—2÷6—F–öç2(	B°¢6æöæ–6ÃÒG·&æ¶VE³Òæ–GÓ²÷F†W'2'VæVB÷&Vg&W6†VBv—F†÷WB6Æ÷6RÖ6÷VçBæÀ¢¢Ð¢Ð ¢òò$D4„”äs¢6öÆÆV7B÷6—F–öç2Fò6fR–ç7FVBöb6f–ær–æF—f–GVÆÇ¢6öç7B÷6—F–öç5Fõ6fS¢G—Vöb÷Vå÷6—F–öç2ÒµÐ ¢6öç7B&ö6W74öæRÒ7–æ2‡÷3¢G—Vöb÷Vå÷6—F–öç5¶çVÖ&W%Ò“¢&öÖ—6SÅ÷4FVÇFâÓâ°¢6öç7BFVÇF¢÷4FVÇFÒ²&V6öæ6–ÆVC¢ÂWFFVC¢Â6Æ÷6VC¢ÂW'&÷'3¢Â&÷FV7F–öå&V&ÖVC¢Ð¢–b†vw&VvFU&÷FV7F–öâçVæF–æt6öçG&öÅ6Æ÷G3òæ†2†vw&VvFU&÷FV7F–öå6Æ÷B‡÷2ç7–Ö&öÂÂ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ‡÷2’’’’&WGW&âFVÇF¢–b†vw&VvFU&÷FV7F–öâæ6Æ÷6VDÖVÖ&W$–G2æ†2‡÷2æ–B’’°¢òòF†Rvw&VvFR72Ç&VG’Ö÷fVBF†—27WW'6VFVB6WB&÷rFòF†P¢òòFW&Ö–æÂ&6†—fRâæWfW"ÆWBF†R7FÆR–âÖÖVÖ÷'’6æ6†÷B&V–ç6W'B—@¢òò–çFòF†R÷Vâ–æFW‚ÆFW"–âF†—26ÖR7–æ27–6ÆRà¢FVÇFç&V6öæ6–ÆVBÒ ¢&WGW&âFVÇF¢Ð¢G'’°¢6öç7BÖ¶W’ÒG¶æ÷&Õ7–Ò‡÷2ç7–Ö&öÂ—×ÂG·÷2æF—&V7F–öçÖ ¢6öç7BÆöv–6Å6Æ÷D¶W’ÒG¶Ö¶W—×ÂG¶Æ—fTW†V7WF–öå6Æ÷B‡÷2—Ö ¢6öç7BW…÷2ÒW†6†ævTÖævWB†Ö¶W’ ¢òò)H)HæöâÖ6æöæ–6ÂGWÆ–6FRf÷"F†—2fVçVR6Æ÷B„%TrB’)H)H)H)H)H)H)H)H)H ¢òòæWfW"G&—fR4ÂõEÂf÷&6RÖ6Æ÷6RÂ÷"6Æ÷6R6÷VçFW'2‡v÷VÆBF÷V&ÆRÐ¢òò6÷VçBöæRfVçVR÷6—F–öâ’â§W7B¶VWF†RF6†&ö&BÖ&²õäÂg&W6€¢òòv†VâF†R6Æ÷B—2Æ—fRÂ÷"'VæRF†R†çFöÒ&VF—2&V6÷&Bv†VâF†P¢òòfVçVR6Æ÷B—2V×G’(	Bv—F†÷WB–æ7&VÖVçF–ærF†R6Æ÷6R6÷VçFW"Â6ð¢òòF†R6æöæ–6Â&V6÷&BÆöæR÷vç2F†R6–ævÆR&VÂ6Æ÷6Rà¢–b†6æöæ–6Ä–D'•6Æ÷BævWB†Æöv–6Å6Æ÷D¶W’’ÓÒ÷2æ–B’°¢–b†W…÷2’°¢6öç7BÕÒ'6U&VF—4f–æ—FTçVÖ&W"†W…÷2æÖ&µ&–6RóòW…÷2æ–æFW…&–6RóòW…÷2æÆ7E&–6R¢6öç7BUÒ'6U&VF—4f–æ—FTçVÖ&W"†W…÷2çVç&VÆ—¦VE&öf—BóòW…÷2çVç&VÆ—6VEæÂóòW…÷2çVç&VÆ—¦VEæÂ¢÷2æW†6†ævTFFÒ°¢ââç÷2æW†6†ævTFFÀ¢Ö&µ&–6S¢ÕbbÕâòÕ¢÷2æW†6†ævTFFòæÖ&µ&–6RÀ¢Vç&VÆ—¦VEäÃ¢Uóò÷2æW†6†ævTFFòçVç&VÆ—¦VEäÂÀ¢7–æ6VDC¢FFRææ÷r‚’À¢Ð¢÷2çWFFVDBÒFFRææ÷r‚¢÷6—F–öç5Fõ6fRçW6‚‡÷2’òò$D4ƒ¢6öÆÆV7B–ç7FVBöb6fR–ÖÖVF–FVÇ¢FVÇFçWFFVB²°¢ÒVÇ6R°¢÷2ç7FGW2Ò&6Æ÷6VB ¢÷2æ6Æ÷6VDBÒFFRææ÷r‚¢÷2æ6Æ÷6U&V6öâÒ&GWÆ–6FU÷6Æ÷E÷'VæVB ¢÷2çWFFVDBÒFFRææ÷r‚¢òò6fU÷6—F–öâ‚’Ö÷fW2—Bg&öÒF†R÷Vâ–æFW‚FòF†R6Æ÷6VB&6†—fP¢÷6—F–öç5Fõ6fRçW6‚‡÷2’òò$D4ƒ¢6öÆÆV7B–ç7FVBöb6fR–ÖÖVF–FVÇ¢FVÇFçWFFVB²°¢Ð¢&WGW&âFVÇF¢Ð ¢òò7&6‚×&V6÷fW'’7FFS¢F†R&–÷"v÷&¶W"GW&&Ç’G&ç6—F–öæVBF†—0¢òò÷6—F–öâFò6Æ÷6–æv&Vf÷&R—G2fVçVR&WVW7BÂF†VâF—6V&VBà¢òòv—BöæÇ’f÷"F†R6†÷'BFö¶VâÖÆö6²ÆV6S²gFW'v&G2&R×&VBF†P¢òòWF†÷&—FF—fRfVçVR6æ6†÷BæBf–æ—6‚F†R6ÖR–FV×÷FVçB6Æ÷6Rà¢–b‡÷2ç7FGW2ÓÓÒ&6Æ÷6–ær"ÇÂ÷2ç7FGW2ÓÓÒ&6Æ÷6–æu÷'F–Â"’°¢6öç7BÆö6¶VDBÒçVÖ&W"‡÷2æÆö6¶VDBÇÂ¢–b†Æö6¶VDBâbbFFRææ÷r‚’ÒÆö6¶VDBÃÒõ4•D”ôåôÕUDD”ôåôÄô4µõEDÅôÕ2²ó’°¢&WGW&âFVÇF¢Ð¢–b‚W…÷2bb&V6÷&DW†6†ævT'6Væ6R‡÷2’’&WGW&âFVÇF¢6öç7BW†—E&–6RÒçVÖ&W"€¢†W…÷22ç’“òæÖ&µ&–6Róð¢†W…÷22ç’“òæÆ7E&–6Róð¢÷2æW†6†ævTFFòæÖ&µ&–6Róð¢÷2æfW&vTW†V7WF–öå&–6Róð¢÷2æVçG'•&–6Róð¢À¢¢6öç7B&V6÷fW&VBÒv—B6Æ÷6TÆ—fU÷6—F–öâ€¢6öææV7F–öä–BÀ¢÷2æ–BÀ¢W†—E&–6RÀ¢W…÷2òW†6†ævT6öææV7F÷"¢çVÆÂÀ¢W…÷2ò&7&6…÷&V6÷fW'•÷VæF–æuö6Æ÷6R"¢&W†6†ævUöW‡FW&æÆÇ•ö6Æ÷6VB"À¢¢–b‡&V6÷fW&VCòç7FGW2ÓÓÒ&6Æ÷6VB"’FVÇFæ6Æ÷6VB²°¢VÇ6R–b‡&V6÷fW&VB’FVÇFçWFFVB²°¢&WGW&âFVÇF¢Ð ¢–b†W…÷2’°¢6ÆV$W†6†ævT'6Væ6R‡÷2¢6öç7BÖ&µ&–6RÒ'6U&VF—4f–æ—FTçVÖ&W"†W…÷2æÖ&µ&–6RóòW…÷2æ–æFW…&–6RóòW…÷2æÆ7E&–6R¢6öç7BÆ—&–6RÒ'6U&VF—4f–æ—FTçVÖ&W"†W…÷2æÆ—V–FF–öå&–6RóòW…÷2æÆ—&–6R¢6öç7BUæÂÒ'6U&VF—4f–æ—FTçVÖ&W"†W…÷2çVç&VÆ—¦VE&öf—BóòW…÷2çVç&VÆ—6VEæÂóòW…÷2çVç&VÆ—¦VEæÂ¢6öç7BWF†÷&—FF—fU6—¦RÒÖF‚æ'2‡'6TfÆöB…7G&–ær†W…÷2ç6—¦RóòW…÷2ç÷6—F–öä×BóòW…÷2çVçF—G’óò#"’’’ÇÂ ¢6öç7BWF†÷&—FF—fTVçG'’Ò'6TfÆöB…7G&–ær†W…÷2æVçG'•&–6RóòW…÷2æfu&–6Róò#"’’ÇÂ  ¢&W—$Æ—fTVçG'•&–6TFöÖ–â‡÷2ÂWF†÷&—FF—fTVçG'’ ¢÷2æW†6†ævTFFÒ°¢ââç÷2æW†6†ævTFFÀ¢Ö&µ&–6S¢Ö&µ&–6RbbÖ&µ&–6RâòÖ&µ&–6R¢÷2æW†6†ævTFFòæÖ&µ&–6RÀ¢Æ—V–FF–öå&–6S¢Æ—&–6RbbÆ—&–6RâòÆ—&–6R¢÷2æW†6†ævTFFòæÆ—V–FF–öå&–6RÀ¢Vç&VÆ—¦VEäÃ¢UæÂóò÷2æW†6†ævTFFòçVç&VÆ—¦VEäÂÀ¢7–æ6VDC¢FFRææ÷r‚’À¢Ð¢÷2çWFFVDBÒFFRææ÷r‚¢6öç7B&ÆÆVÄW†V7WF–öäÆæW2Ò†W†V7WF–öå6Æ÷G4'•‡—6–6Å6Æ÷BævWB†Ö¶W’“òç6—¦RÇÂ’â¢–b‚&ÆÆVÄW†V7WF–öäÆæW2’°¢v—B&V6öæ6–ÆTWF†÷&—FF—fTW†6†ævUVçF—G’‡÷2ÂWF†÷&—FF—fU6—¦RÂWF†÷&—FF—fTVçG'’¢Ð¢÷2ç7V&Ö—76–öä'6VçD6öæf—&ÖF–öç2Ò ¢–b‚÷2æ÷&FW$–Bbb÷2ç7V&Ö—76–öå7FFRÓÓÒ'Væ6öæf—&ÖVB"’°¢6öç7B6Æ–VçD÷&FW$–BÒvWEG&6¶VD6Æ–VçD÷&FW$–B‡÷2Â&VçG'’"¢–b†6Æ–VçD÷&FW$–B’°¢6öç7B&V6÷fW&VBÒv—B&V6÷fW$VçG'”÷&FW$'”6Æ–VçD–B†W†6†ævT6öææV7F÷"Â÷2ç7–Ö&öÂÂ6Æ–VçD÷&FW$–B¢–b‡&V6÷fW&VB’°¢÷2æ÷&FW$–BÒ7G&–ær‡&V6÷fW&VBæ÷&FW$–BÇÂ&V6÷fW&VBæ–B¢÷2ç7V&Ö—76–öå7FFRÒ&6öæf—&ÖVB ¢W6…7FW‡÷2Â&VçG'•÷7V&Ö—76–öå÷&V6÷fW&VB"ÂG'VRÂ÷&FW$–CÒG·÷2æ÷&FW$–GÒ6Æ–VçD÷&FW$–CÒG¶6Æ–VçD÷&FW$–GÖ¢Ð¢Ð¢Ð ¢òò)H)HVçG'’Ö÷&FW"f–ÆÂFWFV7F–öâ‡&V6öæ6–ÆRF‚’)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞûûÞ)H)H ¢ÆWB§W7Df–ÆÆVBÒfÇ6P¢–b‡÷2ç7FGW2ÓÓÒ'Æ6VB"ÇÂ÷2ç7FGW2ÓÓÒ'VæF–æuöf–ÆÂ"ÇÂ÷2ç7FGW2ÓÓÒ'Æ6VE÷Væ6öæf—&ÖVB"’°¢6öç7BW…6—¦RÒÖF‚æ'2‡'6TfÆöB…7G&–ær†W…÷2ç6—¦RóòW…÷2ç÷6—F–öä×BóòW…÷2çVçF—G’óò#"’’’ÇÂ ¢6öç7BW„VçG'’Ò'6TfÆöB…7G&–ær†W…÷2æVçG'•&–6RóòW…÷2æfu&–6Róò#"’’ÇÂ ¢–b†W…6—¦RâbbW„VçG'’âbb&ÆÆVÄW†V7WF–öäÆæW2’°¢–b‡÷2æW†V7WFVEVçF—G’ÃÒ’°¢÷2æW†V7WFVEVçF—G’ÒW…6—¦P¢÷2ç&VÖ–æ–æuVçF—G’ÒÖF‚æÖ‚ƒÂçVÖ&W"‡÷2çVçF—G’ÇÂW…6—¦R’ÒW…6—¦R¢÷2æfW&vTW†V7WF–öå&–6RÒW„VçG'¢Ð¢&V6öæ6–ÆT–æ—F–ÄVçG'”&6UVçF—G’‡÷2ÂW…6—¦R¢÷2ç7FGW2Ò&÷Vâ ¢÷2ç7FGW5&V6öâÒ6öæf—&ÖVE÷÷6—F–öåöfÆÆ&6³¢&V6öæ6–ÆR6rW†6†ævR÷6—F–öâ6—¦SÒG¶W…6—¦WÒfsÒG·÷2æfW&vTW†V7WF–öå&–6WÖ ¢W6…7FW‡÷2Â'&V6öæ6–ÆUöf–ÆÅöFWFV7FVB"ÂG'VRÂ÷2ç7FGW5&V6öâ¢÷2çWFFVDBÒFFRææ÷r‚¢§W7Df–ÆÆVBÒG'VP¢v—B&V6÷&Df–ÆÄ6÷VçFW'4öæ6R†6öææV7F–öä–BÂ÷2Â÷2ç7–Ö&öÂÂ÷2æF—&V7F–öâ¢Ð ¢–b‡÷2æ÷&FW$–B’°¢G'’°¢6öç7B÷&FW"Òv—BW†6†ævT6öææV7F÷"ævWD÷&FW"‡÷2ç7–Ö&öÂÂ÷2æ÷&FW$–B¢6öç7B7FGW4Æ÷vW"Ò7G&–ær†÷&FW#òç7FGW2óò""’çFôÆ÷vW$66R‚¢6öç7B÷&FW$f–ÆÆVEG’Ò'6TfÆöB…7G&–ær†÷&FW#òæf–ÆÆVEG’óò÷&FW#òæW†V7WFVEG’óò#"’’ÇÂ ¢6öç7B÷&FW$f–ÆÆVE&–6RÒ'6TfÆöB…7G&–ær†÷&FW#òæf–ÆÆVE&–6Róò÷&FW#òæfu&–6Róò#"’’ÇÂ ¢–b†÷&FW"bb÷&FW$f–ÆÆVEG’âbb÷&FW$f–ÆÆVE&–6Râbb‡7FGW4Æ÷vW"ÓÓÒ&f–ÆÆVB"ÇÂ7FGW4Æ÷vW"ÓÓÒ''F–ÆÇ•öf–ÆÆVB"ÇÂ÷&FW$f–ÆÆVEG’â’’°¢–b†÷&FW$f–ÆÆVEG’â’°¢÷2æW†V7WFVEVçF—G’Ò÷&FW$f–ÆÆVEG¢÷2ç&VÖ–æ–æuVçF—G’ÒÖF‚æÖ‚ƒÂ÷2çVçF—G’Ò÷2æW†V7WFVEVçF—G’¢÷2æfW&vTW†V7WF–öå&–6RÒ÷&FW$f–ÆÆVE&–6P¢&V6öæ6–ÆT–æ—F–ÄVçG'”&6UVçF—G’‡÷2Â÷&FW$f–ÆÆVEG’¢Ð¢÷2ç7FGW2Ò&÷Vâ ¢÷2ç7FGW5&V6öâÒ6öæf—&ÖVEöf–ÆÃ¢&V6öæ6–ÆR÷&FW"7FGW3ÒG·7FGW4Æ÷vW'ÒG“ÒG·÷2æW†V7WFVEVçF—G—Ö ¢W6…7FW‡÷2Â'&V6öæ6–ÆUöf–ÆÅöFWFV7FVB"ÂG'VRÂ÷2ç7FGW5&V6öâ¢÷2çWFFVDBÒFFRææ÷r‚¢–b‚§W7Df–ÆÆVB’°¢§W7Df–ÆÆVBÒG'VP¢v—B&V6÷&Df–ÆÄ6÷VçFW'4öæ6R†6öææV7F–öä–BÂ÷2Â÷2ç7–Ö&öÂÂ÷2æF—&V7F–öâ¢Ð¢ÒVÇ6R–b‡7FGW4Æ÷vW"ÓÓÒ&6æ6VÆÆVB"ÇÂ7FGW4Æ÷vW"ÓÓÒ&6æ6VÆVB"ÇÂ7FGW4Æ÷vW"ÓÓÒ'&V¦V7FVB"’°¢÷2ç7FGW2Ò'&V¦V7FVB ¢÷2æ6Æ÷6U&V6öâÒVçG'•ö÷&FW%òG·7FGW4Æ÷vW'Ö ¢÷2æ6Æ÷6VDBÒFFRææ÷r‚¢÷2çWFFVDBÒFFRææ÷r‚¢v—B6fU÷6—F–öâ‡÷2¢FVÇFçWFFVB²°¢&WGW&âFVÇF¢Ð¢Ò6F6‚°¢ò¢vWD÷&FW"‚’Ö’f–ÂG&ç6–VçFÇ’(	BÆ–W"&W7VÇB7FæG2¢ð¢Ð¢Ð¢Ð ¢–b‡÷2ç7FGW2ÓÓÒ'Æ6VB"ÇÂ÷2ç7FGW2ÓÓÒ'VæF–æuöf–ÆÂ"ÇÂ÷2ç7FGW2ÓÓÒ'Æ6VE÷Væ6öæf—&ÖVB"’°¢v—B6fU÷6—F–öâ‡÷2¢FVÇFçWFFVB²°¢&WGW&âFVÇF¢Ð ¢òò)H)H÷væW'6†—wV&B)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞûûÞûûÞûûÞ)H)H)H)H)HûûÞûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òòöæÇ’&Ò4ÂõEæB—77VRf÷&6RÖ6Æ÷6W2öâ÷6—F–öç2F†B6''¢òò7—7FVÒ÷&FW$–BûûÞûûÞûûÒ&ööbtRÆ6VBF†RVçG'’÷&FW"à¢òò–b÷&FW$–B—2'6VçBÂF†RW†6†ævR÷6—F–öâBF†—0¢òò7–Ö&öÂ¶F—&V7F–öâÖ’†fR&VVâ÷VæVBÖçVÆÇ’'’F†R÷W&F÷ ¢òò÷"'’æ÷F†W"7—7FVÒâvR×W7Bæ÷B&Ò&VGV6RÖöæÇ’÷&FW'2÷ ¢òò6Æ÷6R—BâvR7F–ÆÂ6fRF†R&Vg&W6†VBÖ&µ&–6RõäÂ6òF†P¢òòF6†&ö&B&VfÆV7G27W'&VçBVç&VÆ—6VBäÂ67W&FVÇ’à¢–b‚÷2æ÷&FW$–B’°¢v—B6fU÷6—F–öâ‡÷2¢FVÇFçWFFVB²°¢&WGW&âFVÇF¢Ð ¢òòV6‚&÷rw2W†7B×VçF—G’fVçVR4ÂõEæBF†R6Æ÷Bw26W&FP¢òògVÆÂ×6Æ÷B6V7W&—G’7F÷vW&R6ö÷&F–æFVB&÷fRâW"×÷6—F–öà¢òòÆ–fV7–6ÆR6†V6·2&VÖ–â–æFWVæFVçBæBÖ’7F–ÆÂ—77VR7—7FVÒ6Æ÷6Rà ¢6öç7B7&÷76VBÒv—B6†V6´æDf÷&6T6Æ÷6Töå6ÇG7&÷72€¢6öææV7F–öä–BÀ¢÷2À¢Ö&µ&–6RóòÀ¢W†6†ævT6öææV7F÷"À¢¢–b†7&÷76VB’°¢–b†7&÷76VBÓÒ&6Æ÷6U÷Væ6öæf—&ÖVB"’FVÇFæ6Æ÷6VB²°¢VÇ6RFVÇFçWFFVB²°¢&WGW&âFVÇF¢Ð ¢òò)H)HÖ‚Ö†öÆB×F–ÖR6fWG’6Æ÷6W"‡&V6öæ6–ÆRF‚’)H)H)H)H)H)H)H)H)H)H)H)H ¢6öç7BÔ…ô„ôÄEõD”ÔUôÕ2Ò&W6öÇfTÖ„†öÆD×2†6öææV7F–öä–B¢6öç7B÷VæVDBÒ÷2æ7&VFVDBÇÂ÷2çWFFVDBÇÂ ¢6öç7B†VÆD×2ÒFFRææ÷r‚’Ò÷VæVD@¢–b€¢Ô…ô„ôÄEõD”ÔUôÕ2âb`¢†VÆD×2âÔ…ô„ôÄEõD”ÔUôÕ2b`¢÷2æW†V7WFVEVçF—G’âb`¢—57—7FVÕG&6¶VDÆ—fU÷6—F–öâ‡÷2Â6öææV7F–öä–B’b`¢‡÷2ç7FGW2ÓÓÒ&÷Vâ"ÇÂ÷2ç7FGW2ÓÓÒ&f–ÆÆVB"¢’°¢6öç7BW†—E&–6RÒÖ&µ&–6RÇÂ÷2æfW&vTW†V7WF–öå&–6RÇÂ÷2æVçG'•&–6P¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò·&V6öæ6–ÆUÒÔ‚„ôÄBD”ÔRW†6VVFVBf÷"G·÷2ç7–Ö&öÇÒ††VÆBG´ÖF‚ç&÷VæB††VÆD×2òc—ÖÖ–â’(	Bf÷&6RÖ6Æ÷6–ævÀ¢¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢'v&æ–ær"À¢Ö‚†öÆBF–ÖRW†6VVFVBf÷"G·÷2ç7–Ö&öÇÒ(	Bf÷&6RÖ6Æ÷6–ær‡&V6öæ6–ÆR–À¢²÷6—F–öä–C¢÷2æ–BÂ†VÆD×2ÂÖ„†öÆD×3¢Ô…ô„ôÄEõD”ÔUôÕ2ÂW†—E&–6RÒÀ¢¢6öç7B6Æ÷6U&W7VÇBÒv—B6Æ÷6TÆ—fU÷6—F–öâ€¢6öææV7F–öä–BÀ¢÷2æ–BÀ¢W†—E&–6RÀ¢W†6†ævT6öææV7F÷"À¢&Ö…ö†öÆE÷F–ÖUöW†6VVFVB"À¢¢–b†6Æ÷6U&W7VÇCòç7FGW2ÓÓÒ&6Æ÷6VB"’FVÇFæ6Æ÷6VB²°¢VÇ6RFVÇFçWFFVB²°¢&WGW&âFVÇF¢Ð ¢v—B6fU÷6—F–öâ‡÷2¢FVÇFçWFFVB²°¢ÒVÇ6R°¢–b‚&V6÷&DW†6†ævT'6Væ6R‡÷2’’&WGW&âFVÇF¢–b‡÷2ç7FGW2ÓÓÒ'Æ6VB"ÇÂ÷2ç7FGW2ÓÓÒ'VæF–æuöf–ÆÂ"ÇÂ÷2ç7FGW2ÓÓÒ'Æ6VE÷Væ6öæf—&ÖVB"’°¢ÆWBFW&Ö–æÄVçG'•7FGW2Ò" ¢6öç7B6Æ–VçD÷&FW$–BÒvWEG&6¶VD6Æ–VçD÷&FW$–B‡÷2Â&VçG'’"¢–b‚÷2æ÷&FW$–Bbb6Æ–VçD÷&FW$–B’°¢6öç7B&V6÷fW&VBÒv—B&V6÷fW$VçG'”÷&FW$'”6Æ–VçD–B†W†6†ævT6öææV7F÷"Â÷2ç7–Ö&öÂÂ6Æ–VçD÷&FW$–B¢–b‡&V6÷fW&VB’°¢÷2æ÷&FW$–BÒ7G&–ær‡&V6÷fW&VBæ÷&FW$–BÇÂ&V6÷fW&VBæ–B¢÷2ç7V&Ö—76–öå7FFRÒ&6öæf—&ÖVB ¢÷2ç7V&Ö—76–öä'6VçD6öæf—&ÖF–öç2Ò ¢W6…7FW‡÷2Â&VçG'•÷7V&Ö—76–öå÷&V6÷fW&VB"ÂG'VRÂ÷&FW$–CÒG·÷2æ÷&FW$–GÒ6Æ–VçD÷&FW$–CÒG¶6Æ–VçD÷&FW$–GÖ¢ÒVÇ6R–b†Æ—fT÷&FW$–G2ÓÒçVÆÂbbÆ—fT÷&FW$–G2æ†2†6Æ–VçD÷&FW$–B’’°¢÷2ç7V&Ö—76–öä'6VçD6öæf—&ÖF–öç2ÒçVÖ&W"‡÷2ç7V&Ö—76–öä'6VçD6öæf—&ÖF–öç2ÇÂ’²¢–b‡÷2ç7V&Ö—76–öä'6VçD6öæf—&ÖF–öç2ãÒ"’°¢÷2ç7FGW2Ò'&V¦V7FVB ¢÷2ç7V&Ö—76–öå7FFRÒ&6öæf—&ÖVB ¢÷2ç7FGW5&V6öâÒ&6Æ–VçD÷&FW$–B6öæf—&ÖVB'6VçB&WVFVFÇ“²&VÆV6–ærGW&&ÆR6Æ÷B ¢÷2æ6Æ÷6U&V6öâÒ÷2ç7FGW5&V6öà¢÷2æ6Æ÷6VDBÒFFRææ÷r‚¢W6…7FW‡÷2Â&VçG'•÷7V&Ö—76–öåö'6VçB"ÂfÇ6RÂ÷2ç7FGW5&V6öâ¢v—B6fU÷6—F–öâ‡÷2¢–b‡÷2æÆ—fTÆö6µFö¶Vâ’°¢v—B&VÆV6TÆö6²†6öææV7F–öä–BÂ÷2ç7–Ö&öÂÂÆ—fTÆö6´F—&V7F–öâ‡÷2’Â÷2æÆ—fTÆö6µFö¶Vâ’æ6F6‚‚‚’ÓâfÇ6R¢Ð¢FVÇFçWFFVB²°¢&WGW&âFVÇF¢Ð¢Ð¢Ð¢–b‡÷2æ÷&FW$–BbbG—VöbW†6†ævT6öææV7F÷"ævWD÷&FW"ÓÓÒ&gVæ7F–öâ"’°¢G'’°¢6öç7B÷&FW"Òv—BW†6†ævT6öææV7F÷"ævWD÷&FW"‡÷2ç7–Ö&öÂÂ÷2æ÷&FW$–B¢FW&Ö–æÄVçG'•7FGW2Ò7G&–ær†÷&FW#òç7FGW2óò""’çFôÆ÷vW$66R‚¢Ò6F6‚²ò¢G&ç6–VçBvWD÷&FW"f–ÇW&R(	B¶VWv—F–ærf÷"÷6—F–öâf—6–&–Æ—G’¢òÐ¢Ð¢–b‡FW&Ö–æÄVçG'•7FGW2ÓÓÒ&6æ6VÆÆVB"ÇÂFW&Ö–æÄVçG'•7FGW2ÓÓÒ&6æ6VÆVB"ÇÂFW&Ö–æÄVçG'•7FGW2ÓÓÒ'&V¦V7FVB"’°¢÷2ç7FGW2Ò'&V¦V7FVB ¢÷2ç7FGW5&V6öâÒVçG'•ö÷&FW%òG·FW&Ö–æÄVçG'•7FGW7Ö ¢÷2æ6Æ÷6U&V6öâÒ÷2ç7FGW5&V6öà¢÷2æ6Æ÷6VDBÒFFRææ÷r‚¢ÒVÇ6R°¢÷2ç7FGW5&V6öâÒ÷2ç7FGW5&V6öâÇÂ'&÷FV7F–öåöFVfW'&VC¢v—F–ærW†6†ævR÷6—F–öâ6—¦R ¢Ð¢÷2çWFFVDBÒFFRææ÷r‚¢v—B6fU÷6—F–öâ‡÷2¢FVÇFçWFFVB²°¢&WGW&âFVÇF¢Ð¢òò÷6—F–öâ6Æ÷6VBW‡FW&æÆÇ’â&W6öÇfRF†RW†7B7—7FVÒ6öçG&öÂ÷&FW ¢òòF†BfÆGFVæVB—C²Ö&²÷F–6¶W"öVçG'’fÆÆ&6²—2æ÷Bf–ÆÂæ@¢òò×W7BæWfW"&V6öÖR&VÆ—6VBäÂà¢v—B&Vg&W6„VçG'”÷&FW$66÷VçF–ær†W†6†ævT6öææV7F÷"Â÷2¢6öç7BG’ÒÖF‚æÖ‚ƒÂçVÖ&W"‡÷2æW†V7WFVEVçF—G’ÇÂ÷2çVçF—G’ÇÂ’¢6öç7B–æ†W&—FVE6V7W&—G’Ò–æ†W&—FVDvw&VvFUfVçVU&÷FV7F–öâ‡÷2¢6öç7B6†&VE6V7W&—G”÷&FW$–BÒf—'7DæöäV×G”–FVçF–f–W"€¢÷2ç6V7W&—G•7F÷÷&FW$–BÀ¢–æ†W&—FVE6V7W&—G“òç6V7W&—G•7F÷÷&FW$–BÀ¢¢6öç7B6Æ÷6T÷&FW$–G2Ò'&’æg&öÒ†æWr6WB…°¢7G&–ær‡÷2ç7F÷Æ÷74÷&FW$–BÇÂ""’À¢7G&–ær‡÷2çF¶U&öf—D÷&FW$–BÇÂ""’À¢7G&–ær‡6†&VE6V7W&—G”÷&FW$–BÇÂ""’À¢7G&–ær‡÷2çVæF–æu7—7FVÔ7F–öãòæ÷&FW$–BÇÂ""’À¢7G&–ær‡÷2çVæF–æu&VGV7F–öãòæ÷&FW$–BÇÂ""’À¢Òæf–ÇFW"„&ööÆVâ’’¢6öç7B6WGFÆVÖVçG2Ò†v—B&öÖ—6RæÆÂ€¢6Æ÷6T÷&FW$–G2æÖ‚†÷&FW$–B’Óâ&VD÷&FW%6WGFÆVÖVçB†W†6†ævT6öææV7F÷"Â÷2ç7–Ö&öÂÂ÷&FW$–B’’À¢’’æf–ÇFW"‚‡fÇVR“¢fÇVR—2W†6†ævT÷&FW%6WGFÆVÖVçBÓâ&ööÆVâ‡fÇVR’¢6öç7B&W7E6WGFÆVÖVçBÒ6WGFÆVÖVçG0¢ç6÷'B‚†Â"’Óâ"æf–ÆÆVEVçF—G’Òæf–ÆÆVEVçF—G’•³ÒÇÂçVÆÀ¢ÆWB7GVÄ÷&FW#¢ç’ÒçVÆÀ¢–b‚&W7E6WGFÆVÖVçBbbG—VöbW†6†ævT6öææV7F÷"ævWD÷&FW"ÓÓÒ&gVæ7F–öâ"’°¢6öç7B÷&FW'2Òv—B&öÖ—6RæÆÂ†6Æ÷6T÷&FW$–G2æÖ‚†÷&FW$–B’Óâv—F…F–ÖV÷WB€¢W†6†ævT6öææV7F÷"ævWD÷&FW"‡÷2ç7–Ö&öÂÂ÷&FW$–B’2&öÖ—6SÆç“âÀ¢U„4„ätUõD”ÔTõUEôtUEôõ$DU%ôÕ2À¢vWD÷&FW"†W‡FW&æÂÖ6Æ÷6RG¶÷&FW$–GÒ–À¢’æ6F6‚‚‚’ÓâçVÆÂ’’¢7GVÄ÷&FW"Ò÷&FW'2æf–æB‚†÷&FW"’Óà¢6öçG&öÄ÷&FW$f–ÆÆVEVçF—G’†÷&FW"’âbb6öçG&öÄ÷&FW$f–ÆÅ&–6R†÷&FW"’âÀ¢’ÇÂçVÆÀ¢Ð¢6öç7B7GVÄ÷&FW$–BÒ&W7E6WGFÆVÖVçCòæ÷&FW$–@¢ÇÂ7G&–ær†7GVÄ÷&FW#òæ÷&FW$–Bóò7GVÄ÷&FW#òæ–Bóò""¢6öç7B&t7GVÄf–ÆÆVEVçF—G’Ò&W7E6WGFÆVÖVçCòæf–ÆÆVEVçF—G¢ÇÂ6öçG&öÄ÷&FW$f–ÆÆVEVçF—G’†7GVÄ÷&FW"¢6öç7B7GVÄf–ÆÅ&–6RÒ&W7E6WGFÆVÖVçCòæfW&vTf–ÆÅ&–6P¢ÇÂ6öçG&öÄ÷&FW$f–ÆÅ&–6R†7GVÄ÷&FW"¢6öç7B—56†&VE6V7W&—G”f–ÆÂÒ&ööÆVâ€¢7GVÄ÷&FW$–@¢bb6†&VE6V7W&—G”÷&FW$–@¢bb7GVÄ÷&FW$–BÓÓÒ6†&VE6V7W&—G”÷&FW$–BÀ¢¢6öç7Bvw&VvFUVçF—G’ÒÖF‚æÖ‚€¢G’À¢çVÖ&W"‡÷2ævw&VvFU&÷FV7F–öåVçF—G’ÇÂ’À¢¢6öç7B6V7W&—G”ÆÆö6F–öå&F–òÒ—56†&VE6V7W&—G”f–ÆÂbbvw&VvFUVçF—G’â ¢òÖF‚æÖ–âƒÂG’òvw&VvFUVçF—G’¢¢¢6öç7B7GVÄf–ÆÆVEVçF—G’Ò—56†&VE6V7W&—G”f–ÆÀ¢òÖF‚æÖ–â‡G’Â&t7GVÄf–ÆÆVEVçF—G’¢6V7W&—G”ÆÆö6F–öå&F–ò¢¢&t7GVÄf–ÆÆVEVçF—G¢–b†7GVÄ÷&FW$–Bbb7GVÄf–ÆÆVEVçF—G’â’°¢÷2æ6Æ÷6T÷&FW$–BÒ7GVÄ÷&FW$–@¢Ð¢6öç7BÆ–VE6WGFÆVÖVçBÒ—56†&VE6V7W&—G”f–ÆÂbb&W7E6WGFÆVÖVç@¢ò÷'F–öæVE6WGFÆVÖVçB†&W7E6WGFÆVÖVçBÂ7GVÄf–ÆÆVEVçF—G’Â6V7W&—G”ÆÆö6F–öå&F–ò¢¢&W7E6WGFÆVÖVç@¢–b†7GVÄ÷&FW$–Bbb7GVÄf–ÆÆVEVçF—G’â’°¢6öç7BW†V7WF–öä–BÒG·÷2æ–GÓ¦W†6†ævRÖW‡FW&æÃ¢G¶7GVÄ÷&FW$–GÖ ¢6öç7BW†—7F–ætW†V7WF–öâÒ÷2ç'F–Ä÷&FW$W†V7WF–öç3òæf–æB‚†VçG'’’ÓâVçG'’æ–BÓÓÒW†V7WF–öä–B¢Ç•&VGV7F–öäö'6W'fF–öâ‡÷2Â°¢W†V7WF–öä–BÀ¢6÷W&6S¢&W†6†ævU÷&V6öæ6–ÆR"À¢7FGW3¢&f–ÆÆVB"À¢&WVW7FVEVçF—G“¢G’À¢&W÷'FVDf–ÆÆVEVçF—G“¢7GVÄf–ÆÆVEVçF—G’À¢&Wf–÷W6Ç”Æ–VEVçF—G“¢çVÖ&W"†W†—7F–ætW†V7WF–öãòæ7V×VÆF—fTf–ÆÆVEVçF—G’ÇÂ’À¢WF†÷&—FF—fUVçF—G“¢À¢&–6S¢7GVÄf–ÆÅ&–6RÀ¢6WGFÆVÖVçC¢Æ–VE6WGFÆVÖVçBÀ¢÷&FW$–C¢7GVÄ÷&FW$–BÀ¢Ò¢–b†7GVÄf–ÆÆVEVçF—G’ÂG’ÒÖF‚æÖ‚ƒRÓ"ÂG’¢RÓ‚’’°¢÷2ç&VÆ—¦VEæÄ6ö×ÆWFRÒfÇ6P¢÷2ç&VÆ—¦VEæÅ6÷W&6RÒ&W†6†ævU÷Vç&W6öÇfVB ¢Ð¢ÒVÇ6R°¢÷2ç&VÆ—¦VEæÄ6ö×ÆWFRÒfÇ6P¢÷2ç&VÆ—¦VEæÅ6÷W&6RÒ&W†6†ævU÷Vç&W6öÇfVB ¢Ð¢6öç7BW†—E&–6RÒ7GVÄf–ÆÅ&–6Râò7GVÄf–ÆÅ&–6R¢ ¢6öç7B&VÆ—¦VEæÂÒçVÖ&W"‡÷2ç&VÆ—¦VEäÂÇÂ ¢ÆWB6öçG&öÇ56WGFÆVBÒv—B6WGFÆU6Æ÷D6öçG&öÇ5v—F†÷WDwVW72€¢W†6†ævT6öææV7F÷"À¢÷2À¢G'VRÀ¢Æ—fT÷&FW$–G2À¢$W‡FW&æÄ6Æ÷6R"À¢¢–b‚6öçG&öÇ56WGFÆVB’°¢6öçG&öÇ56WGFÆVBÒv—B6æ6VÅ6Æ÷D÷væVD6öçG&öÇ2€¢W†6†ævT6öææV7F÷"À¢÷2À¢G'VRÀ¢$W‡FW&æÄ6Æ÷6R"À¢¢Ð¢6öç7B–æ†W&—FVE6V7W&—G•6WGFÆVBÒ6†&VE6V7W&—G”÷&FW$–@¢ÇÂ6†&VE6V7W&—G”÷&FW$–BÓÓÒ÷2ç6V7W&—G•7F÷÷&FW$–@¢ÇÂv—B6æ6VÅ&÷FV7F–öä÷&FW"€¢W†6†ævT6öææV7F÷"À¢÷2ç7–Ö&öÂÀ¢6†&VE6V7W&—G”÷&FW$–BÀ¢$W‡FW&æÄ6Æ÷6RÕ6†&VE6V7W&—G’"À¢÷2æ6öææV7F–öä–BÀ¢¢–b‚6öçG&öÇ56WGFÆVBÇÂ–æ†W&—FVE6V7W&—G•6WGFÆVB’°¢÷2ç7FGW5&V6öâÒ&W‡FW&æÅö6Æ÷6Uö6öçG&öÅö6ÆVçW÷VæF–ær ¢÷2çWFFVDBÒFFRææ÷r‚¢W6…7FW€¢÷2À¢&W‡FW&æÅö6Æ÷6Uö6öçG&öÅö6ÆVçW"À¢fÇ6RÀ¢'fVçVR÷6—F–öâ—2fÆBÂ'WBBÆV7BöæR5E26öçG&öÂ÷&FW"—2æ÷BWF†÷&—FF—fVÇ’6WGFÆVB"À¢¢v—B6fU÷6—F–öâ‡÷2¢FVÇFçWFFVB²°¢&WGW&âFVÇF¢Ð ¢òò)H)HFòäõB6ÆÂ6Æ÷6U÷6—F–öâöâF†RW†6†ævR†W&R)H)H)H)H)H)H)H)H)H)H)H)H ¢òòF†—2'&æ6‚'Vç2v†VâF†R&VF—2×G&6¶VB÷6—F–öâ—2'6Vç@¢òòg&öÒF†RW†6†ævRw2÷Vâ×÷6—F–öç2Æ—7BâF†BÖVç2F†P¢òòW†6†ævR†2Å$TE’6Æ÷6VB—B…4ÂõEf–ÆÆVBÂÆ—V–FFVBÀ¢òò÷"F†R÷W&F÷"6Æ÷6VB—BÖçVÆÇ’’â6ÆÆ–ær6Æ÷6U÷6—F–öà¢òò†W&Rv÷VÆBF†W&Vf÷&RF&vWBç’õD„U"÷Vâ÷6—F–öâBF†P¢òò6ÖR7–Ö&öÂ¶F—&V7F–öâ(	B–æ6ÇVF–æröæW2F†R÷W&F÷"Æ6V@¢òòÖçVÆÇ’F†BF†R7—7FVÒF–Bæ÷B7&VFRâvR×W7Bæ÷BF÷V6€¢òòF†÷6RâF†R&VF—2&V6÷&B—26Æ÷6VBÆö6ÆÇ’'’F†R6öFR&VÆ÷s°¢òòæòW†6†ævR7F–öâ—2&WV—&VB÷"6fRà¢6öç7B&VÖ–æ–æuVçF—G”D6Æ÷6RÒÖF‚æÖ‚€¢À¢çVÖ&W"‡÷2æW†V7WFVEVçF—G’ÇÂ÷2çVçF—G’ÇÂ’À¢¢6öç7BÆ–fWF–ÖUVçF—G”D6Æ÷6RÒÖF‚æÖ‚€¢çVÖ&W"‡÷2çF÷FÄW†V7WFVEVçF—G’ÇÂ’À¢ÖF‚æÖ‚ƒÂçVÖ&W"‡÷2æ6Æ÷6VEVçF—G’ÇÂ’’²&VÖ–æ–æuVçF—G”D6Æ÷6RÀ¢çVÖ&W"‡÷2æ–æ—F–ÄW†V7WFVEVçF—G’ÇÂ’À¢&VÖ–æ–æuVçF—G”D6Æ÷6RÀ¢¢&V6öæ6–ÆTW†6†ævUVçF—G”ÆVFvW"€¢÷2À¢Æ–fWF–ÖUVçF—G”D6Æ÷6RÀ¢çVÖ&W"‡÷2æfW&vTW†V7WF–öå&–6RÇÂ÷2æVçG'•&–6RÇÂ’À¢¢÷2ç7FGW2Ò&6Æ÷6VB ¢÷2æ6Æ÷6VDBÒFFRææ÷r‚¢÷2çF÷FÄW†V7WFVEVçF—G’ÒÆ–fWF–ÖUVçF—G”D6Æ÷6P¢÷2æ6Æ÷6VEVçF—G’ÒÆ–fWF–ÖUVçF—G”D6Æ÷6P¢÷2æW†V7WFVEVçF—G’ÒÆ–fWF–ÖUVçF—G”D6Æ÷6P¢÷2çVçF—G’ÒÆ–fWF–ÖUVçF—G”D6Æ÷6P¢÷2ç&VÖ–æ–æuVçF—G’Ò ¢÷2ç&VÆ—¦VEäÂÒÖF‚ç&÷VæB‡&VÆ—¦VEæÂ¢S‚’òS€¢÷2çVæF–æu&÷FV7F–öä÷&FW'2ÒVæFVf–æV@¢÷2ç7F÷Æ÷74÷&FW$–BÒVæFVf–æV@¢÷2çF¶U&öf—D÷&FW$–BÒVæFVf–æV@¢÷2ç6V7W&—G•7F÷÷&FW$–BÒVæFVf–æV@¢÷2ç7F÷Æ÷75&–6RÒ ¢÷2çF¶U&öf—E&–6RÒ ¢÷2ç6V7W&—G•7F÷&–6RÒ ¢6WE&÷FV7F–öäÆVt&ÖVEVçF—G’‡÷2Â'7F÷öÆ÷72"Â¢6WE&÷FV7F–öäÆVt&ÖVEVçF—G’‡÷2Â'F¶U÷&öf—B"Â¢÷2ç6V7W&—G•7F÷&ÖVEVçF—G’Ò ¢÷2ç6V7W&—G•7F÷'6Væ6T6öæf—&ÖF–öç2Ò ¢÷2ç6V7W&—G•7F÷&WV—&VBÒfÇ6P¢÷2ç6V7W&—G•7F÷7FGW2ÒVæFVf–æV@¢÷2ç7—7FVÕ&÷FV7F–öäÆVw2ÒµÐ¢÷2ç&÷FV7F–öäÖöFRÒVæFVf–æV@¢÷2æ6öçG&öÄ÷&FW%6WD6÷fW&vRÒVæFVf–æV@¢÷2ævw&VvFU&÷FV7F–öä×WFF–öå&WVW7FVDBÒVæFVf–æV@¢÷2ævw&VvFU&÷FV7F–öä×WFF–öå6WGFÆVDBÒVæFVf–æV@¢÷2ævw&VvFU&÷FV7F–öä×WFF–öå&V6öâÒVæFVf–æV@¢÷2ævw&VvFU&÷FV7F–öä÷væW"ÒfÇ6P¢÷2ævw&VvFU&÷FV7F–öåVçF—G’Ò ¢–b†W†—E&–6Râ’÷2æ6Æ÷6U&–6RÒÖF‚ç&÷VæB†W†—E&–6R¢S‚’òS€¢÷2æ6Æ÷6U&V6öâÒ÷2æ6Æ÷6U&V6öâÇÂ&W†6†ævU÷&V6öæ6–Æ–F–öâ ¢W6…7FW€¢÷2À¢&6Æ÷6R"À¢G'VRÀ¢&V6öæ6–ÆVBG¶W†—E&–6RâòW†—E&–6RçFôf—†VBƒ‚’¢'Vç&W6öÇfVB'ÒäÃÒG·&VÆ—¦VEæÂçFôf—†VBƒB—Ò66÷VçF–æsÒG·÷2ç&VÆ—¦VEæÅ6÷W&6WÒòG·÷2ç&VÆ—¦VEæÄ6ö×ÆWFRò&6ö×ÆWFR"¢&–æ6ö×ÆWFR'ÖÀ¢¢÷2çWFFVDBÒFFRææ÷r‚ ¢6öç7BÖ÷fVDÖ&¶W"ÒÆ—fS§÷6—F–öç3¢G¶6öææV7F–öä–GÓ¦Ö÷fVC¢G·÷2æ–GÖ  ¢òò&VBF†RFVGWRÖ&¶W"$Tdõ$R6fU÷6—F–öâ‚’â&VF—2ÖF"ç6fU÷6—F–öâ‚¢òò6WG2F†—2fW'’Ö&¶W"v†Vâ7FGW3ÓÓÒ&6Æ÷6VB"æBÅ4òÖ÷fW2F†R–@¢òòg&öÒF†R÷Vâ–æFW‚FòF†R6Æ÷6VB&6†—fRâ&VF–ærF†RÖ&¶W"gFW ¢òòF†R6ÆÂv÷VÆBF†W&Vf÷&RÇv—2&RG'WF‡’ÂW&ÖæVçFÇ’6¶—–ærF†P¢òò6Æ÷6RÖ6÷VçFW"–æ7&VÖVçB&VÆ÷r†W‡FW&æÆÇ’Ö6Æ÷6VB÷6—F–öç2(	B4ÂõE ¢òòf–ÆÇ2ÂÆ—V–FF–öç2ÂÖçVÂ6Æ÷6W2(	BvW&RæWfW"6÷VçFVB’âF†RÖ&¶W ¢òò—2v†BFVGWW2F†—2F‚v–ç7B6Æ÷6TÆ—fU÷6—F–öâ‚’à¢6öç7BÇ&VG”Ö÷fVBÒv—B6Æ–VçBævWB†Ö÷fVDÖ&¶W"’æ6F6‚‚‚’ÓâçVÆÂ ¢òòW'6—7G2F†R¥4ôâ6æ6†÷B²Ö÷fW2F†R–æFW‚²6WG2F†RÖ&¶W"à¢v—B6fU÷6—F–öâ‡÷2¢v—BGfæ6T&Æö6´6÷VçEW6W4öå÷6—F–öä6Æ÷6R†6Æ–VçBÂ÷2 ¢6öç7B&öt¶W’Ò&öw&W76–öã¢G¶6öææV7F–öä–GÖ ¢6öç7Bw&—FW3¢&öÖ—6SÆç“åµÒÒ°¢6Æ–VçBæW‡—&R‡&öt¶W’Âr¢#B¢c¢c’æ6F6‚‚‚’Óâ·Ò’À¢Ð¢–b‡÷2æÆ—fTÆö6µFö¶Vâ’°¢w&—FW2çW6‚‡&VÆV6TÆö6²†6öææV7F–öä–BÂ÷2ç7–Ö&öÂÂÆ—fTÆö6´F—&V7F–öâ‡÷2’Â÷2æÆ—fTÆö6µFö¶Vâ’æ6F6‚‚‚’ÓâfÇ6R’¢Ð¢–b‚Ç&VG”Ö÷fVB’°¢òò6÷VçFW"–æ7&VÖVçG2&RF†RôäÅ’÷2F†B×W7B&RFVGWVB7&÷70¢òòF†R6Æ÷6TÆ—fU÷6—F–öâ²&V6öæ6–ÆRF‡2(	BF†R–æFW‚Ö÷fR–ç6–FP¢òò6fU÷6—F–öâ‚’—2Ç&VG’–FV×÷FVçBÂ6òvRæòÆöævW"&WVBF†P¢òòÇ&VÒöÇW6‚†W&R†Fö–ær6òF÷V&ÆR×W6†VBF†R–B–çFòF†R&6†—fR’à¢w&—FW2çW6‚€¢6Æ–VçBæ†–æ7&'’‡&öt¶W’Â&Æ—fU÷÷6—F–öç5ö6Æ÷6VEö6÷VçB"Â’æ6F6‚‚‚’Óâ·Ò’À¢¢–b‡÷2ç&VÆ—¦VEæÄ6ö×ÆWFRbb&VÆ—¦VEæÂâ’°¢w&—FW2çW6‚†6Æ–VçBæ†–æ7&'’‡&öt¶W’Â&Æ—fU÷v–ç5ö6÷VçB"Â’æ6F6‚‚‚’Óâ·Ò’¢Ð¢Ð¢v—B&öÖ—6RæÆÂ‡w&—FW2 ¢FVÇFæ6Æ÷6VB²°¢Ð¢Ò6F6‚†W'"’°¢FVÇFæW'&÷'2²°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò&V6öæ6–ÆRW"×÷6—F–öâW'&÷"f÷"G·÷2æ–GÓ¦À¢W'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"’À¢¢Ð¢&WGW&âFVÇF¢Ð ¢òò)H)H&÷VæFVBÖ6öæ7W'&Væ7’7G&VÖ–ærööÂ)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òò7G&VÖ–ær†æ÷B&F6‚’ööÂ6ò6Æ÷rW†6†ævR6ÆÂöâöæP¢òò÷6—F–öâæWfW"&Æö6·2F†RæW‡Brg&öÒ7F'F–ærâ6öæ7W'&Væ7’€¢òò—2vVÆÂ&VÆ÷rF†RSöÖ–â÷&FW"×&FR6V–Æ–æröâWfW'’fVçVRvP¢òò7W÷'BæBvVÆÂ&÷fRF†RG—–6Â7vVW6—¦RÂ6òF†RÆ–Ö—@¢òòf—'GVÆÇ’æWfW"&—FW2–â&7F–6R(	B—BW†—7G2W&VÇ’2¢òò&6·7F÷v–ç7BF†öÆöv–6Â'W'7Bà¢6öç7BÄ•dUõ$T4ôä4”ÄUô4ôä5U%$Tä5’Ò€¢6öç7BVWVRÒ÷Vå÷6—F–öç2ç6Æ–6R‚¢6öç7B'VææW'3¢&öÖ—6SÇfö–CåµÒÒµÐ¢6öç7Bvw&VvFRÒ†C¢÷4FVÇF’Óâ°¢7VÖÖ'’ç&V6öæ6–ÆVB³ÒBç&V6öæ6–ÆV@¢7VÖÖ'’çWFFVB³ÒBçWFFV@¢7VÖÖ'’æ6Æ÷6VB³ÒBæ6Æ÷6V@¢7VÖÖ'’æW'&÷'2³ÒBæW'&÷'0¢7VÖÖ'’ç&÷FV7F–öå&V&ÖVB³ÒBç&÷FV7F–öå&V&ÖV@¢Ð¢7VÖÖ'’ç&V6öæ6–ÆVBÒòò&RÖ6÷VçFVB'’vw&VvFP¢f÷"†ÆWB’Ò²’ÂÖF‚æÖ–â„Ä•dUõ$T4ôä4”ÄUô4ôä5U%$Tä5’ÂVWVRæÆVæwF‚“²’²²’°¢'VææW'2çW6‚‚†7–æ2‚’Óâ°¢v†–ÆR‡G'VR’°¢6öç7BÒVWVRç6†–gB‚¢–b‚’&WGW&à¢vw&VvFR†v—B&ö6W74öæR‡’¢Ð¢Ò’‚’¢Ð¢v—B&öÖ—6RæÆÂ‡'VææW'2 ¢òòv÷&¶W"Ö’†fR§W7B6ö×ÆWFVBâvw&VvFRVçF—G’†æBÖöfb†÷ ¢òò&W7F÷&VBFW&Ö–æÂ'F–Â6Æ÷6R’â&RÖ&ÒF†BW†7B‡—6–6Â6Æ÷Bg&öÐ¢òòg&W6‚fVçVR6æ6†÷B&Vf÷&R&WGW&æ–ærÂ&F†W"F†âÆVf–ær—BVçF–Â¢òògWGW&R7&öâF–6²âFVfW'&VB6Æ÷G2&WF–âF†V—"GW&&ÆRÖ&¶W"æB&VÖ–à¢òòVWVVBf÷"F†RæW‡BWF†÷&—FF—fR72à¢6öç7BVWVVDvw&VvFU6Æ÷G2ÒVWVVDvw&VvFU&÷FV7F–öäf–æÆ—¦F–öç2†6öææV7F–öä–B¢–b‡VWVVDvw&VvFU6Æ÷G2ç6—¦Râ’°¢G'’°¢6öç7Bf–æÆ—¦F–öâÒv—Bf–æÆ—¦UVWVVDvw&VvFU&÷FV7F–öâ€¢6öææV7F–öä–BÀ¢W†6†ævT6öææV7F÷"À¢VWVVDvw&VvFU6Æ÷G2À¢¢7VÖÖ'’ç&÷FV7F–öå&V&ÖVB³Òf–æÆ—¦F–öâç&V&ÖVDÆVFW'0¢6WGFÆTvw&VvFU&÷FV7F–öäf–æÆ—¦F–öç2†6öææV7F–öä–BÂf–æÆ—¦F–öâæ6ö×ÆWFVE6Æ÷G2¢Ò6F6‚†W'&÷"’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Òvw&VvFR&÷FV7F–öâf–æÆ—¦F–öâf–ÆVC²&WF–æ–ærGW&&ÆR&WG'’VWVS¦À¢W'&÷"–ç7Fæ6VöbW'&÷"òW'&÷"æÖW76vR¢7G&–ær†W'&÷"’À¢¢Ð¢Ð ¢òò$D4„”äs¢6fRÆÂ6öÆÆV7FVB÷6—F–öç2–âöæR÷W&F–öâ–ç7FVBöbâ6WVVçF–Â6ÆÇ0¢–b‡÷6—F–öç5Fõ6fRæÆVæwF‚â’°¢G'’°¢v—B&öÖ—6RæÆÂ‡÷6—F–öç5Fõ6fRæÖ‡Óâ6fU÷6—F–öâ‡’’¢Ò6F6‚†&F6„W'"’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò&F6‚6fU÷6—F–öâf–ÆVB†GFV×FVBG·÷6—F–öç5Fõ6fRæÆVæwF‡Ò÷6—F–öç2“¦À¢&F6„W'"–ç7Fæ6VöbW'&÷"ò&F6„W'"æÖW76vR¢7G&–ær†&F6„W'"’À¢¢Ð¢Ð ¢–b‡7VÖÖ'’æ6Æ÷6VBâÇÂ7VÖÖ'’çWFFVBâ’°¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡ÒG¶6öææV7F–öä–GÒ&V6öæ6–ÆVCÒG·7VÖÖ'’ç&V6öæ6–ÆVGÒWFFVCÒG·7VÖÖ'’çWFFVGÒ6Æ÷6VCÒG·7VÖÖ'’æ6Æ÷6VGÖ ¢¢Ð ¢&WGW&â7VÖÖ'¢Ò6F6‚†W'"’°¢6öç6öÆRæW'&÷"†G´Äôuõ$Td•‡Ò&V6öæ6–ÆTÆ—fU÷6—F–öç2fFÃ¦ÂW'"¢&WGW&â7VÖÖ'¢Òf–æÆÇ’°¢7F÷7–æ4Æö6´ÆV6U&Vg&W6ƒòâ‚¢–b†Æö6´7V—&VBbb6Æ–VçB’°¢v—BWfÄÆö6´ÇV†6Æ–VçBÂ$TÄT4UôÄô4µôÅTÂÄ•dUõ5”ä5ôÄô4µô´U’Â·7–æ4Æö6µFö¶VåÒ’æ6F6‚‚‚’Óâ¢Ð¢Ð§Ð ¢ò¢ ¢¢7FæFÆöæR6–×VÆFVB×÷6—F–öâ&ö6W76÷"à¢ ¢¢vÆ·2WfW'’7FGW2ÓÓÒ'6–×VÆFVB&Æ—fR÷6—F–öâæBÆ–W2F†P¢¢6ÖR4ÂõEÖ7&÷72òÖ‚Ö†öÆB×F–ÖR6Æ÷6RÆöv–2F†R&VÂ×÷6—F–öà¢¢F‡2W6RÂ'WBv—F†÷WBç’W†6†ævR×6–FR6ÆÇ2â6Æ÷6W2f–¢¢6Æ÷6TÆ—fU÷6—F–öâ†6öææV7F–öä–BÂ÷4–BÂW†—E&–6RÂçVÆÂÂ&V6öâ– ¢¢v†–6‚Ç&VG’w&6VgVÆÇ’æòÖ÷2F†RW†6†ævR'&æ6†W2v†VâF†P¢¢6öææV7F÷"—2çVÆÆà¢ ¢¢F†—2ÕU5B&R6ÆÆ&ÆR–æFWVæFVçFÇ’öbF†RW†6†ævR6öææV7F÷ ¢¢&V6W6S ¢¢âW"ÖöæÇ’6öææV7F–öç2†æò’¶W—2’æWfW"VçFW ¢¢7–æ5v—F„W†6†ævV(	BÖ–&U'VäÆ—fU7–æ6&WGW&ç2BF†P¢¢’Ö¶W’vFRà¢¢"âF†R7&öâ&V6öæ6–ÆTÆ—fU÷6—F–öç6V&Ç’×&WGW&ç2v†VâF†P¢¢6öææV7F÷"†2æòvWE÷6—F–öç6Âv–â'—76–ærF†P¢¢6–×VÆFVB7vVWF†BÆ—fW2–ç6–FR7–æ5v—F„W†6†ævVà¢ ¢¢v—F†÷WBF†—2†VÇW"Â6–×VÆFVB÷6—F–öç26B÷Vâf÷&WfW"öâç¢¢W"6öææV7F–öâ(	BF†RW6W"×f—6–&ÆR$Æ—fR÷6—F–öç2&R7F–ÆÂæ÷@¢¢vWGF–ær6Æ÷6VB"6ö×Æ–çBà¢ ¢¢&WGW&ç27VÖÖ'’f÷"Æövv–ærà¢¢ð¦W‡÷'B7–æ2gVæ7F–öâ&ö6W756–×VÆFVE÷6—F–öç2€¢6öææV7F–öä–C¢7G&–ærÀ¢&VÆöFVE÷6—F–öç3ó¢&VFöæÇ’Æ—fU÷6—F–öåµÒÀ¢“¢&öÖ—6SÇ²&ö6W76VC¢çVÖ&W#²6Æ÷6VC¢çVÖ&W#²W'&÷'3¢çVÖ&W"Óâ°¢6öç7B7VÖÖ'’Ò²&ö6W76VC¢Â6Æ÷6VC¢ÂW'&÷'3¢Ð¢G'’°¢v—B–æ—E&VF—2‚¢òò7–æ5v—F„W†6†ævR†2Ç&VG’&VBF†RWF†÷&—FF—fR÷Vâ–æFW‚â&WW6P¢òòF†B6æ6†÷Bf÷"W"ÖöFR–ç7FVBöb–ÖÖVF–FVÇ’&VF–ærWfW'’†6€¢òòæB¥4ôâÖ—'&÷"f÷"6V6öæBF–ÖRöâF†R6ÖR#×2F–6²âF†R7FæFÆöæP¢òòF‚¶VW2öæR×6V6öæB7FvR&ö¦V7F–öâ6òFVç6RW"&öö²FöW2æ÷@¢òòFW6W&–Æ—¦R—G26ö×ÆWFR&÷r6WBf—fRF–ÖW2W"6V6öæBà¢6öç7BÆÄ÷VâÒ&VÆöFVE÷6—F–öç0¢ò²ââç&VÆöFVE÷6—F–öç5Ð¢¢v—BvWE6–×VÆFVE÷6—F–öå7FvU&÷w2†6öææV7F–öä–B¢–b‡&VÆöFVE÷6—F–öç2’°¢6öç7B&Wf–÷W2Ò6–×VÆFVE÷6—F–öå7FvW2ævWB†6öææV7F–öä–B¢6–×VÆFVE÷6—F–öå7FvW2ç6WB†6öææV7F–öä–BÂ°¢÷6—F–öç3¢ÆÄ÷VâÀ¢7W'6÷#¢&Wf–÷W3òæ7W'6÷"ÇÂÀ¢W‡—&W4C¢FFRææ÷r‚’²4”ÕTÄDTEõõ4•D”ôåõ5DtUô44„UôÕ2À¢Ò¢G&–Õ6–×VÆFVE÷6—F–öå7FvW2‚¢Ð¢6öç7BÆÅ6–×VÆFVBÒÆÄ÷Vâæf–ÇFW"€¢‡’Óâç7FGW2ÓÓÒ'6–×VÆFVB"bb‡æW†V7WFVEVçF—G’óò’âÀ¢¢–b†ÆÅ6–×VÆFVBæÆVæwF‚ÓÓÒ’&WGW&â7VÖÖ'¢6öç7B6–×2Ò6VÆV7E6–×VÆFVE÷6—F–öå7FvU&÷w2†6öææV7F–öä–BÂÆÅ6–×VÆFVB ¢òòVÆÂ7W'&VçB&–6W2öæÇ’f÷"F†—2f—"7FvR6Æ–6RâV6‚÷Vâ&÷r&VÖ–ç0¢òòVÆ–v–&ÆRf÷"Eõ4ÂÂG&–Æ–æræBÖ‚Ö†öÆB†æFÆ–æs²Æ&vR&öö·26–×Ç¢òò&÷FFRF‡&÷Vv‚&÷VæFVB&÷w2–ç7FVBöb7F'f–ær…EE÷&V6÷fW'’v÷&²à¢6öç7BVæ—VU7–×2Ò'&’æg&öÒ†æWr6WB‡6–×2æÖ‚‡’Óâç7–Ö&öÂ’’¢6öç7B&–6TÖÒæWrÖÇ7G&–ærÂçVÖ&W#â‚¢v—B&öÖ—6RæÆÂ€¢Væ—VU7–×2æÖ†7–æ2‡7–Ò’Óâ°¢6öç7B‚Òv—BfWF6„7W'&VçE&–6R‡7–ÒÂ6öææV7F–öä–B’æ6F6‚‚‚’Óâ¢–b‡‚â’&–6TÖç6WB‡7–ÒÂ‚¢Ò’À¢ ¢6öç7BÔ…ô„ôÄEõD”ÔUôÕ2Ò&W6öÇfTÖ„†öÆD×2†6öææV7F–öä–B¢G—R6–×VÆFVDFVÇFÒ²&ö6W76VC¢çVÖ&W#²6Æ÷6VC¢çVÖ&W#²W'&÷'3¢çVÖ&W"Ð¢6öç7B&ö6W74öæRÒ7–æ2‡÷3¢Æ—fU÷6—F–öâ“¢&öÖ—6SÅ6–×VÆFVDFVÇFâÓâ°¢6öç7BFVÇF¢6–×VÆFVDFVÇFÒ²&ö6W76VC¢Â6Æ÷6VC¢ÂW'&÷'3¢Ð¢G'’°¢6öç7BÖ&µ&–6RÒ&–6TÖævWB‡÷2ç7–Ö&öÂ’ÇÂ÷2æfW&vTW†V7WF–öå&–6RÇÂ ¢6öç7B&Wf–÷W4Ö&²ÒçVÖ&W"‡÷2æW†6†ævTFFòæÖ&µ&–6RÇÂ¢6öç7Bæ÷rÒFFRææ÷r‚¢–b†Ö&µ&–6Râ’°¢÷2æW†6†ævTFFÒ°¢ââç÷2æW†6†ævTFFÀ¢Ö&µ&–6RÀ¢7–æ6VDC¢æ÷rÀ¢Ð¢òò4ÂõE7&÷726†V6²‡76W26öææV7F÷#ÖçVÆÂ6ò6Æ÷6R6¶—0¢òòF†RW†6†ævR×6–FR6æ6VÂ²6Æ÷6U÷6—F–öâ6ÆÇ2’à¢6öç7B7&÷76VBÒv—B6†V6´æDf÷&6T6Æ÷6Töå6ÇG7&÷72€¢6öææV7F–öä–BÀ¢÷2À¢Ö&µ&–6RÀ¢çVÆÂÀ¢¢–b†7&÷76VB’°¢–b†7&÷76VBÓÒ&6Æ÷6U÷Væ6öæf—&ÖVB"’°¢FVÇFæ6Æ÷6VB²°¢6ÆV%6–×VÆFVDÖ&µW'6—7FVæ6R‡÷2¢Ð¢&WGW&âFVÇF¢Ð¢Ð¢òòÖ‚Ö†öÆB6fWG’6Æ÷6W"à¢6öç7B÷VæVDBÒ÷2æ7&VFVDBÇÂ÷2çWFFVDBÇÂ ¢6öç7B†VÆD×2ÒFFRææ÷r‚’Ò÷VæVD@¢–b€¢Ô…ô„ôÄEõD”ÔUôÕ2âb`¢†VÆD×2âÔ…ô„ôÄEõD”ÔUôÕ2b`¢—57—7FVÕG&6¶VDÆ—fU÷6—F–öâ‡÷2Â6öææV7F–öä–B’b`¢‡÷2æW†V7WFVEVçF—G’óò’â ¢’°¢6öç7BW†—E&–6RÒÖ&µ&–6RÇÂ÷2æfW&vTW†V7WF–öå&–6RÇÂ÷2æVçG'•&–6P¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢'v&æ–ær"À¢Ö‚†öÆBF–ÖRW†6VVFVBf÷"6–×VÆFVBG·÷2ç7–Ö&öÇÒ(	Bf÷&6RÖ6Æ÷6–ævÀ¢²÷6—F–öä–C¢÷2æ–BÂ†VÆD×2ÂÖ„†öÆD×3¢Ô…ô„ôÄEõD”ÔUôÕ2ÂW†—E&–6RÒÀ¢¢6öç7B6Æ÷6U&W7VÇBÒv—B6Æ÷6TÆ—fU÷6—F–öâ†6öææV7F–öä–BÂ÷2æ–BÂW†—E&–6RÂçVÆÂÂ&Ö…ö†öÆE÷F–ÖUöW†6VVFVB"¢–b†6Æ÷6U&W7VÇCòç7FGW2ÓÓÒ&6Æ÷6VB"’°¢FVÇFæ6Æ÷6VB²°¢6ÆV%6–×VÆFVDÖ&µW'6—7FVæ6R‡÷2¢ÒVÇ6RFVÇFæW'&÷'2²°¢&WGW&âFVÇF¢Ð¢òò¶VWF†RF6†&ö&Bg&W6‚v—F†÷WBw&—F–ærF†R6ö×ÆWFRÆ–fV7–6ÆRÀ¢òò–æFW†W2æB¥4ôâÖ—'&÷"öâWfW'’7V"×6V6öæBW"F–6²âF†—2—0¢òò–çFVçF–öæÆÇ’gFW"F†R6Æ÷6R6†V6·3¢Æ–fV7–6ÆR6†ævW27F–ÆÂW6P¢òò6Æ÷6TÆ—fU÷6—F–öâ–ÖÖVF–FVÇ’æBæWfW"v—Bf÷"F†—2F‡&÷GFÆRà¢–b‡6†÷VÆEW'6—7E6–×VÆFVDÖ&²‡÷2Â&Wf–÷W4Ö&²ÂÖ&µ&–6RÂæ÷r’’°¢v—B6fU÷6—F–öâ‡÷2¢Ö&µ6–×VÆFVDÖ&µW'6—7FVB‡÷2Âæ÷r¢Ð¢Ò6F6‚†W'"’°¢FVÇFæW'&÷'2²°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò&ö6W756–×VÆFVE÷6—F–öç2W"×÷2W'&÷"f÷"G·÷2æ–GÓ¦À¢W'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"’À¢¢Ð¢&WGW&âFVÇF¢Ð ¢òò&VF—2Ö&6¶VBW"Æ–fV7–6ÆRv÷&²6â&W6öÇfRF‡&÷Vv‚Ö–7&÷F6·2v—F†÷W@¢òò––VÆF–ærFòF†R…EE6W'fW"âW6RF†R6†&VB6ö÷W&F—fRv÷&¶W"ööÂ6ð¢òòÆ&vR÷Vâ×÷6—F–öâ&öö²6ææ÷B7F'fR†VÇF‚Â7&öâ÷"6öçG&öÂÖ÷&FW ¢òò&WVW7G2v†–ÆRWfW'’÷6—F–öâ7F–ÆÂ&V6V—fW2â–æFWVæFVçBÆ–fV7–6ÆP¢òòWfÇVF–öâ–âF†R6ÖR7vVWà¢6öç7BFVÇF2Òv—BÖv—F„6öæ7W'&Væ7’€¢6–×2À¢6öæ7W'&Væ7”g&öÔVçb€¢²%4”ÕTÄDTEõõ4•D”ôåô4ôä5U%$Tä5’%ÒÀ¢4”ÕTÄDTEõõ4•D”ôåõ$ô4U55ô4ôä5U%$Tä5’À¢bÀ¢6–×2æÆVæwF‚À¢’À¢&ö6W74öæRÀ¢²––VÆDWfW'“¢ÒÀ¢¢f÷"†6öç7BFVÇFöbFVÇF2’°¢7VÖÖ'’ç&ö6W76VB³ÒFVÇFç&ö6W76V@¢7VÖÖ'’æ6Æ÷6VB³ÒFVÇFæ6Æ÷6V@¢7VÖÖ'’æW'&÷'2³ÒFVÇFæW'&÷'0¢Ð¢–b‡7VÖÖ'’æ6Æ÷6VBâ’°¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Ò&ö6W756–×VÆFVE÷6—F–öç2G¶6öææV7F–öä–GÒ&ö6W76VCÒG·7VÖÖ'’ç&ö6W76VGÒ6Æ÷6VCÒG·7VÖÖ'’æ6Æ÷6VGÖÀ¢¢Ð¢&WGW&â7VÖÖ'¢Ò6F6‚†W'"’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò&ö6W756–×VÆFVE÷6—F–öç2fFÃ¦À¢W'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"’À¢¢&WGW&â7VÖÖ'¢Ð§Ð ¢ò¢ ¢¢7–æ2Æ—fR÷6—F–öç2v—F‚W†6†ævRFF†Ö&²&–6RÂÆ—&–6RÂVç&VÆ—¦VBäÂ’à¢¢6ÆÆVBW&–öF–6ÆÇ’'’F†RVæv–æRÖöæ—F÷&–ærÆö÷à¢¢ð¦W‡÷'B7–æ2gVæ7F–öâ7–æ5v—F„W†6†ævR†6öææV7F–öä–C¢7G&–ærÂW†6†ævT6öææV7F÷#¢ç’“¢&öÖ—6SÇfö–Câ°¢v—B–æ—E&VF—2‚¢6öç7B6Æ–VçBÒvWE&VF—46Æ–VçB‚¢6öç7B7–æ57F'D×2ÒFFRææ÷r‚ ¢òò)H)H7&÷72Ö6ÆÆW"6–ævÆRÖfÆ–v‡BvFRûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òò7–æ5v—F„W†6†ævV†2F‡&VR–æFWVæFVçB6ÆÆW'2–â&öGV7F–öã ¢òòâ&VÇF–ÖU&ö6W76÷"æÖ–&U'VäÆ—fU7–æ2‚’(	BWfW'’#×2†–â×&ö6W70¢òòvFRÆ—fU7–æ4–äfÆ–v‡F6÷fW'26ÖR×&ö6W726öÆÆ—6–öç2öæÇ’¢òò"âö’ö7&öâ÷7–æ2ÖÆ—fR×÷6—F–öç2(	B÷'F&ÆR66†VGVÆW"Âc0¢òò2âö’÷G&FRÖVæv–æR÷&W7VÖR(	BöæR×6†÷Böâ&W7VÖP¢òð¢òòv—F†÷WB&VF—2Ö&6¶VBÆö6²F†R7&öâ·&VÇF–ÖR6â'Vâ–â&ÆÆVÀ¢òòv–ç7BF†R6ÖRW"×÷6—F–öâ7FFR‡7FGW2fÆ—2Â&÷FV7F–öâÐ¢òò÷&FW"Æ6VÖVçBÂW‡FW&æÆÇ’Ö6Æ÷6VBF÷F–öâ(	BÆÂ&7’v†Và¢òòF÷V&ÆVB’âF†R–â×&ö6W72fÆr—2&ö6W72ÖÆö6ÂæBW6VÆW727&÷70¢òò6W'fW&ÆW727&öâ–çfö6F–öâ†—GF–ærF†R6ÖR&VF—22ÆöærÐ¢òò'Vææ–ærVæv–æRà¢òð¢òòÆö6²6VÖçF–73 ¢òò(
"¶W“¢Æ—fU÷7–æ5öÆö6³§¶6öææV7F–öä–GÐ¢òò(
"EDÃ¢32(	BvVæW&÷W2†VG&ööÒ÷fW"F†R7–æ2w2“’'VçF–ÖP¢òòv†–ÆR7F–ÆÂ&VÆV6–ærv—F†–âöæR†V'F&VBv–æF÷r–`¢òòF†R†öÆFW"&ö6W72F–W2Ö–B×7–æ2à¢òò(
"åƒ¢FöÖ–27V—&S²–bÇ&VG’†VÆBvRV&Ç’×&WGW&â2¢òòæòÖ÷‡F†RW†—7F–ær†öÆFW"v–ÆÂf–æ—6‚F†Rv÷&²’à¢òò(
"&VÆV6S¢&W7BÖVff÷'BFVÆ–âF†Rf–æÆÇ’&Æö6²âöâ7&6‚F†P¢òòEDÂ—2F†R6fWG’æWBà¢òð¢òòF†—2—2–çFVçF–öæÆÇ’ÄU527G&–7BF†âF†R&öw&W76–öâÖÆö6°¢òò‡v†–6‚W6W2÷væW%Fö¶Vâ¶Wö6‚’&V6W6R7–æ5v—F„W†6†ævR—0¢òò–FV×÷FVçB(	BÆ÷6–ærÆö6²&VÆV6R§W7B6÷7G2öæR6¶—VB7–æ0¢òòF–6²Âæ÷B6÷''WFVB7FFRà¢6öç7BÄ•dUõ5”ä5ôÄô4µô´U’ÒÆ—fU÷7–æ5öÆö6³¢G¶6öææV7F–öä–GÖ ¢òòEDÂ&VGV6VBg&öÒ32(i"R2à¢òò&F–öæÆS¢7–æ5v—F„W†6†ævR“’6ö×ÆWFW2–âãcÓ“×2†öæRfWF6…÷6—F–öç2°¢òòöæRfWF6„÷Vä÷&FW'2&÷VæB×G&—’â32EDÂÖVçB6ÆÆW'267V×VÆFVB'6¶— ¢òòÖW76vW2BãC×26FVæ6RŒ9sR7–Ö&öÇ2Ò3rãR6¶—Æöw2÷2’f–ÆÆ–ærF†RÆöp¢òòf–ÆRæB7FÆÆ–ær7FF÷WBâR2v—fW2L9r†VG&ööÒ÷fW"“’v†–ÆRÆ–Ö—F–ærÆö6°¢òò7F'fF–öâFòBÖ÷7BR2&F†W"F†â32öâ7&6‚×v—F†÷WB×&VÆV6Rà¢6öç7BÄ•dUõ5”ä5ôÄô4µõEDÅõ4T2ÒP¢òòF‡&÷GFÆRF†R6¶—ÖÆörFòöæ6RW"#2W"6öææV7F–öâFò&WfVçBÆörfÆööF–ærà¢òòF†R6¶——G6VÆb—27F–ÆÂ–FV×÷FVçBÖ6÷'&V7C²F†R÷W&F÷"6VW2F†RÖW76vR@¢òò‡VÖâ×&VF&ÆR&FR–ç7FVBöb‡VæG&VG2W"6V6öæB7&÷72R7–Ö&öÇ2à¢6öç7B4´•ôÄôuô´U’ÒÆ—fU÷7–æ5÷6¶—öÆövvVC¢G¶6öææV7F–öä–GÖ ¢6öç7B7–æ4Æö6µFö¶VâÒ7–æ3¢G·&ö6W72ç–GÓ¢G·7–æ57F'D×7Ó¢G¶ææö–Bƒ"—Ö ¢ÆWBÆö6´7V—&VBÒfÇ6P¢ÆWB7F÷7–æ4Æö6´ÆV6U&Vg&W6ƒ¢‚‚’Óâfö–B’ÂçVÆÂÒçVÆÀ¢–b†6Æ–VçB’°¢G'’°¢6öç7B7V—&U&W7VÇBÒv—B6Æ–VçBç6WB„Ä•dUõ5”ä5ôÄô4µô´U’Â7–æ4Æö6µFö¶VâÂ°¢åƒ¢G'VRÀ¢Uƒ¢Ä•dUõ5”ä5ôÄô4µõEDÅõ4T2À¢Ò¢Æö6´7V—&VBÒ7V—&U&W7VÇBÓÓÒ$ô² ¢–b†Æö6´7V—&VB’°¢7F÷7–æ4Æö6´ÆV6U&Vg&W6‚Ò7F'E&VF—4Æö6´ÆV6U&Vg&W6‚€¢6Æ–VçBÀ¢Ä•dUõ5”ä5ôÄô4µô´U’À¢7–æ4Æö6µFö¶VâÀ¢Ä•dUõ5”ä5ôÄô4µõEDÅõ4T2¢À¢¢Ð¢Ò6F6‚†Æö6´W'"’°¢òò7&÷72×&ö6W72÷væW'6†——2Væ¶æ÷vâv†–ÆR&VF—2—2Væf–Æ&ÆRâæWfW ¢òò&V6öæ6–ÆRW†6†ævR÷6—F–öç2÷"7V&Ö—BÆ–fV7–6ÆR×WFF–öç2v—F†÷W@¢òòF†B÷væW'6†—&ööc²F†RæW‡B†VÇF‡’F–6²v–ÆÂ&WG'’à¢Æöu'VçF–ÖTW'&÷"€¢Æ—fR×7–æ3¢G¶6öææV7F–öä–GÓ¦Æö6²Ö7V—&RÖf–ÆVFÀ¢cóÀ¢G´Äôuõ$Td•‡Ò·7–æ2ÖÆö6µÒ7V—&Rf–ÆVBf÷"G¶6öææV7F–öä–GÒ(	B&V6öæ6–Æ–F–öâ6¶—VB†f–Â6Æ÷6VB“¦À¢Æö6´W'"–ç7Fæ6VöbW'&÷"òÆö6´W'"æÖW76vR¢7G&–ær†Æö6´W'"’À¢¢&WGW&à¢Ð¢–b‚Æö6´7V—&VB’°¢òòF‡&÷GFÆVB6¶—Æös¢VÖ—BBÖ÷7Böæ6RW"#2Fòfö–BfÆööF–ær7FF÷WBà¢G'’°¢6öç7BÆ7DÆövvVBÒv—B6Æ–VçBævWB…4´•ôÄôuô´U’¢–b‚Æ7DÆövvVB’°¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Ò·7–æ2ÖÆö6µÒ6¶—(	Bæ÷F†W"6ÆÆW"—2Ö–B×7–æ2f÷"6öæãÒG¶6öææV7F–öä–GÒ†Æ–¶VÇ’7&öâ·&VÇF–ÖR÷fW&ÆÂ–FV×÷FVçB6¶—–À¢¢v—B6Æ–VçBç6WB…4´•ôÄôuô´U’Â#"Â²Uƒ¢#Ò¢Ð¢Ò6F6‚²ò¢&W7BÖVff÷'B¢òÐ¢&WGW&à¢Ð¢Ð ¢G'’°¢òòW"ÖöFRæWfW"æVVG2âW†6†ævR&V6öæ6–Æ–F–öââÖ÷&R–×÷'FçFÇ’À¢òò&WVFVFÇ’‡–G&F–ærWfW'’6ö×ÆWFRÆ—fR×÷6—F–öâ†6‚&Vf÷&RF†P¢òò&÷VæFVB6–×VÆFVB7FvR—26VÆV7FVBFVfVG2F†B7FvRw2W'÷6S¢v—F€¢òòfWr‡VæG&VB–æFWVæFVçBW"&÷w2Â#ƒ×2F–6²7VçBÖ÷7Böb—G0¢òòF–ÖR¥4ôâ×'6–ærF†Rv†öÆR&öö²ÂWfVâF†÷Vv‚—BöæÇ’ÖævVBöæRf— ¢òò6Æ–6Râ&W6öÇfRF†RW†V7WF–öâÖöFRf—'7BÂF†VâÆWBF†R7FvR66†RÆö@¢òòæB&÷FFRF†R&öö²B—G2öæR×6V6öæB6FVæ6Râ6Æ÷6RõEõ4Âö†öÆB6†V6·0¢òò&VÖ–â–æFWVæFVçBf÷"WfW'’&÷ræBFW&Ö–æÂ6fW2WFFRF†R66†V@¢òò7FvR–ÖÖVF–FVÇ’à¢6öç7BÆ—fUG&FTöâÒv—B—4Æ—fUG&FTVæ&ÆVDf÷$6öææV7F–öâ†6öææV7F–öä–B¢6öç7BÆ–fV7–6ÆU&÷w2ÒÆ—fUG&FTöà¢òµÐ¢¢v—BvWDÆ—fU÷6—F–öç2†6öææV7F–öä–B’æ6F6‚‚‚’ÓâµÒ2Æ—fU÷6—F–öåµÒ¢6öç7B†4÷væVDW†6†ævTÆ–fV7–6ÆRÒÆ–fV7–6ÆU&÷w2ç6öÖR‚‡÷6—F–öâ’Óà¢—4W†6†ævTÆ–fV7–6ÆU÷6—F–öâ‡÷6—F–öâÂ6öææV7F–öä–B’À¢¢–b‚Æ—fUG&FTöâbb†4÷væVDW†6†ævTÆ–fV7–6ÆR’°¢6öç7B6–Õ7VÖÖ'’Òv—B&ö6W756–×VÆFVE÷6—F–öç2†6öææV7F–öä–B¢Æöu'VçF–ÖT–æfò€¢Æ—fS¢G¶6öææV7F–öä–GÓ§7–æ2×6¶—À¢3óÀ¢‚’Óâ°¢6öç7B7FvVE&÷w2Ò‡6–×VÆFVE÷6—F–öå7FvW2ævWB†6öææV7F–öä–B“òç÷6—F–öç2ÇÂµÒ’2Æ—fU÷6—F–öåµÐ¢6öç7B7FGW4'&V¶F÷vâÒ7FvVE&÷w2ç&VGV6R‚†63¢&V6÷&CÇ7G&–ærÂçVÖ&W#âÂ¢Æ—fU÷6—F–öâ’Óâ°¢6öç7B7FGW2Ò7G&–ær‡ç7FGW2ÇÂ'Væ¶æ÷vâ"¢65·7FGW5ÒÒ†65·7FGW5ÒÇÂ’²¢&WGW&â60¢ÒÂ·Ò2&V6÷&CÇ7G&–ærÂçVÖ&W#â¢&WGW&â€¢G´Äôuõ$Td•‡Ò·7–æ2×6¶—Ò6öæãÒG¶6öææV7F–öä–GÒÆ—fU÷G&FSÖfÇ6S²°¢6¶—VB&—fFRW†6†ævR7–æ2ÂG&6¶VCÒG·7FvVE&÷w2æÆVæwF‡ÒÂ°¢6–Õ&ö6W76VCÒG·6–Õ7VÖÖ'’ç&ö6W76VGÒÂ6–Ô6Æ÷6VCÒG·6–Õ7VÖÖ'’æ6Æ÷6VGÒÂ°¢7FGW6W3ÒG´¥4ôâç7G&–æv–g’‡7FGW4'&V¶F÷vâ—Ö ¢¢ÒÀ¢¢&WGW&à¢Ð¢–b‚Æ—fUG&FTöâ’°¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Ò·7–æ5ÒVçG'’W&Ö—76–öâ—2öfc²6öçF–çV–ærW†6†ævRÆ–fV7–6ÆR7–æ2f÷"°¢G¶Æ–fV7–6ÆU&÷w2æf–ÇFW"‚‡÷6—F–öâ’Óâ—4W†6†ævTÆ–fV7–6ÆU÷6—F–öâ‡÷6—F–öâÂ6öææV7F–öä–B’’æÆVæwF‡Ò7—7FVÒÖ÷væVB÷6—F–öâ‡2–À¢¢Ð ¢òò&Wf–÷W6Ç’V6‚7FGW2f–ÇFW"G&–vvW&VBgVÆÂvWDÆ—fU÷6—F–öç2‚’66âÀ¢òòÖVæ–ærvRfWF6†VBF†R6ÖR÷Vâ×÷6—F–öç2–æFW‚g&öÒ&VF—2dõU"F–ÖW0¢òò§W7BFò'V6¶WB'’7FGW2âÆöBöæ6RÂF†Vâf–ÇFW"–âÖVÖ÷'’à¢6öç7BÆöFVD÷Vå&÷w2ÒÆ—fUG&FTöâòv—BvWDÆ—fU÷6—F–öç2†6öææV7F–öä–B’¢Æ–fV7–6ÆU&÷w0¢òò7F÷&vRFFW'2æBöÆFW"6æ6†÷G2Ö’7W&f6RÖ—76–ærÆ—7B0¢òòVæFVf–æVBWfVâF†÷Vv‚F†RG—VB6öçG&7B—2â'&’â&V6öæ6–Æ–F–öâ—0¢òòf–ÂÖ6Æ÷6VBæB–FV×÷FVçC¢â'6VçB&öö²ÖVç2¦W&ò&÷w2ÂæWfW"à¢òòW†6WF–öâÆö÷F†B6â7F'fRF†RVæv–æRÖöæ—F÷"à¢6öç7BÆÄ÷Vå&rÒ„'&’æ—4'&’†ÆöFVD÷Vå&÷w2’òÆöFVD÷Vå&÷w2¢µÒ’2Æ—fU÷6—F–öåµÐ ¢òòæWfW"G'W7BF†R6öææV7F÷"7WÆ–VB'’vVæW&–2Væv–æRö7&öâ6ÆÆW"f÷ ¢òòâ÷væVBF—&V7BÆ–fV7–6ÆRâvÆö&ÂW"ÖöFR–çFVçF–öæÆÇ’66†W2¢òò6–×VÆFVD6öææV7F÷"VæFW"F†Ræ÷&ÖÂ6öææV7F–öâ¶W“²&WÆ6R—Bv—F‚F†P¢òò6W&FVÇ’66†VBæBVçf—&öæÖVçB×&÷fVBƒ"&öBÕe5B6öææV7F÷"&Vf÷&P¢òòç’W†6†ævR6æ6†÷BÂ&÷FV7F–öâÂ6æ6VÆÆF–öâÂ÷"6Æ÷6R÷W&F–öâà¢W†6†ævT6öææV7F÷"Òv—B&W6öÇfTF—&V7EG&FTÆ–fV7–6ÆT6öææV7F÷"€¢6öææV7F–öä–BÀ¢ÆÄ÷Vå&rÀ¢W†6†ævT6öææV7F÷"À¢¢–b†W†6†ævT6öææV7F÷"bbG—VöbW†6†ævT6öææV7F÷"ævWD&Ææ6RÓÓÒ&gVæ7F–öâ"’°¢v—BÖöæ—F÷$6öææV7F–öäÖ&v–ä6ÆÂ†6öææV7F–öä–BÂW†6†ævT6öææV7F÷"Â²7F'E6W76–öã¢G'VRÒ¢Ð ¢òò)H)H6VÆbÖ†VÃ¢W&vRFW&Ö–æÂ÷6—F–öç27GV6²–âF†R÷Vâ–æFW‚)H)H)H)H)H ¢òò†—7F÷&–6Â'Vr–â&VF—2ÖF"6fU÷6—F–öâ‚’&RÖFFVB&V¦V7FVBö6æ6VÆÆVBð¢òòW'&÷"÷6—F–öç2FòF†R÷Vâ–æFW‚öâWfW'’6fRÂ6ò7FÆRFW&Ö–æÀ¢òòVçG&–W26âW'6—7B–æFVf–æ—FVÇ’†ö'6W'fVC¢b'&V¦V7FVB"&R×7–æ6V@¢òòWfW'’F–6²’âÖ÷fRF†VÒFòF†R6Æ÷6VB&6†—fR†W&R6òF†R7–æ2Æö÷ ¢òòöæÇ’WfW"&ö6W76W2vVçV–æVÇ’Æ—fR÷6—F–öç2à¢6öç7BDU$Ô”äÅõ5”ä5õ5DEU4U2ÒæWr6WB…²&6Æ÷6VB"Â'&V¦V7FVB"Â&6æ6VÆÆVB"Â&6æ6VÆVB"Â&W‡—&VB"Â&W'&÷"%Ò¢6öç7B7GV6µFW&Ö–æÂÒÆÄ÷Vå&ræf–ÇFW"‚‡’ÓâDU$Ô”äÅõ5”ä5õ5DEU4U2æ†2…7G&–ær‡ç7FGW2’’¢–b‡7GV6µFW&Ö–æÂæÆVæwF‚â’°¢G'’°¢6öç7B÷Vä–æFW„¶W’ÒÆ—fS§÷6—F–öç3¢G¶6öææV7F–öä–GÖ ¢6öç7B6Æ÷6VD–æFW„¶W’ÒÆ—fS§÷6—F–öç3¢G¶6öææV7F–öä–GÓ¦6Æ÷6VF ¢ÆWBæWvÇ”Ö÷fVBÒ ¢v—B&öÖ—6RæÆÂ€¢7GV6µFW&Ö–æÂæÖ†7–æ2‡’Óâ°¢6öç7BÇ&VG’Òv—B6Æ–VçBæÇ÷2†6Æ÷6VD–æFW„¶W’Âæ–B’æ6F6‚‚‚’ÓâçVÆÂ¢–b†Ç&VG’ÓÓÒçVÆÂÇÂÇ&VG’ÓÓÒVæFVf–æVB’°¢v—BÖ÷fU&VF—4Æ—7DÖVÖ&W'6†—Fô†VB€¢6Æ–VçBÀ¢÷Vä–æFW„¶W’À¢6Æ÷6VD–æFW„¶W’À¢æ–BÀ¢¢æWvÇ”Ö÷fVB²°¢ÒVÇ6R°¢v—B6Æ–VçBæÇ&VÒ†÷Vä–æFW„¶W’ÂÂæ–B’æ6F6‚‚‚’Óâ¢Ð¢Ò’À¢¢òòöæÇ’Æörv†Vâ÷6—F–öç2&RæWvÇ’Ö÷fVB(	B7W&W72&WWF—F—fRæö—6Rv†Và¢òòF†R6ÖRFW&Ö–æÂ÷6—F–öç2V"–âF†R÷Vâ–æFW‚WfW'’7–6ÆP¢òò†Rærâ&VF—26æ6†÷B&W7F÷&VB7FÆR÷VâÖ–æFW‚VçG&–W2F†B&RÇ&VG¢òò–âF†R6Æ÷6VBÆ—7C²F†W’&R6fRFò6–ÆVçFÇ’F—66&B’à¢–b†æWvÇ”Ö÷fVBâ’°¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Ò·7–æ2×F–6µÒW&vVBG¶æWvÇ”Ö÷fVGÒFW&Ö–æÂ÷6—F–öâ‡2’7GV6²–â÷Vâ–æFW‚f÷"G¶6öææV7F–öä–GÖÀ¢¢Ð¢Ò6F6‚²ò¢&W7BÖVff÷'B6VÆbÖ†VÂ¢òÐ¢Ð¢6öç7B–çfÆ–DF—&V7F–öå÷6—F–öç3¢Æ—fU÷6—F–öåµÒÒµÐ¢6öç7BÆÄ÷VâÒÆÄ÷Vå&ræf–ÇFW"‚‡’Óâ°¢–b…DU$Ô”äÅõ5”ä5õ5DEU4U2æ†2…7G&–ær‡ç7FGW2’’’&WGW&âfÇ6P¢6öç7BF—&V7F–öâÒ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ‡¢–b‚F—&V7F–öâ’°¢ç7FGW5&V6öâÒ'7–æ5ö&Æö6¶VEö–çfÆ–EöF—&V7F–öâ ¢W6…7FW‡Â'7–æ5öF—&V7F–öåöwV&B"ÂfÇ6RÂ$æòW‡Æ–6—BÆöær÷6†÷'BF—&V7F–öã²fVçVR×WFF–öç2&R&Æö6¶VB"¢–çfÆ–DF—&V7F–öå÷6—F–öç2çW6‚‡¢&WGW&âfÇ6P¢Ð¢æF—&V7F–öâÒF—&V7F–öà¢ç6–FRóóÒF—&V7F–öà¢&WGW&âG'VP¢Ò¢–b†–çfÆ–DF—&V7F–öå÷6—F–öç2æÆVæwF‚â’°¢v—B&öÖ—6RæÆÂ†–çfÆ–DF—&V7F–öå÷6—F–öç2æÖ‚‡÷6—F–öâ’Óâ6fU÷6—F–öâ‡÷6—F–öâ’æ6F6‚‚‚’Óâ·Ò’’¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&W'&÷""À¢G¶–çfÆ–DF—&V7F–öå÷6—F–öç2æÆVæwF‡ÒÆ—fR÷6—F–öâ‡2’V&çF–æVBGW&–ær7–æ3¢–çfÆ–BF—&V7F–öæÀ¢²÷6—F–öä–G3¢–çfÆ–DF—&V7F–öå÷6—F–öç2æÖ‚‡÷6—F–öâ’Óâ÷6—F–öâæ–B’ÒÀ¢’æ6F6‚‚‚’Óâ·Ò¢Ð ¢6öç7B÷Vå÷6—F–öç2ÒÆÄ÷Vâæf–ÇFW"€¢‡’Óâç7FGW2ÓÓÒ&÷Vâ"ÇÂç7FGW2ÓÓÒ&f–ÆÆVB"ÇÂç7FGW2ÓÓÒ''F–ÆÇ•öf–ÆÆVB"ÇÂç7FGW2ÓÓÒ'Æ6VB"ÇÂç7FGW2ÓÓÒ'VæF–ær"ÇÂç7FGW2ÓÓÒ'VæF–æuöf–ÆÂ"ÇÂç7FGW2ÓÓÒ'Æ6VE÷Væ6öæf—&ÖVB"ÇÂç7FGW2ÓÓÒ&6Æ÷6–ær"ÇÂç7FGW2ÓÓÒ&6Æ÷6–æu÷'F–Â"À¢ ¢òò)H)H&F6‚&RÖÆö÷fWF6†W2–â&ÆÆVÂ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞ)H ¢òòF‡&VR–æFWVæFVçB’ôò6ÆÇ2&RæVVFVB&Vf÷&RF†RW"×÷6—F–öâÆö÷ ¢òòâvWE÷6—F–öç2‚’(	BW†6†ævR÷6—F–öâÆ—7B†F÷F–öâ²Ö¢òò"âvWD÷Vä÷&FW'2‚’(	BÆ—fR÷&FW"–B6WBf÷"Æ—fVæW72fW&–f–6F–öà¢òò2âvWD6Æ÷6VDÆ—fU÷6—F–öç2ƒS’(	B&V6VçB6Æ÷6W2f÷"÷'†âwV&@¢òð¢òò&Wf–÷W6Ç’F†W6R&â6W&–ÆÇ’FF–ærã<9r%EBFòWfW'’F–6²à¢òò'Vææ–ærF†VÒ–â6–ævÆR&öÖ—6RæÆÂ6öÆÆ6W2Fò9r%EBà¢òòvWE÷6—F–öç2—2Ç6òFVGWÆ–6FVB(	B—Bv2&Wf–÷W6Ç’6ÆÆVBEt”4P¢òò†öæ6Rf÷"F÷F–öâÂöæ6Rf÷"F†RW†6†ævRÖ’à¢ÆWBW†6†ævU÷6—F–öç4f÷$F÷F–öã¢ç•µÒÒµÐ¢ÆWBW†6†ævU÷6—F–öç56æ6†÷Dö²ÒfÇ6P¢ÆWBÆ—fT÷&FW$–G57–æ3¢6WCÇ7G&–æsâÂçVÆÂÒçVÆÀ¢ÆWB&V6VçFÇ”6Æ÷6VDf÷$÷'†äwV&C¢Æ—fU÷6—F–öåµÒÒµÐ ¢v—B&öÖ—6RæÆÅ6WGFÆVB…°¢òòâW†6†ævR÷6—F–öç2‡&WW6VBf÷"F÷F–öâäBW"×÷6—F–öâÖ’à¢†7–æ2‚’Óâ°¢–b†W†6†ævT6öææV7F÷"bbG—VöbW†6†ævT6öææV7F÷"ævWE÷6—F–öç2ÓÓÒ&gVæ7F–öâ"’°¢G'’°¢6öç7B6æ6†÷BÒv—Bv—F…F–ÖV÷WB€¢W†6†ævT6öææV7F÷"ævWE÷6—F–öç2‚’2&öÖ—6SÆç•µÓâÀ¢U„4„ätUõD”ÔTõUEôtUEõõ4•D”ôå5ôÕ2À¢&vWE÷6—F–öç2‡7–æ2×&VfWF6‚’"À¢¢W†6†ævU÷6—F–öç4f÷$F÷F–öâÒ'&’æ—4'&’‡6æ6†÷B’ò6æ6†÷B¢µÐ¢6öç7B6æ6†÷E7FGW2ÒG—VöbW†6†ævT6öææV7F÷"ævWDÆ7E÷6—F–öç56æ6†÷E7FGW2ÓÓÒ&gVæ7F–öâ ¢òW†6†ævT6öææV7F÷"ævWDÆ7E÷6—F–öç56æ6†÷E7FGW2‚¢¢²ö³¢'&’æ—4'&’‡6æ6†÷B’Ð¢W†6†ævU÷6—F–öç56æ6†÷Dö²Ò6æ6†÷E7FGW2æö²ÓÓÒG'VP¢Ò6F6‚°¢W†6†ævU÷6—F–öç56æ6†÷Dö²ÒfÇ6P¢Ð¢Ð¢Ò’‚’À¢òò"â÷Vâ÷&FW'26æ6†÷Bf÷"Æ—fVæW72fW&–f–6F–öâà¢†7–æ2‚’Óâ°¢Æ—fT÷&FW$–G57–æ2Òv—BfWF6„Æ—fT÷&FW$–E6WB†W†6†ævT6öææV7F÷"¢Ò’‚’À¢òò2â&V6VçFÇ’Ö6Æ÷6VB÷6—F–öç2f÷"÷'†âÖF÷F–öâwV&Bà¢†7–æ2‚’Óâ°¢G'’°¢&V6VçFÇ”6Æ÷6VDf÷$÷'†äwV&BÒv—BvWD6Æ÷6VDÆ—fU÷6—F–öç2†6öææV7F–öä–BÂS’æ6F6‚‚‚’ÓâµÒ2Æ—fU÷6—F–öåµÒ¢Ò6F6‚²ò¢&W7BÖVff÷'B¢òÐ¢Ò’‚’À¢Ò ¢òò)H)Hö'6W'f&–Æ—G’†V'F&VB)H)H)H)H)H)H)HûûÞûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞûûÞ)H)H)H)H)H)H ¢òò&Wf–÷W6Ç’F†—2gVæ7F–öâ&â6–ÆVçFÇ’v†VâF†W&RvW&R¦W&ð¢òòG&6¶VB÷6—F–öç2õ"v†VâWfW'’÷6—F–öâv2–â&Fòæ÷F†–ær ¢òò7FFR(	B&öGV6–ærF†R÷W&F÷"w2&÷&FW'2æ÷B6Æ÷6–ærÂæòÆöw2 ¢òò7–×FöÒâÇv—2VÖ—BöæRÖÆ–æR'&V¶F÷vâöbv†BF†R6Æ÷6R×6–FP¢òò—VÆ–æR—26VV–ær6òF†R÷W&F÷"6âF—7F–æwV—6ƒ ¢òò†’7–æ2—6âwB'Vææ–ærBÆÂ†æòÆörÒ6ÆÆW"F‡&÷GFÆVBòW6VB¢òò†"’7–æ2—2'Vææ–ær'WBf–æG2æ÷F†–ærFò7Böà¢òò†2’7–æ2—2'Vææ–æræB&ö6W76–ær÷6—F–öç2–â¶æ÷vâ7FGW0¢òòF‡&÷GFÆVBFòã2öbW6VgVÂFWF–Â6òvRFöâwBfÆööBÆöw2@¢òò7FVG’7FFS²F†RW"×÷6—F–öâ'&æ6†W2&VÆ÷r7F–ÆÂÆörF†V— ¢òò–æF—f–GVÂFV6—6–öç2à¢6öç7B7FGW4'&V¶F÷vâÒÆÄ÷Vâç&VGV6SÅ&V6÷&CÇ7G&–ærÂçVÖ&W#ãâ‚†62Â’Óâ°¢6öç7B2Ò7G&–ær‡ç7FGW2ÇÂ'Væ¶æ÷vâ"¢65·5ÒÒ†65·5ÒÇÂ’²¢&WGW&â60¢ÒÂ·Ò¢6öç7BÆ6VD6÷VçBÒ‡7FGW4'&V¶F÷vâçÆ6VBÇÂ’²‡7FGW4'&V¶F÷vâçVæF–ærÇÂ’²‡7FGW4'&V¶F÷vâçVæF–æuöf–ÆÂÇÂ’²‡7FGW4'&V¶F÷vâçÆ6VE÷Væ6öæf—&ÖVBÇÂ¢6öç7B6–Ô6÷VçBÒ7FGW4'&V¶F÷vâç6–×VÆFVBÇÂ ¢6öç7BF÷FÄÆ—fRÒ÷Vå÷6—F–öç2æf–ÇFW"‚‡’Óâç7FGW2ÓÒ'Æ6VB"bbç7FGW2ÓÒ'VæF–æuöf–ÆÂ"bbç7FGW2ÓÒ'Æ6VE÷Væ6öæf—&ÖVB"’æÆVæwF€¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Ò·7–æ2×F–6µÒ6öæãÒG¶6öææV7F–öä–GÒG&6¶VCÒG¶ÆÄ÷VâæÆVæwF‡Ò÷VãÒG·F÷FÄÆ—fWÒÆ6VCÒG·Æ6VD6÷VçGÒ6–×VÆFVCÒG·6–Ô6÷VçGÒ7FGW6W3ÒG´¥4ôâç7G&–æv–g’‡7FGW4'&V¶F÷vâ—ÖÀ¢ ¢òò)H)H6–×VÆFVB×÷6—F–öâ7vVW‡W"ÖÖöFR²—5öÆ—fU÷G&FSÖfÇ6R’)H)H)H)H)H ¢òò6–×VÆFVB÷6—F–öç2FöâwBF÷V6‚F†RW†6†ævRÂ6òvR6ææ÷BW6RF†P¢òòW†6†ævR×÷6—F–öâÖ÷"ç’W†6†ævT6öææV7F÷"6ÆÇ2Fò6Æ÷6P¢òòF†VÒâ&ö6W72F†VÒ–æÆ–æRW6–ær&VF—2Ö&¶WEöFFF–6·2(	BF†—0¢òò—2F†RF‚F†B&Wf–÷W6Ç’ÆVgB6–×VÆFVB÷&FW'2÷Vâf÷&WfW ¢òò&V6W6RWfW'’÷F†W"6Æ÷6R'&æ6‚–âF†—2gVæ7F–öâvFW2öà¢òòW†6†ævR×6–FRFFà¢òð¢òòvRFò—B$Tdõ$RF†R’Ö¶W’vFR–ç6–FRÖ–&U'VäÆ—fU7–æ2‡F†P¢òò6ÆÆW"’'’Ç6òW‡÷6–ær7FæFÆöæR&ö6W756–×VÆFVE÷6—F–öç6 ¢òò†VÇW"â¶VW–ærÆ–v‡GvV–v‡B6÷’†W&RÖ¶W2F†RVæv–æRw0¢òòW†6†ævR×6–FR7–æ26VÆbÖ6öçF–æVBf÷"6öææV7F–öç2F†BDò†fP¢òò’¶W—2(	B6–×VÆFVB÷6—F–öç2öâF†÷6R6öææV7F–öç2‡W6V@¢òòÆ—fR×G&FRÂÖ—†VBÖöFR’7F–ÆÂvWB6Æ÷6RF‚öâF†R6ÖRF–6²à¢°¢6öç7B6–×2ÒÆÄ÷Vâæf–ÇFW"€¢‡’Óâç7FGW2ÓÓÒ'6–×VÆFVB"bb‡æW†V7WFVEVçF—G’óò’âÀ¢¢–b‡6–×2æÆVæwF‚â’°¢òòVÆÂÆÂ7W'&VçB&–6W2–âöæR&ÆÆVÂfâÖ÷WB(	B–æFWVæFVç@¢òò&VF—2&VG2†öæRW"Væ—VR7–Ö&öÂ’âc27FÆRfÆÆ&6²Fð¢òòfW&vTW†V7WF–öå&–6R¶VW2Ö—76–ærF–6²g&öÒ&Æö6¶–ær6Æ÷6Rà¢6öç7BVæ—VU7–×2Ò'&’æg&öÒ†æWr6WB‡6–×2æÖ‚‡’Óâç7–Ö&öÂ’’¢6öç7B&–6TÖÒæWrÖÇ7G&–ærÂçVÖ&W#â‚¢v—B&öÖ—6RæÆÂ€¢Væ—VU7–×2æÖ†7–æ2‡7–Ò’Óâ°¢6öç7B‚Òv—BfWF6„7W'&VçE&–6R‡7–ÒÂ6öææV7F–öä–B’æ6F6‚‚‚’Óâ¢–b‡‚â’&–6TÖç6WB‡7–ÒÂ‚¢Ò’À¢¢f÷"†6öç7B÷2öb6–×2’°¢G'’°¢6öç7BÖ&µ&–6RÒ&–6TÖævWB‡÷2ç7–Ö&öÂ’ÇÂ÷2æfW&vTW†V7WF–öå&–6RÇÂ ¢–b†Ö&µ&–6Râ’°¢÷2æW†6†ævTFFÒ°¢ââç÷2æW†6†ævTFFÀ¢Ö&µ&–6RÀ¢7–æ6VDC¢FFRææ÷r‚’À¢Ð¢6öç7B7&÷76VBÒv—B6†V6´æDf÷&6T6Æ÷6Töå6ÇG7&÷72€¢6öææV7F–öä–BÀ¢÷2À¢Ö&µ&–6RÀ¢çVÆÂÂòò6–×VÆFVC¢6¶—W†6†ævR÷2–â6Æ÷6P¢¢–b†7&÷76VB’6öçF–çVP¢Ð¢òòÖ‚Ö†öÆB6fWG’6Æ÷6W"‡&ÆÆVÂFòF†R&VÂ×÷6—F–öâF‚’à¢6öç7BÔ…ô„ôÄEõD”ÔUôÕ2Ò&W6öÇfTÖ„†öÆD×2†6öææV7F–öä–B¢6öç7B÷VæVDBÒ÷2æ7&VFVDBÇÂ÷2çWFFVDBÇÂ ¢6öç7B†VÆD×2ÒFFRææ÷r‚’Ò÷VæVD@¢–b€¢Ô…ô„ôÄEõD”ÔUôÕ2âb`¢†VÆD×2âÔ…ô„ôÄEõD”ÔUôÕ2b`¢—57—7FVÕG&6¶VDÆ—fU÷6—F–öâ‡÷2Â6öææV7F–öä–B’b`¢‡÷2æW†V7WFVEVçF—G’óò’â ¢’°¢6öç7BW†—E&–6RÒÖ&µ&–6RÇÂ÷2æfW&vTW†V7WF–öå&–6RÇÂ÷2æVçG'•&–6P¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢'v&æ–ær"À¢Ö‚†öÆBF–ÖRW†6VVFVBf÷"6–×VÆFVBG·÷2ç7–Ö&öÇÒ(	Bf÷&6RÖ6Æ÷6–ævÀ¢²÷6—F–öä–C¢÷2æ–BÂ†VÆD×2ÂÖ„†öÆD×3¢Ô…ô„ôÄEõD”ÔUôÕ2ÂW†—E&–6RÒÀ¢¢v—B6Æ÷6TÆ—fU÷6—F–öâ†6öææV7F–öä–BÂ÷2æ–BÂW†—E&–6RÂçVÆÂÂ&Ö…ö†öÆE÷F–ÖUöW†6VVFVB"¢6öçF–çVP¢Ð¢òòW'6—7B&Vg&W6†VBÖ&²&–6R6òF†RF6†&ö&B&VG2—Bà¢–b†Ö&µ&–6Râ’°¢v—B6fU÷6—F–öâ‡÷2¢Ð¢Ò6F6‚‡6–ÔW'"’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò6–×VÆFVB×F–6²W'&÷"f÷"G·÷2æ–GÓ¦À¢6–ÔW'"–ç7Fæ6VöbW'&÷"ò6–ÔW'"æÖW76vR¢7G&–ær‡6–ÔW'"’À¢¢Ð¢Ð¢Ð¢Ð ¢–b‚W†6†ævU÷6—F–öç56æ6†÷Dö²’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡ÒW†6†ævR÷6—F–öç26æ6†÷Bv2æ÷BWF†÷&—FF—fRf÷"G¶6öææV7F–öä–GÓ²6¶—–ærF÷F–öâÂW‡FW&æÂÖ6Æ÷6RÂæBVçF—G’×WFF–öæÀ¢¢&WGW&à¢Ð ¢òòûûÞûûÞ)HW†6†ævRÖ÷'†âF÷F–öâ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞûûÞ)H)H)H)H)H)H)H)H ¢òòW†6†ævU÷6—F–öç4f÷$F÷F–öæv2Ç&VG’fWF6†VB–âF†R&ÆÆVÀ¢òò&VfWF6‚&÷fR(	Bæò6V6öæBvWE÷6—F–öç2‚’6ÆÂæVVFVB†W&Rà¢òòÆ–2—B6òF†RF÷F–öâ&Æö6²w2f&–&ÆRæÖW2&RVæ6†ævVBà¢6öç7BW†6†ævU÷6—F–öç2ÒW†6†ævU÷6—F–öç4f÷$F÷F–öà¢ÆWBF÷FVD6÷VçBÒ ¢–b†W†6†ævT6öææV7F÷"bb'&’æ—4'&’†W†6†ævU÷6—F–öç4f÷$F÷F–öâ’bbW†6†ævU÷6—F–öç4f÷$F÷F–öâæÆVæwF‚â’°¢–b‡G'VR’²òòwV&BÇ&VG’Æ–VB&÷fP¢òò'V–ÆB6WBöb‡7–Ö&öÇÆF—&V7F–öâ’¶W—2vRÇ&VG’G&6²–âç¢òò7FGW2(	B–æ6ÇVF–ærFW&Ö–æÂöæW2(	B6òvRFöâwB&RÖF÷B¢òò÷6—F–öâF†Bv2§W7B6Æ÷6VB'WBF†RW†6†ævR†6âwB–W@¢òò&VfÆV7FVBF†R6Æ÷6R†fWr×6V6öæBÆr—2æ÷&ÖÂ’à¢6öç7Bæ÷&Õ7–ÒÒ‡&s¢7G&–ær’Óâ7G&–ær‡&rÇÂ""’çFõWW$66R‚’ç&WÆ6R‚õ²ÕõÒörÂ""¢6öç7BG&6¶VD¶W—2ÒæWr6WCÇ7G&–æsâ‚¢f÷"†6öç7BöbÆÄ÷Vâ’°¢G&6¶VD¶W—2æFB†G¶æ÷&Õ7–Ò‡ç7–Ö&öÂ—×ÂG·æF—&V7F–öçÖ¢Ð¢òòW6RF†R&RÖfWF6†VB&V6VçBÖ6Æ÷6W2Æ—7B†fWF6†VB–â&ÆÆVÀ¢òò&÷fR’6òvRFöâwB—77VRæ÷F†W"&VF—2&÷VæB×G&—†W&Rà¢f÷"†6öç7Böb&V6VçFÇ”6Æ÷6VDf÷$÷'†äwV&B’°¢6öç7B6Æ÷6VDvô×2ÒFFRææ÷r‚’Ò‡æ6Æ÷6VDBÇÂ¢6öç7BF—&V7F–öâÒ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ‡¢òòv—F†–âc2öb6Æ÷6R(	BW†6†ævRÖ’7F–ÆÂ&W÷'B÷6—F–öà¢òòVçF–ÂF†R6Æ÷6Rf–ÆÂ&÷vFW2âgFW"F†Bv–æF÷rG&V@¢òò—B2G'VÇ’6Æ÷6VBæB÷'†âÖF÷B–b—B&VV'2à¢–b†6Æ÷6VDvô×2ÂcóbbF—&V7F–öâ’°¢G&6¶VD¶W—2æFB†G¶æ÷&Õ7–Ò‡ç7–Ö&öÂ—×ÂG¶F—&V7F–öçÖ¢Ð¢Ð ¢òòÆöBFVfVÇB4ÂõEW&6VçFvW2öæ6Rf÷"ÆÂF÷F–öç2à¢ÆWBFVfVÇE6Å7BÒ¢ÆWBFVfVÇEG7BÒ ¢G'’°¢6öç7BG&F–æu6WGF–æw2Ò†v—B6Æ–VçBæ†vWFÆÂ‚'6WGF–æw3§G&F–ær"’’ÇÂ·Ð¢6öç7B6Å&rÒ'6TfÆöB…7G&–ær‚‡G&F–æu6WGF–æw22ç’’æFVfVÇE÷7F÷öÆ÷75÷W&6VçBóò#"’¢6öç7BG&rÒ'6TfÆöB…7G&–ær‚‡G&F–æu6WGF–æw22ç’’æFVfVÇE÷F¶U÷&öf—E÷W&6VçBóò#""’¢–b„çVÖ&W"æ—4f–æ—FR‡6Å&r’bb6Å&râ’FVfVÇE6Å7BÒæ÷&ÖÆ—¦U7F÷Æ÷75W&6VçB‡6Å&r’çfÇVP¢–b„çVÖ&W"æ—4f–æ—FR‡G&r’bbG&râ’FVfVÇEG7BÒG&p¢Ò6F6‚²ò¢W6RFVfVÇG2¢òÐ ¢f÷"†6öç7BW…÷2öbW†6†ævU÷6—F–öç4f÷$F÷F–öâ’°¢G'’°¢òòFòæ÷BF÷B÷"×WFFRÖçVÂöf÷&V–vâW†6†ævR÷6—F–öç2à¢òòF÷F–öâ—2öæÇ’6fRf÷"÷6—F–öç26''––ærF†—2w0¢òò7—7FVÒ–BäBF†RÖF6†–ær6öææV7F–öâ–Bà¢–b‚—57—7FVÕG&6¶VDÆ—fU÷6—F–öâ†W…÷2Â6öææV7F–öä–B’’6öçF–çVP ¢6öç7B&u7–ÒÒ7G&–ær†W…÷2ç7–Ö&öÂÇÂ†W…÷22ç’’å7–Ö&öÂÇÂ""¢6öç7B7–ÒÒæ÷&Õ7–Ò‡&u7–Ò¢–b‚7–Ò’6öçF–çVP¢6öç7B6–væVE6—¦RÒ'6TfÆöB…7G&–ær†W…÷2ç6—¦Róò†W…÷22ç’’ç÷6—F–öä×BóòW…÷2çVçF—G’óò#"’¢6öç7B6—¦RÒÖF‚æ'2‡6–væVE6—¦R¢–b‚6—¦RÇÂ6—¦RÃÒ’6öçF–çVP¢òòFWFW&Ö–æRF—&V7F–öââ&–æu‚&WGW&ç2$Äôär"ò%4„õ%B"–à¢òò÷6—F–öå6–FV²6öÖRfVçVW2Væ6öFRf–6–væVB6—¦Rà¢6öç7BF—&V7F–öâÒæ÷&ÖÆ—¦TW†6†ævU÷6—F–öäF—&V7F–öâ€¢†W…÷22ç’’ç÷6—F–öå6–FRÀ¢W…÷2ç6–FRÀ¢6–væVE6—¦RÀ¢¢–b‚F—&V7F–öâ’6öçF–çVP ¢6öç7BÖ¶W’ÒG·7–××ÂG¶F—&V7F–öçÖ ¢–b‡G&6¶VD¶W—2æ†2†Ö¶W’’’6öçF–çVRòòÇ&VG’G&6¶V@¢òòõ%„â(	BF÷B—Bà¢6öç7BVçG'•&–6RÒ'6TfÆöB€¢7G&–ær†W…÷2æVçG'•&–6Róò†W…÷22ç’’æfu&–6RóòW…÷2æÖ&µ&–6Róò#"’À¢’ÇÂ'6TfÆöB…7G&–ær†W…÷2æÖ&µ&–6Róò#"’’ÇÂ ¢–b‚VçG'•&–6RÇÂVçG'•&–6RÃÒ’6öçF–çVP¢6öç7BÖ&µ&–6RÒ'6TfÆöB…7G&–ær†W…÷2æÖ&µ&–6RóòVçG'•&–6R’’ÇÂVçG'•&–6P¢6öç7BÆWfW&vRÒÖF‚æÖ‚ƒÂ'6TfÆöB…7G&–ær†W…÷2æÆWfW&vRóò#"’’ÇÂ¢6öç7Bæ÷F–öæÂÒ6—¦R¢VçG'•&–6P¢6öç7BÖ&v–åG—S¢&7&÷72"Â&—6öÆFVB"Ð¢7G&–ær†W…÷2æÖ&v–åG—Róò&—6öÆFVB"’çFôÆ÷vW$66R‚’æ–æ6ÇVFW2‚&7&÷72"’ò&7&÷72"¢&—6öÆFVB  ¢6öç7BF÷FVD–BÒÆ—fS¢G¶6öææV7F–öä–GÓ¦F÷FVC¢G·7–×Ó¢G¶F—&V7F–öçÓ¢G´FFRææ÷r‚—Ó¢G¶ææö–Bƒ‚—Ö ¢6öç7BF÷FVC¢Æ—fU÷6—F–öâÒ°¢–C¢F÷FVD–BÀ¢6öææV7F–öä–BÀ¢7—7FVÕ÷G&6¶–æuö–C¢7G&–ær†W…÷2ç7—7FVÕ÷G&6¶–æuö–Bóò†W…÷22ç’’ç7—7FVÕG&6¶–æt–Bóò""’À¢6öææV7F–öå÷G&6¶–æuö–C¢7G&–ær†W…÷2æ6öææV7F–öå÷G&6¶–æuö–Bóò†W…÷22ç’’æ6öææV7F–öåG&6¶–æt–Bóò""’À¢7–Ö&öÃ¢7–ÒÀ¢F—&V7F–öâÀ¢&VÅ÷6—F–öä–C¢F÷FVD–BÂòò6VÆb×&VfW&Væ6R(	Bæò&VÂ×7FvR&Vç@¢VçF—G“¢6—¦RÀ¢W†V7WFVEVçF—G“¢6—¦RÀ¢&VÖ–æ–æuVçF—G“¢À¢VçG'•&–6RÀ¢fW&vTW†V7WF–öå&–6S¢VçG'•&–6RÀ¢föÇVÖUW6C¢æ÷F–öæÂÀ¢ÆWfW&vRÀ¢Ö&v–åG—RÀ¢7F÷Æ÷73¢FVfVÇE6Å7BÀ¢F¶U&öf—C¢FVfVÇEG7BÀ¢76–væVE7F÷Æ÷73¢FVfVÇE6Å7BÀ¢76–væVEF¶U&öf—C¢FVfVÇEG7BÀ¢7FGW3¢&÷Vâ"ÂòòW†6†ævR6öæf—&×2F†Rf–ÆÂ(	B7F'B–â&÷Vâ ¢7FGW5&V6öã¢&F÷FVEög&öÕöW†6†ævR"À¢f–ÆÇ3¢°¢°¢F–ÖW7F×¢FFRææ÷r‚’À¢VçF—G“¢6—¦RÀ¢&–6S¢VçG'•&–6RÀ¢fVS¢À¢fVT76WC¢""À¢ÒÀ¢ÒÀ¢W†6†ævTFF¢°¢Ö&µ&–6RÀ¢Æ—V–FF–öå&–6S¢'6U&VF—4f–æ—FTçVÖ&W"†W…÷2æÆ—V–FF–öå&–6R’À¢Vç&VÆ—¦VEäÃ¢'6U&VF—4f–æ—FTçVÖ&W"†W…÷2çVç&VÆ—¦VE&öf—BóòW…÷2çVç&VÆ—¦VEæÂ’À¢7–æ6VDC¢FFRææ÷r‚’À¢ÒÀ¢&öw&W76–öã¢°¢°¢7FW¢&F÷B"À¢F–ÖW7F×¢FFRææ÷r‚’À¢7V66W73¢G'VRÀ¢FWF–Ç3¢F÷FVB7—7FVÒ×G&6¶VBW†6†ævR÷6—F–öâ6—¦SÒG·6—¦WÒG¶VçG'•&–6WÒ†FVfVÇB4ÃÒG¶FVfVÇE6Å7GÒREÒG¶FVfVÇEG7GÒR–À¢ÒÀ¢ÒÀ¢7&VFVDC¢FFRææ÷r‚’À¢WFFVDC¢FFRææ÷r‚’À¢Ò2Æ—fU÷6—F–öà ¢v—B6fU÷6—F–öâ†F÷FVB¢F÷FVD6÷VçB²°¢v—B–æ7&VÖVçDÖWG&–2†6öææV7F–öä–BÂ&Æ—fU÷÷6—F–öç5öF÷FVEö6÷VçB"¢v—BÆöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢'v&æ–ær"À¢F÷FVB7—7FVÒ×G&6¶VBW†6†ævR÷6—F–öâG·7–×ÒG¶F—&V7F–öçÒ(	BÇ––ærFVfVÇB4ÃÒG¶FVfVÇE6Å7GÒREÒG¶FVfVÇEG7GÒVÀ¢²÷6—F–öä–C¢F÷FVD–BÂ6—¦RÂVçG'•&–6RÂÖ&µ&–6RÂÆWfW&vRÒÀ¢¢òòW6‚F÷FVB÷6—F–öâ–çFò÷Vå÷6—F–öç26òF†RW"×÷6—F–öà¢òòÆö÷&VÆ÷r&×24ÂõEöâ—B$”t…Bäõr†FöâwBv—Bf÷"F†P¢òòæW‡BR27–æ2F–6²(	BF†R÷W&F÷"w27G&æFVB÷6—F–öà¢òòæVVG2&÷FV7F–öâ–ÖÖVF–FVÇ’’à¢÷Vå÷6—F–öç2çW6‚†F÷FVB¢Ò6F6‚†÷'†äW'"’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò÷'†âF÷F–öâf–ÆVC¦À¢÷'†äW'"–ç7Fæ6VöbW'&÷"ò÷'†äW'"æÖW76vR¢7G&–ær†÷'†äW'"’À¢¢Ð¢Ð¢–b†F÷FVD6÷VçBâ’°¢6öç6öÆRæÆör†G´Äôuõ$Td•‡ÒF÷FVBG¶F÷FVD6÷VçGÒVçG&6¶VBW†6†ævR÷6—F–öâ‡2’f÷"G¶6öææV7F–öä–GÖ¢Ð¢Ð¢Ð¢òò)HûûÞûûÒVæB÷'†âF÷F–öâ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H  ¢–b†÷Vå÷6—F–öç2æÆVæwF‚ÓÓÒ’°¢òòæ÷F†–ærFò7–æ2gFW"F÷F–öâ(	Bf—&RÖæBÖf÷&vWBF†REDÂW‡—'¢òò7vVW6òvR&WGW&â–ÖÖVF–FVÇ’†æòW†6†ævR6ÆÂÆFVæ7’öâ–FÆRF‚’à¢÷'†ä6Æ÷6TW‡—&VE÷6—F–öç2†6öææV7F–öä–BÂW†6†ævT6öææV7F÷"ÂVæFVf–æVB2ç’’æ6F6‚‚‚’Óâ·Ò¢&WGW&à¢Ð ¢6öç6öÆRæÆör†G´Äôuõ$Td•‡Ò7–æ6–ærG¶÷Vå÷6—F–öç2æÆVæwF‡Ò÷Vâ÷Æ6VB÷6—F–öç2v—F‚W†6†ævR†F÷FVCÒG¶F÷FVD6÷VçGÒ– ¢òò)H)H'V–ÆBF—&V7F–öâÖ¶W–VBW†6†ævR×÷6—F–öâÖ…f—‚’)H)H)H)H)H)H)H)H ¢òò&Wf–÷W6Ç’F†RW"×÷6—F–öâÆö÷6ÆÆVBvWE÷6—F–öâ‡÷6—F–öâç7–Ö&öÂ– ¢òòv†–6‚öâ†VFvRÖÖöFR66÷VçG2&WGW&ç2÷6—F–öç5³Öf÷"F†R7–Ö&öÀ¢òò(	B&Vv&FÆW72öbv†WF†W"F†R6ÆÆW"vçFVBÄôär÷"4„õ%BâF†BÖVçC ¢òò¢–bW6W"†BÄôäröæÇ’Â÷6—F–öç5³Öv2Äôär(i"f–æRà¢òò¢–bW6W"†B4„õ%BöæÇ’Â÷6—F–öç5³Öv24„õ%B(i"f–æRà¢òò¢–bW6W"†B$õD‚††VFvR’Â÷6—F–öç5³Öv2Çv—2F†RöæP¢òò&–æu‚&WGW&æVBf—'7B(i"Ö&µ&–6R7&÷72Ö6öçFÖ–æF–öâ&WGvVVà¢òòF†RGvòÆVw2äBæòv’FòFWFV7Bv†VâöæRÆVrW‡FW&æÆÇ¢òò6Æ÷6VB‡F†R÷F†W"ÆVrw2FFÖ6¶VBF†R6Æ÷6R’à¢òò¢–bW6W"†BäôäR†6Æ÷6VBW‡FW&æÆÇ’’ÂvWE÷6—F–öç2‡7–Ö&öÂ– ¢òò6÷VÆB7F–ÆÂ&WGW&âfÆB¦W&ò×6—¦RVçG'’ÂÖ¶–æp¢òò–b†W†6†ævU÷2–G'WF‡’æB6–ÆVçFÇ’¶VW–ærF†R&VF—2&V6÷&@¢òò&÷Vâ"f÷&WfW"(	BF†R÷W&F÷"w2&WVFVB$Æ—fR÷6—F–öç2&P¢òò7F–ÆÂæ÷BvWGF–ær6Æ÷6VB"6ö×Æ–çBà¢òð¢òòæ÷s¢vRÇ&VG’fWF6†VBF†RgVÆÂ÷6—F–öç2'&’WF÷f÷"÷'†à¢òòF÷F–öââ&WW6R—BFò'V–ÆB‡7–Ö&öÇÆF—&V7F–öâ’(i"W†6†ævU÷6Ö ¢òòv—F‚6—¦Sãf–ÇFW"Æ–VBÂ6ÖR6†R&V6öæ6–ÆTÆ—fU÷6—F–öç6 ¢òòW6W2âöæR&F6‚fWF6‚6÷fW'2&÷F‚F÷F–öâäBW"×÷6—F–öâ7–æ2à¢6öç7Bæ÷&Õ7–ÒÒ‡&s¢7G&–ær’Óâ7G&–ær‡&rÇÂ""’çFõWW$66R‚’ç&WÆ6R‚õ²ÕõÒörÂ""¢6öç7BW†6†ævTÖÒæWrÖÇ7G&–ærÂç“â‚¢f÷"†6öç7BWöbW†6†ævU÷6—F–öç2’°¢6öç7B7–ÒÒæ÷&Õ7–Ò…7G&–ær†Wç7–Ö&öÂÇÂ†W2ç’’å7–Ö&öÂÇÂ""’¢–b‚7–Ò’6öçF–çVP¢6öç7B6–væVE6—¦RÒ'6TfÆöB…7G&–ær†Wç6—¦Róò†W2ç’’ç÷6—F–öä×BóòWçVçF—G’óò#"’¢6öç7B6—¦RÒÖF‚æ'2‡6–væVE6—¦R¢–b‚6—¦RÇÂ6—¦RÃÒ’6öçF–çVRòò6¶—fÆBò¦W&ò×6—¦RVçG&–W0¢6öç7BF—&V7F–öâÒæ÷&ÖÆ—¦TW†6†ævU÷6—F–öäF—&V7F–öâ€¢†W2ç’’ç÷6—F–öå6–FRÀ¢Wç6–FRÀ¢6–væVE6—¦RÀ¢¢–b‚F—&V7F–öâ’6öçF–çVP¢W†6†ævTÖç6WB†G·7–××ÂG¶F—&V7F–öçÖÂW¢Ð¢6öç7B7–æ5&÷FV7F–öâÒv—B&V6öæ6–ÆTvw&VvFU&÷FV7F–öä&öö²€¢6öææV7F–öä–BÀ¢W†6†ævT6öææV7F÷"À¢÷Vå÷6—F–öç2À¢W†6†ævU÷6—F–öç2À¢Æ—fT÷&FW$–G57–æ2À¢¢6öç7BW†V7WF–öå6Æ÷G4'•‡—6–6Å6Æ÷BÒæWrÖÇ7G&–ærÂ6WCÇ7G&–æsãâ‚¢f÷"†6öç7B÷6—F–öâöb÷Vå÷6—F–öç2’°¢6öç7B‡—6–6Å6Æ÷BÒG¶æ÷&Õ7–Ò‡÷6—F–öâç7–Ö&öÂ—×ÂG·÷6—F–öâæF—&V7F–öçÖ ¢6öç7B6Æ÷G2ÒW†V7WF–öå6Æ÷G4'•‡—6–6Å6Æ÷BævWB‡‡—6–6Å6Æ÷B’óòæWr6WCÇ7G&–æsâ‚¢6Æ÷G2æFB†Æ—fTW†V7WF–öå6Æ÷B‡÷6—F–öâ’¢W†V7WF–öå6Æ÷G4'•‡—6–6Å6Æ÷Bç6WB‡‡—6–6Å6Æ÷BÂ6Æ÷G2¢Ð ¢òòÆ—fT÷&FW$–G57–æ2v2fWF6†VB–âF†R&ÆÆVÂ&VfWF6‚&÷fRà¢òòæò6W&FR6W&–Â6ÆÂæVVFVB†W&Rà ¢òò÷6—F–öç2FvvVB27GV6²Ö–â×Æ6VB&R6öÆÆV7FVB†W&Ræ@¢òò&ö6W76VB–â&ÆÆVÂ&F6‚eDU"F†RÖ–âÆö÷6òF†W’Föâw@¢òò&Æö6²&÷FV7F–öâÖ÷&FW"WFFW2f÷"†VÇF‡’÷6—F–öç2à¢6öç7B7GV6µ÷6—F–öç3¢'&“Ç²÷6—F–öã¢Æ—fU÷6—F–öã²Æ6VDvT×3¢çVÖ&W#²5ET4µõÄ4TEôÔ…ôÕ3¢çVÖ&W"ÓâÒµÐ ¢òò)H)H&ÆÆVÆ—6VBW"×÷6—F–öâ7–æ2†&÷VæFVB6öæ7W'&Væ7’’)H)H)H)H)H)H)H)H)H)H)H)H ¢òòF&vWC¢ÆÂ÷6—F–öç26ö×ÆWFR–âÃ2F÷FÂà¢òð¢òò5”ä5ô4ôä5U%$Tä5“¢Ö‚6öæ7W'&VçB÷6—F–öç2Fò7–æ2–â&ÆÆVÂà¢òò&VGV6VBg&öÒ"FòS¢v—F‚2÷6—F–öç2V6‚Ö¶–ær(	32’6ÆÇ0¢òò†vWD÷&FW"ÂÆ6U7F÷ÂvWE÷6—F–öç2’Â"×v–FR6öæ7W'&Væ7’f—&W23°¢òò6–×VÇFæV÷W2&WVW7G2v†–6‚6GW&FW2&–æu‚w2W"Ô•'V6¶WBæB6W6W0¢òò666F–ærF–ÖV÷WG2âR6öæ7W'&VçB9rã22÷÷2Òã‚2F÷FÂf÷"2÷2à¢6öç7B5”ä5ô4ôä5U%$Tä5’ÒP¢ ¢òò5”ä5õU%õõ5õD”ÔTõUEôÕ3¢W"×÷6—F–öâ7–æ2F–ÖV÷WBà¢òò–æF—f–GVÂ÷W&F–öâF–ÖV÷WG3¢vWD÷&FW#Ó'2ÂÆ6U7F÷Óc2à¢òòW†6†ævRÖ6Æ÷6Rƒ3W<9s#Ós2’—2æ÷r6¶—VBf÷"7GV6µö–å÷Æ6VBæ@¢òòW†6†ævUöW‡FW&æÆÇ•ö6Æ÷6VBF‡2Â6òF†Rv÷'7B66R—26–ævÆP¢òòÆ6U7F÷ƒc2’²vWE÷6—F–öç2‡ã72’Òc72âW6RCW22F†R6 ¢òòÆ6U7F÷Ç&VG’†2W†V7WFUF–ÖV÷WD×2–ç6–FRF†R&FRÖÆ–Ö—FW"6Æ÷@¢òò‡7F'G2BF—7F6‚Âæ÷BBVçVWVR’Â6òF†RVffV7F—fR6—2†–v†W ¢òòF†â—BV'2â÷6—F–öç2F†BæVVBgVÆÂ6Æ÷6R7F–ÆÂW6RF†P¢òò6Æ÷6TÆ—fU÷6—F–öâF‚v—F‚—G2÷vâ3W2–çFW&æÂF–ÖV÷WBà¢6öç7B5”ä5õU%õõ5õD”ÔTõUEôÕ2ÒCUó  ¢6öç7B&ö6W74öæU7–æ2Ò7–æ2‡÷6—F–öã¢Æ—fU÷6—F–öâ“¢&öÖ—6SÇfö–CâÓâ°¢G'’°¢òò$33¢&RÖ6†V6²÷6—F–öâW†—7G2gFW"7–æ26öçFW‡B7v—F6€¢òòæ÷F†W"F‡&VBÖ–v‡B†fRFVÆWFVB—BGW&–ær÷W"v—G0¢–b‚÷6—F–öâÇÂ÷6—F–öâæ–B’&WGW&à¢–b‡7–æ5&÷FV7F–öâçVæF–æt6öçG&öÅ6Æ÷G3òæ†2†vw&VvFU&÷FV7F–öå6Æ÷B‡÷6—F–öâç7–Ö&öÂÂ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ‡÷6—F–öâ’’’’&WGW&à¢òòf÷&V–vâöÖçVÂ&÷w2&Rö'6W'fF–öâÖöæÇ’âF†W’6ææ÷B'F–6—FP¢òò–âf–ÆÂ&V6÷fW'’Â&÷FV7F–öâÆ6VÖVçBÂ6æ6VÆÆF–öâÂ÷"7—7FVÐ¢òò6Æ÷6RÖW&VÇ’&V6W6RF†W’6†&R7–Ö&öÂæBF—&V7F–öâà¢–b‚—57—7FVÕG&6¶VDÆ—fU÷6—F–öâ‡÷6—F–öâÂ6öææV7F–öä–B’’&WGW&à¢ ¢òò$3¢6¶—–bÇ&VG’6Æ÷6VB÷"Æö6¶V@¢–b€¢÷6—F–öâç7FGW2ÓÓÒ&6Æ÷6VB"ÇÀ¢‡÷6—F–öâæÆö6¶VDBbb÷6—F–öâæÆö6¶VDBâFFRææ÷r‚’Ò…õ4•D”ôåôÕUDD”ôåôÄô4µõEDÅôÕ2²ó’¢’°¢&WGW&à¢Ð¢ ¢6öç7BÖ¶W’ÒG¶æ÷&Õ7–Ò‡÷6—F–öâç7–Ö&öÂ—×ÂG·÷6—F–öâæF—&V7F–öçÖ ¢6öç7B&ÆÆVÄW†V7WF–öäÆæW2Ò†W†V7WF–öå6Æ÷G4'•‡—6–6Å6Æ÷BævWB†Ö¶W’“òç6—¦RÇÂ’â¢6öç7BW†6†ævU÷2ÒW†6†ævTÖævWB†Ö¶W’¢–b‚W†6†ævU÷2’°¢–b‚&V6÷&DW†6†ævT'6Væ6R‡÷6—F–öâ’’&WGW&à¢ÒVÇ6R°¢6ÆV$W†6†ævT'6Væ6R‡÷6—F–öâ¢Ð¢–b‡÷6—F–öâç7FGW2ÓÓÒ&6Æ÷6–ær"ÇÂ÷6—F–öâç7FGW2ÓÓÒ&6Æ÷6–æu÷'F–Â"’°¢6öç7BÆö6¶VDBÒçVÖ&W"‡÷6—F–öâæÆö6¶VDBÇÂ¢–b†Æö6¶VDBâbbFFRææ÷r‚’ÒÆö6¶VDBÃÒõ4•D”ôåôÕUDD”ôåôÄô4µõEDÅôÕ2²ó’&WGW&à¢6öç7BW†—E&–6RÒçVÖ&W"€¢W†6†ævU÷3òæÖ&µ&–6Róð¢W†6†ævU÷3òæÆ7E&–6Róð¢÷6—F–öâæW†6†ævTFFòæÖ&µ&–6Róð¢÷6—F–öâæfW&vTW†V7WF–öå&–6Róð¢÷6—F–öâæVçG'•&–6Róð¢À¢¢v—B6Æ÷6TÆ—fU÷6—F–öâ€¢6öææV7F–öä–BÀ¢÷6—F–öâæ–BÀ¢W†—E&–6RÀ¢W†6†ævU÷2òW†6†ævT6öææV7F÷"¢çVÆÂÀ¢W†6†ævU÷2ò&7&6…÷&V6÷fW'•÷VæF–æuö6Æ÷6R"¢&W†6†ævUöW‡FW&æÆÇ•ö6Æ÷6VB"À¢¢&WGW&à¢Ð¢–b†W†6†ævU÷2’°¢òòÖ—'&÷"&V6öæ6–ÆTÆ—fU÷6—F–öç2rf–VÆBW‡G&7F–öâ6ò&÷F‚F‡0¢òò&öGV6R7G'V7GW&ÆÇ’–FVçF–6ÂW†6†ævTFFâ&Wf–÷W6Ç’F†—0¢òòF‚7F÷&VB&r7G&–æw2VæFW"Ö&µ&–6V†æò'6TfÆöB’6ð¢òòF÷vç7G&VÒçVÖ&W"‡÷6—F–öâæW†6†ævTFFòæÖ&µ&–6Róò–(	@¢òòv†–ÆR6÷'&V7Bf÷"Æ–âçVÖW&–27G&–æw2(	B6–ÆVçFÇ’6öW&6V@¢òò&–æu‚w2ö666–öæÂçVÆÂöV×G’×7G&–ær&WGW&ç2FòÂvF–æp¢òòF†R4ÂõE7&÷726†V6²à¢6öç7BÖ&µ&–6RÒ'6U&VF—4f–æ—FTçVÖ&W"†W†6†ævU÷2æÖ&µ&–6RóòW†6†ævU÷2æ–æFW…&–6RóòW†6†ævU÷2æÆ7E&–6R¢6öç7BÆ—&–6RÒ'6U&VF—4f–æ—FTçVÖ&W"†W†6†ævU÷2æÆ—V–FF–öå&–6RóòW†6†ævU÷2æÆ—&–6R¢6öç7BUæÂÒ'6U&VF—4f–æ—FTçVÖ&W"†W†6†ævU÷2çVç&VÆ—¦VE&öf—BóòW†6†ævU÷2çVç&VÆ—6VEæÂóòW†6†ævU÷2çVç&VÆ—¦VEæÂ¢÷6—F–öâæW†6†ævTFFÒ°¢ââç÷6—F–öâæW†6†ævTFFÀ¢Ö&v–åG—S¢†W†6†ævU÷22ç’’æÖ&v–åG—RÀ¢Ö&µ&–6S¢Ö&µ&–6RbbÖ&µ&–6RâòÖ&µ&–6R¢÷6—F–öâæW†6†ævTFFòæÖ&µ&–6RÀ¢Æ—V–FF–öå&–6S¢Æ—&–6RbbÆ—&–6RâòÆ—&–6R¢÷6—F–öâæW†6†ævTFFòæÆ—V–FF–öå&–6RÀ¢Vç&VÆ—¦VEäÃ¢UæÂóò÷6—F–öâæW†6†ævTFFòçVç&VÆ—¦VEäÂÀ¢7–æ6VDC¢FFRææ÷r‚’À¢Ð¢òò&V6÷fW"fW&vTW†V7WF–öå&–6RòVçG'•&–6Rg&öÒW†6†ævR–bF†P¢òò7F÷&VBfÇVR—2††Vç2gFW"&W7F'Bv†W&RF†R&VF—2†6€¢òò†BfW&vTW†V7WF–öå&–6SÓg&öÒâV&Æ–W"'F–Âw&—FR’âv—F†÷W@¢òòF†—2Â6ö×WFTFW6—&VE&÷FV7F–öå&–6W2&WGW&ç2FW6—&VE6ÃÓæBæð¢òò4ÂõE÷&FW'2&RWfW"Æ6VBf÷"F†÷6R÷6—F–öç2à¢6öç7BW„VçG'’Ò'6TfÆöB€¢7G&–ær†W†6†ævU÷2æVçG'•&–6Róò†W†6†ævU÷22ç’’æfu&–6RóòW†6†ævU÷2æÖ&µ&–6Róò#"’À¢’ÇÂ ¢6öç7BWF†÷&—FF—fU6—¦RÒÖF‚æ'2‡'6TfÆöB…7G&–ær€¢W†6†ævU÷2ç6—¦Róò†W†6†ævU÷22ç’’ç÷6—F–öä×BóòW†6†ævU÷2çVçF—G’óò#"À¢’’’ÇÂ ¢&W—$Æ—fTVçG'•&–6TFöÖ–â‡÷6—F–öâÂW„VçG'’¢–b†W„VçG'’â’°¢–b‚‡÷6—F–öâæfW&vTW†V7WF–öå&–6Râ’’÷6—F–öâæfW&vTW†V7WF–öå&–6RÒW„VçG'¢–b‚‡÷6—F–öâæVçG'•&–6Râ’’÷6—F–öâæVçG'•&–6RÒW„VçG'¢Ð¢–b‚&ÆÆVÄW†V7WF–öäÆæW2’°¢v—B&V6öæ6–ÆTWF†÷&—FF—fTW†6†ævUVçF—G’‡÷6—F–öâÂWF†÷&—FF—fU6—¦RÂW„VçG'’¢Ð¢÷6—F–öâç7V&Ö—76–öä'6VçD6öæf—&ÖF–öç2Ò ¢÷6—F–öâçWFFVDBÒFFRææ÷r‚¢ÒVÇ6R–b€¢òò)H)HW‡FW&æÆÇ’Ö6Æ÷6VB'&æ6‚…D„RÖ—76–ær6Æ÷6RF‚’)H)H)H)H)H)H ¢òòW†6†ævRæòÆöævW"&W÷'G2F†R‡7–Ö&öÇÆF—&V7F–öâ’vR†fP¢òòG&6¶VB(	BF†R÷6—F–öâ6Æ÷6VBW‡FW&æÆÇ’…4ÂõEf—&VBÂÖçVÀ¢òò6Æ÷6RöâF†R&–æu‚T’ÂÆ—V–FF–öâÂWF2â’â&Wf–÷W6Ç’F†—0¢òò'&æ6‚F–Bæ÷BW†—7B–â7–æ5v—F„W†6†ævVÂ6òF†R&VÇF–ÖP¢òòF–6²F‚æWfW"FWFV7FVBW‡FW&æÂ6Æ÷7W&W2(	BöæÇ’F†R32Ð¢òòF‡&÷GFÆVB6ö÷&F–æF÷"&V6öæ6–ÆRF–Bâ÷W&F÷'2öâ†VÇF‡¢òòVæv–æRF†W&Vf÷&R6r÷6—F–öç26—B2&÷Vâ"–â&VF—2f÷"W ¢òòFògVÆÂ&V6öæ6–ÆRv–æF÷rgFW"F†W’vW&R7GVÆÇ’6Æ÷6VBÀ¢òòæBöâVæv–æW2v†W&RF†R32&V6öæ6–ÆRv÷B6¶—VB‡&FRÐ¢òòÆ–Ö—BG&–gBÂ7G&FVw’fÆ÷rW'&÷"Â6ö÷&F–æF÷"W6R’F†P¢òò÷6—F–öç26BõTâ–æFVf–æ—FVÇ’à¢òð¢òòvRöæÇ’7Bv†VâF†RVçG'’FVf–æ—FVÇ’W†—7FVBöâF†P¢òòW†6†ævRB4ôÔRö–çB(	B’æRâ7FGW2—2ç—F†–ær7@¢òò'Æ6VB"†÷Vâòf–ÆÆVBò'F–ÆÇ•öf–ÆÆVBv—F‚W†V7WFVBG’’à¢òò÷6—F–öç27F–ÆÂ–â'Æ6VB"7FGW2v—F‚æòf–ÆÂ–WBÖ–v‡@¢òòÆVv—F–ÖFVÇ’æ÷B6†÷rWöâF†RW†6†ævR‡F†RVçG'’÷&FW"—0¢òò7F–ÆÂ&W7F–æröâF†R&öö²Âæ÷B÷6—F–öâ’âF†÷6R6öçF–çVP¢òòFò&R&öÖ÷FVBf–F†R$FVÆ–VBÖf–ÆÂ"&Æö6²&÷fRv†VâF†P¢òòVçG'’÷&FW"FöW2f–ÆÂà¢÷6—F–öâæW†V7WFVEVçF—G’âb`¢‡÷6—F–öâç7FGW2ÓÓÒ&÷Vâ"ÇÀ¢÷6—F–öâç7FGW2ÓÓÒ&f–ÆÆVB"ÇÀ¢÷6—F–öâç7FGW2ÓÓÒ''F–ÆÇ•öf–ÆÆVB"¢’°¢òò&W6öÇfRW†—B&–6RW6–ærF†R6ÖRB×7FWfÆÆ&6²6†–à¢òò&V6öæ6–ÆTÆ—fU÷6—F–öç2W6W2Â6òäÂ—2†öæW7Bv†WF†W"F†P¢òòW†6†ævR&WGW&æVBÖ&µ&–6R–âF†R6Æ÷6–ær&F6‚ÂvR¶WB¢òòÖ&µ&–6Rg&öÒF†R&Wf–÷W2F–6²ÂF†R7–Ö&öÂw2Ö&¶WEöFF¢òò†6‚†2g&W6‚F–6·2Â÷"vRfÆÂ&6²FòVçG'•&–6Rà¢ÆWBW†—E&–6S¢çVÖ&W"ÒçVÖ&W"‡÷6—F–öâæW†6†ævTFFòæÖ&µ&–6R’ÇÂ÷6—F–öâæfW&vTW†V7WF–öå&–6RÇÂ ¢–b†W†—E&–6RÃÒ’°¢G'’°¢6öç7BÖD†6‚Òv—B6Æ–VçBæ†vWFÆÂ†Ö&¶WDFF¶W’‡÷6—F–öâç7–Ö&öÂÂ""Â÷6—F–öâæ6öææV7F–öä–BÇÂ6öææV7F–öä–B’¢6öç7BÖE&–6RÒ'6TfÆöB…7G&–ær†ÖD†6ƒòæÆ7E&–6RóòÖD†6ƒòç&–6RóòÖD†6ƒòæ6Æ÷6Róò#"’¢–b†ÖE&–6Râ’W†—E&–6RÒÖE&–6P¢Ò6F6‚²ò¢fÆÂF‡&÷Vv‚¢òÐ¢Ð¢–b†W†—E&–6RÃÒ’W†—E&–6RÒ÷6—F–öâæVçG'•&–6RÇÂ  ¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡ÒU…DU$äÄÅ’Ô4Äõ4TBFWFV7FVBf÷"G·÷6—F–öâç7–Ö&öÇÒG·÷6—F–öâæF—&V7F–öçÒ†–CÒG·÷6—F–öâæ–GÒ’(	Bf–æÆ—6–ær–â&VF—6À¢¢òòf—&RÖæBÖf÷&vWBûûÞûûÞûûÒFöâwB&Æö6²F†R6Æ÷6RF‚öâÆörw&—FRà¢Æöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&–æfò"À¢÷6—F–öâG·÷6—F–öâç7–Ö&öÇÒæòÆöævW"öâW†6†ævR(	B6Æ÷6–ær–â&VF—2‡7–æ2–À¢°¢÷6—F–öä–C¢÷6—F–öâæ–BÀ¢W†—E&–6RÀ¢W†V7WFVEVçF—G“¢÷6—F–öâæW†V7WFVEVçF—G’À¢F—&V7F–öã¢÷6—F–öâæF—&V7F–öâÀ¢ÒÀ¢’æ6F6‚‚‚’Óâ·Ò¢òò6Æ÷6TÆ—fU÷6—F–öâFöW2F†RgVÆÂFW&Ö–æÂ×7FFR—VÆ–æS ¢òò6æ6VÂ÷'†â4ÂõEÂ6ö×WFRäÂõ$ô’Â&6†—fRÂ&VÆV6RÆö6²À¢òò–æ7&VÖVçB6÷VçFW'2â&V6öâ&W†6†ævUöW‡FW&æÆÇ•ö6Æ÷6VB ¢òòF—7F–æwV—6†W2—B–âF†RVF—BG&–Âg&öÒ7&÷72Öf—&W2à¢òð¢òò72çVÆÂ6öææV7F÷#¢F†R÷6—F–öâ—2Ç&VG’6Æ÷6VBöâF†P¢òòW†6†ævR…4ÂõEG&–vvW&VB’Â6òF†R,9s3W2W†6†ævRÖ6Æ÷6R&WG'¢òò–ç6–FR6Æ÷6TÆ—fU÷6—F–öâ—2wV&çFVVBFòV—F†W"f–Â÷"&R¢òòæòÖ÷â6¶—–ær—B¶VW27–æ2ÖFöæRÆFVæ7’VæFW"32g2s2²à¢G'’°¢v—B6Æ÷6TÆ—fU÷6—F–öâ€¢6öææV7F–öä–BÀ¢÷6—F–öâæ–BÀ¢W†—E&–6RÀ¢çVÆÂÂòòW†6†ævRÇ&VG’6Æ÷6VB—B(	B6¶—W†6†ævRÖ6Æ÷6RÆVp¢&W†6†ævUöW‡FW&æÆÇ•ö6Æ÷6VB"À¢¢Ò6F6‚†6Æ÷6TW'"’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡ÒW‡FW&æÆÇ’Ö6Æ÷6VB6Æ÷6RW'&÷"f÷"G·÷6—F–öâæ–GÓ¦À¢6Æ÷6TW'"–ç7Fæ6VöbW'&÷"ò6Æ÷6TW'"æÖW76vR¢7G&–ær†6Æ÷6TW'"’À¢¢Ð¢&WGW&âòò6Æ÷6TÆ—fU÷6—F–öâW'6—7FVBFW&Ö–æÂ7FFR(	B6¶—W"×÷6—F–öâ6WFW€¢Ð ¢–b€¢‡÷6—F–öâç7FGW2ÓÓÒ'Æ6VB"ÇÂ÷6—F–öâç7FGW2ÓÓÒ'VæF–æuöf–ÆÂ"ÇÂ÷6—F–öâç7FGW2ÓÓÒ'Æ6VE÷Væ6öæf—&ÖVB"’b`¢÷6—F–öâæ÷&FW$–@¢’°¢6öç7B6Æ–VçD÷&FW$–BÒvWEG&6¶VD6Æ–VçD÷&FW$–B‡÷6—F–öâÂ&VçG'’"¢–b†6Æ–VçD÷&FW$–B’°¢6öç7B&V6÷fW&VBÒv—B&V6÷fW$VçG'”÷&FW$'”6Æ–VçD–B†W†6†ævT6öææV7F÷"Â÷6—F–öâç7–Ö&öÂÂ6Æ–VçD÷&FW$–B¢–b‡&V6÷fW&VB’°¢÷6—F–öâæ÷&FW$–BÒ7G&–ær‡&V6÷fW&VBæ÷&FW$–BÇÂ&V6÷fW&VBæ–B¢÷6—F–öâç7V&Ö—76–öå7FFRÒ&6öæf—&ÖVB ¢÷6—F–öâç7V&Ö—76–öä'6VçD6öæf—&ÖF–öç2Ò ¢W6…7FW‡÷6—F–öâÂ&VçG'•÷7V&Ö—76–öå÷&V6÷fW&VB"ÂG'VRÂ÷&FW$–CÒG·÷6—F–öâæ÷&FW$–GÒ6Æ–VçD÷&FW$–CÒG¶6Æ–VçD÷&FW$–GÖ¢ÒVÇ6R–b‚W†6†ævU÷2bbÆ—fT÷&FW$–G57–æ2ÓÒçVÆÂbbÆ—fT÷&FW$–G57–æ2æ†2†6Æ–VçD÷&FW$–B’’°¢÷6—F–öâç7V&Ö—76–öä'6VçD6öæf—&ÖF–öç2ÒçVÖ&W"‡÷6—F–öâç7V&Ö—76–öä'6VçD6öæf—&ÖF–öç2ÇÂ’²¢–b‡÷6—F–öâç7V&Ö—76–öä'6VçD6öæf—&ÖF–öç2ãÒ"’°¢÷6—F–öâç7FGW2Ò'&V¦V7FVB ¢÷6—F–öâç7V&Ö—76–öå7FFRÒ&6öæf—&ÖVB ¢÷6—F–öâç7FGW5&V6öâÒ&6Æ–VçD÷&FW$–B6öæf—&ÖVB'6VçB&WVFVFÇ“²&VÆV6–ærGW&&ÆR6Æ÷B ¢÷6—F–öâæ6Æ÷6U&V6öâÒ÷6—F–öâç7FGW5&V6öà¢÷6—F–öâæ6Æ÷6VDBÒFFRææ÷r‚¢W6…7FW‡÷6—F–öâÂ&VçG'•÷7V&Ö—76–öåö'6VçB"ÂfÇ6RÂ÷6—F–öâç7FGW5&V6öâ¢v—B6fU÷6—F–öâ‡÷6—F–öâ¢–b‡÷6—F–öâæÆ—fTÆö6µFö¶Vâ’°¢6öç7BF—&V7F–öâÒ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ‡÷6—F–öâ¢–b†F—&V7F–öâ’°¢v—B&VÆV6TÆö6²†6öææV7F–öä–BÂ÷6—F–öâç7–Ö&öÂÂÆ—fTÆö6´F—&V7F–öâ‡÷6—F–öâ’Â÷6—F–öâæÆ—fTÆö6µFö¶Vâ’æ6F6‚‚‚’ÓâfÇ6R¢Ð¢Ð¢&WGW&à¢Ð¢Ð¢Ð¢Ð ¢ÆWB§W7Df–ÆÆVBÒfÇ6P¢–b€¢W†6†ævU÷2b`¢‡÷6—F–öâç7FGW2ÓÓÒ'Æ6VB"ÇÂ÷6—F–öâç7FGW2ÓÓÒ'VæF–æuöf–ÆÂ"ÇÂ÷6—F–öâç7FGW2ÓÓÒ'Æ6VE÷Væ6öæf—&ÖVB"¢’°¢6öç7BW…6—¦RÒÖF‚æ'2‡'6TfÆöB…7G&–ær†W†6†ævU÷2ç6—¦Róò†W†6†ævU÷22ç’’ç÷6—F–öä×BóòW†6†ævU÷2çVçF—G’óò#"’’’ÇÂ ¢6öç7BW„VçG'’Ò'6TfÆöB…7G&–ær†W†6†ævU÷2æVçG'•&–6Róò†W†6†ævU÷22ç’’æfu&–6RóòW†6†ævU÷2æÖ&µ&–6Róò#"’’ÇÂ ¢–b†W…6—¦Râbb&ÆÆVÄW†V7WF–öäÆæW2’°¢÷6—F–öâæW†V7WFVEVçF—G’ÒW…6—¦P¢÷6—F–öâç&VÖ–æ–æuVçF—G’ÒÖF‚æÖ‚ƒÂ‡÷6—F–öâçVçF—G’ÇÂW…6—¦R’ÒW…6—¦R¢÷6—F–öâæfW&vTW†V7WF–öå&–6RÒW„VçG'’ÇÂ÷6—F–öâæVçG'•&–6P¢÷6—F–öâç7FGW2Ò&÷Vâ ¢÷6—F–öâç7FGW5&V6öâÒ6öæf—&ÖVE÷÷6—F–öåöfÆÆ&6³¢7–æ26rW†6†ævR÷6—F–öâ6—¦SÒG¶W…6—¦WÒfsÒG·÷6—F–öâæfW&vTW†V7WF–öå&–6WÖ ¢÷6—F–öâçWFFVDBÒFFRææ÷r‚¢§W7Df–ÆÆVBÒG'VP¢v—B&V6÷&Df–ÆÄ6÷VçFW'4öæ6R†6öææV7F–öä–BÂ÷6—F–öâÂ÷6—F–öâç7–Ö&öÂÂ÷6—F–öâæF—&V7F–öâÇÂ÷6—F–öâç6–FRÇÂ""¢W6…7FW‡÷6—F–öâÂ'7–æ5öf–ÆÅöFWFV7FVB"ÂG'VRÂ÷6—F–öâç7FGW5&V6öâ¢Ð¢Ð ¢òò)H)HFVÆ–VBÖf–ÆÂ4ÂõE&Ö–ær)H)H)H)HûûÞûûÞûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞûûÞ)H)HûûÞûûÞ)H)H)H)H ¢òò–bF†RVçG'’÷&FW"v27F–ÆÂVæF–ærv†VâW†V7WFTÆ—fU÷6—F–öæ ¢òòG&–VBFòÆ6R4ÂõEÂF†B7FWW6†VBÆ6U÷6Å÷GÒ6¶—VF ¢òòæBF†R÷6—F–öâVæFVBWÆ6VFv—F‚æò&÷FV7F–öâ÷&FW'2à¢òòv†VâF†—2Æö÷æ÷rFWFV7G2F†R÷&FW"†2f–ÆÆVBÂvRG&ç6—F–öà¢òòFò÷VæäB×W7B&Ò4ÂõE(	B÷F†W'v—6RF†R÷W&F÷"vWG0¢òòâ÷VâW†6†ævR÷6—F–öâv—F‚¦W&ò7F÷ÖÆ÷72òF¶R×&öf—@¢òò&÷FV7F–öââF†—2v2&VÂ'VrF†RW6W"&W÷'FVB0¢òò%Eõ4Â6öçG&öÂ÷&FW'2&Ræ÷Bv÷&¶–ær"à¢–b‚‡÷6—F–öâç7FGW2ÓÓÒ'Æ6VB"ÇÂ÷6—F–öâç7FGW2ÓÓÒ'VæF–æuöf–ÆÂ"ÇÂ÷6—F–öâç7FGW2ÓÓÒ'Æ6VE÷Væ6öæf—&ÖVB"’bb÷6—F–öâæ÷&FW$–B’°¢òòwV&C¢6öææV7F÷"Ö’&RçVÆÂ÷Væ–æ—F–Æ—6VBöâF†RfW'’f—'7B7–æ0¢òòF–6²gFW"&W7F'B†f7F÷'’æ÷B–WB6ÆÆVBf÷"F†—26öææV7F–öä–B’à¢òò6¶—f–ÆÂÖFWFV7F–öâ6–ÆVçFÇ’(	BF†RæW‡BF–6²v–ÆÂ&WG'’öæ6RF†P¢òò6öææV7F÷"—2&VG’â&Wf–÷W6Ç’F†—2F‡&Wr$6ææ÷B&VB&÷W'F–W2ö`¢òòçVÆÂ‡&VF–ærvvWD÷&FW"r’"v†–6‚fÆööFVBF†RÆöröâWfW'’7–æ2F–6°¢òòVçF–ÂF†R6öææV7F÷"v2–æ—F–Æ—6VBà¢–b‚W†6†ævT6öææV7F÷"ÇÂG—VöbW†6†ævT6öææV7F÷"ævWD÷&FW"ÓÒ&gVæ7F–öâ"’°¢òò6öææV7F÷"æ÷B&VG’–WB(	B6¶—Â&WG'’æW‡B7–æ2F–6²à¢ÒVÇ6P¢G'’°¢òò&÷VæFVB(	B†æv–ærvWD÷&FW"v÷VÆB&Æö6²F†—2÷6—F–öâw0¢òòVçF—&R7–æ26Æ÷BæBFVÆ’WfW'’F÷vç7G&VÒ6Æ÷6Rö†VÂ7FWà¢òòöâF–ÖV÷WBvR§W7B6¶—F†Rf–ÆÂFWFV7F–öâf÷"F†—2F–6³°¢òòF†RæW‡B7–æ2v–ÆÂ&WG'’à¢6öç7B÷&FW"Òv—Bv—F…F–ÖV÷WB€¢W†6†ævT6öææV7F÷"ævWD÷&FW"‡÷6—F–öâç7–Ö&öÂÂ÷6—F–öâæ÷&FW$–B’2&öÖ—6SÆç“âÀ¢U„4„ätUõD”ÔTõUEôtUEôõ$DU%ôÕ2À¢vWD÷&FW"‚G·÷6—F–öâç7–Ö&öÇÒG·÷6—F–öâæ÷&FW$–GÒ–À¢¢6öç7B7FGW4Æ÷vW"Ò7G&–ær†÷&FW#òç7FGW2óò""’çFôÆ÷vW$66R‚¢6öç7B÷&FW$f–ÆÆVEG’Ò'6TfÆöB…7G&–ær†÷&FW#òæf–ÆÆVEG’óò÷&FW#òæW†V7WFVEG’óò#"’’ÇÂ ¢–b†÷&FW"bb‡7FGW4Æ÷vW"ÓÓÒ&f–ÆÆVB"ÇÂ7FGW4Æ÷vW"ÓÓÒ''F–ÆÇ•öf–ÆÆVB"ÇÂ÷&FW$f–ÆÆVEG’â’’°¢÷6—F–öâæW†V7WFVEVçF—G’Ò÷&FW$f–ÆÆVEG’ÇÂ÷&FW"æf–ÆÆVEG’ÇÂ÷6—F–öâçVçF—G¢÷6—F–öâç&VÖ–æ–æuVçF—G’ÒÖF‚æÖ‚ƒÂ÷6—F–öâçVçF—G’Ò÷6—F–öâæW†V7WFVEVçF—G’¢÷6—F–öâæfW&vTW†V7WF–öå&–6RÒ÷&FW"æf–ÆÆVE&–6RÇÂ÷6—F–öâæVçG'•&–6P¢÷6—F–öâç7FGW2Ò&÷Vâ ¢÷6—F–öâç7FGW5&V6öâÒ6öæf—&ÖVEöf–ÆÃ¢7–æ2÷&FW"7FGW3ÒG·7FGW4Æ÷vW'ÒG“ÒG·÷6—F–öâæW†V7WFVEVçF—G—Ö ¢W6…7FW‡÷6—F–öâÂ'7–æ5öf–ÆÅöFWFV7FVB"ÂG'VRÂ÷6—F–öâç7FGW5&V6öâ¢÷6—F–öâçWFFVDBÒFFRææ÷r‚¢§W7Df–ÆÆVBÒG'VP¢v—B&V6÷&Df–ÆÄ6÷VçFW'4öæ6R†6öææV7F–öä–BÂ÷6—F–öâÂ÷6—F–öâç7–Ö&öÂÂ÷6—F–öâæF—&V7F–öâÇÂ÷6—F–öâç6–FRÇÂ""¢Æöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&–æfò"À¢7–æ2FWFV7FVBf–ÆÂf÷"G·÷6—F–öâç7–Ö&öÇÖÀ¢°¢÷&FW$–C¢÷6—F–öâæ÷&FW$–BÀ¢f–ÆÆVEG“¢÷6—F–öâæW†V7WFVEVçF—G’À¢Ð¢’æ6F6‚‚‚’Óâ·Ò¢ÒVÇ6R–b†÷&FW"’°¢òò÷&FW"W†—7G2'WBæ÷Bf–ÆÆVB‡Æ6VB÷'F–Âö6æ6VÆÆVB÷&V¦V7FVB’(	@¢òòÆör6òF†R÷W&F÷"6â6VRt…’F†R÷6—F–öâ7F—2–à¢òò'Æ6VB"7FGW2â&Wf–÷W6Ç’F†RöæÇ’6–væÂv2F†P¢òò÷6—F–öâæWfW"&öw&W76–ærÂv†–6‚v2–æF—7F–æwV—6†&ÆP¢òòg&öÒ'Vrà¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Ò¶f–ÆÂÖFWFV7EÒG·÷6—F–öâç7–Ö&öÇÒ÷&FW"G·÷6—F–öâæ÷&FW$–GÒ7FGW3ÒG¶÷&FW"ç7FGW7Òf–ÆÆVEG“ÒG¶÷&FW"æf–ÆÆVEG’óòÒ(	B7F––ær–âwÆ6VBvÀ¢¢Ð¢Ò6F6‚†f–ÆÄW'"’°¢òò$Ud”õU4Å’5tÄÄõtTB(	BF†—2v2F†R&ö÷B6W6Röb&÷&FW'0¢òòæWfW"6Æ÷6–ær#¢WfW'’vWD÷&FW"f–ÇW&RÆVgBF†R÷6—F–öà¢òò7GV6²–âÆ6VFf÷&WfW"ÂæBF†R4ÂõE7&÷726†V6²6¶—0¢òòÆ6VF÷6—F–öç26–ÆVçFÇ’‡6VR6†V6´æDf÷&6T6Æ÷6Töå6ÇG7&÷70¢òòÆ–æR&–b‡÷2ç7FGW2ÓÓÒwÆ6VBr’&WGW&âçVÆÂ"’à¢òòvRæ÷rÆör6òF†Rf–ÇW&R—2f—6–&ÆRâF†R&WG'’öâæW‡@¢òò7–æ2F–6²7F–ÆÂ†Vç2(	Bæò&V†f–÷W"6†ævRÂ§W7@¢òòö'6W'f&–Æ—G’à¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò¶f–ÆÂÖFWFV7EÒvWD÷&FW"f–ÆVBf÷"G·÷6—F–öâç7–Ö&öÇÒ÷&FW$–CÒG·÷6—F–öâæ÷&FW$–GÓ¦À¢f–ÆÄW'"–ç7Fæ6VöbW'&÷"òf–ÆÄW'"æÖW76vR¢7G&–ær†f–ÆÄW'"’À¢¢Ð¢Ð ¢òò)H)H7GV6²Ö–â×Æ6VBFWFV7F–öâûûÞûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òò÷6—F–öâ–âÆ6VF7FGW2v—F‚æòW†V7WFVBG’†2—G0¢òòVçG'’÷&FW"&W7F–æröâF†RW†6†ævR&öö²Væf–ÆÆVBâF†R4ÂõE ¢òò7&÷726†V6²6¶—2Æ6VF÷6—F–öç26–ÆVçFÇ’Â6òv—F†÷W@¢òòF†—2'&æ6‚7GV6²÷&FW"6÷VÆB6—Bf÷&WfW# ¢òòÒæWfW"6Æ÷6W2f–4ÂõE7&÷72‡7FGW2vFR¢òòÒæWfW"6Æ÷6W2f–Ö‚Ö†öÆB×F–ÖR†W†V7WFVEG“ÓvFR¢òòÒæWfW"F÷FVB2÷'†â†—B•2–â&VF—2¢òòÒæWfW"f–æÆ—6VB2W‡FW&æÆÇ’Ö6Æ÷6VB†vFR&WV—&W0¢òòW†V7WFVEG“ã²7FGW>(šÆ6VB¢òò6æ6VÂF†RFævÆ–ærVçG'’÷&FW"gFW"5ET4µõÄ4TEôÔ…ôÕ2æ@¢òòÖ&²F†R÷6—F–öâ&V¦V7FVB6ò—BÆVfW2F†R÷Vâ–æFW‚à¢òò)H)H7GV6²Ö–â×Æ6VC¢Fr6æF–FFRÂ&ö6W72–â&ÆÆVÂ&F6‚&VÆ÷r)H)H ¢òòöæÇ’Dr†W&RæB6öçF–çVVâF†R7GVÂ6æ6VÂ¶6Æ÷6R'Vç2–â¢òò&öÖ—6RæÆÅ6WGFÆVB&F6‚gFW"F†Rf÷"Æö÷6òF†Bâ7GV6°¢òò÷6—F–öç2FöâwB6W&–Æ—¦Rf÷"U„4„ätUõD”ÔTõUEô4ä4TÅôõ$DU%ôÕ29rà¢òòæB&Æö6²&÷FV7F–öâÖ÷&FW"WFFW2f÷"ÆÂ†VÇF‡’÷6—F–öç2à¢–b‚‡÷6—F–öâç7FGW2ÓÓÒ'Æ6VB"ÇÂ÷6—F–öâç7FGW2ÓÓÒ'VæF–æuöf–ÆÂ"ÇÂ÷6—F–öâç7FGW2ÓÓÒ'Æ6VE÷Væ6öæf—&ÖVB"’bb‡÷6—F–öâæW†V7WFVEVçF—G’óò’ÓÓÒ’°¢6öç7B5ET4µõÄ4TEôÔ…ôÕ2ÒR¢cóòòRÖ–çWFW0¢6öç7BÆ6VDvT×2ÒFFRææ÷r‚’Ò‡÷6—F–öâæ7&VFVDBÇÂ÷6—F–öâçWFFVDBÇÂFFRææ÷r‚’¢–b‡Æ6VDvT×2â5ET4µõÄ4TEôÔ…ôÕ2’°¢7GV6µ÷6—F–öç2çW6‚‡²÷6—F–öâÂÆ6VDvT×2Â5ET4µõÄ4TEôÔ…ôÕ2Ò¢&WGW&à¢Ð¢Ð ¢òòW†6†ævR6öçG&öÇ2vW&R&V6öæ6–ÆVBöæ6Rf÷"F†R6ö×ÆWFR‡—6–6À¢òò6Æ÷B&Vf÷&RF†RW"×÷6—F–öâv÷&¶W"ööÂâV6‚Æöv–6Â&÷r7F–ÆÀ¢òò'Vç2—G2÷vâG&–vvW"öÖ‚Ö†öÆB6†V6·2&VÆ÷rà ¢òò)H)H&ö7F—fR6Æ÷6RÖ–â×F–ÖR4ÂõE6†V6²)H)H)H)HûûÞûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òò6ÖR6fWG’æWB&V6öæ6–ÆTÆ—fU÷6—F–öç6'Vç2ÂÆ–VB†W&P¢òò6òF†RVæv–æRÆö÷6F6†W27&÷76W2&WGvVVâ7&öâF–6·2â–b¢òò7&÷72f—&W2vR6¶—F†RW"×÷6—F–öâ6WFW‚&VÆ÷r(	BF†R6Æ÷6P¢òò†VÇW"Ç&VG’W'6—7FVBF†RFW&Ö–æÂ7FFRæBÖ÷fVBF†P¢òò–æFW‚VçG'’FòF†R6Æ÷6VB&6†—fRà¢6öç7BÖ&µ&–6RÒçVÖ&W"‡÷6—F–öâæW†6†ævTFFòæÖ&µ&–6Róò¢–b†Ö&µ&–6Râ’°¢6öç7B7&÷76VBÒv—B6†V6´æDf÷&6T6Æ÷6Töå6ÇG7&÷72€¢6öææV7F–öä–BÀ¢÷6—F–öâÀ¢Ö&µ&–6RÀ¢W†6†ævT6öææV7F÷"À¢¢–b†7&÷76VB’&WGW&à¢Ð ¢òò)H)HÖ‚Ö†öÆB×F–ÖR6fWG’6Æ÷6W")H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òò–bF†R÷6—F–öâ†2&VVâ÷VâÆöævW"F†âÔ…ô„ôÄEõD”ÔUôÕ2À¢òòf÷&6RÖ6Æ÷6R—B&Vv&FÆW72öbv†WF†W"4ÂõEÆWfVÇ2vW&P¢òò7&÷76VBâF†—2—2F†R&÷&FW'2æ÷B6Æ÷6–ær–âF–ÖR"6fWG’æWB(	@¢òòWfVâ–bF†RW†6†ævR×Æ6VB4ÂõE÷&FW'2f–ÂFòf—&R†Rærà¢òòæWGv÷&²—77VRÂ–ÆÆ—V–BvÂ÷W&F÷"ÖçVÂ6æ6VÂ’ÂF†P¢òò÷6—F–öâv–ÆÂæ÷B&R†VÆB–æFVf–æ—FVÇ’à¢òð¢òòFVfVÇC¢B†÷W'2âÆ—fR÷fW'&–FRf–÷6WGF–æw2(i"7—7FVÒ(i ¢òòVæv–æRF–Ö–æw2(i"Ö…÷÷6—F–öåö†öÆEö×2†÷"FWÆ÷’×F–ÖP¢òòÔ…õõ4•D”ôåô„ôÄEôÕ2Vçbf"’âÒF—6&ÆVBà¢6öç7BÔ…ô„ôÄEõD”ÔUôÕ2Ò&W6öÇfTÖ„†öÆD×2†6öææV7F–öä–B¢6öç7B÷VæVDBÒ÷6—F–öâæ7&VFVDBÇÂ÷6—F–öâçWFFVDBÇÂ ¢6öç7B†VÆD×2ÒFFRææ÷r‚’Ò÷VæVD@¢–b€¢Ô…ô„ôÄEõD”ÔUôÕ2âb`¢†VÆD×2âÔ…ô„ôÄEõD”ÔUôÕ2b`¢÷6—F–öâæW†V7WFVEVçF—G’âb`¢—57—7FVÕG&6¶VDÆ—fU÷6—F–öâ‡÷6—F–öâÂ6öææV7F–öä–B’b`¢‡÷6—F–öâç7FGW2ÓÓÒ&÷Vâ"ÇÂ÷6—F–öâç7FGW2ÓÓÒ&f–ÆÆVB"¢’°¢6öç7BW†—E&–6RÒÖ&µ&–6RÇÂ÷6—F–öâæfW&vTW†V7WF–öå&–6RÇÂ÷6—F–öâæVçG'•&–6P¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡ÒÔ‚„ôÄBD”ÔRW†6VVFVBf÷"G·÷6—F–öâç7–Ö&öÇÒ††VÆBG´ÖF‚ç&÷VæB††VÆD×2òc—ÖÖ–ââG´ÖF‚ç&÷VæB„Ô…ô„ôÄEõD”ÔUôÕ2òc—ÖÖ–â’(	Bf÷&6RÖ6Æ÷6–ævÀ¢¢òòf—&RÖæBÖf÷&vWB(	B6Æ÷6R6†÷VÆBæ÷B&RvFVBöâÆörw&—FRà¢Æöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢'v&æ–ær"À¢Ö‚†öÆBF–ÖRW†6VVFVBf÷"G·÷6—F–öâç7–Ö&öÇÒ(	Bf÷&6RÖ6Æ÷6–ævÀ¢²÷6—F–öä–C¢÷6—F–öâæ–BÂ†VÆD×2ÂÖ„†öÆD×3¢Ô…ô„ôÄEõD”ÔUôÕ2ÂW†—E&–6RÒÀ¢’æ6F6‚‚‚’Óâ·Ò¢v—B6Æ÷6TÆ—fU÷6—F–öâ†6öææV7F–öä–BÂ÷6—F–öâæ–BÂW†—E&–6RÂW†6†ævT6öææV7F÷"Â&Ö…ö†öÆE÷F–ÖUöW†6VVFVB"¢&WGW&à¢Ð ¢6öç7B¶W’ÒÆ—fS§÷6—F–öã¢G·÷6—F–öâæ–GÖ ¢6öç7BFW&Ö–æÅ&WFVçF–öå6V6öæG2ÒÆ—fU&WFVçF–öå6V6öæG4f÷%7FGW2‡÷6—F–öâç7FGW2¢v—B6Æ–VçBç6WB€¢¶W’À¢¥4ôâç7G&–æv–g’†'V–ÆDÆ—fU÷6—F–öä6ö×F–&–Æ—G•6æ6†÷B‡÷6—F–öâ2Væ¶æ÷vâ2&V6÷&CÇ7G&–ærÂVæ¶æ÷vãâ’’À¢FW&Ö–æÅ&WFVçF–öå6V6öæG2ÓÒçVÆÀ¢ò²Uƒ¢FW&Ö–æÅ&WFVçF–öå6V6öæG2ÇÂÄ•dUõDU$Ô”äÅõ$UDTåD”ôåõ4T4ôäE2Ð¢¢VæFVf–æVBÀ¢’æ6F6‚‚‚’ÓâçVÆÂ¢–b‡FW&Ö–æÅ&WFVçF–öå6V6öæG2ÓÓÒçVÆÂ’°¢v—B6Æ–VçBçW'6—7B†¶W’’æ6F6‚‚‚’Óâ¢Ð¢VÖ—D6æöæ–6ÄWfVçB‡°¢G—S¢&Æ—fRç7FvT6†ævVB"À¢6öææV7F–öä–C¢÷6—F–öâæ6öææV7F–öä–BÇÂ6öææV7F–öä–BÀ¢7–Ö&öÃ¢÷6—F–öâç7–Ö&öÂÀ¢7FvS¢&Æ—fR"À¢FF¢²÷6—F–öä–C¢÷6—F–öâæ–BÂ7FGW3¢÷6—F–öâç7FGW2Â7F–öã¢'7–æ6VB"ÒÀ¢Ò¢–b‡FW&Ö–æÅ&WFVçF–öå6V6öæG2ÓÓÒçVÆÂ’°¢v—BW6W'E&VF—4Æ—7D†VB†6Æ–VçBÂÆ—fS§÷6—F–öç3¢G·÷6—F–öâæ6öææV7F–öä–GÖÂ÷6—F–öâæ–B¢v—B6Æ–VçBçW'6—7B†Æ—fS§÷6—F–öç3¢G·÷6—F–öâæ6öææV7F–öä–GÖ’æ6F6‚‚‚’Óâ¢Ð¢Ò6F6‚†W'"’°¢6öç6öÆRçv&â†G´Äôuõ$Td•‡ÒW'&÷"7–æ6–ærG·÷6—F–öâæ–GÓ¦ÂW'"¢Ð¢Ð ¢òò)H)H&÷VæFVB&ÆÆVÂööÂf÷"&ö6W74öæU7–æ2)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òòV6‚v÷&¶W"–6·2F†RæW‡BVç&ö6W76VB÷6—F–öâ'’–æFWƒ²7F÷2v†Và¢òòÆÂ÷6—F–öç2&R6Æ–ÖVBâÆÅ6WGFÆVBVç7W&W2öæR6Æ÷röf–Æ–æp¢òò÷6—F–öâæWfW"&WfVçG2F†R&W7Bg&öÒ6ö×ÆWF–ærà¢°¢ÆWBæW‡E7–æ4–G‚Ò ¢6öç7B7–æ5v÷&¶W"Ò7–æ2‚“¢&öÖ—6SÇfö–CâÓâ°¢v†–ÆR‡G'VR’°¢6öç7B’ÒæW‡E7–æ4–G‚²°¢–b†’ãÒ÷Vå÷6—F–öç2æÆVæwF‚’&WGW&à¢v—Bv—F…F–ÖV÷WB€¢&ö6W74öæU7–æ2†÷Vå÷6—F–öç5¶•Ò’À¢5”ä5õU%õõ5õD”ÔTõUEôÕ2À¢7–æ5v—F„W†6†ævRç&ö6W74öæU7–æ2‚G¶÷Vå÷6—F–öç5¶•Òç7–Ö&öÇÒ–À¢’æ6F6‚‚†W'#¢Væ¶æ÷vâ’Óâ°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò·7–æ2×ööÅÒ÷6—F–öâG¶÷Vå÷6—F–öç5¶•Óòæ–GÒF–ÖVB÷WB÷"W'&÷&VC¦À¢W'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"’À¢¢Ò¢Ð¢Ð¢6öç7BööÅ6—¦RÒÖF‚æÖ–â…5”ä5ô4ôä5U%$Tä5’Â÷Vå÷6—F–öç2æÆVæwF‚¢–b‡ööÅ6—¦Râ’°¢v—B&öÖ—6RæÆÅ6WGFÆVB„'&’æg&öÒ‡²ÆVæwFƒ¢ööÅ6—¦RÒÂ‚’Óâ7–æ5v÷&¶W"‚’’¢Ð¢Ð ¢òò7–æ26ö×ÆWF–öâ†V'F&VBâ—'2v—F‚F†R·7–æ2×F–6µÖVçG'’Æöp¢òò6òF†R÷W&F÷"6â6VRF†RÆö÷&âFò6ö×ÆWF–öâ†æ÷B6–ÆVçFÇ¢òò&÷'FVB'’âVæ6Vv‡BF‡&÷r’æB†÷rÆöær—BFöö²â–b·7–æ2×F–6µÐ¢òòV'2'WB·7–æ2ÖFöæUÒFöW2æ÷Bf÷"F†R6ÖRF–6²Â6öÖWF†–æp¢òòÖ–BÖÆö÷—2&V¦V7F–ær&Vf÷&RF†R6Æ÷6–ær'&6R(	Bv†–6‚W6VBFò&P¢òò–çf—6–&ÆRà¢òò)H)H&ÆÆVÂ7GV6²×Æ6VB6ÆVçW)H)H)H)H)H)H)H)H)H)HûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òò'VâÆÂ6æ6VÂ¶6Æ÷6R÷W&F–öç26öæ7W'&VçFÇ’6òb²7GV6²÷6—F–öç0¢òò6ö×ÆWFR–âæöæR%EBv–æF÷r–ç7FVBöbU„4„ätUõD”ÔTõUEô4ä4TÅôõ$DU%ôÕ29râà¢–b‡7GV6µ÷6—F–öç2æÆVæwF‚â’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò·7GV6²×Æ6VEÒ&ö6W76–ærG·7GV6µ÷6—F–öç2æÆVæwF‡Ò7GV6²Ö–â×Æ6VB÷6—F–öâ‡2’–â&ÆÆVÆÀ¢¢v—B&öÖ—6RæÆÅ6WGFÆVB€¢7GV6µ÷6—F–öç2æÖ†7–æ2‡²÷6—F–öâÂÆ6VDvT×2Â5ET4µõÄ4TEôÔ…ôÕ2Ò’Óâ°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò·7GV6²×Æ6VEÒG·÷6—F–öâç7–Ö&öÇÒ†–CÒG·÷6—F–öâæ–GÒ’†2&VVâwÆ6VBrf÷"G´ÖF‚ç&÷VæB‡Æ6VDvT×2ò—×2(	B6æ6VÆÆ–ærVçG'’÷&FW"æB&V¦V7F–ær÷6—F–öæÀ¢¢òòf—&RÖæBÖf÷&vWB(	BÆör6†÷VÆBæ÷BFVÆ’6æ6VÂ²6Æ÷6Rà¢Æöu&öw&W76–öäWfVçB€¢6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢'v&æ–ær"À¢VçG'’÷&FW"7GV6²–âwÆ6VBr7FFRf÷"G·÷6—F–öâç7–Ö&öÇÒ(	B6æ6VÆÆ–ævÀ¢°¢÷6—F–öä–C¢÷6—F–öâæ–BÀ¢÷&FW$–C¢÷6—F–öâæ÷&FW$–BÀ¢Æ6VDvT×2À¢7GV6´Æ–Ö—D×3¢5ET4µõÄ4TEôÔ…ôÕ2À¢ÒÀ¢’æ6F6‚‚‚’Óâ·Ò¢òò&W7BÖVff÷'B6æ6VÂöbF†RVçG'’÷&FW"†&÷VæFVBF–ÖV÷WB’à¢òòG&6²v†WF†W"F†R6æ6VÂ7V66VVFVB(	B–b—BF–ÖVB÷WBvR6¶— ¢òòF†RW†6†ævRÖ6Æ÷6RÆVrFòfö–B&Æö6¶–æræ÷F†W"s2ƒ"9r3R2¢òòöââÇ&VG’×Vç&W7öç6—fRW†6†ævRà¢ÆWB6æ6VÅ7V66VVFVBÒfÇ6P¢–b‡÷6—F–öâæ÷&FW$–BbbW†6†ævT6öææV7F÷#òæ6æ6VÄ÷&FW"’°¢G'’°¢v—Bv—F…F–ÖV÷WB€¢W†6†ævT6öææV7F÷"æ6æ6VÄ÷&FW"‡÷6—F–öâç7–Ö&öÂÂ÷6—F–öâæ÷&FW$–B’2&öÖ—6SÆç“âÀ¢U„4„ätUõD”ÔTõUEô4ä4TÅôõ$DU%ôÕ2À¢7GV6²×Æ6VB6æ6VÄ÷&FW"‚G·÷6—F–öâç7–Ö&öÇÒG·÷6—F–öâæ÷&FW$–GÒ–À¢¢6æ6VÅ7V66VVFVBÒG'VP¢Ò6F6‚†6æ6VÄW'"’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò·7GV6²×Æ6VEÒ6æ6VÂVçG'’÷&FW"f–ÆVBf÷"G·÷6—F–öâæ–GÓ¦À¢6æ6VÄW'"–ç7Fæ6VöbW'&÷"ò6æ6VÄW'"æÖW76vR¢7G&–ær†6æ6VÄW'"’À¢¢Ð¢Ð¢òòÖ&²÷6—F–öâ&V¦V7FVBæB&VÖ÷fRg&öÒ÷Vâ–æFW‚à¢òò–b6æ6VÄ÷&FW"F–ÖVB÷WBF†RW†6†ævR—2Vç&W7öç6—fR(	B6¶— ¢òòF†RW†6†ævRÖ6Æ÷6R‡72çVÆÂ6öææV7F÷"’Fòfö–Bæ÷F†W"s0¢òòv—BâF†R÷6—F–öâ—2D"Ö6Æ÷6VB–ÖÖVF–FVÇ“²F†RW†6†ævR6–FP¢òòv–ÆÂ6VÆbÖ†VÂv†VâF†R÷&FW"W‡—&W2÷"F†RæW‡B7–æ2FWFV7G2—Bà¢6öç7B6Æ÷6T6öææV7F÷"Ò6æ6VÅ7V66VVFVBòW†6†ævT6öææV7F÷"¢çVÆÀ¢G'’°¢v—B6Æ÷6TÆ—fU÷6—F–öâ€¢6öææV7F–öä–BÀ¢÷6—F–öâæ–BÀ¢÷6—F–öâæVçG'•&–6RÇÂÀ¢6Æ÷6T6öææV7F÷"À¢'7GV6µö–å÷Æ6VB"À¢¢Ò6F6‚†6Æ÷6TW'"’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò·7GV6²×Æ6VEÒ6Æ÷6TÆ—fU÷6—F–öâf–ÆVBf÷"G·÷6—F–öâæ–GÓ¦À¢6Æ÷6TW'"–ç7Fæ6VöbW'&÷"ò6Æ÷6TW'"æÖW76vR¢7G&–ær†6Æ÷6TW'"’À¢¢Ð¢Ò’À¢¢Ð ¢òò6ö×ÆWFRç’vw&VvFRVçF—G’†æBÖöfb&öGV6VB'’F†R&ÆÆVÀ¢òòv÷&¶W'2&Vf÷&R&W÷'F–ærF†—27–æ22FöæRâF†—2—2FVÆ–&W&FVÇ’gFW ¢òò7GV6²ÖVçG'’6ÆVçW2F†BF‚6âÇ6ò&VÆV6R‡—6–6Â6Æ÷Bà¢6öç7BVWVVDvw&VvFU6Æ÷G2ÒVWVVDvw&VvFU&÷FV7F–öäf–æÆ—¦F–öç2†6öææV7F–öä–B¢–b‡VWVVDvw&VvFU6Æ÷G2ç6—¦Râ’°¢G'’°¢6öç7Bf–æÆ—¦F–öâÒv—Bf–æÆ—¦UVWVVDvw&VvFU&÷FV7F–öâ€¢6öææV7F–öä–BÀ¢W†6†ævT6öææV7F÷"À¢VWVVDvw&VvFU6Æ÷G2À¢¢6WGFÆTvw&VvFU&÷FV7F–öäf–æÆ—¦F–öç2†6öææV7F–öä–BÂf–æÆ—¦F–öâæ6ö×ÆWFVE6Æ÷G2¢–b†f–æÆ—¦F–öâç&V&ÖVDÆVFW'2âÇÂf–æÆ—¦F–öâæ6†ævVE÷6—F–öç2â’°¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Ò¶vw&VvFRÖf–æÆ—¦UÒ6öæãÒG¶6öææV7F–öä–GÒ°¢&V&ÖVCÒG¶f–æÆ—¦F–öâç&V&ÖVDÆVFW'7Ò6†ævVCÒG¶f–æÆ—¦F–öâæ6†ævVE÷6—F–öç7ÖÀ¢¢Ð¢Ò6F6‚†W'&÷"’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò¶vw&VvFRÖf–æÆ—¦UÒf–ÆVC²&WF–æ–ærGW&&ÆR&WG'’VWVS¦À¢W'&÷"–ç7Fæ6VöbW'&÷"òW'&÷"æÖW76vR¢7G&–ær†W'&÷"’À¢¢Ð¢Ð ¢6öç7B7–æ4×2ÒFFRææ÷r‚’Ò7–æ57F'D×0¢6öç6öÆRæÆör€¢G´Äôuõ$Td•‡Ò·7–æ2ÖFöæUÒ6öæãÒG¶6öææV7F–öä–GÒFöö³ÒG·7–æ4×7Ö×2&ö6W76VCÒG¶÷Vå÷6—F–öç2æÆVæwF‡ÒF÷FVCÒG¶F÷FVD6÷VçGÖÀ¢¢Ò6F6‚†W'"’°¢6öç6öÆRæW'&÷"†G´Äôuõ$Td•‡ÒW'&÷"7–æ6–ærv—F‚W†6†ævS¦ÂW'"¢Òf–æÆÇ’°¢7F÷7–æ4Æö6´ÆV6U&Vg&W6ƒòâ‚¢–b†Æö6´7V—&VBbb6Æ–VçB’°¢G'’°¢v—BWfÄÆö6´ÇV†6Æ–VçBÂ$TÄT4UôÄô4µôÅTÂÄ•dUõ5”ä5ôÄô4µô´U’Â·7–æ4Æö6µFö¶VåÒ¢Ò6F6‚‡&VÆV6TW'"’°¢òòÆö6²v–ÆÂW‡—&Rf–EDÂ(	BÆör'WBFöâwB7W&f6Rà¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò·7–æ2ÖÆö6µÒ&VÆV6Rf–ÆVBf÷"G¶6öææV7F–öä–GÓ²EDÂv–ÆÂ&V¦À¢&VÆV6TW'"–ç7Fæ6VöbW'&÷"ò&VÆV6TW'"æÖW76vR¢7G&–ær‡&VÆV6TW'"’À¢¢Ð¢Ð¢Ð§Ð ¢ò¢ ¢¢&V6Æ7VÆFRF†RFW6—&VB4ÂõEf÷"6–ævÆRÆ—fR÷6—F–öâæBÇ¢¢F†R6†ævRFòF†RW†6†ævRâW6VB'’F†R7G&FVw’6ö÷&F–æF÷"v†Vâà¢¢÷W&F÷"VF—G24ÂõEW&6VçFvW2öââ7F—fR6öææV7F–öâ(	Bv—F†÷W@¢¢F†—2ÂF†RW†6†ævR×6–FRÆWfVÇ27F’vÇVVBFòF†R÷&–v–æÂf–ÆÂæ@¢¢F†R6†ævRöæÇ’ffV7G2æWvÇ’Ö÷VæVB÷6—F–öç2à¢ ¢¢72WFFVB7F÷Æ÷757FòF¶U&öf—E7FFò÷fW'&–FRF†RfÇVW0¢¢7F÷&VBöâF†RÆ—fR÷6—F–öã²öÖ—BF†VÒFò&V6ö×WFRg&öÒv†FWfW ¢¢—27W'&VçFÇ’öâF†RÆ—fU÷6—F–öâ&V6÷&B‡W6VgVÂ2&f÷&6RÖ†VÂ ¢¢gFW"Ö—76VB&V6öæ6–ÆR’à¢ ¢¢&WGW&ç2çVÆÆ–bF†R÷6—F–öâFöW6âwBW†—7B÷"—2Ç&VG’6Æ÷6VBà¢¢ð¦W‡÷'B7–æ2gVæ7F–öâ&V6Æ7VÆFTæDÇ•4ÅE€¢6öææV7F–öä–C¢7G&–ærÀ¢Æ—fU÷6—F–öä–C¢7G&–ærÀ¢W†6†ævT6öææV7F÷#¢ç’À¢÷fW'&–FW3ó¢°¢7F÷Æ÷757Có¢çVÖ&W ¢F¶U&öf—E7Có¢çVÖ&W ¢G&–Æ–æt7F—fSó¢&ööÆVà¢G&–Æ–æu7F÷&–6Só¢çVÖ&W ¢ÖçVÅ&÷FV7F–öãó¢°¢7F÷Æ÷75&–6Só¢çVÖ&W"ÂçVÆÀ¢F¶U&öf—E&–6Só¢çVÖ&W"ÂçVÆÀ¢G&–Æ–ætVæ&ÆVCó¢&ööÆVà¢G&–Æ–ætF—7Fæ6U7Có¢çVÖ&W ¢Ð¢6ÆV$ÖçVÅ&÷FV7F–öãó¢&ööÆVà¢ÒÀ¢“¢&öÖ—6SÄÆ—fU÷6—F–öâÂçVÆÃâ°¢v—B–æ—E&VF—2‚¢6öç7B6Æ–VçBÒvWE&VF—46Æ–VçB‚ ¢òò)H)H'VrÓf—ƒ¢7V—&RÆ—fU÷7–æ5öÆö6²$Tdõ$RF†R&VBÖÖöF–g’×w&—FR)H)H)H)H)H)H)H)H ¢òòv—F†÷WBF†—2Æö6²Â&V6Æ7VÆFTæDÇ•4ÅE†6ÆÆVBg&öÐ¢òò7–æ4Æ—fTg&öÕ6WVFö–âF†R#×2Væv–æRÆö÷’&6W2v–ç7@¢òò&V6öæ6–ÆTÆ—fU÷6—F–öç6ò7–æ5v—F„W†6†ævVÂ&÷F‚öbv†–6‚Ç6ò†öÆ@¢òòF†—2Æö6²v†–ÆR6ÆÆ–ærWFFU&÷FV7F–öä÷&FW'6f÷"F†R6ÖR÷6—F–öâà¢òòF†R&6R&öGV6W2Gvò6öæ7W'&VçBÆ6U7F÷÷&FW&6ÆÇ2(i"Gvò4Â÷"Gvð¢òòE&VGV6RÖöæÇ’÷&FW'2öâF†RW†6†ævRâF†RÆFW"6fU÷6—F–öæF†Và¢òò÷fW'w&—FW2F†R–âÖÖVÖ÷'’÷6—F–öâÂÆ÷6–ærF†R÷&FW"Ô”G2w&—GFVâ'’F†P¢òò÷F†W"6ÆÆW"â†öÆF–ærF†RÆö6²†W&R6W&–Æ—6W2ÆÂF‡&VR6ÆÆW'2à¢òð¢òò–bF†RÆö6²—2Ç&VG’†VÆB†Ö–âÆö÷—2Ö–B×&V6öæ6–ÆR’ÂvR&WG'’öæ6P¢òògFW"×26ò÷W&F÷"×G&–vvW&VB÷fW'&–FW27F–ÆÂÇ’&ö×FÇ’–âF†P¢òòv&WGvVVâF–6·2&F†W"F†â6–ÆVçFÇ’æòÖ÷–ærà¢6öç7BÄô4µô´U’ÒÆ—fU÷7–æ5öÆö6³¢G¶6öææV7F–öä–GÖ ¢6öç7BÄô4µõEDÂÒ3 ¢6öç7BÆö6µFö¶VâÒ&V6Æ3¢G·&ö6W72ç–GÓ¢G´FFRææ÷r‚—Ó¢G¶ææö–Bƒ—Ö ¢ÆWBÆö6´7V—&VBÒfÇ6P¢ÆWB×WFF–öäÆö6´†VÆBÒfÇ6P¢ÆWB7F÷×WFF–öäÆV6U&Vg&W6ƒ¢‚‚’Óâfö–B’ÂçVÆÂÒçVÆÀ¢ÆWB7F÷Æö6´ÆV6U&Vg&W6ƒ¢‚‚’Óâfö–B’ÂçVÆÂÒçVÆÀ¢òòf7B&÷VæFVB6öçFVçF–öâv—C¢Ö÷7B7–æ276W26ö×ÆWFR–ç6–FRöæP¢òò#(	33×26FVæ6RâæWfW"÷fW&Æ7F–ÆÂ×'Vææ–ær&V6öæ6–ÆS²–b—B&VÖ–ç0¢òò'W7’ÂF†RæW‡B6WVFò&F6†WB÷7–æ272&WG&–W2g&öÒGW&&ÆR7FFRà¢f÷"†ÆWBGFV×BÒ²GFV×BÂS²GFV×B²²’°¢6öç7B6WE&W7VÇBÒv—B†6Æ–VçBç6WB„Äô4µô´U’ÂÆö6µFö¶VâÂ²åƒ¢G'VRÂUƒ¢Äô4µõEDÂÒ’2ç’¢–b‡6WE&W7VÇBÓÓÒ$ô²"’²Æö6´7V—&VBÒG'VS²'&V²Ð¢–b†GFV×BÂB’v—BæWr&öÖ—6R‡"Óâ6WEF–ÖV÷WB‡"ÂS’¢Ð¢–b‚Æö6´7V—&VB’°¢òòÆö6²7F–ÆÂ†VÆBgFW"öæR&WG'’(	B6¶—F†—2F–6³²F†RÖ–â7–æ2Æö÷ ¢òòv–ÆÂ&RÖ&Ò÷&FW'26÷'&V7FÇ’öâ—G2æW‡B72à¢6öç6öÆRçv&â†G´Äôuõ$Td•‡Ò&V6Æ7VÆFTæDÇ•4ÅE¢Æö6²'W7’f÷"G¶6öææV7F–öä–GÒÂ6¶—–ærF–6¶¢&WGW&âçVÆÀ¢Ð¢7F÷Æö6´ÆV6U&Vg&W6‚Ò7F'E&VF—4Æö6´ÆV6U&Vg&W6‚€¢6Æ–VçBÀ¢Äô4µô´U’À¢Æö6µFö¶VâÀ¢Äô4µõEDÂ¢À¢ ¢G'’°¢×WFF–öäÆö6´†VÆBÒv—B7V—&U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6µFö¶Vâ¢–b‚×WFF–öäÆö6´†VÆB’&WGW&âçVÆÀ¢7F÷×WFF–öäÆV6U&Vg&W6‚Ò7F'E&VF—4Æö6´ÆV6U&Vg&W6‚€¢6Æ–VçBÂ÷6—F–öä×WFF–öäÆö6´¶W’†6öææV7F–öä–BÂÆ—fU÷6—F–öä–B’ÂÆö6µFö¶VâÂõ4•D”ôåôÕUDD”ôåôÄô4µõEDÅôÕ2À¢¢òò&R×&VB&÷F‚6æöæ–6Â6÷W&6W2eDU"7V—&–ærF†RÆö6²6òvR6VRç¢òòw&—FW2F†R&Wf–÷W2Æö6²Ö†öÆFW"‡&V6öæ6–ÆRò7–æ2’§W7B6öÖÖ—GFVBâF†P¢òò¥4ôâ¶W’—2–çFVçF–öæÆÇ’6ö×7BæB6ææ÷B&RW6VBöâ—G2÷vâf÷"¢òò&÷FV7F–öâ&V6Æ7VÆF–öâà¢6öç7B÷6—F–öâÒv—B&VDÆ—fU÷6—F–öå6æ6†÷B†6Æ–VçBÂ6öææV7F–öä–BÂÆ—fU÷6—F–öä–B¢–b‚÷6—F–öâ’&WGW&âçVÆÀ¢–b€¢÷6—F–öâç7FGW2ÓÓÒ&6Æ÷6VB"ÇÀ¢÷6—F–öâç7FGW2ÓÓÒ'&V¦V7FVB"ÇÀ¢÷6—F–öâç7FGW2ÓÓÒ&W'&÷""ÇÀ¢÷6—F–öâæW†V7WFVEVçF—G’ÃÒ ¢’°¢&WGW&â÷6—F–öà¢Ð ¢òò7–æ4Æ—fTg&öÕ6WVFö—2–çFVçF–öæÆÇ’f—&RÖæBÖf÷&vWB6ò—BæWfW ¢òò&Æö6·2F†R&VÇF–ÖRF–6²âGvò&F6†WG26âF†W&Vf÷&R&V6‚F†—2Æö6¶V@¢òò&VBÖÖöF–g’×w&—FRF‚÷WBöb÷&FW"â&V¦V7BâöÆFW"'6öÇWFRÆWfVÂ†W&P¢òò†gFW"&W&VF–ær&VF—2VæFW"F†RÆö6²’&F†W"F†âÆÆ÷v–ær—BFòÆö÷6Và¢òòâÇ&VG’F–v‡FVæVBÆöær÷6†÷'B7F÷öâF†RW†6†ævRà¢6öç7B—4WFöÖFVEG&–Æ–æu7–æ2Ð¢÷fW'&–FW3òæÖçVÅ&÷FV7F–öâb`¢÷fW'&–FW3òæ6ÆV$ÖçVÅ&÷FV7F–öâb`¢÷fW'&–FW3òçG&–Æ–æt7F—fRÓÓÒG'VRb`¢ö&¦V7Bç&÷F÷G—Ræ†4÷vå&÷W'G’æ6ÆÂ†÷fW'&–FW2ÇÂ·ÒÂ'G&–Æ–æu7F÷&–6R"¢–b†—4WFöÖFVEG&–Æ–æu7–æ2bb—5G&–Æ–æu7F÷F–v‡FVæ–ær‡÷6—F–öâÂ÷fW'&–FW3òçG&–Æ–æu7F÷&–6R’’°¢&WGW&â÷6—F–öà¢Ð ¢òò6GW&R&RÖ÷fW'&–FRfÇVW26òvR6âVF—BF†RF–fb–â&öw&W76–öâà¢òòæ÷FS¢vRFVÆ–&W&FVÇ’FòäõBF÷V6‚76–væVE7F÷Æ÷76ð¢òò76–væVEF¶U&öf—F(	BF†÷6R&RF†R–Ö×WF&ÆR7G&FVw’Ö6öçG&7@¢òò6æ6†÷BâgFW"F†—26ÆÂF†W’&VÖ–âWVÂFòF†V—"7&VF–öâ×F–ÖP¢òòfÇVW2v†–ÆR7F÷Æ÷76òF¶U&öf—F6''’F†R÷W&F÷"÷fW'&–FRà¢6öç7B&We7F÷Æ÷757BÒ÷6—F–öâç7F÷Æ÷70¢6öç7B&WeF¶U&öf—E7BÒ÷6—F–öâçF¶U&öf—@¢6öç7B&Wf–÷W4ÖçVÅ&÷FV7F–öâÒ÷6—F–öâæÖçVÅ&÷FV7F–öä÷fW'&–FP¢ò²ââç÷6—F–öâæÖçVÅ&÷FV7F–öä÷fW'&–FRÐ¢¢VæFVf–æV@¢–b†÷fW'&–FW3òæ6ÆV$ÖçVÅ&÷FV7F–öâ’°¢÷6—F–öâæÖçVÅ&÷FV7F–öä÷fW'&–FRÒVæFVf–æV@¢÷6—F–öâçG&–Æ–æt7F—fRÒfÇ6P¢÷6—F–öâçG&–Æ–æu7F÷&–6RÒVæFVf–æV@¢Ð¢–b†÷fW'&–FW3òæÖçVÅ&÷FV7F–öâ’°¢6öç7B–æ6öÖ–ærÒ÷fW'&–FW2æÖçVÅ&÷FV7F–öà¢6öç7B&Wf–÷W2Ò÷6—F–öâæÖçVÅ&÷FV7F–öä÷fW'&–FP¢6öç7BæW‡C¢æöäçVÆÆ&ÆSÄÆ—fU÷6—F–öå²&ÖçVÅ&÷FV7F–öä÷fW'&–FR%ÓâÒ°¢âââ‡&Wf–÷W2ÇÂ²WFFVDC¢FFRææ÷r‚’Â6÷W&6S¢&÷W&F÷""26öç7BÒ’À¢WFFVDC¢FFRææ÷r‚’À¢6÷W&6S¢&÷W&F÷""À¢Ð¢–b„ö&¦V7Bç&÷F÷G—Ræ†4÷vå&÷W'G’æ6ÆÂ†–æ6öÖ–ærÂ'7F÷Æ÷75&–6R"’’°¢6öç7BfÇVRÒ–æ6öÖ–ærç7F÷Æ÷75&–6P¢æW‡Bç7F÷Æ÷75&–6RÒfÇVRÓÓÒçVÆÂòçVÆÂ¢çVÖ&W"‡fÇVR¢Ð¢–b„ö&¦V7Bç&÷F÷G—Ræ†4÷vå&÷W'G’æ6ÆÂ†–æ6öÖ–ærÂ'F¶U&öf—E&–6R"’’°¢6öç7BfÇVRÒ–æ6öÖ–ærçF¶U&öf—E&–6P¢æW‡BçF¶U&öf—E&–6RÒfÇVRÓÓÒçVÆÂòçVÆÂ¢çVÖ&W"‡fÇVR¢Ð¢–b„ö&¦V7Bç&÷F÷G—Ræ†4÷vå&÷W'G’æ6ÆÂ†–æ6öÖ–ærÂ'G&–Æ–ætVæ&ÆVB"’’°¢æW‡BçG&–Æ–ætVæ&ÆVBÒ–æ6öÖ–ærçG&–Æ–ætVæ&ÆVBÓÓÒG'VP¢Ð¢–b„ö&¦V7Bç&÷F÷G—Ræ†4÷vå&÷W'G’æ6ÆÂ†–æ6öÖ–ærÂ'G&–Æ–ætF—7Fæ6U7B"’’°¢æW‡BçG&–Æ–ætF—7Fæ6U7BÒçVÖ&W"†–æ6öÖ–ærçG&–Æ–ætF—7Fæ6U7B¢Ð¢÷6—F–öâæÖçVÅ&÷FV7F–öä÷fW'&–FRÒæW‡@¢÷6—F–öâçG&–Æ–æt7F—fRÒæW‡BçG&–Æ–ætVæ&ÆVBÓÓÒG'VP¢–b‚÷6—F–öâçG&–Æ–æt7F—fR’÷6—F–öâçG&–Æ–æu7F÷&–6RÒVæFVf–æV@¢Ð¢6öç7Bæ÷&ÖÆ—¦VD÷fW'&–FU6ÂÒ÷fW'&–FW3òç7F÷Æ÷757BÓÒVæFVf–æV@¢òæ÷&ÖÆ—¦U7F÷Æ÷75W&6VçB†÷fW'&–FW2ç7F÷Æ÷757B¢¢çVÆÀ¢–b†æ÷&ÖÆ—¦VD÷fW'&–FU6Â’÷6—F–öâç7F÷Æ÷72Òæ÷&ÖÆ—¦VD÷fW'&–FU6ÂçfÇVP¢–b†÷fW'&–FW3òçF¶U&öf—E7BÓÒVæFVf–æVB’÷6—F–öâçF¶U&öf—BÒ÷fW'&–FW2çF¶U&öf—E7@¢–b†÷fW'&–FW2bbö&¦V7Bç&÷F÷G—Ræ†4÷vå&÷W'G’æ6ÆÂ†÷fW'&–FW2Â'G&–Æ–æt7F—fR"’’°¢÷6—F–öâçG&–Æ–æt7F—fRÒ÷fW'&–FW2çG&–Æ–æt7F—fRÓÓÒG'VP¢Ð¢–b†÷fW'&–FW2bbö&¦V7Bç&÷F÷G—Ræ†4÷vå&÷W'G’æ6ÆÂ†÷fW'&–FW2Â'G&–Æ–æu7F÷&–6R"’’°¢6öç7BæW‡EG&–Æ–æu7F÷ÒçVÖ&W"†÷fW'&–FW2çG&–Æ–æu7F÷&–6R¢÷6—F–öâçG&–Æ–æu7F÷&–6RÒçVÖ&W"æ—4f–æ—FR†æW‡EG&–Æ–æu7F÷’bbæW‡EG&–Æ–æu7F÷â ¢òæW‡EG&–Æ–æu7F÷ ¢¢VæFVf–æV@¢Ð ¢æ÷&ÖÆ—¦TÆ—fU÷6—F–öå&÷FV7F–öâ‡÷6—F–öâ ¢6öç7B6Ä6†ævVBÒ÷6—F–öâç7F÷Æ÷72ÓÒ&We7F÷Æ÷757@¢6öç7BG6†ævVBÒ÷6—F–öâçF¶U&öf—BÓÒ&WeF¶U&öf—E7@¢6öç7BÖçVÅ&÷FV7F–öä6†ævVBÒ¥4ôâç7G&–æv–g’‡&Wf–÷W4ÖçVÅ&÷FV7F–öâ’ÓÒ¥4ôâç7G&–æv–g’‡÷6—F–öâæÖçVÅ&÷FV7F–öä÷fW'&–FR¢–b‡6Ä6†ævVBÇÂG6†ævVBÇÂÖçVÅ&÷FV7F–öä6†ævVB’°¢òò6–ævÆRVF—B×G&–ÂWfVçBW"÷fW'&–FRâF†R&öw&W76–öâæVÀ¢òò6†÷w2—B2Æ—fU÷G&F–ær–æfö&÷rÆöæw6–FRF†R7V'6WVVç@¢òòWFFU÷6Å÷G7FWW6†VB'’WFFU&÷FV7F–öä÷&FW'6âFövWF†W ¢òòF†W’FVÆÂF†RgVÆÂ7F÷'“¢&÷W&F÷"6†ævVB4Âg&öÒ‚RFò’RÀ¢òòW†6†ævR÷&FW"&RÖ&ÖVBB&–6R¢"à¢v—BÆöu&öw&W76–öäWfVçB€¢÷6—F–öâæ6öææV7F–öä–BÀ¢&Æ—fU÷G&F–ær"À¢&–æfò"À¢4ÂõE÷fW'&–FRÆ–VBFòG·÷6—F–öâç7–Ö&öÇÖÀ¢°¢76–væVE7F÷Æ÷757C¢÷6—F–öâæ76–væVE7F÷Æ÷72À¢76–væVEF¶U&öf—E7C¢÷6—F–öâæ76–væVEF¶U&öf—BÀ¢&Wf–÷W57F÷Æ÷757C¢&We7F÷Æ÷757BÀ¢&Wf–÷W5F¶U&öf—E7C¢&WeF¶U&öf—E7BÀ¢æWu7F÷Æ÷757C¢÷6—F–öâç7F÷Æ÷72À¢æWuF¶U&öf—E7C¢÷6—F–öâçF¶U&öf—BÀ¢7F÷Æ÷74æ÷&ÖÆ—¦VC¢æ÷&ÖÆ—¦VD÷fW'&–FU6ÃòæF§W7FVBÇÂfÇ6RÀ¢7F÷Æ÷74æ÷&ÖÆ—¦F–öå&V6öã¢æ÷&ÖÆ—¦VD÷fW'&–FU6Ãòç&V6öâÀ¢6Ä6†ævVBÀ¢G6†ævVBÀ¢ÖçVÅ&÷FV7F–öä6†ævVBÀ¢ÖçVÅ&÷FV7F–öä÷fW'&–FS¢÷6—F–öâæÖçVÅ&÷FV7F–öä÷fW'&–FRÀ¢ÒÀ¢¢Ð ¢òòF—&V7B÷fW'&–FR÷G&–Æ–ærWFFW2Ç&VG’¶æ÷rF†R&V6÷&FVB÷&FW"”G2æ@¢òò–çFVçF–öæÆÇ’fö–BâW‡G&÷VâÖ÷&FW'26æ6†÷B%EBöâF†R7&—F–6À¢òòF‚â6æ6VÅ&÷FV7F–öä÷&FW"G&VG2Ç&VG’ÖvöæR”G227V66W73²F†P¢òòF†R#ƒ×26æöæ–6Â7–æ2–æFWVæFVçFÇ’W&f÷&×2gVÆÂÆ—fVæW72†VÆ–ærà¢&F6†WDÖçVÅG&–Æ–æu7F÷‡÷6—F–öâ¢÷6—F–öâçWFFVDBÒFFRææ÷r‚¢v—B&V&Õ&÷FV7F–öägFW%VçF—G”×WFF–öâ†W†6†ævT6öææV7F÷"Â÷6—F–öâÂ&ÖçVÅ÷&V6Æ2" ¢òòF†Rf÷&6VBÖ6Æ÷6RF‚7V—&W2F†R6ÖR÷6—F–öâÆV6RæB&W&VG2F†P¢òò§W7B×W'6—7FVB7FFRâ&VÆV6R÷W"ÆV6R&Vf÷&R†æF–ær÷fW"Fò—Bà¢7F÷×WFF–öäÆV6U&Vg&W6ƒòâ‚¢7F÷×WFF–öäÆV6U&Vg&W6‚ÒçVÆÀ¢v—B&VÆV6U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6µFö¶Vâ¢×WFF–öäÆö6´†VÆBÒfÇ6P ¢òò)H)H–ÖÖVF–FR÷7BÖ÷fW'&–FR7&÷726†V6²)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òò–bF†R÷W&F÷"§W7BF–v‡FVæVB4Â÷"EFòÆWfVÂF†R÷6—F–öà¢òò—2Ç&VG’7BÂF†RW†6†ævR×Æ6VB&VGV6RÖöæÇ’÷&FW"Ö’F¶P¢òòÖöÖVçBFòf—&R†÷"&R&V¦V7FVB÷WG&–v‡B2'G&–vvW"&–6P¢òòÇ&VG’'&V6†VB"’â'VâF†R6ÖR&ö7F—fR6Æ÷6R†VÇW"W6VB'¢òòF†RVæv–æRÆö÷6òF†R÷6—F–öâ—2&V6öæ6–ÆVBFò6Æ÷6VBv—F†–à¢òòF†R6ÖR6ÆÂ&F†W"F†âv—F–ærf÷"F†RæW‡B7&öâF–6²à¢G'’°¢6öç7BÖ&µ&–6RÒçVÖ&W"‡÷6—F–öâæW†6†ævTFFòæÖ&µ&–6Róò¢–b†Ö&µ&–6Râ’°¢v—B6†V6´æDf÷&6T6Æ÷6Töå6ÇG7&÷72€¢÷6—F–öâæ6öææV7F–öä–BÀ¢÷6—F–öâÀ¢Ö&µ&–6RÀ¢W†6†ævT6öææV7F÷"À¢¢Ð¢Ò6F6‚†7&÷74W'"’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò÷7BÖ÷fW'&–FR7&÷726†V6²W'&÷"f÷"G·÷6—F–öâæ–GÓ¦À¢7&÷74W'"–ç7Fæ6VöbW'&÷"ò7&÷74W'"æÖW76vR¢7G&–ær†7&÷74W'"’À¢¢Ð¢&WGW&â÷6—F–öà¢Ò6F6‚†W'"’°¢6öç6öÆRæW'&÷"†G´Äôuõ$Td•‡Ò&V6Æ7VÆFTæDÇ•4ÅEW'&÷#¦ÂW'"¢&WGW&âçVÆÀ¢Òf–æÆÇ’°¢7F÷×WFF–öäÆV6U&Vg&W6ƒòâ‚¢–b†×WFF–öäÆö6´†VÆB’°¢v—B&VÆV6U÷6—F–öä×WFF–öäÆö6²†6öææV7F–öä–BÂÆ—fU÷6—F–öä–BÂÆö6µFö¶Vâ’æ6F6‚‚‚’ÓâfÇ6R¢Ð¢7F÷Æö6´ÆV6U&Vg&W6ƒòâ‚¢òòFö¶VâÖ6†V6¶VB&VÆV6S¢âöÆB6Æ÷r6ÆÂ×W7BæWfW"FVÆWFRæWvW ¢òò&V6öæ6–ÆR÷væW"w2Æö6²gFW"—G2÷vâÆV6R6†ævVB†æG2à¢–b†Æö6´7V—&VB’°¢v—BWfÄÆö6´ÇV†6Æ–VçBÂ$TÄT4UôÄô4µôÅTÂÄô4µô´U’Â¶Æö6µFö¶VåÒ’æ6F6‚‚‚’Óâ¢Ð¢Ð§Ð ¢ò¢ ¢¢FV6öFR6WVFò×÷6—F–öâ&÷FV7F–öâ6öçG&7B–çFòÖ&¶WB×&–6RW&6VçG2à¢ ¢¢7W'&VçB6WVFò÷6—F–öç2W'6—7BW‡Æ–6—B¥÷7Ff–VÆG2Æöæw6–FRF†P¢¢ÆVv7’f7F÷"÷&F–òf–VÆG2âF†÷6RW‡Æ–6—BfÇVW2&RWF†÷&—FF—fRWfVà¢¢&VÆ÷röæRW&6VçC¢ã‚R6–væÂ7F÷×W7BæWfW"&RÖ—7&VB2F†RFV6–ÖÀ¢¢&F–òã‚ƒÒƒR’âöÆFW"&÷w2v—F†÷WBW‡Æ–6—Bf–VÆG2&WF–âF†RFö7VÖVçFV@¢¢&F–òÖ÷"×W&6VçB6ö×F–&–Æ—G’fÆÆ&6²à¢¢ð¦gVæ7F–öâ&W6öÇfU6WVFõ&÷FV7F–öåW&6VçG2‡6WVFõ÷3¢ç’“¢°¢6Å7C¢çVÖ&W"ÂVæFVf–æV@¢G7C¢çVÖ&W"ÂVæFVf–æV@§Ò°¢6öç7BW‡Æ–6—E6Å7BÒçVÖ&W"‡6WVFõ÷3òç7F÷Æ÷75÷7Bóò6WVFõ÷3òç7F÷Æ÷757B¢6öç7BW‡Æ–6—EG7BÒçVÖ&W"‡6WVFõ÷3òçF¶W&öf—E÷7Bóò6WVFõ÷3òçF¶U&öf—E7B¢6öç7B&u4ÂÒçVÖ&W"‡6WVFõ÷3òç7F÷Æ÷75÷&F–òóò6WVFõ÷3òç7F÷Æ÷72óòæâ¢6öç7B&uEÒçVÖ&W"‡6WVFõ÷3òçF¶W&öf—Eöf7F÷"óò6WVFõ÷3òçF¶U&öf—Bóòæâ¢6öç7B6ö÷&F–æFRÒ7G&–ær€¢6WVFõ÷3òç&÷FV7F–öåö6ö÷&F–æFRóò6WVFõ÷3òçF¶W&öf—Eö6ö÷&F–æFRóò""À¢’çG&–Ò‚’çFôÆ÷vW$66R‚¢6öç7B4æöäæVvF—fU7BÒ‡fÇVS¢çVÖ&W"“¢çVÖ&W"ÂVæFVf–æVBÓà¢çVÖ&W"æ—4f–æ—FR‡fÇVR’òÖF‚æÖ‚ƒÂfÇVR’¢VæFVf–æV@ ¢–b„çVÖ&W"æ—4f–æ—FR†W‡Æ–6—E6Å7B’ÇÂçVÖ&W"æ—4f–æ—FR†W‡Æ–6—EG7B’’°¢&WGW&â°¢6Å7C¢4æöäæVvF—fU7B†W‡Æ–6—E6Å7B’À¢G7C¢4æöäæVvF—fU7B†W‡Æ–6—EG7B’À¢Ð¢Ð ¢–b†6ö÷&F–æFRÓÓÒ'÷6—F–öåö6÷7E÷&F–ò"’°¢6öç7B÷6—F–öä6÷7E7BÒæ÷&ÖÆ—¦U÷6—F–öä6÷7EW&6VçB€¢6WVFõ÷3òç÷6—F–öåö6÷7E÷7Bóò6WVFõ÷3òç÷6—F–öä6÷7E7BÀ¢¢&WGW&â°¢6Å7C¢4æöäæVvF—fU7B€¢7F÷Æ÷75÷6—F–öä6÷7E&F–õFõW&6VçB‡÷6—F–öä6÷7E7BÂ&uEÂ&u4Â’À¢’À¢G7C¢4æöäæVvF—fU7B€¢F¶U&öf—E÷6—F–öä6÷7E&F–õFõW&6VçB‡÷6—F–öä6÷7E7BÂ&uE’À¢’À¢Ð¢Ð ¢6öç7BÆVv7•W&6VçBÒ‡fÇVS¢çVÖ&W"“¢çVÖ&W"ÂVæFVf–æVBÓâ°¢–b‚çVÖ&W"æ—4f–æ—FR‡fÇVR’’&WGW&âVæFVf–æV@¢òòÆVv7’&F–òf÷&ÒW6VBã&f÷""S²Æ—FW&ÂW&6VçBfÇVW2vW&P¢òò7F÷&VB2Â"Â(
bâ&VfW"F†RW‡Æ–6—Bf–VÆG2&÷fRv†VæWfW"&W6VçBà¢&WGW&âÖF‚æÖ‚ƒÂÖF‚æ'2‡fÇVR’ÂòfÇVR¢¢fÇVR¢Ð¢&WGW&â°¢6Å7C¢ÆVv7•W&6VçB‡&u4Â’À¢G7C¢ÆVv7•W&6VçB‡&uE’À¢Ð§Ð ¢ò¢ ¢¢)H)H7–æ4Æ—fTg&öÕ6WVFò‡7V2*sb’)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞûûÞ)H)H)H)H)H ¢ ¢¢6÷’4ÂõEW&6VçFvW2g&öÒ6WVFò‡7G&FVw’×6–FRf—'GVÂ’÷6—F–öà¢¢öçFòÖF6†–ærÆ—fR†W†6†ævR×6–FR&VÂ’÷6—F–öç2öâF†R6ÖP¢¢7–Ö&öÂ²F—&V7F–öâÂF†Vâ&RÖ&ÒF†RW†6†ævR&÷FV7F–öâ÷&FW'26ð¢¢F†RæWrÆWfVÇ2&R7GVÆÇ’Væf÷&6VBà¢ ¢¢÷W&F÷#¢'6WVFò÷2WFFW2v—F‚G&–Æ–ærÂ7FW2WF2—2v÷&¶–æp¢¢6ö×ÆWFVÇ’6÷'&V7BæBÆ—fR÷2&R6÷'&V7FÇ’7–æ6‡&öâ"âF†Bw2F†P¢¢F&vWB(	BF†—2†VÇW"6Æ÷6W2F†Rv&WGvVVâ7G&FVw’×6–FRG&–Æ–æp¢¢æBW†6†ævR×6–FR4ÂõE'’—–ærW&6VçBWFFW2F‡&÷Vv‚Fð¢¢&V6Æ7VÆFTæDÇ•4ÅEÂv†–6‚Ç&VG’FöW0¢¢6æ6VÂÖöÆB(i"Æ6RÖæWr(i"W'6—7B²VF—Bà¢ ¢¢–çWG3 ¢¢Ò6WVFõ÷2ç7–Ö&öÆ‡7G&–ærÂ&WV—&VB’æB6WVFõ÷2ç6–FV ¢¢‚&Æöær"Â'6†÷'B"’(	BÖF6‚¶W’v–ç7BÆ—fR÷6—F–öç2à¢¢Ò7W'&VçB6WVFò&÷w2W6R7F÷Æ÷75÷7FòF¶W&öf—E÷7F2F†P¢¢VæÖ&–wV÷W2Ö&¶WB×&–6RW&6VçFvR6öçG&7B†–æ6ÇVF–ærfÇVW2&VÆ÷p¢¢öæRW&6VçB’âÆVv7’f7F÷"÷&F–ò&÷w2&RFV6öFVBöæÇ’v†VâF†÷6P¢¢W‡Æ–6—Bf–VÆG2&R'6VçBà¢ ¢¢–FV×÷FVçC¢–bW&6VçFvW2Væ6†ævVB&V6Æ7VÆFTæDÇ•4ÅE ¢¢æòÖ÷2öâF†RF–fbâW"×÷6—F–öâW'&÷'2&R7vÆÆ÷vVBà¢ ¢¢6ÆÆW"6öçG&7C¢f—&RÖæBÖf÷&vWBâ&WGW&ç2&öÖ—6SÇfö–CææBæWfW ¢¢F‡&÷w27BF†—2&÷VæF'’(	BF†R&VÇF–ÖR†÷BF‚×W7BäUdU"v—@¢¢öâW†6†ævR&÷VæB×G&—2à¢¢ð¦W‡÷'B7–æ2gVæ7F–öâ7–æ4Æ—fTg&öÕ6WVFò€¢6öææV7F–öä–C¢7G&–ærÀ¢6WVFõ÷3¢ç’À¢W†6†ævT6öææV7F÷#¢ç’À¢“¢&öÖ—6SÇfö–Câ°¢G'’°¢òò)HûûÞûûÞûûÒ7—7FVÒG&6¶–ærfÆ–FF–öâ)H)H ¢òòöæÇ’7–æ2÷6—F–öç27&VFVB'’F†—27—7FVÒâ6¶—f÷&V–vâöÖçVÂ÷&FW'2à¢6öç7BG&6¶–æt–BÒ7G&–ær‡6WVFõ÷3òç7—7FVÕ÷G&6¶–æuö–BÇÂ""’çG&–Ò‚¢–b‚G&6¶–æt–Bç7F'G5v—F‚‚'7—2Ò"’ÇÂG&6¶–æt–BæÆVæwF‚ÃÒ’°¢òò6–ÆVçB6¶—ÒFöâwBÆörWfW'’f÷&V–vâ÷6—F–öâöâWfW'’F–6°¢&WGW&à¢Ð ¢6öç7B7–Ö&öÂÒ7G&–ær‡6WVFõ÷3òç7–Ö&öÂÇÂ""’çFõWW$66R‚¢6öç7B6–FRÒæ÷&ÖÆ—¦TÆ—fUG&FTF—&V7F–öâ‡6WVFõ÷3òæF—&V7F–öâÂ6WVFõ÷3òç6–FR¢–b‚7–Ö&öÂÇÂ6–FR’&WGW&à ¢6öç7B²6Å7BÂG7BÒÒ&W6öÇfU6WVFõ&÷FV7F–öåW&6VçG2‡6WVFõ÷2¢–b‡6Å7BÓÓÒVæFVf–æVBbbG7BÓÓÒVæFVf–æVB’&WGW&à ¢òò)H)HG&–Æ–ærÖv&R4ÂVÆÂ×F‡&÷Vv‚ûûÞûûÞûûÞ)H)H)H)H)H)H)HûûÞûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òòv†VâF†R6WVFòw2G&–Æ–ær×7F÷Ö6†–æR—2$ÔTB†×VÇF’×7FW ¢òòG&–Æ–æuö7F—fSÓ÷"ÆVv7’G&–Æ–æu÷7F÷÷&–6Sã’ÂF†P¢òòVffV7F—fR7F÷ÆWfVÂ—2æòÆöævW"7F÷Æ÷75÷&F–ò9rf–ÆÅ&–6V ¢òò(	B—Bw2F†R&F6†WFVBG&–Æ–æu÷7F÷÷&–6VâVÆÆ–ærF†R7FF–0¢òò&F–òF‡&÷Vv‚†W&Rv÷VÆB6W6RWfW'’G&–Æ–ærF–6²Fòf–v‡@¢òòv–ç7B—G6VÆbÂ&WVFVFÇ’&W6WGF–ærF†RÆ—fR4Â&6²FòF†P¢òò÷&–v–âÆWfVÂâ6öçfW'BF†R7F—fRG&–Æ–ær7F÷&–6R–çFò¢òòÆ—fR×÷6—F–öâ×&VÆF—fRW&6VçFvR'’æ6†÷&–ær—BFòF†RÄ•dP¢òò÷6—F–öâw27GVÂf–ÆÂ&–6R†VçG'’×6–FR’âF†RW&6VçB76P¢òò—2v†B&V6Æ7VÆFTæDÇ•4ÅE6öç7VÖW2à¢6öç7BG&–Æ–æt7F—fRÐ¢6WVFõ÷3òçG&–Æ–æuö7F—fRÓÓÒ#"ÇÀ¢6WVFõ÷3òçG&–Æ–æuö7F—fRÓÓÒG'VRÇÀ¢‚‚’Óâ°¢6öç7BG2Ò'6TfÆöB…7G&–ær‡6WVFõ÷3òçG&–Æ–æu÷7F÷÷&–6RÇÂ#"’¢&WGW&âçVÖ&W"æ—4f–æ—FR‡G2’bbG2â ¢Ò’‚¢6öç7BG&–Æ–æu7F÷&–6RÒ'6TfÆöB…7G&–ær‡6WVFõ÷3òçG&–Æ–æu÷7F÷÷&–6RÇÂ#"’¢6öç7B6WVFôVçG'•&–6RÒf–æ—FU÷6—F—fR€¢6WVFõ÷3òæVçG'•÷&–6Róð¢6WVFõ÷3òæVçG'•&–6Róð¢6WVFõ÷3òæfW&vUöVçG'•÷&–6Róð¢6WVFõ÷3òæfW&vTVçG'•&–6RÀ¢ ¢òò)H)H6WB×66÷VBÖF6‚„%Trb’)H)H)H)H)H)H)H)H)H)H)HûûÞûûÞûûÞ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òò–FVçF–g’F†R&VÂ6WBF†B÷vç2D„•26WVFò÷6—F–öââ6WfW&Â6WVFð¢òò÷6—F–öç2†F—7F–æ7B6WG2’6âF&vWBF†R6ÖR7–Ö&öÂ·6–FR6Æ÷C²F†P¢òòFVGWÆö6²6öÆÆ6W2F†VÒöçFòôäRÆ—fR÷6—F–öââÖF6†–ær'¢òò7–Ö&öÂ·6–FRÆöæRv÷VÆBÆWBWfW'’6WBw2G&–Æ–ærF–6²&Ww&—FRF†@¢òò6–ævÆRÆ—fR÷6—F–öâw24ÂõEv—F‚—G2÷vâÆWfVÂÂÖ¶–ærF†R7F÷ ¢òòfÆ&WGvVVâVç&VÆFVB6WG2â66÷RF†RÖF6‚FòF†R÷væ–ær6WBw2¶W¢òò6òV6‚6WVFòöæÇ’7FVW'2F†RÆ—fR÷6—F–öâ—B7GVÆÇ’&6·2à¢6öç7B6WVFõ6WD¶W’Ò7G&–ær€¢6WVFõ÷3òç7G&FVw•÷6WEö¶W’ÇÀ¢6WVFõ÷3òç7G&FVw•6WD¶W’ÇÀ¢6WVFõ÷3òç6WEö–BÇÀ¢6WVFõ÷3òæ6öæf–u÷6WEö¶W’ÇÀ¢6WVFõ÷3òç6÷W&6U÷6WEö¶W’ÇÀ¢""À¢’çG&–Ò‚¢6öç7B6WVFôW†V7WF–öäÆæRÒ&W6öÇfU6–væÄW†V7WF–öäÆæR‡°¢W†V7WF–öäÆæS¢6WVFõ÷3òæW†V7WF–öåöÆæRóò6WVFõ÷3òæW†V7WF–öäÆæRÀ¢–æF–6F–öåG—S¢6WVFõ÷3òæ–æF–6F–öå÷G—Róò6WVFõ÷3òæ–æF–6F–öåG—RÀ¢G&–Æ–æu&öf–ÆS¢6WVFõ÷3òçG&–Æ–æuöÖöFRÓÓÒ'6–væÅöG–æÖ–2 ¢ò°¢ÖöFS¢'6–væÅöG–æÖ–2"À¢7F'E&F–ó¢çVÖ&W"‡6WVFõ÷3òçG&–Æ–æu÷7F'E÷&F–òÇÂ’À¢7F÷&F–ó¢çVÖ&W"‡6WVFõ÷3òçG&–Æ–æu÷7F÷÷&F–òÇÂ’À¢7FW&F–ó¢çVÖ&W"‡6WVFõ÷3òçG&–Æ–æu÷7FW÷&F–òÇÂ’À¢Ð¢¢VæFVf–æVBÀ¢Ò ¢6öç7BÆ—fU÷6—F–öç2Òv—BvWDÆ—fU÷6—F–öç2†6öææV7F–öä–B¢6öç7B6Æ÷DÖF6†W2ÒÆ—fU÷6—F–öç2æf–ÇFW"‚‡¢ç’’Óâ°¢6öç7BÆ—fU6–FRÒ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ‡¢&WGW&â7G&–ær‡ç7–Ö&öÂÇÂ""’çFõWW$66R‚’ÓÓÒ7–Ö&öÂb`¢Æ—fU6–FRÓÓÒ6–FRb`¢Æ—fTW†V7WF–öäÆæR‡’ÓÓÒ6WVFôW†V7WF–öäÆæRb`¢ç7FGW2ÓÒ&6Æ÷6VB ¢Ò¢–b‡6Æ÷DÖF6†W2æÆVæwF‚ÓÓÒ’&WGW&à ¢òò&VfW"Æ—fR÷6—F–öç2v†÷6R6WD¶W’÷&VçE6WD¶W’ö67V×VÆFVE6WD¶W—0¢òòÖF6‚F†—26WVFòw2÷væ–ær6WBâ67V×VÆFVBÆ—fR÷6—F–öç26â6''¢òò×VÇF—ÆR&6R÷G&–Æ–ærö†—26WG3²WfW'’÷væ–ær6WB×W7B&RÆÆ÷vVBFð¢òòGfæ6R—G2G&–Æ–ær&F6†WBæB&V'V–ÆBF†R6÷'&V7B6öçG&öÂ÷&FW'2à¢òòöæÇ’fÆÂ&6²FòF†RVç66÷VB6Æ÷BÖF6†W2v†VâäôäRöbF†VÒ6''’¢òò6WB¶W’vR6â6ö×&Rv–ç7B†ÆVv7’÷6—F–öç2w&—GFVà¢òò&Vf÷&R6WD¶W’&÷vF–öâ’÷"v†VâF†R6WVFò—G6VÆb†2æò6WB–B(	@¢òò–âF†÷6R66W27–Ö&öÂ·6–FR—2F†R&W7B6–væÂf–Æ&ÆRÂ&W6W'f–æp¢òò&6·v&BÖ6ö×F–&ÆR&V†f–÷W"v—F†÷WB6–ÆVçFÇ’G&÷–ærF†R7–æ2à¢ÆWBÖF6†W2Ò6Æ÷DÖF6†W0¢–b‡6WVFõ6WD¶W’’°¢6öç7B66÷VBÒ6Æ÷DÖF6†W2æf–ÇFW"‚‡¢ç’’Óâ°¢6öç7BÆ—fT¶W—2ÒæWr6WCÇ7G&–æsâ‚¢f÷"†6öç7B¶W’öb·ç6WD¶W’Âç&VçE6WD¶W•Ò’°¢6öç7Bæ÷&ÖÆ—¦VBÒ7G&–ær†¶W’ÇÂ""’çG&–Ò‚¢–b†æ÷&ÖÆ—¦VB’Æ—fT¶W—2æFB†æ÷&ÖÆ—¦VB¢Ð¢6öç7B67V×VÆFVBÒ'&’æ—4'&’‡æ67V×VÆFVE6WD¶W—2’òæ67V×VÆFVE6WD¶W—2¢µÐ¢f÷"†6öç7B¶W’öb67V×VÆFVB’°¢6öç7Bæ÷&ÖÆ—¦VBÒ7G&–ær†¶W’ÇÂ""’çG&–Ò‚¢–b†æ÷&ÖÆ—¦VB’Æ—fT¶W—2æFB†æ÷&ÖÆ—¦VB¢Ð¢&WGW&âÆ—fT¶W—2æ†2‡6WVFõ6WD¶W’¢Ò¢6öç7Bç”Æ—fT¶W–VBÒ6Æ÷DÖF6†W2ç6öÖR‚‡¢ç’’Óâ°¢–b…7G&–ær‡ç6WD¶W’ÇÂç&VçE6WD¶W’ÇÂ""’çG&–Ò‚’æÆVæwF‚â’&WGW&âG'VP¢&WGW&â'&’æ—4'&’‡æ67V×VÆFVE6WD¶W—2’bbæ67V×VÆFVE6WD¶W—2ç6öÖR‚†¶W“¢ç’’Óâ7G&–ær†¶W’ÇÂ""’çG&–Ò‚’æÆVæwF‚â¢Ò¢–b‡66÷VBæÆVæwF‚â’°¢ÖF6†W2Ò66÷V@¢ÒVÇ6R–b†ç”Æ—fT¶W–VB’°¢òòÆ—fR÷6—F–öç2$R¶W–VBÂ'WBæöæR&VÆöærFòF†—26WB(i"F†—0¢òò6WVFòFöW2æ÷B÷vâF†R6Æ÷Bw2Æ—fRW‡÷7W&RâFòæ÷BF÷V6‚—Bà¢&WGW&à¢Ð¢òòVÇ6S¢æòÆ—fR÷6—F–öâ—2¶W–VB(i"fÆÂ&6²Fò6Æ÷BÖF6†W2à¢Ð¢–b†ÖF6†W2æÆVæwF‚ÓÓÒ’&WGW&à ¢òò&ÆÆVÆ—¦R7&÷72ÖF6†–ærÆ—fR÷6—F–öç2(	BV6‚÷6—F–öâw0¢òò4ÂõE&V6Æ7VÆF–öâ—2–æFWVæFVçBâF†R&Wf–÷W26W&–Âf÷"ÖÆö÷ ¢òò6W6VB#(	3#×2&Æö6¶–ærW"G&–Æ–ær7F÷WFFRƒ#×2°¢òòW†6†ævR%EG2W"÷6—F–öâ’â6BB6öæ7W'&VçB6òvRFöâw@¢òò†ÖÖW"F†RW†6†ævR’–â6–ævÆRF–6²à¢6öç7BÔ…ô4ôä5U%$TåEõ4ÅEÒ@¢ÆWBæW‡D–G‚Ò ¢6öç7Bv÷&¶W"Ò7–æ2‚“¢&öÖ—6SÇfö–CâÓâ°¢v†–ÆR‡G'VR’°¢6öç7B’ÒæW‡D–G‚²°¢–b†’ãÒÖF6†W2æÆVæwF‚’&WGW&à¢6öç7BÆ—fU÷2ÒÖF6†W5¶•Ð¢G'’°¢òòâ÷W&F÷"÷fW'&–FR—2GW&&ÆR6öçG&öÂ6öçG&7BâF†Ræ÷&ÖÀ¢òò6WVFò×÷6—F–öâ7–æ2×W7Bæ÷B÷fW'w&—FR—BöâF†RæW‡B#×2F–6³°¢òòWFFU&÷FV7F–öä÷&FW'2÷vç2—G2'6öÇWFR4ÂõEæBG&–Æ–ær&F6†W@¢òòVçF–ÂF†R÷W&F÷"W‡Æ–6—FÇ’&W7F÷&W27G&FVw’FVfVÇG2à¢–b†Æ—fU÷2æÖçVÅ&÷FV7F–öä÷fW'&–FR’6öçF–çVP¢6öç7BÆö6ÄWF†÷&—FF—fTVçG'’Ð¢f–æ—FU÷6—F—fR†Æ—fU÷2æ–æ—F–ÄVçG'•&–6R’ÇÀ¢f–æ—FU÷6—F—fR†Æ—fU÷2æfW&vTW†V7WF–öå&–6R’ÇÀ¢f–æ—FU÷6—F—fR†Æ—fU÷2æVçG'•&–6R¢&W—$Æ—fTVçG'•&–6TFöÖ–â†Æ—fU÷2ÂÆö6ÄWF†÷&—FF—fTVçG'’¢6öç7Bf–ÆÂÐ¢f–æ—FU÷6—F—fR†Æ—fU÷2æfW&vTW†V7WF–öå&–6R’ÇÀ¢f–æ—FU÷6—F—fR†Æ—fU÷2æ–æ—F–ÄVçG'•&–6R’ÇÀ¢f–æ—FU÷6—F—fR†Æ—fU÷2æVçG'•&–6R¢6öç7BG&ç6ÆFVEG&–Æ–æu7F÷&–6RÒG&–Æ–æt7F—fP¢òG&ç6ÆFU6WVFõG&–Æ–æu7F÷&–6R‡G&–Æ–æu7F÷&–6RÂ6WVFôVçG'•&–6RÂf–ÆÂ¢¢VæFVf–æV@¢òòæWfW"6÷’â'6öÇWFR6WVFòö†—7F÷&–2&–6RF—&V7FÇ’–çFòÆ—fP¢òòfVçVR÷6—F–öââ–b—B6ææ÷B&R&ö¦V7FVBF‡&÷Vv‚F†R6WVFòVçG'¢òò&F–òÂÆVfRF†R7W'&VçFÇ’&ÖVBÆ—fR&÷FV7F–öâVçF÷V6†VBà¢–b‡G&–Æ–æt7F—fRbbG&–Æ–æu7F÷&–6Râbb‡G&ç6ÆFVEG&–Æ–æu7F÷&–6RbbG&ç6ÆFVEG&–Æ–æu7F÷&–6Râ’’°¢6öçF–çVP¢Ð¢òòf7B×F‚7FÆRwV&BâF†RÆö6¶VB&V6Æ7VÆF–öâF‚W&f÷&×2F†P¢òò6ÖR6†V6²v–âv–ç7Bg&W6‚&VF—2&VC²F†—2V&Ç’6¶—fö–G0¢òòVææV6W76'’fVçVRv÷&²v†VââöÆFW"f—&RÖæBÖf÷&vWB&F6†W@¢òò'&—fW2gFW"F–v‡FW"öæR†2Ç&VG’&VVâW'6—7FVBà¢–b€¢G&–Æ–æt7F—fRb`¢G&ç6ÆFVEG&–Æ–æu7F÷&–6Rb`¢—5G&–Æ–æu7F÷F–v‡FVæ–ær†Æ—fU÷2ÂG&ç6ÆFVEG&–Æ–æu7F÷&–6R¢’6öçF–çVP¢ÆWBVffV7F—fU6Å7BÒ6Å7@¢òò5$•D”4Ã¢wV&BG&–Æ–ær7F÷6Æ7VÆF–öâv–ç7BæâæBF—f—6–öâW'&÷'0¢–b‡G&–Æ–æt7F—fRbbçVÖ&W"æ—4f–æ—FR„çVÖ&W"‡G&ç6ÆFVEG&–Æ–æu7F÷&–6R’’bbçVÖ&W"‡G&ç6ÆFVEG&–Æ–æu7F÷&–6R’â’°¢òòVç7W&Rf–ÆÂ&–6R—2fÆ–BæB÷6—F—fR&Vf÷&RW6–ær–âF—f—6–öà¢–b„çVÖ&W"æ—4f–æ—FR†f–ÆÂ’bbf–ÆÂâ’°¢6öç7BÆ—fU6–FRÒ&W6öÇfTÆ—fU÷6—F–öäF—&V7F–öâ†Æ—fU÷2¢–b‚Æ—fU6–FR’6öçF–çVP¢òòF—7Fæ6Rg&öÒf–ÆÂFòF†RG&–Æ–ær7F÷W‡&W76VB2¢òòW&6VçFvRöbF†Rf–ÆÂ&–6R†Çv—2÷6—F—fR&Vv&FÆW72ö`¢òòF—&V7F–öâ(	BF†RG&–Æ–ærÖ6†–æRVç7W&W2G&–Æ–æu7F÷&–6P¢òò—2&VÆ÷rf–ÆÂf÷"Æöæw2æB&÷fRf–ÆÂf÷"6†÷'G2’à¢ÆWBF—7E7C¢çVÖ&W ¢–b†Æ—fU6–FRÓÓÒ&Æöær"’°¢F—7E7BÒ‚†f–ÆÂÒçVÖ&W"‡G&ç6ÆFVEG&–Æ–æu7F÷&–6R’’òf–ÆÂ’¢ ¢ÒVÇ6R°¢F—7E7BÒ‚„çVÖ&W"‡G&ç6ÆFVEG&–Æ–æu7F÷&–6R’Òf–ÆÂ’òf–ÆÂ’¢ ¢Ð¢òòwV&Bv–ç7Bæâg&öÒF—f—6–öâ÷"6Æ7VÆF–öâW'&÷'2Âæ@¢òòVç7W&RF—7E7B—2÷6—F—fR‡6†÷VÆBÇv—2&Rf÷"fÆ–BG&–Æ–ærÆWfVÇ2¢–b„çVÖ&W"æ—4f–æ—FR†F—7E7B’bbF—7E7Bâ’°¢VffV7F—fU6Å7BÒF—7E7@¢ÒVÇ6R–b‚çVÖ&W"æ—4f–æ—FR†F—7E7B’’°¢òò–bF—7E7B—2æâ÷"–æf–æ—G’ÂÆör—B'WB¶VW7W'&VçB4ÂW&6VçFvP¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡ÒF—7E7B—2G¶F—7E7GÒf÷"G¶Æ—fU÷2ç7–Ö&öÇÒ†f–ÆÃÒG¶f–ÆÇÒÂG&–Æ–æsÒG·G&ç6ÆFVEG&–Æ–æu7F÷&–6WÒÂ6–FSÒG¶Æ—fU6–FWÒ– ¢¢Ð¢Ð¢Ð ¢òò)H)H7F×G&–Æ–ær7FFRöçFòF†RÆ—fR÷6—F–öâ)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òòw&—FRG&–Æ–æt7F—fR²G&–Æ–æu7F÷&–6Rg&öÒF†R6WVFò÷6—F–öà¢òò6òF†B6ö×WFTFW6—&VE&÷FV7F–öå&–6W2æB6†V6´æDf÷&6T6Æ÷6Töå6ÇG7&÷70¢òò6âW6RF†R&F6†WFVB'6öÇWFR&–6R–ç7FVBöb&RÖ6ö×WF–ærg&öÐ¢òòF†R7FÆR7FF–2W&6VçFvRâF†—2Vç7W&W2&÷F‚F†RW†6†ævR÷&FW ¢òòÆ6VÖVçBF‚æBF†R&ö7F—fRf÷&6RÖ6Æ÷6RF‚&VfÆV7BF†RÆFW7@¢òòG&–Æ–ær&F6†WBöâWfW'’F–6²Âæ÷BöæÇ’öâ&V6Æ2F–6·2à¢6öç7B&WeG&–Æ–æt7F—fRÒÆ—fU÷2çG&–Æ–æt7F—fP¢6öç7B&WeG&–Æ–æu7F÷&–6RÒÆ—fU÷2çG&–Æ–æu7F÷&–6P¢6öç7BæW‡EG&–Æ–æu7F÷&–6RÐ¢G&–Æ–æt7F—fRbbçVÖ&W"‡G&ç6ÆFVEG&–Æ–æu7F÷&–6R’â ¢òçVÖ&W"‡G&ç6ÆFVEG&–Æ–æu7F÷&–6R¢¢VæFVf–æV@¢6öç7BG&–Æ–æu7FFT6†ævVBÐ¢&WeG&–Æ–æt7F—fRÓÒG&–Æ–æt7F—fRÇÀ¢&WeG&–Æ–æu7F÷&–6RÓÒæW‡EG&–Æ–æu7F÷&–6P ¢òò)H)HW"×F–6²æòÖ÷wV&B)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H)H ¢òò7–æ4Æ—fTg&öÕ6WVFòf—&W2öâUdU%’&VÇF–ÖR7–6ÆRƒ#(	33×2’'W@¢òòF†RG&–Æ–ær7F÷&–6RöæÇ’&F6†WG2öæ6RW"7G&FVw’7–6ÆP¢òò‡ãR2’â6ÆÆ–ær&V6Æ7VÆFTæDÇ•4ÅEöâæòÖ6†ævRF–6·0¢òò7V—&W2F†RÆ—fU÷7–æ5öÆö6²ÂfWF6†W2÷Vâ÷&FW'2ÂæB6ÆÇ0¢òòWFFU&÷FV7F–öä÷&FW'2(	BÆÂæòÖ÷2BF†RW†6†ævRÆ–W"Â'W@¢òò7F–ÆÂãS(	3S×2öbÆö6²6öçFVçF–öâW"÷6—F–öâW"F–6²à¢òð¢òò6¶—F†R6ÆÂv†Vâ$õDƒ ¢òò(
"F†R6ö×WFVB6Å7B—2v—F†–â+ã#RRöbF†R7W'&VçFÇ’7F÷&V@¢òò7F÷Æ÷727B‡6ÖRã#RRFöÆW&æ6R2&–6TG&–gFVBûûÞûûÒ¢òò6†ævR6ÖÆÆW"F†âF†—26ææ÷BffV7BF†RW†6†ævR÷&FW"¢òò(
"F†RG7B—2v—F†–â+ã#RRöbF†R7W'&VçFÇ’7F÷&VBF¶U&öf—@¢òò7B†÷"&÷F‚&RVæFVf–æVBôæâ¢òòÇv—26ÆÂv†VâF†RÆ—fR÷6—F–öâ†2Ö—76–ær÷&FW"†–BÒVæFVf–æVB¢òòWfVâ–bW&6VçFvW2&RVæ6†ævVB(	BF†R÷&FW"Ö’†fR&VVâ6–ÆVçFÇ¢òòf–ÆÆVB÷"6æ6VÆÆVBöâF†RfVçVRæBæVVG2&RÖ&Ö–ærà¢6öç7B7W'&VçE6Å7BÒG—VöbÆ—fU÷2ç7F÷Æ÷72ÓÓÒ&çVÖ&W""òÆ—fU÷2ç7F÷Æ÷72¢VæFVf–æV@¢6öç7B7W'&VçEG7BÒG—VöbÆ—fU÷2çF¶U&öf—BÓÓÒ&çVÖ&W""òÆ—fU÷2çF¶U&öf—B¢VæFVf–æV@¢6öç7Bvw&VvFTÖVÖ&W"Ð¢Æ—fU÷2æ6öçG&öÄ÷&FW%66÷RÓÓÒ'7–Ö&öÅöF—&V7F–öâ"bbÆ—fU÷2ævw&VvFU&÷FV7F–öä÷væW"ÓÓÒfÇ6Rbb&ööÆVâ†Æ—fU÷2ævw&VvFU&÷FV7F–öä¶W’¢òòvw&VvFRÖVÖ&W'2–çFVçF–öæÆÇ’Fòæ÷B÷vâF÷ÖÆWfVÂfVçVR”G2à¢òòF†V—"6WB6÷fW&vRö–çG2BF†RÆVFW"—"æBF†V—"W†7@¢òòG&–vvW'2&VÖ–â7—7FVÒ×6–FRÂ6òÖ—76–ærÆö6Â”G2&Ræ÷B†VÀ¢òò6–væÂâG&VF–ærF†VÒ2öæR6W6VBW"×F–6²&RÖ&ÒöFVÖ÷FR6‡W&âà¢6öç7B÷&FW'4Ö—76–ærÒvw&VvFTÖVÖ&W"bb‚Æ—fU÷2ç7F÷Æ÷74÷&FW$–BÇÂÆ—fU÷2çF¶U&öf—D÷&FW$–B¢òò5$•D”4Ã¢wV&Bv–ç7BF—f—6–öâ'’¦W&òæBæâ&÷vF–öâà¢òò7W'&VçE6Å7B÷G7B6÷VÆB&RÂæVvF—fRÂ÷"æââW6R6fRF—f—6–öâv—F€¢òòW‡Æ–6—B—4f–æ—FR6†V6·2Fò&WfVçB7&6†W2öâG&–Æ–ær7F÷WFFW2à¢6öç7B6ÄFVÇF7BÒ‚‚’Óâ°¢–b†7W'&VçE6Å7BÓÓÒVæFVf–æVBÇÂVffV7F—fU6Å7BÓÓÒVæFVf–æVB’&WGW&âòòG&VB26†ævV@¢–b‚çVÖ&W"æ—4f–æ—FR†7W'&VçE6Å7B’ÇÂçVÖ&W"æ—4f–æ—FR†VffV7F—fU6Å7B’’&WGW&â¢–b†7W'&VçE6Å7BÃÒ’&WGW&âòòVæFVf–æVB4Â(i"G&VB26†ævV@¢6öç7BFVÇFÒÖF‚æ'2†VffV7F—fU6Å7BÒ7W'&VçE6Å7B’òÖF‚æ'2†7W'&VçE6Å7B¢&WGW&âçVÖ&W"æ—4f–æ—FR†FVÇF’òFVÇF¢¢Ò’‚¢ ¢6öç7BGFVÇF7BÒ‚‚’Óâ°¢–b†7W'&VçEG7BÓÓÒVæFVf–æVBbbG7BÓÓÒVæFVf–æVB’&WGW&âòò&÷F‚VæFVf–æVB(i"æò6†ævP¢–b†7W'&VçEG7BÓÓÒVæFVf–æVBÇÂG7BÓÓÒVæFVf–æVB’&WGW&âòòöæRæWvÇ’FVf–æVB(i"6†ævV@¢–b‚çVÖ&W"æ—4f–æ—FR†7W'&VçEG7B’ÇÂçVÖ&W"æ—4f–æ—FR‡G7B’’&WGW&â¢–b†7W'&VçEG7BÃÒ’&WGW&âòòVæFVf–æVBE(i"G&VB26†ævV@¢6öç7BFVÇFÒÖF‚æ'2‡G7BÒ7W'&VçEG7B’òÖF‚æ'2†7W'&VçEG7B¢&WGW&âçVÖ&W"æ—4f–æ—FR†FVÇF’òFVÇF¢¢Ò’‚¢òòv†VâG&–Æ–ær—27F—fRF†R&F6†WB6âGfæ6RWfVâv†VâF†P¢òòFW&—fVB6Å7B†g&öÒF—7E7B6Æ7VÆF–öâ&÷fR’Æöö·27F&ÆRv—F†–à¢òòã#RRâF†R'6öÇWFR7F÷&–6RGfæ6–ær—2Çv—26–væ–f–6çB(	@¢òò6¶—F†RæòÖ÷wV&B–bF†RG&–Æ–ær7F÷&–6R—G6VÆb6†ævVBà¢6öç7BG&–Æ–æu&–6TGfæ6VBÐ¢G&–Æ–æu7FFT6†ævVBÇÀ¢‡G&–Æ–æt7F—fRbbçVÖ&W"‡G&ç6ÆFVEG&–Æ–æu7F÷&–6R’âbb&WeG&–Æ–æu7F÷&–6RÓÒG&ç6ÆFVEG&–Æ–æu7F÷&–6R¢6öç7Bæ÷F†–æt6†ævVBÐ¢÷&FW'4Ö—76–ærbb6ÄFVÇF7BÂã#RbbGFVÇF7BÂã#RbbG&–Æ–æu&–6TGfæ6V@¢–b†æ÷F†–æt6†ævVB’6öçF–çVP ¢v—B&V6Æ7VÆFTæDÇ•4ÅE†6öææV7F–öä–BÂÆ—fU÷2æ–BÂW†6†ævT6öææV7F÷"Â°¢7F÷Æ÷757C¢VffV7F—fU6Å7BÀ¢F¶U&öf—E7C¢G7BÀ¢G&–Æ–æt7F—fRÀ¢G&–Æ–æu7F÷&–6S¢æW‡EG&–Æ–æu7F÷&–6RÀ¢Ò¢Ò6F6‚†W'"’°¢6öç6öÆRçv&â€¢G´Äôuõ$Td•‡Ò7–æ4Æ—fTg&öÕ6WVFó¢f–ÆVBf÷"G¶Æ—fU÷2æ–GÒ‚G·7–Ö&öÇÒòG·6–FWÒ“¦À¢W'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"’À¢¢Ð¢Ð¢Ð¢6öç7BööÅ6—¦RÒÖF‚æÖ–â„Ô…ô4ôä5U%$TåEõ4ÅEÂÖF6†W2æÆVæwF‚¢v—B&öÖ—6RæÆÂ„'&’æg&öÒ‡²ÆVæwFƒ¢ööÅ6—¦RÒÂ‚’Óâv÷&¶W"‚’’¢Ò6F6‚†W'"’°¢6öç6öÆRçv&â†G´Äôuõ$Td•‡Ò7–æ4Æ—fTg&öÕ6WVFòF÷ÖÆWfVÂW'&÷#¦ÂW'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"’¢Ð§Ð ¦W‡÷'B6öç7BõöÆ—fU7FvUFW7BÒ°¢Æ—fTW†V7WF–öå6Æ÷BÀ¢—47F—fTÆ—fU6Æ÷E7FGW2À¢&W6öÇfT6öæf—&ÖVE7G&FVw•f&–çBÀ¢6ÆV$Æ—fUF–6¶W$66†R‚’°¢Æ—fUF–6¶W$66†Ræ6ÆV"‚¢ÒÀ¢æ÷&ÖÆ—¦UfVçVUF–6¶W"À¢6VÆV7EfVçVUF–6¶W%&–6RÀ¢G&ç6ÆFU6WVFõG&–Æ–æu7F÷&–6RÀ¢&W—$Æ—fTVçG'•&–6TFöÖ–âÀ¢7–æ2&Vg&W6„Æö6µEDÅv—F„6Æ–VçB†6Æ–VçC¢ç’Â¶W“¢7G&–ærÂFö¶Vã¢7G&–ærÂGFÄ×3¢çVÖ&W"’°¢&WGW&â†v—BWfÄÆö6´ÇV†6Æ–VçBÂ$Te$U4…ôÄô4µõEDÅôÅTÂ¶W’Â·Fö¶VâÂ7G&–ær‡GFÄ×2•Ò’’ÓÓÒ¢ÒÀ¢7–æ2&VÆV6TÆö6µv—F„6Æ–VçB†6Æ–VçC¢ç’Â¶W“¢7G&–ærÂFö¶Vã¢7G&–ær’°¢&WGW&â†v—BWfÄÆö6´ÇV†6Æ–VçBÂ$TÄT4UôÄô4µôÅTÂ¶W’Â·Fö¶VåÒ’’ÓÓÒ¢ÒÀ¢6ö×WFTFW6—&VE&÷FV7F–öå&–6W2À¢æ÷&ÖÆ—¦U&÷FV7F–öåG&–vvW%&–6RÀ¢–æ—F–Ävw&VvFU&÷FV7F–öä6ö÷&F–æF–öâÀ¢&ö¦V7Dvw&VvFTÖVÖ&W$6÷fW&vRÀ¢&Vg&W6„6öçG&öÄ÷&FW%6WD6÷fW&vRÀ¢vw&VvFU&÷FV7F–öä×WFF–öä—4–äfÆ–v‡BÀ¢vw&VvFU&÷FV7F–öä×WFF–öä—4&æFöæVBÀ¢—5FW&Ö–æÅ7—7FVÔ6Æ÷6T÷&FW"À¢6Æ76–g•7—7FVÔ6Æ÷6Tf–ÇW&RÀ¢66†VGVÆU7—7FVÔ6Æ÷6U&WG'’À¢—57—7FVÔ6Æ÷6U&WG'”FVfW'&VBÀ¢†5Vç&W6öÇfVE7—7FVÔ6Æ÷6TFVÆ—fW'’À¢6WGFÆT6öçG&öÄ÷&FW'4&Vf÷&U7—7FVÔ6Æ÷6RÀ¢6WGFÆT6öçG&öÄ÷&FW'4&Vf÷&UVçF—G”×WFF–öâÀ¢Ç•&VGV7F–öäö'6W'fF–öâÀ¢6WGFÆU6†&VD6öçG&öÄ7&÷74ÖVÖ&W'2À¢6WGFÆU6Æ÷D6öçG&öÇ5v—F†÷WDwVW72À¢&V6öæ6–ÆTvw&VvFU&÷FV7F–öä&öö²À¢vWD66†VE&÷FV7F–öåöÆ–7’À¢6WGFÆTf–ÆÆVE&÷t6öçG&öÇ47&÷74ÖVÖ&W'2À¢&V6öæ6–ÆUVæF–æt67V×VÆF–öäæE&V&ÒÀ¢&V6öæ6–ÆTWF†÷&—FF—fTW†6†ævUVçF—G’À¢&V6öæ6–ÆT–æ—F–ÄVçG'”&6UVçF—G’À¢FÖ—D67V×VÆF–öåVçF—G’À¢‡—6–6Ä67V×VÆF–öä6÷VçBÀ¢&W6öÇfT67V×VÆF–öåÆâÀ¢7vVW÷'†å&÷FV7F–öä÷&FW'2À¢fWF6„Æ—fT÷&FW$–E6WBÀ¢Æ6U&÷FV7F–öä÷&FW"À¢6V7W&—G•7F÷VçF—G”G&–gFVBÀ¢6V7W&—G•7F÷&–6U&V&ÔFVfW'&VBÀ¢WFFU&÷FV7F–öä÷&FW'2À¢&÷FV7F–öäÆVt&ÖVEVçF—G’À¢6WE&÷FV7F–öäÆVt&ÖVEVçF—G’À¢6ÆV$Ö—76–æu&÷FV7F–öä÷&FW$–G2À¢&W6öÇfU6WVFõ&÷FV7F–öåW&6VçG2À¢—5G&–Æ–æu7F÷F–v‡FVæ–ærÀ¢—5&Tf–ÆÅv—F†÷WDW†6†ævT†æFÆRÀ¢†4Æ—fTW†6†ævT†æFÆRÀ¢6†÷VÆEW'6—7D6æöæ–6ÄÆ—fU÷6—F–öâÀ¢—4V×G”&ööµ&÷FV7F–öå6fRÀ¢&VD'6öÇWFU&÷FV7F–öå&–6W2‡÷3¢Æ—fU÷6—F–öâ’°¢&WGW&â6ö×WFTFW6—&VE&÷FV7F–öå&–6W2‡÷2¢ÒÀ¢—4Ö&–wV÷W46öçG&öÄ÷&FW$FVÆ—fW'’À¢&V6öæ6–ÆTÖ&–wV÷W5&÷FV7F–öåw&—FRÀ¢FWFV7E6ÇG7&÷72‡÷3¢Æ—fU÷6—F–öâÂ&–6S¢çVÖ&W"Â7F÷Æ÷75&–6Só¢çVÖ&W"ÂF¶U&öf—E&–6Só¢çVÖ&W"“¢'6Åö†—B"Â'Gö†—B"ÂçVÆÂ°¢–b‡÷2æF—&V7F–öâÓÓÒ'6†÷'B"’°¢–b‡7F÷Æ÷75&–6Rbb&–6RãÒ7F÷Æ÷75&–6R’&WGW&â'6Åö†—B ¢–b‡F¶U&öf—E&–6Rbb&–6RÃÒF¶U&öf—E&–6R’&WGW&â'Gö†—B ¢&WGW&âçVÆÀ¢Ð¢–b‡7F÷Æ÷75&–6Rbb&–6RÃÒ7F÷Æ÷75&–6R’&WGW&â'6Åö†—B ¢–b‡F¶U&öf—E&–6Rbb&–6RãÒF¶U&öf—E&–6R’&WGW&â'Gö†—B ¢&WGW&âçVÆÀ¢ÒÀ§Ð ¦W‡÷'BFVfVÇB°¢W†V7WFTÆ—fU÷6—F–öâÀ¢WFFTÆ—fU÷6—F–öäf–ÆÂÀ¢6Æ÷6TÆ—fU÷6—F–öâÀ¢vWDÆ—fU÷6—F–öç2À¢vWDÆ—fU÷6—F–öç4'•7FGW2À¢6Æ7VÆFTÆ—fU÷6—F–öå7FG2À¢7–æ5v—F„W†6†ævRÀ¢&V6öæ6–ÆTÆ—fU÷6—F–öç2À¢&V6Æ7VÆFTæDÇ•4ÅEÀ¢7–æ4Æ—fTg&öÕ6WVFòÀ¢vWD6Æ÷6VDÆ—fU÷6—F–öç2À¢&ö6W756–×VÆFVE÷6—F–öç2À§Ð 