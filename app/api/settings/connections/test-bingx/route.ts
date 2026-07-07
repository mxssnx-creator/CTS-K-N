import { NextResponse } from "next/server"
import { getAllConnections, initRedis } from "@/lib/redis-db"
import { BingXConnector } from "@/lib/exchange-connectors/bingx-connector"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/settings/connections/test-bingx
 * Quick test endpoint for BingX connection in quick-start flow
 * Returns account balance if connection is valid
 */
export async function GET() {
  try {
    console.log("[v0] [TestBingX] Testing BingX connection...")
    
    await initRedis()
    const allConnections = await getAllConnections()
    
    // Find BingX connection
    const bingx = allConnections.find((c: any) => {
      const exch = (c.exchange || "").toLowerCase()
      return exch === "bingx" && (c.is_enabled || c.is_enabled === "1")
    })
    
    if (!bingx) {
      console.log("[v0] [TestBingX] BingX connection not found or not enabled in Settings")
      return NextResponse.json(
        { 
          success: false,
          error: "BingX connection not found or not enabled",
          message: "Enable BingX in Settings first"
        },
        { status: 404 }
      )
    }
    
    console.log(`[v0] [TestBingX] Found BingX connection: ${bingx.name}`)
    
    // Actually test the connection and get real balance
    let balance = 0
    let status = "untested"
    
    try {
      const connector = new BingXConnector({
        apiKey: bingx.api_key || "",
        apiSecret: bingx.api_secret || "",
        apiType: bingx.api_type || "perpetual_futures",
        isTestnet: false, // ALWAYS mainnet - no testnet
      }, "bingx")
      
      const result = await connector.testConnection()
      console.log(`[v0] [TestBingX] Connection result:`, result.success, result.balance)
      
      if (result.success) {
        balance = result.balance || 0
        status = "connected"
      } else {
        status = "failed"
        console.log(`[v0] [TestBingX] Connection failed:`, result.error)
      }
    } catch (connError) {
      console.error(`[v0] [TestBingX] Connector error:`, connError)
      status = "error"
    }
    
    // Return connection status and real balance
    return NextResponse.json({
      success: status === "connected",
      connection: {
        id: bingx.id,
        name: bingx.name,
        exchange: bingx.exchange,
        testBalance: balance.toFixed(2),
      },
      status,
      balance: balance.toFixed(2),
      lastTest: new Date().toISOString(),
      message: status === "connected" 
        ? `BingX mainnet connected with ${balance.toFixed(2)} USDT`
        : `BingX connection ${status}`,
    })
  } catch (error) {
    console.error("[v0] [TestBingX] Error:", error)
    return NextResponse.json(
      { success: false, error: "Test failed", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
