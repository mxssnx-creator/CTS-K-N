"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Play,
  Pause,
  Square,
  RotateCw,
  Zap,
  BarChart3,
  ChevronDown,
  Settings2,
  ArrowRightLeft,
} from "lucide-react"

interface Preset {
  id: string
  name: string
  description: string
  type: string
  createdDate: string
  backtestScore: number
}

interface PresetTradeConfig {
  enabled: boolean
  status: "idle" | "active" | "paused" | "stopped"
  activePreset: string
  presetType: string
  availablePresets: Preset[]
  autoUpdateEnabled: boolean
  statistics: {
    coordinatedPositions: number
    testProgress: number
    activeTrades: number
    presetPnL: number
    presetPnLPercent: number
    expectedWinRate: number
  }
}

interface PresetTradeCardProps {
  config: PresetTradeConfig
  onStatusChange?: (status: "idle" | "active" | "paused" | "stopped") => void
  onPresetChange?: (presetId: string) => void
  onConfigUpdate?: (config: Partial<PresetTradeConfig>) => void
  onTestPreset?: () => void
}

export function PresetTradeCard({
  config = {
    enabled: true,
    status: "idle",
    activePreset: "preset-1",
    presetType: "auto-optimal",
    availablePresets: [
      {
        id: "preset-1",
        name: "Auto-Optimal",
        description: "Auto-tuned indicators and strategies",
        type: "auto-optimal",
        createdDate: "2024-03-15",
        backtestScore: 87.5,
      },
      {
        id: "preset-2",
        name: "Conservative",
        description: "Low-risk conservative trading",
        type: "conservative",
        createdDate: "2024-03-10",
        backtestScore: 72.3,
      },
      {
        id: "preset-3",
        name: "Aggressive",
        description: "High-risk high-reward trading",
        type: "aggressive",
        createdDate: "2024-03-05",
        backtestScore: 91.2,
      },
    ],
    autoUpdateEnabled: true,
    statistics: {
      coordinatedPositions: 5,
      testProgress: 45,
      activeTrades: 3,
      presetPnL: 2450.75,
      presetPnLPercent: 3.2,
      expectedWinRate: 72,
    },
  },
  onStatusChange,
  onPresetChange,
  onConfigUpdate,
  onTestPreset,
}: PresetTradeCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const currentPreset = config.availablePresets.find((p) => p.id === config.activePreset)

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "bg-green-500/10 text-green-600 border-green-200"
      case "paused":
        return "bg-yellow-500/10 text-yellow-600 border-yellow-200"
      case "stopped":
        return "bg-red-500/10 text-red-600 border-red-200"
      default:
        return "bg-slate-500/10 text-slate-600 border-slate-200"
    }
  }

  const getStatusLabel = (status: string) => {
    return status.charAt(0).toUpperCase() + status.slice(1)
  }

  return (
    <Card className="border-0 shadow-md">
      <CardHeader className="pb-3">
        <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
          <CollapsibleTrigger asChild>
            <div className="cursor-pointer">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Zap className="h-5 w-5 text-orange-500" />
                  <div>
                    <CardTitle className="text-lg">Preset Trade</CardTitle>
                    <CardDescription>Preset-based trading configuration</CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge className={`${getStatusColor(config.status)} border`}>
                    {getStatusLabel(config.status)}
                  </Badge>
                  <Badge variant="secondary" className="text-xs">
                    {currentPreset?.name || "None"}
                  </Badge>
                  <ChevronDown
                    className={`h-5 w-5 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                  />
                </div>
              </div>
            </div>
          </CollapsibleTrigger>

          <CollapsibleContent className="pt-4 space-y-4">
            <Separator />

            {/* Preset Selector */}
            <div className="space-y-3 rounded-lg bg-slate-50 dark:bg-slate-900/30 p-4">
              <Label className="text-sm font-medium">Active Preset</Label>
              <Select value={config.activePreset} onValueChange={onPresetChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {config.availablePresets.map((preset) => (
                    <SelectItem key={preset.id} value={preset.id}>
                      <div className="flex items-center gap-2">
                        <span>{preset.name}</span>
                        <Badge variant="secondary" className="text-xs">
                          {preset.backtestScore}
                        </Badge>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {currentPreset && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">{currentPreset.description}</p>
                    <div className="flex items-center justify-between text-xs">
                      <span>Created: {currentPreset.createdDate}</span>
                      <Badge variant="outline">Score: {currentPreset.backtestScore}</Badge>
                    </div>
                  </div>
                </>
              )}
            </div>

            <Separator />

            {/* Statistics Overview */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <div className="rounded-lg bg-slate-50 dark:bg-slate-900/30 p-3">
                <p className="text-xs text-muted-foreground">P&L</p>
                <p className={`text-sm font-semibold ${config.statistics.presetPnL >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {config.statistics.presetPnL >= 0 ? "+" : ""}${config.statistics.presetPnL.toFixed(2)}
                </p>
                <p className={`text-xs ${config.statistics.presetPnLPercent >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {config.statistics.presetPnLPercent >= 0 ? "+" : ""}{config.statistics.presetPnLPercent.toFixed(2)}%
                </p>
              </div>

              <div className="rounded-lg bg-slate-50 dark:bg-slate-900/30 p-3">
                <p className="text-xs text-muted-foreground">Active</p>
                <p className="text-sm font-semibold">{config.statistics.coordinatedPositions}</p>
                <p className="text-xs text-muted-foreground">Coordinated Pos</p>
              </div>

              <div className="rounded-lg bg-slate-50 dark:bg-slate-900/30 p-3">
                <p className="text-xs text-muted-foreground">Win Rate</p>
                <p className="text-sm font-semibold text-blue-600">{config.statistics.expectedWinRate}%</p>
                <p className="text-xs text-muted-foreground">Expected</p>
              </div>
            </div>

            <Separator />

            {/* Engine Controls */}
            <div className="space-y-2">
              <Label className="text-sm font-semibold">Engine Controls</Label>
              <div className="flex gap-2 flex-wrap">
                <Button
                  size="sm"
                  variant={config.status === "active" ? "default" : "outline"}
                  className="gap-2"
                  onClick={() => onStatusChange?.("active")}
                >
                  <Play className="h-4 w-4" />
                  Start
                </Button>
                <Button
                  size="sm"
                  variant={config.status === "paused" ? "default" : "outline"}
                  className="gap-2"
                  onClick={() => onStatusChange?.("paused")}
                >
                  <Pause className="h-4 w-4" />
                  Pause
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2"
                  onClick={() => onStatusChange?.("active")}
                >
                  <RotateCw className="h-4 w-4" />
                  Resume
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="gap-2 ml-auto"
                  onClick={() => onStatusChange?.("stopped")}
                >
                  <Square className="h-4 w-4" />
                  Stop
                </Button>
              </div>
            </div>

            <Separator />

            {/* Configuration Tabs */}
            <Tabs defaultValue="details" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="details" className="text-xs">
                  Details
                </TabsTrigger>
                <TabsTrigger value="configuration" className="text-xs">
                  Config
                </TabsTrigger>
                <TabsTrigger value="presets" className="text-xs">
                  Presets
                </TabsTrigger>
              </TabsList>

              {/* Preset Details */}
              <TabsContent value="details" className="space-y-3 mt-3">
                {currentPreset && (
                  <div className="space-y-3 rounded-lg bg-slate-50 dark:bg-slate-900/30 p-4">
                    <div>
                      <Label className="text-xs text-muted-foreground">Name</Label>
                      <p className="text-sm font-medium">{currentPreset.name}</p>
                    </div>

                    <Separator />

                    <div>
                      <Label className="text-xs text-muted-foreground">Type</Label>
                      <p className="text-sm font-medium capitalize">{currentPreset.type}</p>
                    </div>

                    <Separator />

                    <div>
                      <Label className="text-xs text-muted-foreground">Created</Label>
                      <p className="text-sm font-medium">{currentPreset.createdDate}</p>
                    </div>

                    <Separator />

                    <div>
                      <Label className="text-xs text-muted-foreground">Backtest Score</Label>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex-1 bg-slate-200 dark:bg-slate-700 rounded-full h-2 overflow-hidden">
                          <div
                            className="bg-green-500 h-full"
                            style={{ width: `${currentPreset.backtestScore}%` }}
                          />
                        </div>
                        <span className="text-sm font-semibold">{currentPreset.backtestScore}%</span>
                      </div>
                    </div>

                    <Separator />

                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Auto-Update</Label>
                      <div
                        className={`h-3 w-3 rounded-full ${
                          config.autoUpdateEnabled ? "bg-green-500" : "bg-gray-400"
                        }`}
                      />
                    </div>
                  </div>
                )}
              </TabsContent>

              {/* Configuration Settings */}
              <TabsContent value="configuration" className="space-y-3 mt-3">
                <div className="space-y-3 rounded-lg bg-slate-50 dark:bg-slate-900/30 p-4">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Symbols Included</Label>
                    <Input
                      placeholder="BTC, ETH, XRP..."
                      className="text-xs"
                      defaultValue="BTC, ETH, XRP, SOL"
                      readOnly
                    />
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Position Size Multiplier</Label>
                      <Badge variant="secondary" className="text-xs">
                        1.0x
                      </Badge>
                    </div>
                    <Slider
                      value={[1.0]}
                      onValueChange={() => {}}
                      min={0.5}
                      max={2}
                      step={0.1}
                    />
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Risk Level</Label>
                      <Badge variant="secondary" className="text-xs">
                        Medium
                      </Badge>
                    </div>
                    <div className="flex gap-2">
                      {["Low", "Medium", "High"].map((level) => (
                        <Button
                          key={level}
                          variant="outline"
                          size="sm"
                          className="text-xs flex-1"
                        >
                          {level}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              </TabsContent>

              {/* Available Presets Comparison */}
              <TabsContent value="presets" className="space-y-3 mt-3">
                <div className="space-y-2">
                  {config.availablePresets.map((preset) => (
                    <div
                      key={preset.id}
                      className={`rounded-lg p-3 border ${
                        preset.id === config.activePreset
                          ? "bg-blue-50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-800"
                          : "bg-slate-50 dark:bg-slate-900/30 border-transparent"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <p className="text-sm font-medium">{preset.name}</p>
                          <p className="text-xs text-muted-foreground">{preset.description}</p>
                        </div>
                        {preset.id === config.activePreset && (
                          <Badge className="text-xs">Active</Badge>
                        )}
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Score: {preset.backtestScore}</span>
                        {preset.id !== config.activePreset && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-xs h-6"
                            onClick={() => onPresetChange?.(preset.id)}
                          >
                            Switch
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <Separator />

                <Button
                  variant="outline"
                  className="w-full gap-2 text-xs"
                  onClick={onTestPreset}
                >
                  <BarChart3 className="h-4 w-4" />
                  Test Current Preset
                </Button>
              </TabsContent>
            </Tabs>

            {/* Test Progress */}
            {config.statistics.testProgress > 0 && config.statistics.testProgress < 100 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">
                    Test Progress: {config.statistics.testProgress}%
                  </Label>
                  <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-blue-500 h-full transition-all"
                      style={{ width: `${config.statistics.testProgress}%` }}
                    />
                  </div>
                </div>
              </>
            )}
          </CollapsibleContent>
        </Collapsible>
      </CardHeader>
    </Card>
  )
}
