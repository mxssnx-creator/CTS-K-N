import { type NextRequest, NextResponse } from "next/server"
import { clearSession } from "@/lib/auth"

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    await clearSession()

    return NextResponse.json({
      success: true,
      message: "Logged out successfully",
    })
  } catch (error) {
    console.error("[v0] Logout error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
