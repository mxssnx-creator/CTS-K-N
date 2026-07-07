import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { runMigrations } from "@/lib/redis-migrations"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    console.log("[REDIS INIT] Starting Redis initialization...")
    
    // Initialize Redis
    await initRedis()
    
    // Run migrations
    await runMigrations()
    
    const client = getRedisClient()
    const keys = await client.keys("*")
    const keyCount = keys ? keys.length : 0

    return NextResponse.json({
      success: true,
      keys_initialized: keyCount,
      database_type: "redis",
      message: "Redis initialized successfully with automatic migrations"
    })
  } catch (error) {
    console.error("[REDIS INIT] Initialization failed:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Redis initialization failed",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    )
  }
}
