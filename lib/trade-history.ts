/** Bounded transport page; the durable history itself is never truncated. */
export const TRADE_HISTORY_PAGE_SIZE = 500
export const MAX_TRADE_HISTORY_PAGE_SIZE = 1_000
/** Compatibility alias for callers that request one transport page. */
export const MAX_TRADE_HISTORY_RECORDS = TRADE_HISTORY_PAGE_SIZE

export interface TradeHistoryRow {
  id: string
  symbol: string
  direction: "long" | "short"
  entryPrice: number
  exitPrice: number
  quantity: number
  volumeUsd: number
  grossPnl: number
  fees: number
  realizedPnl: number
  pnlPct: number
  openedAt: number
  closedAt: number
  holdMinutes: number
  source: "exchange" | "local"
  environment: "exchange" | "simulated"
  executionIntent?: "main" | "preset" | "signal"
  orderId?: string
  closeOrderId?: string
  positionId?: string
  setKey?: string
  parentSetKey?: string
  setVariant?: string
  indicationType?: string
  presetId?: string
  leverage?: number
  marginType?: string
  stopLossPrice?: number
  takeProfitPrice?: number
  trailingActive?: boolean
  trailingStopPrice?: number
  blockCount?: number
  dcaStep?: number
  executionMode?: string
  closeReason?: string
  /**
   * A structurally complete legacy row can still contain locally-derived
   * accounting which is contradicted by its own short holding period and
   * entry/exit prices. Keep that row only as a venue-reconciliation candidate;
   * it must never contribute to operator statistics until a matching exchange
   * close supplies authoritative PnL and price data.
   */
  accountingQuality?: "local" | "exchange_required"
}

/**
 * Compact, versioned transport used by the Statistics page for the complete
 * durable close archive. The tuple avoids repeating eighteen long JSON field
 * names for every row while retaining every input required by AnalyticsEngine,
 * preset attribution and the PositionCost-coordinate panels.
 */
export type StatisticsHistoryTupleV1 = [
  id: string,
  symbol: string,
  strategyType: string,
  realizedPnl: number,
  quantity: number,
  entryPrice: number,
  exitPrice: number,
  volumeUsd: number,
  openedAt: number,
  closedAt: number,
  direction: 0 | 1,
  indicationType: string,
  presetId: string,
  stopLossPrice: number,
  takeProfitPrice: number,
  trailingActive: 0 | 1,
  fees: number,
  holdMinutes: number,
]

function statisticsStrategyType(row: TradeHistoryRow): string {
  const explicit = String(row.setVariant || "").trim()
  if (explicit) return explicit
  if (row.presetId) return "preset"
  if (row.executionIntent) return row.executionIntent
  return row.source === "exchange" ? "unattributed-exchange" : "live"
}

export function toStatisticsHistoryTuple(row: TradeHistoryRow): StatisticsHistoryTupleV1 {
  return [
    row.id,
    row.symbol,
    statisticsStrategyType(row),
    finite(row.realizedPnl),
    positive(row.quantity),
    positive(row.entryPrice),
    positive(row.exitPrice),
    positive(row.volumeUsd),
    normalizeTimestamp(row.openedAt || row.closedAt),
    normalizeTimestamp(row.closedAt || row.openedAt),
    row.direction === "short" ? 1 : 0,
    String(row.indicationType || "direction"),
    String(row.presetId || ""),
    positive(row.stopLossPrice),
    positive(row.takeProfitPrice),
    row.trailingActive ? 1 : 0,
    positive(row.fees),
    Math.max(0, finite(row.holdMinutes)),
  ]
}

