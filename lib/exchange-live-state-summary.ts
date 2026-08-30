import { exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { getConnection } from "@/lib/redis-db"
import { hasConnectionCredentials } from "@/lib/connection-state-utils"
import {
  getClosedLivePositionReadModelsStrict,
  getOpenLivePositionReadModelsStrict,
} from "@/lib/live-position-read-model"
import { resolvePositionNotionalUsd } from "@/lib/live-position-pnl"
import { isLiveOpenStatus } from "@/lib/live-position-status"
import { isRealExchangePosition } from "@/lib/live-position-source"

export type ExchangeSnapshotStatus = {
  available: boolean
  fetchedAt: number
  error: string | null
}

export type ExchangeSymbolPositionSummary = {
  symbol: string
  positions: number
  long: number
  short: number
  quantity: number
  notionalUsd: number
  unrealizedPnl: number
}

export type ExchangeSymbolOrderSummary = {
  symbol: string
  orders: number
  entryOrders: number
  controlOrders: number
}

export interface ExchangeLiveStateSummary {
  connectionId: string
  source: "exchange-api" | "exchange-api-partial" | "unavailable" | "simulated"
  complete: boolean
  positionsStatus: ExchangeSnapshotStatus
  ordersStatus: ExchangeSnapshotStatus
  openPositions: number
  openPositionSymbols: number
  longPositions: number
  shortPositions: number
  positionQuantity: number
  positionNotionalUsd: number
  unrealizedPnl: number
  positionsBySymbol: ExchangeSymbolPositionSummary[]
  openOrders: number
  openOrderSymbols: number
  entryOrders: number
  controlOrders: number
  ordersBySymbol: ExchangeSymbolOrderSummary[]
  tracking: {
    trackedOpenPositions: number
    trackedPositionSlots: number
    trackedOrderIdentifiers: number
    venuePositionsSeen: number
    venuePositionsExcluded: number
    venueOrdersSeen: number
    venueOrdersExcluded: number
    attributedPositionQuantity: number
    venuePositionQuantity: number
    attributionComplete: boolean
  }
  generatedAt: number
}

type TrackedPositionSlot = {
  symbol: string
  direction: "long" | "short"
  quantity: number
  positionIds: Set<string>
  setKeys: Set<string>
}

export type SystemExchangeTrackingScope = {
  connectionId: string
  positionsBySlot: Map<string, TrackedPositionSlot>
  orderIdentifiers: Set<string>
  clientOrderPrefix: string
  trackedOpenPositions: number
}

export type SystemAttributedExchangePosition = {
  row: Record<string, any>
  symbol: string
  direction: "long" | "short"
  venueQuantity: number
  quantity: number
  attributionRatio: number
}

type Cached = { expiresAt: number; value: ExchangeLiveStateSummary }

const SNAPSHOT_FRESH_MS = 15_000
const SNAPSHOT_FAILURE_FRESH_MS = 3_000
const SNAPSHOT_TIMEOUT_MS = 30_000
const cache = new Map<string, Cached>()
const inFlight = new Map<string, Promise<ExchangeLiveStateSummary>>()

function finite(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizedSymbol(value: unknown): string {
  return String(value || "").trim().toUpperCase().replace(/[-/_:\s]/g, "")
}

function normalizedDirection(row: Record<string, any>, rawQuantity = 0): "long" | "short" | null {
  const rawSide = String(row.positionSide ?? row.position_side ?? row.direction ?? row.side ?? "")
    .trim()
    .toLowerCase()
  if (rawSide.includes("short") || rawSide === "sell" || (rawSide === "both" && rawQuantity < 0)) {
    return "short"
  }
  if (rawSide.includes("long") || rawSide === "buy" || rawQuantity > 0) return "long"
  return null
}

function slotKey(symbol: string, direction: "long" | "short"): string {
  return `${symbol}:${direction}`
}

const TRACKED_ORDER_ID_KEYS = new Set([
  "orderid",
  "clientorderid",
  "exchangeorderid",
  "stoplossorderid",
  "takeprofitorderid",
  "controlorderids",
  "entrysettlementorderids",
  "settledorderids",
])

function collectTrackedOrderIdentifiers(
  value: unknown,
  target: Set<string>,
  parentKey = "",
  depth = 0,
): void {
  if (depth > 8 || value === null || value === undefined) return
  if (typeof value !== "object") {
    if (!TRACKED_ORDER_ID_KEYS.has(parentKey.toLowerCase())) return
    const id = String(value).trim()
    if (id) target.add(id)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTrackedOrderIdentifiers(entry, target, parentKey, depth + 1)
    return
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    collectTrackedOrderIdentifiers(nested, target, key, depth + 1)
  }
}

export function buildSystemExchangeTrackingScope(
  connectionId: string,
  positions: readonly Record<string, any>[],
): SystemExchangeTrackingScope {
  const positionsBySlot = new Map<string, TrackedPositionSlot>()
  const orderIdentifiers = new Set<string>()
  let trackedOpenPositions = 0
  for (const position of positions) {
    if (!isRealExchangePosition(position)) continue
    // Closed lifecycle IDs remain authoritative for detecting orphaned CTS
    // control orders that are still open at the venue after a close/restart.
    collectTrackedOrderIdentifiers(position, orderIdentifiers)
    if (!isLiveOpenStatus(position.status)) continue
    const symbol = normalizedSymbol(position.symbol)
    const direction = normalizedDirection(position)
    const quantity = Math.abs(finite(
      position.executedQuantity ??
      position.quantity ??
      position.exchangeData?.quantity ??
      position.exchangeData?.positionAmt,
    ))
    if (!symbol || !direction || !(quantity > 0)) continue
    trackedOpenPositions++
    const key = slotKey(symbol, direction)
    const current = positionsBySlot.get(key) || {
      symbol,
      direction,
      quantity: 0,
      positionIds: new Set<string>(),
      setKeys: new Set<string>(),
    }
    current.quantity += quantity
    const positionId = String(position.id || "").trim()
    const setKey = String(position.setKey || "").trim()
    if (positionId) current.positionIds.add(positionId)
    if (setKey) current.setKeys.add(setKey)
    positionsBySlot.set(key, current)
  }
  const connectionToken = String(connectionId || "x").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)
  return {
    connectionId,
    positionsBySlot,
    orderIdentifiers,
    clientOrderPrefix: `cts${connectionToken}`.toLowerCase(),
    trackedOpenPositions,
  }
}

function venueOrderIdentifiers(row: Record<string, any>): string[] {
  return [
    row.orderId,
    row.orderID,
    row.id,
    row.ordId,
    row.clientOrderId,
    row.clientOrderID,
    row.client_order_id,
    row.clOrdId,
    row.orderLinkId,
    row.customOrderId,
    row.custom_order_id,
  ].map((value) => String(value ?? "").trim()).filter(Boolean)
}

export function isSystemTrackedExchangeOrder(
  order: Record<string, any>,
  scope: SystemExchangeTrackingScope,
): boolean {
  const identifiers = venueOrderIdentifiers(order)
  return identifiers.some((identifier) =>
    scope.orderIdentifiers.has(identifier) ||
    identifier.toLowerCase().startsWith(scope.clientOrderPrefix),
  )
}

export function attributeSystemTrackedExchangePositions(
  rows: readonly Record<string, any>[],
  trackingScope?: SystemExchangeTrackingScope,
): SystemAttributedExchangePosition[] {
  const attributed: SystemAttributedExchangePosition[] = []
  for (const row of rows) {
    const rawQuantity = finite(
      row.positionAmt ?? row.contracts ?? row.positionSize ?? row.size ?? row.quantity ?? row.qty,
    )
    const venueQuantity = Math.abs(rawQuantity)
    const symbol = normalizedSymbol(row.symbol ?? row.contract ?? row.instrumentId ?? row.instId)
    if (!symbol || !(venueQuantity > 0)) continue
    const direction = normalizedDirection(row, rawQuantity)
    if (!direction) continue
    const trackedQuantity = trackingScope?.positionsBySlot.get(slotKey(symbol, direction))?.quantity
    const quantity = trackingScope
      ? Math.min(venueQuantity, Math.max(0, finite(trackedQuantity)))
      : venueQuantity
    if (!(quantity > 0)) continue
    attributed.push({
      row,
      symbol,
      direction,
      venueQuantity,
      quantity,
      attributionRatio: Math.min(1, quantity / venueQuantity),
    })
  }
  return attributed
}

function truthy(value: unknown): boolean {
  if (value === true || value === 1) return true
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase())
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_timeout`)), SNAPSHOT_TIMEOUT_MS)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function connectorStatus(
  connector: any,
  method: "getLastPositionsSnapshotStatus" | "getLastOpenOrdersSnapshotStatus",
  fallbackAt: number,
): ExchangeSnapshotStatus {
  if (typeof connector?.[method] !== "function") {
    return { available: true, fetchedAt: fallbackAt, error: null }
  }
  const status = connector[method]() || {}
  const ok = status.ok === true
  const error = String(status.error || "").trim()
  return {
    available: ok,
    fetchedAt: finite(status.at) || fallbackAt,
    error: ok ? null : (error || "exchange_snapshot_failed"),
  }
}

export function isExchangeControlOrder(order: Record<string, any>): boolean {
  const type = String(order.type ?? order.orderType ?? order.order_type ?? "").toUpperCase()
  return (
    truthy(order.reduceOnly ?? order.reduce_only ?? order.closePosition ?? order.isReduceOnly) ||
    type.includes("STOP") ||
    type.includes("TAKE_PROFIT") ||
    type.includes("TRAILING") ||
    type.includes("TRIGGER")
  )
}

export function summarizeExchangePositions(
  rows: readonly Record<string, any>[],
  trackingScope?: SystemExchangeTrackingScope,
): Pick<
  ExchangeLiveStateSummary,
  | "openPositions"
  | "openPositionSymbols"
  | "longPositions"
  | "shortPositions"
  | "positionQuantity"
  | "positionNotionalUsd"
  | "unrealizedPnl"
  | "positionsBySymbol"
> {
  const bySymbol = new Map<string, ExchangeSymbolPositionSummary>()
  for (const attributed of attributeSystemTrackedExchangePositions(rows, trackingScope)) {
    const { row, symbol, direction, quantity, attributionRatio } = attributed
    const markPrice = finite(row.markPrice ?? row.mark_price ?? row.currentPrice ?? row.current_price)
    const entryPrice = finite(row.entryPrice ?? row.entry_price ?? row.avgPrice ?? row.averagePrice)
    const notionalUsd = resolvePositionNotionalUsd(
      {
        ...row,
        symbol: row.symbol ?? row.contract ?? row.instrumentId ?? row.instId ?? symbol,
        marketType: row.marketType ?? row.market_type,
        status: row.status ?? "open",
        executedQuantity: quantity,
      },
      quantity,
      markPrice > 0 ? markPrice : entryPrice,
    )
    const unrealizedPnl = finite(
      row.unrealizedPnl ?? row.unrealizedPnL ?? row.unrealizedProfit ?? row.unrealized_pnl,
    ) * attributionRatio
    const current = bySymbol.get(symbol) || {
      symbol,
      positions: 0,
      long: 0,
      short: 0,
      quantity: 0,
      notionalUsd: 0,
      unrealizedPnl: 0,
    }
    current.positions++
    current[direction]++
    current.quantity += quantity
    current.notionalUsd += notionalUsd
    current.unrealizedPnl += unrealizedPnl
    bySymbol.set(symbol, current)
  }
  const positionsBySymbol = [...bySymbol.values()]
    .map((row) => ({
      ...row,
      quantity: Number(row.quantity.toFixed(12)),
      notionalUsd: Number(row.notionalUsd.toFixed(2)),
      unrealizedPnl: Number(row.unrealizedPnl.toFixed(8)),
    }))
    .sort((left, right) => right.positions - left.positions || left.symbol.localeCompare(right.symbol))
  return {
    openPositions: positionsBySymbol.reduce((sum, row) => sum + row.positions, 0),
    openPositionSymbols: positionsBySymbol.length,
    longPositions: positionsBySymbol.reduce((sum, row) => sum + row.long, 0),
    shortPositions: positionsBySymbol.reduce((sum, row) => sum + row.short, 0),
    positionQuantity: Number(positionsBySymbol.reduce((sum, row) => sum + row.quantity, 0).toFixed(12)),
    positionNotionalUsd: Number(positionsBySymbol.reduce((sum, row) => sum + row.notionalUsd, 0).toFixed(2)),
    unrealizedPnl: Number(positionsBySymbol.reduce((sum, row) => sum + row.unrealizedPnl, 0).toFixed(8)),
    positionsBySymbol,
  }
}

export function summarizeExchangeOrders(
  rows: readonly Record<string, any>[],
  trackingScope?: SystemExchangeTrackingScope,
): Pick<
  ExchangeLiveStateSummary,
  "openOrders" | "openOrderSymbols" | "entryOrders" | "controlOrders" | "ordersBySymbol"
> {
  const bySymbol = new Map<string, ExchangeSymbolOrderSummary>()
  for (const row of rows) {
    if (trackingScope && !isSystemTrackedExchangeOrder(row, trackingScope)) continue
    const symbol = normalizedSymbol(row.symbol ?? row.contract ?? row.instrumentId ?? row.instId)
    if (!symbol) continue
    const control = isExchangeControlOrder(row)
    const current = bySymbol.get(symbol) || { symbol, orders: 0, entryOrders: 0, controlOrders: 0 }
    current.orders++
    if (control) current.controlOrders++
    else current.entryOrders++
    bySymbol.set(symbol, current)
  }
  const ordersBySymbol = [...bySymbol.values()]
    .sort((left, right) => right.orders - left.orders || left.symbol.localeCompare(right.symbol))
  return {
    openOrders: ordersBySymbol.reduce((sum, row) => sum + row.orders, 0),
    openOrderSymbols: ordersBySymbol.length,
    entryOrders: ordersBySymbol.reduce((sum, row) => sum + row.entryOrders, 0),
    controlOrders: ordersBySymbol.reduce((sum, row) => sum + row.controlOrders, 0),
    ordersBySymbol,
  }
}

function emptySummary(
  connectionId: string,
  source: ExchangeLiveStateSummary["source"],
  error: string,
): ExchangeLiveStateSummary {
  const now = Date.now()
  return {
    connectionId,
    source,
    complete: false,
    positionsStatus: { available: false, fetchedAt: now, error },
    ordersStatus: { available: false, fetchedAt: now, error },
    ...summarizeExchangePositions([]),
    ...summarizeExchangeOrders([]),
    tracking: {
      trackedOpenPositions: 0,
      trackedPositionSlots: 0,
      trackedOrderIdentifiers: 0,
      venuePositionsSeen: 0,
      venuePositionsExcluded: 0,
      venueOrdersSeen: 0,
      venueOrdersExcluded: 0,
      attributedPositionQuantity: 0,
      venuePositionQuantity: 0,
      attributionComplete: false,
    },
    generatedAt: now,
  }
}

async function buildExchangeLiveStateSummary(connectionId: string): Promise<ExchangeLiveStateSummary> {
  const connection = await getConnection(connectionId).catch(() => null)
  if (!connection || !hasConnectionCredentials(connection, 10)) {
    return emptySummary(connectionId, "unavailable", "exchange_credentials_unavailable")
  }
  const connector = await exchangeConnectorFactory.getOrCreateConnector(connectionId)
  if (!connector) return emptySummary(connectionId, "unavailable", "connector_unavailable")
  if (connector.constructor?.name === "SimulatedConnector") {
    return emptySummary(connectionId, "simulated", "simulated_connector")
  }

  let trackingScope: SystemExchangeTrackingScope
  try {
    const [openTrackedPositions, closedTrackedPositions] = await Promise.all([
      getOpenLivePositionReadModelsStrict(connectionId, 2_000),
      getClosedLivePositionReadModelsStrict(connectionId, 1_000),
    ])
    trackingScope = buildSystemExchangeTrackingScope(
      connectionId,
      [...openTrackedPositions, ...closedTrackedPositions],
    )
  } catch {
    return emptySummary(connectionId, "unavailable", "system_tracking_unavailable")
  }

  const fetchedAt = Date.now()
  const [positionsResult, ordersResult] = await Promise.allSettled([
    withTimeout(connector.getPositions() as Promise<any[]>, "exchange_positions"),
    withTimeout(connector.getOpenOrders() as Promise<any[]>, "exchange_open_orders"),
  ])
  const positionRows = positionsResult.status === "fulfilled" && Array.isArray(positionsResult.value)
    ? positionsResult.value
    : []
  const orderRows = ordersResult.status === "fulfilled" && Array.isArray(ordersResult.value)
    ? ordersResult.value
    : []
  const positionsStatus = positionsResult.status === "fulfilled"
    ? connectorStatus(connector, "getLastPositionsSnapshotStatus", fetchedAt)
    : {
        available: false,
        fetchedAt,
        error: positionsResult.reason instanceof Error
          ? positionsResult.reason.message
          : String(positionsResult.reason || "exchange_positions_failed"),
      }
  const ordersStatus = ordersResult.status === "fulfilled"
    ? connectorStatus(connector, "getLastOpenOrdersSnapshotStatus", fetchedAt)
    : {
        available: false,
        fetchedAt,
        error: ordersResult.reason instanceof Error
          ? ordersResult.reason.message
          : String(ordersResult.reason || "exchange_open_orders_failed"),
      }
  const complete = positionsStatus.available && ordersStatus.available
  const systemPositions = summarizeExchangePositions(positionRows, trackingScope)
  const systemOrders = summarizeExchangeOrders(orderRows, trackingScope)
  const allVenuePositions = summarizeExchangePositions(positionRows)
  return {
    connectionId,
    source: complete
      ? "exchange-api"
      : positionsStatus.available || ordersStatus.available
        ? "exchange-api-partial"
        : "unavailable",
    complete,
    positionsStatus,
    ordersStatus,
    ...systemPositions,
    ...systemOrders,
    tracking: {
      trackedOpenPositions: trackingScope.trackedOpenPositions,
      trackedPositionSlots: trackingScope.positionsBySlot.size,
      trackedOrderIdentifiers: trackingScope.orderIdentifiers.size,
      venuePositionsSeen: allVenuePositions.openPositions,
      venuePositionsExcluded: Math.max(0, allVenuePositions.openPositions - systemPositions.openPositions),
      venueOrdersSeen: orderRows.length,
      venueOrdersExcluded: Math.max(0, orderRows.length - systemOrders.openOrders),
      attributedPositionQuantity: systemPositions.positionQuantity,
      venuePositionQuantity: allVenuePositions.positionQuantity,
      attributionComplete: true,
    },
    generatedAt: Date.now(),
  }
}

export async function getExchangeLiveStateSummary(connectionId: string): Promise<ExchangeLiveStateSummary> {
  const normalized = String(connectionId || "").trim()
  if (!normalized) throw new Error("connectionId is required")
  const cached = cache.get(normalized)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const current = inFlight.get(normalized)
  if (current) return current
  const work = buildExchangeLiveStateSummary(normalized)
    .catch(() => emptySummary(normalized, "unavailable", "exchange_snapshot_unavailable"))
    .then((value) => {
      cache.set(normalized, {
        value,
        expiresAt: Date.now() + (value.complete ? SNAPSHOT_FRESH_MS : SNAPSHOT_FAILURE_FRESH_MS),
      })
      return value
    })
    .finally(() => {
      if (inFlight.get(normalized) === work) inFlight.delete(normalized)
    })
  inFlight.set(normalized, work)
  return work
}

export function clearExchangeLiveStateSummaryCache(connectionId?: string): void {
  if (connectionId) cache.delete(connectionId)
  else cache.clear()
}
