import { NextResponse } from "next/server"
import { authorizeAdminBearer } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request) {
  const authorization = authorizeAdminBearer(request.headers.get("authorization"))
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    )
  }

  try {
    console.log("[v0] Manual migration run requested...")

    // Redis migrations are handled automatically
    const { initRedis } = await import("@/lib/redis-db")
    const { getMigrationStatus } = await import("@/lib/redis-migrations")

    await initRedis()
    const result = await getMigrationStatus()
    if (!result.isMigrated) throw new Error(result.message)

    // Report the durable status instead of the former hardcoded applied count.
    return NextResponse.json({
      success: result.isMigrated,
      version: result.currentVersion,
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
