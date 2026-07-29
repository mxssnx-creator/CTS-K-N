import { NextResponse } from "next/server"
import { getRedisClient } from "@/lib/redis-db"
import { authorizeAdminBearer } from "@/lib/admin-auth"

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
    const keys = await client.keys("*")
    const keyCount = keys ? keys.length : 0
    
    // Get Redis info
    const info = await client.info()
    
    return NextResponse.json({
      success: true,
      database_type: "redis",
      key_count: keyCount,
      keys_sample: keys ? keys.slice(0, 50) : [],
      info: info
    })
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    )
  }
}
