"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Preset, PresetStrategy } from "@/lib/types"
import { TrendingUp, Target, BarChart3, RefreshCw } from "lucide-react"

interface PresetStrategiesViewProps {
  presets: Preset[]
}

export function PresetStrategiesView({ presets }: PresetStrategiesViewProps) {
  const [selectedPresetId, setSelectedPresetId] = useState<string>("")
  const [strategies, setStrategies] = useState<PresetStrategy[]>([])
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (presets.length > 0 && !selectedPresetId) {
      setSelectedPresetId(presets[0].id)
    }
  }, [presets, selectedPresetId])

  useEffect(() => {
    if (selectedPresetId) {
      loadStrategies()
    }
  }, [selectedPresetId])

  const loadStrategies = async () => {
    if (!selectedPresetId) return

    try {
      setIsLoading(true)
      const response = await fetch(`/api/presets/${selectedPresetId}/strategies`)
      const data = await response.json()
      setStrategies(data)
    } catch (error) {
      console.error("[v0] Failed to load preset strategies:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const validatedStrategies = strategies.filter((s) => s.is_validated)
  const avgProfitFactor = strategies.reduce((sum, s) => sum + s.profit_factor, 0) / (strategies.length || 1)
  const avgWinRate = strategies.reduce((sum, s) => sum + s.win_rate, 0) / (strategies.length || 1)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Select value={selectedPresetId} onValueChange={setSelectedPresetId}>
          <SelectTrigger className="w-[300px]">
            <SelectValue placeholder="Select a preset" />
          </SelectTrigger>
          <SelectContent>
            {presets.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button variant="outline" onClick={loadStrategies} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-blue-500" />
              <div>
                <div className="text-2xl font-bold">{strategies.length}</div>
                <div className="text-sm text-muted-foreground">Total Strategies</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Target className="h-5 w-5 text-green-500" />
              <div>
                <div className="text-2xl font-bold">{validatedStrategies.length}</div>
                <div className="text-sm text-muted-foreground">Validated</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-purple-500" />
              <div>
                <div className="text-2xl font-bold">{strategies.length > 0 ? avgProfitFactor.toFixed(2) : "—"}</div>
                <div className="text-sm text-muted-foreground">Avg R</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-orange-500" />
              <div>
                <div className="text-2xl font-bold">{avgWinRate.toFixed(1)}%</div>
                <div className="text-sm text-muted-foreground">Avg Win Rate</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {strategies.length === 0 && !isLoading && (
        <Card>
          <CardContent className="p-12 text-center">
            <Target className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold mb-2">No strategies yet</h3>
            <p className="text-muted-foreground">Strategies will be generated and validated automatically</p>
          </CardContent>
        </Card>
      )}

      {strategies.length > 0 && (
        <div className="space-y-2">
          {strategies.slice(0, 20).map((strategy) => (
            <Card key={strategy.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div>
                      <div className="font-medium">{strategy.symbol}</div>
                      <div className="text-sm text-muted-foreground">
                        {strategy.indication_type} • {strategy.strategy_type}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Badge variant="outline">TP: {strategy.takeprofit_factor}x</Badge>
                      <Badge variant="outline">SL: {strategy.stoploss_ratio}x</Badge>
                      {strategy.trailing_enabled && <Badge variant="outline">Trailing</Badge>}
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="font-medium">Signed R: {strategy.profit_factor.toFixed(2)}</div>
                      <div className="text-sm text-muted-foreground">WR: {strategy.win_rate.toFixed(1)}%</div>
                    </div>
                    {strategy.is_validated ? (
                      <Badge variant="default">Validated</Badge>
                    ) : (
                      <Badge variant="outline">Pending</Badge>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
