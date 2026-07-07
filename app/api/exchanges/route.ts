import { NextResponse } from "next/server"
import { query } from "@/lib/db"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    console.log("[v0] Fetching exchanges from database")

    const exchanges = await query(`
      SELECT 
        id,
        name,
        display_name,
        is_active,
        supports_spot,
        supports_futures,
        supports_margin,
        api_endpoint,
        websocket_endpoint
      FROM exchanges
      WHERE is_active = 1
      ORDER BY display_name
    `)

    console.log("[v0] Found exchanges:", exchanges.length)

    exchanges.forEach((ex: any) => {
      console.log("[v0] - Exchange:", ex.name, "->", ex.display_name)
    })

    return NextResponse.json(exchanges)
  } catch (error) {
    console.error("[v0] Failed to fetch exchanges:", error)
    console.error("[v0] Error details:", error instanceof Error ? error.message : "Unknown error")
    return NextResponse.json([])
  }
}
