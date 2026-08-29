import { NextResponse, type NextRequest } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { getRuntimeMaintenanceState, runtimeMaintenanceJson } from "@/lib/runtime-maintenance"

export const dynamic = "force-dynamic"
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; presetId: string }> }
) {
  try {
    const maintenance = getRuntimeMaintenanceState()
    if (maintenance.active) {
      return NextResponse.json(runtimeMaintenanceJson(maintenance), { status: 503 })
    }

    const { id: connectionId, presetId } = await params
    
    await SystemLogger.logTradeEngine(
      `Starting preset trade engine for connection ${connectionId}, preset ${presetId}`,
      "info",
      { connectionId, presetId }
    )
    
    return NextResponse.json({
      success: true,
      message: `Preset trade engine started for ${presetId}`,
      connectionId,
      presetId,
    })
  } catch (error) {
    console.error("[v0] Failed to start preset trade engine:", error)
    return NextResponse.json(
      { error: "Failed to start", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
