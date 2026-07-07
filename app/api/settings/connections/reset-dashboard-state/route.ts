import { NextResponse } from "next/server"
import { initRedis, getAllConnections, updateConnection } from "@/lib/redis-db"

/**
 * POST /api/settings/connections/reset-dashboard-state
 * Resets dashboard enable state only, without destroying base settings/credentials.
 */
export const dynamic = "force-dynamic"
export async function POST() {
  try {
    await initRedis()
    const allConnections = await getAllConnections()
    
    console.log(`[v0] [ResetDashboard] Resetting ${allConnections.length} connections to disabled state...`)
    
    let updatedCount = 0
    for (const conn of allConnections) {
      // Force disable dashboard execution without changing base/settings enable state.
      const updated = {
        ...conn,
        is_enabled_dashboard: "0",         // NOT enabled by default
        is_dashboard_inserted: conn.is_dashboard_inserted ?? "0", // Preserve existing insertion
        is_enabled: conn.is_enabled || "1", // Preserve base settings state
        is_active_inserted: conn.is_active_inserted ?? "0", // Preserve — never force to "1"
        is_active: "0",                     // NOT processing
        updated_at: new Date().toISOString(),
      }
      
      await updateConnection(conn.id, updated)
      updatedCount++
      console.log(`[v0] [ResetDashboard] ✓ ${conn.name} -> disabled state`)
    }
    
    console.log(`[v0] [ResetDashboard] COMPLETE: Reset ${updatedCount} connections to disabled state`)
    
    return NextResponse.json({
      success: true,
      message: "All connections reset to disabled dashboard state",
      updatedCount,
    })
  } catch (error) {
    console.error(`[v0] [ResetDashboard] ERROR:`, error)
    return NextResponse.json(
      { success: false, error: "Failed to reset dashboard state", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
