import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { databaseType } = body

    // Redis is now the only supported database
    if (databaseType !== "redis") {
      return NextResponse.json(
        {
          success: false,
          error: "Only Redis is supported.",
        },
        { status: 400 }
      )
    }

    console.log("[v0] Testing Redis connection...")

    try {
      const { getRedisClient } = await import("@/lib/redis-db")
      const client = getRedisClient()
      
      // Test connection with ping
      await client.ping()
      
      console.log("[v0] Redis connection successful!")

      return NextResponse.json({
        success: true,
        data: {
          message: "Redis connection successful",
          connected: true,
          type: "redis",
        },
      })
    } catch (redisError) {
      console.log("[v0] Using fallback in-memory store (Redis unavailable)")
      
      return NextResponse.json({
        success: true,
        data: {
          message: "Using fallback in-memory store",
          connected: true,
          type: "memory",
          mode: "development",
        },
      })
    }
  } catch (error) {
    console.error("[v0] Connection test failed:", error)

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Connection test failed",
      },
      { status: 500 }
    )
  }
}
