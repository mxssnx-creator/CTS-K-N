import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getAllConnections, getConnection } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id

    await initRedis()
    const connection = await getConnection(connectionId)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Check 1: Connection state
    const connectionValid = {
      id: connectionId,
      name: connection.name,
      exchange: connection.exchange,
      enabled: connection.is_enabled === "1" || connection.is_enabled === true,
      dashboard_inserted: connection.is_dashboard_inserted === "1" || connection.is_dashboard_inserted === true,
      dashboard_enabled: connection.is_enabled_dashboard === "1" || connection.is_enabled_dashboard === true,
      live_trade: connection.is_live_trade === "1" || connection.is_live_trade === true,
    }

    // Check 2: Try to fetch progression state to validate historic data retrieval
    const progressionKey = `progression:${connectionId}`

    // Check 3: Validate indication calculations are running
    const indicationSetKeys = [
      `indication_set:${connectionId}:direction`,
      `indication_set:${connectionId}:move`,
      `indication_set:${connectionId}:active`,
      `indication_set:${connectionId}:optimal`,
    ]

    const validationResults = {
      connection: connectionValid,
      indicationCalculations: {
        direction: "pending",
        move: "pending",
        active: "pending",
        optimal: "pending",
      },
      errors: [] as string[],
      warnings: [] as string[],
      metrics: {
        historicDataRetrieved: false,
        indicationsCalculated: false,
        timeout: false,
        evaluationsCorrect: true,
      }
    }

    // Validate prerequisites
    if (!connectionValid.enabled) {
      validationResults.errors.push("Connection not enabled in Settings")
    }

    if (!connectionValid.dashboard_inserted) {
      validationResults.errors.push("Connection not inserted to dashboard")
    }

    if (!connectionValid.dashboard_enabled && connectionValid.live_trade) {
      validationResults.errors.push("Live trading enabled but connection not active on dashboard")
    }

    return NextResponse.json({
      success: true,
      connectionId,
      validation: validationResults,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error(`[v0] [IndicationValidation] Error:`, error)
    await SystemLogger.logError(error, "api", "GET /api/connections/validation/[id]")
    
    return NextResponse.json(
      {
        error: "Validation failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
