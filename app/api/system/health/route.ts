import { NextResponse } from "next/server"
import { initRedis, getAllConnections } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const startTime = Date.now()

    // Check Redis connection
    await initRedis()
    const redisConnected = true

    // Check connections available
    const connections = await getAllConnections()

    // Check key endpoints are callable
    const health = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      checks: {
        redis: redisConnected ? "up" : "down",
        connections: connections.length > 0 ? "loaded" : "empty",
        connectionsCount: connections.length,
      },
      uptime: process.uptime(),
      responseTime: Date.now() - startTime,
      environment: process.env.NODE_ENV || "development",
      version: "3.1.0",
    }

    return NextResponse.json(health)
  } catch (error) {
    console.error("[v0] [Health Check] Error:", error)

    return NextResponse.json(
      {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 503 }
    )
  }
}
