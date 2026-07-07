"use client"
export const dynamic = "force-dynamic"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import {
  RefreshCw,
  Target,
  TrendingUp,
  Loader2,
  AlertCircle,
  BarChart3,
  Settings2,
  Zap,
  Sparkles,
  SlidersHorizontal,
  Activity,
  LineChart,
} from "lucide-react"
import { PresetTypeManager } from "@/components/presets/preset-type-manager"
import { ConfigurationSetManager } from "@/components/presets/configuration-set-manager"
import { CoordinationResults } from "@/components/presets/coordination-results"
import { AutoOptimalConfigurationForm } from "@/components/presets/auto-optimal-configuration"
import { AutoOptimalResults } from "@/components/presets/auto-optimal-results"
import type { PresetType, PresetConfigurationSet, PresetCoordinationResult } from "@/lib/types-preset-coordination"
import type { AutoOptimalResult } from "@/lib/types-auto-optimal"

export default function PresetsPage() {
  const [activeTab, setActiveTab] = useState("preset-types")
  const [presetTypes, setPresetTypes] = useState<PresetType[]>([])
  const [configSets, setConfigSets] = useState<PresetConfigurationSet[]>([])
  const [results, setResults] = useState<PresetCoordinationResult[]>([])
  const [autoOptimalResults, setAutoOptimalResults] = useState<AutoOptimalResult[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [indicationCategoryFilter, setIndicationCategoryFilter] = useState<"all" | "main" | "common">("all")

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setIsLoading(true)
      setError(null)

      await Promise.all([loadPresetTypes(), loadConfigSets(), loadResults()])
    } catch (error) {
      console.error("[v0] Failed to load preset data:", error)
      setError(error instanceof Error ? error.message : "Failed to load data")
    } finally {
      setIsLoading(false)
    }
  }

  const loadPresetTypes = async () => {
    try {
      const response = await fetch("/api/preset-types")
      if (!response.ok) throw new Error("Failed to load preset types")
      const data = await response.json()
      setPresetTypes(Array.isArray(data) ? data : [])
    } catch (error) {
      console.error("[v0] Failed to load preset types:", error)
      setPresetTypes([])
    }
  }

  const loadConfigSets = async () => {
    try {
      const response = await fetch("/api/preset-config-sets")
      if (!response.ok) throw new Error("Failed to load configuration sets")
      const data = await response.json()
      setConfigSets(Array.isArray(data) ? data : [])
    } catch (error) {
      console.error("[v0] Failed to load configuration sets:", error)
      setConfigSets([])
    }
  }

  const loadResults = async () => {
    try {
      const response = await fetch("/api/preset-coordination-results")
      if (!response.ok) throw new Error("Failed to load coordination results")
      const data = await response.json()
      setResults(Array.isArray(data) ? data : [])
    } catch (error) {
      console.error("[v0] Failed to load coordination results:", error)
      setResults([])
    }
  }

  const handleAutoOptimalCalculate = async (config: any) => {
    try {
      const response = await fetch("/api/auto-optimal/calculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      })

      if (!response.ok) throw new Error("Failed to calculate optimal configurations")

      const data = await response.json()
      setAutoOptimalResults(data.results || [])
    } catch (error) {
      console.error("[v0] Failed to calculate auto optimal:", error)
      throw error
    }
  }

  const handleSaveAutoOptimalSet = async (selectedResults: string[]) => {
    console.log("[v0] Saving auto optimal set with results:", selectedResults)
  }

  const filteredConfigSets = configSets.filter((set) => {
    if (indicationCategoryFilter === "all") return true
    return set.indication_category === indicationCategoryFilter
  })

  const filteredResults = results.filter((result) => {
    if (indicationCategoryFilter === "all") return true
    return result.indication_category === indicationCategoryFilter
  })

  const stats = {
    totalTypes: presetTypes.length,
    activeTypes: presetTypes.filter((p) => p.is_active).length,
    autoEvaluating: presetTypes.filter((p) => p.auto_evaluate).length,
    totalSets: configSets.length,
    activeSets: configSets.filter((s) => s.is_active).length,
    mainSets: configSets.filter((s) => s.indication_category === "main").length,
    commonSets: configSets.filter((s) => s.indication_category === "common").length,
    validResults: results.filter((r) => r.is_valid).length,
    avgProfitFactor: results.length > 0 ? results.reduce((sum, r) => sum + r.profit_factor, 0) / results.length : 0,
  }

  if (error && !isLoading) {
    return (
      <div className="container mx-auto py-2 px-4">
        <Card>
          <CardHeader>
            <CardTitle>Preset Coordination System</CardTitle>
            <CardDescription>Error loading preset data</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center justify-center p-8 space-y-4">
              <AlertCircle className="h-12 w-12 text-destructive" />
              <p className="text-center text-muted-foreground">{error}</p>
              <Button onClick={loadData} variant="outline">
                <RefreshCw className="h-4 w-4 mr-2" />
                Try Again
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="container mx-auto py-2 px-4">
        <Card>
          <CardHeader>
            <CardTitle>Preset Coordination System</CardTitle>
            <CardDescription>Loading preset data...</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center p-8">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="container mx-auto py-2 px-4 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Preset Coordination System</h1>
          <p className="text-muted-foreground">
            Manage preset types, configuration sets, and automated trading coordination
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Select
            value={indicationCategoryFilter}
            onValueChange={(value: "all" | "main" | "common") => setIndicationCategoryFilter(value)}
          >
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Filter by Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Indications</SelectItem>
              <SelectItem value="main">
                <div className="flex items-center gap-2">
                  <Activity className="h-4 w-4 text-green-500" />
                  Main (Direction/Move/Active)
                </div>
              </SelectItem>
              <SelectItem value="common">
                <div className="flex items-center gap-2">
                  <LineChart className="h-4 w-4 text-blue-500" />
                  Common (RSI/MACD/SAR/ATR)
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={loadData} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Refresh All
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-l-4 border-green-500">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Activity className="h-5 w-5 text-green-500" />
              <div>
                <div className="font-semibold text-green-700 dark:text-green-300">Main Indications</div>
                <div className="text-sm text-muted-foreground">Direction, Move, Active, Optimal</div>
                <Badge variant="outline" className="mt-1">
                  {stats.mainSets} Sets
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-blue-500">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <LineChart className="h-5 w-5 text-blue-500" />
              <div>
                <div className="font-semibold text-blue-700 dark:text-blue-300">Common Indicators</div>
                <div className="text-sm text-muted-foreground">RSI, MACD, Bollinger, SAR, ADX</div>
                <Badge variant="outline" className="mt-1">
                  {stats.commonSets} Sets
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-purple-500">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <Sparkles className="h-5 w-5 text-purple-500" />
              <div>
                <div className="font-semibold text-purple-700 dark:text-purple-300">Additional (Enhancement)</div>
                <div className="text-sm text-muted-foreground">Trailing Stop - Dynamic profit protection</div>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-orange-500">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <SlidersHorizontal className="h-5 w-5 text-orange-500" />
              <div>
                <div className="font-semibold text-orange-700 dark:text-orange-300">Adjust (Volume/Position)</div>
                <div className="text-sm text-muted-foreground">Block & DCA - Volume adjustments</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Target className="h-5 w-5 text-blue-500" />
              <div>
                <div className="text-2xl font-bold">{stats.totalTypes}</div>
                <div className="text-sm text-muted-foreground">Preset Types</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Settings2 className="h-5 w-5 text-purple-500" />
              <div>
                <div className="text-2xl font-bold">{filteredConfigSets.length}</div>
                <div className="text-sm text-muted-foreground">
                  Config Sets {indicationCategoryFilter !== "all" && `(${indicationCategoryFilter})`}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-green-500" />
              <div>
                <div className="text-2xl font-bold">{stats.validResults}</div>
                <div className="text-sm text-muted-foreground">Valid Results</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-orange-500" />
              <div>
                <div className="text-2xl font-bold">{stats.avgProfitFactor.toFixed(2)}</div>
                <div className="text-sm text-muted-foreground">Avg Profit Factor</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="preset-types">Preset Types</TabsTrigger>
          <TabsTrigger value="config-sets">Configuration Sets</TabsTrigger>
          <TabsTrigger value="results">Coordination Results</TabsTrigger>
          <TabsTrigger value="auto-optimal">
            <Zap className="h-4 w-4 mr-2" />
            Auto Optimal
          </TabsTrigger>
        </TabsList>

        <TabsContent value="preset-types" className="space-y-4">
          <PresetTypeManager presetTypes={presetTypes} onRefresh={loadPresetTypes} />
        </TabsContent>

        <TabsContent value="config-sets" className="space-y-4">
          <ConfigurationSetManager
            configSets={filteredConfigSets}
            presetTypes={presetTypes}
            onRefresh={loadConfigSets}
            indicationCategoryFilter={indicationCategoryFilter}
          />
        </TabsContent>

        <TabsContent value="results" className="space-y-4">
          <CoordinationResults
            results={filteredResults}
            presetTypes={presetTypes}
            configSets={filteredConfigSets}
            onRefresh={loadResults}
          />
        </TabsContent>

        <TabsContent value="auto-optimal" className="space-y-4">
          <AutoOptimalConfigurationForm onCalculate={handleAutoOptimalCalculate} />
          {autoOptimalResults.length > 0 && (
            <AutoOptimalResults results={autoOptimalResults} onSaveSet={handleSaveAutoOptimalSet} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
