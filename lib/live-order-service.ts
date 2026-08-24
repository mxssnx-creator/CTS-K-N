import { createHash } from "node:crypto"
import { createExchangeConnector, exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { getLiveOrderSafetyFailure } from "@/lib/live-order-safety"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import { evaluateRealTradeReadiness, hasUsableLiveCredentials, isForcedSimulation } from "@/lib/real-trade-gates"
import {
  getConnection,
  getMarketData,
  getRedisBackend,
  getRedisClient,
  initRedis,
  persistNow,
  savePosition,
} from "@/lib/redis-db"
import { liveOrdersBySymbolKey } from "@/lib/live-order-counter-keys"
import type { ExchangeConnection } from "@/lib/types"
import { resolveExecutableQuantity } from "@/lib/order-quantity"
import { getVenueMinQty } from "@/lib/exchange-min-qty"
import type { ExchangeOrderSettlement } from "@/lib/exchange-connectors/base-connector"

export const LIVE_ORDER_REDIS_KEYS = {
  orderIntent: "settings:orders (via getSettings/setSettings('orders'))",
  exchangeOrder: "live:order:{connectionId}:{exchangeOrderId}",
  livePosition: "live:position:{livePositionId} plus live:positions:{connectionId} index",
  progressionCounters: "progression:{connectionId}",
  perSymbolOrderCounters: "live_orders_by_symbol_v2:{connectionId}",
  perSourceOrderCounters: "live_orders_by_source_v1:{connectionId}",
} as const

export type LiveOrderDirection = "long" | "short"
export type LiveOrderMode = "live" | "simulated"
export type LiveOrderSourceLane = "direct-trade" | "main-trade" | "preset-trade" | "signal-trade" | "other"
export type LiveOrderMarginType = "cross" | "isolated"

export interface PlaceLiveOrderInput {
  connectionId: string
  symbol: string
  side: string
  quantity: number
  leverage?: number
  /** Margin mode is part of the entry contract, never a post-order repair. */
  marginType?: LiveOrderMarginType
  price?: number
  orderType?: "market" | "limit"
  requireLiveConfirmation?: boolean
  safetyPayload?: Record<string, any>
  connector?: any
  connection?: ExchangeConnection | any
  livePositionId?: string
  existingPosition?: any
  persistPosition?: boolean
  updateCounters?: boolean
  countPositionCreated?: boolean
  countAccumulated?: boolean
  source?: string
  // Closing a long is a sell order and closing a short is a buy order. Keep
  // the *position* side explicit so hedge-mode connectors never infer the
  // opposite side from the closing order itself.
  positionDirection?: LiveOrderDirection
  reduceOnly?: boolean
  clientOrderId?: string
}

const DIRECT_ORDER_CONTROL_TTL_SECONDS = 60 * 60 * 24 * 30

type DirectOrderControlState = "submitting" | "acknowledged" | "completed" | "failed"

interface DirectOrderControlRecord {
  version: 1
  fingerprint: string
  state: DirectOrderControlState
  connectionId: string
  clientOrderId: string
  exchangeClientOrderId: string
  symbol: string
  direction: LiveOrderDirection
  positionDirection: LiveOrderDirection
  reduceOnly: boolean
  quantity: number
  orderType: "market" | "limit"
  orderId?: string
  response?: Record<string, any>
  lastError?: string
  createdAt: number
  updatedAt: number
}

/**
 * Durable idempotency record used by the leased Direct-Trade worker. The
 * encoded segments prevent a connection/control id from changing Redis key
 * boundaries while keeping the exact same lookup usable by the API route.
 */
export function directOrderControlKey(connectionId: string, clientOrderId: string): string {
  return `live:direct_order_control:${encodeURIComponent(String(connectionId))}:${encodeURIComponent(String(clientOrderId))}`
}

/**
 * One stable id that is valid on every supported derivatives venue. OKX is
 * the narrowest contract (ASCII alphanumeric, max 32 chars), while the
 * worker's durable control ids intentionally contain separators. Preserve an
 * already-portable id verbatim; otherwise retain a readable prefix and append
 * a 64-bit digest so removing separators can never create a practical alias.
 */
export function exchangeClientOrderIdForControl(clientOrderId: string): string {
  const source = String(clientOrderId || "").trim()
  const alphanumeric = source.replace(/[^A-Za-z0-9]/g, "")
  if (source && source === alphanumeric && source.length <= 32) return source
  const prefix = (alphanumeric || "dt").slice(0, 16)
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16)
  return `${prefix}${digest}`.slice(0, 32)
}

function directOrderFingerprint(input: {
  symbol: string
  direction: LiveOrderDirection
  positionDirection: LiveOrderDirection
  reduceOnly: boolean
  quantity: number
  orderType: "market" | "limit"
}): string {
  return JSON.stringify([
    input.symbol,
    input.direction,
    input.positionDirection,
    input.reduceOnly,
    Number(input.quantity).toPrecision(15),
    input.orderType,
  ])
}

function parseDirectOrderControlRecord(raw: unknown): DirectOrderControlRecord | null {
  if (typeof raw !== "string" || !raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.version !== 1 || typeof parsed?.fingerprint !== "string") return null
    return parsed as DirectOrderControlRecord
  } catch {
    return null
  }
}

async function persistDirectOrderControlSnapshot(): Promise<void> {
  if (typeof getRedisBackend !== "function" || getRedisBackend() !== "inline-local") return
  if (typeof persistNow !== "function" || !(await persistNow())) {
    throw Object.assign(new Error("Direct-Trade control order could not be persisted before exchange execution"), {
      statusCode: 503,
      mode: "direct_order_control_not_durable",
    })
  }
}

async function writeDirectOrderControlRecord(record: DirectOrderControlRecord): Promise<void> {
  const client = getRedisClient() as any
  const key = directOrderControlKey(record.connectionId, record.clientOrderId)
  // Do not downgrade a terminal outcome when an older in-flight reconciliation
  // returns after it. Terminal records are immutable for the lifetime of the
  // control id.
  const current = parseDirectOrderControlRecord(await client.get?.(key))
  if ((current?.state === "completed" || current?.state === "failed")
    && record.state !== "completed" && record.state !== "failed") return
  await client.set(key, JSON.stringify(record), { XX: true, EX: DIRECT_ORDER_CONTROL_TTL_SECONDS })
  await persistDirectOrderControlSnapshot()
}

