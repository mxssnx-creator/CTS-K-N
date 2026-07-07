"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
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
  Activity,
  TrendingUp,
  AlertCircle,
  ChevronDown,
  Settings2,
} from "lucide-react"

interface MainTradeConfig {
  enabled: boolean
  status: "idle" | "active" | "paused" | "stopped"
  entrySettings: {
    indicationBased: boolean
    confirmationRequired: number
    sizeCalculationMethod: "fixed" | "percentage" | "dynamic"
    leverage?: number
  }
  exitSettings: {
    takeProfitPercent: number
    stopLossPercent: number
    trailingStopEnabled: boolean
    trailingStopDistance?: number
    timeBasedExit?: number
  }
  positionManagement: {
    maxPositionsTotal: number
    maxPerSymbol: number
    positionScaling: boolean
    partialExitRules: string
  }
  statistics: {
    activePositions: number
    unrealizedPnL: number
    unrealizedPnLPercent: number
    winRate: number
    maxDailyDrawdown: number
    averageEntryPrice: number
  }
}

interface MainTradeCardProps {
  config: MainTradeConfig
  onStatusChange?: (status: "idle" | "active" | "paused" | "stopped") => void
  onConfigUpdate?: (config: Partial<MainTradeConfig>) => void
}

export function MainTradeCard({
  config = {
    enabled: true,
    status: "idle",
    entrySettings: {
      indicationBased: true,
      confirmationRequired: 2,
      sizeCalculationMethod: "percentage",
    },
    exitSettings: {
      takeProfitPercent: 5,
      stopLossPercent: 2,
      trailingStopEnabled: false,
    },
    positionManagement: {
      maxPositionsTotal: 10,
      maxPerSymbol: 2,
      positionScaling: true,
      partialExitRules: "None",
    },
    statistics: {
      activePositions: 3,
      unrealizedPnL: 1245.5,
      unrealizedPnLPercent: 2.45,
      winRate: 65,
      maxDailyDrawdown: 1.2,
      averageEntryPrice: 0,
    },
  },
  onStatusChange,
  onConfigUpdate,
}: MainTradeCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)

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
                  <Activity className="h-5 w-5 text-green-500" />
                  <div>
                    <CardTitle className="text-lg">Main Trade</CardTitle>
                    <CardDescription>Live trading configuration and status</CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Badge className={`${getStatusColor(config.status)} border`}>
                    {getStatusLabel(config.status)}
                  </Badge>
                  <Badge variant="secondary" className="text-xs">
                    {config.statistics.activePositions} positions
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

            {/* Statistics Overview */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-lg bg-slate-50 dark:bg-slate-900/30 p-3">
                <p className="text-xs text-muted-foreground">P&L</p>
                <p className={`text-sm font-semibold ${config.statistics.unrealizedPnL >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {config.statistics.unrealizedPnL >= 0 ? "+" : ""}${config.statistics.unrealizedPnL.toFixed(2)}
                </p>
                <p className={`text-xs ${config.statistics.unrealizedPnLPercent >= 0 ? "text-green-600" : "text-red-600"}`}>
                  {config.statistics.unrealizedPnLPercent >= 0 ? "+" : ""}{config.statistics.unrealizedPnLPercent.toFixed(2)}%
                </p>
              </div>

              <div className="rounded-lg bg-slate-50 dark:bg-slate-900/30 p-3">
                <p className="text-xs text-muted-foreground">Win Rate</p>
                <p className="text-sm font-semibold text-blue-600">{config.statistics.winRate}%</p>
                <p className="text-xs text-muted-foreground">{Math.round(config.statistics.winRate * config.statistics.activePositions / 100)} wins</p>
              </div>

              <div className="rounded-lg bg-slate-50 dark:bg-slate-900/30 p-3">
                <p className="text-xs text-muted-foreground">Max Drawdown</p>
                <p className="text-sm font-semibold text-orange-600">{config.statistics.maxDailyDrawdown.toFixed(2)}%</p>
                <p className="text-xs text-muted-foreground">Daily</p>
              </div>

              <div className="rounded-lg bg-slate-50 dark:bg-slate-900/30 p-3">
                <p className="text-xs text-muted-foreground">Active</p>
                <p className="text-sm font-semibold">{config.statistics.activePositions}</p>
                <p className="text-xs text-muted-foreground">Positions</p>
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
            <Tabs defaultValue="entry" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="entry" className="text-xs">
                  Entry
                </TabsTrigger>
                <TabsTrigger value="exit" className="text-xs">
                  Exit
                </TabsTrigger>
                <TabsTrigger value="management" className="text-xs">
                  Management
                </TabsTrigger>
              </TabsList>

              {/* Entry Settings */}
              <TabsContent value="entry" className="space-y-3 mt-3">
                <div className="space-y-3 rounded-lg bg-slate-50 dark:bg-slate-900/30 p-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">Indication-Based Entry</Label>
                    <Switch
                      checked={config.entrySettings.indicationBased}
                      onCheckedChange={(checked) =>
                        onConfigUpdate?.({
                          entrySettings: { ...config.entrySettings, indicationBased: checked },
                        })
                      }
                    />
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Confirmation Required</Label>
                      <Badge variant="secondary" className="text-xs">
                        {config.entrySettings.confirmationRequired} signals
                      </Badge>
                    </div>
                    <Slider
                      value={[config.entrySettings.confirmationRequired]}
                      onValueChange={(value) =>
                        onConfigUpdate?.({
                          entrySettings: {
                            ...config.entrySettings,
                            confirmationRequired: value[0],
                          },
                        })
                      }
                      min={1}
                      max={5}
                      step={1}
                    />
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Size Calculation</Label>
                    <div className="flex gap-2">
                      {["fixed", "percentage", "dynamic"].map((method) => (
                        <Button
                          key={method}
                          variant={
                            config.entrySettings.sizeCalculationMethod === method
                              ? "default"
                              : "outline"
                          }
                          size="sm"
                          className="text-xs flex-1"
                          onClick={() =>
                            onConfigUpdate?.({
                              entrySettings: {
                                ...config.entrySettings,
                                sizeCalculationMethod: method as any,
                              },
                            })
                          }
                        >
                          {method.charAt(0).toUpperCase() + method.slice(1)}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              </TabsContent>

              {/* Exit Settings */}
              <TabsContent value="exit" className="space-y-3 mt-3">
                <div className="space-y-3 rounded-lg bg-slate-50 dark:bg-slate-900/30 p-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Take Profit %</Label>
                      <Badge variant="secondary" className="text-xs">
                        {config.exitSettings.takeProfitPercent}%
                      </Badge>
                    </div>
                    <Slider
                      value={[config.exitSettings.takeProfitPercent]}
                      onValueChange={(value) =>
                        onConfigUpdate?.({
                          exitSettings: {
                            ...config.exitSettings,
                            takeProfitPercent: value[0],
                          },
                        })
                      }
                      min={0.5}
                      max={20}
                      step={0.5}
                    />
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Stop Loss %</Label>
                      <Badge variant="secondary" className="text-xs">
                        {config.exitSettings.stopLossPercent}%
                      </Badge>
                    </div>
                    <Slider
                      value={[config.exitSettings.stopLossPercent]}
                      onValueChange={(value) =>
                        onConfigUpdate?.({
                          exitSettings: {
                            ...config.exitSettings,
                            stopLossPercent: value[0],
                          },
                        })
                      }
                      min={0.5}
                      max={10}
                      step={0.5}
                    />
                  </div>

                  <Separator />

                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">Trailing Stop</Label>
                    <Switch
                      checked={config.exitSettings.trailingStopEnabled}
                      onCheckedChange={(checked) =>
                        onConfigUpdate?.({
                          exitSettings: {
                            ...config.exitSettings,
                            trailingStopEnabled: checked,
                          },
                        })
                      }
                    />
                  </div>

                  {config.exitSettings.trailingStopEnabled && (
                    <>
                      <Separator />
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label className="text-sm font-medium">Trailing Distance</Label>
                          <Badge variant="secondary" className="text-xs">
                            {config.exitSettings.trailingStopDistance}%
                          </Badge>
                        </div>
                        <Slider
                          value={[config.exitSettings.trailingStopDistance || 1]}
                          onValueChange={(value) =>
                            onConfigUpdate?.({
                              exitSettings: {
                                ...config.exitSettings,
                                trailingStopDistance: value[0],
                              },
                            })
                          }
                          min={0.1}
                          max={5}
                          step={0.1}
                        />
                      </div>
                    </>
                  )}
                </div>
              </TabsContent>

              {/* Position Management */}
              <TabsContent value="management" className="space-y-3 mt-3">
                <div className="space-y-3 rounded-lg bg-slate-50 dark:bg-slate-900/30 p-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Max Total Positions</Label>
                      <Badge variant="secondary" className="text-xs">
                        {config.positionManagement.maxPositionsTotal}
                      </Badge>
                    </div>
                    <Slider
                      value={[config.positionManagement.maxPositionsTotal]}
                      onValueChange={(value) =>
                        onConfigUpdate?.({
                          positionManagement: {
                            ...config.positionManagement,
                            maxPositionsTotal: value[0],
                          },
                        })
                      }
                      min={1}
                      max={50}
                      step={1}
                    />
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Max Per Symbol</Label>
                      <Badge variant="secondary" className="text-xs">
                        {config.positionManagement.maxPerSymbol}
                      </Badge>
                    </div>
                    <Slider
                      value={[config.positionManagement.maxPerSymbol]}
                      onValueChange={(value) =>
                        onConfigUpdate?.({
                          positionManagement: {
                            ...config.positionManagement,
                            maxPerSymbol: value[0],
                          },
                        })
                      }
                      min={1}
                      max={10}
                      step={1}
                    />
                  </div>

                  <Separator />

                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">Position Scaling</Label>
                    <Switch
                      checked={config.positionManagement.positionScaling}
                      onCheckedChange={(checked) =>
                        onConfigUpdate?.({
                          positionManagement: {
                            ...config.positionManagement,
                            positionScaling: checked,
                          },
                        })
                      }
                    />
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </CollapsibleContent>
        </Collapsible>
      </CardHeader>
    </Card>
  )
}
