import { NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { message, type, context } = body

    await SystemLogger.logToast(message, type, context)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[v0] Toast logging error:", error)
    return NextResponse.json({ error: "Failed to log toast" }, { status: 500 })
  }
}
