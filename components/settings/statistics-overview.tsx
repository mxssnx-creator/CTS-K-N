"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"

interface StatisticsOverviewProps {
  settings: any
}

export function StatisticsOverview({ settings }: StatisticsOverviewProps) {
  // Safety check for undefined settings
  if (!settings) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Statistics Overview</CardTitle>
          <CardDescription>Loading statistics...</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Waiting for settings to load...</p>
        </CardContent>
      </Card>
    )
  }

  // Calculate comprehensive statistics from settings
  const calculateRatios = () => {
    const directionRanges = settings.direction?.range
      ? Math.ceil((settings.direction.range.to - settings.direction.range.from) / settings.direction.range.step) + 1
      : 0
    const moveRanges = settings.move?.range
      ? Math.ceil((settings.move.range.to - settings.move.range.from) / settings.move.range.step) + 1
      : 0
    const activeRanges = settings.active?.range
      ? Math.ceil((settings.active.range.to - settings.active.range.from) / settings.active.range.step) + 1
      : 0

    return { directionRanges, moveRanges, activeRanges }
  }

  const calculateProfitFactorDistribution = () => {
    // ── Main Trade PF thresholds (spec defaults 0.9/1.0/1.0/1.0) ─────
    // `live` was added alongside base/main/real per spec — the four
    // Main-Trade stages are gated independently from the Strategies
    // tab. Preset stays distinct (separate engine, separate threshold
    // at `presetProfitFactor`). Fallback values match the engine's
    // own fallbacks so the overview reflects exactly what the engine
    // gates with when settings haven't loaded yet.
    return {
      base: settings.baseProfitFactor || 0.9,
      main: settings.mainProfitFactor || 1.0,
      real: settings.realProfitFactor || 1.0,
      live: settings.liveProfitFactor || 1.0,
      preset: settings.presetProfitFactor || 0.6,
    }
  }

  const calculateIntervalStatistics = () => {
    return {
      mainEngine: settings.mainEngineInterval || 200,
      presetEngine: settings.presetEngineInterval || 200,
      activeOrderHandling: settings.activeOrderHandlingInterval || 50,
      tradeInterval: settings.trade_interval || 1,
    }
  }

  const calculateDatabaseLimits = () => {
    return {
      base: settings.baseDatabaseSize || 250,
      main: settings.mainDatabaseSize || 250,
      real: settings.realDatabaseSize || 250,
      preset: settings.presetDatabaseSize || 250,
    }
  }

  const ratios = calculateRatios()
  const profitFactors = calculateProfitFactorDistribution()
  const intervals = calculateIntervalStatistics()
  const dbLimits = calculateDatabaseLimits()

  return (
    <div className="space-y-4">
      {/* Indication Ratios & Ranges */}
      <Card>
        <CardHeader>
          <CardTitle>Indication Ratios & Ranges</CardTitle>
          <CardDescription>Configuration distribution across indication types</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-sm font-medium mb-2">Direction</div>
              <div className="text-2xl font-bold">{ratios.directionRanges}</div>
              <div className="text-xs text-muted-foreground">Range variations</div>
              <Progress value={(ratios.directionRanges / 10) * 100} className="mt-2" />
            </div>
            <div>
              <div className="text-sm font-medium mb-2">Move</div>
              <div className="text-2xl font-bold">{ratios.moveRanges}</div>
              <div className="text-xs text-muted-foreground">Range variations</div>
              <Progress value={(ratios.moveRanges / 10) * 100} className="mt-2" />
            </div>
            <div>
              <div className="text-sm font-medium mb-2">Active</div>
              <div className="text-2xl font-bold">{ratios.activeRanges}</div>
              <div className="text-xs text-muted-foreground">Range variations</div>
              <Progress value={(ratios.activeRanges / 20) * 100} className="mt-2" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Profit Factor Requirements */}
      <Card>
        <CardHeader>
          <CardTitle>Minimum Profit Factor Requirements</CardTitle>
          <CardDescription>Performance thresholds for strategy types</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            {Object.entries(profitFactors).map(([type, value]) => (
              <div key={type} className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <div className="font-medium capitalize">{type} Strategy</div>
                  <div className="text-2xl font-bold mt-1">{value.toFixed(2)}</div>
                </div>
                <Badge variant={value >= 0.7 ? "default" : value >= 0.5 ? "secondary" : "destructive"}>
                  {value >= 0.7 ? "Strong" : value >= 0.5 ? "Moderate" : "Weak"}
                </Badge>
              </div>
            ))}
          </div>
          <div className="mt-4 p-3 bg-muted rounded-lg">
            <div className="text-sm font-medium mb-2">Average Profit Factor</div>
            <div className="text-2xl font-bold">
              {(Object.values(profitFactors).reduce((a, b) => a + b, 0) / Object.values(profitFactors).length).toFixed(
                2,
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Engine Intervals & Performance */}
      <Card>
        <CardHeader>
          <CardTitle>Engine Intervals & Processing Time</CardTitle>
          <CardDescription>Configuration for engine processing speeds</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Object.entries(intervals).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between p-2 border rounded">
                <div className="text-sm font-medium capitalize">{key.replace(/([A-Z])/g, " $1").trim()}</div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">
                    {value} {typeof value === "number" && value >= 50 ? "ms" : "s"}
                  </Badge>
                  <div className="text-xs text-muted-foreground">
                    {value >= 200 ? "Standard" : value >= 100 ? "Fast" : "Very Fast"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Database Limits & Capacity */}
      <Card>
        <CardHeader>
          <CardTitle>Database Size Limits</CardTitle>
          <CardDescription>Maximum positions per strategy type</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            {Object.entries(dbLimits).map(([type, limit]) => (
              <div key={type} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium capitalize">{type}</div>
                  <Badge>{limit}</Badge>
                </div>
                <Progress value={(limit / 750) * 100} className="h-2" />
                <div className="text-xs text-muted-foreground">
                  {limit < 200 ? "Conservative" : limit < 400 ? "Balanced" : "Aggressive"}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 p-3 bg-muted rounded-lg">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Total Database Capacity</div>
              <div className="text-xl font-bold">{Object.values(dbLimits).reduce((a, b) => a + b, 0)} positions</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Configuration Summary */}
      <Card>
        <CardHeader>
          <CardTitle>Configuration Summary</CardTitle>
          <CardDescription>Overview of current system configuration</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 border rounded-lg">
              <div className="text-xs text-muted-foreground mb-1">Trade Mode</div>
              <div className="font-medium">{settings.trade_mode || "Both"}</div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="text-xs text-muted-foreground mb-1">Market Timeframe</div>
              <div className="font-medium">{settings.marketDataTimeframe || "5m"}</div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="text-xs text-muted-foreground mb-1">Position Cost</div>
              <div className="font-medium">{settings.position_cost?.toFixed(2) || "0.05"}</div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="text-xs text-muted-foreground mb-1">Prehistoric Data</div>
              <div className="font-medium">{settings.days_of_prehistoric_data || 30} days</div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="text-xs text-muted-foreground mb-1">Risk Percentage</div>
              <div className="font-medium">{settings.risk_percentage || 15}%</div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="text-xs text-muted-foreground mb-1">Max Leverage</div>
              <div className="font-medium">
                {settings.use_maximal_leverage ? "Max" : `${settings.leverage_percentage || 50}%`}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Value Differences & Comparisons */}
      <Card>
        <CardHeader>
          <CardTitle>Performance Differences & Comparisons</CardTitle>
          <CardDescription>Relative differences between strategy configurations</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="p-3 border rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-medium">Base vs Main Profit Factor</div>
                <Badge variant={profitFactors.main >= profitFactors.base ? "default" : "secondary"}>
                  {((profitFactors.main - profitFactors.base) * 100).toFixed(1)}%
                  {profitFactors.main >= profitFactors.base ? " higher" : " lower"}
                </Badge>
              </div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-medium">Main vs Real Profit Factor</div>
                <Badge variant={profitFactors.real >= profitFactors.main ? "default" : "secondary"}>
                  {((profitFactors.real - profitFactors.main) * 100).toFixed(1)}%
                  {profitFactors.real >= profitFactors.main ? " higher" : " lower"}
                </Badge>
              </div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-medium">Database Size Distribution</div>
                <Badge variant="outline">
                  {Math.max(...Object.values(dbLimits)) - Math.min(...Object.values(dbLimits))} position variance
                </Badge>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