export function statisticsHistoryTupleToTradingPosition(
  tuple: StatisticsHistoryTupleV1,
  connectionId: string,
): import("./trading").TradingPosition {
  const [
    id,
    symbol,
    strategyType,
    realizedPnl,
    quantity,
    entryPrice,
    exitPrice,
    volumeUsd,
    openedAt,
    closedAt,
    direction,
    indicationType,
    presetId,
    stopLossPrice,
    takeProfitPrice,
    trailingActive,
    fees,
    holdMinutes,
  ] = tuple
  const safeOpenedAt = openedAt > 0 ? openedAt : closedAt
  const safeClosedAt = closedAt > 0 ? closedAt : safeOpenedAt
  const position = {
    id,
    connection_id: connectionId,
    symbol,
    strategy_type: strategyType || "live",
    volume: Math.abs(quantity),
    entry_price: entryPrice,
    current_price: exitPrice || entryPrice,
    ...(takeProfitPrice > 0 && { takeprofit: takeProfitPrice }),
    ...(stopLossPrice > 0 && { stoploss: stopLossPrice }),
    profit_loss: realizedPnl,
    status: "closed" as const,
    opened_at: new Date(safeOpenedAt).toISOString(),
    closed_at: new Date(safeClosedAt).toISOString(),
    position_side: direction === 1 ? "short" as const : "long" as const,
    leverage: 1,
    indication_type: (indicationType || "direction") as import("./trading").TradingPosition["indication_type"],
    ...(presetId && { preset_id: presetId }),
    unrealized_pnl: 0,
    realized_pnl: realizedPnl,
    // Analytics uses entry × quantity as the canonical PositionCost notional.
    // Keep margin_used on the same notional basis for pseudo-position panels.
    margin_used: volumeUsd > 0 ? volumeUsd : Math.abs(entryPrice * quantity),
    fees_paid: Math.abs(fees),
    hold_time: Math.max(0, holdMinutes),
    max_profit: Math.max(0, realizedPnl),
    max_loss: Math.min(0, realizedPnl),
    trailing_enabled: trailingActive === 1,
  }
  return position as import("./trading").TradingPosition
}

