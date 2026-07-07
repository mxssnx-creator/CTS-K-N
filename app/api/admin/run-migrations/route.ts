import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST() {
  try {
    console.log("[v0] Manual migration run requested...")

    // Redis migrations are handled automatically
    const { initRedis } = await import("@/lib/redis-db")
    const { runMigrations } = await import("@/lib/redis-migrations")

    await initRedis()
    const result = await runMigrations()

    // Report the REAL migration result instead of hardcoded counts. The
    // previous static `applied: 5` misrepresented every run (the system is at
    // schema v22 and runMigrations() returns { success, message, version }).
    return NextResponse.json({
      success: result.success !== false,
      version: result.version,
      message: result.message ?? "Redis migrations completed",
    })
  } catch (error: any) {
    console.error("[v0] Migration API error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || "Migration failed",
      },
      { status: 500 }
    )
  }
}
