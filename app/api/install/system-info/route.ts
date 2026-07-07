export const dynamic = "force-dynamic"
export const runtime = "nodejs"
import { NextResponse } from "next/server"
import os from "os"

export async function GET() {
  try {
    console.log("[v0] Retrieving system information...")

    const systemInfo = {
      platform: os.platform(),
      arch: os.arch(),
      node_version: process.version,
      total_memory: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2),
      free_memory: (os.freemem() / 1024 / 1024 / 1024).toFixed(2),
      cpu_cores: os.cpus().length,
      uptime: (os.uptime() / 3600).toFixed(2),
    }

    console.log("[v0] System information retrieved successfully")

    return NextResponse.json(systemInfo)
  } catch (error) {
    console.error("[v0] Failed to retrieve system info:", error)
    return NextResponse.json(
      {
        error: "Failed to retrieve system info",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
