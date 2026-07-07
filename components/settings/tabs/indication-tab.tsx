"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

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

  return (
    <Tabs value={indicationSubTab} onValueChange={setIndicationSubTab}>
      <TabsList>
        <TabsTrigger value="main">Main</TabsTrigger>
        <TabsTrigger value="common">Common</TabsTrigger>
      </TabsList>

      <TabsContent value="main" className="space-y-4">
        <Tabs value={indicationMainSubTab} onValueChange={setIndicationMainSubTab}>
          <TabsList>
            <TabsTrigger value="main">Main (Direction/Move/Active)</TabsTrigger>
            <TabsTrigger value="optimal">Optimal</TabsTrigger>
            <TabsTrigger value="auto">Auto</TabsTrigger>
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
