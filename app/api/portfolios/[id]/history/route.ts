// API endpoint for portfolio performance history
import { type NextRequest, NextResponse } from "next/server"
import { PortfolioAnalytics } from "@/lib/portfolio-analytics"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const portfolioId = Number.parseInt(id)
    const { searchParams } = new URL(request.url)
    const days = Number.parseInt(searchParams.get("days") || "30")

    if (isNaN(portfolioId)) {
      return NextResponse.json({ success: false, error: "Invalid portfolio ID" }, { status: 400 })
    }

    const analytics = new PortfolioAnalytics(portfolioId)
    const history = await analytics.getPerformanceHistory(days)

    return NextResponse.json({
      success: true,
      data: history,
    })
  } catch (error) {
    console.error("[v0] Error fetching portfolio history:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
