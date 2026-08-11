"use client"
export const dynamic = "force-dynamic"


import { useState, useEffect } from "react"
import { PortfolioOverview } from "@/components/dashboard/portfolio-overview"
import { PositionsTable } from "@/components/dashboard/positions-table"
import { OrdersHistory } from "@/components/dashboard/orders-history"
import { PageLoading, PageState } from "@/components/page-scaffold"
import { WalletCards } from "lucide-react"

export default function PortfoliosPage() {
  const [portfolios, setPortfolios] = useState([])
  const [selectedPortfolio, setSelectedPortfolio] = useState<number | null>(null)
  const [positions, setPositions] = useState([])
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchPortfolios()
  }, [])

  useEffect(() => {
    if (selectedPortfolio) {
      fetchPositions(selectedPortfolio)
      fetchOrders(selectedPortfolio)
    }
  }, [selectedPortfolio])

  const fetchPortfolios = async () => {
    try {
      const response = await fetch("/api/portfolios")
      const data = await response.json()
      if (data.success) {
        setPortfolios(data.data)
        if (data.data.length > 0) {
          setSelectedPortfolio(data.data[0].id)
        }
      }
    } catch (error) {
      console.error("[v0] Error fetching portfolios:", error)
    } finally {
      setLoading(false)
    }
  }

  const fetchPositions = async (portfolioId: number) => {
    try {
      const response = await fetch(`/api/positions?portfolio_id=${portfolioId}`)
      const data = await response.json()
      if (data.success) {
        setPositions(data.data)
      }
    } catch (error) {
      console.error("[v0] Error fetching positions:", error)
    }
  }

  const fetchOrders = async (portfolioId: number) => {
    try {
      const response = await fetch(`/api/orders?portfolio_id=${portfolioId}&limit=20`)
      const data = await response.json()
      if (data.success) {
        setOrders(data.data)
      }
    } catch (error) {
      console.error("[v0] Error fetching orders:", error)
    }
  }

  if (loading) {
    return (
      <div className="page-section">
        <PageLoading label="Loading portfolio data…" />
      </div>
    )
  }

  return (
    <div className="page-section space-y-5">
        <PortfolioOverview portfolios={portfolios} onSelectPortfolio={setSelectedPortfolio} />

        {selectedPortfolio && (
          <>
            <PositionsTable positions={positions} />

            <OrdersHistory orders={orders} />
          </>
        )}
        {!selectedPortfolio && (
          <PageState
            icon={WalletCards}
            title="No portfolio selected"
            description="Create or select a persisted portfolio to display its positions and order history."
          />
        )}
    </div>
  )
}
