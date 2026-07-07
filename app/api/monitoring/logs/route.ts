import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const limit = Number.parseInt(searchParams.get("limit") || "100")
    const level = searchParams.get("level") || undefined
    const category = searchParams.get("category") || undefined

    await initRedis()
    const client = getRedisClient()

    // Determine which log set to query
    let logIds: string[] = []
    if (category && category !== "all") {
      // Get logs from specific category
      logIds = await client.smembers(`logs:${category}`)
    } else {
      // Get all logs
      logIds = await client.smembers("logs:all")
    }

    // Fetch all log entries from Redis
    const logs: any[] = []
    for (const logId of logIds) {
      try {
        const logData = await client.hgetall(logId)
        if (logData && Object.keys(logData).length > 0) {
          // Parse metadata if it's a JSON string
          if (logData.metadata && typeof logData.metadata === "string") {
            try {
              logData.metadata = JSON.parse(logData.metadata)
            } catch {
              // Keep as string if not valid JSON
            }
          }
          
          // Filter by level if specified
          if (!level || level === "all" || logData.level === level) {
            logs.push({
              id: logData.id,
              timestamp: logData.timestamp,
              level: logData.level,
              category: logData.category,
              message: logData.message,
              metadata: logData.metadata,
            })
          }
        }
      } catch (error) {
        console.error(`[v0] Error fetching log ${logId}:`, error)
      }
    }

    // Sort by timestamp descending and limit
    logs.sort((a, b) => {
      const timeA = new Date(a.timestamp).getTime()
      const timeB = new Date(b.timestamp).getTime()
      return timeB - timeA
    })
    const limitedLogs = logs.slice(0, limit)

    // Calculate stats
    const stats = {
      total: logs.length,
      displayed: limitedLogs.length,
      byLevel: logs.reduce((acc: any, log: any) => {
        acc[log.level] = (acc[log.level] || 0) + 1
        return acc
      }, {}),
      byCategory: logs.reduce((acc: any, log: any) => {
        acc[log.category || "unknown"] = (acc[log.category || "unknown"] || 0) + 1
        return acc
      }, {}),
    }

    console.log(`[v0] [API/Logs] Retrieved ${limitedLogs.length}/${logs.length} logs from Redis`)

    return NextResponse.json({ logs: limitedLogs, stats })
  } catch (error) {
    console.error("[v0] Error fetching logs:", error)
    return NextResponse.json(
      {
        error: "Failed to fetch logs",
        details: error instanceof Error ? error.message : "Unknown error",
        logs: [],
        stats: { total: 0, displayed: 0, byLevel: {}, byCategory: {} },
      },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const { level, category, message, metadata } = await request.json()

    if (!level || !category || !message) {
      return NextResponse.json({ error: "Missing required fields: level, category, message" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient()

    const logId = `log:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`
    const logEntry = {
      id: logId,
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      metadata: metadata ? JSON.stringify(metadata) : "",
    }

    // Store in Redis
    await client.hset(logId, logEntry)
    await client.sadd("logs:all", logId)
    await client.sadd(`logs:${category}`, logId)
    await client.expire(logId, 604800) // 7 days TTL

    return NextResponse.json({ success: true, logId })
  } catch (error) {
    console.error("[v0] Error creating log entry:", error)
    return NextResponse.json(
      {
        error: "Failed to create log entry",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
