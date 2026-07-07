import { NextResponse } from "next/server"
import { getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const client = getRedisClient()
    
    // Test Redis connectivity
    const startTime = Date.now()
    const ping = await client.ping()
    const responseTime = Date.now() - startTime

    // Get Redis info
    const info = await client.info()
    
    // Get key count
    const dbSize = await client.dbSize()
    
    const isHealthy = ping === "PONG"

    return NextResponse.json({
      status: isHealthy ? "healthy" : "degraded",
      database: {
        type: "redis",
        connected: isHealthy,
        responseTime: `${responseTime}ms`,
        keyCount: dbSize,
        ping: ping
      },
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    return NextResponse.json({
      status: "unhealthy",
      database: {
        type: "redis",
        connected: false,
        error: error instanceof Error ? error.message : "Unknown error"
      },
      timestamp: new Date().toISOString()
    }, { status: 503 })
  }
}
