"use client"
export const dynamic = "force-dynamic"


import { useState, useEffect } from "react"
import { PortfolioOverview } from "@/components/dashboard/portfolio-overview"
import { PositionsTable } from "@/components/dashboard/positions-table"
import { OrdersHistory } from "@/components/dashboard/orders-history"

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

  const handleClosePosition = async (positionId: number) => {
    // Implement position closing logic
    console.log("[v0] Closing position:", positionId)
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-muted-foreground">Loading portfolios...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 overflow-auto">
      <div className="p-6 space-y-6">
        <div>
          <h1 className="text-4xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
            Portfolio Management
          </h1>
          <p className="text-muted-foreground mt-1">Monitor and manage your trading portfolios</p>
        </div>

        <PortfolioOverview portfolios={portfolios} onSelectPortfolio={setSelectedPortfolio} />

        {selectedPortfolio && (
          <>
            <PositionsTable positions={positions} onClosePosition={handleClosePosition} />

            <OrdersHistory orders={orders} />
          </>
        )}
      </div>
    </div>
  )
}
