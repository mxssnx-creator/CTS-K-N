import { type NextRequest, NextResponse } from "next/server"
import { sql } from "@/lib/db"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const strategies = await sql`
      SELECT * FROM preset_strategies
      WHERE preset_id = ${id}
      ORDER BY profit_factor DESC
      LIMIT 100
    `

    return NextResponse.json(strategies)
  } catch (error) {
    console.error("[v0] Failed to fetch preset strategies:", error)
    return NextResponse.json({ error: "Failed to fetch strategies" }, { status: 500 })
  }
}
