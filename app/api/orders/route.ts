import { type NextRequest, NextResponse } from "next/server"
import { getMarketData, getRedisClient, getSettings, setSettings } from "@/lib/redis-db"
import { auditLogger } from "@/lib/audit-logger"
import { apiErrorHandler, ApiError } from "@/lib/api-error-handler"
import { SystemLogger } from "@/lib/system-logger"

// API Category - used in all responses for type tracking
const API_CATEGORY = "trading.orders"

// Order validation constants
const ORDER_LIMITS = {
  MAX_AMOUNT_USDT: 100000, // Max $100k per order
  MAX_QUANTITY: 1000000, // Max 1M units per order
  MIN_AMOUNT_USDT: 10, // Min $10 per order
  MAX_ORDERS_PER_MINUTE: 500, // Maximum rate limit - no practical limit
}

const ORDER_INDEX_KEY = "orders:index"
const orderKey = (orderId: string) => `order:${orderId}`
const connectionIndexKey = (connectionId: string) => `orders:connection:${connectionId}`
const statusIndexKey = (status: string) => `orders:status:${status}`

// Settings hashes flatten arrays into index-keyed fields ("0","1",...), so
// a legacy stored order list round-trips back as an OBJECT, not an array. Coerce
// either shape into a real array for GET fallback compatibility only; POST no
// longer rewrites this shared list because concurrent handlers can lose writes.
function toOrderArray(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === "object") return Object.values(raw)
  return []
}

