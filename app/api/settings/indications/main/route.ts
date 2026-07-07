import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    await initRedis()
    const client = getRedisClient()
    const settings = await client.get("indications:main")
    return NextResponse.json({ success: true, settings: settings || {} })
  } catch (error) {
    console.error("[v0] Error loading main indication settings:", error)
    return NextResponse.json({ success: false, error: "Failed to load main indication settings" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { settings } = body

    if (!settings) {
      return NextResponse.json({ success: false, error: "Settings are required" }, { status: 400 })
    }

    await initRedis()
    const client = getRedisClient()
    await client.set("indications:main", settings)

    return NextResponse.json({ success: true, message: "Main indication settings saved successfully" })
  } catch (error) {
    console.error("[v0] Error saving main indication settings:", error)
    return NextResponse.json({ success: false, error: "Failed to save main indication settings" }, { status: 500 })
  }
}
