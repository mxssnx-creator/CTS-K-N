"use client"

import { useState, useEffect } from "react"
import { ChevronDown, ChevronRight, TrendingUp, Clock, Target } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PresetCoordinationDiagrams } from "@/components/presets/preset-coordination-diagrams"
import type { PresetType, PresetCoordinationResult } from "@/lib/types-preset-coordination"

interface PresetCoordinationListProps {
  presetTypes: PresetType[]
}

export function PresetCoordinationList({ presetTypes }: PresetCoordinationListProps) {
  const [selectedPresetTypeId, setSelectedPresetTypeId] = useState<string>("")
  const [results, setResults] = useState<PresetCoordinationResult[]>([])
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (presetTypes.length > 0 && !selectedPresetTypeId) {
      setSelectedPresetTypeId(presetTypes[0].id)
    }
  }, [presetTypes, selectedPresetTypeId])

  useEffect(() => {
    if (selectedPresetTypeId) {
      loadResults()
    }
  }, [selectedPresetTypeId])

  const loadResults = async () => {
    if (!selectedPresetTypeId) return

    try {
      setIsLoading(true)
      const response = await fetch(`/api/preset-types/${selectedPresetTypeId}/results`)
      if (!response.ok) throw new Error("Failed to load results")

      const data = await response.json()
      setResults(Array.isArray(data) ? data : [])
    } catch (error) {
      console.error("[v0] Failed to load coordination results:", error)
      setResults([])
    } finally {
      setIsLoading(false)
    }
  }

  const toggleExpand = (id: string) => {
    const newExpanded = new Set(expandedItems)
    if (newExpanded.has(id)) {
      newExpanded.delete(id)
    } else {
      newExpanded.add(id)
    }
    setExpandedItems(newExpanded)
  }

  // Group results by indication type → position range → trailing
  const groupedResults = results.reduce(
    (acc, result) => {
      const indicationKey = `${result.indication_type}-${JSON.stringify(result.indication_params)}`
      if (!acc[indicationKey]) acc[indicationKey] = []
      acc[indicationKey].push(result)
      return acc
    },
    {} as Record<string, PresetCoordinationResult[]>,
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Select value={selectedPresetTypeId} onValueChange={setSelectedPresetTypeId}>
          <SelectTrigger className="w-[300px]">
            <SelectValue placeholder="Select preset type" />
          </SelectTrigger>
          <SelectContent>
            {presetTypes.map((pt) => (
              <SelectItem key={pt.id} value={pt.id}>
                {pt.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={loadResults} disabled={isLoading}>
          Refresh Results
        </Button>
      </div>

      {isLoading ? (
        <div className="text-center py-8 text-muted-foreground">Loading results...</div>
      ) : results.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          No coordination results yet. Run evaluation to generate results.
        </div>
      ) : (
        <div className="space-y-2">
          {Object.entries(groupedResults).map(([indicationKey, indicationResults]) => {
            const isExpanded = expandedItems.has(indicationKey)
            const avgProfitFactor =
              indicationResults.reduce((sum, r) => sum + r.profit_factor, 0) / indicationResults.length
            const avgPositionsPer24h =
              indicationResults.reduce((sum, r) => sum + r.positions_per_24h, 0) / indicationResults.length
            const avgDrawdownHours =
              indicationResults.reduce((sum, r) => sum + r.drawdown_time_hours, 0) / indicationResults.length

            return (
              <Card key={indicationKey} className="overflow-hidden">
                <button
                  onClick={() => toggleExpand(indicationKey)}
                  className="w-full p-4 flex items-center justify-between hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {isExpanded ? (
                      <ChevronDown className="h-5 w-5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    )}
                    <div className="text-left">
                      <div className="font-medium">{indicationResults[0].indication_type.toUpperCase()}</div>
                      <div className="text-sm text-muted-foreground">{indicationResults.length} configuration(s)</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-6 text-sm">
                    <div className="flex items-center gap-2">
                      <Target className="h-4 w-4 text-blue-500" />
                      <span className="text-muted-foreground">Positions/24h:</span>
                      <span className="font-medium">{avgPositionsPer24h.toFixed(1)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-green-500" />
                      <span className="text-muted-foreground">Profit Factor:</span>
                      <span className="font-medium">{avgProfitFactor.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4 text-orange-500" />
                      <span className="text-muted-foreground">Drawdown:</span>
                      <span className="font-medium">{avgDrawdownHours.toFixed(1)}h</span>
                    </div>
                    {indicationResults.some((r) => r.is_valid) && <Badge variant="default">Valid</Badge>}
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t p-4 bg-muted/30">
                    <PresetCoordinationDiagrams results={indicationResults} />
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
