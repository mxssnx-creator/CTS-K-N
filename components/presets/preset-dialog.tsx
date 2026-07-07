"use client"

import type React from "react"

import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { Preset } from "@/lib/types"

interface PresetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  preset: Preset | null
  onSave: (preset: Partial<Preset>) => void
}

export function PresetDialog({ open, onOpenChange, preset, onSave }: PresetDialogProps) {
  const [formData, setFormData] = useState<Partial<Preset>>({
    name: "",
    description: "",
    indication_types: ["direction", "move", "active"],
    indication_ranges: [3, 5, 8, 12, 15, 20, 25, 30],
    takeprofit_steps: [2, 3, 4, 6, 8, 12],
    stoploss_ratios: [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5],
    trailing_enabled: true,
    trail_starts: [0.3, 0.6, 1.0],
    trail_stops: [0.1, 0.2, 0.3],
    strategy_types: ["base", "main", "real"],
    last_positions_counts: [3, 4, 5, 6, 8, 12, 25],
    main_positions_count: [1, 2, 3, 4, 5],
    block_adjustment_enabled: true,
    block_sizes: [2, 4, 6, 8],
    block_adjustment_ratios: [0.5, 1.0, 1.5, 2.0],
    dca_adjustment_enabled: false,
    dca_levels: [3, 5, 7],
    volume_factors: [0.1, 0.2, 0.5, 1.0],
    min_profit_factor: 0.4,
    min_win_rate: 0.0,
    max_drawdown: 50.0,
    backtest_period_days: 30,
    backtest_enabled: true,
    is_active: true,
  })

  useEffect(() => {
    if (preset) {
      setFormData(preset)
    } else {
      setFormData({
        name: "",
        description: "",
        indication_types: ["direction", "move", "active"],
        indication_ranges: [3, 5, 8, 12, 15, 20, 25, 30],
        takeprofit_steps: [2, 3, 4, 6, 8, 12],
        stoploss_ratios: [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5],
        trailing_enabled: true,
        trail_starts: [0.3, 0.6, 1.0],
        trail_stops: [0.1, 0.2, 0.3],
        strategy_types: ["base", "main", "real"],
        last_positions_counts: [3, 4, 5, 6, 8, 12, 25],
        main_positions_count: [1, 2, 3, 4, 5],
        block_adjustment_enabled: true,
        block_sizes: [2, 4, 6, 8],
        block_adjustment_ratios: [0.5, 1.0, 1.5, 2.0],
        dca_adjustment_enabled: false,
        dca_levels: [3, 5, 7],
        volume_factors: [0.1, 0.2, 0.5, 1.0],
        min_profit_factor: 0.4,
        min_win_rate: 0.0,
        max_drawdown: 50.0,
        backtest_period_days: 30,
        backtest_enabled: true,
        is_active: true,
      })
    }
  }, [preset, open])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave(formData)
  }

  const toggleArrayValue = (key: keyof Preset, value: any) => {
    const currentArray = (formData[key] as any[]) || []
    const newArray = currentArray.includes(value) ? currentArray.filter((v) => v !== value) : [...currentArray, value]
    setFormData({ ...formData, [key]: newArray })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{preset ? "Edit Preset" : "Create New Preset"}</DialogTitle>
          <DialogDescription>
            Configure trading preset with progressive settings for short-term trading (up to 2 hours)
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Preset Name</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Aggressive Short-Term"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Describe this preset's strategy and use case"
                rows={2}
              />
            </div>
          </div>

          <Tabs defaultValue="takeprofit" className="w-full">
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="takeprofit">TP/SL</TabsTrigger>
              <TabsTrigger value="trailing">Trailing</TabsTrigger>
              <TabsTrigger value="strategies">Strategies</TabsTrigger>
              <TabsTrigger value="adjustments">Adjustments</TabsTrigger>
              <TabsTrigger value="validation">Validation</TabsTrigger>
            </TabsList>

            <TabsContent value="takeprofit" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Take Profit Steps</CardTitle>
                  <CardDescription>TP steps in relation to 0.1% position cost (2, 3, 4, 6, 8, 12)</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {[2, 3, 4, 6, 8, 12].map((step) => (
                      <Badge
                        key={step}
                        variant={formData.takeprofit_steps?.includes(step) ? "default" : "outline"}
                        className="cursor-pointer"
                        onClick={() => toggleArrayValue("takeprofit_steps", step)}
                      >
                        {step}x
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Stop Loss Ratios</CardTitle>
                  <CardDescription>SL ratios from take profit (0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5)</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {[0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5].map((ratio) => (
                      <Badge
                        key={ratio}
                        variant={formData.stoploss_ratios?.includes(ratio) ? "default" : "outline"}
                        className="cursor-pointer"
                        onClick={() => toggleArrayValue("stoploss_ratios", ratio)}
                      >
                        {ratio}x
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="trailing" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Trailing Configuration</CardTitle>
                  <CardDescription>Same settings as pseudo positions</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="trailing_enabled">Enable Trailing</Label>
                    <Switch
                      id="trailing_enabled"
                      checked={formData.trailing_enabled}
                      onCheckedChange={(checked) => setFormData({ ...formData, trailing_enabled: checked })}
                    />
                  </div>

                  {formData.trailing_enabled && (
                    <>
                      <div className="space-y-2">
                        <Label>Trail Start (profit multiplier)</Label>
                        <div className="flex flex-wrap gap-2">
                          {[0.3, 0.6, 1.0].map((start) => (
                            <Badge
                              key={start}
                              variant={formData.trail_starts?.includes(start) ? "default" : "outline"}
                              className="cursor-pointer"
                              onClick={() => toggleArrayValue("trail_starts", start)}
                            >
                              {start}x
                            </Badge>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>Trail Stop (distance from peak)</Label>
                        <div className="flex flex-wrap gap-2">
                          {[0.1, 0.2, 0.3].map((stop) => (
                            <Badge
                              key={stop}
                              variant={formData.trail_stops?.includes(stop) ? "default" : "outline"}
                              className="cursor-pointer"
                              onClick={() => toggleArrayValue("trail_stops", stop)}
                            >
                              {stop}x
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="strategies" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Strategy Types</CardTitle>
                  <CardDescription>Select which strategy types to include</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {["base", "main", "real"].map((type) => (
                      <Badge
                        key={type}
                        variant={formData.strategy_types?.includes(type) ? "default" : "outline"}
                        className="cursor-pointer"
                        onClick={() => toggleArrayValue("strategy_types", type)}
                      >
                        {type.charAt(0).toUpperCase() + type.slice(1)}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Volume Factors</CardTitle>
                  <CardDescription>Position size multipliers starting at the minimum/default 0.1x</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {[0.1, 0.2, 0.5, 1.0].map((factor) => (
                      <Badge
                        key={factor}
                        variant={formData.volume_factors?.includes(factor) ? "default" : "outline"}
                        className="cursor-pointer"
                        onClick={() => toggleArrayValue("volume_factors", factor)}
                      >
                        {factor}x
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="adjustments" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Block Adjustment</CardTitle>
                  <CardDescription>Group positions into blocks with volume adjustment</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="block_adjustment_enabled">Enable Block Adjustment</Label>
                    <Switch
                      id="block_adjustment_enabled"
                      checked={formData.block_adjustment_enabled}
                      onCheckedChange={(checked) => setFormData({ ...formData, block_adjustment_enabled: checked })}
                    />
                  </div>

                  {formData.block_adjustment_enabled && (
                    <>
                      <div className="space-y-2">
                        <Label>Block Sizes</Label>
                        <div className="flex flex-wrap gap-2">
                          {[2, 4, 6, 8].map((size) => (
                            <Badge
                              key={size}
                              variant={formData.block_sizes?.includes(size) ? "default" : "outline"}
                              className="cursor-pointer"
                              onClick={() => toggleArrayValue("block_sizes", size)}
                            >
                              {size} positions
                            </Badge>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>Adjustment Ratios</Label>
                        <div className="flex flex-wrap gap-2">
                          {[0.5, 1.0, 1.5, 2.0].map((ratio) => (
                            <Badge
                              key={ratio}
                              variant={formData.block_adjustment_ratios?.includes(ratio) ? "default" : "outline"}
                              className="cursor-pointer"
                              onClick={() => toggleArrayValue("block_adjustment_ratios", ratio)}
                            >
                              +{(ratio * 100).toFixed(0)}%
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>DCA Adjustment</CardTitle>
                  <CardDescription>Dollar Cost Averaging for loss recovery</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="dca_adjustment_enabled">Enable DCA</Label>
                    <Switch
                      id="dca_adjustment_enabled"
                      checked={formData.dca_adjustment_enabled}
                      onCheckedChange={(checked) => setFormData({ ...formData, dca_adjustment_enabled: checked })}
                    />
                  </div>

                  {formData.dca_adjustment_enabled && (
                    <div className="space-y-2">
                      <Label>DCA Levels</Label>
                      <div className="flex flex-wrap gap-2">
                        {[3, 5, 7].map((level) => (
                          <Badge
                            key={level}
                            variant={formData.dca_levels?.includes(level) ? "default" : "outline"}
                            className="cursor-pointer"
                            onClick={() => toggleArrayValue("dca_levels", level)}
                          >
                            {level} levels
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="validation" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Validation Rules</CardTitle>
                  <CardDescription>Criteria for strategy validation</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="min_profit_factor">Minimum Profit Factor</Label>
                    <Input
                      id="min_profit_factor"
                      type="number"
                      step="0.1"
                      value={formData.min_profit_factor}
                      onChange={(e) =>
                        setFormData({ ...formData, min_profit_factor: Number.parseFloat(e.target.value) })
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="max_drawdown">Maximum Drawdown (%)</Label>
                    <Input
                      id="max_drawdown"
                      type="number"
                      step="1"
                      value={formData.max_drawdown}
                      onChange={(e) => setFormData({ ...formData, max_drawdown: Number.parseFloat(e.target.value) })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="backtest_period_days">Backtest Period (days)</Label>
                    <Input
                      id="backtest_period_days"
                      type="number"
                      value={formData.backtest_period_days}
                      onChange={(e) =>
                        setFormData({ ...formData, backtest_period_days: Number.parseInt(e.target.value) })
                      }
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="backtest_enabled">Enable Backtesting</Label>
                    <Switch
                      id="backtest_enabled"
                      checked={formData.backtest_enabled}
                      onCheckedChange={(checked) => setFormData({ ...formData, backtest_enabled: checked })}
                    />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">{preset ? "Update" : "Create"} Preset</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
