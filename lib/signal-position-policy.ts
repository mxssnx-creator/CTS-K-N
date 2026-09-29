// Positions and Orders are two separate Signal limits (operator, 2026-09-29).
// Positions: default 100. A position is one active Signal row; Long and Short
// are counted independently, so a symbol held Long and Short counts twice.
export const SIGNAL_MAX_POSITIONS_DEFAULT = 100
export const SIGNAL_MAX_POSITIONS_MIN = 1
export const SIGNAL_MAX_POSITIONS_MAX = 350
export const SIGNAL_POSITION_SELECTION_MODE = "best_first" as const

/**
 * Signal-only limits (operator, 2026-09-29). They do not touch Main, Preset,
 * Direct Trade or the system-wide Previous-position contract.
 *
 * Per symbol: at most this many active Signal positions (Long + Short) may
 * exist on one symbol. A value below 32 is raised to 32; the upper bound is the
 * overall Signal limit.
 */
export const SIGNAL_MAX_POSITIONS_PER_SYMBOL_DEFAULT = 32
export const SIGNAL_MAX_POSITIONS_PER_SYMBOL_MIN = 32
/**
 * Orders: every order of the active Signal positions counts, partial fills
 * included. 0 means unlimited, which is the default. A finite limit is
 * enforced at Signal admission like the position limits.
 */
export const SIGNAL_MAX_ORDERS_UNLIMITED = 0
export const SIGNAL_MAX_ORDERS_DEFAULT = SIGNAL_MAX_ORDERS_UNLIMITED
export const SIGNAL_MAX_ORDERS_MAX = 1_000_000
/**
 * Minimum profit factor for Signals. A value below 1.2 is raised to 1.25; a
 * value from 1.2 upward is kept. Applies to the Signal source validation and to
 * the Signal exact-configuration gate.
 */
export const SIGNAL_MIN_PF_RAISE_BELOW = 1.2
export const SIGNAL_MIN_PF_DEFAULT = 1.25
export const SIGNAL_MIN_PF_MAX = 5

export type SignalPositionDirection = "long" | "short"
export type SignalPositionSelectionMode = typeof SIGNAL_POSITION_SELECTION_MODE

export interface SignalCandidateRank {
  symbol: string
  direction: SignalPositionDirection
  score: number
  confidence: number
  agreement: number
  strength: number
  rewardRisk: number
  stopLossPct: number
  drawdownPct: number
  volatility12hPct: number
  generatedAt: number
  expiresAt: number
}

export interface SignalPositionCapacity {
  allowed: boolean
  reason: "available" | "total_limit" | "symbol_limit" | "order_limit" | "invalid_direction"
  total: number
  long: number
  short: number
  limit: number
  /** Active Signal positions on the candidate's symbol (set when the symbol was checked). */
  symbolTotal?: number
  /** The per-symbol limit that applied. */
  symbolLimit?: number
  /** Orders of the active Signal positions (partial fills included); set when a finite order limit was checked. */
  orders?: number
  /** The order limit that applied; 0 = unlimited. */
  ordersLimit?: number
}

const TERMINAL_POSITION_STATUSES = new Set([
  "closed",
  "rejected",
  "error",
  "cancelled",
  "canceled",
  "failed",
])

export function signalCandidateRankKey(connectionId: string): string {
  const safeConnectionId =
    String(connectionId || "unknown")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_") || "unknown"
  return `signal:candidate_rank:${safeConnectionId}`
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value: unknown, min: number, max: number, fallback = min): number {
  return Math.max(min, Math.min(max, finite(value, fallback)))
}

export function normalizeSignalMaxPositions(value: unknown): number {
  return Math.round(clamp(
    value,
    SIGNAL_MAX_POSITIONS_MIN,
    SIGNAL_MAX_POSITIONS_MAX,
    SIGNAL_MAX_POSITIONS_DEFAULT,
  ))
}

export function normalizeSignalMaxPositionsPerSymbol(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < SIGNAL_MAX_POSITIONS_PER_SYMBOL_MIN) {
    return SIGNAL_MAX_POSITIONS_PER_SYMBOL_DEFAULT
  }
  return Math.round(Math.min(SIGNAL_MAX_POSITIONS_MAX, parsed))
}

export function normalizeSignalMinProfitFactor(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < SIGNAL_MIN_PF_RAISE_BELOW) return SIGNAL_MIN_PF_DEFAULT
  return Math.round(Math.min(SIGNAL_MIN_PF_MAX, parsed) * 100) / 100
}

