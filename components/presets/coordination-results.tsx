"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { RefreshCw, TrendingUp, TrendingDown, BarChart3, Filter, Save, X } from "lucide-react"
import type { PresetCoordinationResult, PresetType, PresetConfigurationSet } from "@/lib/types-preset-coordination"
import { toast } from "@/lib/simple-toast"

interface CoordinationResultsProps {
  results: PresetCoordinationResult[]
  presetTypes: PresetType[]
  configSets: PresetConfigurationSet[]
  onRefresh: () => void
}

export function CoordinationResults({ results, presetTypes, configSets, onRefresh }: CoordinationResultsProps) {
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [selectedConfigSet, setSelectedConfigSet] = useState<string | null>(null)
  const [minProfitFactor, setMinProfitFactor] = useState(0)
  const [minWinRate, setMinWinRate] = useState(0)
  const [maxDrawdown, setMaxDrawdown] = useState(24)
  const [showValidOnly, setShowValidOnly] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [selectedResults, setSelectedResults] = useState<Set<string>>(new Set())
  const [saveSetName, setSaveSetName] = useState("")

  const filteredResults = results.filter((result) => {
    if (selectedSymbol && result.symbol !== selectedSymbol) return false
    if (selectedType && result.preset_type_id !== selectedType) return false
    if (selectedConfigSet && result.configuration_set_id !== selectedConfigSet) return false
    if (result.profit_factor < minProfitFactor) return false
    if (result.win_rate < minWinRate / 100) return false
    if (result.drawdown_time_hours > maxDrawdown) return false
    if (showValidOnly && !result.is_valid) return false
    return true
  })

  const symbols = Array.from(new Set(results.map((r) => r.symbol)))

  const getPresetTypeName = (id: string) => {
    const type = presetTypes.find((t) => t.id === id)
    return type?.name || "Unknown"
  }

  const getConfigSetName = (id: string) => {
    const set = configSets.find((s) => s.id === id)
    return set?.name || "Unknown"
  }

  const toggleSelection = (id: string) => {
    const newSelection = new Set(selectedResults)
    if (newSelection.has(id)) {
      newSelection.delete(id)
    } else {
      newSelection.add(id)
    }
    setSelectedResults(newSelection)
  }

  const selectAll = () => {
    setSelectedResults(new Set(filteredResults.map((r) => r.id)))
  }

  const selectNone = () => {
    setSelectedResults(new Set())
  }

  const saveSelectedAsSet = async () => {
    if (!saveSetName.trim()) {
      toast.error("Please enter a name for the configuration set")
      return
    }

    if (selectedResults.size === 0) {
      toast.error("Please select at least one result")
      return
    }

    try {
      const selectedData = filteredResults.filter((r) => selectedResults.has(r.id))

      const response = await fetch("/api/preset-config-sets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: saveSetName,
          description: `Saved from ${selectedResults.size} selected results`,
          results: selectedData,
        }),
      })

      if (!response.ok) throw new Error("Failed to save configuration set")

      toast.success(`Configuration set "${saveSetName}" saved successfully`)
      setSaveSetName("")
      setSelectedResults(new Set())
      onRefresh()
    } catch (error) {
      toast.error("Failed to save configuration set")
    }
  }

  const clearFilters = () => {
    setSelectedSymbol(null)
    setSelectedType(null)
    setSelectedConfigSet(null)
    setMinProfitFactor(0)
    setMinWinRate(0)
    setMaxDrawdown(24)
    setShowValidOnly(false)
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold">Coordination Results</h2>
          <p className="text-sm text-muted-foreground">
            View backtest and evaluation results for preset configurations
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowFilters(!showFilters)}>
            <Filter className="h-4 w-4 mr-2" />
            {showFilters ? "Hide" : "Show"} Filters
          </Button>
          <Button variant="outline" onClick={onRefresh}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {showFilters && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Filters</CardTitle>
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="h-4 w-4 mr-2" />
                Clear All
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Preset Type</Label>
                <Select value={selectedType || "all"} onValueChange={(v) => setSelectedType(v === "all" ? null : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="All Types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    {presetTypes.map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        {type.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Configuration Set</Label>
                <Select
                  value={selectedConfigSet || "all"}
                  onValueChange={(v) => setSelectedConfigSet(v === "all" ? null : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All Sets" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Sets</SelectItem>
                    {configSets.map((set) => (
                      <SelectItem key={set.id} value={set.id}>
                        {set.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Symbol</Label>
                <Select
                  value={selectedSymbol || "all"}
                  onValueChange={(v) => setSelectedSymbol(v === "all" ? null : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All Symbols" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Symbols</SelectItem>
                    {symbols.map((symbol) => (
                      <SelectItem key={symbol} value={symbol}>
                        {symbol}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Min Profit Factor: {minProfitFactor.toFixed(1)}</Label>
                <Slider
                  value={[minProfitFactor]}
                  onValueChange={([v]) => setMinProfitFactor(v)}
                  min={0}
                  max={5}
                  step={0.1}
                />
              </div>

              <div className="space-y-2">
                <Label>Min Win Rate: {minWinRate}%</Label>
                <Slider value={[minWinRate]} onValueChange={([v]) => setMinWinRate(v)} min={0} max={100} step={5} />
              </div>

              <div className="space-y-2">
                <Label>Max Drawdown: {maxDrawdown}h</Label>
                <Slider value={[maxDrawdown]} onValueChange={([v]) => setMaxDrawdown(v)} min={0} max={48} step={1} />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="validOnly"
                checked={showValidOnly}
                onChange={(e) => setShowValidOnly(e.target.checked)}
                className="rounded"
              />
              <Label htmlFor="validOnly" className="cursor-pointer">
                Show valid results only
              </Label>
            </div>

            <div className="text-sm text-muted-foreground">
              Showing {filteredResults.length} of {results.length} results
            </div>
          </CardContent>
        </Card>
      )}

      {filteredResults.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={selectAll}>
                  Select All
                </Button>
                <Button variant="outline" size="sm" onClick={selectNone}>
                  Select None
                </Button>
                <span className="text-sm text-muted-foreground">{selectedResults.size} selected</span>
              </div>
              {selectedResults.size > 0 && (
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Configuration set name..."
                    value={saveSetName}
                    onChange={(e) => setSaveSetName(e.target.value)}
                    className="w-64"
                  />
                  <Button onClick={saveSelectedAsSet}>
                    <Save className="h-4 w-4 mr-2" />
                    Save as Set
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {filteredResults.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <BarChart3 className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold mb-2">No results found</h3>
            <p className="text-muted-foreground mb-4">
              {results.length === 0
                ? "Run backtests or evaluations to see coordination results here"
                : "Try adjusting your filters to see more results"}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredResults.map((result) => (
            <Card
              key={result.id}
              className={`cursor-pointer transition-colors ${
                selectedResults.has(result.id) ? "ring-2 ring-primary" : ""
              }`}
              onClick={() => toggleSelection(result.id)}
            >
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <CardTitle className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedResults.has(result.id)}
                        onChange={() => toggleSelection(result.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded"
                      />
                      {result.symbol}
                      {result.is_valid ? (
                        <Badge variant="default">Valid</Badge>
                      ) : (
                        <Badge variant="destructive">Invalid</Badge>
                      )}
                      <Badge variant="outline">{result.indication_type}</Badge>
                    </CardTitle>
                    <CardDescription>
                      {getPresetTypeName(result.preset_type_id)} • {getConfigSetName(result.configuration_set_id)}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    {result.profit_factor >= 1 ? (
                      <TrendingUp className="h-5 w-5 text-green-500" />
                    ) : (
                      <TrendingDown className="h-5 w-5 text-red-500" />
                    )}
                    <span className="text-lg font-bold">{result.profit_factor.toFixed(2)}</span>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                  <div>
                    <div className="text-muted-foreground">Win Rate</div>
                    <div className="font-medium">{(result.win_rate * 100).toFixed(1)}%</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Total Trades</div>
                    <div className="font-medium">{result.total_trades}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">TP Factor</div>
                    <div className="font-medium">{result.takeprofit_factor}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">SL Ratio</div>
                    <div className="font-medium">{result.stoploss_ratio}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Drawdown</div>
                    <div className="font-medium">{result.drawdown_time_hours.toFixed(1)}h</div>
                  </div>
                </div>
                {result.validation_reason && (
                  <div className="mt-4 p-2 bg-muted rounded text-sm">
                    <span className="text-muted-foreground">Reason: </span>
                    {result.validation_reason}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
