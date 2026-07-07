import { type NextRequest, NextResponse } from "next/server"
import { sql } from "@/lib/db"

// GET connection logs
export const dynamic = "force-dynamic"
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id

    console.log("[v0] Fetching logs for connection:", connectionId)

    // Get recent logs from database
    const logs = await sql`
      SELECT 
        timestamp,
        level,
        message,
        metadata
      FROM site_logs
      WHERE connection_id = ${connectionId}
      ORDER BY timestamp DESC
      LIMIT 100
    `

    // Format logs for display
    const formattedLogs = logs.map((log: any) => ({
      timestamp: log.timestamp,
      level: log.level,
      message: log.message,
    }))

    return NextResponse.json({ logs: formattedLogs })
  } catch (error) {
    console.error("[v0] Failed to fetch connection logs:", error)
    // Return empty logs if database fails
    return NextResponse.json({ logs: [] })
  }
}
