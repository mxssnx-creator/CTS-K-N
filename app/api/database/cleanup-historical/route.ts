import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function POST(request: Request) {
  try {
    const { connectionId, hoursToKeep } = await request.json()

    if (!connectionId || !hoursToKeep) {
      return NextResponse.json({ error: "connectionId and hoursToKeep are required" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient()

    // Calculate cutoff timestamp
    const cutoffTime = new Date(Date.now() - hoursToKeep * 60 * 60 * 1000)
    const cutoffTimeStr = cutoffTime.toISOString()

    // Get all market data keys for this connection
    const keys = await (client as any).keys(`market_data:${connectionId}:*`)

    let deletedCount = 0
    let archivedCount = 0
    let keptCount = 0

    for (const key of keys) {
      const data = await (client as any).hgetall(key)

      if (!data || !data.timestamp) {
        continue
      }

      const recordTime = new Date(data.timestamp)

      // Check if this record is older than cutoff
      if (recordTime < cutoffTime) {
        try {
          // Archive to another key first (for audit trail)
          const archiveKey = `archived_market_data:${connectionId}:${data.symbol || "unknown"}:${Date.now()}`
          const hashData: Record<string, string> = {}
          for (const [k, v] of Object.entries(data)) {
            hashData[k] = String(v ?? "")
          }
          await (client as any).hset(archiveKey, hashData)
          await (client as any).expire(archiveKey, 90 * 24 * 60 * 60) // Keep archived for 90 days

          // Delete original
          await (client as any).del(key)
          deletedCount++
          archivedCount++

        } catch (error) {
          console.error(`[Cleanup] Error archiving record ${key}:`, error)
        }
      } else {
        keptCount++
      }
    }

    return NextResponse.json({
      success: true,
      deletedCount,
      archivedCount,
      keptCount,
      totalProcessed: keys.length,
    })
  } catch (error) {
    console.error("[v0] Error cleaning up historical data:", error)
    return NextResponse.json({ error: "Failed to cleanup historical data", details: String(error) }, { status: 500 })
  }
}
