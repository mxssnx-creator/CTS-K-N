import { type NextRequest, NextResponse } from "next/server"
import { getAllConnections, getSettings } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    console.log("[v0] Preparing deployment package...")

    // Get all system data from Redis
    const connections = await getAllConnections()
    const systemSettings = await getSettings("system_settings")
    const indicators = await getSettings("indicators")

    // Create deployment package data
    const deploymentData = {
      version: "3.0.0",
      timestamp: new Date().toISOString(),
      connections: Array.isArray(connections) ? connections.length : 0,
      settings: systemSettings ? Object.keys(systemSettings).length : 0,
      indicators: Array.isArray(indicators) ? indicators.length : 0,
      storage: "Redis",
      backup_ready: true,
    }

    console.log("[v0] Deployment package prepared:", deploymentData)

    // Return as JSON
    return NextResponse.json({
      success: true,
      message: "Deployment package prepared",
      data: deploymentData,
    })
  } catch (error) {
    console.error("[v0] Failed to prepare deployment:", error)
    return NextResponse.json(
      {
        error: "Failed to prepare deployment package",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
