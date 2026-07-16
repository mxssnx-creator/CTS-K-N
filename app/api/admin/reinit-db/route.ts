import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST() {
  try {
    console.log("[v0] Reinitializing Redis migrations...")

    const { initRedis } = await import("@/lib/redis-db")
    const { getMigrationStatus } = await import("@/lib/redis-migrations")
    const { consolidateDatabase } = await import("@/lib/database-consolidation")

    const startTime = Date.now()

    // Re-initialize Redis connection
    await initRedis()

    const status = await getMigrationStatus()
    if (!status.isMigrated) throw new Error(status.message)
    const maintenance = await consolidateDatabase({ force: true })
    if (maintenance.status === "busy") throw new Error("Database maintenance is already running")

    const duration = Date.now() - startTime

    console.log(`[v0] Redis reinitialized in ${duration}ms`)

    return NextResponse.json({
      success: true,
      message: "Redis database reinitialized successfully",
      duration,
      mode: "redis",
    })
  } catch (error) {
    console.error("[v0] Reinit failed:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Reinit failed",
      },
      { status: 500 }
    )
  }
}
