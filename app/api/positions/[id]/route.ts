import { NextResponse, type NextRequest } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"

export const dynamic = "force-dynamic"

/**
 * GET /api/positions/[id] - Get specific position details
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: positionId } = await params
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connection_id") || searchParams.get("connectionId")

    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connection_id required" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient()

    // Live positions are stored as JSON strings at live:position:{id}.
    // The id from live-stage always starts with "live:" (e.g. "live:bingx-x01:BTCUSDT:long:...").
    // Try the live store first, then fall back to the legacy hash.
    let position: any = null

    const liveRaw = await client.get(`live:position:${positionId}`).catch(() => null)
    if (liveRaw) {
      try { position = JSON.parse(liveRaw) } catch { /* fall through */ }
    }

    if (!position) {
      // Fallback: legacy hash store (non-live / manually created positions)
      const hash = await client.hgetall(`position:${connectionId}:${positionId}`).catch(() => null)
      if (hash && Object.keys(hash).length > 0) {
        position = { ...hash }
      }
    }

    if (!position) {
      return NextResponse.json(
        { success: false, error: "Position not found" },
        { status: 404 }
      )
    }

    await logProgressionEvent(
      connectionId,
      "positions_api",
      "info",
      `Fetched position ${positionId}`,
      { symbol: position.symbol, status: position.status }
    )

    return NextResponse.json({
      success: true,
      data: { ...position, id: positionId },
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error("[v0] [PositionsAPI] GET detail error:", errorMsg)
    
    return NextResponse.json(
      { success: false, error: "Failed to fetch position", details: process.env.NODE_ENV === "development" ? errorMsg : undefined },
      { status: 500 }
    )
  }
}

/**
 * PATCH /api/positions/[id] - Update position (price, stop-loss, take-profit)
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: positionId } = await params
    const body = await request.json()
    const { connection_id, current_price, stop_loss, take_profit } = body

    if (!connection_id) {
      return NextResponse.json({ success: false, error: "connection_id required" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient()

    // Try live store first, then legacy hash.
    let isLive = false
    let position: any = null
    const liveRaw = await client.get(`live:position:${positionId}`).catch(() => null)
    if (liveRaw) {
      try { position = JSON.parse(liveRaw); isLive = true } catch { /* fall through */ }
    }
    if (!position) {
      const hash = await client.hgetall(`position:${connection_id}:${positionId}`).catch(() => null)
      if (hash && Object.keys(hash).length > 0) position = { ...hash }
    }
    if (!position) {
      return NextResponse.json({ success: false, error: "Position not found" }, { status: 404 })
    }

    // Calculate PnL if price updated
    let updates: Record<string, string> = {}
    
    if (current_price !== undefined) {
      updates.current_price = String(current_price)
      
      const entry = parseFloat(position.entry_price)
      const current = parseFloat(current_price)
      const qty = parseFloat(position.quantity)
      const pnl = (current - entry) * qty
      const pnlPercent = ((current - entry) / entry) * 100
      
      updates.pnl = String(pnl.toFixed(2))
      updates.pnl_percent = String(pnlPercent.toFixed(2))
    }

    if (stop_loss !== undefined) updates.stop_loss = String(stop_loss)
    if (take_profit !== undefined) updates.take_profit = String(take_profit)
    
    updates.updated_at = new Date().toISOString()

    // Write back to the correct store
    if (isLive) {
      const updated = { ...position, ...updates, updatedAt: Date.now() }
      try {
        await client.set(`live:position:${positionId}`, JSON.stringify(updated), ({ ex: 7 * 24 * 60 * 60 } as any))
      } catch {
        await client.set(`live:position:${positionId}`, JSON.stringify(updated))
      }
    } else {
      await client.hset(`position:${connection_id}:${positionId}`, updates)
    }

    await logProgressionEvent(
      connection_id,
      "positions_api",
      "info",
      `Updated position ${positionId}`,
      { updates }
    )

    return NextResponse.json({
      success: true,
      data: { ...position, ...updates, id: positionId },
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error("[v0] [PositionsAPI] PATCH error:", errorMsg)
    
    return NextResponse.json(
      { success: false, error: "Failed to update position", details: process.env.NODE_ENV === "development" ? errorMsg : undefined },
      { status: 500 }
    )
  }
}

