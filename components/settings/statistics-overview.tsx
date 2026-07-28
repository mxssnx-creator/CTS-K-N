"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { calculateIndicationConfigurationCounts } from "@/lib/indication-configuration-counts"
import {
  MAIN_TRADE_BASE_PF_RATIO_DEFAULT,
  MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT,
} from "@/lib/main-trade-profit-factor"

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

  const indicationCounts = calculateIndicationConfigurationCounts(settings, undefined)

  const calculateProfitFactorDistribution = () => {
    // ── Main Trade PositionCost-ratio thresholds ───────────────────────
    // `live` was added alongside base/main/real per spec — the four
    // Main-Trade stages are gated independently from the Strategies
    // tab. Preset stays distinct (separate engine, separate threshold
    // at `presetProfitFactor`). Fallback values match the engine's
    // own fallbacks so the overview reflects exactly what the engine
    // gates with when settings haven't loaded yet.
    return {
      base: Number(settings.baseProfitFactor ?? MAIN_TRADE_BASE_PF_RATIO_DEFAULT),
      main: Number(settings.mainProfitFactor ?? MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT),
      real: Number(settings.realProfitFactor ?? MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT),
      live: Number(settings.liveProfitFactor ?? MAIN_TRADE_DOWNSTREAM_PF_RATIO_DEFAULT),
      preset: Number(settings.profitFactorMinPreset ?? settings.presetProfitFactor ?? 0.7),
    }
  }

  const calculateIntervalStatistics = () => {
    return {
      mainEngineMs: Number(settings.mainEngineIntervalMs ?? 100),
      presetEngineMs: Number(settings.presetEngineIntervalMs ?? 100),
      activeOrderHandlingMs: Number(settings.activeOrderHandlingIntervalMs ?? 50),
      indicationLaneMs: Number(settings.indicationTimeoutMs ?? 250),
      commonLaneMs: 1_000,
      baseReentryMs: Number(settings.positionCooldownMs ?? 3_000),
    }
  }

  const calculateDatabaseLimits = () => {
    return {
      base: Number(settings.databaseSizeBase ?? 250),
      main: Number(settings.databaseSizeMain ?? 250),
      real: Number(settings.databaseSizeReal ?? 250),
      preset: Number(settings.databaseSizePreset ?? 250),
    }
  }

  const profitFactors = calculateProfitFactorDistribution()
  const intervals = calculateIntervalStatistics()
  const dbLimits = calculateDatabaseLimits()

  return (
    <div className="space-y-4">
      {/* Indication Ratios & Ranges */}
      <Card>
        <CardHeader>
          <CardTitle>Indication Configuration Coverage</CardTitle>
          <CardDescription>Exhaustive enabled configuration space; concurrency never truncates it</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {indicationCounts.types.map((type) => (
              <div key={type.type} className="rounded-lg border p-3">
                <div className="text-sm font-medium capitalize">{type.type.replace("_", " ")}</div>
                <div className="mt-1 text-2xl font-bold tabular-nums">
                  {type.possibleSets.toLocaleString()}
                </div>
                <div className="text-xs text-muted-foreground">
                  {type.evaluationConfigurations.toLocaleString()} evaluation configs
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-lg bg-muted p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Total independent Long/Short Sets</span>
              <span className="text-xl font-bold tabular-nums">
                {indicationCounts.totalPossibleSets.toLocaleString()}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Profit Factor Requirements */}
      <Card>
        <CardHeader>
          <CardTitle>PositionCost-relative PF Ratios</CardTitle>
          <CardDescription>Ratio 0.10 equals one PositionCost; these are not classic gross-profit/gross-loss PF labels</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            {Object.entries(profitFactors).map(([type, value]) => (
              <div key={type} className="flex items-center justify-between p-3 border rounded-lg">
                <div>
                  <div className="font-medium capitalize">{type} Strategy</div>
                  <div className="text-2xl font-bold mt-1">{value.toFixed(2)}</div>
                </div>
                <Badge variant="outline">
                  {(value / 0.1).toFixed(1)}× PositionCost
                </Badge>
              </div>
            ))}
          </div>
          <div className="mt-4 p-3 bg-muted rounded-lg">
            <div className="text-sm font-medium mb-2">PositionCost</div>
            <div className="text-2xl font-bold">
              {Number(settings.positionCost ?? 0.1).toFixed(2)}%
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
                  <Badge variant="outline">{value} ms</Badge>
                  <div className="text-xs text-muted-foreground">
                    {value >= 200 ? "Standard" : value >= 100 ? "Fast" : "Very Fast"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Database retention */}
      <Card>
        <CardHeader>
          <CardTitle>Per-Set History Retention</CardTitle>
          <CardDescription>Bounded audit/history rows; never a configuration or active-position ceiling</CardDescription>
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
                <div className="text-xs text-muted-foreground">retained entries per exact Set</div>
              </div>
            ))}
          </div>
          <div className="mt-4 p-3 bg-muted rounded-lg">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Configured retention sum</div>
              <div className="text-xl font-bold">{Object.values(dbLimits).reduce((a, b) => a + b, 0)} entries</div>
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
              <div className="font-medium">{settings.trade_mode ?? "Main + Signal independently"}</div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="text-xs text-muted-foreground mb-1">Market Timeframe</div>
              <div className="font-medium">{settings.marketTimeframe ?? 1}m</div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="text-xs text-muted-foreground mb-1">Position Cost</div>
              <div className="font-medium">{Number(settings.positionCost ?? 0.1).toFixed(2)}%</div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="text-xs text-muted-foreground mb-1">Prehistoric Data</div>
              <div className="font-medium">{settings.prehistoric_range_hours ?? 8} hours</div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="text-xs text-muted-foreground mb-1">Main / Real Lookbacks</div>
              <div className="font-medium">{settings.mainEvalPosCount ?? 25} / {settings.realEvalPosCount ?? 20}</div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="text-xs text-muted-foreground mb-1">Max Leverage</div>
              <div className="font-medium">
                {settings.useMaximalLeverage ? "Exchange maximum" : `${settings.leveragePercentage ?? 100}%`}
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
                  {(profitFactors.main - profitFactors.base).toFixed(2)} ratio
                </Badge>
              </div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-medium">Main vs Real Profit Factor</div>
                <Badge variant={profitFactors.real >= profitFactors.main ? "default" : "secondary"}>
                  {(profitFactors.real - profitFactors.main).toFixed(2)} ratio
                </Badge>
              </div>
            </div>
            <div className="p-3 border rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-medium">Database Size Distribution</div>
                <Badge variant="outline">
                  {Math.max(...Object.values(dbLimits)) - Math.min(...Object.values(dbLimits))} entry variance
                </Badge>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
