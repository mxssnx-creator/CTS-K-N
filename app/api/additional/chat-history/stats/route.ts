import { NextResponse } from "next/server"
import { chatHistory } from "@/lib/additional/chat-history"

export const dynamic = "force-dynamic"
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const daysBack = Number.parseInt(searchParams.get("days") || "30")

    const stats = chatHistory.getStats(daysBack)

    return NextResponse.json(stats)
  } catch (error) {
    console.error("[v0] Chat history stats error:", error)
    return NextResponse.json({ error: "Failed to fetch stats" }, { status: 500 })
  }
}
