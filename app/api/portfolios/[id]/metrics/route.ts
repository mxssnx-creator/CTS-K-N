// API endpoint for portfolio metrics
import { type NextRequest, NextResponse } from "next/server"
import { PortfolioAnalytics } from "@/lib/portfolio-analytics"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const portfolioId = Number.parseInt(id)

    if (isNaN(portfolioId)) {
      return NextResponse.json({ success: false, error: "Invalid portfolio ID" }, { status: 400 })
    }

    const analytics = new PortfolioAnalytics(portfolioId)
    const metrics = await analytics.calculateMetrics()

    return NextResponse.json({
      success: true,
      data: metrics,
    })
  } catch (error) {
    console.error("[v0] Error calculating portfolio metrics:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
