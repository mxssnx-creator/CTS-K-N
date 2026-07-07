import { NextRequest, NextResponse } from "next/server"
import { getProgressManager, getAllProgressManagers } from "@/lib/engine-progress-manager"
import { getEngineLogger } from "@/lib/engine-logger"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connectionId")

    if (!connectionId) {
      // Return all progress managers
      const allManagers = getAllProgressManagers()
      const allProgress = Array.from(allManagers.entries()).map(([id, manager]) => ({
        connectionId: id,
        state: manager.getState(),
      }))
      return NextResponse.json({ progress: allProgress })
    }

    const manager = getProgressManager(connectionId)
    const state = manager.getState()

    return NextResponse.json({ progress: state })
  } catch (error) {
    console.error("[EngineProgress] Error:", error)
    return NextResponse.json(
      { error: "Failed to get engine progress" },
      { status: 500 }
    )
  }
}
