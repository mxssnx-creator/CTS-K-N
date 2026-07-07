import { type NextRequest, NextResponse } from "next/server"
import { getIndications, saveIndication } from "@/lib/redis-db"
import { notifySettingsChanged } from "@/lib/settings-coordinator"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    // Get connection indications from Redis
    const indications = await getIndications(id)

    return NextResponse.json({
      indications: indications || [],
    })
  } catch (error) {
    console.error("[v0] Failed to fetch connection indications:", error)
    return NextResponse.json({ error: "Failed to fetch indications" }, { status: 500 })
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { indications } = await request.json()

    // Save indications to Redis
    for (const ind of indications) {
      const indication = {
        id: ind.id || `${id}-ind-${Date.now()}`,
        connection_id: id,
        type: ind.type || ind.indication_type,
        enabled: ind.enabled !== false,
        config: ind,
      }
      await saveIndication({ ...indication, connection_id: id })
    }

    // Notify engine of indications change
    try {
      await notifySettingsChanged(id, ["indications"])
      const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
      const coordinator = getGlobalTradeEngineCoordinator()
      await coordinator.applyPendingChangesNow(id)
    } catch (applyErr) {
      console.warn(
        `[v0] [Indications] coordinator recoordination failed for ${id}:`,
        applyErr instanceof Error ? applyErr.message : String(applyErr),
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Failed to update connection indications:", error)
    return NextResponse.json({ error: "Failed to update indications" }, { status: 500 })
  }
}
