"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"

interface PresetConfigFiltersProps {
  filters: {
    indicatorTypes: string[]
    symbols: string[]
    minProfitFactor: number
    maxDrawdownHours: number
  }
  onFilterChange: (filters: any) => void
}

export function PresetConfigFilters({ filters, onFilterChange }: PresetConfigFiltersProps) {
  const indicatorTypes = ["rsi", "macd", "bollinger", "sar", "ema", "sma", "stochastic"]
  const availableSymbols = ["BTCUSDT", "ETHUSDT", "XRPUSDT", "BCHUSDT", "LINKUSDT", "DOGEUSDT"]

  const toggleIndicator = (type: string) => {
    const newTypes = filters.indicatorTypes.includes(type)
      ? filters.indicatorTypes.filter((t) => t !== type)
      : [...filters.indicatorTypes, type]
    onFilterChange({ ...filters, indicatorTypes: newTypes })
  }

  const toggleSymbol = (symbol: string) => {
    const newSymbols = filters.symbols.includes(symbol)
      ? filters.symbols.filter((s) => s !== symbol)
      : [...filters.symbols, symbol]
    onFilterChange({ ...filters, symbols: newSymbols })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Filters</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Indicator Types</Label>
          <div className="flex flex-wrap gap-2">
            {indicatorTypes.map((type) => (
              <Badge
                key={type}
                variant={filters.indicatorTypes.includes(type) ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => toggleIndicator(type)}
              >
                {type.toUpperCase()}
              </Badge>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label>Symbols ({filters.symbols.length === 0 ? "All" : filters.symbols.length})</Label>
          <div className="flex flex-wrap gap-2">
            {availableSymbols.map((symbol) => (
              <Badge
                key={symbol}
                variant={filters.symbols.includes(symbol) ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => toggleSymbol(symbol)}
              >
                {symbol}
              </Badge>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="minProfitFactor">Min Profit Factor: {filters.minProfitFactor.toFixed(1)}</Label>
          <Input
            id="minProfitFactor"
            type="number"
            step="0.1"
            min="0"
            max="5"
            value={filters.minProfitFactor}
            onChange={(e) => onFilterChange({ ...filters, minProfitFactor: Number.parseFloat(e.target.value) })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="maxDrawdownHours">Max Drawdown Hours: {filters.maxDrawdownHours}</Label>
          <Input
            id="maxDrawdownHours"
            type="number"
            step="1"
            min="1"
            max="24"
            value={filters.maxDrawdownHours}
            onChange={(e) => onFilterChange({ ...filters, maxDrawdownHours: Number.parseInt(e.target.value) })}
          />
        </div>
      </CardContent>
    </Card>
  )
}
