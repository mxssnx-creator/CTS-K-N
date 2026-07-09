import { createExchangeConnector } from "@/lib/exchange-connectors/factory"
import { getLiveOrderSafetyFailure } from "@/lib/live-order-safety"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import { getConnection, getMarketData, getRedisClient, initRedis, savePosition } from "@/lib/redis-db"
import type { ExchangeConnection } from "@/lib/types"

export const LIVE_ORDER_REDIS_KEYS = {
  orderIntent: "settings:orders (via getSettings/setSettings('orders'))",
  exchangeOrder: "live:order:{connectionId}:{exchangeOrderId}",
  livePosition: "live:position:{livePositionId} plus live:positions:{connectionId} index",
  progressionCounters: "progression:{connectionId}",
  perSymbolOrderCounters: "live_orders_by_symbol:{connectionId}",
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
}

export interface ParsedFill {
  filled: boolean
  filledQty: number
  filledPrice: number
  status: string
}

function normalizeDirection(side: string): LiveOrderDirection {
  const sideKey = String(side || "").trim().toLowerCase()
  return sideKey === "short" || sideKey === "sell" ? "short" : "long"
}

export function exchangeSideForDirection(direction: LiveOrderDirection): "buy" | "sell" {
  return direction === "long" ? "buy" : "sell"
}

export function parseOrderFill(result: any, fallbackQuantity = 0, fallbackPrice = 0): ParsedFill {
  const filledQty = Number(result?.filledQty ?? result?.executedQty ?? result?.cumQty ?? result?.quantity ?? 0) || 0
  const filledPrice = Number(result?.filledPrice ?? result?.avgPrice ?? result?.averagePrice ?? result?.price ?? 0) || fallbackPrice || 0
  const status = String(result?.status ?? (filledQty > 0 ? "filled" : "placed")).toLowerCase()
  const filled = filledQty > 0 && (status.includes("fill") || filledQty >= (Number(fallbackQuantity) || 0) * 0.99)
  return { filled, filledQty, filledPrice, status }
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
  }
}

export async function createLiveOrderConnector(connection: any, payload: Record<string, any> = {}): Promise<{ connector: any; mode: LiveOrderMode; willUseRealExchange: boolean }> {
  const forceSim = process.env.FORCE_SIMULATED === "1"
  const willUseRealExchange = !forceSim && !!connection.api_key && !!connection.api_secret
  if (willUseRealExchange) {
    const safetyFailure = getLiveOrderSafetyFailure(payload)
    if (safetyFailure) throw Object.assign(new Error(safetyFailure), { statusCode: 403, mode: "blocked_live_order_safety" })
  }
  if (!willUseRealExchange) {
    const { SimulatedConnector } = await import("@/lib/exchange-connectors/simulated-connector")
    return { connector: new SimulatedConnector({ apiKey: connection.api_key, apiSecret: connection.api_secret, isTestnet: isTruthyFlag(connection.is_testnet) }, "simulated"), mode: "simulated", willUseRealExchange }
  }
  const connector = await createExchangeConnector(connection.exchange, {
    apiKey: connection.api_key,
    apiSecret: connection.api_secret,
    apiPassphrase: connection.api_passphrase || "",
    isTestnet: isTruthyFlag(connection.is_testnet),
    apiType: connection.api_type,
    contractType: connection.contract_type,
  })
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
  await client.hincrby(`live_orders_by_symbol:${connectionId}`, `${symbol}:${direction}:${metric}`, 1)
}

