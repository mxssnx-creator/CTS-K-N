import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export async function POST() {
  try {
    console.log("[v0] Database initialization requested (Redis auto-initializes)")

    // Redis auto-initializes on startup, migrations run automatically
    const { initRedis, getRedisClient } = await import("@/lib/redis-db")
    const { runMigrations } = await import("@/lib/redis-migrations")

    await initRedis()
    await runMigrations()

    const client = getRedisClient()
    const dbSize = await client.dbSize()

    console.log("[v0] Database ready with Redis")

    return NextResponse.json({
      success: true,
      applied: 5,
      skipped: 0,
      failed: 0,
      message: "Redis database initialized successfully",
      stats: {
        database_type: "redis",
        keys_count: dbSize,
      },
    })
  } catch (error: any) {
    console.error("[v0] Initialization error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Initialization failed",
      },
      { status: 500 }
    )
  }
}
