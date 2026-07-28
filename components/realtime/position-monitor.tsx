"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Target, TrendingUp, TrendingDown } from "lucide-react"

interface Position {
  id: string
  symbol: string
  side: "LONG" | "SHORT"
  entryPrice: number
  currentPrice: number
  quantity: number
  unrealizedPnl: number
  unrealizedPnlPercent: number
  status: "open" | "closing" | "closed"
}

export default function PositionMonitor({ connectionId }: { connectionId: string }) {
  const [positions, setPositions] = useState<Position[]>([])
  const [error, setError] = useState("")

  useEffect(() => {
    // Fetch positions periodically
    const fetchPositions = async () => {
      if (!connectionId) {
        setPositions([])
        setError("Select a connection to read active positions.")
        return
      }
      try {
        const response = await fetch(
          `/api/data/positions?connectionId=${encodeURIComponent(connectionId)}`,
          { cache: "no-store" },
        )
        const payload = await response.json()
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || "Active positions unavailable")
        }
        setPositions(Array.isArray(payload.data) ? payload.data : [])
        setError("")
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Active positions unavailable")
      }
    }

    fetchPositions()
    // Tier-1 perf: visibility-gated polling. Same 1s cadence when the
    // tab is foregrounded; pauses while hidden so a user with this
    // dashboard open in a background tab stops thrashing the API at
    // 60 req/min for pixels they can't see. On revisit a single
    // catch-up tick fires immediately so the first paint is fresh.
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      fetchPositions()
    }, 1000)
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") fetchPositions()
    }
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility)

    return () => {
      clearInterval(interval)
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [connectionId])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="h-5 w-5" />
          Active Positions
        </CardTitle>
        <CardDescription>Real-time position monitoring with PnL tracking</CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
            {error}
          </div>
        ) : positions.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">No active positions</div>
        ) : (
          <div className="space-y-3">
            {positions.map((position) => (
              <div key={position.id} className="border rounded-lg p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{position.symbol}</span>
                    <Badge variant={position.side === "LONG" ? "default" : "secondary"}>{position.side}</Badge>
                  </div>
                  <div
                    className={`flex items-center gap-1 font-bold ${position.unrealizedPnl >= 0 ? "text-green-600" : "text-red-600"}`}
                  >
                    {position.unrealizedPnl >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                    <span>
                      {position.unrealizedPnl >= 0 ? "+" : ""}
                      {position.unrealizedPnl.toFixed(2)} ({position.unrealizedPnlPercent.toFixed(2)}%)
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <p className="text-muted-foreground">Entry</p>
                    <p className="font-semibold">${position.entryPrice.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Current</p>
                    <p className="font-semibold">${position.currentPrice.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Quantity</p>
                    <p className="font-semibold">{position.quantity.toFixed(4)}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
