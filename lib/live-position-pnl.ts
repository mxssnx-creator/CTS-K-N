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

  const quantity = resolvePositionQuantity(position, lifetime)
  const entry = resolveEntryPrice(position)
  const leverage = Math.max(1, firstPositiveNumeric(position.leverage, exchange.leverage) ?? 1)
  return entry && quantity ? (entry * quantity) / leverage : undefined
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
  const quantity = resolvePositionQuantity(position, lifetimeQuantity)
  const entry = resolveEntryPrice(position)
  if (!direction || !quantity || !entry || !currentPrice) return undefined
  const gross = quantity * (direction === "short" ? entry - currentPrice : currentPrice - entry)
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