async function claimDirectOrderControl(record: DirectOrderControlRecord): Promise<{
  owned: boolean
  record: DirectOrderControlRecord
}> {
  const client = getRedisClient() as any
  const key = directOrderControlKey(record.connectionId, record.clientOrderId)
  const claimed = await client.set(key, JSON.stringify(record), { NX: true, EX: DIRECT_ORDER_CONTROL_TTL_SECONDS })
  if (claimed === "OK" || claimed === true) {
    // This is the no-duplicate boundary: an exchange call is permitted only
    // after the exact economic intent survives a process/host crash.
    try {
      await persistDirectOrderControlSnapshot()
    } catch (error) {
      // The venue has not been touched yet. Release the in-memory claim so a
      // repaired persistence backend can safely retry instead of inheriting a
      // permanent `submitting` record for an order that was never sent.
      if (typeof client.del === "function") await client.del(key).catch(() => 0)
      await persistDirectOrderControlSnapshot().catch(() => false)
      throw error
    }
    return { owned: true, record }
  }
  const existing = parseDirectOrderControlRecord(await client.get?.(key))
  if (!existing) {
    throw Object.assign(new Error("Direct-Trade control order could not acquire or read its durable idempotency record"), {
      statusCode: 503,
      mode: "direct_order_control_unavailable",
    })
  }
  if (existing.fingerprint !== record.fingerprint) {
    throw Object.assign(new Error(`Direct-Trade control id ${record.clientOrderId} was already used for a different order`), {
      statusCode: 409,
      mode: "direct_order_control_conflict",
    })
  }
  return { owned: false, record: existing }
}

async function resolveSubmittedQuantity(
  input: PlaceLiveOrderInput,
  symbol: string,
  connection?: ExchangeConnection | any,
): Promise<{
  quantity: number
  requestedQuantity: number
  adjusted: boolean
  reason?: string
}> {
  // Read the pair hash directly here instead of adding another high-level
  // Redis dependency to the order service. This keeps paper/test adapters and
  // older connector mocks compatible while using the same persisted metadata
  // as VolumeCalculator in production.
  let pair: Record<string, unknown> | null = null
  try {
    const client = getRedisClient() as any
    if (typeof client?.hgetall === "function") {
      pair = await client.hgetall(`settings:trading_pair:${symbol}`)
    }
  } catch {
    pair = null
  }
  const exchange = String(connection?.exchange || connection?.exchange_name || connection?.id || "")
    .trim()
    .toLowerCase()
  const isBingX = exchange.includes("bingx")
  const quantityRules: Record<string, unknown> = { ...(pair || {}) }
  if (isBingX) {
    // Direct-Trade can start before the optional trading-pair cache has been
    // warmed. Keep the request minimal but never below the known BingX base
    // quantity floor. Once exact venue metadata is present, it is authoritative
    // and must not be inflated by a conservative static fallback.
    const persistedMinimum = Number(
      quantityRules.minQuantity
      ?? quantityRules.min_order_size
      ?? quantityRules.min_quantity,
    )
    const staticMinimum = getVenueMinQty(symbol)
    if (!(persistedMinimum > 0)) quantityRules.minQuantity = staticMinimum
    else quantityRules.minQuantity = persistedMinimum
  }

  let marketPrice = Number(input.price) || 0
  if (!(marketPrice > 0) && input.reduceOnly !== true) {
    const market = await getMarketData(symbol, "1m").catch(() => null as any)
    const latest = market && (market.latest || (Array.isArray(market) ? market[market.length - 1] : null))
    marketPrice = Number(latest?.close ?? latest?.[4] ?? latest?.price ?? 0) || 0
  }
  const hasVenueNotionalMinimum = [
    quantityRules.minNotionalUsdt,
    quantityRules.minNotional,
    quantityRules.min_notional_usdt,
  ].some((value) => Number(value) > 0)
  return resolveExecutableQuantity(
    input.quantity,
    marketPrice,
    quantityRules,
    {
      reduceOnly: input.reduceOnly === true,
      // Use the venue's own notional floor when present. The $5 fallback is
      // only for a cold/missing metadata cache and is never added on top of
      // an exchange-provided minimum.
      universalMinNotionalUsdt: input.reduceOnly === true || hasVenueNotionalMinimum ? 0 : 5,
    },
  )
}

export interface ParsedFill {
  filled: boolean
  filledQty: number
  filledPrice: number
  status: string
}

function normalizeDirection(side: string): LiveOrderDirection {
  const sideKey = String(side || "").trim().toLowerCase()
  if (sideKey === "long" || sideKey === "buy") return "long"
  if (sideKey === "short" || sideKey === "sell") return "short"
  throw new Error(`Order side must be long, short, buy, or sell; received '${sideKey || "empty"}'`)
}

function normalizeOrderSymbol(symbol: string): string {
  const normalized = String(symbol || "").trim().toUpperCase()
  if (!/^[A-Z0-9/_-]{2,40}$/.test(normalized)) {
    throw new Error("Order symbol must be a non-empty exchange symbol without Redis delimiters")
  }
  return normalized
}

export function exchangeSideForDirection(direction: LiveOrderDirection): "buy" | "sell" {
  return direction === "long" ? "buy" : "sell"
}

export function parseOrderFill(result: any, fallbackQuantity = 0, fallbackPrice = 0): ParsedFill {
  // `quantity` and `price` describe the submitted order on several venues;
  // they are not execution facts.  Only explicit execution fields may enter
  // live accounting.  The fallback arguments remain simulation-only and are
  // supplied by the caller when the deterministic paper adapter is used.
  const filledQty = Number(
    result?.filledQty
    ?? result?.executedQty
    ?? result?.cumQty
    ?? result?.cumExecQty
    ?? result?.accFillSz
    ?? result?.filledSize
    ?? result?.filledQuantity
    ?? result?.filled_amount
    ?? 0,
  ) || 0
  const filledPrice = Number(
    result?.filledPrice
    ?? result?.avgPrice
    ?? result?.averagePrice
    ?? result?.avgPx
    ?? result?.avgFillPrice
    ?? result?.average_price
    ?? 0,
  ) || fallbackPrice || 0
  const status = String(
    result?.status
    ?? result?.orderStatus
    ?? result?.state
    ?? result?.order_state
    ?? (filledQty > 0 ? "filled" : "placed"),
  ).toLowerCase()
  const filled = filledQty > 0 && (status.includes("fill") || filledQty >= (Number(fallbackQuantity) || 0) * 0.99)
  return { filled, filledQty, filledPrice, status }
}

async function hydrateExchangeOrderResult(
  connector: any,
  symbol: string,
  orderId: string,
  result: any,
): Promise<any> {
  const reportedFilledQty = Number(result?.filledQty ?? result?.executedQty ?? result?.cumQty ?? 0) || 0
  const reportedFilledPrice = Number(result?.filledPrice ?? result?.avgPrice ?? result?.averagePrice ?? 0) || 0
  // Some exchange create-order endpoints return only an order id for a market
  // order. Direct-Trade must not record a guessed fill when the connector can
  // cheaply reconcile that id. Keep the query bounded so a slow venue cannot
  // stall the 280ms control loop indefinitely.
  if (
    // A market acknowledgement can contain an executed quantity without its
    // authoritative average price (or vice versa).  Do not accept either
    // partial shape as complete live accounting: the next query must provide
    // both fields before Direct-Trade can calculate a position/PF result.
    (reportedFilledQty > 0 && reportedFilledPrice > 0) ||
    typeof connector?.getOrder !== "function" ||
    !orderId
  ) return result

  try {
    const queried = await new Promise<any>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve(null)
      }, 2_500)
      Promise.resolve()
        .then(() => connector.getOrder(symbol, orderId))
        .then((value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        })
        .catch(() => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(null)
        })
    })
    if (queried && typeof queried === "object") {
      return { ...result, ...queried, orderId: result.orderId || queried.orderId || orderId }
    }
  } catch {
    // The create acknowledgement remains authoritative when the bounded
    // reconciliation read is unavailable; live accounting stays pending
    // rather than inventing the requested quantity or price.
  }
  return result
}

