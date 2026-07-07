import { type NextRequest, NextResponse } from "next/server"
import { getSettings, setSettings } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const allPortfolios = (await getSettings("portfolios")) || []

    return NextResponse.json({
      success: true,
      data: allPortfolios,
    })
  } catch (error) {
    console.error("[v0] Get portfolios error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { name, description, initial_value } = await request.json()

    if (!name) {
      return NextResponse.json({ success: false, error: "Portfolio name is required" }, { status: 400 })
    }

    const existing = (await getSettings("portfolios")) || []
    const newPortfolio = {
      id: `portfolio:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`,
      user_id: "system",
      name,
      description: description || null,
      initial_value: initial_value || 0,
      total_value: initial_value || 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    existing.push(newPortfolio)
    await setSettings("portfolios", existing)

    return NextResponse.json({
      success: true,
      data: newPortfolio,
    })
  } catch (error) {
    console.error("[v0] Create portfolio error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
