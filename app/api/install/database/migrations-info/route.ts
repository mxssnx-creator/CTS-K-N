import { NextResponse } from "next/server"
import { initRedis } from "@/lib/redis-db"
import { getMigrationStatus, runMigrations } from "@/lib/redis-migrations"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    await initRedis()
    const status = await getMigrationStatus()

    return NextResponse.json({
      // currentVersion = version actually applied in Redis;
      // latestVersion = highest migration the code defines. Both values are
      // derived dynamically so this never drifts from the real migration set.
      current_version: status.currentVersion,
      target_version: status.latestVersion,
      total_migrations: status.totalMigrations ?? status.latestVersion,
      migrations_sequential: status.migrationsSequential === true,
      database_health: status.databaseHealth ?? {},
      health_up_to_date: status.healthUpToDate === true,
      pending: Array.isArray(status.pendingMigrations) ? status.pendingMigrations.length : 0,
      message: status.message,
      is_up_to_date: status.isMigrated,
    })
  } catch (error) {
    console.error("[v0] Migrations info error:", error)
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Failed to get migrations info",
      current_version: 0,
    }, { status: 500 })
  }
}

export async function POST() {
  try {
    await initRedis()
    
    console.log("[v0] [API] Running migrations...")
    const result = await runMigrations()
    
    console.log("[v0] [API] Migrations completed:", result.message)
    
    return NextResponse.json({
      success: true,
      message: result.message,
      version: result.version,
    })
  } catch (error) {
    console.error("[v0] Migration run error:", error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : "Migration failed",
    }, { status: 500 })
  }
}