export function isTerminalLiveOrderResult(result: any, requestedQuantity = 0): boolean {
  const status = String(
    result?.status
    ?? result?.orderStatus
    ?? result?.state
    ?? result?.order_state
    ?? "",
  ).trim().toLowerCase().replace(/[\s-]+/g, "_")
  const compactStatus = status.replace(/_/g, "")
  // A partially-filled cancellation is terminal and its cumulative fill must
  // be applied exactly once. Check terminal cancellation/rejection markers
  // before the generic partial branch.
  if (["cancel", "reject", "expire", "fail", "deactivat"].some((marker) => compactStatus.includes(marker))) {
    return true
  }
  if ([
    "filled",
    "fully_filled",
    "closed",
    "complete",
    "completed",
    "done",
    "cancelled",
    "canceled",
    "rejected",
    "expired",
    "failed",
  ].includes(status)) return true
  if (status.includes("partial")) return false
  const filledQty = Number(
    result?.filledQty
    ?? result?.executedQty
    ?? result?.cumQty
    ?? result?.cumExecQty
    ?? result?.accFillSz
    ?? result?.filledSize
    ?? result?.filledQuantity
    ?? result?.filled_amount
    ?? 0,
  ) || 0
  return requestedQuantity > 0 && filledQty >= requestedQuantity * 0.999999
}

function liveOrderId(result: any): string {
  return String(
    result?.orderId
    ?? result?.order_id
    ?? result?.orderID
    ?? result?.ordId
    ?? result?.orderNo
    ?? result?.id
    ?? "",
  ).trim()
}

function liveOrderClientId(result: any): string {
  return String(
    result?.clientOrderId
    ?? result?.clientOrderID
    ?? result?.orderLinkId
    ?? result?.custom_order_id
    ?? result?.customOrderId
    ?? result?.client_order_id
    ?? result?.clOrdId
    ?? result?.newClientOrderId
    ?? result?.label
    ?? "",
  ).trim()
}

function matchesDirectOrderControl(result: any, record: DirectOrderControlRecord): boolean {
  const orderId = liveOrderId(result)
  const clientOrderId = liveOrderClientId(result)
  const exchangeClientOrderId = record.exchangeClientOrderId
    || exchangeClientOrderIdForControl(record.clientOrderId)
  return Boolean(
    (record.orderId && orderId && record.orderId === orderId)
    || (clientOrderId && (clientOrderId === exchangeClientOrderId || clientOrderId === record.clientOrderId))
    || (!record.orderId && orderId && (orderId === exchangeClientOrderId || orderId === record.clientOrderId)),
  )
}

async function boundedConnectorRead(read: () => unknown, timeoutMs = 2_500): Promise<any> {
  return await new Promise<any>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(null)
    }, timeoutMs)
    Promise.resolve()
      .then(read)
      .then((value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(null)
      })
  })
}

/**
 * Read one exact venue settlement without letting accounting history block a
 * hot engine loop.  The exact-id check is intentional: global order-history
 * pages may be incomplete or eventually consistent and must never be used to
 * attribute another order's fills/PnL to this control generation.
 */
export async function readOrderSettlement(
  connector: any,
  symbol: string,
  orderId: string,
  timeoutMs = 3_500,
): Promise<ExchangeOrderSettlement | null> {
  const exactOrderId = String(orderId || "").trim()
  if (!exactOrderId || exactOrderId === "N/A" || typeof connector?.getOrderSettlement !== "function") {
    return null
  }
  const value = await boundedConnectorRead(
    () => connector.getOrderSettlement(symbol, exactOrderId),
    timeoutMs,
  ) as ExchangeOrderSettlement | null
  if (!value || String(value.orderId || "").trim() !== exactOrderId) return null
  const filledQuantity = Number(value.filledQuantity)
  const averageFillPrice = Number(value.averageFillPrice)
  if (!(filledQuantity > 0) || !(averageFillPrice > 0)) return null
  return value
}

function orderRows(value: any): any[] {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.orders)) return value.orders
  if (Array.isArray(value?.data)) return value.data
  if (Array.isArray(value?.data?.orders)) return value.data.orders
  if (Array.isArray(value?.list)) return value.list
  if (Array.isArray(value?.result?.orders)) return value.result.orders
  if (Array.isArray(value?.result?.list)) return value.result.list
  return []
}

function unwrapConnectorOrderDetail(value: any): any | null {
  if (!value || typeof value !== "object" || value?.success === false) return null
  const nested = value?.order ?? value?.data?.order ?? value?.data
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested
  const hasOrderShape = Boolean(
    liveOrderId(value)
    || liveOrderClientId(value)
    || value?.status
    || value?.orderStatus
    || value?.state
    || value?.order_state,
  )
  return hasOrderShape ? value : null
}

async function reconcileDirectOrderControl(
  connector: any,
  record: DirectOrderControlRecord,
): Promise<any | null> {
  const exchangeClientOrderId = record.exchangeClientOrderId
    || exchangeClientOrderIdForControl(record.clientOrderId)
  if (record.orderId && typeof connector?.getOrder === "function") {
    const byOrderId = await boundedConnectorRead(() => connector.getOrder(record.symbol, record.orderId))
    if (byOrderId && typeof byOrderId === "object") return byOrderId
  }

  // BingX exposes a client-order-id query that can recover the especially
  // important ACK-without-order-id case. Calling it conditionally keeps other
  // connectors fully duck-typed.
  if (typeof connector?.getOrderDetails === "function") {
    const detail = unwrapConnectorOrderDetail(await boundedConnectorRead(
      () => connector.getOrderDetails(record.symbol, record.orderId || undefined, exchangeClientOrderId),
    ))
    if (detail) return detail
  } else if (typeof connector?.getOpenOrder === "function") {
    const detail = unwrapConnectorOrderDetail(await boundedConnectorRead(
      () => connector.getOpenOrder(record.symbol, record.orderId || undefined, exchangeClientOrderId),
    ))
    if (detail) return detail
  }

  const [openOrders, history] = await Promise.all([
    typeof connector?.getOpenOrders === "function"
      ? boundedConnectorRead(() => connector.getOpenOrders(record.symbol))
      : Promise.resolve(null),
    typeof connector?.getOrderHistory === "function"
      ? boundedConnectorRead(() => connector.getOrderHistory(record.symbol, 100))
      : Promise.resolve(null),
  ])
  return [...orderRows(openOrders), ...orderRows(history)].find((row) => matchesDirectOrderControl(row, record)) || null
}

