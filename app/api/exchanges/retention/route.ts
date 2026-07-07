import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()

    // Get all retention settings from Redis
    const keys = await (client as any).keys("exchange_retention:*")
    const retentionSettings = []

    for (const key of keys) {
      const data = await (client as any).hgetall(key)
      if (data && Object.keys(data).length > 0) {
        retentionSettings.push({
          connection_id: data.connection_id,
          retention_hours: parseInt(data.retention_hours || "24"),
          auto_cleanup_enabled: data.auto_cleanup_enabled === "true" || data.auto_cleanup_enabled === true,
        })
      }
    }

    // Sort by connection_id
    retentionSettings.sort((a, b) => a.connection_id.localeCompare(b.connection_id))

    return NextResponse.json({ retentionSettings })
  } catch (error) {
    console.error("[v0] Error fetching retention settings:", error)
    return NextResponse.json({ error: "Failed to fetch retention settings" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const { connectionId, retentionHours, autoCleanupEnabled } = await request.json()

    if (!connectionId || retentionHours === undefined) {
      return NextResponse.json({ error: "connectionId and retentionHours are required" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient()

    const key = `exchange_retention:${connectionId}`
    const setting = {
      connection_id: connectionId,
      retention_hours: String(retentionHours),
      auto_cleanup_enabled: String(autoCleanupEnabled ?? true),
      updated_at: new Date().toISOString(),
    }

    // Store in Redis
    await (client as any).hset(key, setting)

    // Add to index
    await (client as any).sadd("exchange_retention_settings:all", connectionId)
    
    // Set TTL (30 days)
    await (client as any).expire(key, 30 * 24 * 60 * 60)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Error saving retention settings:", error)
    return NextResponse.json({ error: "Failed to save retention settings" }, { status: 500 })
  }
}