/**
 * DELETE /api/positions/[id] - Close/delete position
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: positionId } = await params
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connection_id")
    const closePrice = searchParams.get("close_price")
    const closeReason = searchParams.get("close_reason") || "manual"

    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connection_id required" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient()

    // Try live store first, then legacy hash.
    let isLivePosition = false
    let position: any = null
    const liveRawD = await client.get(`live:position:${positionId}`).catch(() => null)
    if (liveRawD) {
      try { position = JSON.parse(liveRawD); isLivePosition = true } catch { /* fall through */ }
    }
    if (!position) {
      const hash = await client.hgetall(`position:${connectionId}:${positionId}`).catch(() => null)
      if (hash && Object.keys(hash).length > 0) {
        position = { ...hash }
        isLivePosition = !!(position.connectionId && (position.orderId || position.status === "filled"))
      }
    }
    if (!position) {
      return NextResponse.json({ success: false, error: "Position not found" }, { status: 404 })
    }

    console.log(`[v0] [PositionsAPI] DELETE: Closing position ${positionId} via API (reason: ${closeReason})`)
    
    if (isLivePosition && closePrice) {
      // For live positions with close price, use the live-stage close logic
      try {
        const { closeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
        let connector: any = undefined
        if (String(position.status || "") !== "simulated") {
          const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
          connector = await exchangeConnectorFactory.getOrCreateConnector(connectionId)
          if (!connector) {
            return NextResponse.json(
              { success: false, error: "Exchange connector unavailable; position remains open" },
              { status: 503 },
            )
          }
        }
        const closedPos = await closeLivePosition(
          connectionId,
          positionId,
          parseFloat(closePrice),
          connector,
          closeReason
        )
        
        if (closedPos) {
          console.log(`[v0] [PositionsAPI] Successfully closed live position via live-stage`)
          return NextResponse.json({
            success: true,
            data: {
              id: positionId,
              status: "closed",
              closeReason: closeReason,
              final_pnl: closedPos.realizedPnL?.toFixed(2) || "0",
            },
          })
        }
        return NextResponse.json(
          { success: false, error: "Exchange close was not confirmed; position remains open" },
          { status: 409 },
        )
      } catch (err) {
        console.error(`[v0] [PositionsAPI] Failed to use live-stage close:`, err)
        return NextResponse.json(
          { success: false, error: "Live position close failed; position remains open" },
          { status: 502 },
        )
      }
    }

    if (isLivePosition) {
      return NextResponse.json(
        { success: false, error: "close_price required for a live position" },
        { status: 400 },
      )
    }

    // Fallback: Basic close for pseudo positions or when live-stage unavailable
    const finalPrice = closePrice ? parseFloat(closePrice) : parseFloat(position.current_price || "0")
    const entry = parseFloat(position.entry_price || "0")
    const qty = parseFloat(position.quantity || "0")
    const direction = String(position.direction || position.side || "long").toLowerCase()
    const finalPnL = (direction === "short" ? entry - finalPrice : finalPrice - entry) * qty

    // Mark as closed with comprehensive metadata
    await client.hset(`position:${connectionId}:${positionId}`, {
      status: "closed",
      close_price: String(finalPrice),
      final_pnl: String(finalPnL.toFixed(2)),
      close_reason: closeReason,
      closed_at: new Date().toISOString(),
      closed_via: "api",
    })

    await logProgressionEvent(
      connectionId,
      "positions_api",
      "info",
      `Closed position ${positionId} via API`,
      { symbol: position.symbol, final_pnl: finalPnL, reason: closeReason }
    )

    console.log(`[v0] [PositionsAPI] Closed position ${positionId}: PnL=${finalPnL.toFixed(2)} reason=${closeReason}`)

    return NextResponse.json({
      success: true,
      data: { id: positionId, status: "closed", final_pnl: finalPnL.toFixed(2), close_reason: closeReason },
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error("[v0] [PositionsAPI] DELETE error:", errorMsg)
    
    return NextResponse.json(
      { success: false, error: "Failed to close position", details: process.env.NODE_ENV === "development" ? errorMsg : undefined },
      { status: 500 }
    )
  }
}
