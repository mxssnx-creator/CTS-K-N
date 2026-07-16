"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

const TREND_TIMEFRAMES = [1, 3, 5, 10, 15, 30]

interface IndicationTabProps {
  settings: any
  handleSettingChange: (key: string, value: any) => void
  getMinIndicationInterval: () => number
}

export function IndicationTab({ settings, handleSettingChange, getMinIndicationInterval }: IndicationTabProps) {
  const [indicationSubTab, setIndicationSubTab] = useState("main")
  const [indicationMainSubTab, setIndicationMainSubTab] = useState("main")

  // Safety check for undefined settings
  if (!settings) {
    return <div>Loading settings...</div>
  }

  const numericListValue = (value: unknown, fallback: number[]) =>
    Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : fallback.join(", ")
  const trendTimeframeValues: unknown[] = Array.isArray(settings.trendTimeframesMinutes)
    ? settings.trendTimeframesMinutes
    : String(settings.trendTimeframesMinutes || "1,3,5,10,15,30").split(",")
  const selectedTrendTimeframes = new Set<number>(
    trendTimeframeValues
      .map((value) => Number(value))
      .filter((value): value is number => Number.isFinite(value)),
  )
  const toggleTrendTimeframe = (minutes: number, enabled: boolean) => {
    const next = new Set(selectedTrendTimeframes)
    if (enabled) next.add(minutes)
    else if (next.size > 1) next.delete(minutes)
    handleSettingChange("trendTimeframesMinutes", Array.from(next).sort((left, right) => left - right))
  }

  return (
    <Tabs value={indicationSubTab} onValueChange={setIndicationSubTab}>
      <TabsList>
        <TabsTrigger value="main">Main</TabsTrigger>
        <TabsTrigger value="common">Common</TabsTrigger>
      </TabsList>

      <TabsContent value="main" className="space-y-4">
        <Tabs value={indicationMainSubTab} onValueChange={setIndicationMainSubTab}>
          <TabsList className="h-auto w-full flex-wrap justify-start">
            <TabsTrigger value="main">Main (Direction/Move/Active)</TabsTrigger>
            <TabsTrigger value="optimal">Optimal</TabsTrigger>
            <TabsTrigger value="auto">Auto</TabsTrigger>
            <TabsTrigger value="trend">Trend</TabsTrigger>
          </TabsList>

          <TabsContent value="main" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Main Indication Settings</CardTitle>
                <CardDescription>Configure Direction, Move, and Active indication parameters</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Market Activity Configuration */}
                <div className="space-y-4 border-b pb-4">
                  <h3 className="text-lg font-semibold">Market Activity</h3>
                  <div className="flex items-center justify-between">
                    <Label>Enable Market Activity Monitoring</Label>
                    <Switch
                      checked={settings.marketActivityEnabled !== false}
                      onCheckedChange={(checked) => handleSettingChange("marketActivityEnabled", checked)}
                    />
                  </div>

                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Calculation Range (5-20 sec)</Label>
                      <Slider
                        min={5}
                        max={20}
                        step={1}
                        value={[settings.marketActivityCalculationRange || 10]}
                        onValueChange={([value]) => handleSettingChange("marketActivityCalculationRange", value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Current: {settings.marketActivityCalculationRange || 10}s
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Active Factor (1-20)</Label>
                      <Slider
                        min={1}
                        max={20}
                        step={1}
                        value={[settings.marketActivityPositionCostRatio || 2]}
                        onValueChange={([value]) => handleSettingChange("marketActivityPositionCostRatio", value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Current: {settings.marketActivityPositionCostRatio || 2}
                      </p>
                      <p className="text-xs text-blue-600 dark:text-blue-400">
                        Calculation: Active Factor = Position Cost × Market Activity × Volume Ratio. Higher values
                        increase position sensitivity to market movements.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Direction Indication */}
                <div className="space-y-4 border-b pb-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold">Direction Indication</h3>
                    <Switch
                      checked={settings.directionEnabled !== false}
                      onCheckedChange={(checked) => handleSettingChange("directionEnabled", checked)}
                    />
                  </div>

                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Interval ({getMinIndicationInterval()}-1000ms, step 50ms)</Label>
                      <Slider
                        min={getMinIndicationInterval()}
                        max={1000}
                        step={50}
                        value={[Math.max(settings.directionInterval || 100, getMinIndicationInterval())]}
                        onValueChange={([value]) => handleSettingChange("directionInterval", value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Current: {settings.directionInterval || 100}ms (Min: {getMinIndicationInterval()}ms based on Main
                        Engine)
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Timeout (0-10 sec, step 1 sec)</Label>
                      <Slider
                        min={0}
                        max={10}
                        step={1}
                        value={[settings.directionTimeout || 0]}
                        onValueChange={([value]) => handleSettingChange("directionTimeout", value)}
                      />
                      <p className="text-xs text-muted-foreground">Current: {settings.directionTimeout || 0}s</p>
                    </div>

                    <div className="space-y-2">
                      <Label>Price Diff Factor (0.5-20, step 0.5)</Label>
                      <Slider
                        min={0.5}
                        max={20}
                        step={0.5}
                        value={[settings.directionPriceDiffFactor || 2]}
                        onValueChange={([value]) => handleSettingChange("directionPriceDiffFactor", value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Current: {settings.directionPriceDiffFactor || 2}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Time Factor (0.5-20, step 0.5)</Label>
                      <Slider
                        min={0.5}
                        max={20}
                        step={0.5}
                        value={[settings.directionTimeFactor || 1.5]}
                        onValueChange={([value]) => handleSettingChange("directionTimeFactor", value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Current: {settings.directionTimeFactor || 1.5}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Move Indication */}
                <div className="space-y-4 border-b pb-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold">Move Indication</h3>
                    <Switch
                      checked={settings.moveEnabled !== false}
                      onCheckedChange={(checked) => handleSettingChange("moveEnabled", checked)}
                    />
                  </div>

                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Interval ({getMinIndicationInterval()}-1000ms, step 50ms)</Label>
                      <Slider
                        min={getMinIndicationInterval()}
                        max={1000}
                        step={50}
                        value={[Math.max(settings.moveInterval || 100, getMinIndicationInterval())]}
                        onValueChange={([value]) => handleSettingChange("moveInterval", value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Current: {settings.moveInterval || 100}ms (Min: {getMinIndicationInterval()}ms based on Main
                        Engine)
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Timeout (0-10 sec, step 1 sec)</Label>
                      <Slider
                        min={0}
                        max={10}
                        step={1}
                        value={[settings.moveTimeout || 0]}
                        onValueChange={([value]) => handleSettingChange("moveTimeout", value)}
                      />
                      <p className="text-xs text-muted-foreground">Current: {settings.moveTimeout || 0}s</p>
                    </div>

                    <div className="space-y-2">
                      <Label>Move Threshold (0-5%, step 0.1%)</Label>
                      <Slider
                        min={0}
                        max={5}
                        step={0.1}
                        value={[settings.moveThreshold || 0.15]}
                        onValueChange={([value]) => handleSettingChange("moveThreshold", value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Current: {(settings.moveThreshold || 0.15).toFixed(2)}%
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Trailing Range Time (sec) (5-600)</Label>
                      <Slider
                        min={5}
                        max={600}
                        step={5}
                        value={[settings.moveTrailingRangeTime || 60]}
                        onValueChange={([value]) => handleSettingChange("moveTrailingRangeTime", value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Current: {settings.moveTrailingRangeTime || 60}s
                      </p>
                    </div>
                  </div>
                </div>

                {/* Active Indication */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold">Active Indication</h3>
                    <Switch
                      checked={settings.activeEnabled !== false}
                      onCheckedChange={(checked) => handleSettingChange("activeEnabled", checked)}
                    />
                  </div>

                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Interval ({getMinIndicationInterval()}-1000ms, step 50ms)</Label>
                      <Slider
                        min={getMinIndicationInterval()}
                        max={1000}
                        step={50}
                        value={[Math.max(settings.activeInterval || 100, getMinIndicationInterval())]}
                        onValueChange={([value]) => handleSettingChange("activeInterval", value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Current: {settings.activeInterval || 100}ms (Min: {getMinIndicationInterval()}ms based on Main
                        Engine)
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Timeout (0-10 sec, step 1 sec)</Label>
                      <Slider
                        min={0}
                        max={10}
                        step={1}
                        value={[settings.activeTimeout || 0]}
                        onValueChange={([value]) => handleSettingChange("activeTimeout", value)}
                      />
                      <p className="text-xs text-muted-foreground">Current: {settings.activeTimeout || 0}s</p>
                    </div>

                    <div className="space-y-2">
                      <Label>Active Threshold (0-5%, step 0.1%)</Label>
                      <Slider
                        min={0}
                        max={5}
                        step={0.1}
                        value={[settings.activeThreshold || 0.1]}
                        onValueChange={([value]) => handleSettingChange("activeThreshold", value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Current: {(settings.activeThreshold || 0.1).toFixed(2)}%
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Noise Filter (0-1%, step 0.01%)</Label>
                      <Slider
                        min={0}
                        max={1}
                        step={0.01}
                        value={[settings.activeNoiseFilter || 0.05]}
                        onValueChange={([value]) => handleSettingChange("activeNoiseFilter", value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Current: {(settings.activeNoiseFilter || 0.05).toFixed(2)}%
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Momentum Window (sec) (1-60)</Label>
                      <Slider
                        min={1}
                        max={60}
                        step={1}
                        value={[settings.activeMomentumWindow || 10]}
                        onValueChange={([value]) => handleSettingChange("activeMomentumWindow", value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Current: {settings.activeMomentumWindow || 10}s
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label>Volatility Weight (0-1, step 0.1)</Label>
                      <Slider
                        min={0}
                        max={1}
                        step={0.1}
                        value={[settings.activeVolatilityWeight || 0.3]}
                        onValueChange={([value]) => handleSettingChange("activeVolatilityWeight", value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Current: {(settings.activeVolatilityWeight || 0.3).toFixed(1)}
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="optimal" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Optimal Indication Settings</CardTitle>
                <CardDescription>Configure optimal indication parameters for entry/exit optimization</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Enable Optimal Indication</Label>
                    <p className="text-xs text-muted-foreground">
                      Use optimal timing for entries and exits based on market conditions
                    </p>
                  </div>
                  <Switch
                    checked={settings.optimalEnabled !== false}
                    onCheckedChange={(checked) => handleSettingChange("optimalEnabled", checked)}
                  />
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Interval ({getMinIndicationInterval()}-1000ms, step 50ms)</Label>
                    <Slider
                      min={getMinIndicationInterval()}
                      max={1000}
                      step={50}
                      value={[Math.max(settings.optimalInterval || 200, getMinIndicationInterval())]}
                      onValueChange={([value]) => handleSettingChange("optimalInterval", value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Current: {settings.optimalInterval || 200}ms (Min: {getMinIndicationInterval()}ms based on Main
                      Engine)
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>Timeout (0-10 sec, step 1 sec)</Label>
                    <Slider
                      min={0}
                      max={10}
                      step={1}
                      value={[settings.optimalTimeout || 0]}
                      onValueChange={([value]) => handleSettingChange("optimalTimeout", value)}
                    />
                    <p className="text-xs text-muted-foreground">Current: {settings.optimalTimeout || 0}s</p>
                  </div>

                  <div className="space-y-2">
                    <Label>Lookback Period (sec) (10-300)</Label>
                    <Slider
                      min={10}
                      max={300}
                      step={10}
                      value={[settings.optimalLookbackPeriod || 60]}
                      onValueChange={([value]) => handleSettingChange("optimalLookbackPeriod", value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Current: {settings.optimalLookbackPeriod || 60}s
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>Confidence Threshold (0.5-1.0, step 0.05)</Label>
                    <Slider
                      min={0.5}
                      max={1.0}
                      step={0.05}
                      value={[settings.optimalConfidenceThreshold || 0.7]}
                      onValueChange={([value]) => handleSettingChange("optimalConfidenceThreshold", value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Current: {(settings.optimalConfidenceThreshold || 0.7).toFixed(2)}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>Risk Factor (0.1-2.0, step 0.1)</Label>
                    <Slider
                      min={0.1}
                      max={2.0}
                      step={0.1}
                      value={[settings.optimalRiskFactor || 1.0]}
                      onValueChange={([value]) => handleSettingChange("optimalRiskFactor", value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Current: {(settings.optimalRiskFactor || 1.0).toFixed(1)}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>Reward Factor (0.1-3.0, step 0.1)</Label>
                    <Slider
                      min={0.1}
                      max={3.0}
                      step={0.1}
                      value={[settings.optimalRewardFactor || 1.5]}
                      onValueChange={([value]) => handleSettingChange("optimalRewardFactor", value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Current: {(settings.optimalRewardFactor || 1.5).toFixed(1)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="auto" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Auto Indication Settings</CardTitle>
                <CardDescription>Configure automatic indication adjustment parameters</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Enable Auto Indication</Label>
                    <p className="text-xs text-muted-foreground">
                      Automatically adjust indication parameters based on market conditions
                    </p>
                  </div>
                  <Switch
                    checked={settings.autoEnabled !== false}
                    onCheckedChange={(checked) => handleSettingChange("autoEnabled", checked)}
                  />
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Interval ({getMinIndicationInterval()}-2000ms, step 100ms)</Label>
                    <Slider
                      min={getMinIndicationInterval()}
                      max={2000}
                      step={100}
                      value={[Math.max(settings.autoInterval || 500, getMinIndicationInterval())]}
                      onValueChange={([value]) => handleSettingChange("autoInterval", value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Current: {settings.autoInterval || 500}ms (Min: {getMinIndicationInterval()}ms based on Main
                      Engine)
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>Adjustment Speed (0.1-1.0, step 0.1)</Label>
                    <Slider
                      min={0.1}
                      max={1.0}
                      step={0.1}
                      value={[settings.autoAdjustmentSpeed || 0.5]}
                      onValueChange={([value]) => handleSettingChange("autoAdjustmentSpeed", value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Current: {(settings.autoAdjustmentSpeed || 0.5).toFixed(1)}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>Min Adjustment Interval (sec) (60-3600)</Label>
                    <Slider
                      min={60}
                      max={3600}
                      step={60}
                      value={[settings.autoMinAdjustmentInterval || 300]}
                      onValueChange={([value]) => handleSettingChange("autoMinAdjustmentInterval", value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Current: {settings.autoMinAdjustmentInterval || 300}s
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>Max Parameter Change (%) (5-50)</Label>
                    <Slider
                      min={5}
                      max={50}
                      step={5}
                      value={[settings.autoMaxParameterChange || 20]}
                      onValueChange={([value]) => handleSettingChange("autoMaxParameterChange", value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Current: {settings.autoMaxParameterChange || 20}%
                    </p>
                  </div>

                  <div className="flex items-center justify-between p-3 border rounded-lg col-span-2">
                    <div>
                      <Label>Learning Mode</Label>
                      <p className="text-xs text-muted-foreground">
                        Enable machine learning for parameter optimization
                      </p>
                    </div>
                    <Switch
                      checked={settings.autoLearningMode !== false}
                      onCheckedChange={(checked) => handleSettingChange("autoLearningMode", checked)}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="trend" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Trend Indication Settings</CardTitle>
                <CardDescription>
                  Coordinate multi-window trend, drawdown, recent and active market situations in independent Sets
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Enable Trend Indication</Label>
                    <p className="text-xs text-muted-foreground">
                      Runs Trend as the final Main indication type
                    </p>
                  </div>
                  <Switch
                    checked={settings.trendEnabled !== false}
                    onCheckedChange={(checked) => handleSettingChange("trendEnabled", checked)}
                  />
                </div>

                <div className="space-y-3">
                  <div>
                    <Label>Calculation windows</Label>
                    <p className="text-xs text-muted-foreground">
                      Each enabled one-minute candle window creates independent Trend configurations
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    {TREND_TIMEFRAMES.map((minutes) => (
                      <div key={minutes} className="flex items-center justify-between rounded-lg border p-3">
                        <Label>{minutes} min</Label>
                        <Switch
                          checked={selectedTrendTimeframes.has(minutes)}
                          onCheckedChange={(checked) => toggleTrendTimeframe(minutes, checked)}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label>Negative drawdown factors</Label>
                    <Input
                      value={numericListValue(settings.trendDrawdownValues, [-1, -2, -3])}
                      onChange={(event) => handleSettingChange("trendDrawdownValues", event.target.value)}
                      placeholder="-1, -2, -3"
                    />
                    <p className="text-xs text-muted-foreground">Negative PositionCost multiples, one Set per value</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Last-situation ratios</Label>
                    <Input
                      value={numericListValue(settings.trendLastSituationRatios, [0.5, 1])}
                      onChange={(event) => handleSettingChange("trendLastSituationRatios", event.target.value)}
                      placeholder="0.5, 1"
                    />
                    <p className="text-xs text-muted-foreground">Required recent per-minute strength vs. 1m average</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Active-situation ratios</Label>
                    <Input
                      value={numericListValue(settings.trendActiveSituationRatios, [0.5, 1])}
                      onChange={(event) => handleSettingChange("trendActiveSituationRatios", event.target.value)}
                      placeholder="0.5, 1"
                    />
                    <p className="text-xs text-muted-foreground">Required last market change vs. 1m average</p>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Minimum directional agreement (50-100%)</Label>
                    <Slider
                      min={0.5}
                      max={1}
                      step={0.05}
                      value={[settings.trendMinAgreement ?? 0.6]}
                      onValueChange={([value]) => handleSettingChange("trendMinAgreement", value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Current: {Math.round((settings.trendMinAgreement ?? 0.6) * 100)}%
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Trend Set database size (50-750)</Label>
                    <Slider
                      min={50}
                      max={750}
                      step={50}
                      value={[settings.databaseSizeTrend ?? 250]}
                      onValueChange={([value]) => handleSettingChange("databaseSizeTrend", value)}
                    />
                    <p className="text-xs text-muted-foreground">Current: {settings.databaseSizeTrend ?? 250} per Set</p>
                  </div>
                </div>

                <div className="space-y-4 rounded-lg border p-4">
                  <div>
                    <Label>Adaptive Base pseudo-position TP range</Label>
                    <p className="text-xs text-muted-foreground">
                      Minimum = average absolute 1m market change ÷ PositionCost × multiplier; maximum and step bound the ladder
                    </p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-3">
                    <div className="space-y-2">
                      <Label>Minimum multiplier (default ×2)</Label>
                      <Slider
                        min={0.5}
                        max={5}
                        step={0.5}
                        value={[settings.trendTpMinMultiplier ?? 2]}
                        onValueChange={([value]) => handleSettingChange("trendTpMinMultiplier", value)}
                      />
                      <p className="text-xs text-muted-foreground">Current: ×{settings.trendTpMinMultiplier ?? 2}</p>
                    </div>
                    <div className="space-y-2">
                      <Label>Maximum TP factor</Label>
                      <Slider
                        min={2}
                        max={22}
                        step={1}
                        value={[settings.trendTpMaxFactor ?? 10]}
                        onValueChange={([value]) => handleSettingChange("trendTpMaxFactor", value)}
                      />
                      <p className="text-xs text-muted-foreground">Current: {settings.trendTpMaxFactor ?? 10}</p>
                    </div>
                    <div className="space-y-2">
                      <Label>TP factor step</Label>
                      <Slider
                        min={0.25}
                        max={5}
                        step={0.25}
                        value={[settings.trendTpStep ?? 1]}
                        onValueChange={([value]) => handleSettingChange("trendTpStep", value)}
                      />
                      <p className="text-xs text-muted-foreground">Current: {settings.trendTpStep ?? 1}</p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Example: 1m average / PositionCost = 3, multiplier ×2 → minimum 6; max 10 and step 1 → 6, 7, 8, 9, 10.
                  </p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </TabsContent>

      <TabsContent value="common" className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Common Indication Settings</CardTitle>
            <CardDescription>Shared parameters across all indication types</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Default Interval ({getMinIndicationInterval()}-1000ms, step 50ms)</Label>
                <Slider
                  min={getMinIndicationInterval()}
                  max={1000}
                  step={50}
                  value={[Math.max(settings.defaultIndicationInterval || 100, getMinIndicationInterval())]}
                  onValueChange={([value]) => handleSettingChange("defaultIndicationInterval", value)}
                />
                <p className="text-xs text-muted-foreground">
                  Current: {settings.defaultIndicationInterval || 100}ms (Min: {getMinIndicationInterval()}ms based on
                  Main Engine)
                </p>
              </div>

              <div className="space-y-2">
                <Label>Default Timeout (0-10 sec, step 1 sec)</Label>
                <Slider
                  min={0}
                  max={10}
                  step={1}
                  value={[settings.defaultIndicationTimeout || 0]}
                  onValueChange={([value]) => handleSettingChange("defaultIndicationTimeout", value)}
                />
                <p className="text-xs text-muted-foreground">
                  Current: {settings.defaultIndicationTimeout || 0}s
                </p>
              </div>

              <div className="space-y-2">
                <Label>Max Concurrent Indications (1-100)</Label>
                <Slider
                  min={1}
                  max={100}
                  step={1}
                  value={[settings.maxConcurrentIndications || 50]}
                  onValueChange={([value]) => handleSettingChange("maxConcurrentIndications", value)}
                />
                <p className="text-xs text-muted-foreground">
                  Current: {settings.maxConcurrentIndications || 50}
                </p>
              </div>

              <div className="space-y-2">
                <Label>State Retention (hours) (1-168)</Label>
                <Slider
                  min={1}
                  max={168}
                  step={1}
                  value={[settings.indicationStateRetention || 48]}
                  onValueChange={([value]) => handleSettingChange("indicationStateRetention", value)}
                />
                <p className="text-xs text-muted-foreground">
                  Current: {settings.indicationStateRetention || 48}h
                </p>
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg col-span-2">
                <div>
                  <Label>Enable State Logging</Label>
                  <p className="text-xs text-muted-foreground">Log indication state changes for debugging</p>
                </div>
                <Switch
                  checked={settings.indicationStateLogging !== false}
                  onCheckedChange={(checked) => handleSettingChange("indicationStateLogging", checked)}
                />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg col-span-2">
                <div>
                  <Label>Enable Performance Monitoring</Label>
                  <p className="text-xs text-muted-foreground">
                    Track indication performance metrics and statistics
                  </p>
                </div>
                <Switch
                  checked={settings.indicationPerformanceMonitoring !== false}
                  onCheckedChange={(checked) => handleSettingChange("indicationPerformanceMonitoring", checked)}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}
