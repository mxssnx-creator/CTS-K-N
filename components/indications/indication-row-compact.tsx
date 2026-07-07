"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight, TrendingUp, TrendingDown, Zap, Activity } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

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

interface IndicationRowCompactProps {
  indication: Indication
  onToggle: (id: string, enabled: boolean) => void
  index: number
}

function MiniSignalBar({ value, min = 0, max = 100 }: { value: number; min?: number; max?: number }) {
  const normalized = ((value - min) / (max - min)) * 100
  const color = value > 70 ? "bg-green-500" : value > 40 ? "bg-yellow-500" : "bg-red-500"
  
  return (
    <div className="flex items-center gap-1 min-w-[80px]">
      <div className="flex-1 h-3 bg-slate-700/50 rounded border border-slate-600 overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${Math.min(100, Math.max(0, normalized))}%` }} />
      </div>
      <span className="text-xs font-mono text-right w-10">{value.toFixed(1)}</span>
    </div>
  )
}

export function IndicationRowCompact({ indication, onToggle, index }: IndicationRowCompactProps) {
  const [expanded, setExpanded] = useState(false)

  const getDirectionColor = (direction: string) => {
    switch (direction) {
      case "UP": return "bg-green-500/20 text-green-300 border-green-500/30"
      case "DOWN": return "bg-red-500/20 text-red-300 border-red-500/30"
      default: return "bg-slate-500/20 text-slate-300 border-slate-500/30"
    }
  }

  const getIndicationIcon = (type: string) => {
    if (type.includes("Momentum")) return <Activity className="h-3 w-3" />
    if (type.includes("Volatility")) return <Zap className="h-3 w-3" />
    if (type.includes("Trend")) return <TrendingUp className="h-3 w-3" />
    if (type.includes("Mean")) return <TrendingDown className="h-3 w-3" />
    return <Activity className="h-3 w-3" />
  }

  const getIndicationColor = (type: string) => {
    if (type.includes("Momentum")) return "bg-blue-500/20 text-blue-300 border-blue-500/30"
    if (type.includes("Volatility")) return "bg-yellow-500/20 text-yellow-300 border-yellow-500/30"
    if (type.includes("Trend")) return "bg-purple-500/20 text-purple-300 border-purple-500/30"
    if (type.includes("Mean")) return "bg-orange-500/20 text-orange-300 border-orange-500/30"
    return "bg-green-500/20 text-green-300 border-green-500/30"
  }

  const formatTime = (timestamp: string) => {
    try {
      // Timestamp may be epoch-ms as a numeric string (e.g. "1749252897123") or ISO format.
      const ms = Number(timestamp)
      const date =
        Number.isFinite(ms) && ms > 1_000_000_000_000 ? new Date(ms) : new Date(timestamp)
      if (isNaN(date.getTime())) return "N/A"
      return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })
    } catch {
      return "N/A"
    }
  }

  return (
    <div className="group border border-slate-700/50 hover:border-slate-600 rounded bg-slate-900/30 hover:bg-slate-900/50 transition-all">
      {/* Main row */}
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        {/* Expand toggle */}
        <Button
          variant="ghost"
          size="sm"
          className="p-0 h-4 w-4 hover:bg-slate-700/50"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </Button>

        {/* Active toggle */}
        <Switch
          checked={indication.enabled}
          onCheckedChange={(checked) => onToggle(indication.id, checked)}
          className="scale-75 origin-left"
        />

        {/* Index */}
        <span className="text-slate-500 font-mono w-5">{(index + 1).toString().padStart(3, '0')}</span>

        {/* Symbol badge */}
        <Badge className="bg-blue-500/20 text-blue-300 border border-blue-500/30 text-xs px-1.5 py-0 h-5 font-mono">
          {indication.symbol}
        </Badge>

        {/* Indication type badge */}
        <Badge className={`${getIndicationColor(indication.indicationType)} border text-xs px-1.5 py-0 h-5 flex items-center gap-0.5`}>
          {getIndicationIcon(indication.indicationType)}
          <span>{indication.indicationType.substring(0, 3)}</span>
        </Badge>

        {/* Direction badge */}
        <Badge className={`${getDirectionColor(indication.direction)} border text-xs px-1.5 py-0 h-5 flex items-center`}>
          {indication.direction === "UP" ? "↑" : indication.direction === "DOWN" ? "↓" : "→"}
        </Badge>

        {/* Confidence bar */}
        <div className="flex items-center gap-1 text-slate-400 flex-1 min-w-[120px]">
          <span className="text-xs">Conf:</span>
          <MiniSignalBar value={indication.confidence} min={0} max={100} />
        </div>

        {/* Strength bar */}
        <div className="flex items-center gap-1 text-slate-400 min-w-[120px]">
          <span className="text-xs">Str:</span>
          <MiniSignalBar value={indication.strength} min={0} max={100} />
        </div>

        {/* Timestamp */}
        <span className="text-slate-500 font-mono text-xs min-w-[50px]">{formatTime(indication.timestamp)}</span>
      </div>

      {/* Expanded details - lazy loaded */}
      {expanded && (
        <div className="border-t border-slate-700/50 bg-slate-900/20 px-3 py-2 space-y-2">
          <div className="grid grid-cols-2 gap-2 text-xs">
            {/* Indication metadata */}
            <div className="bg-slate-900/50 rounded p-2 border border-slate-700/50">
              <div className="text-slate-400 font-semibold mb-1">Signal Details</div>
              <div className="space-y-0.5 text-slate-300 font-mono text-xs">
                <div>Type: <span className="text-cyan-400">{indication.indicationType}</span></div>
                <div>Direction: <span className="text-green-400">{indication.direction}</span></div>
                <div>Confidence: <span className="text-amber-400">{indication.confidence.toFixed(1)}%</span></div>
                <div>Strength: <span className="text-blue-400">{indication.strength.toFixed(1)}</span></div>
              </div>
            </div>

            {/* Technical metrics */}
            {indication.metadata && (
              <div className="bg-slate-900/50 rounded p-2 border border-slate-700/50">
                <div className="text-slate-400 font-semibold mb-1">Tech Metrics</div>
                <div className="space-y-0.5 text-slate-300 font-mono text-xs">
                  {indication.metadata.rsiValue !== undefined && (
                    <div>RSI: <span className="text-purple-400">{indication.metadata.rsiValue.toFixed(1)}</span></div>
                  )}
                  {indication.metadata.macdValue !== undefined && (
                    <div>MACD: <span className="text-pink-400">{indication.metadata.macdValue.toFixed(4)}</span></div>
                  )}
                  {indication.metadata.volatility !== undefined && (
                    <div>Vol: <span className="text-yellow-400">{indication.metadata.volatility.toFixed(2)}</span></div>
                  )}
                  {!indication.metadata.rsiValue && !indication.metadata.macdValue && (
                    <div className="text-slate-500">No additional metrics</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
