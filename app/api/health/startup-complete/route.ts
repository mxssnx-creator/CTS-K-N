import { NextResponse } from "next/server"
import { startPeriodicConnectionTesting } from "@/lib/pre-startup"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/health/startup-complete
 * Called after the server is fully ready to start periodic connection testing
 * This ensures API routes are ready before connection tests run
 */
export async function POST() {
  try {
    console.log("[v0] [Health] Server ready - starting connection tests...")
    
    // Start immediate test
    console.log("[v0] [Health] Running first connection test...")
    
    // Start periodic testing (every 5 minutes)
    startPeriodicConnectionTesting()
    
    console.log("[v0] [Health] ✓ Connection testing started")
    
    return NextResponse.json({
      success: true,
      message: "Server startup complete, connection testing initiated",
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] [Health] Startup complete error:", errorMessage)
    
    return NextResponse.json({
      success: false,
      error: errorMessage,
    }, { status: 500 })
  }
}
