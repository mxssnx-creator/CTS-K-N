export const MAX_TRADE_HISTORY_RECORDS = 500

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
  orderId?: string
  closeOrderId?: string
  positionId?: string
  setKey?: string
  parentSetKey?: string
  setVariant?: string
  closeReason?: string
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
    orderId: String(order.openOrderId ?? "") || undefined,
    closeOrderId: orderId || undefined,
    positionId: positionId || undefined,
  }
}

function parseStoredValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  if (["fills", "exchangeData", "blockLegs", "dcaLegs", "progression", "accumulatedSetKeys"].includes(key)) {
    try { return JSON.parse(trimmed) } catch { return key.endsWith("Legs") || key === "fills" ? [] : value }
  }
  return value
}

function normalizeSnapshot(snapshot: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(snapshot || {}).map(([key, value]) => [key, parseStoredValue(key, value)]))
}

export function normalizeLocalTradeHistoryRow(raw: Record<string, any>): TradeHistoryRow | null {
  const position = normalizeSnapshot(raw)
  const status = String(position.status || "").toLowerCase()
  if (!(["closed", "cancelled", "canceled"].includes(status))) return null
  const closeReason = String(position.closeReason ?? position.statusReason ?? "")
  if (/duplicate_slot|duplicate.*prun|bookkeeping/i.test(closeReason)) return null

  const quantity = positive(
    position.executedQuantity ?? position.filledQuantity ?? position.quantity ?? position.size,
  )
  const entryPrice = firstPositive(
    position.averageExecutionPrice,
    position.entryPrice,
    position.entry_price,
    position.fills?.[0]?.price,
  )
  const exitPrice = firstPositive(position.closePrice, position.exitPrice, position.currentPrice, position.current_price)
  if (!position.id || !normalizeSymbol(position.symbol) || quantity <= 0 || entryPrice <= 0 || exitPrice <= 0) return null

  const direction: "long" | "short" = String(position.direction ?? position.side).toLowerCase().includes("short")
    ? "short"
    : "long"
  const derivedGross = direction === "short"
    ? (entryPrice - exitPrice) * quantity
    : (exitPrice - entryPrice) * quantity
  const fillFees = Array.isArray(position.fills)
    ? position.fills.reduce((sum: number, fill: any) => sum + Math.abs(finite(fill?.fee)), 0)
    : 0
  const fees = Math.abs(firstFinite(position.fees, position.totalFees, fillFees))
  const hasStoredPnl = [position.grossPnl, position.realizedPnL, position.realizedPnl, position.pnl]
    .some((value) => value !== undefined && value !== null && value !== "")
  const storedPnl = firstFinite(position.grossPnl, position.realizedPnL, position.realizedPnl, position.pnl)
  const grossPnl = hasStoredPnl ? storedPnl : derivedGross
  const realizedPnl = position.grossPnl !== undefined ? grossPnl - fees : grossPnl
  const volumeUsd = firstPositive(position.volumeUsd, entryPrice * quantity)
  const openedAt = normalizeTimestamp(position.createdAt ?? position.openedAt ?? position.timestamp)
  const closedAt = normalizeTimestamp(position.closedAt ?? position.closeTimestamp ?? position.updatedAt)
  const exchangeData = position.exchangeData && typeof position.exchangeData === "object" ? position.exchangeData : {}
  const positionId = String(
    exchangeData.exchangePositionId ?? exchangeData.positionId ?? position.exchangePositionId ?? "",
  ).trim()

  return {
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
    orderId: String(position.orderId ?? exchangeData.orderId ?? "") || undefined,
    closeOrderId: String(position.closeOrderId ?? exchangeData.closeOrderId ?? "") || undefined,
    positionId: positionId || undefined,
    setKey: position.setKey,
    parentSetKey: position.parentSetKey,
    setVariant: position.setVariant,
    closeReason: closeReason || undefined,
  }
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
  limit = MAX_TRADE_HISTORY_RECORDS,
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
    merged.push({
      ...local,
      grossPnl: exchange.grossPnl,
      fees: exchange.fees,
      realizedPnl: exchange.realizedPnl,
      pnlPct: local.volumeUsd > 0 ? (exchange.realizedPnl / local.volumeUsd) * 100 : exchange.pnlPct,
      exitPrice: exchange.exitPrice || local.exitPrice,
      closedAt: Math.max(exchange.closedAt, local.closedAt),
      closeOrderId: exchange.closeOrderId || local.closeOrderId,
      positionId: exchange.positionId || local.positionId,
      source: "exchange",
    })
  }
  merged.push(...remainingLocal)

  const deduped = new Map<string, TradeHistoryRow>()
  for (const row of merged) {
    const key = row.closeOrderId ? `close:${row.closeOrderId}` : `id:${row.id}`
    const previous = deduped.get(key)
    if (!previous || row.closedAt >= previous.closedAt) deduped.set(key, row)
  }
  return [...deduped.values()]
    .sort((left, right) => right.closedAt - left.closedAt)
    .slice(0, Math.max(1, Math.min(MAX_TRADE_HISTORY_RECORDS, Math.floor(limit) || MAX_TRADE_HISTORY_RECORDS)))
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
  limit = MAX_TRADE_HISTORY_RECORDS,
): Promise<Record<string, any>[]> {
  const bounded = Math.max(1, Math.min(MAX_TRADE_HISTORY_RECORDS, Math.floor(limit) || MAX_TRADE_HISTORY_RECORDS))
  const indexed = ((await client.lrange(`live:positions:${connectionId}:closed`, 0, bounded - 1).catch(() => [])) || []) as string[]
  const ids = [...new Set(indexed.map(String).filter(Boolean))].slice(0, bounded)
  if (ids.length === 0) return []
  const jsonValues: Array<string | null> = await client.mget(...ids.map((id) => `live:position:${id}`)).catch(() => ids.map(() => null))
  const snapshots: Record<string, any>[] = []
  for (let index = 0; index < ids.length; index++) {
    let parsed: Record<string, any> | null = null
    const raw = jsonValues[index]
    if (raw) {
      try { parsed = JSON.parse(raw) } catch { /* hash fallback */ }
    }
    if (!parsed) {
      const hash = await client.hgetall(`live_positions:${connectionId}:${ids[index]}`).catch(() => null)
      if (hash && Object.keys(hash).length > 0) parsed = normalizeSnapshot(hash)
    }
    if (parsed) snapshots.push(parsed)
  }
  return snapshots
}
