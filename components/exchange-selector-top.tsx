"use client"

import { useEffect } from "react"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useExchange } from "@/lib/exchange-context"

interface Connection {
  id: string
  name: string
  exchange: string
  isReal: boolean
  status: "connected" | "disconnected" | "error"
  isDashboardEnabled?: boolean
  isLiveTradeEnabled?: boolean
}

const STANDARD_OPTION: Connection = {
  id: "standard",
  name: "Standard",
  exchange: "Mock",
  isReal: false,
  status: "connected",
  isDashboardEnabled: false,
  isLiveTradeEnabled: false,
}

interface ExchangeSelectorTopProps {
  variant?: "header" | "sidebar"
}

export function ExchangeSelectorTop({ variant = "header" }: ExchangeSelectorTopProps) {
  const { selectedConnectionId, setSelectedConnectionId, activeConnections, isLoading, loadActiveConnections } = useExchange()

  const currentConnection = activeConnections.find((c) => c.id === selectedConnectionId) || STANDARD_OPTION

  const handleSelectConnection = (id: string) => {
    setSelectedConnectionId(id)
  }

  const defaultValue = selectedConnectionId || "standard"
  const isSidebar = variant === "sidebar"

  const renderStatusBadges = () => {
    return (
      <>
        {currentConnection.isDashboardEnabled && (
          <Badge className="bg-green-500/20 text-green-600 border border-green-500/30 text-xs">Active</Badge>
        )}
        {currentConnection.isLiveTradeEnabled && (
          <Badge className="bg-blue-500/20 text-blue-600 border border-blue-500/30 text-xs">Live</Badge>
        )}
      </>
    )
  }

  useEffect(() => {
    loadActiveConnections({ force: true }).catch((error) => {
      console.warn("[v0] [ExchangeSelectorTop] Failed to load active connections:", error)
    })
  }, [loadActiveConnections])

  return (
    <div className="w-full min-w-0">
      <div className="flex flex-col gap-1 min-w-0">
        <Select value={defaultValue} onValueChange={handleSelectConnection}>
          <SelectTrigger className={isSidebar ? "w-full min-w-0 h-8 text-sm border-input bg-background hover:bg-muted" : "w-full min-w-0 max-w-[260px] h-8 text-sm border-input bg-background/90 hover:bg-muted"}>
            {/* Explicit label: Radix renders an empty trigger whenever the value has no
                mounted item (e.g. while the connection list refreshes). */}
            <SelectValue placeholder="Select connection" className="min-w-0 flex-1 overflow-hidden">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{currentConnection.name || currentConnection.exchange}</span>
                <span className="shrink-0 text-[10px] uppercase text-muted-foreground">{currentConnection.exchange}</span>
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="standard" className="cursor-pointer">
              <div className="flex items-center gap-2">
                <span>Standard</span>
                <span className="text-muted-foreground text-xs">(Mock)</span>
              </div>
            </SelectItem>

            {activeConnections.length === 0 && isLoading ? (
              <div className="px-2 py-2 text-center text-muted-foreground text-xs">Loading...</div>
            ) : activeConnections.length === 0 ? (
              <div className="px-2 py-2 text-center text-muted-foreground text-xs">No Main Connections</div>
            ) : (
              activeConnections.map((conn) => (
                <SelectItem key={conn.id} value={conn.id} className="cursor-pointer">
                  <div className="flex items-center gap-2">
                    <span>{conn.name || conn.exchange}</span>
                    <Badge variant="outline" className="text-[10px]">{conn.exchange}</Badge>
                  </div>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap gap-1">
          {renderStatusBadges()}
        </div>
      </div>
    </div>
  )
}
