"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Filter, RotateCcw, ChevronDown, ChevronUp } from "lucide-react"

interface IndicationFiltersAdvanced {
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

interface IndicationFiltersAdvancedProps {
  filters: IndicationFiltersAdvanced
  onFiltersChange: (filters: IndicationFiltersAdvanced) => void
}

const defaultSymbols = ["BTC", "ETH", "SOL", "AAPL", "EURUSD", "XAUUSD", "GBPUSD", "NZDUSD"]
const indicationTypeOptions = ["Momentum", "Volatility", "Trend", "Mean Reversion", "Volume"]
const directionOptions = ["UP", "DOWN", "NEUTRAL"]

export function IndicationFiltersAdvanced({ filters, onFiltersChange }: IndicationFiltersAdvancedProps) {
  const [expandedSections, setExpandedSections] = useState({
    symbols: true,
    types: true,
    metrics: true,
  })

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }))
  }

  const updateFilter = (key: keyof IndicationFiltersAdvanced, value: any) => {
    onFiltersChange({ ...filters, [key]: value })
  }

  const addSymbol = () => {
    if (filters.symbolInput.trim() && !filters.symbols.includes(filters.symbolInput.toUpperCase())) {
      updateFilter("symbols", [...filters.symbols, filters.symbolInput.toUpperCase()])
      updateFilter("symbolInput", "")
    }
  }

  const removeSymbol = (sym: string) => {
    updateFilter("symbols", filters.symbols.filter((s) => s !== sym))
  }

  const resetAllFilters = () => {
    onFiltersChange({
      symbols: [],
      symbolInput: "",
      indicationTypes: [],
      directions: [],
      confidenceRange: [0, 100],
      strengthRange: [0, 100],
      timeRange: [0, 60],
      enabledOnly: false,
      sortBy: "confidence",
    })
  }

  return (
    <Card className="border-slate-700/50 bg-slate-900/30 sticky top-4">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Filter className="h-4 w-4" />
            Filters
          </CardTitle>
          <Button variant="outline" size="sm" onClick={resetAllFilters} className="h-7 text-xs">
            <RotateCcw className="h-3 w-3 mr-1" />
            Reset
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 text-xs">
        {/* Symbols Section */}
        <div className="border border-slate-700/50 rounded bg-slate-900/50">
          <button
            onClick={() => toggleSection("symbols")}
            className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-800/50 transition-colors"
          >
            <span className="font-semibold">Symbols ({filters.symbols.length})</span>
            {expandedSections.symbols ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {expandedSections.symbols && (
            <div className="px-3 py-2 space-y-2 border-t border-slate-700/50">
              <div className="flex gap-1">
                <Input
                  type="text"
                  placeholder="Add symbol..."
                  value={filters.symbolInput}
                  onChange={(e) => updateFilter("symbolInput", e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === "Enter" && addSymbol()}
                  className="h-7 text-xs flex-1"
                />
                <Button onClick={addSymbol} size="sm" className="h-7 px-2">
                  +
                </Button>
              </div>
              <div className="flex flex-wrap gap-1">
                {filters.symbols.map((sym) => (
                  <Badge
                    key={sym}
                    variant="outline"
                    className="cursor-pointer hover:bg-slate-700 text-xs py-0.5"
                    onClick={() => removeSymbol(sym)}
                  >
                    {sym} ✕
                  </Badge>
                ))}
              </div>
              <div className="flex flex-wrap gap-1">
                {defaultSymbols.map((sym) => (
                  <Badge
                    key={sym}
                    variant="outline"
                    className="cursor-pointer hover:bg-slate-600 text-xs py-0.5"
                    onClick={() => {
                      if (!filters.symbols.includes(sym)) {
                        updateFilter("symbols", [...filters.symbols, sym])
                      }
                    }}
                  >
                    +{sym}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Indication Types Section */}
        <div className="border border-slate-700/50 rounded bg-slate-900/50">
          <button
            onClick={() => toggleSection("types")}
            className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-800/50 transition-colors"
          >
            <span className="font-semibold">Types ({filters.indicationTypes.length})</span>
            {expandedSections.types ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {expandedSections.types && (
            <div className="px-3 py-2 space-y-2 border-t border-slate-700/50">
              <div className="grid grid-cols-1 gap-1 mb-2">
                {indicationTypeOptions.map((type) => (
                  <Badge
                    key={type}
                    variant={filters.indicationTypes.includes(type) ? "default" : "outline"}
                    className="cursor-pointer text-xs py-0.5 justify-center"
                    onClick={() => {
                      const newTypes = filters.indicationTypes.includes(type)
                        ? filters.indicationTypes.filter((t) => t !== type)
                        : [...filters.indicationTypes, type]
                      updateFilter("indicationTypes", newTypes)
                    }}
                  >
                    {type}
                  </Badge>
                ))}
              </div>

              <div className="border-t border-slate-700/50 pt-2">
                <Label className="text-slate-400 mb-2 block text-xs font-semibold">Direction</Label>
                <div className="grid grid-cols-3 gap-1">
                  {directionOptions.map((dir) => (
                    <Badge
                      key={dir}
                      variant={filters.directions.includes(dir) ? "default" : "outline"}
                      className="cursor-pointer text-xs py-0.5 justify-center"
                      onClick={() => {
                        const newDirs = filters.directions.includes(dir)
                          ? filters.directions.filter((d) => d !== dir)
                          : [...filters.directions, dir]
                        updateFilter("directions", newDirs)
                      }}
                    >
                      {dir === "UP" ? "↑" : dir === "DOWN" ? "↓" : "→"}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Metrics Section */}
        <div className="border border-slate-700/50 rounded bg-slate-900/50">
          <button
            onClick={() => toggleSection("metrics")}
            className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-800/50 transition-colors"
          >
            <span className="font-semibold">Metrics</span>
            {expandedSections.metrics ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {expandedSections.metrics && (
            <div className="px-3 py-2 space-y-3 border-t border-slate-700/50">
              {/* Confidence range */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label className="text-slate-400">Confidence: {filters.confidenceRange[0].toFixed(0)}% - {filters.confidenceRange[1].toFixed(0)}%</Label>
                </div>
                <Slider
                  value={filters.confidenceRange}
                  onValueChange={(value) => updateFilter("confidenceRange", [value[0], value[1]])}
                  min={0}
                  max={100}
                  step={5}
                  className="w-full"
                />
              </div>

              {/* Strength range */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label className="text-slate-400">Strength: {filters.strengthRange[0].toFixed(0)} - {filters.strengthRange[1].toFixed(0)}</Label>
                </div>
                <Slider
                  value={filters.strengthRange}
                  onValueChange={(value) => updateFilter("strengthRange", [value[0], value[1]])}
                  min={0}
                  max={100}
                  step={5}
                  className="w-full"
                />
              </div>

              {/* Time range (minutes) */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label className="text-slate-400">Within last {filters.timeRange[1]} min</Label>
                </div>
                <Slider
                  value={filters.timeRange}
                  onValueChange={(value) => updateFilter("timeRange", [value[0], value[1]])}
                  min={0}
                  max={1440}
                  step={60}
                  className="w-full"
                />
              </div>
            </div>
          )}
        </div>

        {/* Toggle and sort */}
        <div className="border border-slate-700/50 rounded bg-slate-900/50 px-3 py-2 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-slate-400 text-xs">Enabled Only</Label>
            <Switch
              checked={filters.enabledOnly}
              onCheckedChange={(checked) => updateFilter("enabledOnly", checked)}
            />
          </div>

          <div className="border-t border-slate-700/50 pt-2">
            <Label className="text-slate-400 text-xs block mb-2">Sort By</Label>
            <div className="grid grid-cols-1 gap-1">
              {(["confidence", "strength", "recent"] as const).map((sort) => (
                <Badge
                  key={sort}
                  variant={filters.sortBy === sort ? "default" : "outline"}
                  className="cursor-pointer text-xs py-0.5 justify-center capitalize"
                  onClick={() => updateFilter("sortBy", sort)}
                >
                  {sort === "recent" ? "Most Recent" : sort.charAt(0).toUpperCase() + sort.slice(1)}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
