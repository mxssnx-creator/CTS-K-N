import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; presetTypeId: string }> },
) {
  try {
    const { id: connectionId, presetTypeId } = await params

    await initRedis()
    const client = getRedisClient()

    // Get preset engine state from Redis
    const state = await client.hgetall(`preset_engine:${connectionId}:${presetTypeId}`)

    if (!state || Object.keys(state).length === 0) {
      return NextResponse.json({
        status: "not_initialized",
        connectionId,
        presetTypeId,
      })
    }

    // Check if global engine is running
    const globalState = await client.hgetall("trade_engine:global")
    const globalRunning = globalState?.status === "running"

    // If global engine stopped but preset says running, it was paused
    const effectiveStatus = (state.status === "running" && !globalRunning)
      ? "paused"
      : state.status

    return NextResponse.json({
      status: effectiveStatus,
      connectionId,
      presetTypeId,
      startedAt: state.started_at || null,
      stoppedAt: state.stopped_at || null,
      updatedAt: state.updated_at || null,
      globalEngineRunning: globalRunning,
      positions: {
        total: 0,
        base: 0,
        main: 0,
        real: 0,
      },
    })
  } catch (error) {
    console.error("[v0] Failed to get preset coordination engine status:", error)

    return NextResponse.json(
      {
        error: "Failed to get status",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