function finite(raw: unknown, fallback = 0): number {
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function positive(raw: unknown, fallback = 0): number {
  const value = Math.abs(finite(raw, fallback))
  return Number.isFinite(value) ? value : fallback
}

function normalizeSymbol(raw: unknown): string {
  return String(raw || "").trim().toUpperCase().replace(/[-_]/g, "")
}

function normalizeTimestamp(raw: unknown): number {
  const value = finite(raw)
  if (value <= 0) return 0
  return value < 10_000_000_000 ? value * 1000 : value
}

function firstFinite(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function firstPositive(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

export function normalizeBingXClosedOrder(order: Record<string, any>): TradeHistoryRow | null {
  if (!order || typeof order !== "object") return null
  const status = String(order.status ?? order.orderStatus ?? "").toUpperCase()
  if (!(["FILLED", "CLOSED", "COMPLETED"].includes(status))) return null

  const quantity = positive(order.executedQty ?? order.filledQty ?? order.cumQty ?? order.quantity)
  const exitPrice = firstPositive(order.avgPrice, order.filledPrice, order.price)
  if (quantity <= 0 || exitPrice <= 0) return null

  const side = String(order.side ?? order.orderSide ?? "").toUpperCase()
  if (side !== "BUY" && side !== "SELL") return null
  const positionSide = String(order.positionSide ?? order.position_side ?? "BOTH").toUpperCase()
  const grossPnl = firstFinite(
    order.profit,
    order.realizedProfit,
    order.realizedPnl,
    order.realisedPnl,
    order.pnl,
  )

  let direction: "long" | "short"
  if (positionSide === "LONG") {
    if (side !== "SELL") return null
    direction = "long"
  } else if (positionSide === "SHORT") {
    if (side !== "BUY") return null
    direction = "short"
  } else {
    // In one-way mode there is no direction marker. A realized-profit field is
    // the only reliable proof that this filled order reduced/closed exposure;
    // a zero-PnL BUY/SELL can just as easily be a new entry.
    if (grossPnl === 0) return null
    direction = side === "BUY" ? "short" : "long"
  }

  const entryPrice = firstPositive(
    order.entryPrice,
    order.avgEntryPrice,
    direction === "long"
      ? exitPrice - grossPnl / quantity
      : exitPrice + grossPnl / quantity,
  )
  if (entryPrice <= 0) return null

  const fees = Math.abs(firstFinite(order.commission, order.fee, order.fees, order.tradingFee))
  const realizedPnl = grossPnl - fees
  const volumeUsd = entryPrice * quantity
  const closedAt = normalizeTimestamp(order.updateTime ?? order.time ?? order.timestamp ?? order.transactTime)
  const openedAt = normalizeTimestamp(order.createTime ?? order.openTime)
  const orderId = String(order.orderId ?? order.orderID ?? order.id ?? "").trim()
  const positionId = String(order.positionID ?? order.positionId ?? order.position_id ?? "").trim()

  return {
    id: `exchange:${orderId || `${normalizeSymbol(order.symbol)}:${closedAt}`}`,
    symbol: normalizeSymbol(order.symbol),
    direction,
    entryPrice,
    exitPrice,
    quantity,
    volumeUsd,
    grossPnl,
    fees,
    realizedPnl,
    pnlPct: volumeUsd > 0 ? (realizedPnl / volumeUsd) * 100 : 0,
    openedAt,
    closedAt,
    holdMinutes: openedAt > 0 && closedAt >= openedAt ? (closedAt - openedAt) / 60_000 : 0,
    source: "exchange",
    environment: "exchange",
    orderId: String(order.openOrderId ?? "") || undefined,
    closeOrderId: orderId || undefined,
    positionId: positionId || undefined,
  }
}

function parseStoredValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  if ([
    "fills",
    "exchangeData",
    "blockLegs",
    "dcaLegs",
    "progression",
    "accumulatedSetKeys",
    "manualProtectionOverride",
    "partialOrderExecutions",
    "systemProtectionLegs",
  ].includes(key)) {
    try { return JSON.parse(trimmed) } catch { return key.endsWith("Legs") || key === "fills" ? [] : value }
  }
  return value
}

function normalizeSnapshot(snapshot: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(snapshot || {}).map(([key, value]) => [key, parseStoredValue(key, value)]))
}

export type LocalTradeHistorySnapshotDisposition =
  | "normalized_trade"
  | "excluded_non_trade"
  | "unresolved_trade"

export interface LocalTradeHistorySnapshotClassification {
  disposition: LocalTradeHistorySnapshotDisposition
  reason:
    | "normalized"
    | "non_terminal_status"
    | "duplicate_bookkeeping"
    | "no_executed_quantity"
    | "missing_identity"
    | "missing_entry_price"
    | "missing_exit_and_pnl"
    | "venue_accounting_required"
  row: TradeHistoryRow | null
}

function totalFillQuantity(fills: unknown): number {
  if (!Array.isArray(fills)) return 0
  return fills.reduce((sum: number, fill: any) =>
    sum + (
      positive(fill?.quantity) ||
      positive(fill?.qty) ||
      positive(fill?.executedQty)
    ), 0)
}

function closeOrderIdFromSnapshot(position: Record<string, any>): string {
  const direct = [position.closeOrderId, position.exchangeData?.closeOrderId]
    .map((value) => String(value || "").trim())
    .find(Boolean) || ""
  if (direct) return direct

  const executions = Array.isArray(position.partialOrderExecutions)
    ? [...position.partialOrderExecutions]
    : []
  executions.sort((left, right) =>
    finite(right?.updatedAt ?? right?.timestamp) - finite(left?.updatedAt ?? left?.timestamp),
  )
  const terminal = executions.find((execution) => {
    if (!execution || !String(execution.orderId || "").trim()) return false
    const source = String(execution.source || "").toLowerCase()
    const quantityAfter = Number(execution.positionQuantityAfter)
    return quantityAfter === 0 || /close|stop|take.?profit/.test(source)
  })
  return String(terminal?.orderId || "").trim()
}

function requiresVenueAccounting(input: {
  environment: "exchange" | "simulated"
  entryPrice: number
  exitPrice: number
  openedAt: number
  closedAt: number
}): boolean {
  if (input.environment !== "exchange") return false
  if (!(input.entryPrice > 0) || !(input.exitPrice > 0)) return false
  if (!(input.openedAt > 0) || input.closedAt < input.openedAt) return false

  // A >=50% entry/exit displacement inside one day is not discarded as an
  // impossible market event. It is deliberately treated as requiring venue
  // accounting because legacy BingX minimum-size retries sometimes persisted
  // quote/notional-like values as fill prices. Those rows produced fictitious
  // six-figure PnL despite venue notionals near a few USDT. A matching close
  // order resolves the row exactly; until then the dashboard reports partial
  // coverage instead of presenting invented accounting.
  const priceRatio = Math.max(input.entryPrice, input.exitPrice) /
    Math.max(Math.min(input.entryPrice, input.exitPrice), Number.EPSILON)
  const holdingMs = input.closedAt - input.openedAt
  return priceRatio >= 1.5 && holdingMs <= 24 * 60 * 60 * 1000
}

/**
 * Classify one durable lifecycle snapshot without mistaking rejected/error
 * attempts for missing trades. A terminal row with no executed quantity is an
 * explicit non-trade. Once execution quantity and entry price exist, missing
 * accounting fields are unresolved unless stored realised P&L can recover the
 * legacy exit price exactly.
 */
export function classifyLocalTradeHistorySnapshot(
  raw: Record<string, any>,
): LocalTradeHistorySnapshotClassification {
  const position = normalizeSnapshot(raw)
  const status = String(position.status || "").toLowerCase()
  if (!(["closed", "cancelled", "canceled"].includes(status))) {
    return { disposition: "excluded_non_trade", reason: "non_terminal_status", row: null }
  }
  const closeReason = String(position.closeReason ?? position.statusReason ?? "")
  if (/duplicate_slot|duplicate.*prun|bookkeeping/i.test(closeReason)) {
    return { disposition: "excluded_non_trade", reason: "duplicate_bookkeeping", row: null }
  }

  if (!position.id || !normalizeSymbol(position.symbol)) {
    return { disposition: "unresolved_trade", reason: "missing_identity", row: null }
  }

  const quantity =
    positive(position.executedQuantity) ||
    positive(position.filledQuantity) ||
    positive(position.quantity) ||
    positive(position.size) ||
    totalFillQuantity(position.fills)
  if (quantity <= 0) {
    return { disposition: "excluded_non_trade", reason: "no_executed_quantity", row: null }
  }
  const entryPrice = firstPositive(
    position.averageExecutionPrice,
    position.entryPrice,
    position.entry_price,
    position.fills?.[0]?.price,
  )
  if (entryPrice <= 0) {
    return { disposition: "unresolved_trade", reason: "missing_entry_price", row: null }
  }

  const direction: "long" | "short" = String(position.direction ?? position.side).toLowerCase().includes("short")
    ? "short"
    : "long"
  const hasStoredPnl = [position.grossPnl, position.realizedPnL, position.realizedPnl, position.pnl]
    .some((value) => value !== undefined && value !== null && value !== "")
  const storedPnl = firstFinite(position.grossPnl, position.realizedPnL, position.realizedPnl, position.pnl)
  const recoveredExitPrice = hasStoredPnl
    ? direction === "short"
      ? entryPrice - storedPnl / quantity
      : entryPrice + storedPnl / quantity
    : 0
  const exitPrice = firstPositive(
    position.closePrice,
    position.exitPrice,
    position.currentPrice,
    position.current_price,
    recoveredExitPrice,
  )
  if (exitPrice <= 0) {
    return { disposition: "unresolved_trade", reason: "missing_exit_and_pnl", row: null }
  }

  const derivedGross = direction === "short"
    ? (entryPrice - exitPrice) * quantity
    : (exitPrice - entryPrice) * quantity
  const fillFees = Array.isArray(position.fills)
    ? position.fills.reduce((sum: number, fill: any) => sum + Math.abs(finite(fill?.fee)), 0)
    : 0
  const fees = Math.abs(firstFinite(position.fees, position.totalFees, fillFees))
  const grossPnl = hasStoredPnl ? storedPnl : derivedGross
  const realizedPnl = position.grossPnl !== undefined ? grossPnl - fees : grossPnl
  const volumeUsd = firstPositive(position.volumeUsd, entryPrice * quantity)
  const openedAt = normalizeTimestamp(position.createdAt ?? position.openedAt ?? position.timestamp)
  const closedAt = normalizeTimestamp(position.closedAt ?? position.closeTimestamp ?? position.updatedAt)
  const exchangeData = position.exchangeData && typeof position.exchangeData === "object" ? position.exchangeData : {}
  const manualProtection = position.manualProtectionOverride && typeof position.manualProtectionOverride === "object"
    ? position.manualProtectionOverride
    : null
  const manualHasStop = manualProtection && Object.prototype.hasOwnProperty.call(manualProtection, "stopLossPrice")
  const manualHasTarget = manualProtection && Object.prototype.hasOwnProperty.call(manualProtection, "takeProfitPrice")
  const positionId = String(
    exchangeData.exchangePositionId ?? exchangeData.positionId ?? position.exchangePositionId ?? "",
  ).trim()
  const executionMode = String(position.executionMode || "").trim().toLowerCase()
  const environment: "exchange" | "simulated" =
    String(position.environment || "").trim().toLowerCase() === "simulated" ||
    executionMode === "simulation" ||
    position.simulated === true ||
    position.simulated === "1" ||
    /paper|simulat|live_trade disabled/i.test(
      String(position.statusReason || position.closeReason || ""),
    )
      ? "simulated"
      : "exchange"
  const closeOrderId = closeOrderIdFromSnapshot(position)
  const rawIntent = String(position.executionIntent || "").trim().toLowerCase()
  const executionIntent =
    rawIntent === "main" || rawIntent === "preset" || rawIntent === "signal"
      ? rawIntent
      : undefined

  const row: TradeHistoryRow = {
    id: String(position.id),
    symbol: normalizeSymbol(position.symbol),
    direction,
    entryPrice,
    exitPrice,
    quantity,
    volumeUsd,
    grossPnl,
    fees,
    realizedPnl,
    pnlPct: volumeUsd > 0 ? (realizedPnl / volumeUsd) * 100 : 0,
    openedAt,
    closedAt,
    holdMinutes: openedAt > 0 && closedAt >= openedAt ? (closedAt - openedAt) / 60_000 : 0,
    source: "local",
    environment,
    executionIntent,
    orderId: String(position.orderId ?? exchangeData.orderId ?? "") || undefined,
    closeOrderId: closeOrderId || undefined,
    positionId: positionId || undefined,
    setKey: position.setKey,
    parentSetKey: position.parentSetKey,
    setVariant: position.setVariant,
    indicationType: position.indicationType,
    presetId: position.presetId,
    leverage: firstPositive(position.leverage) || undefined,
    marginType: String(position.marginType || "") || undefined,
    stopLossPrice: (manualHasStop
      ? firstPositive(manualProtection.stopLossPrice)
      : firstPositive(position.stopLossPrice)) || undefined,
    takeProfitPrice: (manualHasTarget
      ? firstPositive(manualProtection.takeProfitPrice)
      : firstPositive(position.takeProfitPrice)) || undefined,
    trailingActive: manualProtection?.trailingEnabled === true || position.trailingActive === true || position.trailingActive === "true" || position.trailingActive === "1",
    trailingStopPrice: firstPositive(position.trailingStopPrice) || undefined,
    blockCount: firstPositive(position.blockCount) || undefined,
    dcaStep: firstPositive(position.dcaStep) || undefined,
    executionMode: String(position.executionMode || "") || undefined,
    closeReason: closeReason || undefined,
  }
  if (requiresVenueAccounting({ environment, entryPrice, exitPrice, openedAt, closedAt })) {
    row.accountingQuality = "exchange_required"
    return {
      disposition: "unresolved_trade",
      reason: "venue_accounting_required",
      row,
    }
  }
  return { disposition: "normalized_trade", reason: "normalized", row }
}

export function normalizeLocalTradeHistoryRow(raw: Record<string, any>): TradeHistoryRow | null {
  const classification = classifyLocalTradeHistorySnapshot(raw)
  return classification.disposition === "normalized_trade" ? classification.row : null
}

function rowMatchScore(exchange: TradeHistoryRow, local: TradeHistoryRow): number {
  if (exchange.closeOrderId && local.closeOrderId && exchange.closeOrderId === local.closeOrderId) return 0
  if (exchange.symbol !== local.symbol || exchange.direction !== local.direction) return Number.POSITIVE_INFINITY
  if (exchange.closedAt <= 0 || local.closedAt <= 0) return Number.POSITIVE_INFINITY

  const closedDelta = Math.abs(exchange.closedAt - local.closedAt)
  if (closedDelta > 5 * 60_000) return Number.POSITIVE_INFINITY
  // Venue position identifiers may be reused for a symbol/side after a close.
  // They are strong lineage only inside the same bounded close-time window.
  if (exchange.positionId && local.positionId && exchange.positionId === local.positionId) return closedDelta

  // Several independently tracked slots may close the same symbol within one
  // progression cycle. Time alone can attach venue PnL to the wrong strategy
  // lineage, so anonymous fallback matches also require compatible fill size
  // and close price. Exact exchange IDs remain authoritative above.
  const quantityScale = Math.max(exchange.quantity, local.quantity, Number.EPSILON)
  const quantityDeltaRatio = Math.abs(exchange.quantity - local.quantity) / quantityScale
  if (quantityDeltaRatio > 0.005) return Number.POSITIVE_INFINITY
  const priceScale = Math.max(exchange.exitPrice, local.exitPrice, Number.EPSILON)
  const priceDeltaRatio = Math.abs(exchange.exitPrice - local.exitPrice) / priceScale
  if (priceDeltaRatio > 0.005) return Number.POSITIVE_INFINITY

  return closedDelta + quantityDeltaRatio * 60_000 + priceDeltaRatio * 60_000
}

export function mergeTradeHistory(
  exchangeRows: TradeHistoryRow[],
  localRows: TradeHistoryRow[],
  limit = 0,
): TradeHistoryRow[] {
  const remainingLocal = [...localRows]
  const merged: TradeHistoryRow[] = []
  for (const exchange of exchangeRows) {
    let index = -1
    let bestScore = Number.POSITIVE_INFINITY
    for (let candidateIndex = 0; candidateIndex < remainingLocal.length; candidateIndex++) {
      const score = rowMatchScore(exchange, remainingLocal[candidateIndex])
      if (score < bestScore) {
        bestScore = score
        index = candidateIndex
      }
    }
    if (index < 0) {
      merged.push(exchange)
      continue
    }
    const local = remainingLocal.splice(index, 1)[0]
    const venueAccountingRequired = local.accountingQuality === "exchange_required"
    const accountingVolumeUsd = venueAccountingRequired
      ? exchange.volumeUsd
      : local.volumeUsd
    const accountingQuantity = venueAccountingRequired
      ? exchange.quantity
      : local.quantity
    const reconciledClosedAt = Math.max(exchange.closedAt, local.closedAt)
    merged.push({
      ...local,
      entryPrice: venueAccountingRequired ? exchange.entryPrice : local.entryPrice,
      quantity: accountingQuantity,
      grossPnl: exchange.grossPnl,
      fees: exchange.fees,
      realizedPnl: exchange.realizedPnl,
      volumeUsd: accountingVolumeUsd,
      pnlPct: accountingVolumeUsd > 0
        ? (exchange.realizedPnl / accountingVolumeUsd) * 100
        : exchange.pnlPct,
      exitPrice: exchange.exitPrice || local.exitPrice,
      closedAt: reconciledClosedAt,
      holdMinutes: local.openedAt > 0 && reconciledClosedAt >= local.openedAt
        ? (reconciledClosedAt - local.openedAt) / 60_000
        : local.holdMinutes,
      closeOrderId: exchange.closeOrderId || local.closeOrderId,
      positionId: exchange.positionId || local.positionId,
      source: "exchange",
      environment: "exchange",
      accountingQuality: "local",
    })
  }
  merged.push(...remainingLocal)

  const deduped = new Map<string, TradeHistoryRow>()
  for (const row of merged) {
    const key = row.closeOrderId ? `close:${row.closeOrderId}` : `id:${row.id}`
    const previous = deduped.get(key)
    if (!previous || row.closedAt >= previous.closedAt) deduped.set(key, row)
  }
  const ordered = [...deduped.values()]
    .sort((left, right) => right.closedAt - left.closedAt)
  const requested = Math.floor(Number(limit) || 0)
  return requested > 0 ? ordered.slice(0, requested) : ordered
}

export function selectHistoryReconciliationSymbols(input: {
  candidates: readonly string[]
  priority: readonly string[]
  refreshedAt: Record<string, number>
  cursor: number
  now: number
  force: boolean
  limit?: number
  intervalMs?: number
}): { symbols: string[]; nextCursor: number } {
  const candidates = [...new Set(input.candidates.map(String).filter(Boolean))]
  if (candidates.length === 0) return { symbols: [], nextCursor: 0 }

  const limit = Math.max(1, Math.floor(Number(input.limit) || 4))
  const intervalMs = Math.max(0, Number(input.intervalMs) || 0)
  const priority = new Set(input.priority.map(String).filter(Boolean))
  const start = Math.max(0, Math.floor(input.cursor || 0)) % candidates.length
  const rank = (symbol: string) => {
    const index = candidates.indexOf(symbol)
    return (index - start + candidates.length) % candidates.length
  }
  const isDue = (symbol: string) => input.force ||
    input.now - (Number(input.refreshedAt[symbol]) || 0) >= intervalMs

  // Oldest priority symbols are selected first. This preserves prompt
  // reconciliation for app-managed closes while preventing the first four
  // symbols from starving every other candidate when every local row is a
  // priority hint. The round-robin rank makes equal timestamps deterministic.
  const duePriority = candidates
    .filter((symbol) => priority.has(symbol) && isDue(symbol))
    .sort((left, right) =>
      (Number(input.refreshedAt[left]) || 0) - (Number(input.refreshedAt[right]) || 0) ||
      rank(left) - rank(right),
    )
  const dueRegular = candidates
    .filter((symbol) => !priority.has(symbol) && isDue(symbol))
    .sort((left, right) => rank(left) - rank(right))
  const symbols = [...duePriority, ...dueRegular].slice(0, limit)
  const lastRank = symbols.reduce((maximum, symbol) => Math.max(maximum, rank(symbol)), -1)
  return {
    symbols,
    nextCursor: (start + Math.max(lastRank + 1, 1)) % candidates.length,
  }
}

export function summarizeTradeHistory(rows: TradeHistoryRow[]) {
  let wins = 0, losses = 0, flat = 0, netPnl = 0, fees = 0, volumeUsd = 0
  for (const row of rows) {
    if (row.realizedPnl > 0) wins++
    else if (row.realizedPnl < 0) losses++
    else flat++
    netPnl += row.realizedPnl
    fees += Math.abs(row.fees)
    volumeUsd += row.volumeUsd
  }
  const decided = wins + losses
  return {
    total: rows.length,
    wins,
    losses,
    flat,
    winRate: decided > 0 ? (wins / decided) * 100 : 0,
    netPnl,
    fees,
    volumeUsd,
  }
}

export async function loadClosedPositionSnapshots(
  client: any,
  connectionId: string,
  limit = TRADE_HISTORY_PAGE_SIZE,
): Promise<Record<string, any>[]> {
  return (await loadClosedPositionSnapshotPage(client, connectionId, {
    offset: 0,
    limit,
  })).snapshots
}

async function loadPositionSnapshotsByIds(
  client: any,
  connectionId: string,
  rawIds: readonly string[],
): Promise<Record<string, any>[]> {
  const ids = [...new Set(rawIds.map(String).filter(Boolean))]
  const snapshots: Record<string, any>[] = []
  for (let batchOffset = 0; batchOffset < ids.length; batchOffset += 250) {
    const batch = ids.slice(batchOffset, batchOffset + 250)
    const jsonValues = await client
      .mget(...batch.map((id) => `live:position:${id}`))
      .catch(() => batch.map(() => null)) as Array<string | null>
    const parsedBatch = jsonValues.map((raw) => {
      if (!raw) return null
      try {
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, any>
          : null
      } catch { return null }
    })
    const missingIndices = parsedBatch
      .map((parsed, index) => parsed ? -1 : index)
      .filter((index) => index >= 0)
    const hashes = await Promise.all(missingIndices.map((index) =>
      client.hgetall(`live_positions:${connectionId}:${batch[index]}`).catch(() => null),
    )) as Array<Record<string, any> | null>
    for (let fallbackIndex = 0; fallbackIndex < missingIndices.length; fallbackIndex++) {
      const index = missingIndices[fallbackIndex]
      const hash = hashes[fallbackIndex]
      if (hash && Object.keys(hash).length > 0) parsedBatch[index] = normalizeSnapshot(hash)
    }
    for (const parsed of parsedBatch) {
      if (parsed) snapshots.push(parsed)
    }
  }
  return snapshots
}

/**
 * Capture the durable close index in one LRANGE before resolving snapshots.
 * This gives Statistics a stable, complete ID boundary even if a new close is
 * prepended while the corresponding JSON records are being read in batches.
 */
export async function loadClosedPositionSnapshotArchive(
  client: any,
  connectionId: string,
): Promise<{
  snapshots: Record<string, any>[]
  indexed: number
  uniqueIds: number
}> {
  const indexKey = `live:positions:${connectionId}:closed`
  const indexedRows = await client.lrange(indexKey, 0, -1).catch(() => []) as string[]
  const ids = [...new Set(indexedRows.map(String).filter(Boolean))]
  return {
    snapshots: await loadPositionSnapshotsByIds(client, connectionId, ids),
    indexed: indexedRows.length,
    uniqueIds: ids.length,
  }
}

export async function loadClosedPositionSnapshotPage(
  client: any,
  connectionId: string,
  options: { offset?: number; limit?: number } = {},
): Promise<{
  snapshots: Record<string, any>[]
  indexed: number
  offset: number
  nextOffset: number
  totalIndexed: number
  hasMore: boolean
}> {
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0))
  const limit = Math.max(
    1,
    Math.min(
      MAX_TRADE_HISTORY_PAGE_SIZE,
      Math.floor(Number(options.limit) || TRADE_HISTORY_PAGE_SIZE),
    ),
  )
  const indexKey = `live:positions:${connectionId}:closed`
  const [indexedRows, totalRaw] = await Promise.all([
    client.lrange(indexKey, offset, offset + limit - 1).catch(() => []),
    client.llen(indexKey).catch(() => 0),
  ])
  const indexed = (indexedRows || []) as string[]
  const totalIndexed = Number(totalRaw) || 0
  const snapshots = await loadPositionSnapshotsByIds(client, connectionId, indexed)
  const nextOffset = offset + indexed.length
  return {
    snapshots,
    indexed: indexed.length,
    offset,
    nextOffset,
    totalIndexed,
    hasMore: nextOffset < totalIndexed,
  }
}