function isAmbiguousPlacementFailure(resultOrError: any): boolean {
  const message = String(
    resultOrError?.error
    ?? resultOrError?.message
    ?? resultOrError
    ?? "",
  ).toLowerCase()
  return [
    "ambiguous",
    "ack_without_order_id",
    "without order id",
    "reconcile",
    "timed out",
    "timeout",
    "network",
    "socket",
    "econnreset",
    "duplicate",
    "already exists",
  ].some((needle) => message.includes(needle))
}

export async function loadLiveOrderConnection(connectionId: string): Promise<any> {
  await initRedis()
  let connection: any = null
  if (typeof getConnection === "function") {
    connection = await getConnection(connectionId)
  }
  if (!connection || Object.keys(connection).length === 0) {
    const client = getRedisClient() as any
    connection = await client.hgetall?.(`connection:${connectionId}`)
  }
  if (!connection || Object.keys(connection).length === 0) throw new Error(`Connection ${connectionId} not found`)
  return {
    ...connection,
    id: connectionId,
    name: connection.name || connectionId,
    exchange: connection.exchange || "unknown",
    api_key: connection.api_key || "",
    api_secret: connection.api_secret || "",
    api_passphrase: connection.api_passphrase || "",
    api_type: connection.api_type || "",
    contract_type: connection.contract_type || "",
    is_testnet: connection.is_testnet || "0",
    margin_type: connection.margin_type || "",
    position_mode: connection.position_mode || "",
    connection_method: connection.connection_method || "",
    connection_library: connection.connection_library || "",
    is_live_trade: connection.is_live_trade,
    live_trade_enabled: connection.live_trade_enabled,
    live_trade_requested: connection.live_trade_requested,
    live_trade_blocked_reason: connection.live_trade_blocked_reason,
    is_preset_trade: connection.is_preset_trade,
    preset_trade_enabled: connection.preset_trade_enabled,
    preset_trade_requested: connection.preset_trade_requested,
    preset_trade_blocked_reason: connection.preset_trade_blocked_reason,
    is_signal_trade: connection.is_signal_trade,
    signal_trade_enabled: connection.signal_trade_enabled,
    signal_trade_requested: connection.signal_trade_requested,
    signal_trade_blocked_reason: connection.signal_trade_blocked_reason,
  }
}

type LiveTradeIntent = "main" | "preset" | "signal"

function resolveLiveTradeIntent(payload: Record<string, any>): LiveTradeIntent {
  const explicit = String(payload.liveTradeIntent || payload.live_trade_intent || "").toLowerCase()
  if (explicit === "preset" || explicit === "signal") return explicit
  const source = String(payload.source || "").toLowerCase()
  if (source.includes("preset")) return "preset"
  if (source.includes("signal")) return "signal"
  return "main"
}

function isDirectTradePayload(payload: Record<string, any>): boolean {
  return payload.directTrade === true || payload.direct_trade === true || String(payload.source || "").toLowerCase().startsWith("direct-trade-")
}

function assertDirectTradeExecutionContract(
  connection: any,
  payload: Record<string, any>,
  willUseRealExchange: boolean,
): void {
  if (!willUseRealExchange || !isDirectTradePayload(payload)) return
  const apiType = String(connection?.api_type || connection?.apiType || "").trim().toLowerCase()
  if (apiType.includes("spot")) {
    throw Object.assign(new Error("Direct-Trade live execution requires a derivatives connection with reduce-only close support"), {
      statusCode: 409,
      mode: "unsupported_direct_trade_connection",
    })
  }
  const exchange = String(connection?.exchange || "").trim().toLowerCase()
  const connectionLibrary = String(
    connection?.connection_library
    || connection?.connectionLibrary
    || "",
  ).trim().toLowerCase()
  if ((exchange === "orangex" || exchange === "orange-x") && connectionLibrary === "legacy") {
    throw Object.assign(new Error("Direct-Trade live execution requires the OrangeX JSON-RPC adapter; the legacy adapter cannot guarantee reduce-only/idempotent controls"), {
      statusCode: 409,
      mode: "unsupported_direct_trade_connection",
    })
  }
}

function resolveEntryReadiness(connection: any, payload: Record<string, any>) {
  // Direct Trade has its own Redis state/lease gate at the API boundary. It
  // must not be coupled to Main/Preset/Signal switches, while still using the
  // process-wide placement safety gate below.
  // Reduce-only actions belong to an already-owned position lifecycle and are
  // intentionally allowed to finish after an operator disables new entries.
  // Test doubles also intentionally bypass deployment readiness; they never
  // receive a production connector.
  if (process.env.NODE_ENV === "test" || payload.reduceOnly === true || isDirectTradePayload(payload)) return null
  const readiness = evaluateRealTradeReadiness(connection, resolveLiveTradeIntent(payload))
  if (readiness.canPlaceRealOrders || readiness.executionMode === "simulation") return readiness
  throw Object.assign(new Error(readiness.blockReason || "Live trade entry is not ready"), {
    statusCode: 409,
    mode: "blocked_live_trade",
    blockCode: readiness.blockCode,
  })
}

export async function createLiveOrderConnector(connection: any, payload: Record<string, any> = {}): Promise<{ connector: any; mode: LiveOrderMode; willUseRealExchange: boolean }> {
  const entryReadiness = resolveEntryReadiness(connection, payload)
  const forceSim = isForcedSimulation() || entryReadiness?.executionMode === "simulation"
  const willUseRealExchange = !forceSim && hasUsableLiveCredentials(connection)
  if (willUseRealExchange) {
    const safetyFailure = getLiveOrderSafetyFailure(payload)
    if (safetyFailure) throw Object.assign(new Error(safetyFailure), { statusCode: 403, mode: "blocked_live_order_safety" })
  }
  if (
    !willUseRealExchange &&
    !forceSim &&
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_PROD_SIMULATED !== "1"
  ) {
    throw Object.assign(new Error(`Live exchange credentials missing for ${connection.id || connection.name || "connection"}; refusing simulated fallback in production`), {
      statusCode: 409,
      mode: "missing_live_exchange_credentials",
    })
  }
  if (!willUseRealExchange) {
    const { SimulatedConnector } = await import("@/lib/exchange-connectors/simulated-connector")
    return {
      connector: new SimulatedConnector({
        apiKey: connection.api_key,
        apiSecret: connection.api_secret,
        isTestnet: isTruthyFlag(connection.is_testnet),
        // Keep the paper adapter on the same derivatives contract as the
        // selected connection. Omitting these fields made BaseConnector flag
        // every Preset/Signal paper route as an invalid API type and left its
        // quantity/position semantics ambiguous.
        apiType: connection.api_type || connection.apiType || "perpetual_futures",
        contractType: connection.contract_type || connection.contractType || "usdt-perpetual",
      }, "simulated"),
      mode: "simulated",
      willUseRealExchange,
    }
  }
  // Reuse the process-level connector so BingX library initialization,
  // credentials, and HTTP transport are not rebuilt for every live order.
  // Callers without a persisted connection id still get an isolated connector.
  const connector = connection.id && typeof exchangeConnectorFactory?.getOrCreateConnector === "function"
    ? await exchangeConnectorFactory.getOrCreateConnector(String(connection.id))
    : await createExchangeConnector(connection.exchange, {
        apiKey: connection.api_key,
        apiSecret: connection.api_secret,
        apiPassphrase: connection.api_passphrase || "",
        isTestnet: isTruthyFlag(connection.is_testnet),
        apiType: connection.api_type,
        contractType: connection.contract_type,
      })
  if (!connector) {
    throw Object.assign(new Error(`Could not initialize exchange connector for ${connection.id || connection.name || connection.exchange}`), {
      statusCode: 503,
      mode: "exchange_connector_unavailable",
    })
  }
  return { connector, mode: "live", willUseRealExchange }
}

