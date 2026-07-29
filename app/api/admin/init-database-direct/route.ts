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
    console.log("[v0] Initializing Redis database with migrations...")

    const { initRedis } = await import("@/lib/redis-db")

    const startTime = Date.now()

    // Initialize Redis
    await initRedis()

    const duration = Date.now() - startTime

    console.log(`[v0] Redis initialized successfully in ${duration}ms`)

    return NextResponse.json({
      success: true,
      message: "Redis database initialized successfully",
      duration,
      mode: "redis",
    })
  } catch (error) {
    console.error("[v0] Database initialization error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to initialize database",
      },
      { status: 500 }
    )
  }
}
