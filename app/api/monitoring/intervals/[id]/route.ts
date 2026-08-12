import { NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

const INDICATION_INTERVAL_TYPES = [
  "direction", "move", "active", "active_advanced", "special",
  "trend", "optimal", "auto",
  "common", "signal",
] as const

function defaultCadenceSeconds(type: string): number {
  if (type === "common") return 1
  if (type === "trend") return 0.5
  return 0.25
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await initRedis()
    const client = getRedisClient()
    const { id: connectionId } = await params

    if (!connectionId) {
      return NextResponse.json({ error: "Missing connectionId parameter" }, { status: 400 })
    }

    // Get interval tracking data from Redis
    const entries = await Promise.all(INDICATION_INTERVAL_TYPES.map(async (type) => [
      type,
      await getIntervalData(client, connectionId, type),
    ] as const))
    const intervals = Object.fromEntries(entries)

    return NextResponse.json({ intervals })
  } catch (error) {
    console.error("[Intervals API] Error:", error)
    return NextResponse.json(
      {
        intervals: Object.fromEntries(INDICATION_INTERVAL_TYPES.map((type) => [
          type,
          {
            enabled: false,
            isRunning: false,
            isProgressing: false,
            intervalTime: defaultCadenceSeconds(type),
            timeout: defaultCadenceSeconds(type),
          },
        ])),
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
      const known = (INDICATION_INTERVAL_TYPES as readonly string[]).includes(type)
      const defaultCadence = defaultCadenceSeconds(type)
      const def = {
        enabled: known,
        intervalTime: defaultCadence,
        timeout: defaultCadence,
      }
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
      intervalTime: Number(data.intervalTime) || defaultCadenceSeconds(type),
      timeout: Number(data.timeout) || defaultCadenceSeconds(type),
      lastStart: data.lastStart,
      lastEnd: data.lastEnd,
    }
  } catch (error) {
    console.warn(`[Intervals API] Failed to get ${type} data:`, error)
    return {
      enabled: false,
      isRunning: false,
      isProgressing: false,
      intervalTime: defaultCadenceSeconds(type),
      timeout: defaultCadenceSeconds(type),
    }
  }
}
