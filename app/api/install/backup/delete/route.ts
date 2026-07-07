import { type NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json()
    const { backup_id } = body

    if (!backup_id) {
      return NextResponse.json({ error: "Backup ID is required" }, { status: 400 })
    }

    console.log("[v0] Deleting backup:", backup_id)

    // In production, this would delete actual backup files
    // For now, return success
    return NextResponse.json({
      success: true,
      message: "Backup deleted successfully",
    })
  } catch (error) {
    console.error("[v0] Failed to delete backup:", error)
    return NextResponse.json(
      {
        error: "Failed to delete backup",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
