import { type NextRequest, NextResponse } from "next/server"
import { sql } from "@/lib/db"
import { type ExchangeConnection } from "@/lib/types"

// POST retrieve capabilities from exchange
export const dynamic = "force-dynamic"
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    const result = await sql`
      SELECT * FROM exchange_connections WHERE id = ${id}
    `
    const connection = (result as any[])[0] as ExchangeConnection | undefined

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Retrieve capabilities based on exchange type
    let capabilities: string[] = []

    switch (connection.exchange) {
      case "bybit":
        capabilities = ["unified", "perpetual_futures", "spot", "leverage", "hedge_mode", "trailing"]
        break
      case "bingx":
        capabilities = ["futures", "perpetual_futures", "leverage", "hedge_mode"]
        break
      case "pionex":
        capabilities = ["futures", "perpetual_futures", "leverage", "hedge_mode"]
        break
      case "orangex":
        capabilities = ["futures", "perpetual_futures", "leverage"]
        break
      default:
        capabilities = ["basic"]
    }

    await sql`
      UPDATE exchange_connections
      SET 
        api_capabilities = ${JSON.stringify(capabilities)},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}
    `

    console.log("[v0] Retrieved capabilities for:", id, capabilities)
    return NextResponse.json({ success: true, capabilities })
  } catch (error) {
    console.error("[v0] Failed to retrieve capabilities:", error)
    return NextResponse.json({ error: "Failed to retrieve capabilities" }, { status: 500 })
  }
}
