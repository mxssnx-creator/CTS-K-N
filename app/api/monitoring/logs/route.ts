import { type NextRequest, NextResponse } from "next/server"
import { initRedis } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const limit = Math.max(
      1,
      Math.min(500, Number.parseInt(searchParams.get("limit") || "100", 10) || 100),
    )
    const level = searchParams.get("level") || undefined
    const category =
      searchParams.get("category") && searchParams.get("category") !== "all"
        ? searchParams.get("category") || undefined
        : undefined

    await initRedis()
    // The canonical logger writes bounded, newest-first Redis LIST indexes.
    // Read that same store in one batched pipeline; legacy SET fallback is
    // handled inside SystemLogger during migration.
    const sampleLimit = Math.max(limit, 500)
    const rows = await SystemLogger.getLogs(category, sampleLimit)
    const logs = rows
      .filter((entry) => !level || level === "all" || entry.level === level)
      .sort(
        (left, right) =>
          new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
      )
    const limitedLogs = logs.slice(0, limit).map((entry, index) => ({
      id: entry.id || `stored-log-${index}-${entry.timestamp}`,
      timestamp: entry.timestamp,
      level: entry.level,
      category: entry.category,
      message: entry.message,
      metadata: entry.metadata,
    }))

    return NextResponse.json({
      logs: limitedLogs,
      stats: {
        totalInMeasuredWindow: logs.length,
        sampled: rows.length,
        displayed: limitedLogs.length,
        byLevel: logs.reduce((acc: Record<string, number>, log) => {
          acc[log.level] = (acc[log.level] || 0) + 1
          return acc
        }, {}),
        byCategory: logs.reduce((acc: Record<string, number>, log) => {
          acc[log.category || "unknown"] = (acc[log.category || "unknown"] || 0) + 1
          return acc
        }, {}),
      },
    })
  } catch (error) {
    console.error("[v0] Error fetching logs:", error)
    return NextResponse.json(
      {
        error: "Failed to fetch logs",
        details: error instanceof Error ? error.message : "Unknown error",
        logs: [],
        stats: {
          totalInMeasuredWindow: 0,
          sampled: 0,
          displayed: 0,
          byLevel: {},
          byCategory: {},
        },
      },
      { status: 500 },
    )
  }
}
export async function POST(request: NextRequest) {
  try {
    const { level, category, message, metadata } = await request.json()
    if (!level || !category || !message) {
      return NextResponse.json(
        { error: "Missing required fields: level, category, message" },
        { status: 400 },
      )
    }
    const normalizedLevel =
      level === "error" ? "error" : level === "warn" || level === "warning" ? "warn" : "info"
    const normalizedCategory =
      String(category).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "api"

    await initRedis()
    await SystemLogger.logToDatabase({
      timestamp: new Date().toISOString(),
      level: normalizedLevel,
      category: normalizedCategory,
      message: String(message),
      metadata:
        metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? metadata
          : undefined,
    })
    // Make an API-created diagnostic visible to the immediately following GET
    // while retaining the logger's bounded-list storage contract.
    await SystemLogger.flushQueuedLogs()

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Error creating log entry:", error)
    return NextResponse.json(
      {
        error: "Failed to create log entry",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
