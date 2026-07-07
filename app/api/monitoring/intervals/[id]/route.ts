import { NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    await initRedis()
    const client = getRedisClient()
    const connectionId = params.id

    if (!connectionId) {
      return NextResponse.json({ error: "Missing connectionId parameter" }, { status: 400 })
    }

    // Get interval tracking data from Redis
    const intervals = {
      direction: await getIntervalData(client, connectionId, "direction"),
      move: await getIntervalData(client, connectionId, "move"),
      active: await getIntervalData(client, connectionId, "active"),
      optimal: await getIntervalData(client, connectionId, "optimal"),
    }

    return NextResponse.json({ intervals })
  } catch (error) {
    console.error("[Intervals API] Error:", error)
    return NextResponse.json(
      {
        intervals: {
          direction: { enabled: false, isRunning: false, isProgressing: false, intervalTime: 1, timeout: 5 },
          move: { enabled: false, isRunning: false, isProgressing: false, intervalTime: 1, timeout: 5 },
          active: { enabled: false, isRunning: false, isProgressing: false, intervalTime: 1, timeout: 5 },
          optimal: { enabled: false, isRunning: false, isProgressing: false, intervalTime: 2, timeout: 10 },
        },
        error: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    )
  }
}

async function getIntervalData(client: any, connectionId: string, type: string) {
  try {
    const key = `intervals:${connectionId}:${type}`
    const data = await client.hgetall(key)

    if (!data || Object.keys(data).length === 0) {
      // Return default values based on type
      const defaults = {
        direction: { enabled: true, intervalTime: 1, timeout: 5 },
        move: { enabled: true, intervalTime: 1, timeout: 5 },
        active: { enabled: true, intervalTime: 1, timeout: 5 },
        optimal: { enabled: true, intervalTime: 2, timeout: 10 },
      }
      const def = defaults[type as keyof typeof defaults] || { enabled: false, intervalTime: 1, timeout: 5 }
      return {
        enabled: def.enabled,
        isRunning: false,
        isProgressing: false,
        intervalTime: def.intervalTime,
        timeout: def.timeout,
      }
    }

    return {
      enabled: data.enabled === "true" || data.enabled === "1",
      isRunning: data.isRunning === "true" || data.isRunning === "1",
      isProgressing: data.isProgressing === "true" || data.isProgressing === "1",
      intervalTime: parseInt(data.intervalTime) || 1,
      timeout: parseInt(data.timeout) || 5,
      lastStart: data.lastStart,
      lastEnd: data.lastEnd,
    }
  } catch (error) {
    console.warn(`[Intervals API] Failed to get ${type} data:`, error)
    return {
      enabled: false,
      isRunning: false,
      isProgressing: false,
      intervalTime: 1,
      timeout: 5,
    }
  }
}