import { NextResponse } from "next/server"
import { initRedis, getAllConnections } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

/**
 * GET /api/settings/connections/available
 * Returns base connections that are:
 * 1. Enabled in Settings (is_enabled=true)
 * 2. NOT yet added to Active panel (is_active_inserted=false)
 */
export async function GET() {
  try {
    await initRedis()
    const allConnections = await getAllConnections()
    const baseIds = new Set(["bingx-x01", "pionex-x01", "orangex-x01"])
    
    // Filter for base connections that are enabled but NOT in Active panel
    const availableConnections = allConnections.filter((c: any) => {
      if (!baseIds.has(c.id)) return false
      // Must be enabled in Settings
      const isEnabled = c.is_enabled === true || c.is_enabled === "1" || c.is_enabled === "true"
      // Must NOT already be in Active panel
      const isInActivePanel = c.is_active_inserted === true || c.is_active_inserted === "1" || c.is_active_inserted === "true"
      
      return isEnabled && !isInActivePanel
    })
    
    console.log(`[v0] [Available] Found ${availableConnections.length} available connections`)
    
    return NextResponse.json({
      success: true,
      connections: availableConnections.map((c: any) => ({
        id: c.id,
        name: c.name,
        exchange: c.exchange,
        api_type: c.api_type,
        last_test_status: c.last_test_status,
        has_credentials: (c.api_key || "").length > 10 && (c.api_secret || "").length > 10,
      })),
      count: availableConnections.length,
    })
  } catch (error) {
    console.error("[v0] [Available] Error:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to get available connections" },
      { status: 500 }
    )
  }
}
