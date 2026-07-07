import { NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

const SITE_LOGS_KEY = "site_logs"
const MAX_LOGS = 1000

export async function GET(request: Request) {
  try {
    await initRedis()
    const client = getRedisClient()

    const url = new URL(request.url)
    const level = url.searchParams.get("level")
    const category = url.searchParams.get("category")
    const limit = Number.parseInt(url.searchParams.get("limit") || "100")

    const rawLogs = await client.lrange(SITE_LOGS_KEY, 0, MAX_LOGS - 1)
    let logs = rawLogs.map((entry: any) => {
      try { return typeof entry === "string" ? JSON.parse(entry) : entry } catch { return entry }
    })

    if (level && level !== "all") {
      logs = logs.filter((l: any) => l.level === level)
    }
    if (category && category !== "all") {
      logs = logs.filter((l: any) => l.category === category)
    }

    return NextResponse.json(logs.slice(0, limit))
  } catch (error) {
    console.error("[v0] Site log fetch error:", error)
    return NextResponse.json({ error: "Failed to fetch logs", details: String(error) }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    await initRedis()
    const client = getRedisClient()
    const body = await request.json()

    const logEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      level: body.level || "info",
      category: body.category || "general",
      message: body.message || "",
      context: body.context || null,
      connection_id: body.connectionId || null,
      error_message: body.errorMessage || null,
      error_stack: body.errorStack || null,
      metadata: body.metadata || null,
      timestamp: new Date().toISOString(),
    }

    await client.lpush(SITE_LOGS_KEY, JSON.stringify(logEntry))
    await client.ltrim(SITE_LOGS_KEY, 0, MAX_LOGS - 1)

    return NextResponse.json({ success: true, id: logEntry.id })
  } catch (error) {
    console.error("[v0] Site log insert error:", error)
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 })
  }
}
