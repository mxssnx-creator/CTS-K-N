import { type NextRequest, NextResponse } from "next/server"
import { authorizeAdminBearer } from "@/lib/admin-auth"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { maskConnectionSecret, maskConnectionSettings } from "@/lib/connection-secrets"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  // This route can inspect internal Redis records and is therefore disabled by
  // default even when an ADMIN_SECRET exists. Operators must enable it
  // explicitly and authenticate every request with that server-side secret.
  if (process.env.REDIS_DEBUG_ENABLED !== "1") {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  const authorization = authorizeAdminBearer(request.headers.get("authorization"))
  if (!authorization.ok) {
    return NextResponse.json(
      { error: authorization.error },
      { status: authorization.status },
    )
  }

  try {
    await initRedis()
    const client = getRedisClient()
    
    if (!client) {
      return NextResponse.json({ error: "Redis client not available" }, { status: 500 })
    }

    // Inspect an arbitrary hash key via ?hash=<key>
    const hashKey = request.nextUrl.searchParams.get("hash")
    if (hashKey) {
      const data = await client.hgetall(hashKey).catch(() => null)
      return NextResponse.json({
        hashKey,
        data: maskConnectionSettings(data || {}),
        fieldCount: data ? Object.keys(data).length : 0,
      })
    }

    // Inspect an arbitrary string key via ?key=<key>
    const strKey = request.nextUrl.searchParams.get("key")
    if (strKey) {
      const value = await client.get(strKey).catch(() => null)
      let safeValue: unknown = value
      if (/api.?key|api.?secret|passphrase|secret.?key/i.test(strKey)) {
        safeValue = maskConnectionSecret(value)
      } else if (typeof value === "string" && /^[{[]/.test(value.trim())) {
        try { safeValue = maskConnectionSettings(JSON.parse(value)) } catch { /* non-JSON string */ }
      }
      return NextResponse.json({ strKey, value: safeValue })
    }

    // List keys matching ?keys=<pattern>
    const keysPattern = request.nextUrl.searchParams.get("keys")
    if (keysPattern) {
      const matched = await client.keys(keysPattern).catch(() => [])
      return NextResponse.json({ keysPattern, count: matched.length, keys: matched.slice(0, 100) })
    }
    
    // Get all connection IDs from Redis
    const connIds = await client.smembers("connections")
    console.log(`[v0] [DebugRedis] Found ${connIds.length} connections in Redis`)
    
    const connections: any[] = []
    for (const id of connIds) {
      const data = await client.hgetall(`connection:${id}`)
      if (!data) continue
      const hasValidKey = data.api_key && data.api_key.length >= 16 && 
        !data.api_key.includes("PLACEHOLDER") && 
        !data.api_key.includes("00998877")
      
      connections.push({
        id: data.id,
        name: data.name,
        exchange: data.exchange,
        is_predefined: data.is_predefined,
        is_inserted: data.is_inserted,
        is_enabled_dashboard: data.is_enabled_dashboard,
        api_key_length: data.api_key?.length || 0,
        api_key_masked: data.api_key ? maskConnectionSecret(data.api_key) : "EMPTY",
        has_valid_key: hasValidKey,
        api_secret_length: data.api_secret?.length || 0,
        all_fields: Object.keys(data),
      })
    }
    
    return NextResponse.json({
      connections_count: connIds.length,
      connections,
      summary: {
        total: connIds.length,
        with_valid_keys: connections.filter(c => c.has_valid_key).length,
        all_placeholder: connections.every(c => !c.has_valid_key),
      }
    })
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
