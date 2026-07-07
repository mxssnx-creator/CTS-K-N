"use client"

import { useState, useMemo } from "react"
import { ChevronDown, ChevronRight, TrendingUp, TrendingDown, Activity, Target, BarChart3, ZapOff } from 'lucide-react'
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { StrategyResult } from "@/lib/strategies"

interface StrategyRowCompactProps {
  strategy: StrategyResult
  onToggle: (id: string, active: boolean) => void
  minimalProfitFactor: number
  index: number
}

// Mini bar chart - renders horizontally in compact form
function MiniBarChart({ factor, min = -2, max = 2 }: { factor: number; min?: number; max?: number }) {
  const normalized = ((factor - min) / (max - min)) * 100
  const isPositive = factor >= 0
  const color = isPositive ? (factor >= 0.8 ? "bg-green-500" : factor >= 0.4 ? "bg-yellow-500" : "bg-orange-500") : "bg-red-500"
  
  return (
    <div className="flex items-center gap-1 min-w-[60px]">
      <div className="w-8 h-4 bg-slate-700/50 rounded border border-slate-600 overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${Math.min(100, Math.max(0, normalized))}%` }} />
      </div>
      <span className="text-xs font-mono text-right w-8">{factor.toFixed(2)}</span>
    </div>
  )
}

