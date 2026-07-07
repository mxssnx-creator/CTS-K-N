"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Filter, RotateCcw, Sparkles, SlidersHorizontal } from "lucide-react"

interface IndicationFiltersProps {
  filters: {
    type: string[]
    rangeMin: number
    rangeMax: number
    profitFactorMin: number
    symbolFilter: string
    trailingFilter: "no" | "yes" | "only"
    adjustBlock: "no" | "yes" | "only"
    adjustDca: "no" | "yes" | "only"
    activeOnly: boolean
  }
  onFiltersChange: (filters: any) => void
}

export function IndicationFilters({ filters, onFiltersChange }: IndicationFiltersProps) {
  const updateFilter = (key: string, value: any) => {
    onFiltersChange({ ...filters, [key]: value })
  }

  const resetFilters = () => {
    onFiltersChange({
      type: [],
      rangeMin: 3,
      rangeMax: 30,
      profitFactorMin: 0.5,
      symbolFilter: "",
      trailingFilter: "no",
      adjustBlock: "no",
      adjustDca: "no",
      activeOnly: false,
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Indication Filters
          </CardTitle>
          <Button variant="outline" size="sm" onClick={resetFilters}>
            <RotateCcw className="h-4 w-4 mr-2" />
            Reset
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Type Filter */}
        <div className="space-y-2">
          <Label>Indication Types</Label>
          <div className="flex gap-2">
            {["direction", "move", "active"].map((type) => (
              <Badge
                key={type}
                variant={filters.type.includes(type) ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() => {
                  const newTypes = filters.type.includes(type)
                    ? filters.type.filter((t) => t !== type)
                    : [...filters.type, type]
                  updateFilter("type", newTypes)
                }}
              >
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </Badge>
            ))}
          </div>
        </div>

        {/* Range Filter */}
        <div className="space-y-3">
          <Label>
            Range: {filters.rangeMin} - {filters.rangeMax}
          </Label>
          <div className="px-2">
            <Slider
              value={[filters.rangeMin, filters.rangeMax]}
              onValueChange={([min, max]) => {
                updateFilter("rangeMin", min)
                updateFilter("rangeMax", max)
              }}
              min={3}
              max={30}
              step={1}
              className="w-full"
            />
          </div>
        </div>

        {/* Profit Factor Filter */}
        <div className="space-y-3">
          <Label>Minimum Profit Factor: {filters.profitFactorMin}</Label>
          <div className="px-2">
            <Slider
              value={[filters.profitFactorMin]}
              onValueChange={([value]) => updateFilter("profitFactorMin", value)}
              min={0.1}
              max={2.0}
              step={0.1}
              className="w-full"
            />
          </div>
        </div>

        {/* Symbol Filter */}
        <div className="space-y-2">
          <Label htmlFor="symbol-filter">Symbol Filter</Label>
          <Input
            id="symbol-filter"
            placeholder="e.g., BTC, ETH, XRP"
            value={filters.symbolFilter}
            onChange={(e) => updateFilter("symbolFilter", e.target.value)}
          />
        </div>

        <div className="border-t pt-4 space-y-4">
          <Label className="text-base font-semibold">Strategy Filters</Label>

          {/* Additional Category - Trailing */}
          <div className="p-3 border-l-4 border-purple-500 bg-purple-500/5 rounded-r space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-purple-500" />
              <Label className="font-semibold text-purple-700 dark:text-purple-300">Additional (Enhancement)</Label>
            </div>
            <div className="space-y-2 pl-6">
              <Label htmlFor="trailing-filter" className="text-sm">
                Trailing Stop
              </Label>
              <Select value={filters.trailingFilter} onValueChange={(value) => updateFilter("trailingFilter", value)}>
                <SelectTrigger id="trailing-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="no">No Filter</SelectItem>
                  <SelectItem value="yes">Include Trailing</SelectItem>
                  <SelectItem value="only">Only Trailing</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Filter by trailing stop enhancement strategy</p>
            </div>
          </div>

          {/* Adjust Category - Block & DCA */}
          <div className="p-3 border-l-4 border-blue-500 bg-blue-500/5 rounded-r space-y-3">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-blue-500" />
              <Label className="font-semibold text-blue-700 dark:text-blue-300">Adjust (Volume/Position)</Label>
            </div>

            <div className="space-y-2 pl-6">
              <Label htmlFor="adjust-block-filter" className="text-sm">
                Block Strategy
              </Label>
              <Select value={filters.adjustBlock} onValueChange={(value) => updateFilter("adjustBlock", value)}>
                <SelectTrigger id="adjust-block-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="no">No Filter</SelectItem>
                  <SelectItem value="yes">Include Block</SelectItem>
                  <SelectItem value="only">Only Block</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Filter by block volume adjustment strategy</p>
            </div>

            <div className="space-y-2 pl-6">
              <Label htmlFor="adjust-dca-filter" className="text-sm">
                DCA Strategy
              </Label>
              <Select value={filters.adjustDca} onValueChange={(value) => updateFilter("adjustDca", value)}>
                <SelectTrigger id="adjust-dca-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="no">No Filter</SelectItem>
                  <SelectItem value="yes">Include DCA</SelectItem>
                  <SelectItem value="only">Only DCA</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Filter by DCA position adjustment strategy</p>
            </div>
          </div>
        </div>

        {/* Toggle Filters */}
        <div className="space-y-4 border-t pt-4">
          <div className="flex items-center justify-between">
            <Label>Active Only</Label>
            <Switch checked={filters.activeOnly} onCheckedChange={(checked) => updateFilter("activeOnly", checked)} />
          </div>
        </div>

        {/* Quick Filters */}
        <div className="space-y-2">
          <Label>Quick Filters</Label>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => updateFilter("profitFactorMin", 1.0)}>
              High Profit (≥1.0)
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                updateFilter("type", ["direction"])
                updateFilter("rangeMin", 10)
                updateFilter("rangeMax", 20)
              }}
            >
              Direction 10-20
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-purple-500/50 hover:bg-purple-500/10 bg-transparent"
              onClick={() => updateFilter("trailingFilter", "only")}
            >
              Additional: Trailing
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-blue-500/50 hover:bg-blue-500/10 bg-transparent"
              onClick={() => updateFilter("adjustBlock", "only")}
            >
              Adjust: Block
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-blue-500/50 hover:bg-blue-500/10 bg-transparent"
              onClick={() => updateFilter("adjustDca", "only")}
            >
              Adjust: DCA
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
