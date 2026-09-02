import { NextResponse } from "next/server"
import { getRedisClient } from "@/lib/redis-db"
import { authorizeAdminBearer } from "@/lib/admin-auth"
import { scanRedisKeys } from "@/lib/redis-scan"

export const dynamic = "force-dynamic"
export async function GET(request: Request) {
  const authorization = authorizeAdminBearer(request.headers.get("authorization"))
  if (!authorization.ok) {
    return NextResponse.json(
      { success: false, error: authorization.error },
      { status: authorization.status },
    )
  }

  try {
    const client = getRedisClient()
    
    // Get all Redis keys
    const keyCount = typeof (client as any).dbSize === "function"
      ? await (client as any).dbSize()
      : 0
    const keys = await scanRedisKeys(client, "*", { count: 250, limit: 50 })
    
    // Get Redis info
    const info = await client.info()
    
    return NextResponse.json({
      success: true,
      database_type: "redis",
      key_count: keyCount,
      keys_sample: keys,
      info: info
    })
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    )
  }
}
