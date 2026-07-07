"use client"


export const dynamic = "force-dynamic"
// Page with sidebar and exchange selector
import { useState, useEffect, useMemo, useCallback } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { IndicationRowCompact } from "@/components/indications/indication-row-compact"
import { IndicationFiltersAdvanced } from "@/components/indications/indication-filters-advanced"
import { Activity, TrendingUp, Zap, RefreshCw, Download, BarChart3 } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import { useExchange } from "@/lib/exchange-context"
import { useIndicationUpdates } from "@/lib/use-websocket"
import { PageHeader } from "@/components/page-header"

interface Indication {
  id: string
  symbol: string
  indicationType: string
  direction: "UP" | "DOWN" | "NEUTRAL"
  confidence: number
  strength: number
  timestamp: string
  enabled: boolean
  metadata?: {
    macdValue?: number
    rsiValue?: number
    maValue?: number
    bbUpper?: number
    bbLower?: number
    volatility?: number
  }
}

interface AdvancedFiltersInd {
  symbols: string[]
  symbolInput: string
  indicationTypes: string[]
  directions: string[]
  confidenceRange: [number, number]
  strengthRange: [number, number]
  timeRange: [number, number]
  enabledOnly: boolean
  sortBy: "confidence" | "strength" | "recent"
}

const initialFilters: AdvancedFiltersInd = {
  symbols: [],
  symbolInput: "",
  indicationTypes: [],
  directions: [],
  confidenceRange: [0, 100],
  strengthRange: [0, 100],
  timeRange: [0, 60],
  enabledOnly: false,
  sortBy: "confidence",
}

