import { NextResponse } from "next/server"
import { getAllConnections, getAppSettings, initRedis } from "@/lib/redis-db"
import { buildSettingsBackup } from "@/lib/settings-backup"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  try {
    await initRedis()
    const [settings, connections] = await Promise.all([
      getAppSettings({ bypassCache: true }),
      getAllConnections(),
    ])
    const backup = buildSettingsBackup(settings || {}, connections || [])
    const date = backup.exportedAt.slice(0, 10)
    return NextResponse.json(backup, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="cts-settings-${date}.json"`,
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to export settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}
