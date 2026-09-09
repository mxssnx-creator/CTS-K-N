import { NextRequest, NextResponse } from "next/server"
import { getConnection, initRedis, getAppSettings } from "@/lib/redis-db"
import { listDeactivatedLiveConfigs } from "@/lib/live-config-performance"
import { liveConfigLossPolicy } from "@/lib/live-config-loss-policy"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const connectionId = params.get("connectionId") || ""
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(connectionId)) {
    return NextResponse.json({ error: "A valid connectionId is required" }, { status: 400 })
  }
  const offset = Math.max(0, Math.min(1_000_000, Math.floor(Number(params.get("offset")) || 0)))
  const limit = Math.max(1, Math.min(100, Math.floor(Number(params.get("limit")) || 50)))
  try {
    await initRedis()
    if (!await getConnection(connectionId)) return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    const [data, settings] = await Promise.all([listDeactivatedLiveConfigs(connectionId, offset, limit), getAppSettings()])
    return NextResponse.json({ ...data, offset, limit, policy: liveConfigLossPolicy(settings), observedAt: Date.now() },
      { headers: { "Cache-Control": "no-store" } })
  } catch {
    return NextResponse.json({ error: "Live Set deactivation statistics are temporarily unavailable" }, { status: 503 })
  }
}