/** Pure per-symbol admission decision: room for one more when the count is below the limit. */
export function evaluateSignalSymbolCapacity(symbolCount: unknown, limit: unknown): { allowed: boolean; symbolTotal: number; symbolLimit: number } {
  const symbolLimit = normalizeSignalMaxPositionsPerSymbol(limit)
  const symbolTotal = Math.max(0, Math.floor(Number(symbolCount) || 0))
  return { allowed: symbolTotal < symbolLimit, symbolTotal, symbolLimit }
}

export function normalizeSignalMaxOrders(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return SIGNAL_MAX_ORDERS_UNLIMITED
  return Math.round(Math.min(SIGNAL_MAX_ORDERS_MAX, parsed))
}

/** Pure order decision: a limit of 0 never blocks. */
export function evaluateSignalOrderCapacity(orderCount: unknown, limit: unknown): { allowed: boolean; orders: number; ordersLimit: number } {
  const ordersLimit = normalizeSignalMaxOrders(limit)
  const orders = Math.max(0, Math.floor(Number(orderCount) || 0))
  return { allowed: ordersLimit === SIGNAL_MAX_ORDERS_UNLIMITED || orders < ordersLimit, orders, ordersLimit }
}

function orderKey(value: unknown): string {
  const text = String(value ?? "").trim()
  return text
}

/**
 * Orders of ONE Signal position, partial fills included. Every distinct order
 * counts once — entry, add-on, protective (stop loss, take profit, security)
 * and close orders, from the tracked client ids, the stored order ids and the
 * settlement ids — and every further fill of the same order counts as well,
 * so a partially filled order is not hidden behind its first fill.
 */
export function countSignalPositionOrders(position: Record<string, any> | null | undefined): number {
  if (!position) return 0
  const orders = new Set<string>()
  const add = (value: unknown) => { const key = orderKey(value); if (key) orders.add(key) }
  add(position.orderId)
  add(position.closeOrderId)
  add(position.stopLossOrderId)
  add(position.takeProfitOrderId)
  add(position.securityStopOrderId)
  for (const id of Array.isArray(position.settledOrderIds) ? position.settledOrderIds : []) add(id)
  for (const id of Array.isArray(position.entrySettlementOrderIds) ? position.entrySettlementOrderIds : []) add(id)
  const tracked = Array.isArray(position.exchangeData?.clientOrderIds) ? position.exchangeData.clientOrderIds : []
  for (const entry of tracked) add(entry?.clientOrderId ?? entry?.id)
  const fillsPerOrder = new Map<string, number>()
  for (const fill of Array.isArray(position.fills) ? position.fills : []) {
    const key = orderKey(fill?.orderId)
    if (!key) continue
    orders.add(key)
    fillsPerOrder.set(key, (fillsPerOrder.get(key) || 0) + 1)
  }
  let extraFills = 0
  for (const count of fillsPerOrder.values()) extraFills += Math.max(0, count - 1)
  return orders.size + extraFills
}

export interface SignalCountSummary {
  /** Active Signal positions; every row counts, Long and Short independently. */
  positions: number
  long: number
  short: number
  symbols: number
  orders: number
  bySymbol: Array<{ symbol: string; long: number; short: number; orders: number }>
}