export function normalizeLiveOrderMarginType(value: unknown): LiveOrderMarginType {
  return String(value || "").trim().toLowerCase().includes("isolated")
    ? "isolated"
    : "cross"
}

export async function setupLiveOrderLeverage(connector: any, symbol: string, leverage = 1): Promise<boolean> {
  if (leverage > 1 && typeof connector?.setLeverage === "function") {
    const result = await connector.setLeverage(symbol, leverage)
    if (result?.success === false) {
      throw new Error(result?.error || `Exchange rejected ${leverage}x leverage for ${symbol}`)
    }
    return true
  }
  return false
}

/**
 * Configure a new entry's venue state in the only safe order: margin mode
 * first, then leverage, then the order itself.  The exchange connector owns
 * its cooldown/FIFO lane, so awaiting these calls also keeps the sequence
 * intact under concurrent symbol processing.
 *
 * Reduce-only exits deliberately skip this routine: changing account settings
 * while closing an existing position can be rejected by venues and must never
 * prevent a protective exit.
 */
export async function setupLiveOrderMarginAndLeverage(
  connector: any,
  symbol: string,
  options: { marginType?: unknown; leverage?: unknown } = {},
): Promise<{ marginType: LiveOrderMarginType; marginConfigured: boolean; leverageConfigured: boolean }> {
  const marginType = normalizeLiveOrderMarginType(options.marginType)
  let marginConfigured = false
  if (typeof connector?.setMarginType === "function") {
    const result = await connector.setMarginType(symbol, marginType)
    if (result?.success === false) {
      throw new Error(result?.error || `Exchange rejected ${marginType} margin for ${symbol}`)
    }
    marginConfigured = true
  }

  const leverage = Math.max(1, Number(options.leverage) || 1)
  const leverageConfigured = await setupLiveOrderLeverage(connector, symbol, leverage)
  return { marginType, marginConfigured, leverageConfigured }
}

export function validateLiveOrderQuantity(input: { quantity: number; price?: number }): void {
  const quantity = Number(input.quantity)
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Quantity must be positive")
  const price = Number(input.price || 0)
  if (price < 0) throw new Error("Price cannot be negative")
}

export async function recordPerSymbolOrderCounter(connectionId: string, symbol: string, direction: LiveOrderDirection, metric: "placed" | "filled" | "failed"): Promise<void> {
  const client = getRedisClient() as any
  const symbolKey = normalizeOrderSymbol(symbol)
  const directionKey = normalizeDirection(direction)
  await client.hincrby(liveOrdersBySymbolKey(connectionId), `${symbolKey}:${directionKey}:${metric}`, 1)
}

export function normalizeLiveOrderSourceLane(source: unknown): LiveOrderSourceLane {
  const normalized = String(source || "").trim().toLowerCase().replace(/[_\s]+/g, "-")
  if (normalized.includes("direct-trade")) return "direct-trade"
  if (normalized.includes("preset")) return "preset-trade"
  if (normalized.includes("signal")) return "signal-trade"
  if (
    normalized.includes("main-trade")
    || normalized.includes("trade-engine")
    || normalized.includes("live-stage")
    || normalized.includes("real-trade")
  ) return "main-trade"
  return "other"
}

async function recordLiveOrderSourceCounter(
  connectionId: string,
  source: unknown,
  event: "placed" | "filled" | "failed" | "simulated",
  volumeUsd: number,
  options: { countPositionCreated?: boolean; countAccumulated?: boolean },
): Promise<void> {
  const client = getRedisClient() as any
  const key = `live_orders_by_source_v1:${connectionId}`
  const lane = normalizeLiveOrderSourceLane(source)
  const increment = async (metric: string) => client.hincrby(key, `${lane}:${metric}`, 1)
  if (event === "placed") await increment("placed")
  if (event === "failed") await increment("failed")
  if (event === "filled" || event === "simulated") {
    if (event === "simulated") {
      await increment("simulated")
      await increment("placed")
    }
    await increment("filled")
    if (options.countPositionCreated !== false) await increment("position_created")
    if (options.countAccumulated === true) await increment("accumulated")
    if (volumeUsd) {
      if (typeof client.hincrbyfloat === "function") await client.hincrbyfloat(key, `${lane}:volume_usd`, volumeUsd)
      else await client.hincrby(key, `${lane}:volume_usd`, Math.round(volumeUsd))
    }
  }
}

async function claimLiveOrderProgressionEvent(connectionId: string, eventKey?: string): Promise<boolean> {
  if (!eventKey) return true
  const client = getRedisClient() as any
  const normalized = String(eventKey).trim()
  if (!normalized) return true
  if (typeof client.sadd === "function") {
    const claimSetKey = `live_order_progression_events:${connectionId}`
    const added = await client.sadd(claimSetKey, normalized)
    if (Number(added) > 0 && typeof client.expire === "function") {
      await client.expire(claimSetKey, 60 * 60 * 24 * 30).catch(() => 0)
    }
    return Number(added) > 0
  }
  if (typeof client.set === "function") {
    const claimed = await client.set(`live_order_progression_event:${connectionId}:${normalized}`, "1", { NX: true, EX: 60 * 60 * 24 * 30 })
    return claimed === "OK" || claimed === true
  }
  return true
}

