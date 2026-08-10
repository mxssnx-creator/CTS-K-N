import { createExchangeConnector, exchangeConnectorFactory } from "@/lib/exchange-connectors/factory"
import { getLiveOrderSafetyFailure } from "@/lib/live-order-safety"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import { evaluateRealTradeReadiness, hasUsableLiveCredentials, isForcedSimulation } from "@/lib/real-trade-gates"
import { getConnection, getMarketData, getRedisClient, initRedis, savePosition } from "@/lib/redis-db"
import { liveOrdersBySymbolKey } from "@/lib/live-order-counter-keys"
import type { ExchangeConnection } from "@/lib/types"
import { resolveExecutableQuantity } from "@/lib/order-quantity"

export const LIVE_ORDER_REDIS_KEYS = {
  orderIntent: "settings:orders (via getSettings/setSettings('orders'))",
  exchangeOrder: "live:order:{connectionId}:{exchangeOrderId}",
  livePosition: "live:position:{livePositionId} plus live:positions:{connectionId} index",
  progressionCounters: "progression:{connectionId}",
  perSymbolOrderCounters: "live_orders_by_symbol_v2:{connectionId}",
} as const

export type LiveOrderDirection = "long" | "short"
export type LiveOrderMode = "live" | "simulated"

export interface PlaceLiveOrderInput {
  connectionId: string
  symbol: string
  side: string
  quantity: number
  leverage?: number
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
  source?: string
  // Closing a long is a sell order and closing a short is a buy order. Keep
  // the *position* side explicit so hedge-mode connectors never infer the
  // opposite side from the closing order itself.
  positionDirection?: LiveOrderDirection
  reduceOnly?: boolean
  clientOrderId?: string
}

