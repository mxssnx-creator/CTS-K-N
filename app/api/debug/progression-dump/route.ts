import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/debug/progression-dump?id=bingx-x01
 * Dumps the raw Redis keys for a connection so we can see exactly what's stored.
 */
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id") || "bingx-x01"

  try {
    await initRedis()
    const client = getRedisClient()
    if (!client) return NextResponse.json({ error: "no redis" }, { status: 503 })

    const [prog, preh, rt] = await Promise.all([
      client.hgetall(`progression:${id}`).catch(() => null),
      client.hgetall(`prehistoric:${id}`).catch(() => null),
      client.hgetall(`realtime:${id}`).catch(() => null),
    ])

    // Also scan for any indication/strategy/market_data keys for this connection
    const [indKeys, stratKeys, mktKeys, posKeys] = await Promise.all([
      client.keys(`indications:${id}:*`).catch(() => [] as string[]),
      client.keys(`strategies:${id}:*`).catch(() => [] as string[]),
      client.keys(`market_data:*`).catch(() => [] as string[]),
      client.smembers(`pseudo_positions:${id}`).catch(() => [] as string[]),
    ])

    // Read indication type counts
    const indTypeCounts: Record<string, string | null> = {}
    for (const type of ["direction", "move", "active", "optimal", "auto"]) {
      indTypeCounts[type] = await client.get(`indications:${id}:${type}:count`).catch(() => null)
    }

    // Read strategy stage counts
    const stratStageCounts: Record<string, string | null> = {}
    for (const stage of ["base", "main", "real", "live"]) {
      stratStageCounts[stage] = await client.get(`strategies:${id}:${stage}:count`).catch(() => null)
    }

    return NextResponse.json({
      connectionId: id,
      progression: prog || {},
      prehistoric: preh || {},
      realtime: rt || {},
      indicationKeys: indKeys,
      strategyKeys: stratKeys,
      marketDataKeys: mktKeys.slice(0, 20),
      pseudoPositionIds: posKeys.slice(0, 20),
      indicationTypeCounts: indTypeCounts,
      strategyStageCountKeys: stratStageCounts,
      ts: new Date().toISOString(),
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
