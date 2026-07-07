"use client"


export const dynamic = "force-dynamic"
// Page with sidebar and exchange selector
import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { PositionRowCompact } from "@/components/live-trading/position-row-compact"
import { Activity, TrendingUp, TrendingDown, RefreshCw, Play, Pause, AlertCircle, BarChart3 } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import { useExchange } from "@/lib/exchange-context"
import { usePositionUpdates } from "@/lib/use-websocket"
import { PageHeader } from "@/components/page-header"

interface Position {
  id: string
  symbol: string
  side: "LONG" | "SHORT"
  entryPrice: number
  currentPrice: number
  quantity: number
  leverage: number
  unrealizedPnl: number
  unrealizedPnlPercent: number
  takeProfitPrice?: number
  stopLossPrice?: number
  createdAt: string
  status: "open" | "closing" | "closed"
}

export default function LiveTradingPage() {
  const { selectedConnectionId } = useExchange()
  const [positions, setPositions] = useState<Position[]>([])
  const [isDemo, setIsDemo] = useState(false)
  const [isEngineRunning, setIsEngineRunning] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set())
  const [sortBy, setSortBy] = useState<"pnl" | "entry" | "time">("pnl")
  const [filterSide, setFilterSide] = useState<"all" | "long" | "short">("all")
  // Keep a stable ref to the fetch function so the polling interval can call
  // it without adding it as a dependency (avoids interval recreation churn).
  const loadPositionsRef = useRef<(() => Promise<void>) | undefined>(undefined)

  const loadPositions = useCallback(async () => {
    try {
      const connectionToUse = selectedConnectionId || "demo-mode"
      const response = await fetch(`/api/data/positions?connectionId=${encodeURIComponent(connectionToUse)}`)
      if (!response.ok) throw new Error(`Failed to fetch positions: ${response.statusText}`)
      const data = await response.json()
      if (data.success) {
        setPositions(data.data || [])
        setIsDemo(data.isDemo)
      } else {
        throw new Error(data.error || "Unknown error")
      }
    } catch (error) {
      console.error("[Live Trading] Failed to load:", error)
    }
  }, [selectedConnectionId])

  // Keep ref in sync
  useEffect(() => { loadPositionsRef.current = loadPositions }, [loadPositions])

  // Initial load + 5-second polling so closed positions disappear from the UI
  useEffect(() => {
    let cancelled = false
    const doLoad = async () => {
      setIsLoading(true)
      try { await loadPositions() } catch { /* ignore */ }
      if (!cancelled) setIsLoading(false)
    }
    doLoad()

    const interval = setInterval(() => {
      loadPositionsRef.current?.()
    }, 5000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [loadPositions])

  // Close a position: call the server so PseudoPositionManager records the close,
  // then immediately remove it from local state for instant UI feedback.
  const handleClosePosition = useCallback(async (id: string) => {
    if (closingIds.has(id)) return // prevent double-close
    const connectionToUse = selectedConnectionId || "demo-mode"
    setClosingIds((prev) => new Set([...prev, id]))
    // Optimistic removal from local state
    setPositions((prev) => prev.filter((p) => p.id !== id))
    try {
      const res = await fetch(
        `/api/data/positions/${encodeURIComponent(id)}?connectionId=${encodeURIComponent(connectionToUse)}`,
        { method: "DELETE" },
      )
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.success) {
        // Revert optimistic removal on failure and re-fetch to get accurate state
        toast.error(`Failed to close position: ${body?.error ?? res.statusText}`)
        await loadPositions()
      } else {
        toast.success("Position closed")
      }
    } catch (err) {
      console.error("[Live Trading] Close position error:", err)
      toast.error("Failed to close position")
      await loadPositions()
    } finally {
      setClosingIds((prev) => { const next = new Set(prev); next.delete(id); return next })
    }
  }, [selectedConnectionId, closingIds, loadPositions])

  // Handle real-time position updates via SSE
  const handlePositionUpdate = useCallback((update: any) => {
    setPositions((prev) => {
      // Find existing position and update it, or add new one
      const existingIndex = prev.findIndex((p) => p.id === update.id)
      if (existingIndex >= 0) {
        // Update existing position
        const updated = [...prev]
        updated[existingIndex] = {
          ...updated[existingIndex],
          currentPrice: update.currentPrice,
          unrealizedPnl: update.unrealizedPnl,
          unrealizedPnlPercent: update.unrealizedPnlPercent,
          status: update.status || updated[existingIndex].status,
        }
        return updated
      } else {
        // Add new position if not in demo mode
        if (!isDemo) {
          return [
            ...prev,
            {
              id: update.id,
              symbol: update.symbol,
              side: 'LONG',
              entryPrice: update.currentPrice,
              currentPrice: update.currentPrice,
              quantity: 1,
              leverage: 1,
              unrealizedPnl: 0,
              unrealizedPnlPercent: 0,
              createdAt: new Date().toISOString(),
              status: update.status || 'open',
            },
          ]
        }
        return prev
      }
    })
  }, [isDemo])

  // Subscribe to position updates via SSE
  usePositionUpdates(
    selectedConnectionId && selectedConnectionId !== "demo-mode" ? selectedConnectionId : "",
    handlePositionUpdate
  )

  // Simulate real-time price updates (fallback for demo mode)
  useEffect(() => {
    if (!isEngineRunning) return

    const interval = setInterval(() => {
      setPositions((prev) =>
        prev.map((pos) => {
          const priceChange = (Math.random() - 0.5) * 50
          const newPrice = Math.max(1, pos.currentPrice + priceChange)
          const newPnl = (newPrice - pos.entryPrice) * pos.quantity * pos.leverage
          const newPnlPercent = ((newPrice - pos.entryPrice) / pos.entryPrice) * 100

          return {
            ...pos,
            currentPrice: newPrice,
            unrealizedPnl: newPnl,
            unrealizedPnlPercent: newPnlPercent,
          }
        })
      )
    }, 2000)

    return () => clearInterval(interval)
  }, [isEngineRunning])

  // Apply filters and sorting
  const filteredAndSortedPositions = useMemo(() => {
    let result = [...positions]

    // Filter by side
    if (filterSide !== "all") {
      result = result.filter((p) => p.side.toLowerCase() === filterSide)
    }

    // Sort
    switch (sortBy) {
      case "pnl":
        result.sort((a, b) => b.unrealizedPnl - a.unrealizedPnl)
        break
      case "entry":
        result.sort((a, b) => b.entryPrice - a.entryPrice)
        break
      case "time":
        result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        break
    }

    return result
  }, [positions, sortBy, filterSide])

  // Calculate stats
  const stats = useMemo(() => {
    const total = positions.length
    const longs = positions.filter((p) => p.side === "LONG").length
    const shorts = positions.filter((p) => p.side === "SHORT").length
    const totalPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0)
    const profitablePositions = positions.filter((p) => p.unrealizedPnl > 0).length
    const totalCapital = positions.reduce((sum, p) => sum + p.entryPrice * p.quantity, 0)

    return { total, longs, shorts, totalPnl, profitablePositions, totalCapital }
  }, [positions])

   if (isLoading) {
     return (
       <div className="flex flex-1 items-center justify-center">
         <div className="text-center">
           <div className="animate-spin rounded-full h-8 w-8 border border-slate-400 border-t-cyan-600 mx-auto mb-4"></div>
           <p className="text-muted-foreground">Loading positions...</p>
         </div>
       </div>
     )
   }

  /*
   * Rewrote the page shell to fix several latent bugs that were making the
   * page subtly broken:
   *
   *   1. The previous JSX closed the outer `<div className="p-4 space-y-4">`
   *      immediately after the action buttons, leaving the engine-status
   *      banner, stats cards, filters, and list *outside* that wrapper and
   *      thus without padding. This caused the content to hug the viewport
   *      edges on wider screens and broke the `space-y-4` rhythm between
   *      sections.
   *
   *   2. Hard-coded colors (`bg-slate-50`, `text-blue-600`, `text-cyan-600`,
   *      `text-green-200`, …) bypassed the design-token system and were
   *      unreadable in dark mode. Switched to semantic tokens (`bg-card`,
   *      `text-foreground`, `text-muted-foreground`) plus sparing Tailwind
   *      "status" colors (green/red/amber) only where P&L sign carries
   *      semantic meaning.
   *
   *   3. Stat card now has a distinct colored icon pill so the compact card
   *      reads as scannable data rather than a flat row of numbers.
   */
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <PageHeader title="Live Trading" description="Real-time position monitoring and management" />
        <div className="flex gap-2">
          <Button
            variant={isEngineRunning ? "default" : "outline"}
            size="sm"
            onClick={() => setIsEngineRunning(!isEngineRunning)}
            className="h-8 text-xs"
          >
            {isEngineRunning ? (
              <>
                <Pause className="h-3 w-3 mr-1" />
                Stop Simulation
              </>
            ) : (
              <>
                <Play className="h-3 w-3 mr-1" />
                Start Simulation
              </>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.location.reload()} className="h-8 text-xs">
            <RefreshCw className="h-3 w-3 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Engine status banner */}
      {isEngineRunning && (
        <div className="rounded-md border border-green-500/30 bg-green-500/10 p-3">
          <div className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-green-500 animate-pulse flex-shrink-0" />
            <span className="text-foreground">Live trading engine running &mdash; prices updating in real-time</span>
          </div>
        </div>
      )}

      {/* Compact stats cards — semantic tokens + status accents where meaningful */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
        {[
          { icon: BarChart3,    label: "Open",       value: stats.total, tint: "text-primary" },
          { icon: TrendingUp,   label: "Long",       value: stats.longs, tint: "text-green-500" },
          { icon: TrendingDown, label: "Short",      value: stats.shorts, tint: "text-red-500" },
          { icon: Activity,     label: "Profitable", value: stats.profitablePositions, tint: "text-amber-500" },
          { icon: AlertCircle,  label: "Total PnL",  value: stats.totalPnl.toFixed(2) + " USDT", tint: stats.totalPnl >= 0 ? "text-green-500" : "text-red-500" },
          { icon: BarChart3,    label: "Capital",    value: "$" + (stats.totalCapital / 1000).toFixed(0) + "k", tint: "text-primary" },
        ].map((stat) => (
          <Card key={stat.label} className="border-border bg-card">
            <CardContent className="p-2 flex items-center gap-2">
              <div className={`rounded bg-muted/60 p-1.5 ${stat.tint}`}>
                <stat.icon className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0">
                <div className={`text-base font-bold tabular-nums ${stat.tint}`}>{stat.value}</div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{stat.label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filter / sort toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap text-xs px-3 py-2 bg-muted/40 rounded-md border border-border">
        <div className="text-muted-foreground">
          Showing <span className="font-semibold text-foreground tabular-nums">{filteredAndSortedPositions.length}</span> positions
        </div>
        <div className="flex gap-2 items-center">
          <div className="flex gap-1">
            {(["all","long","short"] as const).map((v) => (
              <Button
                key={v}
                variant={filterSide === v ? "default" : "outline"}
                size="sm"
                onClick={() => setFilterSide(v)}
                className="h-7 text-xs capitalize"
              >
                {v}
              </Button>
            ))}
          </div>
          <div className="border-l border-border pl-2 flex gap-1">
            {(["pnl","entry","time"] as const).map((v) => (
              <Button
                key={v}
                variant={sortBy === v ? "default" : "outline"}
                size="sm"
                onClick={() => setSortBy(v)}
                className="h-7 text-xs uppercase"
              >
                {v}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* Positions list */}
      <div className="space-y-1.5 max-h-[calc(100vh-350px)] overflow-y-auto">
        {filteredAndSortedPositions.length > 0 ? (
          filteredAndSortedPositions.map((position, index) => (
            <PositionRowCompact
              key={position.id}
              position={position}
              onClose={handleClosePosition}
              onModify={() => {
                toast.info("Position modification UI would open here")
              }}
              index={index}
            />
          ))
        ) : (
          <div className="text-center py-12 text-muted-foreground text-sm">
            No positions found
          </div>
        )}
      </div>
    </div>
  )
}
