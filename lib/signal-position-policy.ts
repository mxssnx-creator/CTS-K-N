import { connectionTrackingId, isConnectionOwnedClientOrderId, systemTrackingPrefix } from "@/lib/system-order-ownership"

// Signal limits (operator, 2026-09-29). They apply to SIGNALS only and do not
// touch Main, Preset, Direct Trade or the system-wide Previous-position contract.
//
// POSITION = one symbol + direction. Several internal rows (lanes, add-ons) on
// the same symbol and direction are ONE position; a symbol held Long and Short is
// two, counted independently. The limit is 100 by default.
//
// ORDER = every internal position row and every order of it, partial fills
// included. Orders are unlimited by default; an optional per-symbol orders
// limit exists whose finite values below 32 are raised to 32.
export const SIGNAL_MAX_POSITIONS_DEFAULT = 100
export const SIGNAL_MAX_POSITIONS_MIN = 1
export const SIGNAL_MAX_POSITIONS_MAX = 350
export const SIGNAL_POSITION_SELECTION_MODE = "best_first" as const

/**
 * Orders: every order of the active Signal positions counts, partial fills
 * included. 0 means unlimited, which is the default. A finite limit is
 * enforced at Signal admission like the position limits.
 */
export const SIGNAL_MAX_ORDERS_UNLIMITED = 0
export const SIGNAL_MAX_ORDERS_DEFAULT = SIGNAL_MAX_ORDERS_UNLIMITED
export const SIGNAL_MAX_ORDERS_MAX = 1_000_000
/** Optional orders limit for ONE symbol: 0 = unlimited (default); a finite value below 32 becomes 32. */
export const SIGNAL_MAX_ORDERS_PER_SYMBOL_MIN = 32
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
  /** Orders on the candidate's symbol (set when a finite per-symbol orders limit was checked). */
  symbolOrders?: number
  /** The per-symbol orders limit that applied; 0 = unlimited. */
  symbolOrdersLimit?: number
  /** Internal position rows behind the positions (several rows on one symbol + direction are ONE position). */
  rows?: number
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

