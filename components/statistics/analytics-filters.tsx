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
import { endOfDay, format, startOfDay } from "date-fns"
import type { AnalyticsFilter } from "@/lib/analytics"

interface AnalyticsFiltersProps {
  filter: AnalyticsFilter
  onFilterChange: (filter: AnalyticsFilter) => void
  availableSymbols?: string[]
  availableIndicationTypes?: string[]
  availableStrategyTypes?: string[]
}

export function AnalyticsFilters({
  filter,
  onFilterChange,
  availableSymbols = [],
  availableIndicationTypes = [],
  availableStrategyTypes = [],
}: AnalyticsFiltersProps) {
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

  const symbols = availableSymbols.length > 0
    ? availableSymbols
    : ["BTCUSDT", "ETHUSDT", "XRPUSDT", "BCHUSDT", "LINKUSDT", "DOGEUSDT"]
  const indicationTypes = availableIndicationTypes.length > 0
    ? availableIndicationTypes
    : ["direction", "move", "active", "active_advanced", "special", "optimal", "auto", "common", "signal", "trend"]
  const strategyTypes = availableStrategyTypes.length > 0
    ? availableStrategyTypes
    : ["Base", "Main", "Real", "Block", "DCA"]

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
          <div className="flex flex-col gap-2 sm:flex-row">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full min-w-0 justify-start bg-transparent text-left font-normal sm:flex-1">
                  <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
                  <span className="truncate">{format(dateRange.from, "PPP")}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={dateRange.from}
                  onSelect={(date) => {
                    if (date) {
                      const from = startOfDay(date)
                      const newRange = {
                        from,
                        to: from > dateRange.to ? endOfDay(date) : dateRange.to,
                      }
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
                <Button variant="outline" className="w-full min-w-0 justify-start bg-transparent text-left font-normal sm:flex-1">
                  <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
                  <span className="truncate">{format(dateRange.to, "PPP")}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={dateRange.to}
                  onSelect={(date) => {
                    if (date) {
                      const to = endOfDay(date)
                      const newRange = {
                        from: to < dateRange.from ? startOfDay(date) : dateRange.from,
                        to,
                      }
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
          <div className="flex max-h-44 flex-wrap gap-2 overflow-y-auto pr-1">
            {symbols.map((symbol) => (
              <Badge key={symbol} variant={filter.symbols.includes(symbol) ? "default" : "outline"} className="cursor-pointer" asChild>
                <button
                  type="button"
                  aria-pressed={filter.symbols.includes(symbol)}
                  onClick={() => updateFilter({ symbols: toggleArrayItem(filter.symbols, symbol) })}
                >
                  {symbol}
                </button>
              </Badge>
            ))}
          </div>
        </div>

        {/* Indication Types */}
        <div className="space-y-3">
          <Label>Indication Types</Label>
          <div className="flex flex-wrap gap-2">
            {indicationTypes.map((type) => (
              <Badge key={type} variant={filter.indicationTypes.includes(type) ? "default" : "outline"} className="cursor-pointer" asChild>
                <button
                  type="button"
                  aria-pressed={filter.indicationTypes.includes(type)}
                  onClick={() => updateFilter({ indicationTypes: toggleArrayItem(filter.indicationTypes, type) })}
                >
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </button>
              </Badge>
            ))}
          </div>
        </div>

        {/* Strategy Types */}
        <div className="space-y-3">
          <Label>Strategy Types</Label>
          <div className="flex max-h-44 flex-wrap gap-2 overflow-y-auto pr-1">
            {strategyTypes.map((type) => (
              <Badge key={type} variant={filter.strategyTypes.includes(type) ? "default" : "outline"} className="cursor-pointer" asChild>
                <button
                  type="button"
                  aria-pressed={filter.strategyTypes.includes(type)}
                  onClick={() => updateFilter({ strategyTypes: toggleArrayItem(filter.strategyTypes, type) })}
                >
                  {type}
                </button>
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
          <Label>Minimum realised PF (classic): {filter.minProfitFactor?.toFixed(1) || "Any"}</Label>
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
          <Label>Maximum total drawdown hours: {filter.maxDrawdown?.toFixed(0) || "Any"}</Label>
          <div className="px-2">
            <Slider
              value={[filter.maxDrawdown || 0]}
              onValueChange={([value]) => updateFilter({ maxDrawdown: value > 0 ? value : undefined })}
              min={0}
              max={720}
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
              className="h-auto max-w-full"
              onClick={() =>
                updateFilter({
                  symbols: ["BTCUSDT", "ETHUSDT"],
                  minProfitFactor: 1.2,
                })
              }
            >
              <span className="whitespace-normal text-left">Major Pairs High Performance</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-auto max-w-full"
              onClick={() =>
                updateFilter({
                  strategyTypes: ["Base", "Main"], // Updated from Partial to Main
                  trailingEnabled: false,
                })
              }
            >
              <span className="whitespace-normal text-left">Core Strategies</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-auto max-w-full"
              onClick={() =>
                updateFilter({
                  trailingEnabled: true,
                  minProfitFactor: 0.8,
                })
              }
            >
              <span className="whitespace-normal text-left">Trailing Strategies</span>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
