import { NextResponse } from "next/server"
import { WorkflowLogger } from "@/lib/workflow-logger"
import { initRedis } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await initRedis()

    const { id: connectionId } = await params
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get("limit") || "100", 10)
    const eventType = searchParams.get("eventType") as any
    const statsOnly = searchParams.get("stats") === "true"
    const timeWindowMs = parseInt(searchParams.get("timeWindow") || "3600000", 10)

    if (!connectionId) {
      return NextResponse.json(
        { success: false, error: "Connection ID required" },
        { status: 400 }
      )
    }

    if (statsOnly) {
      // Return only statistics
      const stats = await WorkflowLogger.getStats(connectionId, timeWindowMs)
      return NextResponse.json({
        success: true,
        connectionId,
        stats,
        timeWindowMs,
      })
    }

    // Return logs
    const logs = await WorkflowLogger.getLogs(connectionId, limit, eventType)

    return NextResponse.json({
      success: true,
      connectionId,
      logs,
      count: logs.length,
      eventType: eventType || "all",
    })
  } catch (error) {
    console.error("[v0] [Workflow Logs API] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to retrieve workflow logs",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await initRedis()

    const { id: connectionId } = await params

    if (!connectionId) {
      return NextResponse.json(
        { success: false, error: "Connection ID required" },
        { status: 400 }
      )
    }

    await WorkflowLogger.clearLogs(connectionId)

    return NextResponse.json({
      success: true,
      connectionId,
      message: "Workflow logs cleared",
    })
  } catch (error) {
    console.error("[v0] [Workflow Logs API] Clear error:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to clear workflow logs",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
