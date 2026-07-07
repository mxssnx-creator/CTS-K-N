import { type NextRequest, NextResponse } from "next/server"
import { getAllConnections, initRedis, getRedisStats } from "@/lib/redis-db"
import os from "os"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  try {
    console.log("[v0] Running system diagnostics...")

    await initRedis()
    const connections = await getAllConnections()
    const stats = await getRedisStats()

    const diagnostics = {
      system: {
        platform: os.platform(),
        version: os.release(),
        arch: os.arch(),
      },
      node: {
        version: process.version,
      },
      database: {
        status: "connected",
        type: "Redis",
        system: "Upstash Redis (In-Memory Compatible)",
      },
      connections: {
        count: connections.length,
        data: connections.length > 0 ? connections.slice(0, 3) : [],
      },
      redis: stats,
    }

    console.log("[v0] Diagnostics completed successfully")

    return NextResponse.json(diagnostics)
  } catch (error) {
    console.error("[v0] Diagnostics failed:", error)
    return NextResponse.json(
      {
        error: "Diagnostics failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