/** Symbol as the position slots key it: upper case, letters and digits only. */
export function signalSlotSymbol(symbol: unknown): string {
  return String(symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}
/** The slot of a position: one symbol + one direction. */
export function signalSlotMember(symbol: unknown, direction: unknown): string {
  return `${signalSlotSymbol(symbol)}:${direction === "short" ? "short" : "long"}`
}

export function normalizeSignalMaxOrdersPerSymbol(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return SIGNAL_MAX_ORDERS_UNLIMITED
  return Math.round(Math.min(SIGNAL_MAX_ORDERS_MAX, Math.max(SIGNAL_MAX_ORDERS_PER_SYMBOL_MIN, parsed)))
}

export function normalizeSignalMinProfitFactor(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < SIGNAL_MIN_PF_RAISE_BELOW) return SIGNAL_MIN_PF_DEFAULT
  return Math.round(Math.min(SIGNAL_MIN_PF_MAX, parsed) * 100) / 100
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
 * Orders of ONE internal Signal position row, partial fills included. The row
 * itself counts as an order (at least one). Every distinct order
 * counts once — entry, add-on, protective (stop loss, take profit, security)
 * and close orders, from the tracked client ids, the stored order ids and the
 * settlement ids — and every further fill of the same order counts as well,
 * so a partially filled order is not hidden behind its first fill.
 */
/**
 * A Signal row that belongs to THIS system on THIS connection. Only these are
 * counted as positions or orders and only these can meet a limit: other systems
 * trade the same accounts (X01: a second system with client ids "ctsax1_…", the
 * bots with "cb…") and must neither fill the limits nor be affected by them.
 *
 * A row is excluded only when it is PROVABLY foreign: a different connection
 * id, or a system / connection tracking id that is present and does not match.
 * A row without those fields (older rows) is this system's own — the live
 * position list of a connection is written by this system only — because
 * treating "not provable" as foreign would undercount and let the limit be
 * exceeded.
 */
export function isSystemOwnSignalRow(row: Record<string, any> | null | undefined, connectionId: string): boolean {
  if (!row || !connectionId) return false
  const text = (value: unknown) => String(value ?? "").trim()
  const rowConnection = text(row.connectionId ?? row.connection_id)
  if (rowConnection && rowConnection !== connectionId) return false
  const systemId = text(row.system_tracking_id ?? row.systemTrackingId)
  if (systemId && !systemId.startsWith(systemTrackingPrefix(connectionId))) return false
  const trackingId = text(row.connection_tracking_id ?? row.connectionTrackingId)
  if (trackingId && trackingId !== connectionTrackingId(connectionId)) return false
  return true
}

export function countSignalPositionOrders(position: Record<string, any> | null | undefined, connectionId?: string): number {
  if (!position) return 0
  // With a connection the count is own-only: a row that is not this system's
  // has no orders here, and a tracked client order id that is not this
  // system's (another system's or a bot's) is not counted.
  if (connectionId && !isSystemOwnSignalRow(position, connectionId)) return 0
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
  for (const entry of tracked) {
    const clientId = entry?.clientOrderId ?? entry?.id
    if (connectionId && orderKey(clientId) && !isConnectionOwnedClientOrderId(clientId, connectionId)) continue
    add(clientId)
  }
  const fillsPerOrder = new Map<string, number>()
  for (const fill of Array.isArray(position.fills) ? position.fills : []) {
    const key = orderKey(fill?.orderId)
    if (!key) continue
    orders.add(key)
    fillsPerOrder.set(key, (fillsPerOrder.get(key) || 0) + 1)
  }
  let extraFills = 0
  for (const count of fillsPerOrder.values()) extraFills += Math.max(0, count - 1)
  // An internal position row counts as an order in its own right, also before
  // any venue order id is known (pending, simulated).
  return Math.max(1, orders.size + extraFills)
}

export interface SignalCountSummary {
  /** Positions: distinct symbol + direction slots. Several rows on one slot are ONE position. */
  positions: number
  /** Long positions (distinct symbols held Long) and Short positions, counted independently. */
  long: number
  short: number
  symbols: number
  /** Internal position rows behind those positions. */
  rows: number
  /** Orders: every row and every order of it, partial fills included. */
  orders: number
  bySymbol: Array<{ symbol: string; long: number; short: number; rows: number; orders: number }>
}

/** Independent Long / Short / per-symbol POSITION counts, plus the rows and the order total. */
export function summarizeSignalCounts(
  rows: ReadonlyArray<{ symbol?: unknown; direction?: unknown; orders?: number }>,
): SignalCountSummary {
  const bySymbol = new Map<string, { symbol: string; long: number; short: number; rows: number; orders: number }>()
  let rowCount = 0
  let orders = 0
  for (const row of rows) {
    const symbol = signalSlotSymbol(row.symbol)
    if (!symbol || (row.direction !== "long" && row.direction !== "short")) continue
    const entry = bySymbol.get(symbol) || { symbol, long: 0, short: 0, rows: 0, orders: 0 }
    entry[row.direction] = 1 // one position per symbol + direction, however many rows it has
    entry.rows++
    entry.orders += Math.max(0, Number(row.orders) || 0)
    rowCount++
    orders += Math.max(0, Number(row.orders) || 0)
    bySymbol.set(symbol, entry)
  }
  const entries = [...bySymbol.values()]
  const long = entries.reduce((sum, e) => sum + e.long, 0)
  const short = entries.reduce((sum, e) => sum + e.short, 0)
  return {
    positions: long + short,
    long,
    short,
    symbols: entries.length,
    rows: rowCount,
    orders,
    bySymbol: entries.sort((a, b) => (b.long + b.short) - (a.long + a.short) || b.rows - a.rows || a.symbol.localeCompare(b.symbol)).slice(0, 50),
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
  // A position is one symbol + direction: several rows on it are ONE position,
  // a symbol held Long and Short is two.
  const slots = new Set<string>()
  const longSlots = new Set<string>()
  const shortSlots = new Set<string>()
  let rows = 0
  for (const position of positions) {
    if (!isActiveSignalPosition(position)) continue
    if (position.direction !== "long" && position.direction !== "short") continue
    rows++
    const slot = signalSlotMember(position.symbol, position.direction)
    slots.add(slot)
    if (position.direction === "long") longSlots.add(slot)
    else shortSlots.add(slot)
  }
  const total = slots.size
  const long = longSlots.size
  const short = shortSlots.size
  const direction =
    candidateDirection === "long" || candidateDirection === "short"
      ? candidateDirection
      : null
  if (!direction) {
    return { allowed: false, reason: "invalid_direction", total, long, short, limit, rows }
  }
  return {
    allowed: total < limit,
    reason: total < limit ? "available" : "total_limit",
    total,
    long,
    short,
    limit,
    rows,
  }
}
