import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getAllConnections } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"
import { ensureDefaultExchangesExist } from "@/lib/default-exchanges-seeder"

/**
 * POST /api/system/initialize-defaults
 * Initialize system with default disabled exchanges (BingX)
 * These are pre-configured but disabled until user provides credentials
 */
export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    console.log("[v0] [Initialize Defaults] Ensuring canonical base connections...")
    const ensured = await ensureDefaultExchangesExist()

    await SystemLogger.logAPI(
      `Canonical base initialization completed`,
      "info",
      "POST /api/system/initialize-defaults",
      ensured
    )

    return NextResponse.json(
      {
        success: true,
        message: "Canonical base connections initialized",
        ensured,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("[v0] [Initialize Defaults] Error:", error)
    await SystemLogger.logError(error, "api", "POST /api/system/initialize-defaults")
    return NextResponse.json(
      {
        error: "Failed to initialize defaults",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}

/**
 * GET /api/system/initialize-defaults
 * Check status of default exchanges
 */
export async function GET(request: NextRequest) {
  try {
    console.log("[v0] [Initialize Defaults] Checking default exchange status...")

    await initRedis()
    const connections = await getAllConnections()

    const bingx = connections.find((c) => c.id === "bingx-x01")

    return NextResponse.json(
      {
        status: "ready",
        defaults: {
          bingx: bingx
            ? {
                id: bingx.id,
                enabled: bingx.is_enabled,
                active: bingx.is_active,
                has_api_key: !!(bingx.api_key && String(bingx.api_key).length > 10),
              }
            : null,
        },
      },
      { status: 200 }
    )
  } catch (error) {
    console.error("[v0] [Initialize Defaults] Error:", error)
    return NextResponse.json(
      {
        error: "Failed to check status",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