function parseOrder(raw: string | null): any | null {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function readIndexedOrders({ status, connectionId, limit }: { status?: string | null; connectionId?: string | null; limit: number }) {
  const redis = getRedisClient()
  const indexKey = status ? statusIndexKey(status) : connectionId ? connectionIndexKey(connectionId) : ORDER_INDEX_KEY
  const orderIds = await redis.zrange(indexKey, 0, Math.max(limit - 1, 0))
  if (orderIds.length === 0) return []

  const values = await redis.mget(...orderIds.map(orderKey))
  return values.map(parseOrder).filter(Boolean)
}

async function writeOrder(newOrder: any) {
  const redis = getRedisClient()
  const createdScore = Date.parse(newOrder.created_at)
  const score = Number.isFinite(createdScore) ? createdScore : Date.now()

  if (redis && typeof redis.multi === "function") {
    await redis
      .multi()
      .set(orderKey(newOrder.id), JSON.stringify(newOrder))
      .zadd(ORDER_INDEX_KEY, score, newOrder.id)
      .zadd(connectionIndexKey(newOrder.connection_id), score, newOrder.id)
      .zadd(statusIndexKey(newOrder.status), score, newOrder.id)
      .exec()
    return
  }

  // Test/minimal Redis clients may not expose MULTI/ZADD. Keep the legacy
  // settings-list fallback so order creation remains functional in those
  // environments while production still uses indexed atomic writes above.
  const legacyOrders = toOrderArray(await getSettings("orders").catch(() => []))
  legacyOrders.push(newOrder)
  await setSettings("orders", legacyOrders)
}

// Simple per-user rate limiter for order creation
const orderTimestamps = new Map<string, number[]>()

function checkOrderRateLimit(userId: string): boolean {
  const now = Date.now()
  const timestamps = orderTimestamps.get(userId) || []
  // Remove timestamps older than 1 minute
  const recent = timestamps.filter((ts) => now - ts < 60000)
  if (recent.length >= ORDER_LIMITS.MAX_ORDERS_PER_MINUTE) {
    return false
  }
  recent.push(now)
  orderTimestamps.set(userId, recent)
  return true
}

function extractCurrentPrice(marketData: any): number | null {
  if (!marketData) return null

  const candidates: any[] = []
  if (Array.isArray(marketData)) {
    candidates.push(marketData[marketData.length - 1])
  } else {
    candidates.push(
      marketData.latest,
      Array.isArray(marketData.candles) ? marketData.candles[marketData.candles.length - 1] : null,
      marketData,
    )
  }

  for (const candidate of candidates) {
    if (!candidate) continue
    const raw = Array.isArray(candidate)
      ? candidate[4]
      : candidate.close ?? candidate.price ?? candidate.last ?? candidate.markPrice
    const price = Number.parseFloat(String(raw ?? ""))
    if (Number.isFinite(price) && price > 0) return price
  }

  return null
}

async function getCurrentMarketPrice(symbol: string): Promise<number | null> {
  const normalizedSymbol = symbol.toUpperCase()
  const marketData = await getMarketData(normalizedSymbol, "1m").catch(() => null)
  const cachedPrice = extractCurrentPrice(marketData)
  if (cachedPrice) return cachedPrice

  const client = getRedisClient()
  if (!client) return null

  const closeRaw = await client.hget(`market_data:${normalizedSymbol}`, "close").catch(() => null)
  const hashPrice = Number.parseFloat(String(closeRaw ?? ""))
  return Number.isFinite(hashPrice) && hashPrice > 0 ? hashPrice : null
}

async function validateOrder(order: any): Promise<{ valid: boolean; error?: string }> {
  if (!order.quantity || typeof order.quantity !== "number") {
    return { valid: false, error: "Invalid quantity" }
  }

  if (order.quantity <= 0) {
    return { valid: false, error: "Quantity must be positive" }
  }

  if (order.quantity > ORDER_LIMITS.MAX_QUANTITY) {
    return { valid: false, error: `Quantity exceeds limit of ${ORDER_LIMITS.MAX_QUANTITY}` }
  }

  // For limit orders, validate price
  if (order.order_type === "limit" && (!order.price || typeof order.price !== "number")) {
    return { valid: false, error: "Limit orders require a price" }
  }

  if (order.price && order.price <= 0) {
    return { valid: false, error: "Price must be positive" }
  }

  // Estimate order value for both limit and market orders. Limit orders use
  // the submitted price; market orders must have a current Redis price so they
  // cannot bypass notional risk controls as unbounded or dust-sized orders.
  const orderType = order.order_type?.toLowerCase()
  const notionalPrice = orderType === "market" ? await getCurrentMarketPrice(order.symbol) : order.price

  if (orderType === "market" && !notionalPrice) {
    return { valid: false, error: "Current market price unavailable for market order notional validation" }
  }

  if (notionalPrice && order.quantity) {
    const orderValue = notionalPrice * order.quantity
    if (orderValue > ORDER_LIMITS.MAX_AMOUNT_USDT) {
      return { valid: false, error: `Order value exceeds limit of $${ORDER_LIMITS.MAX_AMOUNT_USDT}` }
    }
    if (orderValue < ORDER_LIMITS.MIN_AMOUNT_USDT) {
      return { valid: false, error: `Order value below minimum of $${ORDER_LIMITS.MIN_AMOUNT_USDT}` }
    }
  }

  if (!["BUY", "SELL"].includes(order.side?.toUpperCase() || "")) {
    return { valid: false, error: "Side must be BUY or SELL" }
  }

  if (!["limit", "market"].includes(order.order_type?.toLowerCase() || "")) {
    return { valid: false, error: "Order type must be limit or market" }
  }

  return { valid: true }
}

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const status = searchParams.get("status")
    const limit = Math.min(Number.parseInt(searchParams.get("limit") || "50"), 500)

    const connectionId = searchParams.get("connection_id")

    if (status && !["pending", "filled", "partially_filled", "cancelled", "rejected"].includes(status)) {
      throw new ApiError("Invalid status filter", {
        statusCode: 400,
        code: "VALIDATION_ERROR",
        details: { status },
      })
    }

    let filtered = await readIndexedOrders({ status, connectionId, limit })

    // Legacy compatibility for deployments that still only have the old
    // settings-backed list. New POST writes never use this path.
    if (filtered.length === 0) {
      filtered = toOrderArray(await getSettings("orders"))
      if (status) filtered = filtered.filter((o: any) => o.status === status)
      if (connectionId) filtered = filtered.filter((o: any) => o.connection_id === connectionId)
      filtered = filtered.slice(0, limit)
    }

    return NextResponse.json({
      success: true,
      category: API_CATEGORY,
      timestamp: new Date().toISOString(),
      data: filtered,
      count: filtered.length,
    })
  } catch (error) {
    console.error("[v0] Get orders error:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error",
        category: API_CATEGORY,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    // Rate limit check (keyed on system since no user session)
    const isAllowed = checkOrderRateLimit("system")
    if (!isAllowed) {
      return NextResponse.json(
        {
          success: false,
          error: "Rate limit exceeded: max 500 orders per minute",
          category: API_CATEGORY,
          timestamp: new Date().toISOString(),
        },
        { status: 429 }
      )
    }

    let bodyData
    try {
      bodyData = await request.json()
    } catch (e) {
      return NextResponse.json(
        { success: false, error: "Invalid JSON in request body", category: API_CATEGORY },
        { status: 400 }
      )
    }

    const { connection_id, symbol, order_type, side, price, quantity, time_in_force } = bodyData

    // Required field validation
    if (!connection_id || !symbol || !order_type || !side || !quantity) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required fields: connection_id, symbol, order_type, side, quantity",
          category: API_CATEGORY,
        },
        { status: 400 }
      )
    }

    // Order validation
    const validation = await validateOrder({ quantity, price, order_type, side, symbol })
    if (!validation.valid) {
      console.warn(`Order validation failed: ${validation.error}`)
      return NextResponse.json(
        { success: false, error: validation.error, category: API_CATEGORY },
        { status: 400 }
      )
    }

    // Symbol validation (basic format check)
    if (typeof symbol !== "string" || symbol.length < 2 || symbol.length > 20) {
      return NextResponse.json(
        { success: false, error: "Invalid symbol format", category: API_CATEGORY },
        { status: 400 }
      )
    }

    const newOrder = {
      id: `order:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`,
      user_id: "system",
      connection_id,
      symbol: symbol.toUpperCase(),
      order_type: order_type.toLowerCase(),
      side: side.toUpperCase(),
      price: price || null,
      quantity,
      remaining_quantity: quantity,
      time_in_force: time_in_force || "GTC",
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    // Log order creation for audit
    await auditLogger.log({
      user_id: "system",
      action: "order_create",
      entity_type: "order",
      entity_id: newOrder.id,
      details: {
        symbol: newOrder.symbol,
        side: newOrder.side,
        quantity: newOrder.quantity,
        price: newOrder.price,
        order_type: newOrder.order_type,
      },
      status: "success",
      connection_id,
    })

    console.log(
      `[v0] [Audit] Order created: ${symbol} ${side} ${quantity}@${price || "market"}`
    )

    await writeOrder(newOrder)

    return NextResponse.json({
      success: true,
      category: API_CATEGORY,
      timestamp: new Date().toISOString(),
      data: newOrder,
    })
  } catch (error) {
    console.error("[v0] Create order error:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Internal server error",
        category: API_CATEGORY,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  }
}
