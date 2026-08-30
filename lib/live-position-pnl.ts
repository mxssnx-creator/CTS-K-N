import {
  DEFAULT_FOREX_LOT_SIZE,
  forexNotionalUsd,
  forexPriceMovePnlUsd,
  forexQuoteToUsdRate,
  isForexSymbol,
} from "@/lib/forex-market"

/**
 * One canonical PnL projection for live-position API, statistics, and
 * dashboards. Exchange-supplied PnL is authoritative (including zero); a
 * fallback is used only when the venue did not provide a value.
 */

export type PositionDirection = "long" | "short"

export function firstFiniteNumeric(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function firstPositiveNumeric(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = firstFiniteNumeric(value)
    if (parsed !== undefined && parsed > 0) return parsed
  }
  return undefined
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {}
}

export function normalizePositionDirection(value: unknown): PositionDirection | undefined {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (["short", "sell", "sell_short", "short_open"].includes(normalized)) return "short"
  if (["long", "buy", "buy_long", "long_open"].includes(normalized)) return "long"
  return undefined
}

export function resolvePositionDirection(position: Record<string, any>): PositionDirection | undefined {
  return normalizePositionDirection(position.direction)
    ?? normalizePositionDirection(position.side)
    ?? normalizePositionDirection(position.positionSide)
    ?? normalizePositionDirection(position.exchangeData?.positionSide)
}

/**
 * Uses lifetime filled quantity for a closed position and current filled
 * quantity for an open one. `executedQuantity` can be zero after a fully
 * closed lifecycle, while `totalExecutedQuantity` retains the actual fill.
 */
export function resolvePositionQuantity(
  position: Record<string, any>,
  lifetime = false,
): number | undefined {
  return lifetime
    ? firstPositiveNumeric(
      position.totalExecutedQuantity,
      position.executedQuantity,
      position.closedQuantity,
      position.quantity,
      position.exchangeData?.quantity,
      position.exchangeData?.positionAmt,
    )
    : firstPositiveNumeric(
      position.executedQuantity,
      position.quantity,
      position.totalExecutedQuantity,
      position.exchangeData?.quantity,
      position.exchangeData?.positionAmt,
    )
}

const EXECUTION_PROVING_STATUSES = new Set([
  "open",
  "filled",
  "partially_filled",
  "simulated",
  "closing",
  "closing_partial",
  "closed",
])

function absolutePositiveNumeric(value: unknown): number | undefined {
  const parsed = firstFiniteNumeric(value)
  return parsed !== undefined && Math.abs(parsed) > 0 ? Math.abs(parsed) : undefined
}

/**
 * Resolve only venue- or ledger-confirmed execution. `quantity` is the entry
 * request on current live rows, so it may be used as a legacy fallback only
 * after the lifecycle itself proves that a fill occurred. Pending, placed,
 * rejected, and error intents with requested quantity must remain unexecuted.
 */
export function resolveConfirmedPositionQuantity(
  position: Record<string, any>,
  lifetime = false,
): number | undefined {
  const status = String(position.status || "").trim().toLowerCase()
  const fills = Array.isArray(position.fills) ? position.fills : []
  const fillQuantity = fills.reduce((sum: number, fill: unknown) => {
    const quantity = absolutePositiveNumeric(record(fill).quantity)
    return sum + (quantity ?? 0)
  }, 0)
  const exchange = record(position.exchangeData)
  const exchangeQuantity = absolutePositiveNumeric(
    firstFiniteNumeric(
      exchange.quantity,
      exchange.positionAmt,
      exchange.contracts,
      exchange.size,
    ),
  )
  const current = firstPositiveNumeric(position.executedQuantity, exchangeQuantity)
  const closed = firstPositiveNumeric(position.closedQuantity)
  const total = firstPositiveNumeric(position.totalExecutedQuantity)
  const reconstructedLifetime = (current ?? 0) + (closed ?? 0)

  if (lifetime) {
    return firstPositiveNumeric(
      total,
      reconstructedLifetime,
      fillQuantity,
      closed,
      current,
      EXECUTION_PROVING_STATUSES.has(status) ? position.quantity : undefined,
    )
  }

  if (status === "closed") {
    return firstPositiveNumeric(total, closed, fillQuantity, current)
  }
  const reconstructedOpen = total !== undefined && closed !== undefined
    ? Math.max(0, total - closed)
    : undefined
  return firstPositiveNumeric(
    current,
    reconstructedOpen,
    fillQuantity > 0 ? Math.max(0, fillQuantity - (closed ?? 0)) : undefined,
    EXECUTION_PROVING_STATUSES.has(status) ? position.quantity : undefined,
  )
}

