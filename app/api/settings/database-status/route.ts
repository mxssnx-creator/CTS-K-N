import { NextResponse } from "next/server"
import { initRedis, getRedisBackend, getRedisClient, isRedisConnected, getConnectionCountDiagnostics } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

function maskRedisUrl(value: string): string {
  if (!value) return "inline://process-local"
  try {
    const parsed = new URL(value)
    return `${parsed.protocol}//*****@${parsed.host}`
  } catch {
    return "redis://configured-invalid-url"
  }
}

export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    const connected = isRedisConnected()
    const backend = getRedisBackend()
    const shared = backend === "redis-network"
    
    let connectionCount = 0
    let connectionCounts = { connection_hash_count: 0, legacy_connection_set_count: 0 }
    let schemaVersion = "0"
    
    if (connected) {
      connectionCounts = await getConnectionCountDiagnostics()
      connectionCount = connectionCounts.connection_hash_count
      schemaVersion = (await client.get("_schema_version") || "0") as string
    }

    const configuredUrl = process.env.REDIS_URL || process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || ""
    const maskedUrl = maskRedisUrl(configuredUrl)

    return NextResponse.json({
      type: "redis",
      backend,
      isConfigured: shared,
      isConnected: connected,
      isSharedConfigured: shared,
      isCrossInstanceDurable: shared,
      liveOrderCoordinationReady: shared || process.env.ALLOW_INLINE_REDIS_LIVE_TRADING === "1",
      url: maskedUrl,
      tableCount: connectionCount,
      connection_hash_count: connectionCounts.connection_hash_count,
      legacy_connection_set_count: connectionCounts.legacy_connection_set_count,
      schemaVersion: parseInt(schemaVersion),
      envVars: {
        REDIS_URL: !!process.env.REDIS_URL,
        KV_URL: !!process.env.KV_URL,
        UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
        UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
        KV_REST_API_URL: !!process.env.KV_REST_API_URL,
        KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
      },
      warning: shared
        ? null
        : "InlineLocalRedis is connected but process-local; configure shared Redis for restart-safe production and live orders.",
    })
  } catch (error) {
    console.error("[v0] Failed to get database status:", error)
    return NextResponse.json(
      {
        type: "redis",
        isConfigured: false,
        isConnected: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
