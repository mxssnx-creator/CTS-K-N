import { type NextRequest, NextResponse } from "next/server"
import { runPresetBacktest } from "@/lib/backtest-engine"

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()
    const { connection_id, period_days } = body

    if (!connection_id) {
      return NextResponse.json({ error: "Connection ID required" }, { status: 400 })
    }

    const backtestId = await runPresetBacktest(id, connection_id, period_days || 30)

    return NextResponse.json({ backtest_id: backtestId, status: "running" }, { status: 201 })
  } catch (error) {
    console.error("[v0] Failed to start backtest:", error)
    return NextResponse.json({ error: "Failed to start backtest" }, { status: 500 })
  }
}
