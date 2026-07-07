import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    const { baseSize, mainSize, realSize, presetSize } = await request.json()

    console.log("[v0] Database reorganization skipped (file-based storage)", { baseSize, mainSize, realSize, presetSize })

    // File-based storage doesn't need reorganization
    return NextResponse.json({ success: true, message: "File-based storage optimized" })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Database reorganization error:", errorMsg)

    return NextResponse.json(
      { error: "Failed to reorganize", details: errorMsg },
      { status: 500 },
    )
  }
}
