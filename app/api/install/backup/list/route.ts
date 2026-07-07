import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    console.log("[v0] Loading backups list...")

    // In a real implementation, this would list actual backup files
    // For now, return mock data structure
    const backups = [
      {
        id: "backup-1",
        name: "Manual Backup - 2025-01-10",
        size: "2.4 MB",
        created_at: new Date().toISOString(),
        type: "manual",
      },
    ]

    return NextResponse.json({ success: true, backups })
  } catch (error) {
    console.error("[v0] Failed to load backups:", error)
    return NextResponse.json(
      {
        error: "Failed to load backups",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
