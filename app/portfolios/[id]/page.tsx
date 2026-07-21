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

  const handleClosePosition = async (positionId: number) => {
    console.log("[v0] Closing position:", positionId)
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground">Loading portfolio...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 overflow-auto">
      <div className="p-6 space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/portfolios">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-4xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              Portfolio Details
            </h1>
            <p className="text-muted-foreground mt-1">Performance metrics and risk management</p>
          </div>
        </div>

        {metrics && <PortfolioMetrics metrics={metrics} />}

        {riskLimits && (
          <RiskSettings portfolioId={portfolioId} currentLimits={riskLimits} onUpdate={handleUpdateRiskLimits} />
        )}

        <PositionsTable positions={positions} onClosePosition={handleClosePosition} />
      </div>
    </div>
  )
}
