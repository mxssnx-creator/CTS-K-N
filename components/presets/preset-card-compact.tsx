"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight, Play, Settings, Trash2, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"

interface PresetTemplate {
  id: string
  name: string
  description: string
  strategyType: string
  symbol: string
  enabled: boolean
  config: {
    tp: number
    sl: number
    leverage: number
    volume: number
  }
  stats: {
    winRate: number
    avgProfit: number
    successCount: number
  }
}

interface PresetCardCompactProps {
  preset: PresetTemplate
  onToggle: (id: string, enabled: boolean) => void
  onStart?: (id: string) => void
  onDelete?: (id: string) => void
  onDuplicate?: (id: string) => void
}

export function PresetCardCompact({
  preset,
  onToggle,
  onStart,
  onDelete,
  onDuplicate,
}: PresetCardCompactProps) {
  const [expanded, setExpanded] = useState(false)

  const getStrategyColor = (type: string) => {
    if (type.includes("Momentum")) return "bg-blue-500/20 text-blue-300 border-blue-500/30"
    if (type.includes("Trend")) return "bg-purple-500/20 text-purple-300 border-purple-500/30"
    if (type.includes("Mean")) return "bg-orange-500/20 text-orange-300 border-orange-500/30"
    if (type.includes("Volatility")) return "bg-yellow-500/20 text-yellow-300 border-yellow-500/30"
    return "bg-green-500/20 text-green-300 border-green-500/30"
  }

  return (
    <div className="border border-slate-700/50 hover:border-slate-600 rounded bg-slate-900/30 hover:bg-slate-900/50 transition-all">
      {/* Main row */}
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        {/* Expand */}
        <Button
          variant="ghost"
          size="sm"
          className="p-0 h-4 w-4 hover:bg-slate-700/50"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </Button>

        {/* Enable toggle */}
        <Switch
          checked={preset.enabled}
          onCheckedChange={(checked) => onToggle(preset.id, checked)}
          className="scale-75 origin-left"
        />

        {/* Name & strategy */}
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-slate-200 truncate">{preset.name}</div>
          <div className="text-xs text-slate-500 truncate">{preset.description}</div>
        </div>

        {/* Type badge */}
        <Badge className={`${getStrategyColor(preset.strategyType)} border text-xs px-1.5 py-0 h-5`}>
          {preset.strategyType.substring(0, 4)}
        </Badge>

        {/* Symbol */}
        <Badge className="bg-blue-500/20 text-blue-300 border border-blue-500/30 text-xs px-1.5 py-0 h-5 font-mono">
          {preset.symbol}
        </Badge>

        {/* Stats */}
        <div className="flex items-center gap-2 text-slate-400 min-w-max text-xs">
          <span>WR: <span className="text-cyan-400 font-semibold">{preset.stats.winRate}%</span></span>
          <span>|</span>
          <span>Profit: <span className={`${preset.stats.avgProfit > 0 ? "text-green-400" : "text-red-400"} font-semibold`}>{preset.stats.avgProfit > 0 ? "+" : ""}{preset.stats.avgProfit.toFixed(2)}%</span></span>
        </div>

        {/* Actions */}
        <div className="flex gap-1 min-w-max">
          <Button
            variant="outline"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => onStart?.(preset.id)}
            title="Start preset"
          >
            <Play className="h-3 w-3" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => onDuplicate?.(preset.id)}
            title="Duplicate"
          >
            <Copy className="h-3 w-3" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 w-6 p-0 hover:bg-red-900/30"
            onClick={() => onDelete?.(preset.id)}
            title="Delete"
          >
            <Trash2 className="h-3 w-3 text-red-400" />
          </Button>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-slate-700/50 bg-slate-900/20 px-3 py-2 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-slate-900/50 rounded p-2 border border-slate-700/50">
              <div className="text-slate-400 font-semibold mb-1 text-xs">Configuration</div>
              <div className="space-y-0.5 text-slate-300 font-mono text-xs">
                <div>TP: <span className="text-green-400">{preset.config.tp}</span></div>
                <div>SL: <span className="text-red-400">{preset.config.sl}</span></div>
                <div>Leverage: <span className="text-blue-400">{preset.config.leverage}x</span></div>
                <div>Volume: <span className="text-cyan-400">{preset.config.volume}</span></div>
              </div>
            </div>

            <div className="bg-slate-900/50 rounded p-2 border border-slate-700/50">
              <div className="text-slate-400 font-semibold mb-1 text-xs">Statistics</div>
              <div className="space-y-0.5 text-slate-300 font-mono text-xs">
                <div>Win Rate: <span className="text-cyan-400">{preset.stats.winRate}%</span></div>
                <div>Avg Profit: <span className={preset.stats.avgProfit > 0 ? "text-green-400" : "text-red-400"}>{preset.stats.avgProfit > 0 ? "+" : ""}{preset.stats.avgProfit.toFixed(2)}%</span></div>
                <div>Success: <span className="text-yellow-400">{preset.stats.successCount}</span></div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
