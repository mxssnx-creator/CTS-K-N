import {
  DEFAULT_FOREX_SPREAD_BUFFER_PIPS,
  DEFAULT_FOREX_SPREAD_MULTIPLIER,
  DEFAULT_FOREX_LOT_SIZE,
  forexPriceMovePnlUsd,
  forexPipSize,
  isForexSymbol,
} from "@/lib/forex-market"

/** Canonical exchange position-cost settings, expressed as UI percent values. */
export const POSITION_COST_PERCENT_MIN = 0.02
export const POSITION_COST_PERCENT_MAX = 1
export const POSITION_COST_PERCENT_DEFAULT = 0.1
// Fresh TP set grids start at five PositionCost multiples throughout every
// engine. Existing explicitly saved lower grids remain readable as legacy
// configurations; this is a default, not a destructive migration rule.
export const DEFAULT_TAKE_PROFIT_POSITION_COST_RATIO = 5
// Fresh set generators use this sparse, capacity-safe Cartesian axis. It is
// intentionally separate from legacy read compatibility: previously saved
// lower or denser TP factors remain valid when explicitly selected.
export const DEFAULT_TAKE_PROFIT_POSITION_COST_STEPS = [5, 10, 15, 20] as const

export function normalizePositionCostPercent(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return POSITION_COST_PERCENT_DEFAULT
  return Math.max(POSITION_COST_PERCENT_MIN, Math.min(POSITION_COST_PERCENT_MAX, parsed))
}

/**
 * Converts a configuration-set TP coordinate into a market-price percent.
 *
 * Configuration `takeprofit_factor` values are PositionCost multiples, not
 * literal market percents: factor 5 at a 0.10% PositionCost means a 0.50%
 * gross price move.  Live/signal protections remain explicit `*Pct` values
 * and deliberately do not pass through this converter.
 */
export function takeProfitPositionCostRatioToPercent(
  positionCostPercent: unknown,
  positionCostRatio: unknown,
): number {
  const ratio = Number(positionCostRatio)
  if (!Number.isFinite(ratio) || ratio <= 0) return 0
  return normalizePositionCostPercent(positionCostPercent) * ratio
}

/**
 * Converts the configured `TP-ratio × SL-to-TP-ratio` coordinate into a
 * market-price percent.  It is the paired counterpart of the TP converter
 * above and prevents one engine from treating the same set axis as a raw
 * percentage while another treats it as a PositionCost multiple.
 */
export function stopLossPositionCostRatioToPercent(
  positionCostPercent: unknown,
  takeProfitPositionCostRatio: unknown,
  stopLossToTakeProfitRatio: unknown,
): number {
  const takeProfitRatio = Number(takeProfitPositionCostRatio)
  const stopLossRatio = Number(stopLossToTakeProfitRatio)
  if (
    !Number.isFinite(takeProfitRatio) || takeProfitRatio <= 0 ||
    !Number.isFinite(stopLossRatio) || stopLossRatio <= 0
  ) return 0
  return takeProfitPositionCostRatioToPercent(
    positionCostPercent,
    takeProfitRatio * stopLossRatio,
  )
}

export interface PositionCostQuote {
  bid: number
  ask: number
  last?: number
  digits?: number
  timestamp?: number
  marketType?: "crypto" | "forex"
}

export interface ForexPositionCostSettings {
  marketType?: "crypto" | "forex"
  spreadBufferPips?: number
  spreadMultiplier?: number
}

export interface ObservedSpread {
  bid: number
  ask: number
  mid: number
  spreadPrice: number
  spreadPips?: number
  spreadBps: number
  timestamp: number
}

/** Normalize a live bid/ask quote once at the market boundary. */
export function calculateObservedSpread(quote: PositionCostQuote, symbol?: string): ObservedSpread | null {
  const bid = Number(quote.bid)
  const ask = Number(quote.ask)
  if (!(bid > 0) || !(ask >= bid)) return null
  const mid = (bid + ask) / 2
  if (!(mid > 0)) return null
  const spreadPrice = ask - bid
  const forex = quote.marketType === "forex" || Boolean(symbol && isForexSymbol(symbol))
  return {
    bid,
    ask,
    mid,
    spreadPrice,
    ...(forex ? { spreadPips: spreadPrice / forexPipSize(symbol) } : {}),
    spreadBps: (spreadPrice / mid) * 10_000,
    timestamp: Number.isFinite(Number(quote.timestamp)) && Number(quote.timestamp) > 0 ? Number(quote.timestamp) : Date.now(),
  }
}

