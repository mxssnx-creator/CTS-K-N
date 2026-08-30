import { NextResponse } from "next/server"
import { clearSession } from "@/lib/auth"

export const dynamic = "force-dynamic"

export async function POST() {
  try {
    await clearSession()
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Logout error:", error)
    return NextResponse.json({ success: false, error: "Logout failed" }, { status: 500 })
  }
}
