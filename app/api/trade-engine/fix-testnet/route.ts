import { NextResponse } from "next/server"
import { getAllConnections, initRedis, updateConnection } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/trade-engine/fix-testnet
 * Fixes all BingX/Bybit connections to use mainnet (is_testnet = false)
 */
export async function POST(request: Request) {
  try {
    await initRedis()
    const allConnections = await getAllConnections()

    console.log(`[v0] [FixTestnet] Scanning ${allConnections.length} connections...`)

    // Find all BingX/Bybit connections with is_testnet = true
    const connectionsToFix = allConnections.filter((c: any) => {
      const exch = (c.exchange || "").toLowerCase()
      const isMainExchange = exch === "bingx" || exch === "bybit" || exch === "okx"
      const hasTestnetEnabled = c.is_testnet === true || c.is_testnet === "1" || c.is_testnet === "true"
      return isMainExchange && hasTestnetEnabled
    })

    if (connectionsToFix.length === 0) {
      console.log(`[v0] [FixTestnet] No connections need fixing - all are mainnet`)
      return NextResponse.json({
        success: true,
        fixed: 0,
        message: "All connections already use mainnet",
      })
    }

    console.log(`[v0] [FixTestnet] Found ${connectionsToFix.length} connections to fix...`)

    // Fix each connection
    const fixedConnections = []
    for (const conn of connectionsToFix) {
      const updated = {
        ...conn,
        is_testnet: false,
        updated_at: new Date().toISOString(),
      }
      await updateConnection(conn.id, updated)
      fixedConnections.push({
        id: conn.id,
        name: conn.name,
        exchange: conn.exchange,
      })
      console.log(`[v0] [FixTestnet] Fixed ${conn.name} - mainnet enabled`)
    }

    return NextResponse.json({
      success: true,
      fixed: fixedConnections.length,
      message: `Fixed ${fixedConnections.length} connection(s) to use mainnet`,
      connections: fixedConnections,
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[v0] [FixTestnet] Error:`, errorMsg)

    return NextResponse.json(
      {
        success: false,
        error: "Testnet fix failed",
        details: errorMsg,
      },
      { status: 500 }
    )
  }
}