/**
 * PositionCost is a configured minimum friction budget. The current venue
 * quote widens it when the observed spread is larger, so protections and
 * evaluations cannot call a trade profitable while it is still inside the
 * executable bid/ask width.
 */
export function effectivePositionCostPercent(
  configuredPercent: unknown,
  quote: PositionCostQuote | null | undefined,
  symbol?: string,
  settings: ForexPositionCostSettings = {},
): number {
  const configured = normalizePositionCostPercent(configuredPercent)
  const observed = quote ? calculateObservedSpread(quote, symbol) : null
  const marketType = settings.marketType || quote?.marketType
  const isForex = marketType === "forex" || Boolean(symbol && isForexSymbol(symbol))
  const multiplierValue = Number(settings.spreadMultiplier)
  const bufferValue = Number(settings.spreadBufferPips)
  const multiplier = isForex
    ? (Number.isFinite(multiplierValue) ? Math.max(0, multiplierValue) : DEFAULT_FOREX_SPREAD_MULTIPLIER)
    : 1
  const bufferPips = isForex
    ? (Number.isFinite(bufferValue) ? Math.max(0, bufferValue) : DEFAULT_FOREX_SPREAD_BUFFER_PIPS)
    : 0
  const observedPercent = observed
    ? (observed.spreadBps / 100) * multiplier + (isForex && symbol ? (bufferPips * forexPipSize(symbol) / observed.mid) * 100 : 0)
    : 0
  return normalizePositionCostPercent(Math.max(configured, observedPercent))
}

export function executableEntryPrice(
  direction: "long" | "short",
  quote: PositionCostQuote,
): number {
  return direction === "long" ? Number(quote.ask) : Number(quote.bid)
}

export function executableExitPrice(
  direction: "long" | "short",
  quote: PositionCostQuote,
): number {
  return direction === "long" ? Number(quote.bid) : Number(quote.ask)
}

export interface ForexNetPnlInput {
  direction: "long" | "short"
  lots: number
  entryPrice: number
  exitPrice: number
  lotSize?: number
  symbol?: string
  quoteToUsdRate?: number
  commission?: number
  swap?: number
}

/** Quote-currency PnL for Forex lots; commission and swap are expenses. */
export function calculateForexNetPnl(input: ForexNetPnlInput): number {
  const units = Number(input.lots) * Number(input.lotSize ?? DEFAULT_FOREX_LOT_SIZE)
  const entry = Number(input.entryPrice)
  const exit = Number(input.exitPrice)
  if (!(units > 0) || !(entry > 0) || !(exit > 0)) return 0
  const gross = (input.direction === "long" ? exit - entry : entry - exit) * units
  return gross - Math.max(0, Number(input.commission) || 0) - Math.max(0, Number(input.swap) || 0)
}

/** USD-normalized Forex PnL for overview, risk, and independent evaluations. */
export function calculateForexNetPnlUsd(input: ForexNetPnlInput): number {
  const grossUsd = forexPriceMovePnlUsd(
    input.direction,
    input.lots,
    input.entryPrice,
    input.exitPrice,
    input.symbol,
    input.lotSize ?? DEFAULT_FOREX_LOT_SIZE,
    input.quoteToUsdRate,
  )
  return grossUsd - Math.max(0, Number(input.commission) || 0) - Math.max(0, Number(input.swap) || 0)
}

export function positionCostMoneyFromSpread(
  quote: PositionCostQuote,
  lots: number,
  lotSize = DEFAULT_FOREX_LOT_SIZE,
  settings: ForexPositionCostSettings = {},
  symbol?: string,
): number {
  const spread = calculateObservedSpread(quote, symbol)
  const units = Number(lots) * Number(lotSize)
  if (!spread || !(units > 0)) return 0
  const rawMultiplier = Number(settings.spreadMultiplier)
  const rawBuffer = Number(settings.spreadBufferPips)
  const multiplier = Number.isFinite(rawMultiplier)
    ? Math.max(0, rawMultiplier)
    : DEFAULT_FOREX_SPREAD_MULTIPLIER
  const buffer = Number.isFinite(rawBuffer)
    ? Math.max(0, rawBuffer)
    : DEFAULT_FOREX_SPREAD_BUFFER_PIPS
  const pip = spread.spreadPips !== undefined ? buffer * (spread.spreadPrice / Math.max(spread.spreadPips, Number.EPSILON)) : 0
  return (spread.spreadPrice * multiplier + pip) * units
}
