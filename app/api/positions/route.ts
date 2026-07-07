import { type NextRequest, NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"

export const dynamic = "force-dynamic"

/**
 * GET /api/positions - Get positions for a connection with filtering
 * Query params: connection_id, status, symbol, limit, offset
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now()
  try {
    await initRedis()
    const { searchParams } = new URL(request.url)
    // Accept both snake_case (connection_id) and camelCase (connectionId)
    const connectionId = searchParams.get("connection_id") ?? searchParams.get("connectionId")
    const status = searchParams.get("status") || "all"
    const symbol = searchParams.get("symbol")
    const limit = Math.min(parseInt(searchParams.get("limit") || "100"), 1000)
    const offset = parseInt(searchParams.get("offset") || "0")

    // When no connectionId is provided, return an empty positions list rather
    // than a 400 — callers that poll the endpoint without context (e.g. generic
    // dashboards or health checks) get a valid empty response instead of an error.
    if (!connectionId) {
      return NextResponse.json({
        success: true,
        positions: [],
        total: 0,
        open: 0,
        closed: 0,
        note: "No connection_id supplied — pass connection_id or connectionId query param to filter",
      })
    }

    const client = getRedisClient()

    // Fetch live positions from the live-stage index (primary store).
    // live-stage stores positions as JSON strings at live:position:{id}
    // with an open-index LIST at live:positions:{connId}.
    const positions: any[] = []
    let processed = 0

    // --- Primary: live positions open index (LIST) ---
    const liveOpenIds = await client.lrange(`live:positions:${connectionId}`, 0, -1).catch(() => [] as string[])
    for (const posId of liveOpenIds) {
      const raw = await client.get(`live:position:${posId}`).catch(() => null)
      if (!raw) continue
      let pos: any
      try { pos = JSON.parse(raw) } catch { continue }
      processed++
      if (status !== "all" && status !== "open" && pos.status !== status) continue
      if (symbol && pos.symbol !== symbol) continue
      positions.push({ ...pos, id: posId, _source: "live_open" })
    }

    // --- Secondary: live positions closed index (LIST), only when status filter allows ---
    if (status === "all" || status === "closed") {
      const closedIds = await client.lrange(`live:positions:${connectionId}:closed`, 0, 99).catch(() => [] as string[])
      for (const posId of closedIds) {
        const raw = await client.get(`live:position:${posId}`).catch(() => null)
        if (!raw) continue
        let pos: any
        try { pos = JSON.parse(raw) } catch { continue }
        processed++
        if (symbol && pos.symbol !== symbol) continue
        positions.push({ ...pos, id: posId, _source: "live_closed" })
      }
    }

    // --- Tertiary: legacy positions SET (non-live, manually created via POST) ---
    const legacyIds = await client.smembers(`positions:${connectionId}`).catch(() => [] as string[])
    for (const posId of legacyIds) {
      const pos = await client.hgetall(`position:${connectionId}:${posId}`).catch(() => null)
      if (!pos || Object.keys(pos).length === 0) continue
      processed++
      if (status !== "all" && pos.status !== status) continue
      if (symbol && pos.symbol !== symbol) continue
      positions.push({ ...pos, id: posId, _source: "legacy" })
    }

    // Deduplicate positions by ID (same position might appear from multiple sources)
    const seenIds = new Set<string>()
    const deduped: any[] = []
    for (const pos of positions) {
      if (!seenIds.has(pos.id)) {
        seenIds.add(pos.id)
        deduped.push(pos)
      }
    }
    
    // Apply pagination
    const paginated = deduped.slice(offset, offset + limit)

    await logProgressionEvent(
      connectionId,
      "positions_api",
      "info",
      `Fetched ${paginated.length} positions`,
      { total: positions.length, processed, offset, limit, filters: { status, symbol } }
    )

    return NextResponse.json({
      success: true,
      data: paginated,
      count: paginated.length,
      total: deduped.length,
      limit,
      offset,
      duration: Date.now() - startTime,
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error("[v0] [PositionsAPI] GET error:", errorMsg)
    
    await logProgressionEvent(
      "system",
      "positions_api_error",
      "error",
      `GET /api/positions error: ${errorMsg}`
    )

    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch positions",
        details: process.env.NODE_ENV === "development" ? errorMsg : undefined,
      },
      { status: 500 }
    )
  }
}

/**
 * POST /api/positions - Create new position
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now()
  try {
    await initRedis()
    const body = await request.json()
    
    const {
      connection_id,
      symbol,
      position_type,
      entry_price,
      quantity,
      leverage,
      stop_loss,
      take_profit,
      margin_type,
      side,
      trade_mode,
    } = body

    // Validate required fields
    if (!connection_id || !symbol || !position_type || !entry_price || !quantity) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required fields",
          required: ["connection_id", "symbol", "position_type", "entry_price", "quantity"],
        },
        { status: 400 }
      )
    }

    // Validate numeric fields
    if (isNaN(parseFloat(entry_price)) || isNaN(parseFloat(quantity))) {
      return NextResponse.json({ success: false, error: "entry_price and quantity must be valid numbers" }, { status: 400 })
    }

    const client = getRedisClient()
    const posId = `pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    // Store position
    // NOTE: This endpoint creates positions WITHOUT system_tracking_id.
    // These are "foreign" positions from manual entry and will be ignored
    // by automatic management (updates, closes, syncing). Operators must
    // manually manage these positions or use the automated system endpoints.
    await client.hset(`position:${connection_id}:${posId}`, {
      id: posId,
      connection_id,
      symbol,
      position_type,
      entry_price: String(entry_price),
      current_price: String(entry_price),
      quantity: String(quantity),
      leverage: String(leverage || 1),
      stop_loss: String(stop_loss || ""),
      take_profit: String(take_profit || ""),
      margin_type: margin_type || "isolated",
      side: side || "long",
      trade_mode: trade_mode || "main",
      status: "open",
      opened_at: new Date().toISOString(),
      pnl: "0",
      pnl_percent: "0",
    })

    // Add to position set for this connection
    await client.sadd(`positions:${connection_id}`, posId)

    await logProgressionEvent(
      connection_id,
      "positions_api",
      "info",
      `Created position ${posId}`,
      { symbol, position_type, entry_price, quantity, leverage }
    )

    return NextResponse.json({
      success: true,
      data: { id: posId, status: "open" },
      duration: Date.now() - startTime,
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error("[v0] [PositionsAPI] POST error:", errorMsg)

    return NextResponse.json(
      {
        success: false,
        error: "Failed to create position",
        details: process.env.NODE_ENV === "development" ? errorMsg : undefined,
      },
      { status: 500 }
    )
  }
}
