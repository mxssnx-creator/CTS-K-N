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

interface AdvancedFilters {
  // Date range
  dateFrom: string
  dateTo: string
  
  // Symbols
  symbols: string[]
  symbolInput: string
  
  // Indication types
  indicationTypes: string[]
  
  // Strategy types
  strategyTypes: string[]
  
  // Coordinate selections (ranges)
  tpRange: [number, number]
  slRange: [number, number]
  volRange: [number, number]
  
  // Performance
  profitFactorMin: number
  winRateMin: number
  
  // Toggles
  trailingOnly: boolean
  activeOnly: boolean
  validOnly: boolean
}

interface StrategyFiltersAdvancedProps {
  filters: AdvancedFilters
  onFiltersChange: (filters: AdvancedFilters) => void
}

const defaultSymbols = ["BTC", "ETH", "SOL", "AAPL", "EURUSD", "XAUUSD"]
const indicationTypeOptions = ["Direction", "Magnitude", "Volatility", "Momentum", "Mean Reversion"]
const strategyTypeOptions = ["Base", "Main", "Real", "Block", "DCA"]

export function StrategyFiltersAdvanced({ filters, onFiltersChange }: StrategyFiltersAdvancedProps) {
  const [expandedSections, setExpandedSections] = useState({
    date: true,
    symbols: true,
    indications: true,
    performance: true,
    coordinates: true,
  })

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }))
  }

  const updateFilter = (key: keyof AdvancedFilters, value: any) => {
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
      dateFrom: "",
      dateTo: "",
      symbols: [],
      symbolInput: "",
      indicationTypes: [],
      strategyTypes: [],
      tpRange: [0, 20],
      slRange: [0, 5],
      volRange: [0.5, 5],
      profitFactorMin: 0,
      winRateMin: 0,
      trailingOnly: false,
      activeOnly: false,
      validOnly: false,
    })
  }

  return (
    <Card className="border-slate-700/50 bg-slate-900/30">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Filter className="h-4 w-4" />
            Advanced Filters
          </CardTitle>
          <Button variant="outline" size="sm" onClick={resetAllFilters} className="h-7 text-xs">
            <RotateCcw className="h-3 w-3 mr-1" />
            Reset
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 text-xs">
        {/* Date Range Section */}
        <div className="border border-slate-700/50 rounded bg-slate-900/50">
          <button
            onClick={() => toggleSection("date")}
            className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-800/50 transition-colors"
          >
            <span className="font-semibold">Date Range</span>
            {expandedSections.date ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {expandedSections.date && (
            <div className="px-3 py-2 space-y-2 border-t border-slate-700/50">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs text-slate-400 mb-1 block">From</Label>
                  <Input
                    type="date"
                    value={filters.dateFrom}
                    onChange={(e) => updateFilter("dateFrom", e.target.value)}
                    className="h-7 text-xs"
                  />
                </div>
                <div>
                  <Label className="text-xs text-slate-400 mb-1 block">To</Label>
                  <Input
                    type="date"
                    value={filters.dateTo}
                    onChange={(e) => updateFilter("dateTo", e.target.value)}
                    className="h-7 text-xs"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

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
              {filters.symbols.length === 0 && (
                <div className="text-xs text-slate-500">Add symbols or select from presets:</div>
              )}
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
            onClick={() => toggleSection("indications")}
            className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-800/50 transition-colors"
          >
            <span className="font-semibold">Indication Types ({filters.indicationTypes.length})</span>
            {expandedSections.indications ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {expandedSections.indications && (
            <div className="px-3 py-2 space-y-2 border-t border-slate-700/50">
              <div className="grid grid-cols-2 gap-1">
                {indicationTypeOptions.map((type) => (
                  <Badge
                    key={type}
                    variant={filters.indicationTypes.includes(type) ? "default" : "outline"}
                    className="cursor-pointer text-xs py-0.5"
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
            </div>
          )}
        </div>

        {/* Strategy Types Section */}
        <div className="border border-slate-700/50 rounded bg-slate-900/50">
          <button
            onClick={() => toggleSection("coordinates")}
            className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-800/50 transition-colors"
          >
            <span className="font-semibold">Strategy Types ({filters.strategyTypes.length})</span>
            {expandedSections.coordinates ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {expandedSections.coordinates && (
            <div className="px-3 py-2 space-y-2 border-t border-slate-700/50">
              <div className="grid grid-cols-2 gap-1">
                {strategyTypeOptions.map((type) => (
                  <Badge
                    key={type}
                    variant={filters.strategyTypes.includes(type) ? "default" : "outline"}
                    className="cursor-pointer text-xs py-0.5"
                    onClick={() => {
                      const newTypes = filters.strategyTypes.includes(type)
                        ? filters.strategyTypes.filter((t) => t !== type)
                        : [...filters.strategyTypes, type]
                      updateFilter("strategyTypes", newTypes)
                    }}
                  >
                    {type}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Coordinate Ranges */}
        <div className="border border-slate-700/50 rounded bg-slate-900/50">
          <div className="px-3 py-2 border-b border-slate-700/50">
            <span className="font-semibold block mb-2">Coordinate Ranges</span>
          </div>
          <div className="px-3 py-2 space-y-3">
            {/* TP Range */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-slate-400">Take Profit: {filters.tpRange[0].toFixed(1)} - {filters.tpRange[1].toFixed(1)}</Label>
              </div>
              <Slider
                value={filters.tpRange}
                onValueChange={(value) => updateFilter("tpRange", [value[0], value[1]])}
                min={0}
                max={20}
                step={0.5}
                className="w-full"
              />
            </div>

            {/* SL Range */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-slate-400">Stop Loss: {filters.slRange[0].toFixed(1)} - {filters.slRange[1].toFixed(1)}</Label>
              </div>
              <Slider
                value={filters.slRange}
                onValueChange={(value) => updateFilter("slRange", [value[0], value[1]])}
                min={0}
                max={5}
                step={0.1}
                className="w-full"
              />
            </div>

            {/* Volume Range */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-slate-400">Volume: {filters.volRange[0].toFixed(1)}x - {filters.volRange[1].toFixed(1)}x</Label>
              </div>
              <Slider
                value={filters.volRange}
                onValueChange={(value) => updateFilter("volRange", [value[0], value[1]])}
                min={0.5}
                max={5}
                step={0.1}
                className="w-full"
              />
            </div>
          </div>
        </div>

        {/* Performance Metrics */}
        <div className="border border-slate-700/50 rounded bg-slate-900/50">
          <div className="px-3 py-2 border-b border-slate-700/50">
            <span className="font-semibold block mb-2">Performance</span>
          </div>
          <div className="px-3 py-2 space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-slate-400">Min Profit Factor: {filters.profitFactorMin.toFixed(2)}</Label>
              </div>
              <Slider
                value={[filters.profitFactorMin]}
                onValueChange={(value) => updateFilter("profitFactorMin", value[0])}
                min={-2}
                max={3}
                step={0.1}
                className="w-full"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-slate-400">Min Win Rate: {filters.winRateMin.toFixed(0)}%</Label>
              </div>
              <Slider
                value={[filters.winRateMin]}
                onValueChange={(value) => updateFilter("winRateMin", value[0])}
                min={0}
                max={100}
                step={5}
                className="w-full"
              />
            </div>
          </div>
        </div>

        {/* Toggle Filters */}
        <div className="border border-slate-700/50 rounded bg-slate-900/50 px-3 py-2 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-slate-400">Trailing Only</Label>
            <Switch
              checked={filters.trailingOnly}
              onCheckedChange={(checked) => updateFilter("trailingOnly", checked)}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-slate-400">Active Only</Label>
            <Switch
              checked={filters.activeOnly}
              onCheckedChange={(checked) => updateFilter("activeOnly", checked)}
            />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-slate-400">Valid Only</Label>
            <Switch
              checked={filters.validOnly}
              onCheckedChange={(checked) => updateFilter("validOnly", checked)}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