/**
 * Resolve the capital actually at risk for a position. Quote-currency PnL is
 * never multiplied by leverage; leverage only converts notional into margin
 * for ROI. Keeping this helper shared prevents dashboards from using an
 * unrelated win/loss denominator as a percentage basis.
 */
export function resolvePositionMargin(
  position: Record<string, any>,
  lifetime = false,
): number | undefined {
  // A locally calculated/requested margin is not exposure until execution is
  // confirmed. Resolve quantity first so pending/rejected intents cannot leak
  // requested capital into ROI or overview totals through an explicit margin.
  const quantity = resolveConfirmedPositionQuantity(position, lifetime)
  if (!quantity) return undefined
  const exchange = record(position.exchangeData)
  const explicitMargin = firstPositiveNumeric(
    position.marginUsd,
    position.margin_usd,
    position.marginUsed,
    position.margin_used,
    position.initialMargin,
    position.initial_margin,
    exchange.marginUsd,
    exchange.marginUsed,
    exchange.initialMargin,
  )
  if (explicitMargin !== undefined) return explicitMargin

  const entry = resolveEntryPrice(position)
  const leverage = Math.max(1, firstPositiveNumeric(position.leverage, exchange.leverage) ?? 1)
  if (!entry) return undefined
  if (isForexPosition(position)) {
    const symbol = position.symbol ?? position.exchangeSymbol ?? exchange.symbol
    const notionalUsd = forexNotionalUsd(
      quantity,
      entry,
      symbol,
      resolveForexLotSize(position),
      resolveForexQuoteToUsdRate(position),
    )
    return notionalUsd > 0 ? notionalUsd / leverage : undefined
  }
  return (entry * quantity) / leverage
}

function resolveEntryPrice(position: Record<string, any>): number | undefined {
  return firstPositiveNumeric(
    position.averageExecutionPrice,
    position.entryPrice,
    position.entry_price,
    position.exchangeData?.averageExecutionPrice,
    position.exchangeData?.entryPrice,
  )
}

export function isForexPosition(position: Record<string, any>): boolean {
  const exchange = record(position.exchangeData)
  const marketType = String(
    position.marketType ?? position.market_type ?? exchange.marketType ?? exchange.market_type ?? "",
  ).trim().toLowerCase()
  const volumeKind = String(
    position.volumeKind ?? position.volume_kind ?? exchange.volumeKind ?? exchange.volume_kind ?? "",
  ).trim().toLowerCase()
  return marketType === "forex" || marketType === "fx" || volumeKind === "lots" || isForexSymbol(
    position.symbol ?? position.exchangeSymbol ?? exchange.symbol,
  )
}

function resolveForexLotSize(position: Record<string, any>): number {
  const exchange = record(position.exchangeData)
  return firstPositiveNumeric(
    position.lotSize,
    position.lot_size,
    position.contractSize,
    position.contract_size,
    exchange.lotSize,
    exchange.lot_size,
    exchange.contractSize,
    exchange.contract_size,
    DEFAULT_FOREX_LOT_SIZE,
  ) ?? DEFAULT_FOREX_LOT_SIZE
}

function resolveForexQuoteToUsdRate(position: Record<string, any>): number | undefined {
  const exchange = record(position.exchangeData)
  return firstPositiveNumeric(
    position.quoteToUsdRate,
    position.quote_to_usd_rate,
    exchange.quoteToUsdRate,
    exchange.quote_to_usd_rate,
  )
}

/**
 * Resolve one position's USD exposure using its market contract. Crypto
 * quantities are base units; Forex quantities are InstaForex lots and need
 * the configured lot size plus quote-currency conversion for cross pairs.
 * Pending/request-only rows intentionally resolve to zero through the
 * confirmed-quantity gate instead of leaking requested size into reports.
 */
