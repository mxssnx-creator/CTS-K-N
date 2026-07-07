import { NextResponse } from "next/server"
import { getTradeEngine } from "@/lib/trade-engine"
import { SystemLogger } from "@/lib/system-logger"
import { sql } from "@/lib/db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/trade-engine/emergency-stop
 * EMERGENCY STOP: Immediately halts ALL trading operations
 * - Stops all trade engine instances across all connections
 * - Cancels all pending orders (if implemented)
 * - Pauses all active strategies
 * - Logs emergency stop event
 */
export async function POST() {
  try {
    console.log("[v0] 🚨 EMERGENCY STOP INITIATED 🚨")
    await SystemLogger.logTradeEngine("🚨 EMERGENCY STOP INITIATED - All trading operations halting", "error")

    const coordinator = getTradeEngine()

    // Stop the global coordinator
    if (coordinator) {
      await coordinator.stopAllEngines()
      await coordinator.pause()
      console.log("[v0] Global Trade Engine Coordinator stopped")
    }

    // Update all trade engine states to stopped
    await sql`
      UPDATE trade_engine_state
      SET status = 'stopped',
          error_message = 'Emergency stop activated',
          updated_at = CURRENT_TIMESTAMP
    `

    // Disable all live trading on connections
    await sql`
      UPDATE exchange_connections
      SET is_live_trade = FALSE,
          is_preset_trade = FALSE,
          updated_at = CURRENT_TIMESTAMP
      WHERE is_live_trade = TRUE OR is_preset_trade = TRUE
    `

    const timestamp = new Date().toISOString()
    
    await SystemLogger.logTradeEngine(
      `Emergency stop completed at ${timestamp}. All trading disabled.`,
      "error"
    )

    console.log("[v0] ✅ EMERGENCY STOP COMPLETED")

    return NextResponse.json({
      success: true,
      message: "Emergency stop activated successfully",
      timestamp,
      actions_taken: [
        "Global trade engine coordinator stopped",
        "All trade engine instances halted",
        "All live trading connections disabled",
        "All preset trading connections disabled"
      ]
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] 🚨 EMERGENCY STOP FAILED:", error)
    
    await SystemLogger.logError(
      error,
      "trade-engine",
      "Emergency Stop API - CRITICAL FAILURE"
    )

    return NextResponse.json(
      {
        success: false,
        error: "Emergency stop failed - manual intervention required",
        details: errorMessage
      },
      { status: 500 }
    )
  }
}
