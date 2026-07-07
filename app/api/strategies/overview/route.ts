import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    // Mock strategy data - in production, fetch from database or trade engine
    const strategies = [
      {
        name: "Base Strategy",
        type: "base",
        exchange: "Bybit",
        active: true,
        positions: 12,
        winRate: 65.5,
        profit: 3.2,
        drawdown: 2.1,
      },
      {
        name: "Main Strategy",
        type: "main",
        exchange: "BingX",
        active: true,
        positions: 8,
        winRate: 72.3,
        profit: 5.7,
        drawdown: 1.8,
      },
      {
        name: "Real Strategy",
        type: "real",
        exchange: "Bybit",
        active: false,
        positions: 0,
        winRate: 0,
        profit: 0,
        drawdown: 0,
      },
      {
        name: "Live Strategy",
        type: "live",
        exchange: "OrangeX",
        active: true,
        positions: 5,
        winRate: 68.9,
        profit: 2.4,
        drawdown: 3.2,
      },
    ]

    return NextResponse.json(strategies)
  } catch (error) {
    console.error("[v0] Error fetching strategies:", error)
    return NextResponse.json([], { status: 200 })
  }
}