async function resolveSubmittedQuantity(input: PlaceLiveOrderInput, symbol: string): Promise<{
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
  let marketPrice = Number(input.price) || 0
  if (!(marketPrice > 0) && input.reduceOnly !== true) {
    const market = await getMarketData(symbol, "1m").catch(() => null as any)
    const latest = market && (market.latest || (Array.isArray(market) ? market[market.length - 1] : null))
    marketPrice = Number(latest?.close ?? latest?.[4] ?? latest?.price ?? 0) || 0
  }
  return resolveExecutableQuantity(
    input.quantity,
    marketPrice,
    pair,
    {
      reduceOnly: input.reduceOnly === true,
      universalMinNotionalUsdt: input.reduceOnly === true ? 0 : 5,
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
  const filledQty = Number(result?.filledQty ?? result?.executedQty ?? result?.cumQty ?? 0) || 0
  const filledPrice = Number(result?.filledPrice ?? result?.avgPrice ?? result?.averagePrice ?? 0) || fallbackPrice || 0
  const status = String(result?.status ?? (filledQty > 0 ? "filled" : "placed")).toLowerCase()
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
    return { connector: new SimulatedConnector({ apiKey: connection.api_key, apiSecret: connection.api_secret, isTestnet: isTruthyFlag(connection.is_testnet) }, "simulated"), mode: "simulated", willUseRealExchange }
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

export async function setupLiveOrderLeverage(connector: any, symbol: string, leverage = 1): Promise<void> {
  if (leverage > 1 && typeof connector?.setLeverage === "function") {
    await connector.setLeverage(symbol, leverage).catch(() => undefined)
  }
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
  options: { countPositionCreated?: boolean; countAccumulated?: boolean } = {},
): Promise<boolean> {
  const client = getRedisClient() as any
  const progKey = `progression:${connectionId}`
  const directionKey = normalizeDirection(direction)
  if (!(await claimLiveOrderProgressionEvent(connectionId, eventKey))) return false
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

export async function persistLiveOrderPosition(input: { connectionId: string; symbol: string; direction: LiveOrderDirection; quantity: number; leverage?: number; fill: ParsedFill; orderId?: string; existingPosition?: any; livePositionId?: string; status?: string }): Promise<any> {
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
    marginType: input.existingPosition?.marginType || "cross",
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
  const submitted = await resolveSubmittedQuantity(input, symbol)
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
  await setupLiveOrderLeverage(connector, symbol, Number(input.leverage || 1))
  const hedgeMode = String(connection.position_mode || "").toLowerCase().includes("hedge") || String(connection.position_mode || "").toLowerCase().includes("dual")
  const options = hedgeMode
    ? {
        hedgeMode: true,
        positionSide: positionDirection === "long" ? "LONG" : "SHORT",
        // BingX hedge mode encodes the reduce-only intent through the
        // opposing side plus explicit positionSide; the connector preserves
        // that safe venue-specific behaviour.
        reduceOnly: input.reduceOnly === true,
        clientOrderId: input.clientOrderId,
      }
    : {
        hedgeMode: false,
        reduceOnly: input.reduceOnly === true,
        clientOrderId: input.clientOrderId,
      }
  let result = await connector.placeOrder(symbol, exchangeSide, submitted.quantity, input.price || 0, input.orderType || "market", options)
  if (!result?.success) {
    const failedOrderId = result?.orderId || result?.order_id || result?.id
    if (input.updateCounters !== false) {
      await recordLiveOrderProgression(
        input.connectionId,
        symbol,
        direction,
        "failed",
        0,
        failedOrderId ? `${symbol}:${direction}:${failedOrderId}:failed` : undefined,
      )
    }
    return {
      success: false,
      error: result?.error || "Failed to place order",
      mode,
      requestedQuantity: submitted.requestedQuantity,
      submittedQuantity: submitted.quantity,
      quantityAdjusted: submitted.adjusted,
      quantityAdjustmentReason: submitted.reason,
      raw: result,
    }
  }
  const exchangeOrderId = result.orderId || result.order_id || result.id
  if (willUseRealExchange && exchangeOrderId) {
    result = await hydrateExchangeOrderResult(connector, symbol, String(exchangeOrderId), result)
  }
  const orderId = exchangeOrderId || "N/A"
  // In live mode neither the requested quantity nor the requested limit/mark
  // price is an execution.  Keep those fallbacks for simulation only; live
  // Direct-Trade must receive both fields from the exchange or remain
  // pending/unfilled for reconciliation.
  const fill = willUseRealExchange
    ? parseOrderFill(result, 0, 0)
    : parseOrderFill(result, submitted.quantity, input.price || 0)
  let position: any = null
  if (!willUseRealExchange) {
    if (input.persistPosition !== false) position = await persistLiveOrderPosition({ connectionId: input.connectionId, symbol, direction, quantity: submitted.quantity, leverage: input.leverage, fill, orderId, existingPosition: input.existingPosition, livePositionId: input.livePositionId, status: "simulated" })
    if (input.updateCounters !== false) await recordLiveOrderProgression(input.connectionId, symbol, direction, "simulated", position?.volumeUsd || (fill.filledQty * fill.filledPrice), exchangeOrderId ? `${symbol}:${direction}:${exchangeOrderId}:simulated` : undefined)
  } else {
    if (input.persistPosition !== false) position = await persistLiveOrderPosition({ connectionId: input.connectionId, symbol, direction, quantity: submitted.quantity, leverage: input.leverage, fill, orderId, existingPosition: input.existingPosition, livePositionId: input.livePositionId })
    if (input.updateCounters !== false) {
      await recordLiveOrderProgression(input.connectionId, symbol, direction, "placed", 0, exchangeOrderId ? `${symbol}:${direction}:${exchangeOrderId}:placed` : undefined)
      if ((position?.executedQuantity || fill.filledQty) > 0) await recordLiveOrderProgression(input.connectionId, symbol, direction, "filled", position?.volumeUsd || (fill.filledQty * fill.filledPrice), exchangeOrderId ? `${symbol}:${direction}:${exchangeOrderId}:filled` : undefined)
    }
  }
  return {
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
  }
}
