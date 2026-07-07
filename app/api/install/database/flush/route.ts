import { type NextRequest, NextResponse } from "next/server"
import { flushAll, getRedisClient, initRedis } from "@/lib/redis-db"
import { runMigrations, resetMigrationRunState } from "@/lib/redis-migrations"
import { SystemLogger } from "@/lib/system-logger"
import { stopAllProgressionsBeforeReset } from "@/lib/db-reset-helper"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * POST /api/install/database/flush
 * DANGER: Flushes all Redis data and reinitializes the database
 * This is irreversible - all data will be permanently deleted
 */
export async function POST(request: NextRequest) {
  const logs: string[] = []

  try {
    // Get authorization token if available (optional basic protection)
    const authHeader = request.headers.get("authorization")
    if (authHeader !== `Bearer ${process.env.ADMIN_SECRET || ""}` && process.env.ADMIN_SECRET) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      )
    }

    logs.push("Starting Redis database flush...")
    console.log("[v0] Starting Redis flush operation")

    // Step 1: Initialize Redis
    try {
      await initRedis()
      logs.push("✓ Redis connection established")
    } catch (error) {
      logs.push(`✗ Redis connection failed: ${error}`)
      throw new Error("Redis connection failed")
    }

    // Step 1.5: Stop ALL progressions BEFORE wiping the DB
    // (engines, interval timers, stale __engine_timers, mark global stopped)
    // This prevents an in-flight tick from repopulating progression rows /
    // counter keys between FLUSHALL and migration replay.
    try {
      const stopResult = await stopAllProgressionsBeforeReset()
      logs.push(
        `✓ Stopped progressions before flush ` +
        `(coordinator=${stopResult.coordinator_stopped}, ` +
        `intervals=${stopResult.interval_manager_stopped}, ` +
        `timers_cleared=${stopResult.engine_timers_cleared}, ` +
        `global_marked=${stopResult.global_state_marked_stopped})`
      )
      if (stopResult.errors.length > 0) {
        logs.push(`⚠ Non-fatal stop errors: ${stopResult.errors.join("; ")}`)
      }
      console.log("[v0] Progressions stopped before flush:", stopResult)
    } catch (error) {
      // Non-fatal: a crashed coordinator should not block the operator
      // from resetting state. Log and continue.
      logs.push(`⚠ stop-progressions warning: ${error}`)
    }

    // Step 2: Flush all data
    try {
      await flushAll()
      logs.push("✓ All Redis data flushed (FLUSHALL executed)")
      console.log("[v0] Redis flushed successfully")
    } catch (error) {
      logs.push(`✗ Flush operation failed: ${error}`)
      throw new Error("Flush operation failed")
    }

    // Step 3: Re-run migrations
    try {
      // CRITICAL: FLUSHALL above wiped `_schema_version` / `_migrations_run`
      // from Redis, but the in-process migration guards (cached promise +
      // haveMigrationsRun) still think migrations ran. Reset them so
      // runMigrations() performs a full, clean replay against the now-empty
      // keyspace instead of returning the stale resolved promise.
      resetMigrationRunState()
      await runMigrations()
      logs.push("✓ Migrations re-applied after flush")
      console.log("[v0] Migrations re-applied")
    } catch (error) {
      logs.push(`⚠ Migration re-application warning: ${error}`)
    }

    // Step 4: Reseed data (connections, market data, settings)
    try {
      const { runPreStartup } = await import("@/lib/pre-startup")
      await runPreStartup()
      logs.push("✓ Predefined connections seeded")
      logs.push("✓ Market data seeded for all symbols")
      logs.push("✓ Default settings initialized")
      console.log("[v0] Data reseeded successfully")
    } catch (error) {
      logs.push(`⚠ Data seeding warning: ${error}`)
    }

    // Step 5: Create indexes
    try {
      const client = getRedisClient()
      await client.set("_index:connections:enabled", "true")
      await client.set("_index:trades:by_connection", "true")
      await client.set("_index:positions:active", "true")
      logs.push("✓ Database indexes recreated")
    } catch (error) {
      logs.push(`⚠ Index recreation warning: ${error}`)
    }

    logs.push("")
    logs.push("✓ Redis database flush completed successfully")

    await SystemLogger.logAPI(
      "Redis database flushed and reinitialized",
      "info",
      "POST /api/install/database/flush",
      { success: true, logs }
    )

    return NextResponse.json(
      {
        success: true,
        message: "Redis database flushed and reinitialized successfully",
        database_type: "redis",
        status: {
          flushed: true,
          migrations_reapplied: true,
          indexes_recreated: true,
        },
        logs,
      },
      { status: 200 }
    )
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Flush operation failed"
    logs.push(`✗ Error: ${errorMsg}`)
    console.error("[v0] Flush error:", error)

    await SystemLogger.logError(error, "api", "POST /api/install/database/flush")

    return NextResponse.json(
      {
        success: false,
        error: errorMsg,
        database_type: "redis",
        logs,
      },
      { status: 500 }
    )
  }
}
