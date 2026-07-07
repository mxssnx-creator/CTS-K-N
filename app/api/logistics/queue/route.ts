import { type NextRequest, NextResponse } from "next/server"
import { getDashboardWorkflowSnapshot } from "@/lib/dashboard-workflow"
import { buildLogisticsQueuePayload } from "@/lib/logistics-workflow"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    // When the Logistics page has a connection selected in the sidebar, the
    // queue payload re-focuses on that connection so "Focus Connection" in
    // the queue card mirrors the currently selected exchange.
    const connectionId = request.nextUrl.searchParams.get("connectionId") || undefined
    const preferredConnectionId =
      connectionId && connectionId !== "demo-mode" && !connectionId.startsWith("demo")
        ? connectionId
        : undefined
    const snapshot = await getDashboardWorkflowSnapshot({ preferredConnectionId })

    return NextResponse.json(buildLogisticsQueuePayload(snapshot))
  } catch (error) {
    console.error("[v0] [Logistics] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch logistics data",
        queueSize: 0,
        queueBacklog: 0,
        workflowHealth: "blocked",
        processingPressure: 0,
        processingRate: 0,
        successRate: 0,
        avgLatency: 0,
        completedOrders: 0,
        failedOrders: 0,
        maxLatency: 0,
        throughput: 0,
        workflow: [],
      },
      { status: 500 },
    )
  }
}