export async function recordLiveOrderProgression(
  connectionId: string,
  symbol: string,
  direction: LiveOrderDirection,
  event: "placed" | "filled" | "failed" | "simulated",
  volumeUsd = 0,
  eventKey?: string,
  options: { countPositionCreated?: boolean; countAccumulated?: boolean; source?: string } = {},
): Promise<boolean> {
  const client = getRedisClient() as any
  const progKey = `progression:${connectionId}`
  const directionKey = normalizeDirection(direction)
  if (!(await claimLiveOrderProgressionEvent(connectionId, eventKey))) return false
  await recordLiveOrderSourceCounter(connectionId, options.source, event, volumeUsd, options)
  if (event === "placed") await client.hincrby(progKey, "live_orders_placed_count", 1)
  if (event === "filled") {
    await client.hincrby(progKey, "live_orders_filled_count", 1)
    if (options.countPositionCreated !== false) {
      await client.hincrby(progKey, "live_positions_created_count", 1)
    }
    if (options.countAccumulated === true) {
      await client.hincrby(progKey, "live_orders_accumulated_count", 1)
    }
    if (volumeUsd) {
      if (typeof client.hincrbyfloat === "function") await client.hincrbyfloat(progKey, "live_volume_usd_total", volumeUsd)
      else await client.hincrby(progKey, "live_volume_usd_total", Math.round(volumeUsd))
    }
  }
  if (event === "failed") await client.hincrby(progKey, "live_orders_failed_count", 1)
  if (event === "simulated") {
    // Canonical paper execution: simulated orders immediately create/open an
    // executable position, so expose them in the same placed+filled counters
    // dashboards and accounting code already consume while retaining the
    // simulated-specific audit counter.
    await client.hincrby(progKey, "live_orders_simulated_count", 1)
    await client.hincrby(progKey, "live_orders_placed_count", 1)
    await client.hincrby(progKey, "live_orders_filled_count", 1)
    if (options.countPositionCreated !== false) {
      await client.hincrby(progKey, "live_positions_created_count", 1)
    }
    if (options.countAccumulated === true) {
      await client.hincrby(progKey, "live_orders_accumulated_count", 1)
    }
    if (volumeUsd) {
      if (typeof client.hincrbyfloat === "function") await client.hincrbyfloat(progKey, "live_volume_usd_total", volumeUsd)
      else await client.hincrby(progKey, "live_volume_usd_total", Math.round(volumeUsd))
    }
  }
  if (event !== "simulated") {
    await recordPerSymbolOrderCounter(connectionId, symbol, directionKey, event)
  } else {
    await recordPerSymbolOrderCounter(connectionId, symbol, directionKey, "placed")
    await recordPerSymbolOrderCounter(connectionId, symbol, directionKey, "filled")
  }
  return true
}

export async function persistLiveOrderPosition(input: { connectionId: string; symbol: string; direction: LiveOrderDirection; quantity: number; leverage?: number; marginType?: LiveOrderMarginType; fill: ParsedFill; orderId?: string; existingPosition?: any; livePositionId?: string; status?: string }): Promise<any> {
  // A live position must never be valued from a ticker fallback.  A ticker is
  // an observation, not an exchange execution, and using it creates phantom
  // fills/PF and can strand a pending order after a response-only ack.  The
  // shared simulation adapter supplies its own deterministic fill instead.
  const fillPrice = Number(input.fill.filledPrice) > 0 ? Number(input.fill.filledPrice) : 0
  const execQty = Number(input.fill.filledQty) > 0 ? Number(input.fill.filledQty) : 0
  const hasAuthoritativeFill = execQty > 0 && fillPrice > 0
  const now = Date.now()
  const livePos = {
    ...(input.existingPosition || {}),
    id: input.livePositionId || input.existingPosition?.id || `live:${input.connectionId}:${input.symbol}:${input.direction}:${now}:${Math.random().toString(36).slice(2, 8)}`,
    connectionId: input.connectionId,
    symbol: input.symbol,
    side: input.direction,
    direction: input.direction,
    orderId: input.orderId,
    entryPrice: fillPrice || 0,
    executedQuantity: execQty,
    remainingQuantity: 0,
    averageExecutionPrice: fillPrice || 0,
    quantity: execQty,
    volumeUsd: (execQty || 0) * (fillPrice || 0),
    leverage: input.leverage || 1,
    marginType: input.marginType || input.existingPosition?.marginType || "cross",
    status: input.status || (hasAuthoritativeFill ? "open" : "placed"),
    fills: hasAuthoritativeFill ? [{ timestamp: now, quantity: execQty, price: fillPrice, fee: 0, feeAsset: "" }] : [],
    progression: input.existingPosition?.progression || [],
    createdAt: input.existingPosition?.createdAt || now,
    updatedAt: now,
  }
  await savePosition(livePos)
  return livePos
}

