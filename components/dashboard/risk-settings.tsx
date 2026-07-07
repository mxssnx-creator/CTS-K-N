"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Shield, AlertTriangle } from "lucide-react"

interface RiskSettingsProps {
  portfolioId: number
  currentLimits: {
    max_position_size: number
    max_daily_loss: number
    max_drawdown_percent: number
    max_leverage: number
    max_open_positions: number
  }
  onUpdate: (limits: any) => void
}

export function RiskSettings({ portfolioId, currentLimits, onUpdate }: RiskSettingsProps) {
  const [limits, setLimits] = useState(currentLimits)
  const [isSaving, setIsSaving] = useState(false)

  const handleSave = async () => {
    setIsSaving(true)
    try {
      await onUpdate(limits)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-primary" />
          <CardTitle>Risk Management Settings</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-yellow-900">Important</p>
            <p className="text-sm text-yellow-700 mt-1">
              These limits protect your portfolio from excessive risk. Changes take effect immediately.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <Label htmlFor="max_position_size">Max Position Size ($)</Label>
            <Input
              id="max_position_size"
              type="number"
              value={limits.max_position_size}
              onChange={(e) => setLimits({ ...limits, max_position_size: Number.parseFloat(e.target.value) })}
            />
            <p className="text-xs text-muted-foreground">Maximum size for a single position</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="max_daily_loss">Max Daily Loss ($)</Label>
            <Input
              id="max_daily_loss"
              type="number"
              value={limits.max_daily_loss}
              onChange={(e) => setLimits({ ...limits, max_daily_loss: Number.parseFloat(e.target.value) })}
            />
            <p className="text-xs text-muted-foreground">Stop trading if daily loss exceeds this</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="max_drawdown_percent">Max Drawdown (%)</Label>
            <Input
              id="max_drawdown_percent"
              type="number"
              value={limits.max_drawdown_percent}
              onChange={(e) => setLimits({ ...limits, max_drawdown_percent: Number.parseFloat(e.target.value) })}
            />
            <p className="text-xs text-muted-foreground">Maximum portfolio drawdown allowed</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="max_leverage">Max Leverage (x)</Label>
            <Input
              id="max_leverage"
              type="number"
              value={limits.max_leverage}
              onChange={(e) => setLimits({ ...limits, max_leverage: Number.parseFloat(e.target.value) })}
            />
            <p className="text-xs text-muted-foreground">Maximum leverage per position</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="max_open_positions">Max Open Positions</Label>
            <Input
              id="max_open_positions"
              type="number"
              value={limits.max_open_positions}
              onChange={(e) => setLimits({ ...limits, max_open_positions: Number.parseInt(e.target.value) })}
            />
            <p className="text-xs text-muted-foreground">Maximum concurrent open positions</p>
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-4 border-t">
          <Button variant="outline" onClick={() => setLimits(currentLimits)}>
            Reset
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
