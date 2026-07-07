import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST() {
  try {
    console.log("[v0] Force reinitialization of Redis database...")

    const { initRedis } = await import("@/lib/redis-db")
    const { getRedisClient } = await import("@/lib/redis-db")
    const { runMigrations, resetMigrationRunState } = await import("@/lib/redis-migrations")

    const startTime = Date.now()

    // Clear all Redis keys
    console.log("[v0] Clearing all Redis data...")
    const client = getRedisClient()
    await client.flushDb()

    // Re-initialize
    console.log("[v0] Re-initializing Redis...")
    await initRedis()

    // Run all migrations fresh. The FLUSHALL above deleted `_schema_version`
    // and `_migrations_run` from Redis, but the cached migration promise +
    // haveMigrationsRun guard live in JS module state and survive the wipe.
    // Reset them so runMigrations() performs a real, full replay instead of
    // returning the stale resolved promise (which would leave the DB empty).
    console.log("[v0] Running migrations...")
    resetMigrationRunState()
    await runMigrations()

    const duration = Date.now() - startTime

    console.log("[v0] Force reinitialization complete")

    return NextResponse.json({
      success: true,
      message: "Redis database force-reinitialized successfully",
      duration,
      cleared: true,
      reinitialized: true,
    })
  } catch (error) {
    console.error("[v0] Force reinit failed:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Force reinitialization failed",
      },
      { status: 500 }
    )
  }
}