export function resolvePositionNotionalUsd(
  position: Record<string, any>,
  quantity?: number,
  price?: number,
): number {
  const exchange = record(position.exchangeData)
  const resolvedQuantity = quantity === undefined
    ? resolveConfirmedPositionQuantity(position) ?? (
      String(position.status || "").trim() ? undefined : resolvePositionQuantity(position)
    )
    : firstFiniteNumeric(quantity)
  const resolvedPrice = price === undefined
    ? resolveMarkPrice(position) ?? resolveEntryPrice(position)
    : firstFiniteNumeric(price)
  if (!(resolvedQuantity && resolvedQuantity > 0) || !(resolvedPrice && resolvedPrice > 0)) return 0
  if (isForexPosition(position)) {
    return forexNotionalUsd(
      resolvedQuantity,
      resolvedPrice,
      position.symbol ?? position.exchangeSymbol ?? exchange.symbol,
      resolveForexLotSize(position),
      resolveForexQuoteToUsdRate(position),
    )
  }
  return resolvedQuantity * resolvedPrice
}

/**
 * Resolve the USD volume for the complete filled lifecycle. Exact fill and
 * exchange-adjustment ledgers win because they preserve partial-fill prices;
 * persisted lifetime/current volume is only a compatibility fallback for
 * older rows. All paths use the same Forex lot and conversion rules.
 */
export function resolvePositionLifetimeVolumeUsd(position: Record<string, any>): number {
  const totalQuantity = resolveConfirmedPositionQuantity(position, true) ?? 0
  if (!(totalQuantity > 0)) return 0

  const fills = Array.isArray(position.fills) ? position.fills : []
  const adjustments = Array.isArray(position.exchangeQuantityAdjustments)
    ? position.exchangeQuantityAdjustments
    : []
  const ledgerRows = [...fills, ...adjustments]
  const ledgerQuantity = ledgerRows.reduce((sum: number, row: unknown) => {
    const value = record(row)
    return sum + (absolutePositiveNumeric(
      value.quantity ?? value.qty ?? value.executedQty,
    ) ?? 0)
  }, 0)
  const quantityTolerance = Math.max(
    1e-10,
    Math.abs(firstFiniteNumeric(position.quantityStep, position.quantity_step) ?? 0) / 2,
  )
  const ledgerHasExactPrices = ledgerRows.length > 0 && ledgerRows.every((row) => {
    const value = record(row)
    return (absolutePositiveNumeric(value.quantity ?? value.qty ?? value.executedQty) ?? 0) > 0 &&
      (firstPositiveNumeric(value.price, value.fillPrice, value.executionPrice) ?? 0) > 0
  })
  if (
    ledgerHasExactPrices &&
    Math.abs(ledgerQuantity - totalQuantity) <= quantityTolerance
  ) {
    return ledgerRows.reduce((sum: number, row: unknown) => {
      const value = record(row)
      const rowQuantity = absolutePositiveNumeric(value.quantity ?? value.qty ?? value.executedQty) ?? 0
      const rowPrice = firstPositiveNumeric(value.price, value.fillPrice, value.executionPrice) ?? 0
      return sum + resolvePositionNotionalUsd(position, rowQuantity, rowPrice)
    }, 0)
  }

  const persistedLifetime = firstPositiveNumeric(
    position.lifetimeVolumeUsd,
    position.lifetime_volume_usd,
  )
  if (persistedLifetime !== undefined) return persistedLifetime

  // Older Forex rows persisted `lots * price` in volumeUsd. Re-derive their
  // notional from the market contract instead of exposing that crypto-style
  // value as USD. Crypto keeps the durable current-volume compatibility path.
  if (!isForexPosition(position)) {
    const persistedCurrent = firstPositiveNumeric(
      position.volumeUsd,
      position.volume_usd,
    )
    if (persistedCurrent !== undefined) return persistedCurrent
  }

  return resolvePositionNotionalUsd(position, totalQuantity, resolveEntryPrice(position))
}

function resolveMarkPrice(position: Record<string, any>): number | undefined {
  return firstPositiveNumeric(
    position.markPrice,
    position.currentPrice,
    position.current_price,
    position.exchangeData?.markPrice,
    position.exchangeData?.currentPrice,
  )
}

function resolveClosePrice(position: Record<string, any>): number | undefined {
  return firstPositiveNumeric(
    position.closePrice,
    position.exitPrice,
    position.exit_price,
    position.exchangeData?.closePrice,
    position.exchangeData?.exitPrice,
  )
}

