import { NextResponse, type NextRequest } from "next/server"
import { SystemLogger } from "@/lib/system-logger"

export const dynamic = "force-dynamic"
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; presetId: string }> }
) {
  try {
    const { id: connectionId, presetId } = await params
    
    await SystemLogger.logTradeEngine(
      `Stopping preset trade engine for connection ${connectionId}, preset ${presetId}`,
      "info",
      { connectionId, presetId }
    )
    
    return NextResponse.json({
      success: true,
      message: `Preset trade engine stopped for ${presetId}`,
      connectionId,
      presetId,
    })
  } catch (error) {
    console.error("[v0] Failed to stop preset trade engine:", error)
    return NextResponse.json(
      { error: "Failed to stop", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
