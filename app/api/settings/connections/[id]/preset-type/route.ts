import { type NextRequest, NextResponse } from "next/server"
import { sql } from "@/lib/db"
import { initRedis, getConnection } from "@/lib/redis-db"
import { notifySettingsChanged } from "@/lib/settings-coordinator"

// PATCH /api/settings/connections/[id]/preset-type - Assign preset type to connection
export const dynamic = "force-dynamic"
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()
    const { preset_type_id } = body

    // Validate preset type exists if provided
    if (preset_type_id) {
      const [presetType] = await sql`
        SELECT id FROM preset_types WHERE id = ${preset_type_id}
      `

      if (!presetType) {
        return NextResponse.json({ error: "Preset type not found" }, { status: 404 })
      }
    }

    // Update connection
    await sql`
      UPDATE exchange_connections
      SET preset_type_id = ${preset_type_id || null},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}
    `

    // Notify engine of preset type change
    try {
      await initRedis()
      const connection = await getConnection(id)
      await notifySettingsChanged(id, ["preset_type_id"])
      const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
      const coordinator = getGlobalTradeEngineCoordinator()
      await coordinator.applyPendingChangesNow(id)
      
      // Recoordinate engine if needed
      if (connection) {
        const { isConnectionMainProcessing, hasConnectionCredentials, isTruthyFlag } = await import(
          "@/lib/connection-state-utils"
        )
        const shouldRun =
          isConnectionMainProcessing(connection) &&
          (hasConnectionCredentials(connection, 5, true) ||
            isTruthyFlag((connection as any).is_predefined) ||
            isTruthyFlag((connection as any).is_testnet) ||
            isTruthyFlag((connection as any).demo_mode))
        if (shouldRun) {
          await coordinator.startMissingEngines([connection])
        }
      }
    } catch (applyErr) {
      console.warn(
        `[v0] [PresetType] coordinator recoordination failed for ${id}:`,
        applyErr instanceof Error ? applyErr.message : String(applyErr),
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Failed to assign preset type:", error)
    return NextResponse.json({ error: "Failed to assign preset type" }, { status: 500 })
  }
}

// GET /api/settings/connections/[id]/preset-type - Fetch preset type for connection
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    // Get connection with preset type info
    const result = await sql`
      SELECT 
        ec.preset_type_id,
        pt.id as preset_id,
        pt.name as preset_name,
        pt.description as preset_description,
        pt.preset_trade_type,
        pt.max_positions_per_indication,
        pt.max_positions_per_direction,
        pt.max_positions_per_range,
        pt.timeout_per_indication,
        pt.timeout_after_position,
        pt.block_enabled,
        pt.block_only,
        pt.dca_enabled,
        pt.dca_only,
        pt.auto_evaluate,
        pt.evaluation_interval_hours,
        pt.is_active
      FROM exchange_connections ec
      LEFT JOIN preset_types pt ON ec.preset_type_id = pt.id
      WHERE ec.id = ${id}
    `

    const connection = result[0]

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    return NextResponse.json({
      presetType: connection.preset_id
        ? {
            id: connection.preset_id,
            name: connection.preset_name,
            description: connection.preset_description,
            preset_trade_type: connection.preset_trade_type,
            max_positions_per_indication: connection.max_positions_per_indication,
            max_positions_per_direction: connection.max_positions_per_direction,
            max_positions_per_range: connection.max_positions_per_range,
            timeout_per_indication: connection.timeout_per_indication,
            timeout_after_position: connection.timeout_after_position,
            block_enabled: connection.block_enabled,
            block_only: connection.block_only,
            dca_enabled: connection.dca_enabled,
            dca_only: connection.dca_only,
            auto_evaluate: connection.auto_evaluate,
            evaluation_interval_hours: connection.evaluation_interval_hours,
            is_active: connection.is_active,
          }
        : null,
    })
  } catch (error) {
    console.error("[v0] Failed to fetch preset type:", error)
    return NextResponse.json({ error: "Failed to fetch preset type" }, { status: 500 })
  }
}