export function StrategyRowCompact({ strategy, onToggle, minimalProfitFactor, index }: StrategyRowCompactProps) {
  const [expanded, setExpanded] = useState(false)
  const isProfitable = strategy.avg_profit_factor >= minimalProfitFactor
  
  const getIcon = (name: string) => {
    if (name.includes("Base")) return <Target className="h-3 w-3" />
    if (name.includes("Main")) return <Activity className="h-3 w-3" />
    if (name.includes("Real")) return <BarChart3 className="h-3 w-3" />
    if (name.includes("Block")) return <TrendingUp className="h-3 w-3" />
    if (name.includes("DCA")) return <TrendingDown className="h-3 w-3" />
    return <Activity className="h-3 w-3" />
  }

  const getTypeColor = (name: string) => {
    if (name.includes("Base")) return "bg-blue-500/20 text-blue-300 border-blue-500/30"
    if (name.includes("Main")) return "bg-green-500/20 text-green-300 border-green-500/30"
    if (name.includes("Real")) return "bg-purple-500/20 text-purple-300 border-purple-500/30"
    if (name.includes("Block")) return "bg-orange-500/20 text-orange-300 border-orange-500/30"
    if (name.includes("DCA")) return "bg-red-500/20 text-red-300 border-red-500/30"
    return "bg-gray-500/20 text-gray-300 border-gray-500/30"
  }

  const getStateColor = (state: string) => {
    switch (state) {
      case "valid": return "bg-green-500/20 text-green-300 border-green-500/30"
      case "invalid": return "bg-red-500/20 text-red-300 border-red-500/30"
      case "pending": return "bg-yellow-500/20 text-yellow-300 border-yellow-500/30"
      default: return "bg-gray-500/20 text-gray-300 border-gray-500/30"
    }
  }

  // Summary stats that should load on demand
  const summaryStats = useMemo(() => ({
    totalTrades: Math.floor(Math.random() * 1000) + 50,
    winRate: Math.floor(Math.random() * 100),
    avgReturn: (Math.random() - 0.3) * 5,
    maxDD: Math.random() * 20,
  }), [])

  return (
    <div className="group border border-slate-700/50 hover:border-slate-600 rounded bg-slate-900/30 hover:bg-slate-900/50 transition-all">
      {/* Main row - always visible, compact */}
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
          checked={strategy.isActive}
          onCheckedChange={(checked) => onToggle(strategy.id, checked)}
          className="scale-75 origin-left"
        />

        {/* Index */}
        <span className="text-slate-500 font-mono w-5">{(index + 1).toString().padStart(3, '0')}</span>

        {/* Type badge */}
        <Badge className={`${getTypeColor(strategy.name)} border text-xs px-1.5 py-0 h-5 flex items-center gap-0.5`}>
          {getIcon(strategy.name)}
          <span>{strategy.name.split(" ")[0].substring(0, 3)}</span>
        </Badge>

        {/* State badge */}
        <Badge className={`${getStateColor(strategy.validation_state)} border text-xs px-1.5 py-0 h-5 flex items-center`}>
          {strategy.validation_state === "valid" ? "✓" : strategy.validation_state === "invalid" ? "✗" : "•"}
        </Badge>

        {/* Strategy name */}
        <div className="text-slate-300 truncate max-w-[180px] flex-1">{strategy.name}</div>

        {/* Profit factor with bar */}
        <MiniBarChart factor={strategy.avg_profit_factor} />

        {/* Stats condensed */}
        <div className="flex items-center gap-2 min-w-max text-slate-400">
          <span title="Positions/day" className="flex items-center gap-0.5">
            <Activity className="h-3 w-3" />
            <span className="font-mono">{strategy.stats.positions_per_day.toFixed(1)}</span>
          </span>
          <span title="Volume factor" className="flex items-center gap-0.5">
            <BarChart3 className="h-3 w-3" />
            <span className="font-mono">{strategy.volume_factor.toFixed(1)}x</span>
          </span>
        </div>

        {/* TP/SL indicators */}
        <div className="flex items-center gap-1 min-w-max text-slate-500 text-xs">
          <span className="font-mono">TP:{strategy.config.takeprofit_factor.toFixed(1)}</span>
          <span className="font-mono">SL:{strategy.config.stoploss_ratio.toFixed(1)}</span>
        </div>

        {/* Trailing indicator */}
        {strategy.config.trailing_enabled && (
          <Badge className="bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs px-1.5 py-0 h-5 flex items-center">
            TRAIL
          </Badge>
        )}
      </div>

      {/* Expanded details - lazy loaded */}
      {expanded && (
        <div className="border-t border-slate-700/50 bg-slate-900/20 px-3 py-2 space-y-2">
          {/* Detail sections */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            {/* Configuration block */}
            <div className="bg-slate-900/50 rounded p-2 border border-slate-700/50">
              <div className="text-slate-400 font-semibold mb-1">Configuration</div>
              <div className="space-y-0.5 text-slate-300 font-mono text-xs">
                <div>Main Type: <span className="text-cyan-400">{strategy.mainType}</span></div>
                <div>Validation: <span className="text-green-400">{strategy.validation_state}</span></div>
                <div>Adjustments: <span className="text-amber-400">{strategy.adjustments.join(", ") || "None"}</span></div>
              </div>
            </div>

            {/* Performance block */}
            <div className="bg-slate-900/50 rounded p-2 border border-slate-700/50">
              <div className="text-slate-400 font-semibold mb-1">Performance</div>
              <div className="space-y-0.5 text-slate-300 font-mono text-xs">
                <div>Trades: <span className="text-blue-400">{summaryStats.totalTrades}</span></div>
                <div>Win Rate: <span className="text-green-400">{summaryStats.winRate}%</span></div>
                <div>Max DD: <span className="text-red-400">{summaryStats.maxDD.toFixed(1)}%</span></div>
              </div>
            </div>
          </div>

          {/* Configuration ranges if applicable */}
          {strategy.config && Object.keys(strategy.config).length > 0 && (
            <div className="bg-slate-900/50 rounded p-2 border border-slate-700/50">
              <div className="text-slate-400 font-semibold mb-1 text-xs">Extended Config</div>
              <div className="grid grid-cols-3 gap-1 text-xs text-slate-300 font-mono">
                {Object.entries(strategy.config)
                  .filter(([_, v]) => typeof v === 'number')
                  .slice(0, 6)
                  .map(([k, v]) => (
                    <div key={k} className="truncate">
                      <span className="text-slate-500">{k}:</span> <span className="text-cyan-300">{typeof v === 'number' ? v.toFixed(2) : v}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
