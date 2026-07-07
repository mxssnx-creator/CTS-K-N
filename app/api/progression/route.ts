import { NextRequest, NextResponse } from "next/server"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { initRedis, getAllConnections } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connectionId")

    await initRedis()

    if (connectionId) {
      // Get progression for specific connection
      const progression = await ProgressionStateManager.getProgressionState(connectionId)
      return NextResponse.json({
        success: true,
        connectionId,
        progression,
      })
    }

    // Get all progressions
    const connections = await getAllConnections()
    const progressions = await Promise.all(
      connections.map(async (conn) => ({
        connectionId: conn.id,
        name: conn.name,
        progression: await ProgressionStateManager.getProgressionState(conn.id),
      })),
    )

    return NextResponse.json({
      success: true,
      progressions,
    })
  } catch (error) {
    console.error("[v0] Error fetching progression:", error)
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { connectionId, action, successful, profit } = body

    await initRedis()

    if (action === "cycle") {
      await ProgressionStateManager.incrementCycle(connectionId, successful ?? true, profit ?? 0)
      return NextResponse.json({ success: true, message: "Cycle recorded" })
    }

    if (action === "trade") {
      await ProgressionStateManager.recordTrade(connectionId, successful ?? true, profit ?? 0)
      return NextResponse.json({ success: true, message: "Trade recorded" })
    }

    if (action === "reset") {
      // Stamp ended_at on the existing progression (epoch=0 skips stale guard)
      // so history is correct, then delete the hash for a clean slate.
      await ProgressionStateManager.endProgression(connectionId, 0)
      await ProgressionStateManager.resetProgressionState(connectionId)
      return NextResponse.json({ success: true, message: "Progression reset" })
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 })
  } catch (error) {
    console.error("[v0] Error in progression endpoint:", error)
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 })
  }
}
