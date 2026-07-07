"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Slider } from "@/components/ui/slider"
import { Label } from "@/components/ui/label"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { CalendarIcon, Filter, RotateCcw } from 'lucide-react'
import { format } from "date-fns"
import type { AnalyticsFilter } from "@/lib/analytics"

interface AnalyticsFiltersProps {
  filter: AnalyticsFilter
  onFilterChange: (filter: AnalyticsFilter) => void
}

export function AnalyticsFilters({ filter, onFilterChange }: AnalyticsFiltersProps) {
  const [dateRange, setDateRange] = useState<{ from: Date; to: Date }>({
    from: filter.timeRange.start,
    to: filter.timeRange.end,
  })

  const updateFilter = (updates: Partial<AnalyticsFilter>) => {
    onFilterChange({ ...filter, ...updates })
  }

  const resetFilters = () => {
    const defaultFilter: AnalyticsFilter = {
      symbols: [],
      timeRange: {
        start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
        end: new Date(),
      },
      indicationTypes: [],
      strategyTypes: [],
      trailingEnabled: undefined,
      minProfitFactor: undefined,
      maxDrawdown: undefined,
    }
    onFilterChange(defaultFilter)
    setDateRange({ from: defaultFilter.timeRange.start, to: defaultFilter.timeRange.end })
  }

  const symbols = ["BTCUSDT", "ETHUSDT", "XRPUSDT", "BCHUSDT", "LINKUSDT", "DOGEUSDT"]
  const indicationTypes = ["direction", "move", "active"]
  const strategyTypes = ["Base", "Main", "Real", "Block", "DCA"] // Updated from Partial/Count to Main/Real

  const toggleArrayItem = (array: string[], item: string) => {
    return array.includes(item) ? array.filter((i) => i !== item) : [...array, item]
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Analytics Filters
          </CardTitle>
          <Button variant="outline" size="sm" onClick={resetFilters}>
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Time Range */}
        <div className="space-y-3">
          <Label>Time Range</Label>
          <div className="flex gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="flex-1 justify-start text-left font-normal bg-transparent">
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {format(dateRange.from, "PPP")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={dateRange.from}
                  onSelect={(date) => {
                    if (date) {
                      const newRange = { ...dateRange, from: date }
                      setDateRange(newRange)
                      updateFilter({ timeRange: { start: newRange.from, end: newRange.to } })
                    }
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="flex-1 justify-start text-left font-normal bg-transparent">
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {format(dateRange.to, "PPP")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={dateRange.to}
                  onSelect={(date) => {
                    if (date) {
                      const newRange = { ...dateRange, to: date }
                      setDateRange(newRange)
                      updateFilter({ timeRange: { start: newRange.from, end: newRange.to } })
                    }
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* Symbols Filter */}
        <div className="space-y-3">
          <Label>Symbols ({filter.symbols.length} selected)</Label>
          <div className="flex flex-wrap gap-2">
            {symbols.map((symbol) => (
              <Badge
                key={symbol}
                variant={filter.symbols.includes(symbol) ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => updateFilter({ symbols: toggleArrayItem(filter.symbols, symbol) })}
              >
                {symbol}
              </Badge>
            ))}
          </div>
        </div>

        {/* Indication Types */}
        <div className="space-y-3">
          <Label>Indication Types</Label>
          <div className="flex gap-2">
            {indicationTypes.map((type) => (
              <Badge
                key={type}
                variant={filter.indicationTypes.includes(type) ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => updateFilter({ indicationTypes: toggleArrayItem(filter.indicationTypes, type) })}
              >
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </Badge>
            ))}
          </div>
        </div>

        {/* Strategy Types */}
        <div className="space-y-3">
          <Label>Strategy Types</Label>
          <div className="flex flex-wrap gap-2">
            {strategyTypes.map((type) => (
              <Badge
                key={type}
                variant={filter.strategyTypes.includes(type) ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => updateFilter({ strategyTypes: toggleArrayItem(filter.strategyTypes, type) })}
              >
                {type}
              </Badge>
            ))}
          </div>
        </div>

        {/* Trailing Filter */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label>Trailing Enabled</Label>
            <div className="flex items-center gap-2">
              <Button
                variant={filter.trailingEnabled === false ? "default" : "outline"}
                size="sm"
                onClick={() => updateFilter({ trailingEnabled: false })}
              >
                No
              </Button>
              <Button
                variant={filter.trailingEnabled === true ? "default" : "outline"}
                size="sm"
                onClick={() => updateFilter({ trailingEnabled: true })}
              >
                Yes
              </Button>
              <Button
                variant={filter.trailingEnabled === undefined ? "default" : "outline"}
                size="sm"
                onClick={() => updateFilter({ trailingEnabled: undefined })}
              >
                All
              </Button>
            </div>
          </div>
        </div>

        {/* Minimum Profit Factor */}
        <div className="space-y-3">
          <Label>Minimum Profit Factor: {filter.minProfitFactor?.toFixed(1) || "Any"}</Label>
          <div className="px-2">
            <Slider
              value={[filter.minProfitFactor || 0]}
              onValueChange={([value]) => updateFilter({ minProfitFactor: value > 0 ? value : undefined })}
              min={0}
              max={3}
              step={0.1}
              className="w-full"
            />
          </div>
        </div>

        {/* Maximum Drawdown */}
        <div className="space-y-3">
          <Label>Maximum Drawdown Hours: {filter.maxDrawdown?.toFixed(0) || "Any"}</Label>
          <div className="px-2">
            <Slider
              value={[filter.maxDrawdown || 0]}
              onValueChange={([value]) => updateFilter({ maxDrawdown: value > 0 ? value : undefined })}
              min={0}
              max={48}
              step={1}
              className="w-full"
            />
          </div>
        </div>

        {/* Quick Filters */}
        <div className="space-y-3">
          <Label>Quick Filters</Label>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                updateFilter({
                  symbols: ["BTCUSDT", "ETHUSDT"],
                  minProfitFactor: 1.2,
                })
              }
            >
              Major Pairs High Performance
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                updateFilter({
                  strategyTypes: ["Base", "Main"], // Updated from Partial to Main
                  trailingEnabled: false,
                })
              }
            >
              Core Strategies
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                updateFilter({
                  trailingEnabled: true,
                  minProfitFactor: 0.8,
                })
              }
            >
              Trailing Strategies
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
