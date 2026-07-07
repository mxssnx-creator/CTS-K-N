import { type NextRequest, NextResponse } from "next/server"

let globalTradeEngine: any = null

export const dynamic = "force-dynamic"
export function setGlobalTradeEngine(engine: any) {
  globalTradeEngine = engine
}

export async function POST(request: NextRequest) {
  try {
    if (!globalTradeEngine) {
      return NextResponse.json({ success: false, error: "Trade engine not initialized" }, { status: 503 })
    }

    let force = false
    let clearCache = false
    try {
      const text = await request.text()
      if (text && text.trim()) {
        const body = JSON.parse(text)
        force = body.force ?? false
        clearCache = body.clearCache ?? false
      }
    } catch {
      // Empty body - use defaults
    }

    console.log("[v0] Restarting trade engine...", { force, clearCache })

    // Stop the engine first
    await globalTradeEngine.stop()

    // Optional: Clear cache if requested
    if (clearCache) {
      console.log("[v0] Clearing engine cache...")
      // Clear any cached data if needed
    }

    // Wait a moment before restart
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Start the engine again
    await globalTradeEngine.start()

    console.log("[v0] Trade engine restarted successfully")

    return NextResponse.json({
      success: true,
      message: "Trade engine restarted successfully",
      timestamp: new Date().toISOString(),
    })
  } catch (error: any) {
    console.error("[v0] Error restarting trade engine:", error)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}
