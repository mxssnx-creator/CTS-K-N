"use client"

import MarketDataMonitor from "@/components/realtime/market-data-monitor"
import PositionMonitor from "@/components/realtime/position-monitor"
import { useExchange } from "@/lib/exchange-context"

export const dynamic = "force-dynamic"

export default function RealtimePage() {
  const { selectedConnectionId } = useExchange()
  const connectionId = selectedConnectionId || "default-connection"

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Real-time Monitoring</h1>
        <p className="text-muted-foreground">Live market data and position tracking</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <MarketDataMonitor connectionId={connectionId} />
        <PositionMonitor connectionId={connectionId} />
      </div>
    </div>
  )
}
