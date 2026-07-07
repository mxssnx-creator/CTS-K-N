import { NextResponse } from "next/server"
import { verifyEngineSystem, logEngineSystemState } from "@/lib/engine-system-verification"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const verbose = searchParams.get("verbose") === "true"
    
    console.log("[v0] [Engine Verification] Running comprehensive system checks...")
    
    if (verbose) {
      await logEngineSystemState()
    }
    
    const report = await verifyEngineSystem()
    
    return NextResponse.json(report)
  } catch (error) {
    console.error("[v0] [Engine Verification] Error:", error)
    return NextResponse.json(
      {
        error: "Verification failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
