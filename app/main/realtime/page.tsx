"use client"

import MarketDataMonitor from "@/components/realtime/market-data-monitor"
import PositionMonitor from "@/components/realtime/position-monitor"
import { useExchange } from "@/lib/exchange-context"

export const dynamic = "force-dynamic"

export default function RealtimePage() {
  const { selectedConnectionId } = useExchange()
  const connectionId = selectedConnectionId || ""

  return (
    <div className="page-section space-y-5">
      <div className="grid gap-6 md:grid-cols-2">
        <MarketDataMonitor connectionId={connectionId} />
        <PositionMonitor connectionId={connectionId} />
      </div>
    </div>
  )
}
