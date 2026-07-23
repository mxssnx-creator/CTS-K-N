import { NextResponse } from "next/server"
import { getAllConnections, updateConnection, initRedis } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/**
 * POST /api/admin/enable-live-trading
 * Enable live trading on all connections system-wide
 * Sets is_live_trade=1 on all configured connections
 */
export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get("authorization")
    const secret = process.env.CRON_SECRET || process.env.API_SECRET
    
    // Validate authorization if secret is configured
    if (secret && authHeader !== `Bearer ${secret}`) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      )
    }

    await initRedis()
    const connections = await getAllConnections()
    
    if (!connections || connections.length === 0) {
      return NextResponse.json({
        success: false,
        error: "No connections found",
        updated: [],
      }, { status: 404 })
    }

    const updated: any[] = []
    
    for (const connection of connections) {
      try {
        const currentLiveTradeStatus = connection.is_live_trade
        
        // Update to enable live trading
        await updateConnection(connection.id, {
          is_live_trade: "1",
          live_trade_enabled: "1",
        })
        
        updated.push({
          id: connection.id,
          name: connection.name,
          exchange: connection.exchange,
          previousStatus: currentLiveTradeStatus,
          newStatus: "1",
          success: true,
        })
      } catch (error) {
        updated.push({
          id: connection.id,
          name: connection.name,
          exchange: connection.exchange,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        })
      }
    }

    const successCount = updated.filter(u => u.success).length
    const failureCount = updated.filter(u => !u.success).length

    return NextResponse.json({
      success: successCount === updated.length,
      message: `Live trading enabled on ${successCount}/${updated.length} connections`,
      updated,
      successCount,
      failureCount,
    })
  } catch (error) {
    console.error("[v0] Error enabling live trading:", error)
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : "Failed to enable live trading",
        updated: [],
      },
      { status: 500 }
    )
  }
}

/**
 * GET /api/admin/enable-live-trading
 * Check current live trading status across all connections
 */
export async function GET() {
  try {
    await initRedis()
    const connections = await getAllConnections()
    
    const status = connections.map(conn => ({
      id: conn.id,
      name: conn.name,
      exchange: conn.exchange,
      is_live_trade: conn.is_live_trade,
      live_trade_enabled: conn.live_trade_enabled,
      isEnabled: conn.is_live_trade === "1" || conn.is_live_trade === true,
    }))

    const enabledCount = status.filter(s => s.isEnabled).length
    const totalCount = status.length

    return NextResponse.json({
      success: true,
      status,
      enabledCount,
      totalCount,
      allEnabled: enabledCount === totalCount && totalCount > 0,
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get live trading status",
        status: [],
      },
      { status: 500 }
    )
  }
}