export async function recordLiveOrderProgression(connectionId: string, symbol: string, direction: LiveOrderDirection, event: "placed" | "filled" | "failed" | "simulated", volumeUsd = 0): Promise<void> {
  const client = getRedisClient() as any
  const progKey = `progression:${connectionId}`
  if (event === "placed") await client.hincrby(progKey, "live_orders_placed_count", 1)
  if (event === "filled") {
    await client.hincrby(progKey, "live_orders_filled_count", 1)
    await client.hincrby(progKey, "live_positions_created_count", 1)
    if (volumeUsd) {
      if (typeof client.hincrbyfloat === "function") await client.hincrbyfloat(progKey, "live_volume_usd_total", volumeUsd)
      else await client.hincrby(progKey, "live_volume_usd_total", Math.round(volumeUsd))
    }
  }
  if (event === "failed") await client.hincrby(progKey, "live_orders_failed_count", 1)
  if (event === "simulated") await client.hincrby(progKey, "live_orders_simulated_count", 1)
  if (event !== "simulated") {
    await recordPerSymbolOrderCounter(connectionId, symbol, direction, event)
  } else {
    await recordPerSymbolOrderCounter(connectionId, symbol, direction, "placed")
  }
}

export async function persistLiveOrderPosition(input: { connectionId: string; symbol: string; direction: LiveOrderDirection; quantity: number; leverage?: number; fill: ParsedFill; orderId?: string; existingPosition?: any; livePositionId?: string; status?: string }): Promise<any> {
  let fillPrice = input.fill.filledPrice || 0
  if (!fillPrice) {
    const md = await getMarketData(input.symbol, "1m").catch(() => null as any)
    const latest = md && (md.latest || (Array.isArray(md) ? md[md.length - 1] : null))
    fillPrice = latest ? Number(latest.close ?? latest[4] ?? latest.price ?? 0) || 0 : 0
  }
  const execQty = input.fill.filledQty || input.quantity || 0
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
    status: input.status || (execQty > 0 ? "open" : "placed"),
    fills: execQty > 0 ? [{ timestamp: now, quantity: execQty, price: fillPrice || 0, fee: 0, feeAsset: "" }] : [],
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
  const symbol = String(input.symbol).trim().toUpperCase()
  const direction = normalizeDirection(input.side)
  const exchangeSide = exchangeSideForDirection(direction)
  const { connector, mode, willUseRealExchange } = input.connector
    ? { connector: input.connector, mode: "live" as LiveOrderMode, willUseRealExchange: true }
    : await createLiveOrderConnector(connection, input.safetyPayload || input as any)
  await setupLiveOrderLeverage(connector, symbol, Number(input.leverage || 1))
  const hedgeMode = String(connection.position_mode || "").toLowerCase().includes("hedge") || String(connection.position_mode || "").toLowerCase().includes("dual")
  const options = hedgeMode ? { hedgeMode: true, positionSide: direction === "long" ? "LONG" : "SHORT" } : { hedgeMode: false }
  const result = await connector.placeOrder(symbol, exchangeSide, input.quantity, input.price || 0, input.orderType || "market", options)
  if (!result?.success) {
    if (input.updateCounters !== false) await recordLiveOrderProgression(input.connectionId, symbol, direction, "failed")
    return { success: false, error: result?.error || "Failed to place order", mode, raw: result }
  }
  const orderId = result.orderId || result.order_id || result.id || "N/A"
  const fill = parseOrderFill(result, input.quantity, input.price || 0)
  let position: any = null
  if (!willUseRealExchange) {
    if (input.updateCounters !== false) await recordLiveOrderProgression(input.connectionId, symbol, direction, "simulated")
  } else {
    if (input.persistPosition !== false) position = await persistLiveOrderPosition({ connectionId: input.connectionId, symbol, direction, quantity: input.quantity, leverage: input.leverage, fill, orderId, existingPosition: input.existingPosition, livePositionId: input.livePositionId })
    if (input.updateCounters !== false) {
      await recordLiveOrderProgression(input.connectionId, symbol, direction, "placed")
      if ((position?.executedQuantity || fill.filledQty) > 0) await recordLiveOrderProgression(input.connectionId, symbol, direction, "filled", position?.volumeUsd || (fill.filledQty * fill.filledPrice))
    }
  }
  return { success: true, mode, orderId, symbol, side: exchangeSide, direction, quantity: input.quantity, leverage: input.leverage || 1, fill, position, details: result }
}
