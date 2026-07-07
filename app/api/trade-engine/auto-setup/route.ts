import { NextResponse } from "next/server"
import { getAllConnections, initRedis, updateConnection } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/trade-engine/auto-setup
 * Automatically adds BingX to active connections on startup if credentials exist
 */
export async function POST(request: Request) {
  try {
    await initRedis()
    const allConnections = await getAllConnections()

    console.log(`[v0] [AutoSetup] Scanning ${allConnections.length} connections for auto-setup...`)

    // Find BingX connection with credentials
    const bingxConnection = allConnections.find((c: any) => {
      const exch = (c.exchange || "").toLowerCase()
      const hasCredentials = !!(c.api_key && c.api_secret && c.api_key.length >= 10 && c.api_secret.length >= 10)
      return exch === "bingx" && hasCredentials
    })

    if (!bingxConnection) {
      console.log(`[v0] [AutoSetup] No BingX connection with credentials found`)
      return NextResponse.json({
        success: false,
        message: "No BingX connection with credentials found",
        availableConnections: allConnections.map((c: any) => ({
          name: c.name,
          exchange: c.exchange,
          hasCredentials: !!(c.api_key && c.api_secret && c.api_key.length >= 10),
        })),
      })
    }

    // Check if already in active connections (multiple ways it might be flagged)
    const isAlreadyActive = (bingxConnection.is_active_inserted === "1" || bingxConnection.is_active_inserted === true) &&
                            (bingxConnection.is_active === "1" || bingxConnection.is_active === true)
    
    if (isAlreadyActive) {
      console.log(`[v0] [AutoSetup] ${bingxConnection.name} is already in active connections`)
      return NextResponse.json({
        success: true,
        alreadyActive: true,
        message: `${bingxConnection.name} already active`,
        connection: {
          id: bingxConnection.id,
          name: bingxConnection.name,
          exchange: bingxConnection.exchange,
          isActive: true,
        },
      })
    }

    // Add to active connections (ALWAYS disable testnet for mainnet trading)
    console.log(`[v0] [AutoSetup] Adding ${bingxConnection.name} to active connections (mainnet only)...`)
    const updated = {
      ...bingxConnection,
      is_active_inserted: "1",
      is_active: "1",
      is_inserted: "1",
      is_enabled: "1",
      is_testnet: false, // FORCE mainnet - never use testnet
      updated_at: new Date().toISOString(),
    }

    await updateConnection(bingxConnection.id, updated)

    console.log(`[v0] [AutoSetup] Successfully added ${bingxConnection.name} to active connections`)

    return NextResponse.json({
      success: true,
      alreadyActive: false,
      message: `${bingxConnection.name} added to active connections`,
      connection: {
        id: bingxConnection.id,
        name: bingxConnection.name,
        exchange: bingxConnection.exchange,
        testBalance: bingxConnection.last_test_balance,
        testStatus: bingxConnection.last_test_status,
        isActive: true,
      },
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[v0] [AutoSetup] Error:`, errorMsg)

    return NextResponse.json(
      {
        success: false,
        error: "Auto setup failed",
        details: errorMsg,
      },
      { status: 500 }
    )
  }
}
