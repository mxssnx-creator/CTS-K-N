import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"

// POST system log entry
export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { level, category, message, connectionId, metadata } = body

    // Log to system
    if (category === "connection" && connectionId) {
      await SystemLogger.logConnection(message, connectionId, level || "info", metadata)
    } else {
      await SystemLogger.logAPI(message, level || "info", category, metadata)
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Failed to log:", error)
    return NextResponse.json({ error: "Failed to log" }, { status: 500 })
  }
}
