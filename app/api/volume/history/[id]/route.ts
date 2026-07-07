import { NextResponse, type NextRequest } from "next/server"
import { initRedis } from "@/lib/redis-db"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: connectionId } = await params
    await initRedis()
    
    // Return empty volume history for now
    return NextResponse.json({
      connectionId,
      history: [],
      total: 0,
    })
  } catch (error) {
    console.error("[v0] Failed to get volume history:", error)
    return NextResponse.json(
      { error: "Failed to get volume history", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