/** Independent Long / Short / per-symbol position counts and the order total. */
export function summarizeSignalCounts(
  rows: ReadonlyArray<{ symbol?: unknown; direction?: unknown; orders?: number }>,
): SignalCountSummary {
  const bySymbol = new Map<string, { symbol: string; long: number; short: number; orders: number }>()
  let long = 0
  let short = 0
  let orders = 0
  for (const row of rows) {
    const symbol = String(row.symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
    if (!symbol) continue
    const entry = bySymbol.get(symbol) || { symbol, long: 0, short: 0, orders: 0 }
    if (row.direction === "long") { entry.long++; long++ }
    else if (row.direction === "short") { entry.short++; short++ }
    else continue
    entry.orders += Math.max(0, Number(row.orders) || 0)
    orders += Math.max(0, Number(row.orders) || 0)
    bySymbol.set(symbol, entry)
  }
  return {
    positions: long + short,
    long,
    short,
    symbols: bySymbol.size,
    orders,
    bySymbol: [...bySymbol.values()].sort((a, b) => (b.long + b.short) - (a.long + a.short) || a.symbol.localeCompare(b.symbol)).slice(0, 50),
  }
}

export function normalizeSignalPositionSelectionMode(
  _value: unknown,
): SignalPositionSelectionMode {
  // Best-first is deliberately the only supported admission mode. Allowing a
  // persisted FIFO/random value would make a lower-quality website consensus
  // occupy scarce position capacity ahead of a stronger candidate.
  return SIGNAL_POSITION_SELECTION_MODE
}

export function calculateSignalCandidateQuality(input: {
  confidence?: unknown
  agreement?: unknown
  strength?: unknown
  rewardRisk?: unknown
}): number {
  const confidence = clamp(input.confidence, 0, 1)
  const agreement = clamp(input.agreement, 0, 1)
  const strength = clamp(input.strength, 0, 1)
  const rewardRisk = clamp(input.rewardRisk, 0, 5) / 5
  return Number((
    confidence * 0.4 +
    agreement * 0.3 +
    strength * 0.2 +
    rewardRisk * 0.1
  ).toFixed(8))
}

export function parseSignalCandidateRanks(
  raw: Record<string, unknown> | null | undefined,
  now = Date.now(),
): Map<string, SignalCandidateRank> {
  const ranks = new Map<string, SignalCandidateRank>()
  for (const [field, encoded] of Object.entries(raw || {})) {
    try {
      const row = typeof encoded === "string"
        ? JSON.parse(encoded)
        : encoded as Record<string, unknown>
      if (!row || typeof row !== "object") continue
      const symbol = String(row.symbol || field).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "")
      const direction = row.direction === "short" ? "short" : row.direction === "long" ? "long" : null
      const score = finite(row.score, Number.NaN)
      const generatedAt = finite(row.generatedAt)
      const expiresAt = finite(row.expiresAt)
      if (
        !symbol ||
        !direction ||
        !Number.isFinite(score) ||
        score < 0 ||
        generatedAt <= 0 ||
        expiresAt <= now
      ) continue
      ranks.set(symbol, {
        symbol,
        direction,
        score,
        confidence: clamp(row.confidence, 0, 1),
        agreement: clamp(row.agreement, 0, 1),
        strength: clamp(row.strength, 0, 1),
        rewardRisk: clamp(row.rewardRisk, 0, 5),
        stopLossPct: clamp(row.stopLossPct, 0, 100),
        drawdownPct: clamp(row.drawdownPct, 0, 100),
        volatility12hPct: clamp(row.volatility12hPct, 0, 10_000),
        generatedAt,
        expiresAt,
      })
    } catch {
      // A malformed diagnostic row must not disturb the engine's configured
      // symbol basket. It is ignored and naturally replaced on the next
      // successful Signal observation.
    }
  }
  return ranks
}

export function rankSignalSymbolsBestFirst(
  symbols: readonly string[],
  ranks: ReadonlyMap<string, SignalCandidateRank>,
): string[] {
  const normalized = Array.from(new Set(
    symbols
      .map((symbol) => String(symbol || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, ""))
      .filter(Boolean),
  ))
  const originalIndex = new Map(normalized.map((symbol, index) => [symbol, index]))
  return normalized.sort((left, right) => {
    const leftRank = ranks.get(left)
    const rightRank = ranks.get(right)
    if (leftRank && rightRank) {
      return (
        rightRank.volatility12hPct - leftRank.volatility12hPct ||
        leftRank.stopLossPct - rightRank.stopLossPct ||
        leftRank.drawdownPct - rightRank.drawdownPct ||
        rightRank.score - leftRank.score ||
        rightRank.confidence - leftRank.confidence ||
        rightRank.generatedAt - leftRank.generatedAt ||
        (originalIndex.get(left) || 0) - (originalIndex.get(right) || 0)
      )
    }
    if (leftRank) return -1
    if (rightRank) return 1
    return (originalIndex.get(left) || 0) - (originalIndex.get(right) || 0)
  })
}

export function isActiveSignalPosition(position: Record<string, unknown>): boolean {
  if (TERMINAL_POSITION_STATUSES.has(String(position.status || "").toLowerCase())) return false
  const indicationType = String(
    position.indicationType ??
    position.indication_type ??
    "",
  ).toLowerCase()
  const executionLane = String(
    position.executionLane ??
    position.execution_lane ??
    "",
  ).toLowerCase()
  const signalRisk = position.signalRisk as { sourceIds?: unknown } | undefined
  return (
    indicationType === "signal" ||
    executionLane === "signal_trailing" ||
    Array.isArray(signalRisk?.sourceIds)
  )
}

export function evaluateSignalPositionCapacity(
  positions: ReadonlyArray<Record<string, unknown>>,
  candidateDirection: unknown,
  configuredLimit: unknown,
): SignalPositionCapacity {
  const limit = normalizeSignalMaxPositions(configuredLimit)
  let total = 0
  let long = 0
  let short = 0
  for (const position of positions) {
    if (!isActiveSignalPosition(position)) continue
    total++
    if (position.direction === "long") long++
    else if (position.direction === "short") short++
  }
  const direction =
    candidateDirection === "long" || candidateDirection === "short"
      ? candidateDirection
      : null
  if (!direction) {
    return { allowed: false, reason: "invalid_direction", total, long, short, limit }
  }
  return {
    allowed: total < limit,
    reason: total < limit ? "available" : "total_limit",
    total,
    long,
    short,
    limit,
  }
}