export async function placeLiveOrder(input: PlaceLiveOrderInput): Promise<any> {
  validateLiveOrderQuantity(input)
  const connection = input.connection || await loadLiveOrderConnection(input.connectionId)
  const symbol = normalizeOrderSymbol(input.symbol)
  const direction = normalizeDirection(input.side)
  const submitted = await resolveSubmittedQuantity(input, symbol, connection)
  if (!(submitted.quantity > 0)) {
    throw new Error(`Could not resolve an executable quantity for ${symbol}: ${input.quantity}`)
  }
  const submittedInput = { ...input, quantity: submitted.quantity }
  const positionDirection = input.positionDirection
    ? normalizeDirection(input.positionDirection)
    : direction
  const exchangeSide = exchangeSideForDirection(direction)
  const orderPayload: Record<string, any> = {
    ...(input.safetyPayload || {}),
    ...submittedInput,
    liveTradeIntent: resolveLiveTradeIntent(input as any),
    reduceOnly: input.reduceOnly === true,
  }
  const entryReadiness = resolveEntryReadiness(connection, orderPayload)
  // A caller-supplied connector is an optimization, not a readiness bypass.
  // When the canonical entry decision is paper, discard that connector and
  // create the simulated adapter so development/legacy callers cannot turn a
  // disabled persisted Live switch into a real venue request.
  const useProvidedConnector = Boolean(input.connector) && entryReadiness?.executionMode !== "simulation"
  const { connector, mode, willUseRealExchange } = useProvidedConnector
    ? { connector: input.connector, mode: "live" as LiveOrderMode, willUseRealExchange: true }
    : await createLiveOrderConnector(connection, orderPayload)
  if (input.connector && willUseRealExchange) {
    const safetyFailure = getLiveOrderSafetyFailure(orderPayload)
    if (safetyFailure) throw Object.assign(new Error(safetyFailure), { statusCode: 403, mode: "blocked_live_order_safety" })
  }
  assertDirectTradeExecutionContract(connection, orderPayload, willUseRealExchange)
  const clientOrderId = String(input.clientOrderId || "").trim()
  const usesDirectControl = isDirectTradePayload(orderPayload) && clientOrderId.length > 0
  const now = Date.now()
  let directControl: DirectOrderControlRecord | null = usesDirectControl
    ? {
        version: 1,
        fingerprint: directOrderFingerprint({
          symbol,
          direction,
          positionDirection,
          reduceOnly: input.reduceOnly === true,
          // Fingerprint the worker's stable economic request. Precision/min-
          // notional metadata may be refreshed between reconciliation calls;
          // that must not turn the same control id into a false conflict.
          quantity: Number(input.quantity),
          orderType: input.orderType || "market",
        }),
        state: "submitting",
        connectionId: input.connectionId,
        clientOrderId,
        exchangeClientOrderId: exchangeClientOrderIdForControl(clientOrderId),
        symbol,
        direction,
        positionDirection,
        reduceOnly: input.reduceOnly === true,
        quantity: submitted.quantity,
        orderType: input.orderType || "market",
        createdAt: now,
        updatedAt: now,
      }
    : null
  let ownsDirectControl = false
  if (directControl) {
    const claim = await claimDirectOrderControl(directControl)
    directControl = claim.record
    ownsDirectControl = claim.owned
  }

  const progressionIdentity = (orderId?: string) => String(orderId || clientOrderId || "").trim()
  const progressionOptions = {
    countPositionCreated: input.countPositionCreated !== false,
    countAccumulated: input.countAccumulated === true,
    source: input.source,
  }
  const recordReconciledProgression = async (fill: ParsedFill, orderId: string, terminal: boolean) => {
    if (!willUseRealExchange || input.updateCounters === false) return
    const identity = progressionIdentity(orderId)
    await recordLiveOrderProgression(
      input.connectionId,
      symbol,
      direction,
      "placed",
      0,
      identity ? `${symbol}:${direction}:${identity}:placed` : undefined,
      progressionOptions,
    )
    // An active partial is still one unresolved order. Count/volume it only
    // after the venue makes the cumulative execution terminal so later reads
    // cannot leave Direct-Trade statistics permanently understated.
    if (terminal && fill.filledQty > 0) {
      await recordLiveOrderProgression(
        input.connectionId,
        symbol,
        direction,
        "filled",
        fill.filledQty * fill.filledPrice,
        identity ? `${symbol}:${direction}:${identity}:filled` : undefined,
        progressionOptions,
      )
    }
  }
  const completeDirectControlFailure = async (failure: unknown, raw?: any) => {
    const failedOrderId = liveOrderId(raw)
    const error = String(
      (failure as any)?.error
      ?? (failure as any)?.message
      ?? failure
      ?? "Failed to place order",
    )
    if (input.updateCounters !== false) {
      const identity = progressionIdentity(failedOrderId)
      await recordLiveOrderProgression(
        input.connectionId,
        symbol,
        direction,
        "failed",
        0,
        identity ? `${symbol}:${direction}:${identity}:failed` : undefined,
        progressionOptions,
      )
    }
    const response = {
      success: false,
      error,
      mode,
      requestedQuantity: submitted.requestedQuantity,
      submittedQuantity: submitted.quantity,
      quantityAdjusted: submitted.adjusted,
      quantityAdjustmentReason: submitted.reason,
      raw,
      pendingReconciliation: false,
      controlState: directControl ? "failed" : undefined,
    }
    if (directControl) {
      directControl = {
        ...directControl,
        state: "failed",
        orderId: failedOrderId || directControl.orderId,
        response,
        lastError: error,
        updatedAt: Date.now(),
      }
      await writeDirectOrderControlRecord(directControl)
    }
    return response
  }

  if (directControl && !ownsDirectControl) {
    if ((directControl.state === "completed" || directControl.state === "failed") && directControl.response) {
      // Fill-history propagation can lag the terminal order response. A replay
      // of the same durable control id is the safe opportunity to complete
      // fee/PnL accounting without ever resubmitting the order.
      if (
        directControl.state === "completed"
        && willUseRealExchange
        && !directControl.response.settlement
        && directControl.orderId
      ) {
        const settlement = await readOrderSettlement(
          connector,
          directControl.symbol,
          directControl.orderId,
        )
        if (settlement) {
          directControl = {
            ...directControl,
            response: { ...directControl.response, settlement },
            updatedAt: Date.now(),
          }
          await writeDirectOrderControlRecord(directControl)
        }
      }
      return { ...directControl.response, idempotentReplay: true }
    }
    const reconciled = await reconcileDirectOrderControl(connector, directControl)
    if (!reconciled) {
      return {
        ...(directControl.response || {}),
        success: directControl.state !== "failed",
        mode: directControl.response?.mode || mode,
        orderId: directControl.orderId || directControl.response?.orderId || "N/A",
        symbol,
        side: exchangeSide,
        direction,
        quantity: directControl.quantity,
        requestedQuantity: submitted.requestedQuantity,
        submittedQuantity: directControl.quantity,
        fill: directControl.response?.fill || { filled: false, filledQty: 0, filledPrice: 0, status: "pending_reconciliation" },
        details: directControl.response?.details || null,
        pendingReconciliation: directControl.state !== "failed",
        controlState: directControl.state,
        idempotentReplay: true,
      }
    }
    const reconciledOrderId = liveOrderId(reconciled) || directControl.orderId || "N/A"
    const fill = willUseRealExchange
      ? parseOrderFill(reconciled, 0, 0)
      : parseOrderFill(reconciled, directControl.quantity, input.price || 0)
    const terminal = isTerminalLiveOrderResult(reconciled, directControl.quantity)
    const settlement = terminal && willUseRealExchange
      ? await readOrderSettlement(connector, directControl.symbol, reconciledOrderId)
      : null
    const response = {
      success: true,
      mode,
      orderId: reconciledOrderId,
      symbol,
      side: exchangeSide,
      direction,
      quantity: directControl.quantity,
      requestedQuantity: submitted.requestedQuantity,
      submittedQuantity: directControl.quantity,
      quantityAdjusted: submitted.adjusted,
      quantityAdjustmentReason: submitted.reason,
      leverage: input.leverage || 1,
      fill,
      position: directControl.response?.position || null,
      details: reconciled,
      settlement,
      pendingReconciliation: !terminal,
      controlState: terminal ? "completed" : "acknowledged",
      idempotentReplay: true,
    }
    await recordReconciledProgression(fill, reconciledOrderId, terminal)
    directControl = {
      ...directControl,
      state: terminal ? "completed" : "acknowledged",
      orderId: reconciledOrderId !== "N/A" ? reconciledOrderId : directControl.orderId,
      response,
      updatedAt: Date.now(),
    }
    await writeDirectOrderControlRecord(directControl)
    return response
  }

  const configuredMarginType = normalizeLiveOrderMarginType(
    input.marginType
    ?? input.existingPosition?.marginType
    ?? (connection as any)?.margin_type
    ?? (connection as any)?.marginType,
  )
  try {
    if (!input.reduceOnly) {
      await setupLiveOrderMarginAndLeverage(connector, symbol, {
        marginType: configuredMarginType,
        leverage: Number(input.leverage || 1),
      })
    }
  } catch (error) {
    // Leverage configuration happens strictly before placeOrder. Therefore a
    // failure here is definitive: mark the claimed generation terminal so the
    // worker may advance instead of reconciling an order that was never sent.
    if (!directControl) throw error
    return completeDirectControlFailure(error)
  }
  const hedgeMode = String(connection.position_mode || "").toLowerCase().includes("hedge") || String(connection.position_mode || "").toLowerCase().includes("dual")
  const options = hedgeMode
    ? {
        hedgeMode: true,
        positionSide: positionDirection === "long" ? "LONG" : "SHORT",
        // BingX hedge mode encodes the reduce-only intent through the
        // opposing side plus explicit positionSide; the connector preserves
        // that safe venue-specific behaviour.
        reduceOnly: input.reduceOnly === true,
        clientOrderId: directControl?.exchangeClientOrderId || clientOrderId,
      }
    : {
        hedgeMode: false,
        reduceOnly: input.reduceOnly === true,
        clientOrderId: directControl?.exchangeClientOrderId || clientOrderId,
      }
  let result: any
  try {
    result = await connector.placeOrder(symbol, exchangeSide, submitted.quantity, input.price || 0, input.orderType || "market", options)
  } catch (error) {
    if (!directControl) throw error
    const message = error instanceof Error ? error.message : String(error)
    const response = {
      success: true,
      mode,
      orderId: directControl.orderId || "N/A",
      symbol,
      side: exchangeSide,
      direction,
      quantity: submitted.quantity,
      requestedQuantity: submitted.requestedQuantity,
      submittedQuantity: submitted.quantity,
      quantityAdjusted: submitted.adjusted,
      quantityAdjustmentReason: submitted.reason,
      leverage: input.leverage || 1,
      fill: { filled: false, filledQty: 0, filledPrice: 0, status: "pending_reconciliation" },
      position: null,
      details: { error: message },
      pendingReconciliation: true,
      controlState: "acknowledged",
      idempotentReplay: false,
    }
    directControl = { ...directControl, state: "acknowledged", response, lastError: message, updatedAt: Date.now() }
    await writeDirectOrderControlRecord(directControl)
    return response
  }
  if (!result?.success) {
    const failedOrderId = result?.orderId || result?.order_id || result?.id
    if (directControl && isAmbiguousPlacementFailure(result)) {
      const response = {
        success: true,
        mode,
        orderId: failedOrderId || "N/A",
        symbol,
        side: exchangeSide,
        direction,
        quantity: submitted.quantity,
        requestedQuantity: submitted.requestedQuantity,
        submittedQuantity: submitted.quantity,
        quantityAdjusted: submitted.adjusted,
        quantityAdjustmentReason: submitted.reason,
        leverage: input.leverage || 1,
        fill: { filled: false, filledQty: 0, filledPrice: 0, status: "pending_reconciliation" },
        position: null,
        details: result,
        pendingReconciliation: true,
        controlState: "acknowledged",
        idempotentReplay: false,
      }
      directControl = {
        ...directControl,
        state: "acknowledged",
        orderId: failedOrderId ? String(failedOrderId) : directControl.orderId,
        response,
        lastError: String(result?.error || "Ambiguous exchange acknowledgement"),
        updatedAt: Date.now(),
      }
      await writeDirectOrderControlRecord(directControl)
      return response
    }
    return completeDirectControlFailure(result?.error || "Failed to place order", result)
  }
  let exchangeOrderId = liveOrderId(result)
  if (directControl) {
    directControl = {
      ...directControl,
      state: "acknowledged",
      orderId: exchangeOrderId || directControl.orderId,
      updatedAt: Date.now(),
    }
    // Persist the venue id before the follow-up read. A crash during hydration
    // can then reconcile by exchange id without ever placing again.
    await writeDirectOrderControlRecord(directControl)
  }
  if (willUseRealExchange && exchangeOrderId) {
    result = await hydrateExchangeOrderResult(connector, symbol, String(exchangeOrderId), result)
  }
  exchangeOrderId = liveOrderId(result) || exchangeOrderId
  const orderId = exchangeOrderId || "N/A"
  // In live mode neither the requested quantity nor the requested limit/mark
  // price is an execution.  Keep those fallbacks for simulation only; live
  // Direct-Trade must receive both fields from the exchange or remain
  // pending/unfilled for reconciliation.
  const fill = willUseRealExchange
    ? parseOrderFill(result, 0, 0)
    : parseOrderFill(result, submitted.quantity, input.price || 0)
  const terminal = !willUseRealExchange || isTerminalLiveOrderResult(result, submitted.quantity)
  const settlement = terminal && willUseRealExchange
    ? await readOrderSettlement(connector, symbol, orderId)
    : null
  let position: any = null
  if (!willUseRealExchange) {
    if (input.persistPosition !== false) position = await persistLiveOrderPosition({ connectionId: input.connectionId, symbol, direction, quantity: submitted.quantity, leverage: input.leverage, marginType: configuredMarginType, fill, orderId, existingPosition: input.existingPosition, livePositionId: input.livePositionId, status: "simulated" })
    if (input.updateCounters !== false) await recordLiveOrderProgression(
      input.connectionId,
      symbol,
      direction,
      "simulated",
      position?.volumeUsd || (fill.filledQty * fill.filledPrice),
      progressionIdentity(exchangeOrderId) ? `${symbol}:${direction}:${progressionIdentity(exchangeOrderId)}:simulated` : undefined,
      progressionOptions,
    )
  } else {
    if (input.persistPosition !== false) position = await persistLiveOrderPosition({ connectionId: input.connectionId, symbol, direction, quantity: submitted.quantity, leverage: input.leverage, marginType: configuredMarginType, fill, orderId, existingPosition: input.existingPosition, livePositionId: input.livePositionId })
    if (input.updateCounters !== false) {
      const identity = progressionIdentity(exchangeOrderId)
      await recordLiveOrderProgression(input.connectionId, symbol, direction, "placed", 0, identity ? `${symbol}:${direction}:${identity}:placed` : undefined, progressionOptions)
      if ((position?.executedQuantity || fill.filledQty) > 0 && (!directControl || terminal)) {
        await recordLiveOrderProgression(input.connectionId, symbol, direction, "filled", position?.volumeUsd || (fill.filledQty * fill.filledPrice), identity ? `${symbol}:${direction}:${identity}:filled` : undefined, progressionOptions)
      }
    }
  }
  const response = {
    success: true,
    mode,
    orderId,
    symbol,
    side: exchangeSide,
    direction,
    quantity: submitted.quantity,
    requestedQuantity: submitted.requestedQuantity,
    submittedQuantity: submitted.quantity,
    quantityAdjusted: submitted.adjusted,
    quantityAdjustmentReason: submitted.reason,
    leverage: input.leverage || 1,
    fill,
    position,
    details: result,
    settlement,
    pendingReconciliation: directControl ? !terminal : undefined,
    controlState: directControl ? terminal ? "completed" : "acknowledged" : undefined,
    idempotentReplay: directControl ? false : undefined,
  }
  if (directControl) {
    directControl = {
      ...directControl,
      state: terminal ? "completed" : "acknowledged",
      orderId: exchangeOrderId || directControl.orderId,
      response,
      updatedAt: Date.now(),
    }
    await writeDirectOrderControlRecord(directControl)
  }
  return response
}