function normalizedTimestamp(value: unknown): number {
  if (typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return 0
    return parsed < 10_000_000_000 ? parsed * 1000 : parsed
  }
  const parsed = Date.parse(String(value || ""))
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Require authoritative venue accounting for a physically implausible legacy
 * local close. The row is retained for reconciliation, but must not contribute
 * to PnL/PF until the matching exchange close supplies a trustworthy price and
 * result. A 50%+ displacement inside one day is a quarantine trigger, not a
 * claim that such a market move is impossible.
 */
export function requiresVenueAccountingForPricePair(input: {
  environment: "exchange" | "simulated"
  entryPrice: number
  exitPrice: number
  openedAt: number
  closedAt: number
}): boolean {
  if (input.environment !== "exchange") return false
  if (!(input.entryPrice > 0) || !(input.exitPrice > 0)) return false
  if (!(input.openedAt > 0) || input.closedAt < input.openedAt) return false
  const priceRatio = Math.max(input.entryPrice, input.exitPrice) /
    Math.max(Math.min(input.entryPrice, input.exitPrice), Number.EPSILON)
  const holdingMs = input.closedAt - input.openedAt
  return priceRatio >= 1.5 && holdingMs <= 24 * 60 * 60 * 1000
}

function fillFees(position: Record<string, any>): number | undefined {
  if (!Array.isArray(position.fills)) return undefined
  let hasFee = false
  const total = position.fills.reduce((sum: number, fill: unknown) => {
    const fee = firstFiniteNumeric(record(fill).fee, record(fill).commission)
    if (fee === undefined) return sum
    hasFee = true
    return sum + Math.abs(fee)
  }, 0)
  return hasFee ? total : undefined
}

/** Known quote-currency costs only; this intentionally never invents fees. */
export function resolveKnownPositionCosts(position: Record<string, any>): number {
  const exchange = record(position.exchangeData)
  const fees = firstFiniteNumeric(
    position.fees,
    position.totalFees,
    position.fee,
    exchange.fees,
    exchange.totalFees,
    exchange.fee,
    fillFees(position),
  ) ?? 0
  // Funding may be negative (a rebate), therefore preserve its sign.
  const funding = firstFiniteNumeric(
    position.fundingFee,
    position.fundingFees,
    position.funding,
    exchange.fundingFee,
    exchange.fundingFees,
    exchange.funding,
  ) ?? 0
  return Math.abs(fees) + funding
}

function calculateFallbackPnl(
  position: Record<string, any>,
  currentPrice: number | undefined,
  lifetimeQuantity: boolean,
): number | undefined {
  const direction = resolvePositionDirection(position)
  const quantity = resolveConfirmedPositionQuantity(position, lifetimeQuantity)
  const entry = resolveEntryPrice(position)
  if (!direction || !quantity || !entry || !currentPrice) return undefined
  let gross: number
  if (isForexPosition(position)) {
    const exchange = record(position.exchangeData)
    const symbol = position.symbol ?? position.exchangeSymbol ?? exchange.symbol
    const quoteToUsd = forexQuoteToUsdRate(
      symbol,
      currentPrice,
      resolveForexQuoteToUsdRate(position),
    )
    // Cross-pair conversion is mandatory for USD reporting. Do not turn a
    // missing conversion into a false zero-profit result.
    if (!quoteToUsd) return undefined
    gross = forexPriceMovePnlUsd(
      direction,
      quantity,
      entry,
      currentPrice,
      symbol,
      resolveForexLotSize(position),
      quoteToUsd,
    )
  } else {
    gross = quantity * (direction === "short" ? entry - currentPrice : currentPrice - entry)
  }
  return gross - resolveKnownPositionCosts(position)
}

export function resolveUnrealizedPnl(position: Record<string, any>): number | undefined {
  const exchange = record(position.exchangeData)
  const authoritative = firstFiniteNumeric(
    position.unrealizedPnL,
    position.unrealized_pnl,
    position.unrealizedPnl,
    exchange.unrealizedPnl,
    exchange.unrealizedPnL,
    exchange.unRealizedProfit,
  )
  if (authoritative !== undefined) return authoritative
  return calculateFallbackPnl(position, resolveMarkPrice(position), false)
}

export function resolveRealizedPnl(position: Record<string, any>): number | undefined {
  const exchange = record(position.exchangeData)
  const authoritative = firstFiniteNumeric(
    position.realizedPnL,
    position.realized_pnl,
    position.realizedPnl,
    position.pnl,
    exchange.realizedPnl,
    exchange.realizedPnL,
    exchange.realizedProfit,
  )
  if (authoritative !== undefined) return authoritative
  return calculateFallbackPnl(position, resolveClosePrice(position), true)
}

/**
 * Resolve a reporting-safe terminal result. Explicitly incomplete accounting
 * and rows with no finite realized value are both unresolved; neither may be
 * converted into a synthetic break-even result by overview/statistics code.
 */
export function resolveSettledRealizedPnl(
  position: Record<string, any> | null | undefined,
): number | undefined {
  if (!position || isRealizedPnlAccountingPending(position)) return undefined
  const pnl = resolveRealizedPnl(position)
  return pnl !== undefined && Number.isFinite(pnl) ? pnl : undefined
}

/**
 * A terminal exchange row can exist before the venue has returned every fill,
 * fee, or funding component. The lifecycle deliberately persists that row for
 * recovery, but its placeholder `realizedPnL` (often zero) is not a settled
 * result and must never enter W/L/BE, PF, DDT, or operator PnL statistics.
 *
 * Legacy rows without an explicit accounting marker retain their historical
 * behaviour. New exchange rows are fail-closed whenever either completeness
 * alias is false or the durable source explicitly says accounting is pending.
 */
export function isRealizedPnlAccountingPending(
  position: Record<string, any> | null | undefined,
): boolean {
  if (!position) return false
  const status = String(position.status || "").trim().toLowerCase()
  const executionMode = String(position.executionMode || "").trim().toLowerCase()
  const mode = String(position.mode || "").trim().toLowerCase()
  const environment = String(position.environment || "").trim().toLowerCase()
  if (
    status === "simulated" ||
    ["simulation", "simulated", "paper"].includes(executionMode) ||
    mode === "simulated" ||
    mode === "simulation" ||
    mode === "paper" ||
    ["simulation", "simulated", "paper"].includes(environment) ||
    position.isSimulated === true ||
    position.isSimulated === "1" ||
    position.isSimulated === "true" ||
    position.simulated === true ||
    position.simulated === "1" ||
    position.simulated === "true"
  ) {
    return false
  }

  if (status === "closed" && requiresVenueAccountingForPricePair({
    environment: "exchange",
    entryPrice: resolveEntryPrice(position) ?? 0,
    exitPrice: resolveClosePrice(position) ?? 0,
    openedAt: normalizedTimestamp(
      position.openedAt ?? position.opened_at ?? position.createdAt ?? position.created_at ?? position.timestamp,
    ),
    closedAt: normalizedTimestamp(
      position.closedAt ?? position.closed_at ?? position.closeTimestamp ?? position.updatedAt ?? position.updated_at,
    ),
  })) return true

  for (const completeness of [
    position.realizedPnlComplete,
    position.pnlAccountingComplete,
  ]) {
    const normalizedCompleteness = String(completeness ?? "").trim().toLowerCase()
    if (
      completeness === false ||
      completeness === 0 ||
      normalizedCompleteness === "false" ||
      normalizedCompleteness === "0"
    ) {
      return true
    }
  }

  const accountingPending = String(position.accountingPending ?? "").trim().toLowerCase()
  if (
    position.accountingPending === true ||
    position.accountingPending === 1 ||
    accountingPending === "true" ||
    accountingPending === "1"
  ) return true

  const source = [position.realizedPnlSource, position.pnlAccountingSource]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .find(Boolean) || ""
  return source.includes("pending") || source.includes("incomplete") || source.includes("unresolved")
}

/** Reporting-safe realized PnL: retain an authoritative zero and use 0 only when absent. */
export function closedPnl(position: Record<string, any> | null | undefined): number {
  return resolveRealizedPnl(position || {}) ?? 0
}

/** Reporting-safe unrealized PnL: retain an authoritative zero and use 0 only when absent. */
export function openPnl(position: Record<string, any> | null | undefined): number {
  return resolveUnrealizedPnl(position || {}) ?? 0
}

export function derivePositionRoi(
  position: Record<string, any>,
  pnl: number | undefined,
  lifetimeQuantity = false,
): number | undefined {
  if (pnl === undefined) return undefined
  const margin = resolvePositionMargin(position, lifetimeQuantity)
  return margin && margin > 0 ? (pnl / margin) * 100 : undefined
}

export function roundPositionPnl(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}
