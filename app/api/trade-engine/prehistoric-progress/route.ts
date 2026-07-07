import { NextResponse } from "next/server"
import { initRedis } from "@/lib/redis-db"
import { getPrehistoricProgressTracker } from "@/lib/prehistoric-progress-tracker"

export const dynamic = "force-dynamic"
export const revalidate = 0

/**
 * Prehistoric Progress API
 * Returns stable, non-blocking progress data for all active connections
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const connectionId = searchParams.get("connection_id")

  try {
    await initRedis()

    if (connectionId) {
      // Single connection progress
      const tracker = getPrehistoricProgressTracker(connectionId)
      const progress = await tracker.getProgress()

      return NextResponse.json({
        success: true,
        connectionId,
        progress,
        timestamp: new Date().toISOString(),
      })
    } else {
      // All connections progress
      // Get list of all connections (cached, fast lookup)
      const { getActiveConnectionsForEngine } = await import("@/lib/redis-db")
      const connections = await getActiveConnectionsForEngine()

      const allProgress = await Promise.allSettled(
        connections.map(async (conn) => {
          const tracker = getPrehistoricProgressTracker(conn.id)
          const progress = await tracker.getProgress()
          return { connectionId: conn.id, progress }
        }),
      )

      const progressData = allProgress
        .filter((result) => result.status === "fulfilled")
        .map((result) => (result as PromiseFulfilledResult<any>).value)

      return NextResponse.json({
        success: true,
        connections: progressData,
        timestamp: new Date().toISOString(),
      })
    }
  } catch (error) {
    console.error("[PrehistoricProgress] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    )
  }
}
