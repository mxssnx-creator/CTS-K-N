import { type NextRequest, NextResponse } from "next/server"
import { VolumeCalculator } from "@/lib/volume-calculator"

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { connectionId, symbol, currentPrice } = body

    if (!connectionId || !symbol || !currentPrice) {
      return NextResponse.json({ error: "Missing required parameters" }, { status: 400 })
    }

    const result = await VolumeCalculator.calculateVolumeForConnection(connectionId, symbol, currentPrice)

    return NextResponse.json(result)
  } catch (error) {
    console.error("[v0] Failed to calculate volume:", error)
    return NextResponse.json({ error: "Failed to calculate volume" }, { status: 500 })
  }
}
