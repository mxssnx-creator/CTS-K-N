import { type NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const backupId = searchParams.get("backup_id")

    if (!backupId) {
      return NextResponse.json({ error: "Backup ID is required" }, { status: 400 })
    }

    console.log("[v0] Downloading backup:", backupId)

    // In production, this would return actual backup file
    // For now, return success message
    return NextResponse.json({
      success: true,
      message: "Backup download prepared",
      backup_id: backupId,
    })
  } catch (error) {
    console.error("[v0] Failed to download backup:", error)
    return NextResponse.json(
      {
        error: "Failed to download backup",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
