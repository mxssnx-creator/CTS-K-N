import { type NextRequest, NextResponse } from "next/server"
import { getSettings, setSettings } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const strategies = await getSettings("strategies")

    return NextResponse.json({
      success: true,
      data: strategies || [],
    })
  } catch (error) {
    console.error("[v0] Get strategies error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { name, description, strategy_type, parameters } = await request.json()

    if (!name || !strategy_type) {
      return NextResponse.json({ success: false, error: "Name and strategy type are required" }, { status: 400 })
    }

    const existing = (await getSettings("strategies")) || []
    const newStrategy = {
      id: `strategy:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`,
      user_id: "system",
      name,
      description: description || null,
      strategy_type,
      parameters: parameters || {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    existing.push(newStrategy)
    await setSettings("strategies", existing)

    return NextResponse.json({
      success: true,
      data: newStrategy,
    })
  } catch (error) {
    console.error("[v0] Create strategy error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
