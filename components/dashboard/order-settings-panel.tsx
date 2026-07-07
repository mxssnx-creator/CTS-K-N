"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Zap } from "lucide-react"

interface OrderSettingsPanelProps {
  orderType: "market" | "limit"
  marketSettings?: {
    slippageTolerance: number
    autoExecution: boolean
  }
  limitSettings?: {
    priceOffset: number
    timeoutSeconds: number
  }
  onMarketSettingsChange?: (settings: any) => void
  onLimitSettingsChange?: (settings: any) => void
}

export function OrderSettingsPanel({
  orderType,
  marketSettings = { slippageTolerance: 0.06, autoExecution: true },
  limitSettings = { priceOffset: 0.5, timeoutSeconds: 300 },
  onMarketSettingsChange,
  onLimitSettingsChange,
}: OrderSettingsPanelProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 px-1">
        <Zap className="h-4 w-4 text-orange-500" />
        <h3 className="text-sm font-semibold capitalize">{orderType} Order Settings</h3>
      </div>

      {orderType === "market" && (
        <div className="space-y-3 rounded-lg bg-slate-50 dark:bg-slate-900/30 p-4">
          <div className="space-y-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Slippage Tolerance</Label>
                <Badge variant="secondary" className="text-xs">
                  {marketSettings.slippageTolerance.toFixed(2)}%
                </Badge>
              </div>
              <Slider
                value={[marketSettings.slippageTolerance]}
                onValueChange={(value) =>
                  onMarketSettingsChange?.({ ...marketSettings, slippageTolerance: value[0] })
                }
                min={0.02}
                max={0.3}
                step={0.02}
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                Maximum price difference allowed from market price
              </p>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-sm font-medium">Auto-Execution</Label>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <div
                className={`h-3 w-3 rounded-full ${marketSettings.autoExecution ? "bg-green-500" : "bg-gray-400"}`}
              />
              {marketSettings.autoExecution ? "Enabled - Orders execute immediately" : "Disabled - Requires confirmation"}
            </div>
          </div>
        </div>
      )}

      {orderType === "limit" && (
        <div className="space-y-3 rounded-lg bg-slate-50 dark:bg-slate-900/30 p-4">
          <div className="space-y-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Price Offset</Label>
                <Badge variant="secondary" className="text-xs">
                  {limitSettings.priceOffset}%
                </Badge>
              </div>
              <Slider
                value={[limitSettings.priceOffset]}
                onValueChange={(value) =>
                  onLimitSettingsChange?.({ ...limitSettings, priceOffset: value[0] })
                }
                min={0.1}
                max={2}
                step={0.1}
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                Price offset from current market price for limit orders
              </p>
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Order Timeout</Label>
              <Badge variant="secondary" className="text-xs">
                {limitSettings.timeoutSeconds}s
              </Badge>
            </div>
            <Input
              type="number"
              value={limitSettings.timeoutSeconds}
              onChange={(e) =>
                onLimitSettingsChange?.({
                  ...limitSettings,
                  timeoutSeconds: parseInt(e.target.value),
                })
              }
              min={60}
              max={3600}
              step={60}
              className="text-sm"
              placeholder="Timeout in seconds"
            />
            <p className="text-xs text-muted-foreground">
              Cancel order if not filled within this time period
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
