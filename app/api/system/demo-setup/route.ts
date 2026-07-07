import { NextResponse } from "next/server"
import { initRedis, getAllConnections, updateConnection, getRedisClient, setSettings } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/system/demo-setup
 * Sets up a demo connection with credentials for testing the complete workflow.
 * This endpoint is for development/testing purposes only.
 * 
 * Steps:
 * 1. Find or create a BingX/Bybit connection
 * 2. Add demo credentials (user provides real API keys)
 * 3. Enable the connection for trading
 * 4. Add to Active panel
 * 5. Enable dashboard processing
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const { api_key, api_secret, exchange = "bingx" } = body

    console.log("[v0] [DemoSetup] Starting demo setup for exchange:", exchange)

    // Validate required fields
    if (!api_key || !api_secret) {
      return NextResponse.json({
        success: false,
        error: "API key and secret are required",
        message: "Provide api_key and api_secret in the request body",
        example: {
          api_key: "your-api-key",
          api_secret: "your-api-secret",
          exchange: "bingx" // or "bybit"
        }
      }, { status: 400 })
    }

    await initRedis()
    const allConnections = await getAllConnections()

    // Find existing connection for the exchange or use first predefined
    let connection = allConnections.find((c: any) => {
      const exch = (c.exchange || "").toLowerCase()
      return exch === exchange.toLowerCase()
    })

    if (!connection) {
      return NextResponse.json({
        success: false,
        error: `No ${exchange} connection found`,
        availableExchanges: [...new Set(allConnections.map((c: any) => c.exchange))]
      }, { status: 404 })
    }

    console.log("[v0] [DemoSetup] Found connection:", connection.name, connection.id)

    // Update connection with credentials and enable everything
    const updatedConnection = {
      ...connection,
      api_key,
      api_secret,
      is_testnet: false, // Always mainnet
      is_enabled: "1", // Enable in Settings
      is_inserted: "1", // Marked as inserted
      is_active_inserted: "1", // In Active panel
      is_dashboard_inserted: "1", // Available in dashboard
      is_enabled_dashboard: "1", // Dashboard toggle ON - START PROCESSING
      is_active: "1", // Active status
      is_live_trade: "0", // Live trade still off until explicitly enabled
      updated_at: new Date().toISOString(),
    }

    await updateConnection(connection.id, updatedConnection)
    console.log("[v0] [DemoSetup] Connection updated with credentials")

    // Log progression event
    await logProgressionEvent(connection.id, "demo_setup", "info", "Demo setup completed - connection ready for processing", {
      connectionId: connection.id,
      connectionName: connection.name,
      exchange: connection.exchange,
      dashboardEnabled: true,
    })

    // Set engine progression state
    await setSettings(`engine_progression:${connection.id}`, {
      phase: "ready",
      progress: 0,
      connectionId: connection.id,
      connectionName: connection.name,
      exchange: connection.exchange,
      detail: "Connection ready. Dashboard processing enabled.",
      updated_at: new Date().toISOString(),
    })

    // Store last demo setup for reference
    const client = getRedisClient()
    await client.set("demo_setup:last", JSON.stringify({
      connectionId: connection.id,
      connectionName: connection.name,
      exchange: connection.exchange,
      timestamp: new Date().toISOString(),
    }))

    console.log("[v0] [DemoSetup] Complete - connection ready for processing")

    return NextResponse.json({
      success: true,
      message: "Demo setup complete! Connection is now ready for processing.",
      connection: {
        id: connection.id,
        name: connection.name,
        exchange: connection.exchange,
        status: {
          is_enabled: true,
          is_active_inserted: true,
          is_enabled_dashboard: true,
          hasCredentials: true,
        }
      },
      nextSteps: [
        "The engine will automatically start processing this connection",
        "View progress in the Dashboard -> Active Connections panel",
        "Monitor progression logs in the sidebar",
      ]
    })

  } catch (error) {
    console.error("[v0] [DemoSetup] Error:", error)
    return NextResponse.json({
      success: false,
      error: "Demo setup failed",
      details: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 })
  }
}

/**
 * GET /api/system/demo-setup
 * Returns current demo setup status and instructions
 */
export async function GET() {
  try {
    await initRedis()
    const allConnections = await getAllConnections()

    // Find connections with credentials
    const connectionsWithCredentials = allConnections.filter((c: any) => {
      const hasKey = !!(c.api_key) && c.api_key.length > 10
      const hasSecret = !!(c.api_secret) && c.api_secret.length > 10
      return hasKey && hasSecret
    })

    // Find connections ready for processing (all flags set)
    const readyForProcessing = connectionsWithCredentials.filter((c: any) => {
      const isActiveInserted = c.is_active_inserted === "1" || c.is_active_inserted === true
      const isDashboardEnabled = c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true
      return isActiveInserted && isDashboardEnabled
    })

    const client = getRedisClient()
    const lastSetupRaw = await client.get("demo_setup:last")
    const lastSetup = lastSetupRaw ? JSON.parse(String(lastSetupRaw)) : null

    return NextResponse.json({
      status: readyForProcessing.length > 0 ? "ready" : "needs_setup",
      totalConnections: allConnections.length,
      connectionsWithCredentials: connectionsWithCredentials.length,
      readyForProcessing: readyForProcessing.length,
      lastSetup,
      availableExchanges: [...new Set(allConnections.map((c: any) => c.exchange))],
      instructions: {
        endpoint: "POST /api/system/demo-setup",
        body: {
          api_key: "your-exchange-api-key",
          api_secret: "your-exchange-api-secret",
          exchange: "bingx" // or "bybit", "binance", "okx"
        },
        description: "Provide your real exchange API credentials to set up a connection for testing"
      }
    })
  } catch (error) {
    return NextResponse.json({
      error: "Failed to check demo setup status",
      details: error instanceof Error ? error.message : "Unknown error"
    }, { status: 500 })
  }
}
