import { NextResponse } from "next/server"
import { initRedis, getRedisClient, flushAll } from "@/lib/redis-db"
import { runMigrations, resetMigrationRunState } from "@/lib/redis-migrations"
import { stopAllProgressionsBeforeReset } from "@/lib/db-reset-helper"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST() {
  try {
    console.log("[v0] === FLUSHING REDIS DATABASE ===")
    
    await initRedis()

    // Stop every engine, interval, and stale timer BEFORE the wipe so
    // a tick mid-flight cannot rewrite progression / counter keys
    // between FLUSHALL and migration replay.
    const stopResult = await stopAllProgressionsBeforeReset()
    console.log("[v0] Progressions stopped before reset-and-init:", stopResult)
    
    // Flush all data from Redis
    await flushAll()
    console.log("[v0] Redis database flushed")
    
    console.log("[v0] === RUNNING FRESH MIGRATIONS ===")
    
    // Reset the in-process migration guards: FLUSHALL wiped Redis but the
    // cached migration promise + haveMigrationsRun flag persist in JS module
    // state, so without this runMigrations() returns the stale resolved
    // promise and never replays against the empty keyspace.
    resetMigrationRunState()
    // Run migrations fresh
    await runMigrations()
    console.log("[v0] Migrations completed")
    
    return NextResponse.json({
      success: true,
      message: "Redis database reset and initialized successfully",
      database_type: "redis",
      stopped: stopResult,
    })
  } catch (error: any) {
    console.error("[v0] Reset and init failed:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Unknown error",
        database_type: "redis",
      },
      { status: 500 },
    )
  }
}