export default function IndicationsPage() {
  const { selectedConnectionId, activeConnections } = useExchange()
  const resolvedConnectionId = selectedConnectionId || activeConnections?.[0]?.id || null
  const [indications, setIndications] = useState<Indication[]>([])
  const [isDemo, setIsDemo] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [filters, setFilters] = useState<AdvancedFiltersInd>(initialFilters)

  // Load indications on mount and when connection changes
  useEffect(() => {
    const loadIndications = async () => {
      setIsLoading(true)
      try {
        // Determine which connection to use (fallback to demo if none selected)
        const connectionToUse = resolvedConnectionId || "demo-mode"

        const response = await fetch(`/api/data/indications?connectionId=${encodeURIComponent(connectionToUse)}`)
        if (!response.ok) {
          throw new Error(`Failed to fetch indications: ${response.statusText}`)
        }

        const data = await response.json()
        if (data.success) {
          setIndications(data.data || [])
          setIsDemo(data.isDemo)
        } else {
          throw new Error(data.error || "Unknown error")
        }
      } catch (error) {
        console.error("[Indications] Failed to load:", error)
        toast.error("Failed to load indications")
        setIndications([])
      } finally {
        setIsLoading(false)
      }
    }

    loadIndications()
  }, [resolvedConnectionId])

  // Handle real-time indication updates via SSE
  const handleIndicationUpdate = useCallback((update: any) => {
    setIndications((prev) => {
      // Check if indication already exists
      const existingIndex = prev.findIndex((i) => i.id === update.id)
      if (existingIndex >= 0) {
        // Update existing indication
        const updated = [...prev]
        updated[existingIndex] = {
          ...updated[existingIndex],
          direction: update.direction || updated[existingIndex].direction,
          confidence: update.confidence || updated[existingIndex].confidence,
          strength: update.strength || updated[existingIndex].strength,
          timestamp: update.timestamp || new Date().toISOString(),
        }
        return updated
      } else {
        // Add new indication if not in demo mode
        if (!isDemo) {
          const newIndication: Indication = {
            id: update.id,
            symbol: update.symbol,
            indicationType: 'auto',
            direction: update.direction || 'NEUTRAL',
            confidence: update.confidence || 0,
            strength: update.strength || 0,
            timestamp: update.timestamp || new Date().toISOString(),
            enabled: true,
          }
          return [newIndication, ...prev]
        }
        return prev
      }
    })
  }, [isDemo])

  // Subscribe to indication updates via SSE
  useIndicationUpdates(
    resolvedConnectionId && resolvedConnectionId !== "demo-mode" ? resolvedConnectionId : "",
    handleIndicationUpdate
  )

  // Apply filters and sorting with memoization
  const filteredAndSortedIndications = useMemo(() => {
    let result = [...indications]

    // Apply filters
    result = result.filter((ind) => {
      // Symbol filter
      if (filters.symbols.length > 0 && !filters.symbols.includes(ind.symbol)) return false

      // Type filter
      if (filters.indicationTypes.length > 0 && !filters.indicationTypes.includes(ind.indicationType)) return false

      // Direction filter
      if (filters.directions.length > 0 && !filters.directions.includes(ind.direction)) return false

      // Confidence range
      if (ind.confidence < filters.confidenceRange[0] || ind.confidence > filters.confidenceRange[1]) return false

      // Strength range
      if (ind.strength < filters.strengthRange[0] || ind.strength > filters.strengthRange[1]) return false

      // Time range (minutes)
      const minutesOld = (Date.now() - new Date(ind.timestamp).getTime()) / (1000 * 60)
      if (minutesOld > filters.timeRange[1]) return false

      // Enabled only
      if (filters.enabledOnly && !ind.enabled) return false

      return true
    })

    // Apply sorting
    switch (filters.sortBy) {
      case "confidence":
        result.sort((a, b) => b.confidence - a.confidence)
        break
      case "strength":
        result.sort((a, b) => b.strength - a.strength)
        break
      case "recent":
        result.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        break
    }

    return result
  }, [indications, filters])

  // Calculate statistics
  const stats = useMemo(() => {
    const total = indications.length
    const enabled = indications.filter((i) => i.enabled).length
    const upSignals = indications.filter((i) => i.direction === "UP").length
    const highConfidence = indications.filter((i) => i.confidence >= 70).length
    const avgConfidence = total > 0 ? indications.reduce((sum, i) => sum + i.confidence, 0) / total : 0

    return { total, enabled, upSignals, highConfidence, avgConfidence }
  }, [indications])

  if (isLoading) {
    return (
     <div className="flex flex-1 items-center justify-center">
         <div className="text-center">
           <div className="animate-spin rounded-full h-8 w-8 border border-slate-400 border-t-cyan-600 mx-auto mb-4"></div>
           <p className="text-muted-foreground">Loading indications...</p>
         </div>
       </div>
    )
  }

  /*
   * Same fix as live-trading: the previous JSX closed the `p-4 space-y-4`
   * wrapper immediately after the action buttons, orphaning the stats and
   * the filter/result grid outside the padding. Also swapped hard-coded
   * status colors for design tokens + accent tints with a uniform stat card.
   */
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <PageHeader title="Indications" description="Trading signals with confidence and strength metrics" />
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => window.location.reload()} className="h-8 text-xs">
            <RefreshCw className="h-3 w-3 mr-1" />
            Refresh
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-xs">
            <Download className="h-3 w-3 mr-1" />
            Export
          </Button>
        </div>
      </div>

      {/* Stats cards — compact with accent icon pills */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {[
          { icon: BarChart3, label: "Total",     value: stats.total, tint: "text-primary" },
          { icon: Activity,  label: "Enabled",   value: stats.enabled, tint: "text-green-500" },
          { icon: TrendingUp,label: "Bullish",   value: stats.upSignals, tint: "text-amber-500" },
          { icon: Zap,       label: "High Conf", value: stats.highConfidence, tint: "text-amber-600 dark:text-amber-400" },
          { icon: Activity,  label: "Avg Conf",  value: stats.avgConfidence.toFixed(1) + "%", tint: "text-primary" },
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

      {/* Main content - filters sidebar + results */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-1">
          <IndicationFiltersAdvanced filters={filters} onFiltersChange={setFilters} />
        </div>

        <div className="lg:col-span-4 space-y-3">
          <div className="flex items-center justify-between text-xs px-3 py-2 bg-muted/40 rounded-md border border-border">
            <div className="text-muted-foreground">
              Showing{" "}
              <span className="font-semibold text-foreground tabular-nums">{filteredAndSortedIndications.length}</span>{" "}
              of{" "}
              <span className="font-semibold tabular-nums">{indications.length}</span>{" "}
              indications
            </div>
            <div className="text-muted-foreground">
              {filters.sortBy === "recent"     && "Sorted: Most Recent"}
              {filters.sortBy === "confidence" && "Sorted: Confidence"}
              {filters.sortBy === "strength"   && "Sorted: Strength"}
            </div>
          </div>

          <div className="space-y-1.5 max-h-[calc(100vh-300px)] overflow-y-auto">
            {filteredAndSortedIndications.length > 0 ? (
              filteredAndSortedIndications.map((indication, index) => (
                <IndicationRowCompact
                  key={indication.id}
                  indication={indication}
                  onToggle={(id, enabled) => {
                    setIndications((prev) =>
                      prev.map((ind) => (ind.id === id ? { ...ind, enabled } : ind))
                    )
                    toast.success(`Indication ${enabled ? "enabled" : "disabled"}`)
                  }}
                  index={index}
                />
              ))
            ) : (
              <div className="text-center py-12 text-muted-foreground">
                <div className="text-sm mb-2">No indications match your filters</div>
                <Button variant="outline" size="sm" onClick={() => setFilters(initialFilters)} className="text-xs h-7">
                  Reset Filters
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
