/**
 * Complete System Verification Endpoint
 * Tests all database functionality, APIs, and trade engines
 */

import { NextResponse } from "next/server"
import { verifyCompleteSystem } from "@/lib/system-comprehensive-verifier"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/system/verify-complete
 * Run comprehensive system verification across all components
 */
export async function GET() {
  try {
    console.log("[v0] [API] Starting complete system verification...")

    const result = await verifyCompleteSystem()

    // Log summary
    console.log("[v0] [API] Verification completed:")
    console.log(`  Status: ${result.status}`)
    console.log(`  Passed: ${result.summary.passed}/${result.summary.totalTests}`)
    console.log(`  Failed: ${result.summary.failed}/${result.summary.totalTests}`)

    if (result.summary.warnings.length > 0) {
      console.warn("[v0] [API] Warnings:", result.summary.warnings)
    }

    return NextResponse.json(result, {
      status: result.status === "success" ? 200 : result.status === "partial" ? 206 : 500,
    })
  } catch (error) {
    console.error("[v0] [API] Verification error:", error)

    return NextResponse.json(
      {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
        timestamp: new Date(),
      },
      { status: 500 }
    )
  }
}
