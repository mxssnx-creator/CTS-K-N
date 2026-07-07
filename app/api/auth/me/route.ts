import { type NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const user = await getSession()

    if (!user) {
      return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 })
    }

    return NextResponse.json({
      success: true,
      data: { user },
    })
  } catch (error) {
    console.error("[v0] Get session error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
