import { type NextRequest, NextResponse } from "next/server"
import { flushAll, initRedis } from "@/lib/redis-db"
import { runMigrations, resetMigrationRunState } from "@/lib/redis-migrations"
import { stopAllProgressionsBeforeReset } from "@/lib/db-reset-helper"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    console.log("[v0] Resetting Redis database...")

    await initRedis()

    // Stop every running engine, interval, and stale timer BEFORE wiping.
    // Otherwise an in-flight tick will write fresh progression rows back
    // into the DB between FLUSHALL and the next migration replay.
    const stopResult = await stopAllProgressionsBeforeReset()
    console.log("[v0] Progressions stopped before reset:", stopResult)

    await flushAll()

    // CRITICAL: a bare FLUSHALL leaves the database completely empty —
    // no `_schema_version`, no metadata hashes, no seeded base connections
    // or indexes. Reset the in-process migration guards (the FLUSHALL can't
    // touch JS module state) and replay all migrations so the store comes
    // back up in a fully-initialised, consistent state. Then reseed via
    // runPreStartup (settings, connections, market data in dev).
    resetMigrationRunState()
    await runMigrations()
    try {
      const { runPreStartup } = await import("@/lib/pre-startup")
      await runPreStartup()
    } catch (seedErr) {
      console.warn("[v0] Reseed after reset warning (non-fatal):", seedErr)
    }

    console.log("[v0] Redis database reset successfully")

    return NextResponse.json({
      success: true,
      message: "Database reset successfully",
      migrations_reapplied: true,
      stopped: stopResult,
    })
  } catch (error) {
    console.error("[v0] Database reset failed:", error)
    return NextResponse.json(
      {
        error: "Database reset failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
