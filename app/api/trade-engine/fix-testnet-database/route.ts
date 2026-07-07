import { NextResponse } from "next/server"
import { execute } from "@/lib/db"

export const dynamic = "force-dynamic"
export async function POST() {
  try {
    console.log("[v0] [FixTestnetAPI] Starting testnet to mainnet conversion...")

    // Update all BingX connections to mainnet
    const bingxResult = await execute(
      `UPDATE exchange_connections 
       SET is_testnet = false, updated_at = NOW()
       WHERE exchange_name = 'BingX' OR exchange_name = 'bingx'`,
      []
    )
    console.log(`[v0] [FixTestnetAPI] Updated BingX: ${bingxResult.rowCount} rows`)

    // Update all Bybit connections to mainnet
    const bybitResult = await execute(
      `UPDATE exchange_connections 
       SET is_testnet = false, updated_at = NOW()
       WHERE exchange_name = 'Bybit' OR exchange_name = 'bybit'`,
      []
    )
    console.log(`[v0] [FixTestnetAPI] Updated Bybit: ${bybitResult.rowCount} rows`)

    // Update all OKX connections to mainnet
    const okxResult = await execute(
      `UPDATE exchange_connections 
       SET is_testnet = false, updated_at = NOW()
       WHERE exchange_name = 'OKX' OR exchange_name = 'okx'`,
      []
    )
    console.log(`[v0] [FixTestnetAPI] Updated OKX: ${okxResult.rowCount} rows`)

    // Also update Redis cache for all active connections
    const { getSettings, setSettings, getAllConnections } = await import("@/lib/redis-db")

    const connections = await getAllConnections()
    for (const conn of connections) {
      if (["BingX", "Bybit", "OKX"].some(ex => conn.exchange_name?.includes(ex))) {
        // Update connection in Redis
        await setSettings(`connection:${conn.id}`, {
          ...conn,
          is_testnet: false,
          updated_at: new Date().toISOString(),
        })
      }
    }

    console.log(
      `[v0] [FixTestnetAPI] Complete: Updated ${bingxResult.rowCount + bybitResult.rowCount + okxResult.rowCount} connections to mainnet`
    )

    return NextResponse.json({
      success: true,
      message: "All connections updated to mainnet",
      updated: {
        bingx: bingxResult.rowCount,
        bybit: bybitResult.rowCount,
        okx: okxResult.rowCount,
      },
    })
  } catch (error) {
    console.error("[v0] [FixTestnetAPI] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
