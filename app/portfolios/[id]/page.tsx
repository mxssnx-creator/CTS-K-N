"use client"
export const dynamic = "force-dynamic"


import { useState, useEffect } from "react"
import { useParams } from "next/navigation"
import { PortfolioMetrics } from "@/components/dashboard/portfolio-metrics"
import { RiskSettings } from "@/components/dashboard/risk-settings"
import { PositionsTable } from "@/components/dashboard/positions-table"
import { Button } from "@/components/ui/button"
import { ArrowLeft } from "lucide-react"
import Link from "next/link"
import { PageLoading, PageState } from "@/components/page-scaffold"
import { AlertTriangle } from "lucide-react"

export default function PortfolioDetailPage() {
  const params = useParams()
  const portfolioId = Number.parseInt(String(params?.id ?? ""), 10)

  const [metrics, setMetrics] = useState<any>(null)
  const [riskLimits, setRiskLimits] = useState<any>(null)
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!Number.isSafeInteger(portfolioId) || portfolioId <= 0) {
      setLoading(false)
      return
    }
    void fetchPortfolioData()
  }, [portfolioId])

  const fetchPortfolioData = async () => {
    try {
      // Fetch metrics
      const metricsResponse = await fetch(`/api/portfolios/${portfolioId}/metrics`)
      const metricsData = await metricsResponse.json()
      if (metricsData.success) {
        setMetrics(metricsData.data)
      }

      // Fetch risk limits
      const limitsResponse = await fetch(`/api/portfolios/${portfolioId}/risk-limits`)
      const limitsData = await limitsResponse.json()
      if (limitsData.success) {
        setRiskLimits(limitsData.data)
      }

      // Fetch positions
      const positionsResponse = await fetch(`/api/positions?portfolio_id=${portfolioId}`)
      const positionsData = await positionsResponse.json()
      if (positionsData.success) {
        setPositions(positionsData.data)
      }
    } catch (error) {
      console.error("[v0] Error fetching portfolio data:", error)
    } finally {
      setLoading(false)
    }
  }

  const handleUpdateRiskLimits = async (newLimits: any) => {
    try {
      const response = await fetch(`/api/portfolios/${portfolioId}/risk-limits`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newLimits),
      })

      const data = await response.json()
      if (data.success) {
        setRiskLimits(newLimits)
      }
    } catch (error) {
      console.error("[v0] Error updating risk limits:", error)
    }
  }

  if (loading) {
    return (
      <div className="page-section">
        <PageLoading label="Loading portfolio detail…" />
      </div>
    )
  }

  return (
    <div className="page-section space-y-5">
        <div className="flex items-center gap-3 rounded-xl border bg-card/70 p-3">
          <Link href="/portfolios">
            <Button variant="ghost" size="icon" aria-label="Back to portfolios">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h2 className="text-sm font-semibold">Portfolio #{Number.isFinite(portfolioId) ? portfolioId : "—"}</h2>
            <p className="text-xs text-muted-foreground">Performance metrics and persisted risk limits</p>
          </div>
        </div>

        {(!Number.isSafeInteger(portfolioId) || portfolioId <= 0) && (
          <PageState
            icon={AlertTriangle}
            tone="warning"
            title="Invalid portfolio identifier"
            description="Choose a portfolio from the portfolio overview to open a valid detail route."
          />
        )}

        {Number.isSafeInteger(portfolioId) && portfolioId > 0 && metrics && <PortfolioMetrics metrics={metrics} />}

        {riskLimits && (
          <RiskSettings portfolioId={portfolioId} currentLimits={riskLimits} onUpdate={handleUpdateRiskLimits} />
        )}

        {Number.isSafeInteger(portfolioId) && portfolioId > 0 && <PositionsTable positions={positions} />}
    </div>
  )
}
