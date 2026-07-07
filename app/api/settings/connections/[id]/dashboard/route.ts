import { type NextRequest, NextResponse } from "next/server"
import { getConnection, initRedis, updateConnection } from "@/lib/redis-db"
import { parseBooleanInput, toRedisFlag } from "@/lib/boolean-utils"

// POST - Toggle dashboard active status
export const dynamic = "force-dynamic"
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()
    const isDashboardActive = parseBooleanInput(body?.is_dashboard_active)

    console.log("[v0] [DashboardRoute] Toggling dashboard active for connection:", id, "to:", isDashboardActive)

    await initRedis()
    const connection = await getConnection(id)
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    await updateConnection(id, {
      ...connection,
      is_enabled_dashboard: toRedisFlag(isDashboardActive),
      is_active_inserted: isDashboardActive ? "1" : (connection.is_active_inserted || "1"),
      is_active: toRedisFlag(isDashboardActive),
      is_dashboard_inserted: "1",
      updated_at: new Date().toISOString(),
    })

    return NextResponse.json({ success: true, is_dashboard_active: isDashboardActive })
  } catch (error) {
    console.error("[v0] [DashboardRoute] Failed to toggle dashboard active:", error)
    return NextResponse.json({ error: "Failed to toggle dashboard active" }, { status: 500 })
  }
}
