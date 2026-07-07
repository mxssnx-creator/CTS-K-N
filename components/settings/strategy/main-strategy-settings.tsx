"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export default function MainStrategySettings({
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
          <CardTitle>Main Strategy Configuration</CardTitle>
          <CardDescription>
            Configure main-level strategy parameters that build upon base positions for active trading
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">Position Analysis Settings</h3>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Previous Positions Count</Label>
                <Input
                  type="number"
                  min="1"
                  max="20"
                  value={settings.strategyMainPreviousCount || 5}
                  onChange={(e) => handleSettingChange("strategyMainPreviousCount", Number.parseInt(e.target.value))}
                />
                <p className="text-xs text-muted-foreground">
                  Number of previous positions to analyze for strategy decisions (default: 5)
                </p>
              </div>

              <div className="space-y-2">
                <Label>Last State Count</Label>
                <Select
                  value={settings.strategyMainLastStateCount || "last3"}
                  onValueChange={(value) => handleSettingChange("strategyMainLastStateCount", value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="last1">Last 1</SelectItem>
                    <SelectItem value="last2">Last 2</SelectItem>
                    <SelectItem value="last3">Last 3</SelectItem>
                    <SelectItem value="last5">Last 5</SelectItem>
                    <SelectItem value="last10">Last 10</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  How many recent states to consider for strategy evaluation (default: last3)
                </p>
              </div>
            </div>
          </div>

          <div className="border-t pt-6 space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">Max Pseudo Positions (Per Configuration)</h3>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Max Pseudo Positions (Long)</Label>
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={settings.strategyMainMaxPseudoPositionsLong || 1}
                  onChange={(e) =>
                    handleSettingChange("strategyMainMaxPseudoPositionsLong", Number.parseInt(e.target.value))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Maximum pseudo positions allowed for long entries per configuration set (default: 1)
                </p>
              </div>

              <div className="space-y-2">
                <Label>Max Pseudo Positions (Short)</Label>
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={settings.strategyMainMaxPseudoPositionsShort || 1}
                  onChange={(e) =>
                    handleSettingChange("strategyMainMaxPseudoPositionsShort", Number.parseInt(e.target.value))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Maximum pseudo positions allowed for short entries per configuration set (default: 1)
                </p>
              </div>
            </div>

            <div className="p-3 bg-blue-50 border border-blue-200 rounded text-xs text-blue-800">
              <p className="font-semibold mb-1">About Max Pseudo Positions:</p>
              <p>
                Each configuration possibility set (base, main, real) can independently open up to the specified number of
                pseudo positions in each direction. Setting both to 1 means each set can have at most 1 long and 1 short
                position simultaneously, providing controlled risk management.
              </p>
            </div>
          </div>

          <div className="border-t pt-6 space-y-4">
            <h3 className="text-lg font-semibold border-b pb-2">Adjustment Controls</h3>

            <div className="grid gap-4">
              <div className="flex items-center justify-between p-3 border rounded-lg bg-card">
                <div>
                  <Label className="text-base">Ongoing Trailing</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Enable trailing stop loss for ongoing main strategy positions
                  </p>
                </div>
                <Switch
                  checked={settings.strategyMainOngoingTrailing !== false}
                  onCheckedChange={(checked) => handleSettingChange("strategyMainOngoingTrailing", checked)}
                />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg bg-card">
                <div>
                  <Label className="text-base">Block Adjustment</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Enable block strategy adjustments for main positions
                  </p>
                </div>
                <Switch
                  checked={settings.strategyMainBlockAdjustment === true}
                  onCheckedChange={(checked) => handleSettingChange("strategyMainBlockAdjustment", checked)}
                />
              </div>

              <div className="flex items-center justify-between p-3 border rounded-lg bg-card">
                <div>
                  <Label className="text-base">DCA Adjustment</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Enable Dollar Cost Averaging adjustments for main positions
                  </p>
                </div>
                <Switch
                  checked={settings.strategyMainDcaAdjustment === true}
                  onCheckedChange={(checked) => handleSettingChange("strategyMainDcaAdjustment", checked)}
                />
              </div>
            </div>
          </div>

          <div className="p-4 bg-muted rounded-lg space-y-3">
            <h4 className="text-sm font-semibold">Main Strategy Overview</h4>
            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                The Main Strategy builds upon Base positions to create actively managed trading positions. It analyzes
                recent performance and market conditions to determine optimal entry and exit points.
              </p>
              <p>
                Previous positions analysis helps identify successful patterns, while last state count determines how
                much recent history influences decisions.
              </p>
              <p>
                Ongoing trailing protects profits on active positions. Block and DCA adjustments provide additional
                flexibility for different market conditions.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
