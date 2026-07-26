import { NextResponse } from "next/server"
import { getAllConnections, getRedisClient, initRedis } from "@/lib/redis-db"
import {
  getSignalSourceHealth,
  listSignalPerformance,
} from "@/lib/signal-indication"
import { getSignalSourceDescriptors } from "@/lib/signal-source-registry"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const requested = new URL(request.url).searchParams.get("connectionId")?.trim()
    const connectionIds = requested
      ? [requested]
      : (await getAllConnections().catch(() => []))
          .map((connection: any) => String(connection.id || ""))
          .filter(Boolean)
    const connections = await Promise.all(connectionIds.map(async (connectionId) => ({
      connectionId,
      sourceHealth: await getSignalSourceHealth(connectionId),
      performance: await listSignalPerformance(connectionId),
    })))
    return NextResponse.json({
      success: true,
      connections,
      sourceCount: getSignalSourceDescriptors().length,
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load signal status",
      },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    const parsed = await request.json()
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 })
  }
  if (
    body.action !== "reset_performance" ||
    typeof body.connectionId !== "string" ||
    body.connectionId.trim().length === 0
  ) {
    return NextResponse.json(
      { success: false, error: "action=reset_performance and connectionId are required" },
      { status: 400 },
    )
  }

  try {
    await initRedis()
    const client = getRedisClient()
    const connectionId = body.connectionId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_")
    const indexKey = `signal:performance:index:${connectionId}`
    const indexed = await client.smembers(indexKey).catch(() => [])
    const sourceFilter = typeof body.sourceId === "string"
      ? body.sourceId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_")
      : null
    const symbolFilter = typeof body.symbol === "string"
      ? body.symbol.toUpperCase().replace(/[^A-Z0-9]+/g, "")
      : null
    const directionFilter = body.direction === "long" || body.direction === "short"
      ? body.direction
      : null
    const selected = indexed.filter((key) => {
      const parts = key.split(":")
      const direction = parts.at(-1)
      const symbol = parts.at(-2)
      const source = parts.at(-3)
      return (
        (!sourceFilter || source === sourceFilter) &&
        (!symbolFilter || symbol === symbolFilter) &&
        (!directionFilter || direction === directionFilter)
      )
    })
    if (selected.length > 0) {
      const pipeline = client.multi()
      for (const key of selected) {
        pipeline.del(key, `${key}:samples`, `${key}:probe`)
        pipeline.srem(indexKey, key)
      }
      await pipeline.exec()
    }
    return NextResponse.json({ success: true, reset: selected.length })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to reset signal performance",
      },
      { status: 500 },
    )
  }
}
