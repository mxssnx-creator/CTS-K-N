"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"

export default function RealStrategySettings({
  settings,
  handleSettingChange,
}: {
  settings: any
  handleSettingChange: (key: string, value: any) => void
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Real Strategy Configuration</CardTitle>
          <CardDescription>
            Configure real-time trading strategy parameters for live position execution and management
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">Real-Time Execution Settings</h3>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Real Trade Interval (seconds)</Label>
                <Slider
                  min={1}
                  max={10}
                  step={1}
                  value={[settings.strategyRealTradeInterval || 1]}
                  onValueChange={([value]) => handleSettingChange("strategyRealTradeInterval", value)}
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>1s</span>
                  <span className="font-medium">{settings.strategyRealTradeInterval || 1}s</span>
                  <span>10s</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Execution interval for real-time trading decisions (default: 1 second)
                </p>
              </div>

              <div className="space-y-2">
                <Label>Real Positions Interval (seconds)</Label>
                <Slider
                  min={0.1}
                  max={5}
                  step={0.1}
                  value={[settings.strategyRealPositionsInterval || 0.3]}
                  onValueChange={([value]) => handleSettingChange("strategyRealPositionsInterval", value)}
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>0.1s</span>
                  <span className="font-medium">{settings.strategyRealPositionsInterval || 0.3}s</span>
                  <span>5s</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Position monitoring interval for real strategy (default: 0.3 seconds)
                </p>
              </div>
            </div>
          </div>

          <div className="border-t pt-6 space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">Position Management</h3>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Max Real Positions</Label>
                <Input
                  type="number"
                  min="10"
                  max="500"
                  value={settings.strategyRealMaxPositions || 100}
                  onChange={(e) => handleSettingChange("strategyRealMaxPositions", Number.parseInt(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">
                  Maximum number of concurrent real strategy positions (default: 100)
                </p>
              </div>

              <div className="space-y-2">
                <Label>Position Cooldown (seconds)</Label>
                <Input
                  type="number"
                  min="1"
                  max="300"
                  value={settings.strategyRealPositionCooldown || 20}
                  onChange={(e) => handleSettingChange("strategyRealPositionCooldown", Number.parseInt(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">
                  Cooldown period between real position entries for the same symbol (default: 20)
                </p>
              </div>
            </div>
          </div>

          <div className="border-t pt-6 space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">Real Strategy Features</h3>

            <div className="grid gap-4">
              <div className="flex items-center justify-between p-3 border rounded-lg bg-card">
                <div>
                  <Label className="text-base">Real Trailing Enabled</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Enable trailing stop loss for real-time positions
                  </p>
                </div>
                <Switch
                  checked={settings.strategyRealTrailing !== false}
                  onCheckedChange={(checked) => handleSettingChange("strategyRealTrailing", checked)}
                />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg bg-card">
                <div>
                  <Label className="text-base">Auto Position Sizing</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Automatically adjust position sizes based on account balance and risk
                  </p>
                </div>
                <Switch
                  checked={settings.strategyRealAutoSizing !== false}
                  onCheckedChange={(checked) => handleSettingChange("strategyRealAutoSizing", checked)}
                />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg bg-card">
                <div>
                  <Label className="text-base">Fast Execution Mode</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Prioritize execution speed over additional validation checks
                  </p>
                </div>
                <Switch
                  checked={settings.strategyRealFastMode === true}
                  onCheckedChange={(checked) => handleSettingChange("strategyRealFastMode", checked)}
                />
              </div>
            </div>
          </div>

          <div className="border-t pt-6 space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">Risk Management</h3>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Real Min Profit Factor</Label>
                <Input
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={settings.strategyRealMinProfitFactor || 0.6}
                  onChange={(e) =>
                    handleSettingChange("strategyRealMinProfitFactor", Number.parseFloat(e.target.value))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Minimum profit factor for real strategy execution (default: 0.6)
                </p>
              </div>

              <div className="space-y-2">
                <Label>Max Drawdown Hours</Label>
                <Input
                  type="number"
                  min="1"
                  max="100"
                  value={settings.strategyRealMaxDrawdownHours || 12}
                  onChange={(e) => handleSettingChange("strategyRealMaxDrawdownHours", Number.parseInt(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">
                  Maximum allowed drawdown duration for real positions (default: 12 hours)
                </p>
              </div>
            </div>
          </div>

          <div className="p-4 bg-muted rounded-lg space-y-3">
            <h4 className="text-sm font-semibold">Real Strategy Overview</h4>
            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                The Real Strategy executes live trades based on Main strategy analysis and real-time market data. It
                operates at faster intervals for responsive trading.
              </p>
              <p>
                Position management limits prevent over-exposure, while cooldown periods ensure proper spacing between
                entries for the same symbol.
              </p>
              <p>
                Fast execution mode reduces latency for time-sensitive opportunities, while risk management parameters
                ensure controlled exposure.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
